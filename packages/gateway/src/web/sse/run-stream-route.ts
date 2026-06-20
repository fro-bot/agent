/**
 * Authenticated SSE route: GET /operator/runs/:runId/stream
 *
 * Gate ordering (all must pass before any byte is written):
 *   1. Guard (browser/session/allowlist/CSRF) — installed by buildOperatorApp
 *   2. Resolve session + OAuth token by sessionId
 *   3. Resolve runId → repo via RunIndex (server-owned; never client-supplied)
 *   4. Split owner/repo from the resolved location
 *   5. Resolve binding deny-keys; prime denylist; check isRepoDenied
 *   6. checkRepoAuthz (allowlist + GitHub repo access)
 *   7. Acquire per-operator stream slot (keyed on numeric githubUserId)
 *   8. Open SSE stream → deliver first snapshot/reset frame
 *
 * Every failure at steps 2–6 returns the identical generic not-found shape.
 * Step 7 failure returns 429 (honest backpressure for an already-authorized operator).
 * There is NO authorized non-stream response — a distinguishable success would be
 * a run-resolved/authorized oracle.
 */

import type {Context, Hono} from 'hono'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {SessionStore} from '../auth/session.js'
import type {OperatorLogger} from '../server.js'
import type {ObservationFrame, RunObservationManager} from './manager.js'

import {streamSSE, type SSEStreamingApi} from 'hono/streaming'
import {checkRepoAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse} from '../safe-response.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal run-index interface required by this route. */
export interface RunIndex {
  readonly lookup: (runId: string) => Promise<{readonly repo: string; readonly surface: string} | undefined>
}

/** Dependencies for the run-stream route. */
export interface RunStreamRouteDeps {
  /** Session store for token retrieval. */
  readonly sessionStore: SessionStore
  /** Server-owned run index for runId → repo resolution. */
  readonly runIndex: RunIndex
  /** Denylist cache for pre-subscribe redaction check. */
  readonly denylistCache: DenylistCache
  /** Bindings lookup for deny-key resolution. */
  readonly bindingsLookup: BindingsLookup
  /** Repo authorization dependencies. */
  readonly repoAuthzDeps: RepoAuthzDeps
  /** Run-observation manager for SSE subscription. */
  readonly manager: RunObservationManager
  /** Structured logger. */
  readonly logger: OperatorLogger
  /** Injectable clock. */
  readonly now: () => number
  /**
   * Maximum concurrent SSE streams per operator (keyed on numeric githubUserId).
   * Defaults to 5 when omitted.
   */
  readonly maxStreamsPerOperator?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum concurrent SSE streams per operator. */
const DEFAULT_MAX_STREAMS_PER_OPERATOR = 5

// ---------------------------------------------------------------------------
// Deny-key resolution (mirrors resolveRunRepoKey logic from surface-gate.ts,
// but takes owner/repo strings directly since we already have them from RunIndex)
// ---------------------------------------------------------------------------

interface RepoKey {
  readonly databaseId: number | null
  readonly nodeId: string | null
}

/**
 * Resolve deny-keys for a repo by calling getBindingByRepo directly.
 * Fail-closed: returns {null, null} on store error, missing binding, or missing keys.
 */
async function resolveRepoDenyKeys(owner: string, repo: string, bindingsLookup: BindingsLookup): Promise<RepoKey> {
  const NULL_KEY: RepoKey = {databaseId: null, nodeId: null}

  let result: Awaited<ReturnType<BindingsLookup['getBindingByRepo']>>
  try {
    result = await bindingsLookup.getBindingByRepo(owner, repo)
  } catch {
    return NULL_KEY
  }

  if (result.success === false) {
    return NULL_KEY
  }

  if (result.data === null) {
    return NULL_KEY
  }

  const binding = result.data
  const databaseId = typeof binding.databaseId === 'number' ? binding.databaseId : null
  const nodeId = typeof binding.nodeId === 'string' ? binding.nodeId : null

  return {databaseId, nodeId}
}

// ---------------------------------------------------------------------------
// SSE frame writer
// ---------------------------------------------------------------------------

/**
 * Write an observation frame to the SSE stream.
 * Only status, reset, and heartbeat frames are ever written — no raw run data.
 */
async function writeFrame(stream: SSEStreamingApi, frame: ObservationFrame): Promise<void> {
  if (frame.type === 'status') {
    await stream.writeSSE({event: 'status', data: JSON.stringify(frame.data)})
  } else if (frame.type === 'reset') {
    await stream.writeSSE({event: 'reset', data: JSON.stringify({runId: frame.runId, reason: frame.reason})})
  } else if (frame.type === 'heartbeat') {
    // SSE comment line — keepalive, not a named event
    await stream.write(': heartbeat\n\n')
  }
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Register GET /operator/runs/:runId/stream on the given Hono app.
 *
 * Must be called after setOperatorRouteGuard is installed in buildOperatorApp.
 * The guard runs first (browser/session/allowlist/CSRF); this handler runs only
 * if the guard allows the request.
 */
export function buildRunStreamRoute(app: Hono, deps: RunStreamRouteDeps): void {
  // Per-operator active stream count, keyed on numeric githubUserId.
  // Acquired before opening the stream; released synchronously when the stream ends.
  const activeStreams = new Map<number, number>()
  const maxStreams = deps.maxStreamsPerOperator ?? DEFAULT_MAX_STREAMS_PER_OPERATOR

  registerOperatorRoute(app, 'GET', '/operator/runs/:runId/stream', async (c: Context): Promise<Response> => {
    const nowMs = deps.now()

    // ── Gate 1: Read authenticated context set by the guard ──────────────────
    // In production the guard always sets this; undefined is unreachable.
    // Return not-found as a safe fallback (no oracle — same shape as all denials).
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      return notFoundResponse(c)
    }

    const {githubUserId, sessionId} = authCtx

    // ── Gate 2: Resolve OAuth token ──────────────────────────────────────────
    // A missing token means the session is dropped/expired/revoked and re-auth is needed.
    // Return not-found independent of runId so a re-auth need never becomes a
    // run-existence timing signal.
    const token = deps.sessionStore.getOperatorToken(sessionId, nowMs)
    if (token === undefined) {
      return notFoundResponse(c)
    }

    // ── Gate 3: Resolve runId → repo (server-owned) ──────────────────────────
    // The repo is NEVER taken from the client. RunIndex.lookup is the sole authority.
    const runId = c.req.param('runId') ?? ''
    const location = await deps.runIndex.lookup(runId)
    if (location === undefined) {
      return notFoundResponse(c)
    }

    // ── Gate 4: Split owner/repo ─────────────────────────────────────────────
    const slashIdx = location.repo.indexOf('/')
    if (slashIdx === -1) {
      return notFoundResponse(c)
    }
    const owner = location.repo.slice(0, slashIdx)
    const repo = location.repo.slice(slashIdx + 1)
    if (owner.length === 0 || repo.length === 0) {
      return notFoundResponse(c)
    }

    // ── Gate 5: Redaction check (explicit pre-subscribe, fail-closed) ─────────
    // Resolve deny-keys from the binding store (fail-closed on error/missing).
    // Prime/refresh the denylist cache, then check synchronously.
    // This runs BEFORE checkRepoAuthz so a denylisted repo never triggers a GitHub call.
    const denyKeys = await resolveRepoDenyKeys(owner, repo, deps.bindingsLookup)
    await deps.denylistCache.getDenylistState()
    if (deps.denylistCache.isRepoDenied(denyKeys) === true) {
      return notFoundResponse(c)
    }

    // ── Gate 6: Repo authorization ───────────────────────────────────────────
    // Allowlist + GitHub repo access check. Fail-closed on any error.
    const authzResult = await checkRepoAuthz(githubUserId, owner, repo, token, deps.repoAuthzDeps)
    if (authzResult.authorized === false) {
      return notFoundResponse(c)
    }

    // ── Gate 7: Acquire per-operator stream slot ─────────────────────────────
    // Keyed on numeric githubUserId (not session — a session key is bypassable
    // by opening multiple sessions). Over cap → 429 (honest backpressure for an
    // already-authorized operator; not a run oracle since authz already passed).
    const currentCount = activeStreams.get(githubUserId) ?? 0
    if (currentCount >= maxStreams) {
      return c.json({error: 'too many streams'}, 429)
    }
    activeStreams.set(githubUserId, currentCount + 1)

    // ── Gate 8: Open SSE stream ──────────────────────────────────────────────
    // All gates passed. Transition directly into the SSE stream.
    // There is NO intermediate authorized response — the stream IS the success.
    let cleaned = false

    const cleanup = (unsubscribe: () => void): void => {
      if (cleaned === true) return
      cleaned = true
      unsubscribe()
      // Release the slot synchronously so a rapid reconnect storm cannot
      // transiently exceed the cap.
      const count = activeStreams.get(githubUserId) ?? 0
      if (count <= 1) {
        activeStreams.delete(githubUserId)
      } else {
        activeStreams.set(githubUserId, count - 1)
      }
    }

    return streamSSE(c, async stream => {
      // Promise that resolves when the stream should end (manager closes or client aborts).
      // The streamSSE callback must stay alive (not return) while the stream is open.
      await new Promise<void>(resolve => {
        const unsubscribe = deps.manager.subscribe(runId, {
          onEvent: async (frame: ObservationFrame) => {
            if (cleaned === true) return
            try {
              await writeFrame(stream, frame)
            } catch {
              // Write failure — stream is likely closed; cleanup will handle it
              cleanup(unsubscribe)
              resolve()
            }
          },
          onClose: (_reason: string) => {
            cleanup(unsubscribe)
            resolve()
          },
        })

        // Register abort handler so client disconnect releases the slot
        stream.onAbort(() => {
          cleanup(unsubscribe)
          resolve()
        })
      })
    })
  })
}
