/**
 * Tests for the question family of the shared request gate.
 *
 * Convention: `vi.fn()` for all injected side-effects; no real Discord.js or SDK.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionRequest} from './coordinator.js'
import type {
  QuestionDecisionOutcome,
  QuestionEffectResult,
  QuestionPromptInput,
  QuestionRegistry,
  QuestionRenderFn,
  QuestionSideEffects,
  RegisterQuestionParams,
} from './question-registry.js'
import type {ApprovalRegistry} from './registry.js'
import type {GateActor, TerminalEvent} from './request-gate.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {MAX_OPTIONS_PER_QUESTION, MAX_QUESTIONS_PER_REQUEST} from './question-detail.js'
import {
  createQuestionRegistry,
  emptyAnswers,
  QUESTION_ANSWER_MAX_LENGTH,
  validateQuestionAnswers,
} from './question-registry.js'
import {createApprovalRegistry} from './registry.js'
import {createRequestGate} from './request-gate.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

const OPTIONS = [
  {label: 'staging', description: 'Deploy to staging'},
  {label: 'prod', description: 'Deploy to production'},
] as const

/** `multiple` and `custom` omitted: upstream defaults a custom answer to allowed. */
const SINGLE: QuestionPromptInput = {question: 'Which environment?', header: 'Env', options: OPTIONS}
const MULTI: QuestionPromptInput = {question: 'Which targets?', header: 'Targets', options: OPTIONS, multiple: true}
const CLOSED: QuestionPromptInput = {question: 'Pick one', header: 'Closed', options: OPTIONS, custom: false}
const EXPLICIT_CUSTOM: QuestionPromptInput = {
  question: 'Anything else?',
  header: 'Other',
  options: OPTIONS,
  custom: true,
}

const WEB_ACTOR: GateActor = {kind: 'web-operator', githubUserId: 42, login: 'octocat', sessionCorrelationId: 'sess-1'}
const THREAD_ACTOR: GateActor = {kind: 'discord-user', userId: 'user_A'}

const OK: QuestionEffectResult = {ok: true}

function makeEffects(overrides: Partial<QuestionSideEffects> = {}): QuestionSideEffects {
  return {
    replyQuestion: vi.fn().mockResolvedValue(OK),
    rejectQuestion: vi.fn().mockResolvedValue(OK),
    ...overrides,
  }
}

function makeRenderFn(): QuestionRenderFn {
  return vi.fn().mockResolvedValue(undefined)
}

function makeParams(overrides: Partial<RegisterQuestionParams> = {}): RegisterQuestionParams {
  return {
    requestID: 'que_1',
    sessionID: 'ses_1',
    questionScopeId: 'thread_1',
    questions: [SINGLE],
    effects: makeEffects(),
    deadlineMs: 60_000,
    ...overrides,
  }
}

function setup(logger: GatewayLogger = makeLogger()) {
  const gate = createRequestGate({logger})
  const questions = createQuestionRegistry({logger, gate})
  const approvals = createApprovalRegistry({logger, gate})
  const terminals: TerminalEvent[] = []
  gate.onTerminal(event => {
    terminals.push(event)
  })
  return {logger, gate, questions, approvals, terminals}
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function decideAnswer(
  questions: QuestionRegistry,
  answers: readonly (readonly string[])[],
  overrides: {readonly requestID?: string; readonly scopeId?: string; readonly actor?: GateActor} = {},
): Promise<QuestionDecisionOutcome> {
  return questions.decide({
    requestID: overrides.requestID ?? 'que_1',
    scopeId: overrides.scopeId ?? 'thread_1',
    decision: {kind: 'answer', answers},
    actor: overrides.actor ?? THREAD_ACTOR,
  })
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

describe('answering a question', () => {
  it('valid single-option answer: claimed, one reply POST, echo confirms, entry deleted, one terminal event', async () => {
    // #given a registered single-option question with a rendered prompt
    const {questions, terminals} = setup()
    const effects = makeEffects()
    const render = makeRenderFn()
    questions.register(makeParams({effects}))
    questions.attachMessage('que_1', render)

    // #when an operator answers
    const outcome = await decideAnswer(questions, [['staging']])

    // #then one reply POST, entry claimed (not actionable, still pending), nothing settled yet
    expect(outcome).toEqual({kind: 'ok'})
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['staging']])
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
    expect(questions.hasPendingForScope('thread_1')).toBe(true)
    expect(questions.describePendingForScope('thread_1')).toEqual([])
    expect(terminals).toEqual([])

    // #when OpenCode echoes the reply
    questions.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [['staging']]})
    await flush()

    // #then the entry is gone, rendered with the claiming actor, and exactly one terminal event fired
    expect(questions.has('que_1')).toBe(false)
    expect(render).toHaveBeenCalledExactlyOnceWith(expect.any(Array), {
      reason: 'replied',
      answers: [['staging']],
      actor: THREAD_ACTOR,
    })
    expect(terminals).toEqual([
      {requestID: 'que_1', sessionID: 'ses_1', family: 'question', scopeId: 'thread_1', outcome: 'confirmed'},
    ])
  })

  it('multi-select answer on a multiple question is sent as given', async () => {
    // #given a multiple question
    const {questions} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects, questions: [MULTI]}))

    // #when two options are chosen
    const outcome = await decideAnswer(questions, [['staging', 'prod']])

    // #then both labels are in one reply
    expect(outcome).toEqual({kind: 'ok'})
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['staging', 'prod']])
  })

  it.each([
    ['custom omitted (upstream default allows it)', SINGLE],
    ['custom: true', EXPLICIT_CUSTOM],
  ])('free-text answer is accepted when %s', async (_name, prompt) => {
    // #given a question that allows a custom answer
    const {questions} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects, questions: [prompt]}))

    // #when the operator types an answer that is not an option label
    const outcome = await decideAnswer(questions, [['something else entirely']])

    // #then it is sent verbatim
    expect(outcome).toEqual({kind: 'ok'})
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['something else entirely']])
  })

  it('a free-text answer of exactly the cap length is accepted', async () => {
    // #given
    const {questions} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects}))
    const text = 'a'.repeat(QUESTION_ANSWER_MAX_LENGTH)

    // #when / #then
    expect(await decideAnswer(questions, [[text]])).toEqual({kind: 'ok'})
    expect(effects.replyQuestion).toHaveBeenCalledOnce()
  })

  it('the sent answers are a copy: mutating the caller arrays after the call changes nothing', async () => {
    // #given a deferred reply so the POST is still pending
    const {questions} = setup()
    let sent: readonly (readonly string[])[] = []
    const effects = makeEffects({
      replyQuestion: vi.fn(async (_id: string, answers: readonly (readonly string[])[]) => {
        sent = answers
        return OK
      }),
    })
    questions.register(makeParams({effects}))
    const values = ['staging']

    // #when
    await decideAnswer(questions, [values])
    values.push('mutated')

    // #then
    expect(sent).toEqual([['staging']])
  })
})

describe('skipping a question', () => {
  it('replies with one empty answer per question and never rejects', async () => {
    // #given a three-question request
    const {questions, terminals} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects, questions: [SINGLE, MULTI, CLOSED]}))

    // #when an operator skips
    const outcome = await questions.decide({
      requestID: 'que_1',
      scopeId: 'thread_1',
      decision: {kind: 'skip'},
      actor: WEB_ACTOR,
    })

    // #then an empty reply for every question; reject is reserved for teardown
    expect(outcome).toEqual({kind: 'ok'})
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [[], [], []])
    expect(effects.rejectQuestion).not.toHaveBeenCalled()

    // #when the echo arrives
    questions.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [[], [], []]})
    await flush()

    // #then settled once
    expect(terminals).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('answer validation (no POST, entry stays open)', () => {
  const cases: readonly {
    readonly name: string
    readonly questions: readonly QuestionPromptInput[]
    readonly answers: readonly (readonly string[])[]
    readonly reason: string
    readonly questionIndex: number | null
  }[] = [
    {
      name: 'two answers for a three-question request',
      questions: [SINGLE, MULTI, CLOSED],
      answers: [['staging'], ['prod']],
      reason: 'arity-mismatch',
      questionIndex: null,
    },
    {
      name: 'unknown option label on a closed question',
      questions: [CLOSED],
      answers: [['qa']],
      reason: 'unknown-option',
      questionIndex: 0,
    },
    {
      name: 'free text on a custom:false question',
      questions: [SINGLE, CLOSED],
      answers: [['staging'], ['typed answer']],
      reason: 'unknown-option',
      questionIndex: 1,
    },
    {
      name: 'multiple values on a question without multiple',
      questions: [SINGLE],
      answers: [['staging', 'prod']],
      reason: 'multiple-not-allowed',
      questionIndex: 0,
    },
    {
      name: 'free text over the cap',
      questions: [SINGLE],
      answers: [['a'.repeat(QUESTION_ANSWER_MAX_LENGTH + 1)]],
      reason: 'text-too-long',
      questionIndex: 0,
    },
    {
      name: 'empty free text',
      questions: [SINGLE],
      answers: [['']],
      reason: 'empty-value',
      questionIndex: 0,
    },
    {
      name: 'whitespace-only free text',
      questions: [SINGLE],
      answers: [['   \n\t']],
      reason: 'empty-value',
      questionIndex: 0,
    },
  ]

  it.each(cases)('$name', async ({questions: prompts, answers, reason, questionIndex}) => {
    // #given an open question
    const {questions, terminals} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects, questions: prompts}))

    // #when the answer is invalid
    const outcome = await decideAnswer(questions, answers)

    // #then a typed validation outcome, no POST, entry still open and answerable
    expect(outcome).toEqual({kind: 'invalid', reason, questionIndex})
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
    expect(questions.describePendingForScope('thread_1')).toHaveLength(1)
    expect(terminals).toEqual([])
  })

  it('a rejected answer does not consume the claim: a corrected answer then succeeds', async () => {
    // #given an invalid attempt
    const {questions} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects, questions: [CLOSED]}))
    await decideAnswer(questions, [['nope']])

    // #when the operator retries with a known label
    const outcome = await decideAnswer(questions, [['prod']])

    // #then
    expect(outcome).toEqual({kind: 'ok'})
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['prod']])
  })

  it('validateQuestionAnswers accepts an empty array for a question (left unanswered)', () => {
    // #given
    const prompts = [SINGLE, MULTI].map(prompt => ({
      ...prompt,
      multiple: prompt.multiple === true,
      custom: prompt.custom !== false,
    }))

    // #when / #then
    expect(validateQuestionAnswers(prompts, [['staging'], []])).toEqual({kind: 'valid'})
  })

  it('emptyAnswers produces one empty array per question', () => {
    expect(emptyAnswers([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

describe('register', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a deadline of %s', deadlineMs => {
    // #given
    const {questions} = setup()

    // #when
    const outcome = questions.register(makeParams({deadlineMs}))

    // #then
    expect(outcome).toEqual({kind: 'refused', reason: 'deadline-required'})
    expect(questions.has('que_1')).toBe(false)
  })

  it('registers a request exactly at both count caps', () => {
    // #given the largest accepted request
    const {questions} = setup()
    const options = Array.from({length: MAX_OPTIONS_PER_QUESTION}, (_, index) => ({
      label: `o${index}`,
      description: '',
    }))
    const wide: QuestionPromptInput = {question: 'Which?', header: 'H', options}

    // #when
    const outcome = questions.register(
      makeParams({questions: Array.from({length: MAX_QUESTIONS_PER_REQUEST}, () => wide)}),
    )

    // #then
    expect(outcome).toEqual({kind: 'registered'})
    expect(questions.has('que_1')).toBe(true)
  })

  it.each([
    ['one question over the cap', MAX_QUESTIONS_PER_REQUEST + 1, 2],
    ['one option over the cap', 1, MAX_OPTIONS_PER_QUESTION + 1],
  ])('refuses %s as oversize and stores nothing', (_label, questionCount, optionCount) => {
    // #given an oversize request
    const {questions, terminals} = setup()
    const options = Array.from({length: optionCount}, (_, index) => ({label: `o${index}`, description: ''}))
    const oversize: QuestionPromptInput = {question: 'Which?', header: 'H', options}

    // #when
    const outcome = questions.register(makeParams({questions: Array.from({length: questionCount}, () => oversize)}))

    // #then it is refused and invisible everywhere
    expect(outcome).toEqual({kind: 'refused', reason: 'oversize'})
    expect(questions.has('que_1')).toBe(false)
    expect(questions.pending()).toEqual([])
    expect(questions.describePendingForScope('thread_1')).toEqual([])
    expect(terminals).toEqual([])
  })

  it('duplicate register for a pending id is a no-op: existing entry, flags and deadline are kept', async () => {
    // #given a question with a 1s deadline
    const {questions, terminals} = setup()
    const first = makeEffects()
    const second = makeEffects()
    expect(questions.register(makeParams({effects: first, deadlineMs: 1_000, questions: [SINGLE]}))).toEqual({
      kind: 'registered',
    })
    await vi.advanceTimersByTimeAsync(500)

    // #when the same id is registered again with a longer deadline and different shape
    const outcome = questions.register(makeParams({effects: second, deadlineMs: 60_000, questions: [CLOSED, MULTI]}))

    // #then it is reported as a duplicate and the original keeps its deadline
    expect(outcome).toEqual({kind: 'duplicate'})
    expect(questions.describePendingForScope('thread_1')[0]?.questions).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(600)
    expect(first.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [[]])
    expect(second.replyQuestion).not.toHaveBeenCalled()
    expect(terminals).toHaveLength(1)
  })

  it('normalizes custom and multiple to booleans in the stored shape', () => {
    // #given prompts with the flags omitted, true and false
    const {questions} = setup()
    questions.register(makeParams({questions: [SINGLE, MULTI, CLOSED]}))

    // #when
    const dto = questions.describePendingForScope('thread_1')[0]

    // #then custom defaults to true; multiple defaults to false
    expect(dto?.questions.map(q => [q.multiple, q.custom])).toEqual([
      [false, true],
      [true, true],
      [false, false],
    ])
  })
})

// ---------------------------------------------------------------------------
// Races, deadline, failures
// ---------------------------------------------------------------------------

describe('single-winner claim', () => {
  it('two concurrent answers: one wins, the other reports already-claimed, one POST', async () => {
    // #given a reply POST that stays in flight
    const {questions} = setup()
    let resolveReply!: (result: QuestionEffectResult) => void
    const effects = makeEffects({
      replyQuestion: vi.fn().mockReturnValue(
        new Promise<QuestionEffectResult>(resolve => {
          resolveReply = resolve
        }),
      ),
    })
    questions.register(makeParams({effects}))

    // #when two operators answer at once
    const first = decideAnswer(questions, [['staging']])
    const second = decideAnswer(questions, [['prod']], {actor: WEB_ACTOR})
    resolveReply(OK)

    // #then
    expect(await first).toEqual({kind: 'ok'})
    expect(await second).toEqual({kind: 'already-claimed'})
    expect(effects.replyQuestion).toHaveBeenCalledOnce()
  })

  it('an answer after the entry settled reports not-found', async () => {
    // #given a settled question
    const {questions} = setup()
    questions.register(makeParams())
    questions.confirmEcho({kind: 'rejected', requestID: 'que_1', sessionID: 'ses_1'})
    await flush()

    // #when / #then
    expect(await decideAnswer(questions, [['staging']])).toEqual({kind: 'not-found'})
  })
})

describe('deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('open entry: one empty-answer reply (never reject), one terminal event, a later echo adds none', async () => {
    // #given
    const {questions, terminals} = setup()
    const effects = makeEffects()
    const render = makeRenderFn()
    const onDeadlineSettled = vi.fn()
    questions.register(makeParams({effects, deadlineMs: 1_000, questions: [SINGLE, MULTI], onDeadlineSettled}))
    questions.attachMessage('que_1', render)

    // #when the deadline passes
    await vi.advanceTimersByTimeAsync(1_000)

    // #then the question is skipped, not rejected, and left the gate
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [[], []])
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
    expect(questions.has('que_1')).toBe(false)
    expect(render).toHaveBeenCalledExactlyOnceWith(expect.any(Array), {reason: 'deadline', actor: null})
    expect(onDeadlineSettled).toHaveBeenCalledOnce()
    expect(terminals).toEqual([
      {requestID: 'que_1', sessionID: 'ses_1', family: 'question', scopeId: 'thread_1', outcome: 'deadline'},
    ])

    // #when OpenCode's echo arrives after the fact
    questions.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [[], []]})
    await vi.advanceTimersByTimeAsync(10)

    // #then no second notification and no second render
    expect(terminals).toHaveLength(1)
    expect(render).toHaveBeenCalledOnce()
  })

  it('claimed entry: the answer wins and the deadline sends nothing', async () => {
    // #given an answer in flight when the deadline fires
    const {questions, terminals} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects, deadlineMs: 1_000}))
    await decideAnswer(questions, [['staging']])

    // #when the deadline passes
    await vi.advanceTimersByTimeAsync(1_000)

    // #then only the answer POST exists; the entry waits for its echo
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['staging']])
    expect(questions.has('que_1')).toBe(true)
    expect(terminals).toEqual([])
  })

  it('answer claimed, deadline fires, answer POST then fails: fail-closes with an empty-answer skip, one terminal event', async () => {
    // #given an answer POST that we control
    const {questions, terminals} = setup()
    let resolveReply!: (result: QuestionEffectResult) => void
    const replyQuestion = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<QuestionEffectResult>(resolve => {
          resolveReply = resolve
        }),
      )
      .mockResolvedValue(OK)
    const effects = makeEffects({replyQuestion})
    const render = makeRenderFn()
    questions.register(makeParams({effects, deadlineMs: 1_000}))
    questions.attachMessage('que_1', render)
    const decision = decideAnswer(questions, [['staging']])

    // #when the deadline fires while the answer is in flight, then the answer POST fails
    await vi.advanceTimersByTimeAsync(1_000)
    expect(questions.has('que_1')).toBe(true)
    resolveReply({ok: false, error: 'boom'})
    expect(await decision).toEqual({kind: 'reply-failed'})
    await vi.advanceTimersByTimeAsync(10)

    // #then the entry fail-closed with a skip (not a reject), once
    expect(replyQuestion).toHaveBeenCalledTimes(2)
    expect(replyQuestion).toHaveBeenLastCalledWith('que_1', [[]])
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
    expect(questions.has('que_1')).toBe(false)
    expect(render).toHaveBeenCalledExactlyOnceWith(expect.any(Array), {reason: 'deadline', actor: null})
    expect(terminals.map(event => event.outcome)).toEqual(['fail-closed'])

    // #when a late echo arrives
    questions.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [[]]})
    await vi.advanceTimersByTimeAsync(10)

    // #then still one notification
    expect(terminals).toHaveLength(1)
  })

  it('echo arriving while the deadline skip is in flight settles once: one render, one terminal event', async () => {
    // #given a deadline skip POST that stays in flight
    const {questions, terminals} = setup()
    let resolveReply!: (result: QuestionEffectResult) => void
    const effects = makeEffects({
      replyQuestion: vi.fn().mockReturnValue(
        new Promise<QuestionEffectResult>(resolve => {
          resolveReply = resolve
        }),
      ),
    })
    const render = makeRenderFn()
    questions.register(makeParams({effects, deadlineMs: 1_000}))
    questions.attachMessage('que_1', render)
    await vi.advanceTimersByTimeAsync(1_000)

    // #when OpenCode's echo for the skip lands before the POST resolves, then the POST resolves
    questions.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [[]]})
    resolveReply(OK)
    await vi.advanceTimersByTimeAsync(10)

    // #then the echo settled it: rendered once, one notification, nothing left
    expect(render).toHaveBeenCalledOnce()
    expect(terminals.map(event => event.outcome)).toEqual(['confirmed'])
    expect(questions.has('que_1')).toBe(false)
  })

  it('deadline skip POST failing still removes the entry and emits one terminal event with no echo', async () => {
    // #given a skip POST that reports an error
    const {questions, terminals} = setup()
    const effects = makeEffects({replyQuestion: vi.fn().mockResolvedValue({ok: false, error: 'down'})})
    questions.register(makeParams({effects, deadlineMs: 1_000}))

    // #when the deadline passes
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(questions.has('que_1')).toBe(false)
    expect(terminals.map(event => event.outcome)).toEqual(['deadline'])
  })

  it('an echo clears the deadline timer', async () => {
    // #given
    const {questions} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects, deadlineMs: 1_000}))

    // #when the echo arrives first
    questions.confirmEcho({kind: 'rejected', requestID: 'que_1', sessionID: 'ses_1'})
    await vi.advanceTimersByTimeAsync(5_000)

    // #then the deadline never POSTs
    expect(effects.replyQuestion).not.toHaveBeenCalled()
  })
})

describe('reply failures', () => {
  it('replyQuestion reporting an error releases the claim to open and allows a retry', async () => {
    // #given the first reply fails, the second succeeds
    const {questions, terminals} = setup()
    const replyQuestion = vi.fn().mockResolvedValueOnce({ok: false, error: 'down'}).mockResolvedValue(OK)
    questions.register(makeParams({effects: makeEffects({replyQuestion})}))

    // #when
    const first = await decideAnswer(questions, [['staging']])

    // #then the entry is open again and no terminal event fired
    expect(first).toEqual({kind: 'reply-failed'})
    expect(questions.describePendingForScope('thread_1')).toHaveLength(1)
    expect(terminals).toEqual([])

    // #when retried
    const second = await decideAnswer(questions, [['staging']])

    // #then
    expect(second).toEqual({kind: 'ok'})
    expect(replyQuestion).toHaveBeenCalledTimes(2)
  })

  it('replyQuestion throwing is contained: reply-failed, entry open, nothing thrown to the caller', async () => {
    // #given
    const {questions} = setup()
    const effects = makeEffects({replyQuestion: vi.fn().mockRejectedValue(new Error('network'))})
    questions.register(makeParams({effects}))

    // #when / #then
    await expect(decideAnswer(questions, [['staging']])).resolves.toEqual({kind: 'reply-failed'})
    expect(questions.describePendingForScope('thread_1')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// OpenCode-originated settlement
// ---------------------------------------------------------------------------

describe('echo on an open entry', () => {
  it.each([
    ['question.rejected', {kind: 'rejected', requestID: 'que_1', sessionID: 'ses_1'} as const, 'rejected'],
    [
      'question.replied',
      {kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [['staging']]} as const,
      'replied',
    ],
  ])('%s settles without any gateway POST and emits one terminal event', async (_name, echo, reason) => {
    // #given an open question nobody on the gateway touched
    const {questions, terminals} = setup()
    const effects = makeEffects()
    const render = makeRenderFn()
    questions.register(makeParams({effects}))
    questions.attachMessage('que_1', render)

    // #when OpenCode settles it
    questions.confirmEcho(echo)
    await flush()

    // #then rendered, no POST, entry gone, one notification
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
    expect(render).toHaveBeenCalledExactlyOnceWith(expect.any(Array), expect.objectContaining({reason, actor: null}))
    expect(questions.has('que_1')).toBe(false)
    expect(terminals.map(event => event.outcome)).toEqual(['confirmed'])
  })

  it('a repeated echo does not emit a second terminal event', async () => {
    // #given
    const {questions, terminals} = setup()
    questions.register(makeParams())
    questions.confirmEcho({kind: 'rejected', requestID: 'que_1', sessionID: 'ses_1'})
    await flush()

    // #when
    questions.confirmEcho({kind: 'rejected', requestID: 'que_1', sessionID: 'ses_1'})
    await flush()

    // #then
    expect(terminals).toHaveLength(1)
  })

  it('an echo from a different session is ignored', async () => {
    // #given
    const {questions, terminals} = setup()
    questions.register(makeParams())

    // #when
    questions.confirmEcho({kind: 'rejected', requestID: 'que_1', sessionID: 'ses_OTHER'})
    await flush()

    // #then
    expect(questions.has('que_1')).toBe(true)
    expect(terminals).toEqual([])
  })

  it('an echo for an unknown id is a no-op', () => {
    const {questions} = setup()
    expect(() => {
      questions.confirmEcho({kind: 'rejected', requestID: 'que_GONE', sessionID: 'ses_1'})
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Teardown across families
// ---------------------------------------------------------------------------

function makePermission(requestID: string, sessionID = 'ses_1'): PermissionRequest {
  return {requestID, sessionID, permission: 'bash', patterns: ['ls'], title: 'Run ls'}
}

function registerApproval(approvals: ApprovalRegistry, postReply = vi.fn().mockResolvedValue({ok: true})) {
  approvals.register({
    requestID: 'per_1',
    sessionID: 'ses_1',
    approvalScopeId: 'thread_1',
    directory: '/ws',
    request: makePermission('per_1'),
    effects: {postReply},
  })
  return postReply
}

/** A reply POST the test settles by hand. */
function deferredReply() {
  let settle!: (result: QuestionEffectResult) => void
  const promise = new Promise<QuestionEffectResult>(resolve => {
    settle = resolve
  })
  return {promise, settle}
}

describe('disposeRun across families', () => {
  it('run teardown: each registry disposes its own family, so the approval is fail-closed and the question rejected, once each', async () => {
    // #given one approval and one question pending on the same session
    const {questions, approvals, terminals} = setup()
    const qEffects = makeEffects()
    const approvalRender = vi.fn().mockResolvedValue(undefined)
    const questionRender = makeRenderFn()
    const postReply = registerApproval(approvals)
    approvals.attachMessage('per_1', approvalRender)
    questions.register(makeParams({effects: qEffects}))
    questions.attachMessage('que_1', questionRender)

    // #when the run is torn down, approvals first and then questions (the order run.ts uses)
    await approvals.disposeRun('ses_1', 'run-ended')
    expect(questions.pending()).toEqual(['que_1'])
    await questions.disposeRun('ses_1', 'run-ended')

    // #then the approval fail-closes as before; the question is rejected (turn-ending), not skipped
    expect(postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/ws', 'reject')
    expect(qEffects.rejectQuestion).toHaveBeenCalledExactlyOnceWith('que_1')
    expect(qEffects.replyQuestion).not.toHaveBeenCalled()
    expect(approvalRender).toHaveBeenCalledOnce()
    expect(questionRender).toHaveBeenCalledExactlyOnceWith(expect.any(Array), {reason: 'disposed', actor: null})
    expect(approvals.pending()).toEqual([])
    expect(questions.pending()).toEqual([])
    expect(terminals.map(event => `${event.family}:${event.outcome}`)).toEqual([
      'approval:disposed',
      'question:disposed',
    ])
  })

  it('the approval registry disposes only approvals; the question registry disposes only questions', async () => {
    // #given one of each on the same session
    const {questions, approvals, terminals} = setup()
    const qEffects = makeEffects()
    registerApproval(approvals)
    questions.register(makeParams({effects: qEffects}))

    // #when only the approval registry tears the session down
    await approvals.disposeRun('ses_1', 'run-ended')

    // #then the question is untouched
    expect(approvals.pending()).toEqual([])
    expect(questions.pending()).toEqual(['que_1'])
    expect(qEffects.rejectQuestion).not.toHaveBeenCalled()
    expect(terminals.map(event => event.family)).toEqual(['approval'])

    // #when the question registry then does the same
    registerApproval(approvals)
    await questions.disposeRun('ses_1', 'run-ended')

    // #then the new approval is untouched
    expect(questions.pending()).toEqual([])
    expect(approvals.pending()).toEqual(['per_1'])
    expect(terminals.map(event => event.family)).toEqual(['approval', 'question'])
  })

  it('the same holds for disposeAll on each registry', async () => {
    // #given one of each
    const {questions, approvals} = setup()
    registerApproval(approvals)
    questions.register(makeParams())

    // #when / #then each registry's disposeAll leaves the other family alone
    await approvals.disposeAll('shutdown')
    expect(approvals.pending()).toEqual([])
    expect(questions.pending()).toEqual(['que_1'])
    await questions.disposeAll('shutdown')
    expect(questions.pending()).toEqual([])
  })

  it('the gate-level cross-family dispose settles both families exactly once (gateway shutdown)', async () => {
    // #given one approval and one question on different sessions
    const {gate, questions, approvals, terminals} = setup()
    const qEffects = makeEffects()
    const postReply = registerApproval(approvals)
    questions.register(makeParams({sessionID: 'ses_2', effects: qEffects}))

    // #when shutdown disposes across families (twice: the second call finds nothing)
    await gate.disposeAllAcrossFamilies('gateway shutdown')
    await gate.disposeAllAcrossFamilies('gateway shutdown')

    // #then both are settled exactly once
    expect(postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/ws', 'reject')
    expect(qEffects.rejectQuestion).toHaveBeenCalledExactlyOnceWith('que_1')
    expect(approvals.pending()).toEqual([])
    expect(questions.pending()).toEqual([])
    expect(terminals.map(event => `${event.family}:${event.outcome}`).sort((a, b) => a.localeCompare(b))).toEqual([
      'approval:disposed',
      'question:disposed',
    ])
  })

  it('only the matching session is disposed', async () => {
    // #given questions on two sessions
    const {questions} = setup()
    questions.register(makeParams({requestID: 'que_1', sessionID: 'ses_1'}))
    questions.register(makeParams({requestID: 'que_2', sessionID: 'ses_2'}))

    // #when
    await questions.disposeRun('ses_1', 'run-ended')

    // #then
    expect(questions.pending()).toEqual(['que_2'])
  })

  it('a claimed question is torn down without a second POST', async () => {
    // #given a claimed question
    const {questions, terminals} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects}))
    await decideAnswer(questions, [['staging']])

    // #when
    await questions.disposeRun('ses_1', 'run-ended')

    // #then the claimant owns the outcome: no reject POST, entry gone, one event
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
    expect(questions.has('que_1')).toBe(false)
    expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
  })

  describe('teardown while the claimant reply is still in flight', () => {
    it('the reply fails after teardown: the request is rejected once, and the entry is never reopened or re-rendered', async () => {
      // #given an answer whose reply POST is still in flight, on a question with a rendered prompt
      const {questions, terminals} = setup()
      const reply = deferredReply()
      const effects = makeEffects({replyQuestion: vi.fn().mockReturnValue(reply.promise)})
      const render = makeRenderFn()
      questions.register(makeParams({effects}))
      questions.attachMessage('que_1', render)
      const decision = decideAnswer(questions, [['staging']])
      await flush()
      expect(effects.replyQuestion).toHaveBeenCalledOnce()

      // #when the run is torn down mid-flight, and then the reply fails
      await questions.disposeRun('ses_1', 'run-ended')
      expect(effects.rejectQuestion).not.toHaveBeenCalled()
      reply.settle({ok: false, error: 'down'})
      const outcome = await decision

      // #then the orphaned request is rejected exactly once and the claimant sees the failure
      expect(outcome).toEqual({kind: 'reply-failed'})
      expect(effects.rejectQuestion).toHaveBeenCalledExactlyOnceWith('que_1')
      // #and the entry stayed gone: not pending, not actionable, rendered once, one terminal event
      expect(questions.has('que_1')).toBe(false)
      expect(questions.pending()).toEqual([])
      expect(questions.hasPendingForScope('thread_1')).toBe(false)
      expect(render).toHaveBeenCalledExactlyOnceWith(expect.any(Array), {reason: 'disposed', actor: THREAD_ACTOR})
      expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
    })

    it('the reply throws after teardown: the request is rejected once', async () => {
      // #given
      const {questions} = setup()
      let fail!: (error: Error) => void
      const effects = makeEffects({
        replyQuestion: vi.fn().mockReturnValue(
          new Promise<QuestionEffectResult>((_resolve, reject) => {
            fail = reject
          }),
        ),
      })
      questions.register(makeParams({effects}))
      const decision = decideAnswer(questions, [['staging']])
      await flush()

      // #when
      await questions.disposeRun('ses_1', 'run-ended')
      fail(new Error('boom'))
      const outcome = await decision

      // #then
      expect(outcome).toEqual({kind: 'reply-failed'})
      expect(effects.rejectQuestion).toHaveBeenCalledExactlyOnceWith('que_1')
    })

    it('the reply succeeds after teardown: nothing is rejected', async () => {
      // #given
      const {questions, terminals} = setup()
      const reply = deferredReply()
      const effects = makeEffects({replyQuestion: vi.fn().mockReturnValue(reply.promise)})
      questions.register(makeParams({effects}))
      const decision = decideAnswer(questions, [['staging']])
      await flush()

      // #when the run is torn down and then the reply lands
      await questions.disposeRun('ses_1', 'run-ended')
      reply.settle({ok: true})
      const outcome = await decision

      // #then OpenCode got the answer; no reject follows it
      expect(outcome).toEqual({kind: 'ok'})
      expect(effects.rejectQuestion).not.toHaveBeenCalled()
      expect(questions.has('que_1')).toBe(false)
      expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
    })

    it('a second decision arriving while the claimed entry is being torn down is refused', async () => {
      // #given a claimed entry whose settled render is slow, so teardown is mid-flight
      const {questions} = setup()
      const reply = deferredReply()
      const effects = makeEffects({replyQuestion: vi.fn().mockReturnValue(reply.promise)})
      let finishRender!: () => void
      questions.register(makeParams({effects}))
      questions.attachMessage(
        'que_1',
        vi.fn().mockReturnValue(
          new Promise<void>(resolve => {
            finishRender = resolve
          }),
        ),
      )
      const decision = decideAnswer(questions, [['staging']])
      await flush()
      const teardown = questions.disposeRun('ses_1', 'run-ended')
      await flush()

      // #when another operator decides during teardown
      const second = await decideAnswer(questions, [['prod']])

      // #then it loses the single-winner check and no second reply goes out
      expect(second).toEqual({kind: 'already-claimed'})
      expect(effects.replyQuestion).toHaveBeenCalledOnce()

      finishRender()
      await teardown
      reply.settle({ok: true})
      await decision
    })
  })

  describe('teardown is terminal and final', () => {
    it('a settled render whose failure log also throws still removes the question and emits one event', async () => {
      // #given a question whose render rejects while the log sink throws on the failure record
      const {questions, logger, terminals} = setup()
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      const effects = makeEffects()
      questions.register(makeParams({effects}))
      questions.attachMessage('que_1', vi.fn().mockRejectedValue(new Error('SECRET-TEXT discord down')))
      vi.mocked(logger.error).mockImplementationOnce(() => {
        throw new Error('log sink down')
      })

      try {
        // #when the run is torn down
        await expect(questions.disposeRun('ses_1', 'run-ended')).resolves.toBeUndefined()
        await flush()

        // #then it is gone, rejected once, exactly one event fired, and nothing was left unhandled
        expect(questions.has('que_1')).toBe(false)
        expect(effects.rejectQuestion).toHaveBeenCalledExactlyOnceWith('que_1')
        expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
        expect(unhandled).not.toHaveBeenCalled()
        expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('SECRET-TEXT')
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    })

    it('an echo landing while a claimed question is being torn down is ignored: one render, one terminal event', async () => {
      // #given a claimed question (its reply landed, the echo is pending) whose settled render is held open
      const {questions, terminals} = setup()
      const effects = makeEffects()
      let finishRender!: () => void
      const render: QuestionRenderFn = vi.fn().mockReturnValue(
        new Promise<void>(resolve => {
          finishRender = resolve
        }),
      )
      questions.register(makeParams({effects}))
      questions.attachMessage('que_1', render)
      expect(await decideAnswer(questions, [['staging']])).toEqual({kind: 'ok'})
      const teardown = questions.disposeRun('ses_1', 'run-ended')
      await flush()
      expect(render).toHaveBeenCalledExactlyOnceWith(expect.any(Array), {reason: 'disposed', actor: THREAD_ACTOR})

      // #when OpenCode's replied echo arrives mid-teardown, and then the render is released
      questions.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [['staging']]})
      await flush()
      expect(terminals).toEqual([])
      finishRender()
      await teardown

      // #then there was no "replied" render and no confirmed event: teardown's single event is the only one
      expect(render).toHaveBeenCalledOnce()
      expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
      expect(questions.has('que_1')).toBe(false)
    })
  })

  it('reject failure on teardown still removes the entry and emits one event', async () => {
    // #given
    const {questions, terminals} = setup()
    const effects = makeEffects({rejectQuestion: vi.fn().mockRejectedValue(new Error('down'))})
    questions.register(makeParams({effects}))

    // #when
    await questions.disposeRun('ses_1', 'run-ended')

    // #then
    expect(questions.has('que_1')).toBe(false)
    expect(terminals).toHaveLength(1)
  })
})

describe('approval cascade is unaffected by questions', () => {
  it('rejecting one approval cascades to sibling approvals but not to a question on the same session', async () => {
    // #given two approvals and a question on one session
    const {questions, approvals} = setup()
    const postReplyB = vi.fn().mockResolvedValue({ok: true})
    const qEffects = makeEffects()
    for (const [id, postReply] of [
      ['per_A', vi.fn().mockResolvedValue({ok: true})],
      ['per_B', postReplyB],
    ] as const) {
      approvals.register({
        requestID: id,
        sessionID: 'ses_1',
        approvalScopeId: 'thread_1',
        directory: '/ws',
        request: makePermission(id),
        effects: {postReply},
      })
    }
    questions.register(makeParams({effects: qEffects}))

    // #when approval A is rejected
    approvals.confirmReply({requestID: 'per_A', sessionID: 'ses_1', reply: 'reject'})
    await flush()

    // #then B is cascade-rejected, the question is untouched
    expect(postReplyB).toHaveBeenCalledExactlyOnceWith('per_B', '/ws', 'reject')
    expect(questions.has('que_1')).toBe(true)
    expect(qEffects.rejectQuestion).not.toHaveBeenCalled()
    expect(qEffects.replyQuestion).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Scope policy and family isolation
// ---------------------------------------------------------------------------

describe('scope policy', () => {
  it('a Discord actor from another thread is refused and nothing is sent', async () => {
    // #given a question scoped to thread_1
    const {questions} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects}))

    // #when a user acting from thread_2 answers
    const outcome = await decideAnswer(questions, [['staging']], {scopeId: 'thread_2', actor: THREAD_ACTOR})

    // #then
    expect(outcome).toEqual({kind: 'scope-mismatch'})
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(questions.describePendingForScope('thread_1')).toHaveLength(1)
  })

  it('a Discord actor from the entry thread is accepted', async () => {
    const {questions} = setup()
    questions.register(makeParams())
    expect(await decideAnswer(questions, [['staging']], {scopeId: 'thread_1', actor: THREAD_ACTOR})).toEqual({
      kind: 'ok',
    })
  })

  it('a web operator is accepted on a Discord-scoped question regardless of the scope it passes', async () => {
    // #given a Discord-thread-scoped question
    const {questions} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects}))

    // #when a web operator (authorized by the route) answers with the run id as scope
    const outcome = await decideAnswer(questions, [['prod']], {scopeId: 'run-abc', actor: WEB_ACTOR})

    // #then
    expect(outcome).toEqual({kind: 'ok'})
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['prod']])
  })
})

describe('family isolation on a shared gate', () => {
  it('approval queries ignore questions and vice versa, even for the same scope id', () => {
    // #given an approval and a question sharing a scope id
    const {questions, approvals} = setup()
    approvals.register({
      requestID: 'per_1',
      sessionID: 'ses_1',
      approvalScopeId: 'thread_1',
      directory: '/ws',
      request: makePermission('per_1'),
      effects: {postReply: vi.fn().mockResolvedValue({ok: true})},
    })
    questions.register(makeParams())

    // #then each registry sees only its own family
    expect(approvals.pending()).toEqual(['per_1'])
    expect(questions.pending()).toEqual(['que_1'])
    expect(approvals.has('que_1')).toBe(false)
    expect(questions.has('per_1')).toBe(false)
    expect(approvals.describePendingForScope('thread_1').map(d => d.requestID)).toEqual(['per_1'])
    expect(questions.describePendingForScope('thread_1').map(d => d.requestID)).toEqual(['que_1'])
  })

  it('a permission echo for a question id, and a question echo for an approval id, settle nothing', async () => {
    // #given
    const {questions, approvals, terminals} = setup()
    approvals.register({
      requestID: 'per_1',
      sessionID: 'ses_1',
      approvalScopeId: 'thread_1',
      directory: '/ws',
      request: makePermission('per_1'),
      effects: {postReply: vi.fn().mockResolvedValue({ok: true})},
    })
    questions.register(makeParams())

    // #when
    approvals.confirmReply({requestID: 'que_1', sessionID: 'ses_1', reply: 'once'})
    questions.confirmEcho({kind: 'rejected', requestID: 'per_1', sessionID: 'ses_1'})
    await flush()

    // #then
    expect(approvals.has('per_1')).toBe(true)
    expect(questions.has('que_1')).toBe(true)
    expect(terminals).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Untrusted text never reaches logs
// ---------------------------------------------------------------------------

function loggedText(logger: GatewayLogger): string {
  const calls = [logger.debug, logger.info, logger.warn, logger.error].flatMap(fn =>
    vi
      .mocked(fn)
      .mock.calls.map(call =>
        JSON.stringify(call, (_key, value: unknown) =>
          value instanceof Error ? {name: value.name, message: value.message} : value,
        ),
      ),
  )
  return calls.join('\n')
}

describe('log hygiene', () => {
  const SECRET_QUESTION = 'SECRET-QUESTION-sk-live-abc123'
  const SECRET_OPTION = 'SECRET-OPTION-label'
  const SECRET_ANSWER = 'SECRET-ANSWER-hunter2'
  const SECRET_ERROR = 'SECRET-ERROR-text-echoing-answer'
  const SECRETS = [SECRET_QUESTION, SECRET_OPTION, SECRET_ANSWER, SECRET_ERROR]

  const secretPrompt: QuestionPromptInput = {
    question: SECRET_QUESTION,
    header: SECRET_QUESTION,
    options: [{label: SECRET_OPTION, description: SECRET_QUESTION}],
    custom: false,
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('validation failure, deadline, reply failure, thrown effect, render failure and teardown log no question or answer text', async () => {
    // #given effects and renders that fail with messages echoing secret text
    const logger = makeLogger()
    const {questions} = setup(logger)
    const throwing = async (): Promise<never> => {
      throw new Error(SECRET_ERROR)
    }
    const failingRender: QuestionRenderFn = vi.fn().mockRejectedValue(new Error(SECRET_ANSWER))

    // validation failure (unknown option on a closed question)
    questions.register(makeParams({requestID: 'que_v', questions: [secretPrompt]}))
    await decideAnswer(questions, [[SECRET_ANSWER]], {requestID: 'que_v'})

    // reply POST reports an error carrying the secret
    questions.register(
      makeParams({
        requestID: 'que_f',
        questions: [secretPrompt],
        effects: makeEffects({replyQuestion: vi.fn().mockResolvedValue({ok: false, error: SECRET_ERROR})}),
      }),
    )
    await decideAnswer(questions, [[SECRET_OPTION]], {requestID: 'que_f'})

    // reply POST throws with the secret in the message
    questions.register(
      makeParams({
        requestID: 'que_t',
        questions: [secretPrompt],
        effects: makeEffects({replyQuestion: throwing}),
      }),
    )
    await decideAnswer(questions, [[SECRET_OPTION]], {requestID: 'que_t'})

    // deadline with a throwing skip POST and a failing render
    questions.register(
      makeParams({
        requestID: 'que_d',
        questions: [secretPrompt],
        deadlineMs: 1_000,
        effects: makeEffects({replyQuestion: throwing}),
      }),
    )
    questions.attachMessage('que_d', failingRender)
    await vi.advanceTimersByTimeAsync(1_000)

    // teardown with a throwing reject and a failing render
    questions.register(
      makeParams({
        requestID: 'que_x',
        questions: [secretPrompt],
        effects: makeEffects({rejectQuestion: throwing}),
      }),
    )
    questions.attachMessage('que_x', failingRender)
    await questions.disposeRun('ses_1', 'run-ended')

    // echo whose render fails
    questions.register(makeParams({requestID: 'que_e', sessionID: 'ses_2', questions: [secretPrompt]}))
    questions.attachMessage('que_e', failingRender)
    questions.confirmEcho({kind: 'replied', requestID: 'que_e', sessionID: 'ses_2', answers: [[SECRET_ANSWER]]})
    await vi.advanceTimersByTimeAsync(10)

    // #then something was logged for each path, and none of it carries the untrusted text
    const text = loggedText(logger)
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('que_v')
    for (const secret of SECRETS) {
      expect(text).not.toContain(secret)
    }
  })

  it('actor ids and reason codes are logged for a rejected answer', async () => {
    // #given
    const logger = makeLogger()
    const {questions} = setup(logger)
    questions.register(makeParams({questions: [CLOSED]}))

    // #when
    await decideAnswer(questions, [['nope']], {actor: WEB_ACTOR})

    // #then
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({requestID: 'que_1', reason: 'unknown-option', actorKind: 'web-operator', actorId: '42'}),
      expect.any(String),
    )
  })
})

// ---------------------------------------------------------------------------
// Run binding (web routes find and settle a run's questions on any surface)
// ---------------------------------------------------------------------------

describe('run-bound questions', () => {
  it("describePendingForRun lists a run's open questions whatever their surface scope", () => {
    // #given a thread-scoped and a web-scoped question for run_1, and one for run_2
    const {questions} = setup()
    questions.register(makeParams({requestID: 'que_a', questionScopeId: 'thread_1', runId: 'run_1'}))
    questions.register(makeParams({requestID: 'que_b', questionScopeId: 'run_1', runId: 'run_1'}))
    questions.register(makeParams({requestID: 'que_c', questionScopeId: 'run_2', runId: 'run_2'}))

    // #when / #then
    expect(
      questions
        .describePendingForRun('run_1')
        .map(dto => dto.requestID)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(['que_a', 'que_b'])
    expect(questions.describePendingForRun('run_2').map(dto => dto.requestID)).toEqual(['que_c'])
    expect(questions.describePendingForRun('run_unknown')).toEqual([])
  })

  it('a question registered without a run id is not listed for any run', () => {
    // #given
    const {questions} = setup()
    questions.register(makeParams())

    // #when / #then
    expect(questions.describePendingForRun('thread_1')).toEqual([])
  })

  it('describePendingForRun omits a claimed question', async () => {
    // #given a claimed (reply in flight) question
    const {questions} = setup()
    let release: () => void = () => undefined
    const effects = makeEffects({
      replyQuestion: vi.fn(
        async () =>
          new Promise<QuestionEffectResult>(resolve => {
            release = () => resolve(OK)
          }),
      ),
    })
    questions.register(makeParams({effects, runId: 'run_1'}))
    const pending = decideAnswer(questions, [['staging']], {actor: WEB_ACTOR})
    await flush()

    // #then only open questions are actionable
    expect(questions.describePendingForRun('run_1')).toEqual([])
    release()
    await pending
  })

  it('decide with a run id settles only a request that belongs to that run', async () => {
    // #given a question bound to run_1
    const {questions} = setup()
    const effects = makeEffects()
    questions.register(makeParams({effects, runId: 'run_1'}))

    // #when another run's id is asserted, by a web operator
    const wrongRun = await questions.decide({
      requestID: 'que_1',
      scopeId: 'run_2',
      runId: 'run_2',
      decision: {kind: 'skip'},
      actor: WEB_ACTOR,
    })

    // #then it is indistinguishable from an unknown id, and nothing was sent
    expect(wrongRun).toEqual({kind: 'not-found'})
    expect(effects.replyQuestion).not.toHaveBeenCalled()

    // #when the right run is asserted
    const rightRun = await questions.decide({
      requestID: 'que_1',
      scopeId: 'run_1',
      runId: 'run_1',
      decision: {kind: 'skip'},
      actor: WEB_ACTOR,
    })

    // #then
    expect(rightRun).toEqual({kind: 'ok'})
    expect(effects.replyQuestion).toHaveBeenCalledOnce()
  })

  it('decide with a run id refuses a question that has no run binding', async () => {
    // #given an unbound question
    const {questions} = setup()
    questions.register(makeParams())

    // #when
    const outcome = await questions.decide({
      requestID: 'que_1',
      scopeId: 'thread_1',
      runId: 'run_1',
      decision: {kind: 'skip'},
      actor: WEB_ACTOR,
    })

    // #then
    expect(outcome).toEqual({kind: 'not-found'})
  })
})

// ---------------------------------------------------------------------------
// Several surfaces render the settlement
// ---------------------------------------------------------------------------

describe('attachMessage accumulates renders', () => {
  it('every attached render runs on settlement, and one failing render does not skip the others', async () => {
    // #given two surfaces, the first of which throws
    const logger = makeLogger()
    const {questions} = setup(logger)
    questions.register(makeParams())
    const first = vi.fn().mockRejectedValue(new Error('first surface down'))
    const second = makeRenderFn()
    questions.attachMessage('que_1', first)
    questions.attachMessage('que_1', second)

    // #when the question settles
    questions.confirmEcho({kind: 'rejected', requestID: 'que_1', sessionID: 'ses_1'})
    await flush()

    // #then both ran, and the failure was logged by the gate
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// describeRequest (transport-side index → label mapping)
// ---------------------------------------------------------------------------

describe('describeRequest', () => {
  it('returns the open request with raw questions whatever its scope or run', () => {
    // #given
    const {questions} = setup()
    questions.register(makeParams({runId: 'run_1'}))

    // #when / #then
    expect(questions.describeRequest('que_1')).toEqual({
      requestID: 'que_1',
      questions: [expect.objectContaining({question: 'Which environment?', multiple: false, custom: true})],
    })
    expect(questions.describeRequest('que_unknown')).toBeUndefined()
  })

  it('omits a claimed or settled request', async () => {
    // #given a claimed request
    const {questions} = setup()
    let release: () => void = () => undefined
    const effects = makeEffects({
      replyQuestion: vi.fn(
        async () =>
          new Promise<QuestionEffectResult>(resolve => {
            release = () => resolve(OK)
          }),
      ),
    })
    questions.register(makeParams({effects}))
    const pending = decideAnswer(questions, [['staging']])
    await flush()

    // #then mid-decision it is not describable; after the echo it is gone
    expect(questions.describeRequest('que_1')).toBeUndefined()
    release()
    await pending
    questions.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [['staging']]})
    await flush()
    expect(questions.describeRequest('que_1')).toBeUndefined()
  })

  it('does not return an approval entry', () => {
    const {questions, approvals} = setup()
    approvals.register({
      requestID: 'per_1',
      sessionID: 'ses_1',
      approvalScopeId: 'thread_1',
      directory: '/w',
      request: {
        requestID: 'per_1',
        sessionID: 'ses_1',
        permission: 'bash',
        patterns: [],
        title: 't',
      },
      effects: {postReply: vi.fn(async () => ({ok: true}))},
      deadlineMs: 60_000,
      onDeadlineSettled: undefined,
    })

    expect(questions.describeRequest('per_1')).toBeUndefined()
  })
})
