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
import {assertRunNotCancelled, isRunCancelled, registerCancellationCleanup} from '../../shared/cancellation.js'
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
  /**
   * The PR author is the posting account (login compared case-insensitively, `[bot]` stripped).
   * Distinguishes self-authorship from a fork block so a caller can downgrade to a COMMENT review.
   */
  readonly selfAuthored: boolean
}

export interface ForkOrSelfGuardAllowed {
  readonly allowed: true
  readonly currentHeadSha: string
  /**
   * The PR author is the posting account. GitHub rejects APPROVE and REQUEST_CHANGES from a PR's own
   * author (HTTP 422), so a caller submitting either must downgrade to a COMMENT review.
   */
  readonly selfAuthored: boolean
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
 * the guard permits them on a fork or self-authored PR. GitHub itself rejects
 * APPROVE and REQUEST_CHANGES from the PR's own author (422), so `selfAuthored`
 * is returned for callers to downgrade either to a COMMENT review.
 *
 * All events still fetch and return the head SHA observed at this fetch when
 * allowed. It is a delivery-time read, never the review's pin.
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
      return {allowed: false, reason: 'self-or-fork', selfAuthored: true}
    }

    if (isFork) {
      logger.info('Review guard: blocking fork PR', {prNumber, headRepoFullName, baseRepoFullName})
      return {allowed: false, reason: 'self-or-fork', selfAuthored: false}
    }
  }

  return {allowed: true, currentHeadSha, selfAuthored: isSelfAuthored}
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
  /** The head the agent reviewed (`resolveReviewedHeadSha`); the review is pinned to it. */
  readonly reviewedHeadSha: string
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

/** Longest the guard waits for the store to take a reservation back before it lets the run go on without it. */
const RECEIPT_RELEASE_BOUND_MS = 3_000

export interface SubmitReviewWithHeadGuardSubmitted {
  readonly submitted: true
  readonly review: ReviewResult
  readonly commitSha: string
}

export type SubmitReviewWithHeadGuardOutcome = SubmitReviewWithHeadGuardBlocked | SubmitReviewWithHeadGuardSubmitted

/**
 * Re-fetches the PR head immediately before submitting, aborting if it is not the
 * `reviewedHeadSha` the agent reviewed -- whether the PR moved during the run or in the
 * seconds before this call. On success, submits the review pinned to `reviewedHeadSha`,
 * never to the freshly fetched head.
 *
 * A second TOCTOU window sits inside the reservation itself: `receipt.ops.reserve` is an
 * awaited object-store round trip, during which the PR head can still move between the
 * check above and the POST below. After a successful reservation, the head is re-checked a
 * second time; a move detected here also aborts, but -- unlike the pre-reservation check --
 * the reservation now exists and must be resolved, not just walked away from. This is a
 * stale-head abort, not a delivery and not an ambiguous crash, so the reservation is
 * released (best-effort) rather than left to permanently block a later legitimate review
 * for this `runId` (see `release`'s doc in `review-delivery-receipt.ts`).
 */
export async function submitReviewWithHeadGuard(
  params: SubmitReviewWithHeadGuardParams,
  logger: Logger,
): Promise<SubmitReviewWithHeadGuardOutcome> {
  const {octokit, owner, repo, prNumber, event, body, reviewedHeadSha, receipt} = params

  const freshPrResponse = await octokit.rest.pulls.get({owner, repo, pull_number: prNumber})
  const freshHeadSha: string = freshPrResponse.data.head.sha

  if (freshHeadSha !== reviewedHeadSha) {
    logger.info('Review guard: head moved before submit, aborting', {
      prNumber,
      reviewedHead: reviewedHeadSha,
      freshHead: freshHeadSha,
    })
    return {submitted: false, reason: 'head-moved-before-submit'}
  }

  // After the head read above, which may have been in flight when a signal arrived. Before the reservation, so a cancelled run
  // never takes a reservation slot for a review it will not send (a held slot would block a rerun's review).
  assertRunNotCancelled('the review')

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
    if (reservation.kind === 'reserved-configured') reservationEtag = reservation.etag
  }

  // From here the run HOLDS a reservation and has not started the POST (the `try` below ends where the POST begins, and its `finally`
  // unregisters the cleanup, so nothing in this block can give back a receipt once the POST has been sent). Whatever ends the guard before the POST (a move of the
  // head, a failed lookup, a signal) gives the slot back, so a rerun of the same run id can still deliver the review; once the
  // POST has started the receipt stays whatever happens, because the outcome is then unknown and a second review is worse.
  const held =
    receipt != null && reservationEtag != null
      ? {ops: receipt.ops, identity: receipt.identity, etag: reservationEtag}
      : null
  let released: Promise<void> | undefined
  /** Gives the reservation back, once, within a bound: the store may be the very thing that is not answering. */
  const releaseHeld = async (): Promise<void> => {
    if (held == null) return
    released ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          held.ops.release(held.identity, held.etag),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, RECEIPT_RELEASE_BOUND_MS)
          }),
        ])
      } catch {
        // Best-effort, as `release` itself is: a reservation that stays is the accepted stuck-reserved trade-off.
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    })()
    await released
  }
  // No await between the reserve returning and this registration, so a signal cannot fall between them: either the run is
  // already cancelled here (checked next) or the owner finds this cleanup and runs it the moment the signal arrives, even while
  // a read below is still pending.
  const unregisterRelease = held == null ? () => undefined : registerCancellationCleanup(releaseHeld)

  try {
    // Close the race window the reservation call itself opens: `reserve` above was an
    // awaited round trip, during which the head could have moved. Re-check now, with the
    // reservation already held. A signal that arrived during the round trip is acted on first, before another read.
    if (isRunCancelled()) assertRunNotCancelled('the review')

    // Gated on the reservation's own PROVENANCE (`reserved-configured` vs
    // `reserved-unconfigured`), never on what its etag spells: an unconfigured store's
    // `reserve` (review-delivery-receipt.ts) returns synchronously without any await on a
    // remote call, so no reservation round trip happened and there is no extra race window
    // here to close -- this re-check would be a wasted authenticated API call on every review
    // submitted under the default (`s3-backup: 'false'`) configuration. The pre-reservation
    // head check above still applies unconditionally on every path.
    if (held != null) {
      const postReservationPrResponse = await octokit.rest.pulls.get({owner, repo, pull_number: prNumber})
      const postReservationHeadSha: string = postReservationPrResponse.data.head.sha
      if (postReservationHeadSha !== reviewedHeadSha) {
        logger.info('Review guard: head moved during reservation, releasing and aborting', {
          prNumber,
          reviewedHead: reviewedHeadSha,
          freshHead: postReservationHeadSha,
        })
        await releaseHeld()
        return {submitted: false, reason: 'head-moved-before-submit'}
      }
    }

    // The reservation and the lookup were awaited round trips: a signal may have arrived during them. The slot is released (the
    // review will not be sent), so a rerun can still deliver it.
    assertRunNotCancelled('the review')

    logger.info('Review guard: submitting review', {prNumber, event, reviewedHeadSha})
  } catch (error) {
    await releaseHeld()
    throw error
  } finally {
    unregisterRelease()
  }

  const review = await submitReview(
    octokit,
    {
      prNumber,
      owner,
      repo,
      event,
      body,
      comments: [],
      commitSha: reviewedHeadSha,
    },
    logger,
  )

  if (held != null && receipt != null) {
    await held.ops.recordDelivered(held.identity, held.etag, receipt.attempt, review.reviewId)
  }

  return {submitted: true, review, commitSha: reviewedHeadSha}
}
