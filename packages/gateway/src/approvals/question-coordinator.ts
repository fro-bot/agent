/**
 * Per-run question coordinator and `question.*` event parsers.
 *
 * run-core hands owned `question.asked` / `question.replied` / `question.rejected`
 * events to this seam. It is the question counterpart of the permission
 * coordinator, with the same split of duties: run-core owns the inactivity
 * watchdog and the human-wait gauge; the shared request gate owns settlement.
 *
 * What this module decides:
 * - **Deadline**: computed at ask time from the run's remaining budget. When
 *   there is no budget for a meaningful deadline, the question is skipped
 *   immediately (an empty reply for every question) instead of registered,
 *   because a registered question with no deadline would block the agent until
 *   the run's hard abort.
 * - **Scope**: the surface scope the registry binds the question to.
 * - **Teardown**: the sessions this run registered questions for, so the run
 *   can reject any still-pending question when it ends.
 *
 * Untrusted text: question text lives only in the parsed request, which goes to
 * the registry. Parse failures and every log call here carry ids and reason
 * codes only.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {
  QuestionAnswers,
  QuestionEcho,
  QuestionInfo,
  QuestionOption,
  QuestionRegistry,
  QuestionSideEffects,
} from './question-registry.js'

import {MAX_OPTIONS_PER_QUESTION, MAX_QUESTIONS_PER_REQUEST} from './question-detail.js'
import {emptyAnswers} from './question-registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed `question.asked` payload with `multiple` / `custom` normalized to booleans. */
export interface QuestionAskedRequest {
  readonly requestID: string
  readonly sessionID: string
  readonly questions: readonly QuestionInfo[]
}

export type QuestionParseFailure =
  | 'missing-request-id'
  | 'missing-session-id'
  | 'invalid-questions'
  | 'invalid-question'
  | 'invalid-option'
  // More questions in one request, or more options in one question, than the gateway accepts.
  | 'oversize'

export type QuestionParseResult<T> =
  {readonly kind: 'ok'; readonly value: T} | {readonly kind: 'malformed'; readonly reason: QuestionParseFailure}

/**
 * What became of an ask.
 * - `registered` / `duplicate`: the gate holds the request; its terminal event releases the run's wait.
 * - `skipped`: no budget for a deadline, so the question was answered with empty replies and never
 *   registered; the caller must release its wait itself.
 * - `failed`: registration threw; nothing holds the request, the caller must release its wait.
 */
export type QuestionAskOutcome = 'registered' | 'duplicate' | 'skipped' | 'failed'

export interface QuestionCoordinator {
  /** Register (or immediately skip) an owned question. Never rejects. */
  readonly onAsked: (request: QuestionAskedRequest) => Promise<QuestionAskOutcome>
  /**
   * Reject an owned question whose payload could not be parsed but whose request id is readable.
   * Without this the agent's `question` tool call blocks until the inactivity timeout; rejecting
   * ends the turn instead. Never rejects; logs ids and a reason code only.
   */
  readonly onMalformed: (args: {
    readonly requestID: string
    readonly sessionID: string
    readonly reason: QuestionParseFailure
  }) => Promise<void>
  /** Forward OpenCode's authoritative echo to the registry. Never throws. */
  readonly onEcho: (echo: QuestionEcho) => void
  /** Reject every still-pending question this run registered (run teardown). Never rejects. */
  readonly dispose: (reason: string) => Promise<void>
}

export interface QuestionCoordinatorDeps {
  readonly logger: GatewayLogger
  readonly registry: QuestionRegistry
  readonly effects: QuestionSideEffects
  /** Scope the registry binds each question to (thread id for Discord runs, run id for web runs). */
  readonly scopeId: string
  /** The run these questions belong to; lets web routes find and settle them on any surface. */
  readonly runId?: string
  /** Deadline for a question asked now, or `undefined` when the run has no budget for one. */
  readonly computeDeadlineMs: () => number | undefined
  /**
   * Called once per newly registered question, after the registry holds it (register-before-fan-out):
   * transports attach their settled render and announce the question here. Fail-soft: a throw is
   * logged by id and never changes the ask's outcome.
   */
  readonly onRegistered?: (request: QuestionAskedRequest) => void
}

// ---------------------------------------------------------------------------
// Defensive accessors (payloads are untrusted server JSON; own properties only)
// ---------------------------------------------------------------------------

function getOwn(value: unknown, property: string): unknown {
  if (value == null || typeof value !== 'object') return undefined
  return Object.getOwnPropertyDescriptor(value, property)?.value
}

function getString(value: unknown, property: string): string | null {
  const raw = getOwn(value, property)
  return typeof raw === 'string' ? raw : null
}

/**
 * An id safe to put in a log line: a short token of id characters. Anything else
 * is omitted rather than logged, so a malformed payload cannot smuggle free text
 * into logs through an id field.
 */
export function safeLogId(value: string | null): string | null {
  return value !== null && /^[\w.:-]{1,128}$/.test(value) ? value : null
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseOption(raw: unknown): QuestionOption | null {
  const label = getString(raw, 'label')
  if (label === null) return null
  return {label, description: getString(raw, 'description') ?? ''}
}

function parseQuestion(raw: unknown): QuestionParseResult<QuestionInfo> {
  const question = getString(raw, 'question')
  if (question === null) return {kind: 'malformed', reason: 'invalid-question'}
  const rawOptions = getOwn(raw, 'options')
  if (!Array.isArray(rawOptions)) return {kind: 'malformed', reason: 'invalid-question'}
  if (rawOptions.length > MAX_OPTIONS_PER_QUESTION) return {kind: 'malformed', reason: 'oversize'}
  const options: QuestionOption[] = []
  for (const rawOption of rawOptions as unknown[]) {
    const option = parseOption(rawOption)
    if (option === null) return {kind: 'malformed', reason: 'invalid-option'}
    options.push(option)
  }
  return {
    kind: 'ok',
    value: {
      question,
      header: getString(raw, 'header') ?? '',
      options,
      // Normalized once here: `multiple` is opt-in; a custom answer is allowed unless explicitly `false`.
      multiple: getOwn(raw, 'multiple') === true,
      custom: getOwn(raw, 'custom') !== false,
    },
  }
}

/** Parse a `question.asked` `properties` payload. */
export function parseQuestionRequest(payload: unknown): QuestionParseResult<QuestionAskedRequest> {
  const requestID = getString(payload, 'id')
  if (requestID === null) return {kind: 'malformed', reason: 'missing-request-id'}
  const sessionID = getString(payload, 'sessionID')
  if (sessionID === null) return {kind: 'malformed', reason: 'missing-session-id'}
  const rawQuestions = getOwn(payload, 'questions')
  if (!Array.isArray(rawQuestions)) return {kind: 'malformed', reason: 'invalid-questions'}
  if (rawQuestions.length > MAX_QUESTIONS_PER_REQUEST) return {kind: 'malformed', reason: 'oversize'}
  const questions: QuestionInfo[] = []
  for (const rawQuestion of rawQuestions as unknown[]) {
    const parsed = parseQuestion(rawQuestion)
    if (parsed.kind === 'malformed') return parsed
    questions.push(parsed.value)
  }
  return {kind: 'ok', value: {requestID, sessionID, questions}}
}

function parseAnswers(raw: unknown): QuestionAnswers {
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).map(values =>
    Array.isArray(values) ? (values as unknown[]).filter((value): value is string => typeof value === 'string') : [],
  )
}

/**
 * Parse a `question.replied` / `question.rejected` payload. Only the ids are
 * required: the echo is authoritative, so unparseable answers degrade to an
 * empty list rather than dropping the settlement.
 */
export function parseQuestionEcho(
  eventType: 'question.replied' | 'question.rejected',
  payload: unknown,
): QuestionParseResult<QuestionEcho> {
  const requestID = getString(payload, 'requestID')
  if (requestID === null) return {kind: 'malformed', reason: 'missing-request-id'}
  const sessionID = getString(payload, 'sessionID')
  if (sessionID === null) return {kind: 'malformed', reason: 'missing-session-id'}
  if (eventType === 'question.rejected') {
    return {kind: 'ok', value: {kind: 'rejected', requestID, sessionID}}
  }
  return {kind: 'ok', value: {kind: 'replied', requestID, sessionID, answers: parseAnswers(getOwn(payload, 'answers'))}}
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export function createQuestionCoordinator(deps: QuestionCoordinatorDeps): QuestionCoordinator {
  const {logger, registry, effects, scopeId, runId, computeDeadlineMs, onRegistered} = deps
  /** Sessions this run registered questions for — the dispose set. */
  const registeredSessionIDs = new Set<string>()

  /** Answer with one empty reply per question, without registering. Never throws. */
  async function skipImmediately(request: QuestionAskedRequest): Promise<void> {
    // The effect's own error text is not logged: the coordinator does not trust an injected
    // effect to have kept question or answer text out of it, so the reason code is fixed here.
    const reason = await effects.replyQuestion(request.requestID, emptyAnswers(request.questions)).then(
      result => (result.ok ? null : 'reply-error'),
      () => 'reply-threw',
    )
    if (reason !== null) {
      logger.warn(
        {requestID: request.requestID, sessionID: request.sessionID, reason},
        'question-coordinator: immediate skip reply failed — the question stays pending in OpenCode',
      )
    }
  }

  /** Hand a registered question to the transports. Never throws. */
  function announce(request: QuestionAskedRequest): void {
    if (onRegistered === undefined) return
    try {
      onRegistered(request)
    } catch (error) {
      logger.warn(
        {requestID: request.requestID, errName: error instanceof Error ? error.name : typeof error},
        'question-coordinator: onRegistered threw — question stays registered, deadline will skip it',
      )
    }
  }

  async function onAsked(request: QuestionAskedRequest): Promise<QuestionAskOutcome> {
    const {requestID, sessionID} = request
    try {
      const deadlineMs = computeDeadlineMs()
      if (deadlineMs === undefined) {
        logger.warn(
          {requestID, sessionID, reason: 'no-deadline-budget'},
          'question-coordinator: skipping question immediately — run budget too short for a deadline',
        )
        await skipImmediately(request)
        return 'skipped'
      }

      const outcome = registry.register({
        requestID,
        sessionID,
        questionScopeId: scopeId,
        runId,
        questions: request.questions,
        effects,
        deadlineMs,
      })
      switch (outcome.kind) {
        case 'registered':
          registeredSessionIDs.add(sessionID)
          announce(request)
          return 'registered'
        case 'duplicate':
          return 'duplicate'
        case 'refused':
          logger.error({requestID, sessionID, reason: outcome.reason}, 'question-coordinator: registration refused')
          return 'failed'
      }
    } catch (error) {
      logger.error(
        {requestID, sessionID, errName: error instanceof Error ? error.name : typeof error},
        'question-coordinator: onAsked threw',
      )
      return 'failed'
    }
  }

  async function onMalformed(args: {
    readonly requestID: string
    readonly sessionID: string
    readonly reason: QuestionParseFailure
  }): Promise<void> {
    const {requestID, sessionID, reason} = args
    // The effect's own error text is not logged (see skipImmediately).
    let outcome: 'reject-error' | 'reject-threw' | null
    try {
      outcome = (await effects.rejectQuestion(requestID)).ok ? null : 'reject-error'
    } catch {
      outcome = 'reject-threw'
    }
    if (outcome === null) {
      logger.warn(
        {requestID: safeLogId(requestID), sessionID: safeLogId(sessionID), reason},
        'question-coordinator: malformed question rejected so the agent does not wait for the timeout',
      )
    } else {
      logger.warn(
        {requestID: safeLogId(requestID), sessionID: safeLogId(sessionID), reason, rejectOutcome: outcome},
        'question-coordinator: malformed question could not be rejected — the agent waits for the timeout',
      )
    }
  }

  function onEcho(echo: QuestionEcho): void {
    try {
      registry.confirmEcho(echo)
    } catch (error) {
      logger.error(
        {requestID: echo.requestID, errName: error instanceof Error ? error.name : typeof error},
        'question-coordinator: confirmEcho threw',
      )
    }
  }

  async function dispose(reason: string): Promise<void> {
    await Promise.all(
      Array.from(registeredSessionIDs, async sessionID => {
        try {
          await registry.disposeRun(sessionID, reason)
        } catch (error) {
          logger.error(
            {sessionID, errName: error instanceof Error ? error.name : typeof error},
            'question-coordinator: disposeRun threw',
          )
        }
      }),
    )
  }

  return {onAsked, onMalformed, onEcho, dispose}
}
