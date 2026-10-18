/**
 * Tests for the GET /operator/session route.
 *
 * Covers:
 *   - Happy path: valid session → 200 with operatorId, login, expiresAt.
 *   - Expiry: fixed at issuedAt + the durable lifetime, whatever the clock reads and however often the session is used.
 *   - Error path: store.get returns undefined (expired/revoked/missing) → coarse 401.
 *   - Error path: getOperatorAuthContext undefined (guard not installed) → 401.
 *   - Headers: Cache-Control: no-store, private and Vary header set on 200.
 *
 * Uses BDD comments (#given, #when, #then).
 * Mirrors the structure of csrf-route tests and session.test.ts.
 */

import type {PushHealthStatus} from '../operator-push/push-health.js'
import type {BrowserGuardDeps} from './csrf.js'
import type {DurableSession} from './session.js'

import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {setOperatorRouteGuard} from '../operator-route.js'
import {loadAllowlistFromText} from './allowlist.js'
import {applyBrowserGuard} from './csrf.js'
import {buildSessionInfoRoute} from './session-info-route.js'
import {DURABLE_SESSION_TTL_MS, SESSION_COOKIE_NAME} from './session.js'
import {createTestSessionStore, mintTestSession} from './test-session-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeStubSessionStore(entry?: DurableSession): BrowserGuardDeps['sessionStore'] {
  return {get: vi.fn((_sessionId: string) => entry)}
}

function makeStubBrowserGuardDeps(overrides?: Partial<BrowserGuardDeps>): BrowserGuardDeps {
  const logger = makeLogger()
  return {
    logger,
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    sessionStore: makeStubSessionStore(),
    allowlist: loadAllowlistFromText('12345', logger),
    csrfSecret: 'stub-csrf-secret-base64url-32bytes-ok',
    publicOrigin: 'https://operator.example.com',
    clock: () => 1_000_000,
    ...overrides,
  }
}

/**
 * Build a minimal Hono test app with a stub guard that sets the auth context,
 * then registers the session-info route.
 *
 * When guardInstalled=false, no guard is installed (simulates guard-not-installed path).
 */
function buildTestApp(
  deps: BrowserGuardDeps,
  opts?: {
    guardInstalled?: boolean
    sessionId?: string
    githubUserId?: number
    getPushHealth?: () => PushHealthStatus
  },
): Hono {
  const app = new Hono()
  const guardInstalled = opts?.guardInstalled !== false
  const sessionId = opts?.sessionId ?? 'stub-session-id'
  const githubUserId = opts?.githubUserId ?? 12345

  if (guardInstalled) {
    setOperatorRouteGuard(app, async (_c, _method, _path) => {
      return {ok: true, githubUserId, sessionId}
    })
  }

  buildSessionInfoRoute(app, deps, opts?.getPushHealth)
  return app
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('buildSessionInfoRoute — happy path', () => {
  it('returns 200 with operatorId, login, and expiresAt for a valid session', async () => {
    // #given
    const nowMs = 1_000_000
    const issuedAt = nowMs - 1000

    const entry: DurableSession = {
      githubUserId: 42,
      login: 'octocat',
      issuedAt,
    }

    const sessionStore = makeStubSessionStore(entry)
    const deps = makeStubBrowserGuardDeps({
      sessionStore,
      clock: () => nowMs,
    })
    const app = buildTestApp(deps, {githubUserId: 42, sessionId: 'test-session-id'})

    // #when
    const req = new Request('http://localhost/operator/session', {method: 'GET'})
    const res = await app.fetch(req)

    // #then
    expect(res.status).toBe(200)
    const body = (await res.json()) as {operatorId: number; login: string; expiresAt: number}
    expect(body.operatorId).toBe(42)
    expect(body.login).toBe('octocat')

    // expiresAt = issuedAt + the durable lifetime
    expect(body.expiresAt).toBe(issuedAt + DURABLE_SESSION_TTL_MS)
  })
})

// ---------------------------------------------------------------------------
// Expiry — fixed from login
// ---------------------------------------------------------------------------

async function fetchExpiresAt(issuedAt: number, nowMs: number): Promise<number> {
  const deps = makeStubBrowserGuardDeps({
    sessionStore: makeStubSessionStore({githubUserId: 42, login: 'octocat', issuedAt}),
    clock: () => nowMs,
  })
  const app = buildTestApp(deps, {githubUserId: 42})
  const res = await app.fetch(new Request('http://localhost/operator/session', {method: 'GET'}))
  expect(res.status).toBe(200)
  return ((await res.json()) as {expiresAt: number}).expiresAt
}

describe('buildSessionInfoRoute — fixed expiry', () => {
  it('equals issuedAt plus 7 days whatever the clock reads', async () => {
    // #given a session issued at a fixed time
    const issuedAt = 10_000_000

    // #when the route runs at the start, mid-life and near the end of the lifetime
    const expiries = await Promise.all(
      [issuedAt, issuedAt + 3 * 24 * 60 * 60 * 1000, issuedAt + DURABLE_SESSION_TTL_MS - 1].map(async nowMs =>
        fetchExpiresAt(issuedAt, nowMs),
      ),
    )

    // #then every reading is the same fixed expiry
    expect(DURABLE_SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(expiries).toEqual([
      issuedAt + DURABLE_SESSION_TTL_MS,
      issuedAt + DURABLE_SESSION_TTL_MS,
      issuedAt + DURABLE_SESSION_TTL_MS,
    ])
  })
})

// ---------------------------------------------------------------------------
// Error path — store.get returns undefined
// ---------------------------------------------------------------------------

describe('buildSessionInfoRoute — store.get returns undefined', () => {
  it('returns coarse 401 with {error: "unauthorized"} when session is expired/revoked/missing', async () => {
    // #given — store.get returns undefined (raced revocation/expiry)
    const sessionStore = makeStubSessionStore(undefined)
    const deps = makeStubBrowserGuardDeps({sessionStore})
    const app = buildTestApp(deps)

    // #when
    const req = new Request('http://localhost/operator/session', {method: 'GET'})
    const res = await app.fetch(req)

    // #then
    expect(res.status).toBe(401)
    const body = (await res.json()) as {error: string}
    expect(body).toEqual({error: 'unauthorized'})
  })

  it('returns the same coarse 401 body as the guard-not-installed case (no detail leak)', async () => {
    // #given — two apps: one with missing session, one with guard not installed
    const sessionStore = makeStubSessionStore(undefined)
    const deps = makeStubBrowserGuardDeps({sessionStore})
    const appMissingSession = buildTestApp(deps)
    const appNoGuard = buildTestApp(deps, {guardInstalled: false})

    // #when
    const req1 = new Request('http://localhost/operator/session', {method: 'GET'})
    const req2 = new Request('http://localhost/operator/session', {method: 'GET'})
    const [res1, res2] = await Promise.all([appMissingSession.fetch(req1), appNoGuard.fetch(req2)])

    // #then — both return 401 with identical body
    expect(res1.status).toBe(401)
    expect(res2.status).toBe(401)
    const [body1, body2] = await Promise.all([res1.json(), res2.json()])
    expect(body1).toEqual({error: 'unauthorized'})
    expect(body2).toEqual({error: 'unauthorized'})
    expect(body1).toEqual(body2)
  })
})

// ---------------------------------------------------------------------------
// Error path — guard not installed
// ---------------------------------------------------------------------------

describe('buildSessionInfoRoute — guard not installed', () => {
  it('returns 401 when getOperatorAuthContext returns undefined (guard not installed)', async () => {
    // #given — no guard installed on the app
    const deps = makeStubBrowserGuardDeps()
    const app = buildTestApp(deps, {guardInstalled: false})

    // #when
    const req = new Request('http://localhost/operator/session', {method: 'GET'})
    const res = await app.fetch(req)

    // #then
    expect(res.status).toBe(401)
    const body = (await res.json()) as {error: string}
    expect(body).toEqual({error: 'unauthorized'})
  })
})

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe('buildSessionInfoRoute — response headers', () => {
  it('sets Cache-Control: no-store, private on a 200 response', async () => {
    // #given
    const nowMs = 2_000_000
    const entry: DurableSession = {
      githubUserId: 1,
      login: 'headeruser',
      issuedAt: nowMs - 1000,
    }
    const sessionStore = makeStubSessionStore(entry)
    const deps = makeStubBrowserGuardDeps({sessionStore, clock: () => nowMs})
    const app = buildTestApp(deps)

    // #when
    const req = new Request('http://localhost/operator/session', {method: 'GET'})
    const res = await app.fetch(req)

    // #then
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store, private')
  })

  it('sets Vary: Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest on a 200 response', async () => {
    // #given
    const nowMs = 2_000_000
    const entry: DurableSession = {
      githubUserId: 1,
      login: 'varyuser',
      issuedAt: nowMs - 1000,
    }
    const sessionStore = makeStubSessionStore(entry)
    const deps = makeStubBrowserGuardDeps({sessionStore, clock: () => nowMs})
    const app = buildTestApp(deps)

    // #when
    const req = new Request('http://localhost/operator/session', {method: 'GET'})
    const res = await app.fetch(req)

    // #then
    expect(res.status).toBe(200)
    expect(res.headers.get('Vary')).toBe('Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest')
  })
})

// ---------------------------------------------------------------------------
// Integration — real durable session store + real browser guard
// ---------------------------------------------------------------------------

describe('buildSessionInfoRoute — integration: real guard and durable store', () => {
  it('expiresAt stays at issuedAt + 7 days however often the session is used', async () => {
    // #given — a real durable session issued at a controlled time
    const issuedAt = 5_000_000
    const clock = {now: issuedAt}
    const sessionStore = await createTestSessionStore({clock: () => clock.now})
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const browserGuardDeps: BrowserGuardDeps = {
      logger,
      auditLogger: {info: vi.fn(), warn: vi.fn()},
      sessionStore,
      allowlist: loadAllowlistFromText('42\n', logger),
      csrfSecret: 'stub-csrf-secret-base64url-32bytes-ok',
      publicOrigin: 'https://operator.example.com',
      clock: () => clock.now,
    }

    // Real Hono app with the REAL browser guard installed exactly as server.ts does
    const app = new Hono()
    const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
    setOperatorRouteGuard(app, async (c, method, _path) => {
      const requireCsrf = SAFE_METHODS.has(method.toUpperCase()) === false
      return applyBrowserGuard(c, browserGuardDeps, false, requireCsrf)
    })
    buildSessionInfoRoute(app, browserGuardDeps)

    const request = async (): Promise<Response> =>
      app.fetch(
        new Request('https://operator.example.com/operator/session', {
          method: 'GET',
          headers: {cookie: `${SESSION_COOKIE_NAME}=${sessionId}`, origin: 'https://operator.example.com'},
        }),
      )

    // #when — the session is used at login, on day 3 and on day 6
    const readings: number[] = []
    for (const offsetDays of [0, 3, 6]) {
      clock.now = issuedAt + offsetDays * 24 * 60 * 60 * 1000
      const res = await request()
      expect(res.status).toBe(200)
      const body = (await res.json()) as {operatorId: number; login: string; expiresAt: number}
      expect(body.operatorId).toBe(42)
      expect(body.login).toBe('octocat')
      readings.push(body.expiresAt)
    }

    // #then — no request moved the expiry
    expect(readings).toEqual([
      issuedAt + DURABLE_SESSION_TTL_MS,
      issuedAt + DURABLE_SESSION_TTL_MS,
      issuedAt + DURABLE_SESSION_TTL_MS,
    ])
  })
})

// ---------------------------------------------------------------------------
// Push health (authenticated-only, optional)
// ---------------------------------------------------------------------------

describe('buildSessionInfoRoute — push health', () => {
  const nowMs = 1_000_000
  const entry: DurableSession = {
    githubUserId: 42,
    login: 'octocat',
    issuedAt: nowMs - 1000,
  }

  async function fetchSession(getPushHealth?: () => PushHealthStatus): Promise<Record<string, unknown>> {
    const deps = makeStubBrowserGuardDeps({sessionStore: makeStubSessionStore(entry), clock: () => nowMs})
    const app = buildTestApp(deps, {githubUserId: 42, getPushHealth})
    const res = await app.fetch(new Request('http://localhost/operator/session', {method: 'GET'}))
    expect(res.status).toBe(200)
    return (await res.json()) as Record<string, unknown>
  }

  it.each(['ready', 'degraded', 'unknown'] as const)(
    'includes exactly {status: %s} and nothing else under push',
    async status => {
      // #given push is configured and reports a status
      // #when
      const body = await fetchSession(() => status)

      // #then the allowlist: only push.status, no counts/timestamps/ids
      expect(Object.keys(body).sort()).toEqual(['expiresAt', 'login', 'operatorId', 'push'])
      expect(body.push).toEqual({status})
      expect(Object.keys(body.push as object)).toEqual(['status'])
    },
  )

  it('omits push entirely when no push health reader is supplied (push unconfigured)', async () => {
    // #when
    const body = await fetchSession(undefined)

    // #then the response is byte-identical to the pre-push shape
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'login', 'operatorId'])
    expect('push' in body).toBe(false)
  })

  it('omits push when the tracker reports disabled', async () => {
    // #when
    const body = await fetchSession(() => 'disabled')

    // #then
    expect('push' in body).toBe(false)
  })

  it('reads the status per request (not cached at registration)', async () => {
    // #given a status that changes between requests
    let status: PushHealthStatus = 'ready'
    const deps = makeStubBrowserGuardDeps({sessionStore: makeStubSessionStore(entry), clock: () => nowMs})
    const app = buildTestApp(deps, {githubUserId: 42, getPushHealth: () => status})

    // #when
    const first = (await (await app.fetch(new Request('http://localhost/operator/session'))).json()) as {
      push?: {status: string}
    }
    status = 'degraded'
    const second = (await (await app.fetch(new Request('http://localhost/operator/session'))).json()) as {
      push?: {status: string}
    }

    // #then
    expect(first.push?.status).toBe('ready')
    expect(second.push?.status).toBe('degraded')
  })

  it('does not consult the push health reader on the unauthenticated 401 path', async () => {
    // #given an expired/missing session entry
    const getPushHealth = vi.fn((): PushHealthStatus => 'degraded')
    const deps = makeStubBrowserGuardDeps({sessionStore: makeStubSessionStore(undefined), clock: () => nowMs})
    const app = buildTestApp(deps, {getPushHealth})

    // #when
    const res = await app.fetch(new Request('http://localhost/operator/session'))

    // #then
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({error: 'unauthorized'})
    expect(getPushHealth).not.toHaveBeenCalled()
  })
})
