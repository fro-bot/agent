/**
 * Hono app factory for the workspace-agent HTTP service.
 *
 * Exported as a factory function (not a singleton) so tests can create
 * isolated instances without shared state.
 */

import type {BackupsDeps} from './backups.js'
import type {CloneHandlerDeps, CloneHandlerResult} from './clone.js'
import type {InspectHandlerDeps, InspectHandlerResult} from './inspect.js'
import type {ExecuteRecoveryDeps, PreviewRecoveryDeps} from './recover.js'
import type {
  BackupsValidationFailure,
  CloneFailure,
  CloneRequest,
  DeleteBackupResult,
  ExecuteRecoveryRequest,
  ExecuteRecoveryResult,
  ExecuteRecoveryValidationFailure,
  HealthzResponse,
  InspectFailure,
  InspectRequest,
  ListBackupsResult,
  PreviewRecoveryRequest,
  PreviewRecoveryResult,
  PreviewRecoveryValidationFailure,
  ReadyzResponse,
  UpdateRequest,
  UpdateResult,
  UpdateValidationFailure,
} from './types.js'
import type {UpdateHandlerDeps} from './update.js'

import {Buffer} from 'node:buffer'
import {timingSafeEqual} from 'node:crypto'

import {Hono} from 'hono'
import {deleteBackup, listBackups} from './backups.js'
import {executeClone, scrubCredentials} from './clone.js'
import {inspectCheckout} from './inspect.js'
import {executeRecovery, previewRecovery} from './recover.js'
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

/** Simplified preview-recovery executor signature for dependency injection. Bare `PreviewRecoveryResult`, no `{response, statusCode}` wrapper — see `statusForPreviewRecoveryResult`. */
export type PreviewRecoveryExecutorFn = (
  request: PreviewRecoveryRequest,
  deps?: PreviewRecoveryDeps,
) => Promise<PreviewRecoveryResult>

/** Simplified execute-recovery executor signature for dependency injection. Bare `ExecuteRecoveryResult` — see `statusForExecuteRecoveryResult`. */
export type ExecuteRecoveryExecutorFn = (
  request: ExecuteRecoveryRequest,
  deps?: ExecuteRecoveryDeps,
) => Promise<ExecuteRecoveryResult>

/** Simplified list-backups executor signature for dependency injection. */
export type ListBackupsExecutorFn = (owner: string, repo: string, deps?: BackupsDeps) => Promise<ListBackupsResult>

/** Simplified delete-backup executor signature for dependency injection. */
export type DeleteBackupExecutorFn = (
  owner: string,
  repo: string,
  id: string,
  deps?: BackupsDeps,
) => Promise<DeleteBackupResult>

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
 * Maps a `PreviewRecoveryResult` to an HTTP status code, mirroring `statusForUpdateResult`.
 *
 * - `ok`, `recoverable-update` — 200: the preview itself succeeded; `recoverable-update` just
 *   reports a different situation (an interrupted update journal) than the ordinary preview shape.
 * - `no-checkout` — 404: mirrors `/inspect`/`/update`.
 * - `refused` — 409: the checkout/repository's current state precludes a preview (substituted,
 *   held, or a journal already in flight) — mirrors `/update`'s `refused` → 409.
 * - `failed` — 503: both reasons (`inspection-failed`, `termination-unconfirmed`) are transient
 *   local-check failures, safe to retry — mirrors `/update`'s non-permanent-failure fallback.
 */
function statusForPreviewRecoveryResult(result: PreviewRecoveryResult): 200 | 404 | 409 | 503 {
  if (result.kind === 'ok' || result.kind === 'recoverable-update') return 200
  if (result.kind === 'no-checkout') return 404
  if (result.kind === 'refused') return 409
  return 503
}

/**
 * Maps an `ExecuteRecoveryResult` to an HTTP status code, mirroring `statusForUpdateResult`.
 *
 * - `ok` — 200.
 * - `no-checkout` — 404.
 * - `refused` — 409 for every reason (`maintenance-hold`, `journal-in-progress`,
 *   `checkout-changed`, `quota-exceeded`, `insufficient-disk-space`): each is the checkout or
 *   repository's CURRENT state precluding this confirm, never a request-shape problem.
 * - `failed` — 503: `ExecuteRecoveryResult`'s failed variant carries no `permanent` flag (unlike
 *   `UpdateResult`) — every reason (including `termination-unconfirmed`) is treated as transient.
 */
function statusForExecuteRecoveryResult(result: ExecuteRecoveryResult): 200 | 404 | 409 | 503 {
  if (result.kind === 'ok') return 200
  if (result.kind === 'no-checkout') return 404
  if (result.kind === 'refused') return 409
  return 503
}

/** `ok` → 200; `failed` (an unreadable quarantine directory, or an unexpected fs error) → 503 — transient, safe to retry. */
function statusForListBackupsResult(result: ListBackupsResult): 200 | 503 {
  return result.kind === 'ok' ? 200 : 503
}

/**
 * Maps a `DeleteBackupResult` to an HTTP status code.
 *
 * - `ok` — 200 (with the `{kind: 'ok'}` body, consistent with every other route here returning
 *   its full result union — never a bodyless 204).
 * - `refused`, `invalid-id` — 400: a request-shape problem (the id itself is malformed), never a
 *   state conflict.
 * - `refused`, `not-found` — 404: mirrors `/inspect`'s/`/update`'s `no-checkout` → 404 for "nothing
 *   exists at this identifier".
 * - `refused`, `maintenance-hold` | `recovery-in-progress` — 409: the repository's current state
 *   precludes deletion right now — mirrors every other `refused` → 409 mapping in this file.
 * - `failed` — 503: an unexpected fs error deleting the generation — transient, safe to retry.
 */
function statusForDeleteBackupResult(result: DeleteBackupResult): 200 | 400 | 404 | 409 | 503 {
  if (result.kind === 'ok') return 200
  if (result.kind === 'refused') {
    if (result.reason === 'invalid-id') return 400
    if (result.reason === 'not-found') return 404
    return 409
  }
  return 503
}

/**
 * True only for a simple, single path segment — mirrors backups.ts's own (private) `isSimplePathSegment`
 * so a backup generation id is rejected at BOTH layers before ever reaching `deleteBackup`: no `/`
 * or `\`, no `..`/`.`, no embedded NUL, never empty. Hono decodes `%2F` in a path param to a literal
 * `/` before this ever runs, so it is caught by the same `includes('/')` check as a raw slash.
 */
function isSimplePathSegment(id: string): boolean {
  if (id.length === 0) return false
  if (id === '.' || id === '..') return false
  if (id.includes('/') || id.includes('\\')) return false
  if (id.includes('\0')) return false
  return true
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
  /** Injected recovery-preview executor for testability. */
  readonly previewRecoveryExecutor?: PreviewRecoveryExecutorFn
  /** Injected recovery executor for testability. */
  readonly executeRecoveryExecutor?: ExecuteRecoveryExecutorFn
  /** Injected list-backups executor for testability. */
  readonly listBackupsExecutor?: ListBackupsExecutorFn
  /** Injected delete-backup executor for testability. */
  readonly deleteBackupExecutor?: DeleteBackupExecutorFn
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
    previewRecoveryExecutor = previewRecovery,
    executeRecoveryExecutor = executeRecovery,
    listBackupsExecutor = listBackups,
    deleteBackupExecutor = deleteBackup,
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

  // POST /recover/preview — read-only report of what a `/recover` call would see, without ever
  // mutating anything. Body validation mirrors /inspect (owner, repo only — no token: preview
  // never touches the network). `previewRecoveryExecutor` returns the bare `PreviewRecoveryResult`
  // union directly, like `/update` — see `statusForPreviewRecoveryResult`.
  app.post('/recover/preview', async c => {
    const contentLengthHeader = c.req.header('content-length')
    if (contentLengthHeader === undefined || contentLengthHeader === null) {
      const err: PreviewRecoveryValidationFailure = {ok: false, error: 'body-too-large'}
      return c.json(err, 413)
    }
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (Number.isNaN(contentLength) || contentLength > MAX_BODY_BYTES) {
      const err: PreviewRecoveryValidationFailure = {ok: false, error: 'body-too-large'}
      return c.json(err, 413)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      const err: PreviewRecoveryValidationFailure = {ok: false, error: 'malformed-body'}
      return c.json(err, 400)
    }

    if (typeof body !== 'object' || body === null) {
      const err: PreviewRecoveryValidationFailure = {ok: false, error: 'malformed-body'}
      return c.json(err, 400)
    }

    const raw = body as Record<string, unknown>

    const owner = sanitizeOwner(raw.owner)
    if (owner === null) {
      const err: PreviewRecoveryValidationFailure = {ok: false, error: 'invalid-owner'}
      return c.json(err, 400)
    }

    const repo = sanitizeRepo(raw.repo)
    if (repo === null) {
      const err: PreviewRecoveryValidationFailure = {ok: false, error: 'invalid-repo'}
      return c.json(err, 400)
    }

    const request: PreviewRecoveryRequest = {owner, repo}

    const result = await previewRecoveryExecutor(request)
    return c.json(result, statusForPreviewRecoveryResult(result))
  })

  // POST /recover — confirms a previously previewed recovery: quarantines the existing checkout
  // (if any) and installs a fresh one at the remote's current default branch tip. Body validation
  // mirrors /update (owner, repo, installation token) plus the fingerprint the operator saw from
  // /recover/preview. `executeRecoveryExecutor` returns the bare `ExecuteRecoveryResult` union
  // directly — see `statusForExecuteRecoveryResult`. `ExecuteRecoveryDeps` carries no abort-signal
  // field yet, so there is nothing to pass through from `c.req.raw.signal` here.
  app.post('/recover', async c => {
    const contentLengthHeader = c.req.header('content-length')
    if (contentLengthHeader === undefined || contentLengthHeader === null) {
      const err: ExecuteRecoveryValidationFailure = {ok: false, error: 'body-too-large'}
      return c.json(err, 413)
    }
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (Number.isNaN(contentLength) || contentLength > MAX_BODY_BYTES) {
      const err: ExecuteRecoveryValidationFailure = {ok: false, error: 'body-too-large'}
      return c.json(err, 413)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      const err: ExecuteRecoveryValidationFailure = {ok: false, error: 'malformed-body'}
      return c.json(err, 400)
    }

    if (typeof body !== 'object' || body === null) {
      const err: ExecuteRecoveryValidationFailure = {ok: false, error: 'malformed-body'}
      return c.json(err, 400)
    }

    const raw = body as Record<string, unknown>

    const owner = sanitizeOwner(raw.owner)
    if (owner === null) {
      const err: ExecuteRecoveryValidationFailure = {ok: false, error: 'invalid-owner'}
      return c.json(err, 400)
    }

    const repo = sanitizeRepo(raw.repo)
    if (repo === null) {
      const err: ExecuteRecoveryValidationFailure = {ok: false, error: 'invalid-repo'}
      return c.json(err, 400)
    }

    if (validateTokenShape(raw.token) === false) {
      const err: ExecuteRecoveryValidationFailure = {ok: false, error: 'invalid-token-shape'}
      return c.json(err, 400)
    }

    if (typeof raw.fingerprint !== 'string' || raw.fingerprint.length === 0) {
      const err: ExecuteRecoveryValidationFailure = {ok: false, error: 'invalid-fingerprint'}
      return c.json(err, 400)
    }

    const request: ExecuteRecoveryRequest = {owner, repo, token: raw.token, fingerprint: raw.fingerprint}

    const result = await executeRecoveryExecutor(request)
    return c.json(result, statusForExecuteRecoveryResult(result))
  })

  // GET /backups/:owner/:repo — lists every quarantine generation for a repository. Owner/repo are
  // PATH params here (not a JSON body — GET has none), validated with the same sanitizers /clone
  // and every other route use.
  app.get('/backups/:owner/:repo', async c => {
    const owner = sanitizeOwner(c.req.param('owner'))
    if (owner === null) {
      const err: BackupsValidationFailure = {ok: false, error: 'invalid-owner'}
      return c.json(err, 400)
    }

    const repo = sanitizeRepo(c.req.param('repo'))
    if (repo === null) {
      const err: BackupsValidationFailure = {ok: false, error: 'invalid-repo'}
      return c.json(err, 400)
    }

    const result = await listBackupsExecutor(owner, repo)
    return c.json(result, statusForListBackupsResult(result))
  })

  // DELETE /backups/:owner/:repo/:id — removes exactly one quarantine generation. `id` is
  // validated HERE (rejecting `..`, any path separator — including a `%2F`-encoded one, which Hono
  // decodes to a literal `/` before this ever runs — and an empty segment) as a SECOND layer on top
  // of `deleteBackup`'s own internal check, per the module's "reject the string first, never
  // sanitize-then-join" posture: neither layer alone is trusted to be the only gate.
  app.delete('/backups/:owner/:repo/:id', async c => {
    const owner = sanitizeOwner(c.req.param('owner'))
    if (owner === null) {
      const err: BackupsValidationFailure = {ok: false, error: 'invalid-owner'}
      return c.json(err, 400)
    }

    const repo = sanitizeRepo(c.req.param('repo'))
    if (repo === null) {
      const err: BackupsValidationFailure = {ok: false, error: 'invalid-repo'}
      return c.json(err, 400)
    }

    const id = c.req.param('id')
    if (!isSimplePathSegment(id)) {
      const result: DeleteBackupResult = {kind: 'refused', reason: 'invalid-id'}
      return c.json(result, statusForDeleteBackupResult(result))
    }

    const result = await deleteBackupExecutor(owner, repo, id)
    return c.json(result, statusForDeleteBackupResult(result))
  })

  // 404 for unknown routes
  app.notFound(c => {
    return c.json({ok: false, error: 'not-found'}, 404)
  })

  return app
}
