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
import {describe, expect, it} from 'vitest'
import {
  assertAllPrivilegedRoutesWrapped,
  isPrivilegedRoute,
  isPublicRoute,
  registerOperatorRoute,
  registerPublicRoute,
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
