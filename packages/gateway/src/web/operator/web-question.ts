/**
 * Web question transport.
 *
 * Registers each pending agent question in the question registry and fans out
 * an SSE `question` frame so a web operator can see and answer it. The question
 * analog of `web-approval.ts`; this module only exports a factory. Wiring it
 * into run transport selection belongs to the run-launch units.
 *
 * ### register-before-fan-out
 *
 * The registry entry is registered BEFORE the SSE frame is emitted, so an
 * answer can settle even if the frame is dropped. The registry is the
 * authoritative fail-closed gate; the frame is advisory.
 *
 * ### fail-soft observation
 *
 * `observeQuestion` throwing never escapes the pending hook: the failure is
 * logged with ids and an error name only, and swallowed. The registration
 * already happened and the deadline still skips the question.
 *
 * ### untrusted text
 *
 * Question and answer text is untrusted plain text. It is bounded and
 * control-stripped into the frame by `toQuestionRequestDetail` and appears
 * nowhere else here — log calls carry request ids, run ids, and reason codes
 * only, never text and never a raw error message.
 */

import type {QuestionPromptInput, QuestionRegistry, QuestionSideEffects} from '../../approvals/question-registry.js'
import type {QuestionFrameData} from '../../operator-contract/question-frame.js'
import type {OperatorLogger} from '../server.js'
import {toQuestionRequestDetail} from '../../approvals/question-detail.js'
import {normalizeQuestion} from '../../approvals/question-registry.js'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A pending question as the run's question parser reports it. */
export interface WebQuestionRequest {
  readonly requestID: string
  readonly sessionID: string
  readonly questions: readonly QuestionPromptInput[]
}

/**
 * Per-run context supplied by the run engine; the question analog of
 * `ApprovalTransportContext`. The engine owns the registry, the human-wait
 * deadline derived from the remaining run budget, and the reply/reject
 * effects.
 */
export interface WebQuestionTransportContext {
  /** Program-scoped question registry. The transport calls `register()` and `attachMessage()` here. */
  readonly questionRegistry: Pick<QuestionRegistry, 'register' | 'attachMessage'>
  /** Stable UUID for this run; the registry scope for web runs and the SSE fan-out key. */
  readonly runId: string
  /** `owner/repo` for logging and correlation. */
  readonly repo: string
  /** Human-wait deadline in ms; must be positive (the registry refuses otherwise). */
  readonly questionDeadlineMs: number
  /** Reply/reject effects injected by the engine. */
  readonly effects: QuestionSideEffects
}

export interface WebQuestionTransportDeps {
  /**
   * Fan-out for question frames. Same shape as the per-run observer wired for
   * approvals. Fail-soft: a throw is logged and swallowed.
   */
  readonly observeQuestion: (runId: string, data: QuestionFrameData) => void
  readonly logger: OperatorLogger
}

/** What the engine calls when a question is pending, mirroring the approval `onPending`. */
export type WebQuestionOnPending = (request: WebQuestionRequest) => void

export type WebQuestionOnPendingFactory = (context: WebQuestionTransportContext) => WebQuestionOnPending

// ---------------------------------------------------------------------------
// createWebQuestionOnPending
// ---------------------------------------------------------------------------

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'non-error'
}

/**
 * Factory for the web question transport.
 *
 * Returns a function that, given the run context, returns an `onPending` hook:
 *
 * 1. Registers the request with `questionScopeId = ctx.runId`.
 * 2. Attaches a render function that emits the settle frame on every
 *    settlement path (answer, skip, deadline, echo, teardown).
 * 3. Emits the bounded open frame.
 *
 * A duplicate request id keeps the existing entry and emits nothing new. A
 * refused registration (no usable deadline) emits no frame: there is nothing
 * to answer, and the caller owns the skip-immediately path.
 */
export function createWebQuestionOnPending(deps: WebQuestionTransportDeps): WebQuestionOnPendingFactory {
  const {observeQuestion, logger} = deps

  return (ctx: WebQuestionTransportContext): WebQuestionOnPending => {
    return (request: WebQuestionRequest): void => {
      const {requestID, sessionID, questions} = request
      const {runId} = ctx

      // register-before-fan-out
      const outcome = ctx.questionRegistry.register({
        requestID,
        sessionID,
        questionScopeId: runId,
        questions,
        effects: ctx.effects,
        deadlineMs: ctx.questionDeadlineMs,
      })

      if (outcome.kind !== 'registered') {
        logger.debug({runId, requestID, reason: outcome.kind}, 'web-question: not registered — no frame emitted')
        return
      }

      // The settle render runs on every settlement path. Advisory: a throw is
      // logged and swallowed because the settlement already happened.
      ctx.questionRegistry.attachMessage(requestID, async (): Promise<void> => {
        try {
          observeQuestion(runId, {requestID, runId, settled: true})
        } catch (error: unknown) {
          logger.warn(
            {runId, requestID, errName: errorName(error)},
            'web-question: settle-frame observer threw (fail-soft; settlement already applied)',
          )
        }
      })

      // Frame build and fan-out share one guard: neither may reject the pending hook.
      try {
        observeQuestion(runId, {
          ...toQuestionRequestDetail(requestID, questions.map(normalizeQuestion)),
          runId,
          settled: false,
        })
      } catch (error: unknown) {
        logger.warn(
          {runId, repo: ctx.repo, requestID, errName: errorName(error)},
          'web-question: open-frame observer threw (fail-soft; registered, deadline will skip)',
        )
      }
    }
  }
}
