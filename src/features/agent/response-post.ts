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

import type {AgentContext, ParsedResponse, ResponseSurface} from '@fro-bot/runtime'
import type {TriggerResultProcess} from '../../features/triggers/types.js'
import type {Logger} from '../../shared/logger.js'

import * as fs from 'node:fs/promises'
import process from 'node:process'
import {parseResponseFile} from '@fro-bot/runtime'
import {BOT_COMMENT_MARKER, type CommentTarget, type Octokit} from '../../services/github/types.js'
import {readThread} from '../comments/reader.js'
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
  | 'file-read-failed'
  | 'parse-failed'
  | 'missing-target-context'
  | 'missing-verdict'
  | 'post-failed'
  | 'review-guard-blocked'

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
  /** Action-generated delivery text appended only to plain comment responses. */
  readonly deliveryFooter?: string
}

export interface ReadAndParseResponseFileParams {
  readonly agentContext: AgentContext
  readonly triggerResult: TriggerResultProcess
  readonly responseFilePath: string
  readonly executionSucceeded?: boolean
}

export type ReadAndParseResponseFileResult =
  | {readonly success: true; readonly data: {readonly parsed: ParsedResponse; readonly surface: ResponseSurface}}
  | ResponsePostFailure

function failure(reason: ResponsePostFailureReason, detail: string): ResponsePostFailure {
  return {delivered: false, reason, detail}
}

/** Read and validate a response artifact without performing any GitHub mutation. */
export async function readAndParseResponseFile(
  params: ReadAndParseResponseFileParams,
  logger: Logger,
): Promise<ReadAndParseResponseFileResult> {
  const {responseFilePath, agentContext, triggerResult, executionSucceeded} = params
  let raw: string
  try {
    raw = await fs.readFile(responseFilePath, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (executionSucceeded === false) {
      logger.debug('Response-post: no response file after failed execution (expected)', {
        responseFilePath,
        error: detail,
      })
    } else {
      logger.error('Response-post: failed to read response file', {responseFilePath, error: detail})
    }
    return failure('file-read-failed', detail)
  }

  const surface = resolveResponseSurface(agentContext, triggerResult)
  const parsed = parseResponseFile(raw, {surface})
  if (parsed.success === false) {
    logger.error('Response-post: response file failed validation', {
      responseFilePath,
      reason: parsed.error.reason,
    })
    return failure('parse-failed', parsed.error.message)
  }

  return {success: true, data: {parsed: parsed.data, surface}}
}

function withMarker(body: string): string {
  return body.includes(BOT_COMMENT_MARKER) ? body : `${body}\n\n${BOT_COMMENT_MARKER}`
}

function appendDeliveryFooter(body: string, deliveryFooter: string | undefined): string {
  if (deliveryFooter == null || deliveryFooter.length === 0) {
    return body
  }

  return `${body}\n\n${deliveryFooter}`
}

/**
 * Run-scoped marker distinguishing THIS invocation's response comment from
 * any earlier response comment on the same thread. `BOT_COMMENT_MARKER`
 * alone only identifies "a bot response", which is ambiguous across repeat
 * @-mentions on the same issue/PR.
 */
function runMarker(): string {
  const runId = process.env.GITHUB_RUN_ID ?? 'local'
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1'
  return `<!-- fro-bot-response:${runId}-${runAttempt} -->`
}

function withRunMarker(body: string): string {
  return `${body}\n${runMarker()}`
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
  const surface = resolveResponseSurface(agentContext, triggerResult)
  const [owner, repo] = agentContext.repo.split('/')
  if (owner == null || owner.length === 0 || repo == null || repo.length === 0 || agentContext.issueNumber == null) {
    return {surface, target: null}
  }

  const number = agentContext.issueNumber

  return {
    surface,
    target: {type: surface === 'issue-comment' ? 'issue' : 'pr', number, owner, repo},
  }
}

function resolveResponseSurface(agentContext: AgentContext, triggerResult: TriggerResultProcess): ResponseSurface {
  if (triggerResult.context.eventType === 'pull_request') {
    return 'pr-review'
  }

  if (agentContext.issueType === 'pr') {
    return 'pr-comment'
  }

  return 'issue-comment'
}

/**
 * Posts the response comment with bounded retries for transient writer
 * failures. Idempotency is a run-scoped marker probe, NOT `updateExisting`:
 * `postComment`'s updateExisting path finds the LAST bot comment carrying
 * the generic `BOT_COMMENT_MARKER`, which on a repeat @-mention in the same
 * thread is the PREVIOUS invocation's response — using it here would
 * silently overwrite that prior answer instead of posting a new one (the
 * Response Protocol requires exactly one new comment per invocation).
 *
 * Attempt 1 always creates. On a later attempt (after an ambiguous failure
 * where GitHub may have recorded the comment but the client saw an error),
 * probe the thread for THIS run's marker before creating again: if found,
 * the earlier attempt actually succeeded and nothing more is posted. A
 * previous run's generic-marker comment does not satisfy the probe. If
 * botLogin is unavailable the probe is skipped and every attempt creates
 * (pre-existing ambiguous-duplicate risk on retry, unchanged from before).
 */
async function postCommentWithRetry(
  octokit: Octokit,
  target: CommentTarget,
  body: string,
  botLogin: string | null,
  logger: Logger,
): Promise<boolean> {
  const marker = runMarker()

  for (let attempt = 1; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 1 && botLogin != null && botLogin.length > 0) {
      const thread = await readThread(octokit, target, botLogin, logger)
      const alreadyDelivered = thread?.comments.some(c => c.isBot && c.body.includes(marker)) ?? false
      if (alreadyDelivered) {
        logger.debug("Response-post: probe found this run's comment already posted, skipping re-create", {
          attempt,
          target,
        })
        return true
      }
    }

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
  const {octokit, agentContext, triggerResult, botLogin, responseFilePath, deliveryFooter} = params

  const prepared = await readAndParseResponseFile({agentContext, triggerResult, responseFilePath}, logger)
  if ('success' in prepared === false) {
    return prepared
  }

  const {surface, parsed} = prepared.data
  const {target} = deriveSurfaceAndTarget(agentContext, triggerResult)

  if (target == null) {
    logger.error('Response-post: missing target context', {agentContext: {repo: agentContext.repo}})
    return failure('missing-target-context', 'Cannot post: missing owner/repo/issue number in routing context')
  }

  const body = withMarker(parsed.body)

  if (parsed.verdict == null) {
    // A pull_request trigger's surface is always 'pr-review' and requires a
    // structured verdict — falling through to a plain comment here would
    // silently downgrade a required review into a comment and still report
    // delivered:true. Fail closed instead; nothing is posted.
    if (surface === 'pr-review') {
      logger.error('Response-post: pr-review surface has no verdict frontmatter', {responseFilePath})
      return failure('missing-verdict', 'pull_request responses must carry a verdict frontmatter')
    }

    const commentBody = withMarker(appendDeliveryFooter(parsed.body, deliveryFooter))
    const posted = await postCommentWithRetry(octokit, target, withRunMarker(commentBody), botLogin, logger)
    if (posted === false) {
      return failure('post-failed', 'postComment returned null after retries')
    }
    return {delivered: true, kind: 'comment'}
  }

  // pr-review surface with a structured verdict.
  if (botLogin == null || botLogin.length === 0) {
    return failure('missing-target-context', 'Cannot submit a review: bot login is unavailable')
  }

  const reviewEvent = parsed.verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES'

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

  // Reviews are NOT idempotent (unlike comments, there is no marker-based
  // find-and-update path) — a create that fails ambiguously (GitHub records
  // the review but the client sees a network error) risks a duplicate review
  // on retry. Single attempt only; an ambiguous failure fails the run and
  // the operator re-runs rather than the harness silently retrying.
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
    const detail = error instanceof Error ? error.message : String(error)
    logger.error('Response-post: submitReview failed', {error: detail})
    return failure('post-failed', detail)
  }
}
