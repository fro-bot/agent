/**
 * Question family of the shared request gate.
 *
 * When an agent calls OpenCode's `question` tool, OpenCode blocks the tool
 * call until the request is replied to or rejected. This module registers
 * those requests with the {@link RequestGate} so operators on any surface can
 * answer or skip them, with the gate's single-winner claim, deadline handshake,
 * teardown, and terminal notification (see `request-gate.ts`).
 *
 * ### Family rules
 *
 * - **Decisions**: `answer` (one string array per question) or `skip`.
 * - **Skip and deadline expiry reply with an empty answer per question.**
 *   Upstream turns that into an "Unanswered" tool result and the agent
 *   continues. Rejecting would raise `Question.RejectedError`, which ends the
 *   agent's turn, so reject is reserved for teardown.
 * - **Teardown rejects** (`rejectQuestion`), because ending the turn is the
 *   intent when the run is ending.
 * - **Validation before any POST**: answer arity, known option labels (unless a
 *   custom answer is allowed), `multiple`, and a per-answer length cap. A
 *   failed validation leaves the entry open.
 * - **Scope**: a Discord actor settles only from the entry's own thread; a web
 *   operator actor is accepted for any scope, because the web route authorizes
 *   the operator against the run's repository before calling the gate.
 * - **Duplicate register** for a pending request id is a no-op that keeps the
 *   existing entry and deadline.
 * - **A positive deadline is mandatory.** The caller decides what to do when
 *   the run has no budget left for one (skip immediately).
 * - **No cascade.**
 * - **Teardown is question-only.** Approvals sharing the gate are torn down by the approval registry.
 *
 * ### Untrusted text
 *
 * Question and answer strings are untrusted plain text. They are held in the
 * entry and handed to render functions and DTO consumers only. Log calls in
 * this module and in the gate carry request ids, scope ids, actor ids, and
 * reason codes — never question or answer text, and never an effect's raw
 * error string.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {GateActor, QuestionGateEntry, ReplyResult, RequestGate, ScopePolicy} from './request-gate.js'

import {MAX_OPTIONS_PER_QUESTION, MAX_QUESTIONS_PER_REQUEST} from './question-detail.js'
import {createRequestGate} from './request-gate.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Maximum length of one free-text answer, in UTF-16 code units. Matches Discord's modal input limit. */
export const QUESTION_ANSWER_MAX_LENGTH = 4_000

export interface QuestionOption {
  readonly label: string
  readonly description: string
}

/** A question as OpenCode reports it; `multiple` and `custom` may be omitted. */
export interface QuestionPromptInput {
  readonly question: string
  readonly header: string
  readonly options: readonly QuestionOption[]
  readonly multiple?: boolean
  /** Upstream default is `true`: a custom answer is allowed unless this is explicitly `false`. */
  readonly custom?: boolean
}

/** A question with its flags normalized to booleans. */
export interface QuestionInfo {
  readonly question: string
  readonly header: string
  readonly options: readonly QuestionOption[]
  readonly multiple: boolean
  readonly custom: boolean
}

/** One array of selected labels / typed answers per question, in question order. */
export type QuestionAnswers = readonly (readonly string[])[]

/** Outcome of a reply/reject call to OpenCode. `error` is required when `ok` is false. */
export type QuestionEffectResult = {readonly ok: true} | {readonly ok: false; readonly error: string}

export interface QuestionSideEffects {
  /** `POST /question/{id}/reply` with the given answers. Injected by run.ts. */
  readonly replyQuestion: (requestID: string, answers: QuestionAnswers) => Promise<QuestionEffectResult>
  /** `POST /question/{id}/reject`. Injected by run.ts. */
  readonly rejectQuestion: (requestID: string) => Promise<QuestionEffectResult>
}

/** How a pending question settled, for the settled render. */
export type QuestionSettlement =
  | {readonly reason: 'replied'; readonly answers: QuestionAnswers; readonly actor: GateActor | null}
  | {readonly reason: 'rejected' | 'deadline' | 'disposed'; readonly actor: GateActor | null}

/** Render function injected once the question prompt is posted to a surface. */
export type QuestionRenderFn = (questions: readonly QuestionInfo[], settlement: QuestionSettlement) => Promise<void>

export interface RegisterQuestionParams {
  readonly requestID: string
  readonly sessionID: string
  /** Transport-neutral scope: for a Discord-launched run, its thread id; for a web run, the run id. */
  readonly questionScopeId: string
  /**
   * The run that asked the question. Web routes find and settle a run's questions by this id, so
   * they work the same for Discord-launched runs (whose scope is a thread id). A question
   * registered without it is not reachable from web routes.
   */
  readonly runId?: string
  readonly questions: readonly QuestionPromptInput[]
  readonly effects: QuestionSideEffects
  /** Human-wait deadline in ms. Must be a positive finite number. */
  readonly deadlineMs: number
  /** Invoked after the deadline wins on an open entry (best-effort). */
  readonly onDeadlineSettled?: () => void | Promise<void>
}

export type QuestionRegisterOutcome =
  | {readonly kind: 'registered'}
  /** A request with this id is already pending; the existing entry and deadline are kept. */
  | {readonly kind: 'duplicate'}
  | {readonly kind: 'refused'; readonly reason: 'deadline-required' | 'oversize'}

export type QuestionDecision = {readonly kind: 'answer'; readonly answers: QuestionAnswers} | {readonly kind: 'skip'}

export type QuestionValidationReason =
  'arity-mismatch' | 'unknown-option' | 'multiple-not-allowed' | 'empty-value' | 'text-too-long'

export type QuestionValidation =
  | {readonly kind: 'valid'}
  | {readonly kind: 'invalid'; readonly reason: QuestionValidationReason; readonly questionIndex: number | null}

export type QuestionDecisionOutcome =
  | {readonly kind: 'ok'}
  | {readonly kind: 'not-found'}
  | {readonly kind: 'scope-mismatch'}
  | {readonly kind: 'already-claimed'}
  | {readonly kind: 'reply-failed'}
  | {
      readonly kind: 'invalid'
      readonly reason: QuestionValidationReason
      readonly questionIndex: number | null
    }

/** OpenCode's authoritative `question.replied` / `question.rejected` echo. */
export type QuestionEcho =
  | {
      readonly kind: 'replied'
      readonly requestID: string
      readonly sessionID: string
      readonly answers: QuestionAnswers
    }
  | {readonly kind: 'rejected'; readonly requestID: string; readonly sessionID: string}

/**
 * Pending question for reconnecting operators. Carries the raw question text;
 * the SSE/DTO builder bounds and strips it at its own build site.
 */
export interface PendingQuestionDTO {
  readonly requestID: string
  readonly questions: readonly QuestionInfo[]
}

export interface QuestionRegistry {
  /** Register a pending question BEFORE posting it to any surface. */
  readonly register: (params: RegisterQuestionParams) => QuestionRegisterOutcome
  /** Add a settled render once a surface has posted the prompt. Renders accumulate; each runs on settlement. */
  readonly attachMessage: (requestID: string, renderFn: QuestionRenderFn) => void
  readonly has: (requestID: string) => boolean
  readonly pending: () => readonly string[]
  /** True when an `open` or `claimed` question exists for the scope. */
  readonly hasPendingForScope: (questionScopeId: string) => boolean
  /** Open (not claimed) questions for the scope. */
  readonly describePendingForScope: (questionScopeId: string) => readonly PendingQuestionDTO[]
  /**
   * The open (not claimed) request with this id, whatever its scope or run, or `undefined`.
   * Lets a transport map an operator's option indices back to the raw labels before it calls
   * `decide`, which stays the only place scope is enforced.
   */
  readonly describeRequest: (requestID: string) => PendingQuestionDTO | undefined
  /** Open (not claimed) questions the given run asked, whatever surface scope they are bound to. */
  readonly describePendingForRun: (runId: string) => readonly PendingQuestionDTO[]
  /**
   * Answer or skip: scope check, single-winner claim, validation, reply POST.
   * When `runId` is given, the request must belong to that run or the outcome is `not-found`
   * (the same answer as for an unknown id, so a caller cannot probe other runs' requests).
   */
  readonly decide: (args: {
    readonly requestID: string
    readonly scopeId: string
    readonly runId?: string
    readonly decision: QuestionDecision
    readonly actor: GateActor
  }) => Promise<QuestionDecisionOutcome>
  /** Authoritative settlement from `question.replied` / `question.rejected`. Works on `open` entries too. */
  readonly confirmEcho: (event: QuestionEcho) => void
  /** Fail-close the session's questions. Questions only: approvals sharing the gate are torn down by the approval registry. */
  readonly disposeRun: (sessionID: string, reason: string) => Promise<void>
  /** Fail-close every question. Questions only. */
  readonly disposeAll: (reason: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Entry payload
// ---------------------------------------------------------------------------

/** Question-specific data carried on a gate entry. */
export interface QuestionPayload {
  readonly questions: readonly QuestionInfo[]
  /** The asking run, or `null` when registered without one. */
  readonly runId: string | null
  readonly effects: QuestionSideEffects
  /** Settled renders added by attachMessage, one per surface that posted the prompt. */
  readonly renderFns: QuestionRenderFn[]
}

/** Discord actors settle only from the entry's own thread; web operators are authorized by the route before the gate. */
const questionScopePolicy: ScopePolicy = (entry, request) =>
  request.actor.kind === 'web-operator' || entry.scopeId === request.scopeId

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** One empty answer per question: the reply that makes the tool report "Unanswered". */
export function emptyAnswers(questions: readonly QuestionInfo[]): QuestionAnswers {
  return questions.map(() => [])
}

/**
 * Validate an operator answer against the request's shape. Pure; no I/O.
 * Rejects before any POST so a bad answer never reaches OpenCode.
 */
export function validateQuestionAnswers(
  questions: readonly QuestionInfo[],
  answers: QuestionAnswers,
): QuestionValidation {
  if (answers.length !== questions.length) {
    return {kind: 'invalid', reason: 'arity-mismatch', questionIndex: null}
  }
  for (const [questionIndex, question] of questions.entries()) {
    const values = answers[questionIndex] ?? []
    if (values.length > 1 && !question.multiple) {
      return {kind: 'invalid', reason: 'multiple-not-allowed', questionIndex}
    }
    for (const value of values) {
      if (value.trim().length === 0) {
        return {kind: 'invalid', reason: 'empty-value', questionIndex}
      }
      if (question.options.some(option => option.label === value)) continue
      if (!question.custom) {
        return {kind: 'invalid', reason: 'unknown-option', questionIndex}
      }
      if (value.length > QUESTION_ANSWER_MAX_LENGTH) {
        return {kind: 'invalid', reason: 'text-too-long', questionIndex}
      }
    }
  }
  return {kind: 'valid'}
}

/** Normalize an upstream question: `multiple` defaults to false, `custom` to true. Single owner of that rule. */
export function normalizeQuestion(input: QuestionPromptInput): QuestionInfo {
  return {
    question: input.question,
    header: input.header,
    options: input.options.map(option => ({label: option.label, description: option.description})),
    multiple: input.multiple === true,
    custom: input.custom !== false,
  }
}

/**
 * Call an injected effect without ever throwing or leaking its error text.
 * A thrown error and an `ok: false` result both collapse to a reason code.
 */
async function callEffect(run: () => Promise<QuestionEffectResult>): Promise<ReplyResult> {
  try {
    const result = await run()
    return result.ok ? {ok: true} : {ok: false, error: 'effect-error'}
  } catch {
    return {ok: false, error: 'effect-threw'}
  }
}

function actorLogFields(actor: GateActor): {readonly actorKind: GateActor['kind']; readonly actorId: string} {
  return {
    actorKind: actor.kind,
    actorId: actor.kind === 'discord-user' ? actor.userId : String(actor.githubUserId),
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createQuestionRegistry(deps: {
  readonly logger: GatewayLogger
  /** Shared gate. Pass the approval registry's gate so terminal events span both families. */
  readonly gate?: RequestGate
}): QuestionRegistry {
  const {logger} = deps
  const gate = deps.gate ?? createRequestGate({logger})

  function getEntry(requestID: string): QuestionGateEntry | undefined {
    const entry = gate.get(requestID)
    return entry?.family === 'question' ? entry : undefined
  }

  function questionEntries(): readonly QuestionGateEntry[] {
    const result: QuestionGateEntry[] = []
    for (const entry of gate.list()) {
      if (entry.family === 'question') result.push(entry)
    }
    return result
  }

  async function runRender(entry: QuestionGateEntry, settlement: QuestionSettlement): Promise<void> {
    const {renderFns, questions} = entry.payload
    // Each surface renders independently: one failing render never skips the others.
    for (const renderFn of renderFns) {
      try {
        await renderFn(questions, settlement)
      } catch (error) {
        gate.logRenderFailure(entry, settlement.reason, error)
      }
    }
  }

  /** Teardown: reject an unclaimed question (ends the turn), render, then leave the gate. */
  async function disposeEntry(entry: QuestionGateEntry): Promise<void> {
    const {requestID} = entry
    await gate.retire(entry, 'disposed', async () => {
      // A claimed entry's reply may still be in flight. Mark the entry disposed so the gate never
      // reopens it when that reply fails, and so `decide` can reject the request once the reply
      // settles (see `rejectAfterDisposedReplyFailure`). A reply that already succeeded awaits its
      // echo, which finds nothing to settle: no reject.
      if (entry.state === 'claimed') entry.state = 'disposed'

      if (entry.state === 'open') {
        entry.state = 'claimed'
        const result = await callEffect(async () => entry.payload.effects.rejectQuestion(requestID))
        if (!result.ok) {
          logger.warn({requestID, reason: result.error}, 'QuestionRegistry: dispose reject failed — continuing')
        }
        // An echo that landed while the reject was in flight already settled the entry.
        if (gate.get(requestID) !== entry) return
      }

      await runRender(entry, {reason: 'disposed', actor: entry.actor})
    })
  }

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  function register(params: RegisterQuestionParams): QuestionRegisterOutcome {
    const {requestID, sessionID, questionScopeId, runId, questions, effects, deadlineMs, onDeadlineSettled} = params

    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      logger.warn({requestID, sessionID, reason: 'deadline-required'}, 'QuestionRegistry: register refused')
      return {kind: 'refused', reason: 'deadline-required'}
    }

    // Defense in depth: the coordinator's parser rejects these asks before they get here.
    if (
      questions.length > MAX_QUESTIONS_PER_REQUEST ||
      questions.some(question => question.options.length > MAX_OPTIONS_PER_QUESTION)
    ) {
      logger.warn(
        {requestID, sessionID, reason: 'oversize', questionCount: questions.length},
        'QuestionRegistry: register refused',
      )
      return {kind: 'refused', reason: 'oversize'}
    }

    if (gate.get(requestID) !== undefined) {
      logger.debug(
        {requestID, reason: 'duplicate'},
        'QuestionRegistry: register — already pending, keeping existing entry',
      )
      return {kind: 'duplicate'}
    }

    const normalized = questions.map(normalizeQuestion)
    const entry: QuestionGateEntry = {
      family: 'question',
      requestID,
      sessionID,
      scopeId: questionScopeId,
      payload: {questions: normalized, runId: runId ?? null, effects, renderFns: []},
      ops: {
        // Deadline expiry is a skip: an empty reply, never a reject.
        postDeadlineReply: async () =>
          callEffect(async () => effects.replyQuestion(requestID, emptyAnswers(normalized))),
        renderDeadline: async () => runRender(entry, {reason: 'deadline', actor: null}),
        dispose: async () => disposeEntry(entry),
        onDeadlineSettled,
      },
      state: 'open',
      actor: null,
      timer: null,
      deadlineExpired: false,
      terminalFired: false,
    }
    gate.put(entry, deadlineMs)
    return {kind: 'registered'}
  }

  // -------------------------------------------------------------------------
  // attachMessage / has / pending / scope queries
  // -------------------------------------------------------------------------

  function attachMessage(requestID: string, renderFn: QuestionRenderFn): void {
    const entry = getEntry(requestID)
    if (entry === undefined) {
      logger.warn({requestID}, 'QuestionRegistry: attachMessage — entry not found (already settled?)')
      return
    }
    entry.payload.renderFns.push(renderFn)
  }

  function has(requestID: string): boolean {
    return getEntry(requestID) !== undefined
  }

  function pending(): readonly string[] {
    return questionEntries().map(entry => entry.requestID)
  }

  function hasPendingForScope(questionScopeId: string): boolean {
    return gate.hasPendingForScope('question', questionScopeId)
  }

  function describePendingForScope(questionScopeId: string): readonly PendingQuestionDTO[] {
    // Only `open` entries are actionable; a `claimed` entry is mid-decision.
    return questionEntries()
      .filter(entry => entry.scopeId === questionScopeId && entry.state === 'open')
      .map(entry => ({requestID: entry.requestID, questions: entry.payload.questions}))
  }

  function describeRequest(requestID: string): PendingQuestionDTO | undefined {
    const entry = getEntry(requestID)
    if (entry === undefined || entry.state !== 'open') return undefined
    return {requestID: entry.requestID, questions: entry.payload.questions}
  }

  function describePendingForRun(runId: string): readonly PendingQuestionDTO[] {
    return questionEntries()
      .filter(entry => entry.payload.runId === runId && entry.state === 'open')
      .map(entry => ({requestID: entry.requestID, questions: entry.payload.questions}))
  }

  // -------------------------------------------------------------------------
  // decide
  // -------------------------------------------------------------------------

  async function decide(args: {
    readonly requestID: string
    readonly scopeId: string
    readonly runId?: string
    readonly decision: QuestionDecision
    readonly actor: GateActor
  }): Promise<QuestionDecisionOutcome> {
    const {requestID, scopeId, runId, decision, actor} = args

    const entry = getEntry(requestID)
    if (entry === undefined) return {kind: 'not-found'}
    if (runId !== undefined && entry.payload.runId !== runId) return {kind: 'not-found'}

    const admission = gate.admit(entry, {scopeId, actor}, questionScopePolicy)
    if (admission.kind === 'scope-mismatch') return {kind: 'scope-mismatch'}
    if (admission.kind === 'already-claimed') return {kind: 'already-claimed'}

    const {questions, effects} = entry.payload
    let answers: QuestionAnswers
    if (decision.kind === 'answer') {
      const validation = validateQuestionAnswers(questions, decision.answers)
      if (validation.kind === 'invalid') {
        logger.warn(
          {requestID, reason: validation.reason, questionIndex: validation.questionIndex, ...actorLogFields(actor)},
          'QuestionRegistry: answer rejected by validation',
        )
        return validation
      }
      // Copy so a caller mutating its arrays after validation cannot change what is sent.
      answers = decision.answers.map(values => [...values])
    } else {
      answers = emptyAnswers(questions)
    }

    const outcome = await admission.submit(async () =>
      callEffect(async () => effects.replyQuestion(requestID, answers)),
    )
    switch (outcome) {
      case 'ok':
        return {kind: 'ok'}
      case 'already-claimed':
        return {kind: 'already-claimed'}
      case 'not-found':
        return {kind: 'not-found'}
      case 'reply-failed':
        // Teardown removed the entry while this reply was in flight, and the reply failed: nothing
        // owns the request any more, so it would stay pending in OpenCode. End it once.
        if (entry.state === 'disposed') await rejectAfterDisposedReplyFailure(entry)
        return {kind: 'reply-failed'}
    }
  }

  async function rejectAfterDisposedReplyFailure(entry: QuestionGateEntry): Promise<void> {
    const {requestID} = entry
    const result = await callEffect(async () => entry.payload.effects.rejectQuestion(requestID))
    if (!result.ok) {
      logger.warn(
        {requestID, reason: result.error},
        'QuestionRegistry: reject after a failed reply on a disposed entry did not go through',
      )
    }
  }

  // -------------------------------------------------------------------------
  // confirmEcho — authoritative path for question.replied / question.rejected
  // -------------------------------------------------------------------------

  function confirmEcho(event: QuestionEcho): void {
    const {requestID, sessionID} = event

    const entry = getEntry(requestID)
    if (entry === undefined) {
      logger.debug({requestID, echo: event.kind}, 'QuestionRegistry: confirmEcho — entry not found (already settled?)')
      return
    }

    // Defensive cross-session guard, as for approvals.
    if (entry.sessionID !== sessionID) {
      logger.warn(
        {requestID, entrySessionID: entry.sessionID, eventSessionID: sessionID},
        'QuestionRegistry: confirmEcho — sessionID mismatch, ignoring (cross-session guard)',
      )
      return
    }

    logger.info(
      {requestID, state: entry.state, echo: event.kind},
      entry.state === 'open'
        ? 'QuestionRegistry: confirmEcho — OpenCode-initiated'
        : 'QuestionRegistry: confirmEcho — decision winner echo',
    )

    const settlement: QuestionSettlement =
      event.kind === 'replied'
        ? {reason: 'replied', answers: event.answers, actor: entry.actor}
        : {reason: 'rejected', actor: entry.actor}

    // eslint-disable-next-line no-void
    void gate.settleEcho(entry, async () => runRender(entry, settlement))
  }

  return {
    register,
    attachMessage,
    has,
    pending,
    hasPendingForScope,
    describePendingForScope,
    describePendingForRun,
    describeRequest,
    decide,
    confirmEcho,
    disposeRun: async (sessionID, reason) => gate.disposeFamilyRun('question', sessionID, reason),
    disposeAll: async reason => gate.disposeFamilyAll('question', reason),
  }
}
