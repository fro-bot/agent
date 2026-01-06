/**
 * Session management types matching OpenCode's storage format.
 *
 * @see https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/index.ts
 */

export type {Logger} from '../logger.js'

/**
 * OpenCode Session.Info - matches the actual schema from OpenCode source.
 */
export interface SessionInfo {
  readonly id: string
  readonly version: string
  readonly projectID: string
  readonly directory: string
  readonly parentID?: string
  readonly title: string
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly compacting?: number
    readonly archived?: number
  }
  readonly summary?: {
    readonly additions: number
    readonly deletions: number
    readonly files: number
    readonly diffs?: readonly FileDiff[]
  }
  readonly share?: {
    readonly url: string
  }
  readonly permission?: PermissionRuleset
  readonly revert?: {
    readonly messageID: string
    readonly partID?: string
    readonly snapshot?: string
    readonly diff?: string
  }
}

/**
 * OpenCode MessageV2.User - user message schema
 */
export interface UserMessage {
  readonly id: string
  readonly sessionID: string
  readonly role: 'user'
  readonly time: {
    readonly created: number
  }
  readonly summary?: {
    readonly title?: string
    readonly body?: string
    readonly diffs: readonly FileDiff[]
  }
  readonly agent: string
  readonly model: {
    readonly providerID: string
    readonly modelID: string
  }
  readonly system?: string
  readonly tools?: Record<string, boolean>
  readonly variant?: string
}

/**
 * OpenCode MessageV2.Assistant - assistant message schema
 */
export interface AssistantMessage {
  readonly id: string
  readonly sessionID: string
  readonly role: 'assistant'
  readonly time: {
    readonly created: number
    readonly completed?: number
  }
  readonly parentID: string
  readonly modelID: string
  readonly providerID: string
  readonly mode: string
  readonly agent: string
  readonly path: {
    readonly cwd: string
    readonly root: string
  }
  readonly summary?: boolean
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: {
      readonly read: number
      readonly write: number
    }
  }
  readonly finish?: string
  readonly error?: MessageError
}

export type Message = UserMessage | AssistantMessage

/**
 * OpenCode MessageV2.Part - base interface for message content parts
 */
export interface PartBase {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
}

export interface TextPart extends PartBase {
  readonly type: 'text'
  readonly text: string
  readonly synthetic?: boolean
  readonly ignored?: boolean
  readonly time?: {
    readonly start: number
    readonly end?: number
  }
  readonly metadata?: Record<string, unknown>
}

export interface ToolPart extends PartBase {
  readonly type: 'tool'
  readonly callID: string
  readonly tool: string
  readonly state: ToolState
  readonly metadata?: Record<string, unknown>
}

export interface ToolStateCompleted {
  readonly status: 'completed'
  readonly input: Record<string, unknown>
  readonly output: string
  readonly title: string
  readonly metadata: Record<string, unknown>
  readonly time: {
    readonly start: number
    readonly end: number
    readonly compacted?: number
  }
  readonly attachments?: readonly FilePart[]
}

export interface ToolStatePending {
  readonly status: 'pending'
}

export interface ToolStateRunning {
  readonly status: 'running'
  readonly input: Record<string, unknown>
  readonly time: {readonly start: number}
}

export interface ToolStateError {
  readonly status: 'error'
  readonly input: Record<string, unknown>
  readonly error: string
  readonly time: {readonly start: number; readonly end: number}
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export interface ReasoningPart extends PartBase {
  readonly type: 'reasoning'
  readonly reasoning: string
  readonly time?: {
    readonly start: number
    readonly end?: number
  }
}

export interface StepFinishPart extends PartBase {
  readonly type: 'step-finish'
  readonly reason: string
  readonly snapshot?: string
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: {
      readonly read: number
      readonly write: number
    }
  }
}

export type Part = TextPart | ToolPart | ReasoningPart | StepFinishPart

/**
 * OpenCode Project metadata
 */
export interface ProjectInfo {
  readonly id: string
  readonly worktree: string
  readonly vcs: 'git' | string
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly initialized?: number
  }
}

/**
 * Todo item (stored in todo/{sessionID}.json)
 */
export interface TodoItem {
  readonly id: string
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  readonly priority: 'high' | 'medium' | 'low'
}

/**
 * Simplified session summary for RFC-004 operations
 */
export interface SessionSummary {
  readonly id: string
  readonly projectID: string
  readonly directory: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly messageCount: number
  readonly agents: readonly string[]
  readonly isChild: boolean
}

/**
 * Session search result
 */
export interface SessionSearchResult {
  readonly sessionId: string
  readonly matches: readonly SessionMatch[]
}

/**
 * Individual match within a session
 */
export interface SessionMatch {
  readonly messageId: string
  readonly partId: string
  readonly excerpt: string
  readonly role: 'user' | 'assistant'
  readonly agent?: string
}

/**
 * Result of session pruning operation
 */
export interface PruneResult {
  readonly prunedCount: number
  readonly prunedSessionIds: readonly string[]
  readonly remainingCount: number
  readonly freedBytes: number
}

/**
 * Configuration for session pruning
 */
export interface PruningConfig {
  readonly maxSessions: number
  readonly maxAgeDays: number
}

// Supporting types

export interface FileDiff {
  readonly file: string
  readonly additions: number
  readonly deletions: number
}

export interface FilePart extends PartBase {
  readonly type: 'file'
  readonly file: string
  readonly content: string
}

export interface PermissionRuleset {
  readonly rules: readonly unknown[]
}

export interface MessageError {
  readonly name: string
  readonly message: string
}
