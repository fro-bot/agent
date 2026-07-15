import {describe, expect, it} from 'vitest'
import {
  createAgentError,
  createErrorInfo,
  createLLMFetchError,
  createLLMTimeoutError,
  createRateLimitError,
  formatErrorComment,
  isAgentNotFoundError,
  isLlmFetchError,
} from './error-format.js'

/**
 * `src/features/comments/error-format.ts` is a thin re-export of the
 * canonical `@fro-bot/runtime` error-format module (see
 * `packages/runtime/src/agent/error-format/format.test.ts` for the full
 * behavioral test suite). This file only proves the re-export surface
 * still resolves and behaves identically to the deleted local
 * implementation for existing callers.
 */
describe('comments/error-format (re-export smoke)', () => {
  it('re-exports createRateLimitError producing a retryable rate_limit ErrorInfo', () => {
    // #given a rate-limit message and a reset time
    // #when building an ErrorInfo via the re-exported createRateLimitError
    // #then it is classified as a retryable rate_limit error
    const error = createRateLimitError('API rate limit exceeded', new Date('2024-01-01T01:00:00Z'))
    expect(error.type).toBe('rate_limit')
    expect(error.retryable).toBe(true)
  })

  it('re-exports formatErrorComment producing markdown with icon and message', () => {
    // #given an ErrorInfo built via the re-exported createLLMTimeoutError
    // #when formatting it with the re-exported formatErrorComment
    // #then the markdown includes the timeout icon and the original message
    const error = createLLMTimeoutError('Model response timed out after 30s')
    const formatted = formatErrorComment(error)
    expect(formatted).toContain(':hourglass:')
    expect(formatted).toContain('Model response timed out')
  })

  it('re-exports createErrorInfo producing the requested error shape', () => {
    // #given a type/message/retryable triple
    // #when building an ErrorInfo via the re-exported createErrorInfo
    // #then the fields are set as requested
    const error = createErrorInfo('validation', 'Invalid input', false)
    expect(error.type).toBe('validation')
    expect(error.message).toBe('Invalid input')
    expect(error.retryable).toBe(false)
  })

  it('re-exports createLLMFetchError producing a retryable llm_fetch_error', () => {
    // #given a fetch failure message and model name
    // #when building an ErrorInfo via the re-exported createLLMFetchError
    // #then it is classified as a retryable llm_fetch_error with model details
    const error = createLLMFetchError('fetch failed', 'opencode/big-pickle')
    expect(error.type).toBe('llm_fetch_error')
    expect(error.retryable).toBe(true)
    expect(error.details).toContain('opencode/big-pickle')
  })

  it('re-exports isLlmFetchError detecting network failure messages', () => {
    // #given a fetch failure message
    // #when checking it via the re-exported isLlmFetchError
    // #then it is detected as an LLM fetch error
    expect(isLlmFetchError('fetch failed')).toBe(true)
    expect(isLlmFetchError('Invalid API key')).toBe(false)
  })

  it('re-exports isAgentNotFoundError detecting agent-not-found messages', () => {
    // #given an agent-not-found message
    // #when checking it via the re-exported isAgentNotFoundError
    // #then it is detected as an agent-not-found error
    expect(isAgentNotFoundError('agent not found')).toBe(true)
    expect(isAgentNotFoundError('fetch failed')).toBe(false)
  })

  describe('createAgentError (local compatibility wrapper)', () => {
    it('creates non-retryable agent error with enable-omo suggestion when agent is provided', () => {
      // #when creating an agent error with an agent name
      const error = createAgentError('agent not found', 'sisyphus')

      // #then it should be correctly structured with the historical oMo guidance
      expect(error.type).toBe('configuration')
      expect(error.retryable).toBe(false)
      expect(error.message).toContain('agent not found')
      expect(error.details).toContain('sisyphus')
      expect(error.suggestedAction).toContain('enable-omo: true')
    })

    it('creates error without agent when not provided', () => {
      // #when creating an agent error without agent name
      const error = createAgentError('unknown agent error')

      // #then it should work without agent details or oMo guidance
      expect(error.type).toBe('configuration')
      expect(error.message).toContain('unknown agent error')
      expect(error.details).toBeUndefined()
      expect(error.suggestedAction).toBe('Verify the agent name is correct.')
      expect(error.suggestedAction).not.toContain('enable-omo')
    })
  })
})
