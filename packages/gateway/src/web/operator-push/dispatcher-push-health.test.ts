import type {PushRelayResult, PushSender} from './push-sender.js'
import type {OperatorPushSubscriptionStore, SubscriptionRecord} from './subscription-store.js'
import {describe, expect, it, vi} from 'vitest'
import {createDedupeCache} from './dedupe-cache.js'
import {createPushDispatcher} from './dispatcher.js'
import {createPushHealthTracker} from './push-health.js'
import {createStoreError} from './subscription-store.js'
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

type DispatchStore = Pick<OperatorPushSubscriptionStore, 'listAllActiveRecords' | 'markDead'>

function makeDispatcher(options: {
  readonly records: readonly SubscriptionRecord[]
  readonly sender: PushSender
  readonly store?: Partial<DispatchStore>
  readonly tracker?: ReturnType<typeof createPushHealthTracker>
}) {
  const time = {nowMs: 1_000_000}
  const tracker = options.tracker ?? createPushHealthTracker({clock: () => time.nowMs})
  if (options.tracker === undefined) {
    tracker.recordStartup('ok', tracker.nextSequence())
  }
  const store: DispatchStore = {
    listAllActiveRecords: vi.fn(async () => ({success: true as const, data: options.records})),
    markDead: vi.fn(async () => ({success: true as const, data: undefined})),
    ...options.store,
  }
  const dispatcher = createPushDispatcher({
    store,
    sender: options.sender,
    dedupeCache: createDedupeCache({windowMs: 60_000}),
    triggerPolicy: {shouldNotify},
    vapidConfig: VAPID_CONFIG,
    logger: {debug: vi.fn(), warn: vi.fn()},
    auditLogger: {info: vi.fn(), warn: vi.fn()},
    pushHealth: tracker,
  })
  return {dispatcher, tracker, time}
}

function setup(options: {
  readonly records: readonly SubscriptionRecord[]
  readonly outcomes?: readonly PushRelayResult[]
  readonly store?: Partial<DispatchStore>
}) {
  const sender = makeSender(options.outcomes ?? [])
  return {...makeDispatcher({records: options.records, sender, store: options.store}), sender}
}

async function failThenRun(second: (tracker: ReturnType<typeof createPushHealthTracker>) => Promise<void>) {
  const time = {nowMs: 1_000_000}
  const tracker = createPushHealthTracker({clock: () => time.nowMs})
  tracker.recordStartup('ok', tracker.nextSequence())
  const failing = makeDispatcher({
    records: [makeRecord(1)],
    sender: makeSender([{outcome: 'error'}]),
    tracker,
  })
  await failing.dispatcher.dispatchRunFailed('run-1')
  expect(tracker.getStatus()).toBe('degraded')
  await second(tracker)
  return tracker
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

  it('degrades when a send rejects for one of two records, and the other record still delivers', async () => {
    // #given the first send rejects, the second succeeds
    const sendNotification = vi
      .fn<PushSender['sendNotification']>()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(ACCEPTED)
    const {dispatcher, tracker} = makeDispatcher({
      records: [makeRecord(1), makeRecord(2)],
      sender: {sendNotification},
    })

    // #when
    await dispatcher.dispatchRunFailed('run-1')

    // #then
    expect(sendNotification).toHaveBeenCalledTimes(2)
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('degrades when markDead rejects after a 410', async () => {
    // #given
    const {dispatcher, tracker} = setup({
      records: [makeRecord(1)],
      outcomes: [{outcome: 'dead-subscription', statusCode: 410}],
      store: {
        markDead: vi.fn(async () => {
          throw new Error('store down')
        }),
      },
    })

    // #when
    await dispatcher.dispatchRunFailed('run-1')

    // #then the rejected cleanup is counted as a failed record
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

  it('does not let an older broadcast that finishes late clear a newer broadcast failure', async () => {
    // #given broadcast A starts first and is held open; broadcast B starts later and fails
    let releaseA: (() => void) | undefined
    const sendNotification = vi
      .fn<PushSender['sendNotification']>()
      .mockImplementationOnce(
        async () =>
          new Promise<PushRelayResult>(resolve => {
            releaseA = () => resolve(ACCEPTED)
          }),
      )
      .mockResolvedValueOnce({outcome: 'error'})
    const {dispatcher, tracker} = makeDispatcher({records: [makeRecord(1)], sender: {sendNotification}})

    // #when B fails first, then A completes successfully
    const broadcastA = dispatcher.dispatchRunFailed('run-a')
    await vi.waitFor(() => expect(releaseA).toBeDefined())
    await dispatcher.dispatchRunFailed('run-b')
    expect(tracker.getStatus()).toBe('degraded')
    releaseA?.()
    await broadcastA

    // #then the older broadcast's late success must not clear the newer failure
    expect(tracker.getStatus()).toBe('degraded')
  })
})

describe('createPushDispatcher — push health: broadcasts that establish nothing', () => {
  it('an empty subscription list is neither a failure nor a success', async () => {
    // #given a relay failure, then a broadcast over an empty list
    const tracker = await failThenRun(async shared => {
      const empty = makeDispatcher({records: [], sender: makeSender([]), tracker: shared})
      await empty.dispatcher.dispatchRunFailed('run-2')
    })

    // #then it does not clear the failure
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
    const {dispatcher, tracker, sender} = setup({records: [makeRecord(1)], outcomes: [{outcome: 'error'}]})
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
    const tracker = await failThenRun(async shared => {
      const stale = makeDispatcher({
        records: [makeRecord(2, {keyVersion: '9'})],
        sender: makeSender([]),
        tracker: shared,
      })
      await stale.dispatcher.dispatchRunFailed('run-2')
    })

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('a failed subscription listing records no relay observation', async () => {
    // #given a failed listing (the backend failure itself is observed at the adapter, not here)
    const {dispatcher, tracker} = setup({
      records: [],
      store: {
        listAllActiveRecords: vi.fn(async () => ({
          success: false as const,
          error: createStoreError('list unavailable'),
        })),
      },
    })

    // #when
    await dispatcher.dispatchApprovalPending('approval-1')

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })
})
