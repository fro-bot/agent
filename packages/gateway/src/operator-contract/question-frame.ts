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
// Decision request types
// ---------------------------------------------------------------------------

/**
 * Answer a pending question request: one array of strings per question, in
 * question order. Each string is either an option label or, when the question's
 * `custom` is true, free text (at most 4,000 characters). A question with
 * `multiple: false` accepts at most one string. Every string is untrusted plain
 * text.
 */
export interface QuestionAnswerRequest {
  readonly decision: 'answer'
  readonly answers: readonly (readonly string[])[]
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
