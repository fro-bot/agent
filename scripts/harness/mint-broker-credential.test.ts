import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
  getIDToken: vi.fn<(audience?: string) => Promise<string>>(),
  setSecret: vi.fn<(value: string) => void>(),
  setOutput: vi.fn<(name: string, value: unknown) => void>(),
}))

vi.mock('@actions/core', () => ({
  getIDToken: mocks.getIDToken,
  setSecret: mocks.setSecret,
  setOutput: mocks.setOutput,
}))

const {BROKER_AUDIENCE, main, resolveBrokerUrl, validateBrokerResponse} = await import('./mint-broker-credential.js')

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response
}

const VALID_AUTH_JSON = {anthropic: {type: 'api', key: 'sk-ant-test-123'}}

describe('resolveBrokerUrl', () => {
  it('returns the BROKER_URL override when set', () => {
    // #given
    const env = {BROKER_URL: 'https://broker.test.local'}

    // #when
    const result = resolveBrokerUrl(env)

    // #then
    expect(result).toBe('https://broker.test.local')
  })

  it('returns the production default when BROKER_URL is unset', () => {
    // #given
    const env: NodeJS.ProcessEnv = {}

    // #when
    const result = resolveBrokerUrl(env)

    // #then
    expect(result).toBe('https://broker.fro.bot')
  })

  it('returns the production default when BROKER_URL is empty/whitespace', () => {
    // #given
    const env = {BROKER_URL: '   '}

    // #when
    const result = resolveBrokerUrl(env)

    // #then
    expect(result).toBe('https://broker.fro.bot')
  })
})

describe('validateBrokerResponse', () => {
  it('accepts a well-formed single-provider payload', () => {
    // #given
    const raw = JSON.stringify(VALID_AUTH_JSON)

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(true)
    expect((result as {ok: true; authJson: string}).authJson).toBe(JSON.stringify(VALID_AUTH_JSON))
  })

  it('accepts a well-formed multi-provider payload', () => {
    // #given
    const raw = JSON.stringify({
      anthropic: {type: 'api', key: 'sk-ant-1'},
      openai: {type: 'api', key: 'sk-openai-2'},
    })

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(true)
  })

  it('rejects invalid JSON', () => {
    // #given
    const raw = 'not valid json{{'

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
    expect((result as {ok: false; reason: string}).reason).toContain('not valid JSON')
  })

  it('rejects a JSON array', () => {
    // #given
    const raw = '["anthropic"]'

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects a JSON string', () => {
    // #given
    const raw = '"just a string"'

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects null', () => {
    // #given
    const raw = 'null'

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects an empty object (zero providers)', () => {
    // #given
    const raw = '{}'

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
    expect((result as {ok: false; reason: string}).reason).toContain('zero providers')
  })

  it('rejects a provider missing "type"', () => {
    // #given
    const raw = JSON.stringify({anthropic: {key: 'sk-ant-test'}})

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects a provider with a non-"api" type', () => {
    // #given
    const raw = JSON.stringify({anthropic: {type: 'oauth', key: 'sk-ant-test'}})

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects a provider with an empty key', () => {
    // #given
    const raw = JSON.stringify({anthropic: {type: 'api', key: ''}})

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
    expect((result as {ok: false; reason: string}).reason).toContain('empty or missing key')
  })

  it('rejects a provider with a non-string key', () => {
    // #given
    const raw = JSON.stringify({anthropic: {type: 'api', key: 12345}})

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects a provider id with invalid characters', () => {
    // #given — provider id contains a space, which the allowlist pattern forbids
    const raw = '{"bad provider": {"type": "api", "key": "sk-ant-test"}}'

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
    expect((result as {ok: false; reason: string}).reason).toContain('invalid characters')
  })

  it('rejects an entire payload with one valid and one invalid provider (all-or-nothing)', () => {
    // #given
    const raw = JSON.stringify({
      anthropic: {type: 'api', key: 'sk-ant-valid'},
      openai: {type: 'api', key: ''}, // invalid: empty key
    })

    // #when
    const result = validateBrokerResponse(raw)

    // #then — the entire payload is rejected, not just the bad provider
    expect(result.ok).toBe(false)
  })

  it('rejects a provider value that is not an object', () => {
    // #given
    const raw = JSON.stringify({anthropic: 'sk-ant-test'})

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects a provider value that is an array', () => {
    // #given
    const raw = JSON.stringify({anthropic: ['type', 'api']})

    // #when
    const result = validateBrokerResponse(raw)

    // #then
    expect(result.ok).toBe(false)
  })
})

describe('main — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
    mocks.getIDToken.mockResolvedValue('fake-oidc-jwt')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.exitCode = undefined
  })

  it('emits the masked payload as a step output and does not set a non-zero exit code', async () => {
    // #given a valid OIDC token and a well-formed broker response
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, VALID_AUTH_JSON))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBeUndefined()
    expect(mocks.setOutput).toHaveBeenCalledWith('auth-json', JSON.stringify(VALID_AUTH_JSON))
    expect(mocks.setSecret).toHaveBeenCalledWith(JSON.stringify(VALID_AUTH_JSON))
  })

  it('masks the OIDC token via setSecret before the broker POST fires', async () => {
    // #given
    const callOrder: string[] = []
    mocks.setSecret.mockImplementation((value: string) => {
      if (value === 'fake-oidc-jwt') callOrder.push('setSecret(oidc)')
    })
    const fetchMock = vi.fn().mockImplementation(async () => {
      callOrder.push('fetch')
      return jsonResponse(200, VALID_AUTH_JSON)
    })
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then — setSecret(oidc) happened strictly before fetch
    expect(callOrder).toEqual(['setSecret(oidc)', 'fetch'])
  })

  it('uses the correct broker audience for getIDToken', async () => {
    // #given
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, VALID_AUTH_JSON))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(mocks.getIDToken).toHaveBeenCalledWith(BROKER_AUDIENCE)
  })

  it('sends exactly one POST to <brokerUrl>/v1/mint with the bearer token', async () => {
    // #given
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, VALID_AUTH_JSON))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://broker.fro.bot/v1/mint')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer fake-oidc-jwt')
    expect(headers['Content-Type']).toBe('application/json')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('main — error paths (fail closed)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
    mocks.getIDToken.mockResolvedValue('fake-oidc-jwt')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.exitCode = undefined
  })

  it('exits non-zero and emits nothing when the broker returns a non-2xx status', async () => {
    // #given
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, {error: 'forbidden'}))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('exits non-zero and emits nothing when the broker returns 200 with a zero-provider body', async () => {
    // #given
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('exits non-zero and emits nothing when the broker returns 200 with a malformed body', async () => {
    // #given
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'not valid json{{',
    })
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('exits non-zero and emits nothing for a one-valid-one-invalid-provider payload (all-or-nothing)', async () => {
    // #given
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        anthropic: {type: 'api', key: 'sk-ant-valid'},
        openai: {type: 'api', key: ''},
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('fails fast on timeout without retrying (fetch called exactly once)', async () => {
    // #given — simulate what AbortSignal.timeout produces: fetch rejects with a timeout-shaped error
    const fetchMock = vi.fn().mockImplementation(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('exits non-zero immediately on a transient network error without retrying', async () => {
    // #given
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed: ECONNRESET'))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('fails closed when getIDToken throws (no id-token permission)', async () => {
    // #given
    mocks.getIDToken.mockRejectedValue(new Error('Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then — never reaches the network call, never emits a credential
    expect(process.exitCode).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('never places the OIDC token or minted credential in process.env on any failure branch', async () => {
    // #given
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, {}))
    vi.stubGlobal('fetch', fetchMock)
    const envSnapshotBefore = {...process.env}

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(process.env).toEqual(envSnapshotBefore)
  })
})
