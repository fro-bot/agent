import type {TokenUsage} from '../types.js'
import type {ErrorRecord, RunMetrics} from './types.js'

export interface MetricsCollector {
  start: () => void
  end: () => void
  setCacheStatus: (status: 'hit' | 'miss' | 'corrupted') => void
  addSessionUsed: (sessionId: string) => void
  addSessionCreated: (sessionId: string) => void
  addPRCreated: (prUrl: string) => void
  addCommitCreated: (sha: string) => void
  incrementComments: () => void
  setTokenUsage: (usage: TokenUsage, model: string | null, cost: number | null) => void
  recordError: (type: string, message: string, recoverable: boolean) => void
  getMetrics: () => RunMetrics
}

/**
 * Create a metrics collector for tracking agent execution statistics.
 *
 * Uses closure-based approach instead of ES6 classes per project conventions.
 * Tracks timing, cache status, sessions, artifacts, token usage, and errors.
 * Call getMetrics() to retrieve an immutable snapshot of current metrics.
 */
export function createMetricsCollector(): MetricsCollector {
  let startTime = 0
  let endTime: number | null = null
  let cacheStatus: 'hit' | 'miss' | 'corrupted' = 'miss'
  const sessionsUsed: string[] = []
  const sessionsCreated: string[] = []
  const prsCreated: string[] = []
  const commitsCreated: string[] = []
  let commentsPosted = 0
  let tokenUsage: TokenUsage | null = null
  let model: string | null = null
  let cost: number | null = null
  const errors: ErrorRecord[] = []

  return {
    start(): void {
      startTime = Date.now()
    },

    end(): void {
      endTime = Date.now()
    },

    setCacheStatus(status: 'hit' | 'miss' | 'corrupted'): void {
      cacheStatus = status
    },

    addSessionUsed(sessionId: string): void {
      if (!sessionsUsed.includes(sessionId)) {
        sessionsUsed.push(sessionId)
      }
    },

    addSessionCreated(sessionId: string): void {
      if (!sessionsCreated.includes(sessionId)) {
        sessionsCreated.push(sessionId)
      }
    },

    addPRCreated(prUrl: string): void {
      if (!prsCreated.includes(prUrl)) {
        prsCreated.push(prUrl)
      }
    },

    addCommitCreated(sha: string): void {
      if (!commitsCreated.includes(sha)) {
        commitsCreated.push(sha)
      }
    },

    incrementComments(): void {
      commentsPosted++
    },

    setTokenUsage(usage: TokenUsage, modelId: string | null, costValue: number | null): void {
      tokenUsage = usage
      model = modelId
      cost = costValue
    },

    recordError(type: string, message: string, recoverable: boolean): void {
      errors.push({
        timestamp: new Date().toISOString(),
        type,
        message,
        recoverable,
      })
    },

    getMetrics(): RunMetrics {
      const duration = endTime == null ? Date.now() - startTime : endTime - startTime

      return Object.freeze({
        startTime,
        endTime,
        duration,
        cacheStatus,
        sessionsUsed: Object.freeze([...sessionsUsed]),
        sessionsCreated: Object.freeze([...sessionsCreated]),
        prsCreated: Object.freeze([...prsCreated]),
        commitsCreated: Object.freeze([...commitsCreated]),
        commentsPosted,
        tokenUsage,
        model,
        cost,
        errors: Object.freeze([...errors]),
      })
    },
  }
}
