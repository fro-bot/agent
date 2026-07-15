export const ERROR_TYPES = [
  'api_error',
  'configuration',
  'internal',
  'llm_fetch_error',
  'llm_timeout',
  'permission',
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
