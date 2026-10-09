/**
 * Web question transport.
 *
 * Announces each registered agent question on the run's SSE stream so a web
 * operator can see and answer it, and clears the prompt when the question
 * settles. The question analog of `web-approval.ts`.
 *
 * ### Where it plugs in
 *
 * The run's question coordinator registers the question with the request gate
 * and then calls the hook this factory returns (`onRegistered`). That is the
 * same register-before-fan-out order the approval transport has: the registry
 * entry exists before any frame is emitted, so an answer can settle even if the
 * frame is dropped. The transport serves every run, Discord-launched or
 * web-launched: web operators may answer any run's question, so a Discord run's
 * question must reach the run stream and the pending listing too.
 *
 * ### fail-soft observation
 *
 * `observeQuestion` throwing never escapes the hook: the failure is logged with
 * ids and an error name only, and swallowed. The registration already happened
 * and the deadline still skips the question.
 *
 * ### untrusted text
 *
 * Question and answer text is untrusted plain text. It is bounded and
 * control-stripped into the frame by `toQuestionRequestDetail` and appears
 * nowhere else here — log calls carry request ids, run ids, and reason codes
 * only, never text and never a raw error message.
 */

import type {QuestionInfo, QuestionRegistry} from '../../approvals/question-registry.js'
import type {QuestionFrameData} from '../../operator-contract/question-frame.js'
import type {OperatorLogger} from '../server.js'
import {toQuestionRequestDetail} from '../../approvals/question-detail.js'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A question the registry now holds, with `multiple` / `custom` already normalized. */
export interface WebQuestionRequest {
  readonly requestID: string
  readonly questions: readonly QuestionInfo[]
}

/** Per-run context supplied by the run engine. */
export interface WebQuestionTransportContext {
  /** Program-scoped question registry; the transport attaches its settle render here. */
  readonly questionRegistry: Pick<QuestionRegistry, 'attachMessage'>
  /** Stable UUID for this run; the SSE fan-out key. */
  readonly runId: string
  /** `owner/repo` for logging and correlation. */
  readonly repo: string
}

export interface WebQuestionTransportDeps {
  /**
   * Fan-out for question frames, keyed by run id. Fail-soft: a throw is logged
   * and swallowed.
   */
  readonly observeQuestion: (runId: string, data: QuestionFrameData) => void
  readonly logger: OperatorLogger
}

/** Called by the question coordinator once the registry holds the question. Never throws. */
export type WebQuestionOnRegistered = (request: WebQuestionRequest) => void

export type WebQuestionOnRegisteredFactory = (context: WebQuestionTransportContext) => WebQuestionOnRegistered

// ---------------------------------------------------------------------------
// createWebQuestionOnRegistered
// ---------------------------------------------------------------------------

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'non-error'
}

/**
 * Factory for the web question transport.
 *
 * Returns a function that, given the run context, returns an `onRegistered`
 * hook which:
 *
 * 1. Attaches a render function that emits the settle frame on every
 *    settlement path (answer, skip, deadline, echo, teardown).
 * 2. Emits the bounded open frame.
 */
export function createWebQuestionOnRegistered(deps: WebQuestionTransportDeps): WebQuestionOnRegisteredFactory {
  const {observeQuestion, logger} = deps

  return (ctx: WebQuestionTransportContext): WebQuestionOnRegistered => {
    return (request: WebQuestionRequest): void => {
      const {requestID, questions} = request
      const {runId} = ctx

      // The settle render runs on every settlement path. Advisory: a throw is
      // logged and swallowed because the settlement already happened.
      try {
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
      } catch (error: unknown) {
        logger.warn(
          {runId, requestID, errName: errorName(error)},
          'web-question: attaching the settle render threw (fail-soft)',
        )
      }

      // Frame build and fan-out share one guard: neither may reject the hook.
      try {
        observeQuestion(runId, {...toQuestionRequestDetail(requestID, questions), runId, settled: false})
      } catch (error: unknown) {
        logger.warn(
          {runId, repo: ctx.repo, requestID, errName: errorName(error)},
          'web-question: open-frame observer threw (fail-soft; registered, deadline will skip)',
        )
      }
    }
  }
}
