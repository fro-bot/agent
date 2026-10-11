import type {PushRelayResult} from './push-sender.js'
import type {OperatorPushSubscriptionStore, SubscriptionRecord} from './subscription-store.js'
import {describe, expect, it, vi} from 'vitest'
import {createDedupeCache} from './dedupe-cache.js'
import {createPushDispatcher} from './dispatcher.js'
import {observePushStoreHealth} from './push-health-store.js'
import {createPushHealthTracker} from './push-health.js'
import {createOwnershipDeniedError, createStoreError} from './subscription-store.js'
import {shouldNotify} from './trigger-policy.js'

const VAPID_CONFIG = {
  subject: 'mailto:ops@example.com',
  publicKey: 'public-key',
  privateKey: 'private-key',
  keyVersion: '1',
}

function makeRecord(n: number, overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    endpointHash: `hash-${n}`,
    endpoint: `https://push.example.com/send/${n}`,
    p256dh: 'p256dh',
    auth: 'auth',
    operatorId: 'operator-a',
    active: true,
    keyVersion: '1',
    ownershipGeneration: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function makeSender(outcomes: readonly PushRelayResult[]) {
  const queue = [...outcomes]
  return {
    sendNotification: vi.fn(async () => queue.shift() ?? {outcome: 'accepted' as const, statusCode: 201}),
  }
}

const ACCEPTED: PushRelayResult = {outcome: 'accepted', statusCode: 201}

function setup(options: {
  readonly records: readonly SubscriptionRecord[]
  readonly outcomes?: readonly PushRelayResult[]
  readonly markDead?: OperatorPushSubscriptionStore['markDead']
  readonly list?: OperatorPushSubscriptionStore['listAllActiveRecords']
}) {
  const time = {nowMs: 1_000_000}
  const tracker = createPushHealthTracker({clock: () => time.nowMs})
  tracker.recordStartup('passed')

  const rawStore = {
    listAllActiveRecords: options.list ?? vi.fn(async () => ({success: true as const, data: options.records})),
    markDead: options.markDead ?? vi.fn(async () => ({success: true as const, data: undefined})),
  }
  // Only the two methods the dispatcher uses are observed; the cast-free path is
  // to build the observed store over a full-surface stub.
  const fullStore: OperatorPushSubscriptionStore = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    deactivateForOperator: vi.fn(),
    deleteForOperator: vi.fn(),
    listMetadataForOperator: vi.fn(),
    getActiveRecordsForOperator: vi.fn(),
    pruneInactive: vi.fn(),
    verifyStillOwned: vi.fn(),
    selfTestCas: vi.fn(),
    ...rawStore,
  }
  const sender = makeSender(options.outcomes ?? [])
  const dispatcher = createPushDispatcher({
    store: observePushStoreHealth(fullStore, tracker),
    sender,
    dedupeCache: createDedupeCache({windowMs: 60_000}),
    triggerPolicy: {shouldNotify},
    vapidConfig: VAPID_CONFIG,
    logger: {debug: vi.fn(), warn: vi.fn()},
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    pushHealth: tracker,
  })
  return {dispatcher, tracker, time, sender, rawStore}
}

describe('createPushDispatcher — push health: relay delivery', () => {
  it('degrades on a partial send (one relay failure among successes)', async () => {
    // #given two subscriptions, one of which the relay rejects
    const {dispatcher, tracker} = setup({
      records: [makeRecord(1), makeRecord(2)],
      outcomes: [ACCEPTED, {outcome: 'error'}],
    })

    // #when
    await dispatcher.dispatchRunFailed('run-1')

    // #then any relay failure degrades, even with a partial success
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('clears a relay failure after a later broadcast that is attempted and succeeds', async () => {
    // #given a failed broadcast
    const {dispatcher, tracker} = setup({
      records: [makeRecord(1)],
      outcomes: [{outcome: 'retryable', statusCode: 503}, ACCEPTED],
    })
    await dispatcher.dispatchRunFailed('run-1')
    expect(tracker.getStatus()).toBe('degraded')

    // #when a different event broadcasts successfully
    await dispatcher.dispatchRunFailed('run-2')

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })

  it('reports ready for a fully delivered broadcast', async () => {
    // #given
    const {dispatcher, tracker, time} = setup({records: [makeRecord(1)], outcomes: [ACCEPTED]})
    time.nowMs += 1000

    // #when
    await dispatcher.dispatchApprovalPending('approval-1')

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })

  it('treats a dead subscription as lifecycle, not a relay failure', async () => {
    // #given one accepted and one 410
    const {dispatcher, tracker} = setup({
      records: [makeRecord(1), makeRecord(2)],
      outcomes: [ACCEPTED, {outcome: 'dead-subscription', statusCode: 410}],
    })

    // #when
    await dispatcher.dispatchRunFailed('run-1')

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })

  it('a dead-only broadcast cannot clear an existing relay failure', async () => {
    // #given a relay failure on record
    const {dispatcher, tracker} = setup({
      records: [makeRecord(1)],
      outcomes: [{outcome: 'error'}, {outcome: 'dead-subscription', statusCode: 410}],
    })
    await dispatcher.dispatchRunFailed('run-1')
    expect(tracker.getStatus()).toBe('degraded')

    // #when the next broadcast delivers nothing (only a dead subscription)
    await dispatcher.dispatchRunFailed('run-2')

    // #then no successful delivery was established
    expect(tracker.getStatus()).toBe('degraded')
  })
})

describe('createPushDispatcher — push health: broadcasts that establish nothing', () => {
  it('an empty subscription list is not a failure and not a success', async () => {
    // #given a relay failure on record, then an empty list
    const {dispatcher, tracker} = setup({records: [makeRecord(1)], outcomes: [{outcome: 'error'}]})
    await dispatcher.dispatchRunFailed('run-1')
    expect(tracker.getStatus()).toBe('degraded')

    // (a second dispatcher over an empty store, sharing the same tracker)
    const empty = createPushDispatcher({
      store: {
        listAllActiveRecords: async () => ({success: true as const, data: []}),
        markDead: async () => ({success: true as const, data: undefined}),
      },
      sender: makeSender([]),
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: {debug: vi.fn(), warn: vi.fn()},
      auditLogger: {info: vi.fn(), warn: vi.fn()},
      pushHealth: tracker,
    })

    // #when
    await empty.dispatchRunFailed('run-2')

    // #then the empty broadcast neither clears nor adds a failure
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('an empty list does not degrade a healthy tracker', async () => {
    // #given
    const {dispatcher, tracker} = setup({records: []})

    // #when
    await dispatcher.dispatchRunFailed('run-1')

    // #then zero subscriptions is not a failure
    expect(tracker.getStatus()).toBe('ready')
  })

  it('a deduped broadcast cannot clear a relay failure', async () => {
    // #given: run-1 fails, then the same event is deduped
    const {dispatcher, tracker, sender} = setup({
      records: [makeRecord(1)],
      outcomes: [{outcome: 'error'}],
    })
    await dispatcher.dispatchRunFailed('run-1')
    expect(tracker.getStatus()).toBe('degraded')

    // #when the identical event is dispatched again within the dedupe window
    await dispatcher.dispatchRunFailed('run-1')

    // #then nothing was sent and the failure stands
    expect(sender.sendNotification).toHaveBeenCalledTimes(1)
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('an all-stale-key batch cannot clear a relay failure', async () => {
    // #given a failure, then a batch whose every record is skipped as stale-key
    const failing = setup({records: [makeRecord(1)], outcomes: [{outcome: 'error'}]})
    await failing.dispatcher.dispatchRunFailed('run-1')
    expect(failing.tracker.getStatus()).toBe('degraded')

    const stale = createPushDispatcher({
      store: {
        listAllActiveRecords: async () => ({success: true as const, data: [makeRecord(2, {keyVersion: '9'})]}),
        markDead: async () => ({success: true as const, data: undefined}),
      },
      sender: makeSender([]),
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: {debug: vi.fn(), warn: vi.fn()},
      auditLogger: {info: vi.fn(), warn: vi.fn()},
      pushHealth: failing.tracker,
    })

    // #when
    await stale.dispatchRunFailed('run-2')

    // #then
    expect(failing.tracker.getStatus()).toBe('degraded')
  })
})

describe('createPushDispatcher — push health: store interactions', () => {
  it('records a failed dead-subscription cleanup (markDead err) as a backend failure', async () => {
    // #given a 410 whose markDead cleanup fails operationally
    const {dispatcher, tracker} = setup({
      records: [makeRecord(1)],
      outcomes: [{outcome: 'dead-subscription', statusCode: 410}],
      markDead: vi.fn(async () => ({success: false as const, error: createStoreError('write unavailable')})),
    })
    expect(tracker.getStatus()).toBe('ready')

    // #when
    await dispatcher.dispatchRunFailed('run-1')

    // #then the cleanup failure is a backend failure even though the relay was fine
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('does not degrade on an ownership-denied markDead', async () => {
    // #given
    const {dispatcher, tracker} = setup({
      records: [makeRecord(1)],
      outcomes: [{outcome: 'dead-subscription', statusCode: 410}],
      markDead: vi.fn(async () => ({
        success: false as const,
        error: createOwnershipDeniedError('markDead: endpoint is not owned by this operator'),
      })),
    })

    // #when
    await dispatcher.dispatchRunFailed('run-1')

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })

  it('records a failed subscription listing as a backend read failure', async () => {
    // #given
    const {dispatcher, tracker} = setup({
      records: [],
      list: vi.fn(async () => ({success: false as const, error: createStoreError('list unavailable')})),
    })

    // #when
    await dispatcher.dispatchApprovalPending('approval-1')

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('a successful relay broadcast does not clear a backend write failure from dead cleanup', async () => {
    // #given a failed markDead cleanup
    const {dispatcher, tracker} = setup({
      records: [makeRecord(1)],
      outcomes: [{outcome: 'dead-subscription', statusCode: 410}, ACCEPTED],
      markDead: vi.fn(async () => ({success: false as const, error: createStoreError('write unavailable')})),
    })
    await dispatcher.dispatchRunFailed('run-1')
    expect(tracker.getStatus()).toBe('degraded')

    // #when a later broadcast delivers (the listing is a successful READ)
    await dispatcher.dispatchRunFailed('run-2')

    // #then read + relay success do not clear the write failure
    expect(tracker.getStatus()).toBe('degraded')
  })
})
