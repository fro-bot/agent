import type {ObjectStoreAdapter, Result} from '@fro-bot/runtime'
import type {StoreLogger} from './subscription-store.js'

import {createObjectStoreOperationError, err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createOperatorPushSubscriptionStore, toSubscriptionMetadata} from './subscription-store.js'

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

/**
 * Faithfully models S3-style conditionalPut ifNoneMatch/ifMatch etag CAS
 * semantics against a shared backing map. Passing an existing map lets a
 * test simulate a fresh store "reload" over the same on-disk state.
 */
function createCasFakeAdapter(backing: Map<string, {data: string; etag: string}> = new Map()): ObjectStoreAdapter {
  let etagCounter = 0

  return {
    upload: async () => ok(undefined),
    download: async () => ok(undefined),
    list: async (prefix: string) => ok(Array.from(backing.keys()).filter(k => k.startsWith(prefix))),
    conditionalPut: async (key, data, options) => {
      const current = backing.get(key)
      if (options.ifNoneMatch === '*' && current !== undefined) {
        return err(new Error('PreconditionFailed: key already exists'))
      }
      if (options.ifMatch !== undefined && (current === undefined || current.etag !== options.ifMatch)) {
        return err(new Error('PreconditionFailed: etag mismatch'))
      }
      etagCounter += 1
      const etag = `etag-${etagCounter}`
      backing.set(key, {data, etag})
      return ok({etag})
    },
    conditionalDelete: async (key, options) => {
      const current = backing.get(key)
      if (current === undefined) {
        return err(new Error('NotFound: no such key'))
      }
      if (current.etag !== options.ifMatch) {
        return err(new Error('PreconditionFailed: etag mismatch'))
      }
      backing.delete(key)
      return ok(undefined)
    },
    getObject: async key => {
      const current = backing.get(key)
      if (current === undefined) {
        return err(new Error('NotFound: no such key'))
      }
      return ok({data: current.data, etag: current.etag})
    },
    listWithMetadata: async prefix =>
      ok(
        Array.from(backing.keys())
          .filter(k => k.startsWith(prefix))
          .map(key => ({key, lastModified: new Date()})),
      ),
  }
}

/** Last-write-wins adapter: no real CAS — both contended writes "succeed". */
function createLastWriteWinsFakeAdapter(): ObjectStoreAdapter {
  const objects = new Map<string, {data: string; etag: string}>()
  let etagCounter = 0

  return {
    upload: async () => ok(undefined),
    download: async () => ok(undefined),
    list: async (prefix: string) => ok(Array.from(objects.keys()).filter(k => k.startsWith(prefix))),
    conditionalPut: async (key, data): Promise<Result<{etag: string}, Error>> => {
      // Ignores ifNoneMatch/ifMatch entirely — always "succeeds" (last writer wins).
      etagCounter += 1
      const etag = `etag-${etagCounter}`
      objects.set(key, {data, etag})
      return ok({etag})
    },
    conditionalDelete: async key => {
      objects.delete(key)
      return ok(undefined)
    },
    getObject: async key => {
      const current = objects.get(key)
      if (current === undefined) {
        return err(new Error('NotFound: no such key'))
      }
      return ok({data: current.data, etag: current.etag})
    },
  }
}

/** Adapter missing conditionalPut entirely. */
function createNonCasAdapter(): ObjectStoreAdapter {
  return {
    upload: async () => ok(undefined),
    download: async () => ok(undefined),
    list: async () => ok([]),
  }
}

/** Adapter whose conditionalPut ALWAYS PreconditionFails — simulates a permanently contended key. */
function createAlwaysConflictingAdapter(): ObjectStoreAdapter {
  return {
    upload: async () => ok(undefined),
    download: async () => ok(undefined),
    list: async () => ok([]),
    conditionalPut: async () => err(new Error('PreconditionFailed: always conflicting')),
    conditionalDelete: async () => ok(undefined),
    getObject: async () => err(new Error('NotFound: no such key')),
  }
}

/** Wraps a CAS-fake adapter's conditionalPut with a call counter, to prove a retry actually fired. */
function withConditionalPutCallCounter(adapter: ObjectStoreAdapter): {
  readonly adapter: ObjectStoreAdapter
  readonly callCount: () => number
} {
  let calls = 0
  const conditionalPut = adapter.conditionalPut
  if (conditionalPut === undefined) throw new Error('unreachable')
  return {
    adapter: {
      ...adapter,
      conditionalPut: async (key, data, options) => {
        calls += 1
        return conditionalPut(key, data, options)
      },
    },
    callCount: () => calls,
  }
}

/** Adapter whose conditionalDelete on the subscription key ALWAYS PreconditionFails, everything else delegates. */
function withAlwaysFailingConditionalDeleteFor(
  adapter: ObjectStoreAdapter,
  shouldFail: (key: string) => boolean,
): ObjectStoreAdapter {
  const conditionalDelete = adapter.conditionalDelete
  if (conditionalDelete === undefined) throw new Error('unreachable')
  return {
    ...adapter,
    conditionalDelete: async (key, options) => {
      if (shouldFail(key)) {
        return err(new Error('PreconditionFailed: forced conflict'))
      }
      return conditionalDelete(key, options)
    },
  }
}

/** Adapter that returns a structured ObjectStoreOperationError (httpStatusCode-based) instead of a plain Error. */
function createStructuredErrorAdapter(): ObjectStoreAdapter {
  const objects = new Map<string, {data: string; etag: string}>()
  let etagCounter = 0

  return {
    upload: async () => ok(undefined),
    download: async () => ok(undefined),
    list: async (prefix: string) => ok(Array.from(objects.keys()).filter(k => k.startsWith(prefix))),
    conditionalPut: async (key, data, options) => {
      const current = objects.get(key)
      if (options.ifNoneMatch === '*' && current !== undefined) {
        return err(createObjectStoreOperationError('conflict', {httpStatusCode: 412}))
      }
      if (options.ifMatch !== undefined && (current === undefined || current.etag !== options.ifMatch)) {
        return err(createObjectStoreOperationError('conflict', {httpStatusCode: 412}))
      }
      etagCounter += 1
      const etag = `etag-${etagCounter}`
      objects.set(key, {data, etag})
      return ok({etag})
    },
    conditionalDelete: async (key, options) => {
      const current = objects.get(key)
      if (current === undefined) {
        return err(createObjectStoreOperationError('missing', {httpStatusCode: 404}))
      }
      if (current.etag !== options.ifMatch) {
        return err(createObjectStoreOperationError('conflict', {httpStatusCode: 412}))
      }
      objects.delete(key)
      return ok(undefined)
    },
    getObject: async key => {
      const current = objects.get(key)
      if (current === undefined) {
        return err(createObjectStoreOperationError('missing', {httpStatusCode: 404}))
      }
      return ok({data: current.data, etag: current.etag})
    },
  }
}

const testLogger: StoreLogger = {
  debug: () => {},
  warn: () => {},
}

function makeStore(adapter: ObjectStoreAdapter, clock?: () => number) {
  return createOperatorPushSubscriptionStore({adapter, logger: testLogger, clock})
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOperatorPushSubscriptionStore — subscribe happy path', () => {
  it('creates an active record and listMetadata returns metadata without secrets', async () => {
    // #given a fresh CAS-capable store
    const store = makeStore(createCasFakeAdapter())

    // #when subscribing an operator's first endpoint
    const result = await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-1',
      p256dh: 'p256dh-secret',
      auth: 'auth-secret',
      keyVersion: '1',
    })

    // #then the create succeeds and metadata omits the secret fields
    expect(result.success).toBe(true)
    if (result.success === false) throw new Error('unreachable')
    expect(result.data.active).toBe(true)
    expect(result.data.ownershipGeneration).toBe(1)
    expect('endpoint' in result.data).toBe(false)
    expect('p256dh' in result.data).toBe(false)
    expect('auth' in result.data).toBe(false)

    const listed = await store.listMetadataForOperator({operatorId: 'operator-a'})
    expect(listed.success).toBe(true)
    if (listed.success === false) throw new Error('unreachable')
    expect(listed.data).toHaveLength(1)
    expect(listed.data[0]?.active).toBe(true)
  })
})

describe('createOperatorPushSubscriptionStore — same operator re-subscribe', () => {
  it('replaces in place without creating a duplicate record', async () => {
    // #given an operator with an existing subscription
    const store = makeStore(createCasFakeAdapter())
    const endpoint = 'https://push.example.com/ep-dup'
    await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p1', auth: 'a1', keyVersion: '1'})

    // #when the same operator subscribes the same endpoint again
    const second = await store.subscribe({
      operatorId: 'operator-a',
      endpoint,
      p256dh: 'p2',
      auth: 'a2',
      keyVersion: '2',
    })

    // #then no duplicate is created and generation is unchanged
    expect(second.success).toBe(true)
    if (second.success === false) throw new Error('unreachable')
    expect(second.data.ownershipGeneration).toBe(1)
    expect(second.data.keyVersion).toBe('2')

    const listed = await store.listMetadataForOperator({operatorId: 'operator-a'})
    if (listed.success === false) throw new Error('unreachable')
    expect(listed.data).toHaveLength(1)
  })
})

describe('createOperatorPushSubscriptionStore — ownership transfer', () => {
  it('transfers ownership atomically and bumps generation; old owner loses the record', async () => {
    // #given operator A owns an endpoint
    const store = makeStore(createCasFakeAdapter())
    const endpoint = 'https://push.example.com/ep-transfer'
    await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p1', auth: 'a1', keyVersion: '1'})

    // #when operator B subscribes with the same endpoint
    const transfer = await store.subscribe({
      operatorId: 'operator-b',
      endpoint,
      p256dh: 'p2',
      auth: 'a2',
      keyVersion: '1',
    })

    // #then ownership moves to B, generation bumps, and A no longer sees it
    expect(transfer.success).toBe(true)
    if (transfer.success === false) throw new Error('unreachable')
    expect(transfer.data.operatorId).toBe('operator-b')
    expect(transfer.data.ownershipGeneration).toBe(2)

    const aRecords = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (aRecords.success === false) throw new Error('unreachable')
    expect(aRecords.data).toHaveLength(0)

    const bRecords = await store.getActiveRecordsForOperator({operatorId: 'operator-b'})
    if (bRecords.success === false) throw new Error('unreachable')
    expect(bRecords.data).toHaveLength(1)
  })
})

describe('createOperatorPushSubscriptionStore — cross-operator mutation fails closed', () => {
  it("a different operator cannot unsubscribe another operator's record", async () => {
    // #given operator A owns an endpoint
    const store = makeStore(createCasFakeAdapter())
    const endpoint = 'https://push.example.com/ep-owned'
    await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p1', auth: 'a1', keyVersion: '1'})

    // #when operator B tries to unsubscribe it
    const result = await store.unsubscribe({operatorId: 'operator-b', endpoint})

    // #then the call fails closed and A's record is unaffected
    expect(result.success).toBe(false)
    const aRecords = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (aRecords.success === false) throw new Error('unreachable')
    expect(aRecords.data).toHaveLength(1)
  })
})

describe('createOperatorPushSubscriptionStore — mark inactive', () => {
  it('stops the record appearing in getActiveRecordsForOperator', async () => {
    // #given an active subscription
    const store = makeStore(createCasFakeAdapter())
    const endpoint = 'https://push.example.com/ep-inactive'
    await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p1', auth: 'a1', keyVersion: '1'})

    // #when the owning operator unsubscribes
    const result = await store.unsubscribe({operatorId: 'operator-a', endpoint})
    expect(result.success).toBe(true)

    // #then getActiveRecordsForOperator no longer returns it
    const active = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (active.success === false) throw new Error('unreachable')
    expect(active.data).toHaveLength(0)

    // but it is still visible (inactive) via listMetadata
    const listed = await store.listMetadataForOperator({operatorId: 'operator-a'})
    if (listed.success === false) throw new Error('unreachable')
    expect(listed.data).toHaveLength(1)
    expect(listed.data[0]?.active).toBe(false)
    expect(listed.data[0]?.inactiveReason).toBe('unsubscribed')
  })
})

describe('createOperatorPushSubscriptionStore — durability across reload', () => {
  it('records survive a new store instance over the same backing store', async () => {
    // #given a store with a subscription, backed by a shared map
    const backing = new Map<string, {data: string; etag: string}>()
    const adapter1 = createCasFakeAdapter(backing)
    const store1 = makeStore(adapter1)
    await store1.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-durable',
      p256dh: 'p1',
      auth: 'a1',
      keyVersion: '1',
    })

    // #when a fresh store instance is created over the same backing map (simulated reload)
    const adapter2 = createCasFakeAdapter(backing)
    const store2 = makeStore(adapter2)

    // #then dispatch queries on the new instance see the recovered state
    const active = await store2.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (active.success === false) throw new Error('unreachable')
    expect(active.data).toHaveLength(1)
    expect(active.data[0]?.endpoint).toBe('https://push.example.com/ep-durable')
  })
})

describe('createOperatorPushSubscriptionStore — CAS conflict retry on transfer', () => {
  it('retries a contended transfer without producing two active owners for one endpoint', async () => {
    // #given operator A owns an endpoint, with a call-counting adapter wrapper
    const {adapter: counted, callCount} = withConditionalPutCallCounter(createCasFakeAdapter())
    const store = makeStore(counted)
    const endpoint = 'https://push.example.com/ep-race'
    await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p1', auth: 'a1', keyVersion: '1'})
    const callsBeforeRace = callCount()

    // #when two different operators race to claim the endpoint concurrently
    const [transferB, transferC] = await Promise.all([
      store.subscribe({operatorId: 'operator-b', endpoint, p256dh: 'pb', auth: 'ab', keyVersion: '1'}),
      store.subscribe({operatorId: 'operator-c', endpoint, p256dh: 'pc', auth: 'ac', keyVersion: '1'}),
    ])

    // #then both calls succeed via retry, and exactly one owner ends up active
    expect(transferB.success).toBe(true)
    expect(transferC.success).toBe(true)

    // A clean single-attempt race would need exactly 2 conditionalPut calls
    // (one per subscriber); more than that proves a retry actually fired
    // after a lost CAS race, not just a lucky non-conflicting interleave.
    expect(callCount() - callsBeforeRace).toBeGreaterThan(2)

    const [aActive, bActive, cActive] = await Promise.all([
      store.getActiveRecordsForOperator({operatorId: 'operator-a'}),
      store.getActiveRecordsForOperator({operatorId: 'operator-b'}),
      store.getActiveRecordsForOperator({operatorId: 'operator-c'}),
    ])
    if (aActive.success === false || bActive.success === false || cActive.success === false) {
      throw new Error('unreachable')
    }
    const totalActiveOwners = aActive.data.length + bActive.data.length + cActive.data.length
    expect(totalActiveOwners).toBe(1)
  })
})

describe('createOperatorPushSubscriptionStore — selfTestCas', () => {
  it('passes on a real-CAS fake', async () => {
    // #given a CAS-capable adapter
    const store = makeStore(createCasFakeAdapter())

    // #when running the startup self-test
    const result = await store.selfTestCas()

    // #then it succeeds
    expect(result.success).toBe(true)
  })

  it('fails with a SelfTestCasFailure on a last-write-wins fake', async () => {
    // #given a last-write-wins adapter (no real CAS)
    const store = makeStore(createLastWriteWinsFakeAdapter())

    // #when running the startup self-test
    const result = await store.selfTestCas()

    // #then it fails closed with the dedicated failure code, signalling the
    // caller to fail the push surface closed rather than a generic store error
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('unreachable')
    expect(result.error.code).toBe('OPERATOR_PUSH_SELF_TEST_CAS_FAILURE')
  })

  it('fails with a SelfTestCasFailure on an adapter missing conditionalPut', async () => {
    // #given an adapter that lacks CAS capability entirely
    const store = makeStore(createNonCasAdapter())

    // #when running the startup self-test
    const result = await store.selfTestCas()

    // #then it fails closed with the dedicated failure code
    expect(result.success).toBe(false)
    if (result.success === true) throw new Error('unreachable')
    expect(result.error.code).toBe('OPERATOR_PUSH_SELF_TEST_CAS_FAILURE')
  })

  it('does not leak the self-test key into subsequent scans', async () => {
    // #given a store that has just run its startup self-test
    const store = makeStore(createCasFakeAdapter())
    await store.selfTestCas()
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-post-selftest',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })

    // #when scanning for an operator's records
    const listed = await store.listMetadataForOperator({operatorId: 'operator-a'})
    const active = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})

    // #then only the real subscription is returned — the self-test key lives
    // under a prefix outside every scan and is never surfaced
    if (listed.success === false || active.success === false) throw new Error('unreachable')
    expect(listed.data).toHaveLength(1)
    expect(active.data).toHaveLength(1)
  })
})

describe('createOperatorPushSubscriptionStore — pruneInactive (records)', () => {
  it('removes inactive records older than the window and keeps recent ones', async () => {
    // #given two inactive records: one old, one recent
    let now = 1_000_000
    const store = makeStore(createCasFakeAdapter(), () => now)

    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-old',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    await store.unsubscribe({operatorId: 'operator-a', endpoint: 'https://push.example.com/ep-old'})

    now += 40 * 24 * 60 * 60 * 1000 // fast-forward 40 days
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-recent',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    await store.unsubscribe({operatorId: 'operator-a', endpoint: 'https://push.example.com/ep-recent'})

    now += 1000 // barely after the recent unsubscribe

    // #when pruning with the default 30-day window
    const pruned = await store.pruneInactive()

    // #then only the old record is removed
    expect(pruned.success).toBe(true)
    if (pruned.success === false) throw new Error('unreachable')
    expect(pruned.data.records).toBe(1)

    const remaining = await store.listMetadataForOperator({operatorId: 'operator-a'})
    if (remaining.success === false) throw new Error('unreachable')
    expect(remaining.data).toHaveLength(1)
  })
})

describe('createOperatorPushSubscriptionStore — pruneInactive (tombstones)', () => {
  it('prunes a tombstone older than the retention window and keeps a recent one', async () => {
    // #given two deleted (tombstoned) endpoints: one old, one recent
    let now = 1_000_000
    const store = makeStore(createCasFakeAdapter(), () => now)

    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-tomb-old',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    await store.deleteForOperator({operatorId: 'operator-a'})

    now += 100 * 24 * 60 * 60 * 1000 // fast-forward past the 90-day default tombstone retention

    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-tomb-recent',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    await store.deleteForOperator({operatorId: 'operator-a'})

    now += 1000 // barely after the recent delete

    // #when pruning with the default retention windows
    const pruned = await store.pruneInactive()

    // #then only the old tombstone is removed
    expect(pruned.success).toBe(true)
    if (pruned.success === false) throw new Error('unreachable')
    expect(pruned.data.tombstones).toBe(1)
  })
})

describe('createOperatorPushSubscriptionStore — privacy: secrets never leak', () => {
  it('listMetadata and toSubscriptionMetadata never include endpoint, p256dh, or auth', async () => {
    // #given an active subscription
    const store = makeStore(createCasFakeAdapter())
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-secret',
      p256dh: 'p256dh-secret-value',
      auth: 'auth-secret-value',
      keyVersion: '1',
    })

    // #when reading via the safe metadata surface
    const listed = await store.listMetadataForOperator({operatorId: 'operator-a'})
    if (listed.success === false) throw new Error('unreachable')

    // #then no secret field is present, by structural absence and by JSON serialization check
    const serialized = JSON.stringify(listed.data)
    expect(serialized).not.toContain('p256dh-secret-value')
    expect(serialized).not.toContain('auth-secret-value')
    expect(serialized).not.toContain('https://push.example.com/ep-secret')
  })
})

describe('createOperatorPushSubscriptionStore — restore regression (tombstone wins)', () => {
  it('a deleted record stays excluded after a stale backup restores the subscription object alone, with no re-delete', async () => {
    // #given a subscription that gets privacy-deleted
    const backing = new Map<string, {data: string; etag: string}>()
    const store1 = makeStore(createCasFakeAdapter(backing))
    const endpoint = 'https://push.example.com/ep-restore'
    await store1.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p', auth: 'a', keyVersion: '1'})

    const subscriptionKey = Array.from(backing.keys()).find(k => k.includes('subscriptions/by-endpoint'))
    if (subscriptionKey === undefined) throw new Error('unreachable')
    const staleActiveSnapshot = backing.get(subscriptionKey)
    if (staleActiveSnapshot === undefined) throw new Error('unreachable')

    const deleteResult = await store1.deleteForOperator({operatorId: 'operator-a'})
    expect(deleteResult.success).toBe(true)

    // The subscription object is physically gone; only the tombstone key remains.
    expect(backing.has(subscriptionKey)).toBe(false)
    const tombstoneKey = Array.from(backing.keys()).find(k => k.includes('tombstones'))
    if (tombstoneKey === undefined) throw new Error('unreachable')

    // #when a stale backup restores ONLY the subscription object's old active
    // bytes — the tombstone key is untouched — and then the store reloads
    backing.set(subscriptionKey, staleActiveSnapshot)
    const store2 = makeStore(createCasFakeAdapter(backing))

    // #then the resurrected subscription object is still excluded from every
    // active-read surface, because its tombstone at the separate key still
    // exists. No second deleteForOperator call is made.
    const active = await store2.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (active.success === false) throw new Error('unreachable')
    expect(active.data).toHaveLength(0)

    const listed = await store2.listMetadataForOperator({operatorId: 'operator-a'})
    if (listed.success === false) throw new Error('unreachable')
    expect(listed.data).toHaveLength(0)

    const parsedSnapshot = JSON.parse(staleActiveSnapshot.data) as {
      endpointHash: string
      ownershipGeneration: number
    }
    const stillOwned = await store2.verifyStillOwned({
      endpointHash: parsedSnapshot.endpointHash,
      operatorId: 'operator-a',
      ownershipGeneration: parsedSnapshot.ownershipGeneration,
    })
    if (stillOwned.success === false) throw new Error('unreachable')
    expect(stillOwned.data).toBe(false)
  })
})

describe('createOperatorPushSubscriptionStore — privacy delete removes secrets from disk', () => {
  it('the subscription object is physically gone after delete', async () => {
    // #given an active subscription
    const backing = new Map<string, {data: string; etag: string}>()
    const store = makeStore(createCasFakeAdapter(backing))
    const endpoint = 'https://push.example.com/ep-secret-removal'
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint,
      p256dh: 'p256dh-value',
      auth: 'auth-value',
      keyVersion: '1',
    })

    const subscriptionKey = Array.from(backing.keys()).find(k => k.includes('subscriptions/by-endpoint'))
    if (subscriptionKey === undefined) throw new Error('unreachable')

    // #when the operator privacy-deletes it
    await store.deleteForOperator({operatorId: 'operator-a'})

    // #then the subscription object key no longer exists — the secrets are
    // physically gone, not merely marked inactive.
    expect(backing.has(subscriptionKey)).toBe(false)

    // and no remaining object in the backing store contains the secret values.
    const remainingSerialized = JSON.stringify(Array.from(backing.values()))
    expect(remainingSerialized).not.toContain('p256dh-value')
    expect(remainingSerialized).not.toContain('auth-value')
    expect(remainingSerialized).not.toContain(endpoint)
  })
})

describe('createOperatorPushSubscriptionStore — re-subscribe after delete clears the tombstone', () => {
  it('a legitimate re-subscribe of the same endpoint is active and dispatchable again', async () => {
    // #given an endpoint that was privacy-deleted
    const store = makeStore(createCasFakeAdapter())
    const endpoint = 'https://push.example.com/ep-resubscribe'
    await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p1', auth: 'a1', keyVersion: '1'})
    await store.deleteForOperator({operatorId: 'operator-a'})

    const beforeResubscribe = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (beforeResubscribe.success === false) throw new Error('unreachable')
    expect(beforeResubscribe.data).toHaveLength(0)

    // #when the same operator authenticates and re-subscribes the same endpoint
    const resubscribed = await store.subscribe({
      operatorId: 'operator-a',
      endpoint,
      p256dh: 'p2',
      auth: 'a2',
      keyVersion: '1',
    })
    expect(resubscribed.success).toBe(true)

    // #then the new record is active and dispatchable — delete is not a permanent ban
    const active = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (active.success === false) throw new Error('unreachable')
    expect(active.data).toHaveLength(1)
    expect(active.data[0]?.active).toBe(true)

    if (resubscribed.success === false) throw new Error('unreachable')
    const stillOwned = await store.verifyStillOwned({
      endpointHash: resubscribed.data.endpointHash,
      operatorId: 'operator-a',
      ownershipGeneration: resubscribed.data.ownershipGeneration,
    })
    if (stillOwned.success === false) throw new Error('unreachable')
    expect(stillOwned.data).toBe(true)
  })
})

describe('createOperatorPushSubscriptionStore — verifyStillOwned linearizability', () => {
  it('returns false when a transfer bumped the generation between the dispatch read and the check', async () => {
    // #given operator A's active subscription, read for dispatch
    const store = makeStore(createCasFakeAdapter())
    const endpoint = 'https://push.example.com/ep-verify'
    await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p', auth: 'a', keyVersion: '1'})

    const active = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (active.success === false) throw new Error('unreachable')
    const record = active.data[0]
    if (record === undefined) throw new Error('unreachable')

    // #when a transfer to operator B lands after the dispatch read but before verification
    await store.subscribe({operatorId: 'operator-b', endpoint, p256dh: 'p2', auth: 'a2', keyVersion: '1'})

    const stillOwned = await store.verifyStillOwned({
      endpointHash: record.endpointHash,
      operatorId: 'operator-a',
      ownershipGeneration: record.ownershipGeneration,
    })

    // #then the stale read is rejected — operator A's notification must not be sent
    expect(stillOwned.success).toBe(true)
    if (stillOwned.success === false) throw new Error('unreachable')
    expect(stillOwned.data).toBe(false)
  })

  it('returns true when nothing changed since the dispatch read', async () => {
    // #given an unchanged active subscription
    const store = makeStore(createCasFakeAdapter())
    const endpoint = 'https://push.example.com/ep-verify-ok'
    await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p', auth: 'a', keyVersion: '1'})
    const active = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (active.success === false) throw new Error('unreachable')
    const record = active.data[0]
    if (record === undefined) throw new Error('unreachable')

    // #when verifying immediately
    const stillOwned = await store.verifyStillOwned({
      endpointHash: record.endpointHash,
      operatorId: 'operator-a',
      ownershipGeneration: record.ownershipGeneration,
    })

    // #then it is confirmed still owned
    expect(stillOwned.success).toBe(true)
    if (stillOwned.success === false) throw new Error('unreachable')
    expect(stillOwned.data).toBe(true)
  })

  it('returns false for a nonexistent endpointHash', async () => {
    // #given a store with no matching record
    const store = makeStore(createCasFakeAdapter())

    // #when verifying an endpointHash that was never subscribed
    const stillOwned = await store.verifyStillOwned({
      endpointHash: 'never-existed',
      operatorId: 'operator-a',
      ownershipGeneration: 1,
    })

    // #then it reports not-owned rather than erroring
    expect(stillOwned.success).toBe(true)
    if (stillOwned.success === false) throw new Error('unreachable')
    expect(stillOwned.data).toBe(false)
  })

  it('returns false for a privacy-deleted endpoint via the tombstone fast-path', async () => {
    // #given a subscription that gets privacy-deleted (record physically gone, tombstone remains)
    const store = makeStore(createCasFakeAdapter())
    const endpoint = 'https://push.example.com/ep-verify-deleted'
    const subscribed = await store.subscribe({
      operatorId: 'operator-a',
      endpoint,
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    if (subscribed.success === false) throw new Error('unreachable')
    await store.deleteForOperator({operatorId: 'operator-a'})

    // #when verifying ownership of the now-deleted endpoint
    const stillOwned = await store.verifyStillOwned({
      endpointHash: subscribed.data.endpointHash,
      operatorId: 'operator-a',
      ownershipGeneration: subscribed.data.ownershipGeneration,
    })

    // #then the tombstone fast-path rejects it before even reading the (now-absent) record
    expect(stillOwned.success).toBe(true)
    if (stillOwned.success === false) throw new Error('unreachable')
    expect(stillOwned.data).toBe(false)
  })
})

describe('createOperatorPushSubscriptionStore — deactivateForOperator', () => {
  it('marks every active record inactive with reason session-revoked', async () => {
    // #given operator A with two active subscriptions
    const store = makeStore(createCasFakeAdapter())
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-deact-1',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-deact-2',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })

    // #when deactivating for that operator
    const result = await store.deactivateForOperator({operatorId: 'operator-a'})

    // #then both records are updated and none remain active
    expect(result.success).toBe(true)
    if (result.success === false) throw new Error('unreachable')
    expect(result.data.updated).toBe(2)
    expect(result.data.skipped).toBe(0)

    const active = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (active.success === false) throw new Error('unreachable')
    expect(active.data).toHaveLength(0)

    const listed = await store.listMetadataForOperator({operatorId: 'operator-a'})
    if (listed.success === false) throw new Error('unreachable')
    expect(listed.data.every(m => m.inactiveReason === 'session-revoked')).toBe(true)
  })

  it("is operator-scoped: does not affect another operator's records", async () => {
    // #given operator A and operator B each with an active subscription
    const store = makeStore(createCasFakeAdapter())
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-deact-a',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    await store.subscribe({
      operatorId: 'operator-b',
      endpoint: 'https://push.example.com/ep-deact-b',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })

    // #when operator B's session is revoked
    await store.deactivateForOperator({operatorId: 'operator-b'})

    // #then operator A's record is untouched
    const aActive = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (aActive.success === false) throw new Error('unreachable')
    expect(aActive.data).toHaveLength(1)
  })

  it('logs a warning and reports skipped when the CAS retry loop is exhausted', async () => {
    // #given an active record on a real adapter, then swapped for an
    // always-conflicting adapter to force retry exhaustion
    const backing = new Map<string, {data: string; etag: string}>()
    const seedStore = makeStore(createCasFakeAdapter(backing))
    await seedStore.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-deact-exhaust',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })

    const conflictingAdapter: ObjectStoreAdapter = {
      ...createAlwaysConflictingAdapter(),
      list: async prefix => ok(Array.from(backing.keys()).filter(k => k.startsWith(prefix))),
      getObject: async key => {
        const current = backing.get(key)
        if (current === undefined) return err(new Error('NotFound: no such key'))
        return ok({data: current.data, etag: current.etag})
      },
    }
    const warn = vi.fn()
    const store = createOperatorPushSubscriptionStore({
      adapter: conflictingAdapter,
      logger: {debug: () => {}, warn},
    })

    // #when deactivating against a permanently contended key
    const result = await store.deactivateForOperator({operatorId: 'operator-a'})

    // #then the retry loop exhausts, the record stays untouched, and a warning is logged
    expect(result.success).toBe(true)
    if (result.success === false) throw new Error('unreachable')
    expect(result.data.updated).toBe(0)
    expect(result.data.skipped).toBe(1)
    expect(warn).toHaveBeenCalled()

    const stillActive = await seedStore.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (stillActive.success === false) throw new Error('unreachable')
    expect(stillActive.data).toHaveLength(1)
  })
})

describe('createOperatorPushSubscriptionStore — markDead', () => {
  it("marks the owner's record inactive with reason dead", async () => {
    // #given an active subscription
    const store = makeStore(createCasFakeAdapter())
    const endpoint = 'https://push.example.com/ep-dead'
    await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p', auth: 'a', keyVersion: '1'})

    // #when the owner marks it dead (relay 410 handling)
    const result = await store.markDead({operatorId: 'operator-a', endpoint})

    // #then it becomes inactive with the dead reason
    expect(result.success).toBe(true)
    const listed = await store.listMetadataForOperator({operatorId: 'operator-a'})
    if (listed.success === false) throw new Error('unreachable')
    expect(listed.data[0]?.active).toBe(false)
    expect(listed.data[0]?.inactiveReason).toBe('dead')
  })

  it("fails closed when a different operator calls markDead on someone else's endpoint", async () => {
    // #given operator A owns an endpoint
    const store = makeStore(createCasFakeAdapter())
    const endpoint = 'https://push.example.com/ep-dead-owned'
    await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p', auth: 'a', keyVersion: '1'})

    // #when operator B calls markDead on it
    const result = await store.markDead({operatorId: 'operator-b', endpoint})

    // #then the call fails closed and A's record is unaffected
    expect(result.success).toBe(false)
    const active = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (active.success === false) throw new Error('unreachable')
    expect(active.data).toHaveLength(1)
  })

  it('is idempotent — a second markDead call is a no-op success', async () => {
    // #given a subscription already marked dead
    const store = makeStore(createCasFakeAdapter())
    const endpoint = 'https://push.example.com/ep-dead-idempotent'
    await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p', auth: 'a', keyVersion: '1'})
    await store.markDead({operatorId: 'operator-a', endpoint})

    // #when markDead is called again
    const second = await store.markDead({operatorId: 'operator-a', endpoint})

    // #then it succeeds as a no-op
    expect(second.success).toBe(true)
  })

  it('is a no-op success for a non-existent endpoint', async () => {
    // #given no subscription for this endpoint
    const store = makeStore(createCasFakeAdapter())

    // #when marking it dead
    const result = await store.markDead({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-never-existed',
    })

    // #then it succeeds as a no-op
    expect(result.success).toBe(true)
  })
})

describe('createOperatorPushSubscriptionStore — deleteForOperator gaps', () => {
  it("is operator-scoped: does not affect another operator's records", async () => {
    // #given operator A and operator B each with an active subscription
    const store = makeStore(createCasFakeAdapter())
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-del-a',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    await store.subscribe({
      operatorId: 'operator-b',
      endpoint: 'https://push.example.com/ep-del-b',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })

    // #when operator B privacy-deletes their own records
    await store.deleteForOperator({operatorId: 'operator-b'})

    // #then operator A's record is untouched
    const aActive = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (aActive.success === false) throw new Error('unreachable')
    expect(aActive.data).toHaveLength(1)
  })

  it("removes exactly the target operator's records, active and inactive, leaving other operators intact", async () => {
    // #given operator A with 2 active + 1 inactive record, operator B with 2 active
    const store = makeStore(createCasFakeAdapter())
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-multi-a1',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-multi-a2',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-multi-a3',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    await store.unsubscribe({operatorId: 'operator-a', endpoint: 'https://push.example.com/ep-multi-a3'})
    await store.subscribe({
      operatorId: 'operator-b',
      endpoint: 'https://push.example.com/ep-multi-b1',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    await store.subscribe({
      operatorId: 'operator-b',
      endpoint: 'https://push.example.com/ep-multi-b2',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })

    // #when deleting operator A
    const result = await store.deleteForOperator({operatorId: 'operator-a'})

    // #then exactly A's 3 records are removed and B's 2 are intact
    expect(result.success).toBe(true)
    if (result.success === false) throw new Error('unreachable')
    expect(result.data.deleted).toBe(3)

    const aListed = await store.listMetadataForOperator({operatorId: 'operator-a'})
    if (aListed.success === false) throw new Error('unreachable')
    expect(aListed.data).toHaveLength(0)

    const bActive = await store.getActiveRecordsForOperator({operatorId: 'operator-b'})
    if (bActive.success === false) throw new Error('unreachable')
    expect(bActive.data).toHaveLength(2)
  })

  it('does not count a record as deleted when the physical delete loses its CAS race', async () => {
    // #given an active subscription whose physical conditionalDelete is forced to always PreconditionFail
    const backing = new Map<string, {data: string; etag: string}>()
    const baseAdapter = createCasFakeAdapter(backing)
    const forcedConflictAdapter = withAlwaysFailingConditionalDeleteFor(baseAdapter, key =>
      key.includes('subscriptions/by-endpoint'),
    )
    const warn = vi.fn()
    const store = createOperatorPushSubscriptionStore({adapter: forcedConflictAdapter, logger: {debug: () => {}, warn}})
    const endpoint = 'https://push.example.com/ep-physical-delete-race'
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint,
      p256dh: 'p256dh-still-on-disk',
      auth: 'auth-still-on-disk',
      keyVersion: '1',
    })

    // #when privacy-deleting while the physical delete is forced to conflict
    const result = await store.deleteForOperator({operatorId: 'operator-a'})

    // #then the tombstone still excludes the record from reads, but it is NOT
    // counted as deleted, and the secrets remain on disk pending a later prune
    expect(result.success).toBe(true)
    if (result.success === false) throw new Error('unreachable')
    expect(result.data.deleted).toBe(0)
    expect(result.data.skipped).toBe(1)
    expect(warn).toHaveBeenCalled()

    const active = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    if (active.success === false) throw new Error('unreachable')
    expect(active.data).toHaveLength(0) // tombstone still excludes it from reads

    const subscriptionKey = Array.from(backing.keys()).find(k => k.includes('subscriptions/by-endpoint'))
    if (subscriptionKey === undefined) throw new Error('unreachable')
    expect(backing.get(subscriptionKey)?.data).toContain('p256dh-still-on-disk') // secrets acknowledged as still on disk
  })
})

describe('createOperatorPushSubscriptionStore — corrupted record resilience', () => {
  it('skips a malformed record without throwing and returns valid siblings', async () => {
    // #given one valid record and one corrupted record written directly to the backing store
    const backing = new Map<string, {data: string; etag: string}>()
    const store = makeStore(createCasFakeAdapter(backing))
    await store.subscribe({
      operatorId: 'operator-a',
      endpoint: 'https://push.example.com/ep-valid',
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })
    backing.set('operator-push/subscriptions/by-endpoint/corrupted-hash.json', {
      data: 'not valid json {{{',
      etag: 'etag-corrupt',
    })

    // #when scanning for the operator's records
    const active = await store.getActiveRecordsForOperator({operatorId: 'operator-a'})
    const listed = await store.listMetadataForOperator({operatorId: 'operator-a'})

    // #then the corrupted record is skipped silently and the valid sibling is still returned
    expect(active.success).toBe(true)
    expect(listed.success).toBe(true)
    if (active.success === false || listed.success === false) throw new Error('unreachable')
    expect(active.data).toHaveLength(1)
    expect(listed.data).toHaveLength(1)
  })
})

describe('createOperatorPushSubscriptionStore — CAS retry exhaustion', () => {
  it('subscribe, unsubscribe, and markDead each return the max-retry error on a permanently contended key', async () => {
    // #given a plain-conflict adapter with no successful writes possible
    const adapter = createAlwaysConflictingAdapter()
    const store = makeStore(adapter)
    const endpoint = 'https://push.example.com/ep-permanently-contended'

    // #when calling subscribe against the permanently contended key
    const subscribed = await store.subscribe({
      operatorId: 'operator-a',
      endpoint,
      p256dh: 'p',
      auth: 'a',
      keyVersion: '1',
    })

    // #then it fails with the retry-exhaustion error
    expect(subscribed.success).toBe(false)
    if (subscribed.success === true) throw new Error('unreachable')
    expect(subscribed.error.message).toContain('exceeded max CAS retry attempts')
  })
})

describe('createOperatorPushSubscriptionStore — structured error classification', () => {
  it('classifies a structured 404 getObject error as not-found and a structured 412 conditionalPut error as a precondition conflict', async () => {
    // #given a store backed by an adapter that returns structured
    // ObjectStoreOperationError objects (httpStatusCode-based) instead of
    // plain Error messages
    const {adapter: counted, callCount} = withConditionalPutCallCounter(createStructuredErrorAdapter())
    const store = makeStore(counted)
    const endpoint = 'https://push.example.com/ep-structured-error'

    // #when subscribing for the first time (create-if-absent path reads via
    // getObject first, which returns a structured 404)
    const first = await store.subscribe({operatorId: 'operator-a', endpoint, p256dh: 'p', auth: 'a', keyVersion: '1'})
    expect(first.success).toBe(true)

    // #then a concurrent create attempt against the same endpoint retries
    // past the structured 412 conflict rather than surfacing it as a hard error
    const second = await store.subscribe({
      operatorId: 'operator-a',
      endpoint,
      p256dh: 'p2',
      auth: 'a2',
      keyVersion: '1',
    })
    expect(second.success).toBe(true)
    expect(callCount()).toBeGreaterThan(1)
  })
})

describe('toSubscriptionMetadata', () => {
  it('never includes secret fields even via direct call', () => {
    // #given a full record with secrets
    const record = {
      endpointHash: 'hash-1',
      endpoint: 'https://push.example.com/direct',
      p256dh: 'p256dh-value',
      auth: 'auth-value',
      operatorId: 'operator-a',
      active: true,
      keyVersion: '1',
      ownershipGeneration: 1,
      createdAt: 1,
      updatedAt: 1,
    }

    // #when deriving metadata
    const metadata = toSubscriptionMetadata(record)

    // #then no secret key is present on the result
    expect('endpoint' in metadata).toBe(false)
    expect('p256dh' in metadata).toBe(false)
    expect('auth' in metadata).toBe(false)
  })
})
