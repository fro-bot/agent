import type {
  DiscussionCommentEvent,
  IssueCommentEvent,
  IssuesEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  WorkflowDispatchEvent,
} from '@octokit/webhooks-types'
import type {Logger} from '../logger.js'
import type {CommentTarget, EventType, GitHubContext, NormalizedEvent} from './types.js'
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

export function normalizeEvent(eventType: EventType, payload: unknown): NormalizedEvent {
  switch (eventType) {
    case 'issue_comment': {
      const p = payload as IssueCommentEvent
      return {
        type: 'issue_comment',
        action: p.action,
        issue: {
          number: p.issue.number,
          title: p.issue.title,
          body: p.issue.body ?? null,
          locked: p.issue.locked ?? false,
          isPullRequest: p.issue.pull_request != null,
        },
        comment: {
          id: p.comment.id,
          body: p.comment.body,
          author: p.comment.user.login,
          authorAssociation: p.comment.author_association ?? 'NONE',
        },
      }
    }

    case 'discussion_comment': {
      const p = payload as DiscussionCommentEvent
      return {
        type: 'discussion_comment',
        action: p.action,
        discussion: {
          number: p.discussion.number,
          title: p.discussion.title,
          body: p.discussion.body ?? null,
          locked: p.discussion.locked ?? false,
        },
        comment: {
          id: p.comment.id,
          body: p.comment.body ?? null,
          author: p.comment.user.login,
          authorAssociation: p.comment.author_association ?? 'NONE',
        },
      }
    }

    case 'issues': {
      const p = payload as IssuesEvent
      return {
        type: 'issues',
        action: p.action,
        issue: {
          number: p.issue.number,
          title: p.issue.title,
          body: p.issue.body ?? null,
          locked: p.issue.locked ?? false,
          authorAssociation: p.issue.author_association ?? 'NONE',
        },
        sender: {
          login: p.sender.login,
        },
      }
    }

    case 'pull_request': {
      const p = payload as PullRequestEvent
      return {
        type: 'pull_request',
        action: p.action,
        pullRequest: {
          number: p.pull_request.number,
          title: p.pull_request.title,
          body: p.pull_request.body ?? null,
          locked: p.pull_request.locked ?? false,
          draft: p.pull_request.draft ?? false,
          authorAssociation: p.pull_request.author_association ?? 'NONE',
        },
        sender: {
          login: p.sender.login,
        },
      }
    }

    case 'pull_request_review_comment': {
      const p = payload as PullRequestReviewCommentEvent
      return {
        type: 'pull_request_review_comment',
        action: p.action,
        pullRequest: {
          number: p.pull_request.number,
          title: p.pull_request.title,
          locked: p.pull_request.locked ?? false,
        },
        comment: {
          id: p.comment.id,
          body: p.comment.body,
          author: p.comment.user.login,
          authorAssociation: p.comment.author_association,
          path: p.comment.path,
          line: p.comment.line ?? null,
          diffHunk: p.comment.diff_hunk,
          commitId: p.comment.commit_id,
        },
      }
    }

    case 'workflow_dispatch': {
      const p = payload as WorkflowDispatchEvent
      return {
        type: 'workflow_dispatch',
        inputs: {
          prompt: (p.inputs?.prompt as string | undefined) ?? undefined,
        },
      }
    }

    case 'schedule': {
      const p = payload as {schedule?: string}
      return {
        type: 'schedule',
        schedule: p.schedule ?? undefined,
      }
    }

    case 'unsupported':
      return {
        type: 'unsupported',
      }
  }
}

/**
 * Parse GitHub Actions context into typed structure.
 */
export function parseGitHubContext(logger: Logger): GitHubContext {
  const ctx = github.context

  const eventType = classifyEventType(ctx.eventName)
  const event = normalizeEvent(eventType, ctx.payload)

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
    event,
  }
}

/**
 * Determine if the issue_comment is on a PR or issue.
 */
export function isPullRequest(event: NormalizedEvent): boolean {
  return event.type === 'issue_comment' && event.issue.isPullRequest
}

/**
 * Extract comment target from payload.
 */
export function getCommentTarget(context: GitHubContext): CommentTarget | null {
  const {event, repo} = context

  if (event.type === 'issue_comment') {
    return {
      type: event.issue.isPullRequest ? 'pr' : 'issue',
      number: event.issue.number,
      owner: repo.owner,
      repo: repo.repo,
    }
  }

  if (event.type === 'discussion_comment') {
    return {
      type: 'discussion',
      number: event.discussion.number,
      owner: repo.owner,
      repo: repo.repo,
    }
  }

  return null
}
