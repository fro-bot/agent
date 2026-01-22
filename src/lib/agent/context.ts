/**
 * GitHub context collection for agent prompt construction.
 *
 * Uses RFC-003 utilities (parseGitHubContext, getCommentTarget, etc.)
 * to extract all context from the GitHub Actions event payload.
 */

import type {IssueCommentEvent} from '@octokit/webhooks-types'
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
import {getCommentAuthor, getCommentTarget, parseGitHubContext} from '../github/context.js'
import {collectDiffContext} from './diff-context.js'

export interface CollectAgentContextOptions {
  readonly logger: Logger
  readonly octokit: Octokit
  readonly triggerContext: TriggerContext
}

/**
 * Collect GitHub context from @actions/github event payload.
 *
 * Uses RFC-003 utilities to extract all context from the GitHub Actions
 * event payload. No workflow-level environment variables needed for
 * comment/issue data.
 */
export async function collectAgentContext(options: CollectAgentContextOptions): Promise<AgentContext> {
  const {logger, octokit, triggerContext} = options
  const ghContext = parseGitHubContext(logger)
  const repo = `${ghContext.repo.owner}/${ghContext.repo.repo}`

  const target = getCommentTarget(ghContext)
  const issueType: 'issue' | 'pr' | null = target?.type === 'issue' || target?.type === 'pr' ? target.type : null

  let commentBody: string | null = null
  let commentAuthor: string | null = null
  let commentId: number | null = null
  let issueTitle: string | null = null

  if (ghContext.eventType === 'issue_comment') {
    const payload = ghContext.payload as IssueCommentEvent
    commentBody = payload.comment.body
    commentAuthor = getCommentAuthor(payload)
    commentId = payload.comment.id
    issueTitle = payload.issue.title
  }

  const diffContext = await collectDiffContext(triggerContext, octokit, repo, logger)

  const hydratedContext = await hydrateContext(
    octokit,
    ghContext.repo.owner,
    ghContext.repo.repo,
    target?.number ?? null,
    issueType,
    logger,
  )

  logger.info('Collected agent context', {
    eventName: ghContext.eventName,
    repo,
    issueNumber: target?.number ?? null,
    issueType,
    hasComment: commentBody != null,
    hasDiffContext: diffContext != null,
    hasHydratedContext: hydratedContext != null,
  })

  return {
    eventName: ghContext.eventName,
    repo,
    ref: ghContext.ref,
    actor: ghContext.actor,
    runId: String(ghContext.runId),
    issueNumber: target?.number ?? null,
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
