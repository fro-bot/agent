export const ERROR_TYPES = [
  'api_error',
  'configuration',
  'internal',
  'llm_fetch_error',
  'llm_timeout',
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

interface ProviderAuthErrorFields {
  readonly name?: unknown
  readonly status?: unknown
  readonly reason?: unknown
  readonly code?: unknown
  readonly providerID?: unknown
  readonly message?: unknown
}

/**
 * Provider-neutral normalized input to {@link classifyProviderAuthError}.
 *
 * The classifier accepts only these bounded fields from an upstream signal.
 * Provider identity and message fields are accepted for source-shape parity,
 * but are ignored and never retained in the returned {@link ErrorInfo}.
 */
export type ProviderAuthErrorInput =
  | (ProviderAuthErrorFields & {
      readonly kind: 'retry-status'
      readonly reason: unknown
    })
  | (ProviderAuthErrorFields & {
      readonly kind: 'session-error'
    })
