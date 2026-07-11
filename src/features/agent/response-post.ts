/**
 * Response-post orchestration for file-convention delivery.
 *
 * Reads the run-scoped response file the model wrote (outside the checkout),
 * validates it with the strict allowlist parser, derives the post target and
 * surface from the trusted routing context (never from the file), and posts
 * through the existing Octokit writers — applying the shared review guards
 * for any APPROVE/REQUEST_CHANGES verdict.
 *
 * Fail-closed: any read/parse/post failure returns a typed failure result;
 * the caller (finalize) is responsible for turning that into a failed run.
 */

import type {AgentContext} from '@fro-bot/runtime'
import type {TriggerResultProcess} from '../../features/triggers/types.js'
import type {Logger} from '../../shared/logger.js'

import * as fs from 'node:fs/promises'
import {parseResponseFile} from '@fro-bot/runtime'
import {BOT_COMMENT_MARKER, type CommentTarget, type Octokit} from '../../services/github/types.js'
import {postComment} from '../comments/writer.js'
import {checkForkOrSelfGuard, submitReviewWithHeadGuard} from '../reviews/review-guards.js'

/**
 * Bounded retry count for transient (5xx/network) writer failures. A small
 * fixed count, not exponential backoff — the run already has a hard timeout
 * and this is a best-effort recovery for a flaky single call, not a resilient
 * client.
 */
const TRANSIENT_RETRY_ATTEMPTS = 3

export type ResponsePostFailureReason =
  'file-read-failed' | 'parse-failed' | 'missing-target-context' | 'post-failed' | 'review-guard-blocked'

export interface ResponsePostFailure {
  readonly delivered: false
  readonly reason: ResponsePostFailureReason
  readonly detail: string
}

export interface ResponsePostDelivered {
  readonly delivered: true
  readonly kind: 'comment' | 'review'
}

export type ResponsePostResult = ResponsePostFailure | ResponsePostDelivered

export interface RunResponsePostParams {
  readonly octokit: Octokit
  readonly agentContext: AgentContext
  readonly triggerResult: TriggerResultProcess
  readonly botLogin: string | null
  readonly responseFilePath: string
}

function failure(reason: ResponsePostFailureReason, detail: string): ResponsePostFailure {
  return {delivered: false, reason, detail}
}

function withMarker(body: string): string {
  return body.includes(BOT_COMMENT_MARKER) ? body : `${body}\n\n${BOT_COMMENT_MARKER}`
}

/**
 * Derives the response-file surface (comment vs. review) and the Octokit
 * comment target strictly from the trusted routing context — never from the
 * response file itself.
 */
function deriveSurfaceAndTarget(
  agentContext: AgentContext,
  triggerResult: TriggerResultProcess,
): {readonly surface: 'issue-comment' | 'pr-comment' | 'pr-review'; readonly target: CommentTarget | null} {
  const [owner, repo] = agentContext.repo.split('/')
  if (owner == null || owner.length === 0 || repo == null || repo.length === 0 || agentContext.issueNumber == null) {
    return {surface: 'issue-comment', target: null}
  }

  const number = agentContext.issueNumber

  if (triggerResult.context.eventType === 'pull_request') {
    return {surface: 'pr-review', target: {type: 'pr', number, owner, repo}}
  }

  if (agentContext.issueType === 'pr') {
    return {surface: 'pr-comment', target: {type: 'pr', number, owner, repo}}
  }

  return {surface: 'issue-comment', target: {type: 'issue', number, owner, repo}}
}

async function postCommentWithRetry(
  octokit: Octokit,
  target: CommentTarget,
  body: string,
  logger: Logger,
): Promise<boolean> {
  for (let attempt = 1; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
    const result = await postComment(octokit, target, {body}, logger)
    if (result != null) {
      return true
    }
    logger.warning('Response-post: comment write failed, retrying', {attempt, target})
  }
  return false
}

/**
 * Reads, validates, and posts the model's file-convention response.
 *
 * Comment surfaces post via `postComment`. A `pr-review` surface with a
 * verdict submits through the shared fork/self/head-SHA/TOCTOU guards
 * (`review-guards.ts`) before calling `submitReview`. A guard-blocked
 * APPROVE/REQUEST_CHANGES on a fork or self-authored PR is treated as
 * `review-guard-blocked` — a legitimate refusal, not a partial post, but it
 * still fails the delivery assertion because the model was instructed to
 * respond and nothing was posted. Operators reading the failure reason can
 * distinguish "guard correctly blocked an unsafe approve" from a genuine
 * writer outage.
 */
export async function runResponsePost(params: RunResponsePostParams, logger: Logger): Promise<ResponsePostResult> {
  const {octokit, agentContext, triggerResult, botLogin, responseFilePath} = params

  let raw: string
  try {
    raw = await fs.readFile(responseFilePath, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    logger.error('Response-post: failed to read response file', {responseFilePath, error: detail})
    return failure('file-read-failed', detail)
  }

  const {surface, target} = deriveSurfaceAndTarget(agentContext, triggerResult)

  const parsed = parseResponseFile(raw, {surface})
  if (parsed.success === false) {
    logger.error('Response-post: response file failed validation', {
      responseFilePath,
      reason: parsed.error.reason,
    })
    return failure('parse-failed', parsed.error.message)
  }

  if (target == null) {
    logger.error('Response-post: missing target context', {agentContext: {repo: agentContext.repo}})
    return failure('missing-target-context', 'Cannot post: missing owner/repo/issue number in routing context')
  }

  const body = withMarker(parsed.data.body)

  if (parsed.data.verdict == null) {
    const posted = await postCommentWithRetry(octokit, target, body, logger)
    if (!posted) {
      return failure('post-failed', 'postComment returned null after retries')
    }
    return {delivered: true, kind: 'comment'}
  }

  // pr-review surface with a structured verdict.
  if (botLogin == null || botLogin.length === 0) {
    return failure('missing-target-context', 'Cannot submit a review: bot login is unavailable')
  }

  const reviewEvent = parsed.data.verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES'

  const guard = await checkForkOrSelfGuard(
    {octokit, owner: target.owner, repo: target.repo, prNumber: target.number, botLogin, event: reviewEvent},
    logger,
  )

  if (guard.allowed === false) {
    logger.warning('Response-post: review guard blocked the verdict, no review submitted', {
      reason: guard.reason,
      prNumber: target.number,
    })
    return failure('review-guard-blocked', `Review guard blocked submission: ${guard.reason}`)
  }

  const lastReason: ResponsePostFailureReason = 'post-failed'
  let lastDetail = 'submitReview failed after retries'
  for (let attempt = 1; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const outcome = await submitReviewWithHeadGuard(
        {
          octokit,
          owner: target.owner,
          repo: target.repo,
          prNumber: target.number,
          event: reviewEvent,
          body,
          currentHeadSha: guard.currentHeadSha,
        },
        logger,
      )

      if (outcome.submitted === false) {
        return failure('review-guard-blocked', `Review guard blocked submission: ${outcome.reason}`)
      }

      return {delivered: true, kind: 'review'}
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error)
      logger.warning('Response-post: submitReview failed, retrying', {attempt, error: lastDetail})
    }
  }

  return failure(lastReason, lastDetail)
}
