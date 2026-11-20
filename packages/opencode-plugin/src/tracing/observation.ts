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
  /**
   * The pipeline's inbox was full of raw text, so this observation's text was replaced by its structure: the model records
   * that the content is missing and does not invent any. Set only by the pipeline, at ingress.
   */
  readonly omitted?: boolean | undefined
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
        /** `session.tool.input.started`: the call's name, known before the call itself. */
        readonly kind: 'tool.named'
        readonly sessionId: string
        readonly callId: string
        readonly tool: string
      }
    | {
        /**
         * `session.tool.called`: the call is published, before any local execution (v2.3.2 `step.ts`: "A local execution
         * starts only after its Tool.Called publication completes"). This opens the tool span. A provider-executed call
         * (`executed`) never reaches the local path, so it has no before or after hook.
         */
        readonly kind: 'tool.called'
        readonly sessionId: string
        readonly callId: string
        /** The step (assistant message) whose response asked for this call. */
        readonly messageId?: string | undefined
        readonly executed: boolean
        /** A snapshot of the model's arguments. */
        readonly input?: unknown
      }
    | {
        /** The `execute.before` hook. Adds the agent and the arguments the tool will receive; never opens a span. */
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
        /** The provider ran the tool, not this server. */
        readonly executed?: boolean | undefined
        /** A snapshot of the success event's content: what the model saw. The `execute.after` hook's result wins when it fired. */
        readonly result?: unknown
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
    /**
     * Not an event of OpenCode: the pipeline lost an observation (its inbox was full, it was malformed, the model failed on it)
     * and tells the model so, in its place in the sequence. `sessionIds` undefined means it cannot say whose it was: every session.
     */
    | {readonly kind: 'loss'; readonly sessionIds: readonly string[] | undefined; readonly reason: string}
  )
