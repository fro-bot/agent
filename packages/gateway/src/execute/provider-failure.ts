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
 *   usage-limit cases, so auth/model rejections surface in `message` (or a patched `action.reason`).
 */

import {classifyModelNotFoundError, classifyProviderAuthError} from '@fro-bot/runtime'

/** Closed set of operator-safe failure reasons. Nothing provider-controlled can become one. */
export type ProviderFailureReason =
  'provider auth unavailable' | 'model not available' | 'model provider rejected the request' | 'session error'

export interface ProviderFailure {
  /** Fixed text, safe for failure messages, logs and operator surfaces. */
  readonly reason: ProviderFailureReason
  /** Sanitized error class/marker name for logging; `'unknown'` when the upstream value is not a plain identifier. */
  readonly errorName: string
}

/** Retry `action.reason` values that mean the model can never be served, matched exactly. */
const MODEL_UNAVAILABLE_RETRY_REASONS = new Set(['model_not_found', 'model_not_supported'])

/**
 * Message fallbacks for retry statuses and error payloads that carry no structured marker.
 * Deliberately narrow: a 429, 5xx, "overloaded" or network message must never match.
 */
const AUTH_MESSAGE_PATTERNS = [/\bauth_unavailable\b/i, /\bno auth available\b/i] as const
const MODEL_MESSAGE_PATTERNS = [/\bmodel_not_found\b/i, /\bmodel (?:is )?not (?:supported|found)\b/i] as const

/** Upper bound on text inspected, so a hostile payload cannot make matching expensive. */
const MAX_INSPECTED_MESSAGE_LENGTH = 2048
const SAFE_NAME_PATTERN = /^[A-Z][\w.-]{0,63}$/i

function getStringProperty(value: unknown, property: string): string | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'string' ? descriptor.value : null
}

function getObjectProperty(value: unknown, property: string): unknown {
  if (value == null || typeof value !== 'object') return null
  return Object.getOwnPropertyDescriptor(value, property)?.value ?? null
}

function safeName(name: string | null): string {
  return name !== null && SAFE_NAME_PATTERN.test(name) ? name : 'unknown'
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  const inspected = text.slice(0, MAX_INSPECTED_MESSAGE_LENGTH)
  return patterns.some(pattern => pattern.test(inspected))
}

/** Message-text fallback shared by retry statuses and error payloads. */
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
 * Classify a `session.status` payload value. Returns a failure only for a retry that can never succeed
 * (provider auth missing/unavailable, model unsupported/not found); every other retry returns `null` so
 * the run keeps waiting.
 */
export function classifyRetryStatus(status: unknown): ProviderFailure | null {
  if (getStringProperty(status, 'type') !== 'retry') return null

  const reason = getStringProperty(getObjectProperty(status, 'action'), 'reason')
  if (reason !== null) {
    if (classifyProviderAuthError({kind: 'retry-status', reason}) !== null) {
      return {reason: 'provider auth unavailable', errorName: safeName(reason)}
    }
    if (MODEL_UNAVAILABLE_RETRY_REASONS.has(reason)) {
      return {reason: 'model not available', errorName: safeName(reason)}
    }
  }

  const fallback = classifyMessage(getStringProperty(status, 'message'))
  return fallback === null ? null : {reason: fallback, errorName: 'retry-status'}
}

/**
 * True for OpenCode's abort marker. An abort is the operator or harness stopping the run, never a
 * provider rejection, so the assistant-message path must not report it as one.
 */
export function isAbortedError(error: unknown): boolean {
  return getStringProperty(error, 'name') === 'MessageAbortedError'
}

/**
 * Classify a structured OpenCode error object (`{name, data: {message, ...}}`), as found on an assistant
 * `info.error` or a `session.error` payload. Total: an unrecognized error still yields a fixed reason.
 */
export function classifyStructuredError(error: unknown): ProviderFailure {
  const name = getStringProperty(error, 'name')
  const errorName = safeName(name)

  if (classifyProviderAuthError({kind: 'session-error', name}) !== null) {
    return {reason: 'provider auth unavailable', errorName}
  }

  const message = getStringProperty(getObjectProperty(error, 'data'), 'message') ?? getStringProperty(error, 'message')
  const fromMessage = classifyMessage(message)
  if (fromMessage !== null) return {reason: fromMessage, errorName}

  if (name === 'APIError') return {reason: 'model provider rejected the request', errorName}
  return {reason: 'session error', errorName}
}
