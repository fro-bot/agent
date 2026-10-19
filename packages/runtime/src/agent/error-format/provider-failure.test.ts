import {describe, expect, it} from 'vitest'

import {classifyProviderFailure, retrySignalFromStatus, terminalSignalFromPayload} from './provider-failure.js'

function retry(reason: string | undefined, resetAt?: Date | number) {
  return {source: 'retry-status', reason, resetAt} as const
}

/** Classify a raw `session.status` payload the way both surfaces do: extract, then classify. */
function classifyStatus(status: unknown) {
  const signal = retrySignalFromStatus(status)
  return signal === null ? null : classifyProviderFailure(signal)
}

/** Classify a raw OpenCode error payload the way both surfaces do: extract, then classify. */
function classifyPayload(payload: unknown, options?: {detail?: string; model?: string}) {
  return classifyProviderFailure(terminalSignalFromPayload(payload, options))
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
  ])('returns null for a retry with reason %j so the caller keeps waiting', reason => {
    // #given / #when / #then
    expect(classifyProviderFailure(retry(reason))).toBeNull()
  })

  it.each([undefined, null, 42, {reason: 'auth_unavailable'}, ['auth_unavailable']])(
    'returns null for a retry status whose action.reason is %j',
    reason => {
      // #given a status whose reason is missing or not a string
      const status = {type: 'retry', action: {reason}}

      // #when / #then
      expect(classifyStatus(status)).toBeNull()
    },
  )

  it('ignores a retry that carries only text', () => {
    // #given — retried failures whose text names auth, a model, or quota are not evidence the retry is hopeless
    const messages = [
      'auth_unavailable: no auth available',
      'Model not found: openai/gpt-9. Did you mean: gpt-5?',
      'Usage limit reached. Enable usage from your available balance',
      'Service Unavailable (503)',
    ]

    // #when / #then
    for (const message of messages) expect(classifyStatus({type: 'retry', message})).toBeNull()
  })

  it('never carries provider text in the result', () => {
    // #given
    const status = {type: 'retry', action: {reason: 'auth_unavailable'}, message: 'sk-live-SECRET'}

    // #when
    const result = classifyStatus(status)

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

  it('matches usage-limit text past the hint cap: the stop patterns read the whole message', () => {
    // #given — a provider error that echoes a long body before its usage-limit phrase
    const message = `${'x'.repeat(5_000)} Usage limit reached. Enable usage from your available balance`

    // #when
    const result = classifyProviderFailure({source: 'terminal-payload', message})

    // #then
    expect(result).toMatchObject({kind: 'quota', evidence: 'text', stop: true})
  })

  it('matches a "Model not found:" line past the hint cap', () => {
    // #given
    const message = `${'x'.repeat(5_000)}\nModel not found: openai/gpt-9. Did you mean: gpt-5?`

    // #when
    const result = classifyProviderFailure({source: 'terminal-payload', message})

    // #then
    expect(result).toMatchObject({kind: 'model-not-found', evidence: 'text', stop: true})
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
    const nonBoolean = classifyPayload({isRetryable: 'yes'}, {detail: 'x'})

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
    const status = {type: 'retry', action: {reason: 'auth_unavailable'}, message: 'rate limit'}

    // #when / #then
    expect(classifyStatus(status)).toMatchObject({kind: 'auth', evidence: 'structured', stop: true})
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
    const status = {type: 'retry', message}

    // #when / #then
    expect(classifyStatus(status)).toBeNull()
  })

  it('stops on a retry that carries an account rate limit action (was: keeps waiting)', () => {
    // #given
    const status = {type: 'retry', action: {reason: 'account_rate_limit'}, message: 'Go limit reached'}

    // #when / #then
    expect(classifyStatus(status)).toMatchObject({kind: 'quota', evidence: 'structured', stop: true})
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

describe('classifyProviderFailure — classificationPath', () => {
  it.each(['auth_unavailable', 'account_rate_limit', 'model_not_found', 'model_not_supported'])(
    'reports structured for a %s retry status',
    reason => {
      // #given / #when / #then
      expect(classifyProviderFailure(retry(reason))?.classificationPath).toBe('structured')
    },
  )

  it.each([
    {label: 'ProviderAuthError', signal: {name: 'ProviderAuthError'}, expected: 'structured'},
    {label: 'ContextOverflowError', signal: {name: 'ContextOverflowError'}, expected: 'structured'},
    {label: 'status 402', signal: {status: 402}, expected: 'structured'},
    {label: 'quota code', signal: {code: 'insufficient_quota'}, expected: 'structured'},
    {
      label: 'usage-limit text (recorded as structured since the Action first matched it)',
      signal: {message: 'You have exhausted your credits'},
      expected: 'structured',
    },
    {label: '"Model not found:" text', signal: {message: 'Model not found: openai/gpt-9.'}, expected: 'fallback'},
    {label: 'auth hint', signal: {message: 'no auth available'}, expected: 'fallback'},
    {label: 'model hint', signal: {message: 'model is not supported'}, expected: 'fallback'},
    {label: 'fetch failure label', signal: {detail: 'fetch failed'}, expected: 'fallback'},
    {label: '429 label', signal: {status: 429, detail: 'status=429'}, expected: 'name'},
    {label: 'isRetryable true', signal: {isRetryable: true, detail: 'x'}, expected: 'structured'},
    {label: 'isRetryable false', signal: {isRetryable: false, detail: 'x'}, expected: 'structured'},
    {label: 'a name only', signal: {name: 'UnknownError', detail: 'x'}, expected: 'name'},
    {label: 'a status only', signal: {status: 500, detail: 'x'}, expected: 'name'},
    {label: 'a code only', signal: {code: 'weird', detail: 'x'}, expected: 'name'},
    {label: 'nothing', signal: {detail: 'x'}, expected: 'unclassified'},
    {label: 'MessageAbortedError (generic ladder)', signal: {name: 'MessageAbortedError'}, expected: 'name'},
  ] as const)('reports $expected for $label', ({signal, expected}) => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', ...signal})

    // #then
    expect(result.classificationPath).toBe(expected)
  })
})

describe('classifyProviderFailure — hints keep retryability', () => {
  it.each([
    {label: 'auth wording', message: 'no auth available', type: 'provider_auth_error'},
    {label: 'model wording', message: 'model is not supported', type: 'model_not_found'},
  ])('keeps a $label hint retryable when the payload says isRetryable', ({message, type}) => {
    // #given
    const result = classifyProviderFailure({source: 'terminal-payload', message, isRetryable: true})

    // #then — labelled, still not a stop, and retry admission is preserved
    expect(result).toMatchObject({evidence: 'hint', stop: false})
    expect(result.errorInfo).toMatchObject({type, retryable: true})
  })

  it.each([
    {message: 'no auth available', isRetryable: false},
    {message: 'no auth available', isRetryable: undefined},
    {message: 'model is not supported', isRetryable: false},
  ])('leaves a hint non-retryable otherwise: $message / $isRetryable', ({message, isRetryable}) => {
    // #given / #when
    const result = classifyProviderFailure({source: 'terminal-payload', message, isRetryable})

    // #then
    expect(result.errorInfo.retryable).toBe(false)
  })

  describe('a hint never changes retryability compared with the same payload without the hint', () => {
    const HINTS = [
      {label: 'auth wording', wording: 'no auth available', type: 'provider_auth_error'},
      {label: 'model wording', wording: 'model is not supported', type: 'model_not_found'},
    ] as const
    const CONTROL_WORDING = 'something odd happened'

    // `detail` is the caller's bounded diagnostic; for a plain string payload it is the string itself, which is
    // what the generic ladder's fetch-error check reads.
    const PAYLOADS = [
      {label: 'HTTP 429 with no isRetryable', build: (text: string) => ({status: 429, message: text}), retryable: true},
      {
        label: 'HTTP 429 with isRetryable false',
        build: (text: string) => ({status: 429, isRetryable: false, message: text}),
        retryable: true,
      },
      {
        label: 'isRetryable false',
        build: (text: string) => ({isRetryable: false, message: text, detail: 'x'}),
        retryable: false,
      },
      {
        label: 'isRetryable true',
        build: (text: string) => ({isRetryable: true, message: text, detail: 'x'}),
        retryable: true,
      },
      {label: 'no retry signal at all', build: (text: string) => ({message: text, detail: 'x'}), retryable: false},
      {
        label: 'a plain-string fetch failure',
        build: (text: string) => ({message: `fetch failed: ${text}`, detail: `fetch failed: ${text}`}),
        retryable: true,
      },
    ]

    it.each(HINTS.flatMap(hint => PAYLOADS.map(payload => ({hint, payload}))))(
      '$hint.label with $payload.label',
      ({hint, payload}) => {
        // #given the same payload, once with the hint wording and once with neutral wording
        const hinted = classifyProviderFailure({source: 'terminal-payload', ...payload.build(hint.wording)})
        const control = classifyProviderFailure({source: 'terminal-payload', ...payload.build(CONTROL_WORDING)})

        // #then the hint labels the failure without stopping it, and retryability is exactly the control's
        expect(control.evidence).toBe('none')
        expect(hinted).toMatchObject({evidence: 'hint', stop: false, classificationPath: 'fallback'})
        expect(hinted.errorInfo.type).toBe(hint.type)
        expect(hinted.errorInfo.retryable).toBe(control.errorInfo.retryable)
        expect(hinted.errorInfo.retryable).toBe(payload.retryable)
      },
    )
  })

  it('does not make a structured stop retryable', () => {
    // #given a structured auth failure that also claims isRetryable
    const result = classifyProviderFailure({source: 'terminal-payload', name: 'ProviderAuthError', isRetryable: true})

    // #then
    expect(result).toMatchObject({kind: 'auth', stop: true})
    expect(result.errorInfo.retryable).toBe(false)
  })
})

describe('terminalSignalFromPayload', () => {
  it('reads a message that exists only at the top level', () => {
    // #given / #when / #then
    expect(terminalSignalFromPayload({name: 'UnknownError', message: 'top'}).message).toBe('top')
  })

  it('reads a message that exists only in data (the OpenCode wire shape)', () => {
    // #given / #when / #then
    expect(terminalSignalFromPayload({name: 'APIError', data: {message: 'inner'}}).message).toBe('inner')
  })

  it('prefers data.message when both are present and different', () => {
    // #given — OpenCode declares every provider field on `data`; the top level is only a wrapper fallback
    const signal = terminalSignalFromPayload({message: 'top', data: {message: 'inner'}})

    // #then
    expect(signal.message).toBe('inner')
  })

  it.each([42, null, {nested: true}, ['x'], ''])(
    'falls back to the top-level message when data.message is %j',
    dataMessage => {
      // #given a non-string (or empty) data.message that must not shadow a valid fallback
      const signal = terminalSignalFromPayload({message: 'top', data: {message: dataMessage}})

      // #then
      expect(signal.message).toBe('top')
    },
  )

  it('reads the name from data when the top level has none, and prefers the top level when both exist', () => {
    // #given / #when / #then
    expect(terminalSignalFromPayload({data: {name: 'ProviderAuthError'}}).name).toBe('ProviderAuthError')
    expect(terminalSignalFromPayload({name: 'APIError', data: {name: 'ProviderAuthError'}}).name).toBe('APIError')
    expect(terminalSignalFromPayload({name: 7, data: {name: 'APIError'}}).name).toBe('APIError')
  })

  it('ignores a string status and falls through to a numeric statusCode', () => {
    // #given
    const signal = terminalSignalFromPayload({status: '402', data: {status: 'bad', statusCode: 402}})

    // #then
    expect(signal.status).toBe(402)
  })

  it('leaves status undefined when only strings are present', () => {
    // #given / #when / #then
    expect(terminalSignalFromPayload({status: '402', data: {statusCode: '402'}}).status).toBeUndefined()
  })

  it('reads status, then statusCode, from data before the top level', () => {
    // #given / #when / #then
    expect(terminalSignalFromPayload({status: 500, data: {statusCode: 402}}).status).toBe(402)
    expect(terminalSignalFromPayload({status: 500, statusCode: 402}).status).toBe(500)
    expect(terminalSignalFromPayload({statusCode: 402}).status).toBe(402)
  })

  it('reads code and isRetryable with the same data-first precedence and type narrowing', () => {
    // #given / #when
    const signal = terminalSignalFromPayload({code: 'top_code', isRetryable: true, data: {code: 5, isRetryable: 'no'}})

    // #then — the wrong-typed data values do not hide the valid top-level ones
    expect(signal.code).toBe('top_code')
    expect(signal.isRetryable).toBe(true)
    expect(terminalSignalFromPayload({data: {isRetryable: false}, isRetryable: true}).isRetryable).toBe(false)
  })

  it('treats a plain string payload as the message', () => {
    // #given / #when
    const signal = terminalSignalFromPayload('fetch failed: network error')

    // #then
    expect(signal.message).toBe('fetch failed: network error')
    expect(signal.name).toBeUndefined()
  })

  it.each([null, undefined, 7, true, []])('returns an empty signal for the payload %j', payload => {
    // #given / #when
    const signal = terminalSignalFromPayload(payload)

    // #then
    expect(signal).toEqual({
      source: 'terminal-payload',
      name: undefined,
      status: undefined,
      code: undefined,
      message: undefined,
      isRetryable: undefined,
      detail: undefined,
      model: undefined,
    })
  })

  it('ignores inherited properties', () => {
    // #given a payload whose fields live on the prototype
    const payload = Object.create({name: 'ProviderAuthError', message: 'inherited'}) as unknown

    // #when
    const signal = terminalSignalFromPayload(payload)

    // #then
    expect(signal.name).toBeUndefined()
    expect(signal.message).toBeUndefined()
  })

  it('passes detail and model through for the generic label', () => {
    // #given / #when
    const signal = terminalSignalFromPayload({}, {detail: 'name=X', model: 'a/b'})

    // #then
    expect(signal).toMatchObject({detail: 'name=X', model: 'a/b'})
  })

  it.each([
    {
      label: 'message only at the top level',
      payload: {name: 'UnknownError', message: 'Usage limit reached. Enable usage from your available balance'},
      kind: 'quota',
      stop: true,
    },
    {
      label: 'message only in data',
      payload: {name: 'UnknownError', data: {message: 'Usage limit reached. Enable usage from your available balance'}},
      kind: 'quota',
      stop: true,
    },
    {
      label: 'both present and different (data wins)',
      payload: {message: 'Usage limit reached. Enable usage from your available balance', data: {message: 'boom'}},
      kind: 'unclassified',
      stop: false,
    },
    {
      label: 'a non-string data.message (top level still read)',
      payload: {message: 'Model not found: openai/gpt-9.', data: {message: {nested: true}}},
      kind: 'model-not-found',
      stop: true,
    },
    {
      label: 'name only in data',
      payload: {data: {name: 'ProviderAuthError'}},
      kind: 'auth',
      stop: true,
    },
    {
      label: 'a string status with a numeric data.statusCode',
      payload: {status: '500', data: {statusCode: 402}},
      kind: 'quota',
      stop: true,
    },
    {
      label: 'a string status alone',
      payload: {status: '402'},
      kind: 'unclassified',
      stop: false,
    },
  ])('extracts $label so the rule sees one input per payload', ({payload, kind, stop}) => {
    // #given / #when
    const result = classifyPayload(payload)

    // #then
    expect(result.kind).toBe(kind)
    expect(result.stop).toBe(stop)
  })
})

describe('retrySignalFromStatus', () => {
  it('returns null for a status that is not a retry', () => {
    // #given / #when / #then
    for (const status of [{type: 'busy'}, {type: 'idle'}, null, undefined, 'retry', {}]) {
      expect(retrySignalFromStatus(status)).toBeNull()
    }
  })

  it('reads the structured action.reason and the numeric next, never the message', () => {
    // #given
    const status = {type: 'retry', message: 'auth_unavailable', action: {reason: 'account_rate_limit'}, next: 5}

    // #when / #then
    expect(retrySignalFromStatus(status)).toEqual({source: 'retry-status', reason: 'account_rate_limit', resetAt: 5})
  })

  it('drops a non-numeric next and an empty reason', () => {
    // #given / #when / #then
    expect(retrySignalFromStatus({type: 'retry', action: {reason: ''}, next: '5'})).toEqual({
      source: 'retry-status',
      reason: undefined,
      resetAt: undefined,
    })
  })
})

function timed(message: string) {
  const startedAt = performance.now()
  const result = classifyProviderFailure({source: 'terminal-payload', message})
  return {result, elapsedMs: performance.now() - startedAt}
}

describe('classifyProviderFailure — text matching stays linear on long messages', () => {
  // Generous so a slow CI runner does not flake: the quadratic pattern took seconds at this size, a linear
  // check takes a few milliseconds.
  const BUDGET_MS = 200
  const PREFIX = 'Usage limit reached. '
  const SUFFIX = 'Enable usage from your available balance'
  const repeated = PREFIX.repeat(Math.ceil(400_000 / PREFIX.length))

  it('does not match, and does not rescan, a ~400KB line of repeated usage-limit prefixes with no suffix', () => {
    // #given one line of repeated prefixes: each used to rescan to the end of the line
    // #when
    const {result, elapsedMs} = timed(repeated)

    // #then
    expect(result).toMatchObject({kind: 'unclassified', evidence: 'none', stop: false})
    expect(elapsedMs).toBeLessThan(BUDGET_MS)
  })

  it('matches a real suffix that comes after many repeated prefixes on a ~400KB line', () => {
    // #given
    // #when
    const {result, elapsedMs} = timed(repeated + SUFFIX)

    // #then
    expect(result).toMatchObject({kind: 'quota', evidence: 'text', stop: true})
    expect(elapsedMs).toBeLessThan(BUDGET_MS)
  })

  it('does not match when the suffix only appears before every prefix', () => {
    // #given the suffix first, then ~400KB of prefixes: the old pattern rescanned from each one
    // #when
    const {result, elapsedMs} = timed(`${SUFFIX} ${repeated}`)

    // #then
    expect(result.kind).toBe('unclassified')
    expect(elapsedMs).toBeLessThan(BUDGET_MS)
  })

  it('stays fast on many short lines, and finds a match on the last one', () => {
    // #given 20,000 lines with a prefix but no suffix, then one complete line
    const lines = `${`${PREFIX}and nothing else\n`.repeat(20_000)}${PREFIX}${SUFFIX}`

    // #when
    const {result, elapsedMs} = timed(lines)

    // #then
    expect(result).toMatchObject({kind: 'quota', evidence: 'text', stop: true})
    expect(elapsedMs).toBeLessThan(BUDGET_MS)
  })

  it('stays fast on a ~400KB "Model not found:" lookalike with no model id', () => {
    // #given the other full-message matcher, on its own worst-ish shapes
    const messages = [
      'Model not found: '.repeat(25_000),
      `Model not found: ${'a/'.repeat(200_000)}`,
      `Model not found: ${'a'.repeat(400_000)}`,
      `Model not found: a/${'.a'.repeat(200_000)}`,
    ]

    // #when / #then
    for (const message of messages) {
      const {elapsedMs} = timed(message)
      expect(elapsedMs).toBeLessThan(BUDGET_MS)
    }
  })
})
