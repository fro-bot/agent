import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {Logger} from '../shared/logger.js'
import type {Result} from '../shared/types.js'
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

function hangingSnapshotAfter(goodReads: number) {
  const getObject = vi.fn<Required<ObjectStoreAdapter>['getObject']>()
  for (let i = 0; i < goodReads; i += 1) {
    getObject.mockResolvedValueOnce(ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}))
  }
  getObject.mockImplementation(async () => new Promise(() => {}))
  return getObject
}

function build(
  getObject: ReturnType<typeof hangingSnapshotAfter>,
  conditionalPut?: Parameters<typeof createStoreAdapter>[0],
) {
  return createHeartbeatController(
    createCoordinationConfig(createStoreAdapter({getObject, ...conditionalPut})),
    'coordination',
    'owner/repo',
    'run-1',
    'lock-etag-1',
    'run-etag-0',
    createLogger(),
  )
}

type Renewal = Result<{etag: string}, Error>
type PutResult = Awaited<ReturnType<Required<ObjectStoreAdapter>['conditionalPut']>>
type GetResult = Awaited<ReturnType<Required<ObjectStoreAdapter>['getObject']>>

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

const hang = async <T>(): Promise<T> => new Promise<T>(() => {})

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return {promise, resolve}
}

function buildWithToken(acquisitionToken?: string) {
  const adapter = createStoreAdapter()
  return createHeartbeatController(
    createCoordinationConfig(adapter),
    'coordination',
    'owner/repo',
    'run-1',
    'lock-etag-1',
    'run-etag-0',
    createLogger(),
    ...(acquisitionToken === undefined ? [] : [acquisitionToken]),
  )
}

function buildWithLogger(adapterOverrides: Parameters<typeof createStoreAdapter>[0] = {}) {
  const logger = createLogger()
  const adapter = createStoreAdapter(adapterOverrides)
  const controller = createHeartbeatController(
    createCoordinationConfig(adapter),
    'coordination',
    'owner/repo',
    'run-1',
    'lock-etag-1',
    'run-etag-0',
    logger,
  )
  return {controller, logger, adapter}
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
      {ifMatch: 'etag-current', tagging: 'object-type=run-state', signal: expect.any(AbortSignal) as AbortSignal},
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
      'repo',
      expect.any(AbortSignal),
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
    // A 5 s interval, so the next tick is due inside the 10 s tick timeout (a hung tick now times out at 10 s).
    const controller = createHeartbeatController(
      {...createCoordinationConfig(createStoreAdapter({conditionalPut})), heartbeatIntervalMs: 5_000},
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      'run-etag-0',
      createLogger(),
    )
    controller.start()

    // #when
    const firstTick = vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
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

    // #then no timer is left behind: the interval is cleared and so are the grace timer and the tick timeout
    // (a tick in flight holds its tick timeout beside the interval, so the count is 2 where it used to be 1)
    expect(baseline).toBe(2)
    expect(duringStop).toBe(2)
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

  it.each([
    ['rejects with an Error', async () => Promise.reject(new Error('socket hang up'))],
    [
      'throws a non-Error synchronously',
      () => {
        // eslint-disable-next-line no-throw-literal
        throw 'adapter exploded'
      },
    ],
  ])('resolves to an error carrying the confirmed ETags when the snapshot read %s', async (_label, failingRead) => {
    // #given one good tick (lock renewed, run state written), then the snapshot read on stop fails abnormally
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}))
      .mockImplementationOnce(failingRead)
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

    // #when stop() must settle rather than reject
    const result = await controller.stop()

    // #then the caller still gets the ETags its release and terminal transition need
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failure')
    expect(result.error.tickPending).toBe(false)
    expect(result.error.lockEtag).toBe('lock-etag-next')
    expect(result.error.runEtag).toBe('etag-next')
  })

  it('does not resume after stop: start() is a no-op and an orphaned tick still skips its I/O', async () => {
    // #given a tick parked on its run-state read, and a stop() that gives up on it after the grace period
    let finishRead: ((value: ReturnType<typeof ok>) => void) | null = null
    const getObject = vi.fn<Required<ObjectStoreAdapter>['getObject']>().mockImplementationOnce(
      async () =>
        new Promise(resolve => {
          finishRead = value => resolve(value as Awaited<ReturnType<Required<ObjectStoreAdapter>['getObject']>>)
        }),
    )
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
    const stopPromise = controller.stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS)
    const stopped = await stopPromise
    expect(stopped.success === false ? stopped.error.tickPending : null).toBe(true)

    // #when the controller is started again and the orphaned read completes
    controller.start()
    await vi.advanceTimersByTimeAsync(90_000)
    ;(finishRead as ((value: ReturnType<typeof ok>) => void) | null)?.(
      ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}),
    )
    await vi.advanceTimersByTimeAsync(1)

    // #then nothing resumed: no interval, and the orphaned tick performed no lock renewal or run-state write
    expect(controller.isRunning).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(renewLeaseMock).not.toHaveBeenCalled()
    expect(conditionalPut).not.toHaveBeenCalled()
  })

  describe('a snapshot read that never settles', () => {
    it('bounds stop() to the grace period when no tick is active, carrying the ETags it holds', async () => {
      // #given no tick has run, and the snapshot read never settles
      const controller = build(hangingSnapshotAfter(0))
      controller.start()

      // #when
      let settled = false
      const stopPromise = controller.stop().then(result => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS - 1)
      const settledBeforeBudget = settled
      await vi.advanceTimersByTimeAsync(1)

      // #then stop() resolved exactly at the budget with an explicit, non-pending failure
      expect(settledBeforeBudget).toBe(false)
      expect(settled).toBe(true)
      const result = await stopPromise
      expect(result.success).toBe(false)
      if (result.success === true) throw new Error('expected a failure')
      expect(result.error.message).toBe('Lease finalize did not settle within 5000ms of stop')
      expect(result.error.tickPending).toBe(false)
      expect(result.error.lockEtag).toBe('lock-etag-1')
      expect(result.error.runEtag).toBe('run-etag-0')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('bounds stop() after a tick settled, carrying the ETags that tick confirmed', async () => {
      // #given one good tick (lock renewed, run state written), then the snapshot read never settles
      const controller = build(hangingSnapshotAfter(1))
      controller.start()
      await vi.advanceTimersByTimeAsync(30_000)

      // #when
      const stopPromise = controller.stop()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS)
      const result = await stopPromise

      // #then
      expect(result.success).toBe(false)
      if (result.success === true) throw new Error('expected a failure')
      expect(result.error.tickPending).toBe(false)
      expect(result.error.lockEtag).toBe('lock-etag-next')
      expect(result.error.runEtag).toBe('etag-next')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('shares one grace budget with the tick wait: a slow tick leaves the snapshot only the remainder', async () => {
      // #given a tick that settles 2s into stop(), followed by a snapshot read that never settles
      let finishWrite: (() => void) | null = null
      const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(
        async () =>
          new Promise(resolve => {
            finishWrite = () => resolve(ok({etag: 'etag-heartbeat'}))
          }),
      )
      const controller = build(hangingSnapshotAfter(1), {conditionalPut})
      controller.start()
      await vi.advanceTimersByTimeAsync(30_000)

      // #when
      let settled = false
      const stopPromise = controller.stop().then(result => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(2_000)
      ;(finishWrite as (() => void) | null)?.()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS - 2_000 - 1)
      const settledBeforeBudget = settled
      await vi.advanceTimersByTimeAsync(1)

      // #then stop() resolved within ONE grace period of its call, not two
      expect(settledBeforeBudget).toBe(false)
      expect(settled).toBe(true)
      const result = await stopPromise
      expect(result.success).toBe(false)
      if (result.success === true) throw new Error('expected a failure')
      expect(result.error.tickPending).toBe(false)
      expect(result.error.runEtag).toBe('etag-heartbeat')
      expect(vi.getTimerCount()).toBe(0)
    })
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

  describe('tick timeout and abort', () => {
    const TICK_TIMEOUT_MS = 10_000

    it('times out a hung renewal at 10 s, logs a warning, aborts its signal, and runs the next tick', async () => {
      // #given the first renewal never settles
      renewLeaseMock.mockReset()
      renewLeaseMock.mockImplementationOnce(async () => hang<Renewal>()).mockResolvedValue(ok({etag: 'lock-etag-2'}))
      const {controller, logger} = buildWithLogger()
      controller.start()

      // #when the tick starts and the tick timeout elapses
      await vi.advanceTimersByTimeAsync(30_000 + TICK_TIMEOUT_MS - 1)
      expect(logger.warning).not.toHaveBeenCalled()
      const signal = renewLeaseMock.mock.calls[0]?.[6] as AbortSignal
      expect(signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      // #then
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {
        repo: 'owner/repo',
        runId: 'run-1',
        error: 'Lease renewal exceeded 10000ms',
      })
      expect(signal.aborted).toBe(true)

      // #when the next interval arrives
      await vi.advanceTimersByTimeAsync(30_000 - TICK_TIMEOUT_MS)

      // #then the next tick ran against the original lock ETag
      expect(renewLeaseMock).toHaveBeenCalledTimes(2)
      expect(renewLeaseMock.mock.calls[1]?.[3]).toBe('lock-etag-1')
    })

    it('times out a hung RunState write without losing the confirmed lock ETag', async () => {
      // #given the renewal confirms and the RunState write never settles
      const conditionalPut = vi
        .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
        .mockImplementationOnce(async () => hang<PutResult>())
        .mockResolvedValue(ok({etag: 'etag-next'}))
      const {controller, logger} = buildWithLogger({conditionalPut})
      controller.start()

      // #when
      await vi.advanceTimersByTimeAsync(30_000 + TICK_TIMEOUT_MS)
      const result = await controller.stop()

      // #then the timeout is a failure after a confirmed renewal: the renewed ETag stands, with a warning that says so
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease tick failed after renewal', {
        repo: 'owner/repo',
        runId: 'run-1',
        error: 'Lease tick exceeded 10000ms',
      })
      expect(result.success).toBe(false)
      if (result.success === true) throw new Error('expected a failure')
      expect(result.error.message).toBe('Lease tick exceeded 10000ms')
      expect(result.error.lockEtag).toBe('lock-etag-next')
      expect(result.error.runEtag).toBe('run-etag-0')
      expect(result.error.tickPending).toBe(false)
    })

    it('does not apply a renewal that lands after its tick timed out', async () => {
      // #given
      const late = deferred<Renewal>()
      renewLeaseMock.mockReset()
      renewLeaseMock.mockImplementationOnce(async () => late.promise)
      const {controller, adapter} = buildWithLogger()
      controller.start()
      await vi.advanceTimersByTimeAsync(30_000 + TICK_TIMEOUT_MS)

      // #when the abandoned renewal succeeds
      late.resolve(ok({etag: 'lock-etag-late'}))
      await vi.advanceTimersByTimeAsync(0)
      const result = await controller.stop()

      // #then neither the lock ETag nor the RunState was touched
      expect(result.success).toBe(false)
      if (result.success === true) throw new Error('expected a failure')
      expect(result.error.lockEtag).toBe('lock-etag-1')
      expect(result.error.runEtag).toBe('run-etag-0')
      expect(adapter.conditionalPut).not.toHaveBeenCalled()
    })

    it('recovers after the drop: the next tick adopts the stored ETag and the tick after renews against it', async () => {
      // #given tick 1's renewal committed server-side (ETag lock-etag-committed) but timed out, so tick 2's renewal 412s
      renewLeaseMock.mockReset()
      renewLeaseMock
        .mockImplementationOnce(async () => hang<Renewal>())
        .mockResolvedValueOnce(err(new Error('412 precondition failed')))
        .mockResolvedValue(ok({etag: 'lock-etag-after'}))
      const lockRecord = {
        repo: 'owner/repo',
        holder_id: 'gateway-1',
        surface: 'discord',
        acquired_at: '2026-04-24T18:15:30.000Z',
        ttl_seconds: 900,
        run_id: 'run-1',
        acquisition_token: 'token-0001-abcd',
      }
      const getObject = vi.fn<Required<ObjectStoreAdapter>['getObject']>(async key =>
        key.endsWith('/locks/repo.json')
          ? ok({data: JSON.stringify(lockRecord), etag: 'lock-etag-committed'})
          : ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}),
      )
      const controller = createHeartbeatController(
        createCoordinationConfig(createStoreAdapter({getObject})),
        'coordination',
        'owner/repo',
        'run-1',
        'lock-etag-1',
        'run-etag-0',
        createLogger(),
        'token-0001-abcd',
      )
      controller.start()

      // #when tick 1 times out, tick 2 hits the dead ETag, and tick 3 runs
      await vi.advanceTimersByTimeAsync(30_000 * 3)

      // #then the renewals went out against the original ETag twice, then the adopted one
      expect(renewLeaseMock.mock.calls.map(call => call[3] as string)).toEqual([
        'lock-etag-1',
        'lock-etag-1',
        'lock-etag-committed',
      ])
      const stopped = await controller.stop()
      expect(stopped.success).toBe(true)
      expect(stopped.success ? stopped.data.lockEtag : '').toBe('lock-etag-after')
    })

    it('does not apply a RunState write that lands after its tick timed out', async () => {
      // #given
      const late = deferred<PutResult>()
      const conditionalPut = vi
        .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
        .mockImplementationOnce(async () => late.promise)
      const {controller} = buildWithLogger({conditionalPut})
      controller.start()
      await vi.advanceTimersByTimeAsync(30_000 + TICK_TIMEOUT_MS)

      // #when the abandoned write succeeds
      late.resolve(ok({etag: 'run-etag-late'}))
      await vi.advanceTimersByTimeAsync(0)
      const result = await controller.stop()

      // #then the run ETag the caller will transition with is still the last one a current tick wrote
      expect(result.success).toBe(false)
      if (result.success === true) throw new Error('expected a failure')
      expect(result.error.runEtag).toBe('run-etag-0')
      expect(result.error.lockEtag).toBe('lock-etag-next')
    })

    it('starts no RunState read once stop has begun', async () => {
      // #given a tick parked on its renewal when stop gives up on it
      const hung = deferred<Renewal>()
      renewLeaseMock.mockReset()
      renewLeaseMock.mockImplementationOnce(async () => hung.promise)
      const {controller, adapter} = buildWithLogger()
      controller.start()
      await vi.advanceTimersByTimeAsync(30_000)
      const stopped = controller.stop()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS)
      await stopped
      vi.mocked(adapter.getObject).mockClear()

      // #when time passes and the abandoned renewal finally lands
      await vi.advanceTimersByTimeAsync(90_000)
      hung.resolve(ok({etag: 'lock-etag-late'}))
      await vi.advanceTimersByTimeAsync(0)

      // #then no read, and no write, started
      expect(adapter.getObject).not.toHaveBeenCalled()
      expect(adapter.conditionalPut).not.toHaveBeenCalled()
    })

    it('hands one live signal to the read, the renewal and the write, and aborts none of them at stop', async () => {
      // #given
      const {controller, adapter} = buildWithLogger()
      controller.start()

      // #when one tick runs, then stop reads the snapshot
      await vi.advanceTimersByTimeAsync(30_000)
      const stopped = await controller.stop()

      // #then
      expect(stopped.success).toBe(true)
      const readSignal = vi.mocked(adapter.getObject).mock.calls[0]?.[1]?.signal
      const renewSignal = renewLeaseMock.mock.calls[0]?.[6] as AbortSignal
      const writeSignal = vi.mocked(adapter.conditionalPut).mock.calls[0]?.[2].signal
      const snapshotSignal = vi.mocked(adapter.getObject).mock.calls[1]?.[1]?.signal
      expect(readSignal).toBeInstanceOf(AbortSignal)
      expect(renewSignal).toBe(readSignal)
      expect(writeSignal).toBe(readSignal)
      expect(readSignal?.aborted).toBe(false)
      expect(snapshotSignal).toBeInstanceOf(AbortSignal)
      expect(snapshotSignal?.aborted).toBe(false)
    })

    it('never rejects from stop() when the logger throws', async () => {
      // #given a logger whose debug sink is down
      const logger = createLogger()
      vi.mocked(logger.debug).mockImplementation(() => {
        throw new Error('log sink down')
      })
      const controller = createHeartbeatController(
        createCoordinationConfig(createStoreAdapter()),
        'coordination',
        'owner/repo',
        'run-1',
        'lock-etag-1',
        'run-etag-0',
        logger,
      )

      // #when
      const stopped = await controller.stop()

      // #then stop still ran to completion
      expect(stopped.success).toBe(true)
      expect(controller.isRunning).toBe(false)
    })

    it('keeps the underlying error as the cause of a failed stop', async () => {
      // #given a renewal that fails
      const failure = new Error('lock renewal failed')
      renewLeaseMock.mockReset()
      renewLeaseMock.mockResolvedValue(err(failure))
      const {controller} = buildWithLogger()
      controller.start()
      await vi.advanceTimersByTimeAsync(30_000)

      // #when
      const result = await controller.stop()

      // #then
      expect(result.success).toBe(false)
      if (result.success === true) throw new Error('expected a failure')
      expect(result.error.message).toBe('lock renewal failed')
      expect(result.error.cause).toBe(failure)
    })

    it('aborts the snapshot read when the stop budget runs out', async () => {
      // #given a snapshot read that never settles
      const getObject = hangingSnapshotAfter(0)
      const {controller} = buildWithLogger({getObject})

      // #when
      const stopped = controller.stop()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS - 1)
      const signal = getObject.mock.calls[0]?.[1]?.signal
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await stopped

      // #then
      expect(signal?.aborted).toBe(true)
    })

    it('skips the tick when stop begins after the RunState read, and keeps an earlier error', async () => {
      // #given tick 1 fails its renewal; tick 2 is parked on its read when stop begins
      const read = deferred<GetResult>()
      renewLeaseMock.mockReset()
      renewLeaseMock.mockResolvedValue(err(new Error('first renewal failed')))
      const getObject = vi
        .fn<Required<ObjectStoreAdapter>['getObject']>()
        .mockResolvedValueOnce(ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}))
        .mockImplementationOnce(async () => read.promise)
      const {controller, adapter} = buildWithLogger({getObject})
      controller.start()
      await vi.advanceTimersByTimeAsync(60_000)

      // #when stop begins, then the read lands
      const stopped = controller.stop()
      read.resolve(ok({data: JSON.stringify(createRunState()), etag: 'etag-current'}))
      const result = await stopped

      // #then tick 2 renewed nothing and wrote nothing, so the first error stands
      expect(renewLeaseMock).toHaveBeenCalledTimes(1)
      expect(adapter.conditionalPut).not.toHaveBeenCalled()
      expect(result.success).toBe(false)
      expect(result.success === false ? result.error.message : '').toBe('first renewal failed')
    })

    it('clears an earlier write failure when a tick renews and then skips its write because stop began', async () => {
      // #given tick 1's RunState write fails; tick 2 renews after stop has begun
      const renewal = deferred<Renewal>()
      renewLeaseMock.mockReset()
      renewLeaseMock
        .mockResolvedValueOnce(ok({etag: 'lock-etag-2'}))
        .mockImplementationOnce(async () => renewal.promise)
      const conditionalPut = vi
        .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
        .mockResolvedValueOnce(err(new Error('run state write failed')))
      const getObject = vi
        .fn<Required<ObjectStoreAdapter>['getObject']>()
        .mockResolvedValue(ok({data: JSON.stringify(createRunState()), etag: 'etag-fresh'}))
      const {controller} = buildWithLogger({conditionalPut, getObject})
      controller.start()
      await vi.advanceTimersByTimeAsync(60_000)

      // #when stop begins while tick 2's renewal is in flight, and it lands
      const stopped = controller.stop()
      renewal.resolve(ok({etag: 'lock-etag-3'}))
      const result = await stopped

      // #then tick 2 confirmed a renewal, so the earlier failure is cleared and stop hands back a fresh snapshot
      expect(conditionalPut).toHaveBeenCalledTimes(1)
      expect(result.success).toBe(true)
      expect(result.success === true ? result.data : null).toEqual({
        runEtag: 'etag-fresh',
        runState: createRunState(),
        lockEtag: 'lock-etag-3',
      })
    })
  })

  describe('acquisition token', () => {
    it('carries the token on every renewal record', async () => {
      // #given
      const controller = buildWithToken('token-0001-abcd')
      controller.start()

      // #when two ticks elapse
      await vi.advanceTimersByTimeAsync(60_000)

      // #then
      expect(renewLeaseMock).toHaveBeenCalledTimes(2)
      for (const call of renewLeaseMock.mock.calls) {
        expect(call[2]).toMatchObject({holder_id: 'gateway-1', run_id: 'run-1', acquisition_token: 'token-0001-abcd'})
      }
    })

    it('writes no token field when none was given, so the record is unchanged for existing callers', async () => {
      // #given
      const controller = buildWithToken()
      controller.start()

      // #when
      await vi.advanceTimersByTimeAsync(30_000)

      // #then
      expect(Object.keys(renewLeaseMock.mock.calls[0]?.[2] as object)).not.toContain('acquisition_token')
    })
  })
})
