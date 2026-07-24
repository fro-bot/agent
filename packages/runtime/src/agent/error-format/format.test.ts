import type {ProviderAuthErrorInput} from './types.js'
import {describe, expect, expectTypeOf, it} from 'vitest'
import {
  classifyProviderAuthError,
  classifyQuotaError,
  createAgentError,
  createErrorInfo,
  createLLMFetchError,
  createLLMTimeoutError,
  createProviderAuthError,
  createQuotaExceededError,
  createRateLimitError,
  formatErrorComment,
  isAgentNotFoundError,
  isLlmFetchError,
} from './format.js'

describe('agent/error-format/format', () => {
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

    it('formats quota_exceeded error with error icon and no retryable marker', () => {
      // #given a quota_exceeded error
      const error = createQuotaExceededError()

      // #when formatting the error
      const formatted = formatErrorComment(error)

      // #then it should include error icon (non-retryable)
      expect(formatted).toContain(':x:')
      // #then it should include the label
      expect(formatted).toContain('Quota Exceeded')
      // #then it should NOT indicate it's retryable
      expect(formatted).not.toContain('retryable')
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
    it('creates non-retryable configuration error with the generic suggested action', () => {
      const error = createAgentError('agent not found', 'sisyphus')

      expect(error.type).toBe('configuration')
      expect(error.retryable).toBe(false)
      expect(error.message).toContain('agent not found')
      expect(error.details).toContain('sisyphus')
      expect(error.suggestedAction).toBe(
        'Verify the agent name is correct and the required plugins (e.g., oMo) are installed.',
      )
    })

    it('creates error without agent when not provided, using the same suggested action', () => {
      const error = createAgentError('unknown agent error')

      expect(error.type).toBe('configuration')
      expect(error.message).toContain('unknown agent error')
      expect(error.details).toBeUndefined()
      expect(error.suggestedAction).toBe(
        'Verify the agent name is correct and the required plugins (e.g., oMo) are installed.',
      )
    })
  })

  describe('provider authentication errors', () => {
    it('keeps only classification fields in the provider auth input type', () => {
      // #given the provider authentication classifier input type
      // #when inspecting its shape
      expectTypeOf<ProviderAuthErrorInput>().not.toHaveProperty('status')
      expectTypeOf<ProviderAuthErrorInput>().not.toHaveProperty('code')
      expectTypeOf<ProviderAuthErrorInput>().not.toHaveProperty('providerID')
      expectTypeOf<ProviderAuthErrorInput>().not.toHaveProperty('message')
      // #then it excludes fields that do not affect classification
    })

    it('classifies the exact structured ProviderAuthError marker into fixed non-retryable output', () => {
      // #given a structured provider authentication failure with untrusted provider fields
      const providerId = 'provider-auth-sentinel-7f2c'
      const providerMessage = 'https://provider.example.invalid/account/sentinel-token'
      const input = {
        kind: 'session-error' as const,
        name: 'ProviderAuthError',
        providerID: providerId,
        message: providerMessage,
        status: 401,
        code: 'invalid_api_key',
      }

      // #when classifying the signal
      const error = classifyProviderAuthError(input)

      // #then it becomes the fixed provider authentication error
      expect(error).toEqual(createProviderAuthError())
      expect(error?.type).toBe('provider_auth_error')
      expect(error?.retryable).toBe(false)
    })

    it('classifies only the exact auth_unavailable retry reason into the same fixed error', () => {
      // #given OpenCode's issue-derived retry status marker
      const error = classifyProviderAuthError({kind: 'retry-status', reason: 'auth_unavailable'})

      // #then it becomes the same fixed provider authentication error
      expect(error).toEqual(createProviderAuthError())
      expect(error?.type).toBe('provider_auth_error')
      expect(error?.retryable).toBe(false)
    })

    it('classifies with hostile provider fields and does not leak sentinels', () => {
      // #given a structured marker with missing provider fields and a runtime object carrying hostile extras
      const missingFields = classifyProviderAuthError({kind: 'session-error', name: 'ProviderAuthError'})
      // Keep this as an inferred variable so the runtime extras are exercised instead of rejected by excess-property checking.
      const hostileInput = {
        kind: 'session-error' as const,
        name: 'ProviderAuthError',
        providerID: 'acct-sentinel-91d4',
        message: 'token-sentinel-52aa https://provider.example.invalid/account/sentinel',
        status: 401,
        code: 'account-sentinel-83e1',
      }
      const hostileError = classifyProviderAuthError(hostileInput)
      const rendered = JSON.stringify(hostileError) + formatErrorComment(hostileError ?? createProviderAuthError())

      // #then missing fields do not change the fixed output and no provider-controlled values are rendered
      expect(missingFields).toEqual(createProviderAuthError())
      expect(hostileError).toEqual(createProviderAuthError())
      expect(rendered).not.toContain('acct-sentinel-91d4')
      expect(rendered).not.toContain('token-sentinel-52aa')
      expect(rendered).not.toContain('https://provider.example.invalid')
      expect(rendered).not.toContain('account-sentinel-83e1')
      expect(rendered).not.toContain('401')
    })

    it('formats provider authentication errors as fixed non-retryable guidance', () => {
      // #given a fixed provider authentication error
      const error = createProviderAuthError()

      // #when formatting the error
      const formatted = formatErrorComment(error)

      // #then it uses the exhaustive provider-auth label and fatal icon without retry guidance
      expect(formatted).toContain(':x:')
      expect(formatted).toContain('Provider Authentication Error')
      expect(formatted).not.toContain('retryable')
    })

    it('does not classify generic outages, network failures, or unrelated markers', () => {
      // #given provider signals without one of the exact authentication markers
      const unrelatedNames = ['ProviderAutherror', 'providerautherror', 'ProviderAuthError ']
      const unrelatedReasons = ['account_rate_limit', 'service_unavailable', 'auth_unavailable_retry', '']

      // #then none become provider authentication errors
      for (const name of unrelatedNames) {
        expect(classifyProviderAuthError({kind: 'session-error', name})).toBeNull()
      }
      for (const reason of unrelatedReasons) {
        expect(classifyProviderAuthError({kind: 'retry-status', reason})).toBeNull()
      }
    })

    it('does not classify wrong-case, overlong, or malformed structured values', () => {
      // #given structured signals that are not valid provider-auth markers
      const overlongName = `ProviderAuthError${'x'.repeat(128)}`
      const overlongReason = `auth_unavailable${'x'.repeat(128)}`
      const nonAuthInputs = [
        {kind: 'session-error' as const, name: 'ProviderAuthError '},
        {kind: 'session-error' as const, name: 'providerautherror'},
        {kind: 'session-error' as const, name: overlongName},
        {kind: 'session-error' as const, name: 42},
        {kind: 'session-error' as const, name: {}},
        {kind: 'retry-status' as const, reason: 'AUTH_UNAVAILABLE'},
        {kind: 'retry-status' as const, reason: 'auth_unavailable_retry'},
        {kind: 'retry-status' as const, reason: overlongReason},
        {kind: 'retry-status' as const, reason: 42},
        {kind: 'retry-status' as const, reason: {}},
      ]

      // #then malformed or unrelated values remain outside the provider-auth category
      for (const input of nonAuthInputs) {
        expect(classifyProviderAuthError(input)).toBeNull()
      }
    })
  })

  describe('classifyQuotaError — retry-status primary path', () => {
    it('classifies exact reason "account_rate_limit" as non-retryable quota_exceeded with normalized reset time', () => {
      // #given a retry-status signal matching OpenCode's exact account_rate_limit reason
      const resetAt = new Date('2026-07-16T12:00:00Z')

      // #when classifying it
      const error = classifyQuotaError({kind: 'retry-status', reason: 'account_rate_limit', resetAt})

      // #then it becomes a non-retryable quota_exceeded error with the normalized reset time
      expect(error).not.toBeNull()
      expect(error?.type).toBe('quota_exceeded')
      expect(error?.retryable).toBe(false)
      expect(error?.resetTime).toEqual(resetAt)
    })

    it('does not classify any other action.reason as quota_exceeded', () => {
      // #given retry-status signals with other reasons
      const reasons = ['free_tier_limit', 'account_rate_limited', 'ACCOUNT_RATE_LIMIT', 'account rate limit', '']

      // #then none become quota_exceeded — the match must be exact, not partial/prefix
      for (const reason of reasons) {
        expect(classifyQuotaError({kind: 'retry-status', reason})).toBeNull()
      }
    })
  })

  describe('classifyQuotaError — structured/text fallback path', () => {
    it('classifies a structured session error with status 402 as quota_exceeded', () => {
      // #given a structured session error with HTTP 402 (Payment Required)
      const error = classifyQuotaError({kind: 'session-error', status: 402})

      // #then it becomes quota_exceeded
      expect(error?.type).toBe('quota_exceeded')
      expect(error?.retryable).toBe(false)
    })

    it('classifies explicit insufficient_quota code as quota_exceeded', () => {
      expect(classifyQuotaError({kind: 'session-error', code: 'insufficient_quota'})?.type).toBe('quota_exceeded')
    })

    it('classifies explicit usage_not_included code as quota_exceeded', () => {
      expect(classifyQuotaError({kind: 'session-error', code: 'usage_not_included'})?.type).toBe('quota_exceeded')
    })

    it('classifies a usage-limit-reached fallback message as quota_exceeded', () => {
      const message =
        'Usage limit reached. It will reset in 17 hours 56 minutes. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/acme/go'

      // #then it classifies as quota_exceeded without echoing the raw message/link in the output
      const error = classifyQuotaError({kind: 'session-error', message})
      expect(error?.type).toBe('quota_exceeded')
      expect(error?.message).not.toContain('https://opencode.ai')
      expect(error?.message).not.toContain('workspace/acme')
    })

    it('classifies exhausted-credits phrasing as quota_exceeded', () => {
      expect(
        classifyQuotaError({kind: 'session-error', message: 'You have exhausted your credits for this billing period'})
          ?.type,
      ).toBe('quota_exceeded')
    })

    it('classifies available-balance guidance phrasing as quota_exceeded', () => {
      expect(
        classifyQuotaError({kind: 'session-error', message: 'Please top up your available balance to continue'})?.type,
      ).toBe('quota_exceeded')
    })

    it('does not classify ordinary HTTP 429 without account_rate_limit as quota_exceeded', () => {
      expect(classifyQuotaError({kind: 'session-error', status: 429})).toBeNull()
    })

    it('does not classify ordinary rate-limit text as quota_exceeded', () => {
      expect(
        classifyQuotaError({kind: 'session-error', message: 'Rate limit exceeded, please retry after 60 seconds'}),
      ).toBeNull()
    })

    it('does not classify fetch, auth, overload, or arbitrary text as quota_exceeded', () => {
      const messages = [
        'fetch failed',
        'ECONNRESET',
        'Invalid API key',
        'Unauthorized',
        'Provider is overloaded',
        'Something went wrong',
      ]

      for (const message of messages) {
        expect(classifyQuotaError({kind: 'session-error', message})).toBeNull()
      }
    })

    it('does not classify empty or malformed values as quota_exceeded', () => {
      expect(classifyQuotaError({kind: 'session-error'})).toBeNull()
      expect(classifyQuotaError({kind: 'session-error', message: ''})).toBeNull()
      expect(classifyQuotaError({kind: 'session-error', status: Number.NaN})).toBeNull()
    })
  })

  describe('createQuotaExceededError', () => {
    it('creates a fixed, non-retryable, bounded quota_exceeded ErrorInfo', () => {
      // #when creating a quota exceeded error with a trusted provider and reset time
      const resetTime = new Date('2026-07-16T12:00:00Z')
      const error = createQuotaExceededError({provider: 'openai', resetTime})

      // #then the output is fixed guidance plus only the trusted provider and normalized reset time
      expect(error.type).toBe('quota_exceeded')
      expect(error.retryable).toBe(false)
      expect(error.resetTime).toEqual(resetTime)
      expect(error.details).toContain('openai')
      expect(error.suggestedAction).toBeDefined()
    })

    it('does not leak raw payload values from a structurally compatible session-error input', () => {
      // #given a session-error variable with unique sentinel values in its allowlisted message field
      // plus extra raw provider fields a caller might mistakenly forward
      const sentinelWorkspace = 'wksp-9f3a1c'
      const sentinelLimitName = 'limit-tier-77q'
      const sentinelAccount = 'acct-4e21b8'
      const rawSessionError = {
        kind: 'session-error' as const,
        message: `Usage limit reached. It will reset in 1 hour - enable usage from your available balance`,
        workspace: sentinelWorkspace,
        limitName: sentinelLimitName,
        account: sentinelAccount,
      }

      // #when classifying and formatting it
      const error = classifyQuotaError(rawSessionError)
      expect(error).not.toBeNull()
      if (error === null) throw new Error('Expected quota error')
      const rendered = JSON.stringify(error) + formatErrorComment(error)

      // #then none of the sentinel values appear anywhere in the output
      expect(rendered).not.toContain(sentinelWorkspace)
      expect(rendered).not.toContain(sentinelLimitName)
      expect(rendered).not.toContain(sentinelAccount)
    })
  })
})
