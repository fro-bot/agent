import type {ObjectStoreAdapter} from '@fro-bot/runtime'
import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {observePushStoreHealth} from './push-health-store.js'
import {createPushHealthTracker} from './push-health.js'
import {createOperatorPushSubscriptionStore} from './subscription-store.js'

interface Faults {
  list: boolean
  put: boolean
  get: boolean
  throwOnList: boolean
}

/** In-memory CAS adapter with switchable faults and an I/O call counter. */
function createFaultableAdapter() {
  const backing = new Map<string, {data: string; etag: string}>()
  const faults: Faults = {list: false, put: false, get: false, throwOnList: false}
  let etagCounter = 0
  const calls = {count: 0}

  const adapter: ObjectStoreAdapter = {
    upload: async () => ok(undefined),
    download: async () => ok(undefined),
    list: async prefix => {
      calls.count += 1
      if (faults.throwOnList) throw new Error('adapter exploded')
      if (faults.list) return err(new Error('list unavailable'))
      return ok(Array.from(backing.keys()).filter(k => k.startsWith(prefix)))
    },
    conditionalPut: async (key, data, options) => {
      calls.count += 1
      if (faults.put) return err(new Error('write unavailable'))
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
    conditionalDelete: async key => {
      calls.count += 1
      backing.delete(key)
      return ok(undefined)
    },
    getObject: async key => {
      calls.count += 1
      if (faults.get) return err(new Error('read unavailable'))
      const current = backing.get(key)
      if (current === undefined) return err(new Error('NotFound: no such key'))
      return ok({data: current.data, etag: current.etag})
    },
  }
  return {adapter, faults, calls}
}

function setup() {
  const fake = createFaultableAdapter()
  const time = {nowMs: 1_000_000}
  const tracker = createPushHealthTracker({clock: () => time.nowMs})
  tracker.recordStartup('passed')
  const logger = {debug: vi.fn(), warn: vi.fn()}
  const raw = createOperatorPushSubscriptionStore({adapter: fake.adapter, logger})
  const store = observePushStoreHealth(raw, tracker)
  return {...fake, tracker, time, store}
}

const SUBSCRIBE_INPUT = {
  operatorId: 'operator-a',
  endpoint: 'https://push.example.com/send/1',
  p256dh: 'p256dh',
  auth: 'auth',
  keyVersion: '1',
}

describe('observePushStoreHealth — backend classification', () => {
  it('degrades on a store write failure and recovers on a later write success', async () => {
    // #given
    const {store, tracker, faults} = setup()
    faults.put = true

    // #when a write fails
    const failed = await store.subscribe(SUBSCRIBE_INPUT)

    // #then
    expect(failed.success).toBe(false)
    expect(tracker.getStatus()).toBe('degraded')

    // #when the backend recovers
    faults.put = false
    const recovered = await store.subscribe(SUBSCRIBE_INPUT)

    // #then
    expect(recovered.success).toBe(true)
    expect(tracker.getStatus()).toBe('ready')
  })

  it('does not let a successful read clear a failed write', async () => {
    // #given a failed write
    const {store, tracker, faults} = setup()
    faults.put = true
    await store.subscribe(SUBSCRIBE_INPUT)
    expect(tracker.getStatus()).toBe('degraded')

    // #when an unrelated read succeeds
    faults.put = false
    const listed = await store.listMetadataForOperator({operatorId: 'operator-a'})

    // #then the write failure still stands
    expect(listed.success).toBe(true)
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('degrades on a read failure and on a thrown adapter error, re-throwing the original error', async () => {
    // #given
    const {store, tracker, faults} = setup()

    // #when a read returns err
    faults.list = true
    const listed = await store.listAllActiveRecords()
    // #then
    expect(listed.success).toBe(false)
    expect(tracker.getStatus()).toBe('degraded')

    // #when the read recovers
    faults.list = false
    await store.listAllActiveRecords()
    expect(tracker.getStatus()).toBe('ready')

    // #when the adapter throws
    faults.throwOnList = true
    // #then the throw is preserved for callers AND recorded
    await expect(store.listAllActiveRecords()).rejects.toThrow('adapter exploded')
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('does not degrade backend health on an ownership denial (unsubscribe)', async () => {
    // #given operator-a owns an endpoint and the tracker is healthy
    const {store, tracker} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)
    expect(tracker.getStatus()).toBe('ready')

    // #when a different operator tries to unsubscribe it
    const denied = await store.unsubscribe({operatorId: 'operator-b', endpoint: SUBSCRIBE_INPUT.endpoint})

    // #then the policy denial passes through to the caller but is not a backend fault
    expect(denied.success).toBe(false)
    expect(tracker.getStatus()).toBe('ready')
  })

  it('does not degrade backend health on an ownership denial (markDead)', async () => {
    // #given
    const {store, tracker} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)

    // #when
    const denied = await store.markDead({operatorId: 'operator-b', endpoint: SUBSCRIBE_INPUT.endpoint})

    // #then
    expect(denied.success).toBe(false)
    expect(tracker.getStatus()).toBe('ready')
  })

  it('an ownership denial does not clear an existing write failure either', async () => {
    // #given a real write failure
    const {store, tracker, faults} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)
    faults.put = true
    await store.subscribe({...SUBSCRIBE_INPUT, endpoint: 'https://push.example.com/send/2'})
    expect(tracker.getStatus()).toBe('degraded')

    // #when a denial occurs (it performs no write)
    faults.put = false
    await store.unsubscribe({operatorId: 'operator-b', endpoint: SUBSCRIBE_INPUT.endpoint})

    // #then the denial is neither a failure nor a success observation
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('records an operational unsubscribe failure as a backend failure', async () => {
    // #given
    const {store, tracker, faults} = setup()
    await store.subscribe(SUBSCRIBE_INPUT)
    faults.put = true

    // #when
    const result = await store.unsubscribe({operatorId: 'operator-a', endpoint: SUBSCRIBE_INPUT.endpoint})

    // #then
    expect(result.success).toBe(false)
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('performs no store I/O when the status is read', () => {
    // #given
    const {tracker, calls} = setup()
    const before = calls.count

    // #when
    tracker.getStatus()
    tracker.getStatus()

    // #then
    expect(calls.count).toBe(before)
  })
})
