/**
 * GitHub context collection for agent prompt construction.
 *
 * Uses TriggerContext (built by router.ts) which already has extracted
 * comment data, author info, and target info. Avoids duplicating parsing.
 */

import type {HydratedContext} from '../context/types.js'
import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {TriggerContext} from '../triggers/types.js'
import type {AgentContext} from './types.js'
import {
  DEFAULT_CONTEXT_BUDGET,
  fallbackIssueContext,
  fallbackPullRequestContext,
  hydrateIssueContext,
  hydratePullRequestContext,
} from '../context/index.js'
import {getDefaultBranch} from '../github/api.js'
import {collectDiffContext} from './diff-context.js'

export interface CollectAgentContextOptions {
  readonly logger: Logger
  readonly octokit: Octokit
  readonly triggerContext: TriggerContext
}

/**
 * Collect GitHub context from TriggerContext.
 *
 * TriggerContext is built by router.ts and contains all extracted data:
 * - commentBody, commentId from payload
 * - author.login for comment author
 * - target.title for issue title
 * - target.kind for issue type
 *
 * This function augments that with hydrated context and diff context.
 */
export async function collectAgentContext(options: CollectAgentContextOptions): Promise<AgentContext> {
  const {logger, octokit, triggerContext} = options
  const {repo: repoInfo, ref, actor, runId, target, author, commentBody, commentId} = triggerContext
  const repo = `${repoInfo.owner}/${repoInfo.repo}`

  const issueType = target?.kind === 'issue' || target?.kind === 'pr' ? target.kind : null
  const issueNumber = target?.number ?? null
  const issueTitle = target?.title ?? null
  const commentAuthor = author?.login ?? null

  const diffContext = await collectDiffContext(triggerContext, octokit, repo, logger)

  const hydratedContext = await hydrateContext(octokit, repoInfo.owner, repoInfo.repo, issueNumber, issueType, logger)

  logger.info('Collected agent context', {
    eventName: triggerContext.eventName,
    repo,
    issueNumber,
    issueType,
    hasComment: commentBody != null,
    hasDiffContext: diffContext != null,
    hasHydratedContext: hydratedContext != null,
  })

  return {
    eventName: triggerContext.eventName,
    repo,
    ref,
    actor,
    runId: String(runId),
    issueNumber,
    issueTitle,
    issueType,
    commentBody,
    commentAuthor,
    commentId,
    defaultBranch: await getDefaultBranch(octokit, repo, logger),
    diffContext,
    hydratedContext,
  }
}

async function hydrateContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number | null,
  issueType: 'issue' | 'pr' | null,
  logger: Logger,
): Promise<HydratedContext | null> {
  if (number == null || issueType == null) {
    return null
  }

  const budget = DEFAULT_CONTEXT_BUDGET

  if (issueType === 'issue') {
    const context = await hydrateIssueContext(octokit, owner, repo, number, budget, logger)
    if (context != null) {
      return context
    }
    return fallbackIssueContext(octokit, owner, repo, number, budget, logger)
  }

  const context = await hydratePullRequestContext(octokit, owner, repo, number, budget, logger)
  if (context != null) {
    return context
  }
  return fallbackPullRequestContext(octokit, owner, repo, number, budget, logger)
}
