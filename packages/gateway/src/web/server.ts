/**
 * Hono HTTP server for the operator web surface.
 *
 * createOperatorServer builds a Hono app, wires the operator routes, and
 * returns the @hono/node-server handle so the caller (program.ts) can close
 * it during graceful shutdown.
 *
 * Current posture (classification/guardrail only — no auth yet):
 *   - Listener binds to the configured gateway-net host/port only.
 *     Never 0.0.0.0, loopback, or sandbox-net for production config.
 *   - TLS is terminated by the infra reverse proxy at GATEWAY_OPERATOR_PUBLIC_ORIGIN.
 *     The operator listener receives plain HTTP over gateway-net.
 *   - Forwarded-host/proto headers are validated against publicOrigin (full host:port match).
 *     Requests with mismatched forwarded headers are rejected 400.
 *   - Unauthenticated socket-keyed rate limiting and body-size limits are applied.
 *   - All responses pass through safe-response helpers (coarse, no-oracle).
 *   - No privileged routes registered yet; auth routes land when the auth boundary is in place.
 *
 * Mirror of packages/gateway/src/http/server.ts for the serve()/handle pattern.
 */

import type {ServerType} from '@hono/node-server'
import {serve} from '@hono/node-server'
import {getConnInfo} from '@hono/node-server/conninfo'
import {Hono} from 'hono'
import {bodyLimit} from 'hono/body-limit'
import {createRateLimiter} from '../http/rate-limit.js'
import {assertAllPrivilegedRoutesWrapped, registerPublicRoute} from './operator-route.js'
import {
  badRequestResponse,
  notFoundResponse,
  okResponse,
  payloadTooLargeResponse,
  rateLimitedResponse,
  unavailableResponse,
} from './safe-response.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum body size for unauthenticated operator requests.
 * 64 KB is generous for any pre-auth request (OAuth start, session check).
 * Route-specific limits for authenticated routes are added per-route.
 */
export const OPERATOR_MAX_BODY_BYTES = 64 * 1024

/**
 * Default unauthenticated burst limit: 20 requests per minute per socket.
 * Matches the abuse-control table (Tier: Unauthenticated burst).
 */
const DEFAULT_UNAUTH_LIMIT = 20
const DEFAULT_UNAUTH_WINDOW_MS = 60_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OperatorLogger {
  readonly debug: (ctx: Record<string, unknown>, msg: string) => void
  readonly info: (ctx: Record<string, unknown>, msg: string) => void
  readonly warn: (ctx: Record<string, unknown>, msg: string) => void
  readonly error: (ctx: Record<string, unknown>, msg: string) => void
}

export interface OperatorServerDeps {
  readonly logger: OperatorLogger
  /**
   * Returns true when the gateway is draining (SIGTERM/SIGINT received).
   * Injected so the route can return 503 without importing shutdown.ts directly.
   * Defaults to () => false if omitted (useful in tests that don't care about drain).
   */
  readonly isShuttingDown?: () => boolean
  /**
   * Optional injectable rate limiter for unauthenticated socket-keyed limits.
   * Uses the shared RateLimiter from http/rate-limit.ts with operator defaults
   * (20 req/min) when absent.
   */
  readonly rateLimiter?: import('../http/rate-limit.js').RateLimiter
  /** Injectable clock for testability. */
  readonly clock?: () => number
}

export interface OperatorServerConfig {
  /**
   * Bind host for the operator listener on gateway-net.
   * Must NOT be 0.0.0.0, 127.0.0.1, or a sandbox-net address.
   * Validated by loadGatewayConfig() before this is called.
   */
  readonly bindHost: string
  /** Bind port for the operator listener. */
  readonly bindPort: number
  /**
   * Public HTTPS origin exposed by the infra reverse proxy.
   * Used to validate X-Forwarded-Host/X-Forwarded-Proto headers.
   * Example: 'https://operator.example.com'
   */
  readonly publicOrigin: string
}

// ---------------------------------------------------------------------------
// Origin validation helper
// ---------------------------------------------------------------------------

/**
 * Parse the host from a public origin URL.
 * Throws a programming error if the origin is not a valid https:// URL —
 * this is a startup/configuration error, not a recoverable runtime condition.
 * The caller (buildOperatorApp) must pass a validated publicOrigin from config.
 */
function parsePublicOriginHost(publicOrigin: string): string {
  let url: URL
  try {
    url = new URL(publicOrigin)
  } catch {
    throw new Error(
      `buildOperatorApp: publicOrigin is not a valid URL: "${publicOrigin}". ` +
        'This is a programming error — publicOrigin must be validated by loadGatewayConfig() before reaching here.',
    )
  }
  if (url.protocol !== 'https:') {
    throw new Error(
      `buildOperatorApp: publicOrigin must use https://, got: "${publicOrigin}". ` +
        'This is a programming error — publicOrigin must be validated by loadGatewayConfig() before reaching here.',
    )
  }
  return url.host
}

/**
 * Validate forwarded-host/proto headers against the configured public origin.
 *
 * Returns true when:
 *   - No forwarded headers are present (direct connection, no proxy).
 *   - Both X-Forwarded-Host and X-Forwarded-Proto are present and match
 *     the configured public origin (host and https protocol).
 *
 * Returns false when:
 *   - X-Forwarded-Host is present but does not match the public origin host.
 *   - X-Forwarded-Proto is present but is not 'https'.
 *   - Only one of the pair is present (partial forwarded headers are suspicious).
 *
 * This prevents a workspace-reachable attacker from spoofing the operator
 * origin by injecting forwarded headers.
 */
function validateForwardedHeaders(
  forwardedHost: string | undefined,
  forwardedProto: string | undefined,
  publicOriginHost: string,
): boolean {
  const hasHost = forwardedHost !== undefined && forwardedHost !== ''
  const hasProto = forwardedProto !== undefined && forwardedProto !== ''

  // No forwarded headers — direct connection on gateway-net (operator listener
  // topology owns direct-socket reachability for Unit 3a). Allow here, but
  // privileged routes must not rely on this alone when auth lands; they must
  // enforce their own identity checks regardless of connection path.
  if (hasHost === false && hasProto === false) return true

  // Partial forwarded headers — suspicious. Reject.
  if (hasHost !== hasProto) return false

  // Both present — validate against public origin.
  // X-Forwarded-Host must match publicOriginHost exactly, including port.
  // A proxy forwarding from https://ops.example.com:8443 must send that full host.
  // hasHost/hasProto guards above ensure these are non-empty strings here.
  if ((forwardedHost ?? '') !== publicOriginHost) return false
  if ((forwardedProto ?? '').toLowerCase() !== 'https') return false

  return true
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the Hono application for the operator server.
 *
 * Exported separately from createOperatorServer so the route inventory can be
 * inspected in tests without binding a port. This is the authoritative place
 * where operator HTTP routes are registered — any new route added here is
 * immediately visible to the ingress-pin test.
 *
 * Currently registers only GET /operator/health. Privileged routes (auth, launch,
 * approvals, SSE) are added only after the auth boundary is in place.
 */
export function buildOperatorApp(deps: OperatorServerDeps, config: OperatorServerConfig): Hono {
  const checkShuttingDown = deps.isShuttingDown ?? (() => false)
  // Use the shared RateLimiter from http/rate-limit.ts with operator defaults.
  // Keyed on socket/proxy IP (see rate-limit call in the health route below).
  // Per-client/post-auth identity keying is added when auth routes land.
  const rateLimiter =
    deps.rateLimiter ??
    createRateLimiter({limit: DEFAULT_UNAUTH_LIMIT, windowMs: DEFAULT_UNAUTH_WINDOW_MS, clock: deps.clock})
  const publicOriginHost = parsePublicOriginHost(config.publicOrigin)

  const app = new Hono()

  // ── Global middleware ──────────────────────────────────────────────────────

  // 1. Drain gate — refuse new requests during graceful shutdown.
  //    Must run before body-limit so draining returns 503 without reading the body.
  app.use('*', async (c, next) => {
    if (checkShuttingDown() === true) {
      deps.logger.warn({}, 'operator request rejected (shutting down)')
      return unavailableResponse(c)
    }
    return next()
  })

  // 2. Body size limit — enforced during streaming before any handler allocates
  //    memory. Closes the pre-auth memory DoS vector.
  app.use(
    '*',
    bodyLimit({
      maxSize: OPERATOR_MAX_BODY_BYTES,
      onError: c => payloadTooLargeResponse(c),
    }),
  )

  // 3. Unauthenticated socket-keyed rate limit — applied per-route (not middleware)
  //    to avoid Hono's middleware context type mismatch with getConnInfo.
  //    The rate-limit check is called from each route handler.
  //    Keyed on the actual TCP socket remote address — NOT X-Forwarded-For,
  //    which is caller-spoofable. This matches the announce server pattern.

  // 4. Forwarded-header origin validation.
  //    The operator listener is on gateway-net; the infra reverse proxy forwards
  //    requests from the public operator origin. Validate that any forwarded
  //    headers match the configured public origin to prevent workspace-reachable
  //    attackers from spoofing the operator origin via injected headers.
  app.use('*', async (c, next) => {
    const forwardedHost = c.req.header('x-forwarded-host')
    const forwardedProto = c.req.header('x-forwarded-proto')
    if (validateForwardedHeaders(forwardedHost, forwardedProto, publicOriginHost) === false) {
      // Log a fixed/coarse warning — do not include caller-supplied header values
      // to avoid leaking attacker-controlled data into logs.
      deps.logger.warn({}, 'operator request rejected (untrusted forwarded headers)')
      return badRequestResponse(c)
    }
    return next()
  })

  // ── Routes ─────────────────────────────────────────────────────────────────
  //
  // RATE-LIMIT ENFORCEMENT CONTRACT — every route registered here MUST call
  // rateLimiter.allow(key) before performing any work. This is not optional.
  //
  // Why per-route (not middleware): Hono's middleware context type does not
  // expose getConnInfo, so the socket-keyed rate limit must be called from
  // within each route handler where the full context is available.
  //
  // For unauthenticated routes: key on the TCP socket remote address (not
  // X-Forwarded-For, which is caller-spoofable). Use getConnInfo(c).remote.address
  // with a fallback to 'unknown' for test environments without a real socket.
  //
  // For authenticated routes (added in Unit 3+): key on the authenticated
  // identity (user ID / session ID) in addition to the socket key, so that
  // a single authenticated user cannot exhaust the unauthenticated burst budget.
  //
  // Failure to call rateLimiter.allow() in a new route is a security defect.
  // The ingress-pin test (http/ingress-pin.test.ts) will catch any new route
  // added without updating the pinned inventory — use that as the review gate.

  /**
   * GET /operator/health
   *
   * Unauthenticated health check for the operator listener.
   * Returns 200 {ok:true} when the listener is running and not draining.
   * (Drain gate above returns 503 before this handler is reached.)
   *
   * Registered as a public route via registerPublicRoute — explicitly unauthenticated.
   * Rate limit is applied here (not in middleware) to avoid Hono's middleware
   * context type mismatch with getConnInfo. This matches the announce server pattern.
   * Keyed on socket/proxy IP; per-client/post-auth identity keying is added with auth routes.
   */
  registerPublicRoute(app, 'GET', '/operator/health', c => {
    // Rate limit keyed on actual TCP socket remote address (not X-Forwarded-For).
    // Socket/proxy IP is the coarse key for unauthenticated requests; per-client
    // identity keying is added when auth routes land.
    // getConnInfo may throw in test environments without a real socket; fall back to 'unknown'.
    let sourceKey = 'unknown'
    try {
      const connInfo = getConnInfo(c)
      sourceKey = connInfo.remote.address ?? 'unknown'
    } catch {
      // No real socket (e.g. direct app.fetch() in tests) — use 'unknown' key.
      // Warn in production: all rate-limit keys collapse to 'unknown', which
      // defeats per-client isolation. Investigate if this appears in prod logs.
      deps.logger.warn({}, 'getConnInfo unavailable — rate-limit key collapsed to unknown')
    }
    if (rateLimiter.allow(sourceKey) === false) {
      deps.logger.warn({}, 'operator request rate limited (unauthenticated)')
      return rateLimitedResponse(c)
    }
    return okResponse(c)
  })

  // ── Catch-all ──────────────────────────────────────────────────────────────

  app.notFound(c => notFoundResponse(c))

  // ── Static guardrail ───────────────────────────────────────────────────────
  // Verify every /operator/* route is explicitly classified as privileged or public.
  // This throws at startup if any route was added without registerOperatorRoute or
  // registerPublicRoute during app construction.
  assertAllPrivilegedRoutesWrapped(app)

  return app
}

/**
 * Build and start the Hono server for the operator web surface.
 *
 * Returns the @hono/node-server handle. Call `.close(cb)` during shutdown.
 *
 * The server binds to config.bindHost:config.bindPort. In production this
 * must be a gateway-net address — never all-interfaces, loopback, or sandbox-net.
 * Config validation in loadGatewayConfig() enforces this before this is called.
 *
 * SECURITY: There are exactly two serve() calls in the gateway package — this one
 * (operator surface, gateway-net only) and createAnnounceServer (announce surface,
 * sandbox-net reachable). Adding a third server entry point requires a deliberate
 * security review and must update the ingress-pin test in http/ingress-pin.test.ts.
 */
export function createOperatorServer(deps: OperatorServerDeps, config: OperatorServerConfig): ServerType {
  const app = buildOperatorApp(deps, config)
  const server = serve({fetch: app.fetch, hostname: config.bindHost, port: config.bindPort})
  // Set a server-level socket timeout to bound idle connections.
  // 10 s is sufficient for any pre-auth request; authenticated routes may
  // extend this per-request when they land.
  server.setTimeout(10_000)
  return server
}
