export const ERROR_TYPES = [
  'api_error',
  'configuration',
  'internal',
  'llm_fetch_error',
  'llm_timeout',
  'permission',
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
