/**
 * Tests for Discord agent-question interaction handling.
 *
 * A REAL question registry and request gate sit behind the handler; only the
 * OpenCode reply/reject effects, the role check, and the Discord interaction are
 * faked. A decision therefore travels the same path it does in production.
 */

import type {Guild} from 'discord.js'
import type {GatewayLogger} from './client.js'
import type {QuestionInteractionDeps, QuestionInteractionLike} from './question-interactions.js'
import {describe, expect, it, vi} from 'vitest'
import {createQuestionRegistry, QUESTION_ANSWER_MAX_LENGTH} from '../approvals/question-registry.js'
import {createRequestGate} from '../approvals/request-gate.js'
import {handleQuestionInteraction} from './question-interactions.js'
import {parseQuestionCustomId} from './questions.js'

const THREAD = 'thread-1'
const SECRET = 'S3CRET-QUESTION-OR-ANSWER'

function makeLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()} satisfies GatewayLogger
}

function setup(options: {readonly authorized?: boolean} = {}) {
  const logger = makeLogger()
  const registry = createQuestionRegistry({logger, gate: createRequestGate({logger})})
  const effects = {
    replyQuestion: vi.fn(async (_requestID: string, _answers: readonly (readonly string[])[]) => ({ok: true as const})),
    rejectQuestion: vi.fn(async (_requestID: string) => ({ok: true as const})),
  }
  const isAuthorized = vi.fn(async (_guild: Guild, _userId: string, _log: GatewayLogger) => options.authorized ?? true)
  const deps: QuestionInteractionDeps = {questionRegistry: registry, isAuthorized, logger}
  return {logger, registry, effects, isAuthorized, deps}
}

type Registry = ReturnType<typeof setup>['registry']

function register(
  registry: Registry,
  effects: ReturnType<typeof setup>['effects'],
  overrides: Partial<Parameters<Registry['register']>[0]> = {},
) {
  return registry.register({
    requestID: 'que_1',
    sessionID: 'ses_1',
    questionScopeId: THREAD,
    runId: 'run-1',
    questions: [
      {
        question: 'Which environment?',
        header: 'Env',
        options: [
          {label: 'staging', description: ''},
          {label: 'prod', description: ''},
          {label: 'dev', description: ''},
        ],
        multiple: true,
        custom: true,
      },
    ],
    effects,
    deadlineMs: 60_000,
    ...overrides,
  })
}

function makeInteraction(
  overrides: {
    readonly userId?: string
    readonly channelId?: string | null
    readonly guild?: Guild | null
    readonly values?: readonly string[]
    readonly text?: string
  } = {},
) {
  const deferReply = vi.fn(async (_options: {readonly ephemeral: true}) => undefined)
  const reply = vi.fn(async (_options: unknown) => undefined)
  const editReply = vi.fn(async (_options: unknown) => undefined)
  const showModal = vi.fn(async (_modal: unknown) => undefined)
  const interaction = {
    user: {id: overrides.userId ?? '111111111111111111'},
    guild: 'guild' in overrides ? overrides.guild : ({id: 'guild-1'} as unknown as Guild),
    channelId: 'channelId' in overrides ? overrides.channelId : THREAD,
    deferReply,
    reply,
    editReply,
    showModal,
    ...(overrides.values === undefined ? {} : {values: overrides.values}),
    ...(overrides.text === undefined ? {} : {fields: {getTextInputValue: () => overrides.text ?? ''}}),
  } as unknown as QuestionInteractionLike
  return {interaction, deferReply, reply, editReply, showModal}
}

function parsed(customId: string) {
  const result = parseQuestionCustomId(customId)
  if (result === null) throw new Error(`bad fixture id ${customId}`)
  return result
}

function repliedContent(editReply: ReturnType<typeof vi.fn>): string {
  const call = editReply.mock.calls.at(-1)?.[0] as {content?: string; allowedMentions?: unknown} | undefined
  return call?.content ?? ''
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0)
  })
}

// ---------------------------------------------------------------------------
// Option button
// ---------------------------------------------------------------------------

describe('option button', () => {
  it('claims through the gate: defers first, authorizes, maps the index to the raw label, one reply', async () => {
    // #given a pending single-choice question
    const {registry, effects, deps, isAuthorized} = setup()
    register(registry, effects, {
      questions: [
        {
          question: 'Env?',
          header: 'E',
          options: [
            {label: 'staging', description: ''},
            {label: 'prod', description: ''},
          ],
          multiple: false,
          custom: true,
        },
      ],
    })
    const order: string[] = []
    const {interaction, deferReply, editReply} = makeInteraction()
    deferReply.mockImplementation(async () => {
      order.push('defer')
    })
    isAuthorized.mockImplementation(async () => {
      order.push('authorize')
      return true
    })

    // #when the second option is clicked
    await handleQuestionInteraction(interaction, parsed('fb-q:o:que_1:1'), deps)

    // #then deferred before authorization, one reply carrying the raw label, ephemeral ack
    expect(order).toEqual(['defer', 'authorize'])
    expect(deferReply).toHaveBeenCalledWith({ephemeral: true})
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['prod']])
    expect(repliedContent(editReply)).toBe('Answer recorded.')
  })

  it('the settle echo then removes the entry, so the question is no longer pending', async () => {
    // #given an answered question
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction} = makeInteraction()
    await handleQuestionInteraction(interaction, parsed('fb-q:o:que_1:0'), deps)

    // #when OpenCode echoes
    registry.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [['staging']]})
    await flush()

    // #then
    expect(registry.has('que_1')).toBe(false)
  })

  it('an out-of-range index is refused by mapping, with no reply and the entry open', async () => {
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction, editReply} = makeInteraction()

    await handleQuestionInteraction(interaction, parsed('fb-q:o:que_1:9'), deps)

    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(repliedContent(editReply)).toContain("isn't allowed")
    expect(registry.describeRequest('que_1')).toBeDefined()
  })
})

describe('a claimed question is not reported as settled', () => {
  it('an option click while another answer is in flight gets the fixed already-claimed copy, not no-longer-pending', async () => {
    // #given a first answer whose reply is still in flight
    const {registry, effects, deps} = setup()
    let release: () => void = () => undefined
    effects.replyQuestion.mockImplementationOnce(
      async () =>
        new Promise<{ok: true}>(resolve => {
          release = () => resolve({ok: true})
        }),
    )
    register(registry, effects)
    const first = makeInteraction()
    const firstDone = handleQuestionInteraction(first.interaction, parsed('fb-q:o:que_1:0'), deps)
    await flush()
    expect(effects.replyQuestion).toHaveBeenCalledOnce()

    // #when a second operator clicks an option, and another opens the text modal
    const second = makeInteraction()
    await handleQuestionInteraction(second.interaction, parsed('fb-q:o:que_1:1'), deps)
    const text = makeInteraction()
    await handleQuestionInteraction(text.interaction, parsed('fb-q:t:que_1'), deps)

    // #then both are told it is already being answered (fixed copy), and no second reply goes out
    expect(repliedContent(second.editReply)).toBe('Already being answered.')
    const textReply = text.reply.mock.calls.at(-1)?.[0] as {content?: string} | undefined
    expect(textReply?.content).toBe('Already being answered.')
    expect(effects.replyQuestion).toHaveBeenCalledOnce()

    release()
    await firstDone
  })
})

// ---------------------------------------------------------------------------
// Skip
// ---------------------------------------------------------------------------

describe('skip button', () => {
  it('sends an empty-answer reply, never a reject', async () => {
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction, editReply} = makeInteraction()

    await handleQuestionInteraction(interaction, parsed('fb-q:k:que_1'), deps)

    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [[]])
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
    expect(repliedContent(editReply)).toBe('Skipped — the agent will continue without an answer.')
  })
})

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

describe('select menu', () => {
  it('maps several submitted indices to raw labels, in submission order', async () => {
    // #given a multiple-choice question
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction} = makeInteraction({values: ['2', '0']})

    // #when two options are submitted
    await handleQuestionInteraction(interaction, parsed('fb-q:s:que_1'), deps)

    // #then the reply carries labels, never the indices
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['dev', 'staging']])
  })

  it('maps by index, not by label: a value that looks like a label is refused', async () => {
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction, editReply} = makeInteraction({values: ['prod']})

    await handleQuestionInteraction(interaction, parsed('fb-q:s:que_1'), deps)

    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(repliedContent(editReply)).toContain("isn't allowed")
  })

  it.each([[['7']], [['26']], [['-1']], [['1.5']], [[]]])('refuses the select values %j', async values => {
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction} = makeInteraction({values})

    await handleQuestionInteraction(interaction, parsed('fb-q:s:que_1'), deps)

    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(registry.describeRequest('que_1')).toBeDefined()
  })

  it('several values on a single-choice question are refused by the gate and the entry stays open', async () => {
    const {registry, effects, deps} = setup()
    register(registry, effects, {
      questions: [{question: 'Q', header: 'H', options: options(3), multiple: false, custom: true}],
    })
    const {interaction, editReply} = makeInteraction({values: ['0', '1']})

    await handleQuestionInteraction(interaction, parsed('fb-q:s:que_1'), deps)

    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(repliedContent(editReply)).toBe('This question takes a single answer.')
    expect(registry.describeRequest('que_1')).toBeDefined()
  })
})

function options(count: number) {
  return Array.from({length: count}, (_, index) => ({label: `opt-${index}`, description: ''}))
}

// ---------------------------------------------------------------------------
// Text button and modal
// ---------------------------------------------------------------------------

describe('text button', () => {
  it('opens the answer modal at once, without deferring or authorizing', async () => {
    // #given a pending question
    const {registry, effects, deps, isAuthorized} = setup()
    register(registry, effects)
    const {interaction, showModal, deferReply} = makeInteraction()

    // #when the text button is clicked
    await handleQuestionInteraction(interaction, parsed('fb-q:t:que_1'), deps)

    // #then showModal was the first response
    expect(showModal).toHaveBeenCalledOnce()
    expect(deferReply).not.toHaveBeenCalled()
    expect(isAuthorized).not.toHaveBeenCalled()
  })

  it('for a question that is no longer pending, replies ephemerally instead of opening a modal', async () => {
    const {deps} = setup()
    const {interaction, showModal, reply} = makeInteraction()

    await handleQuestionInteraction(interaction, parsed('fb-q:t:que_gone'), deps)

    expect(showModal).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'This question is no longer pending.', ephemeral: true}),
    )
  })
})

describe('modal submit', () => {
  it('submits free text through the gate', async () => {
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction, editReply} = makeInteraction({text: 'my own env'})

    await handleQuestionInteraction(interaction, parsed('fb-q:m:que_1'), deps)

    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['my own env']])
    expect(repliedContent(editReply)).toBe('Answer recorded.')
  })

  it('text over 4,000 characters is rejected by the gate and the entry stays open', async () => {
    // #given a forged modal submit past the input's maxLength
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction, editReply} = makeInteraction({text: 'a'.repeat(QUESTION_ANSWER_MAX_LENGTH + 1)})

    // #when
    await handleQuestionInteraction(interaction, parsed('fb-q:m:que_1'), deps)

    // #then
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(repliedContent(editReply)).toContain('4,000')
    expect(registry.describeRequest('que_1')).toBeDefined()
  })

  it('exactly 4,000 characters is accepted', async () => {
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction} = makeInteraction({text: 'a'.repeat(QUESTION_ANSWER_MAX_LENGTH)})

    await handleQuestionInteraction(interaction, parsed('fb-q:m:que_1'), deps)

    expect(effects.replyQuestion).toHaveBeenCalledOnce()
  })

  it.each([[''], ['   ']])('empty or blank text %j is refused', async text => {
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction} = makeInteraction({text})

    await handleQuestionInteraction(interaction, parsed('fb-q:m:que_1'), deps)

    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(registry.describeRequest('que_1')).toBeDefined()
  })

  it('free text on a custom:false question is refused by the gate', async () => {
    const {registry, effects, deps} = setup()
    register(registry, effects, {
      questions: [{question: 'Q', header: 'H', options: options(2), multiple: false, custom: false}],
    })
    const {interaction, editReply} = makeInteraction({text: 'free'})

    await handleQuestionInteraction(interaction, parsed('fb-q:m:que_1'), deps)

    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(repliedContent(editReply)).toContain("isn't allowed")
  })

  it('an unauthorized user submitting the modal is refused and the entry stays open', async () => {
    const {registry, effects, deps} = setup({authorized: false})
    register(registry, effects)
    const {interaction, editReply} = makeInteraction({text: 'sneaky'})

    await handleQuestionInteraction(interaction, parsed('fb-q:m:que_1'), deps)

    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(repliedContent(editReply)).toBe('Not authorized to answer this question.')
    expect(registry.describeRequest('que_1')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Authorization, scope, and gate outcomes
// ---------------------------------------------------------------------------

describe('authorization and scope', () => {
  it.each(['fb-q:k:que_1', 'fb-q:o:que_1:0', 'fb-q:s:que_1'])(
    'an unauthorized user clicking %s is refused',
    async id => {
      // #given
      const {registry, effects, deps} = setup({authorized: false})
      register(registry, effects)
      const {interaction, editReply} = makeInteraction({values: ['0']})

      // #when
      await handleQuestionInteraction(interaction, parsed(id), deps)

      // #then refused ephemerally, nothing sent, entry open
      expect(repliedContent(editReply)).toBe('Not authorized to answer this question.')
      expect(effects.replyQuestion).not.toHaveBeenCalled()
      expect(registry.describeRequest('que_1')).toBeDefined()
    },
  )

  it('a user outside any guild is refused', async () => {
    const {registry, effects, deps, isAuthorized} = setup()
    register(registry, effects)
    const {interaction, editReply} = makeInteraction({guild: null})

    await handleQuestionInteraction(interaction, parsed('fb-q:k:que_1'), deps)

    expect(isAuthorized).not.toHaveBeenCalled()
    expect(repliedContent(editReply)).toBe('Not authorized to answer this question.')
  })

  it("a Discord user from another thread hits the gate's scope mismatch", async () => {
    // #given a question bound to thread-1, answered from thread-2
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction, editReply} = makeInteraction({channelId: 'thread-2'})

    // #when
    await handleQuestionInteraction(interaction, parsed('fb-q:k:que_1'), deps)

    // #then
    expect(effects.replyQuestion).not.toHaveBeenCalled()
    expect(repliedContent(editReply)).toBe('This question belongs to another thread.')
    expect(registry.describeRequest('que_1')).toBeDefined()
  })

  it('a missing channel id is a scope mismatch, not a crash', async () => {
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction, editReply} = makeInteraction({channelId: null})

    await handleQuestionInteraction(interaction, parsed('fb-q:k:que_1'), deps)

    expect(repliedContent(editReply)).toBe('This question belongs to another thread.')
  })
})

describe('gate outcomes', () => {
  it('an unknown or already-settled question → "no longer pending"', async () => {
    const {deps, effects} = setup()
    const {interaction, editReply} = makeInteraction()

    await handleQuestionInteraction(interaction, parsed('fb-q:k:que_gone'), deps)
    await handleQuestionInteraction(makeInteraction().interaction, parsed('fb-q:o:que_gone:0'), deps)

    expect(repliedContent(editReply)).toBe('This question is no longer pending.')
    expect(effects.replyQuestion).not.toHaveBeenCalled()
  })

  it('a second click while the first reply is in flight → already being answered, one reply', async () => {
    // #given a reply that has not resolved yet
    const {registry, effects, deps} = setup()
    register(registry, effects)
    let release: () => void = () => undefined
    effects.replyQuestion.mockImplementation(
      async () =>
        new Promise<{ok: true}>(resolve => {
          release = () => resolve({ok: true})
        }),
    )
    const first = handleQuestionInteraction(makeInteraction().interaction, parsed('fb-q:k:que_1'), deps)
    await vi.waitFor(() => expect(effects.replyQuestion).toHaveBeenCalledOnce())

    // #when a second user clicks Skip
    const second = makeInteraction()
    await handleQuestionInteraction(second.interaction, parsed('fb-q:k:que_1'), deps)
    release()
    await first

    // #then
    expect(repliedContent(second.editReply)).toBe('Already being answered.')
    expect(effects.replyQuestion).toHaveBeenCalledOnce()
  })

  it('a reply failure → "try again" and the question is open again', async () => {
    const {registry, effects, deps} = setup()
    register(registry, effects)
    effects.replyQuestion.mockResolvedValue({ok: false, error: SECRET} as never)
    const {interaction, editReply} = makeInteraction()

    await handleQuestionInteraction(interaction, parsed('fb-q:k:que_1'), deps)

    expect(repliedContent(editReply)).toBe('Failed to record the answer, try again.')
    expect(registry.describeRequest('que_1')).toBeDefined()
  })

  it('an unexpected throw is answered ephemerally and never rejects', async () => {
    const {deps} = setup()
    const {interaction, editReply} = makeInteraction()
    vi.mocked(interaction.deferReply).mockRejectedValueOnce(new Error(SECRET))

    await expect(handleQuestionInteraction(interaction, parsed('fb-q:k:que_1'), deps)).resolves.toBeUndefined()

    expect(repliedContent(editReply)).toBe('Failed to record the answer, try again.')
  })
})

// ---------------------------------------------------------------------------
// Decision record and log hygiene
// ---------------------------------------------------------------------------

describe('decision records', () => {
  it('logs an accepted answer and an accepted skip with ids and outcome only', async () => {
    // #given two questions
    const {registry, effects, deps, logger} = setup()
    register(registry, effects)
    register(registry, effects, {requestID: 'que_2'})

    // #when one is answered and one skipped
    await handleQuestionInteraction(makeInteraction().interaction, parsed('fb-q:o:que_1:0'), deps)
    await handleQuestionInteraction(makeInteraction().interaction, parsed('fb-q:k:que_2'), deps)

    // #then
    const decisions = logger.info.mock.calls
      .map(call => call[0] as Record<string, unknown>)
      .filter(ctx => ctx.kind === 'question.decision')
    expect(decisions).toEqual([
      expect.objectContaining({
        requestID: 'que_1',
        family: 'question',
        surface: 'discord',
        threadId: THREAD,
        discordUserId: '111111111111111111',
        outcome: 'answered',
      }),
      expect.objectContaining({requestID: 'que_2', outcome: 'skipped'}),
    ])
  })

  it('logs refusals with a reason code', async () => {
    const {registry, effects, deps, logger} = setup()
    register(registry, effects)

    await handleQuestionInteraction(makeInteraction({channelId: 'other'}).interaction, parsed('fb-q:k:que_1'), deps)
    await handleQuestionInteraction(makeInteraction().interaction, parsed('fb-q:k:que_gone'), deps)

    const refusals = [...logger.info.mock.calls, ...logger.warn.mock.calls]
      .map(call => call[0] as Record<string, unknown>)
      .filter(ctx => ctx.kind === 'question.rejected')
    expect(refusals.map(ctx => String(ctx.reason)).sort((a, b) => a.localeCompare(b))).toEqual([
      'not_found',
      'scope_mismatch',
    ])
  })

  it('no log call on any path carries question or answer text', async () => {
    // #given secret-shaped question, option, and answer text
    const {registry, effects, deps, logger} = setup({authorized: true})
    register(registry, effects, {
      questions: [
        {
          question: SECRET,
          header: SECRET,
          options: [{label: `${SECRET}-opt`, description: SECRET}],
          multiple: false,
          custom: true,
        },
      ],
    })

    // #when answers go through accepted, invalid, forged, wrong-thread, and failed paths
    await handleQuestionInteraction(makeInteraction({text: `${SECRET}-free`}).interaction, parsed('fb-q:m:que_1'), deps)
    registry.register({
      requestID: 'que_2',
      sessionID: 'ses_1',
      questionScopeId: THREAD,
      runId: 'run-1',
      questions: [{question: SECRET, header: SECRET, options: [], multiple: false, custom: false}],
      effects,
      deadlineMs: 60_000,
    })
    await handleQuestionInteraction(makeInteraction({text: `${SECRET}-free`}).interaction, parsed('fb-q:m:que_2'), deps)
    await handleQuestionInteraction(makeInteraction({channelId: 'other'}).interaction, parsed('fb-q:o:que_2:0'), deps)
    const failing = makeInteraction()
    vi.mocked(failing.interaction.deferReply).mockRejectedValueOnce(new Error(`${SECRET}-err`))
    await handleQuestionInteraction(failing.interaction, parsed('fb-q:k:que_2'), deps)

    // #then
    const captured = JSON.stringify([
      logger.debug.mock.calls,
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ])
    expect(captured).not.toContain('S3CRET')
    expect(captured).toContain('question.decision')
  })

  it('every reply is fixed copy: it never echoes the answer', async () => {
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction, editReply} = makeInteraction({text: `${SECRET}-free`})

    await handleQuestionInteraction(interaction, parsed('fb-q:m:que_1'), deps)

    expect(JSON.stringify(editReply.mock.calls)).not.toContain('S3CRET')
  })

  it('every interaction reply applies disabled mentions', async () => {
    const {registry, effects, deps} = setup()
    register(registry, effects)
    const {interaction, editReply} = makeInteraction()

    await handleQuestionInteraction(interaction, parsed('fb-q:k:que_1'), deps)

    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({allowedMentions: {parse: []}}))
  })
})
