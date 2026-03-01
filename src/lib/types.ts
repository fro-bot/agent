import type {Result} from '@bfra.me/es/result'

// Re-export Result type and helpers for convenience
export type {Err, Ok, Result} from '@bfra.me/es/result'
export {err, isErr, isOk, ok} from '@bfra.me/es/result'

// Agent identity for cache scoping
export type AgentIdentity = 'discord' | 'github'

// Cache restore result
export interface CacheResult {
  readonly hit: boolean
  readonly key: string | null
  readonly restoredPath: string | null
  readonly corrupted: boolean
}

// Run context from GitHub Actions
export interface RunContext {
  readonly eventName: string
  readonly repo: string
  readonly ref: string
  readonly runId: number
  readonly actor: string
  readonly agentIdentity: AgentIdentity
}

// Author association for permission gating
export const ALLOWED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const
export type AuthorAssociation = (typeof ALLOWED_ASSOCIATIONS)[number]

// Session pruning configuration
export interface PruningConfig {
  readonly maxSessions: number
  readonly maxAgeDays: number
}

// Model configuration for SDK execution (RFC-013)
export interface ModelConfig {
  readonly providerID: string
  readonly modelID: string
}

// Action inputs (parsed and validated) - per RFC-001, RFC-013
export interface ActionInputs {
  readonly githubToken: string
  readonly authJson: string
  readonly prompt: string | null
  readonly sessionRetention: number
  readonly s3Backup: boolean
  readonly s3Bucket: string | null
  readonly awsRegion: string | null
  // RFC-013: SDK execution configuration
  readonly agent: string
  readonly model: ModelConfig | null
  readonly timeoutMs: number
  // Setup consolidation: auto-setup inputs
  readonly opencodeVersion: string
  readonly skipCache: boolean
  readonly omoVersion: string
  // oMo provider configuration
  readonly omoProviders: OmoProviders
  // OpenCode config to merge with baseline
  readonly opencodeConfig: string | null
}

// oMo provider configuration for installer
export interface OmoProviders {
  readonly claude: 'no' | 'yes' | 'max20'
  readonly copilot: 'no' | 'yes'
  readonly gemini: 'no' | 'yes'
  readonly openai: 'no' | 'yes'
  readonly opencodeZen: 'no' | 'yes'
  readonly zaiCodingPlan: 'no' | 'yes'
}

// Action outputs
export interface ActionOutputs {
  readonly sessionId: string | null
  readonly cacheStatus: 'corrupted' | 'hit' | 'miss'
  readonly duration: number
}

// Token usage tracking (matches OpenCode SDK structure)
export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: {
    readonly read: number
    readonly write: number
  }
}

// Run summary for session writeback (RFC-004)
export interface RunSummary {
  readonly eventType: string
  readonly repo: string
  readonly ref: string
  readonly runId: number
  readonly cacheStatus: 'corrupted' | 'hit' | 'miss'
  readonly sessionIds: readonly string[]
  readonly createdPRs: readonly string[]
  readonly createdCommits: readonly string[]
  readonly duration: number
  readonly tokenUsage: TokenUsage | null
}

// Validation result type aliases for common use cases
export type ValidationResult<T> = Result<T, Error>
export type ParseResult<T> = Result<T, Error>
