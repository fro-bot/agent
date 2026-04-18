import type {MetricsCollector} from '../../features/observability/index.js'
import type {CommentSummaryOptions} from '../../features/observability/types.js'
import type {CommentTarget} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {ExecutePhaseResult} from './execute.js'
import type {RoutingPhaseResult} from './routing.js'
import * as core from '@actions/core'
import {formatErrorComment, postComment} from '../../features/comments/index.js'
import {writeJobSummary} from '../../features/observability/index.js'
import {createLogger} from '../../shared/logger.js'
import {setActionOutputs} from '../config/outputs.js'

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
    resolvedOutputMode: null,
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
    agent: bootstrap.inputs.agent,
  }
  await writeJobSummary(summaryOptions, logger)

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

  const [repoOwner, repoName] = routing.agentContext.repo.split('/')
  const targetType =
    routing.triggerResult.context.eventType === 'discussion_comment'
      ? 'discussion'
      : routing.agentContext.issueType === 'pr'
        ? 'pr'
        : 'issue'

  const commentTarget: CommentTarget = {
    type: targetType,
    number: routing.agentContext.issueNumber ?? 0,
    owner: repoOwner ?? '',
    repo: repoName ?? '',
  }

  if (commentTarget.number > 0 && commentTarget.owner.length > 0 && commentTarget.repo.length > 0) {
    const errorCommentBody = formatErrorComment(execution.llmError)
    const commentLogger = createLogger({phase: 'error-comment'})
    const commentResult = await postComment(
      routing.githubClient,
      commentTarget,
      {body: errorCommentBody},
      commentLogger,
    )

    if (commentResult == null) {
      commentLogger.warning('Failed to post LLM error comment')
    } else {
      commentLogger.info('Posted LLM error comment', {commentUrl: commentResult.url})
      metrics.incrementComments()
    }
  } else {
    logger.warning('Cannot post error comment: missing target context')
  }

  return 0
}
