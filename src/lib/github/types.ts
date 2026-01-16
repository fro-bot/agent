import type {GitHub} from '@actions/github/lib/utils'

export type Octokit = InstanceType<typeof GitHub>

// Event payloads
export interface IssueCommentPayload {
  readonly action: string
  readonly issue: {
    readonly number: number
    readonly title: string
    readonly body: string | null
    readonly state: string
    readonly user: {readonly login: string}
    readonly pull_request?: {readonly url: string}
    readonly locked: boolean
  }
  readonly comment: {
    readonly id: number
    readonly body: string
    readonly user: {readonly login: string}
    readonly author_association: string
  }
  readonly repository: {
    readonly owner: {readonly login: string}
    readonly name: string
    readonly full_name: string
  }
  readonly sender: {readonly login: string}
}

export interface DiscussionCommentPayload {
  readonly action: string
  readonly discussion: {
    readonly number: number
    readonly title: string
    readonly body: string
    readonly category: {readonly name: string}
  }
  readonly comment?: {
    readonly id: number
    readonly body: string
    readonly user: {readonly login: string}
    readonly author_association: string
  }
  readonly repository: {
    readonly owner: {readonly login: string}
    readonly name: string
  }
}

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

export interface GitHubContext {
  readonly eventName: string
  readonly eventType: EventType
  readonly repo: {readonly owner: string; readonly repo: string}
  readonly ref: string
  readonly sha: string
  readonly runId: number
  readonly actor: string
  readonly payload: unknown
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
