/**
 * Shared review-submission guards.
 *
 * Extracted from review-reconciliation.ts so both the legacy model-gh
 * reconciliation backstop and the file-convention response-post path apply
 * the exact same fork / self-authored / TOCTOU protections before ever
 * calling submitReview with an APPROVE or REQUEST_CHANGES event.
 */

import type {
  ReviewDeliveryReceiptIdentity,
  ReviewDeliveryReceiptOperations,
  ReviewDeliveryReservationBlockedReason,
} from '../../services/github/review-delivery-receipt.js'
import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import type {ReviewEvent, ReviewResult} from './types.js'
import {submitReview} from './reviewer.js'

export interface ForkOrSelfGuardParams {
  readonly octokit: Octokit
  readonly owner: string
  readonly repo: string
  readonly prNumber: number
  /** Bot login (e.g. 'fro-bot[bot]') used for the self-authored-PR guard. */
  readonly botLogin: string
  /** The review event this guard is gating. Only APPROVE is refused. */
  readonly event: ReviewEvent
}

export type ForkOrSelfBlockReason = 'self-or-fork'

export interface ForkOrSelfGuardBlocked {
  readonly allowed: false
  readonly reason: ForkOrSelfBlockReason
}

export interface ForkOrSelfGuardAllowed {
  readonly allowed: true
  readonly currentHeadSha: string
}

export type ForkOrSelfGuardResult = ForkOrSelfGuardAllowed | ForkOrSelfGuardBlocked

function normalizeLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/i, '')
}

/**
 * Fetches PR facts and applies the self-authored-PR guard and the fork-PR
 * guard. Mirrors review-reconciliation.ts's early main-path guards
 * (self-authored ~150, fork ~156).
 *
 * The fork/self refusal applies only to `event === 'APPROVE'`: an APPROVE is
 * the only review event that can satisfy branch protection and merge
 * attacker-controlled fork content, or self-approve the bot's own PR.
 * REQUEST_CHANGES and COMMENT can only block a PR, never unblock one, so
 * they are always permitted on a fork or self-authored PR.
 *
 * All events still fetch and return the head SHA observed at this fetch when
 * allowed, for the caller to pass through to `submitReviewWithHeadGuard`
 * (the TOCTOU guard applies regardless of event).
 */
export async function checkForkOrSelfGuard(
  params: ForkOrSelfGuardParams,
  logger: Logger,
): Promise<ForkOrSelfGuardResult> {
  const {octokit, owner, repo, prNumber, botLogin, event} = params
  const normalizedBotLogin = normalizeLogin(botLogin)

  const prResponse = await octokit.rest.pulls.get({owner, repo, pull_number: prNumber})
  const currentHeadSha: string = prResponse.data.head.sha
  const prAuthorLogin: string = prResponse.data.user.login
  const headRepoFullName: string = prResponse.data.head.repo?.full_name ?? ''
  const baseRepoFullName: string = prResponse.data.base.repo.full_name

  const isSelfAuthored = normalizeLogin(prAuthorLogin) === normalizedBotLogin
  const isFork = headRepoFullName !== baseRepoFullName

  if (event === 'APPROVE') {
    if (isSelfAuthored) {
      logger.info('Review guard: blocking self-authored PR', {prNumber, prAuthorLogin})
      return {allowed: false, reason: 'self-or-fork'}
    }

    if (isFork) {
      logger.info('Review guard: blocking fork PR', {prNumber, headRepoFullName, baseRepoFullName})
      return {allowed: false, reason: 'self-or-fork'}
    }
  }

  return {allowed: true, currentHeadSha}
}

/**
 * Publication-receipt configuration for a single `submitReviewWithHeadGuard` call
 * (`services/github/review-delivery-receipt.js`). Collapsed into one sub-object rather than
 * three independently optional sibling fields: `ops`, `identity`, and `attempt` are all-or-
 * nothing at the receipt's own gate (`reserve` only ever protects when all three are known),
 * so a caller that supplies a partial configuration is a type error here instead of a
 * silent, unprotected review submission. Optional at the `receipt` level so this shared
 * guard keeps working, unprotected, for any caller that has not been wired to a receipt yet;
 * every production caller in this codebase always provides it (see `response-post.ts` and
 * `review-reconciliation.ts`).
 */
export interface ReviewDeliveryReceiptConfig {
  readonly ops: ReviewDeliveryReceiptOperations
  readonly identity: ReviewDeliveryReceiptIdentity
  /** `GITHUB_RUN_ATTEMPT`, stored inside the receipt record, never in its key. */
  readonly attempt: number
}

export interface SubmitReviewWithHeadGuardParams {
  readonly octokit: Octokit
  readonly owner: string
  readonly repo: string
  readonly prNumber: number
  readonly event: ReviewEvent
  readonly body: string
  /** Head SHA observed by the caller's prior fork/self guard check. */
  readonly currentHeadSha: string
  /**
   * Injected publication-receipt configuration. When provided, a reservation is acquired
   * immediately after the head check below and before the review POST -- see
   * `ReviewDeliveryReceiptConfig`'s doc and `services/github/review-delivery-receipt.js`'s
   * doc for the full at-most-once guarantee.
   */
  readonly receipt?: ReviewDeliveryReceiptConfig
}

export type HeadGuardBlockReason = 'head-moved-before-submit' | 'receipt-blocked'

export interface SubmitReviewWithHeadGuardBlocked {
  readonly submitted: false
  readonly reason: HeadGuardBlockReason
  /** Present only when `reason === 'receipt-blocked'` -- the receipt's own block reason. */
  readonly receiptReason?: ReviewDeliveryReservationBlockedReason
}

export interface SubmitReviewWithHeadGuardSubmitted {
  readonly submitted: true
  readonly review: ReviewResult
  readonly commitSha: string
}

export type SubmitReviewWithHeadGuardOutcome = SubmitReviewWithHeadGuardBlocked | SubmitReviewWithHeadGuardSubmitted

/**
 * Re-fetches the PR head immediately before submitting to close the TOCTOU
 * window (mirrors review-reconciliation.ts ~230-247), aborting if the head
 * moved since `currentHeadSha` was observed. On success, submits the review
 * pinned to `currentHeadSha` (mirrors ~252-264).
 *
 * A second TOCTOU window sits inside the reservation itself: `receipt.ops.reserve` is an
 * awaited object-store round trip, during which the PR head can still move between the
 * check above and the POST below. After a successful reservation, the head is re-checked a
 * THIRD time; a move detected here also aborts, but -- unlike the pre-reservation check --
 * the reservation now exists and must be resolved, not just walked away from. This is a
 * stale-head abort, not a delivery and not an ambiguous crash, so the reservation is
 * released (best-effort) rather than left to permanently block a later legitimate review
 * for this `runId` (see `release`'s doc in `review-delivery-receipt.ts`).
 */
export async function submitReviewWithHeadGuard(
  params: SubmitReviewWithHeadGuardParams,
  logger: Logger,
): Promise<SubmitReviewWithHeadGuardOutcome> {
  const {octokit, owner, repo, prNumber, event, body, currentHeadSha, receipt} = params

  const freshPrResponse = await octokit.rest.pulls.get({owner, repo, pull_number: prNumber})
  const freshHeadSha: string = freshPrResponse.data.head.sha

  if (freshHeadSha !== currentHeadSha) {
    logger.info('Review guard: head moved before submit, aborting', {
      prNumber,
      originalHead: currentHeadSha,
      freshHead: freshHeadSha,
    })
    return {submitted: false, reason: 'head-moved-before-submit'}
  }

  // Publication receipt reservation -- placed here, immediately before the submit call
  // below, and strictly after the head-moved guard above: a head-guard rejection must never
  // consume a reservation slot for a review that was never going to be submitted anyway.
  // Only the caller that acquires this reservation may proceed to submit.
  let reservationEtag: string | null = null
  if (receipt != null) {
    const reservation = await receipt.ops.reserve(receipt.identity, receipt.attempt)
    if (reservation.kind === 'blocked') {
      logger.warning('Review guard: publication receipt blocked submission', {
        prNumber,
        event,
        reason: reservation.reason,
        detail: reservation.detail,
      })
      return {submitted: false, reason: 'receipt-blocked', receiptReason: reservation.reason}
    }

    // Close the race window the reservation call itself opens: `reserve` above was an
    // awaited round trip, during which the head could have moved. Re-check now, with the
    // reservation already held.
    //
    // Gated on the reservation's own PROVENANCE (`reserved-configured` vs
    // `reserved-unconfigured`), never on what its etag spells: an unconfigured store's
    // `reserve` (review-delivery-receipt.ts) returns synchronously without any await on a
    // remote call, so no reservation round trip happened and there is no extra race window
    // here to close -- this re-check would be a wasted authenticated API call on every review
    // submitted under the default (`s3-backup: 'false'`) configuration. The pre-reservation
    // head check above still applies unconditionally on every path.
    if (reservation.kind === 'reserved-configured') {
      reservationEtag = reservation.etag

      const postReservationPrResponse = await octokit.rest.pulls.get({owner, repo, pull_number: prNumber})
      const postReservationHeadSha: string = postReservationPrResponse.data.head.sha
      if (postReservationHeadSha !== currentHeadSha) {
        logger.info('Review guard: head moved during reservation, releasing and aborting', {
          prNumber,
          originalHead: currentHeadSha,
          freshHead: postReservationHeadSha,
        })
        await receipt.ops.release(receipt.identity, reservationEtag)
        return {submitted: false, reason: 'head-moved-before-submit'}
      }
    }
  }

  logger.info('Review guard: submitting review', {prNumber, event, currentHeadSha})

  const review = await submitReview(
    octokit,
    {
      prNumber,
      owner,
      repo,
      event,
      body,
      comments: [],
      commitSha: currentHeadSha,
    },
    logger,
  )

  if (receipt != null && reservationEtag != null) {
    await receipt.ops.recordDelivered(receipt.identity, reservationEtag, receipt.attempt, review.reviewId)
  }

  return {submitted: true, review, commitSha: currentHeadSha}
}
