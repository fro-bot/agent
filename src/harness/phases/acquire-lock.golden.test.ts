/**
 * Golden-trace characterization of the Action's lease renewal, driven through `runAcquireLock`.
 *
 * These traces record what the renewal loop does TODAY: which `renewLease` and adapter calls it makes, in what order, at
 * what tick spacing, and what the returned `LeaseController` reports afterwards. They exist so moving the loop into
 * the shared runtime can prove it changed nothing it did not mean to.
 *
 * `renewLease` is intercepted at the `@fro-bot/runtime` package boundary, exactly as `acquire-lock.test.ts` does, so the
 * traces stay valid when the Action injects `renewLease` into the shared loop. The interceptor records the call and then
 * runs the real `renewLease` against a recording in-memory adapter, so the trace also shows the adapter-level PUT.
 *
 * Deliberately NOT recorded: leftover or lingering timers. The extraction clears timers the current code leaves behind,
 * and that cannot be seen from outside.
 */
import type {CoordinationConfig, LockAcquisitionResult, ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
import type {LeaseController} from './acquire-lock.js'
import {DEFAULT_HEARTBEAT_INTERVAL_MS} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {err, ok} from '../../shared/types.js'
import {runAcquireLock} from './acquire-lock.js'

const acquireLockMock = vi.hoisted(() => vi.fn())
const createS3AdapterMock = vi.hoisted(() => vi.fn())
const renewLeaseMock = vi.hoisted(() => vi.fn())

vi.mock('@actions/core', () => ({saveState: vi.fn()}))

vi.mock('@fro-bot/runtime', async () => {
  const actual = await vi.importActual<typeof import('@fro-bot/runtime')>('@fro-bot/runtime')
  return {
    ...actual,
    acquireLock: acquireLockMock,
    createS3Adapter: createS3AdapterMock,
    renewLease: renewLeaseMock,
  }
})

const T0 = new Date('2026-04-24T18:15:00.000Z')
const REPO = 'fro-bot/agent'
const HOLDER_ID = 'action:1234:1'
const LOCK_KEY = 'fro-bot-state/coordination/fro-bot/agent/locks/action.json'
const RENEWAL_TIMEOUT_MS = 10_000
const STOP_GRACE_MS = 5_000

/** One recorded call, or one test marker, in the order it happened. `t` is ms since the test's start. */
interface TraceEntry {
  readonly t: number
  readonly op: 'renewLease' | 'conditionalPut' | 'conditionalDelete' | 'mark'
  readonly key?: string
  /** `renewLease`: the ETag argument. Adapter ops: the `ifMatch` option. */
  readonly ifMatch?: string
  readonly ifNoneMatch?: string
  readonly tagging?: string
  /** Whether the call carried an `AbortSignal`. */
  readonly signal?: boolean
  /** `renewLease` only. */
  readonly repo?: string
  readonly scope?: string
  readonly record?: Record<string, unknown>
  /** Marker text, for `op: 'mark'`. */
  readonly name?: string
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

type PutResult = ReturnType<NonNullable<ObjectStoreAdapter['conditionalPut']>>
type PutScript = (n: number, fallback: () => PutResult) => PutResult

function storeConfig(): ObjectStoreConfig {
  return {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'fro-bot-state'}
}

function lockRecordAt(t: number, token: string, extra: Record<string, unknown> = {holder_job: 'build'}) {
  return {
    repo: REPO,
    holder_id: HOLDER_ID,
    surface: 'github',
    acquired_at: new Date(T0.getTime() + t).toISOString(),
    ttl_seconds: 900,
    run_id: '1234',
    ...extra,
    acquisition_token: token,
  }
}

/** Starts the Action's renewal through `runAcquireLock`, with a recording adapter behind the real `renewLease`. */
async function startRenewal(options: {readonly putScript?: PutScript; readonly jobIdentity?: string | null} = {}) {
  const trace: TraceEntry[] = []
  const now = (): number => Date.now() - T0.getTime()
  const mark = (name: string): void => {
    trace.push({t: now(), op: 'mark', name})
  }
  let puts = 0

  const adapter: Required<ObjectStoreAdapter> = {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    listWithMetadata: vi.fn(async () => ok([])),
    getObject: vi.fn<NonNullable<ObjectStoreAdapter['getObject']>>(async () => err(new Error('unexpected getObject'))),
    conditionalDelete: vi.fn<NonNullable<ObjectStoreAdapter['conditionalDelete']>>(async (key, deleteOptions) => {
      trace.push({
        t: now(),
        op: 'conditionalDelete',
        key,
        ifMatch: deleteOptions.ifMatch,
        signal: deleteOptions.signal !== undefined,
      })
      return ok(undefined)
    }),
    conditionalPut: vi.fn<NonNullable<ObjectStoreAdapter['conditionalPut']>>(async (key, _data, putOptions) => {
      trace.push({
        t: now(),
        op: 'conditionalPut',
        key,
        ...(putOptions.ifMatch === undefined ? {} : {ifMatch: putOptions.ifMatch}),
        ...(putOptions.ifNoneMatch === undefined ? {} : {ifNoneMatch: putOptions.ifNoneMatch}),
        ...(putOptions.tagging === undefined ? {} : {tagging: putOptions.tagging}),
        signal: putOptions.signal !== undefined,
      })
      puts += 1
      const n = puts
      const fallback = async () => ok({etag: `"etag-${n}"`})
      return options.putScript === undefined ? fallback() : options.putScript(n, fallback)
    }),
  }
  createS3AdapterMock.mockReturnValue(adapter)

  const actual = await vi.importActual<typeof import('@fro-bot/runtime')>('@fro-bot/runtime')
  renewLeaseMock.mockImplementation(async (...args: Parameters<typeof actual.renewLease>) => {
    const [, repo, record, etag, , scope] = args
    const signal: unknown = (args as readonly unknown[])[6]
    trace.push({
      t: now(),
      op: 'renewLease',
      repo,
      ifMatch: etag,
      scope,
      signal: signal !== undefined,
      record: {...record},
    })
    return actual.renewLease(...args)
  })

  const acquired: LockAcquisitionResult = {acquired: true, outcome: 'acquired', etag: '"etag-0"', holder: null}
  acquireLockMock.mockResolvedValue({success: true, data: acquired})

  const logger = createMockLogger()
  const result = await runAcquireLock({
    storeConfig: storeConfig(),
    repo: REPO,
    runId: '1234',
    runAttempt: 1,
    jobIdentity: options.jobIdentity === undefined ? 'build' : options.jobIdentity,
    logger,
  })
  if (result.outcome !== 'acquired') throw new Error('expected an acquired outcome')
  const acquireOptions = acquireLockMock.mock.calls[0]?.[6] as {acquisitionToken: string}
  const token = acquireOptions.acquisitionToken

  /** Frees the lock the way cleanup does: a conditional delete on the controller's current ETag. */
  const release = async (): Promise<void> => {
    mark('release')
    const config: CoordinationConfig = {
      storeAdapter: adapter,
      storeConfig: storeConfig(),
      lockTtlSeconds: 900,
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    }
    await actual.releaseLock(config, REPO, result.renewal.currentEtag(), logger, 'action')
  }

  const stop = async (): Promise<void> => {
    mark('stop:begin')
    await result.renewal.stop()
    mark('stop:resolved')
  }

  const settle = async (): Promise<void> => {
    mark('settle:begin')
    await mustSettle(result.renewal)()
    mark('settle:resolved')
  }

  return {trace, renewal: result.renewal, logger, token, release, stop, settle}
}

function mustSettle(renewal: LeaseController): () => Promise<void> {
  if (renewal.settle === undefined) throw new Error('expected the real controller to implement settle')
  return renewal.settle
}

describe('Action lease renewal golden traces', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    vi.clearAllMocks()
    renewLeaseMock.mockReset()
    acquireLockMock.mockReset()
    createS3AdapterMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tick success: renews against the confirmed ETag every interval, chains the new ETag, and releases with the latest', async () => {
    // #given
    const {trace, renewal, logger, token, release, stop} = await startRenewal()

    // #when two ticks elapse, renewal stops, and the lock is released
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS * 2)
    await stop()
    await release()
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS * 4)

    // #then
    expect(trace).toEqual([
      {
        t: 30_000,
        op: 'renewLease',
        repo: REPO,
        ifMatch: '"etag-0"',
        scope: 'action',
        signal: true,
        record: lockRecordAt(30_000, token),
      },
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: '"etag-0"', signal: true},
      {
        t: 60_000,
        op: 'renewLease',
        repo: REPO,
        ifMatch: '"etag-1"',
        scope: 'action',
        signal: true,
        record: lockRecordAt(60_000, token),
      },
      {t: 60_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: '"etag-1"', signal: true},
      {t: 60_000, op: 'mark', name: 'stop:begin'},
      {t: 60_000, op: 'mark', name: 'stop:resolved'},
      {t: 60_000, op: 'mark', name: 'release'},
      {t: 60_000, op: 'conditionalDelete', key: LOCK_KEY, ifMatch: '"etag-2"', signal: false},
    ])
    expect(renewal.currentEtag()).toBe('"etag-2"')
    expect(renewal.hasFailed()).toBe(false)
    expect(renewal.continuityUnverified?.()).toBe(false)
    expect(logger.warning).not.toHaveBeenCalled()
  })

  it('tick success without a job identity: the renewal record carries no holder_job', async () => {
    // #given
    const {trace, token} = await startRenewal({jobIdentity: null})

    // #when
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS)

    // #then
    expect(trace[0]).toEqual({
      t: 30_000,
      op: 'renewLease',
      repo: REPO,
      ifMatch: '"etag-0"',
      scope: 'action',
      signal: true,
      record: lockRecordAt(30_000, token, {}),
    })
    expect(trace[0]?.record).not.toHaveProperty('holder_job')
  })

  it('renewal returns err: marks the lease failed and unverified, keeps the ETag, logs a warning; a later success clears only hasFailed', async () => {
    // #given the first renewal is rejected
    const {trace, renewal, logger, token, stop} = await startRenewal({
      putScript: async (n, fallback) => (n === 1 ? err(new Error('renewal rejected')) : fallback()),
    })

    // #when the first tick runs
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS)

    // #then
    expect(renewal.hasFailed()).toBe(true)
    expect(renewal.continuityUnverified?.()).toBe(true)
    expect(renewal.currentEtag()).toBe('"etag-0"')
    expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal failed', {
      repo: REPO,
      holderId: HOLDER_ID,
      error: 'renewal rejected',
    })

    // #when the next tick succeeds
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS)
    await stop()

    // #then it renewed against the unchanged ETag; hasFailed cleared, the continuity latch did not
    expect(trace).toEqual([
      {
        t: 30_000,
        op: 'renewLease',
        repo: REPO,
        ifMatch: '"etag-0"',
        scope: 'action',
        signal: true,
        record: lockRecordAt(30_000, token),
      },
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: '"etag-0"', signal: true},
      {
        t: 60_000,
        op: 'renewLease',
        repo: REPO,
        ifMatch: '"etag-0"',
        scope: 'action',
        signal: true,
        record: lockRecordAt(60_000, token),
      },
      {t: 60_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: '"etag-0"', signal: true},
      {t: 60_000, op: 'mark', name: 'stop:begin'},
      {t: 60_000, op: 'mark', name: 'stop:resolved'},
    ])
    expect(renewal.hasFailed()).toBe(false)
    expect(renewal.continuityUnverified?.()).toBe(true)
    expect(renewal.currentEtag()).toBe('"etag-2"')
  })

  it('renewal throws: same failure state as err, logged as a throw', async () => {
    // #given the adapter throws on the first renewal
    const {trace, renewal, logger, token} = await startRenewal({
      putScript: async (n, fallback) => {
        if (n === 1) throw new Error('adapter exploded')
        return fallback()
      },
    })

    // #when
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS)

    // #then
    expect(trace).toEqual([
      {
        t: 30_000,
        op: 'renewLease',
        repo: REPO,
        ifMatch: '"etag-0"',
        scope: 'action',
        signal: true,
        record: lockRecordAt(30_000, token),
      },
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: '"etag-0"', signal: true},
    ])
    expect(renewal.hasFailed()).toBe(true)
    expect(renewal.continuityUnverified?.()).toBe(true)
    expect(renewal.currentEtag()).toBe('"etag-0"')
    expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {
      repo: REPO,
      holderId: HOLDER_ID,
      error: 'adapter exploded',
    })
  })

  it('renewal timeout: fails the tick at 10 s as a throw and the next tick renews against the original ETag', async () => {
    // #given the first renewal never settles
    const {trace, renewal, logger, token} = await startRenewal({
      putScript: async (n, fallback) => (n === 1 ? hang() : fallback()),
    })

    // #when the tick starts and 1 ms short of the timeout passes
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS + RENEWAL_TIMEOUT_MS - 1)

    // #then still in flight
    expect(renewal.hasFailed()).toBe(false)
    expect(logger.warning).not.toHaveBeenCalled()

    // #when the timeout elapses
    await vi.advanceTimersByTimeAsync(1)

    // #then
    expect(renewal.hasFailed()).toBe(true)
    expect(renewal.continuityUnverified?.()).toBe(true)
    expect(renewal.currentEtag()).toBe('"etag-0"')
    expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {
      repo: REPO,
      holderId: HOLDER_ID,
      error: 'Lease renewal exceeded 10000ms',
    })

    // #when the next interval arrives
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS - RENEWAL_TIMEOUT_MS)

    // #then the timed-out tick's ETag was never adopted
    expect(trace).toEqual([
      {
        t: 30_000,
        op: 'renewLease',
        repo: REPO,
        ifMatch: '"etag-0"',
        scope: 'action',
        signal: true,
        record: lockRecordAt(30_000, token),
      },
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: '"etag-0"', signal: true},
      {
        t: 60_000,
        op: 'renewLease',
        repo: REPO,
        ifMatch: '"etag-0"',
        scope: 'action',
        signal: true,
        record: lockRecordAt(60_000, token),
      },
      {t: 60_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: '"etag-0"', signal: true},
    ])
    expect(renewal.currentEtag()).toBe('"etag-2"')
    expect(renewal.hasFailed()).toBe(false)
  })

  it('late renewal success after the timeout is not applied: currentEtag stays, release uses the old ETag', async () => {
    // #given the first renewal is held open
    const lateRenewal = deferred<{readonly success: true; readonly data: {readonly etag: string}}>()
    const {trace, renewal, release, stop} = await startRenewal({
      putScript: async (n, fallback) => (n === 1 ? lateRenewal.promise : fallback()),
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS + RENEWAL_TIMEOUT_MS)
    expect(renewal.hasFailed()).toBe(true)

    // #when the abandoned renewal succeeds after the timeout
    lateRenewal.resolve(ok({etag: '"etag-late"'}))
    await vi.advanceTimersByTimeAsync(0)

    // #then it changed nothing
    expect(renewal.currentEtag()).toBe('"etag-0"')
    expect(renewal.hasFailed()).toBe(true)
    expect(renewal.continuityUnverified?.()).toBe(true)

    // #when the lock is released
    await stop()
    await release()

    // #then the delete is conditional on the ETag from before the abandoned renewal
    expect(trace.slice(2)).toEqual([
      {t: 40_000, op: 'mark', name: 'stop:begin'},
      {t: 40_000, op: 'mark', name: 'stop:resolved'},
      {t: 40_000, op: 'mark', name: 'release'},
      {t: 40_000, op: 'conditionalDelete', key: LOCK_KEY, ifMatch: '"etag-0"', signal: false},
    ])
  })

  it('stop with a tick pending: returns after the 5 s grace period, latches continuity, leaves the ETag stale', async () => {
    // #given the first renewal never settles
    const {trace, renewal, token, stop} = await startRenewal({
      putScript: async (n, fallback) => (n === 1 ? hang() : fallback()),
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS)

    // #when stop begins and the grace period elapses
    const stopped = stop()
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS)
    await stopped

    // #then stop returned with the lease unverified but not yet failed
    expect(renewal.continuityUnverified?.()).toBe(true)
    expect(renewal.hasFailed()).toBe(false)
    expect(renewal.currentEtag()).toBe('"etag-0"')

    // #when time passes well beyond the next interval
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS * 3)

    // #then the interval stayed cleared: no further renewal started
    expect(trace).toEqual([
      {
        t: 30_000,
        op: 'renewLease',
        repo: REPO,
        ifMatch: '"etag-0"',
        scope: 'action',
        signal: true,
        record: lockRecordAt(30_000, token),
      },
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: '"etag-0"', signal: true},
      {t: 30_000, op: 'mark', name: 'stop:begin'},
      {t: 35_000, op: 'mark', name: 'stop:resolved'},
    ])
  })

  it('stop with a tick pending: the abandoned tick still times out afterwards and marks the lease failed (today)', async () => {
    // #given stop returned with a hung renewal still in flight
    const {renewal, logger, stop} = await startRenewal({
      putScript: async (n, fallback) => (n === 1 ? hang() : fallback()),
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS)
    const stopped = stop()
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS)
    await stopped
    expect(renewal.hasFailed()).toBe(false)

    // #when the abandoned renewal reaches its own 10 s timeout
    await vi.advanceTimersByTimeAsync(RENEWAL_TIMEOUT_MS - STOP_GRACE_MS)

    // #then the failure lands on the controller after stop returned
    expect(renewal.hasFailed()).toBe(true)
    expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {
      repo: REPO,
      holderId: HOLDER_ID,
      error: 'Lease renewal exceeded 10000ms',
    })
  })

  it('stop with a tick pending: a renewal that succeeds after stop returned but before the timeout IS applied (today)', async () => {
    // #given stop returned with the first renewal still in flight
    const lateRenewal = deferred<{readonly success: true; readonly data: {readonly etag: string}}>()
    const {renewal, logger, stop} = await startRenewal({
      putScript: async (n, fallback) => (n === 1 ? lateRenewal.promise : fallback()),
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS)
    const stopped = stop()
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS)
    await stopped
    expect(renewal.currentEtag()).toBe('"etag-0"')

    // #when it succeeds at 36 s, inside its 10 s timeout
    await vi.advanceTimersByTimeAsync(1_000)
    lateRenewal.resolve(ok({etag: '"etag-late"'}))
    await vi.advanceTimersByTimeAsync(0)

    // #then the new ETag is adopted even though stop already returned (intended: `stop()` does not supersede a tick; only the tick timeout does)
    expect(renewal.currentEtag()).toBe('"etag-late"')
    expect(renewal.hasFailed()).toBe(false)
    expect(renewal.continuityUnverified?.()).toBe(true)
    await vi.advanceTimersByTimeAsync(RENEWAL_TIMEOUT_MS)
    expect(logger.warning).not.toHaveBeenCalled()
  })

  it('stop with no tick pending: returns at once, makes no calls, and renewal never fires again', async () => {
    // #given
    const {trace, renewal, release, stop} = await startRenewal()

    // #when stop is called before the first tick, twice, and time passes
    await stop()
    await stop()
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS * 4)
    await release()

    // #then
    expect(trace).toEqual([
      {t: 0, op: 'mark', name: 'stop:begin'},
      {t: 0, op: 'mark', name: 'stop:resolved'},
      {t: 0, op: 'mark', name: 'stop:begin'},
      {t: 0, op: 'mark', name: 'stop:resolved'},
      {t: 120_000, op: 'mark', name: 'release'},
      {t: 120_000, op: 'conditionalDelete', key: LOCK_KEY, ifMatch: '"etag-0"', signal: false},
    ])
    expect(renewal.hasFailed()).toBe(false)
    expect(renewal.continuityUnverified?.()).toBe(false)
  })

  it('settle waits for the in-flight tick without stopping renewal', async () => {
    // #given the first renewal takes 2 s
    const slowRenewal = deferred<{readonly success: true; readonly data: {readonly etag: string}}>()
    const {trace, renewal, token, settle} = await startRenewal({
      putScript: async (n, fallback) => (n === 1 ? slowRenewal.promise : fallback()),
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS)

    // #when settle is called mid-tick and the tick finishes 2 s later
    const settled = settle()
    await vi.advanceTimersByTimeAsync(2_000)
    slowRenewal.resolve(ok({etag: '"etag-slow"'}))
    await settled

    // #then settle resolved when the tick did, and the renewal loop keeps ticking on its schedule
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS - 2_000)
    expect(trace).toEqual([
      {
        t: 30_000,
        op: 'renewLease',
        repo: REPO,
        ifMatch: '"etag-0"',
        scope: 'action',
        signal: true,
        record: lockRecordAt(30_000, token),
      },
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: '"etag-0"', signal: true},
      {t: 30_000, op: 'mark', name: 'settle:begin'},
      {t: 32_000, op: 'mark', name: 'settle:resolved'},
      {
        t: 60_000,
        op: 'renewLease',
        repo: REPO,
        ifMatch: '"etag-slow"',
        scope: 'action',
        signal: true,
        record: lockRecordAt(60_000, token),
      },
      {t: 60_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: '"etag-slow"', signal: true},
    ])
    expect(renewal.currentEtag()).toBe('"etag-2"')
  })

  it('settle with nothing in flight resolves immediately and makes no calls', async () => {
    // #given
    const {trace, settle} = await startRenewal()

    // #when
    await settle()

    // #then
    expect(trace).toEqual([
      {t: 0, op: 'mark', name: 'settle:begin'},
      {t: 0, op: 'mark', name: 'settle:resolved'},
    ])
  })

  it('settle on a hung tick is bounded by the 10 s renewal timeout', async () => {
    // #given the first renewal never settles
    const {trace, renewal, token, settle} = await startRenewal({
      putScript: async (n, fallback) => (n === 1 ? hang() : fallback()),
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS)

    // #when settle is called mid-tick and the timeout elapses
    const settled = settle()
    await vi.advanceTimersByTimeAsync(RENEWAL_TIMEOUT_MS)
    await settled

    // #then settle resolved exactly at the timeout, with the tick recorded as failed
    expect(trace).toEqual([
      {
        t: 30_000,
        op: 'renewLease',
        repo: REPO,
        ifMatch: '"etag-0"',
        scope: 'action',
        signal: true,
        record: lockRecordAt(30_000, token),
      },
      {t: 30_000, op: 'conditionalPut', key: LOCK_KEY, ifMatch: '"etag-0"', signal: true},
      {t: 30_000, op: 'mark', name: 'settle:begin'},
      {t: 40_000, op: 'mark', name: 'settle:resolved'},
    ])
    expect(renewal.hasFailed()).toBe(true)
    expect(renewal.continuityUnverified?.()).toBe(true)
  })

  it('stop with a tick pending: a renewal err that lands after stop returned but before the timeout IS applied (today)', async () => {
    // #given stop returned with the first renewal still in flight
    const lateRenewal = deferred<Awaited<PutResult>>()
    const {renewal, logger, stop} = await startRenewal({
      putScript: async (n, fallback) => (n === 1 ? lateRenewal.promise : fallback()),
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS)
    const stopped = stop()
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS)
    await stopped
    expect(renewal.hasFailed()).toBe(false)
    expect(logger.warning).not.toHaveBeenCalled()

    // #when it fails at 36 s, inside its 10 s timeout
    await vi.advanceTimersByTimeAsync(1_000)
    lateRenewal.resolve(err(new Error('late renewal rejected')))
    await vi.advanceTimersByTimeAsync(0)

    // #then the failure lands on the controller even though stop already returned
    expect(renewal.hasFailed()).toBe(true)
    expect(renewal.continuityUnverified?.()).toBe(true)
    expect(renewal.currentEtag()).toBe('"etag-0"')
    expect(logger.warning).toHaveBeenCalledTimes(1)
    expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal failed', {
      repo: REPO,
      holderId: HOLDER_ID,
      error: 'late renewal rejected',
    })

    // #when its timeout would have elapsed
    await vi.advanceTimersByTimeAsync(RENEWAL_TIMEOUT_MS)

    // #then the settled attempt does not fail a second time
    expect(logger.warning).toHaveBeenCalledTimes(1)
  })

  it('a renewal err that lands after the timeout changes nothing: no state, no log, no ETag', async () => {
    // #given the first renewal timed out
    const lateRenewal = deferred<Awaited<PutResult>>()
    const {renewal, logger} = await startRenewal({
      putScript: async (n, fallback) => (n === 1 ? lateRenewal.promise : fallback()),
    })
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS + RENEWAL_TIMEOUT_MS)
    expect(renewal.hasFailed()).toBe(true)
    expect(logger.warning).toHaveBeenCalledTimes(1)

    // #when the abandoned renewal then fails
    lateRenewal.resolve(err(new Error('late renewal rejected')))
    await vi.advanceTimersByTimeAsync(0)

    // #then nothing moved
    expect(renewal.hasFailed()).toBe(true)
    expect(renewal.continuityUnverified?.()).toBe(true)
    expect(renewal.currentEtag()).toBe('"etag-0"')
    expect(logger.warning).toHaveBeenCalledTimes(1)
    expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {
      repo: REPO,
      holderId: HOLDER_ID,
      error: 'Lease renewal exceeded 10000ms',
    })
  })

  it('aborts the renewal request at the 10 s tick timeout, not before', async () => {
    // #given the first renewal never settles
    const {renewal} = await startRenewal({putScript: async (n, fallback) => (n === 1 ? hang() : fallback())})
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS + RENEWAL_TIMEOUT_MS - 1)
    const signal = renewLeaseMock.mock.calls[0]?.[6] as AbortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)

    // #when the timeout elapses
    await vi.advanceTimersByTimeAsync(1)

    // #then the request is cancelled rather than abandoned
    expect(signal.aborted).toBe(true)
    expect(renewal.hasFailed()).toBe(true)
  })

  it('aborts a pending renewal when the stop grace period runs out, and not when stop begins', async () => {
    // #given the first renewal never settles
    const {stop} = await startRenewal({putScript: async (n, fallback) => (n === 1 ? hang() : fallback())})
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS)
    const signal = renewLeaseMock.mock.calls[0]?.[6] as AbortSignal

    // #when stop begins
    const stopped = stop()
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1)

    // #then the request is still live
    expect(signal.aborted).toBe(false)

    // #when the grace period runs out
    await vi.advanceTimersByTimeAsync(1)
    await stopped

    // #then
    expect(signal.aborted).toBe(true)
  })
})
