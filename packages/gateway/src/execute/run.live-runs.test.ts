import type {CoordinationConfig} from '@fro-bot/runtime'
import type {RunMentionDeps} from './run.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  awaitLaunchWorkRun,
  buildMockRunState,
  makeDeps,
  makeInMemoryRequest,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import * as runCoreModule from './run-core.js'
import {abortRegistry} from './abort-registry.js'
import {isRunLive} from './live-run-registry.js'
import {isRunOwnedByThisProcess} from './stranded-run-sweep.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// "Runs live in this process": the set the stranded-run sweep consults before it terminalizes a stale-looking record.
// A run is live from the moment its ACKNOWLEDGED write commits to the true end of the run: after every terminal write,
// or, for a quarantined run, after the hold window's deferred heartbeat stop.
// ---------------------------------------------------------------------------

function storedRecord() {
  return {
    storeAdapter: {
      upload: vi.fn(),
      download: vi.fn(),
      list: vi.fn(),
      getObject: vi.fn(async () => ({
        success: true as const,
        data: {
          data: JSON.stringify(
            buildMockRunState({
              phase: 'EXECUTING',
              run_id: String(mockRuntime.transitionRun.mock.calls.at(-1)?.[3]),
            }),
          ),
          etag: 'etag-stored',
        },
      })),
    },
    storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  } as unknown as CoordinationConfig
}

/** `transitionRun` that fails every write of `phase` and succeeds for the rest. */
function failEveryWriteOf(phase: string): void {
  mockRuntime.transitionRun.mockImplementation(async (...args: unknown[]) => {
    if (args[4] === phase) return {success: false as const, error: new Error('412 precondition failed')}
    return {success: true as const, data: {etag: 'etag-after', state: buildMockRunState({phase: args[4] as 'FAILED'})}}
  })
}

function lastRunId(): string {
  return String(mockRuntime.transitionRun.mock.calls.at(-1)?.[3])
}

describe('the live-run set', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds a run from its ACK commit through preparation, and drops it when the run completes', async () => {
    // #given an `update` that records whether the run is live while the checkout is being prepared
    setupHappyPath()
    let liveDuringPreparation: boolean | undefined
    const update = vi.fn(async () => {
      liveDuringPreparation = isRunLive(lastRunId())
      return {
        success: true,
        data: {
          kind: 'ready',
          change: 'unchanged',
          branch: 'main',
          sha: 'a'.repeat(40),
          checkedAt: '2026-01-01T00:00:00.000Z',
        },
      }
    })
    const deps = makeDeps({update: update as unknown as RunMentionDeps['update']})
    const {launchWork} = await import('./run.js')

    // #when
    const admission = await awaitLaunchWorkRun(launchWork, makeInMemoryRequest(), deps)

    // #then
    expect(liveDuringPreparation).toBe(true)
    expect(admission.accepted === true ? isRunLive(admission.runId) : true).toBe(false)
  })

  it('owns a run while its ACK write is still in flight, so a sweep cannot fail it, and the run goes on to execute', async () => {
    // #given an aged queued task whose ACKNOWLEDGED write has committed server-side but whose response is withheld
    setupHappyPath()
    let answerAck: () => void = () => {}
    let ownedWhileAckPending: boolean | undefined
    mockRuntime.transitionRun.mockImplementation(async (...args: unknown[]) => {
      if (args[4] === 'ACKNOWLEDGED') {
        ownedWhileAckPending = isRunOwnedByThisProcess(String(args[3]))
        return new Promise<{success: true; data: {etag: string; state: ReturnType<typeof buildMockRunState>}}>(
          resolve => {
            answerAck = () => {
              resolve({success: true, data: {etag: 'etag-ack', state: buildMockRunState({phase: 'ACKNOWLEDGED'})}})
            }
          },
        )
      }
      return {
        success: true as const,
        data: {etag: 'etag-after', state: buildMockRunState({phase: args[4] as 'FAILED'})},
      }
    })
    const {launchWork} = await import('./run.js')

    // #when the ACK response arrives late
    const admission = await launchWork(makeInMemoryRequest(), makeDeps())
    await vi.advanceTimersByTimeAsync(100)
    answerAck()
    await vi.advanceTimersByTimeAsync(60_000)
    if (admission.accepted === true) await admission.runPromise

    // #then the run was already owned while the ACK was pending, and it executed
    expect(ownedWhileAckPending).toBe(true)
    expect(mockRunOpenCodeCore).toHaveBeenCalled()
  })

  it('leaves a run that failed to ACK not live, so the sweep can repair its record', async () => {
    // #given the ACKNOWLEDGED write fails
    setupHappyPath()
    failEveryWriteOf('ACKNOWLEDGED')
    const {launchWork} = await import('./run.js')

    // #when
    const done = awaitLaunchWorkRun(launchWork, makeInMemoryRequest(), makeDeps({coordinationConfig: storedRecord()}))
    await vi.advanceTimersByTimeAsync(60_000)
    const admission = await done

    // #then
    const runId = admission.accepted === true ? admission.runId : ''
    expect(runId).not.toBe('')
    expect(isRunLive(runId)).toBe(false)
    expect(isRunOwnedByThisProcess(runId)).toBe(false)
  })

  it('drops a run whose preparation was refused and whose FAILED write failed every attempt, leaving the record ACKNOWLEDGED', async () => {
    // #given
    setupHappyPath()
    failEveryWriteOf('FAILED')
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'diverged'}})
    const deps = makeDeps({
      coordinationConfig: storedRecord(),
      update,
    })
    const {launchWork} = await import('./run.js')

    // #when
    const done = awaitLaunchWorkRun(launchWork, makeInMemoryRequest(), deps)
    await vi.advanceTimersByTimeAsync(60_000)
    const admission = await done

    // #then no FAILED write succeeded, and the run is no longer live, so the sweep may repair the record
    const phases = mockRuntime.transitionRun.mock.calls.map((call: unknown[]) => call[4])
    expect(phases).toContain('ACKNOWLEDGED')
    expect(phases.filter((phase: unknown) => phase === 'FAILED')).toHaveLength(3)
    const runId = admission.accepted === true ? admission.runId : ''
    expect(isRunLive(runId)).toBe(false)
    expect(isRunOwnedByThisProcess(runId)).toBe(false)
  })

  it('keeps a quarantined run live through its hold even though its quarantine write failed, and drops it when the hold ends', async () => {
    // #given the barrier could not confirm owned work stopped, and the quarantine FAILED write never lands
    setupHappyPath()
    failEveryWriteOf('FAILED')
    mockRunOpenCodeCore.mockRejectedValue(new runCoreModule.RunCoreError('session-error', 'quota exceeded', true))
    const deps = makeDeps({coordinationConfig: storedRecord()})
    const {launchWork, QUARANTINE_HOLD_WINDOW_MS} = await import('./run.js')

    // #when the run's own work is over (its writes retried and gave up)
    const done = awaitLaunchWorkRun(launchWork, makeInMemoryRequest(), deps)
    await vi.advanceTimersByTimeAsync(60_000)
    const admission = await done
    const runId = admission.accepted === true ? admission.runId : ''

    // #then the hold is still running, so the sweep must not touch the record
    expect(isRunLive(runId)).toBe(true)
    expect(isRunOwnedByThisProcess(runId)).toBe(true)

    // #when the hold window elapses and the deferred heartbeat stop has run
    await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS)

    // #then it is no longer owned, so a stale record can be swept
    expect(isRunLive(runId)).toBe(false)
    expect(isRunOwnedByThisProcess(runId)).toBe(false)
  })

  it('drops a run that failed an ordinary way once its writes are done', async () => {
    // #given
    setupHappyPath()
    mockRunOpenCodeCore.mockRejectedValue(new runCoreModule.RunCoreError('timeout', 'timed out'))
    const deps = makeDeps({coordinationConfig: storedRecord()})
    const {launchWork} = await import('./run.js')

    // #when
    const done = awaitLaunchWorkRun(launchWork, makeInMemoryRequest(), deps)
    await vi.advanceTimersByTimeAsync(60_000)
    const admission = await done

    // #then
    expect(admission.accepted === true ? isRunLive(admission.runId) : true).toBe(false)
  })
})

describe('a cancel that lands while the FAILED write is retrying', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts no failure reply and sends no failure push', async () => {
    // #given the FAILED write stalls until released
    setupHappyPath()
    let releaseWrite: () => void = () => {}
    mockRuntime.transitionRun.mockImplementation(async (...args: unknown[]) => {
      if (args[4] === 'FAILED') {
        return new Promise<{success: true; data: {etag: string; state: ReturnType<typeof buildMockRunState>}}>(
          resolve => {
            releaseWrite = () => {
              resolve({
                success: true as const,
                data: {etag: 'etag-failed', state: buildMockRunState({phase: 'FAILED'})},
              })
            }
          },
        )
      }
      return {
        success: true as const,
        data: {etag: 'etag-after', state: buildMockRunState({phase: args[4] as 'FAILED'})},
      }
    })
    mockRunOpenCodeCore.mockRejectedValue(new runCoreModule.RunCoreError('timeout', 'timed out'))
    const pushDispatcher = {
      dispatchApprovalPending: vi.fn().mockResolvedValue(undefined),
      dispatchRunFailed: vi.fn().mockResolvedValue(undefined),
    }
    const request = makeInMemoryRequest()
    const deps = makeDeps({coordinationConfig: storedRecord(), operatorPushDispatcher: pushDispatcher})
    const {launchWork} = await import('./run.js')

    // #when the cancel lands while the write is pending
    const admission = await launchWork(request, deps)
    await vi.advanceTimersByTimeAsync(100)
    const runId = admission.accepted === true ? admission.runId : ''
    expect(abortRegistry.has(runId)).toBe(true)
    abortRegistry.abort(runId, 'operator cancel')
    releaseWrite()
    await vi.advanceTimersByTimeAsync(60_000)
    if (admission.accepted === true) await admission.runPromise

    // #then the user is left with the cancel notice alone
    expect(request._replySink._sends.some(send => send.content.includes('time limit'))).toBe(false)
    expect(request._replySink._sends.some(send => send.content.includes('task failed'))).toBe(false)
    expect(pushDispatcher.dispatchRunFailed).not.toHaveBeenCalled()
  })
})
