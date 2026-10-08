/**
 * Tests for the question event parsers and the per-run question coordinator.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {QuestionAskedRequest} from './question-coordinator.js'
import type {QuestionSideEffects} from './question-registry.js'

import {describe, expect, it, vi} from 'vitest'

import {createQuestionCoordinator, parseQuestionEcho, parseQuestionRequest, safeLogId} from './question-coordinator.js'
import {MAX_OPTIONS_PER_QUESTION, MAX_QUESTIONS_PER_REQUEST} from './question-detail.js'
import {createQuestionRegistry} from './question-registry.js'
import {createRequestGate} from './request-gate.js'

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

const SECRET = 'SECRET-QUESTION-sk-live-abc123'
const ANY_STRING: unknown = expect.any(String)

function askedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'que_1',
    sessionID: 'ses_1',
    questions: [
      {
        question: 'Which environment?',
        header: 'Env',
        options: [
          {label: 'staging', description: 'Deploy to staging'},
          {label: 'prod', description: 'Deploy to production'},
        ],
      },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe('parseQuestionRequest', () => {
  it('parses a request and normalizes multiple to false and custom to true when omitted', () => {
    // #given / #when
    const parsed = parseQuestionRequest(askedPayload())

    // #then
    expect(parsed).toEqual({
      kind: 'ok',
      value: {
        requestID: 'que_1',
        sessionID: 'ses_1',
        questions: [
          {
            question: 'Which environment?',
            header: 'Env',
            options: [
              {label: 'staging', description: 'Deploy to staging'},
              {label: 'prod', description: 'Deploy to production'},
            ],
            multiple: false,
            custom: true,
          },
        ],
      },
    })
  })

  it.each([
    ['custom explicitly false', {custom: false}, {multiple: false, custom: false}],
    ['custom explicitly true', {custom: true}, {multiple: false, custom: true}],
    ['multiple true', {multiple: true}, {multiple: true, custom: true}],
    ['multiple false', {multiple: false}, {multiple: false, custom: true}],
    ['non-boolean flags', {multiple: 'yes', custom: 0}, {multiple: false, custom: true}],
  ])('flags: %s', (_name, flags, expected) => {
    // #given
    const payload = askedPayload({
      questions: [{question: 'Q', header: 'H', options: [], ...flags}],
    })

    // #when
    const parsed = parseQuestionRequest(payload)

    // #then
    expect(parsed.kind === 'ok' ? parsed.value.questions[0] : undefined).toEqual(expect.objectContaining(expected))
  })

  it('defaults a missing header and option description to empty strings', () => {
    // #given
    const payload = askedPayload({questions: [{question: 'Q', options: [{label: 'a'}]}]})

    // #when
    const parsed = parseQuestionRequest(payload)

    // #then
    expect(parsed.kind === 'ok' ? parsed.value.questions[0] : undefined).toEqual(
      expect.objectContaining({header: '', options: [{label: 'a', description: ''}]}),
    )
  })

  it.each([
    ['null payload', null, 'missing-request-id'],
    ['non-object payload', 'text', 'missing-request-id'],
    ['missing id', askedPayload({id: undefined}), 'missing-request-id'],
    ['numeric id', askedPayload({id: 7}), 'missing-request-id'],
    ['missing session', askedPayload({sessionID: undefined}), 'missing-session-id'],
    ['questions not an array', askedPayload({questions: 'nope'}), 'invalid-questions'],
    ['question without text', askedPayload({questions: [{options: []}]}), 'invalid-question'],
    ['question without options array', askedPayload({questions: [{question: 'Q'}]}), 'invalid-question'],
    [
      'option without a label',
      askedPayload({questions: [{question: 'Q', options: [{description: 'd'}]}]}),
      'invalid-option',
    ],
  ])('malformed: %s → %s', (_name, payload, reason) => {
    expect(parseQuestionRequest(payload)).toEqual({kind: 'malformed', reason})
  })

  it('reads own properties only: prototype-polluted values are ignored', () => {
    // #given a payload whose id exists only on the prototype
    const payload = Object.create({id: 'que_proto', sessionID: 'ses_proto', questions: []}) as unknown

    // #when / #then
    expect(parseQuestionRequest(payload)).toEqual({kind: 'malformed', reason: 'missing-request-id'})
  })

  it('accepts an empty questions array', () => {
    expect(parseQuestionRequest(askedPayload({questions: []}))).toEqual({
      kind: 'ok',
      value: {requestID: 'que_1', sessionID: 'ses_1', questions: []},
    })
  })

  describe('count caps', () => {
    const oneQuestion = (optionCount: number) => ({
      question: 'Which?',
      header: 'H',
      options: Array.from({length: optionCount}, (_, index) => ({label: `opt-${index}`, description: ''})),
    })

    it('accepts exactly MAX_QUESTIONS_PER_REQUEST questions', () => {
      // #given / #when a request at the question-count cap
      const parsed = parseQuestionRequest(
        askedPayload({questions: Array.from({length: MAX_QUESTIONS_PER_REQUEST}, () => oneQuestion(2))}),
      )

      // #then
      expect(parsed.kind).toBe('ok')
    })

    it('rejects one question over the cap as oversize', () => {
      // #given / #when
      const parsed = parseQuestionRequest(
        askedPayload({questions: Array.from({length: MAX_QUESTIONS_PER_REQUEST + 1}, () => oneQuestion(2))}),
      )

      // #then
      expect(parsed).toEqual({kind: 'malformed', reason: 'oversize'})
    })

    it('accepts exactly MAX_OPTIONS_PER_QUESTION options', () => {
      // #given / #when
      const parsed = parseQuestionRequest(askedPayload({questions: [oneQuestion(MAX_OPTIONS_PER_QUESTION)]}))

      // #then
      expect(parsed.kind).toBe('ok')
    })

    it('rejects one option over the cap as oversize', () => {
      // #given / #when
      const parsed = parseQuestionRequest(askedPayload({questions: [oneQuestion(MAX_OPTIONS_PER_QUESTION + 1)]}))

      // #then
      expect(parsed).toEqual({kind: 'malformed', reason: 'oversize'})
    })
  })
})

describe('parseQuestionEcho', () => {
  it('parses a replied echo with its answers', () => {
    expect(
      parseQuestionEcho('question.replied', {requestID: 'que_1', sessionID: 'ses_1', answers: [['a', 'b'], []]}),
    ).toEqual({kind: 'ok', value: {kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [['a', 'b'], []]}})
  })

  it('degrades unparseable answers to empty rather than dropping the authoritative settlement', () => {
    expect(parseQuestionEcho('question.replied', {requestID: 'que_1', sessionID: 'ses_1', answers: 'junk'})).toEqual({
      kind: 'ok',
      value: {kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: []},
    })
    expect(
      parseQuestionEcho('question.replied', {requestID: 'que_1', sessionID: 'ses_1', answers: [['a', 3], 'x']}),
    ).toEqual({kind: 'ok', value: {kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [['a'], []]}})
  })

  it('parses a rejected echo', () => {
    expect(parseQuestionEcho('question.rejected', {requestID: 'que_1', sessionID: 'ses_1'})).toEqual({
      kind: 'ok',
      value: {kind: 'rejected', requestID: 'que_1', sessionID: 'ses_1'},
    })
  })

  it.each([
    [{sessionID: 'ses_1'}, 'missing-request-id'],
    [{requestID: 'que_1'}, 'missing-session-id'],
    [null, 'missing-request-id'],
  ])('malformed echo %j → %s', (payload, reason) => {
    expect(parseQuestionEcho('question.rejected', payload)).toEqual({kind: 'malformed', reason})
  })
})

describe('safeLogId', () => {
  it('passes short id-shaped tokens and drops anything else', () => {
    expect(safeLogId('que_abc-123.x:y')).toBe('que_abc-123.x:y')
    expect(safeLogId(null)).toBeNull()
    expect(safeLogId('has spaces and SECRET text')).toBeNull()
    expect(safeLogId('a'.repeat(129))).toBeNull()
    expect(safeLogId('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

function parsedRequest(overrides: Record<string, unknown> = {}): QuestionAskedRequest {
  const parsed = parseQuestionRequest(askedPayload(overrides))
  if (parsed.kind === 'malformed') throw new Error('fixture malformed')
  return parsed.value
}

function setup(
  options: {readonly deadlineMs?: number | undefined; readonly effects?: Partial<QuestionSideEffects>} = {},
) {
  const logger = makeLogger()
  const gate = createRequestGate({logger})
  const registry = createQuestionRegistry({logger, gate})
  const effects: QuestionSideEffects = {
    replyQuestion: vi.fn().mockResolvedValue({ok: true}),
    rejectQuestion: vi.fn().mockResolvedValue({ok: true}),
    ...options.effects,
  }
  const computeDeadlineMs = vi.fn(() => ('deadlineMs' in options ? options.deadlineMs : 60_000))
  const coordinator = createQuestionCoordinator({logger, registry, effects, scopeId: 'scope-1', computeDeadlineMs})
  return {logger, gate, registry, effects, coordinator, computeDeadlineMs}
}

describe('createQuestionCoordinator', () => {
  it('registers the question with the run scope and the deadline computed at ask time', async () => {
    // #given
    const {coordinator, registry, computeDeadlineMs} = setup({deadlineMs: 75_000})
    const registerSpy = vi.spyOn(registry, 'register')

    // #when
    const outcome = await coordinator.onAsked(parsedRequest())

    // #then
    expect(outcome).toBe('registered')
    expect(computeDeadlineMs).toHaveBeenCalledOnce()
    expect(registerSpy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({requestID: 'que_1', sessionID: 'ses_1', questionScopeId: 'scope-1', deadlineMs: 75_000}),
    )
    expect(registry.describePendingForScope('scope-1')).toHaveLength(1)
  })

  it('a duplicate ask reports duplicate and keeps one entry', async () => {
    // #given
    const {coordinator, registry} = setup()
    await coordinator.onAsked(parsedRequest())

    // #when / #then
    expect(await coordinator.onAsked(parsedRequest())).toBe('duplicate')
    expect(registry.pending()).toEqual(['que_1'])
  })

  it('no deadline budget: replies once with an empty answer per question, registers nothing, reports skipped', async () => {
    // #given
    const {coordinator, registry, effects, logger} = setup({deadlineMs: undefined})
    const request = parsedRequest({
      questions: [
        {question: SECRET, header: SECRET, options: []},
        {question: 'second', header: 'h', options: []},
      ],
    })

    // #when
    const outcome = await coordinator.onAsked(request)

    // #then
    expect(outcome).toBe('skipped')
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [[], []])
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
    expect(registry.pending()).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({requestID: 'que_1', sessionID: 'ses_1', reason: 'no-deadline-budget'}),
      expect.any(String),
    )
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(SECRET)
  })

  it.each([
    ['an error result', {replyQuestion: vi.fn().mockResolvedValue({ok: false, error: SECRET})}],
    ['a thrown error', {replyQuestion: vi.fn().mockRejectedValue(new Error(SECRET))}],
  ])(
    'no budget and the skip reply fails with %s: still skipped, logged with a reason code only',
    async (_n, effects) => {
      // #given
      const {coordinator, logger} = setup({deadlineMs: undefined, effects})

      // #when
      const outcome = await coordinator.onAsked(parsedRequest())

      // #then
      expect(outcome).toBe('skipped')
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({requestID: 'que_1', reason: ANY_STRING}),
        expect.stringContaining('immediate skip reply failed'),
      )
      const logged = JSON.stringify([...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.error).mock.calls])
      expect(logged).not.toContain(SECRET)
    },
  )

  it('a registration that throws reports failed and never rejects', async () => {
    // #given a registry whose register throws
    const {coordinator, registry, logger} = setup()
    vi.spyOn(registry, 'register').mockImplementation(() => {
      throw new Error(SECRET)
    })

    // #when / #then
    await expect(coordinator.onAsked(parsedRequest())).resolves.toBe('failed')
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(SECRET)
  })

  it('onEcho settles a registered question without any POST; a throwing registry is contained', async () => {
    // #given
    const {coordinator, registry, effects} = setup()
    await coordinator.onAsked(parsedRequest())

    // #when
    coordinator.onEcho({kind: 'rejected', requestID: 'que_1', sessionID: 'ses_1'})

    // #then
    expect(registry.has('que_1')).toBe(false)
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(effects.rejectQuestion).not.toHaveBeenCalled()

    // #and a registry that throws does not escape
    vi.spyOn(registry, 'confirmEcho').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => {
      coordinator.onEcho({kind: 'rejected', requestID: 'que_2', sessionID: 'ses_1'})
    }).not.toThrow()
  })

  it('dispose rejects every still-pending question of the sessions it registered', async () => {
    // #given two pending questions on two sessions, plus one already settled
    const {coordinator, registry, effects} = setup()
    await coordinator.onAsked(parsedRequest({id: 'que_1', sessionID: 'ses_1'}))
    await coordinator.onAsked(parsedRequest({id: 'que_2', sessionID: 'ses_2'}))
    await coordinator.onAsked(parsedRequest({id: 'que_3', sessionID: 'ses_1'}))
    coordinator.onEcho({kind: 'rejected', requestID: 'que_3', sessionID: 'ses_1'})

    // #when
    await coordinator.dispose('run ended')

    // #then
    expect(registry.pending()).toEqual([])
    expect(
      vi
        .mocked(effects.rejectQuestion)
        .mock.calls.map(call => call[0])
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(['que_1', 'que_2'])
    expect(effects.replyQuestion).not.toHaveBeenCalled()
  })

  it('dispose with nothing registered is a no-op', async () => {
    const {coordinator, effects} = setup()
    await expect(coordinator.dispose('run ended')).resolves.toBeUndefined()
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
  })
})

describe('createQuestionCoordinator — announcement, run binding, malformed asks', () => {
  function setupWith(
    options: {
      readonly onRegistered?: (request: QuestionAskedRequest) => void
      readonly effects?: Partial<QuestionSideEffects>
    } = {},
  ) {
    const logger = makeLogger()
    const gate = createRequestGate({logger})
    const registry = createQuestionRegistry({logger, gate})
    const effects: QuestionSideEffects = {
      replyQuestion: vi.fn().mockResolvedValue({ok: true}),
      rejectQuestion: vi.fn().mockResolvedValue({ok: true}),
      ...options.effects,
    }
    const coordinator = createQuestionCoordinator({
      logger,
      registry,
      effects,
      scopeId: 'thread-1',
      runId: 'run-1',
      computeDeadlineMs: () => 60_000,
      ...(options.onRegistered === undefined ? {} : {onRegistered: options.onRegistered}),
    })
    return {logger, registry, effects, coordinator}
  }

  it('binds the question to the run id so web routes find it under a thread scope', async () => {
    // #given a Discord-style thread scope and a run id
    const {coordinator, registry} = setupWith()

    // #when
    await coordinator.onAsked(parsedRequest())

    // #then it is listed by run id as well as by scope
    expect(registry.describePendingForRun('run-1').map(dto => dto.requestID)).toEqual(['que_1'])
    expect(registry.describePendingForScope('thread-1')).toHaveLength(1)
  })

  it('announces a newly registered question once, after the registry holds it', async () => {
    // #given a hook that checks the registry at call time
    const held: boolean[] = []
    const holder: {registry?: ReturnType<typeof createQuestionRegistry>} = {}
    const onRegistered = vi.fn((request: QuestionAskedRequest) => {
      held.push(holder.registry?.has(request.requestID) === true)
    })
    const {coordinator, registry} = setupWith({onRegistered})
    holder.registry = registry

    // #when the question is asked twice
    await coordinator.onAsked(parsedRequest())
    await coordinator.onAsked(parsedRequest())

    // #then the duplicate is not re-announced
    expect(onRegistered).toHaveBeenCalledExactlyOnceWith(parsedRequest())
    expect(held).toEqual([true])
  })

  it('does not announce a question skipped for lack of budget', async () => {
    // #given
    const onRegistered = vi.fn()
    const logger = makeLogger()
    const registry = createQuestionRegistry({logger, gate: createRequestGate({logger})})
    const effects: QuestionSideEffects = {
      replyQuestion: vi.fn().mockResolvedValue({ok: true}),
      rejectQuestion: vi.fn().mockResolvedValue({ok: true}),
    }
    const coordinator = createQuestionCoordinator({
      logger,
      registry,
      effects,
      scopeId: 's',
      computeDeadlineMs: () => undefined,
      onRegistered,
    })

    // #when
    const outcome = await coordinator.onAsked(parsedRequest())

    // #then
    expect(outcome).toBe('skipped')
    expect(onRegistered).not.toHaveBeenCalled()
  })

  it('a throwing announcement keeps the question registered and logs the id and error name only', async () => {
    // #given a hook that throws an error carrying secret text
    const {coordinator, registry, logger} = setupWith({
      onRegistered: () => {
        throw new Error(SECRET)
      },
    })

    // #when
    const outcome = await coordinator.onAsked(parsedRequest())

    // #then
    expect(outcome).toBe('registered')
    expect(registry.has('que_1')).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({requestID: 'que_1', errName: 'Error'}),
      expect.stringContaining('onRegistered threw'),
    )
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(SECRET)
  })

  it('onMalformed rejects the request and logs ids and a reason code only', async () => {
    // #given
    const {coordinator, effects, logger} = setupWith()

    // #when
    await coordinator.onMalformed({requestID: 'que_bad', sessionID: 'ses_1', reason: 'invalid-question'})

    // #then
    expect(effects.rejectQuestion).toHaveBeenCalledExactlyOnceWith('que_bad')
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      {requestID: 'que_bad', sessionID: 'ses_1', reason: 'invalid-question'},
      expect.stringContaining('rejected'),
    )
  })

  it.each([
    ['an ok:false result', {rejectQuestion: vi.fn().mockResolvedValue({ok: false, error: SECRET})}, 'reject-error'],
    ['a thrown error', {rejectQuestion: vi.fn().mockRejectedValue(new Error(SECRET))}, 'reject-threw'],
  ])('onMalformed survives %s without leaking its text', async (_label, effects, code) => {
    // #given
    const {coordinator, logger} = setupWith({effects})

    // #when / #then it never rejects
    await expect(
      coordinator.onMalformed({requestID: 'que_bad', sessionID: 'ses_1', reason: 'invalid-questions'}),
    ).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({requestID: 'que_bad', rejectOutcome: code}),
      expect.stringContaining('could not be rejected'),
    )
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(SECRET)
  })

  it('onMalformed does not log an id that is not id-shaped', async () => {
    // #given an id carrying free text
    const {coordinator, logger} = setupWith()

    // #when
    await coordinator.onMalformed({requestID: `${SECRET} with spaces`, sessionID: 'ses_1', reason: 'invalid-question'})

    // #then it was still addressed for rejection, but never logged
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(SECRET)
  })
})
