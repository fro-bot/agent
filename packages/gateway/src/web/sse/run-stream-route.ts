/**
 * Authenticated SSE route: GET /operator/runs/:runId/stream
 *
 * Gate ordering (all must pass before any byte is written):
 *   1. Guard (browser/session/allowlist/CSRF) — installed by buildOperatorApp
 *   2. Resolve runId → repo via RunIndex (server-owned; never client-supplied)
 *   3. Split owner/repo from the resolved location
 *   4. resolveRepoAccess (bound AND not denylisted, one binding read); anything but
 *      `allowed` → not found
 *   5. Acquire per-operator stream slot (keyed on numeric githubUserId)
 *   6. Open SSE stream → deliver ready frame (contract version) + first snapshot/reset frame
 *      On a cache miss the manager may resolve the run from persisted state (read only after
 *      gates 1–5, so a denied or unauthorized caller never triggers a durable read).
 *
 * Every failure at steps 2–4 returns the identical generic not-found shape.
 * Step 5 failure returns 429 (honest backpressure for an already-authorized operator).
 * There is NO authorized non-stream response — a distinguishable success would be
 * a run-resolved/authorized oracle.
 *
 * A live stream is re-verified on every lease tick (session, allowlist, repo access). Lease
 * logs carry the operator id and a gate label only — never an owner, repo or run id.
 */

import type {Socket} from 'node:net'
import type {RunState} from '@fro-bot/runtime'
import type {HttpBindings} from '@hono/node-server'
import type {Context, Hono} from 'hono'
import type {RunIndex as FullRunIndex} from '../../execute/run-index.js'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import type {AuditLogger} from '../audit.js'
import type {OperatorAllowlist} from '../auth/allowlist.js'
import type {DurableSessionStore} from '../auth/session.js'
import type {OperatorLogger} from '../server.js'
import type {ObservationFrame, RunObservationManager} from './manager.js'
import {streamSSE, type SSEStreamingApi} from 'hono/streaming'
import {OPERATOR_CONTRACT_VERSION} from '../../operator-contract/index.js'
import {emitAudit} from '../audit.js'
import {getOperatorAuthContext, registerOperatorRoute} from '../operator-route.js'
import {resolveRepoAccess, resolveRepoFromRunIndex} from '../operator/route-helpers.js'
import {notFoundResponse, rateLimitedResponse} from '../safe-response.js'
import {DEFAULT_MAX_STREAM_DURATION_MS} from './manager.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for the run-stream route. */
export interface RunStreamRouteDeps {
  /** Session store for the live-session check. Identity only — sessions hold no credential. */
  readonly sessionStore: Pick<DurableSessionStore, 'get'>
  /** Server-owned run index for runId → repo resolution. */
  readonly runIndex: Pick<FullRunIndex, 'lookup'>
  /**
   * Durable single-run read (`owner/repo`, runId), used only after all gates pass to resolve a
   * subscribe-time cache miss (terminal run whose replay entry was evicted or lost to a restart).
   * Optional — absent keeps the pre-existing cache-miss behavior (`reset: no-snapshot`, stay live).
   */
  readonly readRunState?: (repo: string, runId: string) => Promise<RunState | undefined>
  /** Denylist cache for pre-subscribe redaction check. */
  readonly denylistCache: DenylistCache
  /** Bindings lookup for deny-key resolution. */
  readonly bindingsLookup: BindingsLookup
  /**
   * Operator allowlist. The browser guard enforces it per request; the lease re-checks it on every
   * tick so an operator removed from the allowlist loses a live stream within one interval.
   */
  readonly allowlist: OperatorAllowlist
  /** Audit logger — the lease emits `authz.denied` when an operator leaves the allowlist. */
  readonly auditLogger: AuditLogger
  /** Run-observation manager for SSE subscription. */
  readonly manager: RunObservationManager
  /** Structured logger. */
  readonly logger: OperatorLogger
  /**
   * Maximum concurrent SSE streams per operator (keyed on numeric githubUserId).
   * Defaults to 5 when omitted.
   */
  readonly maxStreamsPerOperator?: number
  /**
   * How often (ms) to re-verify session, allowlist, and repo access for a live stream.
   * Defaults to DEFAULT_LEASE_INTERVAL_MS when omitted.
   */
  readonly leaseIntervalMs?: number
  /**
   * Bound (ms) on the repo-access read inside one lease tick. A read that does not settle in time counts as
   * `unavailable`, which closes the stream. Defaults to DEFAULT_LEASE_REPO_ACCESS_TIMEOUT_MS.
   */
  readonly leaseRepoAccessTimeoutMs?: number
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
  /**
   * Route-owned hard max-duration for a single SSE connection (defense-in-depth).
   * Defaults to DEFAULT_MAX_STREAM_DURATION_MS (same 30-minute value as the manager).
   * Injected in tests to drive the timer without real wall-clock delays.
   */
  readonly maxStreamDurationMs?: number
  /**
   * Injectable setTimeout — defaults to globalThis.setTimeout.
   * Injected in tests to drive the max-duration timer manually.
   */
  readonly setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>
  /**
   * Injectable clearTimeout — defaults to globalThis.clearTimeout.
   * Injected in tests to verify the timer is cleared on teardown.
   */
  readonly clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout> | undefined) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default bound on one lease tick's repo-access read, the scale of the removed GitHub fetch timeout. */
export const DEFAULT_LEASE_REPO_ACCESS_TIMEOUT_MS = 8_000

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
 * How often to re-verify session, allowlist, and repo access for a live stream.
 * A small multiple of the 15s heartbeat interval. Operator-side revocation (unbind,
 * denylist, allowlist removal, logout) closes a stream within one interval.
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
  } else if (frame.type === 'output') {
    await stream.writeSSE({event: 'output', data: JSON.stringify(frame.data)})
  } else if (frame.type === 'approval') {
    await stream.writeSSE({event: 'approval', data: JSON.stringify({runId: frame.runId, ...frame.data})})
  } else if (frame.type === 'question') {
    // Strings inside are untrusted plain text, carried verbatim as JSON string values.
    await stream.writeSSE({event: 'question', data: JSON.stringify({...frame.data, runId: frame.runId})})
  } else {
    // Exhaustiveness guard: a new ObservationFrame variant must be handled above.
    const EXHAUSTIVE_CHECK: never = frame
    throw new Error(`run-stream: unhandled frame type: ${JSON.stringify(EXHAUSTIVE_CHECK)}`)
  }
}

// ---------------------------------------------------------------------------
// Continuous-authz lease check
// ---------------------------------------------------------------------------

/** `resolveRepoAccess` under a deadline. A read that never settles reads as `unavailable`, which closes the stream. */
async function resolveRepoAccessBounded(owner: string, repo: string, deps: RunStreamRouteDeps) {
  const timeoutMs = deps.leaseRepoAccessTimeoutMs ?? DEFAULT_LEASE_REPO_ACCESS_TIMEOUT_MS
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined
  const timedOut = new Promise<{readonly kind: 'unavailable'}>(resolve => {
    timer = globalThis.setTimeout(() => {
      resolve({kind: 'unavailable'})
    }, timeoutMs)
  })
  try {
    return await Promise.race([resolveRepoAccess(owner, repo, deps), timedOut])
  } finally {
    globalThis.clearTimeout(timer)
  }
}

/**
 * Re-verify session, allowlist, and repo access for a live stream.
 *
 * Called on each lease tick. On any failure — including a transient `unavailable` from the
 * binding store — invokes onFail() to close this connection. Each await point is followed by a
 * generation guard: if the connection was already torn down (isCleaned() === true) before the
 * async work resolved, the tick is a no-op — no double cleanup, no late close.
 *
 * Log contexts carry `githubUserId` and a gate label only: no owner, repo or run id, and one
 * `repo-denied` label for both unbound and denylisted repos so the log is not an existence oracle.
 * Only an allowlist removal emits an audit event; repo-level denials emit none.
 */
async function runLeaseCheck(
  githubUserId: number,
  sessionId: string,
  owner: string,
  repo: string,
  deps: RunStreamRouteDeps,
  isCleaned: () => boolean,
  onFail: () => void,
): Promise<void> {
  // ── Check 1: Session still valid ─────────────────────────────────────────────────
  const session = deps.sessionStore.get(sessionId)
  if (isCleaned() === true) return
  if (session === undefined) {
    deps.logger.warn({githubUserId, gate: 'session'}, 'run-stream: lease closed')
    onFail()
    return
  }

  // ── Check 2: Operator still allowlisted ───────────────────────────────────────────
  if (deps.allowlist.isAuthorized(githubUserId) === false) {
    deps.logger.warn({githubUserId, gate: 'allowlist'}, 'run-stream: lease closed')
    emitAudit(
      {
        kind: 'authz.denied',
        correlationId: `run-stream-lease:${githubUserId}`,
        githubUserId,
        reason: 'not_allowlisted',
      },
      deps.auditLogger,
    )
    onFail()
    return
  }

  // ── Check 3: Repo still bound AND not denylisted ─────────────────────────────────
  // One binding read. A transient `unavailable` closes the stream (fail closed); the operator
  // reconnects through the full gate stack.
  const access = await resolveRepoAccessBounded(owner, repo, deps)
  if (isCleaned() === true) return
  if (access.kind !== 'allowed') {
    deps.logger.warn(
      {githubUserId, gate: access.kind === 'denied' ? 'repo-denied' : 'repo-unavailable'},
      'run-stream: lease closed',
    )
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
    // ── Gate 1: Read authenticated context set by the guard ──────────────────
    // In production the guard always sets this; undefined is unreachable.
    // Return not-found as a safe fallback (no oracle — same shape as all denials).
    const authCtx = getOperatorAuthContext(c)
    if (authCtx === undefined) {
      deps.logger.warn({gate: 'no-auth-ctx'}, 'run-stream: denied')
      return notFoundResponse(c)
    }

    const {githubUserId, sessionId} = authCtx

    // ── Gates 2–4: Pre-stream authorization gates ─────────────────────────────────
    // Wrapped in try/catch so any unexpected throw returns the uniform not-found
    // shape rather than propagating to Hono as a 500 (which would be distinguishable
    // from the 404 and break the no-oracle property).
    let runId: string
    let owner: string
    let repo: string

    try {
      // ── Gates 2–3: Resolve runId → {owner, repo} (server-owned) ──────────────
      // The repo is NEVER taken from the client. RunIndex.lookup is the sole authority.
      // resolveRepoFromRunIndex handles the lookup + owner/repo split in one call.
      runId = c.req.param('runId') ?? ''
      const resolved = await resolveRepoFromRunIndex(runId, deps.runIndex)
      if (resolved === null) {
        deps.logger.warn({githubUserId, runId, gate: 'runIndex-miss-or-malformed'}, 'run-stream: denied')
        return notFoundResponse(c)
      }
      owner = resolved.owner
      repo = resolved.repo

      // ── Gate 4: Repo access (bound AND not denylisted, fail-closed) ───────────────
      // One binding read. Unbound and denylisted share one denial label so the log is
      // not an existence oracle; repo-level denials emit no audit event.
      const access = await resolveRepoAccess(owner, repo, deps)
      if (access.kind !== 'allowed') {
        deps.logger.warn(
          {githubUserId, gate: access.kind === 'denied' ? 'repo-denied' : 'repo-unavailable'},
          'run-stream: denied',
        )
        return notFoundResponse(c)
      }
    } catch (error: unknown) {
      deps.logger.warn({runId: c.req.param('runId') ?? '', githubUserId, error}, 'run-stream: gate threw — denying')
      return notFoundResponse(c)
    }

    // ── Gate 5: Acquire per-operator stream slot ─────────────────────────────────────
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

    // ── Gate 6: Open SSE stream ───────────────────────────────────────────
    // All gates passed. Transition directly into the SSE stream.
    // There is NO intermediate authorized response — the stream IS the success.

    // Capture the connection socket before entering streamSSE so we can raise
    // and restore its timeout. Undefined when not running under @hono/node-server.
    const socket = getConnectionSocket(c)
    const priorSocketTimeout = raiseSocketTimeout(socket)

    const setIntervalFn = deps.setInterval ?? globalThis.setInterval.bind(globalThis)
    const clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval.bind(globalThis)
    const setTimeoutFn = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis)
    const clearTimeoutFn = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
    const leaseIntervalMs = deps.leaseIntervalMs ?? DEFAULT_LEASE_INTERVAL_MS
    const routeMaxDurationMs = deps.maxStreamDurationMs ?? DEFAULT_MAX_STREAM_DURATION_MS

    let cleaned = false
    // Declared before subscribe so a synchronous onClose('shutdown') during subscribe
    // can safely call unsubscribe?.() without hitting a TDZ ReferenceError.
    let unsubscribe: (() => void) | undefined
    // Declared before subscribe so a synchronous onClose can clear it.
    let leaseTimer: ReturnType<typeof globalThis.setInterval> | undefined
    // Declared before subscribe so a synchronous onClose can clear it safely
    // (clearTimeout(undefined) is a no-op).
    let maxDurationTimer: ReturnType<typeof globalThis.setTimeout> | undefined

    const cleanup = (closeReason: string): void => {
      if (cleaned === true) return
      cleaned = true
      // Clear both timers before unsubscribing so no tick or fire occurs during teardown.
      clearIntervalFn(leaseTimer)
      clearTimeoutFn(maxDurationTimer)
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

          const callbacks = {
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
          }
          const readRunState = deps.readRunState
          // The repo was resolved server-side at gate 2 and has passed repo access (gate 4); the
          // optional durable read is therefore strictly post-gate. With no reader wired the call is
          // the original two-argument subscribe.
          unsubscribe =
            readRunState === undefined
              ? deps.manager.subscribe(runId, callbacks)
              : deps.manager.subscribe(runId, callbacks, {
                  readDurableRunState: async () => readRunState(`${owner}/${repo}`, runId),
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

          // Route-owned hard max-duration timer (defense-in-depth).
          // Closes the connection if the manager's own max-duration timer fails to fire.
          maxDurationTimer = setTimeoutFn(() => {
            cleanup('route-max-duration')
            resolve()
          }, routeMaxDurationMs)

          // Start the continuous-authz lease timer.
          // Re-verifies session, allowlist, and repo access on each tick.
          // On any failure, closes this connection only (not run-wide).
          // A tick is skipped while the previous check is still in flight, so a slow read never stacks checks.
          let leaseCheckInFlight = false
          leaseTimer = setIntervalFn((): void => {
            if (leaseCheckInFlight === true) return
            leaseCheckInFlight = true
            // runLeaseCheck is async; fail-closed on unexpected error.
            runLeaseCheck(
              githubUserId,
              sessionId,
              owner,
              repo,
              deps,
              () => cleaned,
              () => {
                cleanup('lease-failed')
                resolve()
              },
            )
              .catch((error: unknown) => {
                deps.logger.warn({githubUserId, error}, 'run-stream: lease check threw — closing stream')
                cleanup('lease-error')
                resolve()
              })
              .finally(() => {
                leaseCheckInFlight = false
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
