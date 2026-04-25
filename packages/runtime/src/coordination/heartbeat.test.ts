import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {Logger} from '../shared/logger.js'
import type {CoordinationConfig, RunState} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {createHeartbeatController} from './heartbeat.js'

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
      createLogger(),
    )
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(30_000)

    // #then
    expect(conditionalPut).toHaveBeenCalledWith(
      'fro-bot-state/coordination/owner/repo/runs/run-1.json',
      JSON.stringify(createRunState({last_heartbeat: '2026-04-24T18:15:30.000Z'})),
      {ifMatch: 'etag-current'},
    )
  })

  it('stops the timer and writes a terminal failed state on shutdown', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(ok({etag: 'etag-heartbeat'}))
      .mockResolvedValueOnce(ok({etag: 'etag-terminal'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      createLogger(),
    )
    controller.start()
    await vi.advanceTimersByTimeAsync(30_000)

    // #when
    await controller.stop()

    // #then
    expect(controller.isRunning).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(conditionalPut).toHaveBeenLastCalledWith(
      'fro-bot-state/coordination/owner/repo/runs/run-1.json',
      JSON.stringify(
        createRunState({
          phase: 'FAILED',
          last_heartbeat: '2026-04-24T18:15:30.000Z',
          details: {reason: 'heartbeat-stopped'},
        }),
      ),
      {ifMatch: 'etag-heartbeat'},
    )
  })

  it('writes terminal state even when stopped before the first heartbeat tick', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockImplementation(async () => ok({etag: 'etag-terminal'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      createLogger(),
    )
    controller.start()

    // #when
    await controller.stop()

    // #then
    expect(conditionalPut).toHaveBeenCalledTimes(1)
    expect(conditionalPut).toHaveBeenCalledWith(
      'fro-bot-state/coordination/owner/repo/runs/run-1.json',
      JSON.stringify(
        createRunState({
          phase: 'FAILED',
          details: {reason: 'heartbeat-stopped'},
        }),
      ),
      {ifMatch: 'etag-current'},
    )
    expect(controller.isRunning).toBe(false)
  })

  it('waits for an in-flight tick before stopping so no stale write lands after shutdown', async () => {
    // #given
    const heartbeatGate: {resolve?: (value: {success: true; data: {etag: string}}) => void} = {}
    let markHeartbeatStarted: (() => void) | null = null
    const heartbeatStarted = new Promise<void>(resolve => {
      markHeartbeatStarted = resolve
    })
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockImplementationOnce(
        async () =>
          new Promise(resolve => {
            markHeartbeatStarted?.()
            heartbeatGate.resolve = value => resolve(value)
          }),
      )
      .mockResolvedValueOnce(ok({etag: 'etag-terminal'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
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

  it('surfaces heartbeat failures when stopping after a failed tick', async () => {
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
      createLogger(),
    )
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(30_000)

    // #then
    await expect(controller.stop()).rejects.toThrow('optimistic concurrency failure')
  })

  it('clears tick error after a subsequent successful tick', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(err(new Error('optimistic concurrency failure')))
      .mockResolvedValueOnce(ok({etag: 'etag-recovered'}))
      .mockResolvedValueOnce(ok({etag: 'etag-terminal'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      createLogger(),
    )
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)

    // #then
    await expect(controller.stop()).resolves.toBeUndefined()
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
      .mockResolvedValueOnce(ok({etag: 'etag-terminal'}))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
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
    expect(conditionalPut).toHaveBeenCalledTimes(2)
  })

  it('fails stop when the terminal state write fails', async () => {
    // #given
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(err(new Error('terminal write failed')))
    const controller = createHeartbeatController(
      createCoordinationConfig(createStoreAdapter({conditionalPut})),
      'coordination',
      'owner/repo',
      'run-1',
      'lock-etag-1',
      createLogger(),
    )
    controller.start()

    // #when
    const stopResult = controller.stop()

    // #then
    await expect(stopResult).rejects.toThrow('terminal write failed')
  })
})
