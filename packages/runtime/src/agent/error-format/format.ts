import type {ErrorInfo, ErrorType, QuotaErrorInput} from './types.js'

const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
  api_error: 'API Error',
  configuration: 'Configuration Error',
  internal: 'Internal Error',
  llm_fetch_error: 'LLM Fetch Error',
  llm_timeout: 'LLM Timeout',
  permission: 'Permission Error',
  quota_exceeded: 'Quota Exceeded',
  rate_limit: 'Rate Limit',
  validation: 'Validation Error',
}

function getErrorIcon(error: ErrorInfo): string {
  if (error.type === 'rate_limit') return ':warning:'
  if (error.type === 'llm_timeout') return ':hourglass:'
  if (error.type === 'llm_fetch_error') return ':warning:'
  if (error.retryable) return ':warning:'
  return ':x:'
}

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

export function createRateLimitError(message: string, resetTime: Date): ErrorInfo {
  return createErrorInfo('rate_limit', message, true, {
    resetTime,
    suggestedAction: `Please wait until ${resetTime.toISOString()} and try again.`,
  })
}

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

/** Stable provider error codes that indicate quota exhaustion. */
const QUOTA_FALLBACK_CODES = new Set(['insufficient_quota', 'usage_not_included'])

/** Tightly bounded text patterns that indicate quota exhaustion; must not match ordinary rate-limit/fetch/auth text. */
const QUOTA_FALLBACK_MESSAGE_PATTERNS = [
  /usage limit reached\..*enable usage from your available balance/i,
  /exhausted (your|the) credits/i,
  /top up your available balance/i,
] as const

/**
 * Classify a normalized error signal as `quota_exceeded`, or `null` when it
 * is not. `retry-status` requires an exact `reason === 'account_rate_limit'`
 * match (no partial/prefix matching). `session-error` matches HTTP 402, an
 * allowlisted stable code, or a bounded exhausted-quota message pattern.
 * Never echoes the raw input into the returned `ErrorInfo`.
 */
export function classifyQuotaError(input: QuotaErrorInput): ErrorInfo | null {
  if (input.kind === 'retry-status') {
    if (input.reason !== 'account_rate_limit') return null
    return createQuotaExceededError({resetTime: input.resetAt})
  }

  const status = input.status
  if (status !== undefined && Number.isFinite(status) && status === 402) {
    return createQuotaExceededError()
  }

  const code = input.code
  if (code !== undefined && QUOTA_FALLBACK_CODES.has(code)) {
    return createQuotaExceededError()
  }

  const message = input.message
  if (typeof message === 'string' && message.length > 0) {
    const matches = QUOTA_FALLBACK_MESSAGE_PATTERNS.some(pattern => pattern.test(message))
    if (matches) return createQuotaExceededError()
  }

  return null
}

/**
 * Create the fixed, non-retryable `quota_exceeded` ErrorInfo. Output is
 * bounded to fixed guidance plus an optional trusted `provider` name and a
 * normalized `resetTime`; never a raw provider payload.
 */
export function createQuotaExceededError(options?: {provider?: string; resetTime?: Date}): ErrorInfo {
  return createErrorInfo(
    'quota_exceeded',
    'Provider quota exceeded. This run has stopped because the configured model has reached its usage limit.',
    false,
    {
      details: options?.provider == null ? undefined : `Provider: ${options.provider}`,
      suggestedAction:
        'Check the provider account/billing settings, wait for the quota to reset, or switch to a different model or provider.',
      resetTime: options?.resetTime,
    },
  )
}
