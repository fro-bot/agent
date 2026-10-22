/**
 * The gateway heartbeat over the REAL lock code and an in-memory store with S3's ETag / If-Match semantics.
 *
 * A renewal whose outcome is lost (it committed, but the call timed out, was aborted, or came back as an error) leaves
 * the heartbeat holding a dead ETag. These tests pin that it recovers by adopting the stored ETag when the record is its
 * own, and only then.
 */
import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {Result} from '../shared/types.js'
import type {CoordinationConfig, LockRecord, RunState} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {createHeartbeatController, HEARTBEAT_STOP_GRACE_MS} from './heartbeat.js'
import {releaseLock} from './lock.js'

const LOCK_KEY = 'fro-bot-state/coordination/owner/repo/locks/repo.json'
const RUN_KEY = 'fro-bot-state/coordination/owner/repo/runs/run-1.json'
const INTERVAL = 30_000
const TICK_TIMEOUT = 10_000
const TOKEN = 'token-0001-abcd'

type PutResult = Result<{etag: string}, Error>
type GetResult = Result<{data: string; etag: string}, Error>

interface Hooks {
  /** Replaces a conditional write; `real` performs the compare-and-swap at once. `n` counts writes to that key. */
  readonly put?: (key: string, real: () => PutResult, n: number) => Promise<PutResult>
  readonly get?: (key: string, real: () => GetResult, signal: AbortSignal | undefined) => Promise<GetResult>
}

const hang = async <T>(): Promise<T> => new Promise<T>(() => {})

function runState(): RunState {
  return {
    run_id: 'run-1',
    surface: 'discord',
    thread_id: 'thread-1',
    entity_ref: 'owner/repo#1',
    phase: 'EXECUTING',
    started_at: '2026-04-24T18:00:00.000Z',
    last_heartbeat: '2026-04-24T18:00:00.000Z',
    holder_id: 'gateway-1',
    details: {},
  }
}

function lockRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    repo: 'owner/repo',
    holder_id: 'gateway-1',
    surface: 'discord',
    acquired_at: '2026-04-24T18:15:00.000Z',
    ttl_seconds: 900,
    run_id: 'run-1',
    acquisition_token: TOKEN,
    ...overrides,
  }
}

function createStore(hooks: Hooks = {}) {
  const objects = new Map<string, {data: string; etag: string}>()
  const writes = new Map<string, number>()
  let version = 0
  const set = (key: string, data: string): string => {
    version += 1
    const etag = `etag-${version}`
    objects.set(key, {data, etag})
    return etag
  }
  set(LOCK_KEY, JSON.stringify(lockRecord()))
  set(RUN_KEY, JSON.stringify(runState()))

  const adapter: Required<ObjectStoreAdapter> = {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    listWithMetadata: vi.fn(async () => ok([])),
    conditionalDelete: vi.fn<NonNullable<ObjectStoreAdapter['conditionalDelete']>>(async (key, options) => {
      if (objects.get(key)?.etag !== options.ifMatch) return err(new Error('PreconditionFailed'))
      objects.delete(key)
      return ok(undefined)
    }),
    getObject: vi.fn<NonNullable<ObjectStoreAdapter['getObject']>>(async (key, options) => {
      const real = (): GetResult => {
        const found = objects.get(key)
        return found === undefined ? err(new Error('NoSuchKey')) : ok({...found})
      }
      return hooks.get === undefined ? real() : hooks.get(key, real, options?.signal)
    }),
    conditionalPut: vi.fn<NonNullable<ObjectStoreAdapter['conditionalPut']>>(async (key, data, options) => {
      const n = (writes.get(key) ?? 0) + 1
      writes.set(key, n)
      const real = (): PutResult => {
        if (options.ifMatch !== undefined && objects.get(key)?.etag !== options.ifMatch) {
          return err(new Error('PreconditionFailed'))
        }
        return ok({etag: set(key, data)})
      }
      return hooks.put === undefined ? real() : hooks.put(key, real, n)
    }),
  }
  const storeConfig: ObjectStoreConfig = {enabled: true, bucket: 'b', region: 'us-east-1', prefix: 'fro-bot-state'}
  const config: CoordinationConfig = {
    storeAdapter: adapter,
    storeConfig,
    lockTtlSeconds: 900,
    heartbeatIntervalMs: INTERVAL,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
  return {
    config,
    adapter,
    lock: () => objects.get(LOCK_KEY) ?? null,
    runEtag: () => objects.get(RUN_KEY)?.etag ?? null,
    /** Replaces the stored lock behind the holder's back, as a successor's acquisition (or an old build) would. */
    replaceLock: (record: object) => set(LOCK_KEY, JSON.stringify(record)),
  }
}

function build(store: ReturnType<typeof createStore>, acquisitionToken: string | null = TOKEN) {
  const logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn()}
  const controller = createHeartbeatController(
    store.config,
    'coordination',
    'owner/repo',
    'run-1',
    store.lock()?.etag ?? '',
    store.runEtag() ?? '',
    logger,
    ...(acquisitionToken === null ? [] : [acquisitionToken]),
  )
  return {controller, logger}
}

/** The first lock write (the tick's renewal) commits server-side, then the call hangs / fails. */
const commitThenHang: NonNullable<Hooks['put']> = async (key, real, n) => {
  if (key !== LOCK_KEY || n !== 1) return real()
  real()
  return hang()
}
const commitThenFail: NonNullable<Hooks['put']> = async (key, real, n) => {
  if (key !== LOCK_KEY || n !== 1) return real()
  real()
  return err(new Error('response lost'))
}

function lockFields(store: ReturnType<typeof createStore>): LockRecord {
  const found = store.lock()
  if (found === null) throw new Error('lock missing')
  return JSON.parse(found.data) as LockRecord
}

describe('gateway heartbeat lock ETag adoption', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('recovers a renewal that committed and was dropped by the tick timeout: 412, adopt, then renew and write again', async () => {
    // #given the first renewal commits server-side and never answers
    const store = createStore({put: commitThenHang})
    const {controller, logger} = build(store)
    controller.start()

    // #when it times out, the next tick 412s against the dead ETag, and the tick after that runs
    await vi.advanceTimersByTimeAsync(INTERVAL + TICK_TIMEOUT)
    const lockAfterDrop = store.lock()?.etag
    await vi.advanceTimersByTimeAsync(INTERVAL * 2 - TICK_TIMEOUT)
    const stopped = await controller.stop()

    // #then the lease renews again against the adopted ETag, and the RunState heartbeat is written again
    expect(stopped.success).toBe(true)
    if (stopped.success === false) throw new Error('expected an ok stop')
    expect(stopped.data.lockEtag).toBe(store.lock()?.etag)
    expect(stopped.data.lockEtag).not.toBe(lockAfterDrop)
    expect(Date.parse(lockFields(store).acquired_at)).toBeGreaterThanOrEqual(Date.parse('2026-04-24T18:16:30.000Z'))
    expect(lockFields(store)).toMatchObject({holder_id: 'gateway-1', run_id: 'run-1', acquisition_token: TOKEN})
    expect(stopped.data.runState.last_heartbeat).not.toBe('2026-04-24T18:00:00.000Z')
    expect(logger.info).toHaveBeenCalledWith(
      'Coordination lease ETag adopted after a renewal outcome was lost',
      expect.objectContaining({repo: 'owner/repo', runId: 'run-1'}),
    )
  })

  it('lets stop adopt a dropped committed renewal, so the release succeeds', async () => {
    // #given the dropped renewal, and stop arrives before another tick could recover it
    const store = createStore({put: commitThenHang})
    const {controller} = build(store)
    controller.start()
    await vi.advanceTimersByTimeAsync(INTERVAL + TICK_TIMEOUT)
    const committed = store.lock()?.etag

    // #when
    const stopped = await controller.stop()

    // #then stop still reports the failed tick, but with the ETag the lock actually has
    expect(stopped.success).toBe(false)
    if (stopped.success === true) throw new Error('expected a failed stop')
    expect(stopped.error.lockEtag).toBe(committed)
    expect(stopped.error.tickPending).toBe(false)

    // #and the release with that ETag deletes the lock
    expect((await releaseLock(store.config, 'owner/repo', stopped.error.lockEtag, debugLogger())).success).toBe(true)
    expect(store.lock()).toBeNull()
  })

  it('adopts a renewal that committed but returned an error; stop then returns ok with the adopted ETag', async () => {
    // #given
    const store = createStore({put: commitThenFail})
    const {controller, logger: log} = build(store)
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const stopped = await controller.stop()

    // #then no warning was logged, and the ETag stop reports is the stored one
    expect(log.warning).toHaveBeenCalledTimes(1)
    expect(log.warning).toHaveBeenCalledWith('Coordination lease renewal failed', expect.anything())
    expect(stopped.success).toBe(true)
    expect(stopped.success ? stopped.data.lockEtag : '').toBe(store.lock()?.etag)
  })

  it('does not adopt when the renewal did not commit: the held ETag is the stored one, and the failure stands', async () => {
    // #given
    const store = createStore({
      put: async (key, real, n) => (key === LOCK_KEY && n === 1 ? err(new Error('503')) : real()),
    })
    const original = store.lock()?.etag
    const {controller, logger: log} = build(store)
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const stopped = await controller.stop()

    // #then
    expect(stopped.success).toBe(false)
    if (stopped.success === true) throw new Error('expected a failed stop')
    expect(stopped.error.lockEtag).toBe(original)
    expect(log.warning).toHaveBeenCalledWith('Coordination lease renewal failed', expect.anything())
  })

  it.each([
    ['a different holder', {holder_id: 'gateway-2'}],
    ['a different run', {run_id: 'run-2'}],
    ['the same holder and run with a different acquisition token', {acquisition_token: 'successor-token-9'}],
  ])('never adopts a record held by %s', async (_label, overrides) => {
    // #given a successor's record, written before the first renewal
    const store = createStore()
    const {controller, logger: log} = build(store)
    const held = store.lock()?.etag
    const successor = store.replaceLock(lockRecord(overrides))
    controller.start()

    // #when the tick 412s and stop reads once more
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const stopped = await controller.stop()

    // #then
    expect(stopped.success).toBe(false)
    if (stopped.success === true) throw new Error('expected a failed stop')
    expect(stopped.error.lockEtag).toBe(held)
    expect(stopped.error.lockEtag).not.toBe(successor)
    expect(log.info).not.toHaveBeenCalled()
  })

  it('never adopts a record renewed by an old build without a token, and logs why at debug', async () => {
    // #given
    const store = createStore()
    const {controller, logger: log} = build(store)
    const held = store.lock()?.etag
    store.replaceLock(Object.fromEntries(Object.entries(lockRecord()).filter(([key]) => key !== 'acquisition_token')))
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const stopped = await controller.stop()

    // #then
    expect(stopped.success ? '' : stopped.error.lockEtag).toBe(held)
    expect(log.debug).toHaveBeenCalledWith(
      'Lock record not adopted',
      expect.objectContaining({reason: 'no-token', repo: 'owner/repo', runId: 'run-1'}),
    )
  })

  it('never adopts when the heartbeat was built without a token, even for a record that matches otherwise', async () => {
    // #given an existing caller that does not pass the parameter
    const store = createStore({put: commitThenFail})
    const {controller} = build(store, null)
    const held = store.lock()?.etag
    controller.start()

    // #when
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const stopped = await controller.stop()

    // #then
    expect(stopped.success ? '' : stopped.error.lockEtag).toBe(held)
  })

  it('leaves the ETag and the failure alone when the adoption read fails, in a tick and at stop', async () => {
    // #given a committed renewal and a store whose reads of the lock then fail
    let failLockReads = false
    const store = createStore({
      put: commitThenFail,
      get: async (key, real) => (failLockReads && key === LOCK_KEY ? err(new Error('503 slow down')) : real()),
    })
    const held = store.lock()?.etag
    const {controller} = build(store)
    controller.start()
    failLockReads = true

    // #when
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const stopped = await controller.stop()

    // #then
    expect(stopped.success).toBe(false)
    if (stopped.success === true) throw new Error('expected a failed stop')
    expect(stopped.error.lockEtag).toBe(held)
  })

  it('resolves stop within the budget when the stop-path read hangs, and aborts that read', async () => {
    // #given a dropped committed renewal, then lock reads that hang until aborted
    const signals: (AbortSignal | undefined)[] = []
    let hangLockReads = false
    const store = createStore({
      put: commitThenHang,
      get: async (key, real, signal) => {
        if (!hangLockReads || key !== LOCK_KEY) return real()
        signals.push(signal)
        return new Promise<GetResult>(resolve => {
          signal?.addEventListener('abort', () => {
            resolve(err(new Error('aborted')))
          })
        })
      },
    })
    const held = store.lock()?.etag
    const {controller} = build(store)
    controller.start()
    await vi.advanceTimersByTimeAsync(INTERVAL + TICK_TIMEOUT)
    hangLockReads = true

    // #when
    let resolved = false
    const pending = controller.stop().then(result => {
      resolved = true
      return result
    })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS - 1)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const stopped = await pending

    // #then
    expect(resolved).toBe(true)
    expect(signals[0]?.aborted).toBe(true)
    expect(stopped.success ? '' : stopped.error.lockEtag).toBe(held)
  })
})

function debugLogger() {
  return {debug: vi.fn()}
}
