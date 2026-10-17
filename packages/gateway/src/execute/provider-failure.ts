/**
 * Provider-failure classification for the gateway event loop (#1836).
 *
 * Decides whether an OpenCode event means the model provider has rejected the run in a way no retry
 * will fix, so the run can fail promptly instead of idling until the inactivity window.
 *
 * Security: classification reads upstream fields but NEVER returns them. Every result carries a closed,
 * fixed `reason` plus a sanitized error name; provider messages and response bodies stay in this module.
 *
 * Upstream facts this relies on (OpenCode v1.19.0, `src/session/`):
 * - `processor.ts` retries only what `retry.ts#retryable` accepts, up to `RETRY_MAX_RETRIES`; anything
 *   else reaches `halt`, which sets `assistantMessage.error` and publishes `session.error`.
 * - A retry `session.status` carries `{attempt, message, next, action?}`. Stock only builds `action` for
 *   usage-limit cases, so a retry status is classified from the structured `action.reason` ONLY: its
 *   `message` is the text of a retried (often 5xx) failure and is not evidence the retry is hopeless.
 * - Message-text matching applies to terminal error payloads only (`session.error`, assistant
 *   `info.error`), where OpenCode has already stopped retrying.
 */

import {classifyModelNotFoundError, classifyProviderAuthError} from '@fro-bot/runtime'

/** Closed set of operator-safe failure reasons. Nothing provider-controlled can become one. */
export type ProviderFailureReason =
  'provider auth unavailable' | 'model not available' | 'model provider rejected the request' | 'session error'

/**
 * OpenCode error class names this classifier recognizes (v1.19.0): `packages/core/src/v1/session.ts`
 * (`MessageOutputLengthError` :48, `ProviderAuthError` :49, `MessageAbortedError` :50, `StructuredOutputError` :51,
 * `APIError` :55, `ContextOverflowError` :64, `ContentFilterError` :68) and `packages/core/src/util/error.ts:66`
 * (`UnknownError`). Anything else is provider- or plugin-controlled and is logged as `unknown`.
 */
const KNOWN_ERROR_NAMES = [
  'ProviderAuthError',
  'APIError',
  'UnknownError',
  'MessageAbortedError',
  'MessageOutputLengthError',
  'ContextOverflowError',
  'StructuredOutputError',
  'ContentFilterError',
] as const

type KnownErrorName = (typeof KNOWN_ERROR_NAMES)[number]

/** Closed set of values `errorName` can take: a known class, or one of three source markers. */
export type ProviderFailureErrorName = KnownErrorName | 'retry-status' | 'error-text' | 'unknown'

export interface ProviderFailure {
  /** Fixed text, safe for failure messages, logs and operator surfaces. */
  readonly reason: ProviderFailureReason
  /** Allowlisted error class or source marker for logging. Upstream strings never pass through. */
  readonly errorName: ProviderFailureErrorName
}

/** Retry `action.reason` values that mean the model can never be served, matched exactly. */
const MODEL_UNAVAILABLE_RETRY_REASONS = new Set(['model_not_found', 'model_not_supported'])

/**
 * Message fallbacks for terminal error payloads that carry no structured marker.
 * Deliberately narrow: a 429, 5xx, "overloaded" or network message must never match.
 */
const AUTH_MESSAGE_PATTERNS = [/\bauth_unavailable\b/i, /\bno auth available\b/i] as const
const MODEL_MESSAGE_PATTERNS = [/\bmodel_not_found\b/i, /\bmodel (?:is )?not (?:supported|found)\b/i] as const

/** Upper bound on text inspected, so a hostile payload cannot make matching expensive. */
const MAX_INSPECTED_MESSAGE_LENGTH = 2048

function getStringProperty(value: unknown, property: string): string | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'string' ? descriptor.value : null
}

function getObjectProperty(value: unknown, property: string): unknown {
  if (value == null || typeof value !== 'object') return null
  return Object.getOwnPropertyDescriptor(value, property)?.value ?? null
}

function knownErrorName(name: string | null): ProviderFailureErrorName {
  return KNOWN_ERROR_NAMES.find(known => known === name) ?? 'unknown'
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  const inspected = text.slice(0, MAX_INSPECTED_MESSAGE_LENGTH)
  return patterns.some(pattern => pattern.test(inspected))
}

/** Message-text fallback for terminal error payloads. Never applied to retry statuses. */
function classifyMessage(message: string | null): ProviderFailureReason | null {
  if (message === null) return null
  if (matchesAny(AUTH_MESSAGE_PATTERNS, message)) return 'provider auth unavailable'
  if (matchesAny(MODEL_MESSAGE_PATTERNS, message)) return 'model not available'
  if (
    classifyModelNotFoundError({kind: 'session-error', message: message.slice(0, MAX_INSPECTED_MESSAGE_LENGTH)}) !==
    null
  ) {
    return 'model not available'
  }
  return null
}

/**
 * Classify a `session.status` payload value from its structured `action.reason` only. Returns a failure
 * only for a retry that can never succeed (provider auth unavailable, model unsupported/not found); every
 * other retry, whatever its `message` says, returns `null` so the run keeps waiting.
 */
export function classifyRetryStatus(status: unknown): ProviderFailure | null {
  if (getStringProperty(status, 'type') !== 'retry') return null

  const reason = getStringProperty(getObjectProperty(status, 'action'), 'reason')
  if (reason === null) return null
  if (classifyProviderAuthError({kind: 'retry-status', reason}) !== null) {
    return {reason: 'provider auth unavailable', errorName: 'retry-status'}
  }
  if (MODEL_UNAVAILABLE_RETRY_REASONS.has(reason)) return {reason: 'model not available', errorName: 'retry-status'}
  return null
}

/**
 * Classify a plain-string `session.error` payload. The text is matched, never returned: an arbitrary
 * string yields the fixed `session error` reason.
 */
export function classifyErrorText(text: string): ProviderFailure {
  return {reason: classifyMessage(text) ?? 'session error', errorName: 'error-text'}
}

/**
 * True for OpenCode's abort marker. An abort is the operator or harness stopping the run, never a
 * provider rejection, so the assistant-message path must not report it as one.
 */
export function isAbortedError(error: unknown): boolean {
  return getStringProperty(error, 'name') === 'MessageAbortedError'
}

/**
 * True for the context-overflow marker. With auto-compaction on (the default) OpenCode publishes
 * `session.error` for it and then compacts and continues, so it is not a terminal failure.
 */
export function isContextOverflowError(error: unknown): boolean {
  return getStringProperty(error, 'name') === 'ContextOverflowError'
}

/**
 * Classify a structured OpenCode error object (`{name, data: {message, ...}}`), as found on an assistant
 * `info.error` or a `session.error` payload. Total: an unrecognized error still yields a fixed reason.
 */
export function classifyStructuredError(error: unknown): ProviderFailure {
  const name = getStringProperty(error, 'name')
  const errorName = knownErrorName(name)

  if (classifyProviderAuthError({kind: 'session-error', name}) !== null) {
    return {reason: 'provider auth unavailable', errorName}
  }

  const message = getStringProperty(getObjectProperty(error, 'data'), 'message') ?? getStringProperty(error, 'message')
  const fromMessage = classifyMessage(message)
  if (fromMessage !== null) return {reason: fromMessage, errorName}

  if (name === 'APIError') return {reason: 'model provider rejected the request', errorName}
  return {reason: 'session error', errorName}
}
