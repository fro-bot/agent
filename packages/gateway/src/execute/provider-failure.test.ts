import {describe, expect, it} from 'vitest'

import {classifyErrorText, classifyRetryStatus, classifyStructuredError, isAbortedError} from './provider-failure.js'

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
    expect(classifyRetryStatus(status)).toEqual({reason: 'provider auth unavailable', errorName: 'auth_unavailable'})
  })

  it('does not treat a near-miss structured reason as auth', () => {
    // #given
    const status = retry({action: {reason: 'auth_unavailable_soon'}})

    // #when / #then
    expect(classifyRetryStatus(status)).toBeNull()
  })

  it.each([
    ['auth_unavailable: no auth available', 'provider auth unavailable'],
    ['no auth available for this model', 'provider auth unavailable'],
    ["'gpt-5.5' model is not supported when using Codex", 'model not available'],
    ['model not found', 'model not available'],
    ['model_not_found', 'model not available'],
    ['Model not found: openai/gpt-9. Did you mean: gpt-5?', 'model not available'],
  ])('falls back to message text: %s', (message, reason) => {
    // #given / #when / #then
    expect(classifyRetryStatus(retry({message}))?.reason).toBe(reason)
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
    expect(classifyRetryStatus(retry({message}))).toBeNull()
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

  it('sanitizes the error name', () => {
    // #given / #when / #then
    expect(classifyStructuredError({name: 'has spaces and sk-live'}).errorName).toBe('unknown')
    expect(classifyStructuredError({name: 'a'.repeat(200)}).errorName).toBe('unknown')
    expect(classifyStructuredError({name: 7}).errorName).toBe('unknown')
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
