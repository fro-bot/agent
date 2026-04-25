import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {Logger} from '../shared/logger.js'
import type {CoordinationConfig, LockRecord} from './types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {acquireLock, forceReleaseLock, releaseLock, renewLease} from './lock.js'

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

function createLockRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    repo: 'owner/repo',
    holder_id: 'holder-1',
    surface: 'discord',
    acquired_at: '2026-04-24T18:00:00.000Z',
    ttl_seconds: 900,
    run_id: 'run-1',
    ...overrides,
  }
}

function createStoreAdapter(overrides: Partial<Required<ObjectStoreAdapter>> = {}): Required<ObjectStoreAdapter> {
  return {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    conditionalPut: vi.fn(async () => ok({etag: 'etag-1'})),
    conditionalDelete: vi.fn(async () => ok(undefined)),
    getObject: vi.fn(async () => ok({data: JSON.stringify(createLockRecord()), etag: 'etag-existing'})),
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

describe('lock coordination', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  it('acquires a lock when no existing lock record is present', async () => {
    // #given
    const storeAdapter = createStoreAdapter()
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-1', 'discord', 'run-1', logger)

    // #then
    expect(result).toEqual(ok({acquired: true, etag: 'etag-1', holder: null}))
    expect(storeAdapter.conditionalPut).toHaveBeenCalledWith(
      'fro-bot-state/coordination/owner/repo/locks/repo.json',
      JSON.stringify(
        createLockRecord({
          holder_id: 'gateway-1',
          surface: 'discord',
          acquired_at: '2026-04-24T18:15:00.000Z',
        }),
      ),
      {ifNoneMatch: '*'},
    )
  })

  it('returns the current holder when a fresh lock already exists', async () => {
    // #given
    const existingLock = createLockRecord({acquired_at: '2026-04-24T18:14:30.000Z'})
    const storeAdapter = createStoreAdapter({
      conditionalPut: vi
        .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
        .mockResolvedValueOnce(err(new Error('precondition failed'))),
      getObject: vi.fn(async () => ok({data: JSON.stringify(existingLock), etag: 'etag-existing'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-2', 'github', 'run-2', logger)

    // #then
    expect(result).toEqual(ok({acquired: false, etag: null, holder: existingLock}))
    expect(storeAdapter.getObject).toHaveBeenCalledWith('fro-bot-state/coordination/owner/repo/locks/repo.json')
  })

  it('treats hyphenated pre-condition errors as lock contention', async () => {
    // #given
    const existingLock = createLockRecord({acquired_at: '2026-04-24T18:14:30.000Z'})
    const storeAdapter = createStoreAdapter({
      conditionalPut: vi
        .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
        .mockResolvedValueOnce(err(new Error('pre-condition failed'))),
      getObject: vi.fn(async () => ok({data: JSON.stringify(existingLock), etag: 'etag-existing'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-2', 'github', 'run-2', logger)

    // #then
    expect(result).toEqual(ok({acquired: false, etag: null, holder: existingLock}))
  })

  it('takes over a stale lock using the stale etag', async () => {
    // #given
    const staleLock = createLockRecord({acquired_at: '2026-04-24T17:30:00.000Z'})
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(err(new Error('precondition failed')))
      .mockResolvedValueOnce(ok({etag: 'etag-new'}))
    const storeAdapter = createStoreAdapter({
      conditionalPut,
      getObject: vi.fn(async () => ok({data: JSON.stringify(staleLock), etag: 'etag-stale'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-2', 'github', 'run-2', logger)

    // #then
    expect(result).toEqual(ok({acquired: true, etag: 'etag-new', holder: null}))
    expect(conditionalPut).toHaveBeenNthCalledWith(
      2,
      'fro-bot-state/coordination/owner/repo/locks/repo.json',
      JSON.stringify(
        createLockRecord({
          holder_id: 'gateway-2',
          surface: 'github',
          acquired_at: '2026-04-24T18:15:00.000Z',
          run_id: 'run-2',
        }),
      ),
      {ifMatch: 'etag-stale'},
    )
  })

  it('returns acquired false when stale lock takeover races with another gateway', async () => {
    // #given
    const staleLock = createLockRecord({acquired_at: '2026-04-24T17:30:00.000Z'})
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(err(new Error('precondition failed')))
      .mockResolvedValueOnce(err(new Error('precondition failed')))
    const storeAdapter = createStoreAdapter({
      conditionalPut,
      getObject: vi.fn(async () => ok({data: JSON.stringify(staleLock), etag: 'etag-stale'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-2', 'github', 'run-2', logger)

    // #then
    expect(result).toEqual(ok({acquired: false, etag: null, holder: null}))
  })

  it('treats a lock as stale at exactly the ttl boundary', async () => {
    // #given
    const boundaryLock = createLockRecord({acquired_at: '2026-04-24T18:00:00.000Z'})
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(err(new Error('precondition failed')))
      .mockResolvedValueOnce(ok({etag: 'etag-new'}))
    const storeAdapter = createStoreAdapter({
      conditionalPut,
      getObject: vi.fn(async () => ok({data: JSON.stringify(boundaryLock), etag: 'etag-stale'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-2', 'github', 'run-2', logger)

    // #then
    expect(result).toEqual(ok({acquired: true, etag: 'etag-new', holder: null}))
  })

  it('releases a lock using the held etag', async () => {
    // #given
    const storeAdapter = createStoreAdapter()
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await releaseLock(config, 'owner/repo', 'etag-1', logger)

    // #then
    expect(result).toEqual(ok(undefined))
    expect(storeAdapter.conditionalDelete).toHaveBeenCalledWith(
      'fro-bot-state/coordination/owner/repo/locks/repo.json',
      {ifMatch: 'etag-1'},
    )
  })

  it('returns an error when lock release uses the wrong etag', async () => {
    // #given
    const storeAdapter = createStoreAdapter({
      conditionalDelete: vi.fn(async () => err(new Error('ownership mismatch'))),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await releaseLock(config, 'owner/repo', 'wrong-etag', logger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('ownership mismatch')
  })

  it('renews a lock lease with an updated acquired_at timestamp', async () => {
    // #given
    const conditionalPut = vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(async () => ok({etag: 'etag-2'}))
    const storeAdapter = createStoreAdapter({conditionalPut})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()
    const lockRecord = createLockRecord({holder_id: 'gateway-1'})

    // #when
    const result = await renewLease(config, 'owner/repo', lockRecord, 'etag-1', logger)

    // #then
    expect(result).toEqual(ok({etag: 'etag-2'}))
    expect(conditionalPut).toHaveBeenCalledWith(
      'fro-bot-state/coordination/owner/repo/locks/repo.json',
      JSON.stringify({...lockRecord, acquired_at: '2026-04-24T18:15:00.000Z'}),
      {ifMatch: 'etag-1'},
    )
  })

  it('force releases a stale lock when the etag still matches', async () => {
    // #given
    const storeAdapter = createStoreAdapter()
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseLock(config, 'owner/repo', 'etag-stale', logger)

    // #then
    expect(result).toEqual(ok(undefined))
    expect(storeAdapter.conditionalDelete).toHaveBeenCalledWith(
      'fro-bot-state/coordination/owner/repo/locks/repo.json',
      {ifMatch: 'etag-stale'},
    )
  })

  it('fails cleanly when force release races with another delete', async () => {
    // #given
    const storeAdapter = createStoreAdapter({
      conditionalDelete: vi.fn(async () => err(new Error('precondition failed'))),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseLock(config, 'owner/repo', 'etag-stale', logger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('precondition failed')
  })

  it('throws a clear error when S3 is unavailable during acquisition', async () => {
    // #given
    const storeAdapter = createStoreAdapter({
      conditionalPut: vi.fn(async () => err(new Error('S3 unavailable'))),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-1', 'discord', 'run-1', logger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toBe('S3 unavailable')
  })

  it('returns an error instead of throwing when conditionalPut support is missing', async () => {
    // #given
    const storeAdapter: ObjectStoreAdapter = {
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => ok([]),
      conditionalDelete: async () => ok(undefined),
      getObject: async () => ok({data: JSON.stringify(createLockRecord()), etag: 'etag-existing'}),
    }
    const config = createCoordinationConfig(storeAdapter as Required<ObjectStoreAdapter>)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-1', 'discord', 'run-1', logger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toBe(
      'Object store adapter does not support conditionalPut',
    )
  })

  it('returns an error when an existing lock payload is structurally invalid json', async () => {
    // #given
    const storeAdapter = createStoreAdapter({
      conditionalPut: vi
        .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
        .mockResolvedValueOnce(err(new Error('precondition failed'))),
      getObject: vi.fn(async () => ok({data: JSON.stringify({repo: 'owner/repo'}), etag: 'etag-existing'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-2', 'github', 'run-2', logger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('Invalid lock record payload')
  })
})
