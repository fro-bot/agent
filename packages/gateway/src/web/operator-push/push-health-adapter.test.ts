import type {ObjectStoreAdapter} from '@fro-bot/runtime'
import type {PushHealthBackendKind, PushHealthOutcome} from './push-health.js'
import {createObjectStoreOperationError, err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createDedupeCache} from './dedupe-cache.js'
import {createPushDispatcher} from './dispatcher.js'
import {observePushAdapterHealth} from './push-health-adapter.js'
import {createPushHealthTracker} from './push-health.js'
import {createOperatorPushSubscriptionStore} from './subscription-store.js'
import {shouldNotify} from './trigger-policy.js'

type Fault = number | {readonly status: number; readonly code: string} | 'throw' | 'unstructured' | undefined

interface Faults {
  list: Fault
  get: Fault
  put: Fault
  del: Fault
}

function faultResult(fault: Exclude<Fault, undefined>, label: string) {
  if (fault === 'throw') throw new Error(`${label} exploded`)
  if (fault === 'unstructured') return err(new Error(`${label}: getaddrinfo ENOTFOUND bucket.example.com`))
  if (typeof fault === 'object') {
    return err(
      createObjectStoreOperationError(`${label} failed`, {httpStatusCode: fault.status, errorCode: fault.code}),
    )
  }
  return err(createObjectStoreOperationError(`${label} failed`, {httpStatusCode: fault}))
}

/** In-memory CAS adapter with switchable faults and an adapter-call counter. */
function createFaultableAdapter() {
  const backing = new Map<string, {data: string; etag: string}>()
  const faults: Faults = {list: undefined, get: undefined, put: undefined, del: undefined}
  let etagCounter = 0
  const calls = {count: 0}
  const hold: {key?: string; release?: () => void; reached?: () => void} = {}

  const adapter: ObjectStoreAdapter = {
    upload: async () => ok(undefined),
    download: async () => ok(undefined),
    list: async prefix => {
      calls.count += 1
      if (faults.list !== undefined) return faultResult(faults.list, 'list')
      return ok(Array.from(backing.keys()).filter(k => k.startsWith(prefix)))
    },
    conditionalPut: async (key, data, options) => {
      calls.count += 1
      if (faults.put !== undefined) return faultResult(faults.put, 'put')
      const current = backing.get(key)
      if (options.ifNoneMatch === '*' && current !== undefined) {
        return err(createObjectStoreOperationError('exists', {httpStatusCode: 412}))
      }
      if (options.ifMatch !== undefined && (current === undefined || current.etag !== options.ifMatch)) {
        return err(createObjectStoreOperationError('etag mismatch', {httpStatusCode: 412}))
      }
      etagCounter += 1
      const etag = `etag-${etagCounter}`
      backing.set(key, {data, etag})
      return ok({etag})
    },
    conditionalDelete: async key => {
      calls.count += 1
      if (faults.del !== undefined) return faultResult(faults.del, 'delete')
      backing.delete(key)
      return ok(undefined)
    },
    getObject: async key => {
      calls.count += 1
      if (hold.key === key) {
        hold.reached?.()
        await new Promise<void>(resolve => {
          hold.release = resolve
        })
      }
      if (faults.get !== undefined) return faultResult(faults.get, 'get')
      const current = backing.get(key)
      if (current === undefined) return err(createObjectStoreOperationError('no such key', {httpStatusCode: 404}))
      return ok({data: current.data, etag: current.etag})
    },
  }
  return {adapter, faults, calls, backing, hold}
}

function setup() {
  const fake = createFaultableAdapter()
  const time = {nowMs: 1_000_000}
  const tracker = createPushHealthTracker({clock: () => time.nowMs})
  tracker.recordStartup('ok', tracker.nextSequence())
  const observed = observePushAdapterHealth(fake.adapter, tracker)
  const store = createOperatorPushSubscriptionStore({
    adapter: observed,
    logger: {debug: vi.fn(), warn: vi.fn()},
    captureCasExhaustion: tracker.captureWriteFailure,
  })
  return {...fake, tracker, time, observed, store}
}

const SUBSCRIBE_INPUT = {
  operatorId: 'operator-a',
  endpoint: 'https://push.example.com/send/1',
  p256dh: 'p256dh',
  auth: 'auth',
  keyVersion: '1',
}

describe('observePushAdapterHealth — outcome mapping', () => {
  it('records a completed call as ok', async () => {
    // #given a write failure on record
    const {store, tracker, faults} = setup()
    faults.put = 500
    await store.subscribe(SUBSCRIBE_INPUT)
    expect(tracker.getStatus()).toBe('degraded')

    // #when a write completes
    faults.put = undefined
    const result = await store.subscribe(SUBSCRIBE_INPUT)

    // #then
    expect(result.success).toBe(true)
    expect(tracker.getStatus()).toBe('ready')
  })

  it.each([404, 412])('counts HTTP %i as a working backend', async status => {
    // #given
    const {observed, tracker, faults} = setup()
    faults.get = status
    faults.put = status

    // #when
    await observed.getObject?.('k')
    await observed.conditionalPut?.('k', 'v', {ifMatch: 'e'})

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })

  it('classifies by structured code before status: NoSuchKey, NotFound, PreconditionFailed and ConditionalRequestConflict are answers', async () => {
    // #given each answer code, with a status that would otherwise be a failure
    const codes = ['NoSuchKey', 'NotFound', 'PreconditionFailed', 'ConditionalRequestConflict']
    for (const code of codes) {
      const {observed, tracker, faults} = setup()
      faults.get = {status: 500, code}

      // #when
      await observed.getObject?.('k')

      // #then
      expect({code, status: tracker.getStatus()}).toEqual({code, status: 'ready'})
    }
  })

  it('counts HTTP 409 ConditionalRequestConflict on a conditional write as a working backend', async () => {
    // #given
    const {observed, tracker, faults} = setup()
    faults.put = {status: 409, code: 'ConditionalRequestConflict'}

    // #when
    await observed.conditionalPut?.('k', 'v', {ifNoneMatch: '*'})

    // #then contention is not a backend fault (a single one; sustained exhaustion is reported by the store)
    expect(tracker.getStatus()).toBe('ready')
  })

  it('counts a bare HTTP 409 (no code) as a working backend', async () => {
    // #given
    const {observed, tracker, faults} = setup()
    faults.put = 409

    // #when
    await observed.conditionalPut?.('k', 'v', {ifNoneMatch: '*'})

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })

  it('counts a 404 NoSuchBucket on list as a backend failure', async () => {
    // #given
    const {observed, tracker, faults} = setup()
    faults.list = {status: 404, code: 'NoSuchBucket'}

    // #when
    await observed.list('p/')

    // #then a missing bucket is a fault even though its status is 404
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('counts a 404 NoSuchBucket on conditionalPut as a backend failure', async () => {
    // #given
    const {observed, tracker, faults} = setup()
    faults.put = {status: 404, code: 'NoSuchBucket'}

    // #when
    await observed.conditionalPut?.('k', 'v', {ifMatch: 'e'})

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('counts an unrecognized code as a failure even with an answer-like status', async () => {
    // #given
    const {observed, tracker, faults} = setup()
    faults.get = {status: 412, code: 'InternalError'}

    // #when
    await observed.getObject?.('k')

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })

  it.each([403, 429, 500, 503, 'unstructured'] as const)('counts %s as a backend failure', async fault => {
    // #given
    const {observed, tracker, faults} = setup()
    faults.get = fault

    // #when
    await observed.getObject?.('k')

    // #then — an unstructured transport error (e.g. DNS "ENOTFOUND") is never mistaken for a 404
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('counts a thrown adapter error as a failure and re-throws it unchanged', async () => {
    // #given
    const {observed, tracker, faults} = setup()
    faults.list = 'throw'

    // #when / #then
    await expect(observed.list('p/')).rejects.toThrow('list exploded')
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('counts a throwing conditionalPut as a write failure and re-throws it unchanged', async () => {
    // #given
    const {observed, tracker, faults} = setup()
    faults.put = 'throw'

    // #when / #then
    await expect(observed.conditionalPut?.('k', 'v', {ifNoneMatch: '*'})).rejects.toThrow('put exploded')
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('classifies list and getObject as reads and conditionalPut and conditionalDelete as writes', async () => {
    // #given a spy tracker
    const fake = createFaultableAdapter()
    const recordBackend = vi.fn<(kind: PushHealthBackendKind, outcome: PushHealthOutcome, start: number) => void>()
    const observed = observePushAdapterHealth(fake.adapter, {nextSequence: () => 1, recordBackend})

    // #when
    await observed.list('p/')
    await observed.getObject?.('k')
    await observed.conditionalPut?.('k', 'v', {ifNoneMatch: '*'})
    await observed.conditionalDelete?.('k', {ifMatch: 'e'})

    // #then
    expect(recordBackend.mock.calls.map(([kind]) => kind)).toEqual(['read', 'read', 'write', 'write'])
  })

  it('leaves methods the adapter does not define undefined', () => {
    // #given an adapter without CAS support
    const bare: ObjectStoreAdapter = {
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => ok([]),
    }
    const observed = observePushAdapterHealth(bare, {nextSequence: () => 1, recordBackend: vi.fn()})

    // #then
    expect(observed.conditionalPut).toBeUndefined()
    expect(observed.conditionalDelete).toBeUndefined()
    expect(observed.getObject).toBeUndefined()
  })
})

describe('observePushAdapterHealth — store-level behavior at the I/O boundary', () => {
  it('does not let a successful read clear a failed write', async () => {
    // #given a failed write
    const {store, tracker, faults} = setup()
    faults.put = 500
    await store.subscribe(SUBSCRIBE_INPUT)
    expect(tracker.getStatus()).toBe('degraded')

    // #when an unrelated read succeeds
    faults.put = undefined
    const listed = await store.listMetadataForOperator({operatorId: 'operator-a'})

    // #then the write failure stands
    expect(listed.success).toBe(true)
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('leaves a prior write failure in place after a revoke that writes nothing', async () => {
    // #given a write failure, and an operator with no subscriptions
    const {store, tracker, faults} = setup()
    faults.put = 500
    await store.subscribe(SUBSCRIBE_INPUT)
    faults.put = undefined
    expect(tracker.getStatus()).toBe('degraded')

    // #when that other operator logs out (a successful no-op: one list, no writes)
    const revoke = await store.deactivateForOperator({operatorId: 'operator-without-subscriptions'})

    // #then the no-op success is not evidence the write path works
    expect(revoke).toEqual({success: true, data: {updated: 0, skipped: 0}})
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('records a read error inside subscribe as a read failure that a later read success clears', async () => {
    // #given a read outage while subscribing
    const {store, tracker, faults} = setup()
    faults.get = 500
    const failed = await store.subscribe(SUBSCRIBE_INPUT)
    expect(failed.success).toBe(false)
    expect(tracker.getStatus()).toBe('degraded')

    // #when the read path recovers and a read completes
    faults.get = undefined
    await store.listAllActiveRecords()

    // #then it was a READ failure, so a read success clears it (no write ever succeeded or failed)
    expect(tracker.getStatus()).toBe('ready')
  })

  it('keeps a write failure when only the read inside a write method recovers', async () => {
    // #given a subscribe whose read fails
    const {store, tracker, faults} = setup()
    faults.get = 500
    await store.subscribe(SUBSCRIBE_INPUT)
    expect(tracker.getStatus()).toBe('degraded')

    // #when the next subscribe's read succeeds but its write fails
    faults.get = undefined
    faults.put = 500
    const second = await store.subscribe(SUBSCRIBE_INPUT)

    // #then the read recovered inside a write method, the write failure stands
    expect(second.success).toBe(false)
    expect(tracker.getStatus()).toBe('degraded')

    // #and a write success is what finally clears it
    faults.put = undefined
    await store.subscribe(SUBSCRIBE_INPUT)
    expect(tracker.getStatus()).toBe('ready')
  })

  it('observes every real adapter call of a CAS-exhausted revoke', async () => {
    // #given a spy tracker and a store without the exhaustion callback
    const fake = createFaultableAdapter()
    const recordBackend = vi.fn<(kind: PushHealthBackendKind, outcome: PushHealthOutcome, start: number) => void>()
    let sequence = 0
    const observed = observePushAdapterHealth(fake.adapter, {nextSequence: () => (sequence += 1), recordBackend})
    const store = createOperatorPushSubscriptionStore({adapter: observed, logger: {debug: vi.fn(), warn: vi.fn()}})
    await store.subscribe(SUBSCRIBE_INPUT)
    fake.faults.put = 412
    const callsBefore = fake.calls.count
    recordBackend.mockClear()

    // #when the revoke exhausts its retries
    const revoke = await store.deactivateForOperator({operatorId: 'operator-a'})

    // #then every real adapter call produced exactly one observation
    expect(revoke.success && revoke.data.skipped).toBe(1)
    expect(recordBackend).toHaveBeenCalledTimes(fake.calls.count - callsBefore)
    expect(fake.calls.count - callsBefore).toBeGreaterThan(5)
  })

  it('degrades when a revoke exhausts its CAS retries after a healthy state', async () => {
    // #given a healthy tracker and an active record whose every conditional write loses the race (412)
    const {store, tracker, faults} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)
    faults.put = 412
    expect(tracker.getStatus()).toBe('ready')

    // #when
    const revoke = await store.deactivateForOperator({operatorId: 'operator-a'})

    // #then a single 412 is a working backend, but sustained contention (skipped > 0) is a write failure
    expect(revoke.success && revoke.data.skipped).toBe(1)
    expect(tracker.getStatus()).toBe('degraded')
  })

  it("orders a sweep's exhaustion report by when the skipped record finished, not the sweep's completion", async () => {
    // #given two active records; the sweep skips A (CAS contention), then pauses on B
    const {store, tracker, faults, backing, hold} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)
    await store.subscribe({...SUBSCRIBE_INPUT, endpoint: 'https://push.example.com/send/2'})
    const [, keyB] = Array.from(backing.keys())
    faults.put = 412
    const reachedB = new Promise<void>(resolve => {
      hold.reached = resolve
    })
    hold.key = keyB
    const sweep = store.deactivateForOperator({operatorId: 'operator-a'})
    await reachedB

    // #when a newer subscribe rewrites A successfully while the sweep is paused, then the sweep completes
    faults.put = undefined
    const rewrite = await store.subscribe(SUBSCRIBE_INPUT)
    hold.key = undefined
    hold.release?.()
    const result = await sweep

    // #then the sweep did skip A, but its report is bound to A's end, older than the newer successful write
    expect(rewrite.success).toBe(true)
    expect(result.success && result.data.skipped).toBe(1)
    expect(tracker.getStatus()).toBe('ready')
  })

  it('degrades when subscribe exhausts its CAS retries', async () => {
    // #given
    const {store, tracker, faults} = setup()
    faults.put = 412

    // #when
    const result = await store.subscribe(SUBSCRIBE_INPUT)

    // #then
    expect(result.success).toBe(false)
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('degrades when unsubscribe or markDead exhaust their CAS retries', async () => {
    // #given an active record
    const {store, tracker, faults} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)
    faults.put = 412

    // #when unsubscribe exhausts
    await store.unsubscribe({operatorId: 'operator-a', endpoint: SUBSCRIBE_INPUT.endpoint})
    // #then
    expect(tracker.getStatus()).toBe('degraded')

    // #when the backend writes again, then markDead exhausts
    faults.put = undefined
    await store.subscribe(SUBSCRIBE_INPUT)
    expect(tracker.getStatus()).toBe('ready')
    faults.put = 412
    await store.markDead({operatorId: 'operator-a', endpoint: SUBSCRIBE_INPUT.endpoint})

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('degrades when a privacy delete loses its physical-delete CAS race', async () => {
    // #given an active record whose physical delete loses the race
    const {store, tracker, faults} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)
    faults.del = 412

    // #when
    const result = await store.deleteForOperator({operatorId: 'operator-a'})

    // #then
    expect(result.success && result.data.skipped).toBe(1)
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('records a hard write failure during a revoke', async () => {
    // #given an active record and a failing backend write
    const {store, tracker, faults} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)
    faults.put = 503

    // #when
    const revoke = await store.deactivateForOperator({operatorId: 'operator-a'})

    // #then
    expect(revoke.success).toBe(false)
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('records no backend failure for an ownership denial', async () => {
    // #given operator-a owns an endpoint
    const {store, tracker} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)
    expect(tracker.getStatus()).toBe('ready')

    // #when another operator tries to unsubscribe or mark it dead (denied before any write)
    const denied = await store.unsubscribe({operatorId: 'operator-b', endpoint: SUBSCRIBE_INPUT.endpoint})
    const deniedDead = await store.markDead({operatorId: 'operator-b', endpoint: SUBSCRIBE_INPUT.endpoint})

    // #then the denials pass through but the backend is healthy
    expect(denied.success).toBe(false)
    expect(deniedDead.success).toBe(false)
    expect(tracker.getStatus()).toBe('ready')
  })

  it('does not let an older call that finishes after a newer failure clear it', async () => {
    // #given two reads in flight: the older one is held open
    const tracker = createPushHealthTracker({clock: () => 0})
    tracker.recordStartup('ok', tracker.nextSequence())
    let releaseOlder: (() => void) | undefined
    let call = 0
    const adapter: ObjectStoreAdapter = {
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => {
        call += 1
        if (call === 1) {
          await new Promise<void>(resolve => {
            releaseOlder = resolve
          })
          return ok([])
        }
        return err(createObjectStoreOperationError('boom', {httpStatusCode: 500}))
      },
    }
    const observed = observePushAdapterHealth(adapter, tracker)

    // #when the newer call fails first, then the older call completes successfully
    const older = observed.list('p/')
    await observed.list('p/')
    expect(tracker.getStatus()).toBe('degraded')
    releaseOlder?.()
    await older

    // #then the late success of the older call must not clear the newer failure
    expect(tracker.getStatus()).toBe('degraded')
  })
})

describe('observePushAdapterHealth — startup self-test', () => {
  it('is degraded when the real self-test passes but its cleanup delete is denied (403)', async () => {
    // #given the real self-test over the observed adapter, with the cleanup delete denied
    const fake = createFaultableAdapter()
    const tracker = createPushHealthTracker({clock: () => 1_000_000})
    const observed = observePushAdapterHealth(fake.adapter, tracker)
    const store = createOperatorPushSubscriptionStore({adapter: observed, logger: {debug: vi.fn(), warn: vi.fn()}})
    fake.faults.del = 403

    // #when the startup ticket is taken before the self-test, as program.ts does
    const startupTicket = tracker.nextSequence()
    const result = await store.selfTestCas()
    tracker.recordStartup('ok', startupTicket)

    // #then the self-test passes (cleanup is best-effort) but its own denied delete supersedes the seed
    expect(result.success).toBe(true)
    expect(tracker.getStatus()).toBe('degraded')
  })
})

describe('observePushAdapterHealth — dispatcher integration', () => {
  it('does not record a relay failure when the markDead cleanup throws, so a later dead-only broadcast recovers', async () => {
    // #given an active subscription whose relay answers 410, and a backend whose cleanup write throws
    const {store, tracker, faults} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)
    const dispatcher = createPushDispatcher({
      store,
      sender: {sendNotification: vi.fn(async () => ({outcome: 'dead-subscription' as const, statusCode: 410}))},
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: {subject: 'mailto:ops@example.com', publicKey: 'pub', privateKey: 'priv', keyVersion: '1'},
      logger: {debug: vi.fn(), warn: vi.fn()},
      auditLogger: {info: vi.fn(), warn: vi.fn()},
      pushHealth: tracker,
    })
    faults.put = 'throw'

    // #when the cleanup throws
    await dispatcher.dispatchRunFailed('run-1')

    // #then the backend write failure degrades
    expect(tracker.getStatus()).toBe('degraded')

    // #when the backend recovers and another dead-only broadcast cleans up successfully
    faults.put = undefined
    await dispatcher.dispatchRunFailed('run-2')

    // #then no relay failure was ever recorded, so the write success clears it
    expect(tracker.getStatus()).toBe('ready')
  })

  it('records a failed dead-subscription cleanup (markDead write) as a backend write failure', async () => {
    // #given an active subscription whose relay answers 410, and a backend that rejects the cleanup write
    const {store, tracker, faults} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)
    expect(tracker.getStatus()).toBe('ready')
    const dispatcher = createPushDispatcher({
      store,
      sender: {sendNotification: vi.fn(async () => ({outcome: 'dead-subscription' as const, statusCode: 410}))},
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: {subject: 'mailto:ops@example.com', publicKey: 'pub', privateKey: 'priv', keyVersion: '1'},
      logger: {debug: vi.fn(), warn: vi.fn()},
      auditLogger: {info: vi.fn(), warn: vi.fn()},
      pushHealth: tracker,
    })
    faults.put = 503

    // #when
    await dispatcher.dispatchRunFailed('run-1')

    // #then the relay was fine; the backend write failure alone degrades
    expect(tracker.getStatus()).toBe('degraded')
  })
})
