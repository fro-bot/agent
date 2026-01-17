import type {ErrorInfo, ErrorType} from './types.js'

const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
  api_error: 'API Error',
  configuration: 'Configuration Error',
  internal: 'Internal Error',
  llm_timeout: 'LLM Timeout',
  permission: 'Permission Error',
  rate_limit: 'Rate Limit',
  validation: 'Validation Error',
}

/**
 * Select emoji icon based on error severity and type.
 * Visual distinction helps users quickly assess error impact.
 */
function getErrorIcon(error: ErrorInfo): string {
  if (error.type === 'rate_limit') return ':warning:'
  if (error.type === 'llm_timeout') return ':hourglass:'
  if (error.retryable) return ':warning:'
  return ':x:'
}

/**
 * Format error as user-friendly Markdown comment.
 * Structured format provides actionable information without technical jargon.
 */
export function formatErrorComment(error: ErrorInfo): string {
  const icon = getErrorIcon(error)
  const label = ERROR_TYPE_LABELS[error.type]
  const lines: string[] = []

  lines.push(`${icon} **${label}**`)
  lines.push('')
  lines.push(error.message)

  if (error.details != null) {
    lines.push('')
    lines.push(`> ${error.details}`)
  }

  if (error.suggestedAction != null) {
    lines.push('')
    lines.push(`**Suggested action:** ${error.suggestedAction}`)
  }

  if (error.retryable) {
    lines.push('')
    lines.push('_This error is retryable._')
  }

  if (error.resetTime != null) {
    lines.push('')
    lines.push(`_Rate limit resets at: ${error.resetTime.toISOString()}_`)
  }

  return lines.join('\n')
}

/**
 * Create structured error info for consistent error formatting.
 * Centralizes error metadata to ensure all errors include actionable guidance.
 */
export function createErrorInfo(
  type: ErrorType,
  message: string,
  retryable: boolean,
  options?: {details?: string; suggestedAction?: string; resetTime?: Date},
): ErrorInfo {
  return {
    type,
    message,
    retryable,
    details: options?.details,
    suggestedAction: options?.suggestedAction,
    resetTime: options?.resetTime,
  }
}

/**
 * Create rate limit error with reset time.
 * Rate limits are always retryable after the reset time.
 */
export function createRateLimitError(message: string, resetTime: Date): ErrorInfo {
  return createErrorInfo('rate_limit', message, true, {
    resetTime,
    suggestedAction: `Please wait until ${resetTime.toISOString()} and try again.`,
  })
}

/**
 * Create LLM timeout error.
 * Timeouts are retryable; may succeed with simpler prompt or longer timeout.
 */
export function createLLMTimeoutError(message: string): ErrorInfo {
  return createErrorInfo('llm_timeout', message, true, {
    suggestedAction: 'Try again with a simpler prompt or increased timeout.',
  })
}
