/**
 * Durable publication receipt for irreversible review delivery.
 *
 * Reviews have no idempotency: unlike a comment (`response-post.ts`'s run-scoped marker
 * probe), there is no find-and-update path for a formal PR review, so a rerun that reaches
 * submission again creates a SECOND review. GitHub reruns preserve `GITHUB_RUN_ID` and only
 * increment `GITHUB_RUN_ATTEMPT`, so the ordinary dedup marker (`src/harness/phases/dedup.ts`,
 * keyed by `runId` alone) cannot protect this: `runDedup` explicitly proceeds when the
 * marker and the current invocation share a `runId` (dedup.ts ~:67-69).
 *
 * This module is a SEPARATE receipt, not another field on that time-window marker: the
 * ordinary marker is written only after cleanup, is skipped for disabled dedup and
 * unsupported entities, is stored under a run-ID-only cache key, and is best-effort --
 * none of that is acceptable for a write that can satisfy branch protection.
 *
 * Identity: trusted repository + workflow run ID + PR target + a fixed operation segment
 * (`RECEIPT_OPERATION_SEGMENT`) marking this as the one class of receipt this module issues.
 * The attempt number lives INSIDE the stored record, never in the identity/key -- putting it
 * in the key would hand every rerun (same runId, incremented attempt) a fresh, unprotected
 * reservation slot, defeating the whole guarantee.
 *
 * Two states: `reserved` (submission may be in flight or may already have happened -- a
 * pre-submit record is an intent, not proof of delivery) and `delivered` (acknowledged, with
 * the review id and the attempt that delivered it).
 *
 * At-most-once submission is a deliberate tradeoff: a crash after reservation but before the
 * POST suppresses a review that never arrived, and nothing here retries it automatically.
 * That is accepted -- see `createReviewDeliveryReceiptOperations`'s `recordDelivered` doc.
 * Report that state as "delivery uncertain, operator reconciliation required", never as
 * "already delivered".
 *
 * Fail-closed on a CONFIGURED store: when the object store is configured but unavailable (a
 * read fails ambiguously, a reservation conflicts, an existing record is malformed, or the
 * adapter lacks conditional operations), `reserve` always blocks. This guarantee is
 * mandatory, not best-effort -- it does not fall back to the Actions cache, and it does not
 * expire receipts inside the supported rerun horizon (receipts are never given a TTL or
 * opportunistically cleaned up by this module).
 *
 * An UNCONFIGURED store (`storeConfig.enabled === false` -- the default, and the case forced
 * for every fork PR) is a different situation, not a degenerate case of the above: there is
 * no durable store to fail against, so `reserve` proceeds unprotected rather than blocking
 * every default-configured consumer's review delivery. See `createReviewDeliveryReceiptOperations`'s
 * doc for the full split.
 *
 * `release` is the one narrow, deliberate exception to "never deleted": it exists solely for a
 * caller (`submitReviewWithHeadGuard`) that reserved and then, before the POST, positively
 * confirmed the head moved during the reservation call itself -- a stale-head abort, not a
 * crash and not an ambiguous outcome. That is not a delivery, so leaving the reservation in
 * place would permanently suppress a later legitimate review for this `runId` even though
 * nothing was ever submitted. `release` is conditioned on the exact reservation etag (never a
 * blind delete) and is best-effort: if the adapter lacks `conditionalDelete`, or the delete
 * fails, the reservation simply remains -- the same accepted "stuck reserved" trade-off as a
 * crash between reserve and POST, never a correctness regression.
 */

import type {Result} from '@bfra.me/es/result'
import type {ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'

import {buildObjectStoreKey, createS3Adapter} from '@fro-bot/runtime'

/**
 * Fixed operation segment embedded in every receipt key. Never a variable: this receipt
 * protects exactly one irreversible operation (submitting a formal PR review via the shared
 * `submitReviewWithHeadGuard` path). The segment exists so a future, different kind of
 * publication receipt gets its own namespace instead of colliding with this one -- it is
 * NOT a per-invocation value and must never be derived from event data.
 */
const RECEIPT_OPERATION_SEGMENT = 'review-delivery-receipt'

/**
 * Sentinel etag returned by an UNCONFIGURED store's `reserve` (case 1 below). Never a real
 * store etag -- callers (`submitReviewWithHeadGuard`) use it to detect that `reserve`
 * returned synchronously without any reservation round-trip actually happening, so there is
 * no post-reservation race window to re-check the head against.
 */
export const UNCONFIGURED_RESERVATION_ETAG = 'unconfigured'

export interface ReviewDeliveryReceiptIdentity {
  /** Trusted "owner/repo" -- never derived from an untrusted event payload field. */
  readonly repo: string
  /** `GITHUB_RUN_ID`. Deliberately excludes `GITHUB_RUN_ATTEMPT` -- see module doc. */
  readonly runId: string
  /** The PR this review targets. */
  readonly prNumber: number
}

/**
 * `GITHUB_RUN_ATTEMPT` of the invocation that holds (or held) this receipt. Lives inside
 * the record, never in the key -- see `RECEIPT_OPERATION_SEGMENT`'s doc.
 */
interface ReviewDeliveryReceiptRecordBase {
  readonly attempt: number
  readonly reservedAt: string
}

/** Reservation is in flight or may already have produced a POST -- never proof of delivery. */
interface ReviewDeliveryReceiptReservedRecord extends ReviewDeliveryReceiptRecordBase {
  readonly status: 'reserved'
}

/**
 * Acknowledged delivery. `deliveredAt` and `reviewId` are REQUIRED, not optional -- a
 * record claiming `status: 'delivered'` without both fields is corrupt, not a genuine
 * delivery, and must fail parsing (see `parseReceiptRecord`).
 */
interface ReviewDeliveryReceiptDeliveredRecord extends ReviewDeliveryReceiptRecordBase {
  readonly status: 'delivered'
  readonly deliveredAt: string
  readonly reviewId: number
}

type ReviewDeliveryReceiptRecord = ReviewDeliveryReceiptReservedRecord | ReviewDeliveryReceiptDeliveredRecord

export type ReviewDeliveryReservationBlockedReason =
  'already-reserved' | 'conflict' | 'store-unavailable' | 'read-failed'

export type ReviewDeliveryReservationOutcome =
  | {readonly kind: 'reserved'; readonly etag: string}
  | {readonly kind: 'blocked'; readonly reason: ReviewDeliveryReservationBlockedReason; readonly detail: string}

export interface ReviewDeliveryReceiptOperations {
  /**
   * Reads the receipt (step 1) and, only when genuinely absent, conditionally creates a
   * `reserved` record (step 2) -- both immediately before the caller's review POST. An
   * existing reservation, INCLUDING one from the same attempt, never authorizes another
   * POST: this function is the sole gate, and a second call for the same identity+attempt
   * blocks exactly like a call from a different attempt.
   */
  readonly reserve: (
    identity: ReviewDeliveryReceiptIdentity,
    attempt: number,
  ) => Promise<ReviewDeliveryReservationOutcome>
  /**
   * Best-effort transition from `reserved` to `delivered`, called only after the review POST
   * has already succeeded. Never throws and never blocks the caller: a failure here means
   * "delivery uncertain, operator reconciliation required" -- the review already went out and
   * this function cannot and must not un-submit it or trigger a retry.
   */
  readonly recordDelivered: (
    identity: ReviewDeliveryReceiptIdentity,
    reservationEtag: string,
    attempt: number,
    reviewId: number,
  ) => Promise<void>
  /**
   * Releases a reservation that was acquired but positively confirmed to be a stale-head
   * abort, never a delivery -- see the module doc's `release` paragraph. Best-effort and
   * conditioned on `reservationEtag`: never throws, and if the adapter lacks
   * `conditionalDelete` or the delete fails, the reservation simply remains (the caller has
   * already decided not to submit; a failed release does not change that).
   */
  readonly release: (identity: ReviewDeliveryReceiptIdentity, reservationEtag: string) => Promise<void>
}

function isNotFound(error: Error): boolean {
  const structured = error as Error & {httpStatusCode?: number; errorCode?: string; errorName?: string}
  if (structured.httpStatusCode !== undefined) return structured.httpStatusCode === 404
  if (structured.errorCode !== undefined) return structured.errorCode === 'NoSuchKey'
  if (structured.errorName !== undefined) return structured.errorName === 'NoSuchKey'
  return error.message.includes('NoSuchKey')
}

function buildReceiptKey(
  storeConfig: ObjectStoreConfig,
  identity: ReviewDeliveryReceiptIdentity,
): Result<string, Error> {
  return buildObjectStoreKey(
    storeConfig,
    'github',
    identity.repo,
    'metadata',
    `${RECEIPT_OPERATION_SEGMENT}/pr-${identity.prNumber}/run-${identity.runId}.json`,
  )
}

function parseReceiptRecord(data: string): ReviewDeliveryReceiptRecord | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }

    const candidate = parsed as Record<string, unknown>
    if (typeof candidate.attempt !== 'number' || typeof candidate.reservedAt !== 'string') {
      return null
    }

    // Each branch is validated independently -- a `delivered` status with a missing or
    // wrong-typed `deliveredAt`/`reviewId` is a corrupted record, not a genuine delivery,
    // and must fall through to `null` (fail-closed: the caller blocks submission on a
    // malformed record exactly as it does on any other unparseable one).
    if (candidate.status === 'reserved') {
      return {status: 'reserved', attempt: candidate.attempt, reservedAt: candidate.reservedAt}
    }
    if (candidate.status === 'delivered') {
      if (typeof candidate.deliveredAt !== 'string' || typeof candidate.reviewId !== 'number') {
        return null
      }
      return {
        status: 'delivered',
        attempt: candidate.attempt,
        reservedAt: candidate.reservedAt,
        deliveredAt: candidate.deliveredAt,
        reviewId: candidate.reviewId,
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Builds the injected reservation/delivery operations for the review-delivery receipt.
 *
 * TWO DISTINCT cases, deliberately not collapsed:
 *
 * 1. Store NOT CONFIGURED (`storeConfig.enabled === false`, e.g. the default `s3-backup:
 *    'false'`, or the store force-disabled for fork PRs). There is no durable backing store
 *    to reserve against at all, so at-most-once protection cannot be provided. This is the
 *    status-quo rerun-duplication risk that predates this receipt -- it must not be turned
 *    into total review non-delivery. `reserve` always succeeds unprotected (never blocks)
 *    and logs a `warning` naming the weakened guarantee on every call, so operators see it
 *    in their own run logs rather than discovering it only when a duplicate review lands.
 *    `recordDelivered`/`release` are no-ops (nothing was reserved to update).
 *
 * 2. Store CONFIGURED but the adapter lacks `getObject`/`conditionalPut`, or a reserve call
 *    hits a read failure, conflict, or malformed record: `reserve` returns
 *    `{kind: 'blocked', reason: ...}` and submission is withheld. This is the case the
 *    receipt exists for -- an operator opted into the durable-store guarantee and it is
 *    failing, so this fails closed exactly as before. This mirrors the harness-wide rule
 *    that the object store's own persistence safety predicate stays independent (see
 *    `AGENTS.md`'s "Must not move" list) -- this receipt does not fall back to the Actions
 *    cache when a configured S3 store is unavailable; it withholds formal review submission
 *    instead.
 */
export function createReviewDeliveryReceiptOperations(
  storeConfig: ObjectStoreConfig,
  logger: Logger,
  adapterOverride?: ObjectStoreAdapter,
): ReviewDeliveryReceiptOperations {
  const blockedUnavailable = (detail: string): ReviewDeliveryReservationOutcome => ({
    kind: 'blocked',
    reason: 'store-unavailable',
    detail,
  })

  // Store NOT configured (default `s3-backup: 'false'`, or force-disabled for fork PRs --
  // see `src/harness/config/inputs.ts`). Distinct from "configured but failing" below: there
  // is nothing to reserve against, so at-most-once cannot be provided at all. Submitting
  // unprotected here is the pre-existing rerun-duplication risk, not a new hazard -- refusing
  // to submit would instead turn every default-configured run and every fork PR into total
  // review non-delivery, which is strictly worse. See this function's doc, case 1.
  if (storeConfig.enabled === false) {
    return {
      reserve: async (identity, attempt) => {
        logger.warning(
          'Review delivery receipt: object store not configured -- submitting without at-most-once ' +
            'protection; a rerun of this invocation could duplicate this review',
          {identity, attempt},
        )
        return {kind: 'reserved', etag: UNCONFIGURED_RESERVATION_ETAG}
      },
      recordDelivered: async () => {
        logger.debug('Review delivery receipt: recordDelivered skipped, object store not configured')
      },
      release: async () => {
        logger.debug('Review delivery receipt: release skipped, object store not configured')
      },
    }
  }

  const adapter = adapterOverride ?? createS3Adapter(storeConfig, logger)

  return {
    async reserve(identity, attempt) {
      if (adapter.getObject == null || adapter.conditionalPut == null) {
        return blockedUnavailable('object store adapter does not support conditional operations')
      }

      const key = buildReceiptKey(storeConfig, identity)
      if (key.success === false) {
        return blockedUnavailable(key.error.message)
      }

      // Step 1: read early, before attempting the reservation write. A genuinely absent
      // receipt (NoSuchKey) is the only outcome that proceeds to step 2. An existing
      // receipt of EITHER status, from ANY attempt (including this one), blocks. A read
      // failure that is not "genuinely absent" also blocks -- an ambiguous read is never
      // treated as evidence of safety.
      const existing = await adapter.getObject(key.data)
      if (existing.success === false) {
        if (isNotFound(existing.error) === false) {
          logger.warning('Review delivery receipt: read failed, blocking submission', {
            key: key.data,
            error: existing.error.message,
          })
          return {kind: 'blocked', reason: 'read-failed', detail: existing.error.message}
        }
      } else {
        const record = parseReceiptRecord(existing.data.data)
        if (record == null) {
          logger.warning('Review delivery receipt: existing record is malformed, blocking submission', {
            key: key.data,
          })
          return {kind: 'blocked', reason: 'read-failed', detail: 'malformed receipt record'}
        }

        logger.info('Review delivery receipt: existing reservation found, blocking submission', {
          key: key.data,
          existingStatus: record.status,
          existingAttempt: record.attempt,
          attempt,
        })
        return {
          kind: 'blocked',
          reason: 'already-reserved',
          detail: `existing receipt status=${record.status} attempt=${record.attempt}`,
        }
      }

      // Step 2: immediately before the POST, conditionally create the reservation. Atomic
      // create-if-absent (`ifNoneMatch: '*'`) -- a concurrent reserver racing between the
      // read above and this write is still caught here, not just by the read.
      const record: ReviewDeliveryReceiptRecord = {
        status: 'reserved',
        attempt,
        reservedAt: new Date().toISOString(),
      }
      const put = await adapter.conditionalPut(key.data, JSON.stringify(record), {ifNoneMatch: '*'})
      if (put.success === false) {
        logger.warning('Review delivery receipt: reservation conflict, blocking submission', {
          key: key.data,
          error: put.error.message,
        })
        return {kind: 'blocked', reason: 'conflict', detail: put.error.message}
      }

      logger.info('Review delivery receipt: reservation acquired', {key: key.data, attempt})
      return {kind: 'reserved', etag: put.data.etag}
    },

    async recordDelivered(identity, reservationEtag, attempt, reviewId) {
      if (adapter.conditionalPut == null) {
        return
      }

      const key = buildReceiptKey(storeConfig, identity)
      if (key.success === false) {
        return
      }

      const record: ReviewDeliveryReceiptRecord = {
        status: 'delivered',
        attempt,
        reservedAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
        reviewId,
      }
      const put = await adapter.conditionalPut(key.data, JSON.stringify(record), {ifMatch: reservationEtag})
      if (put.success === false) {
        // Accepted tradeoff (see module doc): the review already succeeded. This failure
        // does not un-submit it and must never trigger a retry of the POST.
        logger.warning(
          'Review delivery receipt: delivery uncertain -- the review was submitted but the receipt could not be marked delivered; operator reconciliation required',
          {key: key.data, error: put.error.message},
        )
      }
    },

    async release(identity, reservationEtag) {
      if (adapter.conditionalDelete == null) {
        logger.warning(
          'Review delivery receipt: release skipped, object store adapter does not support conditional delete; reservation remains and will block future attempts for this run',
          {identity},
        )
        return
      }

      const key = buildReceiptKey(storeConfig, identity)
      if (key.success === false) {
        return
      }

      const deleted = await adapter.conditionalDelete(key.data, {ifMatch: reservationEtag})
      if (deleted.success === false) {
        // Best-effort, matching recordDelivered's style: the caller has already decided not
        // to submit, so a failed release only means the reservation remains -- the same
        // accepted "stuck reserved" trade-off as a crash between reserve and POST.
        logger.warning(
          'Review delivery receipt: release failed after a stale-head abort; reservation remains and will block future attempts for this run',
          {key: key.data, error: deleted.error.message},
        )
        return
      }

      logger.info('Review delivery receipt: reservation released after stale-head abort', {key: key.data})
    },
  }
}
