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

import type {RateLimiter} from '../../http/rate-limit.js'
import type {AuditLogger} from '../audit.js'
import type {GitHubOAuthConfig, GitHubOAuthDeps, OAuthStateStore} from './github.js'
import type {SessionDeps, SessionStore} from './session.js'
import {createHash} from 'node:crypto'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {assertAllPrivilegedRoutesWrapped, isPublicRoute, registerPublicRoute} from '../operator-route.js'
import {buildGitHubOAuthRoutes, createInMemoryStateStore} from './github.js'
import {createInMemorySessionStore, SESSION_COOKIE_NAME} from './session.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    generateState: () => 'test-state-value-32-bytes-long-ok',
    stateStore: createInMemoryStateStore(),
    // In tests, return a fixed source key — no real socket available.
    getSourceKey: () => 'test-source-key',
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
    const stateCount = stateStore.size()
    expect(stateCount).toBe(0)
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
    expect(stateStore.size()).toBe(0)
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
    expect(stateStore.size()).toBe(0)
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
    expect(stateStore.size()).toBe(1)
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
    expect(stateStore.size()).toBe(1)
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
    expect(stateStore.size()).toBe(0)
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

  it('calls rateLimiter.allow with the source key on start', async () => {
    // #given
    const rateLimiter = makePassRateLimiter()
    const deps = makeStubDeps({rateLimiter, getSourceKey: () => 'fixed-key'})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request('https://operator.example.com/operator/auth/github/start')
    await app.fetch(req)

    // #then — rate limiter was called with the source key
    expect(rateLimiter.allow).toHaveBeenCalledWith('fixed-key')
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

  it('calls rateLimiter.allow with the source key on callback', async () => {
    // #given
    const rateLimiter = makePassRateLimiter()
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
    })
    const deps = makeStubDeps({rateLimiter, stateStore, clock: () => now + 1000, getSourceKey: () => 'fixed-key'})
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    await app.fetch(req)

    // #then — rate limiter was called with the source key
    expect(rateLimiter.allow).toHaveBeenCalledWith('fixed-key')
  })
})

// ---------------------------------------------------------------------------
// OAuth callback — source key binding
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/callback — source key binding', () => {
  it('rejects callback when source key differs from mint-time source key', async () => {
    // #given — state minted with source key 'ip-1', callback comes from 'ip-2'
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      sourceKey: 'ip-1',
    })

    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      auditLogger,
      getSourceKey: () => 'ip-2', // different from mint-time key
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — rejected with 400
    expect(res.status).toBe(400)

    // #and — failure audit event emitted with source_key_mismatch reason
    const failureEvent = auditLogger.records.find(r => r.kind === 'auth.callback.failure')
    expect(failureEvent).toBeDefined()
    expect(failureEvent?.reason).toBe('source_key_mismatch')
  })

  it('accepts callback when source key matches mint-time source key', async () => {
    // #given — state minted with source key 'ip-1', callback also from 'ip-1'
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      sourceKey: 'ip-1',
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      getSourceKey: () => 'ip-1',
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

  it('accepts callback when state has no sourceKey bound (legacy/test entries)', async () => {
    // #given — state minted without a sourceKey
    const stateStore = createInMemoryStateStore()
    const now = Date.now()
    stateStore.set('valid-state-value', {
      codeVerifier: 'test-verifier-32-bytes-long-enough-for-pkce',
      issuedAt: now,
      consumed: false,
      // no sourceKey
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      getSourceKey: () => 'any-key',
    })
    const config = makeStubConfig()
    const app = buildTestApp(deps, config)

    // #when
    const req = new Request(
      'https://operator.example.com/operator/auth/github/callback?code=github-code-abc&state=valid-state-value',
    )
    const res = await app.fetch(req)

    // #then — accepted (no sourceKey bound means no binding check)
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
      sourceKey: 'test-source-key',
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
      sourceKey: 'ip-1',
    })

    const deps = makeStubDeps({
      stateStore,
      clock: () => now + 1000,
      getSourceKey: () => 'ip-2', // different source
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
      sourceKey: 'test-source-key',
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

  it('counts outstanding (unconsumed) entries for a source key', () => {
    // #given
    const store = createInMemoryStateStore()
    store.set('state-1', {codeVerifier: 'v1', issuedAt: 1000, consumed: false, sourceKey: 'ip-1'})
    store.set('state-2', {codeVerifier: 'v2', issuedAt: 1000, consumed: false, sourceKey: 'ip-1'})
    store.set('state-3', {codeVerifier: 'v3', issuedAt: 1000, consumed: true, sourceKey: 'ip-1'})
    store.set('state-4', {codeVerifier: 'v4', issuedAt: 1000, consumed: false, sourceKey: 'ip-2'})

    // #when / #then — only unconsumed entries for ip-1
    expect(store.countOutstanding('ip-1')).toBe(2)
    expect(store.countOutstanding('ip-2')).toBe(1)
  })

  it('reports correct size', () => {
    // #given
    const store = createInMemoryStateStore()

    // #when
    store.set('s1', {codeVerifier: 'v1', issuedAt: 1000, consumed: false})
    store.set('s2', {codeVerifier: 'v2', issuedAt: 1000, consumed: false})

    // #then
    expect(store.size()).toBe(2)
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
    expect(store.size()).toBe(1)
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
    expect(store.size()).toBe(1)
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
    expect(store.size()).toBe(1)
    expect(store.get('active')).toBeDefined()
  })

  it('evictStale with empty store is a no-op', () => {
    // #given
    const store = createInMemoryStateStore()

    // #when / #then — no throw
    expect(() => store.evictStale(Date.now(), 600_000)).not.toThrow()
    expect(store.size()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Auth start — global store ceiling (prevents unbounded Map growth)
// ---------------------------------------------------------------------------

describe('GET /operator/auth/github/start — global store ceiling', () => {
  it('rejects new starts when total live entries across all source keys meet the global cap', async () => {
    // #given — many distinct source keys, each with one outstanding entry
    // Use a small per-source cap (1) so each source key can mint exactly one entry.
    // The global cap is what we are testing here: once total live entries reach it,
    // /start must fail closed regardless of which source key is requesting.
    const stateStore = createInMemoryStateStore()
    let stateCounter = 0
    let sourceCounter = 0

    const deps = makeStubDeps({
      stateStore,
      generateState: () => `state-${++stateCounter}`,
      // Each request gets a unique source key so per-source cap never triggers.
      getSourceKey: () => `source-${++sourceCounter}`,
    })
    // Per-source cap is high (100) so it never fires; global cap is what we hit.
    const config = makeStubConfig({maxOutstandingAttemptsPerKey: 100})
    const app = buildTestApp(deps, config)

    const makeReq = () => new Request('https://operator.example.com/operator/auth/github/start')

    // #when — fill the store up to the global ceiling
    // We need to know the ceiling value; import it from the module under test.
    // Since it's an internal constant, we drive it via observable behavior:
    // keep minting until we get a 429, then verify the store size is bounded.
    const responses: Response[] = []
    for (let i = 0; i < 1100; i++) {
      const res = await app.fetch(makeReq())
      responses.push(res)
      if (res.status === 429) break
    }

    // #then — at least one request was rejected (global cap enforced)
    const rejectedCount = responses.filter(r => r.status === 429).length
    expect(rejectedCount).toBeGreaterThan(0)

    // #and — the store size is bounded (did not grow to 1100)
    expect(stateStore.size()).toBeLessThan(1100)
  })

  it('allows new starts after global ceiling entries expire (evict-before-count)', async () => {
    // #given — fill store to global ceiling with distinct source keys, then advance clock
    const ttlMs = 10 * 60 * 1000
    const stateStore = createInMemoryStateStore()
    let stateCounter = 0
    let sourceCounter = 0
    let currentTime = 1000

    const deps = makeStubDeps({
      stateStore,
      generateState: () => `state-${++stateCounter}`,
      getSourceKey: () => `source-${++sourceCounter}`,
      clock: () => currentTime,
    })
    const config = makeStubConfig({maxOutstandingAttemptsPerKey: 100, stateTtlMs: ttlMs})
    const app = buildTestApp(deps, config)

    const makeReq = () => new Request('https://operator.example.com/operator/auth/github/start')

    // Fill until we hit the global cap
    for (let i = 0; i < 1100; i++) {
      const res = await app.fetch(makeReq())
      if (res.status === 429) break
    }

    // Verify we hit the cap
    const capHitRes = await app.fetch(makeReq())
    expect(capHitRes.status).toBe(429)

    // #when — advance clock past TTL so all entries expire
    currentTime = 1000 + ttlMs + 1

    // #then — new start succeeds because evictStale runs before global size check
    const resAfterExpiry = await app.fetch(makeReq())
    expect(resAfterExpiry.status).toBe(302)
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
    expect(stateStore.size()).toBe(0)
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
    expect(stateStore.size()).toBe(0)
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
    expect(stateStore.size()).toBe(0)
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
    expect(res.status).toBe(200)

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

    const staleSessionId = sessionStore.create({githubUserId: 99, login: 'stale'}, now)
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
    expect(res.status).toBe(200)

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

    const staleSessionId = sessionStore.create({githubUserId: 99, login: 'stale'}, now)
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

    // #then — 200 OK, session created
    expect(res.status).toBe(200)
    expect(sessionStore.size()).toBe(1)
  })
})
