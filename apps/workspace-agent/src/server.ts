/**
 * Hono app factory for the workspace-agent HTTP service.
 *
 * Exported as a factory function (not a singleton) so tests can create
 * isolated instances without shared state.
 */

import type {CloneHandlerDeps, CloneHandlerResult} from './clone.js'
import type {InspectHandlerDeps, InspectHandlerResult} from './inspect.js'
import type {
  CloneFailure,
  CloneRequest,
  HealthzResponse,
  InspectFailure,
  InspectRequest,
  ReadyzResponse,
  UpdateRequest,
  UpdateResult,
  UpdateValidationFailure,
} from './types.js'
import type {UpdateHandlerDeps} from './update.js'

import {Buffer} from 'node:buffer'
import {timingSafeEqual} from 'node:crypto'

import {Hono} from 'hono'
import {executeClone, scrubCredentials} from './clone.js'
import {inspectCheckout} from './inspect.js'
import {sanitizeOwner, sanitizeRepo, validateTokenShape} from './sanitize.js'
import {executeUpdate} from './update.js'

/** Maximum allowed request body size in bytes. */
const MAX_BODY_BYTES = 4096

/** Fixed 401 body for a missing/wrong-scheme/wrong control-API bearer. Never echoes the presented header. */
const UNAUTHORIZED_BODY = {ok: false, error: 'unauthorized'} as const

/** Simplified clone executor signature for dependency injection. */
export type CloneExecutorFn = (request: CloneRequest, deps?: CloneHandlerDeps) => Promise<CloneHandlerResult>

/** Simplified inspect executor signature for dependency injection. */
export type InspectExecutorFn = (request: InspectRequest, deps?: InspectHandlerDeps) => Promise<InspectHandlerResult>

/**
 * Simplified update executor signature for dependency injection. Unlike `CloneExecutorFn`/
 * `InspectExecutorFn`, `executeUpdate` returns the bare `UpdateResult` union directly (no
 * `{response, statusCode}` wrapper) — the route below owns the result→status mapping itself; see
 * `statusForUpdateResult`.
 */
export type UpdateExecutorFn = (request: UpdateRequest, deps?: UpdateHandlerDeps) => Promise<UpdateResult>

/**
 * Maps an `UpdateResult` to an HTTP status code.
 *
 * - `ready` → 200: the checkout is current.
 * - `no-checkout` → 404: mirrors `/inspect`'s `no-checkout` → 404 — nothing exists at this path.
 * - `refused` → 409: mirrors `/inspect`'s `checkout-substituted` → 409 and `/clone`'s
 *   `repo-exists` → 409 — the checkout exists but its current state precludes this operation.
 * - `failed`, `reason === 'fetch-timeout'` → 504: mirrors `/clone`'s `clone-timeout` → 504 exactly
 *   (the closest existing precedent for "a network operation against the remote didn't complete
 *   in time").
 * - `failed`, `permanent === true` → 502: the remote gave a definitive, non-retryable rejection
 *   (`fetch-not-found`, `fetch-forbidden`) — this side reports it as an upstream failure, not a
 *   500 (which would imply a bug in this service).
 * - `failed`, otherwise → 503: every other failure reason is transient — safe, and expected, to
 *   retry later (auth rejected, rate-limited, unreachable, remote-moved, aborted,
 *   inspection-failed, apply-failed, termination-unconfirmed).
 */
function statusForUpdateResult(result: UpdateResult): 200 | 404 | 409 | 502 | 503 | 504 {
  if (result.kind === 'ready') return 200
  if (result.kind === 'no-checkout') return 404
  if (result.kind === 'refused') return 409
  if (result.reason === 'fetch-timeout') return 504
  return result.permanent ? 502 : 503
}

/**
 * OpenCode readiness state shared between the lifecycle and the server.
 * - starting: not yet ready (initial boot or mid-respawn transition)
 * - ready: OpenCode HTTP server is accepting connections
 * - down: terminal failure (unmanaged / unexpected)
 * - degraded: retries exhausted; clone API still alive, /readyz returns 503
 */
export type OpencodeStatus = 'starting' | 'ready' | 'down' | 'degraded'

export interface OpencodeStatusRef {
  /** Current readiness. Updated by the lifecycle holder. */
  status: OpencodeStatus
}

/**
 * Bearer proxy listening state shared between the proxy lifecycle and the server.
 * Set to true when the proxy http.Server emits 'listening'; cleared on close/error.
 * Used by /readyz to gate on the attach path (`:9200`) being usable.
 */
export interface ProxyListeningRef {
  /** Whether the bearer proxy is currently bound and listening. */
  listening: boolean
}

export interface ServerDeps {
  /** Injected clone executor for testability. */
  readonly cloneExecutor?: CloneExecutorFn
  /** Injected inspect executor for testability. */
  readonly inspectExecutor?: InspectExecutorFn
  /** Injected update executor for testability. */
  readonly updateExecutor?: UpdateExecutorFn
  /**
   * Trusted network config for the `/update` network half, read ONCE at startup (main.ts) and
   * merged into every `/update` call's `executeUpdate` deps alongside the per-request abort
   * signal. Not yet populated by production `main.ts` wiring — the egress proxy/CA-bundle values
   * themselves are a follow-up; this field exists now so that follow-up is a `main.ts` change
   * only, never another `createApp`/`ServerDeps` signature change. Shape mirrors
   * `UpdateHandlerDeps.caBundlePath`/`.proxy` (git-safety.ts's `NetworkGitProfileOptions.proxy`)
   * exactly, so passing it through is a straight merge, never a translation.
   */
  readonly updateNetworkConfig?: {
    readonly caBundlePath?: string
    readonly proxy?: {readonly https: string; readonly noProxy?: string}
  }
  /** OpenCode server readiness reference. When absent, opencode field is omitted from /healthz. */
  readonly opencodeStatus?: OpencodeStatusRef
  /**
   * Bearer proxy listening reference. When present, /readyz requires BOTH
   * opencodeStatus === 'ready' AND proxyListening.listening === true.
   * When absent, /readyz falls back to the opencode-only check (legacy/clone-only mode).
   */
  readonly proxyListening?: ProxyListeningRef
  /**
   * Required control-API auth mode — every caller must state it explicitly, so an
   * unauthenticated control API can never be built by omission.
   *
   * `{kind: 'bearer', token}`: every route except `/healthz` and `/readyz` requires
   * `Authorization: Bearer <token>`, checked before any body parsing, JSON parsing, or route
   * logic — a missing, wrong-scheme, or wrong token gets a fixed 401 body. Comparison is
   * constant-time (`timingSafeEqual`, length-guarded). The presented header value is never
   * logged. `token` must be non-empty (whitespace-only is also rejected).
   *
   * `{kind: 'disabled-for-tests'}`: no auth middleware is installed. Test-only — production
   * wiring in `main.ts` always passes the `bearer` variant, sourced from the
   * `WORKSPACE_OPENCODE_TOKEN` secret.
   */
  readonly auth: {readonly kind: 'bearer'; readonly token: string} | {readonly kind: 'disabled-for-tests'}
}

/**
 * Create the Hono application.
 *
 * @param deps - Dependency overrides. `deps.auth` is required — every caller must state
 *   whether the control API is protected (`bearer`) or intentionally open (`disabled-for-tests`).
 */
export function createApp(deps: ServerDeps): Hono {
  const {
    cloneExecutor = executeClone,
    inspectExecutor = inspectCheckout,
    updateExecutor = executeUpdate,
    updateNetworkConfig,
    opencodeStatus,
    proxyListening,
    auth,
  } = deps
  const app = new Hono()

  // Control-API bearer check — every route except /healthz and /readyz. Registered before any
  // route so it runs (and can short-circuit with 401) before body parsing, JSON parsing, or
  // owner/repo validation. Constant-time comparison; the presented header is never logged.
  // See ServerDeps.auth above and the reuse rationale in opencode-proxy.ts.
  if (auth.kind === 'bearer') {
    const {token} = auth
    // An empty expected token would authenticate `Authorization: Bearer ` with nothing after it.
    if (token.trim() === '') {
      throw new Error('createApp: control-API token must not be empty')
    }
    const expectedBuf = Buffer.from(token)
    app.use('*', async (c, next) => {
      if (c.req.path === '/healthz' || c.req.path === '/readyz') {
        return next()
      }

      const authHeader = c.req.header('authorization')
      let authorized = false
      if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        const presentedBuf = Buffer.from(authHeader.slice('Bearer '.length))
        // Guard length before timingSafeEqual (requires same-length buffers).
        if (presentedBuf.length === expectedBuf.length) {
          authorized = timingSafeEqual(presentedBuf, expectedBuf)
        }
      }

      if (authorized === false) {
        return c.json(UNAUTHORIZED_BODY, 401)
      }

      return next()
    })
  }

  // GET /healthz — liveness probe (always 200; clone-only signal)
  app.get('/healthz', c => {
    const body: HealthzResponse =
      opencodeStatus === undefined ? {ok: true} : {ok: true, opencode: opencodeStatus.status}
    return c.json(body, 200)
  })

  // GET /readyz — readiness probe (200 only when the full attach path is ready; 503 otherwise)
  //
  // When proxyListening is provided (production mode), BOTH conditions must hold:
  //   1. opencodeStatus.status === 'ready'  (loopback OpenCode is up)
  //   2. proxyListening.listening === true  (bearer proxy on :9200 is bound)
  //
  // This ensures /readyz reflects attach-path usability, not just loopback boot.
  // The startup false-negative is avoided because the proxy binds (OS-level, milliseconds)
  // before OpenCode finishes booting (seconds), so proxyListening.listening is true
  // before opencodeStatus can transition to 'ready' in normal boot.
  //
  // When proxyListening is absent (legacy/clone-only mode), falls back to opencode-only check.
  app.get('/readyz', c => {
    if (opencodeStatus === undefined) {
      const body: ReadyzResponse = {ready: false, opencode: 'unknown'}
      return c.json(body, 503)
    }
    const opencodeReady = opencodeStatus.status === 'ready'
    const proxyReady = proxyListening === undefined || proxyListening.listening === true
    const isReady = opencodeReady === true && proxyReady === true
    const body: ReadyzResponse = {ready: isReady, opencode: opencodeStatus.status}
    return c.json(body, isReady === true ? 200 : 503)
  })

  // POST /clone — clone a GitHub repo into the workspace
  app.post('/clone', async c => {
    // Body size guard — check Content-Length header first.
    // Chunked requests without Content-Length are also rejected (strict mode).
    const contentLengthHeader = c.req.header('content-length')
    if (contentLengthHeader === undefined || contentLengthHeader === null) {
      const err: CloneFailure = {ok: false, error: 'body-too-large'}
      return c.json(err, 413)
    }
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (Number.isNaN(contentLength) || contentLength > MAX_BODY_BYTES) {
      const err: CloneFailure = {ok: false, error: 'body-too-large'}
      return c.json(err, 413)
    }

    // Parse body
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      const err: CloneFailure = {ok: false, error: 'malformed-body'}
      return c.json(err, 400)
    }

    if (typeof body !== 'object' || body === null) {
      const err: CloneFailure = {ok: false, error: 'malformed-body'}
      return c.json(err, 400)
    }

    const raw = body as Record<string, unknown>

    // Validate owner
    const owner = sanitizeOwner(raw.owner)
    if (owner === null) {
      const err: CloneFailure = {ok: false, error: 'invalid-owner'}
      return c.json(err, 400)
    }

    // Validate repo
    const repo = sanitizeRepo(raw.repo)
    if (repo === null) {
      const err: CloneFailure = {ok: false, error: 'invalid-repo'}
      return c.json(err, 400)
    }

    // Validate token shape (never log the token)
    if (validateTokenShape(raw.token) === false) {
      const err: CloneFailure = {ok: false, error: 'invalid-token-shape'}
      return c.json(err, 400)
    }

    const request: CloneRequest = {
      owner,
      repo,
      token: raw.token,
    }

    const {response, statusCode} = await cloneExecutor(request)

    // Defense-in-depth: scrub any credential patterns from the response before sending.
    const scrubbed = JSON.parse(scrubCredentials(JSON.stringify(response))) as typeof response
    return c.json(scrubbed, statusCode)
  })

  // POST /inspect — read-only observation of an EXISTING checkout (branch, SHA, dirty state,
  // in-progress operation). Never clones, fetches, or mutates the checkout. Named distinctly from
  // `/clone` so its read-only contract is unambiguous at the route level.
  app.post('/inspect', async c => {
    const contentLengthHeader = c.req.header('content-length')
    if (contentLengthHeader === undefined || contentLengthHeader === null) {
      const err: InspectFailure = {ok: false, error: 'body-too-large'}
      return c.json(err, 413)
    }
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (Number.isNaN(contentLength) || contentLength > MAX_BODY_BYTES) {
      const err: InspectFailure = {ok: false, error: 'body-too-large'}
      return c.json(err, 413)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      const err: InspectFailure = {ok: false, error: 'malformed-body'}
      return c.json(err, 400)
    }

    if (typeof body !== 'object' || body === null) {
      const err: InspectFailure = {ok: false, error: 'malformed-body'}
      return c.json(err, 400)
    }

    const raw = body as Record<string, unknown>

    const owner = sanitizeOwner(raw.owner)
    if (owner === null) {
      const err: InspectFailure = {ok: false, error: 'invalid-owner'}
      return c.json(err, 400)
    }

    const repo = sanitizeRepo(raw.repo)
    if (repo === null) {
      const err: InspectFailure = {ok: false, error: 'invalid-repo'}
      return c.json(err, 400)
    }

    const request: InspectRequest = {owner, repo}

    const {response, statusCode} = await inspectExecutor(request)
    return c.json(response, statusCode)
  })

  // POST /update — bring an ELIGIBLE existing checkout up to date with its remote default branch,
  // or refuse/fail with a precise reason. Body validation mirrors /clone exactly (owner, repo,
  // installation token) since the network half needs the same credential /clone does. Unlike
  // /clone and /inspect, `executeUpdate` returns the bare `UpdateResult` union directly (no
  // `{response, statusCode}` wrapper already computed) — see `statusForUpdateResult` above and
  // `UpdateExecutorFn`'s own doc comment for why. No credential scrub on the way out: `UpdateResult`
  // has no field that could ever carry token/credential material (verified against every variant
  // in types.ts), unlike /clone's raw-git-stdout-derived response.
  app.post('/update', async c => {
    const contentLengthHeader = c.req.header('content-length')
    if (contentLengthHeader === undefined || contentLengthHeader === null) {
      const err: UpdateValidationFailure = {ok: false, error: 'body-too-large'}
      return c.json(err, 413)
    }
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (Number.isNaN(contentLength) || contentLength > MAX_BODY_BYTES) {
      const err: UpdateValidationFailure = {ok: false, error: 'body-too-large'}
      return c.json(err, 413)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      const err: UpdateValidationFailure = {ok: false, error: 'malformed-body'}
      return c.json(err, 400)
    }

    if (typeof body !== 'object' || body === null) {
      const err: UpdateValidationFailure = {ok: false, error: 'malformed-body'}
      return c.json(err, 400)
    }

    const raw = body as Record<string, unknown>

    const owner = sanitizeOwner(raw.owner)
    if (owner === null) {
      const err: UpdateValidationFailure = {ok: false, error: 'invalid-owner'}
      return c.json(err, 400)
    }

    const repo = sanitizeRepo(raw.repo)
    if (repo === null) {
      const err: UpdateValidationFailure = {ok: false, error: 'invalid-repo'}
      return c.json(err, 400)
    }

    if (validateTokenShape(raw.token) === false) {
      const err: UpdateValidationFailure = {ok: false, error: 'invalid-token-shape'}
      return c.json(err, 400)
    }

    const request: UpdateRequest = {owner, repo, token: raw.token}

    const result = await updateExecutor(request, {
      // The gateway's HTTP call has its own deadline; when the CLIENT disconnects (or its own
      // request times out), this propagates that as an abort — honored through the fetch phase,
      // ignored once the apply phase begins (executeUpdate's own documented contract).
      signal: c.req.raw.signal,
      caBundlePath: updateNetworkConfig?.caBundlePath,
      proxy: updateNetworkConfig?.proxy,
    })
    return c.json(result, statusForUpdateResult(result))
  })

  // 404 for unknown routes
  app.notFound(c => {
    return c.json({ok: false, error: 'not-found'}, 404)
  })

  return app
}
