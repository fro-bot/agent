import {Buffer} from 'node:buffer'
import {generateKeyPairSync} from 'node:crypto'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
  setSecret: vi.fn<(value: string) => void>(),
  setOutput: vi.fn<(name: string, value: unknown) => void>(),
}))

vi.mock('@actions/core', () => ({
  setSecret: mocks.setSecret,
  setOutput: mocks.setOutput,
}))

const {buildAppJwt, main, validateTokenResponse} = await import('./mint-app-token.js')

const {privateKey, publicKey} = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {type: 'spki', format: 'pem'},
  privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
})

const MALFORMED_PEM = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function decodeJwtSegment(segment: string | undefined): Record<string, unknown> {
  if (segment === undefined) {
    throw new Error('missing JWT segment')
  }
  const padded = segment.replaceAll('-', '+').replaceAll('_', '/')
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>
}

const VALID_TOKEN_BODY = {
  token: 'ghs_faketoken123',
  expires_at: '2026-07-11T13:00:00Z',
  permissions: {contents: 'write'},
  repositories: [{name: 'agent'}],
}

describe('buildAppJwt', () => {
  it('produces a JWT with RS256 header, correct iss, and backdated iat', () => {
    // #given
    const nowSeconds = 1_752_000_000

    // #when
    const jwt = buildAppJwt('app-123', privateKey, nowSeconds)

    // #then
    const [headerSegment, payloadSegment] = jwt.split('.')
    const header = decodeJwtSegment(headerSegment)
    const payload = decodeJwtSegment(payloadSegment)
    expect(header.alg).toBe('RS256')
    expect(header.typ).toBe('JWT')
    expect(payload.iss).toBe('app-123')
    expect(payload.iat).toBe(nowSeconds - 60)
    expect(payload.exp).toBe(nowSeconds + 540)
    expect((payload.iat as number) < (payload.exp as number)).toBe(true)
  })

  it('throws when the private key is malformed', () => {
    // #given / #when / #then
    expect(() => buildAppJwt('app-123', MALFORMED_PEM, 1_752_000_000)).toThrow()
  })
})

describe('validateTokenResponse', () => {
  it('accepts a well-formed response', () => {
    // #given / #when
    const result = validateTokenResponse(VALID_TOKEN_BODY)

    // #then
    expect(result.ok).toBe(true)
    expect((result as {ok: true; token: string}).token).toBe('ghs_faketoken123')
  })

  it('rejects a response missing token', () => {
    // #given
    const body = {...VALID_TOKEN_BODY, token: undefined}

    // #when
    const result = validateTokenResponse(body)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects a response missing expires_at', () => {
    // #given
    const body = {...VALID_TOKEN_BODY, expires_at: undefined}

    // #when
    const result = validateTokenResponse(body)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects broader-than-requested permissions', () => {
    // #given
    const body = {...VALID_TOKEN_BODY, permissions: {contents: 'write', issues: 'write'}}

    // #when
    const result = validateTokenResponse(body)

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects narrower-than-requested permissions', () => {
    // #given
    const body = {...VALID_TOKEN_BODY, permissions: {contents: 'read'}}

    // #when
    const result = validateTokenResponse(body)

    // #then
    expect(result.ok).toBe(false)
  })

  it.each([
    ['empty repositories array', []],
    ['two repositories', [{name: 'agent'}, {name: 'other'}]],
    ['wrong repository name', [{name: 'other'}]],
  ])('rejects repository echo: %s', (_label, repositories) => {
    // #given
    const body = {...VALID_TOKEN_BODY, repositories}

    // #when
    const result = validateTokenResponse(body)

    // #then
    expect(result.ok).toBe(false)
  })
})

describe('main — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
    process.env.APPLICATION_ID = 'app-123'
    process.env.APPLICATION_PRIVATE_KEY = privateKey
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.exitCode = undefined
    delete process.env.APPLICATION_ID
    delete process.env.APPLICATION_PRIVATE_KEY
  })

  it('emits the masked token as a step output', async () => {
    // #given
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {id: 999}))
      .mockResolvedValueOnce(jsonResponse(201, VALID_TOKEN_BODY))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBeUndefined()
    expect(mocks.setOutput).toHaveBeenCalledWith('github-token', 'ghs_faketoken123')
    expect(mocks.setSecret).toHaveBeenCalledWith('ghs_faketoken123')
  })

  it('masks the token via setSecret before setOutput', async () => {
    // #given
    const callOrder: string[] = []
    mocks.setSecret.mockImplementation((value: string) => {
      if (value === 'ghs_faketoken123') callOrder.push('setSecret(token)')
    })
    mocks.setOutput.mockImplementation(() => {
      callOrder.push('setOutput')
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {id: 999}))
      .mockResolvedValueOnce(jsonResponse(201, VALID_TOKEN_BODY))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(callOrder).toEqual(['setSecret(token)', 'setOutput'])
  })

  it('masks the private key via setSecret before any fetch', async () => {
    // #given
    const callOrder: string[] = []
    mocks.setSecret.mockImplementation((value: string) => {
      if (value === privateKey) callOrder.push('setSecret(key)')
    })
    const fetchMock = vi.fn().mockImplementation(async () => {
      callOrder.push('fetch')
      return jsonResponse(200, {id: 999})
    })
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(callOrder[0]).toBe('setSecret(key)')
    expect(callOrder).toContain('fetch')
  })

  it('sends the Authorization bearer JWT with expected shape on the installation lookup', async () => {
    // #given
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {id: 999}))
      .mockResolvedValueOnce(jsonResponse(201, VALID_TOKEN_BODY))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/fro-bot/agent/installation')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBeDefined()
    const jwt = (headers.Authorization ?? '').replace('Bearer ', '')
    const [headerSegment, payloadSegment] = jwt.split('.')
    const header = decodeJwtSegment(headerSegment)
    const payload = decodeJwtSegment(payloadSegment)
    expect(header.alg).toBe('RS256')
    expect(payload.iss).toBe('app-123')
    expect(payload.iat as number).toBeLessThan(payload.exp as number)
    expect(Math.floor(Date.now() / 1000) - (payload.iat as number)).toBeGreaterThanOrEqual(59)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends the correct POST body on the token mint request', async () => {
    // #given
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {id: 999}))
      .mockResolvedValueOnce(jsonResponse(201, VALID_TOKEN_BODY))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/app/installations/999/access_tokens')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({repositories: ['agent'], permissions: {contents: 'write'}})
  })

  it('verifies the JWT signature using the public key', async () => {
    // #given
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {id: 999}))
      .mockResolvedValueOnce(jsonResponse(201, VALID_TOKEN_BODY))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    const jwt = (headers.Authorization ?? '').replace('Bearer ', '')
    const [headerSegment, payloadSegment, signatureSegment] = jwt.split('.')
    if (signatureSegment === undefined) {
      throw new Error('missing JWT signature segment')
    }
    const signingInput = `${headerSegment}.${payloadSegment}`
    const signature = Buffer.from(signatureSegment.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
    const {createVerify} = await import('node:crypto')
    const verified = createVerify('RSA-SHA256').update(signingInput).verify(publicKey, signature)
    expect(verified).toBe(true)
  })
})

describe('main — error paths (fail closed)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
    process.env.APPLICATION_ID = 'app-123'
    process.env.APPLICATION_PRIVATE_KEY = privateKey
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.exitCode = undefined
    delete process.env.APPLICATION_ID
    delete process.env.APPLICATION_PRIVATE_KEY
  })

  it('exits non-zero and never fetches when APPLICATION_ID is missing', async () => {
    // #given
    delete process.env.APPLICATION_ID
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('exits non-zero and never fetches when APPLICATION_PRIVATE_KEY is empty', async () => {
    // #given
    process.env.APPLICATION_PRIVATE_KEY = ''
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('exits non-zero when the installation lookup returns non-200', async () => {
    // #given
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(404, {message: 'Not Found'}))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('exits non-zero when the token response is missing token', async () => {
    // #given
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {id: 999}))
      .mockResolvedValueOnce(jsonResponse(201, {...VALID_TOKEN_BODY, token: undefined}))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('exits non-zero when the token response is missing expires_at', async () => {
    // #given
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {id: 999}))
      .mockResolvedValueOnce(jsonResponse(201, {...VALID_TOKEN_BODY, expires_at: undefined}))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('rejects broader-than-requested echoed permissions', async () => {
    // #given
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {id: 999}))
      .mockResolvedValueOnce(
        jsonResponse(201, {...VALID_TOKEN_BODY, permissions: {contents: 'write', issues: 'write'}}),
      )
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('rejects narrower-than-requested echoed permissions', async () => {
    // #given
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {id: 999}))
      .mockResolvedValueOnce(jsonResponse(201, {...VALID_TOKEN_BODY, permissions: {contents: 'read'}}))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it.each([
    ['empty repositories array', []],
    ['two repositories', [{name: 'agent'}, {name: 'other'}]],
    ['wrong repository name', [{name: 'other'}]],
  ])('rejects repository echo: %s', async (_label, repositories) => {
    // #given
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {id: 999}))
      .mockResolvedValueOnce(jsonResponse(201, {...VALID_TOKEN_BODY, repositories}))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it('fails closed on a malformed PEM without leaking key material in the error', async () => {
    // #given
    process.env.APPLICATION_PRIVATE_KEY = MALFORMED_PEM
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.setOutput).not.toHaveBeenCalled()
    const loggedText = stderrSpy.mock.calls.map(call => String(call[0])).join('\n')
    expect(loggedText).not.toContain('BEGIN PRIVATE KEY')
    expect(loggedText).not.toContain('not-a-real-key')
    stderrSpy.mockRestore()
  })

  it('fails closed without retrying when the installation fetch throws', async () => {
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

  it('fails closed without retrying on a timeout-shaped abort', async () => {
    // #given
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

  it('fails closed when the token POST returns non-201', async () => {
    // #given
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, {id: 999}))
      .mockResolvedValueOnce(jsonResponse(403, {message: 'Forbidden'}))
    vi.stubGlobal('fetch', fetchMock)

    // #when
    await main()

    // #then
    expect(process.exitCode).toBe(1)
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })
})
