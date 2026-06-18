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
 * When a guard is installed via `setOperatorRouteGuard`, every privileged route registered
 * through `registerOperatorRoute` is automatically wrapped: the guard runs first, and the
 * handler only executes if the guard allows the request. This ensures future privileged routes
 * cannot forget browser guard / allowlist / CSRF enforcement.
 *
 * Public routes are never wrapped by the guard.
 */

import type {Context, Env, Hono} from 'hono'

/** A Context with an open Variables map — used for c.set/c.get without generic constraints. */
type OpenContext = Context<Env & {Variables: Record<string, unknown>}>

// ---------------------------------------------------------------------------
// Guard types
// ---------------------------------------------------------------------------

/**
 * Authenticated context stored on the Hono context after a successful guard check.
 * Handlers can read this via `getOperatorAuthContext(c)`.
 */
export interface OperatorAuthContext {
  readonly githubUserId: number
  readonly sessionId: string
}

/**
 * A privileged-route guard function.
 *
 * Called before every privileged route handler when installed via `setOperatorRouteGuard`.
 * Receives the Hono context, HTTP method, and route path.
 *
 * Returns:
 *   - `{ok: true, githubUserId, sessionId}` to allow the request (handler runs next).
 *   - `{ok: false, response}` to reject the request (response is returned immediately).
 *
 * The guard MUST NOT call the handler — `registerOperatorRoute` handles that.
 */
export type OperatorRouteGuard = (
  c: Context,
  method: string,
  path: string,
) => Promise<
  | {readonly ok: true; readonly githubUserId: number; readonly sessionId: string}
  | {readonly ok: false; readonly response: Response}
>

// ---------------------------------------------------------------------------
// Hono context variable key for authenticated operator context
// ---------------------------------------------------------------------------

/**
 * Key used to store the authenticated operator context on the Hono context.
 * Set by the auto-guard wrapper; read by handlers via `getOperatorAuthContext`.
 */
const OPERATOR_AUTH_CONTEXT_KEY = '__operatorAuthContext'

/**
 * Read the authenticated operator context set by the auto-guard.
 *
 * Returns the context if the guard ran and allowed the request, or undefined
 * if no guard is installed.
 *
 * Handlers that require authentication MUST check for undefined and return 401.
 * In production (guard installed), undefined is unreachable — the guard rejects first.
 */
export function getOperatorAuthContext(c: Context): OperatorAuthContext | undefined {
  // Use Hono's c.get() API to read context variables set by c.set().
  // Cast to OpenContext to access the open Variables map without generic constraints.
  const ctx = (c as OpenContext).get(OPERATOR_AUTH_CONTEXT_KEY)
  if (ctx === undefined || ctx === null) return undefined
  return ctx as OperatorAuthContext
}

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
const publicCrossSiteRoutes = makeRouteRegistry()

/**
 * Per-app guard registry.
 * WeakMap so the guard is garbage-collected when the app is GC'd.
 */
const guardRegistry = new WeakMap<object, OperatorRouteGuard>()

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()}:${path}`
}

// ---------------------------------------------------------------------------
// Guard installation
// ---------------------------------------------------------------------------

/**
 * Install a privileged-route guard for the given app.
 *
 * When installed, every subsequent call to `registerOperatorRoute` will wrap
 * the handler: the guard runs first, and the handler only executes if the guard
 * allows the request. The guard result (githubUserId, sessionId) is stored on
 * the Hono context and readable via `getOperatorAuthContext(c)`.
 *
 * Must be called BEFORE any `registerOperatorRoute` calls that should be guarded.
 * Routes registered before `setOperatorRouteGuard` are NOT wrapped retroactively.
 *
 * Public routes (registered via `registerPublicRoute` or `registerPublicCrossSiteRoute`)
 * are never wrapped by the guard.
 *
 * Throws if a guard is already installed for this app (programming error).
 */
export function setOperatorRouteGuard(app: Hono, guard: OperatorRouteGuard): void {
  if (guardRegistry.has(app)) {
    throw new Error(
      'Operator route guardrail: a guard is already installed for this app. ' +
        'setOperatorRouteGuard must be called at most once per app instance.',
    )
  }
  guardRegistry.set(app, guard)
}

/**
 * Returns the installed guard for the given app, or undefined if none is installed.
 * Used internally by `registerOperatorRoute` to wrap handlers.
 */
export function getOperatorRouteGuard(app: Hono): OperatorRouteGuard | undefined {
  return guardRegistry.get(app)
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
 * When a guard is installed via `setOperatorRouteGuard`, the handler is automatically
 * wrapped: the guard runs first (browser guard / allowlist / CSRF enforcement), and the
 * handler only executes if the guard allows the request. The authenticated context
 * (githubUserId, sessionId) is stored on the Hono context and readable via
 * `getOperatorAuthContext(c)`.
 *
 * When no guard is installed, the raw handler is applied directly. Production operator
 * apps install a guard before privileged routes; unguarded registration is for isolated
 * route-helper tests only.
 *
 * Throws if the same method+path is registered twice (duplicate detection).
 */
export function registerOperatorRoute(app: Hono, method: SupportedMethod, path: string, handler: RouteHandler): void {
  const key = routeKey(method, path)
  if (privilegedRoutes.has(app, key) || publicRoutes.has(app, key) || publicCrossSiteRoutes.has(app, key)) {
    throw new Error(
      `Operator route guardrail: duplicate registration for ${method} ${path}. ` +
        `Each route may only be registered once via registerOperatorRoute, registerPublicRoute, or registerPublicCrossSiteRoute.`,
    )
  }
  privilegedRoutes.add(app, key)

  const guard = guardRegistry.get(app)
  if (guard === undefined) {
    // No guard installed — apply raw handler. Production operator apps install a guard
    // before privileged routes; this path supports isolated route-helper tests.
    applyMethod(app, method, path, handler)
  } else {
    // Wrap the handler with the guard.
    // The guard runs first; if it rejects, the response is returned immediately.
    // If it allows, the authenticated context is stored on the Hono context and
    // the handler is called.
    const wrappedHandler: RouteHandler = async (c: Context): Promise<Response> => {
      const guardResult = await guard(c, method, path)
      if (guardResult.ok === false) {
        return guardResult.response
      }
      // Store authenticated context for the handler to read via getOperatorAuthContext(c).
      // Cast to OpenContext to access the open Variables map without generic constraints.
      ;(c as OpenContext).set(OPERATOR_AUTH_CONTEXT_KEY, {
        githubUserId: guardResult.githubUserId,
        sessionId: guardResult.sessionId,
      })
      return handler(c)
    }
    applyMethod(app, method, path, wrappedHandler)
  }
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
  if (privilegedRoutes.has(app, key) || publicRoutes.has(app, key) || publicCrossSiteRoutes.has(app, key)) {
    throw new Error(
      `Operator route guardrail: duplicate registration for ${method} ${path}. ` +
        `Each route may only be registered once via registerOperatorRoute, registerPublicRoute, or registerPublicCrossSiteRoute.`,
    )
  }
  publicRoutes.add(app, key)
  applyMethod(app, method, path, handler)
}

/**
 * Register a public cross-site operator route.
 *
 * Use for routes that must accept cross-site requests (e.g. OAuth callback from GitHub).
 * These routes are classified as public (unauthenticated) AND cross-site-allowed.
 * `assertAllPrivilegedRoutesWrapped` recognizes these as explicitly classified.
 * The browser-origin guard exempts these routes from Fetch Metadata cross-site rejection.
 *
 * Currently only the OAuth callback should be registered this way.
 * Do NOT broaden this exemption — it bypasses the cross-site Fetch Metadata check.
 *
 * Throws if the same method+path is registered twice (duplicate detection).
 */
export function registerPublicCrossSiteRoute(
  app: Hono,
  method: SupportedMethod,
  path: string,
  handler: RouteHandler,
): void {
  const key = routeKey(method, path)
  if (privilegedRoutes.has(app, key) || publicRoutes.has(app, key) || publicCrossSiteRoutes.has(app, key)) {
    throw new Error(
      `Operator route guardrail: duplicate registration for ${method} ${path}. ` +
        `Each route may only be registered once via registerOperatorRoute, registerPublicRoute, or registerPublicCrossSiteRoute.`,
    )
  }
  // Cross-site routes are also public (not privileged)
  publicRoutes.add(app, key)
  publicCrossSiteRoutes.add(app, key)
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
 * Returns true if the given route was registered through `registerPublicRoute`
 * or `registerPublicCrossSiteRoute`.
 */
export function isPublicRoute(app: Hono, method: string, path: string): boolean {
  return publicRoutes.has(app, routeKey(method, path))
}

/**
 * Returns true if the given route was registered through `registerPublicCrossSiteRoute`.
 * These routes are exempt from Fetch Metadata cross-site rejection.
 */
export function isPublicCrossSiteRoute(app: Hono, method: string, path: string): boolean {
  return publicCrossSiteRoutes.has(app, routeKey(method, path))
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
