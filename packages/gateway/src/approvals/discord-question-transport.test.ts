/**
 * Tests for the Discord question transport.
 *
 * A REAL question registry and request gate sit behind the transport. The reply
 * sink routes through the real `sendMessage` into a fake thread, and settled
 * renders go through the real `editMessage` onto a fake message, so every send and
 * edit carries exactly the `allowedMentions` production applies and the tests can
 * assert on it.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {ReplySink} from '../execute/launch-types.js'
import type {QuestionAskedRequest} from './question-coordinator.js'
import type {QuestionInfo} from './question-registry.js'
import {DiscordAPIError, RESTJSONErrorCodes} from 'discord.js'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {sendMessage} from '../discord/io.js'
import {composeQuestionHooks, createDiscordQuestionOnRegistered} from './discord-question-transport.js'
import {createQuestionRegistry} from './question-registry.js'
import {createRequestGate} from './request-gate.js'

const SECRET = 'S3CRET-QUESTION-TEXT'
const MENTIONS = '@everyone <@123> <@&456>'
const ORIGIN = 'https://operator.example.com'
const ANY_ARRAY: unknown = expect.any(Array)

function makeLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()} satisfies GatewayLogger
}

function unknownChannel(): DiscordAPIError {
  return new DiscordAPIError(
    {message: 'Unknown Channel', code: RESTJSONErrorCodes.UnknownChannel},
    RESTJSONErrorCodes.UnknownChannel,
    404,
    'POST',
    '/channels/thread_1/messages',
    {},
  )
}

function missingAccess(): DiscordAPIError {
  return new DiscordAPIError(
    {message: 'Missing Access', code: RESTJSONErrorCodes.MissingAccess},
    RESTJSONErrorCodes.MissingAccess,
    403,
    'POST',
    '/channels/thread_1/messages',
    {},
  )
}

function question(overrides: Partial<QuestionInfo> = {}): QuestionInfo {
  return {
    question: 'Which environment?',
    header: 'Env',
    options: [
      {label: 'staging', description: ''},
      {label: 'prod', description: ''},
    ],
    multiple: false,
    custom: true,
    ...overrides,
  }
}

function setup(
  options: {
    readonly sendError?: unknown
    readonly operatorOrigin?: string | undefined
    readonly editError?: unknown
  } = {},
) {
  const logger = makeLogger()
  const registry = createQuestionRegistry({logger, gate: createRequestGate({logger})})
  const effects = {
    replyQuestion: vi.fn(async (_requestID: string, _answers: readonly (readonly string[])[]) => ({ok: true as const})),
    rejectQuestion: vi.fn(async (_requestID: string) => ({ok: true as const})),
  }

  const edit = vi.fn(async (_payload: unknown) => {
    if (options.editError !== undefined) throw options.editError
    return undefined
  })
  const postedMessage = {edit}
  const threadSend = vi.fn(async (_payload: unknown) => {
    if (options.sendError !== undefined) throw options.sendError
    return postedMessage
  })
  const fakeThread = {send: threadSend}

  const settlePending = vi.fn()
  const replySink = {
    send: vi.fn(async (_target: string, payload: Parameters<typeof sendMessage>[1]) =>
      sendMessage(fakeThread, payload, logger),
    ),
    markVisibleOutputPending: vi.fn(() => settlePending),
  } as unknown as ReplySink & {readonly send: ReturnType<typeof vi.fn>}

  const hook = createDiscordQuestionOnRegistered({
    questionRegistry: registry,
    operatorOrigin: 'operatorOrigin' in options ? options.operatorOrigin : ORIGIN,
    logger,
  })({replySink, runId: 'run-1'})

  function ask(questions: readonly QuestionInfo[], deadlineMs = 60_000, requestID = 'que_1'): QuestionAskedRequest {
    const request: QuestionAskedRequest = {requestID, sessionID: 'ses_1', questions}
    registry.register({
      requestID,
      sessionID: 'ses_1',
      questionScopeId: 'thread-1',
      runId: 'run-1',
      questions,
      effects,
      deadlineMs,
    })
    hook(request)
    return request
  }

  return {logger, registry, effects, edit, threadSend, replySink, settlePending, ask, hook}
}

/**
 * The log calls this transport wrote. `io.ts` also logs the Discord-authored error message of a failed
 * send or edit ("Unknown Channel"); that message is Discord's, not the question's, so tests that put a
 * secret inside an error message look only at what the transport itself logged.
 */
function transportLogs(logger: ReturnType<typeof makeLogger>): string {
  const calls = [logger.debug, logger.info, logger.warn, logger.error].flatMap(fn => fn.mock.calls)
  return JSON.stringify(calls.filter(call => String(call[1]).startsWith('discord-question-transport')))
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0)
  })
}

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Native prompt
// ---------------------------------------------------------------------------

describe('native prompt', () => {
  it('posts one embed with components into the thread, with mentions disabled, and settles the visibility claim', async () => {
    // #given a single-question request that fits Discord
    const {ask, threadSend, replySink, settlePending} = setup()

    // #when it is announced
    ask([question()])
    await flush()

    // #then exactly one thread post: embed + components, allowedMentions {parse: []}
    expect(replySink.send).toHaveBeenCalledExactlyOnceWith('thread', expect.objectContaining({embeds: ANY_ARRAY}))
    expect(threadSend).toHaveBeenCalledOnce()
    const payload = threadSend.mock.calls[0]?.[0] as {
      embeds: unknown[]
      components: unknown[]
      allowedMentions: unknown
    }
    expect(payload.embeds).toHaveLength(1)
    expect(payload.components.length).toBeGreaterThan(0)
    expect(payload.allowedMentions).toEqual({parse: []})
    expect(settlePending).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('renders the settled outcome on answer, with components removed and mentions disabled', async () => {
    // #given a posted prompt
    const {ask, registry, edit} = setup()
    ask([question()])
    await flush()

    // #when OpenCode echoes an answer carrying mention-shaped free text
    registry.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [['prod', MENTIONS]]})
    await flush()

    // #then the message was edited once: answered embed, no components, mentions disabled
    expect(edit).toHaveBeenCalledOnce()
    const payload = edit.mock.calls[0]?.[0] as {
      embeds: {toJSON: () => {title?: string; fields?: {value: string}[]}}[]
      components: unknown[]
      allowedMentions: unknown
    }
    expect(payload.components).toEqual([])
    expect(payload.allowedMentions).toEqual({parse: []})
    const embed = payload.embeds[0]?.toJSON()
    expect(embed?.title).toBe('✅ Answered')
    expect(embed?.fields?.[0]?.value).toContain('• prod')
    expect(embed?.fields?.[0]?.value).toContain('@everyone')
  })

  it('renders skipped / timed-out / cancelled outcomes', async () => {
    // #given three prompts
    vi.useFakeTimers()
    const {ask, registry, edit, effects} = setup()
    ask([question()], 1_000, 'que_skip')
    ask([question()], 600_000, 'que_reject')
    ask([question()], 600_000, 'que_dispose')
    await vi.advanceTimersByTimeAsync(10)

    // #when one is rejected by OpenCode, one is disposed with the run, one times out
    registry.confirmEcho({kind: 'rejected', requestID: 'que_reject', sessionID: 'ses_1'})
    await registry.disposeRun('ses_1', 'run ended')
    await vi.advanceTimersByTimeAsync(2_000)

    // #then each settlement edited its own message exactly once, and no reply was sent for dispose/reject
    expect(edit).toHaveBeenCalledTimes(3)
    const titles = edit.mock.calls.map(
      call => (call[0] as {embeds: {toJSON: () => {title?: string}}[]}).embeds[0]?.toJSON().title,
    )
    expect(titles).toContain('⛔ Cancelled')
    expect(titles).toContain('⚠️ Cancelled (run ended)')
    expect(effects.rejectQuestion).toHaveBeenCalledWith('que_dispose')
  })

  it('carries mention payloads in the question as inert embed text and still disables mentions', async () => {
    // #given question, header, and option text full of mention syntax
    const {ask, threadSend} = setup()

    // #when
    ask([question({question: MENTIONS, header: MENTIONS, options: [{label: MENTIONS, description: MENTIONS}]})])
    await flush()

    // #then the text is inside the embed (which never notifies); the message content is empty; mentions are off
    const payload = threadSend.mock.calls[0]?.[0] as {content?: string; allowedMentions: unknown; embeds: unknown[]}
    expect(payload.content).toBeUndefined()
    expect(payload.allowedMentions).toEqual({parse: []})
  })
})

// ---------------------------------------------------------------------------
// Web fallback
// ---------------------------------------------------------------------------

describe('web fallback notice', () => {
  const cases: readonly {
    readonly label: string
    readonly questions: readonly QuestionInfo[]
    readonly requestID: string
  }[] = [
    {label: 'a multi-question request', questions: [question(), question()], requestID: 'que_1'},
    {
      label: 'a 30-option request',
      questions: [question({options: Array.from({length: 30}, (_, i) => ({label: `o${i}`, description: ''}))})],
      requestID: 'que_1',
    },
    {label: 'an oversize request id', questions: [question()], requestID: 'x'.repeat(200)},
  ]

  it.each(cases)('$label posts one notice with no question text and no components', async ({questions, requestID}) => {
    // #given text that must never reach the notice
    const marked = questions.map(q => ({...q, question: `${SECRET} ${q.question}`, header: SECRET}))
    const {ask, threadSend, logger, registry} = setup()

    // #when
    ask(marked, 60_000, requestID)
    await flush()

    // #then a single fixed-copy message: content only, mentions disabled, nothing partial
    expect(threadSend).toHaveBeenCalledOnce()
    const payload = threadSend.mock.calls[0]?.[0] as {
      content?: string
      embeds?: unknown
      components?: unknown
      allowedMentions: unknown
    }
    expect(payload.content).toContain('operator web surface')
    expect(payload.content).toContain(`<${ORIGIN}>`)
    expect(payload.content).not.toContain(SECRET)
    expect(payload.embeds).toBeUndefined()
    expect(payload.components).toBeUndefined()
    expect(payload.allowedMentions).toEqual({parse: []})
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(SECRET)

    // #and the request stays pending and answerable
    expect(registry.has(requestID)).toBe(true)
  })

  it('omits the link when no operator origin is configured', async () => {
    const {ask, threadSend} = setup({operatorOrigin: undefined})

    ask([question(), question()])
    await flush()

    const payload = threadSend.mock.calls[0]?.[0] as {content: string}
    expect(payload.content).toContain('operator web surface')
    expect(payload.content).not.toContain('http')
  })

  it('edits the notice to fixed resolved copy when the question settles, with mentions disabled', async () => {
    // #given a posted fallback notice
    const {ask, registry, edit} = setup()
    ask([question(), question()])
    await flush()

    // #when the question is answered elsewhere
    registry.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [['a'], ['b']]})
    await flush()

    // #then
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: '✅ The agent question was resolved.',
        components: [],
        allowedMentions: {parse: []},
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Delivery failure
// ---------------------------------------------------------------------------

describe('delivery failure never settles the question', () => {
  it.each([
    ['thread deleted (UnknownChannel)', unknownChannel, RESTJSONErrorCodes.UnknownChannel],
    ['access lost (MissingAccess)', missingAccess, RESTJSONErrorCodes.MissingAccess],
  ] as const)(
    '%s: logged with ids and the code, question still answerable from the web',
    async (_label, makeError, code) => {
      // #given the thread is gone
      const {ask, registry, effects, logger, settlePending} = setup({sendError: makeError()})

      // #when the question is announced
      ask([question({question: SECRET})])
      await flush()

      // #then one error log: ids and the Discord code, no text, no error message
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({requestID: 'que_1', runId: 'run-1', code, stage: 'send'}),
        expect.stringContaining('undeliverable'),
      )
      expect(settlePending).toHaveBeenCalledExactlyOnceWith(false)

      // #and the entry is still pending, and a web operator can still answer it through the real gate
      expect(registry.describePendingForRun('run-1').map(dto => dto.requestID)).toEqual(['que_1'])
      expect(effects.replyQuestion).not.toHaveBeenCalled()
      expect(effects.rejectQuestion).not.toHaveBeenCalled()
      const outcome = await registry.decide({
        requestID: 'que_1',
        scopeId: 'run-1',
        runId: 'run-1',
        decision: {kind: 'answer', answers: [['prod']]},
        actor: {kind: 'web-operator', githubUserId: 1, login: 'octocat', sessionCorrelationId: 's'},
      })
      expect(outcome).toEqual({kind: 'ok'})
      expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [['prod']])
    },
  )

  it('the deadline still skips an undelivered question', async () => {
    // #given an undeliverable question with a short deadline
    vi.useFakeTimers()
    const {ask, registry, effects} = setup({sendError: unknownChannel()})
    ask([question()], 5_000)
    await vi.advanceTimersByTimeAsync(1)
    expect(registry.has('que_1')).toBe(true)

    // #when the deadline passes
    await vi.advanceTimersByTimeAsync(5_000)

    // #then it was skipped with an empty reply, never rejected
    expect(effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [[]])
    expect(effects.rejectQuestion).not.toHaveBeenCalled()
  })

  it('the same holds when the web-fallback notice itself is undeliverable', async () => {
    const {ask, registry, logger} = setup({sendError: unknownChannel()})

    ask([question(), question()])
    await flush()

    expect(logger.error).toHaveBeenCalledOnce()
    expect(registry.has('que_1')).toBe(true)
  })

  it('a retryable failure is logged at warn and left alone', async () => {
    // #given a non-terminal Discord error and a plain network error
    const serverError = new DiscordAPIError({message: 'oops', code: 0}, 0, 500, 'POST', '/channels/x/messages', {})
    for (const sendError of [serverError, new Error(`socket hang up ${SECRET}`)]) {
      const {ask, registry, logger} = setup({sendError})

      // #when
      ask([question()])
      await flush()

      // #then warn only, with the code or error name, never the message
      expect(logger.error).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({requestID: 'que_1', stage: 'send'}),
        expect.stringContaining('retryable'),
      )
      expect(registry.has('que_1')).toBe(true)
    }
  })

  it('a rejecting replySink.send is handled the same way', async () => {
    // #given a sink whose send rejects outright
    const logger = makeLogger()
    const registry = createQuestionRegistry({logger, gate: createRequestGate({logger})})
    const settle = vi.fn()
    const replySink = {
      send: vi.fn(async () => {
        throw unknownChannel()
      }),
      markVisibleOutputPending: () => settle,
    } as unknown as ReplySink
    const hook = createDiscordQuestionOnRegistered({questionRegistry: registry, operatorOrigin: ORIGIN, logger})({
      replySink,
      runId: 'run-1',
    })
    registry.register({
      requestID: 'que_1',
      sessionID: 'ses_1',
      questionScopeId: 'thread-1',
      runId: 'run-1',
      questions: [question()],
      effects: {
        replyQuestion: vi.fn(async () => ({ok: true as const})),
        rejectQuestion: vi.fn(async () => ({ok: true as const})),
      },
      deadlineMs: 60_000,
    })

    // #when / #then it neither throws nor rejects
    expect(() => {
      hook({requestID: 'que_1', sessionID: 'ses_1', questions: [question()]})
    }).not.toThrow()
    await flush()
    expect(logger.error).toHaveBeenCalledOnce()
    expect(settle).toHaveBeenCalledWith(false)
    expect(registry.has('que_1')).toBe(true)
  })

  it("a prompt that Discord's builders refuse is logged without text and leaves the question answerable", async () => {
    // #given a header the embed builder cannot take? force a throw via a poisoned question object
    const {hook, registry, logger} = setup()
    const poisoned = {
      get options(): never {
        throw new Error(SECRET)
      },
    } as unknown as QuestionInfo
    registry.register({
      requestID: 'que_p',
      sessionID: 'ses_1',
      questionScopeId: 'thread-1',
      runId: 'run-1',
      questions: [question()],
      effects: {
        replyQuestion: vi.fn(async () => ({ok: true as const})),
        rejectQuestion: vi.fn(async () => ({ok: true as const})),
      },
      deadlineMs: 60_000,
    })

    // #when
    expect(() => {
      hook({requestID: 'que_p', sessionID: 'ses_1', questions: [poisoned]})
    }).not.toThrow()

    // #then
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({requestID: 'que_p', errName: 'Error'}),
      expect.stringContaining('building the prompt failed'),
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET)
    expect(registry.has('que_p')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Settled render is fail-soft
// ---------------------------------------------------------------------------

describe('settled render', () => {
  it('a failing edit is logged by id and code and does not disturb settlement', async () => {
    // #given an edit that fails (message deleted)
    const {ask, registry, edit, logger} = setup({editError: unknownChannel()})
    ask([question()])
    await flush()

    // #when the question settles
    registry.confirmEcho({kind: 'rejected', requestID: 'que_1', sessionID: 'ses_1'})
    await flush()

    // #then the entry is gone and the failure never reached the registry as a throw
    expect(edit).toHaveBeenCalledOnce()
    expect(registry.has('que_1')).toBe(false)
    expect(transportLogs(logger)).not.toContain(SECRET)
  })
})

// ---------------------------------------------------------------------------
// Log hygiene
// ---------------------------------------------------------------------------

describe('log hygiene', () => {
  it('no log call on any path carries question or answer text', async () => {
    // #given secret-shaped question text on every path: native, settled, fallback, failure
    const delivered = setup()
    delivered.ask([question({question: SECRET, header: SECRET, options: [{label: SECRET, description: SECRET}]})])
    await flush()
    delivered.registry.confirmEcho({kind: 'replied', requestID: 'que_1', sessionID: 'ses_1', answers: [[SECRET]]})
    await flush()
    delivered.ask([question({question: SECRET}), question({question: SECRET})], 60_000, 'que_2')
    const failed = setup({sendError: unknownChannel()})
    failed.ask([question({question: SECRET})])
    await flush()

    // #then
    for (const {logger} of [delivered, failed]) {
      const captured = JSON.stringify([
        logger.debug.mock.calls,
        logger.info.mock.calls,
        logger.warn.mock.calls,
        logger.error.mock.calls,
      ])
      expect(captured).not.toContain('S3CRET')
    }
  })
})

// ---------------------------------------------------------------------------
// composeQuestionHooks
// ---------------------------------------------------------------------------

describe('composeQuestionHooks', () => {
  const request: QuestionAskedRequest = {requestID: 'que_1', sessionID: 'ses_1', questions: [question()]}

  it('runs every hook in order and skips undefined entries', () => {
    const calls: string[] = []
    const compose = composeQuestionHooks(
      [
        () => {
          calls.push('a')
        },
        undefined,
        () => {
          calls.push('b')
        },
      ],
      makeLogger(),
    )

    compose(request)

    expect(calls).toEqual(['a', 'b'])
  })

  it('a throwing hook is logged by id and error name and does not stop the others', () => {
    const logger = makeLogger()
    const after = vi.fn()
    const compose = composeQuestionHooks(
      [
        () => {
          throw new Error(SECRET)
        },
        after,
      ],
      logger,
    )

    expect(() => {
      compose(request)
    }).not.toThrow()

    expect(after).toHaveBeenCalledWith(request)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({requestID: 'que_1', errName: 'Error'}),
      expect.stringContaining('hook threw'),
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET)
  })
})
