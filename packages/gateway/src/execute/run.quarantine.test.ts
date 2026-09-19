import type {CoordinationConfig} from '@fro-bot/runtime'
import type {RunTask} from './run.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  buildMockRunState,
  CHANNEL_ID,
  makeBinding,
  makeDefaultConcurrency,
  makeDefaultQueue,
  makeDeps,
  makeMessage,
  makePendingTask,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import * as attachModule from './opencode-attach.js'
import * as promptModule from './prompt.js'
import * as runCoreModule from './run-core.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// Quarantine — the termination barrier (Unit 8): a quarantined run holds the
// lock/slot/heartbeat until the bounded hold window elapses, plus the
// quarantine-FAILED-transition-failure retry behavior.
// ---------------------------------------------------------------------------

describe('termination barrier — quarantine (Unit 8)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a quarantined RunCoreError skips heartbeat.stop, releaseLock, and hand-off entirely', async () => {
    // #given — runOpenCodeCore rejects with a RunCoreError whose termination barrier could
    // NOT confirm this run's owned background sessions actually stopped. This is the load-
    // bearing complement the brief calls for: setupHappyPath's heartbeat.stop/releaseLock/
    // handoff would all fire immediately on ANY other rejection (see the plain
    // 'run-core error handling' describe block above) — only sibling liveness (represented
    // here by `quarantined: true`) should hold them back.
    const {runMention} = await import('./run.js')
    const {RunCoreError} = runCoreModule
    const stopFn = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: buildMockRunState()},
    })
    setupHappyPath({stop: stopFn})
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('session-error', 'Session error: LLM quota exceeded', true))

    const sharedConcurrency = makeDefaultConcurrency()
    const queue = makeDefaultQueue()
    const deps = makeDeps({concurrency: sharedConcurrency, queue})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — heartbeat is never stopped: the lease must keep renewing so the reservation
    // cannot silently lapse via TTL expiry while owned background work is unconfirmed.
    expect(stopFn).not.toHaveBeenCalled()

    // #and — the repository lock is never released.
    expect(mockRuntime.releaseLock).not.toHaveBeenCalled()

    // #and — the concurrency slot is never released, and no queued task is started on it.
    const releaseFn = sharedConcurrency.release as ReturnType<typeof vi.fn>
    expect(releaseFn).not.toHaveBeenCalled()
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce() // only this run — no hand-off dispatch

    // #and — the run still reports failure (never success): a FAILED transition still lands.
    const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
    expect(transitionPhases).toContain('FAILED')
  })

  it('a quarantined run does not hand off to a queued task even though one is waiting', async () => {
    // #given — a second task is queued for the same channel; without the quarantine gate,
    // the outer handoff finally would start it on the still-held slot.
    const {runMention} = await import('./run.js')
    const {RunCoreError} = runCoreModule
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValueOnce(new RunCoreError('stream-ended', 'stream closed', true))

    const sharedConcurrency = makeDefaultConcurrency()
    const queue = makeDefaultQueue()
    const pendingMessage = makeMessage()
    const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue})
    const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)
    // Bounded to one-shot (mockReturnValueOnce + mockReturnValue(undefined)): this stub feeds
    // a hand-off that this test asserts must NOT happen. If quarantine ever regresses into
    // handing off the slot, an unbounded stub here would make takeNext keep returning a task
    // forever, so the run loop would spin until the worker dies of heap exhaustion — the
    // regression would surface as a hang/OOM, not a failed assertion. Bounding it means a
    // regression fails fast and clearly instead of silently looping.
    ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

    const deps = makeDeps({concurrency: sharedConcurrency, queue})
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then — runOpenCodeCore was called exactly once: the queued task was never started.
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    const releaseFn = sharedConcurrency.release as ReturnType<typeof vi.fn>
    expect(releaseFn).not.toHaveBeenCalled()
  })

  it('an unquarantined RunCoreError (quarantined: false, the default) behaves exactly as before — heartbeat stops, lock releases, hand-off proceeds', async () => {
    // #given — regression guard: the new quarantine branch must not swallow the ordinary
    // failure path for every other RunCoreError.
    const {runMention} = await import('./run.js')
    const {RunCoreError} = runCoreModule
    const stopFn = vi.fn().mockResolvedValue({
      success: true,
      data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: buildMockRunState()},
    })
    setupHappyPath({stop: stopFn})
    mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('session-error', 'Session error: LLM quota exceeded'))

    const deps = makeDeps()
    const message = makeMessage()

    // #when
    await runMention(message, makeBinding(), deps)

    // #then
    expect(stopFn).toHaveBeenCalledOnce()
    expect(mockRuntime.releaseLock).toHaveBeenCalledOnce()
    const releaseFn = deps.concurrency.release as ReturnType<typeof vi.fn>
    expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
  })

  describe('bounded quarantine hold', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('a quarantined run keeps holding the lock and slot for the duration of the hold window (complement of the deadlock)', async () => {
      // #given — this is the load-bearing complement: without a bound, nothing would ever
      // release these resources. Advancing time short of the window must still change nothing.
      vi.useFakeTimers()
      const {runMention, QUARANTINE_HOLD_WINDOW_MS} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      const stopFn = vi.fn().mockResolvedValue({
        success: true,
        data: {
          runEtag: 'run-etag-after-heartbeat',
          lockEtag: 'lock-etag-after-heartbeat',
          runState: buildMockRunState(),
        },
      })
      setupHappyPath({stop: stopFn})
      mockRunOpenCodeCore.mockRejectedValue(
        new RunCoreError('session-error', 'Session error: LLM quota exceeded', true),
      )

      const sharedConcurrency = makeDefaultConcurrency()
      const queue = makeDefaultQueue()
      const deps = makeDeps({concurrency: sharedConcurrency, queue})
      const message = makeMessage()

      // #when — the run settles (quarantined) and time advances short of the hold window.
      await runMention(message, makeBinding(), deps)
      await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS - 1_000)

      // #then — still held: no premature release, exactly what the barrier exists to prevent.
      expect(stopFn).not.toHaveBeenCalled()
      expect(mockRuntime.releaseLock).not.toHaveBeenCalled()
      const releaseFn = sharedConcurrency.release as ReturnType<typeof vi.fn>
      expect(releaseFn).not.toHaveBeenCalled()
    })

    it('a quarantined run stops renewing after the hold window and releases the concurrency slot — becoming recoverable without an operator or restart', async () => {
      // #given
      vi.useFakeTimers()
      const {runMention, QUARANTINE_HOLD_WINDOW_MS} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      const stopFn = vi.fn().mockResolvedValue({
        success: true,
        data: {
          runEtag: 'run-etag-after-heartbeat',
          lockEtag: 'lock-etag-after-heartbeat',
          runState: buildMockRunState(),
        },
      })
      setupHappyPath({stop: stopFn})
      mockRunOpenCodeCore.mockRejectedValue(
        new RunCoreError('session-error', 'Session error: LLM quota exceeded', true),
      )

      const sharedConcurrency = makeDefaultConcurrency()
      const queue = makeDefaultQueue()
      const deps = makeDeps({concurrency: sharedConcurrency, queue})
      const message = makeMessage()

      // #when — the run settles quarantined, then the full hold window elapses.
      await runMention(message, makeBinding(), deps)
      await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS + 1_000)

      // #then — the heartbeat is stopped (the lease stops renewing) and the concurrency slot
      // is released: the gateway's capacity is not burned forever.
      expect(stopFn).toHaveBeenCalledOnce()
      const releaseFn = sharedConcurrency.release as ReturnType<typeof vi.fn>
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)

      // #and — the repo lock is still never force-released directly by this module; it is
      // left to decay via its own lease TTL now that the heartbeat has stopped renewing it.
      expect(mockRuntime.releaseLock).not.toHaveBeenCalled()
    })

    it('a quarantined run hands the freed slot to a queued task once the hold window elapses', async () => {
      // #given — a second task is queued for the same channel.
      vi.useFakeTimers()
      const {runMention, QUARANTINE_HOLD_WINDOW_MS} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      mockRunOpenCodeCore.mockRejectedValueOnce(new RunCoreError('stream-ended', 'stream closed', true))

      const sharedConcurrency = makeDefaultConcurrency()
      const queue = makeDefaultQueue()
      const pendingMessage = makeMessage()
      const pendingDeps = makeDeps({concurrency: sharedConcurrency, queue})
      const pendingTask: RunTask = makePendingTask(pendingMessage, makeBinding(), pendingDeps)
      ;(queue.takeNext as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingTask).mockReturnValue(undefined)

      const deps = makeDeps({concurrency: sharedConcurrency, queue})
      const message = makeMessage()

      // #when
      await runMention(message, makeBinding(), deps)
      expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS + 1_000)

      // #then — the queued task started on the freed slot, and once IT finishes
      // draining with an empty queue, the slot is released exactly once.
      expect(mockRunOpenCodeCore).toHaveBeenCalledTimes(2)
      const releaseFn = sharedConcurrency.release as ReturnType<typeof vi.fn>
      expect(releaseFn).toHaveBeenCalledExactlyOnceWith(CHANNEL_ID)
    })

    it('after the quarantine FAILED transition succeeds, no further conditional write (transitionRun or releaseLock) occurs before the hold window elapses', async () => {
      // #given — pins the invariant behind removing the dead `runEtag = quarantineResult.data.etag`
      // assignments: the quarantine path performs exactly one terminal write (the FAILED
      // transition itself) and then nothing else touches the coordination store until the
      // bounded hold window elapses. If a future change adds a conditional write here, it
      // would reach for a captured etag that is now stale/absent — this test catches the
      // extra write landing at all, independent of which etag it used.
      vi.useFakeTimers()
      const {runMention, QUARANTINE_HOLD_WINDOW_MS} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      setupHappyPath()
      mockRunOpenCodeCore.mockRejectedValue(
        new RunCoreError('session-error', 'Session error: LLM quota exceeded', true),
      )

      const deps = makeDeps()
      const message = makeMessage()

      // #when — the run settles quarantined, then time advances past the hold window.
      await runMention(message, makeBinding(), deps)
      await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS + 1_000)

      // #then — exactly the three writes the ordinary path makes on its way into quarantine
      // (ACKNOWLEDGED, EXECUTING, the quarantine FAILED transition) and nothing else — neither
      // a synchronous extra write in the quarantine branch nor a deferred one from the bounded-
      // release callback once the hold window elapses. Exact-sequence assertion (not just a
      // count) so an extra write is caught regardless of where in the sequence it lands.
      const transitionPhases = mockRuntime.transitionRun.mock.calls.map((c: unknown[]) => c[4] as string)
      expect(transitionPhases).toEqual(['ACKNOWLEDGED', 'EXECUTING', 'FAILED'])
      expect(mockRuntime.releaseLock).not.toHaveBeenCalled()
    })
  })

  describe('quarantine FAILED transition failure — record must not silently stay unquarantined', () => {
    it('retries the FAILED (quarantine) transition with a fresh etag after a conditional-write conflict', async () => {
      // #given — the first quarantine FAILED write 412s (e.g. a heartbeat tick landed a write
      // in between); a re-read returns a fresh etag and the retry succeeds.
      const {runMention} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      const executingState = buildMockRunState({phase: 'EXECUTING'})
      const failedState = buildMockRunState({phase: 'FAILED', details: {quarantined: true}})
      const getObjectMock = vi.fn().mockResolvedValue({
        success: true as const,
        data: {data: JSON.stringify(executingState), etag: 'fresh-etag-after-quarantine-412'},
      })
      const coordinationConfig = {
        storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject: getObjectMock},
        storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
        lockTtlSeconds: 900,
        heartbeatIntervalMs: 30_000,
        staleThresholdMs: 60_000,
        pendingStaleThresholdMs: 30 * 60_000,
      } as unknown as CoordinationConfig

      mockRuntime.acquireLock.mockResolvedValue({
        success: true as const,
        data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
      })
      mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
      mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
      let failedAttempts = 0
      mockRuntime.transitionRun.mockImplementation(async (..._args: unknown[]) => {
        const phase = _args[4] as string
        if (phase === 'FAILED') {
          failedAttempts += 1
          if (failedAttempts === 1) {
            return {success: false as const, error: new Error('quarantine FAILED conditional write conflict')}
          }
          return {success: true as const, data: {etag: 'failed-etag-v2', state: failedState}}
        }
        return {success: true as const, data: {etag: 'admit-etag', state: executingState}}
      })
      mockRuntime.createHeartbeatController.mockReturnValue({
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue({
          success: true,
          data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: failedState},
        }),
        isRunning: false,
      })
      vi.mocked(attachModule.attachOpencode).mockReturnValue({
        server: {url: 'http://workspace:9200'},
        session: {create: vi.fn(), prompt: vi.fn()},
      } as unknown as ReturnType<typeof attachModule.attachOpencode>)
      vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('session-error', 'quota exceeded', true))

      const deps = makeDeps({coordinationConfig})
      const message = makeMessage()

      // #when — must not throw despite the initial 412.
      await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()

      // #then — two FAILED attempts observed: the initial 412 and the retry with a fresh etag.
      expect(failedAttempts).toBe(2)
      const failedCalls = mockRuntime.transitionRun.mock.calls.filter((c: unknown[]) => c[4] === 'FAILED')
      expect(failedCalls[1]?.[5]).toBe('fresh-etag-after-quarantine-412')
    })

    it('logs clearly and still applies the bounded hold when both the transition and its retry fail', async () => {
      // #given — the re-read succeeds but the retried write also fails. The run must not
      // throw, and the bounded hold must still be scheduled regardless of the persisted record.
      vi.useFakeTimers()
      const {runMention, QUARANTINE_HOLD_WINDOW_MS} = await import('./run.js')
      const {RunCoreError} = runCoreModule
      const executingState = buildMockRunState({phase: 'EXECUTING'})
      const getObjectMock = vi.fn().mockResolvedValue({
        success: true as const,
        data: {data: JSON.stringify(executingState), etag: 'fresh-etag-that-also-conflicts'},
      })
      const coordinationConfig = {
        storeAdapter: {upload: vi.fn(), download: vi.fn(), list: vi.fn(), getObject: getObjectMock},
        storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
        lockTtlSeconds: 900,
        heartbeatIntervalMs: 30_000,
        staleThresholdMs: 60_000,
        pendingStaleThresholdMs: 30 * 60_000,
      } as unknown as CoordinationConfig

      mockRuntime.acquireLock.mockResolvedValue({
        success: true as const,
        data: {acquired: true as const, etag: 'lock-etag-v1', holder: null},
      })
      mockRuntime.releaseLock.mockResolvedValue({success: true as const, data: undefined})
      mockRuntime.createRun.mockResolvedValue({success: true as const, data: {etag: 'run-etag-v1'}})
      mockRuntime.transitionRun.mockImplementation(async (..._args: unknown[]) => {
        const phase = _args[4] as string
        if (phase === 'FAILED') {
          return {success: false as const, error: new Error('quarantine FAILED conditional write conflict')}
        }
        return {success: true as const, data: {etag: 'admit-etag', state: executingState}}
      })
      const stopFn = vi.fn().mockResolvedValue({
        success: true,
        data: {runEtag: 'run-etag-after-heartbeat', lockEtag: 'lock-etag-after-heartbeat', runState: executingState},
      })
      mockRuntime.createHeartbeatController.mockReturnValue({start: vi.fn(), stop: stopFn, isRunning: false})
      vi.mocked(attachModule.attachOpencode).mockReturnValue({
        server: {url: 'http://workspace:9200'},
        session: {create: vi.fn(), prompt: vi.fn()},
      } as unknown as ReturnType<typeof attachModule.attachOpencode>)
      vi.mocked(promptModule.buildDiscordPrompt).mockReturnValue('Repository: acme/widget\n\ndo the thing')
      mockRunOpenCodeCore.mockRejectedValue(new RunCoreError('session-error', 'quota exceeded', true))

      const sharedConcurrency = makeDefaultConcurrency()
      const queue = makeDefaultQueue()
      const deps = makeDeps({coordinationConfig, concurrency: sharedConcurrency, queue})
      const message = makeMessage()

      // #when — must not throw even though both the transition and its retry failed.
      await expect(runMention(message, makeBinding(), deps)).resolves.toBeUndefined()

      // #then — the bounded hold is scheduled regardless of the persisted record's fate, and
      // still fires the deferred release once the window elapses.
      await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS + 1_000)
      expect(stopFn).toHaveBeenCalledOnce()
      const releaseFn = sharedConcurrency.release as ReturnType<typeof vi.fn>
      expect(releaseFn).toHaveBeenCalledWith(CHANNEL_ID)
    })
  })
})
