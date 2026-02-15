/**
 * Agent-specific type definitions for RFC-012, RFC-013, and RFC-014.
 *
 * These types are used for agent context collection, prompt construction,
 * reactions/labels management, and OpenCode execution.
 */

import type {FilePartInput} from '@opencode-ai/sdk'
import type {ErrorInfo} from '../comments/types.js'
import type {HydratedContext} from '../context/types.js'
import type {SessionSearchResult, SessionSummary} from '../session/types.js'
import type {TriggerContext} from '../triggers/types.js'
import type {ModelConfig, TokenUsage} from '../types.js'

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
  readonly diffContext: DiffContext | null
  readonly hydratedContext: HydratedContext | null
  readonly authorAssociation: string | null
  readonly isRequestedReviewer: boolean
}

/**
 * Result of OpenCode SDK execution.
 */
export interface AgentResult {
  readonly success: boolean
  readonly exitCode: number
  readonly duration: number
  readonly sessionId: string | null
  readonly error: string | null
  readonly tokenUsage: TokenUsage | null
  readonly model: string | null
  readonly cost: number | null
  readonly prsCreated: readonly string[]
  readonly commitsCreated: readonly string[]
  readonly commentsPosted: number
  readonly llmError: ErrorInfo | null
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
 * Session context for prompt building (RFC-004 integration).
 * Provides prior session metadata and relevant search results.
 */
export interface SessionContext {
  readonly recentSessions: readonly SessionSummary[]
  readonly priorWorkContext: readonly SessionSearchResult[]
}

/**
 * Options for building the agent prompt.
 */
export interface PromptOptions {
  readonly context: AgentContext
  readonly customPrompt: string | null
  readonly cacheStatus: 'corrupted' | 'hit' | 'miss'
  readonly sessionContext?: SessionContext
  readonly sessionId?: string
  readonly triggerContext?: TriggerContext
  readonly fileParts?: readonly FilePartInput[]
}

/**
 * PR diff context for review (RFC-009 integration).
 * Provides summarized diff information for the agent prompt.
 */
export interface DiffContext {
  readonly changedFiles: number
  readonly additions: number
  readonly deletions: number
  readonly truncated: boolean
  readonly files: readonly DiffFileSummary[]
}

/**
 * Summary of a changed file for prompt context.
 */
export interface DiffFileSummary {
  readonly filename: string
  readonly status: string
  readonly additions: number
  readonly deletions: number
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

/**
 * Execution configuration for SDK mode (RFC-013).
 * Passed from parsed action inputs to executeOpenCode.
 */
export interface ExecutionConfig {
  readonly agent: string
  readonly model: ModelConfig | null
  readonly timeoutMs: number
}

export interface EnsureOpenCodeResult {
  readonly path: string
  readonly version: string
  readonly didSetup: boolean
}
