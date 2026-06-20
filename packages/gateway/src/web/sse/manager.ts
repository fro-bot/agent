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
import type {OperatorRunStatus} from '../../operator-contract/index.js'

// ---------------------------------------------------------------------------
// Constants (injectable for tests)
// ---------------------------------------------------------------------------

/** Default heartbeat interval (15 seconds). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

/** Default max stream duration (30 minutes). */
export const DEFAULT_MAX_STREAM_DURATION_MS = 30 * 60 * 1000

/** Default per-subscriber queue cap in bytes (64 KB). */
export const DEFAULT_SUBSCRIBER_QUEUE_CAP_BYTES = 64 * 1024

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

/** The closed union of all frame types the manager can emit. */
export type ObservationFrame = StatusFrame | ResetFrame | HeartbeatFrame

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

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  // Latest projected status per run (one frame per active run).
  // A run that never reaches a terminal status (e.g. because a transition fails after
  // PENDING is observed) leaves its entry here until process restart. A future
  // staleness/reconcile path will evict these entries; for now the leak is bounded
  // by the number of active runs and is cleared on process restart.
  const latestStatusCache = new Map<string, OperatorRunStatus>()

  /** Active subscribers per run. Map<runId, Map<subId, SubscriberState>>. */
  const runSubscribers = new Map<string, Map<string, SubscriberState>>()

  /** Whether the manager has been shut down. */
  let isShutdown = false

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

    // Clear queue
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
    while (sub.dropped === false && sub.queue.length > 0) {
      const frame = sub.queue[0]
      if (frame === undefined) {
        break
      }

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
      // TypeScript's control flow doesn't track mutations through function calls,
      // so we use a local re-read via the queue length as the guard.
      if (sub.queue.length === 0 || sub.dropped !== false) {
        sub.writerRunning = false
        return
      }

      // Remove the delivered frame from the queue
      sub.queue.shift()
      const frameBytes = estimateFrameBytes(frame)
      sub.queueBytes = Math.max(0, sub.queueBytes - frameBytes)
    }

    sub.writerRunning = false
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
    }

    // Heartbeat timer: emit a heartbeat frame every heartbeatIntervalMs
    sub.heartbeatTimer = deps.setInterval(() => {
      if (sub.dropped === true) {
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
  // Internal: close all subscribers of a run with a given reason
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

    // Build the status frame (closed DTO — only the contract fields)
    // The projection already returns a closed OperatorRunStatus; we wrap it in a frame.
    const frame: StatusFrame = {type: 'status', data: projected}

    // Update the latest-status cache BEFORE fan-out
    latestStatusCache.set(runId, projected)

    // Fan out to all current subscribers (non-blocking — never awaits writes)
    fanOut(runId, frame)

    // On terminal status: clear the cache entry AFTER fan-out and close subscribers.
    // Order matters: fanOut() above calls enqueueFrame() → drainQueue() fire-and-forget.
    // drainQueue() captures `frame` in a local variable and calls onEvent(frame) before
    // its first `await` suspends — so the terminal frame is already in-flight when
    // closeRunSubscribers() runs synchronously below and clears each subscriber's queue.
    // The queue clear does NOT drop the in-flight frame because drainQueue() holds a
    // direct reference to it; reordering fanOut and closeRunSubscribers would silently
    // discard the terminal frame for any subscriber whose writer task hadn't started yet.
    if (isTerminal(projected.status) === true) {
      latestStatusCache.delete(runId)
      closeRunSubscribers(runId, 'terminal')
    }
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

    // Clear the latest-status cache
    latestStatusCache.clear()
  }

  return {observe, subscribe, abortSubscription, shutdown}
}
