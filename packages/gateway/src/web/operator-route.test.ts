/**
 * Tests for the operator route guardrail seam.
 *
 * Covers:
 *   - Static guard: a route registered without the wrapper causes the static test to fail.
 *   - Static guard: all routes registered through the wrapper pass the static test.
 *   - Static guard: the health route is explicitly public/unprivileged.
 *   - Wrapper metadata: registerOperatorRoute marks routes as privileged.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import type {Context} from 'hono'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {
  assertAllPrivilegedRoutesWrapped,
  getOperatorAuthContext,
  getOperatorRouteGuard,
  isPrivilegedRoute,
  isPublicCrossSiteRoute,
  isPublicRoute,
  registerOperatorRoute,
  registerPublicCrossSiteRoute,
  registerPublicRoute,
  setOperatorRouteGuard,
} from './operator-route.js'

// ---------------------------------------------------------------------------
// registerOperatorRoute — wrapper metadata
// ---------------------------------------------------------------------------

describe('registerOperatorRoute — wrapper metadata', () => {
  it('marks a registered route as privileged', () => {
    // #given
    const app = new Hono()

    // #when
    registerOperatorRoute(app, 'GET', '/operator/test', (c: Context) => {
      return c.json({ok: true})
    })

    // #then — the route is marked as privileged
    expect(isPrivilegedRoute(app, 'GET', '/operator/test')).toBe(true)
  })

  it('marks multiple routes as privileged', () => {
    // #given
    const app = new Hono()

    // #when
    registerOperatorRoute(app, 'GET', '/operator/runs', (c: Context) => c.json({runs: []}))
    registerOperatorRoute(app, 'POST', '/operator/runs', (c: Context) => c.json({runId: 'r1'}))

    // #then — both routes are marked as privileged
    expect(isPrivilegedRoute(app, 'GET', '/operator/runs')).toBe(true)
    expect(isPrivilegedRoute(app, 'POST', '/operator/runs')).toBe(true)
  })

  it('does not mark a route as privileged when registered directly on the app', () => {
    // #given
    const app = new Hono()

    // #when — register directly without the wrapper
    app.get('/operator/unwrapped', (c: Context) => c.json({ok: true}))

    // #then — the route is NOT marked as privileged
    expect(isPrivilegedRoute(app, 'GET', '/operator/unwrapped')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// registerPublicRoute — public route metadata
// ---------------------------------------------------------------------------

describe('registerPublicRoute — public route metadata', () => {
  it('marks a registered route as public', () => {
    // #given
    const app = new Hono()

    // #when
    registerPublicRoute(app, 'GET', '/operator/health', (c: Context) => c.json({ok: true}))

    // #then — the route is marked as public
    expect(isPublicRoute(app, 'GET', '/operator/health')).toBe(true)
  })

  it('does not mark a public route as privileged', () => {
    // #given
    const app = new Hono()

    // #when
    registerPublicRoute(app, 'GET', '/operator/health', (c: Context) => c.json({ok: true}))

    // #then — public routes are not privileged
    expect(isPrivilegedRoute(app, 'GET', '/operator/health')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// assertAllPrivilegedRoutesWrapped — static guard
// ---------------------------------------------------------------------------

describe('assertAllPrivilegedRoutesWrapped — static guard', () => {
  it('passes when all non-health operator routes are wrapped', () => {
    // #given
    const app = new Hono()
    registerPublicRoute(app, 'GET', '/operator/health', (c: Context) => c.json({ok: true}))
    registerOperatorRoute(app, 'GET', '/operator/runs', (c: Context) => c.json({runs: []}))

    // #when / #then — no throw
    expect(() => assertAllPrivilegedRoutesWrapped(app)).not.toThrow()
  })

  it('passes when only the health route is registered (no privileged routes)', () => {
    // #given
    const app = new Hono()
    registerPublicRoute(app, 'GET', '/operator/health', (c: Context) => c.json({ok: true}))

    // #when / #then — no throw
    expect(() => assertAllPrivilegedRoutesWrapped(app)).not.toThrow()
  })

  it('throws when an operator route is registered without the wrapper', () => {
    // #given — a route registered directly (bypassing the wrapper)
    const app = new Hono()
    registerPublicRoute(app, 'GET', '/operator/health', (c: Context) => c.json({ok: true}))
    // Directly register without wrapper — this is the violation
    app.get('/operator/runs', (c: Context) => c.json({runs: []}))

    // #when / #then — must throw naming the unwrapped route
    expect(() => assertAllPrivilegedRoutesWrapped(app)).toThrow(/\/operator\/runs/)
  })

  it('throws when multiple operator routes are registered without the wrapper', () => {
    // #given
    const app = new Hono()
    registerPublicRoute(app, 'GET', '/operator/health', (c: Context) => c.json({ok: true}))
    app.get('/operator/runs', (c: Context) => c.json({runs: []}))
    app.post('/operator/runs', (c: Context) => c.json({runId: 'r1'}))

    // #when / #then — must throw naming the unwrapped routes
    expect(() => assertAllPrivilegedRoutesWrapped(app)).toThrow()
  })

  it('passes when app has no operator routes at all', () => {
    // #given — empty app
    const app = new Hono()

    // #when / #then — no throw
    expect(() => assertAllPrivilegedRoutesWrapped(app)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// assertAllPrivilegedRoutesWrapped — bare /operator and ALL-method violations
// ---------------------------------------------------------------------------

describe('assertAllPrivilegedRoutesWrapped — bare /operator and ALL-method routes', () => {
  it('throws when bare /operator route is registered directly', () => {
    // #given — direct registration on the exact /operator path (no trailing slash)
    const app = new Hono()
    app.get('/operator', (c: Context) => c.json({ok: true}))

    // #when / #then — bare /operator must be caught
    expect(() => assertAllPrivilegedRoutesWrapped(app)).toThrow(/\/operator/)
  })

  it('throws when app.use registers a handler on an operator path (ALL method)', () => {
    // #given — app.use('/operator/bypass', ...) registers an ALL-method entry
    const app = new Hono()
    app.use('/operator/bypass', async (c, _next) => {
      // simulates a direct response handler registered via app.use
      return c.json({bypassed: true})
    })

    // #when / #then — ALL-method operator path must be caught
    expect(() => assertAllPrivilegedRoutesWrapped(app)).toThrow(/\/operator\/bypass/)
  })

  it('throws when app.all registers a handler on an operator path', () => {
    // #given — app.all('/operator/bypass', ...) registers an ALL-method route
    const app = new Hono()
    app.all('/operator/bypass', (c: Context) => c.json({bypassed: true}))

    // #when / #then — ALL-method operator route must be caught
    expect(() => assertAllPrivilegedRoutesWrapped(app)).toThrow(/\/operator\/bypass/)
  })

  it('throws when a wrapped route is also registered directly (duplicate same method+path)', () => {
    // #given — registerOperatorRoute wraps GET /operator/x, then app.get registers it again
    const app = new Hono()
    registerOperatorRoute(app, 'GET', '/operator/x', (c: Context) => c.json({wrapped: true}))
    // Direct registration after wrapping — duplicate
    app.get('/operator/x', (c: Context) => c.json({direct: true}))

    // #when / #then — duplicate must throw
    expect(() => assertAllPrivilegedRoutesWrapped(app)).toThrow(/\/operator\/x/)
  })
})

// ---------------------------------------------------------------------------
// registerOperatorRoute — duplicate detection
// ---------------------------------------------------------------------------

describe('registerOperatorRoute — duplicate detection', () => {
  it('throws when the same method+path is registered twice via registerOperatorRoute', () => {
    // #given
    const app = new Hono()
    registerOperatorRoute(app, 'GET', '/operator/runs', (c: Context) => c.json({runs: []}))

    // #when / #then — second registration must throw
    expect(() => {
      registerOperatorRoute(app, 'GET', '/operator/runs', (c: Context) => c.json({runs: []}))
    }).toThrow(/duplicate registration/)
  })

  it('throws when registerPublicRoute is called after registerOperatorRoute for the same path', () => {
    // #given
    const app = new Hono()
    registerOperatorRoute(app, 'GET', '/operator/runs', (c: Context) => c.json({runs: []}))

    // #when / #then
    expect(() => {
      registerPublicRoute(app, 'GET', '/operator/runs', (c: Context) => c.json({runs: []}))
    }).toThrow(/duplicate registration/)
  })
})

// ---------------------------------------------------------------------------
// registerPublicCrossSiteRoute — cross-site public route classification
// ---------------------------------------------------------------------------

describe('registerPublicCrossSiteRoute — cross-site public route metadata', () => {
  it('marks a registered route as public cross-site', () => {
    // #given
    const app = new Hono()

    // #when
    registerPublicCrossSiteRoute(app, 'GET', '/operator/auth/github/callback', (c: Context) => c.json({ok: true}))

    // #then — the route is marked as public cross-site
    expect(isPublicCrossSiteRoute(app, 'GET', '/operator/auth/github/callback')).toBe(true)
  })

  it('also marks a cross-site route as public (not privileged)', () => {
    // #given
    const app = new Hono()

    // #when
    registerPublicCrossSiteRoute(app, 'GET', '/operator/auth/github/callback', (c: Context) => c.json({ok: true}))

    // #then — cross-site routes are public, not privileged
    expect(isPublicRoute(app, 'GET', '/operator/auth/github/callback')).toBe(true)
    expect(isPrivilegedRoute(app, 'GET', '/operator/auth/github/callback')).toBe(false)
  })

  it('assertAllPrivilegedRoutesWrapped accepts cross-site public routes as classified', () => {
    // #given
    const app = new Hono()
    registerPublicRoute(app, 'GET', '/operator/health', (c: Context) => c.json({ok: true}))
    registerPublicCrossSiteRoute(app, 'GET', '/operator/auth/github/callback', (c: Context) => c.json({ok: true}))

    // #when / #then — no throw
    expect(() => assertAllPrivilegedRoutesWrapped(app)).not.toThrow()
  })

  it('throws on duplicate registration across all registries', () => {
    // #given
    const app = new Hono()
    registerPublicCrossSiteRoute(app, 'GET', '/operator/auth/github/callback', (c: Context) => c.json({ok: true}))

    // #when / #then — second registration must throw
    expect(() => {
      registerPublicCrossSiteRoute(app, 'GET', '/operator/auth/github/callback', (c: Context) => c.json({ok: true}))
    }).toThrow(/duplicate registration/)
  })

  it('throws when registerPublicRoute is called after registerPublicCrossSiteRoute for the same path', () => {
    // #given
    const app = new Hono()
    registerPublicCrossSiteRoute(app, 'GET', '/operator/auth/github/callback', (c: Context) => c.json({ok: true}))

    // #when / #then
    expect(() => {
      registerPublicRoute(app, 'GET', '/operator/auth/github/callback', (c: Context) => c.json({ok: true}))
    }).toThrow(/duplicate registration/)
  })

  it('non-cross-site route returns false for isPublicCrossSiteRoute', () => {
    // #given
    const app = new Hono()
    registerPublicRoute(app, 'GET', '/operator/health', (c: Context) => c.json({ok: true}))

    // #when / #then
    expect(isPublicCrossSiteRoute(app, 'GET', '/operator/health')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// setOperatorRouteGuard / getOperatorRouteGuard — guard seam
// ---------------------------------------------------------------------------

describe('setOperatorRouteGuard — guard installation', () => {
  it('getOperatorRouteGuard returns undefined when no guard is installed', () => {
    // #given
    const app = new Hono()

    // #when / #then — no guard installed
    expect(getOperatorRouteGuard(app)).toBeUndefined()
  })

  it('getOperatorRouteGuard returns the installed guard', () => {
    // #given
    const app = new Hono()
    const guard = vi.fn(async () => ({ok: true as const, githubUserId: 42, sessionId: 'sid'}))

    // #when
    setOperatorRouteGuard(app, guard)

    // #then — guard is retrievable
    expect(getOperatorRouteGuard(app)).toBe(guard)
  })

  it('throws when setOperatorRouteGuard is called twice for the same app', () => {
    // #given
    const app = new Hono()
    const guard = vi.fn(async () => ({ok: true as const, githubUserId: 42, sessionId: 'sid'}))
    setOperatorRouteGuard(app, guard)

    // #when / #then — second installation must throw
    expect(() => setOperatorRouteGuard(app, guard)).toThrow(/already installed/)
  })

  it('guards are isolated per app instance', () => {
    // #given — two separate app instances
    const app1 = new Hono()
    const app2 = new Hono()
    const guard1 = vi.fn(async () => ({ok: true as const, githubUserId: 1, sessionId: 'sid1'}))
    const guard2 = vi.fn(async () => ({ok: true as const, githubUserId: 2, sessionId: 'sid2'}))

    // #when
    setOperatorRouteGuard(app1, guard1)
    setOperatorRouteGuard(app2, guard2)

    // #then — each app has its own guard
    expect(getOperatorRouteGuard(app1)).toBe(guard1)
    expect(getOperatorRouteGuard(app2)).toBe(guard2)
  })
})

// ---------------------------------------------------------------------------
// registerOperatorRoute — auto-guard wrapping
// ---------------------------------------------------------------------------

describe('registerOperatorRoute — auto-guard wrapping', () => {
  it('guard is called before handler when guard allows the request', async () => {
    // #given
    const app = new Hono()
    const guard = vi.fn(async () => ({ok: true as const, githubUserId: 42, sessionId: 'test-sid'}))
    setOperatorRouteGuard(app, guard)

    const handler = vi.fn((c: Context) => c.json({ok: true}))
    registerOperatorRoute(app, 'GET', '/operator/test', handler)

    // #when
    const req = new Request('http://localhost/operator/test')
    const res = await app.fetch(req)

    // #then — guard was called
    expect(guard).toHaveBeenCalledOnce()
    // #and — handler was called (guard allowed)
    expect(handler).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)
  })

  it('guard rejects the request before handler runs when guard returns ok=false', async () => {
    // #given
    const app = new Hono()
    const rejectionResponse = new Response(JSON.stringify({error: 'unauthorized'}), {status: 401})
    const guard = vi.fn(async () => ({ok: false as const, response: rejectionResponse}))
    setOperatorRouteGuard(app, guard)

    const handler = vi.fn((c: Context) => c.json({ok: true}))
    registerOperatorRoute(app, 'GET', '/operator/test', handler)

    // #when
    const req = new Request('http://localhost/operator/test')
    const res = await app.fetch(req)

    // #then — guard was called
    expect(guard).toHaveBeenCalledOnce()
    // #and — handler was NOT called (guard rejected)
    expect(handler).not.toHaveBeenCalled()
    expect(res.status).toBe(401)
  })

  it('authenticated context is available via getOperatorAuthContext when guard allows', async () => {
    // #given
    const app = new Hono()
    const guard = vi.fn(async () => ({ok: true as const, githubUserId: 99, sessionId: 'my-session'}))
    setOperatorRouteGuard(app, guard)

    let capturedCtx: ReturnType<typeof getOperatorAuthContext> | undefined
    registerOperatorRoute(app, 'GET', '/operator/test', (c: Context) => {
      capturedCtx = getOperatorAuthContext(c)
      return c.json({ok: true})
    })

    // #when
    const req = new Request('http://localhost/operator/test')
    await app.fetch(req)

    // #then — auth context is set correctly
    expect(capturedCtx).toEqual({githubUserId: 99, sessionId: 'my-session'})
  })

  it('getOperatorAuthContext returns undefined when no guard is installed (legacy path)', async () => {
    // #given — no guard installed
    const app = new Hono()

    let capturedCtx: ReturnType<typeof getOperatorAuthContext> | undefined
    registerOperatorRoute(app, 'GET', '/operator/test', (c: Context) => {
      capturedCtx = getOperatorAuthContext(c)
      return c.json({ok: true})
    })

    // #when
    const req = new Request('http://localhost/operator/test')
    await app.fetch(req)

    // #then — no auth context (guard not installed)
    expect(capturedCtx).toBeUndefined()
  })

  it('public routes are NOT wrapped by the guard', async () => {
    // #given — guard installed
    const app = new Hono()
    const guard = vi.fn(async () => ({ok: true as const, githubUserId: 42, sessionId: 'sid'}))
    setOperatorRouteGuard(app, guard)

    const handler = vi.fn((c: Context) => c.json({ok: true}))
    registerPublicRoute(app, 'GET', '/operator/health', handler)

    // #when
    const req = new Request('http://localhost/operator/health')
    const res = await app.fetch(req)

    // #then — guard was NOT called for public route
    expect(guard).not.toHaveBeenCalled()
    // #and — handler was called directly
    expect(handler).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)
  })

  it('guard receives the correct method and path', async () => {
    // #given
    const app = new Hono()
    let capturedMethod: string | undefined
    let capturedPath: string | undefined
    const guard = vi.fn(async (_c: Context, method: string, path: string) => {
      capturedMethod = method
      capturedPath = path
      return {ok: true as const, githubUserId: 1, sessionId: 'sid'}
    })
    setOperatorRouteGuard(app, guard)

    registerOperatorRoute(app, 'POST', '/operator/runs', (c: Context) => c.json({ok: true}))

    // #when
    const req = new Request('http://localhost/operator/runs', {method: 'POST'})
    await app.fetch(req)

    // #then — guard received correct method and path
    expect(capturedMethod).toBe('POST')
    expect(capturedPath).toBe('/operator/runs')
  })

  it('routes registered before setOperatorRouteGuard are not wrapped (guard must be installed first)', async () => {
    // #given — register route BEFORE installing guard
    const app = new Hono()
    const handler = vi.fn((c: Context) => c.json({ok: true}))
    registerOperatorRoute(app, 'GET', '/operator/early', handler)

    // Install guard AFTER route registration
    const guard = vi.fn(async () => ({ok: false as const, response: new Response('rejected', {status: 401})}))
    setOperatorRouteGuard(app, guard)

    // #when
    const req = new Request('http://localhost/operator/early')
    const res = await app.fetch(req)

    // #then — guard was NOT called (route was registered before guard installation)
    expect(guard).not.toHaveBeenCalled()
    // #and — handler ran directly (no guard wrapping)
    expect(handler).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Health route in buildOperatorApp — explicitly public/unprivileged
// ---------------------------------------------------------------------------

describe('buildOperatorApp — health route is explicitly public', () => {
  it('health route is registered as a public route, not a privileged route', async () => {
    // #given — import the real buildOperatorApp to verify the health route classification
    const {buildOperatorApp} = await import('./server.js')
    const app = buildOperatorApp(
      {
        logger: {debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined},
        isShuttingDown: () => false,
      },
      {bindHost: '127.0.0.1', bindPort: 0, publicOrigin: 'https://operator.example.com'},
    )

    // #when / #then — health route is public, not privileged
    expect(isPublicRoute(app, 'GET', '/operator/health')).toBe(true)
    expect(isPrivilegedRoute(app, 'GET', '/operator/health')).toBe(false)
  })

  it('assertAllPrivilegedRoutesWrapped passes for the real buildOperatorApp', async () => {
    // #given
    const {buildOperatorApp} = await import('./server.js')
    const app = buildOperatorApp(
      {
        logger: {debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined},
        isShuttingDown: () => false,
      },
      {bindHost: '127.0.0.1', bindPort: 0, publicOrigin: 'https://operator.example.com'},
    )

    // #when / #then — all operator routes are wrapped or explicitly public
    expect(() => assertAllPrivilegedRoutesWrapped(app)).not.toThrow()
  })
})
