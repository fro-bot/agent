import type {PushRelayResult} from './push-sender.js'
import type {SubscriptionRecord} from './subscription-store.js'
import {describe, expect, it, vi} from 'vitest'
import {createDedupeCache} from './dedupe-cache.js'
import {createPushDispatcher} from './dispatcher.js'
import {shouldNotify} from './trigger-policy.js'

const VAPID_CONFIG = {
  subject: 'mailto:ops@example.com',
  publicKey: 'public-key',
  privateKey: 'private-key',
  keyVersion: '1',
}

function makeRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    endpointHash: 'hash-1',
    endpoint: 'https://push.example.com/send/1',
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

function createLogger() {
  return {debug: vi.fn(), warn: vi.fn()}
}

function createFakeSender(outcomes: readonly PushRelayResult[]) {
  const queue = [...outcomes]
  const sendNotification = vi.fn(async () => {
    const next = queue.shift()
    return next ?? {outcome: 'accepted' as const, statusCode: 201}
  })
  return {sendNotification}
}

describe('createPushDispatcher', () => {
  // #given an operator with two active subscriptions
  // #when dispatchApprovalPending is called
  // #then both subscriptions receive a send
  it('sends to all active records', async () => {
    const records = [
      makeRecord({endpointHash: 'h1', endpoint: 'https://push.example.com/1'}),
      makeRecord({endpointHash: 'h2', endpoint: 'https://push.example.com/2'}),
    ]
    const getActiveRecordsForOperator = vi.fn(async () => ({success: true as const, data: records}))
    const verifyStillOwned = vi.fn(async () => ({success: true as const, data: true}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([
      {outcome: 'accepted', statusCode: 201},
      {outcome: 'accepted', statusCode: 201},
    ])

    const dispatcher = createPushDispatcher({
      store: {getActiveRecordsForOperator, verifyStillOwned, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
    })

    await dispatcher.dispatchApprovalPending('operator-a', 'approval-1')
    expect(sender.sendNotification).toHaveBeenCalledTimes(2)
  })

  // #given a second dispatch call for the same approval within the dedupe window
  // #when dispatchApprovalPending is called twice
  // #then only the first call results in a send
  it('suppresses a second dispatch within the dedupe window', async () => {
    const records = [makeRecord()]
    const getActiveRecordsForOperator = vi.fn(async () => ({success: true as const, data: records}))
    const verifyStillOwned = vi.fn(async () => ({success: true as const, data: true}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([{outcome: 'accepted', statusCode: 201}])

    const dispatcher = createPushDispatcher({
      store: {getActiveRecordsForOperator, verifyStillOwned, markDead},
      sender,
      dedupeCache: createDedupeCache({windowMs: 60_000}),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
    })

    await dispatcher.dispatchApprovalPending('operator-a', 'approval-1')
    await dispatcher.dispatchApprovalPending('operator-a', 'approval-1')
    expect(sender.sendNotification).toHaveBeenCalledTimes(1)
    expect(getActiveRecordsForOperator).toHaveBeenCalledTimes(1)
  })

  // #given a record whose ownership transferred between listing and send
  // #when dispatchRunFailed is called
  // #then the record is skipped — never delivered to the new owner's device via this call
  it('skips a record transferred to another operator between list and send', async () => {
    const records = [makeRecord()]
    const getActiveRecordsForOperator = vi.fn(async () => ({success: true as const, data: records}))
    const verifyStillOwned = vi.fn(async () => ({success: true as const, data: false}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([])

    const dispatcher = createPushDispatcher({
      store: {getActiveRecordsForOperator, verifyStillOwned, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
    })

    await dispatcher.dispatchRunFailed('operator-a', 'run-1')
    expect(verifyStillOwned).toHaveBeenCalledTimes(1)
    expect(sender.sendNotification).not.toHaveBeenCalled()
  })

  // #given the relay reports the subscription is dead (410)
  // #when dispatchRunFailed is called
  // #then the store's markDead is called for that record
  it('marks the record dead when the relay reports dead-subscription', async () => {
    const records = [makeRecord()]
    const getActiveRecordsForOperator = vi.fn(async () => ({success: true as const, data: records}))
    const verifyStillOwned = vi.fn(async () => ({success: true as const, data: true}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([{outcome: 'dead-subscription', statusCode: 410}])

    const dispatcher = createPushDispatcher({
      store: {getActiveRecordsForOperator, verifyStillOwned, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
    })

    await dispatcher.dispatchRunFailed('operator-a', 'run-1')
    expect(markDead).toHaveBeenCalledWith({operatorId: 'operator-a', endpoint: records[0]?.endpoint})
  })

  // #given the relay reports a retryable or generic error outcome
  // #when dispatchRunFailed is called
  // #then the record is left active — markDead is never called
  it('leaves the record active on retryable or error outcomes', async () => {
    for (const outcome of ['retryable', 'error', 'payload-too-large'] as const) {
      const records = [makeRecord()]
      const getActiveRecordsForOperator = vi.fn(async () => ({success: true as const, data: records}))
      const verifyStillOwned = vi.fn(async () => ({success: true as const, data: true}))
      const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
      const sender = createFakeSender([
        outcome === 'retryable'
          ? {outcome: 'retryable', statusCode: 500}
          : outcome === 'error'
            ? {outcome: 'error'}
            : {outcome: 'payload-too-large'},
      ])

      const dispatcher = createPushDispatcher({
        store: {getActiveRecordsForOperator, verifyStillOwned, markDead},
        sender,
        dedupeCache: createDedupeCache(),
        triggerPolicy: {shouldNotify},
        vapidConfig: VAPID_CONFIG,
        logger: createLogger(),
      })

      await dispatcher.dispatchRunFailed('operator-a', 'run-1')
      expect(markDead).not.toHaveBeenCalled()
    }
  })

  // #given one record fails and one succeeds
  // #when dispatchApprovalPending is called
  // #then the failing record does not stop the other from being dispatched
  it('isolates a per-subscription failure from the rest of the batch', async () => {
    const records = [
      makeRecord({endpointHash: 'h1', endpoint: 'https://push.example.com/1'}),
      makeRecord({endpointHash: 'h2', endpoint: 'https://push.example.com/2'}),
    ]
    const getActiveRecordsForOperator = vi.fn(async () => ({success: true as const, data: records}))
    let calls = 0
    const verifyStillOwned = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return {success: true as const, data: true}
    })
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([{outcome: 'accepted', statusCode: 201}])

    const dispatcher = createPushDispatcher({
      store: {getActiveRecordsForOperator, verifyStillOwned, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
    })

    await dispatcher.dispatchApprovalPending('operator-a', 'approval-1')
    expect(sender.sendNotification).toHaveBeenCalledTimes(1)
  })

  // #given a dispatch flow producing warn/debug log calls
  // #when inspected
  // #then no log call contains an endpoint, key, or payload body
  it('never logs sensitive detail', async () => {
    const records = [makeRecord({endpoint: 'https://push.example.com/super-secret-path'})]
    const getActiveRecordsForOperator = vi.fn(async () => ({success: true as const, data: records}))
    const verifyStillOwned = vi.fn(async () => ({success: true as const, data: true}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([{outcome: 'retryable', statusCode: 500}])
    const logger = createLogger()

    const dispatcher = createPushDispatcher({
      store: {getActiveRecordsForOperator, verifyStillOwned, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger,
    })

    await dispatcher.dispatchRunFailed('operator-a', 'run-1')
    const allCalls = [...logger.debug.mock.calls, ...logger.warn.mock.calls]
    for (const call of allCalls) {
      const serialized = JSON.stringify(call)
      expect(serialized).not.toContain('super-secret-path')
      expect(serialized).not.toContain('p256dh')
      expect(serialized).not.toContain('auth-value')
    }
  })
})
