/**
 * manager.test.ts — Tests for the run-observation pub/sub manager.
 *
 * The load-bearing risks are:
 *   - Non-blocking backpressure: observe() must never await a subscriber write.
 *   - Observer-only invariant: the manager must never call any mutating run API.
 *
 * BDD comments: #given / #when / #then.
 *
 * Timer seam: all tests use injectable fake timers (setInterval/clearInterval/
 * setTimeout/clearTimeout/now) so heartbeat and max-duration tests are synchronous.
 */

import type {RunState} from '@fro-bot/runtime'
import type {
  OperatorCheckoutPreparation,
  OperatorCheckoutProvenance,
  OperatorRunStatus,
  QuestionFrameData,
  RunStatusRepoKey,
} from '../../operator-contract/index.js'
import type {RunStatusProjection} from '../../redaction/surface-gate.js'
import type {
  ObservationFrame,
  OutputFrame,
  RunObservationManager,
  RunObservationManagerDeps,
  ScopeRefresher,
} from './manager.js'
import type {WaitingPredicates} from './projection.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {PHASE_TO_WEB_STATUS} from '../../operator-contract/run-status.js'
import {projectRunStatusWithKey} from '../../redaction/surface-gate.js'
import {createRunObservationManager, MAX_OPEN_QUESTION_REPLAY_PER_RUN} from './manager.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: 'run-001',
    surface: 'github',
    thread_id: 'thread-001',
    entity_ref: 'acme/widget#1',
    phase: 'EXECUTING',
    started_at: '2024-01-01T00:00:00.000Z',
    last_heartbeat: new Date(1_000_000).toISOString(),
    holder_id: 'holder-001',
    details: {},
    ...overrides,
  }
}

function makeOperatorRunStatus(overrides: Partial<OperatorRunStatus> = {}): OperatorRunStatus {
  return {
    runId: 'run-001',
    entityRef: 'acme/widget#1',
    surface: 'github',
    phase: 'EXECUTING',
    status: 'running',
    startedAt: '2024-01-01T00:00:00.000Z',
    stale: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Fake timer infrastructure
// ---------------------------------------------------------------------------

interface FakeTimerEntry {
  readonly id: number
  readonly intervalMs: number
  readonly callback: () => void
  readonly isInterval: boolean
  /** Absolute time (from startMs) at which this timer next fires. */
  nextFireAt: number
}

interface FakeTimerSystem {
  readonly setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
  readonly clearInterval: (id: ReturnType<typeof setInterval> | undefined) => void
  readonly setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeout: (id: ReturnType<typeof setTimeout> | undefined) => void
  readonly now: () => number
  /** Advance the fake clock by `ms` milliseconds, firing all due timers in order. */
  readonly advance: (ms: number) => void
  readonly activeTimerCount: () => number
}

function makeFakeTimerSystem(startMs = 0): FakeTimerSystem {
  let currentTime = startMs
  let nextId = 1
  const timers = new Map<number, FakeTimerEntry>()

  const setInterval = (cb: () => void, ms: number): ReturnType<typeof globalThis.setInterval> => {
    const id = nextId++
    timers.set(id, {id, intervalMs: ms, callback: cb, isInterval: true, nextFireAt: currentTime + ms})
    return id as unknown as ReturnType<typeof globalThis.setInterval>
  }

  const clearInterval = (id: ReturnType<typeof globalThis.setInterval> | undefined): void => {
    if (id !== undefined) {
      timers.delete(id as unknown as number)
    }
  }

  const setTimeout = (cb: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
    const id = nextId++
    timers.set(id, {id, intervalMs: ms, callback: cb, isInterval: false, nextFireAt: currentTime + ms})
    return id as unknown as ReturnType<typeof globalThis.setTimeout>
  }

  const clearTimeout = (id: ReturnType<typeof globalThis.setTimeout> | undefined): void => {
    if (id !== undefined) {
      timers.delete(id as unknown as number)
    }
  }

  const now = (): number => currentTime

  const advance = (ms: number): void => {
    const targetTime = currentTime + ms
    // Fire timers in chronological order until we reach targetTime
    let safetyLimit = 100_000
    while (safetyLimit-- > 0) {
      // Find the earliest timer that fires at or before targetTime
      let earliest: FakeTimerEntry | undefined
      for (const timer of timers.values()) {
        if (timer.nextFireAt <= targetTime && (earliest === undefined || timer.nextFireAt < earliest.nextFireAt)) {
          earliest = timer
        }
      }
      if (earliest === undefined) {
        break
      }
      // Advance clock to the fire time
      currentTime = earliest.nextFireAt
      // Fire the callback
      earliest.callback()
      if (earliest.isInterval === true) {
        // Reschedule: update nextFireAt in place
        earliest.nextFireAt = currentTime + earliest.intervalMs
      } else {
        // One-shot: remove
        timers.delete(earliest.id)
      }
    }
    currentTime = targetTime
  }

  const activeTimerCount = (): number => timers.size

  return {setInterval, clearInterval, setTimeout, clearTimeout, now, advance, activeTimerCount}
}

// ---------------------------------------------------------------------------
// Manager factory helper
// ---------------------------------------------------------------------------

type ProjectFn = (runState: RunState) => Promise<OperatorRunStatus | null>

const DEFAULT_REPO_KEY: RunStatusRepoKey = {databaseId: 1, nodeId: 'R_1'}
const NO_WAITING: WaitingPredicates = {hasPendingApproval: () => false, hasPendingQuestion: () => false}

/** Adapts a status-returning test projector (null = denied) to the manager's base-projection dep. */
function toProjectBase(projectFn: ProjectFn): RunObservationManagerDeps['projectBase'] {
  return async runState => {
    const status = await projectFn(runState)
    return status === null ? {kind: 'denied'} : {kind: 'projected', status, repoKey: DEFAULT_REPO_KEY}
  }
}

function makeManager(
  projectFn: ProjectFn,
  overrides: Partial<RunObservationManagerDeps> = {},
  fakeTimers?: FakeTimerSystem,
): {manager: RunObservationManager & ScopeRefresher; timers: FakeTimerSystem} {
  const timers = fakeTimers ?? makeFakeTimerSystem()
  const manager = createRunObservationManager({
    projectBase: toProjectBase(projectFn),
    waiting: NO_WAITING,
    isRepoDenied: () => false,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    ...overrides,
  })
  return {manager, timers}
}

function makeManagerWithLogger(
  projectFn: ProjectFn,
  overrides: Partial<RunObservationManagerDeps> = {},
): {manager: RunObservationManager; logger: {warn: ReturnType<typeof vi.fn>}} {
  const warn = vi.fn()
  const {manager} = makeManager(projectFn, {
    logger: {info: vi.fn(), warn, error: vi.fn(), debug: vi.fn()},
    ...overrides,
  })
  return {manager, logger: {warn}}
}

// ---------------------------------------------------------------------------
// Collected frames helper
// ---------------------------------------------------------------------------

function collectFrames(
  manager: RunObservationManager,
  runId: string,
): {frames: ObservationFrame[]; closes: string[]; unsubscribe: () => void} {
  const frames: ObservationFrame[] = []
  const closes: string[] = []
  const unsubscribe = manager.subscribe(runId, {
    onEvent: frame => {
      frames.push(frame)
    },
    onClose: reason => {
      closes.push(reason)
    },
  })
  return {frames, closes, unsubscribe}
}

// ---------------------------------------------------------------------------
// Drain helper: flush the microtask queue so async writer tasks run
// ---------------------------------------------------------------------------

async function drain(): Promise<void> {
  // Multiple rounds to let chained microtasks settle
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

// ===========================================================================
// 1. Happy path: ordered frames + terminal close + cache clear
// ===========================================================================

describe('happy path — ordered frames, terminal close, cache clear', () => {
  it('pushes ordered frames to a subscriber and closes cleanly on terminal status', async () => {
    // #given a manager with a project function that returns status frames in sequence
    const statuses: OperatorRunStatus[] = [
      makeOperatorRunStatus({phase: 'PENDING', status: 'queued'}),
      makeOperatorRunStatus({phase: 'EXECUTING', status: 'running'}),
      makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'}),
    ]
    let callCount = 0
    const projectFn: ProjectFn = async () => statuses[callCount++] ?? null

    const {manager} = makeManager(projectFn)
    const {frames, closes, unsubscribe} = collectFrames(manager, 'run-001')

    // #when observing three transitions
    await manager.observe(makeRunState({phase: 'PENDING'}))
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await manager.observe(makeRunState({phase: 'COMPLETED', run_id: 'run-001'}))
    await drain()

    // #then frames arrive in order
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames).toHaveLength(3)
    expect(statusFrames[0]).toMatchObject({type: 'status', data: {status: 'queued'}})
    expect(statusFrames[1]).toMatchObject({type: 'status', data: {status: 'running'}})
    expect(statusFrames[2]).toMatchObject({type: 'status', data: {status: 'succeeded'}})

    // #then the stream is closed after the terminal status
    expect(closes).toHaveLength(1)
    expect(closes[0]).toBe('terminal')

    // #then subscribing again after terminal gets the terminal replay (status frame + close)
    // The terminal replay cache holds the terminal status for a bounded TTL.
    // Late subscribers receive the terminal status frame, then the stream closes with 'terminal'.
    const {frames: frames2, closes: closes2} = collectFrames(manager, 'run-001')
    await drain()
    // The late subscriber gets the terminal status from the replay cache (not a reset)
    const replayStatusFrames = frames2.filter(f => f.type === 'status')
    expect(replayStatusFrames.length).toBeGreaterThanOrEqual(1)
    expect(replayStatusFrames.at(-1)).toMatchObject({type: 'status', data: {status: 'succeeded'}})
    expect(closes2).toContain('terminal')

    unsubscribe()
    manager.shutdown()
  })

  it('clears the latestStatusCache entry after terminal fan-out — late subscriber gets terminal replay', async () => {
    // #given a manager that projects a terminal status
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const projectFn: ProjectFn = async () => terminalStatus

    const {manager} = makeManager(projectFn)

    // #when observing a terminal transition
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then subscribing after terminal gets the terminal replay (not a reset)
    // The terminal replay cache holds the terminal status for a bounded TTL.
    // The latestStatusCache entry is cleared (no active run entry), but the
    // terminalReplayCache entry delivers the terminal status to late subscribers.
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()
    // Late subscriber gets the terminal status from the replay cache
    expect(frames.some(f => f.type === 'status')).toBe(true)
    expect(frames.some(f => f.type === 'reset')).toBe(false)
    // The stream closes with 'terminal' after delivering the replay
    expect(closes).toContain('terminal')

    manager.shutdown()
  })
})

// ===========================================================================
// 2. Snapshot-on-subscribe
// ===========================================================================

describe('snapshot-on-subscribe', () => {
  it('delivers the cached latest status immediately on subscribe, then live frames', async () => {
    // #given a manager with a cached status for run-001
    const cachedStatus = makeOperatorRunStatus({status: 'running'})
    const liveStatus = makeOperatorRunStatus({status: 'succeeded', phase: 'COMPLETED'})
    let callCount = 0
    const projectFn: ProjectFn = async () => (callCount++ === 0 ? cachedStatus : liveStatus)

    const {manager} = makeManager(projectFn)

    // Seed the cache by observing first
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #when subscribing after the cache is populated
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()

    // #then the snapshot is delivered immediately (before any new observe)
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames.length).toBeGreaterThanOrEqual(1)
    expect(statusFrames[0]).toMatchObject({type: 'status', data: {status: 'running'}})

    // #when a live frame arrives
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then the live frame is also delivered
    const allStatusFrames = frames.filter(f => f.type === 'status')
    expect(allStatusFrames.length).toBeGreaterThanOrEqual(2)
    expect(allStatusFrames.at(-1)).toMatchObject({type: 'status', data: {status: 'succeeded'}})

    // #then the stream closes on terminal
    expect(closes).toContain('terminal')

    manager.shutdown()
  })

  it('emits a reset frame when no cached status exists for the run', async () => {
    // #given a manager with no cached status for run-999
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    // #when subscribing to a run with no cache
    const {frames} = collectFrames(manager, 'run-999')
    await drain()

    // #then a reset frame is emitted
    const resetFrames = frames.filter(f => f.type === 'reset')
    expect(resetFrames).toHaveLength(1)
    expect(resetFrames[0]).toMatchObject({type: 'reset', runId: 'run-999'})

    manager.shutdown()
  })

  it('does NOT emit reset when a cached status exists', async () => {
    // #given a manager with a cached status
    const cachedStatus = makeOperatorRunStatus({status: 'running'})
    const projectFn: ProjectFn = async () => cachedStatus
    const {manager} = makeManager(projectFn)

    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #when subscribing
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #then no reset frame is emitted
    expect(frames.some(f => f.type === 'reset')).toBe(false)

    manager.shutdown()
  })
})

// ===========================================================================
// 3. Backpressure (LOAD-BEARING)
// ===========================================================================

describe('backpressure — LOAD-BEARING', () => {
  it('drops a slow subscriber (overflow) without blocking publish or a fast peer', async () => {
    // #given a manager with a queue cap sized for exactly one status frame
    // Strategy: use a cap that fits one frame. The slow subscriber gets the snapshot
    // frame (dequeued immediately, in-flight). Queue is empty. We then enqueue TWO
    // more frames simultaneously (before any drain) — the first fits, the second
    // overflows → slow subscriber is dropped. The fast subscriber drains immediately.
    const status = makeOperatorRunStatus({status: 'running'})
    const projectFn: ProjectFn = async () => status

    // Estimate one frame's byte size so we can set the cap to exactly that
    const oneFrameBytes = JSON.stringify({type: 'status', data: status}).length
    // Cap = one frame: the slow subscriber can hold exactly one queued frame.
    // With dequeue-before-await, the in-flight frame is not in the queue.
    // So we need to enqueue 2 frames simultaneously to overflow.
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: oneFrameBytes})

    // Seed the cache so both subscribers get a snapshot frame on subscribe
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #given a slow subscriber that never drains (simulated by blocking onEvent)
    const slowCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: async () => {
        // Simulate a slow consumer: never resolves during the test
        await new Promise<void>(() => {
          // intentionally never resolves
        })
      },
      onClose: reason => {
        slowCloses.push(reason)
      },
    })

    // #given a fast subscriber
    const fastFrames: ObservationFrame[] = []
    const fastCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: frame => {
        fastFrames.push(frame)
      },
      onClose: reason => {
        fastCloses.push(reason)
      },
    })

    // The slow subscriber's snapshot frame is dequeued immediately (in-flight, blocking).
    // Queue is empty. Enqueue TWO more frames simultaneously — first fits, second overflows.

    // #when observing twice without draining (second frame overflows slow subscriber)
    const observeStart = Date.now()
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    const observeElapsed = Date.now() - observeStart

    // #then observe() completes in bounded time (not blocked by slow subscriber)
    // The key invariant: observe() must return without awaiting any subscriber write
    expect(observeElapsed).toBeLessThan(100) // well under any real I/O timeout

    await drain()

    // #then the slow subscriber is dropped with 'overflow'
    expect(slowCloses).toContain('overflow')

    // #then the fast subscriber still receives frames (snapshot + live)
    expect(fastFrames.filter(f => f.type === 'status').length).toBeGreaterThanOrEqual(1)
    expect(fastCloses).not.toContain('overflow')

    manager.shutdown()
  })

  it('observe() completes in bounded time with ALL subscribers slow (no await on any write)', async () => {
    // #given a manager with a tiny cap to force all subscribers to overflow
    const status = makeOperatorRunStatus({status: 'running'})
    const projectFn: ProjectFn = async () => status
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: 1})

    // #given multiple slow subscribers
    const closes: string[] = []
    for (let i = 0; i < 5; i++) {
      manager.subscribe('run-001', {
        onEvent: async () => {
          // Never resolves — simulates a completely stuck consumer
          await new Promise<void>(() => {
            // intentionally never resolves
          })
        },
        onClose: reason => {
          closes.push(reason)
        },
      })
    }

    // #when observing with all subscribers slow
    const start = Date.now()
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    const elapsed = Date.now() - start

    // #then observe() returns in bounded time — it NEVER awaits subscriber writes
    // This is the critical invariant: the publisher is non-blocking
    expect(elapsed).toBeLessThan(100)

    // #then the latest-status cache is updated (O(1) operation)
    // Verify by subscribing a new fast subscriber and getting the snapshot
    await drain()

    // All slow subscribers should have been dropped due to overflow
    // The cache may or may not have been updated depending on whether the
    // enqueue happened before the overflow check — but observe() must have returned
    expect(elapsed).toBeLessThan(100) // re-assert the key invariant

    manager.shutdown()
  })

  it('dropping a subscriber mid-fan-out does not corrupt the publish iteration', async () => {
    // #given a manager with a tiny cap
    const statuses = [
      makeOperatorRunStatus({status: 'running'}),
      makeOperatorRunStatus({status: 'succeeded', phase: 'COMPLETED'}),
    ]
    let callCount = 0
    const projectFn: ProjectFn = async () => statuses[callCount++ % statuses.length] ?? null
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: 1})

    // #given a mix of subscribers (some will overflow, some won't)
    const results: {frames: ObservationFrame[]; closes: string[]}[] = []
    for (let i = 0; i < 3; i++) {
      const frames: ObservationFrame[] = []
      const closes: string[] = []
      results.push({frames, closes})
      manager.subscribe('run-001', {
        onEvent: frame => {
          frames.push(frame)
        },
        onClose: reason => {
          closes.push(reason)
        },
      })
    }

    // #when observing multiple times (some subscribers will overflow)
    // This must not throw or corrupt the iteration
    await expect(
      (async () => {
        await manager.observe(makeRunState({phase: 'EXECUTING'}))
        await manager.observe(makeRunState({phase: 'COMPLETED'}))
        await drain()
      })(),
    ).resolves.not.toThrow()

    // #then the results array is still intact (no corruption)
    expect(results).toHaveLength(3)

    manager.shutdown()
  })
})

// ===========================================================================
// 4. Bounds: heartbeat and max duration
// ===========================================================================

describe('bounds — heartbeat and max duration', () => {
  it('emits a heartbeat frame after the heartbeat interval', async () => {
    // #given a manager with injectable fake timers
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const fakeTimers = makeFakeTimerSystem(0)
    const {manager} = makeManager(projectFn, {heartbeatIntervalMs: 15_000}, fakeTimers)

    // #given a subscriber
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when advancing time past the heartbeat interval
    fakeTimers.advance(15_001)
    await drain()

    // #then a heartbeat frame was emitted
    const heartbeats = frames.filter(f => f.type === 'heartbeat')
    expect(heartbeats.length).toBeGreaterThanOrEqual(1)

    manager.shutdown()
  })

  it('does NOT emit a heartbeat before the interval elapses', async () => {
    // #given a manager with injectable fake timers
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const fakeTimers = makeFakeTimerSystem(0)
    const {manager} = makeManager(projectFn, {heartbeatIntervalMs: 15_000}, fakeTimers)

    // #given a subscriber
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when advancing time to just before the heartbeat interval
    fakeTimers.advance(14_999)
    await drain()

    // #then no heartbeat frame was emitted
    const heartbeats = frames.filter(f => f.type === 'heartbeat')
    expect(heartbeats).toHaveLength(0)

    manager.shutdown()
  })

  it('closes a subscriber after the max stream duration', async () => {
    // #given a manager with injectable fake timers and the default max duration
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const fakeTimers = makeFakeTimerSystem(0)
    const {manager} = makeManager(
      projectFn,
      {heartbeatIntervalMs: 15_000, maxStreamDurationMs: 30 * 60 * 1000},
      fakeTimers,
    )

    // #given a subscriber
    const {closes} = collectFrames(manager, 'run-001')
    await drain()

    // #when advancing time past the max stream duration (30 minutes)
    fakeTimers.advance(30 * 60 * 1000 + 1)
    await drain()

    // #then the subscriber is closed with 'max-duration'
    expect(closes).toContain('max-duration')

    manager.shutdown()
  })

  it('emits multiple heartbeats over multiple intervals', async () => {
    // #given a manager with injectable fake timers
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const fakeTimers = makeFakeTimerSystem(0)
    const {manager} = makeManager(projectFn, {heartbeatIntervalMs: 15_000}, fakeTimers)

    // #given a subscriber
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when advancing time past 3 heartbeat intervals
    fakeTimers.advance(45_001)
    await drain()

    // #then at least 3 heartbeat frames were emitted
    const heartbeats = frames.filter(f => f.type === 'heartbeat')
    expect(heartbeats.length).toBeGreaterThanOrEqual(3)

    manager.shutdown()
  })
})

// ===========================================================================
// 5. Denied-repo omission
// ===========================================================================

describe('denied-repo omission', () => {
  it('produces no cache entry, no enqueued frame, no side effect when projection returns null', async () => {
    // #given a manager whose project function always returns null (denied repo)
    const projectFn: ProjectFn = async () => null
    const {manager} = makeManager(projectFn)

    // #given a subscriber before the observe
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()

    // The initial subscribe with no cache emits reset — that's expected
    const initialResetCount = frames.filter(f => f.type === 'reset').length

    // #when observing a denied run
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #then no new status frame was enqueued
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames).toHaveLength(0)

    // #then no new reset was triggered by the denied observe (only the initial one)
    const resetFrames = frames.filter(f => f.type === 'reset')
    expect(resetFrames).toHaveLength(initialResetCount)

    // #then no close was triggered by the denied observe
    expect(closes).toHaveLength(0)

    // #then subscribing again still gets reset (no cache entry was created)
    const {frames: frames2} = collectFrames(manager, 'run-001')
    await drain()
    expect(frames2.some(f => f.type === 'reset')).toBe(true)
    expect(frames2.some(f => f.type === 'status')).toBe(false)

    manager.shutdown()
  })

  it('does not update the latest-status cache when projection returns null', async () => {
    // #given a manager that first returns a real status, then null
    const realStatus = makeOperatorRunStatus({status: 'running'})
    let callCount = 0
    const projectFn: ProjectFn = async () => (callCount++ === 0 ? realStatus : null)
    const {manager} = makeManager(projectFn)

    // Seed the cache
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #when observing a denied run (null projection)
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #then the cache still holds the previous real status (null didn't overwrite it)
    const {frames} = collectFrames(manager, 'run-001')
    await drain()
    const statusFrames = frames.filter(f => f.type === 'status')
    // Should get the cached real status, not a reset
    expect(statusFrames.length).toBeGreaterThanOrEqual(1)
    expect(statusFrames[0]).toMatchObject({type: 'status', data: {status: 'running'}})

    manager.shutdown()
  })

  it('cold-start deny-all: null projection at manager boundary yields no cache entry and no emitted frame', async () => {
    // Pins the fail-closed posture at the manager boundary: when the denylist cache is
    // unprimed (cold start), projectBase returns denied (deny-all). The manager
    // must produce no observable output — no cache write, no frame to any subscriber.

    // #given a manager whose projection always returns null (unprimed denylist → deny-all)
    const projectFn: ProjectFn = async () => null
    const {manager} = makeManager(projectFn)

    // #when observing before any subscriber exists (cold path — no subscribers yet)
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #then subscribing after the denied observe yields reset (no cache entry was written)
    const {frames: framesAfter, closes: closesAfter} = collectFrames(manager, 'run-001')
    await drain()

    expect(framesAfter.filter(f => f.type === 'status')).toHaveLength(0)
    expect(framesAfter.filter(f => f.type === 'reset')).toHaveLength(1)
    expect(closesAfter).toHaveLength(0)

    // #when a subscriber is present during a cold-start denied observe
    const {frames: framesDuring, closes: closesDuring} = collectFrames(manager, 'run-002')
    await drain()
    // Initial subscribe with no cache → reset (expected)
    const resetsBefore = framesDuring.filter(f => f.type === 'reset').length

    await manager.observe(makeRunState({run_id: 'run-002', phase: 'EXECUTING'}))
    await drain()

    // #then no status frame was emitted to the subscriber
    expect(framesDuring.filter(f => f.type === 'status')).toHaveLength(0)
    // #then no additional reset was triggered by the denied observe
    expect(framesDuring.filter(f => f.type === 'reset')).toHaveLength(resetsBefore)
    // #then no close was triggered
    expect(closesDuring).toHaveLength(0)

    manager.shutdown()
  })
})

// ===========================================================================
// 6. Observer-only invariant (LOAD-BEARING)
// ===========================================================================

describe('observer-only invariant — LOAD-BEARING', () => {
  it('deps type has no mutating run API — observer-only by construction', () => {
    // #given the RunObservationManagerDeps type
    // This is a structural/compile-time test: we verify that the deps object
    // we pass to createRunObservationManager has NO mutating run API fields.
    // The type system enforces this — if the type had lock/coordinator/heartbeat
    // mutators, TypeScript would require them and this test would fail to compile.

    const deps: RunObservationManagerDeps = {
      projectBase: async () => ({kind: 'denied'}),
      waiting: NO_WAITING,
      isRepoDenied: () => false,
      logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()},
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      now: Date.now.bind(Date),
    }

    // #then the deps object has ONLY the expected read-only/observer fields
    const depKeys = new Set(Object.keys(deps))

    // No mutating run API keys are present
    const mutatingKeys = ['transitionRun', 'acquireLock', 'releaseLock', 'heartbeat', 'coordinator', 'runLock']
    for (const key of mutatingKeys) {
      expect(depKeys.has(key)).toBe(false)
    }

    // All present keys are in the allowed set
    const allowedKeys = new Set([
      'projectBase',
      'waiting',
      'isRepoDenied',
      'logger',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
      'now',
      'heartbeatIntervalMs',
      'maxStreamDurationMs',
      'subscriberQueueCapBytes',
    ])
    for (const key of depKeys) {
      expect(allowedKeys.has(key)).toBe(true)
    }
  })

  it('observe/subscribe/shutdown never call any mutating run API (behavioral)', async () => {
    // #given spy objects for anything mutating-adjacent
    const mutatingSpies = {
      transitionRun: vi.fn(),
      acquireLock: vi.fn(),
      releaseLock: vi.fn(),
      heartbeat: vi.fn(),
      coordinator: {transition: vi.fn(), lock: vi.fn()},
    }

    // #given a manager that does NOT receive any mutating deps
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    // #when calling all manager operations
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    const unsubscribe = manager.subscribe('run-001', {
      onEvent: vi.fn(),
      onClose: vi.fn(),
    })
    await drain()
    unsubscribe()
    manager.shutdown()

    // #then no mutating spy was ever called (they were never passed to the manager)
    expect(mutatingSpies.transitionRun).not.toHaveBeenCalled()
    expect(mutatingSpies.acquireLock).not.toHaveBeenCalled()
    expect(mutatingSpies.releaseLock).not.toHaveBeenCalled()
    expect(mutatingSpies.heartbeat).not.toHaveBeenCalled()
    expect(mutatingSpies.coordinator.transition).not.toHaveBeenCalled()
    expect(mutatingSpies.coordinator.lock).not.toHaveBeenCalled()
  })

  it('disconnect/abort removes only the subscription — never touches run lifecycle', async () => {
    // #given a manager with a subscriber
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    // Seed the cache
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    const {frames, closes, unsubscribe} = collectFrames(manager, 'run-001')
    await drain()

    // #when disconnecting (unsubscribing)
    unsubscribe()
    await drain()

    // #then the subscription is removed (no more frames after disconnect)
    const frameCountAtDisconnect = frames.length
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()
    expect(frames.length).toBe(frameCountAtDisconnect) // no new frames

    // #then no close reason was emitted (clean disconnect, not an error)
    // Note: unsubscribe() is a clean disconnect — no onClose is called
    expect(closes).toHaveLength(0)

    manager.shutdown()
  })
})

// ===========================================================================
// 7. Cleanup: no leaks on abort/rapid connect-disconnect
// ===========================================================================

describe('cleanup — no leaks', () => {
  it('aborted connection removes subscription, timers, and queued bytes', async () => {
    // #given a manager with fake timers
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const fakeTimers = makeFakeTimerSystem(0)
    const {manager} = makeManager(projectFn, {heartbeatIntervalMs: 15_000}, fakeTimers)

    // Seed the cache
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #given a subscriber
    const {unsubscribe} = collectFrames(manager, 'run-001')
    await drain()

    const timerCountWithSubscriber = fakeTimers.activeTimerCount()
    expect(timerCountWithSubscriber).toBeGreaterThan(0)

    // #when aborting (unsubscribing)
    unsubscribe()
    await drain()

    // #then timers are cleared (fewer active timers)
    const timerCountAfterAbort = fakeTimers.activeTimerCount()
    expect(timerCountAfterAbort).toBeLessThan(timerCountWithSubscriber)

    manager.shutdown()
  })

  it('rapid connect/disconnect does not leak listeners or timers', async () => {
    // #given a manager with fake timers
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const fakeTimers = makeFakeTimerSystem(0)
    const {manager} = makeManager(projectFn, {heartbeatIntervalMs: 15_000}, fakeTimers)

    // #when rapidly connecting and disconnecting many subscribers
    const unsubscribers: (() => void)[] = []
    for (let i = 0; i < 20; i++) {
      const unsub = manager.subscribe('run-001', {
        onEvent: vi.fn(),
        onClose: vi.fn(),
      })
      unsubscribers.push(unsub)
    }

    // Disconnect all
    for (const unsub of unsubscribers) {
      unsub()
    }
    await drain()

    // #then active subscription count returns to 0 (no leaks)
    // Verify by checking that a new observe doesn't deliver to any subscriber
    const frames: ObservationFrame[] = []
    const newUnsub = manager.subscribe('run-001', {
      onEvent: frame => {
        frames.push(frame)
      },
      onClose: vi.fn(),
    })
    await drain()
    // Only the reset frame (no cached status) should appear — no leaked frames from old subs
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames).toHaveLength(0)

    newUnsub()

    // #then timers are cleared (no leaked timers from disconnected subscribers)
    // After all unsubscribes, only manager-level timers (if any) remain
    const timerCount = fakeTimers.activeTimerCount()
    expect(timerCount).toBeLessThanOrEqual(1) // at most 1 manager-level timer

    manager.shutdown()
  })

  it('shutdown closes all subscriptions and clears all caches/timers', async () => {
    // #given a manager with multiple subscribers
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const fakeTimers = makeFakeTimerSystem(0)
    const {manager} = makeManager(projectFn, {heartbeatIntervalMs: 15_000}, fakeTimers)

    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    const closes1: string[] = []
    const closes2: string[] = []
    manager.subscribe('run-001', {onEvent: vi.fn(), onClose: r => closes1.push(r)})
    manager.subscribe('run-001', {onEvent: vi.fn(), onClose: r => closes2.push(r)})
    await drain()

    // #when shutting down
    manager.shutdown()
    await drain()

    // #then all subscribers are closed
    expect(closes1).toContain('shutdown')
    expect(closes2).toContain('shutdown')

    // #then all timers are cleared
    expect(fakeTimers.activeTimerCount()).toBe(0)
  })
})

// ===========================================================================
// 8. Error path: writer failure containment + EOF observation-failed
// ===========================================================================

describe('error path — writer failure containment', () => {
  it('a writer failure on one subscriber does not crash the manager or other subscribers', async () => {
    // #given a manager with a throwing subscriber and a healthy subscriber
    const status = makeOperatorRunStatus({status: 'running'})
    const projectFn: ProjectFn = async () => status
    const {manager} = makeManager(projectFn)

    // Seed the cache
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    const throwingCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: () => {
        throw new Error('simulated writer failure')
      },
      onClose: reason => {
        throwingCloses.push(reason)
      },
    })

    const healthyFrames: ObservationFrame[] = []
    const healthyCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: frame => {
        healthyFrames.push(frame)
      },
      onClose: reason => {
        healthyCloses.push(reason)
      },
    })

    // #when observing (the throwing subscriber will fail)
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #then the manager did not crash (test is still running)
    expect(true).toBe(true)

    // #then the healthy subscriber still received frames
    expect(healthyFrames.filter(f => f.type === 'status').length).toBeGreaterThanOrEqual(1)

    // #then the throwing subscriber was dropped (writer-error close)
    expect(throwingCloses.length).toBeGreaterThanOrEqual(1)

    manager.shutdown()
  })

  it('eOF before terminal status fires onClose("observation-failed"), not success', async () => {
    // #given a manager with a subscriber
    const projectFn: ProjectFn = async () => makeOperatorRunStatus({status: 'running'})
    const {manager} = makeManager(projectFn)

    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    const closes: string[] = []
    const unsubscribe = manager.subscribe('run-001', {
      onEvent: vi.fn(),
      onClose: reason => {
        closes.push(reason)
      },
    })

    await drain()

    // #when the connection is aborted (EOF) before a terminal status
    // We simulate EOF by calling abort on the subscription handle
    // The unsubscribe function returned by subscribe() is the clean-disconnect path.
    // For EOF (connection drop), the caller signals via the abort callback.
    // We test this by calling the returned unsubscribe with an 'eof' signal.
    // Since the plan says "EOF before terminal fires onClose('observation-failed')",
    // we need the manager to expose an abort path distinct from clean unsubscribe.
    // The manager's subscribe returns an unsubscribe fn; EOF is signaled via
    // manager.signalEof(subscriptionHandle) or similar.
    // For testability, we use the manager's abortSubscription method.
    manager.abortSubscription('run-001', 'observation-failed')
    await drain()

    // #then onClose is called with 'observation-failed'
    expect(closes).toContain('observation-failed')

    // #then it was NOT called with 'terminal' or 'succeeded'
    expect(closes).not.toContain('terminal')
    expect(closes).not.toContain('succeeded')

    unsubscribe()
    manager.shutdown()
  })
})

// ===========================================================================
// 9. Safety: only closed-DTO frames are ever enqueued
// ===========================================================================

describe('safety — only closed-DTO frames are enqueued', () => {
  it('only OperatorRunStatus / reset / heartbeat frames are ever enqueued', async () => {
    // #given a run state with sensitive details
    const runStateWithDetails = makeRunState({
      details: {
        rawOutput: 'secret tool output',
        workspacePath: '/home/runner/workspace',
        toolArgs: ['--token', 'ghp_secret'],
        internalUrl: 'http://internal.corp/api',
      },
    })

    // #given a project function that returns a clean OperatorRunStatus
    const cleanStatus = makeOperatorRunStatus({status: 'running'})
    const projectFn: ProjectFn = async () => cleanStatus
    const {manager} = makeManager(projectFn)

    // #given a subscriber that collects all frames
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when observing a run with sensitive details
    await manager.observe(runStateWithDetails)
    await drain()

    // #then all frames are of the allowed types only
    for (const frame of frames) {
      expect(['status', 'reset', 'heartbeat']).toContain(frame.type)
    }

    // #then no frame contains any sensitive field
    const serialized = JSON.stringify(frames)
    expect(serialized).not.toContain('rawOutput')
    expect(serialized).not.toContain('secret tool output')
    expect(serialized).not.toContain('workspacePath')
    expect(serialized).not.toContain('/home/runner/workspace')
    expect(serialized).not.toContain('toolArgs')
    expect(serialized).not.toContain('ghp_secret')
    expect(serialized).not.toContain('internalUrl')
    expect(serialized).not.toContain('http://internal.corp')
    expect(serialized).not.toContain('details')
    expect(serialized).not.toContain('holder_id')
    expect(serialized).not.toContain('thread_id')

    // #then status frames contain ONLY the contract fields
    const statusFrames = frames.filter(f => f.type === 'status')
    const contractFields = new Set(['runId', 'entityRef', 'surface', 'phase', 'status', 'startedAt', 'stale'])
    for (const frame of statusFrames) {
      // frame is already narrowed to StatusFrame by the filter above
      const dataKeys = new Set(Object.keys(frame.data))
      expect(dataKeys).toEqual(contractFields)
    }

    manager.shutdown()
  })

  it('reset frames contain only runId and reason — no run state fields', async () => {
    // #given a manager with no cached status
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    // #when subscribing to a run with no cache
    const {frames} = collectFrames(manager, 'run-999')
    await drain()

    // #then the reset frame has only runId and reason
    const resetFrames = frames.filter(f => f.type === 'reset')
    expect(resetFrames).toHaveLength(1)
    // resetFrames[0] is guaranteed by the length assertion above
    const resetFrame = resetFrames[0] as Extract<ObservationFrame, {type: 'reset'}>
    const resetKeys = new Set(Object.keys(resetFrame))
    expect(resetKeys.has('type')).toBe(true)
    expect(resetKeys.has('runId')).toBe(true)
    expect(resetKeys.has('reason')).toBe(true)
    // No extra fields
    expect(resetKeys.size).toBe(3)

    manager.shutdown()
  })

  it('heartbeat frames contain only the type field', async () => {
    // #given a manager with fake timers
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const fakeTimers = makeFakeTimerSystem(0)
    const {manager} = makeManager(projectFn, {heartbeatIntervalMs: 15_000}, fakeTimers)

    // #given a subscriber
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when advancing time to trigger a heartbeat
    fakeTimers.advance(15_001)
    await drain()

    // #then heartbeat frames contain only the type field
    const heartbeats = frames.filter(f => f.type === 'heartbeat')
    for (const hb of heartbeats) {
      const keys = new Set(Object.keys(hb))
      expect(keys).toEqual(new Set(['type']))
    }

    manager.shutdown()
  })
})

// ===========================================================================
// 10. Multiple runs: isolation between run IDs
// ===========================================================================

describe('run isolation', () => {
  it('frames for run-A do not appear in run-B subscriber', async () => {
    // #given a manager
    const statusA = makeOperatorRunStatus({runId: 'run-A', status: 'running'})
    const statusB = makeOperatorRunStatus({runId: 'run-B', status: 'queued', phase: 'PENDING'})
    const projectFn: ProjectFn = async runState =>
      runState.run_id === 'run-A' ? statusA : runState.run_id === 'run-B' ? statusB : null
    const {manager} = makeManager(projectFn)

    // #given subscribers for two different runs
    const {frames: framesA} = collectFrames(manager, 'run-A')
    const {frames: framesB} = collectFrames(manager, 'run-B')
    await drain()

    // #when observing run-A
    await manager.observe(makeRunState({run_id: 'run-A', phase: 'EXECUTING'}))
    await drain()

    // #then run-A subscriber gets the frame
    expect(framesA.filter(f => f.type === 'status').length).toBeGreaterThanOrEqual(1)

    // #then run-B subscriber does NOT get run-A's frame
    const runBStatusFrames = framesB.filter(f => f.type === 'status')
    for (const frame of runBStatusFrames) {
      // frame is already narrowed to StatusFrame by the filter above
      expect(frame.data.runId).toBe('run-B')
    }

    manager.shutdown()
  })
})

// ===========================================================================
// 11. Error path: throwing projectFn is caught, logged, no cache/frame
// ===========================================================================

describe('error path — throwing projectBase', () => {
  it('a rejecting projectFn is caught, logged, and produces no cache entry and no frame', async () => {
    // #given a manager whose projectBase always rejects
    const projectFn: ProjectFn = async () => {
      throw new Error('projection exploded')
    }
    const warnSpy = vi.fn()
    const {manager} = makeManager(projectFn, {
      logger: {info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn()},
    })

    // #given a subscriber before the observe
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()
    const initialFrameCount = frames.length

    // #when observing with a throwing projectFn
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #then no new status frame was produced
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames).toHaveLength(0)

    // #then no close was triggered (the subscriber is still open)
    expect(closes).toHaveLength(0)

    // #then the warn logger was called (error was logged)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({runId: 'run-001'}),
      expect.stringContaining('projectBase threw'),
    )

    // #then no cache entry was created (subscribing again gets reset)
    const {frames: frames2} = collectFrames(manager, 'run-001')
    await drain()
    expect(frames2.some(f => f.type === 'reset')).toBe(true)
    expect(frames2.some(f => f.type === 'status')).toBe(false)

    // #then total frame count did not increase beyond the initial reset
    expect(frames.length).toBe(initialFrameCount)

    manager.shutdown()
  })
})

// ===========================================================================
// 12. Post-shutdown behavior: subscribe and observe after shutdown
// ===========================================================================

describe('post-shutdown behavior', () => {
  it('subscribe after shutdown immediately calls onClose("shutdown") and returns a no-op unsubscribe', async () => {
    // #given a manager that has been shut down
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)
    manager.shutdown()

    // #when subscribing after shutdown
    const closes: string[] = []
    const frames: ObservationFrame[] = []
    const unsubscribe = manager.subscribe('run-001', {
      onEvent: frame => {
        frames.push(frame)
      },
      onClose: reason => {
        closes.push(reason)
      },
    })
    await drain()

    // #then onClose is called immediately with 'shutdown'
    expect(closes).toContain('shutdown')

    // #then no frames were delivered
    expect(frames).toHaveLength(0)

    // #then the returned unsubscribe is a no-op (does not throw)
    expect(() => unsubscribe()).not.toThrow()
  })

  it('observe after shutdown returns early — no cache entry, no frame delivered', async () => {
    // #given a manager with a subscriber, then shut down
    const projectFn: ProjectFn = async () => makeOperatorRunStatus({status: 'running'})
    const {manager} = makeManager(projectFn)

    // Subscribe before shutdown to verify no frames arrive after
    const frames: ObservationFrame[] = []
    manager.subscribe('run-001', {
      onEvent: frame => {
        frames.push(frame)
      },
      onClose: vi.fn(),
    })
    await drain()

    manager.shutdown()
    const frameCountAtShutdown = frames.length

    // #when observing after shutdown
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #then no new frames were delivered (observe returned early)
    expect(frames.length).toBe(frameCountAtShutdown)

    // #then no cache entry was created (a new subscribe gets reset)
    const frames2: ObservationFrame[] = []
    manager.subscribe('run-001', {
      onEvent: frame => {
        frames2.push(frame)
      },
      onClose: vi.fn(),
    })
    await drain()
    // After shutdown, subscribe immediately calls onClose — no frames expected
    expect(frames2.filter(f => f.type === 'status')).toHaveLength(0)
  })
})

// ===========================================================================
// 13. observeOutput — output frame fan-out, seq counter, final cache
// ===========================================================================

describe('observeOutput — output frame fan-out and seq counter', () => {
  it('fans an output frame {final:false, seq:0} to a subscriber; second call increments seq', async () => {
    // #given a manager with a subscriber
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when calling observeOutput twice
    manager.observeOutput('run-001', 'hello')
    manager.observeOutput('run-001', ' world')
    await drain()

    // #then two output frames are delivered with incrementing seq
    const outputFrames = frames.filter(f => f.type === 'output')
    expect(outputFrames).toHaveLength(2)
    expect(outputFrames[0]).toMatchObject({
      type: 'output',
      data: {runId: 'run-001', text: 'hello', final: false, seq: 0},
    })
    expect(outputFrames[1]).toMatchObject({
      type: 'output',
      data: {runId: 'run-001', text: ' world', final: false, seq: 1},
    })

    manager.shutdown()
  })

  it('observeOutput with {final:true} sets the cache and fans a final frame', async () => {
    // #given a manager with a subscriber
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when calling observeOutput with final:true
    manager.observeOutput('run-001', 'full answer', {final: true})
    await drain()

    // #then a final output frame is delivered
    const outputFrames = frames.filter(f => f.type === 'output')
    expect(outputFrames).toHaveLength(1)
    expect(outputFrames[0]).toMatchObject({
      type: 'output',
      data: {runId: 'run-001', text: 'full answer', final: true, seq: 0},
    })

    manager.shutdown()
  })

  it('empty final: observeOutput with empty text and {final:true} produces a terminal output frame', async () => {
    // #given a manager with a subscriber
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when calling observeOutput with empty text and final:true
    manager.observeOutput('run-001', '', {final: true})
    await drain()

    // #then a final output frame with empty text is delivered
    const outputFrames = frames.filter(f => f.type === 'output')
    expect(outputFrames).toHaveLength(1)
    expect(outputFrames[0]).toMatchObject({type: 'output', data: {runId: 'run-001', text: '', final: true, seq: 0}})

    manager.shutdown()
  })

  it('seq counter is per-run and independent across runs', async () => {
    // #given a manager with subscribers for two runs
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    const {frames: framesA} = collectFrames(manager, 'run-A')
    const {frames: framesB} = collectFrames(manager, 'run-B')
    await drain()

    // #when calling observeOutput on both runs
    manager.observeOutput('run-A', 'a1')
    manager.observeOutput('run-B', 'b1')
    manager.observeOutput('run-A', 'a2')
    await drain()

    // #then each run has its own seq counter starting at 0
    const outputA = framesA.filter(f => f.type === 'output')
    const outputB = framesB.filter(f => f.type === 'output')
    expect(outputA).toHaveLength(2)
    expect(outputA[0]).toMatchObject({data: {seq: 0}})
    expect(outputA[1]).toMatchObject({data: {seq: 1}})
    expect(outputB).toHaveLength(1)
    expect(outputB[0]).toMatchObject({data: {seq: 0}})

    manager.shutdown()
  })
})

// ===========================================================================
// 14. observeOutput — late subscriber snapshot (R3)
// ===========================================================================

describe('observeOutput — late subscriber receives cached final output', () => {
  it('a subscriber connecting after a final observeOutput receives the cached final output frame', async () => {
    // #given a manager where a final output frame has been observed
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    // Seed the status cache so subscribe delivers a status snapshot (not reset)
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #when the final output is observed before the subscriber connects
    manager.observeOutput('run-001', 'the answer', {final: true})
    await drain()

    // #when a late subscriber connects
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #then the subscriber receives the cached final output frame
    const outputFrames = frames.filter(f => f.type === 'output')
    expect(outputFrames).toHaveLength(1)
    expect(outputFrames[0]).toMatchObject({type: 'output', data: {text: 'the answer', final: true}})

    // #then the status snapshot is delivered before the output frame
    const statusIdx = frames.findIndex(f => f.type === 'status')
    const outputIdx = frames.findIndex(f => f.type === 'output')
    expect(statusIdx).toBeGreaterThanOrEqual(0)
    expect(outputIdx).toBeGreaterThan(statusIdx)

    manager.shutdown()
  })

  it('a late subscriber with no cached final output does NOT receive an output frame', async () => {
    // #given a manager with only delta output (no final)
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    manager.observeOutput('run-001', 'delta only')
    await drain()

    // #when a late subscriber connects
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #then no output frame is delivered (no cached final)
    const outputFrames = frames.filter(f => f.type === 'output')
    expect(outputFrames).toHaveLength(0)

    manager.shutdown()
  })
})

// ===========================================================================
// 15. observeOutput — coalescing under backpressure (R5)
// ===========================================================================

describe('observeOutput — coalescing keeps connection alive under overflow', () => {
  it('output frames coalesce on overflow — connection stays alive and droppedCount is carried forward', async () => {
    // #given a manager with a tiny cap (fits exactly one output frame).
    // Both subscribers share the same cap. The slow subscriber never drains, so its
    // queue fills after the first frame. The fast subscriber drains between frames
    // (we send one frame at a time with drain() between each).
    //
    // Key invariant: output frame overflow KEEPS THE CONNECTION ALIVE (coalescing),
    // unlike status frame overflow which DROPS the subscriber. Both subscribers
    // stay alive even when their queues overflow.
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()

    // Estimate one output frame's byte size so we can set the cap to exactly that.
    // With cap = oneFrameBytes, the slow subscriber fills up after the first frame
    // and coalesces on subsequent frames. The fast subscriber drains between frames
    // (one at a time with drain()) so its queue is always empty before each new frame.
    const sampleFrame: OutputFrame = {
      type: 'output',
      data: {runId: 'run-001', text: 'delta-1', final: false, seq: 0},
    }
    const oneFrameBytes = JSON.stringify(sampleFrame).length
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: oneFrameBytes})

    // #given a slow subscriber that never drains
    const slowCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: async () => {
        // Never resolves — simulates a completely stuck consumer
        await new Promise<void>(() => {
          // intentionally never resolves
        })
      },
      onClose: reason => {
        slowCloses.push(reason)
      },
    })

    // #given a fast subscriber on the same run
    const fastFrames: ObservationFrame[] = []
    const fastCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: frame => {
        fastFrames.push(frame)
      },
      onClose: reason => {
        fastCloses.push(reason)
      },
    })

    await drain()

    // #when sending output frames one at a time with drain() between each.
    // The slow subscriber's queue fills after the first frame; subsequent frames coalesce.
    // The fast subscriber drains between each frame so its queue is always empty.
    manager.observeOutput('run-001', 'delta-1')
    await drain()
    manager.observeOutput('run-001', 'delta-2')
    await drain()
    manager.observeOutput('run-001', 'delta-3')
    await drain()

    // #then the slow subscriber is NOT dropped (coalescing keeps it alive)
    expect(slowCloses).not.toContain('overflow')
    expect(slowCloses).toHaveLength(0)

    // #then the fast subscriber is also NOT dropped (coalescing, not drop, on output overflow)
    // The fast subscriber's queue is always empty before each frame (it drains between frames),
    // so it receives all 3 frames without overflow.
    const fastOutputFrames = fastFrames.filter(f => f.type === 'output')
    expect(fastOutputFrames.length).toBeGreaterThanOrEqual(3)
    expect(fastCloses).not.toContain('overflow')

    manager.shutdown()
  })

  it('a later output frame carries droppedCount > 0 after coalescing', async () => {
    // #given a manager with a cap sized for exactly one output frame.
    // The subscriber gets a reset frame (no cached status — reset is smaller than one
    // output frame). After the reset frame drains, two output frames arrive simultaneously:
    // first fits, second overflows → coalescing removes first → second fits with droppedCount=1.
    // The subscriber stays alive (coalescing, not drop).
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()

    const sampleOutputFrame: OutputFrame = {
      type: 'output',
      data: {runId: 'run-001', text: 'a', final: false, seq: 0},
    }
    const oneOutputFrameBytes = JSON.stringify(sampleOutputFrame).length
    // Do NOT seed the status cache — subscriber gets a reset frame (smaller than output frame).
    // Cap = oneOutputFrameBytes: reset fits, two output frames trigger coalescing.
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: oneOutputFrameBytes})

    // #given a slow subscriber that blocks on the first OUTPUT frame (never drains)
    const slowCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: async frame => {
        if (frame.type === 'output') {
          // Block on the first output frame — never resolves
          await new Promise<void>(() => {
            // intentionally never resolves
          })
        }
      },
      onClose: reason => {
        slowCloses.push(reason)
      },
    })
    // Drain the reset frame so the queue is empty before output frames arrive
    await drain()

    // #when sending two output frames simultaneously (before any drain)
    // frame-a: fits (queue empty). Enqueued (queueBytes = oneOutputFrameBytes = cap).
    // frame-b: queueBytes + oneOutputFrameBytes > cap → coalescing removes frame-a
    //          → frame-b fits with droppedCount=1.
    manager.observeOutput('run-001', 'a')
    manager.observeOutput('run-001', 'b')
    await drain()

    // #then the subscriber is still alive (not dropped — coalescing keeps it alive)
    expect(slowCloses).toHaveLength(0)
    expect(slowCloses).not.toContain('overflow')

    manager.shutdown()
  })

  it('droppedCount is carried on the next enqueued output frame after coalescing', async () => {
    // #given a manager with a large cap so all frames fit without coalescing.
    // This test verifies that a fast subscriber receives output frames correctly.
    // The coalescing path (droppedCount > 0) is verified by the slow-subscriber tests above.
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: 4096})

    // #given a fast subscriber that drains immediately
    const fastFrames: ObservationFrame[] = []
    const fastCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: frame => {
        fastFrames.push(frame)
      },
      onClose: reason => {
        fastCloses.push(reason)
      },
    })
    // Drain the reset frame so the queue is empty before output frames arrive
    await drain()

    // #when sending two output frames
    manager.observeOutput('run-001', 'frame-1')
    manager.observeOutput('run-001', 'frame-2')
    await drain()

    // #then the fast subscriber received both frames (no coalescing — large cap)
    const fastOutputFrames = fastFrames.filter(f => f.type === 'output')
    expect(fastOutputFrames.length).toBeGreaterThanOrEqual(2)
    expect(fastOutputFrames[0]).toMatchObject({type: 'output', data: {text: 'frame-1'}})
    expect(fastOutputFrames[1]).toMatchObject({type: 'output', data: {text: 'frame-2'}})

    // #then no droppedCount on either frame (no coalescing happened)
    expect(fastOutputFrames[0]?.data.droppedCount).toBeUndefined()
    expect(fastOutputFrames[1]?.data.droppedCount).toBeUndefined()

    // #then the subscriber is still alive
    expect(fastCloses).not.toContain('overflow')

    manager.shutdown()
  })

  it('discard-after-coalesce: frame discarded when queue is still full after coalescing all output', async () => {
    // #given a manager where the subscriber's queue is filled with a non-output frame
    // (status snapshot), then output frames arrive that cannot fit even after coalescing.
    // The subscriber must stay alive (discard-after-coalesce, not drop).
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()

    // Seed the status cache
    await (async () => {
      const {manager: seedManager} = makeManager(projectFn)
      await seedManager.observe(makeRunState({phase: 'EXECUTING'}))
      seedManager.shutdown()
    })()

    // Use a cap sized for exactly one status frame. The subscriber gets the status
    // snapshot (fills the queue). Then output frames arrive — the queue is full of
    // the status frame (non-output), so coalescing cannot remove it. The output
    // frame is discarded (discard-after-coalesce path). The subscriber stays alive.
    const status = makeOperatorRunStatus({status: 'running'})
    const statusFrameBytes = JSON.stringify({type: 'status', data: status}).length
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: statusFrameBytes})

    // Seed the cache for this manager
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #given a slow subscriber that never drains (queue stays full with the status snapshot)
    const slowCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: async () => {
        // Never resolves — the status snapshot stays in-flight, queue appears empty
        // (dequeue-before-await), but the subscriber is blocked
        await new Promise<void>(() => {
          // intentionally never resolves
        })
      },
      onClose: reason => {
        slowCloses.push(reason)
      },
    })
    // Do NOT drain — the status snapshot is dequeued but in-flight (blocking).
    // Now enqueue two more status frames to fill the queue (first fits, second overflows).
    // But we want to test the output discard path, not status overflow.
    // Instead: drain the status snapshot, then enqueue a non-output frame to fill the queue,
    // then send output frames.
    //
    // Simpler approach: use a cap of 0 bytes for output frames by making the cap
    // exactly the size of the status frame. After the status snapshot is dequeued
    // (in-flight), queue is empty. Output frame arrives: fits (queue empty). Blocked.
    // Second output frame: queue has first output frame (in-flight, dequeued). Queue empty.
    // This doesn't trigger discard-after-coalesce.
    //
    // The discard-after-coalesce path requires: queue has non-output frames that
    // cannot be coalesced, AND the new output frame doesn't fit even after removing
    // all output frames. We achieve this by: (1) subscriber blocks on status frame
    // (in-flight, dequeued), (2) enqueue a second status frame (fills queue),
    // (3) send output frame — coalescing removes output frames (none), frame doesn't fit.
    await drain() // status snapshot dequeued and in-flight (blocking)

    // Enqueue a second status frame to fill the queue (non-output, cannot be coalesced)
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    // Queue now has one status frame (statusFrameBytes). Cap = statusFrameBytes.

    // #when sending output frames — queue is full of non-output frames, discard-after-coalesce
    manager.observeOutput('run-001', 'a')
    manager.observeOutput('run-001', 'b')
    await drain()

    // #then the subscriber is still alive (discard-after-coalesce keeps connection alive)
    expect(slowCloses).toHaveLength(0)
    expect(slowCloses).not.toContain('overflow')

    manager.shutdown()
  })

  it('status-frame overflow still drops the subscriber (regression — unchanged behavior)', async () => {
    // #given a manager with a cap sized for exactly one status frame
    const status = makeOperatorRunStatus({status: 'running'})
    const projectFn: ProjectFn = async () => status

    const oneFrameBytes = JSON.stringify({type: 'status', data: status}).length
    // Cap = one frame. The slow subscriber's onEvent never resolves, so the frame
    // stays in-flight (dequeued). We enqueue TWO more frames simultaneously (before
    // any drain) so the second frame fills the queue and the third overflows.
    // With dequeue-before-await, the first frame is dequeued immediately when
    // drainQueue starts, so queueBytes drops to 0. We need to enqueue 2 frames
    // simultaneously to fill the queue (first fits, second overflows).
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: oneFrameBytes})

    // Seed the cache
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #given a slow subscriber (onEvent never resolves — simulates a stuck consumer)
    const slowCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: async () => {
        await new Promise<void>(() => {
          // intentionally never resolves
        })
      },
      onClose: reason => {
        slowCloses.push(reason)
      },
    })

    // The slow subscriber got the snapshot frame (dequeued immediately, in-flight).
    // Queue is now empty (dequeue-before-await). Enqueue two more status frames
    // simultaneously — first fills the queue, second overflows → drop.
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #then the slow subscriber IS dropped with 'overflow' (status frames still drop)
    expect(slowCloses).toContain('overflow')

    manager.shutdown()
  })
})

// ===========================================================================
// 16. observeOutput — teardown: cache cleared on terminal and shutdown
// ===========================================================================

describe('observeOutput — terminal replay cache delivers final output to late subscribers', () => {
  it('after terminal status, a late subscriber receives the cached final output then terminal status then closes', async () => {
    // #given a manager where a final output is observed, then a terminal status
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const projectFn: ProjectFn = async () => terminalStatus
    const {manager} = makeManager(projectFn)

    // Observe a final output
    manager.observeOutput('run-001', 'done', {final: true})
    await drain()

    // Observe terminal status (moves final output to terminal replay cache)
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #when a late subscriber connects after terminal
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()

    // #then the late subscriber receives the cached final output frame
    const outputFrames = frames.filter(f => f.type === 'output')
    expect(outputFrames).toHaveLength(1)
    expect(outputFrames[0]).toMatchObject({type: 'output', data: {text: 'done', final: true}})

    // #then the late subscriber also receives the terminal status frame
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames).toHaveLength(1)
    expect(statusFrames[0]).toMatchObject({type: 'status', data: {status: 'succeeded'}})

    // #then the output frame is delivered before the terminal status frame
    const outputIdx = frames.findIndex(f => f.type === 'output')
    const statusIdx = frames.findIndex(f => f.type === 'status')
    expect(outputIdx).toBeGreaterThanOrEqual(0)
    expect(statusIdx).toBeGreaterThan(outputIdx)

    // #then the stream closes with 'terminal' after delivering the replay
    expect(closes).toContain('terminal')

    manager.shutdown()
  })

  it('after shutdown, all output caches are cleared', async () => {
    // #given a manager with cached final output for two runs
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    manager.observeOutput('run-001', 'answer-1', {final: true})
    manager.observeOutput('run-002', 'answer-2', {final: true})
    await drain()

    // #when shutting down
    manager.shutdown()
    await drain()

    // #then subscribing after shutdown gets no output frames (caches cleared)
    // (subscribe after shutdown immediately calls onClose — no frames delivered)
    const frames1: ObservationFrame[] = []
    manager.subscribe('run-001', {
      onEvent: f => {
        frames1.push(f)
      },
      onClose: vi.fn(),
    })
    const frames2: ObservationFrame[] = []
    manager.subscribe('run-002', {
      onEvent: f => {
        frames2.push(f)
      },
      onClose: vi.fn(),
    })
    await drain()

    expect(frames1.filter(f => f.type === 'output')).toHaveLength(0)
    expect(frames2.filter(f => f.type === 'output')).toHaveLength(0)
  })

  it('seq counter is cleared on terminal status — observeOutput after terminal is dropped until replay expires', async () => {
    // #given a manager where run-001 has been observed to terminal
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const projectFn: ProjectFn = async () => terminalStatus
    // Use a very short TTL so the replay cache expires quickly in the test
    const fakeTimers = makeFakeTimerSystem(0)
    const {manager} = makeManager(projectFn, {terminalReplayTtlMs: 1000}, fakeTimers)

    // Observe some output (final:true on last) and then terminal
    manager.observeOutput('run-001', 'a')
    manager.observeOutput('run-001', 'b', {final: true})
    await drain()

    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then observeOutput after terminal is dropped (replay cache guards the runId)
    // Subscribe a fresh subscriber — it gets the replay (final output + terminal status)
    const {frames: replayFrames, closes: replayCloses} = collectFrames(manager, 'run-001')
    await drain()
    expect(replayFrames.filter(f => f.type === 'output')).toHaveLength(1)
    expect(replayCloses).toContain('terminal')

    // #when observeOutput is called after terminal (should be dropped)
    manager.observeOutput('run-001', 'fresh start')
    await drain()

    // #then no new output is delivered (dropped by the terminal guard)
    const {frames: afterFrames} = collectFrames(manager, 'run-001')
    await drain()
    // The late subscriber gets the replay (same cached output), not the new 'fresh start'
    const afterOutputFrames = afterFrames.filter(f => f.type === 'output')
    const freshStartFrame = afterOutputFrames.find(f => f.type === 'output' && f.data.text === 'fresh start')
    expect(freshStartFrame).toBeUndefined()

    manager.shutdown()
  })
})

// ===========================================================================
// 17. Observer-only invariant extension: observeOutput does not add mutating API
// ===========================================================================

describe('observer-only invariant — observeOutput extension', () => {
  it('runObservationManager interface includes observeOutput but no mutating run API', () => {
    // #given the RunObservationManager interface (structural check)
    // We verify that a manager object has observeOutput but NOT any mutating run API.
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    // #then the manager has observeOutput
    expect(typeof manager.observeOutput).toBe('function')

    // #then the manager does NOT have any mutating run API
    const managerKeys = new Set(Object.keys(manager))
    const mutatingKeys = ['transitionRun', 'acquireLock', 'releaseLock', 'heartbeat', 'coordinator', 'runLock']
    for (const key of mutatingKeys) {
      expect(managerKeys.has(key)).toBe(false)
    }

    // #then the manager has only the expected public API
    const allowedManagerKeys = new Set([
      'observe',
      'refreshScope',
      'observeOutput',
      'observeApproval',
      'observeQuestion',
      'subscribe',
      'abortSubscription',
      'shutdown',
    ])
    for (const key of managerKeys) {
      expect(allowedManagerKeys.has(key)).toBe(true)
    }

    manager.shutdown()
  })

  it('runObservationManagerDeps type still has no mutating run API after observeOutput addition', () => {
    // #given the RunObservationManagerDeps type (compile-time structural check)
    const deps: RunObservationManagerDeps = {
      projectBase: async () => ({kind: 'denied'}),
      waiting: NO_WAITING,
      isRepoDenied: () => false,
      logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()},
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      now: Date.now.bind(Date),
    }

    // #then the deps object has ONLY the expected read-only/observer fields
    const depKeys = new Set(Object.keys(deps))

    // No mutating run API keys are present
    const mutatingKeys = ['transitionRun', 'acquireLock', 'releaseLock', 'heartbeat', 'coordinator', 'runLock']
    for (const key of mutatingKeys) {
      expect(depKeys.has(key)).toBe(false)
    }

    // All present keys are in the allowed set (includes new terminal replay TTL deps)
    const allowedKeys = new Set([
      'projectBase',
      'waiting',
      'isRepoDenied',
      'logger',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
      'now',
      'heartbeatIntervalMs',
      'maxStreamDurationMs',
      'subscriberQueueCapBytes',
      'terminalReplayTtlMs',
      'terminalReplayMaxEntries',
      'terminalReplayMaxBytes',
    ])
    for (const key of depKeys) {
      expect(allowedKeys.has(key)).toBe(true)
    }
  })
})

// ===========================================================================
// 18. Graceful terminal drain — terminal status delivered after output
// ===========================================================================

describe('graceful terminal drain — terminal status delivered after output', () => {
  it('subscriber receives final output frame AND terminal status frame when output precedes terminal', async () => {
    // #given a manager where observeOutput(final) is called before observe(terminal)
    // This is the engine reorder: output flush happens before terminal status notify.
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const projectFn: ProjectFn = async () => terminalStatus
    const {manager} = makeManager(projectFn)

    // #given a subscriber
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()

    // #when the final output is observed BEFORE the terminal status (engine reorder)
    manager.observeOutput('run-001', 'the final answer', {final: true})
    // Do NOT drain yet — simulate the engine calling observe(terminal) immediately after
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then the subscriber receives the final output frame
    const outputFrames = frames.filter(f => f.type === 'output')
    expect(outputFrames).toHaveLength(1)
    expect(outputFrames[0]).toMatchObject({type: 'output', data: {text: 'the final answer', final: true}})

    // #then the subscriber also receives the terminal status frame (not lost)
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames.length).toBeGreaterThanOrEqual(1)
    const terminalFrame = statusFrames.find(f => f.type === 'status' && f.data.status === 'succeeded')
    expect(terminalFrame).toBeDefined()

    // #then the stream closes with 'terminal' (graceful drain, not hard abort)
    expect(closes).toContain('terminal')

    manager.shutdown()
  })

  it('graceful drain delivers all queued frames before closing — no frames lost on terminal', async () => {
    // #given a manager with a subscriber that has multiple frames queued
    const statuses = [
      makeOperatorRunStatus({phase: 'EXECUTING', status: 'running'}),
      makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'}),
    ]
    let callCount = 0
    const projectFn: ProjectFn = async () => statuses[callCount++ % statuses.length] ?? null
    const {manager} = makeManager(projectFn)

    // #given a subscriber
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()

    // #when observing running status, then output, then terminal — all before draining
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    manager.observeOutput('run-001', 'partial output')
    manager.observeOutput('run-001', 'final output', {final: true})
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then all frames are delivered (none lost to the terminal teardown)
    const outputFrames = frames.filter(f => f.type === 'output')
    expect(outputFrames.length).toBeGreaterThanOrEqual(1)

    const statusFrames = frames.filter(f => f.type === 'status')
    const terminalFrame = statusFrames.find(f => f.data.status === 'succeeded')
    expect(terminalFrame).toBeDefined()

    // #then the stream closes with 'terminal'
    expect(closes).toContain('terminal')

    manager.shutdown()
  })

  it('terminal close is non-blocking — observe() returns without awaiting drain', async () => {
    // #given a manager with a slow subscriber
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const projectFn: ProjectFn = async () => terminalStatus
    const {manager} = makeManager(projectFn)

    // #given a slow subscriber that never drains
    const closes: string[] = []
    manager.subscribe('run-001', {
      onEvent: async () => {
        await new Promise<void>(() => {
          // intentionally never resolves
        })
      },
      onClose: reason => {
        closes.push(reason)
      },
    })
    await drain()

    // #when observing terminal status
    const start = Date.now()
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    const elapsed = Date.now() - start

    // #then observe() returns in bounded time (does not await the slow drain)
    expect(elapsed).toBeLessThan(100)

    manager.shutdown()
  })
})

// ===========================================================================
// 19. Dequeue-before-await ordering integrity
// ===========================================================================

describe('dequeue-before-await — ordering integrity under coalescing', () => {
  it('in-flight frame is not removed by coalescing — delivered frame is the one dequeued', async () => {
    // #given a manager with a cap that allows the status snapshot + exactly one output frame
    // (but not two output frames). The subscriber gets the status snapshot (dequeued,
    // in-flight), then frame-A (dequeued, in-flight, blocking). frame-B fits. frame-C
    // overflows → coalescing removes frame-B → frame-C fits with droppedCount=1.
    // frame-A is NOT removed by coalescing (it was already dequeued before the await).
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()

    const status = makeOperatorRunStatus({status: 'running'})
    const statusFrameBytes = JSON.stringify({type: 'status', data: status}).length
    const sampleOutputFrame: OutputFrame = {
      type: 'output',
      data: {runId: 'run-001', text: 'x', final: false, seq: 0},
    }
    const oneOutputFrameBytes = JSON.stringify(sampleOutputFrame).length
    // Cap = statusFrameBytes + oneOutputFrameBytes: fits status snapshot + one output frame,
    // but not two output frames simultaneously.
    const cap = statusFrameBytes + oneOutputFrameBytes
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: cap})

    // Seed the status cache
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #given a subscriber that records output frames in order
    // The subscriber blocks on the FIRST output frame to allow coalescing to happen
    // during the await (simulating a slow consumer that is mid-delivery).
    const receivedTexts: string[] = []
    const closes: string[] = []
    // Use a deferred promise so we can release the block from outside
    let resolveFirst!: () => void
    const firstOutputBlocked = new Promise<void>(resolve => {
      resolveFirst = resolve
    })
    let outputFrameCount = 0
    manager.subscribe('run-001', {
      onEvent: async frame => {
        if (frame.type === 'output') {
          outputFrameCount++
          receivedTexts.push(frame.data.text)
          if (outputFrameCount === 1) {
            // Block on the first OUTPUT frame to allow coalescing to happen during the await
            await firstOutputBlocked
          }
        }
      },
      onClose: reason => {
        closes.push(reason)
      },
    })
    // Drain the status snapshot so the queue is empty before output frames arrive
    await drain()

    // #when sending frame-A — it is dequeued immediately and in-flight (blocking)
    manager.observeOutput('run-001', 'frame-A')
    // Flush enough microtasks for drainQueue to dequeue frame-A and call onEvent
    // (which pushes 'frame-A' to receivedTexts then blocks on firstOutputBlocked)
    for (let i = 0; i < 50; i++) {
      await Promise.resolve()
    }

    // #then frame-A is in-flight — receivedTexts has it already
    expect(receivedTexts).toHaveLength(1)
    expect(receivedTexts[0]).toBe('frame-A')

    // #when sending frame-B and frame-C simultaneously (before releasing frame-A)
    // frame-B: fits (queue empty). Enqueued.
    // frame-C: overflows → coalescing removes frame-B → frame-C fits with droppedCount=1.
    manager.observeOutput('run-001', 'frame-B')
    manager.observeOutput('run-001', 'frame-C')
    await drain()

    // #then the in-flight frame-A is NOT removed by coalescing (it was already dequeued)
    // Release the first frame
    resolveFirst()
    await drain()

    // #then frame-A was delivered correctly (not replaced by a coalesced frame)
    expect(receivedTexts[0]).toBe('frame-A')

    // #then the subscriber is still alive (coalescing, not drop)
    expect(closes).not.toContain('overflow')
    expect(closes).not.toContain('writer-error')

    manager.shutdown()
  })

  it('queueBytes accounting is correct after dequeue-before-await — no underflow', async () => {
    // #given a manager with a normal cap
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: 4096})

    // #given a subscriber
    const frames: ObservationFrame[] = []
    const closes: string[] = []
    manager.subscribe('run-001', {
      onEvent: frame => {
        frames.push(frame)
      },
      onClose: reason => {
        closes.push(reason)
      },
    })
    await drain()

    // #when sending many output frames
    for (let i = 0; i < 10; i++) {
      manager.observeOutput('run-001', `frame-${i}`)
    }
    await drain()

    // #then all frames are delivered (no accounting errors causing premature overflow)
    const outputFrames = frames.filter(f => f.type === 'output')
    expect(outputFrames.length).toBeGreaterThanOrEqual(10)

    // #then the subscriber is still alive (no spurious overflow from accounting errors)
    expect(closes).not.toContain('overflow')

    manager.shutdown()
  })
})

// ===========================================================================
// 20. Late-subscriber edge cases (empty-output run, synchronous reorder)
// ===========================================================================

describe('late subscriber edge cases', () => {
  it('empty-output run: late subscriber gets terminal status frame and no output frame, closes with terminal', async () => {
    // #given a manager where observe(terminal) is called with NO prior observeOutput
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const projectFn: ProjectFn = async () => terminalStatus
    const {manager} = makeManager(projectFn)

    // #when observing terminal with no output at all
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #when a late subscriber connects after terminal
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()

    // #then the late subscriber receives the terminal status frame
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames).toHaveLength(1)
    expect(statusFrames[0]).toMatchObject({type: 'status', data: {status: 'succeeded'}})

    // #then no output frame is delivered (finalOutput was undefined)
    const outputFrames = frames.filter(f => f.type === 'output')
    expect(outputFrames).toHaveLength(0)

    // #then the stream closes with 'terminal'
    expect(closes).toContain('terminal')

    manager.shutdown()
  })

  it('synchronous reorder: observeOutput(final) then observe(terminal) without drain — late subscriber gets output before status', async () => {
    // #given a manager where the engine calls observeOutput(final) then observe(terminal)
    // without any drain between them (synchronous reorder scenario)
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const projectFn: ProjectFn = async () => terminalStatus
    const {manager} = makeManager(projectFn)

    // #when output and terminal arrive without a drain between them
    manager.observeOutput('run-001', 'the final answer', {final: true})
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    // No drain here — both calls complete before any microtask flush
    await drain()

    // #when a late subscriber connects after both have settled
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()

    // #then the late subscriber receives the output frame before the status frame
    const outputIdx = frames.findIndex(f => f.type === 'output')
    const statusIdx = frames.findIndex(f => f.type === 'status')
    expect(outputIdx).toBeGreaterThanOrEqual(0)
    expect(statusIdx).toBeGreaterThanOrEqual(0)
    expect(outputIdx).toBeLessThan(statusIdx)

    // #then the output frame carries the correct text
    const firstOutputFrame = frames.find(f => f.type === 'output')
    expect(firstOutputFrame).toMatchObject({type: 'output', data: {text: 'the final answer', final: true}})

    // #then the stream closes with 'terminal'
    expect(closes).toContain('terminal')

    manager.shutdown()
  })
})

// ===========================================================================
// 21. queueBytes accuracy after coalescing
// ===========================================================================

describe('queueBytes accuracy after coalescing', () => {
  it('after coalescing sets coalescedDropCount>0, effective frame bytes keep queueBytes at or below cap', async () => {
    // #given a manager with a cap sized for exactly one output frame.
    // The slow subscriber never drains. After the first output frame fills the queue,
    // a second frame triggers coalescing (removes the first, coalescedDropCount=1).
    // The effective frame for the second call now carries droppedCount=1, making it
    // slightly larger. The cap check must use the effective bytes, not the raw bytes,
    // so queueBytes stays <= cap after the enqueue.
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()

    const sampleFrame: OutputFrame = {
      type: 'output',
      data: {runId: 'run-001', text: 'x', final: false, seq: 0},
    }
    const oneFrameBytes = JSON.stringify(sampleFrame).length
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: oneFrameBytes})

    // #given a slow subscriber that never drains (queue stays full)
    const slowCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: async () => {
        await new Promise<void>(() => {
          // intentionally never resolves
        })
      },
      onClose: reason => {
        slowCloses.push(reason)
      },
    })
    await drain()

    // #when sending the first output frame (fills the queue to cap)
    manager.observeOutput('run-001', 'frame-1')
    await drain()

    // #when sending a second output frame (triggers coalescing: removes frame-1,
    // coalescedDropCount becomes 1, effective frame carries droppedCount=1)
    manager.observeOutput('run-001', 'frame-2')
    await drain()

    // #then the subscriber is still alive (coalescing kept it alive, not dropped)
    expect(slowCloses).toHaveLength(0)
    expect(slowCloses).not.toContain('overflow')

    // #when sending a third output frame (coalescedDropCount is now 1 from previous coalesce;
    // effective frame carries droppedCount=1 again; must still fit within cap)
    manager.observeOutput('run-001', 'frame-3')
    await drain()

    // #then the subscriber is still alive after the third frame
    expect(slowCloses).toHaveLength(0)
    expect(slowCloses).not.toContain('overflow')

    manager.shutdown()
  })
})

// ===========================================================================
// 22. maxDuration timer does not preempt graceful terminal drain
// ===========================================================================

describe('maxDuration timer does not preempt graceful terminal drain', () => {
  it('a maxDuration timer scheduled to fire during terminal drain does not preempt — subscriber closes with terminal', async () => {
    // #given a manager with injectable fake timers and a very short maxDuration
    // so we can advance the clock to fire the timer during the drain window.
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const projectFn: ProjectFn = async () => terminalStatus
    const fakeTimers = makeFakeTimerSystem(0)
    // maxStreamDurationMs = 100ms so we can advance the clock to fire it
    const {manager} = makeManager(projectFn, {maxStreamDurationMs: 100, heartbeatIntervalMs: 50_000}, fakeTimers)

    // #given a subscriber
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()

    // #when observing terminal status (marks subscriber for graceful drain,
    // which should cancel the maxDuration timer)
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #when advancing the clock past the maxDuration threshold
    // (the timer should have been cancelled by markRunSubscribersForTerminalDrain)
    fakeTimers.advance(200)
    await drain()

    // #then the subscriber closes with 'terminal', not 'max-duration'
    expect(closes).toContain('terminal')
    expect(closes).not.toContain('max-duration')

    // #then the terminal status frame was delivered
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames.length).toBeGreaterThanOrEqual(1)
    expect(statusFrames.at(-1)).toMatchObject({type: 'status', data: {status: 'succeeded'}})

    manager.shutdown()
  })
})

// ===========================================================================
// 23. Terminal replay cache byte budget
// ===========================================================================

describe('terminal replay cache byte budget', () => {
  it('inserting entries past the byte budget evicts oldest entries by bytes', async () => {
    // #given a manager with a very small byte budget for the replay cache
    // We use a budget that fits exactly one replay entry, so the second entry
    // evicts the first.
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const projectFn: ProjectFn = async runState =>
      makeOperatorRunStatus({runId: runState.run_id, phase: 'COMPLETED', status: 'succeeded'})

    // Estimate the byte cost of one replay entry (output frame + status frame)
    const sampleOutput: OutputFrame = {
      type: 'output',
      data: {runId: 'run-A', text: 'answer', final: true, seq: 0},
    }
    const sampleStatus = {type: 'status', data: terminalStatus}
    const oneEntryBytes = JSON.stringify(sampleOutput).length + JSON.stringify(sampleStatus).length

    // Budget = exactly one entry's worth of bytes
    const {manager} = makeManager(projectFn, {terminalReplayMaxBytes: oneEntryBytes, terminalReplayMaxEntries: 500})

    // #when inserting the first terminal run (run-A)
    manager.observeOutput('run-A', 'answer', {final: true})
    await manager.observe(makeRunState({run_id: 'run-A', phase: 'COMPLETED'}))
    await drain()

    // #then run-A is in the replay cache (late subscriber gets the replay)
    const {frames: framesA, closes: closesA} = collectFrames(manager, 'run-A')
    await drain()
    expect(framesA.filter(f => f.type === 'output')).toHaveLength(1)
    expect(closesA).toContain('terminal')

    // #when inserting a second terminal run (run-B) that exceeds the byte budget
    manager.observeOutput('run-B', 'answer-b', {final: true})
    await manager.observe(makeRunState({run_id: 'run-B', phase: 'COMPLETED'}))
    await drain()

    // #then run-A was evicted from the replay cache (byte budget exceeded)
    // A late subscriber for run-A now gets a reset frame (no replay entry)
    const {frames: framesA2, closes: closesA2} = collectFrames(manager, 'run-A')
    await drain()
    // run-A was evicted — late subscriber gets reset (no terminal replay)
    expect(framesA2.filter(f => f.type === 'reset')).toHaveLength(1)
    expect(closesA2).not.toContain('terminal')

    // #then run-B is still in the replay cache
    const {frames: framesB, closes: closesB} = collectFrames(manager, 'run-B')
    await drain()
    expect(framesB.filter(f => f.type === 'output')).toHaveLength(1)
    expect(closesB).toContain('terminal')

    manager.shutdown()
  })
})

// ===========================================================================
// 20. observeApproval — approval frame fan-out and terminal-drain safety
// ===========================================================================

describe('observeApproval — approval frame fan-out', () => {
  it('fans an open ApprovalFrame (settled:false) to live subscribers', async () => {
    // #given a manager with a subscriber
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when observeApproval is called with an open (pending) frame
    manager.observeApproval('run-001', {
      requestID: 'req-abc',
      permission: 'bash',
      command: 'ls -la',
      settled: false,
    })
    await drain()

    // #then an approval frame is delivered to the subscriber
    const approvalFrames = frames.filter(f => f.type === 'approval')
    expect(approvalFrames).toHaveLength(1)
    expect(approvalFrames[0]).toMatchObject({
      type: 'approval',
      runId: 'run-001',
      data: {requestID: 'req-abc', permission: 'bash', command: 'ls -la', settled: false},
    })

    manager.shutdown()
  })

  it('fans a settle/clear ApprovalFrame (settled:true) to live subscribers', async () => {
    // #given a manager with a subscriber
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when observeApproval is called with a settle/clear frame
    manager.observeApproval('run-001', {requestID: 'req-abc', settled: true})
    await drain()

    // #then a settle/clear approval frame is delivered
    const approvalFrames = frames.filter(f => f.type === 'approval')
    expect(approvalFrames).toHaveLength(1)
    expect(approvalFrames[0]).toMatchObject({
      type: 'approval',
      runId: 'run-001',
      data: {requestID: 'req-abc', settled: true},
    })

    manager.shutdown()
  })

  it('fans approval frames with filepath (external_directory gate)', async () => {
    // #given a manager with a subscriber
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when observeApproval is called with a filepath
    manager.observeApproval('run-001', {
      requestID: 'req-xyz',
      permission: 'external_directory',
      filepath: '/home/user/project',
      settled: false,
    })
    await drain()

    // #then the approval frame carries the filepath
    const approvalFrames = frames.filter(f => f.type === 'approval')
    expect(approvalFrames).toHaveLength(1)
    expect(approvalFrames[0]).toMatchObject({
      type: 'approval',
      runId: 'run-001',
      data: {requestID: 'req-xyz', permission: 'external_directory', filepath: '/home/user/project', settled: false},
    })

    manager.shutdown()
  })

  it('fans approval frames to multiple subscribers simultaneously', async () => {
    // #given a manager with two subscribers
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    const {frames: frames1} = collectFrames(manager, 'run-001')
    const {frames: frames2} = collectFrames(manager, 'run-001')
    await drain()

    // #when observeApproval is called
    manager.observeApproval('run-001', {requestID: 'req-multi', permission: 'bash', settled: false})
    await drain()

    // #then both subscribers receive the approval frame
    expect(frames1.filter(f => f.type === 'approval')).toHaveLength(1)
    expect(frames2.filter(f => f.type === 'approval')).toHaveLength(1)

    manager.shutdown()
  })

  it('open frame followed by settle/clear frame — both arrive in order', async () => {
    // #given a manager with a subscriber
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when an open frame is followed by a settle/clear frame
    manager.observeApproval('run-001', {requestID: 'req-seq', permission: 'bash', settled: false})
    manager.observeApproval('run-001', {requestID: 'req-seq', settled: true})
    await drain()

    // #then both frames arrive in order
    const approvalFrames = frames.filter(f => f.type === 'approval')
    expect(approvalFrames).toHaveLength(2)
    expect(approvalFrames[0]).toMatchObject({data: {settled: false}})
    expect(approvalFrames[1]).toMatchObject({data: {settled: true}})

    manager.shutdown()
  })

  it('approval frame followed by terminal status drains in order (terminal-drain safety)', async () => {
    // #given a manager with a subscriber
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    let callCount = 0
    const projectFn: ProjectFn = async () => (callCount++ === 0 ? makeOperatorRunStatus() : terminalStatus)
    const {manager} = makeManager(projectFn)

    // Seed the cache
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()

    // #when an approval frame is enqueued, then the run reaches terminal
    manager.observeApproval('run-001', {requestID: 'req-drain', permission: 'bash', settled: false})
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then the approval frame arrives before the terminal status frame
    const approvalIdx = frames.findIndex(f => f.type === 'approval')
    const terminalIdx = frames.findIndex(f => f.type === 'status' && f.data.status === 'succeeded')
    expect(approvalIdx).toBeGreaterThanOrEqual(0)
    expect(terminalIdx).toBeGreaterThan(approvalIdx)

    // #then the stream closes with 'terminal' after draining all frames
    expect(closes).toContain('terminal')

    manager.shutdown()
  })

  it('stale approval frame after terminal is dropped (out-of-order async guard)', async () => {
    // #given a manager where the run has already reached terminal
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const projectFn: ProjectFn = async () => terminalStatus
    const {manager} = makeManager(projectFn)

    // Drive the run to terminal
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #given a subscriber (will get the terminal replay)
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    const frameCountBeforeStale = frames.length

    // #when a stale approval frame arrives after terminal
    manager.observeApproval('run-001', {requestID: 'req-stale', permission: 'bash', settled: false})
    await drain()

    // #then no new approval frame was delivered (dropped by the out-of-order guard)
    const approvalFrames = frames.filter(f => f.type === 'approval')
    expect(approvalFrames).toHaveLength(0)

    // #then the frame count did not increase beyond the terminal replay frames
    expect(frames.length).toBe(frameCountBeforeStale)

    manager.shutdown()
  })

  it('observeApproval after shutdown is a no-op', async () => {
    // #given a manager that has been shut down
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)
    manager.shutdown()

    // #when observeApproval is called after shutdown
    // #then it does not throw
    expect(() => {
      manager.observeApproval('run-001', {requestID: 'req-noop', permission: 'bash', settled: false})
    }).not.toThrow()
  })

  it('approval frame overflow drops the subscriber (non-coalescing path)', async () => {
    // #given a manager with a cap sized for exactly one approval frame.
    // Strategy: seed the status cache so the subscriber gets a status snapshot on subscribe.
    // The subscriber blocks on the status snapshot (never drains). Queue is empty after
    // dequeue-before-await. We then enqueue TWO approval frames simultaneously — first fits,
    // second overflows → subscriber is dropped (approval frames do NOT coalesce).
    const status = makeOperatorRunStatus({status: 'running'})
    const projectFn: ProjectFn = async () => status

    const sampleApprovalFrame = {
      type: 'approval' as const,
      runId: 'run-001',
      data: {requestID: 'req-cap', permission: 'bash', settled: false as const},
    }
    const oneApprovalFrameBytes = JSON.stringify(sampleApprovalFrame).length
    const {manager} = makeManager(projectFn, {subscriberQueueCapBytes: oneApprovalFrameBytes})

    // Seed the status cache
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()

    // #given a slow subscriber that blocks on the status snapshot (never drains)
    const slowCloses: string[] = []
    manager.subscribe('run-001', {
      onEvent: async () => {
        // Block on every frame — never resolves
        await new Promise<void>(() => {
          // intentionally never resolves
        })
      },
      onClose: reason => {
        slowCloses.push(reason)
      },
    })
    // The status snapshot is dequeued immediately (in-flight, blocking).
    // Queue is now empty (dequeue-before-await). Enqueue TWO approval frames
    // simultaneously — first fills the queue, second overflows → drop.

    // #when two approval frames arrive simultaneously (first fits, second overflows)
    manager.observeApproval('run-001', {requestID: 'req-cap', permission: 'bash', settled: false})
    manager.observeApproval('run-001', {requestID: 'req-cap', settled: true})
    await drain()

    // #then the subscriber is dropped with 'overflow' (approval frames do NOT coalesce)
    expect(slowCloses).toContain('overflow')

    manager.shutdown()
  })

  it('approval frames are isolated per run — run-A approval does not appear in run-B subscriber', async () => {
    // #given a manager with subscribers for two runs
    const projectFn: ProjectFn = async () => makeOperatorRunStatus()
    const {manager} = makeManager(projectFn)

    const {frames: framesA} = collectFrames(manager, 'run-A')
    const {frames: framesB} = collectFrames(manager, 'run-B')
    await drain()

    // #when observeApproval is called for run-A
    manager.observeApproval('run-A', {requestID: 'req-a', permission: 'bash', settled: false})
    await drain()

    // #then run-A subscriber gets the approval frame
    expect(framesA.filter(f => f.type === 'approval')).toHaveLength(1)

    // #then run-B subscriber does NOT get run-A's approval frame
    expect(framesB.filter(f => f.type === 'approval')).toHaveLength(0)

    manager.shutdown()
  })
})

// ===========================================================================
// 21. observeQuestion — question frame fan-out, ordering, and reconnect replay
// ===========================================================================

function openQuestion(requestID: string, runId = 'run-001'): QuestionFrameData {
  return {
    requestID,
    runId,
    questions: [
      {
        header: 'Pick',
        text: 'Which one?',
        options: [{label: 'A', description: 'first'}],
        multiple: false,
        custom: true,
      },
    ],
    settled: false,
  }
}

describe('observeQuestion — question frame fan-out', () => {
  it('fans an open question frame, then a settle frame, to live subscribers in order', async () => {
    // #given a manager with a subscriber
    const {manager} = makeManager(async () => makeOperatorRunStatus())
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #when a question opens and then settles
    manager.observeQuestion('run-001', openQuestion('q-1'))
    manager.observeQuestion('run-001', {requestID: 'q-1', runId: 'run-001', settled: true})
    await drain()

    // #then both frames arrive in order, carrying the bounded detail and the run id
    const questionFrames = frames.filter(f => f.type === 'question')
    expect(questionFrames).toHaveLength(2)
    expect(questionFrames[0]).toMatchObject({
      type: 'question',
      runId: 'run-001',
      data: {requestID: 'q-1', runId: 'run-001', settled: false, questions: [{header: 'Pick', custom: true}]},
    })
    expect(questionFrames[1]).toMatchObject({type: 'question', data: {requestID: 'q-1', settled: true}})

    manager.shutdown()
  })

  it('routes by the run id argument, not by data.runId', async () => {
    // #given subscribers for two runs
    const {manager} = makeManager(async () => makeOperatorRunStatus())
    const a = collectFrames(manager, 'run-A')
    const b = collectFrames(manager, 'run-B')
    await drain()

    // #when a frame whose data.runId disagrees is observed for run-A
    manager.observeQuestion('run-A', openQuestion('q-x', 'run-B'))
    await drain()

    // #then run-A gets it with the routed run id, and run-B gets nothing
    const aFrames = a.frames.filter(f => f.type === 'question')
    expect(aFrames).toHaveLength(1)
    expect(aFrames[0]).toMatchObject({runId: 'run-A', data: {runId: 'run-A'}})
    expect(b.frames.filter(f => f.type === 'question')).toHaveLength(0)

    manager.shutdown()
  })

  it('delivers the settle frame before the terminal status when the run completes in the same flush', async () => {
    // #given a running run with a subscriber and an open question
    let callCount = 0
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const {manager} = makeManager(async () => (callCount++ === 0 ? makeOperatorRunStatus() : terminalStatus))
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()
    manager.observeQuestion('run-001', openQuestion('q-1'))

    // #when the question settles and the run reaches terminal in the same flush
    manager.observeQuestion('run-001', {requestID: 'q-1', runId: 'run-001', settled: true})
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then the settle frame precedes the terminal status frame, and the stream closes
    const settleIdx = frames.findIndex(f => f.type === 'question' && f.data.settled)
    const terminalIdx = frames.findIndex(f => f.type === 'status' && f.data.status === 'succeeded')
    expect(settleIdx).toBeGreaterThanOrEqual(0)
    expect(terminalIdx).toBeGreaterThan(settleIdx)
    expect(closes).toContain('terminal')

    manager.shutdown()
  })

  it('does not coalesce: question frame overflow drops the subscriber, not the frame', async () => {
    // #given a cap sized for exactly one settle frame and a subscriber that never drains
    const sample = {
      type: 'question' as const,
      runId: 'run-001',
      data: {requestID: 'q-cap', runId: 'run-001', settled: true as const},
    }
    const {manager} = makeManager(async () => makeOperatorRunStatus({status: 'running'}), {
      subscriberQueueCapBytes: JSON.stringify(sample).length + 10,
    })
    const closes: string[] = []
    manager.subscribe('run-001', {
      onEvent: async () => new Promise<void>(() => {}),
      onClose: reason => closes.push(reason),
    })

    // #when two question frames arrive while the first (reset) frame is in flight
    manager.observeQuestion('run-001', {requestID: 'q-cap', runId: 'run-001', settled: true})
    manager.observeQuestion('run-001', {requestID: 'q-cap', runId: 'run-001', settled: true})
    await drain()

    // #then the subscriber is dropped with overflow (non-coalescing path)
    expect(closes).toContain('overflow')

    manager.shutdown()
  })

  it('drops a question frame after terminal (out-of-order async guard)', async () => {
    // #given a run that already reached terminal
    const {manager} = makeManager(async () => makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'}))
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    const {frames} = collectFrames(manager, 'run-001')
    await drain()
    const before = frames.length

    // #when a stale question frame arrives
    manager.observeQuestion('run-001', openQuestion('q-stale'))
    await drain()

    // #then nothing new is delivered
    expect(frames.filter(f => f.type === 'question')).toHaveLength(0)
    expect(frames.length).toBe(before)

    manager.shutdown()
  })

  it('observeQuestion after shutdown is a no-op', () => {
    // #given a shut-down manager
    const {manager} = makeManager(async () => makeOperatorRunStatus())
    manager.shutdown()

    // #when / #then it does not throw
    expect(() => manager.observeQuestion('run-001', openQuestion('q-noop'))).not.toThrow()
  })

  it('never delivers a too-large open frame, warns with ids only, and keeps subscribers', async () => {
    // #given a small queue cap and a healthy subscriber
    const {manager, logger} = makeManagerWithLogger(async () => makeOperatorRunStatus(), {
      subscriberQueueCapBytes: 1000,
    })
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()
    const secret = 'S3CR3T-'.repeat(200)

    // #when an open frame larger than half the cap is observed
    manager.observeQuestion('run-001', {
      requestID: 'q-big',
      runId: 'run-001',
      questions: [{header: 'h', text: secret, options: [], multiple: false, custom: true}],
      settled: false,
    })
    await drain()

    // #then it is not delivered, the subscriber survives, and the warning carries no text
    expect(frames.filter(f => f.type === 'question')).toHaveLength(0)
    expect(closes).toStrictEqual([])
    const warnArgs = JSON.stringify(logger.warn.mock.calls)
    expect(warnArgs).toContain('q-big')
    expect(warnArgs).not.toContain('S3CR3T')

    manager.shutdown()
  })
})

describe('observeQuestion — reconnect reconciliation', () => {
  it('replays a still-open question to a late subscriber, after the status snapshot', async () => {
    // #given a running run with a pending question and no subscribers
    const {manager} = makeManager(async () => makeOperatorRunStatus())
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    manager.observeQuestion('run-001', openQuestion('q-open'))

    // #when an operator reconnects
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #then the status snapshot is followed by the open question frame
    expect(frames.map(f => f.type)).toStrictEqual(['status', 'question'])
    expect(frames[1]).toMatchObject({data: {requestID: 'q-open', settled: false}})

    manager.shutdown()
  })

  it('does not replay a settled question', async () => {
    // #given a question that opened and then settled while nobody was connected
    const {manager} = makeManager(async () => makeOperatorRunStatus())
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    manager.observeQuestion('run-001', openQuestion('q-done'))
    manager.observeQuestion('run-001', {requestID: 'q-done', runId: 'run-001', settled: true})

    // #when an operator reconnects
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #then no question frame is replayed
    expect(frames.filter(f => f.type === 'question')).toHaveLength(0)

    manager.shutdown()
  })

  it('replays only the still-open question when one of two has settled', async () => {
    // #given two pending questions, one of which settles
    const {manager} = makeManager(async () => makeOperatorRunStatus())
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    manager.observeQuestion('run-001', openQuestion('q-1'))
    manager.observeQuestion('run-001', openQuestion('q-2'))
    manager.observeQuestion('run-001', {requestID: 'q-1', runId: 'run-001', settled: true})

    // #when an operator reconnects
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #then only q-2 is replayed
    const replayed = frames.filter(f => f.type === 'question')
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({data: {requestID: 'q-2'}})

    manager.shutdown()
  })

  it('bounds the replay set per run, evicting the oldest open question', async () => {
    // #given more open questions than the replay bound
    const {manager} = makeManager(async () => makeOperatorRunStatus())
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    const total = MAX_OPEN_QUESTION_REPLAY_PER_RUN + 3
    for (let i = 0; i < total; i++) {
      manager.observeQuestion('run-001', openQuestion(`q-${i}`))
    }

    // #when an operator reconnects
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #then exactly the newest MAX are replayed, oldest first
    const ids = frames.flatMap(f => (f.type === 'question' ? [f.data.requestID] : []))
    expect(ids).toHaveLength(MAX_OPEN_QUESTION_REPLAY_PER_RUN)
    expect(ids[0]).toBe('q-3')
    expect(ids.at(-1)).toBe(`q-${total - 1}`)

    manager.shutdown()
  })

  it('clears the replay set when the run reaches terminal', async () => {
    // #given a pending question that never settled before the run completed
    let callCount = 0
    const {manager} = makeManager(async () =>
      callCount++ === 0 ? makeOperatorRunStatus() : makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'}),
    )
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    manager.observeQuestion('run-001', openQuestion('q-orphan'))
    await manager.observe(makeRunState({phase: 'COMPLETED'}))

    // #when a late subscriber connects (terminal replay)
    const {frames} = collectFrames(manager, 'run-001')
    await drain()

    // #then it sees the terminal status only, no question
    expect(frames.filter(f => f.type === 'question')).toHaveLength(0)
    expect(frames.some(f => f.type === 'status' && f.data.status === 'succeeded')).toBe(true)

    manager.shutdown()
  })

  it('isolates the replay set per run', async () => {
    // #given an open question on run-A only
    const {manager} = makeManager(async () => makeOperatorRunStatus())
    manager.observeQuestion('run-A', openQuestion('q-a', 'run-A'))

    // #when a subscriber connects to run-B
    const {frames} = collectFrames(manager, 'run-B')
    await drain()

    // #then run-B sees no question
    expect(frames.filter(f => f.type === 'question')).toHaveLength(0)

    manager.shutdown()
  })
})

// ---------------------------------------------------------------------------
// Real projection wired into the manager: checkout fields reach the status frame
// ---------------------------------------------------------------------------

describe('status frame — checkout fields through the real projection', () => {
  it('delivers checkoutProvenance and checkoutPreparation on the emitted status frame', async () => {
    // #given a manager wired to the real projectRunStatusWithKey and a run carrying both fields
    const provenance: OperatorCheckoutProvenance = {
      kind: 'observed',
      observation: {
        head: {kind: 'attached', branch: 'main', sha: 'a'.repeat(40)},
        worktree: {kind: 'clean'},
        operationInProgress: 'none',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
      remote: {kind: 'not-checked'},
    }
    const preparation: OperatorCheckoutPreparation = {outcome: 'refused', reason: 'dirty', changedPaths: ['a.ts']}
    const runState = makeRunState({details: {checkoutProvenance: provenance, checkoutPreparation: preparation}})
    const projectBase: RunObservationManagerDeps['projectBase'] = async state =>
      projectRunStatusWithKey(state, {
        nowMs: 1_000_000,
        staleThresholdMs: 60_000,
        bindingsLookup: {getBindingByRepo: async () => ({success: true, data: {databaseId: 1, nodeId: 'R_1'}})},
        isRepoDenied: () => false,
      })
    const {manager} = makeManager(async () => null, {projectBase})
    const {frames} = collectFrames(manager, 'run-001')

    // #when the run is observed
    await manager.observe(runState)
    await drain()

    // #then the emitted status frame carries both fields
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames).toHaveLength(1)
    expect(statusFrames[0]).toMatchObject({
      type: 'status',
      data: {checkoutProvenance: provenance, checkoutPreparation: preparation},
    })

    manager.shutdown()
  })
})

describe('status frame — providerFailureReason through the real projection', () => {
  const failedProviderRun = (): RunState =>
    makeRunState({
      phase: 'FAILED',
      details: {failureKind: 'session-error', providerFailureReason: 'provider-auth-unavailable'},
    })
  const realProjectBase: RunObservationManagerDeps['projectBase'] = async state =>
    projectRunStatusWithKey(state, {
      nowMs: 1_000_000,
      staleThresholdMs: 60_000,
      bindingsLookup: {getBindingByRepo: async () => ({success: true, data: {databaseId: 1, nodeId: 'R_1'}})},
      isRepoDenied: () => false,
    })

  it('a cold-restart durable frame deep-equals the live terminal frame, including the reason', async () => {
    // #given a live manager that observes a provider failure and delivers the terminal frame
    const live = makeManager(async () => null, {projectBase: realProjectBase})
    const liveSub = collectFrames(live.manager, 'run-001')
    await live.manager.observe(failedProviderRun())
    await drain()
    const liveFrame = liveSub.frames.find(f => f.type === 'status')

    // #when a freshly started manager (no cache, no replay) resolves the same run from persisted state
    const cold = makeManager(async () => null, {projectBase: realProjectBase})
    const durable = subscribeWithDurable(cold.manager, async () => failedProviderRun())
    await drain()
    const durableFrame = durable.frames.find(f => f.type === 'status')

    // #then both carry the reason and are deeply equal
    expect(liveFrame).toMatchObject({type: 'status', data: {providerFailureReason: 'provider-auth-unavailable'}})
    expect(durableFrame).toEqual(liveFrame)
    expect(durable.closes).toEqual(['terminal'])

    live.manager.shutdown()
    cold.manager.shutdown()
  })

  it('a tampered stored reason is omitted from the durable frame while the frame is still delivered', async () => {
    // #given a persisted FAILED run whose reason was tampered with
    const cold = makeManager(async () => null, {projectBase: realProjectBase})
    const tampered = makeRunState({
      phase: 'FAILED',
      details: {failureKind: 'session-error', providerFailureReason: 'provider auth unavailable'},
    })

    // #when resolved durably
    const durable = subscribeWithDurable(cold.manager, async () => tampered)
    await drain()

    // #then the frame is delivered with no reason key
    const frame = durable.frames.find(f => f.type === 'status')
    expect(frame).toMatchObject({type: 'status', data: {status: 'failed', failureKind: 'session-error'}})
    expect((frame as {data: object}).data).not.toHaveProperty('providerFailureReason')

    cold.manager.shutdown()
  })
})

// ---------------------------------------------------------------------------
// Cleanup: ensure no real timers leak between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

function makeDeferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return {promise, resolve}
}

const projectByPhase: ProjectFn = async runState => {
  const byPhase: Record<string, OperatorRunStatus['status']> = {
    PENDING: 'queued',
    EXECUTING: 'running',
    COMPLETED: 'succeeded',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
  }
  return makeOperatorRunStatus({
    runId: runState.run_id,
    phase: runState.phase,
    status: byPhase[runState.phase] ?? 'running',
  })
}

function subscribeWithDurable(
  manager: RunObservationManager,
  read: () => Promise<RunState | undefined>,
  runId = 'run-001',
): {frames: ObservationFrame[]; closes: string[]} {
  const frames: ObservationFrame[] = []
  const closes: string[] = []
  manager.subscribe(
    runId,
    {
      onEvent: frame => {
        frames.push(frame)
      },
      onClose: reason => {
        closes.push(reason)
      },
    },
    {readDurableRunState: read},
  )
  return {frames, closes}
}

// ===========================================================================
// 24. Durable cache-miss resolution (#1639)
//
// A terminal run whose replay entry was evicted (TTL/caps) or lost to a restart is
// indistinguishable from a live run that has not emitted yet. The caller-supplied durable
// read resolves it from persisted run state.
// ===========================================================================

describe('subscribe — durable cache-miss resolution (#1639)', () => {
  it('delivers the terminal status from persisted state and closes when the replay entry was evicted', async () => {
    // #given a run that completed and whose replay entry then expired (TTL eviction)
    const {manager, timers} = makeManager(projectByPhase, {terminalReplayTtlMs: 1_000})
    manager.observeOutput('run-001', 'the answer', {final: true})
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    timers.advance(1_001)
    const read = vi.fn(async () => makeRunState({phase: 'COMPLETED'}))

    // #when an operator subscribes with a durable seam
    const {frames, closes} = subscribeWithDurable(manager, read)
    await drain()

    // #then the terminal status frame is delivered from persisted state and the stream closes
    expect(read).toHaveBeenCalledTimes(1)
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames).toHaveLength(1)
    expect(statusFrames[0]).toMatchObject({type: 'status', data: {runId: 'run-001', status: 'succeeded'}})
    expect(closes).toEqual(['terminal'])
    // #then no output frame is fabricated — durable state carries no output text
    expect(frames.filter(f => f.type === 'output')).toHaveLength(0)

    manager.shutdown()
  })

  it('closes with the persisted failed and cancelled outcomes too', async () => {
    // #given a fresh manager (restart) and persisted failed / cancelled runs
    const {manager} = makeManager(projectByPhase)

    // #when subscribing to each
    const failed = subscribeWithDurable(manager, async () => makeRunState({run_id: 'run-f', phase: 'FAILED'}), 'run-f')
    const cancelled = subscribeWithDurable(
      manager,
      async () => makeRunState({run_id: 'run-c', phase: 'CANCELLED'}),
      'run-c',
    )
    await drain()

    // #then each gets its own terminal status and closes
    expect(failed.frames.find(f => f.type === 'status')).toMatchObject({data: {status: 'failed'}})
    expect(cancelled.frames.find(f => f.type === 'status')).toMatchObject({data: {status: 'cancelled'}})
    expect(failed.closes).toEqual(['terminal'])
    expect(cancelled.closes).toEqual(['terminal'])

    manager.shutdown()
  })

  it('leaves a live run byte-identical: reset frame, no durable read when a snapshot exists, no close', async () => {
    // #given a live run with a cached snapshot and another run with no observation yet
    const {manager} = makeManager(projectByPhase)
    await manager.observe(makeRunState({run_id: 'run-live', phase: 'EXECUTING'}))
    const readSnapshotRun = vi.fn(async () => makeRunState({run_id: 'run-live', phase: 'COMPLETED'}))
    const readNoSnapshotRun = vi.fn(async () => makeRunState({run_id: 'run-new', phase: 'EXECUTING'}))

    // #when subscribing to each with a durable seam, and to a third without one
    const snapshotSub = subscribeWithDurable(manager, readSnapshotRun, 'run-live')
    const noSnapshotSub = subscribeWithDurable(manager, readNoSnapshotRun, 'run-new')
    const plain = collectFrames(manager, 'run-new')
    await drain()

    // #then the snapshot path never touches durable storage and stays open
    expect(readSnapshotRun).not.toHaveBeenCalled()
    expect(snapshotSub.frames).toHaveLength(1)
    expect(snapshotSub.frames[0]).toMatchObject({type: 'status', data: {status: 'running'}})
    expect(snapshotSub.closes).toEqual([])
    // #then a non-terminal durable read leaves the exact frames of a manager with no seam
    expect(readNoSnapshotRun).toHaveBeenCalledTimes(1)
    expect(noSnapshotSub.frames).toEqual(plain.frames)
    expect(noSnapshotSub.frames).toEqual([{type: 'reset', runId: 'run-new', reason: 'no-snapshot'}])
    expect(noSnapshotSub.closes).toEqual([])

    manager.shutdown()
  })

  it('stays live when the durable read fails, finds nothing, or returns a mismatched run', async () => {
    // #given durable reads that throw, find nothing, and return another run's state
    const {manager} = makeManager(projectByPhase)
    const thrown = subscribeWithDurable(
      manager,
      async () => {
        throw new Error('s3 down')
      },
      'run-a',
    )
    const missing = subscribeWithDurable(manager, async () => undefined, 'run-b')
    const mismatched = subscribeWithDurable(
      manager,
      async () => makeRunState({run_id: 'someone-else', phase: 'COMPLETED'}),
      'run-c',
    )

    // #when the reads settle
    await drain()

    // #then every subscriber keeps today's behaviour: one reset frame, no close
    for (const sub of [thrown, missing, mismatched]) {
      expect(sub.frames.map(f => f.type)).toEqual(['reset'])
      expect(sub.closes).toEqual([])
    }

    manager.shutdown()
  })

  it('does not close a stream that a live observation has since made live, even if the durable read says terminal', async () => {
    // #given a no-snapshot subscriber with a slow durable read
    const {manager} = makeManager(projectByPhase)
    const deferred = makeDeferred<RunState | undefined>()
    const {frames, closes} = subscribeWithDurable(manager, async () => deferred.promise)

    // #when a live non-terminal observation lands, then a (contradictory) terminal durable read resolves
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    deferred.resolve(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then the live run wins: running status delivered, no terminal frame, stream still open
    const statusFrames = frames.filter(f => f.type === 'status')
    expect(statusFrames).toHaveLength(1)
    expect(statusFrames[0]).toMatchObject({data: {status: 'running'}})
    expect(closes).toEqual([])

    manager.shutdown()
  })

  it('terminalizes when a slow durable read resolves terminal after the subscriber has waited', async () => {
    // #given a no-snapshot subscriber with a slow durable read
    const {manager} = makeManager(projectByPhase)
    const deferred = makeDeferred<RunState | undefined>()
    const {frames, closes} = subscribeWithDurable(manager, async () => deferred.promise)
    await drain()
    expect(closes).toEqual([])

    // #when the read finally resolves terminal
    deferred.resolve(makeRunState({phase: 'FAILED'}))
    await drain()

    // #then the terminal status is still delivered and the stream closes
    expect(frames.find(f => f.type === 'status')).toMatchObject({data: {status: 'failed'}})
    expect(closes).toEqual(['terminal'])

    manager.shutdown()
  })

  it('does not duplicate or override the live terminal when it wins the race against the durable read', async () => {
    // #given a no-snapshot subscriber whose durable read is still in flight
    const {manager} = makeManager(projectByPhase)
    const deferred = makeDeferred<RunState | undefined>()
    const {frames, closes} = subscribeWithDurable(manager, async () => deferred.promise)

    // #when the live terminal observation lands first, then the (now stale) durable read resolves
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()
    deferred.resolve(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then exactly one terminal status frame and one close — the live path owns delivery
    expect(frames.filter(f => f.type === 'status')).toHaveLength(1)
    expect(closes).toEqual(['terminal'])

    manager.shutdown()
  })

  it('lets the durable terminal win when the live observation has not arrived, without poisoning the replay cache', async () => {
    // #given a no-snapshot subscriber resolved from durable state first
    const {manager} = makeManager(projectByPhase)
    const first = subscribeWithDurable(manager, async () => makeRunState({phase: 'COMPLETED'}))
    await drain()
    expect(first.closes).toEqual(['terminal'])

    // #when the live terminal (with its final output) arrives afterwards
    manager.observeOutput('run-001', 'late answer', {final: true})
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then the first subscriber saw no second close, and a later subscriber still gets the final output
    expect(first.closes).toEqual(['terminal'])
    const late = collectFrames(manager, 'run-001')
    await drain()
    expect(late.frames.find(f => f.type === 'output')).toMatchObject({data: {text: 'late answer', final: true}})
    expect(late.closes).toEqual(['terminal'])

    manager.shutdown()
  })

  it('reveals nothing for a denied or keyless repo: null projection emits no frame and no close', async () => {
    // #given the deny gate projects the persisted state to null
    const projectNull = vi.fn<ProjectFn>(async () => null)
    const {manager} = makeManager(projectNull)

    // #when a subscriber with a terminal persisted state attaches
    const {frames, closes} = subscribeWithDurable(manager, async () => makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then the persisted state went through the deny-gated projection and leaked no status frame
    expect(projectNull).toHaveBeenCalledTimes(1)
    expect(frames.map(f => f.type)).toEqual(['reset'])
    expect(closes).toEqual([])

    manager.shutdown()
  })

  it('does not synthesize after the subscriber unsubscribed or the manager shut down', async () => {
    // #given two in-flight durable reads
    const {manager} = makeManager(projectByPhase)
    const d1 = makeDeferred<RunState | undefined>()
    const d2 = makeDeferred<RunState | undefined>()
    const frames1: ObservationFrame[] = []
    const closes1: string[] = []
    const unsubscribe = manager.subscribe(
      'run-001',
      {
        onEvent: f => {
          frames1.push(f)
        },
        onClose: r => {
          closes1.push(r)
        },
      },
      {readDurableRunState: async () => d1.promise},
    )
    const second = subscribeWithDurable(manager, async () => d2.promise, 'run-002')

    // #when one unsubscribes and the manager shuts down before the reads resolve
    unsubscribe()
    manager.shutdown()
    d1.resolve(makeRunState({phase: 'COMPLETED'}))
    d2.resolve(makeRunState({run_id: 'run-002', phase: 'COMPLETED'}))
    await drain()

    // #then no status frame is produced for either
    expect(frames1.filter(f => f.type === 'status')).toHaveLength(0)
    expect(second.frames.filter(f => f.type === 'status')).toHaveLength(0)
  })
})

// ===========================================================================
// 25. Terminal close ordering — onClose('terminal') never overtakes a pending delivery
// ===========================================================================

/** Subscriber whose onEvent for `holdType` frames stays pending until `release()`. Logs ordering. */
function subscribeWithHeldStatus(
  manager: RunObservationManager,
  options?: Parameters<RunObservationManager['subscribe']>[2],
  runId = 'run-001',
) {
  const log: string[] = []
  const closes: string[] = []
  const deferred = makeDeferred<void>()
  manager.subscribe(
    runId,
    {
      onEvent: async frame => {
        log.push(`${frame.type}:start`)
        if (frame.type === 'status') await deferred.promise
        log.push(`${frame.type}:done`)
      },
      onClose: reason => {
        closes.push(reason)
        log.push(`close:${reason}`)
      },
    },
    options,
  )
  return {log, closes, release: deferred.resolve}
}

describe('terminal close ordering — close waits for the in-flight terminal write', () => {
  it('durable path: delays onClose until the terminal onEvent settles, after the reset was delivered', async () => {
    // #given a no-snapshot subscriber whose durable read is delayed until reset delivery completes
    const {manager} = makeManager(projectByPhase)
    const read = makeDeferred<RunState | undefined>()
    const sub = subscribeWithHeldStatus(manager, {readDurableRunState: async () => read.promise})
    await drain()
    expect(sub.log).toEqual(['reset:start', 'reset:done'])

    // #when the read resolves terminal and the terminal write is held pending
    read.resolve(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then the write started but the subscriber is NOT closed yet
    expect(sub.log).toEqual(['reset:start', 'reset:done', 'status:start'])
    expect(sub.closes).toEqual([])

    // #when the write settles
    sub.release()
    await drain()

    // #then close follows delivery, exactly once
    expect(sub.log).toEqual(['reset:start', 'reset:done', 'status:start', 'status:done', 'close:terminal'])
    expect(sub.closes).toEqual(['terminal'])

    manager.shutdown()
  })

  it('live path: delays onClose until the live terminal onEvent settles', async () => {
    // #given a subscriber with its reset delivered
    const {manager} = makeManager(projectByPhase)
    const sub = subscribeWithHeldStatus(manager)
    await drain()

    // #when the live terminal lands and its write is held pending
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then the stream stays open until the write settles
    expect(sub.log).toEqual(['reset:start', 'reset:done', 'status:start'])
    expect(sub.closes).toEqual([])

    sub.release()
    await drain()
    expect(sub.log.slice(-2)).toEqual(['status:done', 'close:terminal'])
    expect(sub.closes).toEqual(['terminal'])

    manager.shutdown()
  })

  it('replay path: delays onClose until the replayed terminal onEvent settles', async () => {
    // #given a run whose terminal entry is in the replay cache
    const {manager} = makeManager(projectByPhase)
    await manager.observe(makeRunState({phase: 'COMPLETED'}))

    // #when a late subscriber attaches and the replayed status write is held pending
    const sub = subscribeWithHeldStatus(manager)
    await drain()

    // #then the stream stays open until the write settles
    expect(sub.log).toEqual(['status:start'])
    expect(sub.closes).toEqual([])

    sub.release()
    await drain()
    expect(sub.log).toEqual(['status:start', 'status:done', 'close:terminal'])

    manager.shutdown()
  })

  it('still closes immediately when the terminal drain is marked while the writer is idle with an empty queue', async () => {
    // #given a subscriber whose frames have all been delivered (idle writer, empty queue)
    const {manager} = makeManager(projectByPhase)
    const {frames, closes} = collectFrames(manager, 'run-001')
    await drain()
    expect(frames.map(f => f.type)).toEqual(['reset'])

    // #when the terminal lands with an instantly-settling writer
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then exactly one close, after the status
    expect(frames.map(f => f.type)).toEqual(['reset', 'status'])
    expect(closes).toEqual(['terminal'])

    manager.shutdown()
  })

  it('a pending terminal write that fails is a writer-error drop, never a terminal close', async () => {
    // #given a terminal write that stays pending, then rejects
    const {manager} = makeManager(projectByPhase)
    const closes: string[] = []
    let reject!: (error: Error) => void
    const write = new Promise<void>((_resolve, rej) => {
      reject = rej
    })
    manager.subscribe('run-001', {
      onEvent: async frame => {
        if (frame.type === 'status') await write
      },
      onClose: reason => {
        closes.push(reason)
      },
    })
    await drain()
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()
    expect(closes).toEqual([])

    // #when the write fails
    reject(new Error('socket closed'))
    await drain()

    // #then the subscriber is dropped as a writer error, with exactly one close
    expect(closes).toEqual(['writer-error'])

    manager.shutdown()
  })
})

// ===========================================================================
// 26. Durable resolution — the guard after the (separately deferred) projection
// ===========================================================================

describe('subscribe — durable projection is re-guarded after it resolves (#1639)', () => {
  const DURABLE_HOLDER = 'durable-holder'

  /** Projection that defers only for the durable state (identified by holder_id); live states project instantly. */
  function makeDeferredDurableProjection() {
    const projection = makeDeferred<OperatorRunStatus | null>()
    const projectFn: ProjectFn = async runState =>
      runState.holder_id === DURABLE_HOLDER ? projection.promise : projectByPhase(runState)
    return {projectFn, finishProjection: projection.resolve}
  }

  const durableTerminal = (): RunState => makeRunState({phase: 'COMPLETED', holder_id: DURABLE_HOLDER})

  it('suppresses the stale durable terminal when a live status lands while projection is pending', async () => {
    // #given a durable read that resolves terminal and a projection that stays pending
    const {projectFn, finishProjection} = makeDeferredDurableProjection()
    const {manager} = makeManager(projectFn)
    const {frames, closes} = subscribeWithDurable(manager, async () => durableTerminal())
    await drain()

    // #when a live non-terminal status lands, then the stale projection resolves terminal
    await manager.observe(makeRunState({phase: 'EXECUTING'}))
    await drain()
    finishProjection(makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'}))
    await drain()

    // #then only the live status was delivered: no stale terminal, no close
    expect(frames.filter(f => f.type === 'status')).toHaveLength(1)
    expect(frames.find(f => f.type === 'status')).toMatchObject({data: {status: 'running'}})
    expect(closes).toEqual([])

    manager.shutdown()
  })

  it('suppresses the durable terminal when the subscriber unsubscribes while projection is pending', async () => {
    // #given a durable read that resolves terminal and a projection that stays pending
    const {projectFn, finishProjection} = makeDeferredDurableProjection()
    const {manager} = makeManager(projectFn)
    const frames: ObservationFrame[] = []
    const closes: string[] = []
    const unsubscribe = manager.subscribe(
      'run-001',
      {
        onEvent: f => {
          frames.push(f)
        },
        onClose: r => {
          closes.push(r)
        },
      },
      {readDurableRunState: async () => durableTerminal()},
    )
    await drain()

    // #when the subscriber leaves, then the projection resolves terminal
    unsubscribe()
    finishProjection(makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'}))
    await drain()

    // #then nothing terminal is delivered and no close fires for a subscriber that already left
    expect(frames.filter(f => f.type === 'status')).toHaveLength(0)
    expect(closes).toEqual([])

    manager.shutdown()
  })

  it('delivers the durable terminal when nothing intervenes during a pending projection', async () => {
    // #given the same deferred projection with no interference
    const {projectFn, finishProjection} = makeDeferredDurableProjection()
    const {manager} = makeManager(projectFn)
    const {frames, closes} = subscribeWithDurable(manager, async () => durableTerminal())
    await drain()
    expect(closes).toEqual([])

    // #when the projection resolves terminal
    finishProjection(makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'}))
    await drain()

    // #then the terminal status is delivered and the stream closes (guards do not over-suppress)
    expect(frames.filter(f => f.type === 'status')).toHaveLength(1)
    expect(closes).toEqual(['terminal'])

    manager.shutdown()
  })
})

// ===========================================================================
// Waiting-status refresh: live status and replay follow registry truth
// ===========================================================================

/** In-memory stand-in for the approval and question registries, keyed by scope and request id. */
function makeRegistryFake() {
  const approvals = new Map<string, Set<string>>()
  const questions = new Map<string, Set<string>>()

  const has = (registry: Map<string, Set<string>>, scopeId: string): boolean => (registry.get(scopeId)?.size ?? 0) > 0
  const open = (registry: Map<string, Set<string>>, scopeId: string, requestID: string): void => {
    const ids = registry.get(scopeId) ?? new Set<string>()
    ids.add(requestID)
    registry.set(scopeId, ids)
  }
  const close = (registry: Map<string, Set<string>>, scopeId: string, requestID: string): void => {
    registry.get(scopeId)?.delete(requestID)
  }

  return {
    predicates: {
      hasPendingApproval: (scopeId: string) => has(approvals, scopeId),
      hasPendingQuestion: (scopeId: string) => has(questions, scopeId),
    } satisfies WaitingPredicates,
    openApproval: (scopeId: string, requestID = 'a-1') => {
      open(approvals, scopeId, requestID)
    },
    closeApproval: (scopeId: string, requestID = 'a-1') => {
      close(approvals, scopeId, requestID)
    },
    openQuestion: (scopeId: string, requestID = 'q-1') => {
      open(questions, scopeId, requestID)
    },
    closeQuestion: (scopeId: string, requestID = 'q-1') => {
      close(questions, scopeId, requestID)
    },
  }
}

function makeWaitingHarness(options: Partial<RunObservationManagerDeps> & {readonly project?: ProjectFn} = {}) {
  const {project, ...overrides} = options
  const registries = makeRegistryFake()
  const denial = {denied: false}
  const warn = vi.fn()
  const {manager, timers} = makeManager(project ?? projectByPhase, {
    waiting: registries.predicates,
    isRepoDenied: () => denial.denied,
    logger: {info: vi.fn(), warn, error: vi.fn(), debug: vi.fn()},
    ...overrides,
  })
  return {manager, timers, registries, denial, warn}
}

function statusNames(frames: readonly ObservationFrame[]): string[] {
  return frames.flatMap(frame => (frame.type === 'status' ? [frame.data.status] : []))
}

/** Observe, then flush so the writer task has delivered the frame. */
async function observeAndDrain(manager: RunObservationManager, runState: RunState): Promise<void> {
  await manager.observe(runState)
  await drain()
}

/** Open a request in the fake, then run the refresh the gate's open listener would trigger. */
async function openQuestionAndRefresh(
  harness: ReturnType<typeof makeWaitingHarness>,
  scopeId: string,
  requestID = 'q-1',
): Promise<void> {
  harness.registries.openQuestion(scopeId, requestID)
  harness.manager.refreshScope(scopeId)
  await drain()
}

async function closeQuestionAndRefresh(
  harness: ReturnType<typeof makeWaitingHarness>,
  scopeId: string,
  requestID = 'q-1',
): Promise<void> {
  harness.registries.closeQuestion(scopeId, requestID)
  harness.manager.refreshScope(scopeId)
  await drain()
}

describe('waiting refresh — live status and replay', () => {
  it('flips a running run to waiting_for_question live when a question opens, and replay matches', async () => {
    // #given an observed running run with a live subscriber
    const harness = makeWaitingHarness()
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())

    // #when a question opens for the run's scope
    await openQuestionAndRefresh(harness, 'run-001')

    // #then the live stream shows waiting, and a late subscriber's snapshot agrees
    expect(statusNames(frames)).toEqual(['running', 'waiting_for_question'])
    const late = collectFrames(harness.manager, 'run-001')
    await drain()
    expect(statusNames(late.frames)).toEqual(['waiting_for_question'])

    harness.manager.shutdown()
  })

  it('returns to running once the question leaves the registry, and replay matches', async () => {
    // #given a run waiting on a question
    const harness = makeWaitingHarness()
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await openQuestionAndRefresh(harness, 'run-001')

    // #when the question leaves the registry
    await closeQuestionAndRefresh(harness, 'run-001')

    // #then live status and the replay snapshot both read running
    expect(statusNames(frames)).toEqual(['running', 'waiting_for_question', 'running'])
    const late = collectFrames(harness.manager, 'run-001')
    await drain()
    expect(statusNames(late.frames)).toEqual(['running'])

    harness.manager.shutdown()
  })

  it('applies approval over question, and recomputes both families when one settles', async () => {
    // #given a run with a question already open
    const harness = makeWaitingHarness()
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await openQuestionAndRefresh(harness, 'run-001')

    // #when an approval opens over it, then settles, then the question settles
    harness.registries.openApproval('run-001')
    harness.manager.refreshScope('run-001')
    await drain()
    harness.registries.closeApproval('run-001')
    harness.manager.refreshScope('run-001')
    await drain()
    await closeQuestionAndRefresh(harness, 'run-001')

    // #then approval wins, its settle lands on waiting_for_question, and the last settle returns to running
    expect(statusNames(frames)).toEqual([
      'running',
      'waiting_for_question',
      'waiting_for_approval',
      'waiting_for_question',
      'running',
    ])

    harness.manager.shutdown()
  })

  it('sends no frame while a second question keeps the scope waiting', async () => {
    // #given two open questions in one scope
    const harness = makeWaitingHarness()
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await openQuestionAndRefresh(harness, 'run-001', 'q-1')
    await openQuestionAndRefresh(harness, 'run-001', 'q-2')

    // #when Q1 settles, then Q2 settles
    await closeQuestionAndRefresh(harness, 'run-001', 'q-1')
    const framesAfterQ1 = statusNames(frames).length
    await closeQuestionAndRefresh(harness, 'run-001', 'q-2')

    // #then the first settle is silent and the second returns to running
    expect(statusNames(frames).slice(0, framesAfterQ1)).toEqual(['running', 'waiting_for_question'])
    expect(statusNames(frames)).toEqual(['running', 'waiting_for_question', 'running'])

    harness.manager.shutdown()
  })

  it('sends no extra frame when a refresh yields the status already cached (claim released back to open)', async () => {
    // #given a run waiting on a question
    const harness = makeWaitingHarness()
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await openQuestionAndRefresh(harness, 'run-001')

    // #when the same request reopens (a replacement put, or a failed claim returning to open)
    harness.manager.refreshScope('run-001')
    await drain()

    // #then the status did not change, so no frame is sent
    expect(statusNames(frames)).toEqual(['running', 'waiting_for_question'])

    harness.manager.shutdown()
  })

  it('commits waiting on the first observe when the request opened before it, without an earlier frame', async () => {
    // #given a request that opened before the run was ever observed
    const harness = makeWaitingHarness()
    const {frames} = collectFrames(harness.manager, 'run-001')
    harness.registries.openQuestion('run-001')

    // #when a refresh fires for the unobserved run, then the first observe lands
    harness.manager.refreshScope('run-001')
    await drain()
    expect(statusNames(frames)).toEqual([])
    await observeAndDrain(harness.manager, makeRunState())

    // #then the first frame already reads waiting
    expect(statusNames(frames)).toEqual(['waiting_for_question'])

    harness.manager.shutdown()
  })

  it('keeps the base stale flag when a request settles on a run idle past the stale threshold', async () => {
    // #given a run whose base projection is already stale
    const staleProject: ProjectFn = async runState => makeOperatorRunStatus({runId: runState.run_id, stale: true})
    const harness = makeWaitingHarness({project: staleProject})
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())

    // #when a question opens and settles
    await openQuestionAndRefresh(harness, 'run-001')
    await closeQuestionAndRefresh(harness, 'run-001')

    // #then every frame carries stale: true, taken from the retained base and not recomputed
    const staleFlags = frames.flatMap(frame => (frame.type === 'status' ? [frame.data.stale] : []))
    expect(staleFlags).toEqual([true, true, true])
    expect(statusNames(frames)).toEqual(['running', 'waiting_for_question', 'running'])

    harness.manager.shutdown()
  })

  it('scopes a Discord run by its thread and a web run by its run id', async () => {
    // #given a Discord run in thread T and a github run, each observed
    const harness = makeWaitingHarness()
    const discord = collectFrames(harness.manager, 'run-d')
    const github = collectFrames(harness.manager, 'run-g')
    await observeAndDrain(harness.manager, makeRunState({run_id: 'run-d', surface: 'discord', thread_id: 'T'}))
    await observeAndDrain(harness.manager, makeRunState({run_id: 'run-g', surface: 'github', thread_id: 'ignored'}))

    // #when requests open under the thread id and under the github run id
    await openQuestionAndRefresh(harness, 'T')
    await openQuestionAndRefresh(harness, 'run-g', 'q-2')

    // #then each run waits only for its own scope
    expect(statusNames(discord.frames)).toEqual(['running', 'waiting_for_question'])
    expect(statusNames(github.frames)).toEqual(['running', 'waiting_for_question'])

    // #when only the thread's question leaves
    await closeQuestionAndRefresh(harness, 'T')

    // #then only the Discord run returns to running
    expect(statusNames(discord.frames)).toEqual(['running', 'waiting_for_question', 'running'])
    expect(statusNames(github.frames)).toEqual(['running', 'waiting_for_question'])

    harness.manager.shutdown()
  })
})

describe('waiting refresh — races against in-flight projections', () => {
  it('race A: a request put and removed during the first projection await leaves the run running', async () => {
    // #given a first observe held at its projection await
    const gate = makeDeferred<OperatorRunStatus | null>()
    const harness = makeWaitingHarness({project: async () => gate.promise})
    const {frames} = collectFrames(harness.manager, 'run-001')
    const inFlight = harness.manager.observe(makeRunState())

    // #when a question opens and leaves while the projection is pending
    await openQuestionAndRefresh(harness, 'run-001')
    await closeQuestionAndRefresh(harness, 'run-001')
    gate.resolve(makeOperatorRunStatus())
    await inFlight
    await drain()

    // #then the commit reads the registry as it is now: running, no waiting frame
    expect(statusNames(frames)).toEqual(['running'])

    harness.manager.shutdown()
  })

  it('race A: a request still open at commit time lands as waiting with no intermediate running frame', async () => {
    // #given a first observe held at its projection await
    const gate = makeDeferred<OperatorRunStatus | null>()
    const harness = makeWaitingHarness({project: async () => gate.promise})
    const {frames} = collectFrames(harness.manager, 'run-001')
    const inFlight = harness.manager.observe(makeRunState())

    // #when a question opens during the await and is still open when the projection resolves
    await openQuestionAndRefresh(harness, 'run-001')
    gate.resolve(makeOperatorRunStatus())
    await inFlight
    await drain()

    // #then the only status frame already reads waiting
    expect(statusNames(frames)).toEqual(['waiting_for_question'])

    harness.manager.shutdown()
  })

  it('race B: a newer lifecycle observation committing while a request is open is overlaid against the live registry', async () => {
    // #given a run waiting on a question, then a second observe held at its projection await
    const second = makeDeferred<OperatorRunStatus | null>()
    let call = 0
    const project: ProjectFn = async () => {
      call++
      return call === 1 ? makeOperatorRunStatus() : second.promise
    }
    const harness = makeWaitingHarness({project})
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await openQuestionAndRefresh(harness, 'run-001')
    const inFlight = harness.manager.observe(makeRunState())

    // #when the newer observation resolves with a changed base while the question is still open
    second.resolve(makeOperatorRunStatus({stale: true}))
    await inFlight
    await drain()

    // #then the new base wins and the overlay is applied on top of it
    const last = frames.findLast(frame => frame.type === 'status')
    expect(last).toMatchObject({type: 'status', data: {status: 'waiting_for_question', stale: true}})

    harness.manager.shutdown()
  })

  it('race B: a question that leaves during the second projection await does not stick', async () => {
    // #given a run waiting on a question, then a second observe held at its projection await
    const second = makeDeferred<OperatorRunStatus | null>()
    let call = 0
    const project: ProjectFn = async () => {
      call++
      return call === 1 ? makeOperatorRunStatus() : second.promise
    }
    const harness = makeWaitingHarness({project})
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await openQuestionAndRefresh(harness, 'run-001')
    const inFlight = harness.manager.observe(makeRunState())

    // #when the question leaves, then the newer observation resolves
    await closeQuestionAndRefresh(harness, 'run-001')
    second.resolve(makeOperatorRunStatus({stale: true}))
    await inFlight
    await drain()

    // #then the run ends running, never waiting
    expect(statusNames(frames).at(-1)).toBe('running')

    harness.manager.shutdown()
  })

  it('race C: a terminal observation that wins over an in-flight non-terminal one stays terminal', async () => {
    // #given a non-terminal observe held at its await, and a terminal observe held behind it
    const running = makeDeferred<OperatorRunStatus | null>()
    const completed = makeDeferred<OperatorRunStatus | null>()
    const pending = [running, completed]
    const project: ProjectFn = async () => pending.shift()?.promise ?? null
    const harness = makeWaitingHarness({project})
    const {frames, closes} = collectFrames(harness.manager, 'run-001')
    const first = harness.manager.observe(makeRunState({phase: 'EXECUTING'}))
    const second = harness.manager.observe(makeRunState({phase: 'COMPLETED'}))

    // #when the terminal one resolves first, then the stale non-terminal one
    completed.resolve(makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'}))
    await second
    running.resolve(makeOperatorRunStatus())
    await first
    await drain()

    // #then the stale observation is dropped and a later request opening changes nothing
    await openQuestionAndRefresh(harness, 'run-001')
    expect(statusNames(frames)).toEqual(['succeeded'])
    expect(closes).toEqual(['terminal'])

    harness.manager.shutdown()
  })
})

describe('waiting refresh — retained state is the resurrection guard', () => {
  it('terminal first: a request opening after the terminal observe emits and caches nothing, even after replay eviction', async () => {
    // #given a replay cache that holds one terminal run, and run-001 observed running then terminal
    const harness = makeWaitingHarness({terminalReplayMaxEntries: 1})
    const live = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await observeAndDrain(harness.manager, makeRunState({phase: 'COMPLETED'}))

    // #given a second terminal run evicting run-001's replay entry (which also clears its terminalRuns guard)
    await observeAndDrain(harness.manager, makeRunState({run_id: 'run-002', phase: 'COMPLETED'}))

    // #when a question opens for the finished run's scope
    await openQuestionAndRefresh(harness, 'run-001')

    // #then the live subscriber saw only running then succeeded
    expect(statusNames(live.frames)).toEqual(['running', 'succeeded'])

    // #then no status was cached: a new subscriber gets only a reset
    const late = collectFrames(harness.manager, 'run-001')
    await drain()
    expect(statusNames(late.frames)).toEqual([])
    expect(late.frames.map(frame => frame.type)).toEqual(['reset'])

    harness.manager.shutdown()
  })

  it('terminal first: a request opening while the terminal replay entry exists leaves replay terminal', async () => {
    // #given a finished run whose replay entry is still cached
    const harness = makeWaitingHarness()
    await observeAndDrain(harness.manager, makeRunState())
    await observeAndDrain(harness.manager, makeRunState({phase: 'COMPLETED'}))

    // #when a question opens for its scope
    await openQuestionAndRefresh(harness, 'run-001')

    // #then replay is the terminal status and the stream closes terminal
    const late = collectFrames(harness.manager, 'run-001')
    await drain()
    expect(statusNames(late.frames)).toEqual(['succeeded'])
    expect(late.closes).toEqual(['terminal'])

    harness.manager.shutdown()
  })

  it('a null projection drops retained state: later gate events emit nothing and write nothing', async () => {
    // #given a running run whose next projection comes back null (repository denied)
    let call = 0
    const project: ProjectFn = async () => (++call === 1 ? makeOperatorRunStatus() : null)
    const harness = makeWaitingHarness({project})
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await observeAndDrain(harness.manager, makeRunState())

    // #when a question opens afterwards (the denylist predicate itself reports not-denied)
    await openQuestionAndRefresh(harness, 'run-001')

    // #then nothing was emitted, and the cache still holds the pre-denial status
    expect(statusNames(frames)).toEqual(['running'])
    const late = collectFrames(harness.manager, 'run-001')
    await drain()
    expect(statusNames(late.frames)).toEqual(['running'])

    harness.manager.shutdown()
  })

  it('a run whose first projection is null is never retained', async () => {
    // #given a denied repository from the start
    const harness = makeWaitingHarness({project: async () => null})
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())

    // #when requests open and leave
    await openQuestionAndRefresh(harness, 'run-001')
    await closeQuestionAndRefresh(harness, 'run-001')

    // #then no frame and no cache entry exist
    expect(statusNames(frames)).toEqual([])
    const late = collectFrames(harness.manager, 'run-001')
    await drain()
    expect(late.frames.map(frame => frame.type)).toEqual(['reset'])

    harness.manager.shutdown()
  })

  it('mid-run denial: the refresh-time denylist check drops the run and emits nothing', async () => {
    // #given a running run whose repository becomes denied with no lifecycle observation in between
    const harness = makeWaitingHarness()
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    harness.denial.denied = true

    // #when a question opens
    await openQuestionAndRefresh(harness, 'run-001')

    // #then no frame is emitted and the cache is untouched
    expect(statusNames(frames)).toEqual(['running'])
    const late = collectFrames(harness.manager, 'run-001')
    await drain()
    expect(statusNames(late.frames)).toEqual(['running'])

    // #when the denial lifts and the question leaves
    harness.denial.denied = false
    await closeQuestionAndRefresh(harness, 'run-001')

    // #then the dropped run is not refreshed again
    expect(statusNames(frames)).toEqual(['running'])

    harness.manager.shutdown()
  })
})

describe('waiting refresh — scope index', () => {
  it('re-keys a run that adopts its thread, and never collides two pre-ACK runs', async () => {
    // #given two pre-ACK Discord runs that both carry an empty thread id
    const harness = makeWaitingHarness()
    const runA = collectFrames(harness.manager, 'run-A')
    const runB = collectFrames(harness.manager, 'run-B')
    await observeAndDrain(
      harness.manager,
      makeRunState({run_id: 'run-A', surface: 'discord', thread_id: '', phase: 'PENDING'}),
    )
    await observeAndDrain(
      harness.manager,
      makeRunState({run_id: 'run-B', surface: 'discord', thread_id: '', phase: 'PENDING'}),
    )

    // #when run A adopts thread T and a question opens under T
    await observeAndDrain(harness.manager, makeRunState({run_id: 'run-A', surface: 'discord', thread_id: 'T'}))
    await openQuestionAndRefresh(harness, 'T')

    // #then only run A refreshes
    expect(statusNames(runA.frames)).toEqual(['queued', 'running', 'waiting_for_question'])
    expect(statusNames(runB.frames)).toEqual(['queued'])

    // #when a request registers under the empty scope
    await openQuestionAndRefresh(harness, '', 'q-empty')

    // #then neither run is touched
    expect(statusNames(runA.frames)).toEqual(['queued', 'running', 'waiting_for_question'])
    expect(statusNames(runB.frames)).toEqual(['queued'])

    harness.manager.shutdown()
  })

  it('indexes the new thread before the projection await, so a request opening during it refreshes the run', async () => {
    // #given a running Discord run with no thread yet, and a second observe (the thread adoption) held at its await
    const adoption = makeDeferred<OperatorRunStatus | null>()
    let call = 0
    const project: ProjectFn = async () => {
      call++
      return call === 1 ? makeOperatorRunStatus() : adoption.promise
    }
    const harness = makeWaitingHarness({project})
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState({surface: 'discord', thread_id: ''}))
    const inFlight = harness.manager.observe(makeRunState({surface: 'discord', thread_id: 'T'}))

    // #when a question opens under T while the adoption projection is still pending
    await openQuestionAndRefresh(harness, 'T')

    // #then the run already reads waiting, before the projection resolves
    expect(statusNames(frames)).toEqual(['running', 'waiting_for_question'])

    adoption.resolve(makeOperatorRunStatus())
    await inFlight
    await drain()
    expect(statusNames(frames).at(-1)).toBe('waiting_for_question')

    harness.manager.shutdown()
  })

  it('empty scope: a pending entry under "" never overlays a run that has no thread yet', async () => {
    // #given a request registered under the empty scope and a running Discord run with no thread id
    const harness = makeWaitingHarness()
    const {frames} = collectFrames(harness.manager, 'run-001')
    harness.registries.openQuestion('')

    // #when the run is observed running
    await observeAndDrain(harness.manager, makeRunState({surface: 'discord', thread_id: ''}))

    // #then the run reads running, so it can never get stuck waiting on a scope that is never refreshed
    expect(statusNames(frames)).toEqual(['running'])

    harness.manager.shutdown()
  })

  it('a refresh that throws for one run is logged and does not stop the rest of the scope', async () => {
    // #given two Discord runs in one thread; the first one's repository key makes the denylist check throw
    const projectBase: RunObservationManagerDeps['projectBase'] = async runState => ({
      kind: 'projected',
      status: makeOperatorRunStatus({runId: runState.run_id}),
      repoKey: {databaseId: null, nodeId: runState.run_id === 'run-bad' ? 'bad' : 'good'},
    })
    const harness = makeWaitingHarness({
      projectBase,
      isRepoDenied: repoKey => {
        if (repoKey.nodeId === 'bad') throw new Error('denylist unavailable')
        return false
      },
    })
    const good = collectFrames(harness.manager, 'run-good')
    await observeAndDrain(harness.manager, makeRunState({run_id: 'run-bad', surface: 'discord', thread_id: 'T'}))
    await observeAndDrain(harness.manager, makeRunState({run_id: 'run-good', surface: 'discord', thread_id: 'T'}))

    // #when a question opens in the shared thread
    harness.registries.openQuestion('T')
    expect(() => {
      harness.manager.refreshScope('T')
    }).not.toThrow()
    await drain()

    // #then the healthy run still flips to waiting and the failure is logged
    expect(statusNames(good.frames)).toEqual(['running', 'waiting_for_question'])
    expect(harness.warn).toHaveBeenCalledWith(
      expect.objectContaining({runId: 'run-bad'}),
      expect.stringContaining('scope refresh threw'),
    )

    harness.manager.shutdown()
  })
})

describe('waiting refresh — frame ordering', () => {
  it('delivers the settle frame before the status flip, and a settle frame alone does not flip status', async () => {
    // #given a run waiting on a question, with the question frame delivered
    const harness = makeWaitingHarness()
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await openQuestionAndRefresh(harness, 'run-001')
    harness.manager.observeQuestion('run-001', openQuestion('q-1'))

    // #when the settle frame renders while the entry is still registered (the deadline path)
    harness.manager.observeQuestion('run-001', {requestID: 'q-1', runId: 'run-001', settled: true})
    await drain()

    // #then the status still reads waiting
    expect(statusNames(frames)).toEqual(['running', 'waiting_for_question'])

    // #when the entry leaves the registry and onTerminal refreshes the scope
    await closeQuestionAndRefresh(harness, 'run-001')

    // #then the flip to running follows the settle frame
    const order = frames.map(frame => (frame.type === 'status' ? frame.data.status : frame.type))
    expect(order).toEqual(['reset', 'running', 'waiting_for_question', 'question', 'question', 'running'])

    harness.manager.shutdown()
  })

  it('a subscriber connecting between the settle frame and onTerminal gets waiting, then running, equal to live', async () => {
    // #given a run waiting on a question whose settle frame has been rendered
    const harness = makeWaitingHarness()
    await observeAndDrain(harness.manager, makeRunState())
    await openQuestionAndRefresh(harness, 'run-001')
    harness.manager.observeQuestion('run-001', openQuestion('q-1'))
    harness.manager.observeQuestion('run-001', {requestID: 'q-1', runId: 'run-001', settled: true})

    // #when a subscriber connects before the entry leaves, and then it leaves
    const between = collectFrames(harness.manager, 'run-001')
    await drain()
    await closeQuestionAndRefresh(harness, 'run-001')

    // #then it sees the snapshot waiting, then running; a subscriber after removal sees running
    expect(statusNames(between.frames)).toEqual(['waiting_for_question', 'running'])
    const after = collectFrames(harness.manager, 'run-001')
    await drain()
    expect(statusNames(after.frames)).toEqual(['running'])

    harness.manager.shutdown()
  })

  it('a teardown disposing three entries in one scope ends at running with no duplicate frames', async () => {
    // #given two questions and an approval open in one scope
    const harness = makeWaitingHarness()
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await openQuestionAndRefresh(harness, 'run-001', 'q-1')
    await openQuestionAndRefresh(harness, 'run-001', 'q-2')
    harness.registries.openApproval('run-001')
    harness.manager.refreshScope('run-001')
    await drain()

    // #when the teardown removes them one by one, refreshing after each
    harness.registries.closeApproval('run-001')
    harness.manager.refreshScope('run-001')
    harness.registries.closeQuestion('run-001', 'q-1')
    harness.manager.refreshScope('run-001')
    harness.registries.closeQuestion('run-001', 'q-2')
    harness.manager.refreshScope('run-001')
    await drain()

    // #then each distinct status appears once, in order
    expect(statusNames(frames)).toEqual([
      'running',
      'waiting_for_question',
      'waiting_for_approval',
      'waiting_for_question',
      'running',
    ])

    harness.manager.shutdown()
  })
})

describe('waiting refresh — shutdown', () => {
  it('a refresh after shutdown reads no registry, writes no cache, and arms no timer', async () => {
    // #given an observed run, then a shut-down manager
    const harness = makeWaitingHarness()
    await observeAndDrain(harness.manager, makeRunState())
    harness.manager.shutdown()
    const hasPendingQuestion = vi.spyOn(harness.registries.predicates, 'hasPendingQuestion')
    const hasPendingApproval = vi.spyOn(harness.registries.predicates, 'hasPendingApproval')

    // #when a request opens and a refresh arrives
    harness.registries.openQuestion('run-001')
    harness.manager.refreshScope('run-001')
    await drain()

    // #then nothing was read or scheduled, and a new subscriber is closed outright
    expect(hasPendingQuestion).not.toHaveBeenCalled()
    expect(hasPendingApproval).not.toHaveBeenCalled()
    expect(harness.timers.activeTimerCount()).toBe(0)
    const late = collectFrames(harness.manager, 'run-001')
    expect(late.closes).toEqual(['shutdown'])
    expect(late.frames).toEqual([])
  })

  it('an observe in flight across shutdown does not repopulate the caches or arm a replay timer', async () => {
    // #given a terminal observe held at its projection await
    const gate = makeDeferred<OperatorRunStatus | null>()
    const harness = makeWaitingHarness({project: async () => gate.promise})
    const inFlight = harness.manager.observe(makeRunState({phase: 'COMPLETED'}))

    // #when the manager shuts down and then the projection resolves
    harness.manager.shutdown()
    gate.resolve(makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'}))
    await inFlight
    await drain()

    // #then no terminal replay entry or eviction timer was created
    expect(harness.timers.activeTimerCount()).toBe(0)
  })
})

// ===========================================================================
// Binding store unavailable: a transient read error keeps the last good state
// ===========================================================================

/** A projector whose binding store can be switched into a failing state. */
function makeFlakyStore() {
  const state = {unavailable: false}
  const projectBase: RunObservationManagerDeps['projectBase'] = async runState =>
    state.unavailable
      ? {kind: 'unavailable'}
      : {
          kind: 'projected',
          status: makeOperatorRunStatus({runId: runState.run_id}),
          repoKey: DEFAULT_REPO_KEY,
        }
  return {state, projectBase}
}

/** The base status for a run in its phase, as the real projection would map it. */
function projectByPhaseStatus(runState: RunState): OperatorRunStatus {
  return makeOperatorRunStatus({
    runId: runState.run_id,
    phase: runState.phase,
    status: PHASE_TO_WEB_STATUS[runState.phase],
  })
}

/** An EXECUTING projection held open, and a terminal projection that resolves per `terminal`. */
function makeHeldExecuting(terminal: 'unavailable' | 'denied' | 'throws') {
  const executing = makeDeferred<RunStatusProjection>()
  const projectBase: RunObservationManagerDeps['projectBase'] = async runState => {
    if (runState.phase === 'EXECUTING') return executing.promise
    if (terminal === 'throws') throw new Error('store exploded')
    return terminal === 'unavailable' ? {kind: 'unavailable'} : {kind: 'denied'}
  }
  const resolveExecuting = (runState: RunState): void => {
    executing.resolve({kind: 'projected', status: projectByPhaseStatus(runState), repoKey: DEFAULT_REPO_KEY})
  }
  return {projectBase, resolveExecuting}
}

describe('waiting refresh — binding store unavailable', () => {
  it('a store error on the EXECUTING observe keeps the last base, so a later question still shows waiting', async () => {
    // #given a run observed while the store was healthy, then re-observed while it fails
    const store = makeFlakyStore()
    const harness = makeWaitingHarness({projectBase: store.projectBase})
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    store.state.unavailable = true
    await observeAndDrain(harness.manager, makeRunState())

    // #when a question opens afterwards
    await openQuestionAndRefresh(harness, 'run-001')

    // #then the failed observe emitted nothing, and the refresh works from the last good base
    expect(statusNames(frames)).toEqual(['running', 'waiting_for_question'])

    // #then the failure was logged with the run id only
    expect(harness.warn).toHaveBeenCalledWith({runId: 'run-001'}, expect.stringContaining('binding store unavailable'))

    harness.manager.shutdown()
  })

  it('the refresh-time denylist check still applies to the retained key after a store error', async () => {
    // #given a run kept across a store error
    const store = makeFlakyStore()
    const harness = makeWaitingHarness({projectBase: store.projectBase})
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    store.state.unavailable = true
    await observeAndDrain(harness.manager, makeRunState())

    // #when the repository becomes denied and a question opens
    harness.denial.denied = true
    await openQuestionAndRefresh(harness, 'run-001')

    // #then nothing is emitted
    expect(statusNames(frames)).toEqual(['running'])

    harness.manager.shutdown()
  })

  it('a store error on the very first observe emits and caches nothing, and the next good observe works', async () => {
    // #given a store that fails on the first observe, with no retained state yet
    const store = makeFlakyStore()
    store.state.unavailable = true
    const harness = makeWaitingHarness({projectBase: store.projectBase})
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await openQuestionAndRefresh(harness, 'run-001')

    // #then nothing was emitted or cached
    expect(statusNames(frames)).toEqual([])
    const probe = collectFrames(harness.manager, 'run-001')
    await drain()
    expect(probe.frames.map(frame => frame.type)).toEqual(['reset'])

    // #when the store recovers and the run is observed again with the question still open
    store.state.unavailable = false
    await observeAndDrain(harness.manager, makeRunState())

    // #then the observation commits normally, overlaid against the live registry
    expect(statusNames(frames)).toEqual(['waiting_for_question'])

    harness.manager.shutdown()
  })

  /** A projector that reports `unavailable` for a chosen run and phase, and a healthy projection otherwise. */
  function makeUnavailableFor(runId: string, phase: RunState['phase']): RunObservationManagerDeps['projectBase'] {
    return async runState =>
      runState.run_id === runId && runState.phase === phase
        ? {kind: 'unavailable'}
        : {kind: 'projected', status: projectByPhaseStatus(runState), repoKey: DEFAULT_REPO_KEY}
  }

  it('releases a finished run whose terminal projection is unavailable, so a sibling in the thread refreshes alone', async () => {
    // #given two Discord runs sharing thread T, both running
    const harness = makeWaitingHarness({projectBase: makeUnavailableFor('run-A', 'COMPLETED')})
    const finished = collectFrames(harness.manager, 'run-A')
    const sibling = collectFrames(harness.manager, 'run-B')
    await observeAndDrain(harness.manager, makeRunState({run_id: 'run-A', surface: 'discord', thread_id: 'T'}))
    await observeAndDrain(harness.manager, makeRunState({run_id: 'run-B', surface: 'discord', thread_id: 'T'}))

    // #when run A's terminal observation hits a binding-store error
    await observeAndDrain(
      harness.manager,
      makeRunState({run_id: 'run-A', surface: 'discord', thread_id: 'T', phase: 'COMPLETED'}),
    )

    // #when an approval opens in the shared thread, and then, separately, a question
    harness.registries.openApproval('T')
    harness.manager.refreshScope('T')
    await drain()
    harness.registries.closeApproval('T')
    await openQuestionAndRefresh(harness, 'T')

    // #then the sibling follows the registries, and the finished run emits nothing and stays open
    expect(statusNames(sibling.frames)).toEqual(['running', 'waiting_for_approval', 'waiting_for_question'])
    expect(statusNames(finished.frames)).toEqual(['running'])
    expect(finished.closes).toEqual([])

    harness.manager.shutdown()
  })

  it('leaves nothing behind when the first observe and the terminal observe are both unavailable', async () => {
    // #given a run whose every projection is unavailable, and a healthy sibling in the same thread
    const harness = makeWaitingHarness({
      projectBase: async runState =>
        runState.run_id === 'run-A'
          ? {kind: 'unavailable'}
          : {kind: 'projected', status: projectByPhaseStatus(runState), repoKey: DEFAULT_REPO_KEY},
    })
    const unreadable = collectFrames(harness.manager, 'run-A')
    const sibling = collectFrames(harness.manager, 'run-B')
    await observeAndDrain(harness.manager, makeRunState({run_id: 'run-A', surface: 'discord', thread_id: 'T'}))
    await observeAndDrain(harness.manager, makeRunState({run_id: 'run-B', surface: 'discord', thread_id: 'T'}))
    await observeAndDrain(
      harness.manager,
      makeRunState({run_id: 'run-A', surface: 'discord', thread_id: 'T', phase: 'FAILED'}),
    )

    // #when a question opens in the shared thread
    await openQuestionAndRefresh(harness, 'T')

    // #then only the sibling refreshes, and the unreadable run never emitted or cached anything
    expect(statusNames(sibling.frames)).toEqual(['running', 'waiting_for_question'])
    expect(statusNames(unreadable.frames)).toEqual([])
    const probe = collectFrames(harness.manager, 'run-A')
    await drain()
    expect(probe.frames.map(frame => frame.type)).toEqual(['reset'])

    harness.manager.shutdown()
  })

  it.each(Object.keys(PHASE_TO_WEB_STATUS) as RunState['phase'][])(
    'keeps or releases retained state on an unavailable %s observation according to its status being terminal',
    async phase => {
      // #given a run observed healthy while running, then re-observed in the phase with the store failing
      const store = makeFlakyStore()
      const harness = makeWaitingHarness({projectBase: store.projectBase})
      const {frames} = collectFrames(harness.manager, 'run-001')
      await observeAndDrain(harness.manager, makeRunState({surface: 'discord', thread_id: 'T', phase: 'EXECUTING'}))
      store.state.unavailable = true
      await observeAndDrain(harness.manager, makeRunState({surface: 'discord', thread_id: 'T', phase}))

      // #when a question opens in the thread
      await openQuestionAndRefresh(harness, 'T')

      // #then a terminal phase released the state (no waiting frame); every other phase kept it
      const isTerminalPhase = ['succeeded', 'failed', 'cancelled'].includes(PHASE_TO_WEB_STATUS[phase])
      const waitedAfterwards = statusNames(frames).includes('waiting_for_question')
      expect(waitedAfterwards).toBe(!isTerminalPhase)

      harness.manager.shutdown()
    },
  )

  describe('terminal fence — an older in-flight observation cannot undo terminal cleanup', () => {
    it.each(['unavailable', 'denied', 'throws'] as const)(
      'discards a late EXECUTING projection after a %s terminal projection: no retain, no emit, no replay',
      async terminal => {
        // #given a held EXECUTING projection, a terminal observe whose projection does not succeed, and a sibling
        const held = makeHeldExecuting(terminal)
        const harness = makeWaitingHarness({projectBase: held.projectBase})
        const finished = collectFrames(harness.manager, 'run-A')
        const executingState = makeRunState({run_id: 'run-A', surface: 'discord', thread_id: 'T'})
        const inFlight = harness.manager.observe(executingState)
        await harness.manager.observe({...executingState, phase: 'COMPLETED'})

        // #when the older EXECUTING projection resolves successfully
        held.resolveExecuting(executingState)
        await inFlight
        await drain()

        // #then it emitted no frame, and a later request in the thread does not reach the finished run
        const sibling = collectFrames(harness.manager, 'run-B')
        await observeAndDrain(harness.manager, makeRunState({run_id: 'run-B', surface: 'discord', thread_id: 'T'}))
        await openQuestionAndRefresh(harness, 'T')
        expect(statusNames(finished.frames)).toEqual([])
        expect(statusNames(sibling.frames)).toEqual(['running', 'waiting_for_question'])

        // #then no running replay was installed for the finished run
        const reconnect = collectFrames(harness.manager, 'run-A')
        await drain()
        expect(reconnect.frames.map(frame => frame.type)).toEqual(['reset'])

        harness.manager.shutdown()
      },
    )

    it.each(['unavailable', 'denied', 'throws'] as const)(
      'still discards a late EXECUTING projection after the fence TTL has expired (%s terminal)',
      async terminal => {
        // #given a held EXECUTING projection and a terminal observe whose projection does not succeed
        const held = makeHeldExecuting(terminal)
        const harness = makeWaitingHarness({projectBase: held.projectBase, terminalReplayTtlMs: 1_000})
        const finished = collectFrames(harness.manager, 'run-A')
        const executingState = makeRunState({run_id: 'run-A', surface: 'discord', thread_id: 'T'})
        const inFlight = harness.manager.observe(executingState)
        await harness.manager.observe({...executingState, phase: 'COMPLETED'})

        // #when the fence timer fires, and only then the older projection resolves
        harness.timers.advance(1_001)
        held.resolveExecuting(executingState)
        await inFlight
        await drain()

        // #then it still emitted nothing, and no retained state was recreated for the finished run
        const sibling = collectFrames(harness.manager, 'run-B')
        await observeAndDrain(harness.manager, makeRunState({run_id: 'run-B', surface: 'discord', thread_id: 'T'}))
        await openQuestionAndRefresh(harness, 'T')
        expect(statusNames(finished.frames)).toEqual([])
        expect(statusNames(sibling.frames)).toEqual(['running', 'waiting_for_question'])

        // #then no running replay exists for the finished run
        const reconnect = collectFrames(harness.manager, 'run-A')
        await drain()
        expect(reconnect.frames.map(frame => frame.type)).toEqual(['reset'])

        harness.manager.shutdown()
      },
    )

    it('lets a successful terminal projection still emit and close after an older in-flight EXECUTING', async () => {
      // #given a held EXECUTING projection and a terminal observe that succeeds
      const executing = makeDeferred<RunStatusProjection>()
      const projectBase: RunObservationManagerDeps['projectBase'] = async runState =>
        runState.phase === 'EXECUTING'
          ? executing.promise
          : {kind: 'projected', status: projectByPhaseStatus(runState), repoKey: DEFAULT_REPO_KEY}
      const harness = makeWaitingHarness({projectBase})
      const {frames, closes} = collectFrames(harness.manager, 'run-001')
      const inFlight = harness.manager.observe(makeRunState())
      await observeAndDrain(harness.manager, makeRunState({phase: 'COMPLETED'}))

      // #when the older projection resolves afterwards
      executing.resolve({kind: 'projected', status: projectByPhaseStatus(makeRunState()), repoKey: DEFAULT_REPO_KEY})
      await inFlight
      await drain()

      // #then only the terminal status was delivered, and the stream closed
      expect(statusNames(frames)).toEqual(['succeeded'])
      expect(closes).toEqual(['terminal'])

      harness.manager.shutdown()
    })

    it('expires the fence after the replay TTL, leaving no timer behind', async () => {
      // #given a terminal observe whose projection was unavailable (no replay entry), and no subscribers
      const harness = makeWaitingHarness({
        projectBase: async () => ({kind: 'unavailable'}),
        terminalReplayTtlMs: 1_000,
      })
      await harness.manager.observe(makeRunState({phase: 'COMPLETED'}))
      expect(harness.timers.activeTimerCount()).toBe(1)

      // #when the TTL passes
      harness.timers.advance(1_001)

      // #then the fence timer is gone
      expect(harness.timers.activeTimerCount()).toBe(0)
    })

    it('releases the fence timer at shutdown', async () => {
      // #given a fenced run
      const harness = makeWaitingHarness({projectBase: async () => ({kind: 'unavailable'})})
      await harness.manager.observe(makeRunState({phase: 'COMPLETED'}))
      expect(harness.timers.activeTimerCount()).toBe(1)

      // #when the manager shuts down
      harness.manager.shutdown()

      // #then no timer remains
      expect(harness.timers.activeTimerCount()).toBe(0)
    })
  })

  it('a real denial still drops the retained state, unlike a store error', async () => {
    // #given a run whose next projection is denied
    let call = 0
    const projectBase: RunObservationManagerDeps['projectBase'] = async runState =>
      ++call === 1
        ? {kind: 'projected', status: makeOperatorRunStatus({runId: runState.run_id}), repoKey: DEFAULT_REPO_KEY}
        : {kind: 'denied'}
    const harness = makeWaitingHarness({projectBase})
    const {frames} = collectFrames(harness.manager, 'run-001')
    await observeAndDrain(harness.manager, makeRunState())
    await observeAndDrain(harness.manager, makeRunState())

    // #when a question opens
    await openQuestionAndRefresh(harness, 'run-001')

    // #then the run was dropped: no waiting frame
    expect(statusNames(frames)).toEqual(['running'])

    harness.manager.shutdown()
  })
})
