import type {FilePartInput} from '@opencode-ai/sdk'
import type {LogicalSessionKey, SessionSearchResult, SessionSummary} from '../session/index.js'
import type {ModelConfig, OmoProviders, ResolvedOutputMode, TokenUsage} from '../shared/types.js'

export type {OutputMode, ResolvedOutputMode} from '../shared/types.js'

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

export interface ContextBudget {
  readonly maxComments: number
  readonly maxCommits: number
  readonly maxFiles: number
  readonly maxReviews: number
  readonly maxBodyBytes: number
  readonly maxTotalBytes: number
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxComments: 50,
  maxCommits: 100,
  maxFiles: 100,
  maxReviews: 100,
  maxBodyBytes: 10 * 1024,
  maxTotalBytes: 100 * 1024,
} as const

export interface ContextComment {
  readonly id: string
  readonly author: string | null
  readonly body: string
  readonly createdAt: string
  readonly authorAssociation: string
  readonly isMinimized: boolean
}

export interface ContextLabel {
  readonly name: string
  readonly color?: string
}

export interface ContextAssignee {
  readonly login: string
}

export interface ContextCommit {
  readonly oid: string
  readonly message: string
  readonly author: string | null
}

export interface ContextFile {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  readonly status?: string
}

export interface ContextReviewComment {
  readonly id: string
  readonly author: string | null
  readonly body: string
  readonly path: string
  readonly line: number | null
  readonly createdAt: string
}

export interface ContextReview {
  readonly author: string | null
  readonly state: string
  readonly body: string
  readonly createdAt: string
  readonly comments: readonly ContextReviewComment[]
}

export interface IssueContext {
  readonly type: 'issue'
  readonly number: number
  readonly title: string
  readonly body: string
  readonly bodyTruncated: boolean
  readonly state: string
  readonly author: string | null
  readonly createdAt: string
  readonly labels: readonly ContextLabel[]
  readonly assignees: readonly ContextAssignee[]
  readonly comments: readonly ContextComment[]
  readonly commentsTruncated: boolean
  readonly totalComments: number
}

export interface PullRequestContext {
  readonly type: 'pull_request'
  readonly number: number
  readonly title: string
  readonly body: string
  readonly bodyTruncated: boolean
  readonly state: string
  readonly author: string | null
  readonly createdAt: string
  readonly baseBranch: string
  readonly headBranch: string
  readonly isFork: boolean
  readonly labels: readonly ContextLabel[]
  readonly assignees: readonly ContextAssignee[]
  readonly comments: readonly ContextComment[]
  readonly commentsTruncated: boolean
  readonly totalComments: number
  readonly commits: readonly ContextCommit[]
  readonly commitsTruncated: boolean
  readonly totalCommits: number
  readonly files: readonly ContextFile[]
  readonly filesTruncated: boolean
  readonly totalFiles: number
  readonly reviews: readonly ContextReview[]
  readonly reviewsTruncated: boolean
  readonly totalReviews: number
  readonly authorAssociation: string
  readonly requestedReviewers: readonly string[]
  readonly requestedReviewerTeams: readonly string[]
}

export type HydratedContext = IssueContext | PullRequestContext

export interface TriggerTarget {
  readonly kind: 'discussion' | 'issue' | 'manual' | 'pr'
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly locked: boolean
  readonly isDraft?: boolean
  readonly requestedReviewerLogin?: string
  readonly requestedTeamSlug?: string
  readonly requestedReviewerLogins?: readonly string[]
  readonly path?: string
  readonly line?: number
  readonly diffHunk?: string
  readonly commitId?: string
}

export interface ParsedCommand {
  readonly raw: string
  readonly action: string | null
  readonly args: string
}

export interface TriggerContext {
  readonly eventType: EventType
  readonly eventName: string
  readonly repo: {readonly owner: string; readonly repo: string}
  readonly ref: string
  readonly sha: string
  readonly runId: number
  readonly actor: string
  readonly action: string | null
  readonly author: {
    readonly login: string
    readonly association: string
    readonly isBot: boolean
  } | null
  readonly target: TriggerTarget | null
  readonly commentBody: string | null
  readonly commentId: number | null
  readonly hasMention: boolean
  readonly command: ParsedCommand | null
  readonly isBotReviewRequested: boolean
  readonly raw: unknown
}

export const ERROR_TYPES = [
  'api_error',
  'configuration',
  'internal',
  'llm_fetch_error',
  'llm_timeout',
  'permission',
  'rate_limit',
  'validation',
] as const

export type ErrorType = (typeof ERROR_TYPES)[number]

export interface ErrorInfo {
  readonly type: ErrorType
  readonly message: string
  readonly details?: string
  readonly suggestedAction?: string
  readonly retryable: boolean
  readonly resetTime?: Date
}

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

export interface ReactionContext {
  readonly repo: string
  readonly commentId: number | null
  readonly issueNumber: number | null
  readonly issueType: 'issue' | 'pr' | null
  readonly botLogin: string | null
}

export interface SessionContext {
  readonly recentSessions: readonly SessionSummary[]
  readonly priorWorkContext: readonly SessionSearchResult[]
}

export interface PromptOptions {
  readonly context: AgentContext
  readonly customPrompt: string | null
  readonly cacheStatus: 'corrupted' | 'hit' | 'miss'
  readonly sessionContext?: SessionContext
  readonly logicalKey?: LogicalSessionKey | null
  readonly isContinuation?: boolean
  readonly currentThreadSessionId?: string | null
  readonly sessionId?: string
  readonly triggerContext?: TriggerContext
  readonly resolvedOutputMode?: ResolvedOutputMode | null
  readonly fileParts?: readonly FilePartInput[]
}

export interface ReferenceFile {
  readonly filename: string
  readonly content: string
}

export interface PromptResult {
  readonly text: string
  readonly referenceFiles: readonly ReferenceFile[]
}

export interface DiffContext {
  readonly changedFiles: number
  readonly additions: number
  readonly deletions: number
  readonly truncated: boolean
  readonly files: readonly DiffFileSummary[]
}

export interface DiffFileSummary {
  readonly filename: string
  readonly status: string
  readonly additions: number
  readonly deletions: number
}

export type AcknowledgmentState = 'acknowledged' | 'completed' | 'failed' | 'pending'

export const WORKING_LABEL = 'agent: working' as const
export const WORKING_LABEL_COLOR = 'fcf2e1' as const
export const WORKING_LABEL_DESCRIPTION = 'Agent is currently working on this' as const

export interface ExecutionConfig {
  readonly agent: string
  readonly model: ModelConfig | null
  readonly timeoutMs: number
  readonly omoProviders: OmoProviders
  readonly continueSessionId?: string
  readonly sessionTitle?: string
}

export interface EnsureOpenCodeResult {
  readonly path: string
  readonly version: string
  readonly didSetup: boolean
}
