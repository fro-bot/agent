/**
 * Tests for the operator web listener.
 *
 * Covers:
 *   - Happy path: listener starts only when all required config is present.
 *   - Error path: partial config fails closed during startup.
 *   - Security: unauthenticated floods hit socket-keyed rate limits and bounded body handling.
 *   - Shutdown: closing the Gateway closes the operator server without hanging active handles.
 *   - Health route: GET /operator/health returns 200 {ok:true}.
 *   - Rate limiter: limit enforcement, window reset, key isolation.
 *   - Forwarded headers: no headers, only host, only proto, proto=http, host with port, comma-separated.
 *   - Drain gate: returns 503 before body-limit (drain fires first).
 *   - Warning log: coarse warning on drain/rejection paths.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import type {AddressInfo} from 'node:net'
import type {ServerType} from '@hono/node-server'

import type {OperatorServerConfig, OperatorServerDeps} from './server.js'
import {Buffer} from 'node:buffer'
import {createServer} from 'node:http'

import {describe, expect, it, vi} from 'vitest'
import {createRateLimiter} from '../http/rate-limit.js'
import {buildOperatorApp, createOperatorServer} from './server.js'

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
    ...overrides,
  }
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
// GET /operator/health — happy path
// ---------------------------------------------------------------------------

describe('GET /operator/health — happy path', () => {
  it('returns 200 {ok:true} when the listener is running', async () => {
    // #given
    const port = await findFreePort()
    const server = createOperatorServer(makeStubDeps(), makeStubConfig({bindPort: port}))

    try {
      // #when
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`)
      const body = await res.json()

      // #then
      expect(res.status).toBe(200)
      expect(body).toEqual({ok: true})
    } finally {
      await closeServer(server)
    }
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
  it('returns 429 when the socket-keyed rate limiter is exhausted', async () => {
    // #given — rate limiter that always denies
    const port = await findFreePort()
    const server = createOperatorServer(
      makeStubDeps({rateLimiter: {allow: () => false}}),
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

describe('operator server — trusted origin enforcement', () => {
  it('rejects requests with X-Forwarded-Host that does not match publicOrigin', async () => {
    // #given
    const port = await findFreePort()
    const server = createOperatorServer(
      makeStubDeps(),
      makeStubConfig({
        bindPort: port,
        publicOrigin: 'https://operator.example.com',
      }),
    )

    try {
      // #when — send a request with a mismatched forwarded host
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {
          'x-forwarded-host': 'evil.attacker.com',
          'x-forwarded-proto': 'https',
        },
      })
      const body = await res.json()

      // #then — rejected as untrusted
      expect(res.status).toBe(400)
      expect(body).toEqual({error: 'bad request'})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('accepts requests with X-Forwarded-Host matching publicOrigin', async () => {
    // #given
    const port = await findFreePort()
    const server = createOperatorServer(
      makeStubDeps(),
      makeStubConfig({
        bindPort: port,
        publicOrigin: 'https://operator.example.com',
      }),
    )

    try {
      // #when — send a request with the correct forwarded host
      const res = await fetch(`http://127.0.0.1:${port}/operator/health`, {
        headers: {
          'x-forwarded-host': 'operator.example.com',
          'x-forwarded-proto': 'https',
        },
      })
      const body = await res.json()

      // #then — accepted (health route is not privileged)
      expect(res.status).toBe(200)
      expect(body).toEqual({ok: true})
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('rejects requests with only X-Forwarded-Host (no proto) — partial headers', async () => {
    // #given
    const app = buildOperatorApp(makeStubDeps(), makeStubConfig())

    // #when
    const req = new Request('http://127.0.0.1/operator/health', {
      headers: {'x-forwarded-host': 'operator.example.com'},
    })
    const res = await app.fetch(req)

    // #then — partial forwarded headers are suspicious; reject
    expect(res.status).toBe(400)
  })

  it('rejects requests with only X-Forwarded-Proto (no host) — partial headers', async () => {
    // #given
    const app = buildOperatorApp(makeStubDeps(), makeStubConfig())

    // #when
    const req = new Request('http://127.0.0.1/operator/health', {
      headers: {'x-forwarded-proto': 'https'},
    })
    const res = await app.fetch(req)

    // #then — partial forwarded headers are suspicious; reject
    expect(res.status).toBe(400)
  })

  it('rejects requests with X-Forwarded-Proto=http (not https)', async () => {
    // #given
    const app = buildOperatorApp(makeStubDeps(), makeStubConfig({publicOrigin: 'https://operator.example.com'}))

    // #when
    const req = new Request('http://127.0.0.1/operator/health', {
      headers: {
        'x-forwarded-host': 'operator.example.com',
        'x-forwarded-proto': 'http',
      },
    })
    const res = await app.fetch(req)

    // #then — http proto is not acceptable; TLS is required
    expect(res.status).toBe(400)
  })

  it('accepts X-Forwarded-Host with port suffix (host:port form)', async () => {
    // #given — publicOrigin has no port; forwarded host includes port
    // Inject a stub rate limiter so getConnInfo (which needs a real socket) is not reached
    const app = buildOperatorApp(
      makeStubDeps({rateLimiter: {allow: () => true}}),
      makeStubConfig({publicOrigin: 'https://operator.example.com'}),
    )

    // #when — host with port suffix should match after stripping port
    const req = new Request('http://127.0.0.1/operator/health', {
      headers: {
        'x-forwarded-host': 'operator.example.com:443',
        'x-forwarded-proto': 'https',
      },
    })
    const res = await app.fetch(req)

    // #then — port suffix is stripped for comparison; accepted
    expect(res.status).toBe(200)
  })

  it('rejects comma-separated X-Forwarded-Host (multi-value header)', async () => {
    // #given — comma-separated host is not a valid single host match
    const app = buildOperatorApp(makeStubDeps(), makeStubConfig({publicOrigin: 'https://operator.example.com'}))

    // #when
    const req = new Request('http://127.0.0.1/operator/health', {
      headers: {
        'x-forwarded-host': 'operator.example.com, evil.attacker.com',
        'x-forwarded-proto': 'https',
      },
    })
    const res = await app.fetch(req)

    // #then — comma-separated host does not match the expected host; reject
    expect(res.status).toBe(400)
  })

  it('no forwarded headers — direct connection — accepted', async () => {
    // #given — inject stub rate limiter so getConnInfo (needs real socket) is not reached
    const app = buildOperatorApp(makeStubDeps({rateLimiter: {allow: () => true}}), makeStubConfig())

    // #when — no forwarded headers at all
    const req = new Request('http://127.0.0.1/operator/health')
    const res = await app.fetch(req)

    // #then — direct connection with no forwarded headers is allowed
    expect(res.status).toBe(200)
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
})
