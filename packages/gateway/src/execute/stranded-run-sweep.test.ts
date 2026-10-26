import type {GatewayLogger} from '../discord/client.js'
import type {RecoverStaleRunsDeps} from './recovery.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {abortRegistry} from './abort-registry.js'
import {
  createStrandedRunPass,
  createStrandedRunSweep,
  isRunOwnedByThisProcess,
  STRANDED_RUN_NOTE,
  STRANDED_RUN_SWEEP_INTERVAL_MS,
  STRANDED_RUN_SWEEP_PASS_BOUND_MS,
} from './stranded-run-sweep.js'

const mockRecoverStaleRuns = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}))
vi.mock('./recovery.js', () => ({recoverStaleRuns: mockRecoverStaleRuns}))
const mockMaintenanceInFlight = vi.hoisted(() => new Set<string>())
vi.mock('../discord/maintenance-run.js', () => ({
  isMaintenanceRunInFlight: (runId: string) => mockMaintenanceInFlight.has(runId),
}))

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

describe('createStrandedRunSweep', () => {
  beforeEach(() => {
    mockRecoverStaleRuns.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks every 60 s, with the first tick one interval after start', async () => {
    // #given
    expect(STRANDED_RUN_SWEEP_INTERVAL_MS).toBe(60_000)
    const pass = vi.fn(async (_signal: AbortSignal) => {})
    const sweep = createStrandedRunSweep({pass, logger: makeLogger()})

    // #when
    sweep.start()
    await vi.advanceTimersByTimeAsync(STRANDED_RUN_SWEEP_INTERVAL_MS - 1)
    expect(pass).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(pass).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(STRANDED_RUN_SWEEP_INTERVAL_MS)

    // #then
    expect(pass).toHaveBeenCalledTimes(2)
    sweep.stop()
  })

  it("uses a single unref'd timer", () => {
    // #given
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    const sweep = createStrandedRunSweep({pass: async () => {}, logger: makeLogger()})

    // #when
    sweep.start()

    // #then
    const timers = intervalSpy.mock.results.map(result => result.value as ReturnType<typeof setInterval>)
    expect(timers).toHaveLength(1)
    expect(timers[0]?.hasRef()).toBe(false)
    sweep.stop()
  })

  it('never starts a pass while one is running, and starts the next once it settles', async () => {
    // #given a pass that outlasts several intervals
    let release: () => void = () => {}
    const pass = vi.fn(
      async (_signal: AbortSignal) =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    )
    const logger = makeLogger()
    const sweep = createStrandedRunSweep({pass, logger})

    // #when three intervals elapse during the first pass
    sweep.start()
    await vi.advanceTimersByTimeAsync(3 * STRANDED_RUN_SWEEP_INTERVAL_MS)

    // #then only one pass started
    expect(pass).toHaveBeenCalledTimes(1)

    // #and once it settles, the next tick starts a new one
    release()
    await vi.advanceTimersByTimeAsync(STRANDED_RUN_SWEEP_INTERVAL_MS)
    expect(pass).toHaveBeenCalledTimes(2)
    sweep.stop()
  })

  it('bounds a pass: its signal aborts at the bound, and the overrun is logged once', async () => {
    // #given a pass that only ends when told to stop
    let signal: AbortSignal | undefined
    const pass = vi.fn(
      async (passSignal: AbortSignal) =>
        new Promise<void>(resolve => {
          signal ??= passSignal
          passSignal.addEventListener('abort', () => {
            resolve()
          })
        }),
    )
    const logger = makeLogger()
    const sweep = createStrandedRunSweep({pass, logger})
    sweep.start()
    await vi.advanceTimersByTimeAsync(STRANDED_RUN_SWEEP_INTERVAL_MS)

    // #when
    await vi.advanceTimersByTimeAsync(STRANDED_RUN_SWEEP_PASS_BOUND_MS - 1)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    // #then
    expect(signal?.aborted).toBe(true)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    sweep.stop()
  })

  it('clears the bound timer when a pass ends in time, so nothing is left armed', async () => {
    // #given
    const sweep = createStrandedRunSweep({pass: async () => {}, logger: makeLogger()})
    sweep.start()

    // #when
    await vi.advanceTimersByTimeAsync(STRANDED_RUN_SWEEP_INTERVAL_MS)
    sweep.stop()

    // #then
    expect(vi.getTimerCount()).toBe(0)
  })

  it('logs a failing pass at error level and keeps ticking', async () => {
    // #given
    const pass = vi.fn(async (_signal: AbortSignal) => {
      throw new Error('store down')
    })
    const logger = makeLogger()
    const sweep = createStrandedRunSweep({pass, logger})

    // #when
    sweep.start()
    await vi.advanceTimersByTimeAsync(2 * STRANDED_RUN_SWEEP_INTERVAL_MS)

    // #then
    expect(pass).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({err: 'store down'}),
      'stranded-run sweep: pass failed',
    )
    sweep.stop()
  })

  it('stops ticking when stopped, and aborts the pass that is still running', async () => {
    // #given a pass in flight
    let signal: AbortSignal | undefined
    const pass = vi.fn(
      async (passSignal: AbortSignal) =>
        new Promise<void>(resolve => {
          signal = passSignal
          passSignal.addEventListener('abort', () => {
            resolve()
          })
        }),
    )
    const sweep = createStrandedRunSweep({pass, logger: makeLogger()})
    sweep.start()
    await vi.advanceTimersByTimeAsync(STRANDED_RUN_SWEEP_INTERVAL_MS)

    // #when
    sweep.stop()
    // (shorter than the pass bound, so only `stop` can have aborted the pass)
    await vi.advanceTimersByTimeAsync(2 * STRANDED_RUN_SWEEP_INTERVAL_MS)

    // #then no further pass started, the running one was told to stop, and no timer is left
    expect(pass).toHaveBeenCalledTimes(1)
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('start is idempotent: a second start does not add a second timer', async () => {
    // #given
    const pass = vi.fn(async (_signal: AbortSignal) => {})
    const sweep = createStrandedRunSweep({pass, logger: makeLogger()})

    // #when
    sweep.start()
    sweep.start()
    await vi.advanceTimersByTimeAsync(STRANDED_RUN_SWEEP_INTERVAL_MS)

    // #then
    expect(pass).toHaveBeenCalledTimes(1)
    sweep.stop()
  })
})

describe('createStrandedRunPass', () => {
  it('recovers only EXECUTING runs, skips owned ones, ignores the workspace gate, and posts the neutral note', async () => {
    // #given
    const recoverDeps = {identity: 'gw'} as unknown as RecoverStaleRunsDeps
    const isOwned = vi.fn((runId: string) => runId === 'owned')
    const controller = new AbortController()

    // #when
    await createStrandedRunPass({recoverDeps, isOwned})(controller.signal)

    // #then
    expect(mockRecoverStaleRuns).toHaveBeenCalledTimes(1)
    const [passedDeps, options] = mockRecoverStaleRuns.mock.calls[0] as unknown as [
      RecoverStaleRunsDeps,
      {
        phases: ReadonlySet<string>
        isOwned: (runId: string) => boolean
        requireQuiescence: boolean
        note: string
        signal: AbortSignal
      },
    ]
    expect(passedDeps).toBe(recoverDeps)
    expect([...options.phases]).toEqual(['EXECUTING'])
    expect(options.requireQuiescence).toBe(false)
    expect(options.note).toBe(STRANDED_RUN_NOTE)
    expect(options.signal).toBe(controller.signal)
    expect(options.isOwned('owned')).toBe(true)
    expect(options.isOwned('other')).toBe(false)
  })

  it('words the note neutrally: it neither claims a restart nor contradicts a reply that already posted', () => {
    // #then
    expect(STRANDED_RUN_NOTE).toBe("This run's status was reconciled: it is no longer running.")
    expect(STRANDED_RUN_NOTE).not.toMatch(/restart|interrupted|failed|re-send/i)
  })
})

describe('isRunOwnedByThisProcess', () => {
  afterEach(() => {
    abortRegistry.delete('run-mention')
    mockMaintenanceInFlight.clear()
  })

  it('owns a run in the abort registry (a mention or web run)', () => {
    // #given
    abortRegistry.register('run-mention')

    // #then
    expect(isRunOwnedByThisProcess('run-mention')).toBe(true)
  })

  it('owns an in-flight maintenance run, which is not in the abort registry', () => {
    // #given
    mockMaintenanceInFlight.add('run-maintenance')

    // #then
    expect(abortRegistry.has('run-maintenance')).toBe(false)
    expect(isRunOwnedByThisProcess('run-maintenance')).toBe(true)
  })

  it('does not own an unknown run, nor one that has finished', () => {
    // #given a run that was registered and then deleted
    abortRegistry.register('run-mention')
    abortRegistry.delete('run-mention')

    // #then
    expect(isRunOwnedByThisProcess('run-mention')).toBe(false)
    expect(isRunOwnedByThisProcess('never-seen')).toBe(false)
  })
})
