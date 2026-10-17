/**
 * Tests for the operator web listener.
 *
 * Covers:
 *   - Happy path: listener starts only when all required config is present.
 *   - Error path: partial config fails closed during startup.
 *   - Security: unauthenticated floods hit socket-keyed rate limits and bounded body handling.
 *   - Shutdown: closing the Gateway closes the operator server without hanging active handles.
 *   - Health route: GET /operator/health returns 200 {ok:true, contractVersion}.
 *   - Rate limiter: limit enforcement, window reset, key isolation.
 *   - Forwarded headers: no headers, only host, only proto, proto=http, host with port, comma-separated.
 *   - Drain gate: returns 503 before body-limit (drain fires first).
 *   - Warning log: coarse warning on drain/rejection paths.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import type {AddressInfo} from 'node:net'
import type {RunState} from '@fro-bot/runtime'
import type {ServerType} from '@hono/node-server'

import type {GitHubOAuthConfig, GitHubOAuthDeps} from './auth/github.js'
import type {SessionDeps} from './auth/session.js'
import type {ResolvedClientAddress} from './ingress/resolve-client.js'
import type {OperatorServerConfig, OperatorServerDeps} from './server.js'
import {Buffer} from 'node:buffer'
import {createServer} from 'node:http'

import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import {createRateLimiter} from '../http/rate-limit.js'
import {OPERATOR_CONTRACT_VERSION} from '../operator-contract/index.js'
import {loadAllowlistFromText} from './auth/allowlist.js'
import {generateCsrfToken} from './auth/csrf.js'
import {createInMemoryStateStore} from './auth/github.js'
import {SESSION_COOKIE_NAME} from './auth/session.js'
import {createTestSessionStore, mintTestSession} from './auth/test-session-store.js'
import {makeDirectIngressPolicy, makeTrustedProxyIngressPolicy} from './ingress/policy.js'
import {unsafeResolvedClientAddressForTest} from './ingress/resolve-client.js'
import {parseTrustedProxyAddress} from './ingress/trusted-proxy-address.js'
import {EXPECTED_OPERATOR_ROUTES} from './operator-route-smoke.js'
import {isPrivilegedRoute, isPublicCrossSiteRoute, isPublicRoute} from './operator-route.js'
import {buildOperatorApp, createOperatorServer} from './server.js'
import {createRunObservationManager} from './sse/manager.js'

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

function makeLogger(): OperatorServerDeps['logger'] {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeStubDeps(overrides?: Partial<OperatorServerDeps>): OperatorServerDeps {
  return {
    logger: makeLogger(),
    isShuttingDown: () => false,
    ...overrides,
  }
}

function makeStubConfig(overrides?: Partial<OperatorServerConfig>): OperatorServerConfig {
  return {
    // Use 127.0.0.1 in tests — the production guard (no 127.0.0.1 for operator)
    // is enforced at config-load time, not in the server factory itself.
    bindHost: '127.0.0.1',
    bindPort: 0,
    publicOrigin: 'https://operator.example.com',
    // Default: no reverse proxy trusted. Real test requests over loopback
    // (127.0.0.1) are therefore an untrusted peer — X-Forwarded-For is
    // ignored, and any supplied X-Forwarded-Host/-Proto is rejected. Tests
    // exercising the trusted-peer path override this with TRUSTED_PROXY_POLICY.
    ingressPolicy: makeDirectIngressPolicy(),
    ...overrides,
  }
}

/**
 * Ingress policy trusting 127.0.0.1 as a reverse-proxy peer — real test
 * requests made via fetch() against a loopback-bound createOperatorServer()
 * originate from exactly this address, so this is the only real (non-fabricated)
 * way to exercise the trusted-peer path with a genuine socket.
 */
function makeTrustedLoopbackPolicy() {
  return makeTrustedProxyIngressPolicy([Effect.runSync(parseTrustedProxyAddress('127.0.0.1'))])
}

interface RouteEntry {
  readonly method: string
  readonly path: string
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error: Error | undefined) => {
      if (error !== undefined) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

/** Find a free port by briefly opening a server. */
async function findFreePort(): Promise<number> {
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

// ---------------------------------------------------------------------------
// buildOperatorApp — route inventory
// ---------------------------------------------------------------------------

describe('buildOperatorApp — route inventory', () => {
  it('registers GET /operator/health and no other routes', () => {
    // #given
    const app = buildOperatorApp(makeStubDeps(), makeStubConfig())

    // #when — extract unique (method, path) pairs, excluding global middleware
    // entries (ALL /*). Hono registers each app.use('*', ...) call as a separate
    // ALL /* entry; we deduplicate and filter those out so the pin reflects the
    // logical route inventory, not the middleware-chain expansion.
    const seen = new Set<string>()
    const routes = app.routes
      .map((route: RouteEntry) => ({method: route.method, path: route.path}))
      .filter((route: RouteEntry) => {
        // Exclude global middleware catch-alls
        if (route.method === 'ALL' && route.path === '/*') return false
        const key = `${route.method}:${route.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    // #then — only the health route is registered (no privileged routes yet)
    expect(routes).toEqual([{method: 'GET', path: '/operator/health'}])
  })
})

// ---------------------------------------------------------------------------
// Helpers — GitHub OAuth stubs (used only in the OAuth route tests below)
// ---------------------------------------------------------------------------

function makeStubGitHubOAuthDeps(overrides?: Partial<GitHubOAuthDeps>): GitHubOAuthDeps {
  return {
    logger: makeLogger(),
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    fetch: vi.fn(async () => new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})),
    clock: () => Date.now(),
    generateVerifier: () => 'stub-verifier-32-bytes-long-enough-for-pkce',
    generateState: () => 'stub-state-value-32-bytes-long-ok',
    stateStore: createInMemoryStateStore(),
    resolveClientAddress: () => Effect.succeed(stubResolved('stub-source-key')),
    // rateLimiter is overwritten by buildOperatorApp with the shared instance;
    // provide a pass-through stub so the type is satisfied.
    rateLimiter: {allow: () => true},
    ...overrides,
  }
}

function makeStubGitHubOAuthConfig(overrides?: Partial<GitHubOAuthConfig>): GitHubOAuthConfig {
  return {
    clientId: 'stub-client-id',
    clientSecret: 'stub-client-secret',
    publicOrigin: 'https://operator.example.com',
    callbackPath: '/operator/auth/github/callback',
    allowedReturnPaths: ['/operator/dashboard'],
    maxOutstandingAttemptsPerKey: 5,
    stateTtlMs: 10 * 60 * 1000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildOperatorApp — OAuth route registration
// ---------------------------------------------------------------------------

describe('buildOperatorApp — OAuth route registration', () => {
  it('registers /operator/auth/github/start and /operator/auth/github/callback when both deps.githubOAuth and config.githubOAuth are provided', () => {
    // #given — both OAuth deps and config are present
    const app = buildOperatorApp(
      makeStubDeps({githubOAuth: makeStubGitHubOAuthDeps()}),
      makeStubConfig({githubOAuth: makeStubGitHubOAuthConfig()}),
    )

    // #when — extract unique logical routes (excluding global middleware)
    const seen = new Set<string>()
    const routes = app.routes
      .map((route: RouteEntry) => ({method: route.method, path: route.path}))
      .filter((route: RouteEntry) => {
        if (route.method === 'ALL' && route.path === '/*') return false
        const key = `${route.method}:${route.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    // #then — health + both OAuth routes are registered
    expect(routes).toContainEqual({method: 'GET', path: '/operator/health'})
    expect(routes).toContainEqual({method: 'GET', path: '/operator/auth/github/start'})
    expect(routes).toContainEqual({method: 'GET', path: '/operator/auth/github/callback'})
    expect(routes).toHaveLength(3)
  })

  it('registers only /operator/health when neither deps.githubOAuth nor config.githubOAuth are provided', () => {
    // #given — no OAuth deps or config
    const app = buildOperatorApp(makeStubDeps(), makeStubConfig())

    // #when
    const seen = new Set<string>()
    const routes = app.routes
      .map((route: RouteEntry) => ({method: route.method, path: route.path}))
      .filter((route: RouteEntry) => {
        if (route.method === 'ALL' && route.path === '/*') return false
        const key = `${route.method}:${route.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    // #then — only health route
    expect(routes).toEqual([{method: 'GET', path: '/operator/health'}])
  })
})

// ---------------------------------------------------------------------------
// buildOperatorApp — partial OAuth config is a programming error
// ---------------------------------------------------------------------------

describe('buildOperatorApp — partial OAuth config programming error', () => {
  it('throws when deps.githubOAuth is set but config.githubOAuth is absent', () => {
    // #given — only deps side is provided
    expect(() =>
      buildOperatorApp(
        makeStubDeps({githubOAuth: makeStubGitHubOAuthDeps()}),
        makeStubConfig(), // no githubOAuth in config
      ),
    ).toThrow('programming error')
  })

  it('throws when config.githubOAuth is set but deps.githubOAuth is absent', () => {
    // #given — only config side is provided
    expect(() =>
      buildOperatorApp(
        makeStubDeps(), // no githubOAuth in deps
        makeStubConfig({githubOAuth: makeStubGitHubOAuthConfig()}),
      ),
    ).toThrow('programming error')
  })
})

// ---------------------------------------------------------------------------
// GET /operator/health — happy path
// ---------------------------------------------------------------------------

describe('GET /operator/health — happy path', () => {
  it('returns 200 {ok:true, contractVersion} when the listener is running', async () => {
    // #given
    const port = await findFreePort()
    const server = createOperatorServer(makeStubDeps(), makeStubConfig({bindPort: port}))

    try {
      // #when
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`)
      const body = await res.json()

      // #then
      expect(res.status).toBe(200)
      expect(body).toEqual({ok: true, contractVersion: OPERATOR_CONTRACT_VERSION})
    } finally {
      await closeServer(server)
    }
  })
})

describe('GET /operator/health — push health stays off the public surface', () => {
  it('returns the unchanged {ok, contractVersion} body even when push health is degraded', async () => {
    // #given a push health reader reporting degraded
    const port = await findFreePort()
    const server = createOperatorServer(
      {...makeStubDeps(), operatorPushHealth: () => 'degraded'},
      makeStubConfig({bindPort: port}),
    )

    try {
      // #when an anonymous caller hits the public health route
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`)
      const text = await res.text()

      // #then no push field and no byte of push state leaks
      expect(res.status).toBe(200)
      expect(JSON.parse(text)).toEqual({ok: true, contractVersion: OPERATOR_CONTRACT_VERSION})
      expect(text).not.toContain('push')
      expect(text).not.toContain('degraded')
    } finally {
      await closeServer(server)
    }
  })

  it('does not change the route inventory when a push health reader is supplied', async () => {
    // #given the same full browser-guard deps with and without a push health reader
    const sessionStore = await createTestSessionStore()
    const inventory = (operatorPushHealth?: OperatorServerDeps['operatorPushHealth']): RouteEntry[] => {
      const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
      const app = buildOperatorApp(
        makeStubDeps({
          sessionStore,
          sessionDeps: makeStubSessionDeps(),
          allowlist,
          csrfSecret,
          auditLogger,
          logger,
          operatorPushHealth,
        }),
        makeStubConfig(),
      )
      const seen = new Set<string>()
      return app.routes
        .map((route: RouteEntry) => ({method: route.method, path: route.path}))
        .filter((route: RouteEntry) => {
          if (route.method === 'ALL' && route.path === '/*') return false
          const key = `${route.method}:${route.path}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
    }

    // #when
    const without = inventory()
    const withReader = inventory(() => 'ready')

    // #then the guarded inventory (which includes the session routes) is identical
    expect(without).toContainEqual({method: 'GET', path: '/operator/session'})
    expect(withReader).toEqual(without)
  })
})

// ---------------------------------------------------------------------------
// Shutdown — operator server closes cleanly
// ---------------------------------------------------------------------------

describe('operator server shutdown', () => {
  it('closes without hanging when close() is called', async () => {
    // #given — start the server and verify it is reachable before closing
    const port = await findFreePort()
    const server = createOperatorServer(makeStubDeps(), makeStubConfig({bindPort: port}))

    // Verify the server is up before closing (ensures the handle is live)
    const res = await fetch(`http://127.0.0.1:${port}/operator/health`)
    expect(res.status).toBe(200)

    // #when — close the server
    await closeServer(server)

    // #then — closed cleanly
    expect(server.listening).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Drain gate — 503 when shutting down
// ---------------------------------------------------------------------------

describe('GET /operator/health — drain gate', () => {
  it('returns 503 {error:"unavailable"} when isShuttingDown() returns true', async () => {
    // #given
    const port = await findFreePort()
    const server = createOperatorServer(makeStubDeps({isShuttingDown: () => true}), makeStubConfig({bindPort: port}))

    try {
      // #when
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`)
      const body = await res.json()

      // #then
      expect(res.status).toBe(503)
      expect(body).toEqual({error: 'unavailable'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

// ---------------------------------------------------------------------------
// Body size limit — 413 for oversized unauthenticated requests
// ---------------------------------------------------------------------------

describe('operator server — body size limit', () => {
  it('returns 413 for a body exceeding the unauthenticated limit', async () => {
    // #given — send a body larger than OPERATOR_MAX_BODY_BYTES
    const port = await findFreePort()
    const server = createOperatorServer(makeStubDeps(), makeStubConfig({bindPort: port}))

    // 64 KB + 1 byte — exceeds the unauthenticated body limit
    const oversizedBody = Buffer.alloc(65 * 1024 + 1, 0x41)

    try {
      // #when — POST to a non-existent route with an oversized body
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: oversizedBody,
      })

      // #then — body limit fires before any handler
      expect(res.status).toBe(413)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

// ---------------------------------------------------------------------------
// Rate limit — 429 for unauthenticated floods
// ---------------------------------------------------------------------------

describe('operator server — unauthenticated rate limit', () => {
  it('returns 429 when the health-route rate limiter is exhausted', async () => {
    // #given — health route uses its own independent limiter (healthRateLimiter),
    // NOT the shared OAuth/logout rateLimiter — that separation is the fix for
    // health polling being able to starve sign-in.
    const port = await findFreePort()
    const server = createOperatorServer(
      makeStubDeps({healthRateLimiter: {allow: () => false}}),
      makeStubConfig({bindPort: port}),
    )

    try {
      // #when
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`)
      const body = await res.json()

      // #then
      expect(res.status).toBe(429)
      expect(body).toEqual({error: 'rate limited'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

// ---------------------------------------------------------------------------
// Unknown routes — 404 with safe response shape
// ---------------------------------------------------------------------------

describe('operator server — unknown routes', () => {
  it('returns 404 {error:"not-found"} for unregistered paths', async () => {
    // #given
    const port = await findFreePort()
    const server = createOperatorServer(makeStubDeps(), makeStubConfig({bindPort: port}))

    try {
      // #when
      const res = await fetch(`http://127.0.0.1:${port}/operator/nonexistent`)
      const body = await res.json()

      // #then
      expect(res.status).toBe(404)
      expect(body).toEqual({error: 'not-found'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

// ---------------------------------------------------------------------------
// Trusted-origin header validation — reject untrusted forwarded-host/proto
// ---------------------------------------------------------------------------

// All requests here go through a real TCP socket (createOperatorServer + fetch),
// exactly like http/server.test.ts — the trust decision now depends on the real
// peer address (getConnInfo), which app.fetch() cannot supply.

/** Start a real operator server on a free loopback port; caller must close it. */
async function startRealOperatorServer(
  deps: OperatorServerDeps,
  configOverrides: Partial<OperatorServerConfig> = {},
): Promise<{readonly port: number; readonly close: () => Promise<void>}> {
  const port = await findFreePort()
  const server = createOperatorServer(deps, makeStubConfig({bindPort: port, ...configOverrides}))
  return {
    port,
    close: async () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

describe('operator server — trusted origin enforcement — untrusted peer (default policy)', () => {
  it('rejects a request supplying X-Forwarded-Host/-Proto even when they match publicOrigin — a matching hostname is not proof of proxy provenance', async () => {
    // #given — default policy trusts no peer; the real test socket (127.0.0.1) is untrusted
    const {port, close} = await startRealOperatorServer(makeStubDeps())

    try {
      // #when — forwarded headers exactly match publicOrigin
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {'x-forwarded-host': 'operator.example.com', 'x-forwarded-proto': 'https'},
      })

      // #then — rejected: only the peer address decides trust, not header content
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({error: 'bad request'})
    } finally {
      await close()
    }
  })

  it('rejects a request supplying only X-Forwarded-Host from an untrusted peer', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {'x-forwarded-host': 'evil.attacker.com'},
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('rejects a request supplying only X-Forwarded-Proto from an untrusted peer', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {'x-forwarded-proto': 'https'},
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('ignores X-Forwarded-For from an untrusted peer — the socket address is used, not the spoofed header', async () => {
    // #given — an untrusted peer supplying a spoofed XFF should not be able to
    // fragment or forge the rate-limit key via the header alone.
    const {port, close} = await startRealOperatorServer(makeStubDeps())
    try {
      // #when — two requests claim two different "clients" via XFF from the same untrusted socket
      const resA = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {'x-forwarded-for': '203.0.113.10'},
      })
      const resB = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {'x-forwarded-for': '203.0.113.20'},
      })
      // #then — XFF is not rejected outright (only X-Forwarded-Host/-Proto are);
      // both requests succeed and are keyed on the real (untrusted) socket address
      expect(resA.status).toBe(200)
      expect(resB.status).toBe(200)
    } finally {
      await close()
    }
  })

  it('no forwarded headers — headerless direct connection — accepted', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`)
      expect(res.status).toBe(200)
    } finally {
      await close()
    }
  })
})

describe('operator server — trusted origin enforcement — trusted peer', () => {
  it('accepts a single valid X-Forwarded-Host/-Proto pair matching publicOrigin', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps(), {ingressPolicy: makeTrustedLoopbackPolicy()})
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {
          'x-forwarded-host': 'operator.example.com',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '198.51.100.1',
        },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ok: true, contractVersion: OPERATOR_CONTRACT_VERSION})
    } finally {
      await close()
    }
  })

  it('rejects a mismatched X-Forwarded-Host', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps(), {ingressPolicy: makeTrustedLoopbackPolicy()})
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {
          'x-forwarded-host': 'evil.attacker.com',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '198.51.100.1',
        },
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('rejects X-Forwarded-Proto=http (not https)', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps(), {ingressPolicy: makeTrustedLoopbackPolicy()})
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {
          'x-forwarded-host': 'operator.example.com',
          'x-forwarded-proto': 'http',
          'x-forwarded-for': '198.51.100.1',
        },
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('rejects only X-Forwarded-Host (no proto) — partial headers', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps(), {ingressPolicy: makeTrustedLoopbackPolicy()})
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {'x-forwarded-host': 'operator.example.com', 'x-forwarded-for': '198.51.100.1'},
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('rejects only X-Forwarded-Proto (no host) — partial headers', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps(), {ingressPolicy: makeTrustedLoopbackPolicy()})
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.1'},
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('rejects comma-separated X-Forwarded-Host (multi-value header)', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps(), {ingressPolicy: makeTrustedLoopbackPolicy()})
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {
          'x-forwarded-host': 'operator.example.com, evil.attacker.com',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '198.51.100.1',
        },
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('accepts X-Forwarded-Host matching publicOrigin with a non-default port (exact host:port match)', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps(), {
      publicOrigin: 'https://operator.example.com:8443',
      ingressPolicy: makeTrustedLoopbackPolicy(),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {
          'x-forwarded-host': 'operator.example.com:8443',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '198.51.100.1',
        },
      })
      expect(res.status).toBe(200)
    } finally {
      await close()
    }
  })

  it('rejects X-Forwarded-Host with a port not present in publicOrigin', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps(), {ingressPolicy: makeTrustedLoopbackPolicy()})
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {
          'x-forwarded-host': 'operator.example.com:8443',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '198.51.100.1',
        },
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('rejects a headerless request to a non-health route — the health-only exception does not generalize', async () => {
    const {port, close} = await startRealOperatorServer(makeStubDeps(), {ingressPolicy: makeTrustedLoopbackPolicy()})
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/nonexistent`)
      // #then — rejected by the forwarded-header middleware before the 404 handler runs
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('a headerless direct health probe from a trusted-proxy peer still succeeds (narrow, health-only exception)', async () => {
    // #given — trusted peer, zero forwarding metadata at all: the proxy's own
    // liveness check, not a forwarded client request.
    const {port, close} = await startRealOperatorServer(makeStubDeps(), {ingressPolicy: makeTrustedLoopbackPolicy()})
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ok: true, contractVersion: OPERATOR_CONTRACT_VERSION})
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// Trusted-peer rejections must not allocate a rate-limit bucket — an
// unauthenticated caller who can still consume budget on a rejected request
// is the exact failure class this whole change exists to fix.
// ---------------------------------------------------------------------------

describe('operator server — trusted peer rejections allocate no rate-limit bucket', () => {
  it('missing both forwarded headers on a non-health route allocates no bucket', async () => {
    // #given — trusted peer, a registered non-health route, and a spied rateLimiter
    // (the limiter that route would call if the middleware let the request through)
    const rateLimiter = {allow: vi.fn(() => true)}
    const {port, close} = await startRealOperatorServer(
      makeStubDeps({rateLimiter, githubOAuth: makeStubGitHubOAuthDeps()}),
      {ingressPolicy: makeTrustedLoopbackPolicy(), githubOAuth: makeStubGitHubOAuthConfig()},
    )
    try {
      // #when — no forwarded headers at all
      const res = await fetch(`http://127.0.0.1:${port}/operator/auth/github/start`, {redirect: 'manual'})

      // #then — rejected before the route runs; no bucket consumed
      expect(res.status).toBe(400)
      expect(rateLimiter.allow).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('only X-Forwarded-Host (partial headers) allocates no health bucket', async () => {
    const healthRateLimiter = {allow: vi.fn(() => true)}
    const {port, close} = await startRealOperatorServer(makeStubDeps({healthRateLimiter}), {
      ingressPolicy: makeTrustedLoopbackPolicy(),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {'x-forwarded-host': 'operator.example.com'},
      })
      expect(res.status).toBe(400)
      expect(healthRateLimiter.allow).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('only X-Forwarded-Proto (partial headers) allocates no health bucket', async () => {
    const healthRateLimiter = {allow: vi.fn(() => true)}
    const {port, close} = await startRealOperatorServer(makeStubDeps({healthRateLimiter}), {
      ingressPolicy: makeTrustedLoopbackPolicy(),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {'x-forwarded-proto': 'https'},
      })
      expect(res.status).toBe(400)
      expect(healthRateLimiter.allow).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('a mismatched X-Forwarded-Host allocates no health bucket', async () => {
    const healthRateLimiter = {allow: vi.fn(() => true)}
    const {port, close} = await startRealOperatorServer(makeStubDeps({healthRateLimiter}), {
      ingressPolicy: makeTrustedLoopbackPolicy(),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {'x-forwarded-host': 'evil.attacker.com', 'x-forwarded-proto': 'https'},
      })
      expect(res.status).toBe(400)
      expect(healthRateLimiter.allow).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('a non-https X-Forwarded-Proto allocates no health bucket', async () => {
    const healthRateLimiter = {allow: vi.fn(() => true)}
    const {port, close} = await startRealOperatorServer(makeStubDeps({healthRateLimiter}), {
      ingressPolicy: makeTrustedLoopbackPolicy(),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {'x-forwarded-host': 'operator.example.com', 'x-forwarded-proto': 'http'},
      })
      expect(res.status).toBe(400)
      expect(healthRateLimiter.allow).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// The actual outage this fixes, pinned: two distinct clients behind one
// trusted reverse proxy must resolve to two distinct rate-limit keys.
// ---------------------------------------------------------------------------

describe('GET /operator/health — trusted-proxy client separation (regression pin for the outage)', () => {
  it('two different clients behind one trusted proxy get separate rate-limit buckets', async () => {
    // #given — health limiter with a per-key limit of 1; the real test socket
    // (127.0.0.1) is the trusted proxy, two distinct XFF values are the two clients
    const {port, close} = await startRealOperatorServer(
      makeStubDeps({healthRateLimiter: createRateLimiter({limit: 1, windowMs: 60_000})}),
      {ingressPolicy: makeTrustedLoopbackPolicy()},
    )
    try {
      // #when — client A's first request, then B's first request, then A's second request
      const forwardedOrigin = {'x-forwarded-host': 'operator.example.com', 'x-forwarded-proto': 'https'}
      const resA1 = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {...forwardedOrigin, 'x-forwarded-for': '203.0.113.5'},
      })
      const resB1 = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {...forwardedOrigin, 'x-forwarded-for': '203.0.113.9'},
      })
      const resA2 = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {...forwardedOrigin, 'x-forwarded-for': '203.0.113.5'},
      })

      // #then — A and B each get their own budget; A's second request exhausts A's
      // own bucket, not a shared one collapsed onto the proxy's address
      expect(resA1.status).toBe(200)
      expect(resB1.status).toBe(200)
      expect(resA2.status).toBe(429)
    } finally {
      await close()
    }
  })

  it('a trusted peer with valid matching X-Forwarded-Host/-Proto but no X-Forwarded-For is never treated as the headerless probe — must not collapse onto the proxy key', async () => {
    // #given — trusted peer, X-Forwarded-Host/-Proto ARE forwarded and match the
    // public origin, but X-Forwarded-For is omitted. This is NOT the headerless
    // probe the health-only exception exists for (that requires no XFH/XFP either) —
    // it is an incomplete forwarded-client request, and must be rejected the ordinary
    // way rather than silently keyed on the proxy's own address.
    const healthRateLimiter = {allow: vi.fn(() => true)}
    const {port, close} = await startRealOperatorServer(makeStubDeps({healthRateLimiter}), {
      ingressPolicy: makeTrustedLoopbackPolicy(),
    })
    try {
      const headers = {'x-forwarded-host': 'operator.example.com', 'x-forwarded-proto': 'https'}

      // #when — two separate requests, both missing X-Forwarded-For entirely
      const res1 = await fetch(`http://127.0.0.1:${port}/operator/health`, {headers})
      const res2 = await fetch(`http://127.0.0.1:${port}/operator/health`, {headers})

      // #then — both rejected by ordinary ingress validation; neither is admitted
      // to the health-only budget under a shared proxy-address key, so two distinct
      // callers matching this pattern never collapse onto one rate-limit key
      expect(res1.status).toBe(400)
      expect(res2.status).toBe(400)
      expect(healthRateLimiter.allow).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// #1652: health buckets use the derived accounting key; the headerless-probe
// exception stays on the exact peer address.
// ---------------------------------------------------------------------------

describe('GET /operator/health — derived accounting keys (#1652)', () => {
  const forwardedOrigin = {'x-forwarded-host': 'operator.example.com', 'x-forwarded-proto': 'https'}

  it('clients in one /64 behind a trusted proxy share a bucket; an adjacent /64 is independent', async () => {
    // #given — per-key limit of 1
    const {port, close} = await startRealOperatorServer(
      makeStubDeps({healthRateLimiter: createRateLimiter({limit: 1, windowMs: 60_000})}),
      {ingressPolicy: makeTrustedLoopbackPolicy()},
    )
    try {
      const get = async (xff: string) =>
        fetch(`http://127.0.0.1:${port}/operator/health`, {headers: {...forwardedOrigin, 'x-forwarded-for': xff}})

      // #when
      const first = await get('2001:db8:1:2::1')
      const sameSlash64 = await get('2001:db8:1:2:aaaa::9')
      const adjacent = await get('2001:db8:1:3::1')

      // #then
      expect(first.status).toBe(200)
      expect(sameSlash64.status).toBe(429)
      expect(adjacent.status).toBe(200)
    } finally {
      await close()
    }
  })

  it('an IPv4 client and its IPv4-mapped spellings share one health bucket', async () => {
    // #given
    const {port, close} = await startRealOperatorServer(
      makeStubDeps({healthRateLimiter: createRateLimiter({limit: 1, windowMs: 60_000})}),
      {ingressPolicy: makeTrustedLoopbackPolicy()},
    )
    try {
      const get = async (xff: string) =>
        fetch(`http://127.0.0.1:${port}/operator/health`, {headers: {...forwardedOrigin, 'x-forwarded-for': xff}})

      // #when / #then
      expect((await get('203.0.113.7')).status).toBe(200)
      expect((await get('::ffff:203.0.113.7')).status).toBe(429)
      expect((await get('::ffff:cb00:7107')).status).toBe(429)
    } finally {
      await close()
    }
  })

  it('a resolved client is keyed on the derived key, the headerless probe on the exact peer address', async () => {
    // #given — a recording health limiter behind a trusted loopback proxy
    const keys: string[] = []
    const healthRateLimiter = {
      allow: (key: string) => {
        keys.push(key)
        return true
      },
    }
    const {port, close} = await startRealOperatorServer(makeStubDeps({healthRateLimiter}), {
      ingressPolicy: makeTrustedLoopbackPolicy(),
    })
    try {
      // #when — one forwarded client, one fully headerless probe
      await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {...forwardedOrigin, 'x-forwarded-for': '203.0.113.7'},
      })
      await fetch(`http://127.0.0.1:${port}/operator/health`)

      // #then — derived key for the client, exact (unprefixed) canonical for the proxy peer
      expect(keys).toEqual(['ipv4/32:203.0.113.7', '127.0.0.1'])
    } finally {
      await close()
    }
  })

  it('a headerless probe from an IPv6 trusted peer keeps the exact, unprefixed, unaggregated key', async () => {
    // #given — an IPv6 trusted proxy peer, injected as the socket address (no real IPv6 socket needed)
    const keys: string[] = []
    const healthRateLimiter = {
      allow: (key: string) => {
        keys.push(key)
        return true
      },
    }
    const proxy = '2001:db8:aa:bb::1'
    const app = buildOperatorApp(
      makeStubDeps({healthRateLimiter}),
      makeStubConfig({
        ingressPolicy: makeTrustedProxyIngressPolicy([Effect.runSync(parseTrustedProxyAddress(proxy))]),
      }),
    )

    // #when — a fully headerless health probe from the proxy itself
    const res = await app.fetch(new Request('http://localhost/operator/health'), {
      incoming: {socket: {remoteAddress: proxy}},
    })

    // #then — accepted, keyed on the exact eight-group canonical address (not an ipv6/64: key)
    expect(res.status).toBe(200)
    expect(keys).toEqual(['2001:0db8:00aa:00bb:0000:0000:0000:0001'])
  })
})

describe('POST /operator/auth/logout — anonymous traffic cannot spend the shared bucket (#1652)', () => {
  it('an unauthenticated logout is rejected by the guard before the shared limiter is consulted', async () => {
    // #given — logout wired with a recording shared limiter, no session presented
    const sessionStore = await createTestSessionStore()
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const rateLimiter = {allow: vi.fn(() => true)}
    const {port, close} = await startRealOperatorServer(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps(),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter,
      }),
      {publicOrigin: 'https://operator.example.com'},
    )
    try {
      // #when
      const res = await fetch(`http://127.0.0.1:${port}/operator/auth/logout`, {
        method: 'POST',
        headers: {origin: 'https://operator.example.com'},
      })

      // #then — 401 from the guard, and the OAuth/logout budget is untouched
      expect(res.status).toBe(401)
      expect(rateLimiter.allow).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('an authenticated logout spends the shared bucket on the derived accounting key', async () => {
    // #given
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1000, secret: csrfSecret})
    const rateLimiter = {allow: vi.fn(() => true)}
    const {port, close} = await startRealOperatorServer(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now + 1000}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter,
      }),
      {publicOrigin: 'https://operator.example.com'},
    )
    try {
      // #when
      const res = await fetch(`http://127.0.0.1:${port}/operator/auth/logout`, {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
          origin: 'https://operator.example.com',
          'x-csrf-token': csrfToken,
        },
      })

      // #then
      expect(res.status).toBe(200)
      expect(rateLimiter.allow).toHaveBeenCalledWith('ipv4/32:127.0.0.1')
    } finally {
      await close()
    }
  })

  it('authenticated logouts from one /64 share a bucket; an adjacent /64 is independent', async () => {
    // #given — direct policy (the socket IS the client), a limit-1 shared bucket, and three
    // authenticated operators, each with their own session + CSRF token
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const {logger, auditLogger, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const allowlist = loadAllowlistFromText('41\n42\n43\n', logger)
    const operatorSessions = await Promise.all(
      [41, 42, 43].map(async githubUserId => ({
        githubUserId,
        sessionId: await mintTestSession(sessionStore, {githubUserId, login: `op${githubUserId}`}),
      })),
    )
    const operators = operatorSessions.map(({githubUserId, sessionId}) => {
      const csrfToken = generateCsrfToken({
        sessionId,
        operatorId: githubUserId,
        nowMs: now + 1000,
        secret: csrfSecret,
      })
      return {sessionId, csrfToken}
    })
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now + 1000}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: createRateLimiter({limit: 1, windowMs: 60_000}),
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )
    const logoutFrom = async (remoteAddress: string, operator: (typeof operators)[number]) =>
      app.fetch(
        new Request('http://localhost/operator/auth/logout', {
          method: 'POST',
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${operator.sessionId}`,
            origin: 'https://operator.example.com',
            'x-csrf-token': operator.csrfToken,
          },
        }),
        {incoming: {socket: {remoteAddress}}},
      )
    const [first, second, third] = operators
    if (first === undefined || second === undefined || third === undefined) throw new Error('expected 3 operators')

    // #when
    const fromSlash64 = await logoutFrom('2001:db8:7:7::1', first)
    const sameSlash64 = await logoutFrom('2001:db8:7:7:aaaa::2', second)
    const adjacent = await logoutFrom('2001:db8:7:8::1', third)

    // #then — the second address in the /64 is throttled by the shared bucket; the adjacent /64 is not
    expect(fromSlash64.status).toBe(200)
    expect(sameSlash64.status).toBe(429)
    expect(adjacent.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Health limiter independence — health polling cannot starve sign-in, and vice versa.
// ---------------------------------------------------------------------------

describe('operator server — health and OAuth/logout use independent rate-limit budgets', () => {
  it('exhausting the health budget does not block the OAuth start route', async () => {
    // #given — health limiter denies everything; the shared OAuth/logout limiter allows
    const {port, close} = await startRealOperatorServer(
      makeStubDeps({
        healthRateLimiter: {allow: () => false},
        rateLimiter: {allow: () => true},
        githubOAuth: makeStubGitHubOAuthDeps(),
      }),
      {githubOAuth: makeStubGitHubOAuthConfig()},
    )
    try {
      const healthRes = await fetch(`http://127.0.0.1:${port}/operator/health`)
      const startRes = await fetch(`http://127.0.0.1:${port}/operator/auth/github/start`, {redirect: 'manual'})

      // #then — health is throttled; sign-in is unaffected
      expect(healthRes.status).toBe(429)
      expect(startRes.status).toBe(302)
    } finally {
      await close()
    }
  })

  it('exhausting the shared OAuth/logout budget does not block the health route', async () => {
    // #given — shared limiter denies everything; health's own limiter allows
    const {port, close} = await startRealOperatorServer(
      makeStubDeps({
        healthRateLimiter: {allow: () => true},
        rateLimiter: {allow: () => false},
        githubOAuth: makeStubGitHubOAuthDeps(),
      }),
      {githubOAuth: makeStubGitHubOAuthConfig()},
    )
    try {
      const startRes = await fetch(`http://127.0.0.1:${port}/operator/auth/github/start`, {redirect: 'manual'})
      const healthRes = await fetch(`http://127.0.0.1:${port}/operator/health`)

      // #then — sign-in is throttled; health is unaffected
      expect(startRes.status).toBe(429)
      expect(healthRes.status).toBe(200)
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// Rate limiter — focused behavior tests using injected clock
// ---------------------------------------------------------------------------

describe('operator server — rate limiter behavior', () => {
  it('allows requests up to the limit within a window', () => {
    // #given — rate limiter with limit=3, window=60s
    const now = 0
    const limiter = createRateLimiter({limit: 3, windowMs: 60_000, clock: () => now})

    // #when — 3 requests from the same key
    // #then — all allowed
    expect(limiter.allow('key-a')).toBe(true)
    expect(limiter.allow('key-a')).toBe(true)
    expect(limiter.allow('key-a')).toBe(true)
  })

  it('rejects the request that exceeds the limit', () => {
    // #given — rate limiter with limit=3
    const now = 0
    const limiter = createRateLimiter({limit: 3, windowMs: 60_000, clock: () => now})

    limiter.allow('key-a')
    limiter.allow('key-a')
    limiter.allow('key-a')

    // #when — 4th request in the same window
    const result = limiter.allow('key-a')

    // #then — rejected
    expect(result).toBe(false)
  })

  it('resets the count after the window expires', () => {
    // #given — rate limiter with limit=2, window=60s
    let now = 0
    const limiter = createRateLimiter({limit: 2, windowMs: 60_000, clock: () => now})

    limiter.allow('key-a')
    limiter.allow('key-a')
    expect(limiter.allow('key-a')).toBe(false) // exhausted

    // #when — advance clock past the window
    now = 60_001

    // #then — window reset; requests allowed again
    expect(limiter.allow('key-a')).toBe(true)
  })

  it('isolates counts per key', () => {
    // #given — rate limiter with limit=1
    const now = 0
    const limiter = createRateLimiter({limit: 1, windowMs: 60_000, clock: () => now})

    // #when — exhaust key-a
    limiter.allow('key-a')
    expect(limiter.allow('key-a')).toBe(false)

    // #then — key-b is unaffected
    expect(limiter.allow('key-b')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Drain gate — fires before body-limit
// ---------------------------------------------------------------------------

describe('operator server — drain gate fires before body-limit', () => {
  it('returns 503 for an oversized body when draining (drain gate wins)', async () => {
    // #given — server is draining AND body is oversized
    const port = await findFreePort()
    const server = createOperatorServer(makeStubDeps({isShuttingDown: () => true}), makeStubConfig({bindPort: port}))

    // 64 KB + 1 byte — exceeds the unauthenticated body limit
    const oversizedBody = Buffer.alloc(65 * 1024 + 1, 0x41)

    try {
      // #when — POST with oversized body while draining
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: oversizedBody,
      })

      // #then — drain gate fires first; 503 not 413
      expect(res.status).toBe(503)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

// ---------------------------------------------------------------------------
// Warning log — coarse warning on rejection paths
// ---------------------------------------------------------------------------

describe('operator server — warning log on rejection paths', () => {
  it('logs a coarse warning (no caller-supplied values) when forwarded headers are untrusted', async () => {
    // #given
    const logger = makeLogger()
    const app = buildOperatorApp(makeStubDeps({logger}), makeStubConfig({publicOrigin: 'https://operator.example.com'}))

    // #when — send a request with a mismatched forwarded host
    const req = new Request('http://127.0.0.1/operator/health', {
      headers: {
        'x-forwarded-host': 'evil.attacker.com',
        'x-forwarded-proto': 'https',
      },
    })
    await app.fetch(req)

    // #then — warn was called
    expect(logger.warn).toHaveBeenCalledOnce()

    // #and — the warning context does NOT include caller-supplied header values
    const [ctx] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, string]
    expect(ctx).not.toHaveProperty('forwardedHost')
    expect(ctx).not.toHaveProperty('forwardedProto')
    expect(ctx).not.toHaveProperty('publicOriginHost')
  })

  it('logs a coarse warning when draining', async () => {
    // #given
    const logger = makeLogger()
    const app = buildOperatorApp(makeStubDeps({logger, isShuttingDown: () => true}), makeStubConfig())

    // #when
    const req = new Request('http://127.0.0.1/operator/health')
    await app.fetch(req)

    // #then — warn was called once
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('returns 503 (never a fallback key) when the socket is unavailable, and logs a bounded diagnostic', async () => {
    // #given — use app.fetch() directly (no real socket) so getConnInfo throws.
    // A rate limiter that always allows is injected so a 200 here (if it occurred)
    // could only be explained by a resurrected fallback key, not a rate-limit rejection.
    const logger = makeLogger()
    const healthRateLimiter = {allow: vi.fn(() => true)}
    const app = buildOperatorApp(makeStubDeps({logger, healthRateLimiter}), makeStubConfig())

    // #when — direct app.fetch() has no underlying socket; getConnInfo will throw
    const req = new Request('http://127.0.0.1/operator/health')
    const res = await app.fetch(req)

    // #then — socket acquisition failure is a coarse 503, never a fallback 'unknown' key
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({error: 'unavailable'})

    // #and — no rate-limit bucket was allocated for a request that never resolved a key
    expect(healthRateLimiter.allow).not.toHaveBeenCalled()

    // #and — a bounded diagnostic was logged (reason only, no raw headers/addresses)
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls as [Record<string, unknown>, string][]
    const rejectionWarning = warnCalls.find(([, msg]) => msg.includes('ingress resolution failed'))
    expect(rejectionWarning).toBeDefined()
    expect(rejectionWarning?.[0]).toEqual({reason: 'socket-unavailable'})
  })
})

// ---------------------------------------------------------------------------
// buildOperatorApp — logout route registration
// ---------------------------------------------------------------------------

function makeStubSessionDeps(overrides?: Partial<SessionDeps>): SessionDeps {
  return {
    logger: makeLogger(),
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    clock: () => Date.now(),
    ...overrides,
  }
}

describe('buildOperatorApp — logout route registration', () => {
  it('registers POST /operator/auth/logout when sessionStore, sessionDeps, and browser guard deps are provided', async () => {
    // #given — all required deps for logout (sessionStore + sessionDeps + browser guard deps)
    const sessionStore = await createTestSessionStore()
    const sessionDeps = makeStubSessionDeps()
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({sessionStore, sessionDeps, allowlist, csrfSecret, auditLogger, logger}),
      makeStubConfig(),
    )

    // #when — extract unique logical routes
    const seen = new Set<string>()
    const routes = app.routes
      .map((route: {method: string; path: string}) => ({method: route.method, path: route.path}))
      .filter((route: {method: string; path: string}) => {
        if (route.method === 'ALL' && route.path === '/*') return false
        const key = `${route.method}:${route.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    // #then — logout route is registered
    expect(routes).toContainEqual({method: 'POST', path: '/operator/auth/logout'})
  })

  it('does NOT register POST /operator/auth/logout when sessionStore is absent', () => {
    // #given — no session store
    const app = buildOperatorApp(makeStubDeps(), makeStubConfig())

    // #when
    const seen = new Set<string>()
    const routes = app.routes
      .map((route: {method: string; path: string}) => ({method: route.method, path: route.path}))
      .filter((route: {method: string; path: string}) => {
        if (route.method === 'ALL' && route.path === '/*') return false
        const key = `${route.method}:${route.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    // #then — logout route is NOT registered
    expect(routes).not.toContainEqual({method: 'POST', path: '/operator/auth/logout'})
  })

  it('throws a programming error when sessionStore/sessionDeps are present but browser guard deps are absent', async () => {
    // #given — sessionStore + sessionDeps without allowlist/csrfSecret/auditLogger
    const sessionStore = await createTestSessionStore()
    const sessionDeps = makeStubSessionDeps()

    // #when / #then — must throw: public mutating logout is a CSRF footgun
    expect(() => buildOperatorApp(makeStubDeps({sessionStore, sessionDeps}), makeStubConfig())).toThrow(
      'programming error',
    )
  })

  it('logout route is classified as privileged (requires session + CSRF)', async () => {
    // #given — all required deps for logout
    const sessionStore = await createTestSessionStore()
    const sessionDeps = makeStubSessionDeps()
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({sessionStore, sessionDeps, allowlist, csrfSecret, auditLogger, logger}),
      makeStubConfig(),
    )

    // #when / #then — logout is privileged (not public)
    expect(isPrivilegedRoute(app, 'POST', '/operator/auth/logout')).toBe(true)
    expect(isPublicRoute(app, 'POST', '/operator/auth/logout')).toBe(false)
  })

  it('logout route returns 200 and clears the session cookie when session + CSRF are valid', async () => {
    // #given — all required deps for logout
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1000, secret: csrfSecret})
    const {port, close} = await startRealOperatorServer(
      makeStubDeps({
        sessionStore,
        sessionDeps,
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      {publicOrigin: 'https://operator.example.com'},
    )

    try {
      // #when
      const res = await fetch(`http://127.0.0.1:${port}/operator/auth/logout`, {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
          origin: 'https://operator.example.com',
          'x-csrf-token': csrfToken,
        },
      })

      // #then — success
      expect(res.status).toBe(200)

      // #and — session is invalidated
      expect(sessionStore.get(sessionId)).toBeUndefined()

      // #and — clear-cookie header is set
      const setCookie = res.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain(SESSION_COOKIE_NAME)
      expect(setCookie.toLowerCase()).toContain('max-age=0')
    } finally {
      await close()
    }
  })

  it('logout route returns 429 when rate limiter rejects (after guard passes)', async () => {
    // #given — valid session + CSRF, but rate limiter always blocks
    // Rate limit check runs inside the handler after the guard passes.
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1000, secret: csrfSecret})
    const {port, close} = await startRealOperatorServer(
      makeStubDeps({
        sessionStore,
        sessionDeps,
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => false},
      }),
      {publicOrigin: 'https://operator.example.com'},
    )

    try {
      // #when — valid session + CSRF but rate limiter blocks
      const res = await fetch(`http://127.0.0.1:${port}/operator/auth/logout`, {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
          origin: 'https://operator.example.com',
          'x-csrf-token': csrfToken,
        },
      })

      // #then — rate limited
      expect(res.status).toBe(429)
    } finally {
      await close()
    }
  })

  it('logout route clears cookie and invalidates session when rate limiter allows', async () => {
    // #given — rate limiter allows; valid session + CSRF
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const sessionDeps = makeStubSessionDeps({clock: () => now + 1000})
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const csrfToken = generateCsrfToken({sessionId, operatorId: 42, nowMs: now + 1000, secret: csrfSecret})
    const {port, close} = await startRealOperatorServer(
      makeStubDeps({
        sessionStore,
        sessionDeps,
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      {publicOrigin: 'https://operator.example.com'},
    )

    try {
      // #when
      const res = await fetch(`http://127.0.0.1:${port}/operator/auth/logout`, {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
          origin: 'https://operator.example.com',
          'x-csrf-token': csrfToken,
        },
      })

      // #then — allowed; session cleared
      expect(res.status).toBe(200)
      expect(sessionStore.get(sessionId)).toBeUndefined()
      const setCookie = res.headers.get('set-cookie') ?? ''
      expect(setCookie.toLowerCase()).toContain('max-age=0')
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// CSRF endpoint — GET /operator/session/csrf
// ---------------------------------------------------------------------------

const TEST_CSRF_SECRET = Buffer.from('test-csrf-secret-32-bytes-long!!', 'utf8').toString('base64url')

function makeStubBrowserGuardDeps(sessionStore: Awaited<ReturnType<typeof createTestSessionStore>>) {
  const logger = makeLogger()
  const auditLogger = {info: vi.fn(), warn: vi.fn()}
  const allowlist = loadAllowlistFromText('42\n', logger)
  return {
    logger,
    auditLogger,
    sessionStore,
    allowlist,
    csrfSecret: TEST_CSRF_SECRET,
  }
}

describe('buildOperatorApp — CSRF endpoint registration', () => {
  it('registers GET /operator/session/csrf when allowlist, csrfSecret, auditLogger, and sessionStore are provided', async () => {
    // #given
    const sessionStore = await createTestSessionStore()
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({sessionStore, sessionDeps: makeStubSessionDeps(), allowlist, csrfSecret, auditLogger, logger}),
      makeStubConfig(),
    )

    // #when — extract unique logical routes
    const seen = new Set<string>()
    const routes = app.routes
      .map((route: RouteEntry) => ({method: route.method, path: route.path}))
      .filter((route: RouteEntry) => {
        if (route.method === 'ALL' && route.path === '/*') return false
        const key = `${route.method}:${route.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    // #then — CSRF endpoint is registered
    expect(routes).toContainEqual({method: 'GET', path: '/operator/session/csrf'})
  })

  it('does NOT register GET /operator/session/csrf when allowlist is absent', () => {
    // #given — no allowlist
    const app = buildOperatorApp(makeStubDeps(), makeStubConfig())

    // #when
    const seen = new Set<string>()
    const routes = app.routes
      .map((route: RouteEntry) => ({method: route.method, path: route.path}))
      .filter((route: RouteEntry) => {
        if (route.method === 'ALL' && route.path === '/*') return false
        const key = `${route.method}:${route.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    // #then — CSRF endpoint is NOT registered
    expect(routes).not.toContainEqual({method: 'GET', path: '/operator/session/csrf'})
  })
})

describe('GET /operator/session/csrf — happy path', () => {
  it('returns 200 with csrfToken when session is valid and operator is allowlisted', async () => {
    // #given
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when
    const req = new Request('http://127.0.0.1/operator/session/csrf', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
      },
    })
    const res = await app.fetch(req)
    const body = (await res.json()) as {csrfToken?: unknown}

    // #then
    expect(res.status).toBe(200)
    expect(typeof body.csrfToken).toBe('string')
    expect((body.csrfToken as string).length).toBeGreaterThan(0)
  })

  it('returns 401 when no session cookie is present', async () => {
    // #given
    const sessionStore = await createTestSessionStore()
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps(),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when — no session cookie
    const req = new Request('http://127.0.0.1/operator/session/csrf', {
      headers: {origin: 'https://operator.example.com'},
    })
    const res = await app.fetch(req)

    // #then
    expect(res.status).toBe(401)
  })

  it('returns 403 when operator is not in allowlist', async () => {
    // #given — session for user 99 who is NOT in the allowlist (allowlist has 42)
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 99, login: 'notallowed'})

    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when
    const req = new Request('http://127.0.0.1/operator/session/csrf', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
      },
    })
    const res = await app.fetch(req)

    // #then
    expect(res.status).toBe(403)
  })

  it('returns 400 when Origin does not match publicOrigin', async () => {
    // #given
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when — wrong origin
    const req = new Request('http://127.0.0.1/operator/session/csrf', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://evil.attacker.com',
      },
    })
    const res = await app.fetch(req)

    // #then
    expect(res.status).toBe(400)
  })

  it('returns 400 when non-cookie credential scheme is present', async () => {
    // #given
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when — Authorization header present (non-cookie credential)
    const req = new Request('http://127.0.0.1/operator/session/csrf', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
        authorization: 'Bearer some-token',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected without logging the credential value
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Auto-guard: registerOperatorRoute applies browser guard automatically
// ---------------------------------------------------------------------------

describe('registerOperatorRoute — auto-guard applies browser guard to privileged routes', () => {
  it('a privileged route registered via registerOperatorRoute rejects unauthenticated requests with 401', async () => {
    // #given — build app with browser guard deps and a privileged route
    const sessionStore = await createTestSessionStore()
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps(),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when — GET a privileged route (CSRF endpoint) without a session cookie
    const req = new Request('http://127.0.0.1/operator/session/csrf', {
      headers: {origin: 'https://operator.example.com'},
    })
    const res = await app.fetch(req)

    // #then — rejected 401 (no session)
    expect(res.status).toBe(401)
  })

  it('a privileged route registered via registerOperatorRoute rejects non-allowlisted operators with 403', async () => {
    // #given — session for user 99 who is NOT in the allowlist (allowlist has 42)
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 99, login: 'notallowed'})

    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when — GET privileged route with non-allowlisted session
    const req = new Request('http://127.0.0.1/operator/session/csrf', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected 403 (not allowlisted)
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Logout protection: POST /operator/auth/logout requires session + CSRF
// ---------------------------------------------------------------------------

describe('POST /operator/auth/logout — browser guard protection', () => {
  it('rejects logout without session cookie with 401 when browser guard is enabled', async () => {
    // #given — app with browser guard deps
    const sessionStore = await createTestSessionStore()
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps(),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when — POST logout without session cookie
    const req = new Request('http://127.0.0.1/operator/auth/logout', {
      method: 'POST',
      headers: {origin: 'https://operator.example.com'},
    })
    const res = await app.fetch(req)

    // #then — rejected 401 (no session)
    expect(res.status).toBe(401)
  })

  it('rejects logout without CSRF token with 400 when browser guard is enabled', async () => {
    // #given — valid session but no CSRF token
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when — POST logout with session but no CSRF token
    const req = new Request('http://127.0.0.1/operator/auth/logout', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
        // No x-csrf-token
      },
    })
    const res = await app.fetch(req)

    // #then — rejected 400 (missing CSRF token)
    expect(res.status).toBe(400)
  })

  it('allows logout with valid session and CSRF token when browser guard is enabled', async () => {
    // #given — valid session and valid CSRF token
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const {generateCsrfToken: genToken} = await import('./auth/csrf.js')
    const csrfToken = genToken({sessionId, operatorId: 42, nowMs: now + 1000, secret: csrfSecret})

    const {port, close} = await startRealOperatorServer(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now + 1000}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      {publicOrigin: 'https://operator.example.com'},
    )

    try {
      // #when — POST logout with valid session and CSRF token
      const res = await fetch(`http://127.0.0.1:${port}/operator/auth/logout`, {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
          origin: 'https://operator.example.com',
          'x-csrf-token': csrfToken,
        },
      })

      // #then — success
      expect(res.status).toBe(200)
      // #and — session is invalidated
      expect(sessionStore.get(sessionId)).toBeUndefined()
    } finally {
      await close()
    }
  })
})

describe('buildOperatorApp — OAuth callback is cross-site public', () => {
  it('oAuth callback is registered as public cross-site when OAuth is configured', () => {
    // #given
    const app = buildOperatorApp(
      makeStubDeps({githubOAuth: makeStubGitHubOAuthDeps()}),
      makeStubConfig({githubOAuth: makeStubGitHubOAuthConfig()}),
    )

    // #when / #then — callback is cross-site public
    expect(isPublicCrossSiteRoute(app, 'GET', '/operator/auth/github/callback')).toBe(true)
    expect(isPublicRoute(app, 'GET', '/operator/auth/github/callback')).toBe(true)
  })

  it('oAuth start is NOT cross-site public (only callback is)', () => {
    // #given
    const app = buildOperatorApp(
      makeStubDeps({githubOAuth: makeStubGitHubOAuthDeps()}),
      makeStubConfig({githubOAuth: makeStubGitHubOAuthConfig()}),
    )

    // #when / #then — start is public but NOT cross-site
    expect(isPublicCrossSiteRoute(app, 'GET', '/operator/auth/github/start')).toBe(false)
    expect(isPublicRoute(app, 'GET', '/operator/auth/github/start')).toBe(true)
  })
})

describe('server integration — forwarded-header rejection before CSRF', () => {
  it('rejects with 400 on bad forwarded headers before reaching CSRF check', async () => {
    // #given — server with browser guard enabled
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when — bad forwarded headers (should reject before CSRF check)
    const req = new Request('http://127.0.0.1/operator/session/csrf', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
        'x-forwarded-host': 'evil.attacker.com',
        'x-forwarded-proto': 'https',
      },
    })
    const res = await app.fetch(req)

    // #then — rejected at forwarded-header check (400), not at CSRF check
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// buildOperatorApp — partial browser guard deps throws (Fix 4)
// ---------------------------------------------------------------------------

describe('buildOperatorApp — partial browser guard deps throws at construction time (Fix 4)', () => {
  it('throws when allowlist is provided but csrfSecret is absent', async () => {
    // #given — allowlist present but csrfSecret and auditLogger absent
    const sessionStore = await createTestSessionStore()
    const {allowlist} = makeStubBrowserGuardDeps(sessionStore)

    // #when / #then — partial deps must throw at construction time
    expect(() =>
      buildOperatorApp(
        makeStubDeps({allowlist, sessionStore}), // csrfSecret and auditLogger absent
        makeStubConfig(),
      ),
    ).toThrow(/partial browser guard deps/)
  })

  it('throws when csrfSecret is provided but allowlist is absent', async () => {
    // #given — csrfSecret present but allowlist and auditLogger absent
    const sessionStore = await createTestSessionStore()
    const {csrfSecret} = makeStubBrowserGuardDeps(sessionStore)

    // #when / #then
    expect(() =>
      buildOperatorApp(
        makeStubDeps({csrfSecret, sessionStore}), // allowlist and auditLogger absent
        makeStubConfig(),
      ),
    ).toThrow(/partial browser guard deps/)
  })

  it('throws when auditLogger is provided but allowlist and csrfSecret are absent', async () => {
    // #given — auditLogger present but allowlist and csrfSecret absent
    const sessionStore = await createTestSessionStore()
    const {auditLogger} = makeStubBrowserGuardDeps(sessionStore)

    // #when / #then
    expect(() =>
      buildOperatorApp(
        makeStubDeps({auditLogger, sessionStore}), // allowlist and csrfSecret absent
        makeStubConfig(),
      ),
    ).toThrow(/partial browser guard deps/)
  })

  it('does NOT throw when all four browser guard deps are absent (guard disabled)', () => {
    // #given — no browser guard deps at all
    // #when / #then — all absent is valid (guard disabled)
    expect(() => buildOperatorApp(makeStubDeps(), makeStubConfig())).not.toThrow()
  })

  it('does NOT throw when all four browser guard deps are present (guard enabled)', async () => {
    // #given — all four browser guard deps present
    const sessionStore = await createTestSessionStore()
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)

    // #when / #then — all present is valid (guard enabled)
    expect(() =>
      buildOperatorApp(
        makeStubDeps({allowlist, csrfSecret, auditLogger, sessionStore, sessionDeps: makeStubSessionDeps(), logger}),
        makeStubConfig(),
      ),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// GET /operator/session/csrf — Cache-Control and Vary headers (Fix 7)
// ---------------------------------------------------------------------------

describe('GET /operator/session/csrf — Cache-Control and Vary headers (Fix 7)', () => {
  it('returns Cache-Control: no-store, private on successful CSRF token response', async () => {
    // #given — valid session and allowlisted operator
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when
    const req = new Request('http://127.0.0.1/operator/session/csrf', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
      },
    })
    const res = await app.fetch(req)

    // #then — success with Cache-Control: no-store, private
    expect(res.status).toBe(200)
    const cacheControl = res.headers.get('cache-control') ?? ''
    expect(cacheControl).toContain('no-store')
    expect(cacheControl).toContain('private')
  })

  it('returns Vary header on successful CSRF token response', async () => {
    // #given — valid session and allowlisted operator
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when
    const req = new Request('http://127.0.0.1/operator/session/csrf', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'https://operator.example.com',
      },
    })
    const res = await app.fetch(req)

    // #then — Vary header present
    expect(res.status).toBe(200)
    const vary = res.headers.get('vary') ?? ''
    expect(vary).toContain('Origin')
  })

  it('returns Vary header on rejection response (origin mismatch)', async () => {
    // #given — valid session but wrong Origin
    const sessionStore = await createTestSessionStore()
    const now = Date.now()
    const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps({clock: () => now}),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when — wrong Origin
    const req = new Request('http://127.0.0.1/operator/session/csrf', {
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
// OperatorServerDeps — optional streaming deps wiring
// ---------------------------------------------------------------------------

describe('buildOperatorApp — optional streaming deps accepted without error', () => {
  it('accepts denylistCache, bindingsLookup, and runObservationManager without registering new routes', () => {
    // #given — stub implementations of the three optional streaming deps
    const stubDenylistCache: import('./server.js').OperatorServerDeps['denylistCache'] = {
      getDenylistState: async () => undefined,
      isRepoDenied: () => false,
    }
    const stubBindingsLookup: import('./server.js').OperatorServerDeps['bindingsLookup'] = {
      getBindingByRepo: async () => ({success: true, data: null}),
    }
    const stubRunObservationManager: import('./server.js').OperatorServerDeps['runObservationManager'] = {
      observe: async () => undefined,
      observeOutput: () => undefined,
      observeApproval: () => undefined,
      observeQuestion: () => undefined,
      subscribe: () => () => undefined,
      abortSubscription: () => undefined,
      shutdown: () => undefined,
    }

    // #when — build the app with all three optional deps present
    const app = buildOperatorApp(
      makeStubDeps({
        denylistCache: stubDenylistCache,
        bindingsLookup: stubBindingsLookup,
        runObservationManager: stubRunObservationManager,
      }),
      makeStubConfig(),
    )

    // #then — no error thrown; route inventory is unchanged (no new route registered yet)
    const seen = new Set<string>()
    const routes = app.routes
      .map((route: RouteEntry) => ({method: route.method, path: route.path}))
      .filter((route: RouteEntry) => {
        if (route.method === 'ALL' && route.path === '/*') return false
        const key = `${route.method}:${route.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    expect(routes).toEqual([{method: 'GET', path: '/operator/health'}])
  })

  it('accepts buildOperatorApp without the optional streaming deps (backward-compatible)', () => {
    // #given — no streaming deps (omitted entirely)
    // #when / #then — no error; existing call sites that omit the new deps still compile and run
    expect(() => buildOperatorApp(makeStubDeps(), makeStubConfig())).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// buildOperatorApp — v1.4.0 full route-registration smoke / drift guard
//
// Asserts the registered operator route SET (method + path) equals exactly the
// expected v1.4.0 surface when all privileged deps are present. If a route is
// added or removed, this exact-set assertion fails, forcing a deliberate update
// of this test and the deploy/README Operator API surface table. It guards the
// route set only — per-route auth semantics (Session / CSRF / repo authz) are
// covered by each route's own unit tests, not pinned here.
// ---------------------------------------------------------------------------

/** Shared stub for denylist cache — fail-open for registration tests. */
function makeStubDenylistCache(): NonNullable<OperatorServerDeps['denylistCache']> {
  return {
    getDenylistState: async () => undefined,
    isRepoDenied: () => false,
  }
}

/** Shared stub for bindings lookup — returns null (no binding) for registration tests. */
function makeStubBindingsLookup(): NonNullable<OperatorServerDeps['bindingsLookup']> {
  return {
    getBindingByRepo: async () => ({success: true, data: null}),
  }
}

/** Shared stub for run-observation manager — no-op for registration tests. */
function makeStubRunObservationManager(): NonNullable<OperatorServerDeps['runObservationManager']> {
  return {
    observe: async () => undefined,
    observeOutput: () => undefined,
    observeApproval: () => undefined,
    observeQuestion: () => undefined,
    subscribe: () => () => undefined,
    abortSubscription: () => undefined,
    shutdown: () => undefined,
  }
}

/** Shared stub for run index — never finds a run (registration tests don't exercise lookup). */
function makeStubRunIndex(): NonNullable<OperatorServerDeps['runIndex']> {
  return {
    register: () => undefined,
    lookup: async () => undefined,
    listRunsForRepo: async () => [],
  }
}

/** Shared stub for approval registry — no-op for registration tests. */
function makeStubApprovalRegistry(): NonNullable<OperatorServerDeps['approvalRegistry']> {
  return {
    handleDecision: async () => 'not-found' as const,
    describePendingForScope: () => [],
    hasPendingForScope: () => false,
  }
}

function makeStubQuestionRegistry(): NonNullable<OperatorServerDeps['questionRegistry']> {
  return {
    decide: async () => ({kind: 'not-found' as const}),
    describePendingForRun: () => [],
    isClaimed: () => false,
    hasPendingForScope: () => false,
  }
}

/** Shared stub for cancelRunDeps — opaque sentinel for registration tests only. */
function makeStubCancelRunDeps(): NonNullable<OperatorServerDeps['cancelRunDeps']> {
  // Registration only checks `deps.cancelRunDeps !== undefined`; the actual
  // shape is not inspected at construction time. Cast to satisfy the type.
  return {} as unknown as NonNullable<OperatorServerDeps['cancelRunDeps']>
}

/** Shared stub for launchWorkDeps — opaque sentinel for registration tests only. */
function makeStubLaunchWorkDeps(): NonNullable<OperatorServerDeps['launchWorkDeps']> {
  // Registration only checks `deps.launchWorkDeps !== undefined`; the actual
  // shape is not inspected at construction time. Cast to satisfy the type.
  return {} as unknown as NonNullable<OperatorServerDeps['launchWorkDeps']>
}

/** Shared stub for the operator push subscription store — no-op for registration tests. */
function makeStubOperatorPushStore(): NonNullable<OperatorServerDeps['operatorPushStore']> {
  return {
    subscribe: async () => ({
      success: true as const,
      data: {
        endpointHash: 'stub-hash',
        operatorId: 'stub-operator',
        active: true,
        keyVersion: '1',
        ownershipGeneration: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    }),
    unsubscribe: async () => ({success: true as const, data: undefined}),
    listMetadataForOperator: async () => ({success: true as const, data: []}),
  }
}

/** Shared stub for client-safe VAPID key info — registration tests only. */
function makeStubOperatorPushVapidKeyInfo(): NonNullable<OperatorServerDeps['operatorPushVapidKeyInfo']> {
  return {
    publicKey: 'BOb1EqJOpvFSxr2XOPIr82Ktdxl6AibGOAiPmrkjbsv0mpr9In09mLbskqVAgLPIDjb0UIb7mZpU0SJKWWsVazc',
    keyVersion: '1',
  }
}

/** Build a full-deps OperatorServerDeps with all privileged routes enabled. */
function makeFullPrivilegedDeps(sessionStore: Awaited<ReturnType<typeof createTestSessionStore>>): OperatorServerDeps {
  const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
  return makeStubDeps({
    logger,
    auditLogger,
    allowlist,
    csrfSecret,
    sessionStore,
    sessionDeps: makeStubSessionDeps(),
    githubOAuth: makeStubGitHubOAuthDeps(),
    denylistCache: makeStubDenylistCache(),
    bindingsLookup: makeStubBindingsLookup(),
    runObservationManager: makeStubRunObservationManager(),
    runIndex: makeStubRunIndex(),
    listBindings: async () => ({success: true, data: []}),
    getBindingByRepo: async () => ({success: true, data: null}),
    launchWorkDeps: makeStubLaunchWorkDeps(),
    dispatchWorkflow: async (owner: string, repo: string) => ({outcome: 'accepted' as const, owner, repo}),
    approvalRegistry: makeStubApprovalRegistry(),
    questionRegistry: makeStubQuestionRegistry(),
    cancelRunDeps: makeStubCancelRunDeps(),
    operatorPushStore: makeStubOperatorPushStore(),
    operatorPushVapidKeyInfo: makeStubOperatorPushVapidKeyInfo(),
    rateLimiter: {allow: () => true},
  })
}

/** Extract unique logical routes from a Hono app (excludes ALL /* middleware entries). */
function extractRoutes(app: import('hono').Hono): {method: string; path: string}[] {
  const seen = new Set<string>()
  return app.routes
    .map((route: RouteEntry) => ({method: route.method, path: route.path}))
    .filter((route: RouteEntry) => {
      if (route.method === 'ALL' && route.path === '/*') return false
      const key = `${route.method}:${route.path}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

describe('buildOperatorApp — v1.5.0 full route-registration smoke (drift guard)', async () => {
  it('registers exactly the expected v1.5.0 operator route set when all privileged deps are present', async () => {
    // #given — all privileged deps present
    const sessionStore = await createTestSessionStore()
    const app = buildOperatorApp(
      makeFullPrivilegedDeps(sessionStore),
      makeStubConfig({githubOAuth: makeStubGitHubOAuthConfig()}),
    )

    // #when — extract registered routes
    const routes = extractRoutes(app)

    // #then — exact v1.5.0 set (order-independent)
    // If this assertion fails, a route was added or removed. Update EXPECTED_OPERATOR_ROUTES
    // in operator-route-smoke.ts (the single canonical source) AND the deploy/README
    // "Operator API surface" table to keep them in sync.
    const routeSet = new Set(routes.map(r => `${r.method}:${r.path}`))
    const expectedV15Routes = new Set(EXPECTED_OPERATOR_ROUTES.map(r => `${r.method}:${r.path}`))

    expect(routeSet).toEqual(expectedV15Routes)
    expect(routes).toHaveLength(expectedV15Routes.size)
  })

  it('dep-gated negative case: without the question registry the question routes and the run listing are absent', async () => {
    // #given — every privileged dep except the question registry
    const sessionStore = await createTestSessionStore()
    const app = buildOperatorApp(
      {...makeFullPrivilegedDeps(sessionStore), questionRegistry: undefined},
      makeStubConfig({githubOAuth: makeStubGitHubOAuthConfig()}),
    )

    // #when
    const routeSet = new Set(extractRoutes(app).map(r => `${r.method}:${r.path}`))

    // #then — the two question routes and GET /operator/runs (waiting overlay needs the registry) are missing
    const missing = EXPECTED_OPERATOR_ROUTES.map(r => `${r.method}:${r.path}`).filter(key => !routeSet.has(key))
    expect(missing.toSorted()).toEqual([
      'GET:/operator/runs',
      'GET:/operator/runs/:runId/questions',
      'POST:/operator/runs/:runId/questions/:requestId/decision',
    ])
  })

  it('dep-gated negative case: without the approval registry the approval routes and the run listing are absent', async () => {
    // #given — every privileged dep except the approval registry
    const sessionStore = await createTestSessionStore()
    const app = buildOperatorApp(
      {...makeFullPrivilegedDeps(sessionStore), approvalRegistry: undefined},
      makeStubConfig({githubOAuth: makeStubGitHubOAuthConfig()}),
    )

    // #when
    const routeSet = new Set(extractRoutes(app).map(r => `${r.method}:${r.path}`))

    // #then — GET /operator/runs is among the missing routes
    const missing = EXPECTED_OPERATOR_ROUTES.map(r => `${r.method}:${r.path}`).filter(key => !routeSet.has(key))
    expect(missing).toContain('GET:/operator/runs')
    expect(missing).toContain('GET:/operator/runs/:runId/approvals')
  })

  it.each(['denylistCache', 'bindingsLookup', 'runObservationManager', 'runIndex'] as const)(
    'dep-gated negative case: without %s the run-stream route is unmounted and nothing else is',
    async omitted => {
      // #given — every privileged dep except one of the stream route's own dependencies
      const sessionStore = await createTestSessionStore()
      const app = buildOperatorApp(
        {...makeFullPrivilegedDeps(sessionStore), [omitted]: undefined},
        makeStubConfig({githubOAuth: makeStubGitHubOAuthConfig()}),
      )

      // #when
      const routeSet = new Set(extractRoutes(app).map(r => `${r.method}:${r.path}`))

      // #then — the stream route is among the missing routes (the omission is visible, not silent)
      const missing = EXPECTED_OPERATOR_ROUTES.map(r => `${r.method}:${r.path}`).filter(key => !routeSet.has(key))
      expect(missing).toContain('GET:/operator/runs/:runId/stream')
    },
  )

  it.each(['allowlist', 'auditLogger'] as const)(
    'omitting %s (a run-stream lease dependency) fails construction and names it instead of unmounting silently',
    async omitted => {
      // #given — the stream route needs the allowlist and audit logger for its lease re-checks;
      // both belong to the all-or-nothing browser guard
      const sessionStore = await createTestSessionStore()
      const deps = {...makeFullPrivilegedDeps(sessionStore), [omitted]: undefined}

      // #when / #then
      expect(() => buildOperatorApp(deps, makeStubConfig({githubOAuth: makeStubGitHubOAuthConfig()}))).toThrow(
        new RegExp(`Missing: ${omitted}`),
      )
    },
  )

  it('question decision route: a body over 64 KiB is rejected before session or run lookup', async () => {
    // #given — the full route set with spies on the session and run-index lookups
    const sessionStore = await createTestSessionStore()
    const getSpy = vi.spyOn(sessionStore, 'get')
    const lookup = vi.fn(async () => undefined)
    const base = makeFullPrivilegedDeps(sessionStore)
    const app = buildOperatorApp(
      {...base, runIndex: {...makeStubRunIndex(), lookup}},
      makeStubConfig({githubOAuth: makeStubGitHubOAuthConfig()}),
    )

    // #when — an oversized body is posted to the question decision route
    const res = await app.fetch(
      new Request('http://localhost/operator/runs/run-1/questions/que_1/decision', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: Buffer.alloc(65 * 1024 + 1, 0x41),
      }),
    )

    // #then — the global body limit answers 413 and nothing was looked up
    expect(res.status).toBe(413)
    expect(lookup).not.toHaveBeenCalled()
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('dep-gated negative case: without run/approval deps, privileged run/approval routes do NOT register', async () => {
    // #given — only OAuth + session/browser-guard deps (no launchWorkDeps, runIndex,
    // denylistCache, bindingsLookup, runObservationManager, approvalRegistry)
    const sessionStore = await createTestSessionStore()
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        logger,
        auditLogger,
        allowlist,
        csrfSecret,
        sessionStore,
        sessionDeps: makeStubSessionDeps(),
        githubOAuth: makeStubGitHubOAuthDeps(),
        rateLimiter: {allow: () => true},
        // Intentionally absent: denylistCache, bindingsLookup, runObservationManager,
        // runIndex, listBindings, getBindingByRepo, launchWorkDeps, approvalRegistry
      }),
      makeStubConfig({githubOAuth: makeStubGitHubOAuthConfig()}),
    )

    // #when — extract registered routes
    const routes = extractRoutes(app)
    const routePaths = routes.map(r => `${r.method}:${r.path}`)

    // #then — run/approval routes are NOT registered (conditional gating is real)
    expect(routePaths).not.toContain('GET:/operator/repos')
    expect(routePaths).not.toContain('GET:/operator/runs')
    expect(routePaths).not.toContain('POST:/operator/runs')
    expect(routePaths).not.toContain('GET:/operator/runs/:runId/stream')
    expect(routePaths).not.toContain('POST:/operator/runs/:runId/approvals/:requestId/decision')
    expect(routePaths).not.toContain('GET:/operator/runs/:runId/approvals')
    expect(routePaths).not.toContain('POST:/operator/runs/:runId/cancel')

    // #and — health, auth, session routes ARE registered
    expect(routePaths).toContain('GET:/operator/health')
    expect(routePaths).toContain('GET:/operator/auth/github/start')
    expect(routePaths).toContain('GET:/operator/auth/github/callback')
    expect(routePaths).toContain('POST:/operator/auth/logout')
    expect(routePaths).toContain('GET:/operator/session/csrf')
    expect(routePaths).toContain('GET:/operator/session')
  })
})

// ---------------------------------------------------------------------------
// #1639 — production wiring: RunIndex.readRun reaches the run-stream route
// ---------------------------------------------------------------------------

interface SseChunk {
  readonly done: boolean
  readonly value?: Uint8Array
}

/** Reads an SSE body, resolving `done: true` only if the server ends the stream within `idleMs`. */
function openStream(res: Response) {
  const reader = res.body?.getReader()
  if (reader === undefined) throw new Error('expected a readable SSE body')
  const decoder = new TextDecoder()
  let pending: Promise<SseChunk> | undefined
  return {
    async readToEnd(idleMs: number): Promise<{text: string; done: boolean}> {
      let text = ''
      for (let i = 0; i < 50; i++) {
        pending ??= reader.read() as Promise<SseChunk>
        const result = await Promise.race([
          pending,
          new Promise<'idle'>(resolve => setTimeout(() => resolve('idle'), idleMs)),
        ])
        if (result === 'idle') return {text, done: false}
        pending = undefined
        if (result.done === true) return {text, done: true}
        text += decoder.decode(result.value, {stream: true})
      }
      return {text, done: false}
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => undefined)
    },
  }
}

const eventNames = (text: string): string[] =>
  [...text.matchAll(/^event: (\w+)$/gm)].map(m => m[1]).filter((n): n is string => n !== undefined)

describe('buildOperatorApp — run stream resolves an evicted terminal run from persisted state (#1639)', () => {
  const RUN_ID = 'run-evicted'
  const LIVE_RUN_ID = 'run-live'
  const REPO = 'acme/widget'
  const BOUNDED_MS = 2_000

  function makePersistedRunState(runId: string, phase: RunState['phase']): RunState {
    return {
      run_id: runId,
      surface: 'github',
      thread_id: 'thread-001',
      entity_ref: `${REPO}#1`,
      phase,
      started_at: '2024-01-01T00:00:00.000Z',
      last_heartbeat: '2024-01-01T00:00:00.000Z',
      holder_id: 'holder-001',
      details: {},
    }
  }

  it(
    'emits ready, reset, terminal status then closes and releases the slot via the real server wiring',
    {timeout: 10_000},
    async () => {
      // #given the real operator app with an authorized operator session on a non-denied repo
      const sessionStore = await createTestSessionStore()
      const now = Date.now()
      const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})
      const guard = makeStubBrowserGuardDeps(sessionStore)

      // #given a persisted terminal RunState for RUN_ID (and a still-running one for LIVE_RUN_ID)
      const readRun = vi.fn(async (_repo: string, runId: string) =>
        makePersistedRunState(runId, runId === RUN_ID ? 'COMPLETED' : 'EXECUTING'),
      )
      const runIndex = {
        register: () => undefined,
        lookup: async () => ({repo: REPO, surface: 'github' as const}),
        listRunsForRepo: async () => [],
        readRun,
      }

      // #given an SSE manager with NO replay entry for either run (the cache-miss / restart case)
      const manager = createRunObservationManager({
        projectBase: async runState => ({
          kind: 'projected',
          status: {
            runId: runState.run_id,
            entityRef: runState.entity_ref,
            surface: runState.surface,
            phase: runState.phase,
            status: runState.phase === 'COMPLETED' ? 'succeeded' : 'running',
            startedAt: runState.started_at,
            stale: false,
          },
          repoKey: {databaseId: 1, nodeId: 'R_1'},
        }),
        waiting: {hasPendingApproval: () => false, hasPendingQuestion: () => false},
        isRepoDenied: () => false,
        logger: makeLogger(),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        now: () => Date.now(),
      })

      const app = buildOperatorApp(
        makeStubDeps({
          ...guard,
          sessionDeps: makeStubSessionDeps({clock: () => now}),
          denylistCache: makeStubDenylistCache(),
          bindingsLookup: {
            getBindingByRepo: async () => ({success: true, data: {databaseId: 42, nodeId: 'node-id-1'}}),
          },
          runObservationManager: manager,
          runIndex,
          rateLimiter: {allow: () => true},
        }),
        makeStubConfig({publicOrigin: 'https://operator.example.com'}),
      )
      const open = async (runId: string): Promise<Response> =>
        app.fetch(
          new Request(`http://127.0.0.1/operator/runs/${runId}/stream`, {
            headers: {cookie: `${SESSION_COOKIE_NAME}=${sessionId}`, origin: 'https://operator.example.com'},
          }),
        )
      const live: ReturnType<typeof openStream>[] = []

      try {
        // #given four live streams holding slots (default per-operator cap is 5)
        for (let i = 0; i < 4; i++) {
          const res = await open(LIVE_RUN_ID)
          expect(res.status).toBe(200)
          const stream = openStream(res)
          live.push(stream)
          expect(eventNames((await stream.readToEnd(150)).text)).toEqual(['ready', 'reset'])
        }

        // #when the operator opens the stream for the evicted terminal run
        const res = await open(RUN_ID)
        expect(res.status).toBe(200)
        const {text, done} = await openStream(res).readToEnd(BOUNDED_MS)

        // #then ready, then reset, then the terminal status — in that order
        expect(eventNames(text)).toEqual(['ready', 'reset', 'status'])
        expect(text).toContain('"status":"succeeded"')
        // #then the persisted state was read for the server-resolved repo (proves server.ts passes readRun through)
        expect(readRun).toHaveBeenCalledWith(REPO, RUN_ID)
        // #then the stream closed on its own
        expect(done).toBe(true)

        // #then its slot was released: a fifth live stream is admitted, and only a sixth is refused
        const fifth = await open(LIVE_RUN_ID)
        expect(fifth.status).toBe(200)
        live.push(openStream(fifth))
        const sixth = await open(LIVE_RUN_ID)
        expect(sixth.status).toBe(429)
        await sixth.body?.cancel()
      } finally {
        await Promise.all(live.map(async stream => stream.cancel()))
        manager.shutdown()
      }
    },
  )
})

// ---------------------------------------------------------------------------
// GET /operator/session — push health (authenticated, optional)
// ---------------------------------------------------------------------------

async function fetchSession(operatorPushHealth?: OperatorServerDeps['operatorPushHealth']) {
  const sessionStore = await createTestSessionStore()
  const now = Date.now()
  const sessionId = await mintTestSession(sessionStore, {githubUserId: 42, login: 'octocat'})

  const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
  const app = buildOperatorApp(
    makeStubDeps({
      sessionStore,
      sessionDeps: makeStubSessionDeps({clock: () => now}),
      allowlist,
      csrfSecret,
      auditLogger,
      logger,
      rateLimiter: {allow: () => true},
      operatorPushHealth,
    }),
    makeStubConfig({publicOrigin: 'https://operator.example.com'}),
  )

  const res = await app.fetch(
    new Request('http://127.0.0.1/operator/session', {
      headers: {cookie: `${SESSION_COOKIE_NAME}=${sessionId}`, origin: 'https://operator.example.com'},
    }),
  )
  return {res, body: (await res.json()) as Record<string, unknown>}
}

describe('GET /operator/session — push health through buildOperatorApp', () => {
  it.each(['ready', 'degraded', 'unknown'] as const)(
    'returns push: {status: %s} to an authenticated operator',
    async status => {
      // #when
      const {res, body} = await fetchSession(() => status)

      // #then
      expect(res.status).toBe(200)
      expect(body.push).toEqual({status})
      expect(Object.keys(body).sort()).toEqual(['expiresAt', 'login', 'operatorId', 'push'])
    },
  )

  it('omits push when no reader is supplied', async () => {
    // #when
    const {res, body} = await fetchSession(undefined)

    // #then
    expect(res.status).toBe(200)
    expect('push' in body).toBe(false)
  })

  it('omits push when the reader reports disabled', async () => {
    // #when
    const {res, body} = await fetchSession(() => 'disabled')

    // #then
    expect(res.status).toBe(200)
    expect('push' in body).toBe(false)
  })

  it('does not expose push health to an unauthenticated caller', async () => {
    // #given a reader that would report degraded
    const sessionStore = await createTestSessionStore()
    const {logger, auditLogger, allowlist, csrfSecret} = makeStubBrowserGuardDeps(sessionStore)
    const app = buildOperatorApp(
      makeStubDeps({
        sessionStore,
        sessionDeps: makeStubSessionDeps(),
        allowlist,
        csrfSecret,
        auditLogger,
        logger,
        rateLimiter: {allow: () => true},
        operatorPushHealth: () => 'degraded',
      }),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when no session cookie is presented
    const res = await app.fetch(
      new Request('http://127.0.0.1/operator/session', {headers: {origin: 'https://operator.example.com'}}),
    )

    // #then
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('degraded')
  })
})
