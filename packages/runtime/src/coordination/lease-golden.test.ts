/**
 * Golden-trace characterization of the gateway heartbeat's lease renewal (`createHeartbeatController`).
 *
 * These traces record what the controller does TODAY, against the real runtime (`renewLease` and all) over a recording
 * in-memory adapter. They exist so the shared lease-loop extraction can prove it changed nothing it did not mean to.
 * Where the current behaviour is a known gap that a later unit changes on purpose (no per-tick timeout, late results
 * applied, no abort signal), the test says so; that unit updates the trace deliberately.
 *
 * Deliberately NOT recorded: leftover or lingering timers. The extraction clears timers the current code leaves behind,
 * and that cannot be seen from outside.
 */
import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {Result} from '../shared/types.js'
import type {CoordinationConfig, RunState} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {createHeartbeatController, HEARTBEAT_STOP_GRACE_MS} from './heartbeat.js'

const T0 = new Date('2026-04-24T18:15:00.000Z')
const INTERVAL_MS = 30_000

const LOCK_KEY = 'fro-bot-state/coordination/owner/repo/locks/repo.json'
const RUN_KEY = 'fro-bot-state/coordination/owner/repo/runs/run-1.json'
const RUN_STATE_TAGGING = 'object-type=run-state'

/** One adapter call, or one test marker, in the order it happened. `t` is ms since the test's start. */
interface TraceEntry {
  readonly t: number
  readonly op: 'getObject' | 'conditionalPut' | 'conditionalDelete' | 'mark'
  readonly key?: string
  readonly ifMatch?: string
  readonly ifNoneMatch?: string
  readonly tagging?: string
  /** Whether the call carried an `AbortSignal`. */
  readonly signal?: boolean
  /** Marker text, for `op: 'mark'`. */
  readonly name?: string
}

interface Call {
  /** The call's 1-based position among calls of the same op to the same key. */
  readonly n: number
  readonly key: string
}

type Fallback<T> = () => Promise<Result<T, Error>>
interface Script {
  readonly getObject?: (
    call: Call,
    fallback: Fallback<{data: string; etag: string}>,
  ) => Promise<Result<{data: string; etag: string}, Error>>
  readonly conditionalPut?: (call: Call, fallback: Fallback<{etag: string}>) => Promise<Result<{etag: string}, Error>>
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return {promise, resolve}
}

const hang = async <T>(): Promise<T> => new Promise<T>(() => {})

function createRunState(): RunState {
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
  }
}

function createHarness(script: Script = {}) {
  const trace: TraceEntry[] = []
  const counts = new Map<string, number>()
  // The RunState object's current ETag: reads return it, a successful default write advances it.
  let storedRunEtag = 'run-etag-0'

  const now = (): number => Date.now() - T0.getTime()
  const mark = (name: string): void => {
    trace.push({t: now(), op: 'mark', name})
  }
  const nextCall = (op: string, key: string): Call => {
    const n = (counts.get(`${op}:${key}`) ?? 0) + 1
    counts.set(`${op}:${key}`, n)
    return {n, key}
  }

  const adapter: Required<ObjectStoreAdapter> = {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    listWithMetadata: vi.fn(async () => ok([])),
    conditionalDelete: vi.fn<NonNullable<ObjectStoreAdapter['conditionalDelete']>>(async (key, options) => {
      trace.push({
        t: now(),
        op: 'conditionalDelete',
        key,
        ifMatch: options.ifMatch,
        signal: options.signal !== undefined,
      })
      return ok(undefined)
    }),
    getObject: vi.fn<NonNullable<ObjectStoreAdapter['getObject']>>(async (key, options) => {
      trace.push({t: now(), op: 'getObject', key, signal: options?.signal !== undefined})
      const call = nextCall('getObject', key)
      const fallback: Fallback<{data: string; etag: string}> = async () =>
        ok({data: JSON.stringify(createRunState()), etag: storedRunEtag})
      return script.getObject === undefined ? fallback() : script.getObject(call, fallback)
    }),
    conditionalPut: vi.fn<NonNullable<ObjectStoreAdapter['conditionalPut']>>(async (key, _data, options) => {
      trace.push({
        t: now(),
        op: 'conditionalPut',
        key,
        ...(options.ifMatch === undefined ? {} : {ifMatch: options.ifMatch}),
        ...(options.ifNoneMatch === undefined ? {} : {ifNoneMatch: options.ifNoneMatch}),
        ...(options.tagging === undefined ? {} : {tagging: options.tagging}),
        signal: false,
      })
      const call = nextCall('conditionalPut', key)
      const fallback: Fallback<{etag: string}> = async () => {
        const etag = key === LOCK_KEY ? `lock-etag-${call.n}` : `run-etag-${call.n}`
        if (key === RUN_KEY) storedRunEtag = etag
        return ok({etag})
      }
      return script.conditionalPut === undefined ? fallback() : script.conditionalPut(call, fallback)
    }),
  }

  const storeConfig: ObjectStoreConfig = {
    enabled: true,
    bucket: 'test-bucket',
    region: 'us-east-1',
    prefix: 'fro-bot-state',
  }
  const config: CoordinationConfig = {
    storeAdapter: adapter,
    storeConfig,
    lockTtlSeconds: 900,
    heartbeatIntervalMs: INTERVAL_MS,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
  const logger = {debug: vi.fn()}
  const controller = createHeartbeatController(
    config,
    'coordination',
    'owner/repo',
    'run-1',
    'lock-etag-0',
    'run-etag-0',
    logger,
  )

  /** Calls `stop()` and marks when it began and when it resolved. */
  const stop = async () => {
    mark('stop:begin')
    return controller.stop().then(result => {
      mark('stop:resolved')
      return result
    })
  }

  return {trace, controller, logger, stop, mark}
}

describe('gateway heartbeat golden traces', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads RunState, renews the lock, then writes RunState; ETags chain across ticks and stop reads a snapshot', async () => {
    // #given
    const {trace, controller, stop} = createHarness()
    controller.start()

    // #when two ticks elapse and the controller is stopped
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    const result = await stop()

    // #then
    expect(trace).toEqual([
      {t: 30_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: 'lock-etag-0', signal: false},
      {t: 30_000, op: 'conditionalPut', key: RUN_KEY, ifMatch: 'run-etag-0', tagging: RUN_STATE_TAGGING, signal: false},
      {t: 60_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 60_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: 'lock-etag-1', signal: false},
      {t: 60_000, op: 'conditionalPut', key: RUN_KEY, ifMatch: 'run-etag-1', tagging: RUN_STATE_TAGGING, signal: false},
      {t: 60_000, op: 'mark', name: 'stop:begin'},
      {t: 60_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 60_000, op: 'mark', name: 'stop:resolved'},
    ])
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.lockEtag : '').toBe('lock-etag-2')
    expect(result.success === true ? result.data.runEtag : '').toBe('run-etag-2')
  })

  it('skips the RunState write and still reads no snapshot when the renewal fails; stop returns that error', async () => {
    // #given the lock renewal's PUT fails
    const {trace, controller, stop} = createHarness({
      conditionalPut: async (call, fallback) =>
        call.key === LOCK_KEY ? err(new Error('lock renewal failed')) : fallback(),
    })
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    const result = await stop()

    // #then no RunState write, and no snapshot read after the failed tick
    expect(trace).toEqual([
      {t: 30_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: 'lock-etag-0', signal: false},
      {t: 30_000, op: 'mark', name: 'stop:begin'},
      {t: 30_000, op: 'mark', name: 'stop:resolved'},
    ])
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failed stop')
    expect(result.error.message).toBe('lock renewal failed')
    expect(result.error).toMatchObject({lockEtag: 'lock-etag-0', runEtag: 'run-etag-0', tickPending: false})
  })

  it('carries the renewed lock ETag when the RunState write fails after a successful renewal', async () => {
    // #given the renewal succeeds and the RunState write fails
    const {trace, controller, stop} = createHarness({
      conditionalPut: async (call, fallback) =>
        call.key === RUN_KEY ? err(new Error('run state write failed')) : fallback(),
    })
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    const result = await stop()

    // #then the write was attempted; the error carries the renewed lock ETag and the untouched RunState ETag
    expect(trace).toEqual([
      {t: 30_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: 'lock-etag-0', signal: false},
      {t: 30_000, op: 'conditionalPut', key: RUN_KEY, ifMatch: 'run-etag-0', tagging: RUN_STATE_TAGGING, signal: false},
      {t: 30_000, op: 'mark', name: 'stop:begin'},
      {t: 30_000, op: 'mark', name: 'stop:resolved'},
    ])
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failed stop')
    expect(result.error.message).toBe('run state write failed')
    expect(result.error).toMatchObject({lockEtag: 'lock-etag-1', runEtag: 'run-etag-0', tickPending: false})
  })

  it('clears an earlier tick error when a later tick completes; the failed renewal did not advance the lock ETag', async () => {
    // #given only the first renewal fails
    const {trace, controller, stop} = createHarness({
      conditionalPut: async (call, fallback) =>
        call.key === LOCK_KEY && call.n === 1 ? err(new Error('lock renewal failed')) : fallback(),
    })
    controller.start()

    // #when two ticks elapse
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    const result = await stop()

    // #then the second tick renews against the original ETag and stop returns a snapshot
    expect(trace).toEqual([
      {t: 30_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: 'lock-etag-0', signal: false},
      {t: 60_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 60_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: 'lock-etag-0', signal: false},
      {t: 60_000, op: 'conditionalPut', key: RUN_KEY, ifMatch: 'run-etag-0', tagging: RUN_STATE_TAGGING, signal: false},
      {t: 60_000, op: 'mark', name: 'stop:begin'},
      {t: 60_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 60_000, op: 'mark', name: 'stop:resolved'},
    ])
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.lockEtag : '').toBe('lock-etag-2')
  })

  it('keeps an earlier tick error when the next tick skips its I/O because stop began', async () => {
    // #given the first renewal fails, and the second tick's RunState read is held open
    const secondRead = deferred<Result<{data: string; etag: string}, Error>>()
    const {trace, controller, stop} = createHarness({
      conditionalPut: async (call, fallback) =>
        call.key === LOCK_KEY && call.n === 1 ? err(new Error('first renewal failed')) : fallback(),
      getObject: async (call, fallback) => (call.n === 2 ? secondRead.promise : fallback()),
    })
    controller.start()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)

    // #when stop begins while tick 2 waits on its read, then the read returns
    const stopped = stop()
    await vi.advanceTimersByTimeAsync(1_000)
    secondRead.resolve(ok({data: JSON.stringify(createRunState()), etag: 'run-etag-0'}))
    const result = await stopped

    // #then tick 2 renewed nothing, so the first tick's error is still what stop reports; no snapshot is read
    expect(trace).toEqual([
      {t: 30_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: 'lock-etag-0', signal: false},
      {t: 60_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 60_000, op: 'mark', name: 'stop:begin'},
      {t: 61_000, op: 'mark', name: 'stop:resolved'},
    ])
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failed stop')
    expect(result.error.message).toBe('first renewal failed')
    expect(result.error).toMatchObject({lockEtag: 'lock-etag-0', tickPending: false})
  })

  it('has no per-tick timeout: a hung renewal makes every later tick skip silently', async () => {
    // #given the first renewal never settles
    const {trace, controller} = createHarness({
      conditionalPut: async (call, fallback) => (call.key === LOCK_KEY ? hang() : fallback()),
    })
    controller.start()

    // #when ten intervals elapse
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10)

    // #then only the first tick ever touched the adapter. (Gap: a later unit bounds ticks at 10 s.)
    expect(trace).toEqual([
      {t: 30_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: 'lock-etag-0', signal: false},
    ])
  })

  it('stop with a renewal pending returns tickPending after the grace period, without a snapshot; a late renewal is applied', async () => {
    // #given the first renewal is held open
    const renewal = deferred<Result<{etag: string}, Error>>()
    const {trace, controller, stop} = createHarness({
      conditionalPut: async (call, fallback) => (call.key === LOCK_KEY && call.n === 1 ? renewal.promise : fallback()),
    })
    controller.start()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    // #when stop begins and the grace period elapses
    const stopped = stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS)
    const result = await stopped

    // #then stop gave up after exactly the grace period
    expect(trace).toEqual([
      {t: 30_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: 'lock-etag-0', signal: false},
      {t: 30_000, op: 'mark', name: 'stop:begin'},
      {t: 35_000, op: 'mark', name: 'stop:resolved'},
    ])
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failed stop')
    expect(result.error.message).toBe('Heartbeat tick did not settle within 5000ms of stop')
    expect(result.error).toMatchObject({lockEtag: 'lock-etag-0', runEtag: 'run-etag-0', tickPending: true})

    // #when the abandoned renewal lands after stop returned
    renewal.resolve(ok({etag: 'lock-etag-late'}))
    await vi.advanceTimersByTimeAsync(0)
    const again = await stop()

    // #then it was applied to the lock ETag (gap: a later unit drops late results) but wrote no RunState
    expect(trace.slice(4)).toEqual([
      {t: 35_000, op: 'mark', name: 'stop:begin'},
      {t: 35_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 35_000, op: 'mark', name: 'stop:resolved'},
    ])
    expect(again.success).toBe(true)
    expect(again.success === true ? again.data.lockEtag : '').toBe('lock-etag-late')
  })

  it('stop with a RunState write pending returns tickPending with the renewed lock ETag; a late write is applied', async () => {
    // #given the renewal succeeds and the RunState write is held open
    const write = deferred<Result<{etag: string}, Error>>()
    const {trace, controller, stop} = createHarness({
      conditionalPut: async (call, fallback) => (call.key === RUN_KEY ? write.promise : fallback()),
      getObject: async (call, fallback) => (call.n === 2 ? err(new Error('snapshot unavailable')) : fallback()),
    })
    controller.start()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    // #when stop begins and the grace period elapses
    const stopped = stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS)
    const result = await stopped

    // #then
    expect(trace).toEqual([
      {t: 30_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: 'lock-etag-0', signal: false},
      {t: 30_000, op: 'conditionalPut', key: RUN_KEY, ifMatch: 'run-etag-0', tagging: RUN_STATE_TAGGING, signal: false},
      {t: 30_000, op: 'mark', name: 'stop:begin'},
      {t: 35_000, op: 'mark', name: 'stop:resolved'},
    ])
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failed stop')
    expect(result.error).toMatchObject({lockEtag: 'lock-etag-1', runEtag: 'run-etag-0', tickPending: true})

    // #when the abandoned write lands after stop returned, and a second stop reports through a failing snapshot read
    write.resolve(ok({etag: 'run-etag-late'}))
    await vi.advanceTimersByTimeAsync(0)
    const again = await stop()

    // #then the late write's ETag was applied (gap: a later unit drops late results)
    expect(again.success).toBe(false)
    if (again.success === true) throw new Error('expected a failed stop')
    expect(again.error).toMatchObject({lockEtag: 'lock-etag-1', runEtag: 'run-etag-late', tickPending: false})
  })

  it('stop with the snapshot read pending resolves after the grace period with the ETags confirmed so far', async () => {
    // #given no tick has run and the snapshot read never settles
    const {trace, stop} = createHarness({getObject: async () => hang()})

    // #when
    const stopped = stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS)
    const result = await stopped

    // #then
    expect(trace).toEqual([
      {t: 0, op: 'mark', name: 'stop:begin'},
      {t: 0, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 5_000, op: 'mark', name: 'stop:resolved'},
    ])
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failed stop')
    expect(result.error.message).toBe('Heartbeat snapshot read did not settle within 5000ms of stop')
    expect(result.error).toMatchObject({lockEtag: 'lock-etag-0', runEtag: 'run-etag-0', tickPending: false})
  })

  it('shares one grace budget between the pending tick and the snapshot read', async () => {
    // #given a tick whose renewal takes 2 s to settle, and a snapshot read that never does
    const renewal = deferred<Result<{etag: string}, Error>>()
    const {trace, controller, stop} = createHarness({
      conditionalPut: async (call, fallback) => (call.key === LOCK_KEY ? renewal.promise : fallback()),
      getObject: async (call, fallback) => (call.n === 2 ? hang() : fallback()),
    })
    controller.start()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    // #when stop begins, the tick settles 2 s in, and the rest of the budget runs out
    const stopped = stop()
    await vi.advanceTimersByTimeAsync(2_000)
    renewal.resolve(ok({etag: 'lock-etag-slow'}))
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS - 2_000)
    const result = await stopped

    // #then stop resolved 5 s after it began (not 7 s), with the slow renewal's ETag, and the tick wrote no RunState
    expect(trace).toEqual([
      {t: 30_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: 'lock-etag-0', signal: false},
      {t: 30_000, op: 'mark', name: 'stop:begin'},
      {t: 32_000, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 35_000, op: 'mark', name: 'stop:resolved'},
    ])
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('expected a failed stop')
    expect(result.error.message).toBe('Heartbeat snapshot read did not settle within 5000ms of stop')
    expect(result.error).toMatchObject({lockEtag: 'lock-etag-slow', tickPending: false})
  })

  it('ignores start after stop: no tick ever runs', async () => {
    // #given a stopped controller
    const {trace, controller, logger, stop} = createHarness()
    await stop()

    // #when it is started again and time passes
    controller.start()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4)

    // #then it stayed stopped and touched nothing beyond stop's own snapshot read
    expect(controller.isRunning).toBe(false)
    expect(logger.debug).toHaveBeenCalledWith('Ignoring start of a stopped heartbeat controller', {
      repo: 'owner/repo',
      runId: 'run-1',
    })
    expect(trace).toEqual([
      {t: 0, op: 'mark', name: 'stop:begin'},
      {t: 0, op: 'getObject', key: RUN_KEY, signal: false},
      {t: 0, op: 'mark', name: 'stop:resolved'},
    ])
  })
})
