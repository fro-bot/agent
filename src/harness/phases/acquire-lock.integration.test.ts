import type {LockRecord, ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {err, ok} from '../../shared/types.js'
import {STATE_KEYS} from '../config/state-keys.js'
import {releaseActionLockIfHeld, runAcquireLock, SAME_RUN_TAKEOVER_MIN_UNRENEWED_MS} from './acquire-lock.js'

// Real acquireLock / renewLease / releaseLockIfHolder against an in-memory store with ETag semantics. Only the S3
// adapter factory and the Actions state file are faked.
const storeRef = vi.hoisted((): {adapter: unknown} => ({adapter: null}))
const state = vi.hoisted(() => new Map<string, string>())

vi.mock('@actions/core', () => ({
  saveState: (key: string, value: string) => {
    state.set(key, value)
  },
}))

vi.mock('@fro-bot/runtime', async () => {
  const actual = await vi.importActual<typeof import('@fro-bot/runtime')>('@fro-bot/runtime')
  return {...actual, createS3Adapter: () => storeRef.adapter}
})

const NOW = new Date('2026-04-25T12:10:00.000Z')
const STALE_MS = SAME_RUN_TAKEOVER_MIN_UNRENEWED_MS + 30_000

const storeConfig: ObjectStoreConfig = {enabled: true, bucket: 'b', region: 'us-east-1', prefix: 'fro-bot-state'}

function createMemoryStore(initial: LockRecord | null = null) {
  let current: {data: string; etag: string} | null =
    initial === null ? null : {data: JSON.stringify(initial), etag: 'etag-0'}
  let version = 0

  const adapter: Required<ObjectStoreAdapter> = {
    upload: async () => ok(undefined),
    download: async () => ok(undefined),
    list: async () => ok([]),
    listWithMetadata: async () => ok([]),
    getObject: async () => (current === null ? err(new Error('NoSuchKey')) : ok({...current})),
    conditionalPut: async (_key, data, options) => {
      if (options?.ifNoneMatch === '*' && current !== null) return err(new Error('PreconditionFailed'))
      if (options?.ifMatch !== undefined && options.ifMatch !== current?.etag) {
        return err(new Error('PreconditionFailed'))
      }
      version += 1
      current = {data, etag: `etag-${version}`}
      return ok({etag: current.etag})
    },
    conditionalDelete: async (_key, options) => {
      if (options.ifMatch !== current?.etag) return err(new Error('PreconditionFailed'))
      current = null
      return ok(undefined)
    },
  }
  storeRef.adapter = adapter
  return {record: () => (current === null ? null : (JSON.parse(current.data) as LockRecord))}
}

function seedRecord(overrides: Partial<LockRecord>): LockRecord {
  return {
    repo: 'owner/repo',
    holder_id: 'action:1234:1',
    holder_job: 'build',
    surface: 'github',
    acquired_at: new Date(NOW.getTime() - STALE_MS).toISOString(),
    ttl_seconds: 900,
    run_id: '1234',
    ...overrides,
  }
}

async function acquireAsAttempt2(jobIdentity: string | null) {
  const result = await runAcquireLock({
    storeConfig,
    repo: 'owner/repo',
    runId: '1234',
    runAttempt: 2,
    jobIdentity,
    logger: createMockLogger(),
  })
  if (result.outcome === 'acquired') await result.renewal.stop()
  return result
}

describe('same-run takeover through the real lock', () => {
  beforeEach(() => {
    state.clear()
    vi.useFakeTimers({toFake: ['Date']})
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes over a live lease whose same-job earlier attempt stopped renewing', async () => {
    // #given an unexpired lease (15 min TTL) that went quiet two minutes ago
    const store = createMemoryStore(seedRecord({}))

    // #when attempt 2 of the same job acquires
    const result = await acquireAsAttempt2('build')

    // #then it takes the lock over immediately and records itself
    expect(result.outcome).toBe('acquired')
    expect(store.record()).toMatchObject({holder_id: 'action:1234:2', holder_job: 'build'})
  })

  it('declines when the earlier attempt renewed recently', async () => {
    // #given a holder that renewed 30s ago
    const store = createMemoryStore(seedRecord({acquired_at: new Date(NOW.getTime() - 30_000).toISOString()}))

    // #when
    const result = await acquireAsAttempt2('build')

    // #then a live holder is never displaced
    expect(result).toMatchObject({outcome: 'held-by-other', reason: 'active-holder'})
    expect(store.record()?.holder_id).toBe('action:1234:1')
  })

  it('declines when the earlier attempt belongs to a different job of the run', async () => {
    // #given
    const store = createMemoryStore(seedRecord({holder_job: 'test'}))

    // #when
    const result = await acquireAsAttempt2('build')

    // #then
    expect(result).toMatchObject({outcome: 'held-by-other', reason: 'active-holder'})
    expect(store.record()?.holder_job).toBe('test')
  })

  it('declines a legacy record without holder_job', async () => {
    // #given a lease written by a pre-holder_job agent version
    const legacy: Partial<LockRecord> = {}
    const store = createMemoryStore({...seedRecord(legacy), holder_job: undefined})

    // #when
    const result = await acquireAsAttempt2('build')

    // #then it waits for expiry like any other lease
    expect(result).toMatchObject({outcome: 'held-by-other', reason: 'active-holder'})
    expect(store.record()?.holder_id).toBe('action:1234:1')
  })
})

describe('holder record round trip', () => {
  beforeEach(() => {
    state.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('releases with exactly the holder and job recorded at acquisition', async () => {
    // #given a run that acquired the lock as job "build"
    const store = createMemoryStore()
    const acquired = await acquireAsAttempt2('build')
    expect(acquired.outcome).toBe('acquired')

    // #when the post hook reads the main step's state and releases
    const released = await releaseActionLockIfHeld({
      storeConfig,
      repo: 'owner/repo',
      holderId: state.get(STATE_KEYS.LOCK_HOLDER_ID) ?? '',
      ...(state.has(STATE_KEYS.LOCK_HOLDER_JOB) ? {holderJob: state.get(STATE_KEYS.LOCK_HOLDER_JOB)} : {}),
      logger: createMockLogger(),
    })

    // #then
    expect(released).toEqual(ok('released'))
    expect(store.record()).toBeNull()
  })

  it('round-trips a run with no job identity', async () => {
    // #given
    const store = createMemoryStore()
    await acquireAsAttempt2(null)

    // #when
    const released = await releaseActionLockIfHeld({
      storeConfig,
      repo: 'owner/repo',
      holderId: state.get(STATE_KEYS.LOCK_HOLDER_ID) ?? '',
      logger: createMockLogger(),
    })

    // #then
    expect(state.has(STATE_KEYS.LOCK_HOLDER_JOB)).toBe(false)
    expect(released).toEqual(ok('released'))
    expect(store.record()).toBeNull()
  })

  it('does not delete a sibling job’s lock that shares the run and attempt', async () => {
    // #given the "test" job holds the lock; the "build" job's recorded identity is the same run and attempt
    const store = createMemoryStore()
    await acquireAsAttempt2('test')

    // #when the "build" job's post hook releases by its own record
    const released = await releaseActionLockIfHeld({
      storeConfig,
      repo: 'owner/repo',
      holderId: 'action:1234:2',
      holderJob: 'build',
      logger: createMockLogger(),
    })

    // #then
    expect(released).toEqual(ok('not-holder'))
    expect(store.record()).toMatchObject({holder_job: 'test'})
  })

  it('writes records a pre-holder_job reader still recognizes as Action holders, across renewals', async () => {
    // #given the 3-segment matcher shipped in older agent versions
    const olderReader = /^action:\d+:\d+$/
    vi.useFakeTimers()
    const store = createMemoryStore()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'owner/repo',
      runId: '1234',
      runAttempt: 2,
      jobIdentity: 'build-m1a2b3c4d',
      logger: createMockLogger(),
    })
    const afterAcquire = store.record()

    // #when the lease renews
    await vi.advanceTimersByTimeAsync(30_000)
    const afterRenewal = store.record()
    if (result.outcome === 'acquired') await result.renewal.stop()

    // #then holder_id keeps the legacy shape, and the job survives the rewrite
    expect(afterAcquire?.holder_id).toMatch(olderReader)
    expect(afterRenewal?.holder_id).toMatch(olderReader)
    expect(afterRenewal?.holder_job).toBe('build-m1a2b3c4d')
    expect(afterRenewal?.acquired_at).not.toBe(afterAcquire?.acquired_at)
  })
})
