import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'
import type {CoordinationConfig, LockRecord} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {acquireLock, getLockKey, isPreconditionFailed, releaseLock, releaseLockIfHolder, renewLease} from './lock.js'

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

  /** The store's real conditional write, usable from a test double that mutates the store first. */
  const put = async (key: string, data: string, options: {ifNoneMatch?: string; ifMatch?: string}) => {
    const found = objects.get(key)
    if (options.ifNoneMatch === '*' && found != null) return err(new Error('PreconditionFailed'))
    if (options.ifMatch != null && found?.etag !== options.ifMatch) return err(new Error('PreconditionFailed'))
    const etag = `etag-${++version}`
    objects.set(key, {data, etag})
    return ok({etag})
  }

  /** The store's real conditional delete, usable from a test double that mutates the store first. */
  const del = async (key: string, options: {ifMatch: string}) => {
    const found = objects.get(key)
    if (options.ifMatch != null && found?.etag !== options.ifMatch) return err(new Error('PreconditionFailed'))
    objects.delete(key)
    return ok(undefined)
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
    conditionalPut: vi.fn(put),
    conditionalDelete: vi.fn(del),
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
  return {config, objects, adapter, put, del}
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

  it('renewLease sends exactly {ifMatch} when no signal is given', async () => {
    // #given an acquired lock
    const {config, adapter} = createMemoryStore()
    const logger = createLogger()
    const acquired = await acquireLock(config, 'owner/repo', 'gateway-1', 'discord', 'run-1', logger)
    if (acquired.success === false || acquired.data.acquired === false) throw new Error('expected acquisition')
    vi.mocked(adapter.conditionalPut).mockClear()

    // #when renewing with and without an explicit scope, and with an explicit undefined signal
    await renewLease(config, 'owner/repo', lockRecord(), acquired.data.etag, logger)
    await renewLease(config, 'owner/repo', lockRecord(), acquired.data.etag, logger, 'repo', undefined)

    // #then the option object is exactly what it was before signals existed, with no `signal` key at all
    const optionObjects = vi.mocked(adapter.conditionalPut).mock.calls.map(call => call[2])
    expect(optionObjects).toStrictEqual([{ifMatch: acquired.data.etag}, {ifMatch: acquired.data.etag}])
  })

  it('renewLease forwards the signal to conditionalPut on the requested scope', async () => {
    // #given an acquired Action lock
    const {config, adapter} = createMemoryStore()
    const logger = createLogger()
    const acquired = await acquireLock(config, 'owner/repo', 'action:1:1', 'github', '1', logger, {scope: 'action'})
    if (acquired.success === false || acquired.data.acquired === false) throw new Error('expected acquisition')
    const controller = new AbortController()
    vi.mocked(adapter.conditionalPut).mockClear()

    // #when renewing with a signal
    const renewed = await renewLease(
      config,
      'owner/repo',
      lockRecord({holder_id: 'action:1:1', surface: 'github'}),
      acquired.data.etag,
      logger,
      'action',
      controller.signal,
    )

    // #then the signal reaches the adapter next to the ETag condition
    expect(renewed.success).toBe(true)
    expect(adapter.conditionalPut).toHaveBeenCalledTimes(1)
    expect(adapter.conditionalPut).toHaveBeenCalledWith(ACTION_KEY, expect.any(String), {
      ifMatch: acquired.data.etag,
      signal: controller.signal,
    })
  })

  it('renewLease resolves to err when the adapter reports the aborted request', async () => {
    // #given an adapter whose PUT fails once the signal has aborted
    const {config, adapter} = createMemoryStore()
    const logger = createLogger()
    const acquired = await acquireLock(config, 'owner/repo', 'gateway-1', 'discord', 'run-1', logger)
    if (acquired.success === false || acquired.data.acquired === false) throw new Error('expected acquisition')
    const controller = new AbortController()
    controller.abort()
    vi.mocked(adapter.conditionalPut).mockImplementationOnce(async (_key, _data, options) =>
      options.signal?.aborted === true ? err(new Error('Request aborted')) : ok({etag: 'unexpected'}),
    )

    // #when
    const renewed = await renewLease(
      config,
      'owner/repo',
      lockRecord(),
      acquired.data.etag,
      logger,
      'repo',
      controller.signal,
    )

    // #then
    expect(renewed.success).toBe(false)
    expect(renewed.success === false ? renewed.error.message : '').toBe('Request aborted')
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

describe('acquireLock — holderJob', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes holder_job on creation, leaving holder_id untouched', async () => {
    // #given an empty store
    const {config, objects} = createMemoryStore()

    // #when acquiring with a job
    await acquireLock(config, 'owner/repo', 'action:1:1', 'github', '1', createLogger(), {
      scope: 'action',
      holderJob: 'build',
    })

    // #then older readers still match holder_id, and the job rides along
    const stored = JSON.parse(objects.get(ACTION_KEY)?.data ?? '{}') as LockRecord
    expect(stored.holder_id).toMatch(/^action:\d+:\d+$/)
    expect(stored.holder_job).toBe('build')
  })

  it('omits holder_job when none is given', async () => {
    // #given
    const {config, objects} = createMemoryStore()

    // #when
    await acquireLock(config, 'owner/repo', 'action:1:1', 'github', '1', createLogger(), {scope: 'action'})

    // #then the record is byte-compatible with what older writers produce
    const stored = JSON.parse(objects.get(ACTION_KEY)?.data ?? '{}') as LockRecord
    expect(Object.keys(stored)).not.toContain('holder_job')
  })

  it('writes holder_job on a takeover too', async () => {
    // #given an expired Action lease
    const {config, objects} = createMemoryStore({
      [ACTION_KEY]: lockRecord({holder_id: 'action:1:1', surface: 'github', acquired_at: '2026-04-24T17:00:00.000Z'}),
    })

    // #when a later attempt reclaims it
    await acquireLock(config, 'owner/repo', 'action:1:2', 'github', '1', createLogger(), {
      scope: 'action',
      holderJob: 'build',
      reclaimableWithoutConfirmation: holder => holder.surface === 'github',
    })

    // #then
    expect(JSON.parse(objects.get(ACTION_KEY)?.data ?? '{}')).toMatchObject({
      holder_id: 'action:1:2',
      holder_job: 'build',
    })
  })

  it('drops a malformed holder_job from the holder it reports instead of rejecting the record', async () => {
    // #given a live lease with a corrupt holder_job
    const {config} = createMemoryStore({
      [ACTION_KEY]: {
        ...lockRecord({holder_id: 'action:1:1', surface: 'github'}),
        holder_job: ['x'],
      } as unknown as LockRecord,
    })

    // #when another run tries to acquire
    const result = await acquireLock(config, 'owner/repo', 'action:2:1', 'github', '2', createLogger(), {
      scope: 'action',
    })

    // #then it is an ordinary active-holder decline, and the reported holder carries no holder_job
    expect(result.success === true && result.data.outcome).toBe('active-holder')
    expect(result.success === true && result.data.holder?.holder_job).toBeUndefined()
  })
})

describe('acquisition token', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes acquisition_token on creation and on a takeover', async () => {
    // #given an empty store, then an expired lease
    const created = createMemoryStore()
    const takenOver = createMemoryStore({
      [ACTION_KEY]: lockRecord({holder_id: 'action:1:1', surface: 'github', acquired_at: '2026-04-24T17:00:00.000Z'}),
    })

    // #when
    await acquireLock(created.config, 'owner/repo', 'action:1:1', 'github', '1', createLogger(), {
      scope: 'action',
      acquisitionToken: 'token-aaaaaaaa',
    })
    await acquireLock(takenOver.config, 'owner/repo', 'action:1:2', 'github', '1', createLogger(), {
      scope: 'action',
      acquisitionToken: 'token-bbbbbbbb',
      reclaimableWithoutConfirmation: holder => holder.surface === 'github',
    })

    // #then
    expect(JSON.parse(created.objects.get(ACTION_KEY)?.data ?? '{}')).toMatchObject({
      acquisition_token: 'token-aaaaaaaa',
    })
    expect(JSON.parse(takenOver.objects.get(ACTION_KEY)?.data ?? '{}')).toMatchObject({
      acquisition_token: 'token-bbbbbbbb',
    })
  })

  it('omits the field when none is given', async () => {
    // #given
    const {config, objects} = createMemoryStore()

    // #when
    await acquireLock(config, 'owner/repo', 'action:1:1', 'github', '1', createLogger(), {scope: 'action'})

    // #then
    const stored = JSON.parse(objects.get(ACTION_KEY)?.data ?? '{}') as LockRecord
    expect(Object.keys(stored)).not.toContain('acquisition_token')
  })

  it('is never consulted when deciding a takeover', async () => {
    // #given a live lease carrying a token, and a predicate that approves it
    const {config, objects} = createMemoryStore({
      [ACTION_KEY]: {
        ...lockRecord({holder_id: 'action:1:1', surface: 'github'}),
        acquisition_token: 'token-aaaaaaaa',
      },
    })

    // #when a contender presents a different token
    const result = await acquireLock(config, 'owner/repo', 'action:1:2', 'github', '1', createLogger(), {
      scope: 'action',
      acquisitionToken: 'token-bbbbbbbb',
      reclaimableBeforeExpiry: () => true,
    })

    // #then the takeover rule alone decided
    expect(result.success === true && result.data.outcome).toBe('acquired')
    expect(JSON.parse(objects.get(ACTION_KEY)?.data ?? '{}')).toMatchObject({acquisition_token: 'token-bbbbbbbb'})
  })

  it('drops a malformed token from the holder it reports instead of rejecting the record', async () => {
    // #given a live lease with a corrupt token
    const {config} = createMemoryStore({
      [ACTION_KEY]: {
        ...lockRecord({holder_id: 'action:1:1', surface: 'github'}),
        acquisition_token: {x: 1},
      } as unknown as LockRecord,
    })

    // #when
    const result = await acquireLock(config, 'owner/repo', 'action:2:1', 'github', '2', createLogger(), {
      scope: 'action',
    })

    // #then
    expect(result.success === true && result.data.outcome).toBe('active-holder')
    expect(result.success === true && result.data.holder?.acquisition_token).toBeUndefined()
  })

  it('a late release by an earlier acquisition cannot delete a successor with identical holder fields', async () => {
    // #given A and B share run, attempt, job and matrix, so holder_id and holder_job are identical; A's lease expired
    const {config, objects} = createMemoryStore()
    const sameFields = {scope: 'action' as const, holderJob: 'build'}
    await acquireLock(config, 'owner/repo', 'action:1:1', 'github', '1', createLogger(), {
      ...sameFields,
      acquisitionToken: 'token-aaaaaaaa',
    })
    vi.setSystemTime(new Date('2026-04-24T18:31:00.000Z'))
    const successor = await acquireLock(config, 'owner/repo', 'action:1:1', 'github', '1', createLogger(), {
      ...sameFields,
      acquisitionToken: 'token-bbbbbbbb',
      reclaimableWithoutConfirmation: holder => holder.surface === 'github',
    })
    expect(successor.success === true && successor.data.outcome).toBe('acquired')

    // #when A's delayed post hook releases with A's recorded token
    const released = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
      holderJob: 'build',
      acquisitionToken: 'token-aaaaaaaa',
    })

    // #then B's live lease is untouched
    expect(released).toEqual(ok('not-holder'))
    expect(JSON.parse(objects.get(ACTION_KEY)?.data ?? '{}')).toMatchObject({acquisition_token: 'token-bbbbbbbb'})
  })
})

describe('acquireLock — reclaimableBeforeExpiry', () => {
  // The fixture clock is 18:15:00; a lease renewed at 18:13:00 has been unrenewed for 120s.
  const leaseRenewedAt = (holderId: string, renewedAt: string) =>
    lockRecord({holder_id: holderId, surface: 'github', acquired_at: renewedAt})
  const staleActionLease = (holderId: string) => leaseRenewedAt(holderId, '2026-04-24T18:13:00.000Z')
  const earlierAttemptOnly = vi.fn((holder: LockRecord, _observedAt: Date) => holder.holder_id === 'action:1:1')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
    earlierAttemptOnly.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes over an unexpired lease the predicate approves and audits a distinct source', async () => {
    // #given an unexpired lease held by an earlier attempt
    const {config, objects} = createMemoryStore({[ACTION_KEY]: staleActionLease('action:1:1')})
    const logger = createLogger()

    // #when a later attempt acquires with the pre-expiry predicate
    const result = await acquireLock(config, 'owner/repo', 'action:1:2', 'github', '1', logger, {
      scope: 'action',
      reclaimableBeforeExpiry: earlierAttemptOnly,
    })

    // #then the lease is replaced without waiting for expiry, and the predicate saw the expiry-check clock
    expect(result.success === true && result.data.outcome).toBe('acquired')
    expect(JSON.parse(objects.get(ACTION_KEY)?.data ?? '{}')).toMatchObject({holder_id: 'action:1:2'})
    expect(earlierAttemptOnly).toHaveBeenCalledWith(
      expect.objectContaining({holder_id: 'action:1:1'}),
      new Date('2026-04-24T18:15:00.000Z'),
    )
    expect(logger.info).toHaveBeenLastCalledWith(
      'lock-takeover-outcome',
      expect.objectContaining({decision: 'taken-over', confirmationSource: 'holder-superseded'}),
    )
  })

  it('keeps an unexpired lease the predicate rejects', async () => {
    // #given a lease held by a different run
    const {config, objects} = createMemoryStore({[ACTION_KEY]: staleActionLease('action:9:1')})

    // #when a later attempt acquires with the pre-expiry predicate
    const result = await acquireLock(config, 'owner/repo', 'action:1:2', 'github', '1', createLogger(), {
      scope: 'action',
      reclaimableBeforeExpiry: earlierAttemptOnly,
    })

    // #then the holder is untouched
    expect(result.success === true && result.data.outcome).toBe('active-holder')
    expect(JSON.parse(objects.get(ACTION_KEY)?.data ?? '{}')).toMatchObject({holder_id: 'action:9:1'})
  })

  it('does not reclaim when the holder renews between the read and the conditional write', async () => {
    // #given a lease that renews (new etag) just before the takeover's conditional write lands
    const {config, objects, adapter, put} = createMemoryStore({[ACTION_KEY]: staleActionLease('action:1:1')})
    const observedEtag = objects.get(ACTION_KEY)?.etag
    const renewedBody = JSON.stringify(leaseRenewedAt('action:1:1', '2026-04-24T18:15:00.000Z'))
    vi.mocked(adapter.conditionalPut).mockImplementation(async (key, data, options) => {
      if (options?.ifMatch !== undefined) objects.set(key, {data: renewedBody, etag: 'etag-renewed'})
      return put(key, data, options ?? {})
    })

    // #when a later attempt tries to take over
    const result = await acquireLock(config, 'owner/repo', 'action:1:2', 'github', '1', createLogger(), {
      scope: 'action',
      reclaimableBeforeExpiry: earlierAttemptOnly,
    })

    // #then the takeover sent the observed etag, lost the real etag race, and the renewed record survives
    const takeoverWrite = vi
      .mocked(adapter.conditionalPut)
      .mock.calls.find(([, , options]) => options?.ifMatch !== undefined)
    expect(observedEtag).toBeDefined()
    expect(takeoverWrite?.[2]).toEqual({ifMatch: observedEtag})
    expect(result).toEqual(ok({acquired: false, outcome: 'conflict', etag: null, holder: null}))
    expect(JSON.parse(objects.get(ACTION_KEY)?.data ?? '{}')).toMatchObject({holder_id: 'action:1:1'})
  })
})

describe('releaseLockIfHolder', () => {
  const holderRecord = (holderId: string) => lockRecord({holder_id: holderId, surface: 'github'})

  it('deletes the lock when the stored holder matches', async () => {
    // #given
    const {config, objects} = createMemoryStore({[ACTION_KEY]: holderRecord('action:1:1')})

    // #when
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action')

    // #then
    expect(result).toEqual(ok('released'))
    expect(objects.has(ACTION_KEY)).toBe(false)
  })

  it('leaves another holder’s lock alone', async () => {
    // #given
    const {config, objects} = createMemoryStore({[ACTION_KEY]: holderRecord('action:1:2')})

    // #when
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action')

    // #then
    expect(result).toEqual(ok('not-holder'))
    expect(objects.has(ACTION_KEY)).toBe(true)
  })

  it('fails closed without deleting a holder-matching record whose expiry is not a finite number', async () => {
    // #given the caller's own record, but its acquired_at is unparseable: it is rejected like any malformed record
    const {config, objects, adapter} = createMemoryStore({
      [ACTION_KEY]: lockRecord({holder_id: 'action:1:1', surface: 'github', acquired_at: 'not-a-date'}),
    })

    // #when
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action')

    // #then
    expect(result.success).toBe(false)
    expect(result.success === false ? result.error.message : '').toBe('Invalid lock record payload')
    expect(adapter.conditionalDelete).not.toHaveBeenCalled()
    expect(objects.has(ACTION_KEY)).toBe(true)
  })

  it('deletes only while run_id also matches when the caller names one', async () => {
    // #given the same holder and token on two different runs
    const same = createMemoryStore({
      [ACTION_KEY]: {...holderRecord('action:1:1'), acquisition_token: 'token-0001-abcd'},
    })
    const other = createMemoryStore({
      [ACTION_KEY]: {...holderRecord('action:1:1'), acquisition_token: 'token-0001-abcd'},
    })

    // #when
    const kept = await releaseLockIfHolder(other.config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
      acquisitionToken: 'token-0001-abcd',
      runId: 'run-other',
    })
    const released = await releaseLockIfHolder(same.config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
      acquisitionToken: 'token-0001-abcd',
      runId: 'run-1',
    })

    // #then
    expect(kept).toEqual(ok('not-holder'))
    expect(other.objects.has(ACTION_KEY)).toBe(true)
    expect(other.adapter.conditionalDelete).not.toHaveBeenCalled()
    expect(released).toEqual(ok('released'))
    expect(same.objects.has(ACTION_KEY)).toBe(false)
  })

  it('ignores run_id when the caller names none', async () => {
    // #given
    const {config, objects} = createMemoryStore({[ACTION_KEY]: holderRecord('action:1:1')})

    // #when
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {})

    // #then
    expect(result).toEqual(ok('released'))
    expect(objects.has(ACTION_KEY)).toBe(false)
  })

  it('reports no-lock when the lock is already gone', async () => {
    // #given
    const {config} = createMemoryStore()

    // #when
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action')

    // #then
    expect(result).toEqual(ok('no-lock'))
  })

  it('reports conflict and keeps the lock when it is replaced between the read and the delete', async () => {
    // #given a successor replaces the lock after our read; the delete runs against the real ETag-enforcing store
    const {config, objects, adapter, del} = createMemoryStore({[ACTION_KEY]: holderRecord('action:1:1')})
    const observedEtag = objects.get(ACTION_KEY)?.etag
    vi.mocked(adapter.conditionalDelete).mockImplementationOnce(async (key, options) => {
      objects.set(key, {data: JSON.stringify(holderRecord('action:1:2')), etag: 'etag-successor'})
      return del(key, options)
    })

    // #when
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action')

    // #then the delete carried the ETag observed at read time, lost the real race, and the successor survives
    expect(observedEtag).toBeDefined()
    expect(vi.mocked(adapter.conditionalDelete).mock.calls[0]?.[1]).toEqual({ifMatch: observedEtag})
    expect(result).toEqual(ok('conflict'))
    expect(JSON.parse(objects.get(ACTION_KEY)?.data ?? '{}')).toMatchObject({holder_id: 'action:1:2'})
  })

  it('returns an error for a store failure other than not-found', async () => {
    // #given
    const {config, adapter} = createMemoryStore({[ACTION_KEY]: holderRecord('action:1:1')})
    vi.mocked(adapter.getObject).mockResolvedValueOnce(err(new Error('503 slow down')))

    // #when
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action')

    // #then
    expect(result.success).toBe(false)
  })

  it('deletes only when holder_job matches too', async () => {
    // #given a lock held by the "build" job
    const {config, objects} = createMemoryStore({[ACTION_KEY]: {...holderRecord('action:1:1'), holder_job: 'build'}})

    // #when the "build" job's post hook releases with its recorded holder and job
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
      holderJob: 'build',
    })

    // #then
    expect(result).toEqual(ok('released'))
    expect(objects.has(ACTION_KEY)).toBe(false)
  })

  it.each([
    ['a sibling job of the same run and attempt', {holder_job: 'test'}, 'build'],
    ['a record without holder_job when one is expected', {}, 'build'],
    ['a record with holder_job when none is expected', {holder_job: 'build'}, undefined],
  ])('leaves the lock alone for %s', async (_label, recordOverrides, expectedJob) => {
    // #given both jobs share holder_id `action:1:1`
    const {config, objects} = createMemoryStore({[ACTION_KEY]: {...holderRecord('action:1:1'), ...recordOverrides}})

    // #when
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
      holderJob: expectedJob,
    })

    // #then
    expect(result).toEqual(ok('not-holder'))
    expect(objects.has(ACTION_KEY)).toBe(true)
  })

  it('treats a malformed holder_job as absent', async () => {
    // #given a record whose holder_job is outside the identity charset
    const {config, objects} = createMemoryStore({
      [ACTION_KEY]: {...holderRecord('action:1:1'), holder_job: 'bad job/../x'},
    })

    // #when the caller expects a job, then expects none
    const withJob = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
      holderJob: 'bad job/../x',
    })
    const withoutJob = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action')

    // #then the bad value never matches, and the record reads like a legacy one
    expect(withJob).toEqual(ok('not-holder'))
    expect(withoutJob).toEqual(ok('released'))
    expect(objects.has(ACTION_KEY)).toBe(false)
  })

  it('treats a NotFound on the delete as no-lock', async () => {
    // #given the lock vanishes between the read and the delete
    const {config, adapter} = createMemoryStore({[ACTION_KEY]: holderRecord('action:1:1')})
    vi.mocked(adapter.conditionalDelete).mockResolvedValueOnce(err(new Error('NoSuchKey')))

    // #when
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action')

    // #then
    expect(result).toEqual(ok('no-lock'))
  })

  it('returns an error for a generic delete failure', async () => {
    // #given
    const {config, adapter} = createMemoryStore({[ACTION_KEY]: holderRecord('action:1:1')})
    vi.mocked(adapter.conditionalDelete).mockResolvedValueOnce(err(new Error('503 slow down')))

    // #when
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action')

    // #then
    expect(result.success).toBe(false)
  })

  it('returns an error for a malformed lock body and deletes nothing', async () => {
    // #given
    const {config, adapter, objects} = createMemoryStore()
    objects.set(ACTION_KEY, {data: 'not json', etag: 'etag-bad'})

    // #when
    const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action')

    // #then
    expect(result.success).toBe(false)
    expect(adapter.conditionalDelete).not.toHaveBeenCalled()
    expect(objects.has(ACTION_KEY)).toBe(true)
  })

  describe('acquisition token', () => {
    const tokenRecord = (token?: string) => ({
      ...holderRecord('action:1:1'),
      holder_job: 'build',
      ...(token === undefined ? {} : {acquisition_token: token}),
    })

    it('deletes when the stored token matches', async () => {
      // #given
      const {config, objects} = createMemoryStore({[ACTION_KEY]: tokenRecord('token-aaaaaaaa')})

      // #when
      const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
        holderJob: 'build',
        acquisitionToken: 'token-aaaaaaaa',
      })

      // #then
      expect(result).toEqual(ok('released'))
      expect(objects.has(ACTION_KEY)).toBe(false)
    })

    it.each([
      ['a different token', 'token-bbbbbbbb'],
      ['no token on the record', undefined],
    ])('leaves the lock alone for %s', async (_label, stored) => {
      // #given identical holder_id and holder_job
      const {config, objects} = createMemoryStore({[ACTION_KEY]: tokenRecord(stored)})

      // #when
      const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
        holderJob: 'build',
        acquisitionToken: 'token-aaaaaaaa',
      })

      // #then
      expect(result).toEqual(ok('not-holder'))
      expect(objects.has(ACTION_KEY)).toBe(true)
    })

    it('does not compare the token when the caller supplies none', async () => {
      // #given a record with a token and a caller that never recorded one
      const {config} = createMemoryStore({[ACTION_KEY]: tokenRecord('token-aaaaaaaa')})

      // #when
      const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
        holderJob: 'build',
      })

      // #then
      expect(result).toEqual(ok('released'))
    })

    it('treats a malformed stored token as absent', async () => {
      // #given
      const {config, objects} = createMemoryStore({[ACTION_KEY]: tokenRecord('bad token/../x')})

      // #when the caller expects that exact value
      const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
        holderJob: 'build',
        acquisitionToken: 'bad token/../x',
      })

      // #then the dropped value can never match
      expect(result).toEqual(ok('not-holder'))
      expect(objects.has(ACTION_KEY)).toBe(true)
    })
  })

  describe('abort', () => {
    it('starts no delete when the deadline expires while the read is in flight', async () => {
      // #given a read that ignores the signal and resolves after the abort
      const {config, adapter, objects} = createMemoryStore({[ACTION_KEY]: holderRecord('action:1:1')})
      const controller = new AbortController()
      const realGet = vi.mocked(adapter.getObject).getMockImplementation()
      vi.mocked(adapter.getObject).mockImplementationOnce(async (key, options) => {
        controller.abort()
        return realGet?.(key, options) ?? err(new Error('unreachable'))
      })

      // #when
      const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
        signal: controller.signal,
      })

      // #then
      expect(result.success).toBe(false)
      expect(adapter.conditionalDelete).not.toHaveBeenCalled()
      expect(objects.has(ACTION_KEY)).toBe(true)
    })

    it('does not touch the store when already aborted', async () => {
      // #given
      const {config, adapter} = createMemoryStore({[ACTION_KEY]: holderRecord('action:1:1')})
      const controller = new AbortController()
      controller.abort()

      // #when
      const result = await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
        signal: controller.signal,
      })

      // #then
      expect(result.success).toBe(false)
      expect(adapter.getObject).not.toHaveBeenCalled()
    })

    it('passes the signal to both the read and the delete', async () => {
      // #given
      const {config, adapter} = createMemoryStore({[ACTION_KEY]: holderRecord('action:1:1')})
      const controller = new AbortController()

      // #when
      await releaseLockIfHolder(config, 'owner/repo', 'action:1:1', createLogger(), 'action', {
        signal: controller.signal,
      })

      // #then
      expect(vi.mocked(adapter.getObject).mock.calls[0]?.[1]).toEqual({signal: controller.signal})
      expect(vi.mocked(adapter.conditionalDelete).mock.calls[0]?.[1]).toMatchObject({signal: controller.signal})
    })
  })
})

describe('isPreconditionFailed', () => {
  it.each([
    ['PreconditionFailed', true],
    ['precondition failed', true],
    ['Pre-condition failed', true],
    ['503 slow down', false],
    ['NoSuchKey', false],
  ])('classifies %s as %s', (message, expected) => {
    expect(isPreconditionFailed(new Error(message))).toBe(expected)
  })
})
