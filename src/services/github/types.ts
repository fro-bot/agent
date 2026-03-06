import type {GitHub} from '@actions/github/lib/utils'

export type Octokit = InstanceType<typeof GitHub>

// Context types
/**
 * Supported event types for agent activation.
 * Maps from GitHub event names to processable event categories.
 *
 * - 'issue_comment': Comment on issue or PR (via issue_comment event)
 * - 'discussion_comment': Comment on discussion (via discussion or discussion_comment event)
 * - 'issues': Issue opened or edited
 * - 'pull_request': PR opened, synchronized, or reopened
 * - 'pull_request_review_comment': Review comment on PR
 * - 'schedule': Cron-triggered workflow run
 * - 'workflow_dispatch': Manual workflow trigger
 * - 'unsupported': Event type not handled by this action
 */
export const EVENT_TYPES = [
  'discussion_comment',
  'issue_comment',
  'issues',
  'pull_request',
  'pull_request_review_comment',
  'schedule',
  'unsupported',
  'workflow_dispatch',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

// Normalized event data (discriminated union by eventType)
export type NormalizedEvent =
  | NormalizedIssueCommentEvent
  | NormalizedDiscussionCommentEvent
  | NormalizedIssuesEvent
  | NormalizedPullRequestEvent
  | NormalizedPullRequestReviewCommentEvent
  | NormalizedWorkflowDispatchEvent
  | NormalizedScheduleEvent
  | NormalizedUnsupportedEvent

export interface NormalizedIssueCommentEvent {
  readonly type: 'issue_comment'
  readonly action: string
  readonly issue: {
    readonly number: number
    readonly title: string
    readonly body: string | null
    readonly locked: boolean
    readonly isPullRequest: boolean
  }
  readonly comment: {
    readonly id: number
    readonly body: string
    readonly author: string
    readonly authorAssociation: string
  }
}

export interface NormalizedDiscussionCommentEvent {
  readonly type: 'discussion_comment'
  readonly action: string
  readonly discussion: {
    readonly number: number
    readonly title: string
    readonly body: string | null
    readonly locked: boolean
  }
  readonly comment: {
    readonly id: number
    readonly body: string | null
    readonly author: string
    readonly authorAssociation: string
  }
}

export interface NormalizedIssuesEvent {
  readonly type: 'issues'
  readonly action: string
  readonly issue: {
    readonly number: number
    readonly title: string
    readonly body: string | null
    readonly locked: boolean
    readonly authorAssociation: string
  }
  readonly sender: {
    readonly login: string
  }
}

export interface NormalizedPullRequestEvent {
  readonly type: 'pull_request'
  readonly action: string
  readonly pullRequest: {
    readonly number: number
    readonly title: string
    readonly body: string | null
    readonly locked: boolean
    readonly draft: boolean
    readonly authorAssociation: string
  }
  readonly sender: {
    readonly login: string
  }
}

export interface NormalizedPullRequestReviewCommentEvent {
  readonly type: 'pull_request_review_comment'
  readonly action: string
  readonly pullRequest: {
    readonly number: number
    readonly title: string
    readonly locked: boolean
  }
  readonly comment: {
    readonly id: number
    readonly body: string
    readonly author: string
    readonly authorAssociation: string
    readonly path: string
    readonly line: number | null
    readonly diffHunk: string
    readonly commitId: string
  }
}

export interface NormalizedWorkflowDispatchEvent {
  readonly type: 'workflow_dispatch'
  readonly inputs: {
    readonly prompt?: string
  }
}

export interface NormalizedScheduleEvent {
  readonly type: 'schedule'
  readonly schedule?: string
}

export interface NormalizedUnsupportedEvent {
  readonly type: 'unsupported'
}

export interface GitHubContext {
  readonly eventName: string
  readonly eventType: EventType
  readonly repo: {readonly owner: string; readonly repo: string}
  readonly ref: string
  readonly sha: string
  readonly runId: number
  readonly actor: string
  readonly payload: unknown
  readonly event: NormalizedEvent
}

// Comment types
export interface CommentTarget {
  readonly type: 'discussion' | 'issue' | 'pr'
  readonly number: number
  readonly owner: string
  readonly repo: string
}

export interface Comment {
  readonly id: number
  readonly body: string
  readonly author: string
  readonly authorAssociation: string
  readonly createdAt: string
  readonly updatedAt: string
}

// Bot identification
export const BOT_COMMENT_MARKER = '<!-- fro-bot-agent -->' as const
