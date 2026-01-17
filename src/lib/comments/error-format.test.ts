import {describe, expect, it} from 'vitest'
import {createErrorInfo, createLLMTimeoutError, createRateLimitError, formatErrorComment} from './error-format.js'

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
})
