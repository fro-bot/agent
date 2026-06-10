import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {Logger} from '../shared/logger.js'
import type {CoordinationConfig, LockRecord, RunState} from './types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {createObjectStoreOperationError} from '../object-store/types.js'
import {err, ok} from '../shared/types.js'
import {
  acquireLock,
  COORDINATION_IDENTITY,
  forceReleaseLock,
  forceReleaseStaleLock,
  getLockKey,
  releaseLock,
  renewLease,
} from './lock.js'
import {getRunKey} from './run-state.js'

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

  it('returns an error instead of throwing when releaseLock has no conditionalDelete adapter support', async () => {
    // #given
    const storeAdapter: ObjectStoreAdapter = {
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => ok([]),
      conditionalPut: async () => ok({etag: 'etag-1'}),
      getObject: async () => ok({data: JSON.stringify(createLockRecord()), etag: 'etag-1'}),
    }
    const config = createCoordinationConfig(storeAdapter as Required<ObjectStoreAdapter>)
    const logger = createLogger()

    // #when
    const result = await releaseLock(config, 'owner/repo', 'etag-1', logger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toBe(
      'Object store adapter does not support conditionalDelete',
    )
  })

  it('returns an error instead of throwing when forceReleaseLock has no conditionalDelete adapter support', async () => {
    // #given
    const storeAdapter: ObjectStoreAdapter = {
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => ok([]),
      conditionalPut: async () => ok({etag: 'etag-1'}),
      getObject: async () => ok({data: JSON.stringify(createLockRecord()), etag: 'etag-1'}),
    }
    const config = createCoordinationConfig(storeAdapter as Required<ObjectStoreAdapter>)
    const logger = createLogger()

    // #when
    const result = await forceReleaseLock(config, 'owner/repo', 'etag-1', logger)

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toBe(
      'Object store adapter does not support conditionalDelete',
    )
  })

  it('returns an error instead of throwing when renewLease has no conditionalPut adapter support', async () => {
    // #given
    const storeAdapter: ObjectStoreAdapter = {
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => ok([]),
      conditionalDelete: async () => ok(undefined),
      getObject: async () => ok({data: JSON.stringify(createLockRecord()), etag: 'etag-1'}),
    }
    const config = createCoordinationConfig(storeAdapter as Required<ObjectStoreAdapter>)
    const logger = createLogger()

    // #when
    const result = await renewLease(config, 'owner/repo', createLockRecord(), 'etag-1', logger)

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

  it('returns err when initial acquire succeeds but adapter returns an empty etag', async () => {
    // #given — adapter returns success with an empty string etag (impossible state guard)
    const storeAdapter = createStoreAdapter({
      conditionalPut: vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(async () => ok({etag: ''})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-1', 'discord', 'run-1', logger)

    // #then — must NOT return acquired:true; must return err
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('usable ETag')
  })

  it('returns err when stale-takeover succeeds but adapter returns an empty etag', async () => {
    // #given — first put precondition-fails, getObject returns a stale lock,
    //          takeover put returns success with an empty etag
    const staleLock = createLockRecord({acquired_at: '2026-04-24T17:30:00.000Z'})
    const conditionalPut = vi
      .fn<Required<ObjectStoreAdapter>['conditionalPut']>()
      .mockResolvedValueOnce(err(new Error('precondition failed')))
      .mockResolvedValueOnce(ok({etag: ''}))
    const storeAdapter = createStoreAdapter({
      conditionalPut,
      getObject: vi.fn(async () => ok({data: JSON.stringify(staleLock), etag: 'etag-stale'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-2', 'github', 'run-2', logger)

    // #then — must NOT return acquired:true; must return err
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toContain('usable ETag')
  })

  it('happy path: valid etag on initial acquire returns acquired:true with the etag', async () => {
    // #given — adapter returns a valid non-empty etag
    const storeAdapter = createStoreAdapter({
      conditionalPut: vi.fn<Required<ObjectStoreAdapter>['conditionalPut']>(async () => ok({etag: 'etag-valid'})),
    })
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await acquireLock(config, 'owner/repo', 'gateway-1', 'discord', 'run-1', logger)

    // #then
    expect(result).toEqual(ok({acquired: true, etag: 'etag-valid', holder: null}))
  })
})

// ─── forceReleaseStaleLock ────────────────────────────────────────────────────

function createRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: 'run-1',
    surface: 'discord',
    thread_id: 'thread-1',
    entity_ref: 'owner/repo#123',
    phase: 'EXECUTING',
    started_at: '2026-04-24T18:00:00.000Z',
    last_heartbeat: '2026-04-24T18:00:00.000Z',
    holder_id: 'holder-1',
    details: {},
    ...overrides,
  }
}

// System time is set to 2026-04-24T18:15:00.000Z in the outer beforeEach.
// Lock record: acquired_at=2026-04-24T18:00:00.000Z, ttl_seconds=900 → expires at 18:15:00 (stale at boundary).
// Run-state: last_heartbeat=2026-04-24T18:00:00.000Z → 15 min ago; staleThresholdMs=60_000 (1 min) → stale.

describe('forceReleaseStaleLock', () => {
  // The outer beforeEach already sets fake timers to 2026-04-24T18:15:00.000Z.

  // Lock key:      fro-bot-state/coordination/owner/repo/locks/repo.json
  // Run-state key: fro-bot-state/discord-gateway/owner/repo/runs/run-1.json  (gateway identity, NOT coordination)

  it('releases the lock when lease is expired AND run-state heartbeat is stale', async () => {
    // #given — lock is stale (acquired 15 min ago, ttl=900s), run-state heartbeat is 15 min ago (staleThresholdMs=60s)
    const staleLock = createLockRecord({acquired_at: '2026-04-24T18:00:00.000Z', run_id: 'run-1'})
    const staleRunState = createRunState({last_heartbeat: '2026-04-24T18:00:00.000Z'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleLock), etag: 'etag-lock'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleRunState), etag: 'etag-run'}))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('released')
    expect(result.success === true ? result.data.holderId : null).toBe('holder-1')
    expect(result.success === true ? result.data.runId : null).toBe('run-1')
    expect(conditionalDelete).toHaveBeenCalledExactlyOnceWith('fro-bot-state/coordination/owner/repo/locks/repo.json', {
      ifMatch: 'etag-lock',
    })
  })

  it('releases the lock when lease is expired AND run-state record is absent (treated as dead)', async () => {
    // #given — lock is stale, run-state object does not exist (404-style error)
    const staleLock = createLockRecord({acquired_at: '2026-04-24T18:00:00.000Z', run_id: 'run-1'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleLock), etag: 'etag-lock'}))
      .mockResolvedValueOnce(err(new Error('NoSuchKey: object not found')))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('released')
    expect(conditionalDelete).toHaveBeenCalledExactlyOnceWith('fro-bot-state/coordination/owner/repo/locks/repo.json', {
      ifMatch: 'etag-lock',
    })
  })

  it('refuses to delete when lease is expired BUT run-state heartbeat is fresh (P0 guard)', async () => {
    // #given — lock lease expired, but run is still heartbeating (heartbeat 30s ago, threshold=60s → alive)
    const staleLock = createLockRecord({acquired_at: '2026-04-24T18:00:00.000Z', run_id: 'run-1'})
    // 18:14:30 is 30 seconds before 18:15:00 — within the 60s staleThresholdMs → live
    const liveRunState = createRunState({last_heartbeat: '2026-04-24T18:14:30.000Z'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleLock), etag: 'etag-lock'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify(liveRunState), etag: 'etag-run'}))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — must refuse, no delete
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('live-holder')
    expect(result.success === true ? result.data.holderId : null).toBe('holder-1')
    expect(result.success === true ? result.data.runId : null).toBe('run-1')
    // The core P0 guard: assert NO delete call was made
    expect(conditionalDelete).not.toHaveBeenCalled()
  })

  it('returns live-holder when lease is NOT expired (no run-state read, no delete)', async () => {
    // #given — lock acquired 30s ago, ttl=900s → not expired
    const freshLock = createLockRecord({acquired_at: '2026-04-24T18:14:30.000Z', run_id: 'run-1'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(freshLock), etag: 'etag-lock'}))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — live-holder, no run-state read, no delete
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('live-holder')
    // Only one getObject call (the lock read) — no run-state read
    expect(getObject).toHaveBeenCalledOnce()
    expect(conditionalDelete).not.toHaveBeenCalled()
  })

  it('returns no-lock when no lock record exists', async () => {
    // #given — getObject returns a not-found error for the lock key
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(err(new Error('NoSuchKey: object not found')))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('no-lock')
    expect(conditionalDelete).not.toHaveBeenCalled()
  })

  it('returns conflict when lock object changed between read and delete (IfMatch precondition failure)', async () => {
    // #given — both signals say dead, but conditionalDelete fails with precondition error
    const staleLock = createLockRecord({acquired_at: '2026-04-24T18:00:00.000Z', run_id: 'run-1'})
    const staleRunState = createRunState({last_heartbeat: '2026-04-24T18:00:00.000Z'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleLock), etag: 'etag-lock'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleRunState), etag: 'etag-run'}))
    const conditionalDelete = vi
      .fn<Required<ObjectStoreAdapter>['conditionalDelete']>()
      .mockResolvedValueOnce(err(new Error('precondition failed')))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — conflict, not an error; the new holder's lock is NOT deleted
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('conflict')
    // Delete was attempted exactly once (with the read etag) but failed
    expect(conditionalDelete).toHaveBeenCalledExactlyOnceWith('fro-bot-state/coordination/owner/repo/locks/repo.json', {
      ifMatch: 'etag-lock',
    })
  })

  it('returns error and does NOT delete when lock record is malformed', async () => {
    // #given — lock object exists but has invalid shape
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify({repo: 'owner/repo'}), etag: 'etag-lock'}))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — fail closed, no delete
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('error')
    expect(conditionalDelete).not.toHaveBeenCalled()
  })

  it('returns error and does NOT delete when run-state record is malformed', async () => {
    // #given — lock is stale, but run-state has invalid shape
    const staleLock = createLockRecord({acquired_at: '2026-04-24T18:00:00.000Z', run_id: 'run-1'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleLock), etag: 'etag-lock'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify({run_id: 'run-1'}), etag: 'etag-run'}))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — fail closed, no delete
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('error')
    expect(conditionalDelete).not.toHaveBeenCalled()
  })

  it('returns error and does NOT delete when run-state getObject returns a transient (non-not-found) error', async () => {
    // #given — lock lease is expired; run-state read fails with a transient error (not NoSuchKey)
    // This is the P0 fail-closed guard: a network/503 error must NOT be treated as "absent → dead".
    const staleLock = createLockRecord({acquired_at: '2026-04-24T18:00:00.000Z', run_id: 'run-1'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleLock), etag: 'etag-lock'}))
      .mockResolvedValueOnce(err(new Error('connection reset')))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — fail closed: transient error → outcome 'error', NO delete
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('error')
    // The core P0 guard: conditionalDelete must NOT be called on a transient read failure
    expect(conditionalDelete).not.toHaveBeenCalled()
  })

  it('releases the lock when run-state is absent (NoSuchKey) — genuinely-absent path still works', async () => {
    // #given — lock lease expired; run-state returns a not-found error (genuinely absent → dead)
    // This confirms the NoSuchKey → ok(null) → released path is preserved after the P0 fix.
    const staleLock = createLockRecord({acquired_at: '2026-04-24T18:00:00.000Z', run_id: 'run-1'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleLock), etag: 'etag-lock'}))
      .mockResolvedValueOnce(err(new Error('NoSuchKey: object not found')))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — NoSuchKey is genuinely absent → treated as dead → released
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('released')
    expect(conditionalDelete).toHaveBeenCalledExactlyOnceWith('fro-bot-state/coordination/owner/repo/locks/repo.json', {
      ifMatch: 'etag-lock',
    })
  })

  it('returns no-lock when conditionalDelete returns a not-found error (lock vanished between read and delete)', async () => {
    // #given — both signals say dead, but the lock object disappeared before the delete
    // P2-a: NoSuchKey on delete → outcome 'no-lock' (not err)
    const staleLock = createLockRecord({acquired_at: '2026-04-24T18:00:00.000Z', run_id: 'run-1'})
    const staleRunState = createRunState({last_heartbeat: '2026-04-24T18:00:00.000Z'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleLock), etag: 'etag-lock'}))
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleRunState), etag: 'etag-run'}))
    const conditionalDelete = vi
      .fn<Required<ObjectStoreAdapter>['conditionalDelete']>()
      .mockResolvedValueOnce(err(new Error('NoSuchKey: object not found')))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — lock vanished between read and delete → no-lock (not an error)
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('no-lock')
    // Delete was attempted exactly once
    expect(conditionalDelete).toHaveBeenCalledExactlyOnceWith('fro-bot-state/coordination/owner/repo/locks/repo.json', {
      ifMatch: 'etag-lock',
    })
  })

  it('run-state key uses the gateway identity segment, NOT the coordination identity (NBC-2 regression)', async () => {
    // #given — lock is stale; run-state is absent (NoSuchKey) so we can assert the exact key used
    // This test PINS the run-state key identity segment: it must contain /discord-gateway/ (the
    // gateway identity passed in), NOT /coordination/ (the lock key's identity). This is the
    // regression test for the P0 bug where readRunStateByRunId used COORDINATION_IDENTITY.
    const staleLock = createLockRecord({acquired_at: '2026-04-24T18:00:00.000Z', run_id: 'run-42'})
    const getObject = vi
      .fn<Required<ObjectStoreAdapter>['getObject']>()
      .mockResolvedValueOnce(ok({data: JSON.stringify(staleLock), etag: 'etag-lock'}))
      .mockResolvedValueOnce(err(new Error('NoSuchKey: object not found')))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when — pass 'discord-gateway' as the run-state owner identity
    await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — the second getObject call (run-state read) must use the gateway identity segment
    // Key shape: {prefix}/{identity}/{owner}/{repo}/runs/{runId}.json
    const runStateCall = getObject.mock.calls[1]
    expect(runStateCall).toBeDefined()
    const runStateKey = runStateCall?.[0] as string
    // Must contain the gateway identity segment
    expect(runStateKey).toContain('/discord-gateway/')
    // Must reference the correct run ID
    expect(runStateKey).toContain('/runs/run-42.json')
    // Must NOT use the coordination identity (the lock key's identity)
    expect(runStateKey).not.toContain('/coordination/')
  })
})

// ─── NBC-2: exported key-builder contracts ────────────────────────────────────

describe('COORDINATION_IDENTITY', () => {
  it('is the string "coordination"', () => {
    expect(COORDINATION_IDENTITY).toBe('coordination')
  })
})

describe('getLockKey', () => {
  it('builds a key containing COORDINATION_IDENTITY (not the gateway identity)', () => {
    // #given
    const config = createCoordinationConfig(createStoreAdapter())

    // #when
    const result = getLockKey(config, 'owner/repo')

    // #then
    expect(result.success).toBe(true)
    const key = result.success === true ? result.data : ''
    // Must contain the coordination identity segment
    expect(key).toContain(`/${COORDINATION_IDENTITY}/`)
    // Must NOT contain a gateway identity
    expect(key).not.toContain('/discord-gateway/')
    // Must end with the lock path
    expect(key).toContain('/locks/repo.json')
  })

  it('key shape: {prefix}/{COORDINATION_IDENTITY}/{owner}/{repo}/locks/repo.json', () => {
    // #given
    const config = createCoordinationConfig(createStoreAdapter())

    // #when
    const result = getLockKey(config, 'owner/repo')

    // #then
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data : '').toBe('fro-bot-state/coordination/owner/repo/locks/repo.json')
  })
})

describe('getRunKey', () => {
  it('builds a key containing the passed identity (not COORDINATION_IDENTITY)', () => {
    // #given
    const config = createCoordinationConfig(createStoreAdapter())

    // #when
    const result = getRunKey(config, 'discord-gateway', 'owner/repo', 'run-42')

    // #then
    expect(result.success).toBe(true)
    const key = result.success === true ? result.data : ''
    // Must contain the gateway identity segment
    expect(key).toContain('/discord-gateway/')
    // Must NOT contain the coordination identity
    expect(key).not.toContain(`/${COORDINATION_IDENTITY}/`)
    // Must reference the run ID
    expect(key).toContain('/runs/run-42.json')
  })

  it('key shape: {prefix}/{identity}/{owner}/{repo}/runs/{runId}.json', () => {
    // #given
    const config = createCoordinationConfig(createStoreAdapter())

    // #when
    const result = getRunKey(config, 'discord-gateway', 'owner/repo', 'run-42')

    // #then
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data : '').toBe('fro-bot-state/discord-gateway/owner/repo/runs/run-42.json')
  })
})

// ─── NBC-5: isNotFound structured-error check ─────────────────────────────────

describe('isNotFound (via forceReleaseStaleLock lock-read path)', () => {
  // isNotFound is private; we exercise it indirectly through forceReleaseStaleLock's
  // lock-read path: a not-found error on the lock read → outcome 'no-lock'.
  // A non-not-found error → outcome 'error'.

  it('httpStatusCode 404 → classified as not-found (structured field takes precedence)', async () => {
    // #given — lock read returns an ObjectStoreOperationError with httpStatusCode=404
    const notFoundError = createObjectStoreOperationError('some message', {httpStatusCode: 404})
    const getObject = vi.fn<Required<ObjectStoreAdapter>['getObject']>().mockResolvedValueOnce(err(notFoundError))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — 404 → not-found → no-lock (not error)
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('no-lock')
    expect(conditionalDelete).not.toHaveBeenCalled()
  })

  it('errorCode "NoSuchKey" → classified as not-found', async () => {
    // #given — lock read returns an ObjectStoreOperationError with errorCode=NoSuchKey
    const notFoundError = createObjectStoreOperationError('some message', {errorCode: 'NoSuchKey'})
    const getObject = vi.fn<Required<ObjectStoreAdapter>['getObject']>().mockResolvedValueOnce(err(notFoundError))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — NoSuchKey errorCode → not-found → no-lock
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('no-lock')
    expect(conditionalDelete).not.toHaveBeenCalled()
  })

  it('errorName "NoSuchKey" → classified as not-found', async () => {
    // #given — lock read returns an ObjectStoreOperationError with errorName=NoSuchKey
    const notFoundError = createObjectStoreOperationError('some message', {errorName: 'NoSuchKey'})
    const getObject = vi.fn<Required<ObjectStoreAdapter>['getObject']>().mockResolvedValueOnce(err(notFoundError))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — NoSuchKey errorName → not-found → no-lock
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('no-lock')
    expect(conditionalDelete).not.toHaveBeenCalled()
  })

  it('transient error with non-404 httpStatusCode → NOT classified as not-found (structured field takes precedence over message)', async () => {
    // #given — error message contains "not found" but httpStatusCode is 503 (transient)
    // The structured field must win: 503 is NOT a not-found, even if the message says "not found".
    const transientError = createObjectStoreOperationError('service not found temporarily', {httpStatusCode: 503})
    const getObject = vi.fn<Required<ObjectStoreAdapter>['getObject']>().mockResolvedValueOnce(err(transientError))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — 503 with "not found" in message → classified as error (not no-lock), no delete
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('error')
    expect(conditionalDelete).not.toHaveBeenCalled()
  })

  it('plain-message NoSuchKey (no structured fields) → still classified as not-found via fallback', async () => {
    // #given — plain Error with "NoSuchKey" in message, no structured fields
    const plainError = new Error('NoSuchKey: object not found')
    const getObject = vi.fn<Required<ObjectStoreAdapter>['getObject']>().mockResolvedValueOnce(err(plainError))
    const conditionalDelete = vi.fn<Required<ObjectStoreAdapter>['conditionalDelete']>(async () => ok(undefined))
    const storeAdapter = createStoreAdapter({getObject, conditionalDelete})
    const config = createCoordinationConfig(storeAdapter)
    const logger = createLogger()

    // #when
    const result = await forceReleaseStaleLock(config, 'owner/repo', 'discord-gateway', logger)

    // #then — fallback regex matches → no-lock
    expect(result.success).toBe(true)
    expect(result.success === true ? result.data.outcome : null).toBe('no-lock')
    expect(conditionalDelete).not.toHaveBeenCalled()
  })
})
