import type {IssueCommentEvent} from '@octokit/webhooks-types'
import type {Logger} from '../logger.js'
import type {CommentTarget, EventType, GitHubContext} from './types.js'
import * as github from '@actions/github'

/**
 * Classify event name into simplified type.
 */
export function classifyEventType(eventName: string): EventType {
  switch (eventName) {
    case 'issue_comment':
      return 'issue_comment'
    case 'discussion':
    case 'discussion_comment':
      return 'discussion_comment'
    case 'workflow_dispatch':
      return 'workflow_dispatch'
    case 'issues':
      return 'issues'
    case 'pull_request':
      return 'pull_request'
    case 'pull_request_review_comment':
      return 'pull_request_review_comment'
    case 'schedule':
      return 'schedule'
    default:
      return 'unsupported'
  }
}

/**
 * Parse GitHub Actions context into typed structure.
 */
export function parseGitHubContext(logger: Logger): GitHubContext {
  const ctx = github.context

  const eventType = classifyEventType(ctx.eventName)

  logger.debug('Parsed GitHub context', {
    eventName: ctx.eventName,
    eventType,
    repo: `${ctx.repo.owner}/${ctx.repo.repo}`,
  })

  return {
    eventName: ctx.eventName,
    eventType,
    repo: ctx.repo,
    ref: ctx.ref,
    sha: ctx.sha,
    runId: ctx.runId,
    actor: ctx.actor,
    payload: ctx.payload,
  }
}

/**
 * Determine if the issue_comment is on a PR or issue.
 */
export function isPullRequest(payload: IssueCommentEvent): boolean {
  return payload.issue.pull_request != null
}

/**
 * Extract comment target from payload.
 */
export function getCommentTarget(context: GitHubContext): CommentTarget | null {
  const {eventType, payload, repo} = context

  if (eventType === 'issue_comment') {
    const p = payload as IssueCommentEvent
    return {
      type: isPullRequest(p) ? 'pr' : 'issue',
      number: p.issue.number,
      owner: repo.owner,
      repo: repo.repo,
    }
  }

  if (eventType === 'discussion_comment') {
    // Discussion handling requires GraphQL - implemented in RFC-008
    return null
  }

  return null
}

/**
 * Get author association from comment payload.
 */
export function getAuthorAssociation(payload: IssueCommentEvent): string {
  return payload.comment.author_association
}

/**
 * Get comment author login.
 */
export function getCommentAuthor(payload: IssueCommentEvent): string {
  return payload.comment.user.login
}

/**
 * Check if issue/PR is locked.
 */
export function isIssueLocked(payload: IssueCommentEvent): boolean {
  return payload.issue.locked
}
