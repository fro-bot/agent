/**
 * Provider-failure labelling for the OpenCode V2 event loop: the sibling of `provider-failure.ts`.
 *
 * V2 reports a terminal failure as `session.execution.failed` with a structured error `{type, message, status,
 * retryAfterMs}` (`packages/schema/src/session-error.ts`). The shared classifier (`classifyProviderFailure`) takes the
 * same typed signal the V1 loop builds, so the V2 error is mapped onto it field by field. Classification reads
 * upstream fields but NEVER returns them: every result is a closed, fixed `reason`. The error `type` and `message` are
 * provider- or plugin-controlled, so the logged error name is always `unknown`, never the upstream string.
 *
 * The error `type` is the structured evidence for auth: `provider.auth` is mapped onto the classifier's `ProviderAuthError`
 * name whatever the provider's message says. Every other type is passed on unchanged and judged by the shared rules.
 *
 * A retry (`session.retry.scheduled`) is never a failure here. V1 stopped on a retry only when the structured
 * `action.reason` said the model could never be served. The V2 retry event carries the retried error and no such
 * action, and the message of a retried (often 5xx) failure is not evidence the retry is hopeless, so the loop keeps
 * waiting and lets the terminal event decide.
 */

import type {ProviderFailureKind, V2ErrorInfo} from '@fro-bot/runtime'

import {classifyProviderFailure, terminalSignalFromPayload} from '@fro-bot/runtime'

/** Closed set of operator-safe failure reasons. Nothing provider-controlled can become one. */
export type ProviderFailureReason =
  | 'provider auth unavailable'
  | 'model not available'
  | 'provider quota exceeded'
  | 'model provider rejected the request'
  | 'session error'

/**
 * Closed set of values `errorName` can take: an OpenCode error class the classifier recognizes (v1.19.0:
 * `packages/core/src/v1/session.ts`), or one of three source markers.
 */
export type ProviderFailureErrorName =
  | 'ProviderAuthError'
  | 'APIError'
  | 'UnknownError'
  | 'MessageAbortedError'
  | 'MessageOutputLengthError'
  | 'ContextOverflowError'
  | 'StructuredOutputError'
  | 'ContentFilterError'
  | 'retry-status'
  | 'error-text'
  | 'unknown'

export interface ProviderFailure {
  /** Fixed text, safe for failure messages, logs and operator surfaces. */
  readonly reason: ProviderFailureReason
  /** Allowlisted error class or source marker for logging. Upstream strings never pass through. */
  readonly errorName: ProviderFailureErrorName
}

function toReason(kind: ProviderFailureKind): ProviderFailureReason {
  switch (kind) {
    case 'auth':
      return 'provider auth unavailable'
    case 'quota':
      return 'provider quota exceeded'
    case 'model-not-found':
      return 'model not available'
    case 'unclassified':
    case 'context-overflow':
    case 'aborted':
      return 'session error'
  }
}

/** The V2 error type the server uses for a rejected credential (`to-session-error.ts`: `providerError("provider.auth")`). */
const V2_PROVIDER_AUTH_TYPE = 'provider.auth'
const PROVIDER_AUTH_NAME = 'ProviderAuthError'

/** Label a V2 execution failure. Total: an unrecognized error still yields a fixed reason. */
export function failureFromV2Error(error: V2ErrorInfo): ProviderFailure {
  const classification = classifyProviderFailure(
    terminalSignalFromPayload({
      name: error.type === V2_PROVIDER_AUTH_TYPE ? PROVIDER_AUTH_NAME : error.type,
      message: error.message,
      ...(error.status === null ? {} : {status: error.status}),
    }),
  )
  return {reason: toReason(classification.kind), errorName: 'unknown'}
}
