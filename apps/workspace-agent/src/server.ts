/**
 * Hono app factory for the workspace-agent HTTP service.
 *
 * Exported as a factory function (not a singleton) so tests can create
 * isolated instances without shared state.
 */

import type {CloneHandlerDeps, CloneHandlerResult} from './clone.js'
import type {CloneFailure, CloneRequest, HealthzResponse, ReadyzResponse} from './types.js'

import {Hono} from 'hono'
import {executeClone, scrubCredentials} from './clone.js'
import {sanitizeOwner, sanitizeRepo, validateTokenShape} from './sanitize.js'

/** Maximum allowed request body size in bytes. */
const MAX_BODY_BYTES = 4096

/** Simplified clone executor signature for dependency injection. */
export type CloneExecutorFn = (request: CloneRequest, deps?: CloneHandlerDeps) => Promise<CloneHandlerResult>

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
  /** OpenCode server readiness reference. When absent, opencode field is omitted from /healthz. */
  readonly opencodeStatus?: OpencodeStatusRef
  /**
   * Bearer proxy listening reference. When present, /readyz requires BOTH
   * opencodeStatus === 'ready' AND proxyListening.listening === true.
   * When absent, /readyz falls back to the opencode-only check (legacy/clone-only mode).
   */
  readonly proxyListening?: ProxyListeningRef
}

/**
 * Create the Hono application.
 *
 * @param deps - Optional dependency overrides for testing.
 */
export function createApp(deps: ServerDeps = {}): Hono {
  const {cloneExecutor = executeClone, opencodeStatus, proxyListening} = deps
  const app = new Hono()

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

  // 404 for unknown routes
  app.notFound(c => {
    return c.json({ok: false, error: 'not-found'}, 404)
  })

  return app
}
