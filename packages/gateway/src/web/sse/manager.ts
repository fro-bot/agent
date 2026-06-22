/**
 * In-memory pub/sub for run-status observation.
 *
 * `observe(runState)` projects the run through the redaction bridge, caches the
 * latest status per run, and fans it to that run's subscribers. A denied/keyless
 * projection (null) is dropped — never cached, never emitted. Fan-out serializes
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
import type {ApprovalFrameData, OperatorOutputFrame, OperatorRunStatus} from '../../operator-contract/index.js'

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

const TERMINAL_STATUSES = new Set<OperatorRunStatus['status']>(['succeeded', 'failed', 'cancelled'])

function isTerminal(status: OperatorRunStatus['status']): boolean {
  return TERMINAL_STATUSES.has(status)
}

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

/** The closed union of all frame types the manager can emit. */
export type ObservationFrame = StatusFrame | ResetFrame | HeartbeatFrame | OutputFrame | ApprovalFrame

// ---------------------------------------------------------------------------
// Subscriber callbacks
// ---------------------------------------------------------------------------

export interface SubscriberCallbacks {
  /** Called synchronously (or async) when a frame is ready. May throw — errors are contained. */
  readonly onEvent: (frame: ObservationFrame) => void | Promise<void>
  /** Called when the subscription is closed for any reason. */
  readonly onClose: (reason: string) => void
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
   * Project a RunState to an OperatorRunStatus (or null for denied/keyless repos).
   * Injected so the manager test doesn't need a real bindings store.
   * In production, wire to projectRunObservation from projection.ts.
   */
  readonly projectRunObservation: (runState: RunState) => Promise<OperatorRunStatus | null>

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

export interface RunObservationManager {
  /**
   * Observe a run state transition. Projects via the injected function.
   * A null projection is dropped immediately (no cache, no emit, no side effect).
   * A non-null projection updates the latest-status cache and fans out to subscribers.
   * On a terminal status, clears the cache entry and closes subscribers cleanly.
   * NEVER awaits a subscriber write — strictly non-blocking.
   */
  readonly observe: (runState: RunState) => Promise<void>

  /**
   * Subscribe to run-status frames for a given runId.
   * If a latest-status cache entry exists, delivers it immediately as the first frame.
   * If none exists, emits a single `reset` frame.
   * Returns an unsubscribe function for clean disconnect (no onClose called).
   */
  readonly subscribe: (runId: string, callbacks: SubscriberCallbacks) => () => void

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

export function createRunObservationManager(deps: RunObservationManagerDeps): RunObservationManager {
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
   * Tracks which runIds have reached terminal state. Used to guard against
   * stale non-terminal observe() calls that arrive out of causal order after
   * a terminal observe() has already committed the replay cache entry.
   */
  const terminalRuns = new Set<string>()

  /** Running total of estimated bytes stored in terminalReplayCache. */
  let terminalReplayCacheBytes = 0

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
      terminalRuns.delete(runId)
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
      if (sub.dropped === true) {
        continue
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
      //   queue empty              → finalize immediately (nothing to deliver)
      //   queue non-empty, writer running  → trust drainQueue to finalize on empty
      //   queue non-empty, writer NOT running → start the drain so queued frames
      //                                         are delivered and finalize is called
      if (sub.queue.length === 0) {
        finalizeTerminalSubscriber(sub)
      } else if (sub.writerRunning === false) {
        // Writer stopped but queue is non-empty — start the drain so the queued
        // frames (including the terminal status) are delivered before closing.
        sub.writerRunning = true
        drainQueue(sub).catch(() => {})
      }
      // If writerRunning === true, drainQueue will call finalizeTerminalSubscriber
      // when the queue empties.
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

  const observe = async (runState: RunState): Promise<void> => {
    if (isShutdown === true) {
      return
    }

    // Project the run state — may return null for denied/keyless repos
    let projected: OperatorRunStatus | null
    try {
      projected = await deps.projectRunObservation(runState)
    } catch (error) {
      logger.warn(
        {runId: runState.run_id, err: String(error)},
        'manager: projectRunObservation threw — dropping observation',
      )
      return
    }

    // Null projection: denied/keyless repo — drop immediately, no cache, no emit
    if (projected === null) {
      return
    }

    const runId = runState.run_id

    // Guard against stale non-terminal observations arriving out of causal order.
    // If two concurrent observe() calls resolve out of order (COMPLETED resolves first,
    // then EXECUTING resolves), the non-terminal path must not overwrite the terminal
    // replay entry or regress the cached status.
    if (isTerminal(projected.status) === false && terminalRuns.has(runId) === true) {
      logger.warn(
        {runId, status: projected.status},
        'manager: non-terminal observe arrived after terminal — dropping stale observation',
      )
      return
    }

    // On a non-terminal status, clear any stale terminal replay cache entry for this
    // runId (avoids stale replay if runId is reused after a previous terminal run).
    // Only reached when terminalRuns does NOT contain this runId (guard above).
    if (isTerminal(projected.status) === false) {
      evictTerminalReplayEntry(runId)
    }

    // Build the status frame (closed DTO — only the contract fields)
    // The projection already returns a closed OperatorRunStatus; we wrap it in a frame.
    const frame: StatusFrame = {type: 'status', data: projected}

    // Update the latest-status cache BEFORE fan-out
    latestStatusCache.set(runId, projected)

    // Fan out to all current subscribers (non-blocking — never awaits writes)
    fanOut(runId, frame)

    // On terminal status: transition to graceful drain instead of hard abort.
    // markRunSubscribersForTerminalDrain does NOT clear queues — it lets
    // drainQueue deliver all already-queued frames (including the terminal status
    // frame just enqueued above) before finalizing the subscriber.
    if (isTerminal(projected.status) === true) {
      latestStatusCache.delete(runId)
      outputSeqCounters.delete(runId)

      // Move final output to terminal replay cache (with TTL) instead of
      // deleting it. Late subscribers connecting within the TTL receive the cached
      // final output then terminal status, then the stream closes gracefully.
      const finalOutput = latestOutputCache.get(runId)
      latestOutputCache.delete(runId)

      // Evict any existing entry for this runId before creating a new one
      evictTerminalReplayEntry(runId)

      // Mark this runId as terminal so stale non-terminal observations are rejected
      terminalRuns.add(runId)

      const expiresAt = deps.now() + terminalReplayTtlMs
      // Use evictTerminalReplayEntry in the TTL callback so byte accounting,
      // seq counter, and terminalRuns are all cleaned up on natural expiry.
      const evictionTimer = deps.setTimeout(() => {
        evictTerminalReplayEntry(runId)
      }, terminalReplayTtlMs)

      const newEntry: TerminalReplayCacheEntry = {
        finalOutput,
        terminalStatus: projected,
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
  // subscribe
  // ---------------------------------------------------------------------------

  const subscribe = (runId: string, callbacks: SubscriberCallbacks): (() => void) => {
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
      // Apply the same drain-state invariant as markRunSubscribersForTerminalDrain:
      //   queue empty              → finalize immediately
      //   queue non-empty, writer running  → trust drainQueue
      //   queue non-empty, writer NOT running → start the drain
      sub.closingReason = 'terminal'
      if (sub.queue.length === 0) {
        finalizeTerminalSubscriber(sub)
      } else if (sub.writerRunning === false) {
        sub.writerRunning = true
        drainQueue(sub).catch(() => {})
      }

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

    // Deliver the cached final output frame (if any) after the status snapshot.
    // This ensures a late subscriber (connecting after the run's final output frame
    // but before terminal) receives the complete answer.
    // Order: status/reset first, then cached output.
    const cachedOutput = latestOutputCache.get(runId)
    if (cachedOutput !== undefined) {
      const outputFrame: OutputFrame = {type: 'output', data: cachedOutput}
      enqueueOutputFrame(sub, outputFrame)
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

    // Clear terminal replay cache (cancel all eviction timers)
    for (const entry of terminalReplayCache.values()) {
      if (entry.evictionTimer !== undefined) {
        deps.clearTimeout(entry.evictionTimer)
      }
    }
    terminalReplayCache.clear()
    terminalReplayCacheBytes = 0
    terminalRuns.clear()
  }

  return {observe, observeOutput, observeApproval, subscribe, abortSubscription, shutdown}
}
