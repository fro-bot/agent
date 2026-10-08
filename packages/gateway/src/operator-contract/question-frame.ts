/**
 * Question frame, pending-question DTO, and decision request types for the
 * operator API (contract 1.9.0).
 *
 * An agent running in a gateway workspace can call OpenCode's `question` tool.
 * The gateway forwards the pending question to operators over the run's SSE
 * stream and a reconnect-listing REST read, and accepts an answer or a skip.
 *
 * ### Untrusted text — render inertly
 *
 * **Every question and answer string in this module is untrusted, model- or
 * operator-authored plain text.** That covers `header`, `text`, option `label`,
 * option `description`, and every answer string. The gateway carries them
 * verbatim apart from bounding (length caps) and control-character stripping at
 * the build site; it never pre-renders, escapes, or sanitizes them as HTML or
 * Markdown. Consumers MUST display them as inert text (for example a text node
 * or `textContent`) and MUST NOT interpret them as HTML, Markdown, or links. A
 * string such as `<img src=x onerror=alert(1)>` is data, not markup.
 *
 * Question and answer text never appears in gateway logs, errors, audit events,
 * or push payloads — only request ids and reason codes do.
 *
 * ### Frame modes
 *
 * - **Open frame** (`settled: false`): a question is pending. The browser should
 *   show a prompt and let the operator answer or skip.
 * - **Settle/clear frame** (`settled: true`): the request is resolved (answered,
 *   skipped, expired, rejected, or torn down). The browser should dismiss the
 *   prompt. It carries only `requestID`, `runId`, and `settled: true`.
 *
 * A request settles as a whole: an operator submits answers for every question
 * in the request in one decision.
 */

// ---------------------------------------------------------------------------
// QuestionPromptDetail / QuestionRequestDetail — shared field shapes
// ---------------------------------------------------------------------------

/** One selectable option of a question. Both strings are untrusted plain text. */
export interface QuestionOptionDetail {
  /**
   * Option label. Also the answer value an operator submits when choosing this
   * option. Bounded and control-character-stripped; if bounding altered it,
   * submitting the altered label will not match the option.
   */
  readonly label: string
  /** Option description. Untrusted plain text, bounded. */
  readonly description: string
}

/** One question of a request. All strings are untrusted plain text, bounded. */
export interface QuestionPromptDetail {
  /** Short label for the question. */
  readonly header: string
  /** The question text. */
  readonly text: string
  /** Selectable options; may be empty when only a custom answer is meaningful. */
  readonly options: readonly QuestionOptionDetail[]
  /** True when more than one option may be chosen. Normalized: always a boolean. */
  readonly multiple: boolean
  /**
   * True when a free-text answer is accepted in addition to the options.
   * Normalized: upstream allows a custom answer unless it is explicitly
   * disabled, so an omitted upstream value arrives here as `true`.
   */
  readonly custom: boolean
}

/**
 * The shared field shape for a pending question request: the single source of
 * truth for the open `QuestionFrameData` variant and `PendingQuestionDTO`, so
 * the SSE frame and the REST listing cannot drift.
 */
export interface QuestionRequestDetail {
  /** The unique request identifier — matches the registry entry. */
  readonly requestID: string
  /** One entry per question, in question order. Answers must match this arity. */
  readonly questions: readonly QuestionPromptDetail[]
}

// ---------------------------------------------------------------------------
// QuestionFrameData — SSE frame payload
// ---------------------------------------------------------------------------

/**
 * Payload for a `question` frame delivered over the operator run-stream.
 *
 * Open frames carry the full bounded request so the browser can render a
 * prompt. Settle/clear frames carry only `requestID` and `runId`.
 */
export type QuestionFrameData =
  | (QuestionRequestDetail & {
      /** The run the question belongs to. */
      readonly runId: string
      /** Discriminant: false for open (pending) frames. */
      readonly settled: false
    })
  | {
      /** The unique request identifier — matches the registry entry. */
      readonly requestID: string
      /** The run the question belonged to. */
      readonly runId: string
      /** Discriminant: true for settle/clear frames. */
      readonly settled: true
    }

// ---------------------------------------------------------------------------
// PendingQuestionDTO — reconnect listing entry
// ---------------------------------------------------------------------------

/**
 * A pending question as listed for a reconnecting operator. Same bounded shape
 * as the open frame, minus the run id (the listing is scoped to one run).
 *
 * Distinct from the gateway-internal registry DTO of the same name, which holds
 * raw, unbounded text. This is the operator-facing, bounded form.
 */
export type PendingQuestionDTO = QuestionRequestDetail

// ---------------------------------------------------------------------------
// Decision request and response types
// ---------------------------------------------------------------------------

/**
 * The operator's answer to one question: which options they chose and, when the
 * question's `custom` is true, free text.
 *
 * Options are chosen by zero-based **index into that question's `options`**, never
 * by label. The labels a consumer displays are bounded and control-stripped, so
 * they can differ from the raw labels the agent sent; the gateway maps each index
 * back to the raw label before replying. `options` holds at most one index unless
 * the question's `multiple` is true. `text` is untrusted plain text, at most 4,000
 * characters; an omitted or empty `text` means no free-text answer. A question with
 * neither is left unanswered.
 */
export interface QuestionAnswerChoice {
  readonly options?: readonly number[]
  readonly text?: string
}

/**
 * Answer a pending question request: one choice per question, in question order.
 * The array length must equal the request's question count.
 */
export interface QuestionAnswerRequest {
  readonly decision: 'answer'
  readonly answers: readonly QuestionAnswerChoice[]
}

/**
 * Skip a pending question request. The agent sees the question as unanswered
 * and continues; the run does not fail.
 */
export interface QuestionSkipRequest {
  readonly decision: 'skip'
}

/** Body of an operator question decision: answer or skip. */
export type QuestionDecisionRequest = QuestionAnswerRequest | QuestionSkipRequest

/** Response body of `GET /operator/runs/:runId/questions`: the run's open question requests. */
export interface PendingQuestionsResponse {
  readonly requests: readonly PendingQuestionDTO[]
}

/**
 * Why a decision was refused as malformed (HTTP 400). The request stays pending.
 * `malformed` covers a body that is not an answer/skip shape, duplicate or non-integer
 * option indices, and non-string text; the others mirror the gateway's answer validation.
 */
export type QuestionDecisionInvalidReason =
  'malformed' | 'arity-mismatch' | 'unknown-option' | 'multiple-not-allowed' | 'empty-value' | 'text-too-long'

/**
 * Outcome of a question decision (HTTP 200 unless noted).
 *
 * - `claimed`         — accepted; the reply is on its way to the agent.
 * - `already_claimed` — another decision for this request is in flight; nothing changed.
 * - `already_settled` — the request is no longer pending (answered, skipped, expired, or
 *                       never existed for this run). Repeating a submission lands here.
 * - `failed_to_settle`— the reply to the agent failed; the request is pending again.
 * - `invalid`         — HTTP 400; the body was refused, see `reason`. The request stays pending.
 */
export type QuestionDecisionResponse =
  | {readonly state: 'claimed' | 'already_claimed' | 'already_settled' | 'failed_to_settle'}
  | {
      readonly state: 'invalid'
      readonly reason: QuestionDecisionInvalidReason
      /** The question the problem is in, or null when it concerns the whole request. */
      readonly questionIndex: number | null
    }
