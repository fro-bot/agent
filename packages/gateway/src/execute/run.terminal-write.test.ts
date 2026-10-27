import type {CoordinationConfig} from '@fro-bot/runtime'
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
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// A terminal RunState write is retried, and everything the user is told does not depend on it.
//
// A stranded EXECUTING record is what the periodic sweep exists to repair, so the first line of defence is that the
// terminal write itself survives a lost conditional write or a transient store error: three attempts with 500 ms then
// 1 s between them, each bounded, for every terminal phase of a run that took the lock.
// ---------------------------------------------------------------------------

const STORED_ETAG = 'etag-stored'

/** A store whose run record is this run's, in the given phase. The run id is generated per run. */
function configStoring(phase: 'EXECUTING' | 'COMPLETED', etag = STORED_ETAG) {
  return {
    storeAdapter: {
      upload: vi.fn(),
      download: vi.fn(),
      list: vi.fn(),
      getObject: vi.fn(async () => ({
        success: true as const,
        data: {
          data: JSON.stringify(
            buildMockRunState({phase, run_id: String(mockRuntime.transitionRun.mock.calls.at(-1)?.[3])}),
          ),
          etag,
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

function makeLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

/** `transitionRun` that fails the first `failures` writes of `phase` (every write when `Infinity`), then succeeds. */
function failTerminal(phase: string, failures: number): void {
  let seen = 0
  mockRuntime.transitionRun.mockImplementation(async (...args: unknown[]) => {
    if (args[4] === phase) {
      seen += 1
      if (seen <= failures) return {success: false as const, error: new Error('412 precondition failed')}
    }
    return {success: true as const, data: {etag: 'etag-after', state: buildMockRunState({phase: args[4] as 'FAILED'})}}
  })
}

function writesOf(phase: string): readonly unknown[] {
  return mockRuntime.transitionRun.mock.calls
    .filter((call: unknown[]) => call[4] === phase)
    .map((call: unknown[]) => call[5])
}

async function runToEnd(request: ReturnType<typeof makeInMemoryRequest>, deps: ReturnType<typeof makeDeps>) {
  const {launchWork} = await import('./run.js')
  const done = awaitLaunchWorkRun(launchWork, request, deps)
  await vi.advanceTimersByTimeAsync(60_000)
  await done
}

describe('terminal RunState writes retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a COMPLETED write, with a clean heartbeat stop, re-reads and retries with the stored ETag after a lost write', async () => {
    // #given the first COMPLETED write loses its condition, and the record is still EXECUTING under a newer ETag
    setupHappyPath()
    failTerminal('COMPLETED', 1)
    const deps = makeDeps({coordinationConfig: configStoring('EXECUTING')})

    // #when
    await runToEnd(makeInMemoryRequest(), deps)

    // #then the retry used the stored ETag
    expect(writesOf('COMPLETED')).toEqual(['run-etag-after-heartbeat', STORED_ETAG])
  })

  it('a FAILED write succeeds on the third write, after the first two fail', async () => {
    // #given
    setupHappyPath()
    failTerminal('FAILED', 2)
    mockRunOpenCodeCore.mockRejectedValue(new runCoreModule.RunCoreError('timeout', 'timed out'))
    const logger = makeLogger()
    const deps = makeDeps({coordinationConfig: configStoring('EXECUTING'), logger})

    // #when
    await runToEnd(makeInMemoryRequest(), deps)

    // #then three writes were made, and none was reported as a failure
    expect(writesOf('FAILED')).toEqual(['run-etag-after-heartbeat', STORED_ETAG, STORED_ETAG])
    expect(logger.error).not.toHaveBeenCalledWith(expect.anything(), 'run: transitionRun FAILED failed')
  })

  it('waits 500 ms, then 1 s, between the writes', async () => {
    // #given every FAILED write fails
    setupHappyPath()
    failTerminal('FAILED', Number.POSITIVE_INFINITY)
    mockRunOpenCodeCore.mockRejectedValue(new runCoreModule.RunCoreError('timeout', 'timed out'))
    const {launchWork} = await import('./run.js')
    const deps = makeDeps({coordinationConfig: configStoring('EXECUTING')})

    // #when
    const done = awaitLaunchWorkRun(launchWork, makeInMemoryRequest(), deps)
    await vi.advanceTimersByTimeAsync(0)
    const afterFirst = writesOf('FAILED').length
    await vi.advanceTimersByTimeAsync(499)
    const beforeFirstDelay = writesOf('FAILED').length
    await vi.advanceTimersByTimeAsync(1)
    const afterFirstDelay = writesOf('FAILED').length
    await vi.advanceTimersByTimeAsync(999)
    const beforeSecondDelay = writesOf('FAILED').length
    await vi.advanceTimersByTimeAsync(1)
    const afterSecondDelay = writesOf('FAILED').length
    await vi.advanceTimersByTimeAsync(60_000)
    await done

    // #then
    expect([afterFirst, beforeFirstDelay, afterFirstDelay, beforeSecondDelay, afterSecondDelay]).toEqual([
      1, 1, 2, 2, 3,
    ])
  })

  it('posts the failure reply and the push when every FAILED write fails, logs the error with the run id, and keeps no terminal record', async () => {
    // #given every FAILED write loses
    setupHappyPath()
    failTerminal('FAILED', Number.POSITIVE_INFINITY)
    mockRunOpenCodeCore.mockRejectedValue(new runCoreModule.RunCoreError('timeout', 'timed out'))
    const logger = makeLogger()
    const pushDispatcher = {
      dispatchApprovalPending: vi.fn().mockResolvedValue(undefined),
      dispatchRunFailed: vi.fn().mockResolvedValue(undefined),
    }
    const request = makeInMemoryRequest()
    const deps = makeDeps({
      coordinationConfig: configStoring('EXECUTING'),
      logger,
      operatorPushDispatcher: pushDispatcher,
    })

    // #when
    await runToEnd(request, deps)

    // #then the user was told, and the operator was pushed, whatever the write result
    expect(request._replySink._sends.some(send => send.content.includes('time limit'))).toBe(true)
    expect(pushDispatcher.dispatchRunFailed).toHaveBeenCalledTimes(1)

    // #and it tried three times, then logged the loss at error level with the run id for the sweep to find
    expect(writesOf('FAILED')).toHaveLength(3)
    const runId = String(mockRuntime.transitionRun.mock.calls.at(-1)?.[3])
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({runId, repo: 'acme/widget'}),
      'run: transitionRun FAILED failed',
    )
  })

  it('does not retry, and overwrites nothing, when the stored record is already terminal', async () => {
    // #given another writer already completed the run
    setupHappyPath()
    failTerminal('FAILED', Number.POSITIVE_INFINITY)
    mockRunOpenCodeCore.mockRejectedValue(new runCoreModule.RunCoreError('timeout', 'timed out'))
    const request = makeInMemoryRequest()
    const deps = makeDeps({coordinationConfig: configStoring('COMPLETED')})

    // #when
    await runToEnd(request, deps)

    // #then one write, and the reply still posted
    expect(writesOf('FAILED')).toHaveLength(1)
    expect(request._replySink._sends.some(send => send.content.includes('time limit'))).toBe(true)
  })

  it('bounds a stalled write: the reply still posts and the run still ends', async () => {
    // #given the store accepts the FAILED write and never answers
    setupHappyPath()
    mockRuntime.transitionRun.mockImplementation(async (...args: unknown[]) => {
      if (args[4] === 'FAILED') return new Promise<never>(() => {})
      return {
        success: true as const,
        data: {etag: 'etag-after', state: buildMockRunState({phase: args[4] as 'FAILED'})},
      }
    })
    mockRunOpenCodeCore.mockRejectedValue(new runCoreModule.RunCoreError('timeout', 'timed out'))
    const request = makeInMemoryRequest()
    const deps = makeDeps({coordinationConfig: configStoring('EXECUTING')})
    const {launchWork} = await import('./run.js')
    let finished = false

    // #when
    const done = awaitLaunchWorkRun(launchWork, request, deps).then(() => {
      finished = true
    })
    // three bounded writes (5 s each) with 1.5 s of waits, and two instant store reads
    await vi.advanceTimersByTimeAsync(3 * 5_000 + 1_500 - 1)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await done

    // #then
    expect(finished).toBe(true)
    expect(writesOf('FAILED')).toHaveLength(3)
    expect(request._replySink._sends.some(send => send.content.includes('time limit'))).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a refused preparation: the reply and the push go out when the FAILED write fails, after three attempts', async () => {
    // #given `update` refuses the checkout, and every FAILED write loses
    setupHappyPath()
    failTerminal('FAILED', Number.POSITIVE_INFINITY)
    const pushDispatcher = {
      dispatchApprovalPending: vi.fn().mockResolvedValue(undefined),
      dispatchRunFailed: vi.fn().mockResolvedValue(undefined),
    }
    const update = vi.fn().mockResolvedValue({success: true, data: {kind: 'refused', reason: 'diverged'}})
    const logger = makeLogger()
    const request = makeInMemoryRequest()
    const deps = makeDeps({
      coordinationConfig: configStoring('EXECUTING'),
      logger,
      operatorPushDispatcher: pushDispatcher,
      update,
    })

    // #when
    await runToEnd(request, deps)

    // #then
    expect(writesOf('FAILED')).toHaveLength(3)
    expect(request._replySink._sends).toHaveLength(1)
    expect(pushDispatcher.dispatchRunFailed).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      'workspace-unavailable',
    )
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({runId: expect.any(String) as string}),
      'run: transitionRun FAILED (preparation) failed',
    )
  })

  it('a quarantined run: the quarantine FAILED write makes three attempts, and the reply and push go out when all fail', async () => {
    // #given the barrier could not confirm owned work stopped, and every FAILED write loses
    setupHappyPath()
    failTerminal('FAILED', Number.POSITIVE_INFINITY)
    mockRunOpenCodeCore.mockRejectedValue(new runCoreModule.RunCoreError('session-error', 'quota exceeded', true))
    const pushDispatcher = {
      dispatchApprovalPending: vi.fn().mockResolvedValue(undefined),
      dispatchRunFailed: vi.fn().mockResolvedValue(undefined),
    }
    const logger = makeLogger()
    const request = makeInMemoryRequest()
    const deps = makeDeps({
      coordinationConfig: configStoring('EXECUTING'),
      logger,
      operatorPushDispatcher: pushDispatcher,
    })

    // #when
    await runToEnd(request, deps)

    // #then
    expect(writesOf('FAILED')).toHaveLength(3)
    expect(pushDispatcher.dispatchRunFailed).toHaveBeenCalledTimes(1)
    expect(request._replySink._sends.some(send => send.content.includes('reserved'))).toBe(true)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({runId: expect.any(String) as string}),
      expect.stringContaining('transitionRun FAILED (quarantine) failed'),
    )
  })

  it('a COMPLETED write that stalls past its bound but commits: subscribers get the stored terminal record, with its own phase', async () => {
    // #given the COMPLETED write hangs, and by the time the retry re-reads, the stored record is terminal (FAILED),
    // as if the abandoned write, or another writer, had committed it meanwhile
    setupHappyPath()
    mockRuntime.transitionRun.mockImplementation(async (...args: unknown[]) => {
      if (args[4] === 'COMPLETED') return new Promise<never>(() => {})
      return {
        success: true as const,
        data: {etag: 'etag-after', state: buildMockRunState({phase: args[4] as 'FAILED'})},
      }
    })
    const observe = vi.fn(async (_state: unknown) => {})
    const logger = makeLogger()
    const base = configStoring('EXECUTING')
    const coordinationConfig = {
      ...base,
      storeAdapter: {
        ...base.storeAdapter,
        getObject: vi.fn(async () => ({
          success: true as const,
          data: {
            data: JSON.stringify(
              buildMockRunState({
                phase: 'FAILED',
                run_id: String(mockRuntime.transitionRun.mock.calls.at(-1)?.[3]),
                details: {marker: 'authoritative'},
              }),
            ),
            etag: 'etag-committed',
          },
        })),
      },
    } as unknown as CoordinationConfig
    const deps = makeDeps({coordinationConfig, logger, runObserver: {observe}})

    // #when
    await runToEnd(makeInMemoryRequest(), deps)

    // #then no second COMPLETED write was made over the stored record
    expect(writesOf('COMPLETED')).toHaveLength(1)

    // #and the observer got the STORED state and its actual phase, not the phase this run tried to write
    const terminalFrames = observe.mock.calls
      .map(call => call[0] as {phase: string; details?: Record<string, unknown>})
      .filter(state => state.phase === 'FAILED')
    expect(terminalFrames).toHaveLength(1)
    expect(terminalFrames[0]?.details).toEqual({marker: 'authoritative'})
    expect(observe.mock.calls.some(call => (call[0] as {phase: string}).phase === 'COMPLETED')).toBe(false)

    // #and it is not reported as a lost write
    expect(logger.error).not.toHaveBeenCalledWith(expect.anything(), 'run: transitionRun COMPLETED failed')
  })

  it('a COMPLETED write abandoned at its bound that commits after the run gave up still gives observers the terminal frame', async () => {
    // #given every COMPLETED write hangs, and the store keeps showing a live run, so the helper returns a failure
    setupHappyPath()
    const pending: ((state: ReturnType<typeof buildMockRunState>) => void)[] = []
    mockRuntime.transitionRun.mockImplementation(async (...args: unknown[]) => {
      if (args[4] === 'COMPLETED') {
        return new Promise<{success: true; data: {etag: string; state: ReturnType<typeof buildMockRunState>}}>(
          resolve => {
            pending.push(state => {
              resolve({success: true as const, data: {etag: 'etag-late', state}})
            })
          },
        )
      }
      return {
        success: true as const,
        data: {etag: 'etag-after', state: buildMockRunState({phase: args[4] as 'FAILED'})},
      }
    })
    const observe = vi.fn(async (_state: unknown) => {})
    const logger = makeLogger()
    const deps = makeDeps({coordinationConfig: configStoring('EXECUTING'), logger, runObserver: {observe}})

    // #when the run finishes without a successful write, and only then does an abandoned write commit
    await runToEnd(makeInMemoryRequest(), deps)
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'run: transitionRun COMPLETED failed')
    expect(observe.mock.calls.some(call => (call[0] as {phase: string}).phase === 'COMPLETED')).toBe(false)
    const written = buildMockRunState({
      phase: 'COMPLETED',
      run_id: String(mockRuntime.transitionRun.mock.calls.at(-1)?.[3]),
      details: {marker: 'late'},
    })
    pending[0]?.(written)
    await vi.advanceTimersByTimeAsync(0)

    // #then the observer received the written terminal state, once
    const frames = observe.mock.calls.map(call => call[0] as {phase: string; details?: Record<string, unknown>})
    expect(frames.filter(state => state.phase === 'COMPLETED')).toHaveLength(1)
    expect(frames.find(state => state.phase === 'COMPLETED')?.details).toEqual({marker: 'late'})
  })
})
