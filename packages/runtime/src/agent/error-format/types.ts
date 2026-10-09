export const ERROR_TYPES = [
  'api_error',
  'configuration',
  'context_overflow',
  'internal',
  'llm_fetch_error',
  'llm_timeout',
  'model_not_found',
  'permission',
  'provider_auth_error',
  'quota_exceeded',
  'rate_limit',
  'validation',
] as const

export type ErrorType = (typeof ERROR_TYPES)[number]

export interface ErrorInfo {
  readonly type: ErrorType
  readonly message: string
  readonly details?: string
  readonly suggestedAction?: string
  readonly retryable: boolean
  readonly resetTime?: Date
}

/**
 * Provider-neutral normalized input to {@link classifyQuotaError}.
 *
 * `retry-status` carries OpenCode's `session.status`/`retry` reason string.
 * `session-error` carries only allowlisted fields from a structured/text
 * `session.error` — never a raw SDK Event or payload object.
 */
export type QuotaErrorInput =
  | {
      readonly kind: 'retry-status'
      readonly reason: string
      readonly resetAt?: Date
    }
  | {
      readonly kind: 'session-error'
      readonly status?: number
      readonly code?: string
      readonly message?: string
    }

/**
 * Provider-neutral normalized input to {@link classifyProviderAuthError}.
 *
 * The classifier accepts only these bounded fields from an upstream signal.
 */
export type ProviderAuthErrorInput =
  | {
      readonly kind: 'retry-status'
      readonly reason: unknown
    }
  | {
      readonly kind: 'session-error'
      readonly name?: unknown
    }

/**
 * Normalized input to {@link classifyModelNotFoundError}. OpenCode reports an unresolvable model as a
 * generic `UnknownError` whose only signal is its `message` text, so the message is the one field consumed;
 * the classifier extracts an allowlisted, bounded subset and never echoes the rest.
 */
export interface ModelNotFoundErrorInput {
  readonly kind: 'session-error'
  readonly message?: string
}

/**
 * Provider-neutral normalized input to {@link classifyContextOverflowError}.
 *
 * The classifier accepts only the structured session-error name marker; raw
 * provider response fields are intentionally outside this contract.
 */
export interface ContextOverflowErrorInput {
  readonly kind: 'session-error'
  readonly name?: unknown
}
