import {beforeEach, describe, expect, it, vi} from 'vitest'

import {AppNotInstalledError, AuthError, InsufficientPermissionsError, createAppClient} from './app-client.js' // eslint-disable-line perfectionist/sort-named-imports

const {mockAuth, mockCreateAppAuth, mockRequest, MockOctokit} = vi.hoisted(() => {
  const mockAuth = vi.fn()
  const mockCreateAppAuth = vi.fn(() => mockAuth)
  const mockRequest = vi.fn()
  const MockOctokit = vi.fn()
  return {mockAuth, mockCreateAppAuth, mockRequest, MockOctokit}
})

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: mockCreateAppAuth,
}))

vi.mock('@octokit/core', () => ({
  Octokit: MockOctokit,
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APP_ID = '12345'
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----'
const INSTALL_URL = 'https://github.com/apps/fro-bot-agent/installations/new'

const INSTALLATION_RESPONSE = {
  data: {
    id: 99,
    permissions: {contents: 'read'},
  },
}

const REPO_IDENTITY_RESPONSE = {
  data: {
    id: 123456789,
    node_id: 'MDEwOlJlcG9zaXRvcnkxMjM0NTY3ODk=',
  },
}

function makeLogger() {
  const lines: string[] = []
  return {
    warn: (msg: string, meta?: Record<string, unknown>) => {
      lines.push(`WARN: ${msg} ${JSON.stringify(meta ?? {})}`)
    },
    debug: (msg: string, meta?: Record<string, unknown>) => {
      lines.push(`DEBUG: ${msg} ${JSON.stringify(meta ?? {})}`)
    },
    lines,
  }
}

// ---------------------------------------------------------------------------
// Test helpers for installation auth call assertions
// ---------------------------------------------------------------------------

/** Shape of the argument passed to installAuth({type:'installation',...}) */
interface InstallationAuthCallArg {
  readonly type: string
  readonly repositoryNames?: string[]
  readonly permissions?: Record<string, string>
}

function getInstallationCalls(): InstallationAuthCallArg[] {
  return mockAuth.mock.calls
    .filter(args => (args[0] as {type: string}).type === 'installation')
    .map(args => args[0] as InstallationAuthCallArg)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAppClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Re-wire createAppAuth → mockAuth after clearAllMocks resets implementations
    mockCreateAppAuth.mockImplementation(() => mockAuth)
    // Re-wire Octokit constructor → mockRequest after clearAllMocks resets implementations
    // eslint-disable-next-line prefer-arrow-callback
    MockOctokit.mockImplementation(function () {
      return {request: mockRequest}
    })

    // Default: JWT auth returns a token, installation auth returns a token
    mockAuth.mockImplementation(async ({type}: {type: string}) => {
      if (type === 'app') return {token: 'jwt-token-value'}
      if (type === 'installation') return {token: 'installation-token-value'}
      return {token: 'unknown'}
    })

    // Default: discovery succeeds with contents:read
    mockRequest.mockResolvedValue(INSTALLATION_RESPONSE)
  })

  // -------------------------------------------------------------------------
  // Happy paths
  // -------------------------------------------------------------------------

  it('happy path: valid creds + installed App returns {octokit, installationId, token}', async () => {
    // #given
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when
    const result = await client.authForRepo('owner', 'repo')

    // #then
    expect(result.success).toBe(true)
    if (result.success === false) return
    expect(result.data.installationId).toBe(99)
    expect(result.data.token).toBe('installation-token-value')
    expect(result.data.octokit).toBeDefined()
  })

  it('happy path: second call for same (owner, repo) reuses cached installationId', async () => {
    // #given
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when — two calls
    await client.authForRepo('owner', 'repo')
    await client.authForRepo('owner', 'repo')

    // #then — discovery request called only once (first call)
    expect(mockRequest).toHaveBeenCalledTimes(1)
    // createAppAuth called twice (once per authForRepo for stage-2 token)
    // but the JWT-stage auth({type:'app'}) call only once
    const appTypeCalls = mockAuth.mock.calls.filter(args => (args[0] as {type: string}).type === 'app')
    expect(appTypeCalls).toHaveLength(1)
  })

  it('happy path: installation has contents:read exactly — succeeds without warning', async () => {
    // #given
    const logger = makeLogger()
    mockRequest.mockResolvedValue({data: {id: 99, permissions: {contents: 'read'}}})
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY, logger})

    // #when
    const result = await client.authForRepo('owner', 'repo')

    // #then
    expect(result.success).toBe(true)
    expect(logger.lines.some(l => l.startsWith('WARN'))).toBe(false)
  })

  it('happy path: installation has contents:write (over-privileged) — succeeds with WARN log', async () => {
    // #given
    const logger = makeLogger()
    mockRequest.mockResolvedValue({data: {id: 99, permissions: {contents: 'write'}}})
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY, logger})

    // #when
    const result = await client.authForRepo('owner', 'repo')

    // #then
    expect(result.success).toBe(true)
    expect(logger.lines.some(l => l.startsWith('WARN') && l.includes('over-privileged'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('edge case: App not installed on repo → Result.err(AppNotInstalledError) with install URL', async () => {
    // #given
    const notFoundError = Object.assign(new Error('Not Found'), {status: 404})
    mockRequest.mockRejectedValue(notFoundError)
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY, installUrl: INSTALL_URL})

    // #when
    const result = await client.authForRepo('owner', 'repo')

    // #then
    expect(result.success).toBe(false)
    if (result.success === true) return
    expect(result.error).toBeInstanceOf(AppNotInstalledError)
    expect(result.error.message).toContain(INSTALL_URL)
  })

  // -------------------------------------------------------------------------
  // Error paths
  // -------------------------------------------------------------------------

  it('error: installation has contents:none → Result.err(InsufficientPermissionsError)', async () => {
    // #given
    mockRequest.mockResolvedValue({data: {id: 99, permissions: {contents: 'none'}}})
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY, installUrl: INSTALL_URL})

    // #when
    const result = await client.authForRepo('owner', 'repo')

    // #then
    expect(result.success).toBe(false)
    if (result.success === true) return
    expect(result.error).toBeInstanceOf(InsufficientPermissionsError)
    expect(result.error.message).toContain(INSTALL_URL)
  })

  it('error: installation missing contents permission → Result.err(InsufficientPermissionsError)', async () => {
    // #given
    mockRequest.mockResolvedValue({data: {id: 99, permissions: {}}})
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY, installUrl: INSTALL_URL})

    // #when
    const result = await client.authForRepo('owner', 'repo')

    // #then
    expect(result.success).toBe(false)
    if (result.success === true) return
    expect(result.error).toBeInstanceOf(InsufficientPermissionsError)
  })

  it('error: invalid private key format → wrapped as AuthError, not a stack trace', async () => {
    // #given
    mockAuth.mockImplementation(async ({type}: {type: string}) => {
      if (type === 'app') throw new Error('Invalid private key format')
      return {token: 'installation-token-value'}
    })
    const client = createAppClient({appId: APP_ID, privateKey: 'not-a-pem'})

    // #when
    const result = await client.authForRepo('owner', 'repo')

    // #then
    expect(result.success).toBe(false)
    if (result.success === true) return
    expect(result.error).toBeInstanceOf(AuthError)
    expect(result.error.message).toContain('Invalid private key format')
  })

  it('error: IAT request returns 401 → wrapped as AuthError; token NOT in error message', async () => {
    // #given
    const unauthorizedError = Object.assign(new Error('Bad credentials'), {status: 401})
    mockRequest.mockRejectedValue(unauthorizedError)
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when
    const result = await client.authForRepo('owner', 'repo')

    // #then
    expect(result.success).toBe(false)
    if (result.success === true) return
    expect(result.error).toBeInstanceOf(AuthError)
    // Token must not appear in the error message
    expect(result.error.message).not.toContain('jwt-token-value')
    expect(result.error.message).not.toContain('installation-token-value')
  })

  // -------------------------------------------------------------------------
  // Security: no sensitive material in logs
  // -------------------------------------------------------------------------

  it('security: no JWT, private key, or token appears in any log line', async () => {
    // #given
    const logger = makeLogger()
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY, logger})

    // #when
    await client.authForRepo('owner', 'repo')

    // #then — check all captured log lines
    for (const line of logger.lines) {
      expect(line).not.toContain('jwt-token-value')
      expect(line).not.toContain('installation-token-value')
      expect(line).not.toContain(PRIVATE_KEY)
      expect(line).not.toContain('fake-key')
    }
  })

  // -------------------------------------------------------------------------
  // Security: repository-scoped installation tokens
  // -------------------------------------------------------------------------

  it('security: installAuth({type:"installation"}) receives repositoryNames:[repo] and permissions:{contents:"read"}', async () => {
    // #given
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when
    const result = await client.authForRepo('myorg', 'myrepo')

    // #then — must succeed
    expect(result.success).toBe(true)

    // The installation-type auth call must carry repository scoping and minimal permissions.
    const installationCalls = getInstallationCalls()
    expect(installationCalls).toHaveLength(1)
    const [installationCallArg] = installationCalls
    expect(installationCallArg?.repositoryNames).toEqual(['myrepo'])
    expect(installationCallArg?.permissions).toEqual({contents: 'read'})
  })

  it('security: second authForRepo call (cache hit) also passes repositoryNames and permissions', async () => {
    // #given
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when — two calls; second hits the cache
    await client.authForRepo('myorg', 'myrepo')
    await client.authForRepo('myorg', 'myrepo')

    // #then — both installation-type calls must carry scoping
    const installationCalls = getInstallationCalls()
    expect(installationCalls).toHaveLength(2)
    for (const arg of installationCalls) {
      expect(arg.repositoryNames).toEqual(['myrepo'])
      expect(arg.permissions).toEqual({contents: 'read'})
    }
  })

  it('security: repositoryNames uses the repo name, not the owner/repo path', async () => {
    // #given — repo name differs from owner name
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when
    await client.authForRepo('some-org', 'specific-repo')

    // #then — repositoryNames must be just the repo name, not "some-org/specific-repo"
    const installationCalls = getInstallationCalls()
    expect(installationCalls).toHaveLength(1)
    const [arg] = installationCalls
    expect(arg?.repositoryNames).toEqual(['specific-repo'])
    expect(arg?.repositoryNames).not.toContain('some-org/specific-repo')
  })

  // -------------------------------------------------------------------------
  // Cache invalidation
  // -------------------------------------------------------------------------

  it('cache eviction: stage-2 mint failure with warm cache evicts entry so next call re-discovers', async () => {
    // #given
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // First call — warm the cache (discovery + mint both succeed)
    const first = await client.authForRepo('foo', 'bar')
    expect(first.success).toBe(true)
    const discoveryCallsAfterFirst = mockRequest.mock.calls.length // should be 1

    // Reconfigure: install-auth mint throws on next call
    mockAuth.mockImplementation(async ({type}: {type: string}) => {
      if (type === 'app') return {token: 'jwt-token-value'}
      if (type === 'installation') throw new Error('installation token revoked')
      return {token: 'unknown'}
    })

    // #when — second call hits warm cache but mint fails
    const second = await client.authForRepo('foo', 'bar')

    // #then — returns AuthError
    expect(second.success).toBe(false)
    if (second.success) return
    expect(second.error).toBeInstanceOf(AuthError)
    // Discovery should NOT have re-run (cache was hit before mint failed)
    expect(mockRequest.mock.calls.length).toBe(discoveryCallsAfterFirst)

    // Reconfigure: mint succeeds again
    mockAuth.mockImplementation(async ({type}: {type: string}) => {
      if (type === 'app') return {token: 'jwt-token-value'}
      if (type === 'installation') return {token: 'installation-token-value'}
      return {token: 'unknown'}
    })

    // #when — third call; cache was evicted by the stage-2 failure
    const third = await client.authForRepo('foo', 'bar')

    // #then — succeeds AND discovery ran a second time (cache was evicted)
    expect(third.success).toBe(true)
    const appTypeCalls = mockAuth.mock.calls.filter(args => (args[0] as {type: string}).type === 'app')
    expect(appTypeCalls.length).toBeGreaterThanOrEqual(2)
    expect(mockRequest.mock.calls.length).toBe(discoveryCallsAfterFirst + 1)
  })

  it('concurrent discovery: two simultaneous authForRepo calls for same uncached pair both succeed', async () => {
    // #given
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when — fire both before either resolves
    const [a, b] = await Promise.all([client.authForRepo('foo', 'bar'), client.authForRepo('foo', 'bar')])

    // #then — both succeed
    expect(a.success).toBe(true)
    expect(b.success).toBe(true)
  })

  it('cache invalidation: after invalidateCache, next authForRepo re-discovers installation', async () => {
    // #given
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // First call — populates cache
    await client.authForRepo('owner', 'repo')
    expect(mockRequest).toHaveBeenCalledTimes(1)

    // #when — invalidate and call again
    client.invalidateCache('owner', 'repo')
    await client.authForRepo('owner', 'repo')

    // #then — discovery called again (twice total)
    expect(mockRequest).toHaveBeenCalledTimes(2)
    const appTypeCalls = mockAuth.mock.calls.filter(args => (args[0] as {type: string}).type === 'app')
    expect(appTypeCalls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// getRepoIdentity tests
// ---------------------------------------------------------------------------

describe('createAppClient.getRepoIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockCreateAppAuth.mockImplementation(() => mockAuth)
    // eslint-disable-next-line prefer-arrow-callback
    MockOctokit.mockImplementation(function () {
      return {request: mockRequest}
    })

    mockAuth.mockImplementation(async ({type}: {type: string}) => {
      if (type === 'app') return {token: 'jwt-token-value'}
      if (type === 'installation') return {token: 'installation-token-value'}
      return {token: 'unknown'}
    })

    // Default: installation discovery succeeds
    mockRequest.mockResolvedValue(INSTALLATION_RESPONSE)
  })

  it('happy path: returns {databaseId, nodeId} from GET /repos/{owner}/{repo}', async () => {
    // #given — first call is installation discovery, second is repo identity
    mockRequest.mockResolvedValueOnce(INSTALLATION_RESPONSE).mockResolvedValueOnce(REPO_IDENTITY_RESPONSE)
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when
    const result = await client.getRepoIdentity('owner', 'repo')

    // #then
    expect(result.success).toBe(true)
    if (result.success === false) return
    expect(result.data.databaseId).toBe(123456789)
    expect(result.data.nodeId).toBe('MDEwOlJlcG9zaXRvcnkxMjM0NTY3ODk=')
  })

  it('happy path: databaseId is the numeric id (not node_id)', async () => {
    // #given — repo with a different numeric id
    mockRequest
      .mockResolvedValueOnce(INSTALLATION_RESPONSE)
      .mockResolvedValueOnce({data: {id: 42, node_id: 'R_kgDOBcdefg'}})
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when
    const result = await client.getRepoIdentity('myorg', 'myrepo')

    // #then
    expect(result.success).toBe(true)
    if (result.success === false) return
    expect(result.data.databaseId).toBe(42)
    expect(result.data.nodeId).toBe('R_kgDOBcdefg')
  })

  it('uses the authenticated octokit from authForRepo (no extra auth round-trip)', async () => {
    // #given — track all request calls
    mockRequest.mockResolvedValueOnce(INSTALLATION_RESPONSE).mockResolvedValueOnce(REPO_IDENTITY_RESPONSE) // discovery then identity
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when
    await client.getRepoIdentity('owner', 'repo')

    // #then — exactly 2 request calls: one for installation discovery, one for repo identity
    // (no extra JWT or installation token minting beyond what authForRepo already does)
    expect(mockRequest).toHaveBeenCalledTimes(2)
    const [firstCall, secondCall] = mockRequest.mock.calls as [[string, unknown], [string, unknown]][]
    expect(firstCall?.[0]).toContain('/installation')
    expect(secondCall?.[0]).not.toContain('/installation')
    expect(secondCall?.[0]).toMatch(/GET \/repos\/\{owner\}\/\{repo\}/)
  })

  it('error: repo not found (404) → Result.err(AppNotInstalledError)', async () => {
    // #given — installation discovery succeeds but repo GET returns 404
    const notFoundError = Object.assign(new Error('Not Found'), {status: 404})
    mockRequest.mockResolvedValueOnce(INSTALLATION_RESPONSE).mockRejectedValueOnce(notFoundError)
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY, installUrl: INSTALL_URL})

    // #when
    const result = await client.getRepoIdentity('owner', 'repo')

    // #then
    expect(result.success).toBe(false)
    if (result.success === true) return
    expect(result.error).toBeInstanceOf(AppNotInstalledError)
  })

  it('error: auth failure → Result.err(AuthError)', async () => {
    // #given — authForRepo itself fails (App not installed)
    const notFoundError = Object.assign(new Error('Not Found'), {status: 404})
    mockRequest.mockRejectedValue(notFoundError)
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY, installUrl: INSTALL_URL})

    // #when
    const result = await client.getRepoIdentity('owner', 'repo')

    // #then — propagates the auth error
    expect(result.success).toBe(false)
    if (result.success === true) return
    expect(result.error).toBeInstanceOf(AppNotInstalledError)
  })

  it('error: generic API error → Result.err(AuthError)', async () => {
    // #given — repo GET throws a non-404 error
    const apiError = new Error('Internal Server Error')
    mockRequest.mockResolvedValueOnce(INSTALLATION_RESPONSE).mockRejectedValueOnce(apiError)
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when
    const result = await client.getRepoIdentity('owner', 'repo')

    // #then
    expect(result.success).toBe(false)
    if (result.success === true) return
    expect(result.error).toBeInstanceOf(AuthError)
  })

  it('security: rename-stable — databaseId is the immutable numeric id (not derived from name)', async () => {
    // #given — repo with a numeric id that would survive a rename/transfer
    const STABLE_ID = 987654321
    mockRequest
      .mockResolvedValueOnce(INSTALLATION_RESPONSE)
      .mockResolvedValueOnce({data: {id: STABLE_ID, node_id: 'MDEwOlJlcG9zaXRvcnkx'}})
    const client = createAppClient({appId: APP_ID, privateKey: PRIVATE_KEY})

    // #when — called with original name
    const result = await client.getRepoIdentity('original-owner', 'original-repo')

    // #then — databaseId is the stable numeric id, not derived from the name
    expect(result.success).toBe(true)
    if (result.success === false) return
    expect(result.data.databaseId).toBe(STABLE_ID)
    // The id is a number, not a string derived from owner/repo
    expect(typeof result.data.databaseId).toBe('number')
  })
})
