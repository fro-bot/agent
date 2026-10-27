/**
 * In-memory pub/sub for run-status observation.
 *
 * `observe(runState)` projects the run through the redaction bridge, overlays the
 * live waiting state, caches the latest status per run, and fans it to that run's
 * subscribers. A denied/keyless projection is dropped — never cached, never
 * emitted. An unavailable one (the binding store failed) emits and caches nothing and
 * keeps the run's last good state. The manager retains each live run's base status
 * (overlay not applied) and a scope index; `refreshScope(scopeId)` reapplies the
 * overlay synchronously when a request opens or leaves, so live status and replay
 * track registry truth. Retained state exists only between a projected non-terminal
 * observation and the run's terminal observation, a denied projection, a refresh-time
 * denial, or shutdown; a refresh never commits without it. Fan-out serializes
 * once and enqueues per subscriber; it never awaits a write, so a slow consumer
 * cannot stall publishing. A subscriber whose queue exceeds the byte cap is
 * dropped locally without affecting peers, and fan-out iterates a snapshot of the
 * subscriber set so mid-fan-out removal is safe.
 *
 * `subscribe(runId)` delivers the cached latest status first (or a `reset` frame
 * if none exists), then live frames, plus a keepalive heartbeat; subscriptions
 * close at the max-duration cap. Only three frame shapes are ever enqueued —
 * status (the closed-DTO contract type), reset, and heartbeat — so RunState and
 * its details never reach a subscriber.
 *
 * This is observer-only: the deps carry no mutating run API, and teardown touches
 * only the subscription's own timers and queue, never the run, lock, or heartbeat.
 * EOF before a terminal status closes as an observation failure, not run success.
 */

import type {RunState} from '@fro-bot/runtime'
import type {
  ApprovalFrameData,
  OperatorOutputFrame,
  OperatorRunStatus,
  QuestionFrameData,
  RunStatusRepoKey,
} from '../../operator-contract/index.js'
import type {RunStatusProjection} from '../../redaction/surface-gate.js'
import type {WaitingPredicates} from './projection.js'

import {isDeepStrictEqual} from 'node:util'

import {overlayWaitingStatus, overlayWaitReason, scopeIdFor} from './projection.js'

// ---------------------------------------------------------------------------
// Constants (injectable for tests)
// ---------------------------------------------------------------------------

/** Default heartbeat interval (15 seconds). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

/** Default max stream duration (30 minutes). */
export const DEFAULT_MAX_STREAM_DURATION_MS = 30 * 60 * 1000

/** Default per-subscriber queue cap in bytes (64 KB). */
export const DEFAULT_SUBSCRIBER_QUEUE_CAP_BYTES = 64 * 1024

/**
 * Default TTL for the terminal replay cache (10 minutes).
 * Late subscribers connecting within this window receive the final output
 * and terminal status, then the stream closes gracefully.
 */
export const DEFAULT_TERMINAL_REPLAY_TTL_MS = 10 * 60 * 1000

/**
 * Maximum number of entries in the terminal replay cache.
 * Oldest entries are evicted when this cap is exceeded.
 */
export const DEFAULT_TERMINAL_REPLAY_MAX_ENTRIES = 500

/**
 * Maximum total byte budget for the terminal replay cache (8 MB).
 * When inserting an entry would exceed this budget, oldest entries are evicted
 * until the budget is satisfied. Works in tandem with the entry-count cap.
 */
export const DEFAULT_TERMINAL_REPLAY_MAX_BYTES = 8 * 1024 * 1024

// ---------------------------------------------------------------------------
// Terminal statuses
// ---------------------------------------------------------------------------

/** Max open question frames kept for reconnect replay, per run. Live delivery is not limited by this. */
export const MAX_OPEN_QUESTION_REPLAY_PER_RUN = 8

const TERMINAL_STATUSES = new Set<OperatorRunStatus['status']>(['succeeded', 'failed', 'cancelled'])

function isTerminal(status: OperatorRunStatus['status']): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** The run phases that project to a terminal status. */
const TERMINAL_PHASES: ReadonlySet<RunState['phase']> = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])

// ---------------------------------------------------------------------------
// Frame types (closed union — only these three types are ever enqueued)
// ---------------------------------------------------------------------------

/** A status frame carrying the closed-DTO OperatorRunStatus. */
export interface StatusFrame {
  readonly type: 'status'
  readonly data: OperatorRunStatus
}

/**
 * Typed set of reasons a reset frame can carry.
 * Exhaustive over all reasons emitted by the manager.
 */
export type ResetReason = 'no-snapshot' | 'terminal' | 'shutdown' | 'max-duration' | 'writer-error' | 'overflow'

/** A reset frame emitted when no snapshot exists for a run. */
export interface ResetFrame {
  readonly type: 'reset'
  readonly runId: string
  readonly reason: ResetReason
}

/** A heartbeat keepalive frame. */
export interface HeartbeatFrame {
  readonly type: 'heartbeat'
}

/** An output frame carrying the agent's visible text. */
export interface OutputFrame {
  readonly type: 'output'
  readonly data: OperatorOutputFrame
}

/**
 * An approval frame carrying a pending tool-permission request (or its
 * settle/clear signal) to the browser.
 *
 * Open frames (`data.settled === false`) carry the full request detail.
 * Settle/clear frames (`data.settled === true`) carry only the requestID so
 * the browser can dismiss the prompt.
 *
 * Approval frames are NOT coalesced — they are rare and must arrive intact.
 * They fan out via the non-coalescing `enqueueFrame` path.
 */
export interface ApprovalFrame {
  readonly type: 'approval'
  readonly runId: string
  readonly data: ApprovalFrameData
}

/**
 * A question frame carrying a pending agent question (or its settle/clear
 * signal) to the browser. All question and answer strings inside are untrusted
 * plain text; see `operator-contract/question-frame.ts`.
 *
 * Like approval frames, question frames are NOT coalesced: they are rare and
 * must arrive intact, and fan out via the non-coalescing `enqueueFrame` path.
 */
export interface QuestionFrame {
  readonly type: 'question'
  readonly runId: string
  readonly data: QuestionFrameData
}

/** The closed union of all frame types the manager can emit. */
export type ObservationFrame = StatusFrame | ResetFrame | HeartbeatFrame | OutputFrame | ApprovalFrame | QuestionFrame

// ---------------------------------------------------------------------------
// Subscriber callbacks
// ---------------------------------------------------------------------------

export interface SubscriberCallbacks {
  /** Called synchronously (or async) when a frame is ready. May throw — errors are contained. */
  readonly onEvent: (frame: ObservationFrame) => void | Promise<void>
  /** Called when the subscription is closed for any reason. */
  readonly onClose: (reason: string) => void
}

/**
 * Optional per-subscription seams.
 *
 * `readDurableRunState` resolves a subscribe-time cache miss from persisted run state.
 * It is supplied by the caller (the route), which has already resolved the run's repo
 * server-side and passed the redaction and authz gates — the manager has no storage or
 * authorization knowledge of its own. Absent → the cache-miss path is unchanged.
 */
export interface SubscribeOptions {
  readonly readDurableRunState?: () => Promise<RunState | undefined>
}

// ---------------------------------------------------------------------------
// Logger interface (minimal — matches GatewayLogger shape)
// ---------------------------------------------------------------------------

export interface ObservationManagerLogger {
  readonly info: (obj: Record<string, unknown>, msg: string) => void
  readonly warn: (obj: Record<string, unknown>, msg: string) => void
  readonly error: (obj: Record<string, unknown>, msg: string) => void
  readonly debug: (obj: Record<string, unknown>, msg: string) => void
}

// ---------------------------------------------------------------------------
// Deps interface — observer-only by construction (NO mutating run API)
// ---------------------------------------------------------------------------

/**
 * Dependencies for createRunObservationManager.
 *
 * Observer-only by construction: this interface has NO mutating run API.
 * There is no transitionRun, acquireLock, releaseLock, heartbeat, or coordinator.
 * The manager cannot mutate run lifecycle even if it wanted to.
 */
export interface RunObservationManagerDeps {
  /**
   * Project a RunState to its base status — redaction applied, waiting overlay NOT applied — together
   * with the run's repository key, or `denied` / `unavailable` (see RunStatusProjection). The key is
   * the one the redaction bridge resolved, so retaining it costs no second binding lookup.
   * Injected so the manager test doesn't need a real bindings store.
   */
  readonly projectBase: (runState: RunState) => Promise<RunStatusProjection>

  /** Live registry reads for the waiting overlay. Both families are required. */
  readonly waiting: WaitingPredicates

  /**
   * The completion gate's latest declined-attempt code for a run, if it is draining. The manager maps it to the
   * closed wire `waitReason` and shows it only on a `running` status. Optional: without it no run shows one.
   */
  readonly readWaitReason?: (runId: string) => string | undefined

  /**
   * Synchronous denylist check, re-run on every scope refresh so a repository denied mid-run stops
   * emitting without waiting for a lifecycle observation.
   */
  readonly isRepoDenied: (repoKey: RunStatusRepoKey) => boolean

  /** Logger with redaction. */
  readonly logger: ObservationManagerLogger

  // Timer seams — injectable for deterministic tests
  readonly setInterval: (cb: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>
  readonly clearInterval: (id: ReturnType<typeof globalThis.setInterval> | undefined) => void
  readonly setTimeout: (cb: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>
  readonly clearTimeout: (id: ReturnType<typeof globalThis.setTimeout> | undefined) => void
  readonly now: () => number

  // Optional injectable bounds (defaults to named constants above)
  readonly heartbeatIntervalMs?: number
  readonly maxStreamDurationMs?: number
  readonly subscriberQueueCapBytes?: number
  readonly terminalReplayTtlMs?: number
  readonly terminalReplayMaxEntries?: number
  /** Total byte budget for the terminal replay cache. Defaults to DEFAULT_TERMINAL_REPLAY_MAX_BYTES. */
  readonly terminalReplayMaxBytes?: number
}

// ---------------------------------------------------------------------------
// Public manager interface
// ---------------------------------------------------------------------------

/**
 * The refresh seam, kept off {@link RunObservationManager}: only the program wiring that subscribes to
 * the request gate calls it, so route and launch consumers never depend on it.
 */
export interface ScopeRefresher {
  /**
   * Reapply the waiting overlay to every live run in the scope, synchronously. Call it when a
   * request in the scope opens or leaves the request gate. Emits and caches only on a status
   * change; a run without retained state, or whose repository is now denied, is skipped.
   * No-op after shutdown.
   */
  readonly refreshScope: (scopeId: string) => void

  /**
   * Reapply the overlays to one run, synchronously. Call it when the run's wait reason changes. Emits and caches only
   * on a status change; a run without retained state, or whose repository is now denied, is skipped. No-op after
   * shutdown.
   */
  readonly refreshRun: (runId: string) => void
}

export interface RunObservationManager {
  /**
   * Observe a run state transition. Projects the base status via the injected function.
   * A null projection is dropped (no cache, no emit) and the run's retained state is released.
   * A non-null projection retains the base, overlays the live waiting state read at commit time,
   * updates the latest-status cache, and fans out to subscribers.
   * On a terminal status, clears the cache entry and closes subscribers cleanly.
   * NEVER awaits a subscriber write — strictly non-blocking.
   */
  readonly observe: (runState: RunState) => Promise<void>

  /**
   * Subscribe to run-status frames for a given runId.
   * If a latest-status cache entry exists, delivers it immediately as the first frame.
   * If none exists, emits a single `reset` frame.
   *
   * When `options.readDurableRunState` is supplied and there is no cached snapshot, the
   * persisted run state is consulted (fail-soft, off the subscribe path — the subscriber is
   * live and queued before the read starts). A terminal persisted state is
   * projected through the same deny-gated projection as live observations, delivered as the
   * terminal status frame, and the subscriber is closed with `terminal`. A live, unknown,
   * denied, or failed read leaves the subscriber on the ordinary live path.
   * No terminal output frame is synthesized: durable state carries no output text.
   *
   * Returns an unsubscribe function for clean disconnect (no onClose called).
   */
  readonly subscribe: (runId: string, callbacks: SubscriberCallbacks, options?: SubscribeOptions) => () => void

  /**
   * Observe an output text fragment for a run. Observer-only / best-effort.
   *
   * Builds an OutputFrame with a per-run monotonic seq counter and fans it out to
   * all current subscribers of the run via the same enqueueFrame path. On overflow,
   * output frames COALESCE (do not drop the subscriber): pending output frames are
   * merged and a droppedCount is accumulated onto the next successfully-enqueued
   * output frame for that subscriber, keeping the connection alive.
   *
   * On opts.final === true, caches the frame in the terminal replay cache so late
   * subscribers receive the final answer on subscribe.
   *
   * Does NOT add any mutating run API to the deps — observer-only by construction.
   */
  readonly observeOutput: (runId: string, text: string, opts?: {final?: boolean; droppedCount?: number}) => void

  /**
   * Observe a pending or settled approval request for a run. Observer-only / best-effort.
   *
   * Fans an ApprovalFrame to all current subscribers of the run via the
   * non-coalescing `enqueueFrame` path — approval frames are rare and must
   * arrive intact (unlike output frames, they are NOT coalesced on overflow).
   *
   * Call with `data.settled === false` when a permission gate opens, and with
   * `data.settled === true` when the request is resolved (approved or rejected).
   * The settle/clear frame should be enqueued BEFORE the terminal status fans
   * out so the browser can dismiss the prompt before the run closes.
   *
   * Does NOT add any mutating run API to the deps — observer-only by construction.
   * Drops silently when the manager is shut down or the run has already reached
   * terminal state (out-of-order async guard).
   */
  readonly observeApproval: (runId: string, data: ApprovalFrameData) => void

  /**
   * Observe a pending or settled agent question for a run. Observer-only / best-effort.
   *
   * Fans a QuestionFrame to all current subscribers via the non-coalescing
   * `enqueueFrame` path, like approval frames. Call with `data.settled === false`
   * when a question opens and `data.settled === true` when it settles (answered,
   * skipped, expired, or torn down); the settle frame must be observed BEFORE the
   * terminal status so the browser dismisses the prompt before the run closes.
   *
   * Unlike approval frames, open question frames are also replayed to a
   * subscriber that connects while the question is pending (reconnect
   * reconciliation). The replay set is bounded (`MAX_OPEN_QUESTION_REPLAY_PER_RUN`
   * per run, oldest evicted), cleared on settle and on terminal, and never holds
   * a settled question. An open frame larger than half the subscriber queue cap
   * is dropped with a warning (ids only) rather than evicting every subscriber.
   *
   * Drops silently when the manager is shut down or the run has already reached
   * terminal state (out-of-order async guard).
   */
  readonly observeQuestion: (runId: string, data: QuestionFrameData) => void

  /**
   * Abort a subscription with a given reason (e.g., 'observation-failed' for EOF).
   * Calls onClose(reason) and removes the subscription + its timers/queue.
   * Used by the route layer to signal connection drops before a terminal status.
   * Aborts ALL subscriptions for the given runId with the given reason.
   */
  readonly abortSubscription: (runId: string, reason: string) => void

  /**
   * Shut down the manager: close all subscriptions with 'shutdown', clear all caches/timers.
   * Idempotent.
   */
  readonly shutdown: () => void
}

// ---------------------------------------------------------------------------
// Internal subscriber state
// ---------------------------------------------------------------------------

interface SubscriberState {
  readonly id: string
  readonly runId: string
  readonly callbacks: SubscriberCallbacks
  /** Pending frames waiting to be drained to onEvent. */
  readonly queue: ObservationFrame[]
  /** Current estimated byte size of the queue. */
  queueBytes: number
  /** Whether the writer task is currently running. */
  writerRunning: boolean
  /** Whether this subscriber has been dropped (overflow, error, close, etc.). */
  dropped: boolean
  /** Heartbeat interval timer ID. */
  heartbeatTimer: ReturnType<typeof globalThis.setInterval> | undefined
  /** Max-duration timeout timer ID. */
  maxDurationTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  /**
   * Accumulated count of output frames coalesced/dropped for this subscriber.
   * Carried onto the next successfully-enqueued output frame as droppedCount.
   * Keeps the connection alive under output overflow (unlike status frames which
   * drop the subscriber).
   */
  coalescedDropCount: number
  /**
   * When set to 'terminal', this subscriber is in graceful-drain mode:
   * - No new frames are accepted (heartbeat enqueue is skipped).
   * - The queue is NOT cleared; drainQueue delivers all already-queued frames.
   * - When the queue empties, drainQueue finalizes: removes from runSubscribers,
   *   clears timers, calls onClose('terminal').
   * - dropped is NOT set to true until finalization.
   */
  closingReason: 'terminal' | undefined
}

// ---------------------------------------------------------------------------
// Terminal replay cache entry
// ---------------------------------------------------------------------------

interface TerminalReplayCacheEntry {
  finalOutput: OperatorOutputFrame | undefined
  terminalStatus: OperatorRunStatus | undefined
  expiresAt: number
  evictionTimer: ReturnType<typeof globalThis.setTimeout> | undefined
}

// ---------------------------------------------------------------------------
// Byte estimation for queue cap
// ---------------------------------------------------------------------------

/**
 * Estimate the serialized byte size of a frame.
 * Uses JSON.stringify length as a conservative estimate.
 * This is O(frame size) but frames are small closed DTOs.
 */
function estimateFrameBytes(frame: ObservationFrame): number {
  return JSON.stringify(frame).length
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRunObservationManager(deps: RunObservationManagerDeps): RunObservationManager & ScopeRefresher {
  const {logger} = deps

  // ---------------------------------------------------------------------------
  // ID generation — per-factory counter so two managers never share sub IDs
  // ---------------------------------------------------------------------------

  let subIdCounter = 0
  function nextSubId(): string {
    subIdCounter++
    return `sub-${subIdCounter}`
  }

  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const maxStreamDurationMs = deps.maxStreamDurationMs ?? DEFAULT_MAX_STREAM_DURATION_MS
  const subscriberQueueCapBytes = deps.subscriberQueueCapBytes ?? DEFAULT_SUBSCRIBER_QUEUE_CAP_BYTES
  const terminalReplayTtlMs = deps.terminalReplayTtlMs ?? DEFAULT_TERMINAL_REPLAY_TTL_MS
  const terminalReplayMaxEntries = deps.terminalReplayMaxEntries ?? DEFAULT_TERMINAL_REPLAY_MAX_ENTRIES
  const terminalReplayMaxBytes = deps.terminalReplayMaxBytes ?? DEFAULT_TERMINAL_REPLAY_MAX_BYTES

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  // Latest projected status per run (one frame per active run).
  // A run that never reaches a terminal status (e.g. because a transition fails after
  // PENDING is observed) leaves its entry here until process restart. A future
  // staleness/reconcile path will evict these entries; for now the leak is bounded
  // by the number of active runs and is cleared on process restart.
  const latestStatusCache = new Map<string, OperatorRunStatus>()

  /**
   * Terminal replay cache: persists the final output frame AND terminal status
   * for a bounded TTL after a run reaches terminal state. Late subscribers
   * connecting within the TTL receive the cached final output then terminal status,
   * then the stream closes gracefully with 'terminal'.
   *
   * Replaces latestOutputCache for the terminal path. Active (non-terminal) runs
   * still use latestOutputCache for the live-subscriber snapshot path.
   */
  const terminalReplayCache = new Map<string, TerminalReplayCacheEntry>()

  /**
   * Latest final output frame per run. Set only when observeOutput is called with
   * final:true AND the run is still active (not yet terminal). Cleared when the
   * run reaches terminal (entry moves to terminalReplayCache) or on shutdown.
   * Delivered to late subscribers on subscribe for active runs.
   */
  const latestOutputCache = new Map<string, OperatorOutputFrame>()

  /**
   * Monotonic seq counter per run for output frames. Incremented on each
   * observeOutput call. Cleared on terminal teardown so a re-used runId starts
   * at seq 0 again.
   */
  const outputSeqCounters = new Map<string, number>()

  /** Active subscribers per run. Map<runId, Map<subId, SubscriberState>>. */
  const runSubscribers = new Map<string, Map<string, SubscriberState>>()

  /** Whether the manager has been shut down. */
  let isShutdown = false

  /**
   * Runs whose terminal observation has begun: set synchronously when a terminal-phase observe() starts,
   * whether or not its projection later succeeds. A non-terminal observation that starts afterwards is
   * discarded, and approval/question frames for the run are dropped. In-flight older observations are
   * cancelled by token instead (see inFlightObservations). Each entry expires after the terminal replay
   * TTL (timer in terminalRunTimers), so the set is bounded by the terminal observations seen per TTL
   * window; replay eviction and shutdown release it earlier.
   */
  const terminalRuns = new Set<string>()
  const terminalRunTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>()

  /** Running total of estimated bytes stored in terminalReplayCache. */
  let terminalReplayCacheBytes = 0

  /**
   * Open (unsettled) question frames per run, replayed to a subscriber that
   * connects mid-question. Map<runId, Map<requestID, frame>>; a Map preserves
   * insertion order, so eviction at the cap drops the oldest. Cleared per
   * request on settle, per run on terminal, and entirely on shutdown.
   */
  const openQuestionFrames = new Map<string, Map<string, QuestionFrame>>()

  /**
   * Per live run: the last base status (overlay not applied) and its repository key. A scope refresh
   * commits only for a run with an entry here. Deleted on the terminal observation, a null projection,
   * a refresh-time denial, and shutdown. Unlike terminalRuns it is not cleared by replay eviction.
   */
  const retainedRuns = new Map<string, {readonly base: OperatorRunStatus; readonly repoKey: RunStatusRepoKey}>()

  /** Scope index: scopeId → run IDs, and the inverse. Empty scopes (pre-ACK Discord runs) are never indexed. */
  const runsByScope = new Map<string, Set<string>>()
  const scopeByRun = new Map<string, string>()

  // ---------------------------------------------------------------------------
  // Internal: scope index and retained state
  // ---------------------------------------------------------------------------

  function unindexRun(runId: string): void {
    const scopeId = scopeByRun.get(runId)
    if (scopeId === undefined) {
      return
    }
    scopeByRun.delete(runId)
    const runIds = runsByScope.get(scopeId)
    if (runIds !== undefined) {
      runIds.delete(runId)
      if (runIds.size === 0) {
        runsByScope.delete(scopeId)
      }
    }
  }

  /** Synchronous: runs before observe's first await, so a gate event during the await finds the run. */
  function indexRunScope(runId: string, scopeId: string): void {
    if (scopeByRun.get(runId) === scopeId) {
      return
    }
    unindexRun(runId)
    if (scopeId === '') {
      return
    }
    scopeByRun.set(runId, scopeId)
    let runIds = runsByScope.get(scopeId)
    if (runIds === undefined) {
      runIds = new Set()
      runsByScope.set(scopeId, runIds)
    }
    runIds.add(runId)
  }

  function dropRunState(runId: string): void {
    retainedRuns.delete(runId)
    unindexRun(runId)
  }

  /** Overlay the live waiting state on a base status. Scope comes from the index; an unindexed run has no overlay. */
  function overlaidStatus(runId: string, base: OperatorRunStatus): OperatorRunStatus {
    const scopeId = scopeByRun.get(runId)
    const status = scopeId === undefined ? base.status : overlayWaitingStatus(base.status, scopeId, deps.waiting)
    const waitReason = overlayWaitReason(status, deps.readWaitReason?.(runId))
    const withStatus = status === base.status ? base : {...base, status}
    return waitReason === undefined ? withStatus : {...withStatus, waitReason}
  }

  /** Cache the status BEFORE fan-out, then fan it out to the run's subscribers. */
  function cacheAndEmit(runId: string, status: OperatorRunStatus): void {
    latestStatusCache.set(runId, status)
    const frame: StatusFrame = {type: 'status', data: status}
    fanOut(runId, frame)
  }

  /** A lifecycle observation always emits, even when the overlaid status equals the cached one. */
  function commitLifecycleStatus(runId: string, base: OperatorRunStatus): void {
    cacheAndEmit(runId, overlaidStatus(runId, base))
  }

  /** A scope refresh emits only when the overlaid status differs from the cached one. */
  function commitRefreshedStatus(runId: string, base: OperatorRunStatus): void {
    const next = overlaidStatus(runId, base)
    const cached = latestStatusCache.get(runId)
    if (cached !== undefined && isDeepStrictEqual(cached, next)) {
      return
    }
    cacheAndEmit(runId, next)
  }

  // ---------------------------------------------------------------------------
  // Internal: terminal replay cache management
  // ---------------------------------------------------------------------------

  /**
   * Estimate the byte cost of a terminal replay cache entry.
   * Accounts for the final output frame (if any) plus a small overhead for the
   * terminal status object.
   */
  function estimateReplayCacheEntryBytes(entry: TerminalReplayCacheEntry): number {
    let bytes = 0
    if (entry.finalOutput !== undefined) {
      const outputFrame: OutputFrame = {type: 'output', data: entry.finalOutput}
      bytes += estimateFrameBytes(outputFrame)
    }
    if (entry.terminalStatus !== undefined) {
      const statusFrame: StatusFrame = {type: 'status', data: entry.terminalStatus}
      bytes += estimateFrameBytes(statusFrame)
    }
    return bytes
  }

  function releaseTerminalFence(runId: string): void {
    const timer = terminalRunTimers.get(runId)
    if (timer !== undefined) {
      deps.clearTimeout(timer)
      terminalRunTimers.delete(runId)
    }
    terminalRuns.delete(runId)
  }

  /**
   * Observation-local cancellation. Each observe() registers a token before its await; a terminal-phase
   * observe cancels the run's tokens already registered. Unlike terminalRuns, a cancelled token never
   * expires, so no timer can revalidate an invalidated observation. Tokens leave in a finally, and a
   * run's set is deleted when empty: memory is bounded by observations in flight.
   */
  interface ObservationToken {
    cancelled: boolean
  }
  const inFlightObservations = new Map<string, Set<ObservationToken>>()

  function registerInFlightObservation(runId: string): ObservationToken {
    const token: ObservationToken = {cancelled: false}
    let tokens = inFlightObservations.get(runId)
    if (tokens === undefined) {
      tokens = new Set()
      inFlightObservations.set(runId, tokens)
    }
    tokens.add(token)
    return token
  }

  function unregisterInFlightObservation(runId: string, token: ObservationToken): void {
    const tokens = inFlightObservations.get(runId)
    if (tokens === undefined) {
      return
    }
    tokens.delete(token)
    if (tokens.size === 0) {
      inFlightObservations.delete(runId)
    }
  }

  function cancelInFlightObservations(runId: string): void {
    for (const token of inFlightObservations.get(runId) ?? []) {
      token.cancelled = true
    }
  }

  /** Fence the run as terminal for one replay TTL; re-fencing restarts the window. */
  function fenceTerminalRun(runId: string): void {
    releaseTerminalFence(runId)
    terminalRuns.add(runId)
    terminalRunTimers.set(
      runId,
      deps.setTimeout(() => {
        terminalRunTimers.delete(runId)
        terminalRuns.delete(runId)
      }, terminalReplayTtlMs),
    )
  }

  function evictTerminalReplayEntry(runId: string): void {
    const entry = terminalReplayCache.get(runId)
    if (entry !== undefined) {
      if (entry.evictionTimer !== undefined) {
        deps.clearTimeout(entry.evictionTimer)
      }
      terminalReplayCache.delete(runId)
      // Keep byte accounting in sync with the evicted entry
      terminalReplayCacheBytes = Math.max(0, terminalReplayCacheBytes - estimateReplayCacheEntryBytes(entry))
      // Belt-and-suspenders: clear the seq counter so a re-used runId starts fresh
      outputSeqCounters.delete(runId)
      // Clear the terminal guard so a re-used runId is not permanently blocked
      releaseTerminalFence(runId)
    }
  }

  function enforceTerminalReplayCap(): void {
    // Enforce entry-count cap: evict oldest entries until within the limit
    if (terminalReplayCache.size > terminalReplayMaxEntries) {
      const toEvict = terminalReplayCache.size - terminalReplayMaxEntries
      let evicted = 0
      for (const [runId] of terminalReplayCache) {
        if (evicted >= toEvict) {
          break
        }
        // evictTerminalReplayEntry handles byte accounting, seq counter, and terminalRuns cleanup
        evictTerminalReplayEntry(runId)
        evicted++
      }
    }

    // Enforce byte budget: evict oldest entries until total bytes are within budget
    while (terminalReplayCacheBytes > terminalReplayMaxBytes && terminalReplayCache.size > 0) {
      const firstRunId = terminalReplayCache.keys().next().value
      if (firstRunId === undefined) {
        break
      }
      evictTerminalReplayEntry(firstRunId)
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: finalize a subscriber in graceful-terminal-drain mode
  // ---------------------------------------------------------------------------

  function finalizeTerminalSubscriber(sub: SubscriberState): void {
    if (sub.dropped === true) {
      return
    }
    sub.dropped = true

    // Clear timers
    if (sub.heartbeatTimer !== undefined) {
      deps.clearInterval(sub.heartbeatTimer)
      sub.heartbeatTimer = undefined
    }
    if (sub.maxDurationTimer !== undefined) {
      deps.clearTimeout(sub.maxDurationTimer)
      sub.maxDurationTimer = undefined
    }

    // Remove from the run's subscriber set
    const subs = runSubscribers.get(sub.runId)
    if (subs !== undefined) {
      subs.delete(sub.id)
      if (subs.size === 0) {
        runSubscribers.delete(sub.runId)
      }
    }

    // Schedule onClose via queueMicrotask so a slow or synchronous onClose callback
    // cannot block observe() from returning.
    queueMicrotask(() => {
      try {
        sub.callbacks.onClose('terminal')
      } catch (error) {
        logger.warn({subId: sub.id, runId: sub.runId, err: String(error)}, 'manager: onClose threw — ignoring')
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Internal: drop a subscriber (overflow, error, close, shutdown)
  // ---------------------------------------------------------------------------

  function dropSubscriber(sub: SubscriberState, reason: string): void {
    if (sub.dropped === true) {
      return
    }
    sub.dropped = true

    // Clear timers
    if (sub.heartbeatTimer !== undefined) {
      deps.clearInterval(sub.heartbeatTimer)
      sub.heartbeatTimer = undefined
    }
    if (sub.maxDurationTimer !== undefined) {
      deps.clearTimeout(sub.maxDurationTimer)
      sub.maxDurationTimer = undefined
    }

    // Clear queue (hard abort — discard in-flight frames)
    sub.queue.length = 0
    sub.queueBytes = 0

    // Remove from the run's subscriber set
    const subs = runSubscribers.get(sub.runId)
    if (subs !== undefined) {
      subs.delete(sub.id)
      if (subs.size === 0) {
        runSubscribers.delete(sub.runId)
      }
    }

    // Schedule onClose via queueMicrotask so a slow or synchronous onClose callback
    // cannot block observe() from returning. The terminal-status path calls dropSubscriber
    // synchronously inside observe(); without this deferral, a slow onClose would hold
    // the observe() promise open until onClose completes.
    queueMicrotask(() => {
      try {
        sub.callbacks.onClose(reason)
      } catch (error) {
        logger.warn({subId: sub.id, runId: sub.runId, err: String(error)}, 'manager: onClose threw — ignoring')
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Internal: enqueue a frame to a subscriber (strictly non-blocking)
  // ---------------------------------------------------------------------------

  /**
   * Enqueue a frame to a subscriber's queue.
   * If the queue would exceed the cap, drop the subscriber locally (overflow).
   * NEVER awaits the writer task — strictly non-blocking.
   * Returns true if enqueued, false if the subscriber was dropped.
   */
  function enqueueFrame(sub: SubscriberState, frame: ObservationFrame): boolean {
    if (sub.dropped === true) {
      return false
    }
    // In graceful-terminal-drain mode, do not accept new frames (except the
    // terminal status frame itself, which was already enqueued before this mode
    // was set). Heartbeats and other frames are silently dropped.
    if (sub.closingReason === 'terminal') {
      return false
    }

    const frameBytes = estimateFrameBytes(frame)
    if (sub.queueBytes + frameBytes > subscriberQueueCapBytes) {
      // Overflow: drop the subscriber locally
      logger.warn(
        {subId: sub.id, runId: sub.runId, queueBytes: sub.queueBytes, frameBytes},
        'manager: subscriber queue overflow — dropping subscriber',
      )
      dropSubscriber(sub, 'overflow')
      return false
    }

    sub.queue.push(frame)
    sub.queueBytes += frameBytes

    // Start the writer task if not already running
    if (sub.writerRunning === false) {
      sub.writerRunning = true
      // Fire-and-forget: the writer task drains the queue asynchronously.
      // Never awaited — a slow or erroring drain must not stall the publisher.
      drainQueue(sub).catch(() => {})
    }

    return true
  }

  // ---------------------------------------------------------------------------
  // Internal: async writer task — drains the queue to onEvent
  // ---------------------------------------------------------------------------

  async function drainQueue(sub: SubscriberState): Promise<void> {
    while (sub.queue.length > 0) {
      // Dequeue BEFORE the await so the writer owns the frame.
      // Coalescing (enqueueOutputFrame) splices the queue during the await;
      // dequeue-before-await means the in-flight frame is no longer in the queue
      // so coalescing cannot touch it. queueBytes is decremented on dequeue.
      const frame = sub.queue.shift()
      if (frame === undefined) {
        break
      }
      sub.queueBytes = Math.max(0, sub.queueBytes - estimateFrameBytes(frame))

      try {
        await sub.callbacks.onEvent(frame)
      } catch (error) {
        // Writer failure: contain the error, drop the subscriber.
        // Reset writerRunning before returning so the invariant holds even though
        // dropSubscriber does not clear it (it only clears timers and the queue).
        sub.writerRunning = false
        logger.warn(
          {subId: sub.id, runId: sub.runId, err: String(error)},
          'manager: onEvent threw — dropping subscriber',
        )
        dropSubscriber(sub, 'writer-error')
        return
      }

      // Re-check dropped: dropSubscriber may have been called from another path
      // (e.g., heartbeat timer) while onEvent was awaited.
      if (sub.dropped === true) {
        sub.writerRunning = false
        return
      }

      // Graceful terminal drain — when the queue is empty and closingReason
      // is 'terminal', finalize the subscriber (remove from runSubscribers, clear
      // timers, call onClose('terminal')). This delivers all already-queued frames
      // (including the terminal status) before closing.
      if (sub.queue.length === 0 && sub.closingReason === 'terminal') {
        sub.writerRunning = false
        finalizeTerminalSubscriber(sub)
        return
      }
    }

    sub.writerRunning = false

    // Final check after the loop: if we exited because queue is empty and
    // closingReason is 'terminal', finalize now (handles the case where the
    // queue was empty when we entered the loop).
    if (sub.dropped === false && sub.closingReason === 'terminal') {
      finalizeTerminalSubscriber(sub)
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: create a subscriber with heartbeat + max-duration timers
  // ---------------------------------------------------------------------------

  function createSubscriber(runId: string, callbacks: SubscriberCallbacks): SubscriberState {
    const id = nextSubId()
    const sub: SubscriberState = {
      id,
      runId,
      callbacks,
      queue: [],
      queueBytes: 0,
      writerRunning: false,
      dropped: false,
      heartbeatTimer: undefined,
      maxDurationTimer: undefined,
      coalescedDropCount: 0,
      closingReason: undefined,
    }

    // Heartbeat timer: emit a heartbeat frame every heartbeatIntervalMs
    sub.heartbeatTimer = deps.setInterval(() => {
      if (sub.dropped === true) {
        return
      }
      // Do not enqueue heartbeats during graceful terminal drain
      if (sub.closingReason === 'terminal') {
        return
      }
      const heartbeat: HeartbeatFrame = {type: 'heartbeat'}
      enqueueFrame(sub, heartbeat)
    }, heartbeatIntervalMs)

    // Max-duration timer: close the subscriber after maxStreamDurationMs
    sub.maxDurationTimer = deps.setTimeout(() => {
      if (sub.dropped === true) {
        return
      }
      logger.info({subId: id, runId}, 'manager: subscriber reached max stream duration — closing')
      dropSubscriber(sub, 'max-duration')
    }, maxStreamDurationMs)

    return sub
  }

  // ---------------------------------------------------------------------------
  // Internal: fan-out a frame to all subscribers of a run
  // ---------------------------------------------------------------------------

  /**
   * Fan out a frame to all current subscribers of a run.
   * Iterates over a SNAPSHOT of the subscriber set so mid-fan-out removal
   * cannot corrupt the iteration.
   * NEVER awaits any subscriber write — strictly non-blocking.
   */
  function fanOut(runId: string, frame: ObservationFrame): void {
    const subs = runSubscribers.get(runId)
    if (subs === undefined || subs.size === 0) {
      return
    }

    // Snapshot the subscriber set before iterating
    const snapshot = Array.from(subs.values())
    for (const sub of snapshot) {
      enqueueFrame(sub, frame)
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: enqueue an output frame with coalescing on overflow
  // ---------------------------------------------------------------------------

  /**
   * Enqueue an output frame to a subscriber with coalescing on overflow.
   *
   * Unlike status frames (which drop the subscriber on overflow), output frames
   * coalesce: when the queue would overflow, pending output frames in the queue
   * are removed and their count is accumulated in sub.coalescedDropCount. The
   * next successfully-enqueued output frame carries that count as droppedCount,
   * keeping the connection alive.
   *
   * Returns true if the frame was enqueued (possibly after coalescing), false if
   * the subscriber was already dropped.
   */
  function enqueueOutputFrame(sub: SubscriberState, frame: OutputFrame): boolean {
    if (sub.dropped === true) {
      return false
    }
    // In graceful-terminal-drain mode, do not accept new output frames
    if (sub.closingReason === 'terminal') {
      return false
    }

    // Build the effective frame BEFORE the cap check so the byte measurement used
    // for the cap comparison is the same value added to queueBytes on enqueue.
    // Without this, the cap check uses frameBytes but queueBytes grows by effectiveBytes
    // (which is larger when coalescedDropCount > 0), causing queueBytes to drift above
    // the cap and triggering spurious coalescing on frames that actually fit.
    const effectiveFrame: OutputFrame =
      sub.coalescedDropCount > 0
        ? {
            type: 'output',
            data: {...frame.data, droppedCount: (frame.data.droppedCount ?? 0) + sub.coalescedDropCount},
          }
        : frame
    const effectiveBytes = estimateFrameBytes(effectiveFrame)

    // If the effective frame fits, enqueue it directly
    if (sub.queueBytes + effectiveBytes <= subscriberQueueCapBytes) {
      sub.coalescedDropCount = 0

      sub.queue.push(effectiveFrame)
      sub.queueBytes += effectiveBytes

      if (sub.writerRunning === false) {
        sub.writerRunning = true
        drainQueue(sub).catch(() => {})
      }
      return true
    }

    // Overflow: coalesce — remove pending output frames from the queue to make room,
    // accumulating their count. Keep non-output frames (status, reset, heartbeat) intact.
    let removedCount = 0
    let removedBytes = 0
    for (let i = sub.queue.length - 1; i >= 0; i--) {
      const queued = sub.queue[i]
      if (queued !== undefined && queued.type === 'output') {
        removedBytes += estimateFrameBytes(queued)
        sub.queue.splice(i, 1)
        removedCount++
      }
    }
    sub.queueBytes = Math.max(0, sub.queueBytes - removedBytes)
    sub.coalescedDropCount += removedCount

    // Rebuild the effective frame after coalescing (coalescedDropCount has grown)
    const effectiveFrameAfterCoalesce: OutputFrame =
      sub.coalescedDropCount > 0
        ? {
            type: 'output',
            data: {...frame.data, droppedCount: (frame.data.droppedCount ?? 0) + sub.coalescedDropCount},
          }
        : frame
    const effectiveBytesAfterCoalesce = estimateFrameBytes(effectiveFrameAfterCoalesce)

    // Try again after coalescing — use the post-coalesce effective bytes for both
    // the cap check and the queueBytes increment so accounting stays accurate.
    if (sub.queueBytes + effectiveBytesAfterCoalesce <= subscriberQueueCapBytes) {
      sub.coalescedDropCount = 0

      sub.queue.push(effectiveFrameAfterCoalesce)
      sub.queueBytes += effectiveBytesAfterCoalesce

      logger.warn(
        {subId: sub.id, runId: sub.runId, removedCount, queueBytes: sub.queueBytes},
        'manager: output frame coalesced — dropped pending output frames to keep connection alive',
      )

      if (sub.writerRunning === false) {
        sub.writerRunning = true
        drainQueue(sub).catch(() => {})
      }
      return true
    }

    // Even after coalescing all output frames, the new frame still doesn't fit.
    // Accumulate the drop count and discard this frame too (connection stays alive).
    sub.coalescedDropCount++
    logger.warn(
      {subId: sub.id, runId: sub.runId, coalescedDropCount: sub.coalescedDropCount},
      'manager: output frame discarded after coalescing — queue still full, accumulating droppedCount',
    )
    return false
  }

  // ---------------------------------------------------------------------------
  // Internal: fan-out an output frame to all subscribers of a run (with coalescing)
  // ---------------------------------------------------------------------------

  function fanOutOutput(runId: string, frame: OutputFrame): void {
    const subs = runSubscribers.get(runId)
    if (subs === undefined || subs.size === 0) {
      return
    }

    // Snapshot the subscriber set before iterating
    const snapshot = Array.from(subs.values())
    for (const sub of snapshot) {
      enqueueOutputFrame(sub, frame)
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: mark all subscribers of a run for graceful terminal drain
  // ---------------------------------------------------------------------------

  /**
   * Mark one subscriber for graceful terminal drain (see markRunSubscribersForTerminalDrain).
   * No-op for a subscriber that is already dropped.
   */
  function markSubscriberForTerminalDrain(sub: SubscriberState): void {
    if (sub.dropped === true) {
      return
    }
    sub.closingReason = 'terminal'

    // Cancel the maxDuration and heartbeat timers now that we are in graceful-drain
    // mode. Without this, a maxDuration timer firing during the drain window would
    // call dropSubscriber('max-duration'), clearing the queue and reporting the wrong
    // close reason. The heartbeat callback already early-returns on closingReason===
    // 'terminal', but cancelling it here is cleaner and avoids the macrotask entirely.
    if (sub.maxDurationTimer !== undefined) {
      deps.clearTimeout(sub.maxDurationTimer)
      sub.maxDurationTimer = undefined
    }
    if (sub.heartbeatTimer !== undefined) {
      deps.clearInterval(sub.heartbeatTimer)
      sub.heartbeatTimer = undefined
    }

    // Drain-state invariant:
    //   writer running           → drainQueue finalizes once the in-flight write settles
    //                              and the queue is empty. An EMPTY queue does not mean
    //                              "nothing left to deliver": drainQueue dequeues a frame
    //                              BEFORE awaiting onEvent, so the frame being written is
    //                              in neither the queue nor yet delivered.
    //   writer idle, queue empty → finalize immediately (nothing to deliver)
    //   writer idle, queue non-empty → start the drain so queued frames are delivered
    //                                  and finalize is called
    startOrFinalizeTerminalDrain(sub)
  }

  /**
   * Apply the terminal drain-state invariant to a subscriber already marked
   * `closingReason = 'terminal'`. Immediate finalization requires BOTH an empty queue AND
   * no active writer; otherwise the active writer (or the drain started here) finalizes
   * after the last delivery settles, so `onClose('terminal')` never overtakes a frame.
   */
  function startOrFinalizeTerminalDrain(sub: SubscriberState): void {
    if (sub.writerRunning === true) {
      return
    }
    if (sub.queue.length === 0) {
      finalizeTerminalSubscriber(sub)
      return
    }
    sub.writerRunning = true
    drainQueue(sub).catch(() => {})
  }

  /**
   * Mark all subscribers of a run for graceful terminal drain.
   *
   * Unlike closeRunSubscribers (hard abort), this path:
   * 1. Sets closingReason = 'terminal' (stops accepting new frames, stops heartbeats).
   * 2. Does NOT clear the queue — drainQueue delivers all already-queued frames.
   * 3. Does NOT set dropped = true — drainQueue's completion path finalizes.
   * 4. If the queue is already empty (writerRunning === false), finalizes immediately.
   *
   * This guarantees the terminal status frame (already enqueued via fanOut before
   * this is called) is delivered before the subscriber is closed.
   */
  function markRunSubscribersForTerminalDrain(runId: string): void {
    const subs = runSubscribers.get(runId)
    if (subs === undefined || subs.size === 0) {
      return
    }

    // Snapshot before iterating (finalization modifies the map)
    const snapshot = Array.from(subs.values())
    for (const sub of snapshot) {
      markSubscriberForTerminalDrain(sub)
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: close all subscribers of a run with a given reason (hard abort)
  // ---------------------------------------------------------------------------

  function closeRunSubscribers(runId: string, reason: string): void {
    const subs = runSubscribers.get(runId)
    if (subs === undefined || subs.size === 0) {
      return
    }

    // Snapshot before iterating (dropSubscriber modifies the map)
    const snapshot = Array.from(subs.values())
    for (const sub of snapshot) {
      dropSubscriber(sub, reason)
    }
  }

  // ---------------------------------------------------------------------------
  // observe
  // ---------------------------------------------------------------------------

  /** Read through a call: shutdown() can flip the flag across an await, which TS cannot see. */
  function isShutDownNow(): boolean {
    return isShutdown
  }

  const observe = async (runState: RunState): Promise<void> => {
    if (isShutdown === true) {
      return
    }

    const runId = runState.run_id

    // Index the scope before the first await: a request that opens during the projection await
    // must find this run, and a run adopting its thread must re-key at once.
    indexRunScope(runId, scopeIdFor(runState))

    // A terminal observation cancels every older in-flight observation of the run, and fences later
    // arrivals, whether or not its own projection succeeds. Both happen before the await; no terminal
    // status is fabricated.
    const isTerminalPhase = TERMINAL_PHASES.has(runState.phase)
    if (isTerminalPhase === true) {
      cancelInFlightObservations(runId)
      fenceTerminalRun(runId)
    }

    const token = registerInFlightObservation(runId)
    try {
      await applyObservation(runState, token, isTerminalPhase)
    } finally {
      unregisterInFlightObservation(runId, token)
    }
  }

  async function applyObservation(
    runState: RunState,
    token: ObservationToken,
    isTerminalPhase: boolean,
  ): Promise<void> {
    const runId = runState.run_id

    // Project the base status — `denied` for a denied/keyless repo, `unavailable` when the binding store failed
    let projection: RunStatusProjection
    try {
      projection = await deps.projectBase(runState)
    } catch (error) {
      logger.warn({runId, err: String(error)}, 'manager: projectBase threw — dropping observation')
      if (isTerminalPhase === true) {
        dropRunState(runId)
      }
      return
    }

    // A shutdown during the await must not repopulate the caches it just cleared.
    if (isShutDownNow() === true) {
      return
    }

    // Denied/keyless repo: drop immediately, no cache, no emit; later gate events skip the run
    if (projection.kind === 'denied') {
      dropRunState(runId)
      return
    }

    // Store error: the repository is unknown, not denied. Keep the last good state so a later request
    // still refreshes the run; emit and cache nothing for this observation. A terminal run has no
    // later lifecycle observation to release that state, so it is released here.
    if (projection.kind === 'unavailable') {
      logger.warn({runId}, 'manager: binding store unavailable — observation not applied')
      if (isTerminalPhase === true) {
        dropRunState(runId)
      }
      return
    }

    const observed = projection.status

    // A terminal observation began while this one was in flight: discard a non-terminal result, however
    // long ago the terminal fence expired.
    if (isTerminal(observed.status) === false && token.cancelled === true) {
      logger.warn(
        {runId, status: observed.status},
        'manager: observation cancelled by a terminal observation — dropping',
      )
      dropRunState(runId)
      return
    }

    // Guard against stale non-terminal observations arriving out of causal order.
    // If two concurrent observe() calls resolve out of order (COMPLETED resolves first,
    // then EXECUTING resolves), the non-terminal path must not overwrite the terminal
    // replay entry or regress the cached status.
    if (isTerminal(observed.status) === false && terminalRuns.has(runId) === true) {
      logger.warn(
        {runId, status: observed.status},
        'manager: non-terminal observe arrived after terminal — dropping stale observation',
      )
      dropRunState(runId)
      return
    }

    // On a non-terminal status, clear any stale terminal replay cache entry for this
    // runId (avoids stale replay if runId is reused after a previous terminal run).
    // Only reached when terminalRuns does NOT contain this runId (guard above).
    if (isTerminal(observed.status) === false) {
      evictTerminalReplayEntry(runId)

      // Retain the base, then overlay the registries as they stand now (not as they stood before the
      // await). The cache is updated BEFORE fan-out.
      retainedRuns.set(runId, {base: observed, repoKey: projection.repoKey})
      commitLifecycleStatus(runId, observed)
      return
    }

    // Build the status frame (closed DTO — only the contract fields)
    // The projection already returns a closed OperatorRunStatus; we wrap it in a frame.
    const frame: StatusFrame = {type: 'status', data: observed}

    // Update the latest-status cache BEFORE fan-out
    latestStatusCache.set(runId, observed)

    // Fan out to all current subscribers (non-blocking — never awaits writes)
    fanOut(runId, frame)

    // Terminal: the run no longer has a base to overlay, and no scope to refresh.
    dropRunState(runId)

    // Transition to graceful drain instead of hard abort.
    // markRunSubscribersForTerminalDrain does NOT clear queues — it lets
    // drainQueue deliver all already-queued frames (including the terminal status
    // frame just enqueued above) before finalizing the subscriber.
    latestStatusCache.delete(runId)
    outputSeqCounters.delete(runId)
    // A terminal run has no pending question; late subscribers get the terminal replay only.
    openQuestionFrames.delete(runId)

    // Move final output to terminal replay cache (with TTL) instead of
    // deleting it. Late subscribers connecting within the TTL receive the cached
    // final output then terminal status, then the stream closes gracefully.
    const finalOutput = latestOutputCache.get(runId)
    latestOutputCache.delete(runId)

    // Evict any existing entry for this runId before creating a new one
    evictTerminalReplayEntry(runId)

    // Restart the terminal fence so it spans the replay entry's lifetime
    fenceTerminalRun(runId)

    const expiresAt = deps.now() + terminalReplayTtlMs
    // Use evictTerminalReplayEntry in the TTL callback so byte accounting,
    // seq counter, and terminalRuns are all cleaned up on natural expiry.
    const evictionTimer = deps.setTimeout(() => {
      evictTerminalReplayEntry(runId)
    }, terminalReplayTtlMs)

    const newEntry: TerminalReplayCacheEntry = {
      finalOutput,
      terminalStatus: observed,
      expiresAt,
      evictionTimer,
    }
    terminalReplayCache.set(runId, newEntry)
    // Track the byte cost of this new entry for the byte-budget cap
    terminalReplayCacheBytes += estimateReplayCacheEntryBytes(newEntry)

    // Enforce both the entry-count cap and the byte budget
    enforceTerminalReplayCap()

    // Graceful drain: deliver all queued frames (including terminal status) then close
    markRunSubscribersForTerminalDrain(runId)
  }

  // ---------------------------------------------------------------------------
  // refreshScope
  // ---------------------------------------------------------------------------

  const refreshRetainedRun = (runId: string): void => {
    const retained = retainedRuns.get(runId)
    if (retained === undefined) {
      return
    }
    try {
      // The denylist is TTL-cached, so a repository can be denied while its run is live. Check
      // before the overlay so a newly denied run emits nothing and is not refreshed again.
      if (deps.isRepoDenied(retained.repoKey) === true) {
        dropRunState(runId)
        return
      }
      commitRefreshedStatus(runId, retained.base)
    } catch (error) {
      logger.warn({runId, err: String(error)}, 'manager: scope refresh threw — skipping run')
    }
  }

  const refreshScope = (scopeId: string): void => {
    if (isShutdown === true) {
      return
    }
    const runIds = runsByScope.get(scopeId)
    if (runIds === undefined) {
      return
    }

    for (const runId of Array.from(runIds)) {
      refreshRetainedRun(runId)
    }
  }

  const refreshRun = (runId: string): void => {
    if (isShutdown === true) {
      return
    }
    refreshRetainedRun(runId)
  }

  // ---------------------------------------------------------------------------
  // observeOutput
  // ---------------------------------------------------------------------------

  const observeOutput = (runId: string, text: string, opts?: {final?: boolean; droppedCount?: number}): void => {
    if (isShutdown === true) {
      return
    }

    // If the run has already reached terminal (replay cache entry exists), drop
    // any further output observations — the run is done.
    if (terminalReplayCache.has(runId) === true) {
      logger.warn({runId}, 'manager: observeOutput called after terminal — dropping')
      return
    }

    // Increment the per-run seq counter
    const seq = outputSeqCounters.get(runId) ?? 0
    outputSeqCounters.set(runId, seq + 1)

    const isFinal = opts?.final ?? false

    const outputData: OperatorOutputFrame = {
      runId,
      text,
      final: isFinal,
      seq,
      ...(opts?.droppedCount === undefined ? {} : {droppedCount: opts.droppedCount}),
    }

    const frame: OutputFrame = {type: 'output', data: outputData}

    // Cache the final frame for late subscribers (active run path)
    if (isFinal === true) {
      latestOutputCache.set(runId, outputData)
    }

    // Fan out to all current subscribers with coalescing on overflow
    fanOutOutput(runId, frame)
  }

  // ---------------------------------------------------------------------------
  // observeApproval
  // ---------------------------------------------------------------------------

  const observeApproval = (runId: string, data: ApprovalFrameData): void => {
    if (isShutdown === true) {
      return
    }

    // Out-of-order async guard: if the run has already reached terminal state,
    // drop any further approval observations — a stale approval frame must not
    // arrive after the terminal status has committed the replay cache entry.
    if (terminalRuns.has(runId) === true) {
      logger.warn({runId}, 'manager: observeApproval called after terminal — dropping')
      return
    }

    const frame: ApprovalFrame = {type: 'approval', runId, data}

    // Fan out via the non-coalescing path — approval frames are rare and must
    // arrive intact. Overflow drops the subscriber (same as status frames),
    // not the frame (unlike output frames which coalesce).
    fanOut(runId, frame)
  }

  // ---------------------------------------------------------------------------
  // observeQuestion
  // ---------------------------------------------------------------------------

  const observeQuestion = (runId: string, data: QuestionFrameData): void => {
    if (isShutdown === true) {
      return
    }

    // Out-of-order async guard, as for approvals: a question frame must not
    // arrive after the terminal status has committed the replay cache entry.
    if (terminalRuns.has(runId) === true) {
      logger.warn({runId, requestID: data.requestID}, 'manager: observeQuestion called after terminal — dropping')
      return
    }

    // Pin the fan-out key: the frame's runId is the one the manager routed by.
    const frame: QuestionFrame = {type: 'question', runId, data: {...data, runId}}

    if (data.settled === true) {
      // A settled question must never reappear on reconnect.
      const open = openQuestionFrames.get(runId)
      if (open !== undefined) {
        open.delete(data.requestID)
        if (open.size === 0) {
          openQuestionFrames.delete(runId)
        }
      }
      fanOut(runId, frame)
      return
    }

    // An open frame that cannot fit a healthy subscriber queue would drop the
    // subscriber on every delivery and every reconnect. Skip it instead; the
    // registry entry, the pending listing, and the deadline are unaffected.
    const frameBytes = estimateFrameBytes(frame)
    if (frameBytes > subscriberQueueCapBytes / 2) {
      logger.warn(
        {runId, requestID: data.requestID, frameBytes, reason: 'frame-too-large'},
        'manager: observeQuestion open frame too large — not delivered',
      )
      return
    }

    let open = openQuestionFrames.get(runId)
    if (open === undefined) {
      open = new Map()
      openQuestionFrames.set(runId, open)
    }
    // Re-observing an id keeps one entry at the newest position.
    open.delete(data.requestID)
    open.set(data.requestID, frame)
    if (open.size > MAX_OPEN_QUESTION_REPLAY_PER_RUN) {
      const oldest = open.keys().next().value
      if (oldest !== undefined) {
        open.delete(oldest)
      }
    }

    // Non-coalescing path: overflow drops the subscriber, never the frame.
    fanOut(runId, frame)
  }

  // ---------------------------------------------------------------------------
  // Durable cache-miss resolution
  // ---------------------------------------------------------------------------

  /**
   * True while the subscriber is still on the undecided live path: not dropped or draining,
   * the manager is up, and no live observation has landed a snapshot for the run since the
   * cache miss. Re-checked after every await so a live terminal that wins the race — which
   * drains this subscriber through the ordinary fan-out — is never duplicated or overridden.
   */
  function isAwaitingLiveResolution(sub: SubscriberState): boolean {
    return (
      isShutdown === false &&
      sub.dropped === false &&
      sub.closingReason === undefined &&
      latestStatusCache.has(sub.runId) === false
    )
  }

  /**
   * Resolve a subscribe-time cache miss from persisted run state.
   *
   * Only a terminal persisted state is acted on: it is projected through the same deny-gated
   * projection as live observations, enqueued as the terminal status frame, and the subscriber
   * is drained and closed with `terminal`. Everything else (non-terminal, missing, mismatched,
   * denied/null projection, read failure) leaves the subscriber on the live path,
   * identical to a manager with no durable read. Nothing is written to a shared cache, so a
   * live terminal arriving later still builds its own replay entry (with final output) intact.
   */
  async function resolveCacheMissFromDurableState(
    sub: SubscriberState,
    read: () => Promise<RunState | undefined>,
  ): Promise<void> {
    const runId = sub.runId

    let runState: RunState | undefined
    try {
      runState = await read()
    } catch (error) {
      logger.warn({subId: sub.id, runId, err: String(error)}, 'manager: durable run-state read failed — staying live')
      return
    }
    if (runState === undefined || runState.run_id !== runId || TERMINAL_PHASES.has(runState.phase) === false) {
      return
    }
    if (isAwaitingLiveResolution(sub) === false) {
      return
    }

    let projection: RunStatusProjection
    try {
      projection = await deps.projectBase(runState)
    } catch (error) {
      logger.warn(
        {subId: sub.id, runId, err: String(error)},
        'manager: projectBase threw for durable state — staying live',
      )
      return
    }
    // A denied/keyless repo or an unreadable binding reveals nothing: no frame, no close.
    // A terminal status carries no waiting overlay, so the base is the final status.
    if (projection.kind !== 'projected' || isTerminal(projection.status.status) === false) {
      return
    }
    const projected = projection.status
    if (isAwaitingLiveResolution(sub) === false) {
      return
    }

    const statusFrame: StatusFrame = {type: 'status', data: projected}
    enqueueFrame(sub, statusFrame)
    markSubscriberForTerminalDrain(sub)
  }

  // ---------------------------------------------------------------------------
  // subscribe
  // ---------------------------------------------------------------------------

  const subscribe = (runId: string, callbacks: SubscriberCallbacks, options?: SubscribeOptions): (() => void) => {
    if (isShutdown === true) {
      // Manager is shut down — immediately close
      try {
        callbacks.onClose('shutdown')
      } catch {
        // ignore
      }
      return () => {
        // no-op
      }
    }

    // Check terminal replay cache first. If the run has already terminated,
    // replay the final output and terminal status, then close gracefully.
    const replayEntry = terminalReplayCache.get(runId)
    if (replayEntry !== undefined) {
      // Create a subscriber for the replay path (with timers, so cleanup is consistent)
      const sub = createSubscriber(runId, callbacks)

      // Register in the run's subscriber set
      let subs = runSubscribers.get(runId)
      if (subs === undefined) {
        subs = new Map()
        runSubscribers.set(runId, subs)
      }
      subs.set(sub.id, sub)

      // Enqueue: final output (if any) then terminal status, then mark for terminal drain
      if (replayEntry.finalOutput !== undefined) {
        const outputFrame: OutputFrame = {type: 'output', data: replayEntry.finalOutput}
        enqueueOutputFrame(sub, outputFrame)
      }
      if (replayEntry.terminalStatus !== undefined) {
        const statusFrame: StatusFrame = {type: 'status', data: replayEntry.terminalStatus}
        enqueueFrame(sub, statusFrame)
      }

      // Mark for graceful terminal drain — delivers queued frames then closes with 'terminal'.
      sub.closingReason = 'terminal'
      startOrFinalizeTerminalDrain(sub)

      // Return a clean-disconnect function
      return () => {
        if (sub.dropped === true) {
          return
        }
        sub.dropped = true
        if (sub.heartbeatTimer !== undefined) {
          deps.clearInterval(sub.heartbeatTimer)
          sub.heartbeatTimer = undefined
        }
        if (sub.maxDurationTimer !== undefined) {
          deps.clearTimeout(sub.maxDurationTimer)
          sub.maxDurationTimer = undefined
        }
        sub.queue.length = 0
        sub.queueBytes = 0
        const runSubs = runSubscribers.get(runId)
        if (runSubs !== undefined) {
          runSubs.delete(sub.id)
          if (runSubs.size === 0) {
            runSubscribers.delete(runId)
          }
        }
      }
    }

    // Create the subscriber with heartbeat + max-duration timers
    const sub = createSubscriber(runId, callbacks)

    // Register in the run's subscriber set
    let subs = runSubscribers.get(runId)
    if (subs === undefined) {
      subs = new Map()
      runSubscribers.set(runId, subs)
    }
    subs.set(sub.id, sub)

    // Snapshot-on-subscribe: deliver the latest cached status immediately,
    // or emit a reset frame if no snapshot exists.
    const cached = latestStatusCache.get(runId)
    if (cached === undefined) {
      const resetFrame: ResetFrame = {type: 'reset', runId, reason: 'no-snapshot'}
      enqueueFrame(sub, resetFrame)
    } else {
      const snapshotFrame: StatusFrame = {type: 'status', data: cached}
      enqueueFrame(sub, snapshotFrame)
    }

    // Reconnect reconciliation: deliver every still-open question after the
    // status snapshot so the browser can re-render the prompt. Settled
    // questions were removed from the set when they settled.
    const openQuestions = openQuestionFrames.get(runId)
    if (openQuestions !== undefined) {
      for (const questionFrame of openQuestions.values()) {
        enqueueFrame(sub, questionFrame)
      }
    }

    // Deliver the cached final output frame (if any) after the status snapshot.
    // This ensures a late subscriber (connecting after the run's final output frame
    // but before terminal) receives the complete answer.
    // Order: status/reset first, then cached output.
    const cachedOutput = latestOutputCache.get(runId)
    if (cachedOutput !== undefined) {
      const outputFrame: OutputFrame = {type: 'output', data: cachedOutput}
      enqueueOutputFrame(sub, outputFrame)
    }

    // Cache miss with a durable seam: the run may be terminal with its replay entry evicted
    // (TTL/caps) or lost to a restart. Resolve from persisted state in the background; the
    // reset frame above is already queued, so a live run sees exactly the frames it always did.
    if (cached === undefined && options?.readDurableRunState !== undefined) {
      resolveCacheMissFromDurableState(sub, options.readDurableRunState).catch((error: unknown) => {
        logger.warn({subId: sub.id, runId, err: String(error)}, 'manager: durable cache-miss resolution failed')
      })
    }

    // Return a clean-disconnect function (no onClose called)
    return () => {
      if (sub.dropped === true) {
        return
      }
      // Clean disconnect: remove timers/queue but do NOT call onClose
      sub.dropped = true

      if (sub.heartbeatTimer !== undefined) {
        deps.clearInterval(sub.heartbeatTimer)
        sub.heartbeatTimer = undefined
      }
      if (sub.maxDurationTimer !== undefined) {
        deps.clearTimeout(sub.maxDurationTimer)
        sub.maxDurationTimer = undefined
      }

      sub.queue.length = 0
      sub.queueBytes = 0

      const runSubs = runSubscribers.get(runId)
      if (runSubs !== undefined) {
        runSubs.delete(sub.id)
        if (runSubs.size === 0) {
          runSubscribers.delete(runId)
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // abortSubscription
  // ---------------------------------------------------------------------------

  const abortSubscription = (runId: string, reason: string): void => {
    closeRunSubscribers(runId, reason)
  }

  // ---------------------------------------------------------------------------
  // shutdown
  // ---------------------------------------------------------------------------

  const shutdown = (): void => {
    if (isShutdown === true) {
      return
    }
    isShutdown = true

    // Close all subscriptions across all runs
    const allRunIds = Array.from(runSubscribers.keys())
    for (const runId of allRunIds) {
      closeRunSubscribers(runId, 'shutdown')
    }

    // Clear all caches
    latestStatusCache.clear()
    latestOutputCache.clear()
    outputSeqCounters.clear()
    openQuestionFrames.clear()
    retainedRuns.clear()
    runsByScope.clear()
    scopeByRun.clear()

    // Clear terminal replay cache (cancel all eviction timers)
    for (const entry of terminalReplayCache.values()) {
      if (entry.evictionTimer !== undefined) {
        deps.clearTimeout(entry.evictionTimer)
      }
    }
    terminalReplayCache.clear()
    terminalReplayCacheBytes = 0
    for (const timer of terminalRunTimers.values()) {
      deps.clearTimeout(timer)
    }
    terminalRunTimers.clear()
    terminalRuns.clear()
    inFlightObservations.clear()
  }

  return {
    observe,
    refreshScope,
    refreshRun,
    observeOutput,
    observeApproval,
    observeQuestion,
    subscribe,
    abortSubscription,
    shutdown,
  }
}
