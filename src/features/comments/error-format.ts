import type {ErrorInfo, ErrorType} from './types.js'

const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
  api_error: 'API Error',
  configuration: 'Configuration Error',
  internal: 'Internal Error',
  llm_fetch_error: 'LLM Fetch Error',
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
  if (error.type === 'llm_fetch_error') return ':warning:'
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

const LLM_FETCH_ERROR_PATTERNS = [
  /fetch failed/i,
  /connect\s*timeout/i,
  /connecttimeouterror/i,
  /timed?\s*out/i,
  /econnrefused/i,
  /econnreset/i,
  /etimedout/i,
  /network error/i,
] as const

/**
 * Detect if an error is an LLM fetch/network error.
 * Handles string messages, Error objects, and objects with cause property.
 */
export function isLlmFetchError(error: unknown): boolean {
  if (error == null) return false

  let errorMessage = ''

  if (typeof error === 'string') {
    errorMessage = error
  } else if (error instanceof Error) {
    errorMessage = error.message
    if ('cause' in error && typeof error.cause === 'string') {
      errorMessage += ` ${error.cause}`
    }
  } else if (typeof error === 'object') {
    const obj = error as Record<string, unknown>
    if (typeof obj.message === 'string') {
      errorMessage = obj.message
    }
    if (typeof obj.cause === 'string') {
      errorMessage += ` ${obj.cause}`
    }
  }

  return LLM_FETCH_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage))
}

/**
 * Create LLM fetch error for network/connection failures.
 * These are retryable transient errors that may succeed on retry.
 */
export function createLLMFetchError(message: string, model?: string): ErrorInfo {
  return createErrorInfo('llm_fetch_error', `LLM request failed: ${message}`, true, {
    details: model == null ? undefined : `Model: ${model}`,
    suggestedAction: 'This is a transient network error. The request may succeed on retry, or try a different model.',
  })
}

const AGENT_NOT_FOUND_PATTERNS = [
  /agent\s+not\s+found/i,
  /unknown\s+agent/i,
  /invalid\s+agent/i,
  /agent\s+\S+\s+does\s+not\s+exist/i,
  /no\s+agent\s+named/i,
  /agent\s+\S+\s+is\s+not\s+available/i,
] as const

export function isAgentNotFoundError(error: unknown): boolean {
  if (error == null) return false

  let errorMessage = ''

  if (typeof error === 'string') {
    errorMessage = error
  } else if (error instanceof Error) {
    errorMessage = error.message
  } else if (typeof error === 'object') {
    const obj = error as Record<string, unknown>
    if (typeof obj.message === 'string') {
      errorMessage = obj.message
    }
  }

  return AGENT_NOT_FOUND_PATTERNS.some(pattern => pattern.test(errorMessage))
}

export function createAgentError(message: string, agent?: string): ErrorInfo {
  return createErrorInfo('configuration', `Agent error: ${message}`, false, {
    details: agent == null ? undefined : `Requested agent: ${agent}`,
    suggestedAction: 'Verify the agent name is correct and the required plugins (e.g., oMo) are installed.',
  })
}
