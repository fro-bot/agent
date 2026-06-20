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
 *   8. Open SSE stream → deliver ready frame (contract version) + first snapshot/reset frame
 *
 * Every failure at steps 2–6 returns the identical generic not-found shape.
 * Step 7 failure returns 429 (honest backpressure for an already-authorized operator).
 * There is NO authorized non-stream response — a distinguishable success would be
 * a run-resolved/authorized oracle.
 */

import type {Socket} from 'node:net'
import type {HttpBindings} from '@hono/node-server'
import type {Context, Hono} from 'hono'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {RepoAuthzDeps} from '../auth/repo-authz.js'
import type {SessionStore} from '../auth/session.js'
import type {OperatorLogger} from '../server.js'
import type {ObservationFrame, RunObservationManager} from './manager.js'

import {streamSSE, type SSEStreamingApi} from 'hono/streaming'
import {OPERATOR_CONTRACT_VERSION} from '../../operator-contract/index.js'
import {resolveBindingDenyKeys} from '../../redaction/surface-gate.js'
import {checkRepoAuthz} from '../auth/repo-authz.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {notFoundResponse, rateLimitedResponse} from '../safe-response.js'

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
  /**
   * How often (ms) to re-verify session, token, redaction, and repo authz for a live stream.
   * Defaults to DEFAULT_LEASE_INTERVAL_MS when omitted.
   */
  readonly leaseIntervalMs?: number
  /**
   * Injectable setInterval — defaults to globalThis.setInterval.
   * Injected in tests to drive lease ticks manually without real timers.
   */
  readonly setInterval?: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>
  /**
   * Injectable clearInterval — defaults to globalThis.clearInterval.
   * Injected in tests to verify the timer is cleared on teardown.
   */
  readonly clearInterval?: (id: ReturnType<typeof globalThis.setInterval> | undefined) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum concurrent SSE streams per operator. */
const DEFAULT_MAX_STREAMS_PER_OPERATOR = 5

/**
 * Per-connection socket timeout for SSE streams.
 * Must exceed the manager's 15s heartbeat interval so an idle-but-heartbeating
 * stream is not killed by the socket timeout. The global server timeout (10s)
 * bounds idle pre-auth sockets and is intentionally left unchanged.
 */
const SOCKET_TIMEOUT_MS = 60_000

/**
 * How often to re-verify session, token, redaction, and repo authz for a live stream.
 * A small multiple of the 15s heartbeat interval. Revocation detection is bounded by
 * checkRepoAuthz's positive cache TTL (~5m + 10% jitter) plus this interval.
 */
const DEFAULT_LEASE_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// Socket timeout helpers
// ---------------------------------------------------------------------------

/**
 * Read the Node socket from the Hono context's HttpBindings env, if present.
 * Returns undefined when running outside @hono/node-server (e.g. test harness
 * with plain app.fetch()) or when the socket has not yet been assigned.
 */
function getConnectionSocket(c: Context): Socket | undefined {
  const env = c.env as HttpBindings | undefined
  const socket = env?.incoming?.socket
  // IncomingMessage.socket is typed as Socket | null in Node's types
  return socket ?? undefined
}

/**
 * Raise the per-connection socket timeout above the heartbeat interval.
 * Returns the prior timeout value so it can be restored on every exit path.
 * Safe to call when socket is undefined — returns 0 (no-op restore).
 */
function raiseSocketTimeout(socket: Socket | undefined): number {
  if (socket === undefined) return 0
  // socket.timeout is number | undefined in Node's types; treat undefined as 0
  const prior = socket.timeout ?? 0
  socket.setTimeout(SOCKET_TIMEOUT_MS)
  return prior
}

/**
 * Restore the socket timeout to the value captured before the stream opened.
 * Must run on every exit path (normal close, error, abort) to avoid leaking
 * the raised timeout to a reused keep-alive socket.
 * Safe to call when socket is undefined — no-op.
 */
function restoreSocketTimeout(socket: Socket | undefined, priorTimeout: number): void {
  if (socket === undefined) return
  socket.setTimeout(priorTimeout)
}

// ---------------------------------------------------------------------------
// Reset-reason type
// ---------------------------------------------------------------------------

/**
 * Typed set of reasons a reset frame can carry.
 * Exhaustive over all reasons emitted by the manager and route layer.
 */
export type ResetReason = 'no-snapshot' | 'terminal' | 'shutdown' | 'max-duration' | 'writer-error' | 'overflow'

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
  } else {
    // Exhaustiveness guard: a new ObservationFrame variant must be handled above.
    const EXHAUSTIVE_CHECK: never = frame
    throw new Error(`run-stream: unhandled frame type: ${JSON.stringify(EXHAUSTIVE_CHECK)}`)
  }
}

// ---------------------------------------------------------------------------
// Continuous-authz lease check
// ---------------------------------------------------------------------------

/**
 * Re-verify session, token, redaction, and repo authz for a live stream.
 *
 * Called on each lease tick. On any failure, invokes onFail() to close this
 * connection. Each await point is followed by a generation guard: if the
 * connection was already torn down (isCleaned() === true) before the async
 * work resolved, the tick is a no-op — no double cleanup, no late close.
 *
 * Does NOT call dropOperatorToken() on a generic github_denied result because
 * that result cannot distinguish a revoked token from a denied repo.
 */
async function runLeaseCheck(
  githubUserId: number,
  sessionId: string,
  runId: string,
  owner: string,
  repo: string,
  deps: RunStreamRouteDeps,
  isCleaned: () => boolean,
  onFail: () => void,
): Promise<void> {
  const nowMs = deps.now()

  // ── Check 1: Session still valid ─────────────────────────────────────────
  const session = deps.sessionStore.get(sessionId, nowMs)
  if (isCleaned() === true) return
  if (session === undefined) {
    deps.logger.warn({githubUserId, runId}, 'run-stream: lease closed — session expired')
    onFail()
    return
  }

  // ── Check 2: OAuth token still present ───────────────────────────────────
  const freshToken = deps.sessionStore.getOperatorToken(sessionId, nowMs)
  if (isCleaned() === true) return
  if (freshToken === undefined) {
    deps.logger.warn({githubUserId, runId}, 'run-stream: lease closed — token missing')
    onFail()
    return
  }

  // ── Check 3: Repo still not denylisted ───────────────────────────────────
  const denyKeys = await resolveBindingDenyKeys(owner, repo, deps.bindingsLookup)
  if (isCleaned() === true) return
  await deps.denylistCache.getDenylistState()
  if (isCleaned() === true) return
  if (deps.denylistCache.isRepoDenied(denyKeys) === true) {
    deps.logger.warn({githubUserId, runId, owner, repo}, 'run-stream: lease closed — repo denylisted')
    onFail()
    return
  }

  // ── Check 4: Repo authz still passes ─────────────────────────────────────
  // Goes through checkRepoAuthz's cache; revocation detection is bounded by
  // the positive cache TTL (~5m + 10% jitter) plus the lease interval.
  // No cache-bypass — accepted for v1 (status-only data).
  const authzResult = await checkRepoAuthz(githubUserId, owner, repo, freshToken, deps.repoAuthzDeps)
  if (isCleaned() === true) return
  if (authzResult.authorized === false) {
    // Do NOT call dropOperatorToken here — github_denied cannot distinguish
    // a revoked token from a denied repo. Only drop on a token-specific signal.
    deps.logger.warn({githubUserId, runId, owner, repo}, 'run-stream: lease closed — authz denied')
    onFail()
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
      deps.logger.warn({gate: 'no-auth-ctx'}, 'run-stream: denied')
      return notFoundResponse(c)
    }

    const {githubUserId, sessionId} = authCtx

    // ── Gate 2–6: Pre-stream authorization gates ─────────────────────────────
    // Wrapped in try/catch so any unexpected throw returns the uniform not-found
    // shape rather than propagating to Hono as a 500 (which would be distinguishable
    // from the 404 and break the no-oracle property).
    let token: string
    let runId: string
    let owner: string
    let repo: string

    try {
      // ── Gate 2: Resolve OAuth token ────────────────────────────────────────
      // A missing token means the session is dropped/expired/revoked and re-auth is needed.
      // Return not-found independent of runId so a re-auth need never becomes a
      // run-existence timing signal.
      const resolvedToken = deps.sessionStore.getOperatorToken(sessionId, nowMs)
      if (resolvedToken === undefined) {
        deps.logger.warn({githubUserId, gate: 'no-token'}, 'run-stream: denied')
        return notFoundResponse(c)
      }
      token = resolvedToken

      // ── Gate 3: Resolve runId → repo (server-owned) ────────────────────────
      // The repo is NEVER taken from the client. RunIndex.lookup is the sole authority.
      runId = c.req.param('runId') ?? ''
      const location = await deps.runIndex.lookup(runId)
      if (location === undefined) {
        deps.logger.warn({githubUserId, runId, gate: 'runIndex-miss'}, 'run-stream: denied')
        return notFoundResponse(c)
      }

      // ── Gate 4: Split owner/repo ───────────────────────────────────────────
      const slashIdx = location.repo.indexOf('/')
      if (slashIdx === -1) {
        deps.logger.warn({githubUserId, runId, gate: 'malformed-repo'}, 'run-stream: denied')
        return notFoundResponse(c)
      }
      owner = location.repo.slice(0, slashIdx)
      repo = location.repo.slice(slashIdx + 1)
      if (owner.length === 0 || repo.length === 0) {
        deps.logger.warn({githubUserId, runId, gate: 'malformed-repo'}, 'run-stream: denied')
        return notFoundResponse(c)
      }

      // ── Gate 5: Redaction check (explicit pre-subscribe, fail-closed) ──────
      // Resolve deny-keys from the binding store (fail-closed on error/missing).
      // Prime/refresh the denylist cache, then check synchronously.
      // This runs BEFORE checkRepoAuthz so a denylisted repo never triggers a GitHub call.
      const denyKeys = await resolveBindingDenyKeys(owner, repo, deps.bindingsLookup)
      await deps.denylistCache.getDenylistState()
      if (deps.denylistCache.isRepoDenied(denyKeys) === true) {
        deps.logger.warn({githubUserId, runId, gate: 'denylisted'}, 'run-stream: denied')
        return notFoundResponse(c)
      }

      // ── Gate 6: Repo authorization ─────────────────────────────────────────
      // Allowlist + GitHub repo access check. Fail-closed on any error.
      const authzResult = await checkRepoAuthz(githubUserId, owner, repo, token, deps.repoAuthzDeps)
      if (authzResult.authorized === false) {
        deps.logger.warn({githubUserId, runId, gate: 'authz-denied'}, 'run-stream: denied')
        return notFoundResponse(c)
      }
    } catch (error: unknown) {
      deps.logger.warn({runId: c.req.param('runId') ?? '', githubUserId, error}, 'run-stream: gate threw — denying')
      return notFoundResponse(c)
    }

    // ── Gate 7: Acquire per-operator stream slot ─────────────────────────────
    // Keyed on numeric githubUserId (not session — a session key is bypassable
    // by opening multiple sessions). Over cap → 429 (honest backpressure for an
    // already-authorized operator; not a run oracle since authz already passed).
    const currentCount = activeStreams.get(githubUserId) ?? 0
    if (currentCount >= maxStreams) {
      deps.logger.warn({githubUserId, activeCount: currentCount, maxStreams}, 'run-stream: over cap')
      return rateLimitedResponse(c)
    }
    activeStreams.set(githubUserId, currentCount + 1)

    // Idempotent slot-release helper — safe to call multiple times.
    let slotReleased = false
    const releaseSlot = (): void => {
      if (slotReleased === true) return
      slotReleased = true
      const count = activeStreams.get(githubUserId) ?? 0
      if (count <= 1) {
        activeStreams.delete(githubUserId)
      } else {
        activeStreams.set(githubUserId, count - 1)
      }
    }

    // ── Gate 8: Open SSE stream ──────────────────────────────────────────────
    // All gates passed. Transition directly into the SSE stream.
    // There is NO intermediate authorized response — the stream IS the success.

    // Capture the connection socket before entering streamSSE so we can raise
    // and restore its timeout. Undefined when not running under @hono/node-server.
    const socket = getConnectionSocket(c)
    const priorSocketTimeout = raiseSocketTimeout(socket)

    const setIntervalFn = deps.setInterval ?? globalThis.setInterval.bind(globalThis)
    const clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval.bind(globalThis)
    const leaseIntervalMs = deps.leaseIntervalMs ?? DEFAULT_LEASE_INTERVAL_MS

    let cleaned = false
    // Declared before subscribe so a synchronous onClose('shutdown') during subscribe
    // can safely call unsubscribe?.() without hitting a TDZ ReferenceError.
    let unsubscribe: (() => void) | undefined
    // Declared before subscribe so a synchronous onClose can clear it.
    let leaseTimer: ReturnType<typeof globalThis.setInterval> | undefined

    const cleanup = (closeReason: string): void => {
      if (cleaned === true) return
      cleaned = true
      // Clear the lease timer before unsubscribing so no tick fires during teardown.
      clearIntervalFn(leaseTimer)
      // unsubscribe may be undefined if onClose fired synchronously during subscribe.
      unsubscribe?.()
      // Release the slot synchronously so a rapid reconnect storm cannot
      // transiently exceed the cap.
      releaseSlot()
      // Restore the socket timeout to its pre-stream value so it never leaks
      // to a reused keep-alive socket. Wrapped in try/catch so a destroyed-socket
      // error does not skip the slot release above.
      try {
        restoreSocketTimeout(socket, priorSocketTimeout)
      } catch {
        // Socket already destroyed — timeout restore is a no-op; slot already released.
      }
      deps.logger.info({githubUserId, runId, reason: closeReason}, 'run-stream: closed')
    }

    deps.logger.info({githubUserId, runId, owner, repo}, 'run-stream: opened')

    return streamSSE(c, async stream => {
      // Promise that resolves when the stream should end (manager closes or client aborts).
      // The streamSSE callback must stay alive (not return) while the stream is open.
      try {
        await new Promise<void>(resolve => {
          // Emit the ready frame (contract version) as the very first SSE frame.
          // Sent only after all gates pass — never on a denial path.
          // Fire-and-forget: if the write fails the stream is broken and the
          // abort/onClose path will clean up.
          stream
            .writeSSE({event: 'ready', data: JSON.stringify({contractVersion: OPERATOR_CONTRACT_VERSION})})
            .catch(() => {})

          unsubscribe = deps.manager.subscribe(runId, {
            onEvent: async (frame: ObservationFrame) => {
              if (cleaned === true) return
              try {
                await writeFrame(stream, frame)
              } catch {
                // Write failure — stream is likely closed; cleanup will handle it
                cleanup('writer-error')
                resolve()
              }
            },
            onClose: (reason: string) => {
              cleanup(reason)
              resolve()
            },
          })

          // If onClose fired synchronously during subscribe (e.g. 'shutdown'),
          // cleaned is already true — no further setup needed.
          if (cleaned === true) {
            resolve()
            return
          }

          // Register abort handler so client disconnect releases the slot
          stream.onAbort(() => {
            cleanup('client-abort')
            resolve()
          })

          // Start the continuous-authz lease timer.
          // Re-verifies session, token, redaction, and repo authz on each tick.
          // On any failure, closes this connection only (not run-wide).
          leaseTimer = setIntervalFn((): void => {
            // runLeaseCheck is async; fail-closed on unexpected error.
            runLeaseCheck(
              githubUserId,
              sessionId,
              runId,
              owner,
              repo,
              deps,
              () => cleaned,
              () => {
                cleanup('lease-failed')
                resolve()
              },
            ).catch((error: unknown) => {
              deps.logger.warn({runId, githubUserId, error}, 'run-stream: lease check threw — closing stream')
              cleanup('lease-error')
              resolve()
            })
          }, leaseIntervalMs)
        })
      } finally {
        // Safety net: ensure the slot is always released even if an unexpected
        // throw bypassed all cleanup paths (e.g. streamSSE internal error).
        releaseSlot()
        // Restore the socket timeout if cleanup() was never called.
        // cleanup() sets cleaned=true before restoring, so this is a no-op when
        // cleanup already ran — avoids a double-restore on a reused keep-alive socket.
        if (cleaned === false) {
          try {
            restoreSocketTimeout(socket, priorSocketTimeout)
          } catch {
            // Socket already destroyed — no-op.
          }
        }
      }
    })
  })
}
