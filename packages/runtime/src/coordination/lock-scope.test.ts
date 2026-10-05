import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {CoordinationConfig, LockRecord} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {acquireLock, getLockKey, releaseLock, renewLease} from './lock.js'

const REPO_KEY = 'fro-bot-state/coordination/owner/repo/locks/repo.json'
const ACTION_KEY = 'fro-bot-state/coordination/owner/repo/locks/action.json'

function createLogger() {
  return {
    debug: vi.fn<(message: string, context?: Record<string, unknown>) => void>(),
    info: vi.fn<(message: string, context?: Record<string, unknown>) => void>(),
  }
}

function lockRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    repo: 'owner/repo',
    holder_id: 'gateway-1',
    surface: 'discord',
    acquired_at: '2026-04-24T18:14:30.000Z',
    ttl_seconds: 900,
    run_id: 'run-1',
    ...overrides,
  }
}

/** Multi-key in-memory object store with real ETag / If-Match / If-None-Match semantics. */
function createMemoryStore(initial: Readonly<Record<string, LockRecord>> = {}) {
  const objects = new Map<string, {data: string; etag: string}>()
  let version = 0
  for (const [key, record] of Object.entries(initial)) {
    objects.set(key, {data: JSON.stringify(record), etag: `etag-${++version}`})
  }

  const adapter: Required<ObjectStoreAdapter> = {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    listWithMetadata: vi.fn(async () => ok([])),
    getObject: vi.fn(async (key: string) => {
      const found = objects.get(key)
      return found == null ? err(new Error('NoSuchKey')) : ok({...found})
    }),
    conditionalPut: vi.fn(async (key: string, data: string, options: {ifNoneMatch?: string; ifMatch?: string}) => {
      const found = objects.get(key)
      if (options.ifNoneMatch === '*' && found != null) return err(new Error('PreconditionFailed'))
      if (options.ifMatch != null && found?.etag !== options.ifMatch) return err(new Error('PreconditionFailed'))
      const etag = `etag-${++version}`
      objects.set(key, {data, etag})
      return ok({etag})
    }),
    conditionalDelete: vi.fn(async (key: string, options: {ifMatch: string}) => {
      const found = objects.get(key)
      if (options.ifMatch != null && found?.etag !== options.ifMatch) return err(new Error('PreconditionFailed'))
      objects.delete(key)
      return ok(undefined)
    }),
  }

  const storeConfig: ObjectStoreConfig = {enabled: true, bucket: 'b', region: 'us-east-1', prefix: 'fro-bot-state'}
  const config: CoordinationConfig = {
    storeAdapter: adapter,
    storeConfig,
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
  return {config, objects, adapter}
}

describe('lock scope', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('getLockKey defaults to repo.json and the action scope is a distinct object', () => {
    // #given a coordination config
    const {config} = createMemoryStore()

    // #when keys are built with and without a scope
    const defaultKey = getLockKey(config, 'owner/repo')
    const repoKey = getLockKey(config, 'owner/repo', 'repo')
    const actionKey = getLockKey(config, 'owner/repo', 'action')

    // #then the default is unchanged and the Action key differs
    expect(defaultKey).toEqual(ok(REPO_KEY))
    expect(repoKey).toEqual(ok(REPO_KEY))
    expect(actionKey).toEqual(ok(ACTION_KEY))
  })

  it('a gateway-held repo.json does not block Action acquisition', async () => {
    // #given the gateway holds a live repo lock
    const {config, objects} = createMemoryStore({[REPO_KEY]: lockRecord()})

    // #when an Action acquires on its own scope
    const result = await acquireLock(config, 'owner/repo', 'action:1:1', 'github', '1', createLogger(), {
      scope: 'action',
    })

    // #then it succeeds and the gateway's lock object is untouched
    expect(result.success === true && result.data.outcome).toBe('acquired')
    expect(JSON.parse(objects.get(REPO_KEY)?.data ?? '{}')).toMatchObject({holder_id: 'gateway-1'})
    expect(objects.has(ACTION_KEY)).toBe(true)
  })

  it('an action-held action.json does not block gateway acquisition on the default key', async () => {
    // #given an Action holds the Action lock
    const {config} = createMemoryStore({
      [ACTION_KEY]: lockRecord({holder_id: 'action:1:1', surface: 'github'}),
    })

    // #when the gateway acquires with default options
    const result = await acquireLock(config, 'owner/repo', 'gateway-1', 'discord', 'run-9', createLogger())

    // #then the gateway still gets repo.json
    expect(result.success === true && result.data.outcome).toBe('acquired')
  })

  it('action-vs-action contention reports the active holder', async () => {
    // #given one Action holds the Action lock
    const {config} = createMemoryStore()
    const first = await acquireLock(config, 'owner/repo', 'action:1:1', 'github', '1', createLogger(), {
      scope: 'action',
    })
    expect(first.success).toBe(true)

    // #when a second Action tries
    const second = await acquireLock(config, 'owner/repo', 'action:2:1', 'github', '2', createLogger(), {
      scope: 'action',
    })

    // #then it is blocked by the first Action's lease
    expect(second.success === true && second.data.outcome).toBe('active-holder')
    expect(second.success === true && second.data.holder?.holder_id).toBe('action:1:1')
  })

  it('reclaims an expired Action lease on the action key when the predicate allows it', async () => {
    // #given an expired Action lease
    const {config} = createMemoryStore({
      [ACTION_KEY]: lockRecord({holder_id: 'action:1:1', surface: 'github', acquired_at: '2026-04-24T17:00:00.000Z'}),
    })

    // #when a later Action acquires with the Action reclaim predicate
    const result = await acquireLock(config, 'owner/repo', 'action:2:1', 'github', '2', createLogger(), {
      scope: 'action',
      reclaimableWithoutConfirmation: holder => holder.surface === 'github',
    })

    // #then the expired lease is replaced
    expect(result.success === true && result.data.outcome).toBe('acquired')
  })

  it('does not take over an expired non-Action lease on the action key without corroboration', async () => {
    // #given an expired lease whose holder the predicate rejects
    const {config} = createMemoryStore({
      [ACTION_KEY]: lockRecord({holder_id: 'gateway-1', surface: 'discord', acquired_at: '2026-04-24T17:00:00.000Z'}),
    })

    // #when an Action acquires
    const result = await acquireLock(config, 'owner/repo', 'action:2:1', 'github', '2', createLogger(), {
      scope: 'action',
      reclaimableWithoutConfirmation: holder => holder.surface === 'github',
    })

    // #then it is not taken over
    expect(result.success === true && result.data.outcome).toBe('expired-holder')
  })

  it('renews and releases on the Action key only, leaving repo.json alone', async () => {
    // #given both locks exist: a gateway repo lock and this Action's lock
    const {config, objects} = createMemoryStore({[REPO_KEY]: lockRecord()})
    const logger = createLogger()
    const acquired = await acquireLock(config, 'owner/repo', 'action:1:1', 'github', '1', logger, {scope: 'action'})
    if (acquired.success === false || acquired.data.acquired === false) throw new Error('expected acquisition')
    const repoEtagBefore = objects.get(REPO_KEY)?.etag

    // #when the Action renews then releases using the Action scope
    const renewed = await renewLease(
      config,
      'owner/repo',
      lockRecord({holder_id: 'action:1:1', surface: 'github'}),
      acquired.data.etag,
      logger,
      'action',
    )
    if (renewed.success === false) throw new Error('expected renewal')
    const released = await releaseLock(config, 'owner/repo', renewed.data.etag, logger, 'action')

    // #then the Action key is gone, and the gateway's lock was never touched
    expect(released.success).toBe(true)
    expect(objects.has(ACTION_KEY)).toBe(false)
    expect(objects.get(REPO_KEY)?.etag).toBe(repoEtagBefore)
  })

  it('renew and release default to the repo key', async () => {
    // #given a gateway lock acquired with default options
    const {config, objects} = createMemoryStore()
    const logger = createLogger()
    const acquired = await acquireLock(config, 'owner/repo', 'gateway-1', 'discord', 'run-1', logger)
    if (acquired.success === false || acquired.data.acquired === false) throw new Error('expected acquisition')

    // #when renewing and releasing without a scope
    const renewed = await renewLease(config, 'owner/repo', lockRecord(), acquired.data.etag, logger)
    if (renewed.success === false) throw new Error('expected renewal')
    const released = await releaseLock(config, 'owner/repo', renewed.data.etag, logger)

    // #then they operate on repo.json
    expect(released.success).toBe(true)
    expect(objects.has(REPO_KEY)).toBe(false)
    expect(config.storeAdapter.conditionalPut).toHaveBeenCalledWith(REPO_KEY, expect.any(String), expect.anything())
  })
})

describe('create/read release race', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const notFound = () => err(new Error('NoSuchKey'))
  const preconditionFailed = () => err(new Error('PreconditionFailed'))

  it.each([['repo' as const], ['action' as const]])(
    'retries the create once when the lock vanished between create and read (%s scope)',
    async scope => {
      // #given the create fails its precondition, the read finds nothing, and the retry succeeds
      const {config, adapter} = createMemoryStore()
      vi.mocked(adapter.conditionalPut).mockResolvedValueOnce(preconditionFailed())
      vi.mocked(adapter.getObject).mockResolvedValueOnce(notFound())

      // #when acquiring
      const result = await acquireLock(config, 'owner/repo', 'h-1', 'github', 'r-1', createLogger(), {scope})

      // #then the second create wins and two creates were made
      expect(result.success === true && result.data.outcome).toBe('acquired')
      expect(adapter.conditionalPut).toHaveBeenCalledTimes(2)
    },
  )

  it('reports the active holder when the retry loses to a new holder', async () => {
    // #given precondition -> not-found -> precondition -> holder visible
    const holder = lockRecord({holder_id: 'other', acquired_at: '2026-04-24T18:14:30.000Z'})
    const {config, adapter} = createMemoryStore()
    vi.mocked(adapter.conditionalPut)
      .mockResolvedValueOnce(preconditionFailed())
      .mockResolvedValueOnce(preconditionFailed())
    vi.mocked(adapter.getObject)
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(ok({data: JSON.stringify(holder), etag: 'etag-x'}))

    // #when acquiring
    const result = await acquireLock(config, 'owner/repo', 'h-1', 'github', 'r-1', createLogger())

    // #then the normal active-holder path applies
    expect(result.success === true && result.data.outcome).toBe('active-holder')
    expect(result.success === true && result.data.holder?.holder_id).toBe('other')
  })

  it('returns conflict, not an error, when the lock is still absent after the retry', async () => {
    // #given precondition -> not-found -> precondition -> not-found
    const {config, adapter} = createMemoryStore()
    vi.mocked(adapter.conditionalPut)
      .mockResolvedValueOnce(preconditionFailed())
      .mockResolvedValueOnce(preconditionFailed())
    vi.mocked(adapter.getObject).mockResolvedValueOnce(notFound()).mockResolvedValueOnce(notFound())

    // #when acquiring
    const result = await acquireLock(config, 'owner/repo', 'h-1', 'github', 'r-1', createLogger())

    // #then it is a normal conflict outcome after exactly one retry
    expect(result).toEqual(ok({acquired: false, outcome: 'conflict', etag: null, holder: null}))
    expect(adapter.conditionalPut).toHaveBeenCalledTimes(2)
  })

  it('still returns an error for a non-precondition failure on the retry', async () => {
    // #given the retry fails for a store reason
    const {config, adapter} = createMemoryStore()
    vi.mocked(adapter.conditionalPut)
      .mockResolvedValueOnce(preconditionFailed())
      .mockResolvedValueOnce(err(new Error('503 slow down')))
    vi.mocked(adapter.getObject).mockResolvedValueOnce(notFound())

    // #when acquiring
    const result = await acquireLock(config, 'owner/repo', 'h-1', 'github', 'r-1', createLogger())

    // #then the store error surfaces
    expect(result.success).toBe(false)
  })

  it('does not retry when the read fails for a reason other than not-found', async () => {
    // #given a transient read error after a precondition failure
    const {config, adapter} = createMemoryStore()
    vi.mocked(adapter.conditionalPut).mockResolvedValueOnce(preconditionFailed())
    vi.mocked(adapter.getObject).mockResolvedValueOnce(err(new Error('503 slow down')))

    // #when acquiring
    const result = await acquireLock(config, 'owner/repo', 'h-1', 'github', 'r-1', createLogger())

    // #then it is an error and no second create happened
    expect(result.success).toBe(false)
    expect(adapter.conditionalPut).toHaveBeenCalledTimes(1)
  })
})
