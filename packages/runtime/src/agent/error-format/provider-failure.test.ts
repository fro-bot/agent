import {describe, expect, it} from 'vitest'

import {classifyProviderFailure} from './provider-failure.js'

function retry(reason: unknown, resetAt?: Date | number) {
  return {source: 'retry-status', reason, resetAt} as const
}

describe('classifyProviderFailure — retry status', () => {
  it('stops on auth_unavailable as structured auth', () => {
    // #given / #when
    const result = classifyProviderFailure(retry('auth_unavailable'))

    // #then
    expect(result).toMatchObject({kind: 'auth', evidence: 'structured', stop: true})
    expect(result?.errorInfo.type).toBe('provider_auth_error')
  })

  it('stops on account_rate_limit as structured quota and keeps the reset time', () => {
    // #given
    const resetAt = new Date('2026-07-16T12:00:00Z')

    // #when
    const result = classifyProviderFailure(retry('account_rate_limit', resetAt))

    // #then — the gateway used to keep waiting here; the shared rule stops
    expect(result).toMatchObject({kind: 'quota', evidence: 'structured', stop: true})
    expect(result?.errorInfo.type).toBe('quota_exceeded')
    expect(result?.errorInfo.resetTime).toEqual(resetAt)
  })

  it.each(['model_not_found', 'model_not_supported'])('stops on %s as structured model-not-found', reason => {
    // #given / #when
    const result = classifyProviderFailure(retry(reason))

    // #then
    expect(result).toMatchObject({kind: 'model-not-found', evidence: 'structured', stop: true})
    expect(result?.errorInfo.type).toBe('model_not_found')
    expect(result?.errorInfo.retryable).toBe(false)
  })

  it.each([
    'rate_limit',
    '429',
    'overloaded',
    'service_unavailable',
    'auth_unavailable_soon',
    'model_not_found_later',
    'ACCOUNT_RATE_LIMIT',
    '',
    undefined,
    null,
    42,
  ])('returns null for a retry with reason %j so the caller keeps waiting', reason => {
    // #given / #when / #then
    expect(classifyProviderFailure(retry(reason))).toBeNull()
  })

  it('ignores a retry that carries only text', () => {
    // #given — retried failures whose text names auth, a model, or quota are not evidence the retry is hopeless
    const signals = [
      {source: 'retry-status', message: 'auth_unavailable: no auth available'},
      {source: 'retry-status', message: 'Model not found: openai/gpt-9. Did you mean: gpt-5?'},
      {source: 'retry-status', message: 'Usage limit reached. Enable usage from your available balance'},
      {source: 'retry-status', message: 'Service Unavailable (503)'},
    ] as const

    // #when / #then
    for (const signal of signals) expect(classifyProviderFailure(signal)).toBeNull()
  })

  it('never carries provider text in the result', () => {
    // #given
    const signal = {source: 'retry-status', reason: 'auth_unavailable', message: 'sk-live-SECRET'} as const

    // #when
    const result = classifyProviderFailure(signal)

    // #then
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
})

describe('classifyProviderFailure — retry reset-time normalization', () => {
  it('keeps a finite epoch-millisecond reset time', () => {
    // #given
    const next = Date.parse('2026-07-16T12:00:00Z')

    // #when
    const result = classifyProviderFailure(retry('account_rate_limit', next))

    // #then
    expect(result?.errorInfo.resetTime).toEqual(new Date(next))
  })

  it('keeps a zero reset time: falsy but finite', () => {
    // #given / #when
    const result = classifyProviderFailure(retry('account_rate_limit', 0))

    // #then
    expect(result?.errorInfo.resetTime).toEqual(new Date(0))
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'omits a non-finite reset time %s but still classifies quota',
    next => {
      // #given / #when
      const result = classifyProviderFailure(retry('account_rate_limit', next))

      // #then
      expect(result?.errorInfo.type).toBe('quota_exceeded')
      expect(result?.errorInfo.resetTime).toBeUndefined()
    },
  )

  it('omits a finite reset time outside the Date range', () => {
    // #given — finite per Number.isFinite, but new Date(Number.MAX_VALUE) is an Invalid Date
    // #when
    const result = classifyProviderFailure(retry('account_rate_limit', Number.MAX_VALUE))

    // #then
    expect(result?.errorInfo.type).toBe('quota_exceeded')
    expect(result?.errorInfo.resetTime).toBeUndefined()
  })

  it('omits an Invalid Date reset time', () => {
    // #given / #when
    const result = classifyProviderFailure(retry('account_rate_limit', new Date(Number.NaN)))

    // #then
    expect(result?.errorInfo.type).toBe('quota_exceeded')
    expect(result?.errorInfo.resetTime).toBeUndefined()
  })

  it('omits a missing reset time', () => {
    // #given / #when
    const result = classifyProviderFailure(retry('account_rate_limit'))

    // #then
    expect(result?.errorInfo.resetTime).toBeUndefined()
  })
})

describe('classifyProviderFailure — terminal payload, structured', () => {
  it('stops on ProviderAuthError as structured auth', () => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', name: 'ProviderAuthError'})

    // #then
    expect(result).toMatchObject({kind: 'auth', evidence: 'structured', stop: true})
    expect(result.errorInfo.type).toBe('provider_auth_error')
  })

  it.each([
    {label: 'status 402', payload: {status: 402}},
    {label: 'code insufficient_quota', payload: {code: 'insufficient_quota'}},
    {label: 'code usage_not_included', payload: {code: 'usage_not_included'}},
  ])('stops on $label as structured quota', ({payload}) => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', ...payload})

    // #then
    expect(result).toMatchObject({kind: 'quota', evidence: 'structured', stop: true})
    expect(result.errorInfo.type).toBe('quota_exceeded')
  })

  it('does not treat a non-402 status or unknown code as quota', () => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', status: 500, code: 'server_error'})

    // #then
    expect(result).toMatchObject({kind: 'unclassified', evidence: 'none', stop: false})
  })

  it('reports ContextOverflowError as context-overflow without stopping', () => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', name: 'ContextOverflowError'})

    // #then — recovery is surface policy, so the shared rule does not stop
    expect(result).toMatchObject({kind: 'context-overflow', evidence: 'structured', stop: false})
    expect(result.errorInfo.type).toBe('context_overflow')
  })

  it('reports MessageAbortedError as aborted without stopping', () => {
    // #given / #when
    const result = classifyProviderFailure({
      source: 'terminal-payload',
      name: 'MessageAbortedError',
      detail: 'name=MessageAbortedError',
    })

    // #then — the Action has no abort label, so errorInfo is its generic agent error
    expect(result).toMatchObject({kind: 'aborted', evidence: 'structured', stop: false})
    expect(result.errorInfo.type).toBe('configuration')
  })

  it('does not match near-miss error names', () => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', name: 'providerautherror'})

    // #then
    expect(result).toMatchObject({kind: 'unclassified', evidence: 'none', stop: false})
  })
})

describe('classifyProviderFailure — terminal payload, text', () => {
  it.each([
    'Usage limit reached. Enable usage from your available balance to continue.',
    'You have exhausted your credits for this billing period.',
    'Please top up your available balance.',
  ])('stops on usage-limit text as quota: %s', message => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', message})

    // #then
    expect(result).toMatchObject({kind: 'quota', evidence: 'text', stop: true})
    expect(result.errorInfo.type).toBe('quota_exceeded')
  })

  it('stops on "Model not found:" text as model-not-found and extracts the model id', () => {
    // #given
    const message = 'Model not found: openai/gpt-9. Did you mean: gpt-5?'

    // #when
    const result = classifyProviderFailure({source: 'terminal-payload', name: 'UnknownError', message})

    // #then
    expect(result).toMatchObject({kind: 'model-not-found', evidence: 'text', stop: true})
    expect(result.errorInfo.type).toBe('model_not_found')
    expect(result.errorInfo.message).toBe('Model not found: openai/gpt-9. Did you mean: gpt-5?')
  })

  it('does not echo extra provider text from the model message', () => {
    // #given
    const message = 'Error: Model not found: openai/gpt-9. sk-live-SECRET\n    at stack frame'

    // #when
    const result = classifyProviderFailure({source: 'terminal-payload', message})

    // #then
    expect(result.kind).toBe('model-not-found')
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('does not treat ordinary rate-limit, fetch, or auth-adjacent text as quota', () => {
    // #given
    const messages = ['Too Many Requests', 'rate limit exceeded', 'fetch failed', 'authentication token refreshed']

    // #when / #then
    for (const message of messages) {
      expect(classifyProviderFailure({source: 'terminal-payload', message}).kind).toBe('unclassified')
    }
  })

  it('only inspects a bounded prefix of a long message', () => {
    // #given — the marker sits past the 2048-character bound
    const message = `${'x'.repeat(5_000)} Usage limit reached. Enable usage from your available balance`

    // #when
    const result = classifyProviderFailure({source: 'terminal-payload', message})

    // #then
    expect(result).toMatchObject({kind: 'unclassified', evidence: 'none', stop: false})
  })
})

describe('classifyProviderFailure — terminal payload, hint', () => {
  it.each(['auth_unavailable: no auth available', 'no auth available for this model', 'got auth_unavailable'])(
    'labels auth wording as an auth hint that never stops: %s',
    message => {
      // #given / #when
      const result = classifyProviderFailure({source: 'terminal-payload', message})

      // #then
      expect(result).toMatchObject({kind: 'auth', evidence: 'hint', stop: false})
      expect(result.errorInfo.type).toBe('provider_auth_error')
    },
  )

  it.each([
    "'gpt-5.5' model is not supported when using Codex",
    'model not found',
    'model_not_found',
    'The model not supported here',
  ])('labels loose model wording as a model hint that never stops: %s', message => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', name: 'APIError', message})

    // #then
    expect(result).toMatchObject({kind: 'model-not-found', evidence: 'hint', stop: false})
    expect(result.errorInfo.type).toBe('model_not_found')
  })

  it('never lets a message be auth evidence for a structured or stop decision', () => {
    // #given — runtime's rule: only the ProviderAuthError name is auth evidence
    const payloads = [
      {source: 'terminal-payload', message: 'auth_unavailable'},
      {source: 'terminal-payload', name: 'APIError', message: 'no auth available'},
      {source: 'terminal-payload', status: 401, code: 'unauthorized', message: 'no auth available'},
    ] as const

    // #when / #then
    for (const payload of payloads) {
      const result = classifyProviderFailure(payload)
      expect(result.stop).toBe(false)
      expect(result.evidence).not.toBe('structured')
    }
  })

  it('never stops for any hint-evidence result', () => {
    // #given
    const messages = [
      'auth_unavailable',
      'no auth available',
      'model_not_found',
      'model is not supported',
      'model not found',
    ]

    // #when / #then
    for (const message of messages) {
      const result = classifyProviderFailure({source: 'terminal-payload', message})
      expect(result.evidence).toBe('hint')
      expect(result.stop).toBe(false)
    }
  })

  it('only inspects a bounded prefix of a long hint message', () => {
    // #given
    const message = `${'x'.repeat(5_000)} auth_unavailable`

    // #when
    const result = classifyProviderFailure({source: 'terminal-payload', message})

    // #then
    expect(result).toMatchObject({kind: 'unclassified', evidence: 'none', stop: false})
  })

  it('never returns the input text', () => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', message: 'auth_unavailable sk-live-SECRET'})

    // #then
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
})

describe('classifyProviderFailure — terminal payload, generic ladder', () => {
  it('returns unclassified with the fixed placeholder when there is no evidence', () => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload'})

    // #then
    expect(result).toMatchObject({kind: 'unclassified', evidence: 'none', stop: false})
    expect(result.errorInfo.type).toBe('configuration')
    expect(result.errorInfo.message).toBe('Agent error: Unknown session error')
  })

  it('labels network failures as llm_fetch_error with the model detail', () => {
    // #given / #when
    const result = classifyProviderFailure({
      source: 'terminal-payload',
      detail: 'fetch failed',
      model: 'anthropic/claude',
    })

    // #then
    expect(result).toMatchObject({kind: 'unclassified', evidence: 'none', stop: false})
    expect(result.errorInfo.type).toBe('llm_fetch_error')
    expect(result.errorInfo.details).toBe('Model: anthropic/claude')
  })

  it('labels a 429 as a retryable rate_limit', () => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', status: 429, detail: 'status=429'})

    // #then
    expect(result).toMatchObject({kind: 'unclassified', evidence: 'none', stop: false})
    expect(result.errorInfo).toMatchObject({type: 'rate_limit', retryable: true, message: 'status=429'})
  })

  it('labels isRetryable: true as a retryable API error', () => {
    // #given / #when
    const result = classifyProviderFailure({
      source: 'terminal-payload',
      isRetryable: true,
      detail: 'name=APIError',
      model: 'm',
    })

    // #then
    expect(result.errorInfo).toMatchObject({type: 'api_error', retryable: true})
    expect(result.errorInfo.details).toBe('Model: m')
    expect(result.stop).toBe(false)
  })

  it('labels isRetryable: false and non-boolean as a non-retryable agent error', () => {
    // #given / #when
    const explicitFalse = classifyProviderFailure({source: 'terminal-payload', isRetryable: false, detail: 'x'})
    const nonBoolean = classifyProviderFailure({source: 'terminal-payload', isRetryable: 'yes', detail: 'x'})

    // #then
    for (const result of [explicitFalse, nonBoolean]) {
      expect(result.errorInfo).toMatchObject({type: 'configuration', retryable: false, message: 'Agent error: x'})
    }
  })

  it('applies the ladder in order: fetch beats 429 beats retryable', () => {
    // #given
    const base = {source: 'terminal-payload', status: 429, isRetryable: true} as const

    // #when
    const fetch = classifyProviderFailure({...base, detail: 'ECONNRESET'})
    const rateLimit = classifyProviderFailure({...base, detail: 'status=429'})
    const retryable = classifyProviderFailure({...base, status: 500, detail: 'status=500'})

    // #then
    expect(fetch.errorInfo.type).toBe('llm_fetch_error')
    expect(rateLimit.errorInfo.type).toBe('rate_limit')
    expect(retryable.errorInfo.type).toBe('api_error')
  })
})

describe('classifyProviderFailure — precedence', () => {
  it('structured overflow beats usage-limit text', () => {
    // #given
    const signal = {
      source: 'terminal-payload',
      name: 'ContextOverflowError',
      message: 'Usage limit reached. Enable usage from your available balance',
    } as const

    // #when
    const result = classifyProviderFailure(signal)

    // #then
    expect(result).toMatchObject({kind: 'context-overflow', evidence: 'structured', stop: false})
  })

  it('structured auth beats usage-limit text', () => {
    // #given / #when
    const result = classifyProviderFailure({
      source: 'terminal-payload',
      name: 'ProviderAuthError',
      message: 'Usage limit reached. Enable usage from your available balance',
    })

    // #then
    expect(result).toMatchObject({kind: 'auth', evidence: 'structured', stop: true})
  })

  it('structured quota beats model text', () => {
    // #given / #when
    const result = classifyProviderFailure({
      source: 'terminal-payload',
      status: 402,
      message: 'Model not found: openai/gpt-9.',
    })

    // #then
    expect(result).toMatchObject({kind: 'quota', evidence: 'structured', stop: true})
  })

  it('quota text upgrades a generic error', () => {
    // #given — everything else on the payload says generic network error
    const result = classifyProviderFailure({
      source: 'terminal-payload',
      detail: 'fetch failed',
      isRetryable: true,
      message: 'You have exhausted your credits',
    })

    // #then
    expect(result).toMatchObject({kind: 'quota', evidence: 'text', stop: true})
    expect(result.errorInfo.type).toBe('quota_exceeded')
  })

  it('text beats hint', () => {
    // #given — both a stop pattern and a hint pattern in one message
    const result = classifyProviderFailure({
      source: 'terminal-payload',
      message: 'auth_unavailable. Model not found: openai/gpt-9.',
    })

    // #then
    expect(result).toMatchObject({kind: 'model-not-found', evidence: 'text', stop: true})
  })

  it('hint beats the generic ladder', () => {
    // #given
    const result = classifyProviderFailure({
      source: 'terminal-payload',
      message: 'auth_unavailable',
      status: 429,
      isRetryable: true,
      detail: 'fetch failed',
    })

    // #then
    expect(result).toMatchObject({kind: 'auth', evidence: 'hint', stop: false})
  })

  it('usage-limit text beats the model text pattern', () => {
    // #given / #when
    const result = classifyProviderFailure({
      source: 'terminal-payload',
      message: 'Model not found: openai/gpt-9. Usage limit reached. Enable usage from your available balance',
    })

    // #then
    expect(result.kind).toBe('quota')
  })
})

describe('classifyProviderFailure — ported gateway policy cases', () => {
  it('classifies the structured auth retry reason ahead of any text', () => {
    // #given — the message says rate limit, the structured marker says auth
    const signal = {source: 'retry-status', reason: 'auth_unavailable', message: 'rate limit'} as const

    // #when / #then
    expect(classifyProviderFailure(signal)).toMatchObject({kind: 'auth', evidence: 'structured', stop: true})
  })

  it('does not treat a near-miss structured reason as auth', () => {
    // #given / #when / #then
    expect(classifyProviderFailure(retry('auth_unavailable_soon'))).toBeNull()
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
  ])('keeps waiting on a transient retry message: %j', message => {
    // #given — the caller has only text, so no structured reason reaches the classifier
    const signal = {source: 'retry-status', message} as const

    // #when / #then
    expect(classifyProviderFailure(signal)).toBeNull()
  })

  it('stops on a retry that carries an account rate limit action (was: keeps waiting)', () => {
    // #given
    const signal = {source: 'retry-status', reason: 'account_rate_limit', message: 'Go limit reached'} as const

    // #when / #then
    expect(classifyProviderFailure(signal)).toMatchObject({kind: 'quota', evidence: 'structured', stop: true})
  })

  it('classifies a model rejection carried only in message data as a model hint', () => {
    // #given
    const result = classifyProviderFailure({
      source: 'terminal-payload',
      name: 'APIError',
      message: 'model is not supported',
    })

    // #then
    expect(result).toMatchObject({kind: 'model-not-found', evidence: 'hint', stop: false})
  })

  it('falls back to unclassified for an APIError, UnknownError, or empty payload without wording', () => {
    // #given / #when / #then
    for (const signal of [
      {source: 'terminal-payload', name: 'APIError', message: 'Bad Request'},
      {source: 'terminal-payload', name: 'UnknownError', message: 'boom'},
      {source: 'terminal-payload'},
    ] as const) {
      expect(classifyProviderFailure(signal)).toMatchObject({kind: 'unclassified', evidence: 'none', stop: false})
    }
  })

  it.each([
    ['auth_unavailable: no auth available', 'auth', 'hint'],
    ["'gpt-5.5' model is not supported when using Codex", 'model-not-found', 'hint'],
    ['Model not found: openai/gpt-9. Did you mean: gpt-5?', 'model-not-found', 'text'],
    ['LLM quota exceeded', 'unclassified', 'none'],
    ['', 'unclassified', 'none'],
  ] as const)('classifies plain-string text %j', (message, kind, evidence) => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', message})

    // #then
    expect(result.kind).toBe(kind)
    expect(result.evidence).toBe(evidence)
  })
})
