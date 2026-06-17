/**
 * Operator route guardrail seam.
 *
 * Every privileged operator route MUST be registered through `registerOperatorRoute`.
 * Public/unauthenticated routes (e.g. health) MUST be registered through `registerPublicRoute`.
 *
 * `assertAllPrivilegedRoutesWrapped` inspects the Hono app's route inventory and throws
 * if any /operator or /operator/* route is registered without going through one of the two
 * explicit registration helpers.
 *
 * Classification only — no auth, rate limiting, origin, or CSRF enforcement yet.
 * Real middleware replaces this seam when the auth boundary lands.
 */

import type {Context, Hono} from 'hono'

// ---------------------------------------------------------------------------
// Internal registry
// ---------------------------------------------------------------------------

/**
 * Per-app registry of route keys that have been explicitly classified.
 * Key format: `${method.toUpperCase()}:${path}`
 *
 * WeakMap so the registry is garbage-collected when the app is GC'd.
 */
function makeRouteRegistry() {
  const map = new WeakMap<object, Set<string>>()
  return {
    add(app: object, key: string): void {
      let set = map.get(app)
      if (set === undefined) {
        set = new Set()
        map.set(app, set)
      }
      set.add(key)
    },
    has(app: object, key: string): boolean {
      return map.get(app)?.has(key) ?? false
    },
  }
}

const privilegedRoutes = makeRouteRegistry()
const publicRoutes = makeRouteRegistry()

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()}:${path}`
}

// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------

type SupportedMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type RouteHandler = (c: Context) => Response | Promise<Response>

/** Apply a route handler to the app for the given method. */
function applyMethod(app: Hono, method: SupportedMethod, path: string, handler: RouteHandler): void {
  switch (method) {
    case 'GET':
      app.get(path, handler)
      break
    case 'POST':
      app.post(path, handler)
      break
    case 'PUT':
      app.put(path, handler)
      break
    case 'PATCH':
      app.patch(path, handler)
      break
    case 'DELETE':
      app.delete(path, handler)
      break
  }
}

/**
 * Register a privileged operator route.
 *
 * Every route that requires auth MUST go through this function.
 * `assertAllPrivilegedRoutesWrapped` throws at startup if any /operator or /operator/*
 * route bypasses it.
 *
 * Classification only — no auth middleware yet. Real guards replace this seam when
 * the auth boundary lands.
 *
 * Throws if the same method+path is registered twice (duplicate detection).
 */
export function registerOperatorRoute(app: Hono, method: SupportedMethod, path: string, handler: RouteHandler): void {
  const key = routeKey(method, path)
  if (privilegedRoutes.has(app, key) || publicRoutes.has(app, key)) {
    throw new Error(
      `Operator route guardrail: duplicate registration for ${method} ${path}. ` +
        `Each route may only be registered once via registerOperatorRoute or registerPublicRoute.`,
    )
  }
  privilegedRoutes.add(app, key)
  applyMethod(app, method, path, handler)
}

/**
 * Register a public (unauthenticated) operator route.
 *
 * Use for routes that are intentionally unauthenticated (e.g. health check).
 * `assertAllPrivilegedRoutesWrapped` recognizes these as explicitly classified.
 *
 * Throws if the same method+path is registered twice (duplicate detection).
 */
export function registerPublicRoute(app: Hono, method: SupportedMethod, path: string, handler: RouteHandler): void {
  const key = routeKey(method, path)
  if (privilegedRoutes.has(app, key) || publicRoutes.has(app, key)) {
    throw new Error(
      `Operator route guardrail: duplicate registration for ${method} ${path}. ` +
        `Each route may only be registered once via registerOperatorRoute or registerPublicRoute.`,
    )
  }
  publicRoutes.add(app, key)
  applyMethod(app, method, path, handler)
}

// ---------------------------------------------------------------------------
// Inspection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the given route was registered through `registerOperatorRoute`.
 */
export function isPrivilegedRoute(app: Hono, method: string, path: string): boolean {
  return privilegedRoutes.has(app, routeKey(method, path))
}

/**
 * Returns true if the given route was registered through `registerPublicRoute`.
 */
export function isPublicRoute(app: Hono, method: string, path: string): boolean {
  return publicRoutes.has(app, routeKey(method, path))
}

// ---------------------------------------------------------------------------
// Static guard
// ---------------------------------------------------------------------------

interface RouteEntry {
  readonly method: string
  readonly path: string
}

/**
 * Assert that every /operator and /operator/* route in the app is either:
 *   - Registered through `registerOperatorRoute` (privileged), or
 *   - Registered through `registerPublicRoute` (explicitly public).
 *
 * Throws if any operator route is registered directly on the app without going
 * through one of the two explicit registration helpers, or if a route is
 * registered both via a helper and directly (duplicate same method+path).
 *
 * Call this after all routes are registered (e.g. at the end of buildOperatorApp).
 */
export function assertAllPrivilegedRoutesWrapped(app: Hono): void {
  const seen = new Set<string>()
  const unwrapped: string[] = []
  const duplicates: string[] = []

  for (const route of app.routes as RouteEntry[]) {
    // Skip global middleware catch-alls (ALL /* or ALL *) — these are app.use('*', ...)
    // registrations, not operator routes.
    if (route.method === 'ALL' && (route.path === '/*' || route.path === '*')) continue

    // Inspect /operator (exact) and /operator/* routes.
    // ALL method entries on operator paths (e.g. app.use('/operator/x', ...) or app.all('/operator/x', ...))
    // are NOT skipped — they must be classified or they are a violation.
    const isOperatorPath = route.path === '/operator' || route.path.startsWith('/operator/')
    if (isOperatorPath === false) continue

    const key = routeKey(route.method, route.path)

    if (seen.has(key)) {
      // Same method+path seen twice — one was registered via helper, one directly.
      if (privilegedRoutes.has(app, key) || publicRoutes.has(app, key)) {
        duplicates.push(`${route.method} ${route.path}`)
      }
      continue
    }
    seen.add(key)

    const isClassified = privilegedRoutes.has(app, key) || publicRoutes.has(app, key)
    if (isClassified === false) {
      unwrapped.push(`${route.method} ${route.path}`)
    }
  }

  if (duplicates.length > 0) {
    throw new Error(
      `Operator route guardrail violation: the following routes are registered both via a helper ` +
        `and directly on the app. Each route must be registered exactly once.\n` +
        `Duplicate routes:\n${duplicates.map(r => `  ${r}`).join('\n')}`,
    )
  }

  if (unwrapped.length > 0) {
    throw new Error(
      `Operator route guardrail violation: the following operator routes are registered without ` +
        `registerOperatorRoute or registerPublicRoute. Every privileged operator route must use ` +
        `registerOperatorRoute; unauthenticated routes must use registerPublicRoute.\n` +
        `Unwrapped routes:\n${unwrapped.map(r => `  ${r}`).join('\n')}`,
    )
  }
}
