/**
 * The turn model's input vocabulary: what OpenCode's hooks and bus events become before the model sees them. Types only.
 * `record-observations.ts` produces these from real payloads; `turn-model.ts` consumes them.
 */

/** A provider or tool error, reduced to what a span may carry. The message is raw content: it is scrubbed on export. */
export interface ErrorInfo {
  readonly type: string
  readonly message?: string | undefined
  readonly status?: number | undefined
}

/** OpenCode's token split: `input` excludes cache reads, `output` excludes reasoning. Mapped to the convention later. */
export interface Usage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type RequestKind = 'primary' | 'compaction' | 'title' | 'generate'
export type InboxItemKind = 'user' | 'synthetic' | 'compaction' | 'other'
export type ExecutionOutcome = 'succeeded' | 'failed' | 'interrupted'

interface ObservationBase {
  /** Epoch milliseconds. Hooks carry the plugin's receive time, events carry their own `created`. */
  readonly at: number
  /** Approximate size of the content this observation carries, for the buffer bound. */
  readonly bytes?: number | undefined
}

export type Observation = ObservationBase &
  (
    | {
        readonly kind: 'prompt'
        readonly sessionId: string
        readonly messageId: string
        readonly delivery?: string | undefined
        readonly content?: unknown
      }
    | {
        readonly kind: 'inbox.enqueued'
        readonly sessionId: string
        readonly inboxId: string
        readonly item: InboxItemKind
        /** A subagent report: the child it reports on, and its state (`running` is not final). */
        readonly childSessionId?: string | undefined
        readonly reportState?: string | undefined
      }
    | {readonly kind: 'inbox.delivered'; readonly sessionId: string; readonly inboxId: string}
    | {
        readonly kind: 'session.created'
        readonly sessionId: string
        readonly parentSessionId?: string | undefined
        readonly agent?: string | undefined
      }
    | {readonly kind: 'execution.started'; readonly sessionId: string}
    | {
        readonly kind: 'execution.ended'
        readonly sessionId: string
        readonly outcome: ExecutionOutcome
        readonly reason?: string | undefined
        readonly error?: ErrorInfo | undefined
      }
    | {
        readonly kind: 'request'
        readonly sessionId: string
        readonly requestKind: RequestKind
        readonly agent?: string | undefined
        readonly model?: string | undefined
        readonly provider?: string | undefined
        readonly content?: unknown
      }
    | {
        readonly kind: 'retry'
        readonly sessionId: string
        /** The attempt number the NEXT request will carry. */
        readonly attempt: number
        readonly willRetry: boolean
        readonly error: ErrorInfo
      }
    | {
        readonly kind: 'step.started'
        readonly sessionId: string
        readonly messageId: string
        readonly agent?: string | undefined
        readonly model?: string | undefined
        readonly provider?: string | undefined
      }
    | {
        readonly kind: 'step.ended'
        readonly sessionId: string
        readonly messageId: string
        readonly finish?: string | undefined
        readonly rawFinish?: string | undefined
        readonly usage?: Usage | undefined
        readonly cost?: number | undefined
      }
    | {
        readonly kind: 'step.failed'
        readonly sessionId: string
        readonly messageId: string
        readonly error: ErrorInfo
        readonly usage?: Usage | undefined
      }
    | {
        readonly kind: 'output'
        readonly sessionId: string
        readonly messageId: string
        readonly part: 'text' | 'reasoning'
        readonly text: string
      }
    | {
        readonly kind: 'tool.before'
        readonly sessionId: string
        readonly callId: string
        readonly tool: string
        /** The step (assistant message) whose model response asked for this call. */
        readonly messageId?: string | undefined
        readonly agent?: string | undefined
        readonly input?: unknown
      }
    | {
        readonly kind: 'tool.after'
        readonly sessionId: string
        readonly callId: string
        readonly tool: string
        readonly status: 'completed' | 'error'
        readonly result?: unknown
        readonly error?: unknown
        readonly interrupted?: boolean | undefined
        readonly childSessionId?: string | undefined
      }
    | {
        readonly kind: 'tool.ended'
        readonly sessionId: string
        readonly callId: string
        readonly succeeded: boolean
        readonly errorType?: string | undefined
        readonly message?: string | undefined
        /** The tool cut its own output (not the plugin's truncation). */
        readonly truncated?: boolean | undefined
        readonly childSessionId?: string | undefined
      }
    | {
        readonly kind: 'compaction.started'
        readonly sessionId: string
        readonly reason?: string | undefined
        readonly inputId?: string | undefined
      }
    | {
        readonly kind: 'compaction.ended'
        readonly sessionId: string
        readonly ok: boolean
        readonly text?: string | undefined
        readonly usage?: Usage | undefined
        readonly cost?: number | undefined
        readonly error?: ErrorInfo | undefined
      }
    | {readonly kind: 'title'; readonly sessionId: string; readonly title: string}
    | {readonly kind: 'usage'; readonly sessionId: string}
    | {readonly kind: 'tick'}
  )
