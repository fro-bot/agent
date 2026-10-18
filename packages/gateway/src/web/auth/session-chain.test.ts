/**
 * End-to-end session chain over the real routes, guard and durable store, with a "restart" modelled as a
 * fresh store (and app) loaded from the same object-store fake:
 *
 *   login -> restart -> session still valid -> logout -> restart -> session gone
 *
 * Uses BDD comments (#given, #when, #then).
 */

import type {GitHubOAuthDeps} from './github.js'
import type {TestObjectStore} from './test-object-store.js'

import {Buffer} from 'node:buffer'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import {makeDirectIngressPolicy} from '../ingress/policy.js'
import {unsafeResolvedClientAddressForTest} from '../ingress/resolve-client.js'
import {buildOperatorApp} from '../server.js'
import {generateCsrfToken} from './csrf.js'
import {buildGitHubOAuthDeps, createInMemoryStateStore} from './github.js'
import {DURABLE_SESSION_TTL_MS, SESSION_COOKIE_NAME} from './session.js'
import {createTestObjectStore} from './test-object-store.js'
import {createTestSessionStoreHarness} from './test-session-store.js'

const ORIGIN = 'https://operator.example.com'
const CSRF_SECRET = Buffer.from('chain-test-csrf-secret-32-bytes!!', 'utf8').toString('base64url')
const OPERATOR_ID = 4242
const CLIENT = {incoming: {socket: {remoteAddress: '203.0.113.9'}}}

function makeLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

/** One gateway "process": a loaded store over `objectStore`, and an app wired the way program.ts wires it. */
async function boot(objectStore: TestObjectStore, hook: (githubUserId: number) => void) {
  const logger = makeLogger()
  const auditLogger = {info: vi.fn(), warn: vi.fn()}
  const allowlist = {isAuthorized: (id: number) => id === OPERATOR_ID, size: 1}
  const harness = await createTestSessionStoreHarness({objectStore, allowed: [OPERATOR_ID], onSessionRevoked: hook})
  const sessionDeps = {logger, auditLogger, clock: () => Date.now()}
  const stateStore = createInMemoryStateStore()
  stateStore.set('chain-state-value', {
    codeVerifier: 'chain-verifier-32-bytes-long-enough-for-pkce',
    issuedAt: Date.now(),
    consumed: false,
  })
  const githubOAuth: GitHubOAuthDeps = {
    ...buildGitHubOAuthDeps(
      logger,
      auditLogger,
      () => Effect.succeed(unsafeResolvedClientAddressForTest('chain-key')),
      {allow: () => true},
      harness.store,
      sessionDeps,
      allowlist,
    ),
    stateStore,
    fetch: vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      return target.includes('login/oauth/access_token')
        ? Response.json({access_token: 'ghs_CHAIN_TOKEN', token_type: 'bearer'})
        : Response.json({id: OPERATOR_ID, login: 'octocat'})
    }),
  }
  const app = buildOperatorApp(
    {
      logger,
      isShuttingDown: () => false,
      githubOAuth,
      sessionStore: harness.store,
      sessionDeps,
      allowlist,
      csrfSecret: CSRF_SECRET,
      auditLogger,
    },
    {
      bindHost: '127.0.0.1',
      bindPort: 0,
      publicOrigin: ORIGIN,
      ingressPolicy: makeDirectIngressPolicy(),
      githubOAuth: {
        clientId: 'chain-client',
        clientSecret: 'chain-secret',
        publicOrigin: ORIGIN,
        callbackPath: '/operator/auth/github/callback',
        allowedReturnPaths: ['/operator/dashboard'],
        maxOutstandingAttemptsPerKey: 5,
        stateTtlMs: 600_000,
      },
    },
  )
  const withCookie = (sessionId: string, init: RequestInit = {}) => ({
    ...init,
    headers: {...init.headers, cookie: `${SESSION_COOKIE_NAME}=${sessionId}`, origin: ORIGIN},
  })
  return {
    app,
    login: async () =>
      app.fetch(new Request(`${ORIGIN}/operator/auth/github/callback?code=c&state=chain-state-value`), CLIENT),
    readSession: async (sessionId: string) =>
      app.fetch(new Request(`${ORIGIN}/operator/session`, withCookie(sessionId)), CLIENT),
    logout: async (sessionId: string) =>
      app.fetch(
        new Request(
          `${ORIGIN}/operator/auth/logout`,
          withCookie(sessionId, {
            method: 'POST',
            headers: {
              'x-csrf-token': generateCsrfToken({
                sessionId,
                operatorId: OPERATOR_ID,
                nowMs: Date.now(),
                secret: CSRF_SECRET,
              }),
            },
          }),
        ),
        CLIENT,
      ),
  }
}

describe('operator session chain across restarts', () => {
  it('login, restart, still valid, logout, restart, gone', async () => {
    // #given a gateway process with a fresh object store
    const objectStore = createTestObjectStore()
    const hook = vi.fn()
    const first = await boot(objectStore, hook)

    // #when the operator logs in through the real callback
    const loginRes = await first.login()
    const cookie = loginRes.headers
      .getSetCookie()
      .find(h => h.startsWith(`${SESSION_COOKIE_NAME}=`) && h.includes('Max-Age=0') === false)
    const sessionId = cookie?.split(';')[0]?.slice(SESSION_COOKIE_NAME.length + 1)
    if (sessionId === undefined) throw new Error('expected the callback to set a session cookie')

    // #then the cookie is durable-lifetime and the session reads back
    expect(loginRes.status).toBe(302)
    expect(cookie).toContain('Max-Age=604800')
    const beforeRestart = await first.readSession(sessionId)
    expect(beforeRestart.status).toBe(200)
    const issuedExpiry = ((await beforeRestart.json()) as {expiresAt: number}).expiresAt

    // #when the gateway restarts (a new store and app load from the same object store)
    const second = await boot(objectStore, hook)
    const afterRestart = await second.readSession(sessionId)

    // #then the same cookie is still accepted, with the same fixed expiry
    expect(afterRestart.status).toBe(200)
    const restored = (await afterRestart.json()) as {operatorId: number; login: string; expiresAt: number}
    expect(restored).toMatchObject({operatorId: OPERATOR_ID, login: 'octocat'})
    expect(restored.expiresAt).toBe(issuedExpiry)
    expect(restored.expiresAt - DURABLE_SESSION_TTL_MS).toBeLessThanOrEqual(Date.now())

    // #when the operator logs out on the restored process
    const logoutRes = await second.logout(sessionId)

    // #then logout is durable: 200, the cookie is cleared, and the revoke hook fired once for the operator
    expect(logoutRes.status).toBe(200)
    expect(logoutRes.headers.get('set-cookie')?.toLowerCase()).toContain('max-age=0')
    expect(hook).toHaveBeenCalledExactlyOnceWith(OPERATOR_ID)
    expect((await second.readSession(sessionId)).status).toBe(401)

    // #when the gateway restarts again
    const third = await boot(objectStore, hook)

    // #then the logged-out session stays gone
    expect((await third.readSession(sessionId)).status).toBe(401)
  })
})
