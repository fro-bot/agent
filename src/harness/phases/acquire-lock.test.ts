import type {LockAcquisitionResult, LockRecord, ObjectStoreConfig} from '@fro-bot/runtime'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {runAcquireLock} from './acquire-lock.js'

const acquireLockMock = vi.hoisted(() => vi.fn())
const createS3AdapterMock = vi.hoisted(() => vi.fn(() => ({}) as unknown))

vi.mock('@fro-bot/runtime', async () => {
  const actual = await vi.importActual<typeof import('@fro-bot/runtime')>('@fro-bot/runtime')
  return {
    ...actual,
    acquireLock: acquireLockMock,
    createS3Adapter: createS3AdapterMock,
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

    // #then phase returns acquired with the etag
    expect(result).toEqual({outcome: 'acquired', lockEtag: '"etag-abc"'})
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

  it('returns error when adapter reports acquired but no etag', async () => {
    // #given adapter returned acquired:true with null etag (defensive — should not happen)
    const storeConfig = createStoreConfig()
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, etag: null, holder: null}))

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then phase fails fast — releasing without an etag would be unsafe
    expect(result.outcome).toBe('error')
    const errorMessage = result.outcome === 'error' ? result.error.message : ''
    expect(errorMessage).toContain('no ETag')
  })
})
