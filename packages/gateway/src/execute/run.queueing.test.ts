import type {RunTask} from './run.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  buildMockRunState,
  CHANNEL_ID,
  makeBinding,
  makeDefaultQueue,
  makeDeps,
  makeEnsureCloneFn,
  makeMessage,
  makeOwnershipCoordinationConfig,
  makePendingTask,
  mockRunOpenCodeCore,
  setupHappyPath,
} from './test-helpers.js'

// ---------------------------------------------------------------------------
// Queueing and handoff — the serial per-channel queue, the handoff unit
// tests, the isShuttingDown shutdown gate, and drain/heartbeat/ownership
// persistence during a slot handoff.
// ---------------------------------------------------------------------------

describe('runMention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Serial per-channel queue — front door + atomic handoff ─────────────

  describe('serial per-channel queue', () => {
    // ── busy → enqueue + queued ack ──────────────────────────────────────────

    it('r1: mention while channel busy → queue.enqueue called + queued ack sent (not old reject)', async () => {
      // #given — channel is busy; queue has capacity
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const queue = makeDefaultQueue()
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('busy'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — task enqueued
      expect(queue.enqueue).toHaveBeenCalledOnce()
      // #and — queued ack sent (not the old terminal reject)
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).toMatch(/queue/i)
      expect(call.content).not.toContain('already a task')
      expect(call.allowedMentions).toEqual({parse: []})
      // #and — startRun pipeline NOT invoked synchronously
      expect(message.startThread).not.toHaveBeenCalled()
      expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
    })

    it('r1: busy + queue.enqueue returns "full" → terse "queue is full" reply (not queued ack)', async () => {
      // #given — channel is busy; queue is at capacity
      const {runMention} = await import('./run.js')
      const queue = makeDefaultQueue()
      ;(queue.enqueue as ReturnType<typeof vi.fn>).mockReturnValue('full')
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('busy'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — "queue is full" reply (not the queued ack)
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        content: string
        allowedMentions: unknown
      }
      expect(call.content).toMatch(/full/i)
      expect(call.allowedMentions).toEqual({parse: []})
      // #and — no thread created
      expect(message.startThread).not.toHaveBeenCalled()
    })

    // ── FIFO gate: pending work present → enqueue even if slot is free ───────

    it('fIFO gate: new mention with pendingCount > 0 is enqueued even though tryAcquire would return ok', async () => {
      // #given — no in-flight run (tryAcquire would return 'ok') but pending work exists
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const queue = makeDefaultQueue()
      // pendingCount returns 1 → front-door must enqueue without consulting tryAcquire
      ;(queue.pendingCount as ReturnType<typeof vi.fn>).mockReturnValue(1)
      const tryAcquireFn = vi.fn().mockReturnValue('ok')
      const deps = makeDeps({
        concurrency: {
          tryAcquire: tryAcquireFn,
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(0),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — task enqueued (not started immediately)
      expect(queue.enqueue).toHaveBeenCalledOnce()
      // #and — tryAcquire NOT consulted (pending work has priority)
      expect(tryAcquireFn).not.toHaveBeenCalled()
      // #and — startRun pipeline NOT invoked
      expect(message.startThread).not.toHaveBeenCalled()
      expect(mockRunOpenCodeCore).not.toHaveBeenCalled()
      // #and — queued ack sent
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toMatch(/queue/i)
    })

    // ── completion with pending task → takeNext + next startRun ─────────────

    it('r2: completion with pending task → takeNext called + next startRun begins', async () => {
      // #given — first run completes; queue has one pending task
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const releaseFn = vi.fn()
      const sharedConcurrency = {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      }
      const queue = makeDefaultQueue()

      // The pending task must share the same concurrency + queue so the handoff
      // uses the same release fn and the same takeNext chain.
      const pendingMessage = makeMessage()
      const pendingBinding = makeBinding()
      const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue})
      const pendingTask: RunTask = makePendingTask(pendingMessage, pendingBinding, pendingDeps)

      ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

      const deps = makeDeps({concurrency: sharedConcurrency, queue})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // Allow the fire-and-forget handoff to settle
      await new Promise(resolve => setTimeout(resolve, 10))

      // #then — takeNext was called (handoff attempted)
      expect(queue.takeNext).toHaveBeenCalledWith(CHANNEL_ID)
      // #and — runOpenCodeCore called twice (once for original, once for queued task)
      expect(mockRunOpenCodeCore).toHaveBeenCalledTimes(2)
      // #and — concurrency.release called exactly once (after the second run completes with empty queue)
      // The slot was handed off (not freed) between the two runs; release fires only after the last run.
      expect(releaseFn).toHaveBeenCalledExactlyOnceWith(CHANNEL_ID)
    })

    it('r2: completion with empty queue → concurrency.release IS called (slot freed)', async () => {
      // #given — first run completes; queue is empty
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const queue = makeDefaultQueue()
      // takeNext returns undefined → queue is empty
      ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValue(undefined)

      const releaseFn = vi.fn()
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('ok'),
          release: releaseFn,
          activeCount: vi.fn().mockReturnValue(1),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — takeNext was called
      expect(queue.takeNext).toHaveBeenCalledWith(CHANNEL_ID)
      // #and — concurrency.release IS called (queue was empty)
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })

    // ── Serial safety: no free-slot gap ──────────────────────────────────────

    it('serial safety: slot handed off without concurrency.release between runs (no free-slot gap)', async () => {
      // #given — first run completes; queue has one pending task
      // Assert: concurrency.release is NOT called between the two startRun invocations.
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const releaseFn = vi.fn()
      const callOrder: string[] = []

      // Track when release is called vs when runOpenCodeCore is called
      releaseFn.mockImplementation(() => {
        callOrder.push('release')
      })
      mockRunOpenCodeCore.mockImplementation(async () => {
        callOrder.push('runOpenCodeCore')
      })

      const sharedConcurrency = {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      }
      const queue = makeDefaultQueue()

      // The pending task must share the same concurrency + queue so the handoff
      // uses the same release fn and the same takeNext chain.
      const pendingMessage = makeMessage()
      const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue})
      const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)

      ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

      const deps = makeDeps({concurrency: sharedConcurrency, queue})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)
      await new Promise(resolve => setTimeout(resolve, 10))

      // #then — runOpenCodeCore called twice (two runs)
      expect(callOrder.filter(e => e === 'runOpenCodeCore')).toHaveLength(2)
      // #and — release NOT called between the two runs (no free-slot gap)
      // release should only be called AFTER the second run completes
      const firstRunIdx = callOrder.indexOf('runOpenCodeCore')
      const secondRunIdx = callOrder.lastIndexOf('runOpenCodeCore')
      const releaseIdx = callOrder.indexOf('release')
      // release must come AFTER the second run, not between them
      expect(releaseIdx).toBeGreaterThan(secondRunIdx)
      // release must NOT appear between first and second run
      expect(callOrder.slice(firstRunIdx + 1, secondRunIdx)).not.toContain('release')
    })

    // ── ok path and cap path ─────────────────────────────────────────────────

    it('r5: ok path (no pending work) runs normally — startRun pipeline invoked', async () => {
      // #given — no pending work; tryAcquire returns ok
      const {runMention} = await import('./run.js')
      setupHappyPath()
      const queue = makeDefaultQueue()
      // pendingCount returns 0 → ok path
      ;(queue.pendingCount as ReturnType<typeof vi.fn>).mockReturnValue(0)
      const deps = makeDeps({queue})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — full pipeline ran
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
      expect(message.startThread).toHaveBeenCalledOnce()
    })

    it('r6: cap path replies terminally and does NOT enqueue', async () => {
      // #given — global cap reached
      const {runMention} = await import('./run.js')
      const queue = makeDefaultQueue()
      const deps = makeDeps({
        concurrency: {
          tryAcquire: vi.fn().mockReturnValue('cap'),
          release: vi.fn(),
          activeCount: vi.fn().mockReturnValue(3),
          max: 3,
        },
        queue,
      })
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)

      // #then — terminal capacity reply
      expect(message.reply).toHaveBeenCalledOnce()
      const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
      expect(call.content).toContain('capacity')
      // #and — NOT enqueued (cap stays terminal)
      expect(queue.enqueue).not.toHaveBeenCalled()
      // #and — no thread created
      expect(message.startThread).not.toHaveBeenCalled()
    })

    // ── Error path: handed-off startRun that throws still releases ───────────

    it('error path: handed-off startRun that throws still releases/hands off (its own finally)', async () => {
      // #given — first run completes; queue has one pending task that will throw
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const releaseFn = vi.fn()
      const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
      const sharedConcurrency = {
        tryAcquire: vi.fn().mockReturnValue('ok'),
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      }
      const queue = makeDefaultQueue()

      // The pending task must share the same concurrency + queue so the handoff
      // uses the same release fn and the same takeNext chain.
      const pendingMessage = makeMessage()
      const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue, logger})
      const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)

      ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

      // Second run (the handed-off one) throws
      mockRunOpenCodeCore
        .mockResolvedValueOnce(undefined) // first run succeeds
        .mockRejectedValueOnce(new Error('handoff run failed')) // second run throws

      const deps = makeDeps({concurrency: sharedConcurrency, queue, logger})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)
      // Allow the fire-and-forget handoff to settle (including its error path)
      await new Promise(resolve => setTimeout(resolve, 20))

      // #then — slot eventually released (handoff's own finally ran)
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
      // #and — queue not stranded (takeNext called for the handoff too)
      expect(queue.takeNext).toHaveBeenCalledTimes(2)
    })

    // ── Integration: three mentions run strictly FIFO ─────────────────────────

    it('integration: three mentions on a busy channel run strictly FIFO with no concurrent overlap', async () => {
      // #given — simulate three sequential mentions on the same channel
      // First mention: acquires slot immediately (ok) and runs
      // Second + third: arrive while first is still running (busy → enqueue)
      // After first completes: second starts via handoff; after second: third starts
      const {runMention} = await import('./run.js')
      setupHappyPath()

      const runOrder: string[] = []
      const releaseOrder: string[] = []

      // Use a real queue to test FIFO ordering
      const {createChannelQueue} = await import('./queue.js')
      const realQueue = createChannelQueue<RunTask>()

      // Control when the first run completes — it must pause so msg2/msg3 can be enqueued
      let resolveFirstRun!: () => void
      const firstRunPaused = new Promise<void>(resolve => {
        resolveFirstRun = resolve
      })

      let runCount = 0
      mockRunOpenCodeCore.mockImplementation(async () => {
        runCount++
        const thisRun = runCount
        runOrder.push(`run-${thisRun}`)
        // First run pauses until we explicitly release it
        if (thisRun === 1) {
          await firstRunPaused
        }
      })

      const releaseFn = vi.fn().mockImplementation(() => {
        releaseOrder.push('release')
      })

      // Concurrency: first tryAcquire returns 'ok', subsequent return 'busy'
      let acquireCount = 0
      const tryAcquireFn = vi.fn().mockImplementation(() => {
        acquireCount++
        return acquireCount === 1 ? 'ok' : 'busy'
      })

      const sharedConcurrency = {
        tryAcquire: tryAcquireFn,
        release: releaseFn,
        activeCount: vi.fn().mockReturnValue(1),
        max: 3,
      }

      // All three mentions share the same concurrency + queue so handoffs chain correctly.
      const deps1 = makeDeps({concurrency: sharedConcurrency, queue: realQueue})
      const deps2 = makeDeps({concurrency: sharedConcurrency, queue: realQueue})
      const deps3 = makeDeps({concurrency: sharedConcurrency, queue: realQueue})

      const msg1 = makeMessage()
      const msg2 = makeMessage()
      const msg3 = makeMessage()

      // #when — start first mention (it will pause inside runOpenCodeCore)
      const run1Promise = runMention(msg1, makeBinding(), deps1)

      // Yield to let run1 start and reach the pause point
      await new Promise(resolve => setTimeout(resolve, 0))

      // Second and third arrive while first is still running (busy)
      await runMention(msg2, makeBinding(), deps2)
      await runMention(msg3, makeBinding(), deps3)

      // Verify second and third were enqueued (not started yet)
      expect(realQueue.pendingCount(CHANNEL_ID)).toBe(2)

      // Release the first run to complete
      resolveFirstRun()
      await run1Promise

      // Allow all handoffs to settle
      await new Promise(resolve => setTimeout(resolve, 50))

      // #then — all three runs completed in order
      expect(runOrder).toEqual(['run-1', 'run-2', 'run-3'])
      // #and — slot released exactly once (after the last run)
      expect(releaseOrder).toHaveLength(1)
      // #and — queue fully drained
      expect(realQueue.pendingCount(CHANNEL_ID)).toBe(0)
    })
  })
})

describe('isShuttingDown — handoff shutdown gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('when isShuttingDown() returns true, handoff does NOT call queue.takeNext and DOES release the slot', async () => {
    // #given — first run completes; shutdown is in progress
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const releaseFn = vi.fn()
    const sharedConcurrency = {
      tryAcquire: vi.fn().mockReturnValue('ok'),
      release: releaseFn,
      activeCount: vi.fn().mockReturnValue(1),
      max: 3,
    }
    const queue = makeDefaultQueue()
    const isShuttingDown = vi.fn().mockReturnValue(true)

    const deps = makeDeps({concurrency: sharedConcurrency, queue, isShuttingDown})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — shutdown gate fired: takeNext NOT called (no handoff started)
    expect(queue.takeNext).not.toHaveBeenCalled()
    // #and — slot released immediately (not transferred to a next run)
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
  })

  it('when isShuttingDown() returns false, normal handoff proceeds (takeNext called, startRun fires)', async () => {
    // #given — first run completes; NOT shutting down; queue has one pending task
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const releaseFn = vi.fn()
    const sharedConcurrency = {
      tryAcquire: vi.fn().mockReturnValue('ok'),
      release: releaseFn,
      activeCount: vi.fn().mockReturnValue(1),
      max: 3,
    }
    const queue = makeDefaultQueue()
    const isShuttingDown = vi.fn().mockReturnValue(false)

    const pendingMessage = makeMessage()
    const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue, isShuttingDown})
    const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)

    ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

    const deps = makeDeps({concurrency: sharedConcurrency, queue, isShuttingDown})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)
    // Allow the fire-and-forget handoff to settle
    await new Promise(resolve => setTimeout(resolve, 10))

    // #then — not shutting down: takeNext WAS called (handoff attempted)
    expect(queue.takeNext).toHaveBeenCalledWith(CHANNEL_ID)
    // #and — slot NOT released by the first run (transferred to the handoff)
    // (it will be released by the handoff run's own outer finally after it completes)
    // We verify release was called exactly once — by the handoff run after it drains
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
  })

  it('when isShuttingDown is absent (undefined), normal handoff proceeds', async () => {
    // #given — no isShuttingDown injected; queue has one pending task
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const queue = makeDefaultQueue()
    const pendingMessage = makeMessage()
    const pendingDeps = makeDeps({queue})
    const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)

    ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

    const deps = makeDeps({queue})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)
    await new Promise(resolve => setTimeout(resolve, 10))

    // #then — takeNext was called (handoff proceeded normally)
    expect(queue.takeNext).toHaveBeenCalledWith(CHANNEL_ID)
  })
})

describe('handoff unit tests (F8)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mocked handoff: startRun runs for the next task; release NOT called during handoff; release IS called when takeNext returns undefined', async () => {
    // #given — first run completes; queue has one pending task
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const releaseFn = vi.fn()
    const callOrder: string[] = []

    releaseFn.mockImplementation(() => {
      callOrder.push('release')
    })
    mockRunOpenCodeCore.mockImplementation(async () => {
      callOrder.push('runOpenCodeCore')
    })

    const sharedConcurrency = {
      tryAcquire: vi.fn().mockReturnValue('ok'),
      release: releaseFn,
      activeCount: vi.fn().mockReturnValue(1),
      max: 3,
    }
    const queue = makeDefaultQueue()

    const pendingMessage = makeMessage()
    const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue})
    const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)

    // First takeNext returns the pending task; second returns undefined (queue empty)
    ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

    const deps = makeDeps({concurrency: sharedConcurrency, queue})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)
    await new Promise(resolve => setTimeout(resolve, 10))

    // #then — (1) startRun ran for the next task (runOpenCodeCore called twice)
    expect(callOrder.filter(e => e === 'runOpenCodeCore')).toHaveLength(2)
    // #and — (2) release NOT called during handoff (only after second run)
    const firstRunIdx = callOrder.indexOf('runOpenCodeCore')
    const secondRunIdx = callOrder.lastIndexOf('runOpenCodeCore')
    const releaseIdx = callOrder.indexOf('release')
    expect(callOrder.slice(firstRunIdx + 1, secondRunIdx)).not.toContain('release')
    // #and — (3) release IS called after takeNext returns undefined
    expect(releaseIdx).toBeGreaterThan(secondRunIdx)
    expect(releaseFn).toHaveBeenCalledExactlyOnceWith(CHANNEL_ID)
  })

  it('fIFO-gate full branch: pendingCount > 0 and enqueue returns "full" → "queue is full" reply', async () => {
    // #given — pending work exists; queue is at capacity
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const queue = makeDefaultQueue()
    ;(queue.pendingCount as ReturnType<typeof vi.fn>).mockReturnValue(1)
    ;(queue.enqueue as ReturnType<typeof vi.fn>).mockReturnValue('full')

    const deps = makeDeps({queue})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — "queue is full" reply via the FIFO-gate path
    expect(message.reply).toHaveBeenCalledOnce()
    const call = (message.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {content: string}
    expect(call.content).toMatch(/full/i)
    // #and — ensureClone NOT called (rejected before pipeline)
    expect(message.startThread).not.toHaveBeenCalled()
  })

  it('fIFO-gate: ensureClone not called when pendingCount > 0', async () => {
    // #given — pending work exists; slot would be free
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const ensureClone = makeEnsureCloneFn('success')
    const queue = makeDefaultQueue()
    ;(queue.pendingCount as ReturnType<typeof vi.fn>).mockReturnValue(1)
    ;(queue.enqueue as ReturnType<typeof vi.fn>).mockReturnValue('queued')

    const deps = makeDeps({queue, ensureClone})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — ensureClone NOT called (FIFO gate short-circuits before pipeline)
    expect(ensureClone).not.toHaveBeenCalled()
  })
})

describe('drain (Unit 6) — slot/heartbeat/ownership-persistence integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('heartbeat is not stopped until runOpenCodeCore resolves, even across a drain longer than the heartbeat interval', async () => {
    // #given — fake timers; runOpenCodeCore (which owns the whole drain loop internally)
    // is held open by a controlled promise so the test can advance time past a single
    // heartbeat interval (30s default) while the run is still "draining".
    vi.useFakeTimers()
    const {runMention} = await import('./run.js')
    const startFn = vi.fn()
    const stopFn = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: buildMockRunState()},
    })
    setupHappyPath({start: startFn, stop: stopFn})

    let resolveRun: (() => void) | undefined
    mockRunOpenCodeCore.mockImplementation(
      async () =>
        new Promise<void>(resolve => {
          resolveRun = resolve
        }),
    )

    const deps = makeDeps()
    const message = makeMessage()
    const runPromise = runMention(message, makeBinding(), deps)

    // Let admission run through to heartbeat.start() + runOpenCodeCore being invoked.
    await vi.advanceTimersByTimeAsync(0)
    expect(startFn).toHaveBeenCalledOnce()
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()

    // #when — advance well past a single heartbeat interval while still draining.
    await vi.advanceTimersByTimeAsync(65_000)

    // #then — the run is still executing (drain in progress): stop() must not have fired.
    // Stopping the heartbeat is what lets ANOTHER instance sweep this run as stale and
    // kill the subagents — firing it while owned work is outstanding would be a bug.
    expect(stopFn).not.toHaveBeenCalled()

    // #and — once drain completes (runOpenCodeCore resolves), stop() fires exactly once.
    resolveRun?.()
    await runPromise
    expect(stopFn).toHaveBeenCalledOnce()
  })

  it('ownership is persisted onto run state as entries are adopted, not only at completion', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {config: coordinationConfig, writes} = makeOwnershipCoordinationConfig(
      buildMockRunState({phase: 'EXECUTING'}),
    )

    let capturedOnOwnershipChange:
      ((info: {readonly rootSessionId: string; readonly ownedSessionIds: readonly string[]}) => void) | undefined
    let resolveRun: (() => void) | undefined
    mockRunOpenCodeCore.mockImplementation(async params => {
      capturedOnOwnershipChange = (params as {onOwnershipChange?: typeof capturedOnOwnershipChange}).onOwnershipChange
      await new Promise<void>(resolve => {
        resolveRun = resolve
      })
    })

    const deps = makeDeps({coordinationConfig})
    const message = makeMessage()
    const runPromise = runMention(message, makeBinding(), deps)

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(capturedOnOwnershipChange).toBeDefined()

    // #when — an entry is adopted mid-execution, well before the run resolves.
    capturedOnOwnershipChange?.({rootSessionId: 'root-1', ownedSessionIds: ['child-1']})
    await new Promise(resolve => setTimeout(resolve, 10))

    // #then — already persisted, before `runOpenCodeCore` (and therefore the run) has resolved.
    expect(writes().length).toBeGreaterThanOrEqual(1)
    const firstWrite = writes()[0]
    expect(firstWrite?.details.rootSessionId).toBe('root-1')
    expect(firstWrite?.details.ownedSessionIds).toEqual(['child-1'])

    // Drive the run to completion so nothing leaks into the next test.
    resolveRun?.()
    await runPromise
  })

  it('a run interrupted mid-drain leaves run state in the exact shape recovery.ts reads (rootSessionId, ownedSessionIds)', async () => {
    // #given — same setup as above, but the run is never allowed to resolve (simulating
    // a crash/restart mid-drain): only the persisted state matters for this assertion.
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {config: coordinationConfig, writes} = makeOwnershipCoordinationConfig(
      buildMockRunState({phase: 'EXECUTING'}),
    )

    let capturedOnOwnershipChange:
      ((info: {readonly rootSessionId: string; readonly ownedSessionIds: readonly string[]}) => void) | undefined
    mockRunOpenCodeCore.mockImplementation(
      async params =>
        new Promise<void>(() => {
          // Deliberately never resolves — models a gateway crash mid-drain.
          capturedOnOwnershipChange = (params as {onOwnershipChange?: typeof capturedOnOwnershipChange})
            .onOwnershipChange
        }),
    )

    const deps = makeDeps({coordinationConfig})
    const message = makeMessage()
    // Fire-and-forget: this promise never resolves by construction (see above), so it must
    // not be awaited.
    // eslint-disable-next-line no-void
    void runMention(message, makeBinding(), deps)

    await new Promise(resolve => setTimeout(resolve, 10))
    capturedOnOwnershipChange?.({rootSessionId: 'root-crash-1', ownedSessionIds: ['child-crash-1', 'child-crash-2']})
    await new Promise(resolve => setTimeout(resolve, 10))

    // #then — what landed in the store uses the EXACT field names
    // `recovery.ts`'s `readPersistedOwnership` reads: `details.rootSessionId` (string) and
    // `details.ownedSessionIds` (string[]) — see `packages/gateway/src/execute/recovery.ts`
    // (`run.details.rootSessionId`, `run.details.ownedSessionIds`) and its own Unit 7 test
    // suite's `persistedOwnershipDetails()` helper, which asserts against those same two keys.
    const lastWrite = writes().at(-1)
    expect(Object.keys(lastWrite?.details ?? {}).sort()).toEqual(['ownedSessionIds', 'rootSessionId'])
    expect(lastWrite?.details.rootSessionId).toBe('root-crash-1')
    expect(lastWrite?.details.ownedSessionIds).toEqual(['child-crash-1', 'child-crash-2'])
  })

  it('integration: a second queued run does not start until the first has finished draining', async () => {
    // #given — the first run's runOpenCodeCore call is held open (simulating drain) while
    // a second message arrives and is enqueued for the same channel.
    const {runMention} = await import('./run.js')
    setupHappyPath()

    const releaseFn = vi.fn()
    const sharedConcurrency = {
      tryAcquire: vi.fn().mockReturnValue('ok'),
      release: releaseFn,
      activeCount: vi.fn().mockReturnValue(1),
      max: 3,
    }
    const queue = makeDefaultQueue()

    const pendingMessage = makeMessage()
    const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue})
    const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)
    ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

    const callOrder: string[] = []
    let resolveFirstDrain: (() => void) | undefined
    mockRunOpenCodeCore.mockImplementationOnce(async () => {
      callOrder.push('run-1-start')
      await new Promise<void>(resolve => {
        resolveFirstDrain = resolve
      })
      callOrder.push('run-1-drain-complete')
    })
    mockRunOpenCodeCore.mockImplementationOnce(async () => {
      callOrder.push('run-2-start')
    })

    const deps = makeDeps({concurrency: sharedConcurrency, queue})
    const message = makeMessage()

    // #when — start the first run; it blocks in "drain"
    const runPromise = runMention(message, makeBinding(), deps)
    await new Promise(resolve => setTimeout(resolve, 10))

    // #then — the second (queued) run has not started while the first is still draining
    expect(callOrder).toEqual(['run-1-start'])
    expect(releaseFn).not.toHaveBeenCalled()

    // #when — the first run's drain completes
    resolveFirstDrain?.()
    await runPromise
    await new Promise(resolve => setTimeout(resolve, 10))

    // #then — the second run started only AFTER the first fully resolved
    expect(callOrder).toEqual(['run-1-start', 'run-1-drain-complete', 'run-2-start'])
    expect(releaseFn).toHaveBeenCalledExactlyOnceWith(CHANNEL_ID)
  })
})
