import type {PushRelayResult} from './push-sender.js'
import type {SubscriptionRecord} from './subscription-store.js'
import {describe, expect, it, vi} from 'vitest'
import {createDedupeCache} from './dedupe-cache.js'
import {createPushDispatcher} from './dispatcher.js'
import {createStoreError} from './subscription-store.js'
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

function createAuditLogger() {
  return {info: vi.fn(), warn: vi.fn()}
}

function createFakeSender(outcomes: readonly PushRelayResult[]) {
  const queue = [...outcomes]
  const sendNotification = vi.fn(async () => {
    const next = queue.shift()
    return next ?? {outcome: 'accepted' as const, statusCode: 201}
  })
  return {sendNotification}
}

describe('createPushDispatcher — broadcast', () => {
  // #given active subscriptions owned by two different operators
  // #when dispatchApprovalPending is called
  // #then every active subscription across every operator receives a send
  it('nudges all active records across multiple operators', async () => {
    const records = [
      makeRecord({endpointHash: 'h1', endpoint: 'https://push.example.com/1', operatorId: 'operator-a'}),
      makeRecord({endpointHash: 'h2', endpoint: 'https://push.example.com/2', operatorId: 'operator-b'}),
    ]
    const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: records}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([
      {outcome: 'accepted', statusCode: 201},
      {outcome: 'accepted', statusCode: 201},
    ])

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
      auditLogger: createAuditLogger(),
    })

    await dispatcher.dispatchApprovalPending('approval-1')
    expect(sender.sendNotification).toHaveBeenCalledTimes(2)
  })

  // #given a second dispatch call for the same event within the dedupe window
  // #when dispatchApprovalPending is called twice
  // #then only the first call results in a send
  it('suppresses a second dispatch within the dedupe window', async () => {
    const records = [makeRecord()]
    const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: records}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([{outcome: 'accepted', statusCode: 201}])

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache({windowMs: 60_000}),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
      auditLogger: createAuditLogger(),
    })

    await dispatcher.dispatchApprovalPending('approval-1')
    await dispatcher.dispatchApprovalPending('approval-1')
    expect(sender.sendNotification).toHaveBeenCalledTimes(1)
    // listAllActiveRecords now runs before the dedupe check on every call (so a failed list
    // never consumes the dedupe slot) — the second call still lists, but shouldSend suppresses
    // the send.
    expect(listAllActiveRecords).toHaveBeenCalledTimes(2)
  })

  // #given the relay reports the subscription is dead (410)
  // #when dispatchRunFailed is called
  // #then the store's markDead is called with that record's own operatorId+endpoint
  it('marks the record dead when the relay reports dead-subscription', async () => {
    const records = [makeRecord()]
    const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: records}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([{outcome: 'dead-subscription', statusCode: 410}])

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
      auditLogger: createAuditLogger(),
    })

    await dispatcher.dispatchRunFailed('run-1')
    expect(markDead).toHaveBeenCalledWith({operatorId: 'operator-a', endpoint: records[0]?.endpoint})
  })

  // #given the relay reports a retryable or generic error outcome
  // #when dispatchRunFailed is called
  // #then the record is left active — markDead is never called
  it('leaves the record active on retryable or error outcomes', async () => {
    for (const outcome of ['retryable', 'error', 'payload-too-large'] as const) {
      const records = [makeRecord()]
      const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: records}))
      const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
      const sender = createFakeSender([
        outcome === 'retryable'
          ? {outcome: 'retryable', statusCode: 500}
          : outcome === 'error'
            ? {outcome: 'error'}
            : {outcome: 'payload-too-large'},
      ])

      const dispatcher = createPushDispatcher({
        store: {listAllActiveRecords, markDead},
        sender,
        dedupeCache: createDedupeCache(),
        triggerPolicy: {shouldNotify},
        vapidConfig: VAPID_CONFIG,
        logger: createLogger(),
        auditLogger: createAuditLogger(),
      })

      await dispatcher.dispatchRunFailed('run-1')
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
    const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: records}))
    let calls = 0
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = {
      sendNotification: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return {outcome: 'accepted' as const, statusCode: 201}
      }),
    }

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
      auditLogger: createAuditLogger(),
    })

    await dispatcher.dispatchApprovalPending('approval-1')
    expect(sender.sendNotification).toHaveBeenCalledTimes(2)
  })

  // #given the store fails to list active subscriptions
  // #when dispatchApprovalPending is called
  // #then it warns and returns without attempting any send
  it('warns and returns when listAllActiveRecords fails', async () => {
    const listAllActiveRecords = vi.fn(async () => ({
      success: false as const,
      error: createStoreError('db down'),
    }))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([])
    const logger = createLogger()

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger,
      auditLogger: createAuditLogger(),
    })

    await dispatcher.dispatchApprovalPending('approval-1')
    expect(sender.sendNotification).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  // #given the first call's listAllActiveRecords fails
  // #when dispatchApprovalPending is called again for the same event and the
  //   list now succeeds
  // #then the second call still sends — the failed first call never consumed
  //   the dedupe slot
  it('does not consume the dedupe slot when listAllActiveRecords fails', async () => {
    const records = [makeRecord()]
    const listAllActiveRecords = vi
      .fn()
      .mockResolvedValueOnce({success: false as const, error: createStoreError('db down')})
      .mockResolvedValueOnce({success: true as const, data: records})
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([{outcome: 'accepted', statusCode: 201}])
    const logger = createLogger()

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache({windowMs: 60_000}),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger,
      auditLogger: createAuditLogger(),
    })

    await dispatcher.dispatchApprovalPending('approval-1')
    expect(sender.sendNotification).not.toHaveBeenCalled()

    await dispatcher.dispatchApprovalPending('approval-1')
    expect(sender.sendNotification).toHaveBeenCalledTimes(1)
    expect(listAllActiveRecords).toHaveBeenCalledTimes(2)
  })

  // #given a record whose keyVersion predates the current VAPID rotation
  // #when dispatchApprovalPending is called
  // #then the stale-key record is skipped — no send attempted
  it('skips a record with a stale key version', async () => {
    const records = [makeRecord({keyVersion: 'old-version'})]
    const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: records}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([])

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
      auditLogger: createAuditLogger(),
    })

    await dispatcher.dispatchApprovalPending('approval-1')
    expect(sender.sendNotification).not.toHaveBeenCalled()
  })

  // #given markDead fails (store error) after a dead-subscription outcome
  // #when dispatchRunFailed is called
  // #then a warn is logged and the dispatcher does not throw
  it('warns without throwing when markDead fails', async () => {
    const records = [makeRecord()]
    const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: records}))
    const markDead = vi.fn(async () => ({success: false as const, error: createStoreError('write failed')}))
    const sender = createFakeSender([{outcome: 'dead-subscription', statusCode: 410}])
    const logger = createLogger()

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger,
      auditLogger: createAuditLogger(),
    })

    await expect(dispatcher.dispatchRunFailed('run-1')).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })

  // #given a store method throws synchronously inside broadcast
  // #when dispatchApprovalPending / dispatchRunFailed are called
  // #then neither promise rejects — the outer catch swallows and logs
  it('never rejects even when a store call throws', async () => {
    const listAllActiveRecords = vi.fn(async () => {
      throw new Error('unexpected throw')
    })
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([])
    const logger = createLogger()

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger,
      auditLogger: createAuditLogger(),
    })

    await expect(dispatcher.dispatchApprovalPending('approval-1')).resolves.toBeUndefined()
    await expect(dispatcher.dispatchRunFailed('run-1')).resolves.toBeUndefined()
  })

  // #given a dispatch flow producing warn/debug log calls
  // #when inspected
  // #then no log call contains an endpoint, key, or payload body
  it('never logs sensitive detail', async () => {
    const records = [makeRecord({endpoint: 'https://push.example.com/super-secret-path'})]
    const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: records}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([{outcome: 'retryable', statusCode: 500}])
    const logger = createLogger()

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger,
      auditLogger: createAuditLogger(),
    })

    await dispatcher.dispatchRunFailed('run-1')
    const allCalls = [...logger.debug.mock.calls, ...logger.warn.mock.calls]
    for (const call of allCalls) {
      const serialized = JSON.stringify(call)
      expect(serialized).not.toContain('super-secret-path')
      expect(serialized).not.toContain('p256dh')
      expect(serialized).not.toContain('auth-value')
    }
  })
})

// ---------------------------------------------------------------------------
// push.dispatch audit event
// ---------------------------------------------------------------------------

describe('createPushDispatcher — push.dispatch audit event', () => {
  // #given two delivered records and one dead record
  // #when dispatchApprovalPending completes the broadcast
  // #then exactly one push.dispatch audit event fires with the aggregated counts
  it('emits one push.dispatch event per broadcast with correct counts', async () => {
    const records = [
      makeRecord({endpointHash: 'h1', endpoint: 'https://push.example.com/1'}),
      makeRecord({endpointHash: 'h2', endpoint: 'https://push.example.com/2'}),
      makeRecord({endpointHash: 'h3', endpoint: 'https://push.example.com/3'}),
    ]
    const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: records}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([
      {outcome: 'accepted', statusCode: 201},
      {outcome: 'accepted', statusCode: 201},
      {outcome: 'dead-subscription', statusCode: 410},
    ])
    const auditLogger = createAuditLogger()

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
      auditLogger,
    })

    await dispatcher.dispatchApprovalPending('approval-1')

    expect(auditLogger.info).toHaveBeenCalledOnce()
    const [ctx] = auditLogger.info.mock.calls[0] as [Record<string, unknown>, string]
    expect(ctx).toMatchObject({
      kind: 'push.dispatch',
      correlationId: 'approval-1',
      trigger: 'approval',
      delivered: 2,
      dead: 1,
      failed: 0,
    })
  })

  // #given a dedupe-suppressed second call for the same event
  // #when dispatchApprovalPending is called twice within the dedupe window
  // #then the audit event fires only once (for the first, actually-dispatched call)
  it('does not emit a dispatch audit event on a dedupe-suppressed call', async () => {
    const records = [makeRecord()]
    const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: records}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([{outcome: 'accepted', statusCode: 201}])
    const auditLogger = createAuditLogger()

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache({windowMs: 60_000}),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
      auditLogger,
    })

    await dispatcher.dispatchApprovalPending('approval-1')
    await dispatcher.dispatchApprovalPending('approval-1')

    expect(auditLogger.info).toHaveBeenCalledOnce()
  })

  // #given no active subscriptions
  // #when dispatchApprovalPending is called
  // #then no dispatch audit event fires — nothing was dispatched
  it('does not emit a dispatch audit event when the active-subscription list is empty', async () => {
    const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: []}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([])
    const auditLogger = createAuditLogger()

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
      auditLogger,
    })

    await dispatcher.dispatchApprovalPending('approval-1')

    expect(auditLogger.info).not.toHaveBeenCalled()
    expect(auditLogger.warn).not.toHaveBeenCalled()
  })

  // #given the emitted push.dispatch audit event
  // #when serialized
  // #then it never contains an endpoint, key, or payload value
  it('emitted dispatch audit event never carries endpoint or key material', async () => {
    const records = [makeRecord({endpoint: 'https://push.example.com/super-secret-path', p256dh: 'p256dh-secret'})]
    const listAllActiveRecords = vi.fn(async () => ({success: true as const, data: records}))
    const markDead = vi.fn(async () => ({success: true as const, data: undefined}))
    const sender = createFakeSender([{outcome: 'accepted', statusCode: 201}])
    const auditLogger = createAuditLogger()

    const dispatcher = createPushDispatcher({
      store: {listAllActiveRecords, markDead},
      sender,
      dedupeCache: createDedupeCache(),
      triggerPolicy: {shouldNotify},
      vapidConfig: VAPID_CONFIG,
      logger: createLogger(),
      auditLogger,
    })

    await dispatcher.dispatchApprovalPending('approval-1')

    const serialized = JSON.stringify(auditLogger.info.mock.calls)
    expect(serialized).not.toContain('super-secret-path')
    expect(serialized).not.toContain('p256dh-secret')
  })
})
