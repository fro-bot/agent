/**
 * Tests for the server-side session store, cookie helpers, and logout route.
 *
 * Covers:
 *   - Session store: create, get, touch, delete with correct field shapes.
 *   - Session IDs have at least 128 bits of entropy (32 hex chars minimum).
 *   - Absolute expiry (8 hours) and idle expiry (30 minutes) enforced.
 *   - Scavenge removes expired sessions; cap prevents unbounded growth.
 *   - Cookie attributes: __Host- prefix, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain.
 *   - Stale pre-auth cookie is cleared before the new session cookie is set.
 *   - Logout invalidates session server-side and clears cookie.
 *   - Revocation hook is triggered when a session is revoked; concurrent sessions independently revocable.
 *   - Simulated restart: previously valid session IDs are not found in a new store.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import type {AuditLogger} from '../audit.js'
import type {BrowserGuardDeps} from './csrf.js'
import type {SessionDeps, SessionStore} from './session.js'
import {Buffer} from 'node:buffer'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {assertAllPrivilegedRoutesWrapped, registerPublicRoute, setOperatorRouteGuard} from '../operator-route.js'
import {loadAllowlistFromText} from './allowlist.js'
import {applyBrowserGuard, generateCsrfToken} from './csrf.js'
import {
  buildLogoutRoutes,
  buildSessionCookieValue,
  createInMemorySessionStore,
  parseSessionCookie,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_TTL_MS,
  SESSION_MAX_ENTRIES,
} from './session.js'

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
// Session store — create
// ---------------------------------------------------------------------------

describe('createInMemorySessionStore — create', () => {
  it('creates a session entry with the given identity and returns a session ID', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000

    // #when
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)

    // #then — session ID is a non-empty string
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)
  })

  it('session ID has at least 128 bits of entropy (32 hex chars minimum)', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000

    // #when
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)

    // #then — 32 hex chars = 128 bits; base64url 22 chars = ~132 bits
    // Accept either hex (64 chars for 256 bits) or base64url (43+ chars for 256 bits)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
    expect(sessionId.length).toBeGreaterThanOrEqual(22)
  })

  it('each create call returns a unique session ID', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000

    // #when
    const ids = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const id = store.create({githubUserId: 42, login: 'octocat'}, '', now)
      if (id === undefined) throw new Error('expected session ID to be defined')
      ids.add(id)
    }

    // #then — all IDs are unique
    expect(ids.size).toBe(20)
  })

  it('stored entry has correct identity, issuedAt, lastAccessedAt, and not revoked', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000

    // #when
    const sessionId = store.create({githubUserId: 99, login: 'testuser'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
    const entry = store.get(sessionId, now)

    // #then
    expect(entry).toBeDefined()
    expect(entry?.githubUserId).toBe(99)
    expect(entry?.login).toBe('testuser')
    expect(entry?.issuedAt).toBe(now)
    expect(entry?.lastAccessedAt).toBe(now)
    expect(entry?.revoked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Session store — get (expiry enforcement)
// ---------------------------------------------------------------------------

describe('createInMemorySessionStore — get with expiry', () => {
  it('returns the entry when within absolute and idle TTL', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when — access 1 second later
    const entry = store.get(sessionId, now + 1_000)

    // #then
    expect(entry).toBeDefined()
  })

  it('returns undefined when absolute TTL (8 hours) is exceeded', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when — access 1ms past absolute TTL
    const entry = store.get(sessionId, now + SESSION_ABSOLUTE_TTL_MS + 1)

    // #then — expired
    expect(entry).toBeUndefined()
  })

  it('returns undefined when idle TTL (30 minutes) is exceeded since last access', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when — access 1ms past idle TTL without any touch
    const entry = store.get(sessionId, now + SESSION_IDLE_TTL_MS + 1)

    // #then — idle expired
    expect(entry).toBeUndefined()
  })

  it('returns undefined for an unknown session ID', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000

    // #when
    const entry = store.get('nonexistent-session-id', now)

    // #then
    expect(entry).toBeUndefined()
  })

  it('returns undefined for a revoked session', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
    store.delete(sessionId)

    // #when
    const entry = store.get(sessionId, now + 1_000)

    // #then — revoked
    expect(entry).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Session store — touch (idle TTL reset)
// ---------------------------------------------------------------------------

describe('createInMemorySessionStore — touch', () => {
  it('touch updates lastAccessedAt and extends idle TTL', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when — touch at 25 minutes (within idle TTL)
    const touchTime = now + 25 * 60 * 1000
    store.touch(sessionId, touchTime)

    // #then — session is still valid 10 minutes after touch (35 min total, but only 10 since touch)
    const entry = store.get(sessionId, touchTime + 10 * 60 * 1000)
    expect(entry).toBeDefined()
    expect(entry?.lastAccessedAt).toBe(touchTime)
  })

  it('touch does not extend absolute TTL', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when — touch just before absolute TTL expires
    const touchTime = now + SESSION_ABSOLUTE_TTL_MS - 1_000
    store.touch(sessionId, touchTime)

    // #then — session expires at absolute TTL regardless of touch
    const entry = store.get(sessionId, now + SESSION_ABSOLUTE_TTL_MS + 1)
    expect(entry).toBeUndefined()
  })

  it('touch on unknown session ID is a no-op (does not throw)', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000

    // #when / #then — no throw
    expect(() => store.touch('nonexistent-id', now)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Session store — delete (revocation)
// ---------------------------------------------------------------------------

describe('createInMemorySessionStore — delete', () => {
  it('delete makes the session immediately unavailable', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when
    store.delete(sessionId)

    // #then
    expect(store.get(sessionId, now + 1_000)).toBeUndefined()
  })

  it('delete on unknown session ID is a no-op (does not throw)', () => {
    // #given
    const store = createInMemorySessionStore()

    // #when / #then — no throw
    expect(() => store.delete('nonexistent-id')).not.toThrow()
  })

  it('concurrent sessions are independently revocable', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionA = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    const sessionB = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionA === undefined || sessionB === undefined) throw new Error('expected session IDs to be defined')

    // #when — revoke only session A
    store.delete(sessionA)

    // #then — session A is gone, session B is still valid
    expect(store.get(sessionA, now + 1_000)).toBeUndefined()
    expect(store.get(sessionB, now + 1_000)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Session store — revocation hook
// ---------------------------------------------------------------------------

describe('createInMemorySessionStore — revocation hook', () => {
  it('revocation hook is called when a session is deleted', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    const hookCalled = vi.fn()
    store.onRevoke(sessionId, hookCalled)

    // #when
    store.delete(sessionId)

    // #then
    expect(hookCalled).toHaveBeenCalledOnce()
  })

  it('revocation hook is called with the session ID', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    const hookCalled = vi.fn()
    store.onRevoke(sessionId, hookCalled)

    // #when
    store.delete(sessionId)

    // #then
    expect(hookCalled).toHaveBeenCalledWith(sessionId)
  })

  it('revocation hooks for different sessions are independent', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionA = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    const sessionB = store.create({githubUserId: 43, login: 'other'}, '', now)
    if (sessionA === undefined || sessionB === undefined) throw new Error('expected session IDs to be defined')

    const hookA = vi.fn()
    const hookB = vi.fn()
    store.onRevoke(sessionA, hookA)
    store.onRevoke(sessionB, hookB)

    // #when — revoke only session A
    store.delete(sessionA)

    // #then — only hook A was called
    expect(hookA).toHaveBeenCalledOnce()
    expect(hookB).not.toHaveBeenCalled()
  })

  it('revocation hook is not called when a different session is deleted', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionA = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    const sessionB = store.create({githubUserId: 43, login: 'other'}, '', now)
    if (sessionA === undefined || sessionB === undefined) throw new Error('expected session IDs to be defined')

    const hookA = vi.fn()
    store.onRevoke(sessionA, hookA)

    // #when — delete session B (not A)
    store.delete(sessionB)

    // #then — hook A was NOT called
    expect(hookA).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Session store — scavenge
// ---------------------------------------------------------------------------

describe('createInMemorySessionStore — scavenge', () => {
  it('scavenge removes expired sessions', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    store.create({githubUserId: 42, login: 'octocat'}, '', now)
    store.create({githubUserId: 43, login: 'other'}, '', now)

    // #when — scavenge past absolute TTL
    store.scavenge(now + SESSION_ABSOLUTE_TTL_MS + 1)

    // #then — size is 0
    expect(store.size()).toBe(0)
  })

  it('scavenge does not remove sessions within TTL', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    store.create({githubUserId: 42, login: 'octocat'}, '', now)

    // #when — scavenge 1 second after creation (well within TTL)
    store.scavenge(now + 1_000)

    // #then — session still present
    expect(store.size()).toBe(1)
  })

  it('scavenge removes revoked sessions', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
    store.delete(sessionId)

    // #when — scavenge at any time
    store.scavenge(now + 1_000)

    // #then — revoked session is removed
    expect(store.size()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Session store — cap
// ---------------------------------------------------------------------------

describe('createInMemorySessionStore — cap', () => {
  it('create returns undefined when the session cap is reached', () => {
    // #given — fill the store to the cap
    const store = createInMemorySessionStore()
    const now = 1_000_000

    for (let i = 0; i < SESSION_MAX_ENTRIES; i++) {
      store.create({githubUserId: i, login: `user${i}`}, '', now)
    }

    // #when — one more create
    const result = store.create({githubUserId: 99999, login: 'overflow'}, '', now)

    // #then — cap enforced; returns undefined
    expect(result).toBeUndefined()
  })

  it('create succeeds after scavenge frees space below the cap', () => {
    // #given — fill to cap with sessions that will expire
    const store = createInMemorySessionStore()
    const now = 1_000_000

    for (let i = 0; i < SESSION_MAX_ENTRIES; i++) {
      store.create({githubUserId: i, login: `user${i}`}, '', now)
    }

    // #when — scavenge past absolute TTL, then create
    store.scavenge(now + SESSION_ABSOLUTE_TTL_MS + 1)
    const result = store.create({githubUserId: 99999, login: 'new'}, '', now + SESSION_ABSOLUTE_TTL_MS + 2)

    // #then — create succeeds
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Session store — simulated restart
// ---------------------------------------------------------------------------

describe('createInMemorySessionStore — simulated restart', () => {
  it('previously valid session IDs are not found in a new store instance', () => {
    // #given — create a session in store A
    const storeA = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = storeA.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
    expect(storeA.get(sessionId, now + 1_000)).toBeDefined()

    // #when — create a new store (simulating restart)
    const storeB = createInMemorySessionStore()

    // #then — session ID from store A is not found in store B
    expect(storeB.get(sessionId, now + 1_000)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Cookie helpers
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
  store: SessionStore,
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
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
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
    expect(store.get(sessionId, now + 2_000)).toBeUndefined()
  })

  it('sets a clear-cookie header on logout', async () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
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
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
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
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
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
    const store = createInMemorySessionStore()
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
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
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
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
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
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 99, login: 'notallowed'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
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
    const store = createInMemorySessionStore()
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
// Session store — create scavenges before cap check
// ---------------------------------------------------------------------------

describe('createInMemorySessionStore — create scavenges before cap check', () => {
  it('create succeeds after revoked entries are scavenged at cap (re-auth after stale session)', () => {
    // #given — fill to cap with sessions, then revoke one
    const store = createInMemorySessionStore()
    const now = 1_000_000

    const ids: string[] = []
    for (let i = 0; i < SESSION_MAX_ENTRIES; i++) {
      const id = store.create({githubUserId: i, login: `user${i}`}, '', now)
      if (id === undefined) throw new Error('expected session ID to be defined')
      ids.push(id)
    }

    // Revoke the first session (simulating logout before re-auth)
    const firstId = ids[0]
    if (firstId === undefined) throw new Error('expected first session ID to be defined')
    store.delete(firstId)

    // #when — create a new session without calling scavenge() manually
    const newId = store.create({githubUserId: 99999, login: 'reauth-user'}, '', now + 1_000)

    // #then — create succeeds because revoked entry was scavenged opportunistically
    expect(newId).toBeDefined()
  })

  it('create succeeds after expired entries are scavenged at cap', () => {
    // #given — fill to cap with sessions that will expire
    const store = createInMemorySessionStore()
    const now = 1_000_000

    for (let i = 0; i < SESSION_MAX_ENTRIES; i++) {
      store.create({githubUserId: i, login: `user${i}`}, '', now)
    }

    // #when — create at a time past absolute TTL (entries are expired)
    const newId = store.create({githubUserId: 99999, login: 'new-user'}, '', now + SESSION_ABSOLUTE_TTL_MS + 1)

    // #then — create succeeds because expired entries were scavenged opportunistically
    expect(newId).toBeDefined()
  })

  it('create still returns undefined when all entries are live at cap', () => {
    // #given — fill to cap with fresh sessions
    const store = createInMemorySessionStore()
    const now = 1_000_000

    for (let i = 0; i < SESSION_MAX_ENTRIES; i++) {
      store.create({githubUserId: i, login: `user${i}`}, '', now)
    }

    // #when — create at same time (all entries still live)
    const result = store.create({githubUserId: 99999, login: 'overflow'}, '', now)

    // #then — cap enforced; returns undefined
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Session store — get returns Readonly
// ---------------------------------------------------------------------------

describe('createInMemorySessionStore — get returns Readonly', () => {
  it('get returns an entry that satisfies the Readonly<SessionEntry> type', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when
    const entry = store.get(sessionId, now)

    // #then — entry is defined and has expected shape
    expect(entry).toBeDefined()
    expect(entry?.githubUserId).toBe(42)
    expect(entry?.login).toBe('octocat')
    expect(entry?.revoked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Session ID entropy
// ---------------------------------------------------------------------------

describe('generateSessionId — entropy', () => {
  it('session ID is exactly 43 characters (256-bit base64url)', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000

    // #when
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #then — 32 bytes base64url = 43 chars (no padding)
    expect(sessionId.length).toBe(43)
  })

  it('session ID contains only base64url characters (A-Z, a-z, 0-9, -, _)', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000

    // #when
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #then — only base64url charset (no +, /, or =)
    // base64url uses A-Z, a-z, 0-9, -, _ (no +, /, or = padding)
    expect(sessionId).toMatch(/^[\w-]+$/)
  })
})

// ---------------------------------------------------------------------------
// parseSessionCookie — empty value returns undefined
// ---------------------------------------------------------------------------

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
// Session store — OAuth token retention (Unit 3h)
// ---------------------------------------------------------------------------

describe('createInMemorySessionStore — getOperatorToken (token retention)', () => {
  it('getOperatorToken returns the token stored at create time', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const token = 'ghs_SECRETTOKEN'

    // #when
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, token, now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #then — token is retrievable via the narrow accessor
    expect(store.getOperatorToken(sessionId, now)).toBe(token)
  })

  it('getOperatorToken returns undefined for an unknown session ID', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000

    // #when / #then
    expect(store.getOperatorToken('nonexistent-id', now)).toBeUndefined()
  })

  it('getOperatorToken returns undefined after the session is revoked (logout)', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, 'ghs_TOKEN', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when — revoke the session (logout path)
    store.delete(sessionId)

    // #then — token is gone
    expect(store.getOperatorToken(sessionId, now + 1_000)).toBeUndefined()
  })

  it('getOperatorToken returns undefined after absolute TTL expiry', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, 'ghs_TOKEN', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when — access past absolute TTL
    const result = store.getOperatorToken(sessionId, now + SESSION_ABSOLUTE_TTL_MS + 1)

    // #then — token is gone (TTL-evicted)
    expect(result).toBeUndefined()
  })

  it('getOperatorToken returns undefined after idle TTL expiry', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, 'ghs_TOKEN', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when — access past idle TTL without any touch
    const result = store.getOperatorToken(sessionId, now + SESSION_IDLE_TTL_MS + 1)

    // #then — token is gone (idle-evicted)
    expect(result).toBeUndefined()
  })

  it('token is NOT present in the SessionEntry returned by get()', () => {
    // #given — security: token must not leak into the public SessionEntry shape
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const token = 'ghs_SECRETTOKEN'
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, token, now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when
    const entry = store.get(sessionId, now)

    // #then — entry does not contain the token in any field
    expect(entry).toBeDefined()
    const entryJson = JSON.stringify(entry)
    expect(entryJson).not.toContain(token)
    // Explicit field check: SessionIdentity fields only
    expect(Object.keys(entry ?? {})).not.toContain('oauthToken')
  })

  it('token is NOT present in SessionIdentity (githubUserId, login only)', () => {
    // #given — security: SessionIdentity must not gain the token field
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const token = 'ghs_SECRETTOKEN'
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, token, now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when
    const entry = store.get(sessionId, now)

    // #then — only expected fields present
    if (entry === undefined) throw new Error('expected entry to be defined')
    expect(entry.githubUserId).toBe(42)
    expect(entry.login).toBe('octocat')
    // Token must not appear as any property
    for (const value of Object.values(entry)) {
      expect(value).not.toBe(token)
    }
  })
})

describe('createInMemorySessionStore — dropOperatorToken (re-auth coupling)', () => {
  it('dropOperatorToken removes the token; getOperatorToken returns undefined after', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, 'ghs_TOKEN', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when — drop the token (e.g. on detected GitHub token expiry)
    store.dropOperatorToken(sessionId)

    // #then — token is gone; session itself is still valid
    expect(store.getOperatorToken(sessionId, now + 1_000)).toBeUndefined()
    expect(store.get(sessionId, now + 1_000)).toBeDefined()
  })

  it('dropOperatorToken on unknown session ID is a no-op (does not throw)', () => {
    // #given
    const store = createInMemorySessionStore()

    // #when / #then — no throw
    expect(() => store.dropOperatorToken('nonexistent-id')).not.toThrow()
  })

  it('dropOperatorToken on revoked session is a no-op (does not throw)', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, 'ghs_TOKEN', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
    store.delete(sessionId)

    // #when / #then — no throw
    expect(() => store.dropOperatorToken(sessionId)).not.toThrow()
  })

  it('session remains valid after dropOperatorToken (only token is cleared, not the session)', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, 'ghs_TOKEN', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')

    // #when
    store.dropOperatorToken(sessionId)

    // #then — session is still valid
    const entry = store.get(sessionId, now + 1_000)
    expect(entry).toBeDefined()
    expect(entry?.githubUserId).toBe(42)
  })
})

describe('createInMemorySessionStore — token no-oracle (token never in public entry)', () => {
  it('token does not appear in the entry returned by get() at any point in the lifecycle', () => {
    // #given — the session store has no logger; the no-oracle invariant is enforced by
    // ensuring the token never appears in the public SessionEntry returned by get().
    // Route-level no-oracle (logger calls) is tested in github.test.ts.
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const token = 'ghs_SUPERSECRETTOKEN_NEVERLOG'

    // #when — exercise the full token lifecycle
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, token, now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
    const retrieved = store.getOperatorToken(sessionId, now)
    store.dropOperatorToken(sessionId)
    const afterDrop = store.getOperatorToken(sessionId, now)

    // #then — token is returned correctly by the accessor (not leaked elsewhere)
    expect(retrieved).toBe(token)
    expect(afterDrop).toBeUndefined()

    // #and — the entry returned by get() does not contain the token in any field
    const entry = store.get(sessionId, now)
    const entryStr = JSON.stringify(entry)
    expect(entryStr).not.toContain(token)
  })
})

describe('createInMemorySessionStore — create signature backward compat', () => {
  it('create still returns a session ID with the new three-argument signature', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000

    // #when — new signature: (identity, oauthToken, nowMs)
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, 'ghs_TOKEN', now)

    // #then
    expect(sessionId).toBeDefined()
    expect(typeof sessionId).toBe('string')
  })

  it('create with token stores identity correctly (get() returns correct fields)', () => {
    // #given
    const store = createInMemorySessionStore()
    const now = 1_000_000

    // #when
    const sessionId = store.create({githubUserId: 99, login: 'testuser'}, 'ghs_TOKEN', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
    const entry = store.get(sessionId, now)

    // #then — identity fields are correct
    expect(entry?.githubUserId).toBe(99)
    expect(entry?.login).toBe('testuser')
    expect(entry?.issuedAt).toBe(now)
    expect(entry?.revoked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Logout response body
// ---------------------------------------------------------------------------

describe('POST /operator/auth/logout — response body', () => {
  it('response body is {ok: true} when session + CSRF are valid', async () => {
    // #given — valid session and CSRF token
    const store = createInMemorySessionStore()
    const now = 1_000_000
    const sessionId = store.create({githubUserId: 42, login: 'octocat'}, '', now)
    if (sessionId === undefined) throw new Error('expected session ID to be defined')
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
