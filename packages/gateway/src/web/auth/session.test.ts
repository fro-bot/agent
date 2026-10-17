/**
 * Tests for the session cookie helpers and the logout route over the durable store.
 *
 * Covers:
 *   - Cookie attributes: __Host- prefix, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain; Max-Age on set, 0 on clear.
 *   - Logout invalidates the session server-side and clears the cookie.
 *   - Logout is durable first: 200 only after the revoke is stored, 503 with the session still valid otherwise.
 *   - The store lifecycle itself (create, TTL, cap, revoke, restart) is covered in durable-session.test.ts.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import type {AuditLogger} from '../audit.js'
import type {BrowserGuardDeps} from './csrf.js'
import type {DurableSessionStore, SessionDeps} from './session.js'
import {Buffer} from 'node:buffer'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {assertAllPrivilegedRoutesWrapped, registerPublicRoute, setOperatorRouteGuard} from '../operator-route.js'
import {loadAllowlistFromText} from './allowlist.js'
import {applyBrowserGuard, generateCsrfToken} from './csrf.js'
import {
  buildLogoutRoutes,
  buildSessionCookieValue,
  parseSessionCookie,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
} from './session.js'
import {createTestSessionStore, createTestSessionStoreHarness, mintTestSession} from './test-session-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuditLogger(): AuditLogger & {records: Record<string, unknown>[]} {
  const records: Record<string, unknown>[] = []
  return {
    records,
    info: vi.fn((ctx: Record<string, unknown>, _msg: string) => {
      records.push(ctx)
    }),
    warn: vi.fn((ctx: Record<string, unknown>, _msg: string) => {
      records.push(ctx)
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

function makeStubDeps(overrides?: Partial<SessionDeps>): SessionDeps {
  return {
    logger: makeLogger(),
    auditLogger: makeAuditLogger(),
    clock: () => Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Cookie name and helpers
// ---------------------------------------------------------------------------

describe('SESSION_COOKIE_NAME', () => {
  it('uses the __Host- prefix', () => {
    // #then — __Host- prefix enforces Secure, Path=/, no Domain
    expect(SESSION_COOKIE_NAME).toMatch(/^__Host-/)
  })
})

describe('buildSessionCookieValue', () => {
  it('returns a Set-Cookie string with the session ID as value', () => {
    // #given
    const sessionId = 'test-session-id-abc123'

    // #when
    const cookieValue = buildSessionCookieValue(sessionId)

    // #then
    expect(cookieValue).toContain(sessionId)
  })

  it('includes HttpOnly attribute', () => {
    // #given / #when
    const cookieValue = buildSessionCookieValue('test-id')

    // #then
    expect(cookieValue.toLowerCase()).toContain('httponly')
  })

  it('includes Secure attribute', () => {
    // #given / #when
    const cookieValue = buildSessionCookieValue('test-id')

    // #then
    expect(cookieValue.toLowerCase()).toContain('secure')
  })

  it('includes SameSite=Lax attribute', () => {
    // #given / #when
    const cookieValue = buildSessionCookieValue('test-id')

    // #then
    expect(cookieValue.toLowerCase()).toContain('samesite=lax')
  })

  it('includes Path=/ attribute', () => {
    // #given / #when
    const cookieValue = buildSessionCookieValue('test-id')

    // #then
    expect(cookieValue).toContain('Path=/')
  })

  it('does NOT include Domain attribute', () => {
    // #given / #when
    const cookieValue = buildSessionCookieValue('test-id')

    // #then — __Host- prefix forbids Domain
    expect(cookieValue.toLowerCase()).not.toContain('domain=')
  })

  it('uses the __Host- cookie name', () => {
    // #given / #when
    const cookieValue = buildSessionCookieValue('test-id')

    // #then
    expect(cookieValue).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`))
  })
})

describe('buildSessionCookieValue — Max-Age', () => {
  it('a set cookie carries Max-Age equal to the 7-day durable lifetime', () => {
    // #given / #when
    const cookieValue = buildSessionCookieValue('test-id')

    // #then
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(604_800)
    expect(cookieValue).toContain('Max-Age=604800')
  })

  it('the clear cookie keeps every other attribute of the set cookie and swaps only Max-Age', () => {
    // #given
    const attributes = (value: string): string[] => value.split('; ').slice(1)

    // #when
    const set = attributes(buildSessionCookieValue('test-id'))
    const cleared = attributes(buildSessionCookieValue('', {clear: true}))

    // #then
    expect(set.filter(part => part.startsWith('Max-Age='))).toEqual(['Max-Age=604800'])
    expect(cleared.filter(part => part.startsWith('Max-Age='))).toEqual(['Max-Age=0'])
    expect(cleared.filter(part => part.startsWith('Max-Age=') === false)).toEqual(
      set.filter(part => part.startsWith('Max-Age=') === false),
    )
  })
})

describe('buildSessionCookieValue — clear cookie', () => {
  it('clear cookie sets Max-Age=0 to expire the cookie', () => {
    // #given / #when
    const cookieValue = buildSessionCookieValue('', {clear: true})

    // #then
    expect(cookieValue.toLowerCase()).toContain('max-age=0')
  })

  it('clear cookie still includes HttpOnly, Secure, SameSite=Lax, Path=/', () => {
    // #given / #when
    const cookieValue = buildSessionCookieValue('', {clear: true})

    // #then
    expect(cookieValue.toLowerCase()).toContain('httponly')
    expect(cookieValue.toLowerCase()).toContain('secure')
    expect(cookieValue.toLowerCase()).toContain('samesite=lax')
    expect(cookieValue).toContain('Path=/')
  })
})

describe('parseSessionCookie', () => {
  it('returns the session ID from a valid Cookie header', () => {
    // #given
    const cookieHeader = `${SESSION_COOKIE_NAME}=my-session-id-abc`

    // #when
    const sessionId = parseSessionCookie(cookieHeader)

    // #then
    expect(sessionId).toBe('my-session-id-abc')
  })

  it('returns undefined when the cookie header is absent', () => {
    // #given / #when
    const sessionId = parseSessionCookie(undefined)

    // #then
    expect(sessionId).toBeUndefined()
  })

  it('returns undefined when the session cookie is not present in the header', () => {
    // #given
    const cookieHeader = 'other-cookie=some-value; another=thing'

    // #when
    const sessionId = parseSessionCookie(cookieHeader)

    // #then
    expect(sessionId).toBeUndefined()
  })

  it('handles multiple cookies and extracts the session cookie', () => {
    // #given
    const cookieHeader = `other=value; ${SESSION_COOKIE_NAME}=target-session-id; another=thing`

    // #when
    const sessionId = parseSessionCookie(cookieHeader)

    // #then
    expect(sessionId).toBe('target-session-id')
  })
})

// ---------------------------------------------------------------------------
// Logout route
// ---------------------------------------------------------------------------

const TEST_CSRF_SECRET = Buffer.from('test-csrf-secret-32-bytes-long!!', 'utf8').toString('base64url')
const PUBLIC_ORIGIN = 'https://operator.example.com'

/**
 * Build a test app with the full browser guard installed and the logout route registered.
 * Logout is always a privileged route — this helper mirrors the production wiring in server.ts.
 */
function buildTestLogoutApp(
  store: DurableSessionStore,
  deps: SessionDeps,
  guardDepsOverrides?: Partial<BrowserGuardDeps>,
): Hono {
  const logger = makeLogger()
  const auditLogger = makeAuditLogger()
  const allowlist = loadAllowlistFromText('42\n', logger)
  const browserGuardDeps: BrowserGuardDeps = {
    logger,
    auditLogger,
    sessionStore: store,
    allowlist,
    csrfSecret: TEST_CSRF_SECRET,
    publicOrigin: PUBLIC_ORIGIN,
    clock: deps.clock,
    ...guardDepsOverrides,
  }

  const app = new Hono()
  registerPublicRoute(app, 'GET', '/operator/health', c => c.json({ok: true}))

  // Install the browser guard before registering privileged routes — mirrors server.ts.
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
  setOperatorRouteGuard(app, async (c, method, _path) => {
    const requireCsrf = SAFE_METHODS.has(method.toUpperCase()) === false
    return applyBrowserGuard(c, browserGuardDeps, false, requireCsrf)
  })

  buildLogoutRoutes(app, store, deps, browserGuardDeps)
  assertAllPrivilegedRoutesWrapped(app)
  return app
}

describe('POST /operator/auth/logout — happy path (privileged route)', () => {
  it('returns 200 and clears the session cookie when session + CSRF are valid', async () => {
    // #given
    const store = await createTestSessionStore()
    const now = 1_000_000
    const sessionId = await mintTestSession(store, {githubUserId: 42, login: 'octocat'})
    const deps = makeStubDeps({clock: () => now + 1_000})
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1_000, secret: TEST_CSRF_SECRET})
    const app = buildTestLogoutApp(store, deps)

    // #when
    const req = new Request(`${PUBLIC_ORIGIN}/operator/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: PUBLIC_ORIGIN,
        'x-csrf-token': csrfToken,
      },
    })
    const res = await app.fetch(req)

    // #then — success
    expect(res.status).toBe(200)

    // #and — session is invalidated server-side
    expect(store.get(sessionId)).toBeUndefined()
  })

  it('sets a clear-cookie header on logout', async () => {
    // #given
    const store = await createTestSessionStore()
    const now = 1_000_000
    const sessionId = await mintTestSession(store, {githubUserId: 42, login: 'octocat'})
    const deps = makeStubDeps({clock: () => now + 1_000})
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1_000, secret: TEST_CSRF_SECRET})
    const app = buildTestLogoutApp(store, deps)

    // #when
    const req = new Request(`${PUBLIC_ORIGIN}/operator/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: PUBLIC_ORIGIN,
        'x-csrf-token': csrfToken,
      },
    })
    const res = await app.fetch(req)

    // #then — Set-Cookie header clears the session cookie
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(SESSION_COOKIE_NAME)
    expect(setCookie.toLowerCase()).toContain('max-age=0')
  })

  it('emits auth.logout audit event with githubUserId', async () => {
    // #given
    const store = await createTestSessionStore()
    const now = 1_000_000
    const sessionId = await mintTestSession(store, {githubUserId: 42, login: 'octocat'})
    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({clock: () => now + 1_000, auditLogger})
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1_000, secret: TEST_CSRF_SECRET})
    // Pass the same auditLogger to the guard deps so we capture guard audit events too
    const app = buildTestLogoutApp(store, deps, {auditLogger, clock: () => now + 1_000})

    // #when
    const req = new Request(`${PUBLIC_ORIGIN}/operator/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: PUBLIC_ORIGIN,
        'x-csrf-token': csrfToken,
      },
    })
    await app.fetch(req)

    // #then — auth.logout audit event emitted (from the handler, not the guard)
    const logoutEvent = auditLogger.records.find(r => r.kind === 'auth.logout')
    expect(logoutEvent).toBeDefined()
    expect(logoutEvent?.githubUserId).toBe(42)
  })

  it('audit event correlationId does NOT contain the raw session ID', async () => {
    // #given — session IDs are never logged (security invariant)
    const store = await createTestSessionStore()
    const now = 1_000_000
    const sessionId = await mintTestSession(store, {githubUserId: 42, login: 'octocat'})
    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({clock: () => now + 1_000, auditLogger})
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1_000, secret: TEST_CSRF_SECRET})
    const app = buildTestLogoutApp(store, deps, {auditLogger, clock: () => now + 1_000})

    // #when
    const req = new Request(`${PUBLIC_ORIGIN}/operator/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: PUBLIC_ORIGIN,
        'x-csrf-token': csrfToken,
      },
    })
    await app.fetch(req)

    // #then — correlationId must not be the raw session ID
    const logoutEvent = auditLogger.records.find(r => r.kind === 'auth.logout')
    expect(logoutEvent).toBeDefined()
    expect(logoutEvent?.correlationId).not.toBe(sessionId)

    // #and — correlationId must be the safe static sentinel
    expect(logoutEvent?.correlationId).toBe('logout')

    // #and — no field in the audit record contains the raw session ID
    for (const [key, value] of Object.entries(logoutEvent ?? {})) {
      expect(value, `field '${key}' must not contain the raw session ID`).not.toBe(sessionId)
    }
  })
})

describe('POST /operator/auth/logout — guard enforcement (privileged route)', () => {
  it('returns 401 when no session cookie is present (guard rejects unauthenticated requests)', async () => {
    // #given — logout is a privileged route; no session = 401
    const store = await createTestSessionStore()
    const deps = makeStubDeps()
    const app = buildTestLogoutApp(store, deps)

    // #when — no cookie header
    const req = new Request(`${PUBLIC_ORIGIN}/operator/auth/logout`, {
      method: 'POST',
      headers: {origin: PUBLIC_ORIGIN},
    })
    const res = await app.fetch(req)

    // #then — guard rejects with 401 (no session)
    expect(res.status).toBe(401)
  })

  it('returns 400 when session is valid but CSRF token is missing', async () => {
    // #given — valid session but no CSRF token
    const store = await createTestSessionStore()
    const now = 1_000_000
    const sessionId = await mintTestSession(store, {githubUserId: 42, login: 'octocat'})
    const deps = makeStubDeps({clock: () => now + 1_000})
    const app = buildTestLogoutApp(store, deps)

    // #when — no x-csrf-token header
    const req = new Request(`${PUBLIC_ORIGIN}/operator/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: PUBLIC_ORIGIN,
        // No x-csrf-token
      },
    })
    const res = await app.fetch(req)

    // #then — guard rejects with 400 (missing CSRF token)
    expect(res.status).toBe(400)
  })

  it('returns 400 when Origin header is absent on mutating request', async () => {
    // #given — valid session and CSRF token but no Origin header
    const store = await createTestSessionStore()
    const now = 1_000_000
    const sessionId = await mintTestSession(store, {githubUserId: 42, login: 'octocat'})
    const deps = makeStubDeps({clock: () => now + 1_000})
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1_000, secret: TEST_CSRF_SECRET})
    const app = buildTestLogoutApp(store, deps)

    // #when — no Origin header (absent origin on mutating request is rejected)
    const req = new Request(`${PUBLIC_ORIGIN}/operator/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        'x-csrf-token': csrfToken,
        // No origin header
      },
    })
    const res = await app.fetch(req)

    // #then — guard rejects with 400 (absent origin on mutating request)
    expect(res.status).toBe(400)
  })

  it('returns 403 when operator is not in allowlist', async () => {
    // #given — session for user 99 who is NOT in the allowlist (allowlist has 42)
    const store = await createTestSessionStore()
    const now = 1_000_000
    const sessionId = await mintTestSession(store, {githubUserId: 99, login: 'notallowed'})
    const deps = makeStubDeps({clock: () => now + 1_000})
    const csrfToken = generateCsrfToken({sessionId, operatorId: 99, nowMs: now + 1_000, secret: TEST_CSRF_SECRET})
    const app = buildTestLogoutApp(store, deps)

    // #when
    const req = new Request(`${PUBLIC_ORIGIN}/operator/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: PUBLIC_ORIGIN,
        'x-csrf-token': csrfToken,
      },
    })
    const res = await app.fetch(req)

    // #then — guard rejects with 403 (not allowlisted)
    expect(res.status).toBe(403)
  })
})

describe('POST /operator/auth/logout — unknown session ID', () => {
  it('returns 401 for an unknown session ID (guard rejects invalid session)', async () => {
    // #given — unknown session ID; guard rejects before handler runs
    const store = await createTestSessionStore()
    const deps = makeStubDeps()
    const app = buildTestLogoutApp(store, deps)

    // #when — send a session cookie with an unknown ID
    const req = new Request(`${PUBLIC_ORIGIN}/operator/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=unknown-session-id-xyz`,
        origin: PUBLIC_ORIGIN,
      },
    })
    const res = await app.fetch(req)

    // #then — guard rejects with 401 (invalid session)
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Logout — durable first
// ---------------------------------------------------------------------------

describe('POST /operator/auth/logout — durable first', () => {
  const now = 1_000_000

  async function setup(onSessionRevoked?: (githubUserId: number) => void) {
    const harness = await createTestSessionStoreHarness(
      onSessionRevoked === undefined ? {clock: () => now} : {clock: () => now, onSessionRevoked},
    )
    const sessionId = await mintTestSession(harness.store, {githubUserId: 42, login: 'octocat'})
    const auditLogger = makeAuditLogger()
    const deps = makeStubDeps({clock: () => now + 1_000, auditLogger})
    const app = buildTestLogoutApp(harness.store, deps, {auditLogger, clock: () => now + 1_000})
    const logout = async () =>
      app.fetch(
        new Request(`${PUBLIC_ORIGIN}/operator/auth/logout`, {
          method: 'POST',
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
            origin: PUBLIC_ORIGIN,
            'x-csrf-token': generateCsrfToken({
              sessionId,
              operatorId: 42,
              nowMs: now + 1_000,
              secret: TEST_CSRF_SECRET,
            }),
          },
        }),
      )
    return {harness, sessionId, auditLogger, logout}
  }

  function storedStatus(harness: Awaited<ReturnType<typeof setup>>['harness']): string | undefined {
    const [stored] = [...harness.objectStore.objects.values()]
    return stored === undefined ? undefined : (JSON.parse(stored.data) as {status?: string}).status
  }

  it('answers 200 only after the stored record is revoked', async () => {
    // #given a live session and an observer inside the durable write
    const hook = vi.fn()
    const {harness, sessionId, logout} = await setup(hook)
    const observed: {validDuringWrite?: boolean} = {}
    harness.objectStore.onBefore('conditionalPut', () => {
      observed.validDuringWrite = harness.store.get(sessionId) !== undefined
    })

    // #when the operator logs out
    const res = await logout()

    // #then the session was still valid during the write, and the record is revoked by the time of the 200
    expect(res.status).toBe(200)
    expect(observed.validDuringWrite).toBe(true)
    expect(storedStatus(harness)).toBe('revoked')
    expect(harness.store.get(sessionId)).toBeUndefined()
    expect(hook).toHaveBeenCalledExactlyOnceWith(42)
  })

  it('returns 503 with Retry-After, keeps the cookie and leaves the session valid when the write fails', async () => {
    // #given a durable write that fails
    const hook = vi.fn()
    const {harness, sessionId, auditLogger, logout} = await setup(hook)
    harness.objectStore.failNext('conditionalPut')

    // #when the operator logs out
    const res = await logout()

    // #then logout is refused and nothing about the session changed
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).not.toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(harness.store.get(sessionId)).toBeDefined()
    expect(storedStatus(harness)).toBe('active')
    expect(hook).not.toHaveBeenCalled()
    expect(auditLogger.records.some(r => r.kind === 'auth.logout')).toBe(false)
  })

  it('succeeds on retry after a failed attempt, with one hook and the clear cookie', async () => {
    // #given a first attempt that failed
    const hook = vi.fn()
    const {harness, sessionId, logout} = await setup(hook)
    harness.objectStore.failNext('conditionalPut')
    await logout()

    // #when the operator retries
    const res = await logout()

    // #then the retry is durable, clears the cookie, and fires the hook once
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')?.toLowerCase()).toContain('max-age=0')
    expect(storedStatus(harness)).toBe('revoked')
    expect(harness.store.get(sessionId)).toBeUndefined()
    expect(hook).toHaveBeenCalledExactlyOnceWith(42)
  })
})

describe('parseSessionCookie — empty value', () => {
  it('returns undefined when session cookie value is empty (clear cookie)', () => {
    // #given — cookie header with empty session cookie value followed by another cookie
    const cookieHeader = `${SESSION_COOKIE_NAME}=; other=value`

    // #when
    const sessionId = parseSessionCookie(cookieHeader)

    // #then — empty value treated as absent
    expect(sessionId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Logout response body
// ---------------------------------------------------------------------------

describe('POST /operator/auth/logout — response body', () => {
  it('response body is {ok: true} when session + CSRF are valid', async () => {
    // #given — valid session and CSRF token
    const store = await createTestSessionStore()
    const now = 1_000_000
    const sessionId = await mintTestSession(store, {githubUserId: 42, login: 'octocat'})
    const deps = makeStubDeps({clock: () => now + 1_000})
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1_000, secret: TEST_CSRF_SECRET})
    const app = buildTestLogoutApp(store, deps)

    // #when
    const req = new Request(`${PUBLIC_ORIGIN}/operator/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: PUBLIC_ORIGIN,
        'x-csrf-token': csrfToken,
      },
    })
    const res = await app.fetch(req)

    // #then — body is {ok: true}
    const body = await res.json()
    expect(body).toEqual({ok: true})
  })
})
