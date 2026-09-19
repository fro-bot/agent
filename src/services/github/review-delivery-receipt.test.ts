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

  it('an unconfigured store (storeConfig.enabled: false) submits unprotected, not blocked -- the status quo, and a warning names the weakened guarantee', async () => {
    // #given an unconfigured store (the default `s3-backup: 'false'`, or the fork-PR force-disable)
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig({enabled: false}), logger)

    // #when reserve is attempted
    const outcome = await ops.reserve(IDENTITY, 1)

    // #then it succeeds unprotected -- refusing to submit here would turn every
    // default-configured consumer's review delivery into an outage, which is worse than the
    // pre-existing rerun-duplication risk this accepts
    expect(outcome.kind).toBe('reserved')
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('without at-most-once'),
      expect.objectContaining({identity: IDENTITY, attempt: 1}),
    )
  })

  it('complement: a rerun with no store configured submits again -- the accepted status-quo risk, not silently pretended away', async () => {
    // #given an unconfigured store, and a first attempt that already "reserved" (i.e. submitted unprotected)
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig({enabled: false}), logger)
    const first = await ops.reserve(IDENTITY, 1)
    expect(first.kind).toBe('reserved')

    // #when a rerun (same runId, incremented attempt) reserves again
    const second = await ops.reserve(IDENTITY, 2)

    // #then it ALSO succeeds unprotected -- with no durable store there is no record of the
    // first attempt to block against, so a rerun can duplicate the review. This is the
    // accepted status-quo risk, documented here rather than silently assumed
    expect(second.kind).toBe('reserved')
  })

  it('complement: a configured store still fails closed on read failure -- unconfigured and failing are not the same case', async () => {
    // #given a CONFIGURED store whose read fails ambiguously (not genuinely absent)
    const {adapter} = createInMemoryAdapter()
    const getObject = vi.fn(async () => err(new Error('ServiceUnavailable')))
    const brokenAdapter: ObjectStoreAdapter = {...adapter, getObject}
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig({enabled: true}), logger, brokenAdapter)

    // #when reserve is attempted
    const outcome = await ops.reserve(IDENTITY, 1)

    // #then still blocked -- a configured-but-failing store must never be treated like an
    // unconfigured one
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') throw new Error('expected blocked')
    expect(outcome.reason).toBe('read-failed')
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

  it('a corrupted `delivered` record missing `reviewId` is rejected and blocks submission (fail-closed, not treated as genuine delivery)', async () => {
    // #given an existing object whose status claims 'delivered' but is missing reviewId --
    // a partial write, not a genuine delivery
    const {adapter, store} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)
    store.set('fro-bot-state/github/owner/repo/metadata/review-delivery-receipt-pr-42-run-run-1.json', {
      data: JSON.stringify({status: 'delivered', attempt: 1, reservedAt: new Date().toISOString()}),
      etag: 'etag-seed',
    })
    const conditionalPutSpy = vi.spyOn(adapter, 'conditionalPut' as never)

    // #when reserve is attempted
    const outcome = await ops.reserve(IDENTITY, 2)

    // #then blocked -- the corrupted record fails validation exactly like any other
    // malformed record and must not be treated as evidence the review already went out
    expect(outcome.kind).toBe('blocked')
    expect(outcome.kind === 'blocked' ? outcome.reason : null).toBe('read-failed')
    expect(conditionalPutSpy).not.toHaveBeenCalled()
  })

  it('a corrupted `delivered` record missing `deliveredAt` is rejected and blocks submission', async () => {
    // #given an existing object whose status claims 'delivered' but is missing deliveredAt
    const {adapter, store} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)
    store.set('fro-bot-state/github/owner/repo/metadata/review-delivery-receipt-pr-42-run-run-1.json', {
      data: JSON.stringify({status: 'delivered', attempt: 1, reservedAt: new Date().toISOString(), reviewId: 999}),
      etag: 'etag-seed',
    })
    const conditionalPutSpy = vi.spyOn(adapter, 'conditionalPut' as never)

    // #when reserve is attempted
    const outcome = await ops.reserve(IDENTITY, 2)

    // #then blocked -- same fail-closed treatment as any other malformed record
    expect(outcome.kind).toBe('blocked')
    expect(outcome.kind === 'blocked' ? outcome.reason : null).toBe('read-failed')
    expect(conditionalPutSpy).not.toHaveBeenCalled()
  })

  it('a genuine `reserved` record (no delivery fields at all) still parses and blocks as before', async () => {
    // #given a well-formed reserved record, with neither deliveredAt nor reviewId -- this
    // must keep parsing and blocking exactly as it did before the record was tightened into
    // a discriminated union
    const {adapter, store} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)
    store.set('fro-bot-state/github/owner/repo/metadata/review-delivery-receipt-pr-42-run-run-1.json', {
      data: JSON.stringify({status: 'reserved', attempt: 1, reservedAt: new Date().toISOString()}),
      etag: 'etag-seed',
    })

    // #when reserve is attempted
    const outcome = await ops.reserve(IDENTITY, 2)

    // #then blocked with 'already-reserved' -- a genuine, well-formed reserved record is
    // still recognized and protective, not swept up by the tightened validation
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') throw new Error('expected blocked')
    expect(outcome.reason).toBe('already-reserved')
    expect(outcome.detail).toContain('reserved')
  })

  it('a genuine `delivered` record with both required fields still parses and blocks as before', async () => {
    // #given a well-formed delivered record with deliveredAt and reviewId present
    const {adapter, store} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)
    store.set('fro-bot-state/github/owner/repo/metadata/review-delivery-receipt-pr-42-run-run-1.json', {
      data: JSON.stringify({
        status: 'delivered',
        attempt: 1,
        reservedAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
        reviewId: 999,
      }),
      etag: 'etag-seed',
    })

    // #when reserve is attempted
    const outcome = await ops.reserve(IDENTITY, 2)

    // #then blocked with 'already-reserved', carrying the delivered status in its detail
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') throw new Error('expected blocked')
    expect(outcome.reason).toBe('already-reserved')
    expect(outcome.detail).toContain('delivered')
  })

  it('release deletes the reservation (conditioned on its etag) so a later attempt can re-reserve', async () => {
    // #given a reservation acquired but never delivered (mirrors a stale-head abort)
    const {adapter, store} = createInMemoryAdapter()
    const conditionalDelete = vi.fn(async (key: string) => {
      store.delete(key)
      return ok(undefined)
    })
    const adapterWithDelete: ObjectStoreAdapter = {...adapter, conditionalDelete}
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapterWithDelete)
    const reservation = await ops.reserve(IDENTITY, 1)
    if (reservation.kind !== 'reserved') throw new Error('expected reserved')

    // #when release is called with the reservation's own etag
    await ops.release(IDENTITY, reservation.etag)

    // #then the object is gone, and a later attempt can reserve again -- a stale-head abort
    // is not a delivery, so it must not permanently suppress a later legitimate review
    expect(conditionalDelete).toHaveBeenCalledExactlyOnceWith(expect.any(String), {ifMatch: reservation.etag})
    const retry = await ops.reserve(IDENTITY, 2)
    expect(retry.kind).toBe('reserved')
  })

  it('release is best-effort: when the adapter lacks conditionalDelete, it never throws and the reservation remains', async () => {
    // #given an adapter with no conditionalDelete support
    const {adapter} = createInMemoryAdapter()
    const ops = createReviewDeliveryReceiptOperations(createStoreConfig(), logger, adapter)
    const reservation = await ops.reserve(IDENTITY, 1)
    if (reservation.kind !== 'reserved') throw new Error('expected reserved')

    // #when release is called anyway
    await expect(ops.release(IDENTITY, reservation.etag)).resolves.toBeUndefined()

    // #then the reservation remains in place and still blocks -- the same accepted trade-off
    // as a crash between reserve and POST, never a correctness regression
    const retry = await ops.reserve(IDENTITY, 2)
    expect(retry.kind).toBe('blocked')
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
