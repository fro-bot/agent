import type {ErrorInfo, ErrorType} from './types.js'

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

function createErrorInfo(
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
