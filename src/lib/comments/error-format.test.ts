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

describe('comments/error-format', () => {
  describe('formatErrorComment', () => {
    it('formats rate limit error with warning icon and reset time', () => {
      // #given a rate limit error
      const error = createRateLimitError('API rate limit exceeded', new Date('2024-01-01T01:00:00Z'))

      // #when formatting the error
      const formatted = formatErrorComment(error)

      // #then it should include warning icon
      expect(formatted).toContain(':warning:')
      // #then it should include the error type
      expect(formatted).toContain('Rate Limit')
      // #then it should include the message
      expect(formatted).toContain('API rate limit exceeded')
      // #then it should indicate it's retryable
      expect(formatted).toContain('retryable')
    })

    it('formats LLM timeout error with clock icon', () => {
      // #given an LLM timeout error
      const error = createLLMTimeoutError('Model response timed out after 30s')

      // #when formatting the error
      const formatted = formatErrorComment(error)

      // #then it should include timeout indicator
      expect(formatted).toContain(':hourglass:')
      // #then it should include the message
      expect(formatted).toContain('Model response timed out')
    })

    it('formats fatal error with error icon', () => {
      // #given an internal error (fatal)
      const error = createErrorInfo('internal', 'Unexpected failure', false)

      // #when formatting the error
      const formatted = formatErrorComment(error)

      // #then it should include error icon
      expect(formatted).toContain(':x:')
      // #then it should NOT indicate it's retryable
      expect(formatted).not.toContain('retryable')
    })

    it('includes suggested action when provided', () => {
      // #given an error with suggested action
      const error = createErrorInfo('permission', 'Insufficient permissions', false, {
        suggestedAction: 'Check repository permissions',
      })

      // #when formatting the error
      const formatted = formatErrorComment(error)

      // #then it should include the suggested action
      expect(formatted).toContain('Check repository permissions')
    })

    it('includes details when provided', () => {
      // #given an error with details
      const error = createErrorInfo('api_error', 'API call failed', true, {
        details: 'Status: 502 Bad Gateway',
      })

      // #when formatting the error
      const formatted = formatErrorComment(error)

      // #then it should include the details
      expect(formatted).toContain('502 Bad Gateway')
    })
  })

  describe('createErrorInfo', () => {
    it('creates error with required fields', () => {
      // #when creating a basic error
      const error = createErrorInfo('validation', 'Invalid input', false)

      // #then it should have the correct structure
      expect(error.type).toBe('validation')
      expect(error.message).toBe('Invalid input')
      expect(error.retryable).toBe(false)
      expect(error.details).toBeUndefined()
      expect(error.suggestedAction).toBeUndefined()
    })

    it('creates error with optional fields', () => {
      // #when creating an error with all fields
      const error = createErrorInfo('configuration', 'Missing config', false, {
        details: 'auth.json not found',
        suggestedAction: 'Add auth.json to secrets',
      })

      // #then it should include optional fields
      expect(error.details).toBe('auth.json not found')
      expect(error.suggestedAction).toBe('Add auth.json to secrets')
    })
  })

  describe('createRateLimitError', () => {
    it('creates retryable rate limit error with reset time', () => {
      // #given a reset time
      const resetTime = new Date('2024-01-01T01:00:00Z')

      // #when creating a rate limit error
      const error = createRateLimitError('Rate limit exceeded', resetTime)

      // #then it should be correctly structured
      expect(error.type).toBe('rate_limit')
      expect(error.retryable).toBe(true)
      expect(error.resetTime).toEqual(resetTime)
      expect(error.suggestedAction).toContain('wait')
    })
  })

  describe('createLLMTimeoutError', () => {
    it('creates retryable LLM timeout error', () => {
      // #when creating an LLM timeout error
      const error = createLLMTimeoutError('Response timed out')

      // #then it should be correctly structured
      expect(error.type).toBe('llm_timeout')
      expect(error.retryable).toBe(true)
      expect(error.suggestedAction).toBeDefined()
    })
  })

  describe('createLLMFetchError', () => {
    it('creates retryable LLM fetch error with model info', () => {
      // #when creating an LLM fetch error
      const error = createLLMFetchError('fetch failed', 'opencode/big-pickle')

      // #then it should be correctly structured
      expect(error.type).toBe('llm_fetch_error')
      expect(error.retryable).toBe(true)
      expect(error.message).toContain('fetch failed')
      expect(error.details).toContain('opencode/big-pickle')
      expect(error.suggestedAction).toBeDefined()
    })

    it('creates error without model when not provided', () => {
      // #when creating an LLM fetch error without model
      const error = createLLMFetchError('Connection refused')

      // #then it should work without model details
      expect(error.type).toBe('llm_fetch_error')
      expect(error.message).toContain('Connection refused')
      expect(error.details).toBeUndefined()
    })
  })

  describe('isLlmFetchError', () => {
    it('detects "fetch failed" error message', () => {
      // #given various error messages
      const errors = [
        'fetch failed',
        'FETCH FAILED',
        'Request: fetch failed after 3 retries',
        'Error: fetch failed due to network issue',
      ]

      // #then all should be detected as LLM fetch errors
      for (const msg of errors) {
        expect(isLlmFetchError(msg)).toBe(true)
      }
    })

    it('detects connection timeout errors', () => {
      // #given timeout-related error messages
      const errors = ['ConnectTimeoutError', 'Connection timed out', 'connect timeout']

      // #then all should be detected as LLM fetch errors
      for (const msg of errors) {
        expect(isLlmFetchError(msg)).toBe(true)
      }
    })

    it('detects ECONNREFUSED and network errors', () => {
      // #given network error messages
      const errors = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'network error']

      // #then all should be detected as LLM fetch errors
      for (const msg of errors) {
        expect(isLlmFetchError(msg)).toBe(true)
      }
    })

    it('returns false for non-fetch errors', () => {
      // #given non-network error messages
      const errors = ['Invalid API key', 'Rate limit exceeded', 'Permission denied', 'Syntax error in prompt', '']

      // #then none should be detected as LLM fetch errors
      for (const msg of errors) {
        expect(isLlmFetchError(msg)).toBe(false)
      }
    })

    it('handles Error objects with message property', () => {
      // #given an Error object
      const error = new Error('fetch failed')

      // #then it should detect the error
      expect(isLlmFetchError(error)).toBe(true)
    })

    it('handles objects with cause property', () => {
      // #given an error with cause
      const error = {message: 'Request failed', cause: 'fetch failed'}

      // #then it should detect via cause
      expect(isLlmFetchError(error)).toBe(true)
    })

    it('handles null and undefined safely', () => {
      // #then should return false without throwing
      expect(isLlmFetchError(null)).toBe(false)
      expect(isLlmFetchError(undefined)).toBe(false)
    })
  })

  describe('formatErrorComment for LLM fetch error', () => {
    it('formats LLM fetch error with warning icon', () => {
      // #given an LLM fetch error
      const error = createLLMFetchError('fetch failed', 'opencode/big-pickle')

      // #when formatting the error
      const formatted = formatErrorComment(error)

      // #then it should include warning icon (retryable)
      expect(formatted).toContain(':warning:')
      // #then it should include the error type label
      expect(formatted).toContain('LLM Fetch Error')
      // #then it should indicate it's retryable
      expect(formatted).toContain('retryable')
    })
  })

  describe('isAgentNotFoundError', () => {
    it('detects "agent not found" error messages', () => {
      // #given various agent error messages
      const errors = ['agent not found', 'Agent Not Found', 'Agent not found: sisyphus']

      // #then all should be detected as agent errors
      for (const msg of errors) {
        expect(isAgentNotFoundError(msg)).toBe(true)
      }
    })

    it('detects "unknown agent" error messages', () => {
      // #given unknown agent messages
      const errors = ['unknown agent: sisyphus', 'Unknown Agent']

      // #then all should be detected as agent errors
      for (const msg of errors) {
        expect(isAgentNotFoundError(msg)).toBe(true)
      }
    })

    it('detects "invalid agent" error messages', () => {
      // #given invalid agent messages
      const errors = ['invalid agent name', 'Invalid Agent']

      // #then all should be detected as agent errors
      for (const msg of errors) {
        expect(isAgentNotFoundError(msg)).toBe(true)
      }
    })

    it('detects "agent does not exist" patterns', () => {
      // #given agent does not exist messages
      const errors = ['agent sisyphus does not exist', 'Agent foo does not exist']

      // #then all should be detected as agent errors
      for (const msg of errors) {
        expect(isAgentNotFoundError(msg)).toBe(true)
      }
    })

    it('detects "no agent named" patterns', () => {
      // #given no agent named messages
      expect(isAgentNotFoundError('no agent named sisyphus')).toBe(true)
    })

    it('detects "agent is not available" patterns', () => {
      // #given agent not available messages
      expect(isAgentNotFoundError('agent sisyphus is not available')).toBe(true)
    })

    it('returns false for non-agent errors', () => {
      // #given non-agent error messages
      const errors = ['fetch failed', 'Rate limit exceeded', 'Permission denied', 'Invalid API key', '']

      // #then none should be detected as agent errors
      for (const msg of errors) {
        expect(isAgentNotFoundError(msg)).toBe(false)
      }
    })

    it('handles Error objects with message property', () => {
      // #given an Error object
      const error = new Error('agent not found')

      // #then it should detect the error
      expect(isAgentNotFoundError(error)).toBe(true)
    })

    it('handles objects with message property', () => {
      // #given an object with message
      const error = {message: 'unknown agent'}

      // #then it should detect via message
      expect(isAgentNotFoundError(error)).toBe(true)
    })

    it('handles null and undefined safely', () => {
      // #then should return false without throwing
      expect(isAgentNotFoundError(null)).toBe(false)
      expect(isAgentNotFoundError(undefined)).toBe(false)
    })
  })

  describe('createAgentError', () => {
    it('creates non-retryable agent error', () => {
      // #when creating an agent error
      const error = createAgentError('agent not found', 'sisyphus')

      // #then it should be correctly structured
      expect(error.type).toBe('configuration')
      expect(error.retryable).toBe(false)
      expect(error.message).toContain('agent not found')
      expect(error.details).toContain('sisyphus')
      expect(error.suggestedAction).toBeDefined()
    })

    it('creates error without agent when not provided', () => {
      // #when creating an agent error without agent name
      const error = createAgentError('unknown agent error')

      // #then it should work without agent details
      expect(error.type).toBe('configuration')
      expect(error.message).toContain('unknown agent error')
      expect(error.details).toBeUndefined()
    })
  })
})
