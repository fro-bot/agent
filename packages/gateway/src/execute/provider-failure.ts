/**
 * Provider-failure labelling for the gateway event loop (#1836).
 *
 * The classification itself, and the decision to stop on a retry status, live in the shared
 * `classifyProviderFailure` (`@fro-bot/runtime`), which the Action uses too. This module does the two things that
 * are gateway-only: it extracts a normalized signal from an OpenCode payload and maps the shared `kind` onto the
 * closed operator-safe `ProviderFailureReason`, and it keeps the error-name allowlist for logs.
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
 *
 * Retry-status trade-off: `action.reason: 'auth_unavailable'` is the production shape captured in #1253
 * (fixture: `docs/plans/2026-07-24-001-fix-provider-auth-fast-fail-plan.md`). A retried 5xx whose only
 * auth or model signal is its text is NOT failed fast: OpenCode retries 5xx as transient, so such a run
 * waits for the terminal error instead of risking a false failure on a recoverable outage.
 */

import type {ProviderFailureClassification, ProviderFailureSignal} from '@fro-bot/runtime'

import {classifyProviderFailure} from '@fro-bot/runtime'

/** Closed set of operator-safe failure reasons. Nothing provider-controlled can become one. */
export type ProviderFailureReason =
  | 'provider auth unavailable'
  | 'model not available'
  | 'provider quota exceeded'
  | 'model provider rejected the request'
  | 'session error'

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

function getOwnProperty(value: unknown, property: string): unknown {
  if (value == null || typeof value !== 'object') return undefined
  return Object.getOwnPropertyDescriptor(value, property)?.value
}

function getStringProperty(value: unknown, property: string): string | null {
  const found = getOwnProperty(value, property)
  return typeof found === 'string' ? found : null
}

function knownErrorName(name: string | null): ProviderFailureErrorName {
  return KNOWN_ERROR_NAMES.find(known => known === name) ?? 'unknown'
}

/**
 * Shared `kind` → internal reason. Evidence strength does not matter here: a `hint` result (looser wording) labels
 * the failure the same as a structured one; only the shared stop decision cares how strong the evidence was.
 *
 * `unclassified` keeps one gateway-side refinement: an `APIError` with no other evidence is still "the provider
 * rejected the request", which is more useful to an operator than `session error`.
 */
function toReason(classification: ProviderFailureClassification, payloadName: string | null): ProviderFailureReason {
  switch (classification.kind) {
    case 'auth':
      return 'provider auth unavailable'
    case 'quota':
      return 'provider quota exceeded'
    case 'model-not-found':
      return 'model not available'
    case 'unclassified':
      return payloadName === 'APIError' ? 'model provider rejected the request' : 'session error'
    // Overflow and abort are surface policy, handled by `run-core` before a failure is built; if one reaches
    // here it is not a provider rejection, so it gets the generic label.
    case 'context-overflow':
    case 'aborted':
      return 'session error'
  }
}

/**
 * Classify a `session.status` payload. Returns a failure only when the shared function says the retry can never
 * succeed (`stop`): provider auth unavailable, an account rate limit (quota), or a model that cannot be served.
 * Every other retry, whatever its `message` says, returns `null` so the run keeps waiting.
 *
 * The retry `message` is deliberately not passed: it is the text of a retried (often 5xx) failure and is not
 * evidence the retry is hopeless.
 */
export function failureFromRetryStatus(status: unknown): ProviderFailure | null {
  if (getStringProperty(status, 'type') !== 'retry') return null

  const reason = getStringProperty(getOwnProperty(status, 'action'), 'reason')
  const signal: ProviderFailureSignal = {source: 'retry-status', ...(reason === null ? {} : {reason})}
  const classification = classifyProviderFailure(signal)
  if (classification === null || classification.stop === false) return null
  return {reason: toReason(classification, null), errorName: 'retry-status'}
}

/**
 * Label a plain-string `session.error` payload. The text is matched, never returned: an arbitrary string yields
 * a fixed reason. Every terminal error fails the run; the label is all this decides.
 */
export function failureFromErrorText(text: string): ProviderFailure {
  const classification = classifyProviderFailure({source: 'terminal-payload', message: text})
  return {reason: toReason(classification, null), errorName: 'error-text'}
}

/**
 * Label a structured OpenCode error object (`{name, data: {message, statusCode, ...}}`), as found on an assistant
 * `info.error` or a `session.error` payload. Total: an unrecognized error still yields a fixed reason.
 */
export function failureFromErrorObject(error: unknown): ProviderFailure {
  const name = getStringProperty(error, 'name')
  const data = getOwnProperty(error, 'data')
  const classification = classifyProviderFailure({
    source: 'terminal-payload',
    name,
    status:
      getOwnProperty(error, 'status') ??
      getOwnProperty(error, 'statusCode') ??
      getOwnProperty(data, 'status') ??
      getOwnProperty(data, 'statusCode'),
    code: getOwnProperty(error, 'code') ?? getOwnProperty(data, 'code'),
    message: getOwnProperty(data, 'message') ?? getOwnProperty(error, 'message'),
    isRetryable: getOwnProperty(error, 'isRetryable') ?? getOwnProperty(data, 'isRetryable'),
  })
  return {reason: toReason(classification, name), errorName: knownErrorName(name)}
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
