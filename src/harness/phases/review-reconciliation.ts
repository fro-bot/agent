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
 */
function normalizeLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/i, '')
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

  if (!isPullRequestReviewTrigger) {
    return {reconciled: false, reason: 'not-pr-review-trigger'}
  }

  if (prNumber == null) {
    return {reconciled: false, reason: 'no-pr-number'}
  }

  if (!responseModeIsGithub) {
    return {reconciled: false, reason: 'response-mode-not-github'}
  }

  if (!agentSucceeded) {
    return {reconciled: false, reason: 'agent-failed'}
  }

  if (botLogin == null || botLogin.length === 0) {
    return {reconciled: false, reason: 'no-bot-login'}
  }

  // -------------------------------------------------------------------------
  // Main path — wrapped in try/catch for fail-safe behavior
  // -------------------------------------------------------------------------

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

    // Guard: self-authored PR (bot is the PR author)
    if (normalizeLogin(prAuthorLogin) === normalizedBotLogin) {
      logger.info('Review reconciliation: skipping self-authored PR', {prNumber, prAuthorLogin})
      return {reconciled: false, reason: 'self-or-fork'}
    }

    // Guard: fork PR (head repo differs from base repo)
    if (headRepoFullName !== baseRepoFullName) {
      logger.info('Review reconciliation: skipping fork PR', {prNumber, headRepoFullName, baseRepoFullName})
      return {reconciled: false, reason: 'self-or-fork'}
    }

    // Step 2: Fetch bot's reviews on this PR
    const reviewsResponse = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    })

    const allReviews = reviewsResponse.data

    // Determine if bot already has an APPROVED review at the current head
    const alreadyApprovedAtHead = allReviews.some(
      review =>
        review.user != null &&
        normalizeLogin(review.user.login) === normalizedBotLogin &&
        review.state === 'APPROVED' &&
        review.commit_id === currentHeadSha,
    )

    // Find the latest bot review from this run (submitted_at >= runStart)
    const runStartIso = new Date(runStartMs).toISOString()
    const botReviewsThisRun = allReviews.filter(
      review =>
        review.user != null &&
        normalizeLogin(review.user.login) === normalizedBotLogin &&
        review.submitted_at != null &&
        review.submitted_at >= runStartIso,
    )

    // Sort descending by submitted_at to get the latest
    botReviewsThisRun.sort((a, b) => {
      const aTime = a.submitted_at ?? ''
      const bTime = b.submitted_at ?? ''
      return bTime.localeCompare(aTime)
    })

    const latestBotReview = botReviewsThisRun[0] ?? null

    // Step 3: Fallback to issue comments if no qualifying bot review found
    let verdictBody: string | null = null
    let headMatches = false
    let verdictBelongsToRun = false

    if (latestBotReview == null) {
      // Fallback: look for a bot issue comment from this run
      const commentsResponse = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      })

      const botCommentsThisRun = commentsResponse.data.filter(
        comment =>
          comment.user != null &&
          normalizeLogin(comment.user.login) === normalizedBotLogin &&
          comment.created_at >= runStartIso,
      )

      // Sort descending by created_at
      botCommentsThisRun.sort((a, b) => b.created_at.localeCompare(a.created_at))

      const latestBotComment = botCommentsThisRun[0] ?? null

      if (latestBotComment != null) {
        verdictBody = latestBotComment.body ?? null
        // Issue comments have no commit_id — treat headMatches as true when
        // the comment is within this run window (already filtered above)
        headMatches = true
        verdictBelongsToRun = true
      }
    } else {
      verdictBody = latestBotReview.body ?? null
      headMatches = latestBotReview.commit_id === currentHeadSha
      verdictBelongsToRun = true // already filtered by runStart
    }

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

    // Step 5: Submit formal APPROVE
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
