/**
 * Agent-specific type definitions for RFC-012.
 *
 * These types are used for agent context collection, prompt construction,
 * reactions/labels management, and OpenCode execution.
 */

/**
 * Context collected from GitHub Actions for agent prompt construction.
 * Extracted from @actions/github event payload via RFC-003 utilities.
 */
export interface AgentContext {
  readonly eventName: string
  readonly repo: string
  readonly ref: string
  readonly actor: string
  readonly runId: string
  readonly issueNumber: number | null
  readonly issueTitle: string | null
  readonly issueType: 'issue' | 'pr' | null
  readonly commentBody: string | null
  readonly commentAuthor: string | null
  readonly commentId: number | null
  readonly defaultBranch: string
}

/**
 * Result of OpenCode CLI execution.
 */
export interface AgentResult {
  readonly success: boolean
  readonly exitCode: number
  readonly duration: number
  readonly sessionId: string | null
  readonly error: string | null
}

/**
 * Context for reaction and label operations.
 */
export interface ReactionContext {
  readonly repo: string
  readonly commentId: number | null
  readonly issueNumber: number | null
  readonly issueType: 'issue' | 'pr' | null
  readonly botLogin: string | null
}

/**
 * Options for building the agent prompt.
 */
export interface PromptOptions {
  readonly context: AgentContext
  readonly customPrompt: string | null
  readonly cacheStatus: 'corrupted' | 'hit' | 'miss'
}

/**
 * State of acknowledgment lifecycle.
 */
export type AcknowledgmentState = 'acknowledged' | 'completed' | 'failed' | 'pending'

/**
 * Working label configuration.
 */
export const WORKING_LABEL = 'agent: working' as const
export const WORKING_LABEL_COLOR = 'fcf2e1' as const
export const WORKING_LABEL_DESCRIPTION = 'Agent is currently working on this' as const
