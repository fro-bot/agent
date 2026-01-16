/**
 * Trigger Types for GitHub Event Handling (RFC-005)
 *
 * Defines the type system for event routing and trigger classification.
 * Works alongside github/context.ts utilities, not replacing them.
 */

import type {EventType, GitHubContext} from '../github/types.js'

/**
 * Author information extracted from the triggering event.
 */
export interface AuthorInfo {
  /** GitHub login of the comment author */
  readonly login: string
  /** Author's association with the repository (OWNER, MEMBER, COLLABORATOR, etc.) */
  readonly association: string
  /** Whether the author is a bot account */
  readonly isBot: boolean
}

/**
 * Target of the trigger (issue, PR, discussion, or manual dispatch).
 */
export interface TriggerTarget {
  /** Type of target */
  readonly kind: 'discussion' | 'issue' | 'manual' | 'pr'
  /** Issue/PR/Discussion number */
  readonly number: number
  /** Title of the issue/PR/discussion */
  readonly title: string
  /** Body content (may be null) */
  readonly body: string | null
  /** Whether the target is locked */
  readonly locked: boolean
  /** Whether the PR is a draft (pull_request only) */
  readonly isDraft?: boolean
  /** File path for review comments (pull_request_review_comment only) */
  readonly path?: string
  /** Line number for review comments (pull_request_review_comment only) */
  readonly line?: number
  /** Diff hunk for review comments (pull_request_review_comment only) */
  readonly diffHunk?: string
  /** Commit ID for review comments (pull_request_review_comment only) */
  readonly commitId?: string
}

/**
 * Parsed command from bot mention.
 */
export interface ParsedCommand {
  /** Raw command text after the mention */
  readonly raw: string
  /** First word of the command (the action) */
  readonly action: string | null
  /** Arguments after the action */
  readonly args: string
}

/**
 * Full context for a trigger event.
 * Built by routeEvent() from GitHubContext.
 */
export interface TriggerContext {
  /** Classified event type */
  readonly eventType: EventType
  /** Original GitHub event name */
  readonly eventName: string
  /** Repository owner and name */
  readonly repo: {readonly owner: string; readonly repo: string}
  /** Git ref (branch/tag) */
  readonly ref: string
  /** Commit SHA */
  readonly sha: string
  /** Workflow run ID */
  readonly runId: number
  /** Actor who triggered the event */
  readonly actor: string
  /** Author of the comment (if applicable) */
  readonly author: AuthorInfo | null
  /** Target of the trigger */
  readonly target: TriggerTarget | null
  /** Comment body (if applicable) */
  readonly commentBody: string | null
  /** Comment ID (if applicable) */
  readonly commentId: number | null
  /** Whether the bot was mentioned in the comment */
  readonly hasMention: boolean
  /** Parsed command from the mention (if any) */
  readonly command: ParsedCommand | null
  /** Original GitHub context for advanced use */
  readonly raw: GitHubContext
}

/**
 * Reasons why a trigger should be skipped.
 */
export const SKIP_REASONS = [
  'action_not_created',
  'action_not_supported',
  'draft_pr',
  'issue_locked',
  'no_mention',
  'prompt_required',
  'self_comment',
  'unauthorized_author',
  'unsupported_event',
] as const

export type SkipReason = (typeof SKIP_REASONS)[number]

/**
 * Result of trigger routing - discriminated union.
 * When shouldProcess is false, skipReason and skipMessage are guaranteed non-null.
 */
export type TriggerResult = TriggerResultProcess | TriggerResultSkip

interface TriggerResultBase {
  /** Trigger context (always provided for debugging) */
  readonly context: TriggerContext
}

export interface TriggerResultProcess extends TriggerResultBase {
  /** Event should be processed */
  readonly shouldProcess: true
}

export interface TriggerResultSkip extends TriggerResultBase {
  /** Event should be skipped */
  readonly shouldProcess: false
  /** Reason for skipping */
  readonly skipReason: SkipReason
  /** Human-readable skip message */
  readonly skipMessage: string
}

/**
 * Configuration for trigger routing.
 */
export interface TriggerConfig {
  /** Actor login from the event (used for mention detection and bot filtering) */
  readonly login: string | null
  /** Whether to require bot mention for issue_comment events */
  readonly requireMention: boolean
  /** Allowed author associations for processing */
  readonly allowedAssociations: readonly string[]
  /** Whether to skip draft PRs (default: true) */
  readonly skipDraftPRs: boolean
  /** Prompt input for schedule/workflow_dispatch triggers */
  readonly promptInput: string | null
}

/**
 * Default allowed author associations.
 * Only repo owners, members, and collaborators can trigger the agent.
 */
export const ALLOWED_ASSOCIATIONS = ['COLLABORATOR', 'MEMBER', 'OWNER'] as const

/**
 * Default trigger configuration.
 */
export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  login: null,
  requireMention: true,
  allowedAssociations: ALLOWED_ASSOCIATIONS,
  skipDraftPRs: true,
  promptInput: null,
} as const
