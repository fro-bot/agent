import {describe, expect, it} from 'vitest'

import {
  classifyErrorText,
  classifyRetryStatus,
  classifyStructuredError,
  isAbortedError,
  isContextOverflowError,
} from './provider-failure.js'

function retry(fields: Record<string, unknown>): object {
  return {type: 'retry', attempt: 1, message: '', next: 0, ...fields}
}

describe('classifyRetryStatus', () => {
  it('returns null for a non-retry status', () => {
    // #given / #when / #then
    expect(classifyRetryStatus({type: 'busy'})).toBeNull()
    expect(classifyRetryStatus({type: 'idle'})).toBeNull()
    expect(classifyRetryStatus(null)).toBeNull()
    expect(classifyRetryStatus('retry')).toBeNull()
  })

  it('classifies the exact structured auth reason before looking at text', () => {
    // #given — the message says rate limit, the structured marker says auth
    const status = retry({message: 'rate limit', action: {reason: 'auth_unavailable'}})

    // #when / #then
    expect(classifyRetryStatus(status)).toEqual({reason: 'provider auth unavailable', errorName: 'retry-status'})
  })

  it('does not treat a near-miss structured reason as auth', () => {
    // #given
    const status = retry({action: {reason: 'auth_unavailable_soon'}})

    // #when / #then
    expect(classifyRetryStatus(status)).toBeNull()
  })

  it.each(['model_not_found', 'model_not_supported'])(
    'classifies the structured reason %s as model not available',
    reason => {
      // #given
      const status = retry({action: {reason}})

      // #when / #then
      expect(classifyRetryStatus(status)).toEqual({reason: 'model not available', errorName: 'retry-status'})
    },
  )

  it.each([
    'auth_unavailable: no auth available',
    'no auth available for this model',
    "'gpt-5.5' model is not supported when using Codex",
    'model not found',
    'model_not_found',
    'Model not found: openai/gpt-9. Did you mean: gpt-5?',
  ])('ignores message text on a retry status: %s', message => {
    // #given — a retried (e.g. 503) failure whose text names auth or a model, with no structured reason
    // #when / #then
    expect(classifyRetryStatus(retry({message}))).toBeNull()
  })

  it.each([
    'Too Many Requests',
    'rate limit exceeded',
    '429',
    'Provider is overloaded',
    'Internal server error',
    'Service Unavailable (503)',
    'fetch failed',
    'connection reset',
    'authentication token refreshed, retrying',
    'the model is warming up',
    '',
  ])('keeps waiting on a transient message: %j', message => {
    // #given / #when / #then
    expect(classifyRetryStatus(retry({message}))).toBeNull()
  })

  it('keeps waiting on a retry that only carries an account rate limit action', () => {
    // #given
    const status = retry({action: {reason: 'account_rate_limit'}, message: 'Go limit reached'})

    // #when / #then
    expect(classifyRetryStatus(status)).toBeNull()
  })

  it('only inspects a bounded prefix of a long message', () => {
    // #given — the marker sits past the bound
    const message = `${'x'.repeat(5_000)} auth_unavailable`

    // #when / #then
    expect(classifyErrorText(message).reason).toBe('session error')
  })

  it('never returns provider text', () => {
    // #given
    const status = retry({message: 'auth_unavailable: sk-live-SECRET', action: {reason: 'auth_unavailable'}})

    // #when
    const result = classifyRetryStatus(status)

    // #then
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
})

describe('classifyStructuredError', () => {
  it('classifies ProviderAuthError by name', () => {
    // #given / #when / #then
    expect(classifyStructuredError({name: 'ProviderAuthError', data: {message: 'x'}})).toEqual({
      reason: 'provider auth unavailable',
      errorName: 'ProviderAuthError',
    })
  })

  it('classifies a model rejection by the message in data', () => {
    // #given / #when / #then
    expect(classifyStructuredError({name: 'APIError', data: {message: 'model is not supported'}}).reason).toBe(
      'model not available',
    )
  })

  it('falls back to a fixed reason per error class', () => {
    // #given / #when / #then
    expect(classifyStructuredError({name: 'APIError', data: {message: 'Bad Request'}}).reason).toBe(
      'model provider rejected the request',
    )
    expect(classifyStructuredError({name: 'UnknownError', data: {message: 'boom'}}).reason).toBe('session error')
    expect(classifyStructuredError({}).reason).toBe('session error')
  })

  it.each([
    'ProviderAuthError',
    'APIError',
    'UnknownError',
    'MessageAbortedError',
    'MessageOutputLengthError',
    'ContextOverflowError',
    'StructuredOutputError',
    'ContentFilterError',
  ])('logs the known OpenCode error class %s by name', name => {
    // #given / #when / #then
    expect(classifyStructuredError({name}).errorName).toBe(name)
  })

  it.each(['sk-live-abc123', 'a.b-c', 'has spaces and sk-live', 'apierror', 'a'.repeat(200), 7, null])(
    'reports any other error name as "unknown": %j',
    name => {
      // #given / #when / #then
      expect(classifyStructuredError({name}).errorName).toBe('unknown')
    },
  )
})

describe('isContextOverflowError', () => {
  it('matches only the overflow marker', () => {
    // #given / #when / #then
    expect(isContextOverflowError({name: 'ContextOverflowError'})).toBe(true)
    expect(isContextOverflowError({name: 'APIError'})).toBe(false)
    expect(isContextOverflowError('ContextOverflowError')).toBe(false)
    expect(isContextOverflowError(null)).toBe(false)
  })
})

describe('isAbortedError', () => {
  it('matches only the abort marker', () => {
    // #given / #when / #then
    expect(isAbortedError({name: 'MessageAbortedError'})).toBe(true)
    expect(isAbortedError({name: 'ProviderAuthError'})).toBe(false)
    expect(isAbortedError(null)).toBe(false)
  })
})

describe('classifyErrorText', () => {
  it.each([
    ['auth_unavailable: no auth available', 'provider auth unavailable'],
    ["'gpt-5.5' model is not supported when using Codex", 'model not available'],
    ['Model not found: openai/gpt-9. Did you mean: gpt-5?', 'model not available'],
    ['LLM quota exceeded', 'session error'],
    ['', 'session error'],
  ])('classifies %j', (text, reason) => {
    // #given / #when / #then
    expect(classifyErrorText(text).reason).toBe(reason)
  })

  it('never returns the input text', () => {
    // #given / #when
    const result = classifyErrorText('auth_unavailable sk-live-SECRET')

    // #then
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
})
