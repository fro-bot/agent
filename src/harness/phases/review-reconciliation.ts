/**
 * Review Reconciliation Phase
 *
 * After the agent session on a pull_request review trigger, gathers GitHub
 * facts, calls decideReconciliation(), and on 'approve' submits a formal
 * APPROVE via submitReview(). Fail-safe: any error logs + no-ops, NEVER
 * throws out, NEVER fails the run.
 */

import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import {decideReconciliation, parseVerdict} from '../../features/reviews/review-reconciliation.js'
import {submitReview} from '../../features/reviews/reviewer.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReviewReconciliationParams {
  /** Octokit client (authenticated) */
  readonly octokit: Octokit
  /** Bot login (e.g. 'fro-bot[bot]') — null/empty triggers early no-op */
  readonly botLogin: string | null
  /** Repository owner */
  readonly owner: string
  /** Repository name */
  readonly repo: string
  /** PR number — null triggers early no-op */
  readonly prNumber: number | null
  /** True when the triggering event is a pull_request review trigger */
  readonly isPullRequestReviewTrigger: boolean
  /** True when responseMode is 'github' */
  readonly responseModeIsGithub: boolean
  /** True when the agent session completed successfully */
  readonly agentSucceeded: boolean
  /** Run start time in milliseconds (Date.now() at run start) */
  readonly runStartMs: number
}

export interface ReviewReconciliationOutcome {
  /** Whether the harness submitted a formal APPROVE review */
  readonly reconciled: boolean
  /** Human-readable reason (stable identifier for tests/logs) */
  readonly reason: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a GitHub login for comparison.
 * Strips the `[bot]` suffix and lowercases.
 * Used only for the self-authored-PR guard (conservative).
 */
function normalizeLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/i, '')
}

/**
 * Returns true when the review was authored by the bot.
 *
 * Requires EXACT login match AND user.type === 'Bot' to prevent a human
 * account named 'fro-bot' from matching the bot 'fro-bot[bot]'.
 * Fails closed: returns false when user is null or type is not 'Bot'.
 */
function isBotReview(
  review: {readonly user: {readonly login: string; readonly type?: string} | null},
  botLogin: string,
): boolean {
  if (review.user == null) {
    return false
  }
  return review.user.login === botLogin && review.user.type === 'Bot'
}

// ---------------------------------------------------------------------------
// Phase implementation
// ---------------------------------------------------------------------------

/**
 * Run the review reconciliation phase.
 *
 * Fail-safe: the entire body is wrapped in try/catch. Any error is logged
 * and the function returns {reconciled: false, reason: 'error'} — it never
 * rethrows.
 */
export async function runReviewReconciliation(
  params: ReviewReconciliationParams,
  logger: Logger,
): Promise<ReviewReconciliationOutcome> {
  const {
    octokit,
    botLogin,
    owner,
    repo,
    prNumber,
    isPullRequestReviewTrigger,
    responseModeIsGithub,
    agentSucceeded,
    runStartMs,
  } = params

  // -------------------------------------------------------------------------
  // Early no-op guards — zero octokit calls
  // -------------------------------------------------------------------------

  if (isPullRequestReviewTrigger === false) {
    return {reconciled: false, reason: 'not-pr-review-trigger'}
  }

  if (prNumber == null) {
    return {reconciled: false, reason: 'no-pr-number'}
  }

  if (responseModeIsGithub === false) {
    return {reconciled: false, reason: 'response-mode-not-github'}
  }

  if (agentSucceeded === false) {
    return {reconciled: false, reason: 'agent-failed'}
  }

  if (botLogin == null || botLogin.length === 0) {
    return {reconciled: false, reason: 'no-bot-login'}
  }

  // -------------------------------------------------------------------------
  // Main path — wrapped in try/catch for fail-safe behavior
  // -------------------------------------------------------------------------

  logger.info('Review reconciliation: phase entered', {prNumber})

  try {
    const normalizedBotLogin = normalizeLogin(botLogin)

    // Step 1: Fetch current PR state (head SHA, author, fork status)
    const prResponse = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    })

    const currentHeadSha: string = prResponse.data.head.sha
    const prAuthorLogin: string = prResponse.data.user.login
    const headRepoFullName: string = prResponse.data.head.repo?.full_name ?? ''
    const baseRepoFullName: string = prResponse.data.base.repo.full_name

    // Guard: self-authored PR (bot is the PR author) — normalized comparison is fine here
    if (normalizeLogin(prAuthorLogin) === normalizedBotLogin) {
      logger.info('Review reconciliation: skipping self-authored PR', {prNumber, prAuthorLogin})
      return {reconciled: false, reason: 'self-or-fork'}
    }

    // Guard: fork PR (head repo differs from base repo)
    if (headRepoFullName !== baseRepoFullName) {
      logger.info('Review reconciliation: skipping fork PR', {prNumber, headRepoFullName, baseRepoFullName})
      return {reconciled: false, reason: 'self-or-fork'}
    }

    // Step 2: Fetch bot's reviews on this PR.
    // Single page (max 100). On a PR with >100 reviews the latest bot review
    // could fall on a later page, in which case this phase no-ops (the PR keeps
    // its existing state) rather than approving — a safe degradation, not a
    // wrongful approval. Pagination can be added if that ceiling is ever hit.
    const reviewsResponse = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    })

    const allReviews = reviewsResponse.data

    // Determine if bot already has an APPROVED review at the current head.
    // Requires exact login + Bot type to prevent human 'fro-bot' from matching.
    const alreadyApprovedAtHead = allReviews.some(
      review => isBotReview(review, botLogin) && review.state === 'APPROVED' && review.commit_id === currentHeadSha,
    )

    // Find the latest bot review from this run (submitted_at >= runStart).
    // Only formal PR reviews qualify — issue comments carry no commit_id and
    // cannot be used to verify the reviewed SHA.
    const runStartIso = new Date(runStartMs).toISOString()
    const botReviewsThisRun = allReviews.filter(
      review => isBotReview(review, botLogin) && review.submitted_at != null && review.submitted_at >= runStartIso,
    )

    // Sort descending by submitted_at to get the latest
    botReviewsThisRun.sort((a, b) => {
      const aTime = a.submitted_at ?? ''
      const bTime = b.submitted_at ?? ''
      return bTime.localeCompare(aTime)
    })

    const latestBotReview = botReviewsThisRun[0] ?? null

    // Step 3: Require a qualifying bot PR review — no issue-comment fallback.
    // Issue comments carry no commit_id and cannot verify the reviewed SHA,
    // making them an unsafe approval vector.
    if (latestBotReview == null) {
      logger.info('Review reconciliation: no qualifying bot review found this run', {prNumber})
      return {reconciled: false, reason: 'no-bot-review'}
    }

    const verdictBody: string | null = latestBotReview.body ?? null
    const headMatches = latestBotReview.commit_id === currentHeadSha
    // Always true here: botReviewsThisRun is pre-filtered by submitted_at >= runStart,
    // so any review reaching this point belongs to the current run. The field stays in
    // decideReconciliation's contract so the decision logic is independently testable
    // (and reusable by callers that don't pre-filter), but the phase's own guard is the
    // timestamp filter above.
    const verdictBelongsToRun = true

    // Step 4: Parse verdict and decide
    const verdict = verdictBody == null ? null : parseVerdict(verdictBody)

    const decision = decideReconciliation({
      verdict,
      alreadyApprovedAtHead,
      verdictBelongsToRun,
      headMatches,
    })

    if (decision.action === 'skip') {
      logger.info('Review reconciliation: skipping', {prNumber, reason: decision.reason})
      return {reconciled: false, reason: decision.reason}
    }

    // Step 5: Re-fetch PR head immediately before submitting to close the TOCTOU window.
    // If the head moved since Step 1, abort — we must not approve an unreviewed commit.
    const freshPrResponse = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    })

    const freshHeadSha: string = freshPrResponse.data.head.sha

    if (freshHeadSha !== currentHeadSha) {
      logger.info('Review reconciliation: head moved before submit, aborting', {
        prNumber,
        originalHead: currentHeadSha,
        freshHead: freshHeadSha,
      })
      return {reconciled: false, reason: 'head-moved-before-submit'}
    }

    // Step 6: Submit formal APPROVE, pinned to the reviewed SHA
    logger.info('Review reconciliation: submitting APPROVE', {prNumber, currentHeadSha})

    await submitReview(
      octokit,
      {
        prNumber,
        owner,
        repo,
        event: 'APPROVE',
        body: 'Approving to match the review verdict above.',
        comments: [],
        commitSha: currentHeadSha,
      },
      logger,
    )

    logger.info('Review reconciliation: APPROVE submitted successfully', {prNumber})
    return {reconciled: true, reason: 'approved'}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warning('Review reconciliation: error during phase, no-oping', {
      prNumber,
      error: message,
    })
    return {reconciled: false, reason: 'error'}
  }
}
