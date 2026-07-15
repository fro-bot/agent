import type {MetricsCollector} from '../../features/observability/index.js'
import type {CommentSummaryOptions} from '../../features/observability/types.js'
import type {CommentTarget} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {ExecutePhaseResult} from './execute.js'
import type {RoutingPhaseResult} from './routing.js'
import * as core from '@actions/core'
import {createQuotaExceededError} from '@fro-bot/runtime'
import {runResponsePost} from '../../features/agent/response-post.js'
import {formatErrorComment, postComment} from '../../features/comments/index.js'
import {writeJobSummary} from '../../features/observability/index.js'
import {createLogger} from '../../shared/logger.js'
import {setActionOutputs} from '../config/outputs.js'

/**
 * Fixed, non-retryable guidance surfaced via `core.setFailed` for quota
 * exhaustion. Never includes raw provider/incoming message text.
 */
const QUOTA_EXCEEDED_SET_FAILED_MESSAGE =
  'Agent execution stopped: provider quota exceeded. Check the provider account/billing settings, wait for the quota to reset, or switch to a different model or provider.'

/** Resolve the event-bound comment target (issue, PR, or discussion) shared by all error-comment paths. */
function resolveCommentTarget(routing: RoutingPhaseResult): CommentTarget {
  const [repoOwner, repoName] = routing.agentContext.repo.split('/')
  const targetType =
    routing.triggerResult.context.eventType === 'discussion_comment'
      ? 'discussion'
      : routing.agentContext.issueType === 'pr'
        ? 'pr'
        : 'issue'

  return {
    type: targetType,
    number: routing.agentContext.issueNumber ?? 0,
    owner: repoOwner ?? '',
    repo: repoName ?? '',
  }
}

function isResolvedCommentTarget(target: CommentTarget): boolean {
  return target.number > 0 && target.owner.length > 0 && target.repo.length > 0
}

/** Post a formatted error comment to the resolved target, if any. Never throws. */
async function postErrorComment(
  routing: RoutingPhaseResult,
  commentTarget: CommentTarget,
  errorCommentBody: string,
  metrics: MetricsCollector,
  logger: Logger,
): Promise<void> {
  const commentResult = await postComment(routing.githubClient, commentTarget, {body: errorCommentBody}, logger)

  if (commentResult == null) {
    logger.warning('Failed to post LLM error comment')
  } else {
    logger.info('Posted LLM error comment', {commentUrl: commentResult.url})
    metrics.incrementComments()
  }
}

export async function runFinalize(
  bootstrap: BootstrapPhaseResult,
  routing: RoutingPhaseResult,
  cacheRestore: CacheRestorePhaseResult,
  execution: ExecutePhaseResult,
  metrics: MetricsCollector,
  startTime: number,
  logger: Logger,
): Promise<number> {
  const duration = Date.now() - startTime

  setActionOutputs({
    sessionId: execution.sessionId,
    resolvedOutputMode: execution.resolvedOutputMode,
    cacheStatus: cacheRestore.cacheStatus,
    duration,
  })

  const summaryOptions: CommentSummaryOptions = {
    eventType: routing.agentContext.eventName,
    repo: routing.agentContext.repo,
    ref: routing.agentContext.ref,
    runId: Number(routing.agentContext.runId),
    runUrl: `https://github.com/${routing.agentContext.repo}/actions/runs/${routing.agentContext.runId}`,
    metrics: metrics.getMetrics(),
    agent: bootstrap.inputs.agent ?? 'build (default)',
    resolvedOutputMode: execution.resolvedOutputMode,
  }
  await writeJobSummary(summaryOptions, logger)

  // Rebuilds a safe ErrorInfo instead of trusting the incoming llmError; skips runResponsePost entirely.
  // Posts at most once, only when delivery isn't 'none' and no response was already posted; always fails closed.
  if (execution.llmError?.type === 'quota_exceeded') {
    const commentTarget = resolveCommentTarget(routing)
    const shouldPost =
      bootstrap.delivery !== 'none' && execution.commentsPosted === 0 && isResolvedCommentTarget(commentTarget)

    if (shouldPost) {
      const safeError = createQuotaExceededError({resetTime: execution.llmError.resetTime})
      const errorCommentBody = formatErrorComment(safeError)
      await postErrorComment(routing, commentTarget, errorCommentBody, metrics, logger)
    }

    core.setFailed(QUOTA_EXCEEDED_SET_FAILED_MESSAGE)
    return 1
  }

  // For file-convention delivery, the `execution.success → return 0` early
  // path below is bypassed: the delivery assertion must run regardless of
  // execution.success, otherwise a model that wrote no response file (or
  // wrote a malformed one) would still exit the run green (#1154 class).
  if (bootstrap.delivery === 'file-convention') {
    if (bootstrap.responseFilePath == null) {
      core.setFailed('File-convention delivery is active but no response file path was resolved at bootstrap')
      return 1
    }

    const responsePostLogger = createLogger({phase: 'response-post'})
    const result = await runResponsePost(
      {
        octokit: routing.githubClient,
        agentContext: routing.agentContext,
        triggerResult: routing.triggerResult,
        botLogin: routing.botLogin,
        responseFilePath: bootstrap.responseFilePath,
      },
      responsePostLogger,
    )

    if (result.delivered === false) {
      core.setFailed(
        `Failed to deliver the agent's response from ${bootstrap.responseFilePath}: ${result.reason} — ${result.detail}`,
      )
      return 1
    }

    responsePostLogger.info('Delivered file-convention response', {kind: result.kind})
    metrics.incrementComments()

    // Delivery succeeded, but the underlying execution may still have failed
    // (e.g. the model wrote a valid response file and then the process
    // exited non-zero for an unrelated reason). Preserve that failure rather
    // than always returning 0.
    if (execution.success === false) {
      if (execution.llmError == null) {
        core.setFailed(`Agent execution failed with exit code ${execution.exitCode}`)
        return execution.exitCode
      }

      // Recoverable LLM error, but the response was already delivered above —
      // posting a second error comment would violate the one-response-per-run
      // invariant. Log and return success; the delivered response wins.
      logger.info('Agent failed with recoverable LLM error, but a response was already delivered', {
        error: execution.llmError.message,
        type: execution.llmError.type,
        durationMs: duration,
      })
      return 0
    }

    logger.info('Agent run completed successfully', {durationMs: duration})
    return 0
  }

  if (execution.success) {
    logger.info('Agent run completed successfully', {durationMs: duration})
    return 0
  }

  if (execution.llmError == null) {
    core.setFailed(`Agent execution failed with exit code ${execution.exitCode}`)
    return execution.exitCode
  }

  logger.info('Agent failed with recoverable LLM error', {
    error: execution.llmError.message,
    type: execution.llmError.type,
    durationMs: duration,
  })

  const commentTarget = resolveCommentTarget(routing)

  if (isResolvedCommentTarget(commentTarget)) {
    const errorCommentBody = formatErrorComment(execution.llmError)
    await postErrorComment(routing, commentTarget, errorCommentBody, metrics, logger)
  } else {
    logger.warning('Cannot post error comment: missing target context')
  }

  return 0
}
