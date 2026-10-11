/**
 * Tests for the GitHub OAuth PKCE + state flow.
 *
 * Covers:
 *   - Happy path: auth start redirects to GitHub with correct params.
 *   - Security: code verifier is never in cookie or browser-visible response.
 *   - Security: absolute/cross-origin redirect targets rejected before state mint.
 *   - Happy path: valid state + PKCE exchange returns numeric GitHub user id and login.
 *   - Error path: invalid state, replayed state, expired state fail closed.
 *   - Error path: token exchange failure fails closed.
 *   - Error path: user fetch failure fails closed.
 *   - Security: all auth failure branches return the same coarse 400 response shape.
 *   - Security: OAuth callback accepts GitHub's cross-site redirect shape.
 *   - Audit: auth.callback.success and auth.callback.failure events are emitted with reason.
 *   - Outstanding attempt cap: exceeding cap per source key fails closed.
 *   - Rate limiter: both start and callback routes are rate limited.
 *   - Source key binding: callback rejects when source key differs from mint-time key.
 *   - Provider error with valid state: state is consumed immediately.
 *   - Fetch timeout/throw: token exchange and user fetch throw/timeout fail closed.
 *   - Non-2xx responses: token exchange and user fetch non-2xx fail closed.
 *   - Eviction: evictStale removes consumed and expired entries.
 *   - Programming errors: partial deps/config throws at construction time.
 *   - Route inventory: OAuth-enabled buildOperatorApp registers expected routes.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import type {AddressInfo} from 'node:net'

import type {Context} from 'hono'
import type {RateLimiter} from '../../http/rate-limit.js'
import type {AuditLogger} from '../audit.js'
import type {RawIngressInput, ResolvedClientAddress} from '../ingress/resolve-client.js'
import type {GitHubOAuthConfig, GitHubOAuthDeps, OAuthStateStore} from './github.js'
import type {SessionDeps, SessionStore} from './session.js'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {serve} from '@hono/node-server'
import {Effect} from 'effect'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {extractRawIngressInput} from '../ingress/hono-context.js'
import {makeDirectIngressPolicy, makeTrustedProxyIngressPolicy} from '../ingress/policy.js'
import {resolveClient, unsafeResolvedClientAddressForTest} from '../ingress/resolve-client.js'
import {parseTrustedProxyAddress} from '../ingress/trusted-proxy-address.js'
import {assertAllPrivilegedRoutesWrapped, isPublicRoute, registerPublicRoute} from '../operator-route.js'
import {buildGitHubOAuthRoutes, createInMemoryStateStore, validateReturnPath} from './github.js'
import {createInMemorySessionStore, SESSION_COOKIE_NAME} from './session.js'

/**
 * Build a stub ResolvedClientAddress for test resolveClientAddress stubs. The branded
 * type can only be produced by resolveClient() in production; tests use the
 * sanctioned test-only constructor to stand in for a fixed resolved client
 * identity.
 */
function stubResolved(canonical: string): ResolvedClientAddress {
  return unsafeResolvedClientAddressForTest(canonical)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The state value makeStubDeps mints by default (a fixed string). */
const DEFAULT_TEST_STATE = 'test-state-value-32-bytes-long-ok'

/** Counts which of `candidates` the store still knows — observed via get(), not a production size(). */
function countKnown(store: OAuthStateStore, candidates: readonly string[]): number {
  return candidates.filter(candidate => store.get(candidate) !== undefined).length
}

/** Captured audit log record — kind + any additional fields. */
interface CapturedAuditRecord {
  readonly kind: string
  readonly reason?: string
  readonly [key: string]: unknown
}

function isCapturedAuditRecord(ctx: Record<string, unknown>): ctx is CapturedAuditRecord {
  return typeof ctx.kind === 'string'
}

function makeAuditLogger(): AuditLogger & {records: CapturedAuditRecord[]} {
  const records: CapturedAuditRecord[] = []
  const capture = (ctx: Record<string, unknown>): void => {
    if (isCapturedAuditRecord(ctx)) {
      records.push(ctx)
    }
  }
  return {
    records,
    info: vi.fn((ctx: Record<string, unknown>, _msg: string) => {
      capture(ctx)
    }),
    warn: vi.fn((ctx: Record<string, unknown>, _msg: string) => {
      capture(ctx)
    }),
  }
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makePassRateLimiter(): RateLimiter {
  return {allow: vi.fn(() => true)}
}

function makeBlockRateLimiter(): RateLimiter {
  return {allow: vi.fn(() => false)}
}

/** Minimal stub fetch that returns a successful token exchange and user fetch. */
function makeSuccessFetch(
  opts: {
    accessToken?: string
    userId?: number
    login?: string
  } = {},
): GitHubOAuthDeps['fetch'] {
  const accessToken = opts.accessToken ?? 'ghs_TESTTOKEN'
  const userId = opts.userId ?? 12345
  const login = opts.login ?? 'octocat'

  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    if (urlStr.includes('login/oauth/access_token')) {
      return new Response(JSON.stringify({access_token: accessToken, token_type: 'bearer', scope: 'read:user'}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    }
    if (urlStr.includes('api.github.com/user')) {
      return new Response(JSON.stringify({id: userId, login}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    }
    return new Response('not found', {status: 404})
  })
}

function makeStubConfig(overrides?: Partial<GitHubOAuthConfig>): GitHubOAuthConfig {
  return {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    publicOrigin: 'https://operator.example.com',
    callbackPath: '/operator/auth/github/callback',
    allowedReturnPaths: ['/operator/dashboard', '/operator/runs'],
    maxOutstandingAttemptsPerKey: 5,
    stateTtlMs: 10 * 60 * 1000, // 10 minutes
    ...overrides,
  }
}

function makeStubDeps(overrides?: Partial<GitHubOAuthDeps>): GitHubOAuthDeps {
  return {
    logger: makeLogger(),
    auditLogger: makeAuditLogger(),
    fetch: makeSuccessFetch(),
    clock: () => Date.now(),
    generateVerifier: () => 'test-verifier-32-bytes-long-enough-for-pkce',
    generateState: () => DEFAULT_TEST_STATE,
    stateStore: createInMemoryStateStore(),
    // In tests, resolve to a fixed source key — no real socket available.
    resolveClientAddress: () => Effect.succeed(stubResolved('test-source-key')),
    rateLimiter: makePassRateLimiter(),
    ...overrides,
  }
}

/** Derive the expected S256 code challenge for a given verifier (mirrors production logic). */
function deriveExpectedChallenge(verifier: string): string {
  const hash = createHash('sha256').update(verifier, 'ascii').digest()
  return hash.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Build a Hono app with the OAuth routes registered. */
function buildTestApp(deps: GitHubOAuthDeps, config: GitHubOAuthConfig): Hono {
  const app = new Hono()
  // Register health as public so assertAllPrivilegedRoutesWrapped passes
  registerPublicRoute(app, 'GET', '/operator/health', c => c.json({ok: true}))
  buildGitHubOAuthRoutes(app, deps, config)
  assertAllPrivilegedRoutesWrapped(app)
  return app
}

/** Mint an OAuth state by hitting the start route and parsing it off the redirect. */
async function mintState(app: Hono): Promise<string> {
  const startRes = await app.fetch(new Request('https://operator.example.com/operator/auth/github/start'))
  const location = startRes.headers.get('location') ?? ''
  const state = new URL(location).searchParams.get('state')
  if (state === null) throw new Error('expected a state param on the start redirect')
  return state
}

// ---------------------------------------------------------------------------
// Auth start — happy path
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/start — happy path', () => {
  it('redirects to GitHub authorization URL with required PKCE and state params', async () => {
    // #given
    const deps = makeStubDeps()
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request('https://operator.example.com/operator/auth/github/start')
    const res = await app.fetch(req)

    // #then — redirect to GitHub
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toBeTruthy()
    const redirectUrl = new URL(location)
    expect(redirectUrl.hostname).toBe('github.com')
    expect(redirectUrl.pathname).toBe('/login/oauth/authorize')
    expect(redirectUrl.searchParams.get('client_id')).toBe('test-client-id')
    expect(redirectUrl.searchParams.get('state')).toBe('test-state-value-32-bytes-long-ok')
    expect(redirectUrl.searchParams.get('code_challenge_method')).toBe('S256')
    // Exact deterministic PKCE challenge derived from the injected verifier
    expect(redirectUrl.searchParams.get('code_challenge')).toBe(
      deriveExpectedChallenge('test-verifier-32-bytes-long-enough-for-pkce'),
    )
    expect(redirectUrl.searchParams.get('redirect_uri')).toBe(
      'https://operator.example.com/operator/auth/github/callback',
    )
    // Exact scope assertion
    expect(redirectUrl.searchParams.get('scope')).toBe('read:user')
  })

  it('stores state server-side with codeVerifier, issuedAt, consumed=false', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request('https://operator.example.com/operator/auth/github/start')
    await app.fetch(req)

    // #then — state is stored server-side
    const stored = stateStore.get('test-state-value-32-bytes-long-ok')
    if (stored === undefined) throw new Error('expected state to be stored')
    expect(stored.codeVerifier).toBe('test-verifier-32-bytes-long-enough-for-pkce')
    expect(stored.consumed).toBe(false)
    expect(stored.issuedAt).toBeGreaterThan(0)
  })

  it('includes redirect_target in stored state when a valid same-origin path is provided', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — provide a valid same-origin return path
    const req = new Request('https://operator.example.com/operator/auth/github/start?return_to=%2Foperator%2Fdashboard')
    await app.fetch(req)

    // #then — redirect target is stored
    const stored = stateStore.get('test-state-value-32-bytes-long-ok')
    if (stored === undefined) throw new Error('expected state to be stored')
    expect(stored.redirectTarget).toBe('/operator/dashboard')
  })
})

// ---------------------------------------------------------------------------
// Auth start — code verifier never browser-visible
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/start — code verifier security', () => {
  it('does not include code verifier in the redirect URL', async () => {
    // #given
    const deps = makeStubDeps()
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request('https://operator.example.com/operator/auth/github/start')
    const res = await app.fetch(req)

    // #then — verifier is NOT in the redirect URL
    const location = res.headers.get('location') ?? ''
    expect(location).not.toContain('test-verifier-32-bytes-long-enough-for-pkce')
    expect(location).not.toContain('code_verifier')
  })

  it('does not include code verifier in any response header', async () => {
    // #given
    const deps = makeStubDeps()
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request('https://operator.example.com/operator/auth/github/start')
    const res = await app.fetch(req)

    // #then — verifier is NOT in any response header
    const allHeaders = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')
    expect(allHeaders).not.toContain('test-verifier-32-bytes-long-enough-for-pkce')
    expect(allHeaders).not.toContain('code_verifier')
  })

  it('does not set a cookie containing the code verifier', async () => {
    // #given
    const deps = makeStubDeps()
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request('https://operator.example.com/operator/auth/github/start')
    const res = await app.fetch(req)

    // #then — no cookie contains the verifier
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).not.toContain('test-verifier-32-bytes-long-enough-for-pkce')
    expect(setCookie).not.toContain('code_verifier')
  })
})

// ---------------------------------------------------------------------------
// Auth start — redirect target validation
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/start — redirect target validation', () => {
  it('rejects absolute URL redirect targets before state is minted', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — absolute URL as return_to
    const req = new Request(
      'https://operator.example.com/operator/auth/github/start?return_to=https%3A%2F%2Fevil.attacker.com%2Fsteal',
    )
    const res = await app.fetch(req)

    // #then — rejected; no state minted
    expect(res.status).toBe(400)
    expect(stateStore.get(DEFAULT_TEST_STATE)).toBeUndefined()
  })

  it('rejects cross-origin redirect targets before state is minted', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — cross-origin URL
    const req = new Request(
      'https://operator.example.com/operator/auth/github/start?return_to=%2F%2Fevil.attacker.com%2Fsteal',
    )
    const res = await app.fetch(req)

    // #then — rejected; no state minted
    expect(res.status).toBe(400)
    expect(stateStore.get(DEFAULT_TEST_STATE)).toBeUndefined()
  })

  it('rejects paths not in the allowlist before state is minted', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — path not in allowlist
    const req = new Request(
      'https://operator.example.com/operator/auth/github/start?return_to=%2Fsome%2Funknown%2Fpath',
    )
    const res = await app.fetch(req)

    // #then — rejected; no state minted
    expect(res.status).toBe(400)
    expect(stateStore.get(DEFAULT_TEST_STATE)).toBeUndefined()
  })

  it('accepts a valid allowlisted path as redirect target', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — valid allowlisted path
    const req = new Request('https://operator.example.com/operator/auth/github/start?return_to=%2Foperator%2Fruns')
    const res = await app.fetch(req)

    // #then — accepted; state minted
    expect(res.status).toBe(302)
    expect(stateStore.get(DEFAULT_TEST_STATE)).toBeDefined()
  })

  it('accepts no return_to param (defaults to no redirect target)', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — no return_to
    const req = new Request('https://operator.example.com/operator/auth/github/start')
    const res = await app.fetch(req)

    // #then — accepted; state minted with no redirectTarget
    expect(res.status).toBe(302)
    expect(stateStore.get(DEFAULT_TEST_STATE)).toBeDefined()
    const stored = stateStore.get('test-state-value-32-bytes-long-ok')
    if (stored === undefined) throw new Error('expected state to be stored')
    expect(stored.redirectTarget).toBeUndefined()
  })

  it('rejects when allowedReturnPaths is empty and return_to is provided', async () => {
    // #given — empty allowlist
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig({allowedReturnPaths: []})
    const app = buildTestApp(deps, config)

    // #when — any path is rejected when allowlist is empty
    const req = new Request('https://operator.example.com/operator/auth/github/start?return_to=%2Foperator%2Fdashboard')
    const res = await app.fetch(req)

    // #then — rejected; no state minted
    expect(res.status).toBe(400)
    expect(stateStore.get(DEFAULT_TEST_STATE)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Auth start — outstanding attempt cap
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/start — outstanding attempt cap', () => {
  it('rejects when outstanding attempts per source key exceed the cap', async () => {
    // #given — cap of 2 outstanding attempts
    let stateCounter = 0
    const deps = makeStubDeps({
      generateState: () => `state-${++stateCounter}`,
      stateStore: createInMemoryStateStore(),
    })
    const config = makeStubConfig({maxOutstandingAttemptsPerKey: 2})
    const app = buildTestApp(deps, config)

    // #when — exhaust the cap
    const makeReq = () => new Request('https://operator.example.com/operator/auth/github/start')
    const res1 = await app.fetch(makeReq())
    const res2 = await app.fetch(makeReq())
    const res3 = await app.fetch(makeReq())

    // #then — first two succeed, third is rejected
    expect(res1.status).toBe(302)
    expect(res2.status).toBe(302)
    expect(res3.status).toBe(429)
  })

  it('allows new starts after previously-outstanding entries expire (evict-before-count)', async () => {
    // #given — cap of 2; two entries minted at t=0 (will expire at ttlMs+1)
    const ttlMs = 10 * 60 * 1000
    const stateStore = createInMemoryStateStore()
    let stateCounter = 0
    let currentTime = 1000

    const deps = makeStubDeps({
      stateStore,
      generateState: () => `state-${++stateCounter}`,
      clock: () => currentTime,
    })
    const config = makeStubConfig({maxOutstandingAttemptsPerKey: 2, stateTtlMs: ttlMs})
    const app = buildTestApp(deps, config)

    const makeReq = () => new Request('https://operator.example.com/operator/auth/github/start')

    // #when — exhaust the cap at t=1000
    const res1 = await app.fetch(makeReq())
    const res2 = await app.fetch(makeReq())
    expect(res1.status).toBe(302)
    expect(res2.status).toBe(302)

    // Verify cap is hit before expiry
    const resCapped = await app.fetch(makeReq())
    expect(resCapped.status).toBe(429)

    // #when — advance clock past TTL so the two entries are now expired
    currentTime = 1000 + ttlMs + 1

    // #then — new start succeeds because evictStale runs before countOutstanding
    const resAfterExpiry = await app.fetch(makeReq())
    expect(resAfterExpiry.status).toBe(302)
  })
})

// ---------------------------------------------------------------------------
// Auth start — rate limiter
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/start — rate limiter', () => {
  it('returns 429 when the shared rate limiter rejects the request', async () => {
    // #given — rate limiter always blocks
    const deps = makeStubDeps({rateLimiter: makeBlockRateLimiter()})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request('https://operator.example.com/operator/auth/github/start')
    const res = await app.fetch(req)

    // #then — rate limited before any work
    expect(res.status).toBe(429)
  })

  it('calls rateLimiter.allow with the derived accounting key on start', async () => {
    // #given
    const rateLimiter = makePassRateLimiter()
    const deps = makeStubDeps({rateLimiter, resolveClientAddress: () => Effect.succeed(stubResolved('203.0.113.5'))})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request('https://operator.example.com/operator/auth/github/start')
    await app.fetch(req)

    // #then — rate limiter was called with the derived /32 accounting key
    expect(rateLimiter.allow).toHaveBeenCalledWith('ipv4/32:203.0.113.5')
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — happy path
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — happy path', () => {
  it('returns numeric GitHub user id and login on valid state + code exchange', async () => {
    // #given — pre-seed state store
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000, // 1 second after issuedAt
      fetch: makeSuccessFetch({userId: 99999, login: 'testuser'}),
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — success response with verified identity
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      githubUserId: 99999,
      login: 'testuser',
    })
  })

  it('includes code_verifier in the token exchange request', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'my-specific-verifier-value',
      issuedAt: now,
      consumed: false,
    })

    const fetchSpy = vi.fn(makeSuccessFetch())
    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: fetchSpy,
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    await app.fetch(req)

    // #then — token exchange includes code_verifier
    const tokenCall = fetchSpy.mock.calls.find(([url]: [string | URL | Request, RequestInit?]) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      return urlStr.includes('login/oauth/access_token')
    })
    expect(tokenCall).toBeDefined()
    const tokenCallInit = tokenCall?.[1]
    const body = tokenCallInit?.body
    const bodyStr = typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : ''
    expect(bodyStr).toContain('code_verifier=my-specific-verifier-value')
  })

  it('emits auth.callback.success audit event with numeric id and login', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      auditLogger,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    await app.fetch(req)

    // #then — success audit event emitted
    const successEvent = auditLogger.records.find(r => r.kind === 'auth.callback.success')
    expect(successEvent).toBeDefined()
    expect(successEvent?.githubUserId).toBe(42)
    expect(successEvent?.login).toBe('octocat')
  })

  it('consumes state (one-time use) after successful callback', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — first callback succeeds
    const req1 = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res1 = await app.fetch(req1)
    expect(res1.status).toBe(200)

    // #when — replay the same state
    const req2 = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res2 = await app.fetch(req2)

    // #then — replayed state is rejected
    expect(res2.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — rate limiter
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — rate limiter', () => {
  it('returns 429 when the shared rate limiter rejects the callback', async () => {
    // #given — rate limiter always blocks
    const deps = makeStubDeps({rateLimiter: makeBlockRateLimiter()})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request('https://operator.example.com/operator/auth/github/callback?code=abc&state=some-state')
    const res = await app.fetch(req)

    // #then — rate limited before any work
    expect(res.status).toBe(429)
  })

  it('calls rateLimiter.allow with the derived accounting key on callback', async () => {
    // #given
    const rateLimiter = makePassRateLimiter()
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })
    const deps = makeStubDeps({
      rateLimiter,
      stateStore,
      clock: () => now + 1000,
      resolveClientAddress: () => Effect.succeed(stubResolved('2001:db8:1:2::9')),
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    await app.fetch(req)

    // #then — rate limiter was called with the /64 accounting key, not the exact address
    expect(rateLimiter.allow).toHaveBeenCalledWith('ipv6/64:2001:0db8:0001:0002')
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — source key binding
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — source key binding', () => {
  it('on first mismatch, redirects back to /start and releases the outstanding attempt instead of 400ing', async () => {
    // #given — state minted with source key 'ip-1', callback comes from 'ip-2'
    // (address changed mid-flow — mobile handover, VPN toggle, CGNAT rotation)
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      boundAddress: 'ip-1',
      accountingKey: 'acct-ip-1',
    })

    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      auditLogger,
      resolveClientAddress: () => Effect.succeed(stubResolved('ip-2')), // different from mint-time key
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — bounced back to /start, not a 400
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('/operator/auth/github/start')
    expect(location).toContain('retry=1')

    // #and — the outstanding attempt is released (consumed), so it no longer
    // counts against the cap — this is the part that must not be missed
    const entry = stateStore.get('valid-state-value')
    expect(entry?.consumed).toBe(true)
    expect(stateStore.countOutstanding('acct-ip-1')).toBe(0)

    // #and — failure audit event emitted with source_key_mismatch reason
    const failureEvent = auditLogger.records.find(r => r.kind === 'auth.callback.failure')
    expect(failureEvent).toBeDefined()
    expect(failureEvent?.reason).toBe('source_key_mismatch')
  })

  it('retrying the bounced flow from the new stable address succeeds', async () => {
    // #given — state minted from 'ip-1'; the client's address is now stably 'ip-2'
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('orig-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      boundAddress: 'ip-1',
    })

    let stateCounter = 0
    const deps = makeStubDeps({
      stateStore,
      clock: () => now,
      generateState: () => `retry-state-${++stateCounter}`,
      resolveClientAddress: () => Effect.succeed(stubResolved('ip-2')), // stable from here on
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — first callback attempt mismatches and bounces
    const bounceRes = await app.fetch(
      new Request(
        'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=orig-state-value',
      ),
    )
    expect(bounceRes.status).toBe(302)
    const bounceLocation = bounceRes.headers.get('location') ?? ''

    // #when — client follows the redirect back to /start, now stably at ip-2
    const startRes = await app.fetch(new Request(`https://operator.example.com${bounceLocation}`))
    expect(startRes.status).toBe(302)
    const newState = new URL(startRes.headers.get('location') ?? '').searchParams.get('state')
    if (newState === null) throw new Error('expected a state param on the retried start redirect')

    // #when — retried callback, still from ip-2
    const finalRes = await app.fetch(
      new Request(`https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=${newState}`),
    )

    // #then — succeeds
    expect(finalRes.status).toBe(200)
  })

  it('a second consecutive mismatch terminates with an error instead of redirecting again', async () => {
    // #given — a state entry that is itself already the retry target of a
    // prior bounce (bounced: true), and the address mismatches again
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('bounced-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      boundAddress: 'ip-2',
      bounced: true,
    })

    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({
      stateStore,
      clock: () => now,
      auditLogger,
      resolveClientAddress: () => Effect.succeed(stubResolved('ip-3')), // mismatches again
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const res = await app.fetch(
      new Request(
        'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=bounced-state-value',
      ),
    )

    // #then — terminates with an error; no further redirect
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()

    // #and — the attempt is still released
    const entry = stateStore.get('bounced-state-value')
    expect(entry?.consumed).toBe(true)

    // #and — distinguishable from the bounce case in the audit stream: a
    // terminal mismatch is a queryable reason of its own, not the same
    // `source_key_mismatch` value as the first-attempt bounce
    const failureEvent = auditLogger.records.find(r => r.kind === 'auth.callback.failure')
    expect(failureEvent?.reason).toBe('source_key_mismatch_terminal')
  })

  it("a replayed callback from an attacker who learned the state value burns the victim's own subsequent callback", async () => {
    // #given — state minted for the victim at 'victim-ip'; an attacker who
    // learned the state value (browser history, proxy logs, shoulder-surf)
    // replays the callback first, from a different address
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('shared-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      boundAddress: 'victim-ip',
    })

    const attackerDeps = makeStubDeps({
      stateStore,
      clock: () => now,
      resolveClientAddress: () => Effect.succeed(stubResolved('attacker-ip')),
    })
    const config = makeStubConfig()
    const attackerApp = buildTestApp(attackerDeps, config)

    // #when — the attacker's replay hits the mismatch path and consumes the state
    const replayRes = await attackerApp.fetch(
      new Request(
        'https://operator.example.com/operator/auth/github/callback?code=attacker-code&state=shared-state-value',
      ),
    )
    expect(replayRes.status).toBe(302) // bounced — the attacker gains nothing, but the state is now consumed

    // #when — the victim's own browser then completes the real flow, from its
    // genuine 'victim-ip' address, with the same original state value
    const victimDeps = makeStubDeps({
      stateStore,
      clock: () => now,
      resolveClientAddress: () => Effect.succeed(stubResolved('victim-ip')),
    })
    const victimApp = buildTestApp(victimDeps, config)
    const victimRes = await victimApp.fetch(
      new Request(
        'https://operator.example.com/operator/auth/github/callback?code=victim-code&state=shared-state-value',
      ),
    )

    // #then — the victim's legitimate callback fails: the state was already
    // consumed by the attacker's replay, so it hits the same-shape 400 as any
    // other replayed-state case, even though the victim did nothing wrong
    expect(victimRes.status).toBe(400)
  })

  it('unknown, consumed, or expired state is rejected unchanged — no retry path, even from a mismatched address', async () => {
    // #given — three invalid-state scenarios, all approached from a source key
    // that would be eligible for the retry path IF the state were valid
    const now = Date.now()
    const ttlMs = 10 * 60 * 1000

    const consumedStore = createInMemoryStateStore()
    consumedStore.set('consumed-state', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: true,
      boundAddress: 'ip-1',
    })

    const expiredStore = createInMemoryStateStore()
    expiredStore.set('expired-state', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      boundAddress: 'ip-1',
    })

    const scenarios: readonly {
      readonly stateStore: OAuthStateStore
      readonly stateParam: string
      readonly clock: () => number
    }[] = [
      {stateStore: createInMemoryStateStore(), stateParam: 'unknown-state', clock: () => now}, // #given — never minted
      {stateStore: consumedStore, stateParam: 'consumed-state', clock: () => now}, // #given — already consumed
      {stateStore: expiredStore, stateParam: 'expired-state', clock: () => now + ttlMs + 1}, // #given — past TTL
    ]

    for (const scenario of scenarios) {
      const deps = makeStubDeps({
        stateStore: scenario.stateStore,
        clock: scenario.clock,
        resolveClientAddress: () => Effect.succeed(stubResolved('ip-2')), // mismatched from the bound key, if any
      })
      const config = makeStubConfig({stateTtlMs: ttlMs})
      const app = buildTestApp(deps, config)

      // #when
      const res = await app.fetch(
        new Request(
          `https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=${scenario.stateParam}`,
        ),
      )

      // #then — unchanged coarse rejection, never a redirect
      expect(res.status).toBe(400)
      expect(res.headers.get('location')).toBeNull()
    }
  })

  it('accepts callback when source key matches mint-time source key', async () => {
    // #given — state minted with source key 'ip-1', callback also from 'ip-1'
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      boundAddress: 'ip-1',
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      resolveClientAddress: () => Effect.succeed(stubResolved('ip-1')),
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — accepted
    expect(res.status).toBe(200)
  })

  it('accepts callback when state has no boundAddress bound (legacy/test entries)', async () => {
    // #given — state minted without a boundAddress
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      // no boundAddress
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      resolveClientAddress: () => Effect.succeed(stubResolved('any-key')),
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — accepted (no boundAddress bound means no binding check)
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — provider error consumes state
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — provider error state consumption', () => {
  it('consumes valid known state immediately on provider error (does not hold outstanding budget)', async () => {
    // #given — state is valid and unconsumed
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      boundAddress: 'test-source-key',
    })

    const deps = makeStubDeps({stateStore, clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — GitHub sends error param with a valid known state
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?error=access_denied&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)

    // #and — state is consumed (not holding outstanding budget until TTL)
    const entry = stateStore.get('valid-state-value')
    expect(entry?.consumed).toBe(true)
  })

  it('emits provider_error audit reason on provider error', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })
    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({stateStore, clock: () => now + 1000, auditLogger})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?error=access_denied&state=valid-state-value',
    )
    await app.fetch(req)

    // #then — failure audit event with provider_error reason
    const failureEvent = auditLogger.records.find(r => r.kind === 'auth.callback.failure')
    expect(failureEvent).toBeDefined()
    expect(failureEvent?.reason).toBe('provider_error')
  })

  it('does not consume state on provider error when source key differs from mint-time key', async () => {
    // #given — state minted with 'ip-1', error callback arrives from 'ip-2'
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      boundAddress: 'ip-1',
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      resolveClientAddress: () => Effect.succeed(stubResolved('ip-2')), // different source
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — error callback from a different source
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?error=access_denied&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)

    // #and — state is NOT consumed (source key mismatch prevented the burn)
    const entry = stateStore.get('valid-state-value')
    expect(entry?.consumed).toBe(false)
  })

  it('does not consume state on provider error when state is expired', async () => {
    // #given — state is past TTL
    const stateStore = createInMemoryStateStore()
    const ttlMs = 10 * 60 * 1000
    const issuedAt = 1000
    stateStore.set('expired-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt,
      consumed: false,
      boundAddress: 'test-source-key',
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => issuedAt + ttlMs + 1, // 1ms past TTL
    })
    const config = makeStubConfig({stateTtlMs: ttlMs})
    const app = buildTestApp(deps, config)

    // #when — error callback with expired state
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?error=access_denied&state=expired-state-value',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)

    // #and — state is NOT consumed (expired entries are not burned)
    const entry = stateStore.get('expired-state-value')
    expect(entry?.consumed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — source key binding through the REAL trusted-proxy resolver
//
// The tests above stub resolveClientAddress with a fixed/varying string — they prove
// the *comparison* logic. These tests wire resolveClientAddress to the real
// resolveClient() + OperatorIngressPolicy (the exact production composition
// from program.ts), fed crafted RawIngressInput per call, to prove the
// *resolution* itself: that start and callback traversing different trusted
// proxies still bind, that IPv4 and IPv4-mapped-IPv6 spellings of one client
// are the same key, and that a genuinely different client still fails. A real
// socket cannot be made to originate from two different configured proxy
// addresses in-process, so this is the faithful alternative: same resolver,
// same policy, real (not stubbed) canonicalization — only the transport-level
// getConnInfo() call is substituted.
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — source key binding via the real ingress resolver', () => {
  const PROXY_A = '198.51.100.1'
  const PROXY_B = '198.51.100.2'
  const trustedProxyPolicy = makeTrustedProxyIngressPolicy([
    Effect.runSync(parseTrustedProxyAddress(PROXY_A)),
    Effect.runSync(parseTrustedProxyAddress(PROXY_B)),
  ])

  /** Resolves each successive call against the real resolver, one RawIngressInput per call, in order. */
  function makeSequencedRealResolveClientAddress(
    rawInputsInCallOrder: readonly RawIngressInput[],
  ): GitHubOAuthDeps['resolveClientAddress'] {
    let callIndex = 0
    return () => {
      const raw = rawInputsInCallOrder[callIndex]
      callIndex += 1
      if (raw === undefined) throw new Error('makeSequencedRealResolveClientAddress: more calls than configured inputs')
      return resolveClient(raw, trustedProxyPolicy)
    }
  }

  it('start through trusted proxy A, callback through trusted proxy B, same client — binding passes', async () => {
    // #given — start traverses proxy A, callback traverses proxy B; same client XFF both times
    const deps = makeStubDeps({
      resolveClientAddress: makeSequencedRealResolveClientAddress([
        {socketAddress: PROXY_A, forwardedForHeaders: ['203.0.113.5']},
        {socketAddress: PROXY_B, forwardedForHeaders: ['203.0.113.5']},
      ]),
    })
    const app = buildTestApp(deps, makeStubConfig())
    const state = await mintState(app)

    // #when
    const res = await app.fetch(
      new Request(`https://operator.example.com/operator/auth/github/callback?state=${state}&code=test-code`),
    )

    // #then — binding passed; callback proceeded to identity verification
    expect(res.status).toBe(200)
  })

  it('equivalent IPv4 and IPv4-mapped-IPv6 forms of one client — binding passes', async () => {
    // #given — same trusted proxy both times; client written as plain IPv4 at
    // mint, as its IPv4-mapped-IPv6 form at callback
    const deps = makeStubDeps({
      resolveClientAddress: makeSequencedRealResolveClientAddress([
        {socketAddress: PROXY_A, forwardedForHeaders: ['203.0.113.5']},
        {socketAddress: PROXY_A, forwardedForHeaders: ['::ffff:203.0.113.5']},
      ]),
    })
    const app = buildTestApp(deps, makeStubConfig())
    const state = await mintState(app)

    // #when
    const res = await app.fetch(
      new Request(`https://operator.example.com/operator/auth/github/callback?state=${state}&code=test-code`),
    )

    // #then — both forms canonicalize to the same client; binding passed
    expect(res.status).toBe(200)
  })

  it('a genuinely different client — the existing protection is still enforced (never completes the original flow)', async () => {
    // #given — different XFF client at callback than at mint
    const deps = makeStubDeps({
      resolveClientAddress: makeSequencedRealResolveClientAddress([
        {socketAddress: PROXY_A, forwardedForHeaders: ['203.0.113.5']}, // mint (original client)
        {socketAddress: PROXY_A, forwardedForHeaders: ['203.0.113.9']}, // attacker's first attempt
        {socketAddress: PROXY_A, forwardedForHeaders: ['203.0.113.9']}, // attacker replays the same original state
      ]),
    })
    const app = buildTestApp(deps, makeStubConfig())
    const state = await mintState(app)

    // #when — the attacker's first attempt at the original state+code
    const firstRes = await app.fetch(
      new Request(`https://operator.example.com/operator/auth/github/callback?state=${state}&code=test-code`),
    )

    // #then — bounced to a fresh /start, not handed the original identity
    expect(firstRes.status).toBe(302)
    expect(firstRes.headers.get('location') ?? '').toContain('/operator/auth/github/start')

    // #when — the attacker replays the exact same original state+code again
    const secondRes = await app.fetch(
      new Request(`https://operator.example.com/operator/auth/github/callback?state=${state}&code=test-code`),
    )

    // #then — the bounce already released and consumed the original state, so
    // the replay lands on the ordinary “already consumed” rejection — the
    // attacker never completes the original client's flow, and gets no
    // further redirect out of it
    expect(secondRes.status).toBe(400)
    expect(secondRes.headers.get('location')).toBeNull()
  })

  it('the provider-error callback path uses the same real-resolver comparison', async () => {
    // #given — different XFF client at callback than at mint, provider returns an error
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({
      stateStore,
      resolveClientAddress: makeSequencedRealResolveClientAddress([
        {socketAddress: PROXY_A, forwardedForHeaders: ['203.0.113.5']},
        {socketAddress: PROXY_A, forwardedForHeaders: ['203.0.113.9']},
      ]),
    })
    const app = buildTestApp(deps, makeStubConfig())
    const state = await mintState(app)

    // #when — provider-error callback from the mismatched client
    const res = await app.fetch(
      new Request(`https://operator.example.com/operator/auth/github/callback?error=access_denied&state=${state}`),
    )

    // #then — rejected; the mismatched source key must NOT consume the state
    // (same comparison, same fail-closed outcome as the non-error callback path)
    expect(res.status).toBe(400)
    const entry = stateStore.get(state)
    expect(entry?.consumed).toBe(false)
  })

  it('socket-unavailable on start allocates neither a rate-limit bucket nor OAuth state, and returns 503', async () => {
    // #given — the real resolver sees no socket at all (mirrors app.fetch() with no real connection)
    const stateStore = createInMemoryStateStore()
    const rateLimiter = {allow: vi.fn(() => true)}
    const deps = makeStubDeps({
      stateStore,
      rateLimiter,
      resolveClientAddress: makeSequencedRealResolveClientAddress([
        {socketAddress: undefined, forwardedForHeaders: []},
      ]),
    })
    const app = buildTestApp(deps, makeStubConfig())

    // #when
    const res = await app.fetch(new Request('https://operator.example.com/operator/auth/github/start'))

    // #then — 503, never a fallback key
    expect(res.status).toBe(503)
    expect(rateLimiter.allow).not.toHaveBeenCalled()
    expect(stateStore.get(DEFAULT_TEST_STATE)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Derived accounting keys vs exact binding (#1652)
//
// Counting (rate-limit bucket + outstanding-attempt slot) uses the derived
// accounting key (IPv6 /64, IPv4 /32). The OAuth binding stays on the exact
// canonical address. The client address is read from a test header and run
// through the REAL resolver, so derivation is production code, not a stub.
// ---------------------------------------------------------------------------

describe('OAuth accounting keys vs exact binding (#1652)', () => {
  const TEST_CLIENT_HEADER = 'x-test-client'
  const directPolicy = makeDirectIngressPolicy()

  function headerResolvedResolveClientAddress(): GitHubOAuthDeps['resolveClientAddress'] {
    return (c: Context) =>
      resolveClient({socketAddress: c.req.header(TEST_CLIENT_HEADER), forwardedForHeaders: []}, directPolicy)
  }

  async function startFrom(app: Hono, client: string): Promise<Response> {
    return app.fetch(
      new Request('https://operator.example.com/operator/auth/github/start', {
        headers: {[TEST_CLIENT_HEADER]: client},
      }),
    )
  }

  function makeAppWith(overrides: Partial<GitHubOAuthDeps> = {}, config?: GitHubOAuthConfig) {
    let stateCounter = 0
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({
      stateStore,
      generateState: () => `acct-state-${++stateCounter}`,
      resolveClientAddress: headerResolvedResolveClientAddress(),
      ...overrides,
    })
    return {app: buildTestApp(deps, config ?? makeStubConfig({maxOutstandingAttemptsPerKey: 1})), deps, stateStore}
  }

  it('addresses in the same /64 share one outstanding-attempt slot; an adjacent /64 is independent', async () => {
    // #given — one outstanding attempt allowed per accounting key
    const {app} = makeAppWith()

    // #when — two different addresses in one /64, then a neighbouring /64
    const first = await startFrom(app, '2001:db8:1:2::1')
    const sameSlash64 = await startFrom(app, '2001:db8:1:2:aaaa:bbbb:cccc:dddd')
    const adjacent = await startFrom(app, '2001:db8:1:3::1')

    // #then — the second address in the /64 is refused by the shared slot; the adjacent /64 is not
    expect(first.status).toBe(302)
    expect(sameSlash64.status).toBe(429)
    expect(adjacent.status).toBe(302)
  })

  it('iPv4 and its IPv4-mapped forms share one outstanding-attempt slot', async () => {
    // #given
    const {app} = makeAppWith()

    // #when
    const plain = await startFrom(app, '203.0.113.7')
    const dotted = await startFrom(app, '::ffff:203.0.113.7')
    const hex = await startFrom(app, '::ffff:cb00:7107')
    const other = await startFrom(app, '203.0.113.8')

    // #then
    expect(plain.status).toBe(302)
    expect(dotted.status).toBe(429)
    expect(hex.status).toBe(429)
    expect(other.status).toBe(302)
  })

  it('records the exact canonical address for binding and the derived key for counting', async () => {
    // #given
    const {app, stateStore} = makeAppWith({}, makeStubConfig())

    // #when
    await startFrom(app, '2001:db8:1:2::1')

    // #then — two distinct fields on the stored entry
    const entry = stateStore.get('acct-state-1')
    expect(entry?.boundAddress).toBe('2001:0db8:0001:0002:0000:0000:0000:0001')
    expect(entry?.accountingKey).toBe('ipv6/64:2001:0db8:0001:0002')
  })

  it('start and callback spend the same shared rate-limit bucket for addresses in one /64', async () => {
    // #given — a recording limiter
    const keys: string[] = []
    const rateLimiter: RateLimiter = {
      allow: key => {
        keys.push(key)
        return true
      },
    }
    const {app} = makeAppWith({rateLimiter}, makeStubConfig())

    // #when — start from one address, callback (no state) from another address in the same /64
    await startFrom(app, '2001:db8:1:2::1')
    await app.fetch(
      new Request('https://operator.example.com/operator/auth/github/callback?state=x&code=y', {
        headers: {[TEST_CLIENT_HEADER]: '2001:db8:1:2::2'},
      }),
    )

    // #then — one bucket key for both routes
    expect(keys).toEqual(['ipv6/64:2001:0db8:0001:0002', 'ipv6/64:2001:0db8:0001:0002'])
  })

  it('an address change within the same /64 still trips the exact binding mismatch', async () => {
    // #given — state minted from one address, callback from another address in the same /64
    const fetchSpy = makeSuccessFetch()
    const {app, stateStore} = makeAppWith({fetch: fetchSpy}, makeStubConfig())
    const startRes = await startFrom(app, '2001:db8:1:2::1')
    const state = new URL(startRes.headers.get('location') ?? '').searchParams.get('state') ?? ''

    // #when
    const res = await app.fetch(
      new Request(`https://operator.example.com/operator/auth/github/callback?state=${state}&code=test-code`, {
        headers: {[TEST_CLIENT_HEADER]: '2001:db8:1:2::2'},
      }),
    )

    // #then — exact binding refuses it: bounced to /start, state consumed, NO token exchange
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toContain('retry=1')
    expect(stateStore.get(state)?.consumed).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['dotted IPv4-mapped IPv6', '::ffff:203.0.113.5'],
    ['hex IPv4-mapped IPv6', '::ffff:cb00:7105'],
  ])(
    'a dual-stack respelling (%s) of the starting IPv4 address still matches the exact binding',
    async (_label, mapped) => {
      // #given — state minted from plain IPv4; canonicalization normalizes mapped forms to IPv4
      const fetchSpy = makeSuccessFetch()
      const {app, stateStore} = makeAppWith({fetch: fetchSpy}, makeStubConfig())
      const startRes = await startFrom(app, '203.0.113.5')
      const state = new URL(startRes.headers.get('location') ?? '').searchParams.get('state') ?? ''
      expect(stateStore.get(state)?.boundAddress).toBe('203.0.113.5')

      // #when — the callback arrives with the mapped spelling
      const res = await app.fetch(
        new Request(`https://operator.example.com/operator/auth/github/callback?state=${state}&code=test-code`, {
          headers: {[TEST_CLIENT_HEADER]: mapped},
        }),
      )

      // #then — no mismatch: completes the flow (token exchange happened), no bounce
      expect(res.status).toBe(200)
      expect(res.headers.get('location')).toBeNull()
      expect(fetchSpy).toHaveBeenCalled()
    },
  )
})

// ---------------------------------------------------------------------------
// OAuth start — source key resolution wired through a REAL Hono Context
//
// The "real ingress resolver" tests above feed predetermined RawIngressInput
// values into resolveClient() directly, in call order — they prove the
// *comparison* logic, not that the route hands resolveClient the request's
// actual Context. This section serves the OAuth routes over a genuine TCP
// socket (mirroring the announce-server precedent in http/server.test.ts, and
// startRealOperatorServer in web/server.test.ts) so getConnInfo(c) inside
// extractRawIngressInput returns a real remote address, and resolveClientAddress is
// the exact production composition — resolveClient(extractRawIngressInput(c),
// policy), as wired in program.ts — rather than a stub or a sequenced fixture.
// ---------------------------------------------------------------------------

/** Find a free port by briefly opening a server (mirrors web/server.test.ts). */
async function findFreePortForOAuthServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port
      s.close(err => {
        if (err !== undefined && err !== null) {
          reject(err)
        } else {
          resolve(port)
        }
      })
    })
  })
}

describe('GET /operator/auth/github/start — source key resolution via a real Hono Context', () => {
  const trustedLoopbackPolicy = makeTrustedProxyIngressPolicy([Effect.runSync(parseTrustedProxyAddress('127.0.0.1'))])

  /** Start a real OAuth-only server on a free loopback port; caller must close it. */
  async function startRealOAuthServer(
    config: GitHubOAuthConfig,
  ): Promise<{readonly port: number; readonly close: () => Promise<void>}> {
    let stateCounter = 0
    const deps = makeStubDeps({
      rateLimiter: makePassRateLimiter(),
      // Distinct state values per call — makeStubDeps' default generateState is
      // a fixed string, which would collide across the sequential requests
      // below and overwrite each other's state-store entry.
      generateState: () => `real-context-state-${++stateCounter}`,
      // The real production composition (see program.ts resolveClientAddress) — not a
      // stub returning a fixed/sequenced key. getConnInfo(c) requires a genuine
      // socket, which only a real serve() listener (not app.fetch()) provides.
      resolveClientAddress: (c: Context) => resolveClient(extractRawIngressInput(c), trustedLoopbackPolicy),
    })
    const app = buildTestApp(deps, config)
    const port = await findFreePortForOAuthServer()
    const server = serve({fetch: app.fetch, port, hostname: '127.0.0.1'})
    return {
      port,
      close: async () => new Promise<void>(resolve => server.close(() => resolve())),
    }
  }

  it('two distinct clients behind the trusted loopback proxy each get their own outstanding-attempt budget', async () => {
    // #given — cap of 1 outstanding attempt per source key; a real listening server
    const config = makeStubConfig({maxOutstandingAttemptsPerKey: 1})
    const {port, close} = await startRealOAuthServer(config)
    try {
      // #when — two different real clients (distinguished by X-Forwarded-For
      // through the trusted loopback proxy) each start once, then the first
      // client starts again
      const resA1 = await fetch(`http://127.0.0.1:${port}/operator/auth/github/start`, {
        headers: {'x-forwarded-for': '203.0.113.5'},
        redirect: 'manual',
      })
      const resB1 = await fetch(`http://127.0.0.1:${port}/operator/auth/github/start`, {
        headers: {'x-forwarded-for': '203.0.113.9'},
        redirect: 'manual',
      })
      const resA2 = await fetch(`http://127.0.0.1:${port}/operator/auth/github/start`, {
        headers: {'x-forwarded-for': '203.0.113.5'},
        redirect: 'manual',
      })

      // #then — A and B each get their own budget, proving the route resolved
      // two distinct real Contexts to two distinct keys; A's second start
      // exceeds A's own cap, proving the SAME real Context resolves to the
      // SAME key on a repeat request. Either wiring defect (stale/shared
      // Context, or a Context ignored in favor of a fixed key) would collapse
      // this into either "B blocked too" or "A2 never blocked".
      expect(resA1.status).toBe(302)
      expect(resB1.status).toBe(302)
      expect(resA2.status).toBe(429)
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — error paths (fail closed)
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — error paths', () => {
  it('returns 400 for missing state param', async () => {
    // #given
    const deps = makeStubDeps()
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — no state param
    const req = new Request('https://operator.example.com/operator/auth/github/callback?code=github-code-abc')
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing code param', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })
    const deps = makeStubDeps({stateStore, clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — no code param
    const req = new Request('https://operator.example.com/operator/auth/github/callback?state=valid-state-value')
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)
  })

  it('returns 400 for unknown state (state mismatch)', async () => {
    // #given — empty state store
    const deps = makeStubDeps()
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — unknown state value
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=unknown-state-value',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)
  })

  it('returns 400 for replayed (already consumed) state', async () => {
    // #given — state already consumed
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('consumed-state', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: true, // already consumed
    })

    const deps = makeStubDeps({stateStore, clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=consumed-state',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)
  })

  it('returns 400 for expired state (TTL exceeded)', async () => {
    // #given — state issued long ago
    const stateStore = createInMemoryStateStore()
    const issuedAt = 1000
    stateStore.set('expired-state', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt,
      consumed: false,
    })

    const ttlMs = 10 * 60 * 1000 // 10 minutes
    const deps = makeStubDeps({
      stateStore,
      clock: () => issuedAt + ttlMs + 1, // 1ms past TTL
    })
    const config = makeStubConfig({stateTtlMs: ttlMs})
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=expired-state',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)
  })

  it('returns 400 when GitHub returns an error in the callback (provider_error)', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })
    const deps = makeStubDeps({stateStore, clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — GitHub sends error param
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?error=access_denied&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)
  })

  it('returns 400 when token exchange returns no access_token (missing field)', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const failFetch: GitHubOAuthDeps['fetch'] = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlStr.includes('login/oauth/access_token')) {
        return new Response(JSON.stringify({error: 'bad_verification_code'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      }
      return new Response('not found', {status: 404})
    })

    const deps = makeStubDeps({stateStore, clock: () => now + 1000, fetch: failFetch})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)
  })

  it('returns 400 when token exchange returns non-2xx HTTP status', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const failFetch: GitHubOAuthDeps['fetch'] = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlStr.includes('login/oauth/access_token')) {
        return new Response('server error', {status: 500})
      }
      return new Response('not found', {status: 404})
    })

    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({stateStore, clock: () => now + 1000, fetch: failFetch, auditLogger})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)

    // #and — correct audit reason
    const failureEvent = auditLogger.records.find(r => r.kind === 'auth.callback.failure')
    expect(failureEvent?.reason).toBe('token_exchange_failed')
  })

  it('returns 400 when token exchange throws (network error / timeout)', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const throwFetch: GitHubOAuthDeps['fetch'] = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlStr.includes('login/oauth/access_token')) {
        throw new Error('network timeout')
      }
      return new Response('not found', {status: 404})
    })

    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({stateStore, clock: () => now + 1000, fetch: throwFetch, auditLogger})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)

    // #and — correct audit reason
    const failureEvent = auditLogger.records.find(r => r.kind === 'auth.callback.failure')
    expect(failureEvent?.reason).toBe('token_exchange_failed')
  })

  it('returns 400 when user fetch returns non-2xx HTTP status', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const failFetch: GitHubOAuthDeps['fetch'] = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlStr.includes('login/oauth/access_token')) {
        return new Response(JSON.stringify({access_token: 'ghs_TOKEN', token_type: 'bearer', scope: 'read:user'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      }
      if (urlStr.includes('api.github.com/user')) {
        return new Response('unauthorized', {status: 401})
      }
      return new Response('not found', {status: 404})
    })

    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({stateStore, clock: () => now + 1000, fetch: failFetch, auditLogger})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)

    // #and — correct audit reason
    const failureEvent = auditLogger.records.find(r => r.kind === 'auth.callback.failure')
    expect(failureEvent?.reason).toBe('user_fetch_failed')
  })

  it('returns 400 when user fetch throws (network error / timeout)', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const throwFetch: GitHubOAuthDeps['fetch'] = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlStr.includes('login/oauth/access_token')) {
        return new Response(JSON.stringify({access_token: 'ghs_TOKEN', token_type: 'bearer', scope: 'read:user'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      }
      if (urlStr.includes('api.github.com/user')) {
        throw new Error('connection reset')
      }
      return new Response('not found', {status: 404})
    })

    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({stateStore, clock: () => now + 1000, fetch: throwFetch, auditLogger})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — fail closed
    expect(res.status).toBe(400)

    // #and — correct audit reason
    const failureEvent = auditLogger.records.find(r => r.kind === 'auth.callback.failure')
    expect(failureEvent?.reason).toBe('user_fetch_failed')
  })

  it('emits auth.callback.failure audit event with state_mismatch reason on unknown state', async () => {
    // #given
    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({auditLogger})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — unknown state
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=unknown-state',
    )
    await app.fetch(req)

    // #then — failure audit event emitted with reason
    const failureEvent = auditLogger.records.find(r => r.kind === 'auth.callback.failure')
    expect(failureEvent).toBeDefined()
    expect(failureEvent?.reason).toBe('state_mismatch')
  })

  it('emits auth.callback.failure audit event with token_exchange_failed reason on token failure', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const failFetch: GitHubOAuthDeps['fetch'] = vi.fn(async () => {
      return new Response(JSON.stringify({error: 'bad_verification_code'}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    })

    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({stateStore, clock: () => now + 1000, fetch: failFetch, auditLogger})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    await app.fetch(req)

    // #then — failure audit event emitted with reason
    const failureEvent = auditLogger.records.find(r => r.kind === 'auth.callback.failure')
    expect(failureEvent).toBeDefined()
    expect(failureEvent?.reason).toBe('token_exchange_failed')
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — coarse failure response shape
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — coarse failure response shape', () => {
  it('all failure branches return the same coarse 400 response shape', async () => {
    // #given — multiple failure scenarios
    const scenarios: {name: string; url: string; storeSetup?: (s: OAuthStateStore) => void}[] = [
      {name: 'missing state', url: 'https://operator.example.com/operator/auth/github/callback?code=abc'},
      {name: 'missing code', url: 'https://operator.example.com/operator/auth/github/callback?state=unknown'},
      {
        name: 'unknown state',
        url: 'https://operator.example.com/operator/auth/github/callback?code=abc&state=unknown',
      },
      {
        name: 'provider error',
        url: 'https://operator.example.com/operator/auth/github/callback?error=access_denied&state=valid-state',
        storeSetup: s => {
          s.set('valid-state', {
            codeVerifier: 'verifier',
            issuedAt: Date.now(),
            consumed: false,
          })
        },
      },
    ]

    for (const scenario of scenarios) {
      const stateStore = createInMemoryStateStore()
      if (scenario.storeSetup !== undefined) scenario.storeSetup(stateStore)
      const deps = makeStubDeps({stateStore})
      const config = makeStubConfig()
      const app = buildTestApp(deps, config)

      // #when
      const req = new Request(scenario.url)
      const res = await app.fetch(req)

      // #then — coarse 400 with consistent shape
      expect(res.status, `scenario: ${scenario.name}`).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body, `scenario: ${scenario.name}`).toHaveProperty('error')
      // Error message must be coarse — no internal details
      const errorMsg = String(body.error)
      expect(errorMsg, `scenario: ${scenario.name}`).not.toContain('state_mismatch')
      expect(errorMsg, `scenario: ${scenario.name}`).not.toContain('verifier')
      expect(errorMsg, `scenario: ${scenario.name}`).not.toContain('token')
    }
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — future Fetch Metadata compatibility
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — future Fetch Metadata compatibility', () => {
  it('accepts cross-site Sec-Fetch-Site header on the callback route', async () => {
    // #given — state pre-seeded
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({stateStore, clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — GitHub redirects cross-site (Sec-Fetch-Site: cross-site)
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
      {
        headers: {
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
        },
      },
    )
    const res = await app.fetch(req)

    // #then — callback accepts GitHub's cross-site redirect shape
    expect(res.status).toBe(200)
  })

  it('callback route is registered as public (not privileged)', async () => {
    // #given
    const deps = makeStubDeps()
    const config = makeStubConfig()
    const app = new Hono()
    registerPublicRoute(app, 'GET', '/operator/health', c => c.json({ok: true}))
    buildGitHubOAuthRoutes(app, deps, config)

    // #then — callback is public
    expect(isPublicRoute(app, 'GET', '/operator/auth/github/callback')).toBe(true)
  })

  it('start route is registered as public (not privileged)', async () => {
    // #given
    const deps = makeStubDeps()
    const config = makeStubConfig()
    const app = new Hono()
    registerPublicRoute(app, 'GET', '/operator/health', c => c.json({ok: true}))
    buildGitHubOAuthRoutes(app, deps, config)

    // #then — start is public
    expect(isPublicRoute(app, 'GET', '/operator/auth/github/start')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Route inventory — OAuth-enabled buildOperatorApp
// ---------------------------------------------------------------------------

describe('buildGitHubOAuthRoutes — route inventory', () => {
  it('registers exactly the expected OAuth routes as public', () => {
    // #given
    const deps = makeStubDeps()
    const config = makeStubConfig()
    const app = new Hono()
    registerPublicRoute(app, 'GET', '/operator/health', c => c.json({ok: true}))
    buildGitHubOAuthRoutes(app, deps, config)

    // #then — both OAuth routes are registered as public
    expect(isPublicRoute(app, 'GET', '/operator/auth/github/start')).toBe(true)
    expect(isPublicRoute(app, 'GET', '/operator/auth/github/callback')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createInMemoryStateStore — unit tests
// ---------------------------------------------------------------------------

describe('createInMemoryStateStore', () => {
  it('stores and retrieves state entries', () => {
    // #given
    const store = createInMemoryStateStore()
    const entry = {codeVerifier: 'verifier', issuedAt: 1000, consumed: false}

    // #when
    store.set('state-key', entry)

    // #then
    expect(store.get('state-key')).toEqual(entry)
  })

  it('returns undefined for unknown keys', () => {
    // #given
    const store = createInMemoryStateStore()

    // #when / #then
    expect(store.get('nonexistent')).toBeUndefined()
  })

  it('marks an entry as consumed', () => {
    // #given
    const store = createInMemoryStateStore()
    store.set('state-key', {codeVerifier: 'verifier', issuedAt: 1000, consumed: false})

    // #when
    store.consume('state-key')

    // #then
    const entry = store.get('state-key')
    if (entry === undefined) throw new Error('expected entry to exist')
    expect(entry.consumed).toBe(true)
  })

  it('counts outstanding (unconsumed) entries for an accounting key', () => {
    // #given
    const store = createInMemoryStateStore()
    store.set('state-1', {codeVerifier: 'v1', issuedAt: 1000, consumed: false, accountingKey: 'acct-1'})
    store.set('state-2', {codeVerifier: 'v2', issuedAt: 1000, consumed: false, accountingKey: 'acct-1'})
    store.set('state-3', {codeVerifier: 'v3', issuedAt: 1000, consumed: true, accountingKey: 'acct-1'})
    store.set('state-4', {codeVerifier: 'v4', issuedAt: 1000, consumed: false, accountingKey: 'acct-2'})
    // exact binding key alone never counts toward an accounting slot
    store.set('state-5', {codeVerifier: 'v5', issuedAt: 1000, consumed: false, boundAddress: 'acct-1'})

    // #when / #then — only unconsumed entries carrying that accounting key
    expect(store.countOutstanding('acct-1')).toBe(2)
    expect(store.countOutstanding('acct-2')).toBe(1)
  })

  it('evictStale removes consumed entries', () => {
    // #given
    const store = createInMemoryStateStore()
    const now = 10_000
    store.set('consumed', {codeVerifier: 'v1', issuedAt: now - 100, consumed: true})
    store.set('active', {codeVerifier: 'v2', issuedAt: now - 100, consumed: false})

    // #when
    store.evictStale(now, 600_000)

    // #then — consumed entry is removed; active entry remains
    expect(store.get('consumed')).toBeUndefined()
    expect(store.get('active')).toBeDefined()
    expect(countKnown(store, ['consumed', 'active'])).toBe(1)
  })

  it('evictStale removes expired entries', () => {
    // #given
    const store = createInMemoryStateStore()
    const ttlMs = 10 * 60 * 1000
    const now = 100_000
    store.set('expired', {codeVerifier: 'v1', issuedAt: now - ttlMs - 1, consumed: false})
    store.set('fresh', {codeVerifier: 'v2', issuedAt: now - 1000, consumed: false})

    // #when
    store.evictStale(now, ttlMs)

    // #then — expired entry is removed; fresh entry remains
    expect(store.get('expired')).toBeUndefined()
    expect(store.get('fresh')).toBeDefined()
    expect(countKnown(store, ['expired', 'fresh'])).toBe(1)
  })

  it('evictStale removes both consumed and expired entries in one pass', () => {
    // #given
    const store = createInMemoryStateStore()
    const ttlMs = 10 * 60 * 1000
    const now = 100_000
    store.set('consumed', {codeVerifier: 'v1', issuedAt: now - 100, consumed: true})
    store.set('expired', {codeVerifier: 'v2', issuedAt: now - ttlMs - 1, consumed: false})
    store.set('active', {codeVerifier: 'v3', issuedAt: now - 1000, consumed: false})

    // #when
    store.evictStale(now, ttlMs)

    // #then — only active entry remains
    expect(countKnown(store, ['consumed', 'expired', 'active'])).toBe(1)
    expect(store.get('active')).toBeDefined()
  })

  it('evictStale with empty store is a no-op', () => {
    // #given
    const store = createInMemoryStateStore()

    // #when / #then — no throw
    expect(() => store.evictStale(Date.now(), 600_000)).not.toThrow()
    expect(countKnown(store, ['anything'])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Auth start — bounded state store evicts the oldest instead of refusing (#1652)
//
// Order of operations in /start: (1) reclaim consumed + expired states,
// (2) enforce the per-accounting-key outstanding cap, (3) validate the request,
// (4) at the insertion point, if the store is full evict the oldest remaining
// state, (5) insert synchronously. The store owns bounded insertion.
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/start — full state store evicts the oldest (#1652)', () => {
  const CLIENT_HEADER = 'x-test-client'

  interface EvictionHarness {
    readonly app: Hono
    readonly stateStore: ReturnType<typeof createInMemoryStateStore>
    readonly fetchSpy: GitHubOAuthDeps['fetch']
    readonly clock: {now: number}
    readonly start: (client: string, query?: string) => Promise<Response>
    readonly callback: (client: string, state: string, extra?: string) => Promise<Response>
    /** Mint a state from `client` and return its value (throws if start did not redirect). */
    readonly mint: (client: string) => Promise<string>
    /** How many of the state values generated so far the store still knows (observed via get()). */
    readonly knownCount: () => number
  }

  function makeEvictionHarness(opts: {
    readonly maxEntries?: number
    readonly perKeyCap?: number
    readonly ttlMs?: number
    readonly fetch?: GitHubOAuthDeps['fetch']
  }): EvictionHarness {
    let stateCounter = 0
    const generated: string[] = []
    const stateStore =
      opts.maxEntries === undefined ? createInMemoryStateStore() : createInMemoryStateStore(opts.maxEntries)
    const fetchSpy = opts.fetch ?? makeSuccessFetch()
    const clock = {now: 1_000_000}
    const deps = makeStubDeps({
      stateStore,
      fetch: fetchSpy,
      clock: () => clock.now,
      generateState: () => {
        const state = `st-${++stateCounter}`
        generated.push(state)
        return state
      },
      resolveClientAddress: (c: Context) =>
        Effect.succeed(stubResolved(c.req.header(CLIENT_HEADER) ?? 'missing-client')),
    })
    const config = makeStubConfig({
      maxOutstandingAttemptsPerKey: opts.perKeyCap ?? 5,
      ...(opts.ttlMs === undefined ? {} : {stateTtlMs: opts.ttlMs}),
    })
    const app = buildTestApp(deps, config)
    const start = async (client: string, query = ''): Promise<Response> =>
      app.fetch(
        new Request(`https://operator.example.com/operator/auth/github/start${query}`, {
          headers: {[CLIENT_HEADER]: client},
        }),
      )
    const callback = async (client: string, state: string, extra = ''): Promise<Response> =>
      app.fetch(
        new Request(
          `https://operator.example.com/operator/auth/github/callback?state=${state}&code=test-code${extra}`,
          {headers: {[CLIENT_HEADER]: client}},
        ),
      )
    const mint = async (client: string): Promise<string> => {
      const res = await start(client)
      const state = new URL(res.headers.get('location') ?? 'https://x.invalid').searchParams.get('state')
      if (res.status !== 302 || state === null) throw new Error(`expected a state mint, got ${res.status}`)
      return state
    }
    const knownCount = (): number => countKnown(stateStore, generated)
    return {app, stateStore, fetchSpy, clock, start, callback, mint, knownCount}
  }

  it('admits a new start into a full store, stays bounded, and evicts exactly the oldest entry', async () => {
    // #given — a store of 3, filled by three distinct clients
    const h = makeEvictionHarness({maxEntries: 3})
    const s1 = await h.mint('203.0.113.1')
    const s2 = await h.mint('203.0.113.2')
    const s3 = await h.mint('203.0.113.3')
    expect(h.knownCount()).toBe(3)

    // #when — a fourth, eligible client starts
    const s4 = await h.mint('203.0.113.4')

    // #then — admitted, still 3 entries, only the oldest is gone
    expect(h.knownCount()).toBe(3)
    expect(h.stateStore.get(s1)).toBeUndefined()
    expect(h.stateStore.get(s2)).toBeDefined()
    expect(h.stateStore.get(s3)).toBeDefined()
    expect(h.stateStore.get(s4)).toBeDefined()
  })

  it('rejects the evicted entry callback with the ordinary 400, no bounce, and no token exchange', async () => {
    // #given — s1 was evicted by a newer start
    const h = makeEvictionHarness({maxEntries: 2})
    const s1 = await h.mint('203.0.113.1')
    await h.mint('203.0.113.2')
    await h.mint('203.0.113.3')
    expect(h.stateStore.get(s1)).toBeUndefined()

    // #when — the evicted attempt's owner returns from GitHub
    const res = await h.callback('203.0.113.1', s1)

    // #then — unknown state: plain 400, no redirect, GitHub never contacted
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(h.fetchSpy).not.toHaveBeenCalled()
  })

  it('stays bounded at the production default of 1,000 and evicts the oldest on the 1,001st start', async () => {
    // #given — 1,000 distinct clients, one outstanding state each
    const h = makeEvictionHarness({})
    const first = await h.mint('10.0.0.0')
    for (let i = 1; i < 1000; i++) {
      await h.mint(`10.0.${Math.floor(i / 256)}.${i % 256}`)
    }
    expect(h.knownCount()).toBe(1000)

    // #when — one more
    const res = await h.start('198.51.100.9')

    // #then — admitted instead of 429; bounded; the first state is the one that went
    expect(res.status).toBe(302)
    expect(h.knownCount()).toBe(1000)
    expect(h.stateStore.get(first)).toBeUndefined()
  })

  it('an invalid start (bad return_to) against a full store evicts nothing', async () => {
    // #given
    const h = makeEvictionHarness({maxEntries: 2})
    const s1 = await h.mint('203.0.113.1')
    const s2 = await h.mint('203.0.113.2')

    // #when — a fresh client sends an invalid return_to
    const res = await h.start('203.0.113.3', '?return_to=https://evil.example.com/')

    // #then — rejected, and the store is untouched
    expect(res.status).toBe(400)
    expect(h.knownCount()).toBe(2)
    expect(h.stateStore.get(s1)).toBeDefined()
    expect(h.stateStore.get(s2)).toBeDefined()
  })

  it('a start rejected by the per-key outstanding cap against a full store evicts nothing', async () => {
    // #given — per-key cap 1; store of 2 filled by two clients
    const h = makeEvictionHarness({maxEntries: 2, perKeyCap: 1})
    const s1 = await h.mint('203.0.113.1')
    const s2 = await h.mint('203.0.113.2')

    // #when — the first client tries again while its slot is held
    const res = await h.start('203.0.113.1')

    // #then — 429, and nothing was evicted to make room
    expect(res.status).toBe(429)
    expect(h.knownCount()).toBe(2)
    expect(h.stateStore.get(s1)).toBeDefined()
    expect(h.stateStore.get(s2)).toBeDefined()
  })

  it('reclaims consumed and stale entries first, so no live entry is evicted while reclaimable ones exist', async () => {
    // #given — store of 3: s1 will go stale, s2 will be consumed, s3 stays live
    const ttlMs = 60_000
    const h = makeEvictionHarness({maxEntries: 3, ttlMs})
    const t0 = 1_000
    h.clock.now = t0
    const s1 = await h.mint('203.0.113.1')
    h.clock.now = t0 + ttlMs / 2
    const s2 = await h.mint('203.0.113.2')
    h.clock.now = t0 + ttlMs / 2 + 1
    const s3 = await h.mint('203.0.113.3')
    h.stateStore.consume(s2)
    h.clock.now = t0 + ttlMs + 1_000 // s1 is now older than the TTL; s3 is still inside it

    // #when — a new start arrives at a nominally full store
    const s4 = await h.mint('203.0.113.4')

    // #then — the reclaimable pair was dropped; the live s3 survived
    expect(h.stateStore.get(s1)).toBeUndefined()
    expect(h.stateStore.get(s2)).toBeUndefined()
    expect(h.stateStore.get(s3)).toBeDefined()
    expect(h.stateStore.get(s4)).toBeDefined()
    expect(h.knownCount()).toBe(2)
  })

  it('bounce/retry and terminal mismatch still work under saturation', async () => {
    // #given — store of 2, full of A and E after B's state was consumed by a mismatching callback
    const h = makeEvictionHarness({maxEntries: 2})
    const sA = await h.mint('203.0.113.1')
    const sB = await h.mint('203.0.113.2')
    const bounce = await h.callback('203.0.113.99', sB)
    expect(bounce.status).toBe(302)
    expect(bounce.headers.get('location') ?? '').toContain('retry=1')
    expect(h.stateStore.get(sB)?.consumed).toBe(true)
    await h.mint('203.0.113.5')

    // #when — the bounced client follows the redirect into a FULL store
    const retry = await h.start('203.0.113.99', '?retry=1')
    const retryState = new URL(retry.headers.get('location') ?? 'https://x.invalid').searchParams.get('state') ?? ''

    // #then — admitted by evicting the oldest (sA); the new state is marked bounced
    expect(retry.status).toBe(302)
    expect(h.stateStore.get(sA)).toBeUndefined()
    expect(h.stateStore.get(retryState)?.bounced).toBe(true)

    // #when — the address shifts AGAIN on the retried state
    const second = await h.callback('203.0.113.98', retryState)

    // #then — terminal: plain 400, no further bounce, state consumed, no token exchange
    expect(second.status).toBe(400)
    expect(second.headers.get('location')).toBeNull()
    expect(h.stateStore.get(retryState)?.consumed).toBe(true)
    expect(h.fetchSpy).not.toHaveBeenCalled()
  })

  it('provider-error handling still consumes a live state minted after an eviction', async () => {
    // #given — store of 2; sC's start evicted the oldest (sA), so sC is a fresh live state in a full store
    const h = makeEvictionHarness({maxEntries: 2})
    const sA = await h.mint('203.0.113.1')
    await h.mint('203.0.113.2')
    const sC = await h.mint('203.0.113.3')
    expect(h.stateStore.get(sA)).toBeUndefined()
    expect(h.stateStore.get(sC)?.consumed).toBe(false)

    // #when — the provider reports an error for sC from its own client
    const res = await h.callback('203.0.113.3', sC, '&error=access_denied')

    // #then — fails closed with 400, the live state is consumed, GitHub is never contacted
    expect(res.status).toBe(400)
    expect(h.stateStore.get(sC)?.consumed).toBe(true)
    expect(h.fetchSpy).not.toHaveBeenCalled()
  })

  it('replay of a completed state is rejected, and stays rejected after later starts reclaim or evict it', async () => {
    // #given — store of 2 holding s1 and sB; sB completes a sign-in (2 fetches: token + user)
    const h = makeEvictionHarness({maxEntries: 2})
    await h.mint('203.0.113.1')
    const sB = await h.mint('203.0.113.2')
    const first = await h.callback('203.0.113.2', sB)
    expect(first.status).toBe(200)
    expect(h.fetchSpy).toHaveBeenCalledTimes(2)

    // #when — replay while the consumed record is still present
    const immediateReplay = await h.callback('203.0.113.2', sB)

    // #then — rejected without touching GitHub
    expect(immediateReplay.status).toBe(400)
    expect(h.fetchSpy).toHaveBeenCalledTimes(2)

    // #when — two more starts push the store through reclaim (consumed sB) and eviction (s1)
    await h.mint('203.0.113.3')
    await h.mint('203.0.113.4')
    expect(h.stateStore.get(sB)).toBeUndefined()
    const lateReplay = await h.callback('203.0.113.2', sB)

    // #then — still a plain 400, no further token exchange
    expect(lateReplay.status).toBe(400)
    expect(lateReplay.headers.get('location')).toBeNull()
    expect(h.fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('consumes the state before the first external await, under saturation', async () => {
    // #given — the token-exchange fetch observes the store at the moment it is called
    const observed: boolean[] = []
    let probe: (() => boolean) | undefined
    const probingFetch: GitHubOAuthDeps['fetch'] = vi.fn(async (url: string | URL | Request) => {
      observed.push(probe?.() ?? false)
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlStr.includes('access_token')) return new Response(JSON.stringify({access_token: 't'}), {status: 200})
      return new Response(JSON.stringify({id: 7, login: 'octocat'}), {status: 200})
    })
    const h = makeEvictionHarness({maxEntries: 2, fetch: probingFetch})
    await h.mint('203.0.113.1')
    const sB = await h.mint('203.0.113.2')
    await h.mint('203.0.113.3') // evicts the oldest; store is saturated again
    const sC = await h.mint('203.0.113.4')
    probe = () => h.stateStore.get(sC)?.consumed === true

    // #when
    const res = await h.callback('203.0.113.4', sC)

    // #then — consumed by the time GitHub is first contacted; the earlier-evicted sB stays unknown
    expect(res.status).toBe(200)
    expect(observed[0]).toBe(true)
    expect(h.stateStore.get(sB)).toBeUndefined()
  })
})

describe('createInMemoryStateStore — bounded insertion (#1652)', () => {
  const entry = (issuedAt = 1000) => ({codeVerifier: 'v', issuedAt, consumed: false})

  it('evicts the oldest entry when inserting a new key into a full store', () => {
    // #given
    const store = createInMemoryStateStore(2)
    store.set('a', entry())
    store.set('b', entry())

    // #when
    store.set('c', entry())

    // #then
    expect(countKnown(store, ['a', 'b', 'c'])).toBe(2)
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBeDefined()
    expect(store.get('c')).toBeDefined()
  })

  it('stays bounded under sustained churn', () => {
    // #given
    const store = createInMemoryStateStore(5)

    // #when
    for (let i = 0; i < 500; i++) store.set(`s-${i}`, entry())

    // #then — only the 5 newest survive
    expect(
      countKnown(
        store,
        Array.from({length: 500}, (_, i) => `s-${i}`),
      ),
    ).toBe(5)
    expect(store.get('s-494')).toBeUndefined()
    expect(store.get('s-495')).toBeDefined()
    expect(store.get('s-499')).toBeDefined()
  })

  it('re-minting an existing state value does not evict a different entry', () => {
    // #given
    const store = createInMemoryStateStore(2)
    store.set('a', entry())
    store.set('b', entry())

    // #when
    store.set('b', entry(2000))

    // #then
    expect(countKnown(store, ['a', 'b'])).toBe(2)
    expect(store.get('a')).toBeDefined()
    expect(store.get('b')?.issuedAt).toBe(2000)
  })

  it('an evicted state is never resurrected by later activity', () => {
    // #given
    const store = createInMemoryStateStore(1)
    store.set('a', entry())
    store.set('b', entry())

    // #when
    store.consume('a')
    store.evictStale(10_000, 600_000)

    // #then
    expect(store.get('a')).toBeUndefined()
    expect(countKnown(store, ['a', 'b'])).toBe(1)
  })

  it.each([
    ['zero', 0],
    ['a negative value', -1],
    ['NaN', Number.NaN],
    ['a fractional value', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('fails fast with a RangeError when maxEntries is %s', (_label, maxEntries) => {
    // #given / #when / #then — a non-positive or non-integer bound is a programming error
    expect(() => createInMemoryStateStore(maxEntries)).toThrow(RangeError)
  })

  it('accepts a bound of exactly 1', () => {
    // #given / #when / #then
    expect(() => createInMemoryStateStore(1)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// validateReturnPath — backslash and encoded-slash regression tests
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/start — validateReturnPath backslash/encoded-slash', () => {
  it(String.raw`rejects backslash-prefixed path (\\evil.com open-redirect attempt)`, async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — backslash prefix: \evil.com
    const req = new Request('https://operator.example.com/operator/auth/github/start?return_to=%5Cevil.com')
    const res = await app.fetch(req)

    // #then — rejected; no state minted (backslash does not start with /)
    expect(res.status).toBe(400)
    expect(stateStore.get(DEFAULT_TEST_STATE)).toBeUndefined()
  })

  it('rejects encoded-slash path (/%2fevil.com open-redirect attempt)', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — encoded slash: /%2fevil.com (not in allowlist)
    const req = new Request('https://operator.example.com/operator/auth/github/start?return_to=%2F%2Fevil.com')
    const res = await app.fetch(req)

    // #then — rejected; not in allowlist (exact-match allowlist prevents bypass)
    expect(res.status).toBe(400)
    expect(stateStore.get(DEFAULT_TEST_STATE)).toBeUndefined()
  })

  it('rejects uppercase encoded-slash path (/%2Fevil.com)', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when — uppercase encoded slash: /%2Fevil.com
    const req = new Request('https://operator.example.com/operator/auth/github/start?return_to=%2F%2Fevil.com')
    const res = await app.fetch(req)

    // #then — rejected; not in allowlist
    expect(res.status).toBe(400)
    expect(stateStore.get(DEFAULT_TEST_STATE)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — session minting
// ---------------------------------------------------------------------------

function makeStubSessionDeps(overrides?: Partial<SessionDeps>): SessionDeps {
  return {
    logger: makeLogger(),
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    clock: () => Date.now(),
    ...overrides,
  }
}

/** Build a test app with session store wired into OAuth deps. */
function buildTestAppWithSession(
  deps: GitHubOAuthDeps,
  config: GitHubOAuthConfig,
  sessionStore: SessionStore,
  sessionDeps: SessionDeps,
): Hono {
  const app = new Hono()
  registerPublicRoute(app, 'GET', '/operator/health', c => c.json({ok: true}))
  buildGitHubOAuthRoutes(app, {...deps, sessionStore, sessionDeps}, config)
  assertAllPrivilegedRoutesWrapped(app)
  return app
}

describe('GET /operator/auth/github/callback — session minting', () => {
  it('mints a fresh session on successful callback and sets __Host- session cookie', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — success
    expect(res.status).toBe(302) // no return_to captured → redirect to default landing path

    // #and — session was created in the store
    expect(sessionStore.size()).toBe(1)

    // #and — Set-Cookie header contains the session cookie
    const setCookieHeaders = res.headers.getSetCookie()
    const sessionCookie = setCookieHeaders.find(h => h.startsWith(`${SESSION_COOKIE_NAME}=`))
    expect(sessionCookie).toBeDefined()
  })

  it('session cookie has HttpOnly, Secure, SameSite=Lax, Path=/ attributes', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — cookie attributes
    const setCookieHeaders = res.headers.getSetCookie()
    const sessionCookie = setCookieHeaders.find(h => h.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? ''
    expect(sessionCookie.toLowerCase()).toContain('httponly')
    expect(sessionCookie.toLowerCase()).toContain('secure')
    expect(sessionCookie.toLowerCase()).toContain('samesite=lax')
    expect(sessionCookie).toContain('Path=/')
    expect(sessionCookie.toLowerCase()).not.toContain('domain=')
  })

  it('session cookie does not have Max-Age=0 (not a clear cookie)', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — the session cookie is not a clear cookie
    const setCookieHeaders = res.headers.getSetCookie()
    const sessionCookie = setCookieHeaders.find(h => h.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? ''
    expect(sessionCookie.toLowerCase()).not.toContain('max-age=0')
  })

  it('clears stale pre-auth session cookie before setting the new session cookie', async () => {
    // #given — a stale session already exists in the store
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()

    const staleSessionId = sessionStore.create({githubUserId: 99, login: 'stale'}, '', now)
    if (staleSessionId === undefined) throw new Error('expected stale session to be created')

    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when — callback with stale session cookie in request
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
      {headers: {cookie: `${SESSION_COOKIE_NAME}=${staleSessionId}`}},
    )
    const res = await app.fetch(req)

    // #then — success
    expect(res.status).toBe(302) // no return_to captured → redirect to default landing path

    // #and — stale session is revoked server-side
    expect(sessionStore.get(staleSessionId, now + 2000)).toBeUndefined()

    // #and — a clear-cookie header is emitted for the stale session
    const setCookieHeaders = res.headers.getSetCookie()
    const clearCookie = setCookieHeaders.find(
      h => h.startsWith(`${SESSION_COOKIE_NAME}=`) && h.toLowerCase().includes('max-age=0'),
    )
    expect(clearCookie).toBeDefined()

    // #and — a new session cookie is also set
    const newSessionCookie = setCookieHeaders.find(
      h => h.startsWith(`${SESSION_COOKIE_NAME}=`) && !h.toLowerCase().includes('max-age=0'),
    )
    expect(newSessionCookie).toBeDefined()
  })

  it('session cookie value is the minted session ID (retrievable from store)', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — extract session ID from cookie
    const setCookieHeaders = res.headers.getSetCookie()
    const sessionCookieHeader = setCookieHeaders.find(
      h => h.startsWith(`${SESSION_COOKIE_NAME}=`) && !h.toLowerCase().includes('max-age=0'),
    )
    if (sessionCookieHeader === undefined) throw new Error('expected session cookie to be set')

    // Parse the session ID from the cookie value
    const cookieValue = sessionCookieHeader.split(';')[0]
    if (cookieValue === undefined) throw new Error('expected cookie value')
    const sessionId = cookieValue.slice(SESSION_COOKIE_NAME.length + 1)

    // #and — the session ID is valid in the store
    const entry = sessionStore.get(sessionId, now + 2000)
    expect(entry).toBeDefined()
    expect(entry?.githubUserId).toBe(42)
    expect(entry?.login).toBe('octocat')
  })

  it('falls back to coarse JSON response when no session store is wired', async () => {
    // #given — no session store in deps
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config) // no session store

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — still returns 200 with identity JSON
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({githubUserId: 42, login: 'octocat'})

    // #and — no session cookie set
    const setCookieHeaders = res.headers.getSetCookie()
    const sessionCookie = setCookieHeaders.find(h => h.startsWith(`${SESSION_COOKIE_NAME}=`))
    expect(sessionCookie).toBeUndefined()
  })

  it('returns 503 (service unavailable) when session cap is exhausted after scavenge', async () => {
    // #given — session store at cap with all live sessions (no expired/revoked to scavenge)
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    // Create a session store stub that always returns undefined from create()
    const fullSessionStore: SessionStore = {
      create: () => undefined,
      get: () => undefined,
      touch: () => undefined,
      delete: () => undefined,
      onRevoke: () => undefined,
      scavenge: () => undefined,
      size: () => 10_000,
      getOperatorToken: () => undefined,
      dropOperatorToken: () => undefined,
    }

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, fullSessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — 503 Service Unavailable (capacity issue, not a bad request)
    expect(res.status).toBe(503)
  })

  it('503 response on session cap exhaustion includes Retry-After header', async () => {
    // #given — session store that always returns undefined from create()
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const fullSessionStore: SessionStore = {
      create: () => undefined,
      get: () => undefined,
      touch: () => undefined,
      delete: () => undefined,
      onRevoke: () => undefined,
      scavenge: () => undefined,
      size: () => 10_000,
      getOperatorToken: () => undefined,
      dropOperatorToken: () => undefined,
    }

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, fullSessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — Retry-After header is present
    expect(res.headers.get('retry-after')).toBe('60')
  })

  it('does NOT emit auth.callback.success when session cap is exhausted (503 path)', async () => {
    // #given — session store that always returns undefined from create()
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const fullSessionStore: SessionStore = {
      create: () => undefined,
      get: () => undefined,
      touch: () => undefined,
      delete: () => undefined,
      onRevoke: () => undefined,
      scavenge: () => undefined,
      size: () => 10_000,
      getOperatorToken: () => undefined,
      dropOperatorToken: () => undefined,
    }

    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
      auditLogger,
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, fullSessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — 503 (capacity issue)
    expect(res.status).toBe(503)

    // #and — auth.callback.success must NOT have been emitted
    const successEvent = auditLogger.records.find(r => r.kind === 'auth.callback.success')
    expect(successEvent).toBeUndefined()
  })

  it('stale-session revocation hook fires during OAuth callback replacement', async () => {
    // #given — a stale session with a revocation hook registered
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()

    const staleSessionId = sessionStore.create({githubUserId: 99, login: 'stale'}, '', now)
    if (staleSessionId === undefined) throw new Error('expected stale session to be created')

    // Register a revocation hook on the stale session
    const revocationHook = vi.fn()
    sessionStore.onRevoke(staleSessionId, revocationHook)

    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when — callback with stale session cookie in request
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
      {headers: {cookie: `${SESSION_COOKIE_NAME}=${staleSessionId}`}},
    )
    await app.fetch(req)

    // #then — revocation hook was called (stale session was deleted)
    expect(revocationHook).toHaveBeenCalledExactlyOnceWith(staleSessionId)
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — onSessionRevoke wiring (operator push deactivation)
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — onSessionRevoke wiring', () => {
  it('registers onSessionRevoke closed over githubUserId, fired on later session revocation', async () => {
    // #given — deps carry onSessionRevoke; a session is minted via a successful callback
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const onSessionRevoke = vi.fn()
    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 4242, login: 'pushuser'}),
      onSessionRevoke,
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when — the callback mints a session, then the session is later revoked (logout)
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)
    const setCookie = res.headers.get('set-cookie') ?? ''
    const match = /__Host-session=([^;]+)/.exec(setCookie)
    const sessionId = match?.[1]
    if (sessionId === undefined) throw new Error('expected a minted session cookie')

    expect(onSessionRevoke).not.toHaveBeenCalled()
    sessionStore.delete(sessionId)

    // #then — the hook fired with the githubUserId captured at session-creation time
    expect(onSessionRevoke).toHaveBeenCalledExactlyOnceWith(4242)
  })

  it('does not break session revocation when onSessionRevoke throws', async () => {
    // #given — onSessionRevoke is wired to a throwing callback
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const throwingOnSessionRevoke = vi.fn(() => {
      throw new Error('deactivateForOperator boom')
    })
    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 55, login: 'boomuser'}),
      onSessionRevoke: throwingOnSessionRevoke,
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)
    const setCookie = res.headers.get('set-cookie') ?? ''
    const match = /__Host-session=([^;]+)/.exec(setCookie)
    const sessionId = match?.[1]
    if (sessionId === undefined) throw new Error('expected a minted session cookie')

    // #then — delete() does not throw despite the hook throwing (session.ts swallows hook errors)
    expect(() => sessionStore.delete(sessionId)).not.toThrow()
    expect(throwingOnSessionRevoke).toHaveBeenCalledExactlyOnceWith(55)
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — OAuth token retention in session
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — OAuth token retention', () => {
  it('getOperatorToken returns the access token after a successful OAuth callback', async () => {
    // #given
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    const accessToken = 'ghs_RETAINED_TOKEN'
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat', accessToken}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)
    expect(res.status).toBe(302) // no return_to captured → redirect to default landing path

    // #then — extract session ID from cookie and verify token is retained
    const setCookieHeaders = res.headers.getSetCookie()
    const sessionCookieHeader = setCookieHeaders.find(
      h => h.startsWith(`${SESSION_COOKIE_NAME}=`) && !h.toLowerCase().includes('max-age=0'),
    )
    if (sessionCookieHeader === undefined) throw new Error('expected session cookie to be set')
    const cookieValue = sessionCookieHeader.split(';')[0]
    if (cookieValue === undefined) throw new Error('expected cookie value')
    const sessionId = cookieValue.slice(SESSION_COOKIE_NAME.length + 1)

    // #and — getOperatorToken returns the access token
    expect(sessionStore.getOperatorToken(sessionId, now + 2000)).toBe(accessToken)
  })

  it('access token is NOT present in the session cookie value', async () => {
    // #given — security: token must never appear in the cookie
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    const accessToken = 'ghs_NEVER_IN_COOKIE'
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat', accessToken}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — token is NOT in any Set-Cookie header
    const setCookieHeaders = res.headers.getSetCookie()
    for (const header of setCookieHeaders) {
      expect(header).not.toContain(accessToken)
    }
  })

  it('access token is NOT present in the response body', async () => {
    // #given — security: token must never appear in any operator-facing response
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    const accessToken = 'ghs_NEVER_IN_BODY'
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat', accessToken}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)
    const body = await res.text()

    // #then — token is NOT in the response body
    expect(body).not.toContain(accessToken)
  })

  it('access token is NOT present in any log message during the callback (no-oracle)', async () => {
    // #given — capture all logger calls
    const logMessages: string[] = []
    const capturingLogger = {
      debug: vi.fn((_ctx: Record<string, unknown>, msg: string) => {
        logMessages.push(msg)
      }),
      info: vi.fn((_ctx: Record<string, unknown>, msg: string) => {
        logMessages.push(msg)
      }),
      warn: vi.fn((_ctx: Record<string, unknown>, msg: string) => {
        logMessages.push(msg)
      }),
      error: vi.fn((_ctx: Record<string, unknown>, msg: string) => {
        logMessages.push(msg)
      }),
    }

    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    const accessToken = 'ghs_NEVERLOG_TOKEN'
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat', accessToken}),
      logger: capturingLogger,
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000, logger: capturingLogger})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    await app.fetch(req)

    // #then — token never appears in any log message
    for (const msg of logMessages) {
      expect(msg).not.toContain(accessToken)
    }
  })

  it('getOperatorToken returns undefined after logout (token dropped with session)', async () => {
    // #given — complete a successful OAuth callback
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    const accessToken = 'ghs_LOGOUT_TOKEN'
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat', accessToken}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)
    expect(res.status).toBe(302) // no return_to captured → redirect to default landing path

    // Extract session ID
    const setCookieHeaders = res.headers.getSetCookie()
    const sessionCookieHeader = setCookieHeaders.find(
      h => h.startsWith(`${SESSION_COOKIE_NAME}=`) && !h.toLowerCase().includes('max-age=0'),
    )
    if (sessionCookieHeader === undefined) throw new Error('expected session cookie to be set')
    const cookieValue = sessionCookieHeader.split(';')[0]
    if (cookieValue === undefined) throw new Error('expected cookie value')
    const sessionId = cookieValue.slice(SESSION_COOKIE_NAME.length + 1)

    // Verify token is retained
    expect(sessionStore.getOperatorToken(sessionId, now + 2000)).toBe(accessToken)

    // #when — logout (revoke the session)
    sessionStore.delete(sessionId)

    // #then — token is gone
    expect(sessionStore.getOperatorToken(sessionId, now + 3000)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — return_to redirect on session-minted success path
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — return_to redirect after session mint', () => {
  it('redirects to allowlisted return_to path (302) with Set-Cookie on session-minted success', async () => {
    // #given — state has a redirectTarget that is in the allowlist
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      redirectTarget: '/operator/dashboard',
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig() // allowedReturnPaths includes '/operator/dashboard'
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — 302 redirect to the validated return path
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/dashboard')

    // #and — session cookie is still set on the redirect response
    const setCookieHeaders = res.headers.getSetCookie()
    const sessionCookie = setCookieHeaders.find(h => h.startsWith(`${SESSION_COOKIE_NAME}=`))
    expect(sessionCookie).toBeDefined()

    // #and — session was minted in the store
    expect(sessionStore.size()).toBe(1)
  })

  it('redirects (302) to the default landing path when state has no redirectTarget (no return_to)', async () => {
    // #given — state has no redirectTarget (e.g. /operator/auth/github/start opened directly)
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      // no redirectTarget
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig() // allowedReturnPaths: ['/operator/dashboard', '/operator/runs']
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — redirected to the first allowed return path, not a bare JSON identity page
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/dashboard')

    // #and — session cookie is still set on the redirect
    const setCookieHeaders = res.headers.getSetCookie()
    const sessionCookie = setCookieHeaders.find(h => h.startsWith(`${SESSION_COOKIE_NAME}=`))
    expect(sessionCookie).toBeDefined()
  })

  it('a captured return_to wins over the default landing path', async () => {
    // #given — captured target is the SECOND allowed path, so it differs from the default (first entry)
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      redirectTarget: '/operator/runs',
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig() // default (first entry) is '/operator/dashboard'
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const res = await app.fetch(
      new Request(
        'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
      ),
    )

    // #then — the captured path, not the default
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/runs')
  })

  it.each([
    ['an absolute URL', ['https://evil.attacker.com/steal', '/operator']],
    ['a protocol-relative URL', ['//evil.attacker.com/steal', '/operator']],
    ['a non-rooted path', ['operator', '/operator']],
  ])(
    'never redirects to a misconfigured default landing path that is %s (falls back to identity JSON)',
    async (_label, allowedReturnPaths) => {
      // #given — the FIRST allowedReturnPaths entry (the default) is unsafe, even though it is "in the list"
      const stateStore = createInMemoryStateStore()
      const sessionStore = createInMemorySessionStore()
      const now = Date.now()
      stateStore.set('valid-state-value', {
        codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
        issuedAt: now,
        consumed: false,
      })

      const deps = makeStubDeps({
        stateStore,
        clock: () => now + 1000,
        fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
      })
      const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
      const config = makeStubConfig({allowedReturnPaths})
      const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

      // #when
      const res = await app.fetch(
        new Request(
          'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
        ),
      )

      // #then — no redirect at all (no open redirect); coarse identity JSON, session still minted
      expect(res.status).toBe(200)
      expect(res.headers.get('location')).toBeNull()
      expect(await res.json()).toMatchObject({githubUserId: 42, login: 'octocat'})
      expect(sessionStore.size()).toBe(1)
    },
  )

  it('falls back to identity JSON (no redirect) when allowedReturnPaths is empty', async () => {
    // #given — nothing to validate a default against
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig({allowedReturnPaths: []})
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const res = await app.fetch(
      new Request(
        'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
      ),
    )

    // #then
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.json()).toMatchObject({githubUserId: 42, login: 'octocat'})
  })

  it('end-to-end: /start with no return_to then /callback lands on the default path', async () => {
    // #given — real start handler mints the state (no return_to), real callback consumes it
    const sessionStore = createInMemorySessionStore()
    const deps = makeStubDeps({fetch: makeSuccessFetch({userId: 42, login: 'octocat'})})
    const sessionDeps = makeStubSessionDeps()
    const app = buildTestAppWithSession(deps, makeStubConfig(), sessionStore, sessionDeps)
    const state = await mintState(app)

    // #when
    const res = await app.fetch(
      new Request(`https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=${state}`),
    )

    // #then
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/dashboard')
  })

  it('redirects to the default landing path when redirectTarget is NOT in allowedReturnPaths (security: no unvalidated redirect)', async () => {
    // #given — state has a redirectTarget that is NOT in the allowlist
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      redirectTarget: '/some/unlisted/path',
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig() // allowedReturnPaths: ['/operator/dashboard', '/operator/runs']
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — MUST NOT redirect to the unlisted path; lands on the validated default (security-critical assertion)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/dashboard')

    // #and — session was still minted (allowlist failure only affects redirect, not session)
    expect(sessionStore.size()).toBe(1)
  })

  it('redirects to the default landing path when redirectTarget is an absolute URL (cross-origin attempt)', async () => {
    // #given — state has an absolute URL as redirectTarget (should be rejected by validateReturnPath)
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      redirectTarget: 'https://evil.attacker.com/steal',
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — MUST NOT redirect to the cross-origin URL; lands on the validated default instead
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator/dashboard')

    // #and — session was still minted
    expect(sessionStore.size()).toBe(1)
  })

  it('no-session-store path still returns 200 JSON regardless of redirectTarget', async () => {
    // #given — no session store wired; state has a redirectTarget
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      redirectTarget: '/operator/dashboard',
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config) // no session store

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — no-session path is unchanged: always 200 JSON
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({githubUserId: 42, login: 'octocat'})
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — allowlist check before session creation (Fix 2)
// ---------------------------------------------------------------------------

function buildTestAppWithSessionAndAllowlist(
  deps: GitHubOAuthDeps,
  config: GitHubOAuthConfig,
  sessionStore: SessionStore,
  sessionDeps: SessionDeps,
  allowlist: import('./allowlist.js').OperatorAllowlist,
): Hono {
  const app = new Hono()
  registerPublicRoute(app, 'GET', '/operator/health', c => c.json({ok: true}))
  buildGitHubOAuthRoutes(app, {...deps, sessionStore, sessionDeps, allowlist}, config)
  assertAllPrivilegedRoutesWrapped(app)
  return app
}

describe('GET /operator/auth/github/callback — allowlist check before session creation', () => {
  it('returns 403 and does not mint a session when user is not in allowlist', async () => {
    // #given — allowlist only contains user 99, callback returns user 42
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const allowlist: import('./allowlist.js').OperatorAllowlist = {
      isAuthorized: (id: number) => id === 99, // only user 99 is allowed
      size: 1,
    }

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}), // user 42 is NOT in allowlist
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSessionAndAllowlist(deps, config, sessionStore, sessionDeps, allowlist)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — 403 Forbidden (not allowlisted)
    expect(res.status).toBe(403)

    // #and — no session was created
    expect(sessionStore.size()).toBe(0)
  })

  it('does not set a session cookie when user is not in allowlist', async () => {
    // #given — allowlist only contains user 99, callback returns user 42
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const allowlist: import('./allowlist.js').OperatorAllowlist = {
      isAuthorized: (id: number) => id === 99,
      size: 1,
    }

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSessionAndAllowlist(deps, config, sessionStore, sessionDeps, allowlist)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — no session cookie in response
    const setCookieHeaders = res.headers.getSetCookie()
    const sessionCookie = setCookieHeaders.find(h => h.startsWith(`${SESSION_COOKIE_NAME}=`))
    expect(sessionCookie).toBeUndefined()
  })

  it('emits auth.callback.failure with reason not_allowlisted when user is not in allowlist', async () => {
    // #given — allowlist only contains user 99, callback returns user 42
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const allowlist: import('./allowlist.js').OperatorAllowlist = {
      isAuthorized: (id: number) => id === 99,
      size: 1,
    }

    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
      auditLogger,
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSessionAndAllowlist(deps, config, sessionStore, sessionDeps, allowlist)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    await app.fetch(req)

    // #then — audit event emitted with reason not_allowlisted
    const failureRecord = auditLogger.records.find(r => r.kind === 'auth.callback.failure')
    expect(failureRecord).toBeDefined()
    expect(failureRecord?.reason).toBe('not_allowlisted')
  })

  it('allows session creation when user IS in allowlist', async () => {
    // #given — allowlist contains user 42, callback returns user 42
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })

    const allowlist: import('./allowlist.js').OperatorAllowlist = {
      isAuthorized: (id: number) => id === 42, // user 42 is allowed
      size: 1,
    }

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig()
    const app = buildTestAppWithSessionAndAllowlist(deps, config, sessionStore, sessionDeps, allowlist)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — redirected (default landing path), session created
    expect(res.status).toBe(302) // no return_to captured → redirect to default landing path
    expect(sessionStore.size()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// validateReturnPath — unit tests (backslash / control-char / cross-origin hardening)
// ---------------------------------------------------------------------------

describe('validateReturnPath', () => {
  const origin = 'https://operator.example.com'
  const allowed = [
    '/operator',
    '/operator/runs',
    String.raw`/\evil.example/landing`,
    String.raw`/operator\runs`,
    '/operator\n',
    '/operator\t',
    '/operator\u0000',
    '/operator\u007F',
    '/operator x',
    '/operator\u00A0x',
    '/%5Cevil',
    '//evil.example',
    'https://evil.example/x',
  ]

  it.each([['/operator'], ['/operator/runs']])('accepts ordinary allowlisted path %s', path => {
    // #given an ordinary allowlisted path
    // #when validated
    const result = validateReturnPath(path, allowed, origin)

    // #then it is returned unchanged
    expect(result).toBe(path)
  })

  it.each([
    ['a leading backslash (host-relative form)', String.raw`/\evil.example/landing`],
    ['an embedded backslash', String.raw`/operator\runs`],
    ['a trailing newline', '/operator\n'],
    ['a trailing tab', '/operator\t'],
    ['a NUL byte', '/operator\u0000'],
    ['DEL', '/operator\u007F'],
    ['an ASCII space', '/operator x'],
    ['a non-breaking space', '/operator\u00A0x'],
  ])('rejects %s even when the exact string is allowlisted', (_label, candidate) => {
    // #given the candidate is literally present in the allowlist
    expect(allowed).toContain(candidate)

    // #when validated
    const result = validateReturnPath(candidate, allowed, origin)

    // #then the character screen rejects it
    expect(result).toBeNull()
  })

  it('accepts a percent-encoded backslash because URL parsing never decodes it into a separator', () => {
    // #given /%5Cevil is allowlisted
    // #when validated
    const result = validateReturnPath('/%5Cevil', allowed, origin)

    // #then it is accepted, and a browser resolves it to the same origin
    expect(result).toBe('/%5Cevil')
    expect(new URL('/%5Cevil', origin).origin).toBe(origin)
  })

  it.each([['//evil.example'], ['https://evil.example/x']])('rejects %s (protocol-relative / absolute URL)', path => {
    // #given the candidate is allowlisted
    // #when validated
    const result = validateReturnPath(path, allowed, origin)

    // #then it is rejected
    expect(result).toBeNull()
  })

  it('rejects an unparseable public origin (fail closed)', () => {
    // #given a broken origin
    // #when validated
    const result = validateReturnPath('/operator', allowed, 'not a url')

    // #then
    expect(result).toBeNull()
  })

  it('rejects a path whose resolved form is not itself allowlisted (dot-segment escape)', () => {
    // #given /operator/../admin is allowlisted but resolves to /admin
    const result = validateReturnPath('/operator/../admin', ['/operator/../admin'], origin)

    // #then
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — unsafe backslash target must never become a redirect
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — backslash open-redirect hardening', () => {
  const evilPath = String.raw`/\evil.example/landing`

  it('falls back to identity JSON (no Location) when the first allowed default is a backslash path', async () => {
    // #given — the default (first entry) is /\evil.example/landing, no return_to captured
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })
    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig({allowedReturnPaths: [evilPath, '/operator']})
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const res = await app.fetch(
      new Request(
        'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
      ),
    )

    // #then — 200 identity JSON, no redirect, session still minted once, warning logged
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.json()).toMatchObject({githubUserId: 42, login: 'octocat'})
    expect(sessionStore.size()).toBe(1)
    expect(sessionDeps.logger.warn).toHaveBeenCalledWith({}, expect.stringContaining('no valid default landing path'))
  })

  it('rejects an explicit allowlisted backslash return_to and lands on the default /operator', async () => {
    // #given — captured redirectTarget is the (allowlisted) backslash path; default is /operator
    const stateStore = createInMemoryStateStore()
    const sessionStore = createInMemorySessionStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      redirectTarget: evilPath,
    })
    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      fetch: makeSuccessFetch({userId: 42, login: 'octocat'}),
    })
    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const config = makeStubConfig({allowedReturnPaths: ['/operator', evilPath]})
    const app = buildTestAppWithSession(deps, config, sessionStore, sessionDeps)

    // #when
    const res = await app.fetch(
      new Request(
        'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
      ),
    )

    // #then — redirected to the safe default, never to the backslash target
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/operator')
    expect(sessionStore.size()).toBe(1)
  })

  it('rejects an explicit backslash return_to at /start (400, no state minted)', async () => {
    // #given — the backslash path is allowlisted
    const stateStore = createInMemoryStateStore()
    const deps = makeStubDeps({stateStore})
    const config = makeStubConfig({allowedReturnPaths: ['/operator', evilPath]})
    const app = buildTestApp(deps, config)

    // #when
    const res = await app.fetch(
      new Request(`https://operator.example.com/operator/auth/github/start?return_to=${encodeURIComponent(evilPath)}`),
    )

    // #then
    expect(res.status).toBe(400)
    expect(stateStore.get(DEFAULT_TEST_STATE)).toBeUndefined()
  })
})
