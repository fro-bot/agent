import type {TokenUsage} from '../types.js'

export interface ErrorRecord {
  readonly timestamp: string
  readonly type: string
  readonly message: string
  readonly recoverable: boolean
}

export interface RunMetrics {
  readonly startTime: number
  readonly endTime: number | null
  readonly duration: number | null
  readonly cacheStatus: 'hit' | 'miss' | 'corrupted'
  readonly sessionsUsed: readonly string[]
  readonly sessionsCreated: readonly string[]
  readonly prsCreated: readonly string[]
  readonly commitsCreated: readonly string[]
  readonly commentsPosted: number
  readonly tokenUsage: TokenUsage | null
  readonly model: string | null
  readonly cost: number | null
  readonly errors: readonly ErrorRecord[]
}

export interface CommentSummaryOptions {
  readonly eventType: string
  readonly repo: string
  readonly ref: string
  readonly runId: number
  readonly runUrl: string
  readonly metrics: RunMetrics
  readonly agent: string
}
