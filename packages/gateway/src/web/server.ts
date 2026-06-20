/**
 * Hono HTTP server for the operator web surface.
 *
 * createOperatorServer builds a Hono app, wires the operator routes, and
 * returns the @hono/node-server handle so the caller (program.ts) can close
 * it during graceful shutdown.
 *
 * Current posture:
 *   - Listener binds to the configured gateway-net host/port only.
 *     Never 0.0.0.0, loopback, or sandbox-net for production config.
 *   - TLS is terminated by the infra reverse proxy at GATEWAY_OPERATOR_PUBLIC_ORIGIN.
 *     The operator listener receives plain HTTP over gateway-net.
 *   - Forwarded-host/proto headers are validated against publicOrigin (full host:port match).
 *     Requests with mismatched forwarded headers are rejected 400.
 *   - Unauthenticated socket-keyed rate limiting and body-size limits are applied.
 *   - All responses pass through safe-response helpers (coarse, no-oracle).
 *   - GitHub OAuth start and callback routes are registered as public (unauthenticated).
 *     The callback route must remain compatible with future Fetch Metadata middleware
 *     because GitHub redirects cross-site after authorization.
 *
 * Mirror of packages/gateway/src/http/server.ts for the serve()/handle pattern.
 */

import type {ServerType} from '@hono/node-server'
import type {RepoBinding} from '../bindings/types.js'
import type {RunIndex} from '../execute/run-index.js'
import type {RunMentionDeps} from '../execute/run.js'
import type {DenylistCache} from '../redaction/denylist.js'
import type {BindingsLookup} from '../redaction/surface-gate.js'
import type {AuditLogger} from './audit.js'
import type {OperatorAllowlist} from './auth/allowlist.js'
import type {GitHubOAuthConfig, GitHubOAuthDeps} from './auth/github.js'
import type {RepoAuthzCache} from './auth/repo-authz.js'
import type {SessionDeps, SessionStore} from './auth/session.js'
import type {IdempotencyGuard} from './operator/idempotency.js'
import type {RunObservationManager} from './sse/manager.js'
import {serve} from '@hono/node-server'
import {getConnInfo} from '@hono/node-server/conninfo'
import {Hono} from 'hono'
import {bodyLimit} from 'hono/body-limit'
import {createRateLimiter} from '../http/rate-limit.js'
import {buildCsrfRoute} from './auth/csrf-route.js'
import {applyBrowserGuard} from './auth/csrf.js'
import {buildGitHubOAuthRoutes} from './auth/github.js'
import {createRepoAuthzCache} from './auth/repo-authz.js'
import {buildSessionInfoRoute} from './auth/session-info-route.js'
import {buildLogoutRoutes} from './auth/session.js'
import {assertAllPrivilegedRoutesWrapped, registerPublicRoute, setOperatorRouteGuard} from './operator-route.js'
import {createIdempotencyGuard} from './operator/idempotency.js'
import {buildLaunchRoute} from './operator/launch-route.js'
import {buildReposRoute} from './operator/repos-route.js'
import {
  badRequestResponse,
  notFoundResponse,
  okResponse,
  payloadTooLargeResponse,
  rateLimitedResponse,
  unavailableResponse,
} from './safe-response.js'
import {buildRunStreamRoute} from './sse/run-stream-route.js'

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
  /**
   * Optional GitHub OAuth dependencies for the auth routes.
   * When present, the GitHub OAuth start and callback routes are registered.
   * When absent, the auth routes are not registered (opt-in).
   */
  readonly githubOAuth?: GitHubOAuthDeps
  /**
   * Optional session store for the logout route.
   * When present (alongside sessionDeps), POST /operator/auth/logout is registered.
   */
  readonly sessionStore?: SessionStore
  /**
   * Session deps (logger, auditLogger, clock) for the logout route.
   * Required when sessionStore is present; ignored otherwise.
   */
  readonly sessionDeps?: SessionDeps
  /**
   * Optional operator allowlist for the browser guard.
   * When present (alongside csrfSecret and auditLogger), the browser guard is applied
   * to authenticated operator routes and the CSRF endpoint is registered.
   */
  readonly allowlist?: OperatorAllowlist
  /**
   * CSRF token signing key (HMAC-SHA256), base64url-encoded with no padding/newlines.
   * Required when allowlist is present; ignored otherwise.
   * Must decode to at least 32 bytes (256 bits) of CSPRNG entropy.
   */
  readonly csrfSecret?: string
  /**
   * Audit logger for security events.
   * Required when allowlist is present; ignored otherwise.
   */
  readonly auditLogger?: AuditLogger
  /**
   * Denylist cache for the run-stream route's pre-subscribe redaction check.
   * Consumed by the run-stream route to verify a repo is not denied before
   * opening the SSE stream. Optional — omit in tests that don't exercise streaming.
   */
  readonly denylistCache?: DenylistCache
  /**
   * Bindings lookup for the run-stream route's repo-key resolution.
   * Used to resolve a run's entity_ref to its binding deny keys before
   * the pre-subscribe redaction check. Optional — omit in tests that don't exercise streaming.
   */
  readonly bindingsLookup?: BindingsLookup
  /**
   * Run-observation manager for the run-stream route's SSE subscription.
   * Provides subscribe/unsubscribe for per-connection streaming; the route
   * calls subscribe() after all gates pass and unsubscribe() on every exit path.
   * Optional — omit in tests that don't exercise streaming.
   */
  readonly runObservationManager?: RunObservationManager
  /**
   * Server-owned run index for runId → {repo, surface} resolution.
   * Required by the run-stream route to resolve a runId to its repo without
   * trusting any client-supplied value. The launch route uses register() to
   * record PENDING entries before firing launchWork. Optional — omit in tests
   * that don't exercise the run-stream or launch routes.
   */
  readonly runIndex?: Pick<RunIndex, 'lookup' | 'register'>
  /**
   * Shared repo-authz cache for the run-stream route's checkRepoAuthz calls.
   * When absent, a fresh in-memory cache is created per buildOperatorApp call.
   * Pass a shared instance in production so positive/negative results are reused
   * across requests and the GitHub API is not called redundantly.
   */
  readonly repoAuthzCache?: RepoAuthzCache
  /**
   * Binding store list function for the repos route.
   * When present (alongside the browser guard and denylistCache), GET /operator/repos
   * is registered. When absent, the repos route is not registered (opt-in).
   */
  readonly listBindings?: () => Promise<
    {readonly success: true; readonly data: RepoBinding[]} | {readonly success: false; readonly error: Error}
  >
  /**
   * Binding lookup for the launch route's server-owned repo resolution.
   * When present (alongside launchWorkDeps and the browser guard), POST /operator/runs
   * is registered. When absent, the launch route is not registered (opt-in).
   */
  readonly getBindingByRepo?: (
    owner: string,
    repo: string,
  ) => Promise<
    {readonly success: true; readonly data: RepoBinding | null} | {readonly success: false; readonly error: Error}
  >
  /**
   * Engine dependencies for the launch route's launchWork call.
   * Required when getBindingByRepo is present; ignored otherwise.
   */
  readonly launchWorkDeps?: RunMentionDeps
  /**
   * Per-operator idempotency guard for the launch route.
   * When absent and the launch route is registered, a fresh in-memory guard is created.
   */
  readonly idempotencyGuard?: IdempotencyGuard
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
  /**
   * Optional GitHub OAuth configuration for the auth routes.
   * When present (alongside deps.githubOAuth), the GitHub OAuth start and
   * callback routes are registered. When absent, the auth routes are not
   * registered (opt-in).
   */
  readonly githubOAuth?: GitHubOAuthConfig
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

  // No forwarded headers — direct connection on gateway-net. Network topology
  // owns socket reachability; allow here, but authenticated routes must enforce
  // identity independently of connection path.
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
  // For authenticated routes: key on the authenticated identity (user ID /
  // session ID) so that a single authenticated user cannot exhaust the
  // unauthenticated burst budget.
  //
  // Exception: authenticated long-lived streaming routes (e.g. the run-stream route)
  // use the per-operator stream-slot cap (gate 7, keyed on numeric githubUserId) for
  // backpressure instead of the socket-keyed rateLimiter — stronger keying for that case.
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

  // ── GitHub OAuth routes ────────────────────────────────────────────────────
  //
  // Registered only when both deps.githubOAuth and config.githubOAuth are present.
  // Both must be provided together — partial config is a programming error.
  //
  // Routes registered:
  //   GET /operator/auth/github/start    — public, unauthenticated
  //   GET /operator/auth/github/callback — public OAuth redirect callback
  if (deps.githubOAuth !== undefined && config.githubOAuth !== undefined) {
    // Thread the shared rate limiter into the OAuth deps so both OAuth routes
    // participate in the same per-socket budget as the health route.
    const oauthDepsWithRateLimiter = {...deps.githubOAuth, rateLimiter}
    buildGitHubOAuthRoutes(app, oauthDepsWithRateLimiter, config.githubOAuth)
  } else if (deps.githubOAuth !== undefined || config.githubOAuth !== undefined) {
    // Partial config: one is set but not the other. This is a programming error.
    throw new Error(
      'buildOperatorApp: deps.githubOAuth and config.githubOAuth must both be present or both absent. ' +
        'Partial GitHub OAuth config is a programming error.',
    )
  }

  // ── Browser guard deps (shared by logout and CSRF endpoint) ───────────────
  //
  // Built when allowlist, csrfSecret, auditLogger, and sessionStore are all present.
  // Used to protect both the logout route and the CSRF endpoint.
  //
  // Partial deps (some but not all of allowlist/csrfSecret/auditLogger/sessionStore)
  // is a programming error — fail closed with a clear error instead of silently
  // disabling the guard. The guard is all-or-nothing.
  const browserGuardPieces = [deps.allowlist, deps.csrfSecret, deps.auditLogger, deps.sessionStore]
  const browserGuardPresentCount = browserGuardPieces.filter(v => v !== undefined).length
  if (browserGuardPresentCount > 0 && browserGuardPresentCount < 4) {
    const missing: string[] = []
    if (deps.allowlist === undefined) missing.push('allowlist')
    if (deps.csrfSecret === undefined) missing.push('csrfSecret')
    if (deps.auditLogger === undefined) missing.push('auditLogger')
    if (deps.sessionStore === undefined) missing.push('sessionStore')
    throw new Error(
      `buildOperatorApp: partial browser guard deps — all four of allowlist, csrfSecret, auditLogger, and sessionStore must be provided together to enable the browser guard, or none to disable it. Missing: ${missing.join(', ')}. This is a programming error — partial browser guard wiring silently disables security enforcement.`,
    )
  }
  const browserGuardDeps =
    deps.allowlist !== undefined &&
    deps.csrfSecret !== undefined &&
    deps.auditLogger !== undefined &&
    deps.sessionStore !== undefined
      ? {
          logger: deps.logger,
          auditLogger: deps.auditLogger,
          sessionStore: deps.sessionStore,
          allowlist: deps.allowlist,
          csrfSecret: deps.csrfSecret,
          publicOrigin: config.publicOrigin,
          clock: deps.sessionDeps?.clock ?? (() => Date.now()),
        }
      : undefined

  // ── Privileged-route guard installation ────────────────────────────────────
  //
  // When browserGuardDeps is present, install a generic guard on the app before
  // registering any privileged routes. Every subsequent `registerOperatorRoute`
  // call will automatically wrap its handler: the guard runs first (browser guard /
  // allowlist / CSRF enforcement), and the handler only executes if the guard allows.
  //
  // The guard calls applyBrowserGuard with:
  //   - isPublicCrossSiteRoute=false (privileged routes are never cross-site)
  //   - requireCsrf=true for mutating methods (POST/PUT/PATCH/DELETE), false for safe methods
  //
  // This ensures future privileged routes cannot forget browser guard enforcement.
  // Routes registered before this point (health, OAuth) are public and unaffected.
  if (browserGuardDeps !== undefined) {
    const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
    setOperatorRouteGuard(app, async (c, method, _path) => {
      const requireCsrf = SAFE_METHODS.has(method.toUpperCase()) === false
      return applyBrowserGuard(c, browserGuardDeps, false, requireCsrf)
    })
  }

  // ── Logout route ───────────────────────────────────────────────────────────
  //
  // Registered only when sessionStore, sessionDeps, AND browserGuardDeps are all present.
  // Logout is always a privileged route protected by session + allowlist + origin + CSRF.
  // Providing sessionStore/sessionDeps without browserGuardDeps is a programming error —
  // a public mutating logout path is a CSRF footgun and is not supported.
  // Thread the shared rate limiter and socket-derived source key into the logout route
  // so it participates in the same per-socket budget as the health and OAuth routes.
  if (deps.sessionStore !== undefined && deps.sessionDeps !== undefined) {
    if (browserGuardDeps === undefined) {
      throw new Error(
        'buildOperatorApp: sessionStore and sessionDeps are present but browserGuardDeps is absent. ' +
          'Logout must always be protected by the browser guard (session + allowlist + origin + CSRF). ' +
          'Provide allowlist, csrfSecret, and auditLogger alongside sessionStore, or omit sessionStore entirely. ' +
          'This is a programming error — a public mutating logout path is a CSRF footgun.',
      )
    }
    const sessionDepsWithRateLimiter = {
      ...deps.sessionDeps,
      rateLimiter,
      getSourceKey: (c: Parameters<typeof getConnInfo>[0]) => {
        try {
          const connInfo = getConnInfo(c)
          return connInfo.remote.address ?? 'unknown'
        } catch {
          return 'unknown'
        }
      },
    }
    buildLogoutRoutes(app, deps.sessionStore, sessionDepsWithRateLimiter, browserGuardDeps)
  }

  // ── CSRF endpoint ──────────────────────────────────────────────────────────
  //
  // Registered only when allowlist, csrfSecret, auditLogger, and sessionStore are present.
  // Route: GET /operator/session/csrf — privileged (requires session + allowlist).
  // Returns a fresh signed CSRF token for the authenticated session.
  if (browserGuardDeps !== undefined) {
    buildCsrfRoute(app, browserGuardDeps)
  }

  // ── Session info endpoint ───────────────────────────────────────────────────
  //
  // Registered only when the browser guard is present (same condition as CSRF endpoint).
  // Route: GET /operator/session — privileged (requires session + allowlist).
  // Returns current session info (operatorId, login, expiresAt) for the authenticated session.
  if (browserGuardDeps !== undefined) {
    buildSessionInfoRoute(app, browserGuardDeps)
  }

  // ── Run-stream SSE endpoint ─────────────────────────────────────────────────
  //
  // Registered only when the full browser guard is present AND the run-observation
  // deps (denylistCache, bindingsLookup, runObservationManager) are provided.
  // Route: GET /operator/runs/:runId/stream — privileged (requires session + allowlist).
  //
  // Gate ordering (all must pass before any byte is written):
  //   1. Guard (browser/session/allowlist/CSRF) — installed above
  //   2. Session token resolution
  //   3. RunIndex.lookup (server-owned repo resolution)
  //   4. Denylist check (pre-subscribe redaction, fail-closed)
  //   5. checkRepoAuthz (allowlist + GitHub repo access)
  //   6. Per-operator stream slot acquisition
  //   7. SSE stream open → first snapshot/reset frame
  //
  // Every failure at steps 2–5 returns the identical generic not-found shape.
  // There is NO authorized non-stream response — a distinguishable success would
  // be a run-resolved/authorized oracle.
  if (
    browserGuardDeps !== undefined &&
    deps.sessionStore !== undefined &&
    deps.denylistCache !== undefined &&
    deps.bindingsLookup !== undefined &&
    deps.runObservationManager !== undefined &&
    deps.runIndex !== undefined &&
    deps.allowlist !== undefined &&
    deps.auditLogger !== undefined
  ) {
    const clock = deps.sessionDeps?.clock ?? (() => Date.now())
    buildRunStreamRoute(app, {
      sessionStore: deps.sessionStore,
      runIndex: deps.runIndex,
      denylistCache: deps.denylistCache,
      bindingsLookup: deps.bindingsLookup,
      repoAuthzDeps: {
        allowlist: deps.allowlist,
        fetch: globalThis.fetch,
        clock,
        random: Math.random.bind(Math),
        auditLogger: deps.auditLogger,
        logger: deps.logger,
        cache: deps.repoAuthzCache ?? createRepoAuthzCache(),
      },
      manager: deps.runObservationManager,
      logger: deps.logger,
      now: clock,
    })
  }

  // ── Repos listing endpoint ─────────────────────────────────────────────────
  //
  // Registered only when the full browser guard is present AND listBindings,
  // denylistCache, and sessionStore are provided.
  // Route: GET /operator/repos — privileged (requires session + allowlist).
  // Returns the set of bound repos the operator is authorized to launch work in.
  //
  // Gate ordering:
  //   1. Guard (browser/session/allowlist) — installed above
  //   2. Session token resolution
  //   3. listBindings() — enumerate all bound repos
  //   4. filterDeniedRecords() — drop denylisted repos BEFORE any authz call
  //   5. checkRepoAuthz() per surviving binding — keep only authorized repos
  //   6. Cap at MAX_REPOS_PER_LISTING; map to RepoSummary[]; return 200
  if (
    browserGuardDeps !== undefined &&
    deps.sessionStore !== undefined &&
    deps.denylistCache !== undefined &&
    deps.listBindings !== undefined &&
    deps.allowlist !== undefined &&
    deps.auditLogger !== undefined
  ) {
    const clock = deps.sessionDeps?.clock ?? (() => Date.now())
    buildReposRoute(app, {
      sessionStore: deps.sessionStore,
      listBindings: deps.listBindings,
      isRepoDenied: deps.denylistCache.isRepoDenied.bind(deps.denylistCache),
      repoAuthzDeps: {
        allowlist: deps.allowlist,
        fetch: globalThis.fetch,
        clock,
        random: Math.random.bind(Math),
        auditLogger: deps.auditLogger,
        logger: deps.logger,
        cache: deps.repoAuthzCache ?? createRepoAuthzCache(),
      },
      logger: deps.logger,
      now: clock,
    })
  }

  // ── Launch route ───────────────────────────────────────────────────────────
  //
  // Registered only when the full browser guard is present AND getBindingByRepo
  // and launchWorkDeps are provided.
  // Route: POST /operator/runs — privileged (requires session + allowlist + CSRF).
  // Returns 202 {runId} immediately (fire-and-return); operator observes via SSE.
  //
  // Gate ordering:
  //   1. Guard (browser/session/allowlist/CSRF) — installed above (POST → requireCsrf=true)
  //   2. Operator rate limit (3/min, 10/hr, operator-keyed)
  //   3. Session token resolution
  //   4. Body parse: {repo, prompt, idempotencyKey?}
  //   5. Server-owned binding resolution via getBindingByRepo
  //   6. Denylist check (before authz, no oracle)
  //   7. checkRepoAuthz (allowlist + GitHub repo access)
  //   8. Empty-prompt fail-fast
  //   9. Per-operator idempotency guard
  //  10. Generate runId + register PENDING in run index
  //  11. Fire launchWork WITHOUT await → return 202 {runId}
  if (
    browserGuardDeps !== undefined &&
    deps.sessionStore !== undefined &&
    deps.denylistCache !== undefined &&
    deps.getBindingByRepo !== undefined &&
    deps.launchWorkDeps !== undefined &&
    deps.allowlist !== undefined &&
    deps.auditLogger !== undefined
  ) {
    const clock = deps.sessionDeps?.clock ?? (() => Date.now())
    buildLaunchRoute(app, {
      sessionStore: deps.sessionStore,
      bindingsLookup: {getBindingByRepo: deps.getBindingByRepo},
      isRepoDenied: deps.denylistCache.isRepoDenied.bind(deps.denylistCache),
      repoAuthzDeps: {
        allowlist: deps.allowlist,
        fetch: globalThis.fetch,
        clock,
        random: Math.random.bind(Math),
        auditLogger: deps.auditLogger,
        logger: deps.logger,
        cache: deps.repoAuthzCache ?? createRepoAuthzCache(),
      },
      idempotencyGuard: deps.idempotencyGuard ?? createIdempotencyGuard(),
      runIndex: deps.runIndex ?? {register: () => undefined, lookup: async () => undefined},
      launchWorkDeps: deps.launchWorkDeps,
      logger: deps.logger,
      now: clock,
    })
  }

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
