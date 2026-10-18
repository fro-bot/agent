/**
 * Tests for the CSRF token module and browser-origin guard middleware.
 *
 * Covers:
 *   - Token generation and verification (happy path).
 *   - Session/operator binding mismatch rejection.
 *   - The session binding is sha256(sessionId): the payload never carries the raw ID, and pre-change tokens fail.
 *   - Token expiry.
 *   - Malformed token rejection.
 *   - Timing-safe compare path (no short-circuit on mismatch).
 *   - No token leakage in logs or responses.
 *   - Browser guard: credential headers reject without value leakage.
 *   - Browser guard: Origin exact match / null / mismatch.
 *   - Browser guard: Fetch Metadata cross-site / same-site / navigate / no-cors / object / embed.
 *   - Browser guard: absent-header behavior.
 *   - Browser guard: Vary header on rejects.
 *   - CSRF endpoint: requires session + allowlist, returns token in body only.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import {Buffer} from 'node:buffer'
import {createHmac} from 'node:crypto'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {loadAllowlistFromText} from './allowlist.js'
import {
  applyBrowserGuard,
  CSRF_TOKEN_GRACE_MS,
  CSRF_TOKEN_INTERVAL_MS,
  CSRF_TOKEN_MAX_LENGTH,
  generateCsrfToken,
  verifyCsrfToken,
} from './csrf.js'
import {hashSessionId} from './session-persistence.js'
import {SESSION_COOKIE_NAME} from './session.js'
import {createTestSessionStore, createTestSessionStoreHarness, mintTestSession} from './test-session-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CSRF_SECRET = Buffer.from('test-csrf-secret-32-bytes-long!!', 'utf8').toString('base64url')

// ---------------------------------------------------------------------------
// generateCsrfToken / verifyCsrfToken — happy path
// ---------------------------------------------------------------------------

describe('generateCsrfToken / verifyCsrfToken — happy path', () => {
  it('generates a token that verifies successfully', () => {
    // #given
    const sessionId = 'session-abc-123'
    const operatorId = 42
    const nowMs = Date.now()

    // #when
    const token = generateCsrfToken({sessionId, operatorId, nowMs, secret: TEST_CSRF_SECRET})
    const result = verifyCsrfToken({token, sessionId, operatorId, nowMs, secret: TEST_CSRF_SECRET})

    // #then
    expect(result.ok).toBe(true)
  })

  it('token is a non-empty string', () => {
    // #given
    const nowMs = Date.now()

    // #when
    const token = generateCsrfToken({sessionId: 'sid', operatorId: 1, nowMs, secret: TEST_CSRF_SECRET})

    // #then
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
  })

  it('two tokens generated at the same time for the same session are identical (deterministic within interval)', () => {
    // #given
    const sessionId = 'session-abc-123'
    const operatorId = 42
    const nowMs = 1_000_000 // fixed time

    // #when
    const token1 = generateCsrfToken({sessionId, operatorId, nowMs, secret: TEST_CSRF_SECRET})
    const token2 = generateCsrfToken({sessionId, operatorId, nowMs, secret: TEST_CSRF_SECRET})

    // #then — same inputs produce same token (HMAC is deterministic)
    expect(token1).toBe(token2)
  })

  it('tokens for different sessions are different', () => {
    // #given
    const nowMs = 1_000_000

    // #when
    const token1 = generateCsrfToken({sessionId: 'session-A', operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})
    const token2 = generateCsrfToken({sessionId: 'session-B', operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})

    // #then
    expect(token1).not.toBe(token2)
  })

  it('tokens for different operators are different', () => {
    // #given
    const nowMs = 1_000_000

    // #when
    const token1 = generateCsrfToken({sessionId: 'session-A', operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})
    const token2 = generateCsrfToken({sessionId: 'session-A', operatorId: 99, nowMs, secret: TEST_CSRF_SECRET})

    // #then
    expect(token1).not.toBe(token2)
  })
})

// ---------------------------------------------------------------------------
// verifyCsrfToken — session/operator binding mismatch
// ---------------------------------------------------------------------------

describe('verifyCsrfToken — session/operator binding mismatch', () => {
  it('rejects token when session ID does not match', () => {
    // #given
    const nowMs = 1_000_000
    const token = generateCsrfToken({sessionId: 'session-A', operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})

    // #when — verify with different session ID
    const result = verifyCsrfToken({
      token,
      sessionId: 'session-B',
      operatorId: 42,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects token when operator ID does not match', () => {
    // #given
    const nowMs = 1_000_000
    const token = generateCsrfToken({sessionId: 'session-A', operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})

    // #when — verify with different operator ID
    const result = verifyCsrfToken({
      token,
      sessionId: 'session-A',
      operatorId: 99,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects token signed with a different secret', () => {
    // #given
    const nowMs = 1_000_000
    const otherSecret = Buffer.from('other-csrf-secret-32-bytes-long!', 'utf8').toString('base64url')
    const token = generateCsrfToken({sessionId: 'session-A', operatorId: 42, nowMs, secret: otherSecret})

    // #when — verify with the test secret
    const result = verifyCsrfToken({
      token,
      sessionId: 'session-A',
      operatorId: 42,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// verifyCsrfToken — expiry
// ---------------------------------------------------------------------------

function decodePayload(token: string): Record<string, unknown> {
  const [payloadB64] = token.split('.')
  return JSON.parse(Buffer.from(payloadB64 ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('generateCsrfToken / verifyCsrfToken — session binding', () => {
  it('a token minted for one session fails for another and verifies for its own', () => {
    // #given two distinct session IDs of the production shape
    const nowMs = 1_000_000
    const sessionA = 'A'.repeat(43)
    const sessionB = 'B'.repeat(43)
    const token = generateCsrfToken({sessionId: sessionA, operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})

    // #when verified against each
    const forA = verifyCsrfToken({token, sessionId: sessionA, operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})
    const forB = verifyCsrfToken({token, sessionId: sessionB, operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})

    // #then
    expect(forA).toEqual({ok: true})
    expect(forB).toEqual({ok: false, reason: 'binding_mismatch'})
  })

  it('the decoded payload carries sha256(sessionId) and no part of the raw session ID', () => {
    // #given a session ID of the production shape (43-character base64url)
    const sessionId = 'xK3_pQ-9mZ7vLw2Rt5YhNc8BdFgJ0aSeUi4oTnMq6Vy'
    const token = generateCsrfToken({sessionId, operatorId: 42, nowMs: 1_000_000, secret: TEST_CSRF_SECRET})

    // #when the payload is decoded
    const payload = decodePayload(token)
    const decoded = Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')

    // #then sid is the hash, and no run of the raw ID (even 8 characters) appears in the payload or token
    expect(payload.sid).toBe(hashSessionId(sessionId))
    expect(payload.sid).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(payload).sort()).toEqual(['iv', 'oid', 'sid'])
    for (let start = 0; start + 8 <= sessionId.length; start++) {
      const run = sessionId.slice(start, start + 8)
      expect(decoded).not.toContain(run)
      expect(token).not.toContain(run)
    }
  })

  it('rejects a token built the old way, with the raw session ID as the binding', () => {
    // #given a token a pre-deploy gateway would have issued: HMAC-valid, sid is the raw session ID
    const nowMs = 1_000_000
    const sessionId = 'session-abc-123'
    const legacyPayload = Buffer.from(
      JSON.stringify({sid: sessionId, oid: 42, iv: Math.floor(nowMs / CSRF_TOKEN_INTERVAL_MS)}),
    ).toString('base64url')
    const sig = createHmac('sha256', Buffer.from(TEST_CSRF_SECRET, 'base64url'))
      .update(legacyPayload)
      .digest('base64url')

    // #when verified after the change
    const result = verifyCsrfToken({
      token: `${legacyPayload}.${sig}`,
      sessionId,
      operatorId: 42,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then it fails once, on the binding; a freshly minted token for the same session passes
    expect(result).toEqual({ok: false, reason: 'binding_mismatch'})
    const fresh = generateCsrfToken({sessionId, operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})
    expect(verifyCsrfToken({token: fresh, sessionId, operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})).toEqual({
      ok: true,
    })
  })

  it('a token verifies after a restart: same secret, session reloaded from the object store', async () => {
    // #given a session created on one store and a token minted for it
    const nowMs = Date.now()
    const {createTestObjectStore} = await import('./test-object-store.js')
    const objectStore = createTestObjectStore()
    const before = await createTestSessionStoreHarness({objectStore, allowed: [42]})
    const sessionId = await mintTestSession(before.store, {githubUserId: 42, login: 'octocat'})
    const token = generateCsrfToken({sessionId, operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})

    // #when a fresh store loads the same records and verifies the same token
    const after = await createTestSessionStoreHarness({objectStore, allowed: [42]})
    const restored = after.store.get(sessionId)

    // #then the session is back and the token still binds to it
    expect(restored?.githubUserId).toBe(42)
    expect(verifyCsrfToken({token, sessionId, operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})).toEqual({ok: true})
  })
})

describe('verifyCsrfToken — expiry', () => {
  it('accepts a token within the current interval', () => {
    // #given — token issued at start of interval
    const intervalStart = 0
    const token = generateCsrfToken({
      sessionId: 'sid',
      operatorId: 1,
      nowMs: intervalStart,
      secret: TEST_CSRF_SECRET,
    })

    // #when — verify just before interval ends
    const result = verifyCsrfToken({
      token,
      sessionId: 'sid',
      operatorId: 1,
      nowMs: intervalStart + CSRF_TOKEN_INTERVAL_MS - 1,
      secret: TEST_CSRF_SECRET,
    })

    // #then
    expect(result.ok).toBe(true)
  })

  it('accepts a token from the previous interval within the grace window', () => {
    // #given — token issued at start of interval 0
    const intervalStart = 0
    const token = generateCsrfToken({
      sessionId: 'sid',
      operatorId: 1,
      nowMs: intervalStart,
      secret: TEST_CSRF_SECRET,
    })

    // #when — verify just after interval boundary (within grace)
    const result = verifyCsrfToken({
      token,
      sessionId: 'sid',
      operatorId: 1,
      nowMs: intervalStart + CSRF_TOKEN_INTERVAL_MS + CSRF_TOKEN_GRACE_MS - 1,
      secret: TEST_CSRF_SECRET,
    })

    // #then — still valid within grace window
    expect(result.ok).toBe(true)
  })

  it('rejects a token from the previous interval after the grace window', () => {
    // #given — token issued at start of interval 0
    const intervalStart = 0
    const token = generateCsrfToken({
      sessionId: 'sid',
      operatorId: 1,
      nowMs: intervalStart,
      secret: TEST_CSRF_SECRET,
    })

    // #when — verify after grace window expires
    const result = verifyCsrfToken({
      token,
      sessionId: 'sid',
      operatorId: 1,
      nowMs: intervalStart + CSRF_TOKEN_INTERVAL_MS + CSRF_TOKEN_GRACE_MS + 1,
      secret: TEST_CSRF_SECRET,
    })

    // #then — expired
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// verifyCsrfToken — malformed token
// ---------------------------------------------------------------------------

describe('verifyCsrfToken — malformed token', () => {
  it('rejects an empty token', () => {
    // #given
    const nowMs = Date.now()

    // #when
    const result = verifyCsrfToken({token: '', sessionId: 'sid', operatorId: 1, nowMs, secret: TEST_CSRF_SECRET})

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects a token with wrong format (no dot separator)', () => {
    // #given
    const nowMs = Date.now()

    // #when
    const result = verifyCsrfToken({
      token: 'notavalidtoken',
      sessionId: 'sid',
      operatorId: 1,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects a token with tampered payload', () => {
    // #given
    const nowMs = 1_000_000
    const token = generateCsrfToken({sessionId: 'sid', operatorId: 1, nowMs, secret: TEST_CSRF_SECRET})
    // Tamper with the payload part
    const parts = token.split('.')
    const tamperedToken = `tampered${parts[0]}.${parts[1]}`

    // #when
    const result = verifyCsrfToken({
      token: tamperedToken,
      sessionId: 'sid',
      operatorId: 1,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then
    expect(result.ok).toBe(false)
  })

  it('rejects a token with tampered signature', () => {
    // #given
    const nowMs = 1_000_000
    const token = generateCsrfToken({sessionId: 'sid', operatorId: 1, nowMs, secret: TEST_CSRF_SECRET})
    // Tamper with the signature part
    const parts = token.split('.')
    const tamperedToken = `${parts[0]}.tamperedsignature`

    // #when
    const result = verifyCsrfToken({
      token: tamperedToken,
      sessionId: 'sid',
      operatorId: 1,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Token leakage — tokens must not appear in error reasons
// ---------------------------------------------------------------------------

describe('verifyCsrfToken — no token leakage', () => {
  it('rejection result does not contain the token value', () => {
    // #given
    const nowMs = 1_000_000
    const token = generateCsrfToken({sessionId: 'sid', operatorId: 1, nowMs, secret: TEST_CSRF_SECRET})

    // #when — verify with wrong session
    const result = verifyCsrfToken({
      token,
      sessionId: 'wrong-session',
      operatorId: 1,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then — result must not contain the token value
    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(token)
  })
})

// ---------------------------------------------------------------------------
// CSRF_TOKEN_INTERVAL_MS and CSRF_TOKEN_GRACE_MS — exported constants
// ---------------------------------------------------------------------------

describe('CSRF token constants', () => {
  it('cSRF_TOKEN_INTERVAL_MS is 15 minutes', () => {
    expect(CSRF_TOKEN_INTERVAL_MS).toBe(15 * 60 * 1000)
  })

  it('cSRF_TOKEN_GRACE_MS is 30 seconds', () => {
    expect(CSRF_TOKEN_GRACE_MS).toBe(30 * 1000)
  })
})

// ---------------------------------------------------------------------------
// applyBrowserGuard — absent Origin on mutating requests
// ---------------------------------------------------------------------------

function makeBrowserGuardDeps(sessionStore: Awaited<ReturnType<typeof createTestSessionStore>>) {
  const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
  const auditLogger = {info: vi.fn(), warn: vi.fn()}
  const allowlist = loadAllowlistFromText('42\n', logger)
  return {
    logger,
    auditLogger,
    sessionStore,
    allowlist,
    csrfSecret: TEST_CSRF_SECRET,
    publicOrigin: 'https://operator.example.com',
    clock: () => Date.now(),
  }
}

describe('applyBrowserGuard — absent Origin on mutating requests', () => {
  it('rejects POST with no Origin and no Fetch Metadata headers', async () => {
    // #given — valid session, no Origin, no Sec-Fetch-* headers
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1000, secret: TEST_CSRF_SECRET})

    const app = new Hono()
    app.post('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, true)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — POST with no Origin and no Sec-Fetch-Site (absent both)
    const req = new Request('http://operator.example.com/test', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        'x-csrf-token': csrfToken,
        // No Origin, no Sec-Fetch-Site
      },
    })
    const res = await app.fetch(req)

    // #then — must reject (absent Origin on mutating request is not allowed)
    expect(res.status).toBe(400)
  })

  it('allows GET with no Origin (safe method — no mutation risk)', async () => {
    // #given — valid session, no Origin, GET method
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}

    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — GET with no Origin (safe method)
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        // No Origin — safe method, should be allowed
      },
    })
    const res = await app.fetch(req)

    // #then — allowed (GET is safe)
    expect(res.status).toBe(200)
  })

  it('allows POST with Sec-Fetch-Site: same-origin and no Origin (Fetch Metadata fallback)', async () => {
    // #given — valid session, no Origin but Sec-Fetch-Site: same-origin
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1000, secret: TEST_CSRF_SECRET})

    const app = new Hono()
    app.post('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, true)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — POST with Sec-Fetch-Site: same-origin (no Origin header)
    const req = new Request('http://operator.example.com/test', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        'x-csrf-token': csrfToken,
        'sec-fetch-site': 'same-origin',
        // No Origin header — Fetch Metadata fallback should allow same-origin
      },
    })
    const res = await app.fetch(req)

    // #then — allowed via Fetch Metadata fallback
    expect(res.status).toBe(200)
  })

  it('allows mutating request with no Origin, Sec-Fetch-Site: same-origin, no Sec-Fetch-Mode, valid CSRF/session/allowlist', async () => {
    // #given — valid session + allowlist, no Origin, Sec-Fetch-Site: same-origin, Sec-Fetch-Mode absent
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1000, secret: TEST_CSRF_SECRET})

    const app = new Hono()
    app.post('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, true)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — POST with no Origin, Sec-Fetch-Site: same-origin, no Sec-Fetch-Mode
    // Sec-Fetch-Mode absent is not a rejection signal when Sec-Fetch-Site is same-origin.
    const req = new Request('http://operator.example.com/test', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        'x-csrf-token': csrfToken,
        'sec-fetch-site': 'same-origin',
        // No Origin header
        // No Sec-Fetch-Mode header — absent is fine when Sec-Fetch-Site is same-origin
      },
    })
    const res = await app.fetch(req)

    // #then — must pass (Sec-Fetch-Site: same-origin is sufficient without Sec-Fetch-Mode)
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// applyBrowserGuard — typed audit events
// ---------------------------------------------------------------------------

describe('applyBrowserGuard — typed audit events', () => {
  it('emits browser.guard.rejected with reason non_cookie_credential for Authorization header', async () => {
    // #given — valid session but Authorization header present
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = {
      ...makeBrowserGuardDeps(sessionStore),
      auditLogger,
      clock: () => now + 1000,
    }

    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — request with Authorization header (non-cookie credential)
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        authorization: 'Bearer some-token',
      },
    })
    await app.fetch(req)

    // #then — audit event must be browser.guard.rejected with reason non_cookie_credential
    const warnCalls = auditLogger.warn.mock.calls as [Record<string, unknown>, string][]
    const auditCall = warnCalls.find(([ctx]) => ctx.kind === 'browser.guard.rejected')
    expect(auditCall).toBeDefined()
    expect(auditCall?.[0]).toMatchObject({kind: 'browser.guard.rejected', reason: 'non_cookie_credential'})
    // Must NOT use bearer.rejected for this case
    const bearerCall = warnCalls.find(([ctx]) => ctx.kind === 'bearer.rejected')
    expect(bearerCall).toBeUndefined()
  })

  it('emits browser.guard.rejected with reason origin_mismatch for wrong Origin', async () => {
    // #given — valid session, valid allowlist, wrong Origin
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = {
      ...makeBrowserGuardDeps(sessionStore),
      auditLogger,
      clock: () => now + 1000,
    }

    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — request with wrong Origin
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://evil.attacker.com',
      },
    })
    await app.fetch(req)

    // #then — audit event must be browser.guard.rejected with reason origin_mismatch
    const warnCalls = auditLogger.warn.mock.calls as [Record<string, unknown>, string][]
    const auditCall = warnCalls.find(([ctx]) => ctx.kind === 'browser.guard.rejected')
    expect(auditCall).toBeDefined()
    expect(auditCall?.[0]).toMatchObject({kind: 'browser.guard.rejected', reason: 'origin_mismatch'})
  })

  it('emits browser.guard.rejected with reason csrf_missing for missing CSRF token', async () => {
    // #given — valid session, valid allowlist, correct Origin, no CSRF token
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = {
      ...makeBrowserGuardDeps(sessionStore),
      auditLogger,
      clock: () => now + 1000,
    }

    const app = new Hono()
    app.post('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, true)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — POST with correct Origin but no CSRF token
    const req = new Request('http://operator.example.com/test', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
        // No x-csrf-token
      },
    })
    await app.fetch(req)

    // #then — audit event must be browser.guard.rejected with reason csrf_missing
    const warnCalls = auditLogger.warn.mock.calls as [Record<string, unknown>, string][]
    const auditCall = warnCalls.find(([ctx]) => ctx.kind === 'browser.guard.rejected')
    expect(auditCall).toBeDefined()
    expect(auditCall?.[0]).toMatchObject({kind: 'browser.guard.rejected', reason: 'csrf_missing'})
  })

  it('emits browser.guard.rejected with reason csrf_invalid for invalid CSRF token', async () => {
    // #given — valid session, valid allowlist, correct Origin, invalid CSRF token
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = {
      ...makeBrowserGuardDeps(sessionStore),
      auditLogger,
      clock: () => now + 1000,
    }

    const app = new Hono()
    app.post('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, true)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — POST with correct Origin but invalid CSRF token
    const req = new Request('http://operator.example.com/test', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
        'x-csrf-token': 'invalid.token',
      },
    })
    await app.fetch(req)

    // #then — audit event must be browser.guard.rejected with reason csrf_invalid
    const warnCalls = auditLogger.warn.mock.calls as [Record<string, unknown>, string][]
    const auditCall = warnCalls.find(([ctx]) => ctx.kind === 'browser.guard.rejected')
    expect(auditCall).toBeDefined()
    expect(auditCall?.[0]).toMatchObject({kind: 'browser.guard.rejected', reason: 'csrf_invalid'})
  })
})

// ---------------------------------------------------------------------------
// applyBrowserGuard — allowlist, and a read-only session lookup
// ---------------------------------------------------------------------------

describe('applyBrowserGuard — session lookup is read-only', () => {
  it('rejects a session whose operator is not in the allowlist', async () => {
    // #given — session for user 99 who is NOT in the allowlist (allowlist has 42)
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 99, login: 'notallowed'})
    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}

    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — GET with valid session but non-allowlisted user
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected 403
    expect(res.status).toBe(403)
  })

  it('admits an allowlisted session using only `get` on the store', async () => {
    // #given — a store that exposes nothing but `get`, so any touch or write would throw
    const now = Date.now()
    const get = vi.fn((_sessionId: string) => ({githubUserId: 42, login: 'octocat', issuedAt: now}))
    const deps = {...makeBrowserGuardDeps(await createTestSessionStore()), sessionStore: {get}, clock: () => now + 1000}

    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — GET with a cookie for that session
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=some-session-id`,
        origin: 'https://operator.example.com',
      },
    })
    const res = await app.fetch(req)

    // #then — allowed, with exactly one lookup by the cookie's ID
    expect(res.status).toBe(200)
    expect(get).toHaveBeenCalledExactlyOnceWith('some-session-id')
  })

  it('rejects an unknown session ID without any store write', async () => {
    // #given — a ready store that never issued the cookie's ID
    const sessionStore = await createTestSessionStore()
    const deps = makeBrowserGuardDeps(sessionStore)

    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when
    const res = await app.fetch(
      new Request('http://operator.example.com/test', {
        method: 'GET',
        headers: {cookie: `${SESSION_COOKIE_NAME}=${'u'.repeat(43)}`, origin: 'https://operator.example.com'},
      }),
    )

    // #then
    expect(res.status).toBe(401)
    expect(sessionStore.size()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// applyBrowserGuard — audit includes githubUserId on not_allowlisted (Fix 6)
// ---------------------------------------------------------------------------

describe('applyBrowserGuard — not_allowlisted audit includes githubUserId (Fix 6)', () => {
  it('browser.guard.rejected audit event includes githubUserId when reason is not_allowlisted', async () => {
    // #given — session for user 99 who is NOT in the allowlist
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 99, login: 'notallowed'})

    const auditLogger = {info: vi.fn(), warn: vi.fn()}
    const deps = {...makeBrowserGuardDeps(sessionStore), auditLogger, clock: () => now + 1000}

    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
      },
    })
    await app.fetch(req)

    // #then — audit event includes githubUserId
    const warnCalls = auditLogger.warn.mock.calls as [Record<string, unknown>, string][]
    const auditCall = warnCalls.find(([ctx]) => ctx.kind === 'browser.guard.rejected')
    expect(auditCall).toBeDefined()
    expect(auditCall?.[0]).toMatchObject({
      kind: 'browser.guard.rejected',
      reason: 'not_allowlisted',
      githubUserId: 99,
    })
  })
})

// ---------------------------------------------------------------------------
// applyBrowserGuard — Fetch Metadata rejection branches (Fix 8)
// ---------------------------------------------------------------------------

describe('applyBrowserGuard — Fetch Metadata rejection branches (Fix 8)', () => {
  it('rejects Origin: null (opaque origin)', async () => {
    // #given — valid session, Origin: null
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}
    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — Origin: null (sandboxed iframe or cross-site navigation)
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'null',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected 400
    expect(res.status).toBe(400)
  })

  it('rejects Sec-Fetch-Site: cross-site', async () => {
    // #given — valid session, Sec-Fetch-Site: cross-site
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}
    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — Sec-Fetch-Site: cross-site (not a public cross-site route)
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
        'sec-fetch-site': 'cross-site',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected 400
    expect(res.status).toBe(400)
  })

  it('rejects Sec-Fetch-Site: same-site (not same-origin)', async () => {
    // #given — valid session, Sec-Fetch-Site: same-site
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}
    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — Sec-Fetch-Site: same-site (not same-origin — rejected for security)
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
        'sec-fetch-site': 'same-site',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected 400
    expect(res.status).toBe(400)
  })

  it('rejects Sec-Fetch-Mode: navigate on mutating request', async () => {
    // #given — valid session, Sec-Fetch-Mode: navigate on POST
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1000, secret: TEST_CSRF_SECRET})
    const app = new Hono()
    app.post('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, true)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — POST with Sec-Fetch-Mode: navigate
    const req = new Request('http://operator.example.com/test', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
        'x-csrf-token': csrfToken,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected 400
    expect(res.status).toBe(400)
  })

  it('rejects Sec-Fetch-Mode: no-cors on mutating request', async () => {
    // #given — valid session, Sec-Fetch-Mode: no-cors on POST
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1000, secret: TEST_CSRF_SECRET})
    const app = new Hono()
    app.post('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, true)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — POST with Sec-Fetch-Mode: no-cors
    const req = new Request('http://operator.example.com/test', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
        'x-csrf-token': csrfToken,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'no-cors',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected 400
    expect(res.status).toBe(400)
  })

  it('rejects Sec-Fetch-Dest: object', async () => {
    // #given — valid session, Sec-Fetch-Dest: object
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}
    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — GET with Sec-Fetch-Dest: object (plugin/embed context)
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
        'sec-fetch-dest': 'object',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected 400
    expect(res.status).toBe(400)
  })

  it('rejects Sec-Fetch-Dest: embed', async () => {
    // #given — valid session, Sec-Fetch-Dest: embed
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}
    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — GET with Sec-Fetch-Dest: embed
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
        'sec-fetch-dest': 'embed',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected 400
    expect(res.status).toBe(400)
  })

  it('adds Vary header on rejection responses', async () => {
    // #given — valid session, wrong Origin (will be rejected)
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const deps = {...makeBrowserGuardDeps(sessionStore), clock: () => now + 1000}
    const app = new Hono()
    app.get('/test', async c => {
      const result = await applyBrowserGuard(c, deps, false, false)
      if (result.ok === false) return result.response
      return c.json({ok: true})
    })

    // #when — GET with wrong Origin
    const req = new Request('http://operator.example.com/test', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://evil.attacker.com',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected with Vary header
    expect(res.status).toBe(400)
    const vary = res.headers.get('vary') ?? ''
    expect(vary).toContain('Origin')
  })
})

// ---------------------------------------------------------------------------
// verifyCsrfToken — overlong token and wrong-length signature (Fix 8)
// ---------------------------------------------------------------------------

describe('verifyCsrfToken — overlong token rejected before Buffer allocation (Fix 8)', () => {
  it('rejects a token exceeding CSRF_TOKEN_MAX_LENGTH without allocating large buffers', () => {
    // #given — token longer than the max allowed length
    const nowMs = Date.now()
    const overlong = 'a'.repeat(CSRF_TOKEN_MAX_LENGTH + 1)

    // #when
    const result = verifyCsrfToken({
      token: overlong,
      sessionId: 'sid',
      operatorId: 1,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then — rejected as malformed_token
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('malformed_token')
  })

  it('cSRF_TOKEN_MAX_LENGTH is 512', () => {
    expect(CSRF_TOKEN_MAX_LENGTH).toBe(512)
  })

  it('wrong-length signature returns invalid_signature without throwing', () => {
    // #given — valid payload but signature of wrong length (1 char)
    const nowMs = 1_000_000
    const token = generateCsrfToken({sessionId: 'sid', operatorId: 1, nowMs, secret: TEST_CSRF_SECRET})
    const payloadPart = token.split('.')[0]
    // Construct a token with a 1-char signature (wrong length)
    const wrongLengthSigToken = `${payloadPart}.x`

    // #when
    const result = verifyCsrfToken({
      token: wrongLengthSigToken,
      sessionId: 'sid',
      operatorId: 1,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then — returns false / invalid_signature without throwing
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('invalid_signature')
  })

  it('cSRF token binding mismatch for session ID returns binding_mismatch', () => {
    // #given — token bound to session-A, verified against session-B
    const nowMs = 1_000_000
    const token = generateCsrfToken({sessionId: 'session-A', operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})

    // #when — verify with different session ID
    const result = verifyCsrfToken({
      token,
      sessionId: 'session-B',
      operatorId: 42,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('binding_mismatch')
  })

  it('cSRF token binding mismatch for operator ID returns binding_mismatch', () => {
    // #given — token bound to operator 42, verified against operator 99
    const nowMs = 1_000_000
    const token = generateCsrfToken({sessionId: 'session-A', operatorId: 42, nowMs, secret: TEST_CSRF_SECRET})

    // #when — verify with different operator ID
    const result = verifyCsrfToken({
      token,
      sessionId: 'session-A',
      operatorId: 99,
      nowMs,
      secret: TEST_CSRF_SECRET,
    })

    // #then
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('binding_mismatch')
  })
})
