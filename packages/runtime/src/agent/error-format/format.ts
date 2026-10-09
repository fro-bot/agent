import type {
  ContextOverflowErrorInput,
  ErrorInfo,
  ErrorType,
  ModelNotFoundErrorInput,
  ProviderAuthErrorInput,
  QuotaErrorInput,
} from './types.js'

const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
  api_error: 'API Error',
  configuration: 'Configuration Error',
  context_overflow: 'Context Overflow',
  internal: 'Internal Error',
  llm_fetch_error: 'LLM Fetch Error',
  llm_timeout: 'LLM Timeout',
  model_not_found: 'Model Not Found',
  permission: 'Permission Error',
  provider_auth_error: 'Provider Authentication Error',
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

// Retain until transport failures expose a stable structured SDK marker.
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

/**
 * Build a retryable error for a provider failure the API itself marked as
 * retryable. Deliberately claims no cause: the provider stated the request may
 * succeed if repeated, and nothing in that signal identifies the failure as a
 * network fault, so describing it as one would assert something unobserved.
 */
export function createRetryableApiError(message: string, model?: string): ErrorInfo {
  return createErrorInfo('api_error', `Provider request failed: ${message}`, true, {
    details: model == null ? undefined : `Model: ${model}`,
    suggestedAction: 'The provider reported this failure as retryable. The request may succeed on retry.',
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

// Retain until agent-not-found failures expose a stable structured SDK marker.
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

// `<providerID>/<modelID>` as OpenCode renders it (the model id may itself contain `/`). The lazy model id stops at
// the sentence-ending `.` (never a dot inside the id, e.g. `gpt-4.1`), then optional suggestions follow. Deliberately
// unanchored: the same text arrives bare (`SessionPrompt.getModel`) and wrapped by the error class name and stack
// frames (`Cause.pretty` in `prompt_async`'s failure handler).
const MODEL_NOT_FOUND_PATTERN = /Model not found: ([\w.:@+-]+\/[\w.:@+/-]+?)\.(?=\s|$)(?: Did you mean: ([^\n?]*)\?)?/
const MODEL_SUGGESTION_PATTERN = /^[\w.:@+/-]{1,128}$/
const MODEL_NOT_FOUND_MAX_SUGGESTIONS = 5
const MODEL_NOT_FOUND_ACTION =
  'Check that the configured model id is correct. If it is, the OpenCode model catalog may not have loaded: ' +
  'make sure the job can reach models.opencode.ai (egress/firewall) or define the model explicitly in the OpenCode config.'

/**
 * Classify OpenCode's "requested model could not be resolved" failure as `model_not_found`.
 *
 * OpenCode (v1.18.34 `session/prompt.ts` `getModel`) reports it as a generic `UnknownError` whose only signal is
 * `Model not found: <provider>/<model>. Did you mean: a, b?`. Only the allowlisted model id and well-formed
 * suggestion ids are extracted into the result; the rest of the message (stack frames, class prefix, anything
 * provider-supplied) is never echoed.
 */
export function classifyModelNotFoundError(input: ModelNotFoundErrorInput): ErrorInfo | null {
  if (typeof input.message !== 'string') return null

  const match = MODEL_NOT_FOUND_PATTERN.exec(input.message)
  const model = match?.[1]
  if (model == null) return null

  const suggestions = (match?.[2] ?? '')
    .split(',')
    .map(suggestion => suggestion.trim())
    .filter(suggestion => MODEL_SUGGESTION_PATTERN.test(suggestion))
    .slice(0, MODEL_NOT_FOUND_MAX_SUGGESTIONS)
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : ''

  return createErrorInfo('model_not_found', `Model not found: ${model}.${hint}`, false, {
    suggestedAction: MODEL_NOT_FOUND_ACTION,
  })
}

const PROVIDER_AUTH_ERROR_MESSAGE = 'The model provider rejected authentication for this run.'
const PROVIDER_AUTH_ERROR_DETAILS = 'Authentication with the configured model provider is unavailable.'
const PROVIDER_AUTH_ERROR_ACTION = 'Check the model provider credentials and configuration, then try again.'

/** Create the fixed, non-retryable `provider_auth_error` ErrorInfo. */
export function createProviderAuthError(): ErrorInfo {
  return createErrorInfo('provider_auth_error', PROVIDER_AUTH_ERROR_MESSAGE, false, {
    details: PROVIDER_AUTH_ERROR_DETAILS,
    suggestedAction: PROVIDER_AUTH_ERROR_ACTION,
  })
}

const MAX_PROVIDER_AUTH_FIELD_LENGTH = 128

function normalizeProviderAuthString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > MAX_PROVIDER_AUTH_FIELD_LENGTH) return undefined
  return value
}

/**
 * Classify exact structured provider authentication markers as a fixed
 * `provider_auth_error`. Generic statuses, messages, codes, and retry reasons
 * are intentionally not authentication evidence.
 */
export function classifyProviderAuthError(input: ProviderAuthErrorInput): ErrorInfo | null {
  if (input.kind === 'retry-status') {
    if (normalizeProviderAuthString(input.reason) !== 'auth_unavailable') return null
    return createProviderAuthError()
  }

  if (normalizeProviderAuthString(input.name) === 'ProviderAuthError') {
    return createProviderAuthError()
  }

  return null
}

const CONTEXT_OVERFLOW_ERROR_MESSAGE = 'The model context window was exceeded while processing this run.'
const CONTEXT_OVERFLOW_ERROR_DETAILS = 'The current session reached the model context limit.'
const CONTEXT_OVERFLOW_ERROR_ACTION = 'Retry the run with a fresh session or reduce the prompt size.'

/** Create the fixed, non-retryable `context_overflow` ErrorInfo. */
export function createContextOverflowError(): ErrorInfo {
  return createErrorInfo('context_overflow', CONTEXT_OVERFLOW_ERROR_MESSAGE, false, {
    details: CONTEXT_OVERFLOW_ERROR_DETAILS,
    suggestedAction: CONTEXT_OVERFLOW_ERROR_ACTION,
  })
}

/**
 * Classify the exact structured context overflow marker as a fixed
 * `context_overflow` error without retaining the upstream payload.
 */
export function classifyContextOverflowError(input: ContextOverflowErrorInput): ErrorInfo | null {
  if (normalizeProviderAuthString(input.name) !== 'ContextOverflowError') return null
  return createContextOverflowError()
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
