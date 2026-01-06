/**
 * GitHub context collection for agent prompt construction.
 *
 * Uses RFC-003 utilities (parseGitHubContext, getCommentTarget, etc.)
 * to extract all context from the GitHub Actions event payload.
 */

import type {IssueCommentPayload} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {AgentContext} from './types.js'
import * as exec from '@actions/exec'
import {getCommentAuthor, getCommentTarget, parseGitHubContext} from '../github/context.js'

/**
 * Collect GitHub context from @actions/github event payload.
 *
 * Uses RFC-003 utilities to extract all context from the GitHub Actions
 * event payload. No workflow-level environment variables needed for
 * comment/issue data.
 */
export function collectAgentContext(logger: Logger): AgentContext {
  const ghContext = parseGitHubContext(logger)
  const repo = `${ghContext.repo.owner}/${ghContext.repo.repo}`

  // Extract comment target (issue/PR number and type)
  const target = getCommentTarget(ghContext)

  // Map target type to issue/pr (discussions are handled separately)
  const issueType: 'issue' | 'pr' | null = target?.type === 'issue' || target?.type === 'pr' ? target.type : null

  // Extract comment details from payload (for issue_comment events)
  let commentBody: string | null = null
  let commentAuthor: string | null = null
  let commentId: number | null = null
  let issueTitle: string | null = null

  if (ghContext.eventType === 'issue_comment') {
    const payload = ghContext.payload as IssueCommentPayload
    commentBody = payload.comment.body
    commentAuthor = getCommentAuthor(payload)
    commentId = payload.comment.id
    issueTitle = payload.issue.title
  }

  logger.info('Collected agent context', {
    eventName: ghContext.eventName,
    repo,
    issueNumber: target?.number ?? null,
    issueType,
    hasComment: commentBody != null,
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
    defaultBranch: 'main', // Will be fetched via gh CLI if needed
  }
}

/**
 * Fetch repository default branch via gh CLI.
 * Called separately to avoid blocking context collection.
 */
export async function fetchDefaultBranch(repo: string, logger: Logger): Promise<string> {
  try {
    const {stdout} = await exec.getExecOutput('gh', ['api', `/repos/${repo}`, '--jq', '.default_branch'], {
      silent: true,
    })
    return stdout.trim() || 'main'
  } catch (error) {
    logger.warning('Failed to fetch default branch', {
      error: error instanceof Error ? error.message : String(error),
    })
    return 'main'
  }
}
