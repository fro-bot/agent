/**
 * Tests for the durable review-delivery receipt (src/services/github/review-delivery-receipt.ts).
 */

import type {ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import {err, ok} from '@fro-bot/runtime'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {createReviewDeliveryReceiptOperations, type ReviewDeliveryReceiptIdentity} from './review-delivery-receipt.js'

function createStoreConfig(overrides: Partial<ObjectStoreConfig> = {}): ObjectStoreConfig {
  return {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'fro-bot-state', ...overrides}
}

const IDENTITY: ReviewDeliveryReceiptIdentity = {repo: 'owner/repo', runId: 'run-1', prNumber: 42}

/** Minimal in-memory conditional object store: enough to exercise create-if-absent and update-if-match semantics. */
function createInMemoryAdapter(): {
  readonly adapter: ObjectStoreAdapter
  readonly store: Map<string, {readonly data: string; readonly etag: string}>
} {
  const store = new Map<string, {readonly data: string; readonly etag: string}>()
  let etagCounter = 0

  const adapter: ObjectStoreAdapter = {
    upload: vi.fn(),
    download: vi.fn(),
    list: vi.fn(),
    getObject: vi.fn(async (key: string) => {
      const existing = store.get(key)
      if (existing == null) {
        return err(Object.assign(new Error('NoSuchKey: object not found'), {errorCode: 'NoSuchKey'}))
      }
      return ok(existing)
    }),
    conditionalPut: vi.fn(async (key: string, data: string, options: {ifNoneMatch?: string; ifMatch?: string}) => {
      const existing = store.get(key)
      if (options.ifNoneMatch === '*' && existing != null) {
        return err(new Error('PreconditionFailed: object already exists'))
      }
      if (options.ifMatch != null && (existing == null || existing.etag !== options.ifMatch)) {
        return err(new Error('PreconditionFailed: etag mismatch'))
      }
      etagCounter += 1
      const etag = `etag-${etagCounter}`
      store.set(key, {data, etag})
      return ok({etag})
    }),
  }

  return {adapter, store}
}

describe('createReviewDeliveryReceiptOperations', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('reserves cleanly when no receipt exists yet (control case, proving the fixture is not vacuous)', async () => {
    // #given a fresh in-memory store with nothing reserved for this identity
    const {adapter} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)

    // #when attempt 1 reserves
    const outcome = await ops.reserve(IDENTITY, 1)

    // #then it succeeds
    expect(outcome.kind).toBe('reserved')
  })

  it('attempt 1 reserves and delivers; attempt 2 (rerun, same runId) performs zero POSTs -- reserve is blocked', async () => {
    // #given attempt 1 already reserved and delivered
    const {adapter} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)
    const first = await ops.reserve(IDENTITY, 1)
    if (first.kind !== 'reserved') throw new Error('expected reserved')
    await ops.recordDelivered(IDENTITY, first.etag, 1, 999)

    // #when a rerun (same runId, incremented GITHUB_RUN_ATTEMPT) reserves again
    const second = await ops.reserve(IDENTITY, 2)

    // #then it is blocked -- the caller never reaches the review POST
    expect(second.kind).toBe('blocked')
    if (second.kind !== 'blocked') throw new Error('expected blocked')
    expect(second.reason).toBe('already-reserved')
    expect(second.detail).toContain('delivered')
  })

  it('crash-equivalent: reservation exists but was never recorded delivered -- a later attempt is still blocked, not retried', async () => {
    // #given attempt 1 reserved but crashed before the POST (recordDelivered never called)
    const {adapter} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)
    await ops.reserve(IDENTITY, 1)

    // #when a later attempt tries to reserve
    const outcome = await ops.reserve(IDENTITY, 2)

    // #then it is blocked -- an unresolved 'reserved' record is just as protective as a
    // 'delivered' one; this is "delivery uncertain", never "safe to retry"
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') throw new Error('expected blocked')
    expect(outcome.reason).toBe('already-reserved')
    expect(outcome.detail).toContain('reserved')
  })

  it('same attempt re-entering submission performs zero additional POSTs (also covers dedupWindow:0/synchronize/issue_comment bypass classes, which never reach this far unprotected)', async () => {
    // #given attempt 1 already reserved
    const {adapter} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)
    await ops.reserve(IDENTITY, 1)

    // #when the SAME attempt number reserves again (e.g. a second review-capable code path
    // in the same invocation, or any ordinary-dedup bypass that still lands on this identity)
    const outcome = await ops.reserve(IDENTITY, 1)

    // #then still blocked -- an existing reservation from the SAME attempt never authorizes
    // a second POST
    expect(outcome.kind).toBe('blocked')
  })

  it('a conflicting concurrent reservation (conditional put returns a conflict) results in zero POSTs for the loser', async () => {
    // #given the read races a concurrent reserver: the read sees nothing, but the write loses
    const {adapter} = createInMemoryAdapter()
    const conditionalPut = vi.fn(async () => err(new Error('PreconditionFailed')))
    const racedAdapter: ObjectStoreAdapter = {...adapter, conditionalPut}
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, racedAdapter)

    // #when reserve is attempted
    const outcome = await ops.reserve(IDENTITY, 1)

    // #then blocked with the conflict-specific reason, distinct from 'already-reserved'
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') throw new Error('expected blocked')
    expect(outcome.reason).toBe('conflict')
    expect(typeof outcome.detail).toBe('string')
  })

  it('a receipt read failure (not genuinely absent) blocks submission entirely, before any write is attempted', async () => {
    // #given the read fails with an ambiguous, non-404 error
    const {adapter} = createInMemoryAdapter()
    const getObject = vi.fn(async () => err(new Error('ServiceUnavailable')))
    const conditionalPut = vi.fn()
    const brokenAdapter: ObjectStoreAdapter = {...adapter, getObject, conditionalPut}
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, brokenAdapter)

    // #when reserve is attempted
    const outcome = await ops.reserve(IDENTITY, 1)

    // #then blocked, and the write path was never reached
    expect(outcome.kind).toBe('blocked')
    expect(outcome.kind === 'blocked' ? outcome.reason : null).toBe('read-failed')
    expect(conditionalPut).not.toHaveBeenCalled()
  })

  it('a malformed existing record blocks submission entirely, before any write is attempted', async () => {
    // #given an existing object at the receipt key that does not parse as a valid record
    const {adapter, store} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)
    // Seed the store directly, bypassing reserve(), with garbage at the exact key reserve()
    // will compute (mirrors buildObjectStoreKey's shape: prefix/github/repo/metadata/suffix).
    store.set('fro-bot-state/github/owner/repo/metadata/review-delivery-receipt-pr-42-run-run-1.json', {
      data: 'not json',
      etag: 'etag-seed',
    })
    const conditionalPutSpy = vi.spyOn(adapter, 'conditionalPut' as never)

    // #when reserve is attempted
    const outcome = await ops.reserve(IDENTITY, 1)

    // #then blocked, and no write was attempted
    expect(outcome.kind).toBe('blocked')
    expect(outcome.kind === 'blocked' ? outcome.reason : null).toBe('read-failed')
    expect(conditionalPutSpy).not.toHaveBeenCalled()
  })

  it('fails closed when the object store is unconfigured (storeConfig.enabled: false) -- reserve always blocks, never falls back', async () => {
    // #given an unconfigured store
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig({enabled: false}), logger)

    // #when reserve is attempted
    const outcome = await ops.reserve(IDENTITY, 1)

    // #then blocked with the store-unavailable reason -- no Actions-cache fallback exists
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') throw new Error('expected blocked')
    expect(outcome.reason).toBe('store-unavailable')
    expect(typeof outcome.detail).toBe('string')
  })

  it('fails closed when the adapter lacks conditional operations', async () => {
    // #given an adapter with no getObject/conditionalPut (e.g. a minimal adapter variant)
    const bareAdapter: ObjectStoreAdapter = {upload: vi.fn(), download: vi.fn(), list: vi.fn()}
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, bareAdapter)

    // #when reserve is attempted
    const outcome = await ops.reserve(IDENTITY, 1)

    // #then blocked
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') throw new Error('expected blocked')
    expect(outcome.reason).toBe('store-unavailable')
  })

  it('recordDelivered failing after a successful POST is reported as delivery-uncertain (warning), never thrown, and never retried automatically', async () => {
    // #given a reservation acquired, but the delivered write then fails (etag went stale)
    const {adapter} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)
    const reservation = await ops.reserve(IDENTITY, 1)
    if (reservation.kind !== 'reserved') throw new Error('expected reserved')

    // #when recordDelivered is called with a stale etag
    await expect(ops.recordDelivered(IDENTITY, 'stale-etag', 1, 999)).resolves.toBeUndefined()

    // #then it warns rather than throwing -- the review already went out and must not be
    // retried on the strength of this failure alone
    const warningCall = vi.mocked(logger.warning).mock.calls[0]
    expect(warningCall?.[0]).toContain('delivery uncertain')
    expect(typeof warningCall?.[1]?.key).toBe('string')
  })

  it('a different workflow run id is eligible for a new submission (distinct receipt identity)', async () => {
    // #given attempt 1 of run-1 already reserved and delivered
    const {adapter} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)
    const first = await ops.reserve(IDENTITY, 1)
    if (first.kind !== 'reserved') throw new Error('expected reserved')
    await ops.recordDelivered(IDENTITY, first.etag, 1, 999)

    // #when a genuinely NEW workflow run (different GITHUB_RUN_ID) targets the same PR
    const outcome = await ops.reserve({...IDENTITY, runId: 'run-2'}, 1)

    // #then it is a distinct identity/key and reserves cleanly
    expect(outcome.kind).toBe('reserved')
  })
})
