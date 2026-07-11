/**
 * Shared review-submission guards.
 *
 * Extracted from review-reconciliation.ts so both the legacy model-gh
 * reconciliation backstop and the file-convention response-post path apply
 * the exact same fork / self-authored / TOCTOU protections before ever
 * calling submitReview with an APPROVE or REQUEST_CHANGES event.
 */

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

export interface SubmitReviewWithHeadGuardParams {
  readonly octokit: Octokit
  readonly owner: string
  readonly repo: string
  readonly prNumber: number
  readonly event: ReviewEvent
  readonly body: string
  /** Head SHA observed by the caller's prior fork/self guard check. */
  readonly currentHeadSha: string
}

export type HeadGuardBlockReason = 'head-moved-before-submit'

export interface SubmitReviewWithHeadGuardBlocked {
  readonly submitted: false
  readonly reason: HeadGuardBlockReason
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
 */
export async function submitReviewWithHeadGuard(
  params: SubmitReviewWithHeadGuardParams,
  logger: Logger,
): Promise<SubmitReviewWithHeadGuardOutcome> {
  const {octokit, owner, repo, prNumber, event, body, currentHeadSha} = params

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

  return {submitted: true, review, commitSha: currentHeadSha}
}
