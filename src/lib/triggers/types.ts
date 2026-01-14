/**
 * Trigger Types for GitHub Event Handling (RFC-005)
 *
 * Defines the type system for event routing and trigger classification.
 * Works alongside github/context.ts utilities, not replacing them.
 */

import type {GitHubContext} from '../github/types.js'

/**
 * Supported trigger types for agent activation.
 * Maps from GitHub event names to processable trigger categories.
 *
 * - 'issue_comment': Comment on issue or PR (via issue_comment event)
 * - 'discussion_comment': Comment on discussion (via discussion_comment event)
 * - 'workflow_dispatch': Manual workflow trigger
 * - 'unsupported': Event type not handled by this action
 */
export const TRIGGER_TYPES = ['issue_comment', 'discussion_comment', 'workflow_dispatch', 'unsupported'] as const

export type TriggerType = (typeof TRIGGER_TYPES)[number]

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
  /** Classified trigger type */
  readonly triggerType: TriggerType
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
  'issue_locked',
  'no_mention',
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
  /** Bot login name (without [bot] suffix) */
  readonly botLogin: string | null
  /** Whether to require bot mention for issue_comment events */
  readonly requireMention: boolean
  /** Allowed author associations for processing */
  readonly allowedAssociations: readonly string[]
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
  botLogin: null,
  requireMention: true,
  allowedAssociations: ALLOWED_ASSOCIATIONS,
} as const
