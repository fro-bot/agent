import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {Logger} from '../shared/logger.js'
import type {CoordinationConfig, RunState} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {createHeartbeatController, HEARTBEAT_STOP_GRACE_MS} from './heartbeat.js'

const {renewLeaseMock} = vi.hoisted(() => ({
  renewLeaseMock: vi.fn(),
}))

vi.mock('./lock.js', async importOriginal => {
  const original = await importOriginal<typeof import('./lock.js')>()

  return {
    ...original,
    renewLease: renewLeaseMock,
  }
})

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createStoreConfig(): ObjectStoreConfig {
  return {
    enabled: true,
    bucket: 'test-bucket',
    region: 'us-east-1',
    prefix: 'fro-bot-state',
  }
}

function createRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: 'run-1',
    surface: 'discord',
    thread_id: 'thread-1',
    entity_ref: 'owner/repo#123',
    phase: 'EXECUTING',
    started_at: '2026-04-24T18:00:00.000Z',
    last_heartbeat: '2026-04-24T18:00:00.000Z',
    holder_id: 'gateway-1',
    details: {},
    ...overrides,
  }
}

function createStoreAdapter(overrides: Partial<Required<ObjectStoreAdapter>> = {}): Required<ObjectStoreAdapter> {
  return {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    conditionalPut: vi.fn(async () => ok({etag: 'etag-next'})),
    conditionalDelete: vi.fn(async () => ok(undefined)),
    getObject: vi.fn(async () => ok({data: JSON.stringify(createRunState()), etag: 'etag-current'})),
    listWithMetadata: vi.fn(async () => ok([])),
    ...overrides,
  }
}

function createCoordinationConfig(storeAdapter: Required<ObjectStoreAdapter>): CoordinationConfig {
  return {
    storeAdapter,
    storeConfig: createStoreConfig(),
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
}

describe('heartbeat controller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
    renewLeaseMock.mockReset()
    renewLeaseMock.mockResolvedValue(ok({etag: 'lock-etag-next'}))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts a periodic heartbeat timer', () => {
    // #given
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter()),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )

    // #when
    controller.start()

    // #then
    expect(controller.isRunning).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('updates last_heartbeat on each timer tick', async () => {
    // #given
    const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(async () => ok({etag: 'etag-next'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(30_000)

    // #then
    expect(conditionalPut).toHaveBeenCalledWith(
      'fro-bot-state/coordination/owner/repo/runs/run-1.json',
      JSON.stringify(createRunState({last_heartbeat: '2026-04-24T18:15:30.000Z'})),
      {ifMatch: 'etag-current', tagging: 'object-type=run-state'},
    )
  })

  it('renews the lock before writing the tagged run-state heartbeat', async () => {
    // #given
    const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(async () => ok({etag: 'etag-next'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(30_000)

    // #then the lock renewal completes before the run-state write
    expect(renewLeaseMock).toHaveBeenCalledTimes(1)
    expect(conditionalPut).toHaveBeenCalledTimes(1)
    expect(conditionalPut).toHaveBeenCalledWith(
      'fro-bot-state/coordination/owner/repo/runs/run-1.json',
      expect.any(String),
      expect.objectContaining({tagging: 'object-type=run-state'}),
    )

    // #then the lock lease is renewed strictly before the tagged run-state write
    const renewOrder = renewLeaseMock.mock.invocationCallOrder[0]
    const putOrder = conditionalPut.mock.invocationCallOrder[0]
    expect(renewOrder).toBeDefined()
    expect(putOrder).toBeDefined()
    expect(renewOrder as number).toBeLessThan(putOrder as number)
  })

  it('resends the run-state tag on every repeated heartbeat tick', async () => {
    // #given
    const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(async () => ok({etag: 'etag-next'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()

    // #when three ticks elapse
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)

    // #then every tick's write carries the tag
    expect(conditionalPut).toHaveBeenCalledTimes(3)
    for (const call of conditionalPut.mock.calls) {
      expect(call[2]).toMatchObject({tagging: 'object-type=run-state'})
    }
  })

  it('prevents the run-state write when lock renewal fails', async () => {
    // #given
    renewLeaseMock.mockReset()
    renewLeaseMock.mockResolvedValue(err(new Error('lock renewal failed')))
    const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(async () => ok({etag: 'etag-next'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await controller.stop()

    // #then the tagged run-state write never happens, and the failure propagates
    expect(conditionalPut).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toBe('lock renewal failed')
  })

  it('returns the current run snapshot from stop without writing a terminal state', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-heartbeat'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    // #when
    const result = await controller.stop()

    // #then
    expect(controller.isRunning).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    // stop() does NOT perform a terminal write — only the heartbeat tick wrote.
    expect(conditionalPut).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.runEtag : null).toBe('etag-current')
    expect(result.success === true ? result.data.runState.phase : null).toBe('EXECUTING')
    expect(result.success === true ? result.data.lockEtag : null).toBe('lock-etag-next')
  })

  it('returns an authoritative snapshot when stopped before the first heartbeat tick', async () => {
    // #given
    const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>()
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()

    // #when
    const result = await controller.stop()

    // #then
    expect(conditionalPut).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.runEtag : null).toBe('etag-current')
    expect(result.success === true ? result.data.runState.phase : null).toBe('EXECUTING')
    // No tick ran, so the lock etag is still the constructor value.
    expect(result.success === true ? result.data.lockEtag : null).toBe('lock-etag-1')
    expect(controller.isRunning).toBe(false)
  })

  it('waits for an in-flight tick before stopping so no stale write lands after shutdown', async () => {
    // #given
    const heartbeatGate: {resolve?: (value: {success: true; data: {etag: string}}) => void} = {}
    let markHeartbeatStarted: (() => void) | null = null
    const heartbeatStarted = new Promise<void>(resolve => {
      markHeartbeatStarted = resolve
    })
    const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>().mockImplementationOnce(
      async () =>
        new Promise(resolve => {
          markHeartbeatStarted?.()
          heartbeatGate.resolve = value => resolve(value)
        }),
    )
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    const tickPromise = vi.advanceTimersByTimeAsync(30_000)
    await heartbeatStarted

    // #when
    const stopPromise = controller.stop()
    if (heartbeatGate.resolve != null) {
      heartbeatGate.resolve({success: true, data: {etag: 'etag-heartbeat'}})
    }
    await tickPromise
    await stopPromise
    const callsAfterStop = conditionalPut.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)

    // #then
    expect(conditionalPut).toHaveBeenCalledTimes(callsAfterStop)
    expect(controller.isRunning).toBe(false)
  })

  it('renews the lock lease on each heartbeat tick', async () => {
    // #given
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter()),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(30_000)

    // #then
    expect(renewLeaseMock).toHaveBeenCalledTimes(1)
    expect(renewLeaseMock).toHaveBeenCalledWith(
      expect.any(Object),
      'owner/repo',
      expect.objectContaining({run_id: 'run-1'}),
      'lock-etag-1',
      expect.any(Object),
    )
  })

  it('returns the tick error when stopping after a failed tick', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(err(new Error('optimistic concurrency failure')))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await controller.stop()

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toBe('optimistic concurrency failure')
  })

  it('returns ok after a tick error is cleared by a subsequent successful tick', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(err(new Error('optimistic concurrency failure')))
      .mockResolvedValueOnce(ok({etag: 'etag-recovered'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await controller.stop()

    // #then
    expect(result.success).toBe(true)
  })

  it('skips tick when a previous tick is still in-flight', async () => {
    // #given
    const pendingWrite: {resolve: ((value: {success: true; data: {etag: string}}) => void) | null} = {resolve: null}
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockImplementationOnce(
        async () =>
          new Promise(resolve => {
            pendingWrite.resolve = value => resolve(value)
          }),
      )
      .mockResolvedValueOnce(ok({etag: 'etag-recovered'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()

    // #when
    const firstTick = vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    const resolvePendingWrite = pendingWrite.resolve
    if (resolvePendingWrite != null) {
      resolvePendingWrite({success: true, data: {etag: 'etag-heartbeat'}})
    }
    await firstTick
    await controller.stop()

    // #then
    // Only the first tick made a write; the overlapping second tick was skipped, and stop()
    // performs no terminal write — exactly one conditionalPut call.
    expect(conditionalPut).toHaveBeenCalledTimes(1)
  })

  it('bounds stop() when an in-flight tick never settles and flags the outcome as uncertain', async () => {
    // #given a tick whose lock renewal never resolves
    renewLeaseMock.mockReset()
    renewLeaseMock.mockReturnValue(new Promise(() => {}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter()),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    // #when stop() is called and the grace period elapses
    let settled = false
    const stopPromise = controller.stop().then(result => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS - 1)
    const settledBeforeDeadline = settled
    await vi.advanceTimersByTimeAsync(1)

    // #then stop() waited the full grace, then resolved with an explicit uncertain failure
    expect(settledBeforeDeadline).toBe(false)
    expect(settled).toBe(true)
    const result = await stopPromise
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failure')
    expect(result.error.tickPending).toBe(true)
    // The lock ETag is the last CONFIRMED one: the hung renewal may or may not have moved it.
    expect(result.error.lockEtag).toBe('lock-etag-1')
    expect(controller.isRunning).toBe(false)
  })

  it('does not report the stop as uncertain when the tick settles within the grace period', async () => {
    // #given a tick that settles slowly but inside the grace period
    const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(
      async () =>
        new Promise(resolve => {
          setTimeout(() => resolve(ok({etag: 'etag-heartbeat'})), 2_000)
        }),
    )
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    // #when
    const stopPromise = controller.stop()
    await vi.advanceTimersByTimeAsync(2_000)
    const result = await stopPromise

    // #then
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.lockEtag : null).toBe('lock-etag-next')
  })

  it('returns the renewed lock ETag from stop() when the run-state write fails after a successful renewal', async () => {
    // #given the lock renews to a fresh ETag, then the run-state write fails
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(err(new Error('run-state write failed')))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    // #when
    const result = await controller.stop()

    // #then the error still surfaces, but carries the freshest confirmed lock ETag
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failure')
    expect(result.error.message).toBe('run-state write failed')
    expect(result.error.tickPending).toBe(false)
    expect(result.error.lockEtag).toBe('lock-etag-next')
  })

  it('returns the acquisition lock ETag from a failed stop when no renewal ever succeeded', async () => {
    // #given the lock renewal itself fails
    renewLeaseMock.mockReset()
    renewLeaseMock.mockResolvedValue(err(new Error('lock renewal failed')))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter()),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    // #when
    const result = await controller.stop()

    // #then
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failure')
    expect(result.error.lockEtag).toBe('lock-etag-1')
  })

  it('returns the renewed lock ETag when stop() fails to fetch the snapshot after a successful renewal', async () => {
    // #given one good tick, then the snapshot read on stop fails
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}))
      .mockResolvedValueOnce(err(new Error('S3 unavailable on stop')))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({getObject})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    // #when
    const result = await controller.stop()

    // #then
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failure')
    expect(result.error.lockEtag).toBe('lock-etag-next')
  })

  it('returns the ETag of the last successful run-state write when a later stop step fails', async () => {
    // #given one tick writes the run state (etag-written), then the snapshot read on stop fails
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-written'}))
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}))
      .mockResolvedValueOnce(err(new Error('S3 unavailable on stop')))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut, getObject})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    // #when
    const result = await controller.stop()

    // #then the caller gets the ETag its terminal transition must use, not the one it started with
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failure')
    expect(result.error.runEtag).toBe('etag-written')
  })

  it('returns the seed run ETag from a failed stop when no tick ever wrote the run state', async () => {
    // #given the lock renewal fails, so the run-state write never happens
    renewLeaseMock.mockReset()
    renewLeaseMock.mockResolvedValue(err(new Error('lock renewal failed')))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter()),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    // #when
    const result = await controller.stop()

    // #then
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failure')
    expect(result.error.runEtag).toBe('run-etag-0')
  })

  it('returns the last written run ETag when stop gives up on a tick that never settles', async () => {
    // #given tick 1 writes etag-written; tick 2 hangs in its lock renewal
    renewLeaseMock.mockReset()
    renewLeaseMock.mockResolvedValueOnce(ok({etag: 'lock-etag-next'})).mockReturnValue(new Promise(() => {}))
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-written'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(60_000)

    // #when
    const stopPromise = controller.stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS)
    const result = await stopPromise

    // #then
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failure')
    expect(result.error.tickPending).toBe(true)
    expect(result.error.runEtag).toBe('etag-written')
    expect(result.error.lockEtag).toBe('lock-etag-next')
  })

  it('clears the grace timer once the tick settles within the grace period', async () => {
    // #given a tick that is still in flight when stop() is called
    let finishWrite: (() => void) | null = null
    const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(
      async () =>
        new Promise(resolve => {
          finishWrite = () => resolve(ok({etag: 'etag-heartbeat'}))
        }),
    )
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)
    const baseline = vi.getTimerCount()

    // #when stop() arms its grace timer, then the tick settles
    const stopPromise = controller.stop()
    await vi.advanceTimersByTimeAsync(1)
    const duringStop = vi.getTimerCount()
    ;(finishWrite as (() => void) | null)?.()
    const result = await stopPromise

    // #then no timer is left behind: the interval is cleared and so is the grace timer
    expect(baseline).toBe(1)
    expect(duringStop).toBe(1)
    expect(result.success).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('performs no lock renewal or run-state write for a tick that was stopped before its I/O started', async () => {
    // #given a tick parked on its initial run-state read
    let finishRead: ((value: ReturnType<typeof ok>) => void) | null = null
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockImplementationOnce(
        async () =>
          new Promise(resolve => {
            finishRead = value => resolve(value as Awaited<ReturnType<Required<ObjectStoreAdapter>['getObject']>>)
          }),
      )
      .mockResolvedValue(ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}))
    const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(async () => ok({etag: 'etag-next'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({getObject, conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    // #when stop() begins, then the parked read completes
    const stopPromise = controller.stop()
    ;(finishRead as ((value: ReturnType<typeof ok>) => void) | null)?.(
      ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}),
    )
    const result = await stopPromise

    // #then the late tick skipped both writes, and stop() still returns a clean snapshot
    expect(renewLeaseMock).not.toHaveBeenCalled()
    expect(conditionalPut).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.lockEtag : null).toBe('lock-etag-1')
  })

  it('skips the run-state write for a tick whose lock renewal completes after stop began', async () => {
    // #given a tick parked inside its lock renewal
    let finishRenewal: (() => void) | null = null
    renewLeaseMock.mockReset()
    renewLeaseMock.mockImplementationOnce(
      async () =>
        new Promise(resolve => {
          finishRenewal = () => resolve(ok({etag: 'lock-etag-next'}))
        }),
    )
    const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(async () => ok({etag: 'etag-next'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    // #when stop() begins while the renewal is in flight, then the renewal lands
    const stopPromise = controller.stop()
    ;(finishRenewal as (() => void) | null)?.()
    const result = await stopPromise

    // #then the renewal that was already in flight is recorded, but no run-state write follows it
    expect(conditionalPut).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.lockEtag : null).toBe('lock-etag-next')
  })

  it('does not let a skipped late tick erase the error of an earlier failed tick', async () => {
    // #given tick 1 fails its lock renewal; tick 2 is parked on its run-state read when stop() begins
    renewLeaseMock.mockReset()
    renewLeaseMock.mockResolvedValue(err(new Error('lock renewal failed')))
    let finishRead: ((value: ReturnType<typeof ok>) => void) | null = null
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}))
      .mockImplementationOnce(
        async () =>
          new Promise(resolve => {
            finishRead = value => resolve(value as Awaited<ReturnType<Required<ObjectStoreAdapter>['getObject']>>)
          }),
      )
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({getObject})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(60_000)

    // #when
    const stopPromise = controller.stop()
    ;(finishRead as ((value: ReturnType<typeof ok>) => void) | null)?.(
      ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}),
    )
    const result = await stopPromise

    // #then the earlier failure is still reported
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toBe('lock renewal failed')
  })

  it('returns an error when stop fails to fetch the authoritative snapshot', async () => {
    // #given
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(err(new Error('S3 unavailable on stop')))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({getObject})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()

    // #when
    const result = await controller.stop()

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toBe('S3 unavailable on stop')
  })
})
