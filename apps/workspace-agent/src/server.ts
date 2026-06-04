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

/** OpenCode readiness state shared between the lifecycle and the server. */
export type OpencodeStatus = 'starting' | 'ready' | 'down'

export interface OpencodeStatusRef {
  /** Current readiness. Updated by the lifecycle holder. */
  status: OpencodeStatus
}

export interface ServerDeps {
  /** Injected clone executor for testability. */
  readonly cloneExecutor?: CloneExecutorFn
  /** OpenCode server readiness reference. When absent, opencode field is omitted from /healthz. */
  readonly opencodeStatus?: OpencodeStatusRef
}

/**
 * Create the Hono application.
 *
 * @param deps - Optional dependency overrides for testing.
 */
export function createApp(deps: ServerDeps = {}): Hono {
  const {cloneExecutor = executeClone, opencodeStatus} = deps
  const app = new Hono()

  // GET /healthz — liveness probe (always 200; clone-only signal)
  app.get('/healthz', c => {
    const body: HealthzResponse =
      opencodeStatus === undefined ? {ok: true} : {ok: true, opencode: opencodeStatus.status}
    return c.json(body, 200)
  })

  // GET /readyz — readiness probe (200 only when OpenCode is ready; 503 otherwise)
  app.get('/readyz', c => {
    if (opencodeStatus === undefined) {
      const body: ReadyzResponse = {ready: false, opencode: 'unknown'}
      return c.json(body, 503)
    }
    const isReady = opencodeStatus.status === 'ready'
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
