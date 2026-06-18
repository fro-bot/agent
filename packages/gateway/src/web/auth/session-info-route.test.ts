/**
 * Tests for the GET /operator/session route.
 *
 * Covers:
 *   - Happy path: valid session → 200 with operatorId, login, expiresAt.
 *   - Expiry math: min(absolute, idle) — both idle-bound and absolute-bound cases.
 *   - Error path: store.get returns undefined (expired/revoked/missing) → coarse 401.
 *   - Error path: getOperatorAuthContext undefined (guard not installed) → 401.
 *   - Headers: Cache-Control: no-store, private and Vary header set on 200.
 *
 * Uses BDD comments (#given, #when, #then).
 * Mirrors the structure of csrf-route tests and session.test.ts.
 */

import type {BrowserGuardDeps} from './csrf.js'
import type {SessionEntry, SessionStore} from './session.js'

import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {setOperatorRouteGuard} from '../operator-route.js'
import {loadAllowlistFromText} from './allowlist.js'
import {buildSessionInfoRoute} from './session-info-route.js'
import {SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS} from './session.js'

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

function makeStubSessionStore(entry?: Readonly<SessionEntry>): SessionStore {
  return {
    create: vi.fn(() => 'stub-session-id'),
    get: vi.fn((_sessionId: string, _nowMs: number) => entry),
    touch: vi.fn(),
    delete: vi.fn(),
    onRevoke: vi.fn(),
    scavenge: vi.fn(),
    size: vi.fn(() => 0),
  }
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
  opts?: {guardInstalled?: boolean; sessionId?: string; githubUserId?: number},
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

  buildSessionInfoRoute(app, deps)
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
    const lastAccessedAt = nowMs - 500

    const entry: SessionEntry = {
      githubUserId: 42,
      login: 'octocat',
      issuedAt,
      lastAccessedAt,
      revoked: false,
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

    // expiresAt = min(issuedAt + ABSOLUTE_TTL, lastAccessedAt + IDLE_TTL)
    const absoluteExpiry = issuedAt + SESSION_ABSOLUTE_TTL_MS
    const idleExpiry = lastAccessedAt + SESSION_IDLE_TTL_MS
    expect(body.expiresAt).toBe(Math.min(absoluteExpiry, idleExpiry))
  })
})

// ---------------------------------------------------------------------------
// Expiry math — idle-bound vs absolute-bound
// ---------------------------------------------------------------------------

describe('buildSessionInfoRoute — expiry math', () => {
  it('uses idle expiry when idle TTL bounds sooner than absolute TTL', async () => {
    // #given — session was just issued but last accessed long ago (idle expires first)
    const nowMs = 1_000_000
    // issuedAt is recent → absolute expiry is far in the future
    const issuedAt = nowMs - 1000 // absolute expires at nowMs - 1000 + 8h (far future)
    // lastAccessedAt is old → idle expires soon
    const lastAccessedAt = nowMs - SESSION_IDLE_TTL_MS + 60_000 // idle expires in 60s

    const entry: SessionEntry = {
      githubUserId: 99,
      login: 'idle-user',
      issuedAt,
      lastAccessedAt,
      revoked: false,
    }

    const sessionStore = makeStubSessionStore(entry)
    const deps = makeStubBrowserGuardDeps({sessionStore, clock: () => nowMs})
    const app = buildTestApp(deps)

    // #when
    const req = new Request('http://localhost/operator/session', {method: 'GET'})
    const res = await app.fetch(req)

    // #then
    expect(res.status).toBe(200)
    const body = (await res.json()) as {expiresAt: number}
    const absoluteExpiry = issuedAt + SESSION_ABSOLUTE_TTL_MS
    const idleExpiry = lastAccessedAt + SESSION_IDLE_TTL_MS
    // idle expires sooner
    expect(idleExpiry).toBeLessThan(absoluteExpiry)
    expect(body.expiresAt).toBe(idleExpiry)
  })

  it('uses absolute expiry when absolute TTL bounds sooner than idle TTL', async () => {
    // #given — session is near its absolute limit but was recently accessed
    const nowMs = 1_000_000
    // issuedAt is old → absolute expires soon
    const issuedAt = nowMs - SESSION_ABSOLUTE_TTL_MS + 60_000 // absolute expires in 60s
    // lastAccessedAt is recent → idle expires far in the future
    const lastAccessedAt = nowMs - 1000 // idle expires at nowMs - 1000 + 30min (far future)

    const entry: SessionEntry = {
      githubUserId: 77,
      login: 'absolute-user',
      issuedAt,
      lastAccessedAt,
      revoked: false,
    }

    const sessionStore = makeStubSessionStore(entry)
    const deps = makeStubBrowserGuardDeps({sessionStore, clock: () => nowMs})
    const app = buildTestApp(deps)

    // #when
    const req = new Request('http://localhost/operator/session', {method: 'GET'})
    const res = await app.fetch(req)

    // #then
    expect(res.status).toBe(200)
    const body = (await res.json()) as {expiresAt: number}
    const absoluteExpiry = issuedAt + SESSION_ABSOLUTE_TTL_MS
    const idleExpiry = lastAccessedAt + SESSION_IDLE_TTL_MS
    // absolute expires sooner
    expect(absoluteExpiry).toBeLessThan(idleExpiry)
    expect(body.expiresAt).toBe(absoluteExpiry)
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
    const entry: SessionEntry = {
      githubUserId: 1,
      login: 'headeruser',
      issuedAt: nowMs - 1000,
      lastAccessedAt: nowMs - 500,
      revoked: false,
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
    const entry: SessionEntry = {
      githubUserId: 1,
      login: 'varyuser',
      issuedAt: nowMs - 1000,
      lastAccessedAt: nowMs - 500,
      revoked: false,
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
