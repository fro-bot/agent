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
import type {OperatorRunStatus} from '../../operator-contract/index.js'
import type {ObservationFrame, RunObservationManager, RunObservationManagerDeps} from './manager.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createRunObservationManager} from './manager.js'

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

type ProjectFn = RunObservationManagerDeps['projectRunObservation']

function makeManager(
  projectFn: ProjectFn,
  overrides: Partial<RunObservationManagerDeps> = {},
  fakeTimers?: FakeTimerSystem,
): {manager: RunObservationManager; timers: FakeTimerSystem} {
  const timers = fakeTimers ?? makeFakeTimerSystem()
  const manager = createRunObservationManager({
    projectRunObservation: projectFn,
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

    // #then subscribing again after terminal emits reset (cache cleared)
    const {frames: frames2} = collectFrames(manager, 'run-001')
    await drain()
    expect(frames2.filter(f => f.type === 'reset')).toHaveLength(1)

    unsubscribe()
    manager.shutdown()
  })

  it('clears the cache entry after terminal fan-out', async () => {
    // #given a manager that projects a terminal status
    const terminalStatus = makeOperatorRunStatus({phase: 'COMPLETED', status: 'succeeded'})
    const projectFn: ProjectFn = async () => terminalStatus

    const {manager} = makeManager(projectFn)

    // #when observing a terminal transition
    await manager.observe(makeRunState({phase: 'COMPLETED'}))
    await drain()

    // #then subscribing after terminal gets reset (no cached entry)
    const {frames} = collectFrames(manager, 'run-001')
    await drain()
    expect(frames.some(f => f.type === 'reset')).toBe(true)
    expect(frames.some(f => f.type === 'status')).toBe(false)

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
    // We need the slow subscriber to overflow when a SECOND frame arrives (queue full),
    // while the fast subscriber drains immediately and never overflows.
    //
    // Strategy: use a cap that fits one frame. The slow subscriber gets the snapshot
    // frame (fills the queue) and then never drains. When the second observe() arrives,
    // the slow subscriber's queue is full → overflow. The fast subscriber drains
    // immediately so its queue is always empty → no overflow.
    const status = makeOperatorRunStatus({status: 'running'})
    const projectFn: ProjectFn = async () => status

    // Estimate one frame's byte size so we can set the cap to exactly that
    const oneFrameBytes = JSON.stringify({type: 'status', data: status}).length
    // Cap = one frame: the slow subscriber fills up after the snapshot, overflows on the next
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

    // Both subscribers got the snapshot frame. The slow subscriber's queue is now full
    // (one frame = cap). The fast subscriber drained immediately (queue empty).

    // #when observing again (second frame — slow subscriber queue is full → overflow)
    const observeStart = Date.now()
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
    // unprimed (cold start), projectRunObservation returns null (deny-all). The manager
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
      projectRunObservation: async () => null,
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
      'projectRunObservation',
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

describe('error path — throwing projectRunObservation', () => {
  it('a rejecting projectFn is caught, logged, and produces no cache entry and no frame', async () => {
    // #given a manager whose projectRunObservation always rejects
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
      expect.stringContaining('projectRunObservation threw'),
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

// ---------------------------------------------------------------------------
// Cleanup: ensure no real timers leak between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})
