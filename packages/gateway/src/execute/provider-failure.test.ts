import {describe, expect, it} from 'vitest'

import {
  failureFromErrorObject,
  failureFromErrorText,
  failureFromRetryStatus,
  isAbortedError,
  isContextOverflowError,
} from './provider-failure.js'

// The classification policy (rule table, precedence, evidence strength, the stop decision, the text patterns) is
// tested once, in `packages/runtime/src/agent/error-format/provider-failure.test.ts`. These tests cover only what
// stays in the gateway: extracting a signal from an OpenCode payload, the shared-kind → internal-reason mapping,
// and the error-name allowlist.

function retry(fields: Record<string, unknown>): object {
  return {type: 'retry', attempt: 1, message: '', next: 0, ...fields}
}

describe('failureFromRetryStatus — signal extraction and mapping', () => {
  it('returns null for a non-retry status', () => {
    // #given / #when / #then
    expect(failureFromRetryStatus({type: 'busy'})).toBeNull()
    expect(failureFromRetryStatus({type: 'idle'})).toBeNull()
    expect(failureFromRetryStatus(null)).toBeNull()
    expect(failureFromRetryStatus('retry')).toBeNull()
  })

  it.each([
    ['auth_unavailable', 'provider auth unavailable'],
    ['account_rate_limit', 'provider quota exceeded'],
    ['model_not_found', 'model not available'],
    ['model_not_supported', 'model not available'],
  ] as const)('maps the stopping retry reason %s to %j', (actionReason, reason) => {
    // #given a retry whose structured reason the shared function says can never recover
    const status = retry({action: {reason: actionReason}})

    // #when / #then
    expect(failureFromRetryStatus(status)).toEqual({reason, errorName: 'retry-status'})
  })

  it.each([
    ['no action', retry({})],
    ['a near-miss structured reason', retry({action: {reason: 'auth_unavailable_soon'}})],
    ['an unknown structured reason', retry({action: {reason: 'something_else'}})],
    ['a non-string structured reason', retry({action: {reason: 7}})],
    ['a transient 429 message', retry({message: 'Too Many Requests'})],
    ['a 503 whose text names auth', retry({message: '503 auth_unavailable: no auth available'})],
    ['a 503 whose text names a model', retry({message: '503 model not found: openai/gpt-9'})],
    [
      'usage-limit text without a structured reason',
      retry({message: 'Go limit reached. Top up your available balance'}),
    ],
  ])('keeps waiting on %s', (_label, status) => {
    // #given / #when / #then — only a structured reason stops a retry; its text never does
    expect(failureFromRetryStatus(status)).toBeNull()
  })

  it('never returns provider text', () => {
    // #given
    const status = retry({message: 'auth_unavailable: sk-live-SECRET', action: {reason: 'auth_unavailable'}})

    // #when
    const result = failureFromRetryStatus(status)

    // #then
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
})

describe('failureFromErrorObject — signal extraction and mapping', () => {
  it('maps ProviderAuthError to the auth reason and keeps its allowlisted name', () => {
    // #given / #when / #then
    expect(failureFromErrorObject({name: 'ProviderAuthError', data: {message: 'x'}})).toEqual({
      reason: 'provider auth unavailable',
      errorName: 'ProviderAuthError',
    })
  })

  it.each([
    ['a 402 status on the data object', {name: 'APIError', data: {message: 'Payment Required', statusCode: 402}}],
    ['a 402 status on the error', {name: 'APIError', status: 402, data: {message: 'Payment Required'}}],
    ['the insufficient_quota code', {name: 'APIError', data: {message: 'nope', code: 'insufficient_quota'}}],
    ['the usage_not_included code on the error', {name: 'APIError', code: 'usage_not_included', data: {message: 'x'}}],
    [
      'usage-limit text',
      {name: 'APIError', data: {message: 'Usage limit reached. Enable usage from your available balance'}},
    ],
  ])('labels %s as quota', (_label, error) => {
    // #given / #when / #then
    expect(failureFromErrorObject(error).reason).toBe('provider quota exceeded')
  })

  it('labels `Model not found:` text (text evidence) as model not available', () => {
    // #given / #when / #then
    const error = {name: 'UnknownError', data: {message: 'Model not found: openai/gpt-9. Did you mean: gpt-5?'}}
    expect(failureFromErrorObject(error).reason).toBe('model not available')
  })

  it('maps hint wording to its reason', () => {
    // #given / #when / #then
    expect(failureFromErrorObject({name: 'APIError', data: {message: 'model is not supported'}}).reason).toBe(
      'model not available',
    )
    expect(failureFromErrorObject({name: 'UnknownError', message: 'no auth available'}).reason).toBe(
      'provider auth unavailable',
    )
  })

  it('keeps the APIError fallback on the gateway: APIError with no other evidence was rejected by the provider', () => {
    // #given / #when / #then
    expect(failureFromErrorObject({name: 'APIError', data: {message: 'Bad Request'}}).reason).toBe(
      'model provider rejected the request',
    )
    expect(
      failureFromErrorObject({name: 'APIError', data: {message: 'Too Many Requests', statusCode: 429}}).reason,
    ).toBe('model provider rejected the request')
  })

  it('does not apply the APIError fallback to other classes or to a bare payload', () => {
    // #given / #when / #then
    expect(failureFromErrorObject({name: 'UnknownError', data: {message: 'boom'}}).reason).toBe('session error')
    expect(failureFromErrorObject({}).reason).toBe('session error')
    expect(failureFromErrorObject(null).reason).toBe('session error')
  })

  it('structured evidence outranks a quota-looking message on an auth error', () => {
    // #given — the name is structured auth evidence; the message is text
    const error = {name: 'ProviderAuthError', data: {message: 'Usage limit reached. Top up your available balance'}}

    // #when / #then
    expect(failureFromErrorObject(error).reason).toBe('provider auth unavailable')
  })

  it.each(['ContextOverflowError', 'MessageAbortedError'])(
    'gives the policy-owned class %s the generic label if it ever reaches the mapping',
    name => {
      // #given / #when / #then — `run-core` handles these before a failure is built
      expect(failureFromErrorObject({name}).reason).toBe('session error')
    },
  )

  it('never returns provider text', () => {
    // #given
    const error = {name: 'APIError', data: {message: 'model is not supported sk-live-SECRET', responseBody: 'SECRET'}}

    // #when
    const result = failureFromErrorObject(error)

    // #then
    expect(JSON.stringify(result)).not.toContain('SECRET')
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
    expect(failureFromErrorObject({name}).errorName).toBe(name)
  })

  it.each(['sk-live-abc123', 'a.b-c', 'has spaces and sk-live', 'apierror', 'a'.repeat(200), 7, null])(
    'reports any other error name as "unknown": %j',
    name => {
      // #given / #when / #then
      expect(failureFromErrorObject({name}).errorName).toBe('unknown')
    },
  )
})

describe('failureFromErrorText — plain-string session.error', () => {
  it.each([
    ['auth_unavailable: no auth available', 'provider auth unavailable'],
    ["'gpt-5.5' model is not supported when using Codex", 'model not available'],
    ['Model not found: openai/gpt-9. Did you mean: gpt-5?', 'model not available'],
    ['Usage limit reached. Enable usage from your available balance', 'provider quota exceeded'],
    ['LLM quota exceeded', 'session error'],
    ['', 'session error'],
  ])('labels %j', (text, reason) => {
    // #given / #when
    const result = failureFromErrorText(text)

    // #then
    expect(result).toEqual({reason, errorName: 'error-text'})
  })

  it('only inspects a bounded prefix of a long message', () => {
    // #given — the marker sits past the bound
    const message = `${'x'.repeat(5_000)} auth_unavailable`

    // #when / #then
    expect(failureFromErrorText(message).reason).toBe('session error')
  })

  it('never returns the input text', () => {
    // #given / #when
    const result = failureFromErrorText('auth_unavailable sk-live-SECRET')

    // #then
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
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
