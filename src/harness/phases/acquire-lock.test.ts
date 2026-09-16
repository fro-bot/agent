import type {LockAcquisitionResult, LockRecord, ObjectStoreConfig} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {err, ok} from '../../shared/types.js'
import {runAcquireLock} from './acquire-lock.js'

const acquireLockMock = vi.hoisted(() => vi.fn())
const createS3AdapterMock = vi.hoisted(() => vi.fn(() => ({})))
const renewLeaseMock = vi.hoisted(() => vi.fn())

vi.mock('@fro-bot/runtime', async () => {
  const actual = await vi.importActual<typeof import('@fro-bot/runtime')>('@fro-bot/runtime')
  return {
    ...actual,
    acquireLock: acquireLockMock,
    createS3Adapter: createS3AdapterMock,
    renewLease: renewLeaseMock,
  }
})

function createStoreConfig(overrides?: Partial<ObjectStoreConfig>): ObjectStoreConfig {
  return {
    enabled: true,
    bucket: 'test-bucket',
    region: 'us-east-1',
    prefix: 'fro-bot-state',
    ...overrides,
  }
}

function createLockRecord(overrides?: Partial<LockRecord>): LockRecord {
  return {
    repo: 'fro-bot/agent',
    holder_id: 'gateway:instance-1:run-99',
    surface: 'discord',
    acquired_at: '2026-04-25T12:00:00.000Z',
    ttl_seconds: 900,
    run_id: 'run-99',
    ...overrides,
  }
}

function lockOk(data: LockAcquisitionResult): {readonly success: true; readonly data: LockAcquisitionResult} {
  return {success: true, data}
}

function lockErr(error: Error): {readonly success: false; readonly error: Error} {
  return {success: false, error}
}

describe('runAcquireLock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    renewLeaseMock.mockResolvedValue(ok({etag: '"etag-renewed"'}))
  })

  it('returns s3-disabled when storeConfig.enabled is false', async () => {
    // #given storeConfig with object store disabled
    const storeConfig = createStoreConfig({enabled: false})

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '1234',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then phase short-circuits without calling acquireLock
    expect(result).toEqual({outcome: 's3-disabled'})
    expect(acquireLockMock).not.toHaveBeenCalled()
    expect(createS3AdapterMock).not.toHaveBeenCalled()
  })

  it('returns acquired with etag on happy-path lock acquisition', async () => {
    // #given object store enabled and acquireLock returns success
    const storeConfig = createStoreConfig()
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, etag: '"etag-abc"', holder: null}))

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 2,
      logger: createMockLogger(),
    })

    // #then phase returns acquired with the etag and a running lease-renewal controller
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')
    expect(result.lockEtag).toBe('"etag-abc"')
    expect(typeof result.renewal.hasFailed).toBe('function')
    expect(typeof result.renewal.currentEtag).toBe('function')
    expect(typeof result.renewal.stop).toBe('function')
    expect(result.renewal.hasFailed()).toBe(false)
    expect(result.renewal.currentEtag()).toBe('"etag-abc"')
    await result.renewal.stop()
    expect(acquireLockMock).toHaveBeenCalledTimes(1)
    expect(createS3AdapterMock).toHaveBeenCalledTimes(1)
  })

  it('passes holderId in action:{runId}:{runAttempt} format to acquireLock', async () => {
    // #given object store enabled and acquireLock returns success
    const storeConfig = createStoreConfig()
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, etag: '"etag"', holder: null}))

    // #when running acquire-lock phase
    await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '99999',
      runAttempt: 3,
      logger: createMockLogger(),
    })

    // #then holderId encodes both runId and runAttempt; surface is github
    expect(acquireLockMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storeConfig,
        lockTtlSeconds: 900,
      }),
      'fro-bot/agent',
      'action:99999:3',
      'github',
      '99999',
      expect.any(Object),
    )
  })

  it('returns held-by-other when another surface holds the lock', async () => {
    // #given another surface (Discord gateway) currently holds the lock
    const storeConfig = createStoreConfig()
    const holder = createLockRecord({
      holder_id: 'gateway:instance-1:run-99',
      surface: 'discord',
    })
    acquireLockMock.mockResolvedValue(lockOk({acquired: false, etag: null, holder}))

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then phase reports held-by-other with holder details
    expect(result).toEqual({outcome: 'held-by-other', holder})
  })

  it('returns held-by-other when another Action run holds the lock', async () => {
    // #given another Action run (same surface) holds the lock
    const storeConfig = createStoreConfig()
    const holder = createLockRecord({
      holder_id: 'action:1234:1',
      surface: 'github',
    })
    acquireLockMock.mockResolvedValue(lockOk({acquired: false, etag: null, holder}))

    // #when running acquire-lock phase from a different Action run
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 2,
      logger: createMockLogger(),
    })

    // #then same skip path applies — no special handling for same-surface contention
    expect(result).toEqual({outcome: 'held-by-other', holder})
  })

  it('returns held-by-other with null holder when stale-takeover race lost', async () => {
    // #given the lock was stale but another caller won the takeover write
    const storeConfig = createStoreConfig()
    acquireLockMock.mockResolvedValue(lockOk({acquired: false, etag: null, holder: null}))

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then phase reports held-by-other with no holder context
    expect(result).toEqual({outcome: 'held-by-other', holder: null})
  })

  it('returns error when acquireLock fails (S3 unavailable)', async () => {
    // #given S3 is unavailable
    const storeConfig = createStoreConfig()
    const networkError = new Error('connection refused')
    acquireLockMock.mockResolvedValue(lockErr(networkError))

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then phase reports error with the underlying cause; caller decides fail vs proceed
    expect(result).toEqual({outcome: 'error', error: networkError})
  })

  it('returns error when acquireLock returns err (e.g. adapter returned no usable ETag)', async () => {
    // #given acquireLock itself returns err — the impossible state {acquired:true, etag:null}
    //        is now prevented at the source; the harness maps any err Result to outcome:'error'
    const storeConfig = createStoreConfig()
    acquireLockMock.mockResolvedValue(lockErr(new Error('Lock acquisition succeeded without a usable ETag')))

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then phase reports error — releasing without an etag would be unsafe
    expect(result.outcome).toBe('error')
    const errorMessage = result.outcome === 'error' ? result.error.message : ''
    expect(errorMessage).toContain('usable ETag')
  })
})

describe('runAcquireLock lease renewal (plan Unit 12)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    renewLeaseMock.mockResolvedValue(ok({etag: '"etag-renewed"'}))
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, etag: '"etag-initial"', holder: null}))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renews the lease periodically and advances currentEtag on a successful tick', async () => {
    // #given a lock acquired successfully
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '1111',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when the renewal interval fires
    await vi.advanceTimersByTimeAsync(30_000)

    // #then a renewal tick ran and the confirmed ETag advanced
    expect(renewLeaseMock).toHaveBeenCalledTimes(1)
    expect(result.renewal.hasFailed()).toBe(false)
    expect(result.renewal.currentEtag()).toBe('"etag-renewed"')

    await result.renewal.stop()
  })

  it('a failed lease renewal fails closed: hasFailed() becomes true without stopping the timer', async () => {
    // #given a lock acquired successfully, but the object store rejects renewal (e.g.
    // another surface already took over the lock record)
    renewLeaseMock.mockResolvedValueOnce(err(new Error('precondition failed')))
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '2222',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when the renewal interval fires and the tick fails
    await vi.advanceTimersByTimeAsync(30_000)

    // #then hasFailed() reports the failure WITHOUT the caller stopping the timer --
    // renewal must keep running through persistence, so a caller checks this by peeking,
    // not by stopping first
    expect(result.renewal.hasFailed()).toBe(true)
    // #and the last confirmed ETag is unchanged -- the failed tick never advanced it
    expect(result.renewal.currentEtag()).toBe('"etag-initial"')

    // #when a later tick succeeds
    renewLeaseMock.mockResolvedValueOnce(ok({etag: '"etag-recovered"'}))
    await vi.advanceTimersByTimeAsync(30_000)

    // #then hasFailed() reflects the most recent tick, not history
    expect(result.renewal.hasFailed()).toBe(false)
    expect(result.renewal.currentEtag()).toBe('"etag-recovered"')

    await result.renewal.stop()
  })

  it('stop() clears the timer so no further renewal ticks occur', async () => {
    // #given a lock acquired successfully
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '3333',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when stopped before any tick fires
    await result.renewal.stop()
    await vi.advanceTimersByTimeAsync(60_000)

    // #then no renewal call was ever made
    expect(renewLeaseMock).not.toHaveBeenCalled()
  })

  it('stop() returns within its grace period when a renewal is hung', async () => {
    // #given a renewal call that never settles (e.g. a stalled network request)
    renewLeaseMock.mockReturnValue(new Promise(() => {}))
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '4444',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when the renewal interval fires, starting the hung tick
    await vi.advanceTimersByTimeAsync(30_000)
    expect(renewLeaseMock).toHaveBeenCalledTimes(1)

    // #and stop() is called while that tick is still in flight
    const stopPromise = result.renewal.stop()

    // #then stop() settles at its own grace period (5s) -- well before the renewal's own
    // 10s timeout would otherwise bound it -- so cleanup never blocks on a stalled call
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(stopPromise).resolves.toBeUndefined()
  })

  it('a renewal that exceeds its own timeout marks the controller failed', async () => {
    // #given a renewal call that never settles
    renewLeaseMock.mockReturnValue(new Promise(() => {}))
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5555',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when the renewal interval fires
    await vi.advanceTimersByTimeAsync(30_000)

    // #then hasFailed() is still false -- the renewal's own timeout has not elapsed yet
    expect(result.renewal.hasFailed()).toBe(false)

    // #when the renewal's own timeout (10s) elapses without the call settling
    await vi.advanceTimersByTimeAsync(10_000)

    // #then the timed-out renewal is treated as a failure, same as a rejected/failed tick --
    // this is exactly the case where a caller about to persist state must decline
    expect(result.renewal.hasFailed()).toBe(true)

    await vi.advanceTimersByTimeAsync(5_000)
  })
})
