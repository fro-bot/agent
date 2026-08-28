import type {BrokeredPushFailureClass, BrokeredPushOutcome} from '../../features/delegated/brokered-push.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {CommentSummaryOptions} from '../../features/observability/types.js'
import type {CommentTarget} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {ExecutePhaseResult} from './execute.js'
import type {RoutingPhaseResult} from './routing.js'
import * as path from 'node:path'
import process from 'node:process'
import * as core from '@actions/core'
import {createErrorInfo, createProviderAuthError, createQuotaExceededError} from '@fro-bot/runtime'
import {readAndParseResponseFile, runResponsePost} from '../../features/agent/response-post.js'
import {formatErrorComment, postComment} from '../../features/comments/index.js'
import {runBrokeredPush} from '../../features/delegated/brokered-push.js'
import {writeJobSummary} from '../../features/observability/index.js'
import {createExecAdapter} from '../../services/setup/adapters.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createLogger} from '../../shared/logger.js'
import {setActionOutputs} from '../config/outputs.js'

/**
 * Fixed, non-retryable guidance surfaced via `core.setFailed` for quota
 * exhaustion. Never includes raw provider/incoming message text.
 */
const QUOTA_EXCEEDED_SET_FAILED_MESSAGE =
  'Agent execution stopped: provider quota exceeded. Check the provider account/billing settings, wait for the quota to reset, or switch to a different model or provider.'

const PROVIDER_AUTH_SET_FAILED_MESSAGE =
  'Agent execution stopped: model provider authentication failed. Check the model provider credentials and configuration, then try again.'

const FILE_READ_FAILURE_FALLBACK_ACTION =
  'The agent execution failed before it could write a response artifact, so no response was delivered.'
const FILE_READ_FAILURE_AFTER_SUCCESS_ACTION =
  'The agent execution completed, but the response artifact was not found at the expected path, so no response was delivered.'

const BROKERED_PUSH_ERROR_ACTION = 'Review the workflow logs and retry the run.'
const MAX_FOOTER_PATHS = 50
const MAX_BROKERED_PUSH_ERROR_PATHS = 10
/** Keep brokered delivery below the job ceiling and bound reconstruction even when Git cannot observe AbortSignal. */
export const BROKERED_PUSH_TIMEOUT_MS = 120_000
const BROKERED_PUSH_TIMEOUT_REASON = 'brokered push exceeded time budget'

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

function formatFileReadFailureFallback(executionSucceeded: boolean): string {
  return executionSucceeded === true ? FILE_READ_FAILURE_AFTER_SUCCESS_ACTION : FILE_READ_FAILURE_FALLBACK_ACTION
}

function failWithPrimaryExecutionError(execution: ExecutePhaseResult): number {
  const failureMessage =
    execution.error != null && execution.error.length > 0
      ? `Agent execution failed: ${execution.error}`
      : `Agent execution failed with exit code ${execution.exitCode}`
  core.setFailed(failureMessage)
  return execution.exitCode
}

const BROKERED_PUSH_FAILURE_MESSAGES: Readonly<Record<BrokeredPushFailureClass, string>> = {
  validation: 'Brokered push failure (validation): a changed file path is outside the brokered-push allowlist.',
  reconstruction: 'Brokered push failure (reconstruction): the changed files could not be reconstructed.',
  'moved-head': 'Brokered push failure (moved-head): the pull request head moved during delivery.',
  identity: 'Brokered push failure (identity): the pull request identity changed during delivery.',
  permission: 'Brokered push failure (permission): the brokered-push permission check failed.',
  commit: 'Brokered push failure (commit): the commit could not be created.',
  timeout: 'Brokered push failure (timeout): delivery exceeded its time budget.',
  unknown: 'Brokered push failure (unknown): delivery failed before the cause could be classified.',
}

function createBrokeredPushError(failureClass: BrokeredPushFailureClass) {
  return createErrorInfo('internal', BROKERED_PUSH_FAILURE_MESSAGES[failureClass], false, {
    suggestedAction: BROKERED_PUSH_ERROR_ACTION,
  })
}

function toRepoRelativeBrokeredPushPath(value: string): string {
  const normalizedValue = value.replaceAll('\\', '/').replaceAll('\n', ' ').replaceAll('\r', ' ')
  const workspace = (process.env.GITHUB_WORKSPACE ?? process.cwd()).replaceAll('\\', '/').replace(/\/+$/, '')

  if (normalizedValue === workspace) return '.'
  if (normalizedValue.startsWith(`${workspace}/`)) return normalizedValue.slice(workspace.length + 1)

  return normalizedValue.replace(/^\/+/, '').replace(/^\.\//, '')
}

function sanitizeBrokeredPushPath(value: string): string {
  return toRepoRelativeBrokeredPushPath(value).replaceAll('`', '').replaceAll('~', '')
}

function formatBrokeredPushError(outcome: Extract<BrokeredPushOutcome, {readonly kind: 'fail-loud'}>): string {
  const errorComment = formatErrorComment(createBrokeredPushError(outcome.failureClass))
  if (outcome.failureClass !== 'validation' || outcome.paths == null || outcome.paths.length === 0) {
    return errorComment
  }

  const visiblePaths = outcome.paths.slice(0, MAX_BROKERED_PUSH_ERROR_PATHS).map(sanitizeBrokeredPushPath)
  const remainingPathCount = outcome.paths.length - visiblePaths.length
  const pathSummary = remainingPathCount > 0 ? `\n… and ${remainingPathCount} more` : ''

  return `${errorComment}\n\nOffending paths:\n\`\`\`\n${visiblePaths.join('\n')}\n\`\`\`${pathSummary}`
}

function createUnknownBrokeredPushOutcome(error: unknown): Extract<BrokeredPushOutcome, {readonly kind: 'fail-loud'}> {
  return {kind: 'fail-loud', failureClass: 'unknown', reason: toErrorMessage(error)}
}

function escapeFooterCode(value: string): string {
  return value.replaceAll('`', '\\`').replaceAll('\n', ' ').replaceAll('\r', ' ')
}

function formatBrokeredPushFooter(outcome: Extract<BrokeredPushOutcome, {readonly kind: 'pushed'}>): string {
  const visiblePaths = outcome.paths.slice(0, MAX_FOOTER_PATHS).map(path => `\`${escapeFooterCode(path)}\``)
  const remainingPathCount = outcome.paths.length - visiblePaths.length
  const pathSummary =
    remainingPathCount > 0 ? `${visiblePaths.join(', ')}, … (+${remainingPathCount} more)` : visiblePaths.join(', ')

  return [
    '### Brokered push delivered',
    `- Branch: \`${escapeFooterCode(outcome.branch)}\``,
    `- Changed paths: ${pathSummary}`,
    `- Commit: \`${escapeFooterCode(outcome.commit.sha.slice(0, 7))}\``,
  ].join('\n')
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
    outputModeMigration: execution.outputModeMigration,
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
  if (execution.overflowRecovery?.recovered === true) {
    core.summary.addRaw(
      `Recovered from context overflow (fresh review session; archived ${execution.overflowRecovery.archivedSessionId})\n`,
    )
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
    } else if (
      bootstrap.delivery !== 'none' &&
      execution.commentsPosted === 0 &&
      !isResolvedCommentTarget(commentTarget)
    ) {
      logger.warning('Cannot post quota exceeded error comment: missing target context')
    }

    core.setFailed(QUOTA_EXCEEDED_SET_FAILED_MESSAGE)
    return 1
  }

  // Rebuilds a safe ErrorInfo instead of trusting the incoming llmError; skips runResponsePost entirely.
  // Posts at most once, only when delivery isn't 'none' and no response was already posted; always fails closed.
  if (execution.llmError?.type === 'provider_auth_error') {
    const commentTarget = resolveCommentTarget(routing)
    const shouldPost =
      bootstrap.delivery !== 'none' && execution.commentsPosted === 0 && isResolvedCommentTarget(commentTarget)

    if (shouldPost) {
      const safeError = createProviderAuthError()
      const errorCommentBody = formatErrorComment(safeError)
      await postErrorComment(routing, commentTarget, errorCommentBody, metrics, logger)
    } else if (
      bootstrap.delivery !== 'none' &&
      execution.commentsPosted === 0 &&
      !isResolvedCommentTarget(commentTarget)
    ) {
      logger.warning('Cannot post provider authentication error comment: missing target context')
    }

    core.setFailed(PROVIDER_AUTH_SET_FAILED_MESSAGE)
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
    const responseFileParams = {
      agentContext: routing.agentContext,
      triggerResult: routing.triggerResult,
      responseFilePath: bootstrap.responseFilePath,
      responseFilePathCandidates: bootstrap.responseFilePathCandidates ?? undefined,
      executionSucceeded: execution.success,
    }
    const responsePrecheck = await readAndParseResponseFile(responseFileParams, responsePostLogger)
    let result: Awaited<ReturnType<typeof runResponsePost>>

    if ('success' in responsePrecheck === false) {
      result = responsePrecheck
    } else {
      let deliveryFooter: string | undefined
      if (execution.success === true && execution.commentsPosted === 0) {
        const triggerContext = routing.triggerResult.context
        const [owner = '', repo = ''] = routing.agentContext.repo.split('/')
        const eventFacts = {
          eventType: triggerContext.eventType,
          isPullRequest: routing.agentContext.issueType === 'pr',
          authorAssociation: triggerContext.author?.association ?? '',
          commentAuthor: triggerContext.author?.login ?? '',
          issueNumber: routing.agentContext.issueNumber ?? 0,
          owner,
          repo,
        }
        const expectedHeadBranch =
          routing.agentContext.hydratedContext?.type === 'pull_request'
            ? routing.agentContext.hydratedContext.headBranch
            : ''
        const controller = new AbortController()
        let timeout: ReturnType<typeof setTimeout> | undefined

        try {
          // Wall-clock ceiling on the whole brokered-push. The signal aborts the
          // octokit calls promptly; the git subprocess in reconstruction cannot
          // observe an AbortSignal (@actions/exec has no signal option), so this
          // race is the hard bound for a stalled subprocess. The losing promise
          // is abandoned but never leaks: main.ts exits via process.exit(exitCode)
          // once run() resolves, which terminates any still-live git child.
          const brokeredPushPromise = Promise.resolve()
            .then(async () =>
              runBrokeredPush({
                octokit: routing.githubClient,
                execAdapter: createExecAdapter(),
                logger,
                eventFacts,
                trustedHeadSha: bootstrap.trustedHeadSha,
                expectedHeadBranch,
                repoRoot: process.env.GITHUB_WORKSPACE ?? process.cwd(),
                extraPathPrefixes: bootstrap.inputs.brokeredPushExtraPaths,
                signal: controller.signal,
              }),
            )
            .catch(createUnknownBrokeredPushOutcome)

          const brokeredPush = await Promise.race<BrokeredPushOutcome>([
            brokeredPushPromise,
            // This branch only ever resolves (to fail-loud), never rejects — a
            // load-bearing invariant: the brokered-push promise above also normalizes
            // synchronous throws and rejected promises, so the race can never reject
            // and the abandoned losing promise cannot surface as an unhandled rejection.
            new Promise<BrokeredPushOutcome>(resolve => {
              timeout = setTimeout(() => {
                controller.abort()
                resolve({kind: 'fail-loud', failureClass: 'timeout', reason: BROKERED_PUSH_TIMEOUT_REASON})
              }, BROKERED_PUSH_TIMEOUT_MS)
            }),
          ])

          if (brokeredPush.kind === 'fail-loud') {
            // A timeout that fires after updateRef already landed server-side reports
            // failure for a commit that may exist on the branch — the same accepted
            // non-atomic property as the pushed/response-post ordering below. A re-run
            // reconstructs the updated branch to nothing-to-deliver, so it self-heals.
            const commentTarget = resolveCommentTarget(routing)
            if (execution.commentsPosted === 0 && isResolvedCommentTarget(commentTarget)) {
              const safeError = formatBrokeredPushError(brokeredPush)
              await postErrorComment(routing, commentTarget, safeError, metrics, logger)
            } else if (execution.commentsPosted === 0 && !isResolvedCommentTarget(commentTarget)) {
              logger.warning('Cannot post brokered push failure comment: missing target context')
            }

            core.setFailed(`Brokered push delivery failed: ${brokeredPush.reason}`)
            return 1
          }

          if (brokeredPush.kind === 'pushed') {
            // Intentional ordering: the commit is pushed before runResponsePost. The
            // commit is the substantive delivery; if response-post later fails the run
            // still exits non-zero, and a re-run reconstructs a clean workspace to
            // nothing-to-deliver rather than double-pushing. Do not reorder to post first.
            deliveryFooter = formatBrokeredPushFooter(brokeredPush)
          }
        } finally {
          if (timeout != null) {
            clearTimeout(timeout)
          }
        }
      }

      const responsePostParams = {
        octokit: routing.githubClient,
        agentContext: routing.agentContext,
        triggerResult: routing.triggerResult,
        botLogin: routing.botLogin,
        responseFilePath: bootstrap.responseFilePath,
        responseFilePathCandidates: bootstrap.responseFilePathCandidates ?? undefined,
        ...(deliveryFooter == null ? {} : {deliveryFooter}),
      }

      result = await runResponsePost(responsePostParams, responsePostLogger)
    }

    if (result.delivered === false) {
      if (result.reason === 'file-read-failed') {
        if (execution.success === false && execution.commentsPosted === 0) {
          const commentTarget = resolveCommentTarget(routing)
          if (isResolvedCommentTarget(commentTarget)) {
            await postErrorComment(routing, commentTarget, formatFileReadFailureFallback(false), metrics, logger)
          } else {
            logger.warning('Cannot post missing-response fallback comment: missing target context')
          }

          return failWithPrimaryExecutionError(execution)
        }

        if (execution.success === true) {
          core.setFailed(formatFileReadFailureFallback(true))
          return 1
        }
      }

      core.setFailed(
        `Failed to deliver the agent's response from ${path.dirname(bootstrap.responseFilePath)}: ${result.reason} — ${result.detail}`,
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
    core.setFailed(
      'Agent execution failed with a recoverable LLM error, and no delivery surface was available to report it.',
    )
    return execution.exitCode === 0 ? 1 : execution.exitCode
  }

  return 0
}
