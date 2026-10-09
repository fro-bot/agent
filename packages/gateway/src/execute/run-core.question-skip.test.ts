/**
 * #1736 — end-to-end pin of the question **skip** contract against a fake OpenCode.
 *
 * A skipped question (deadline expiry or operator Skip) must be a *reply* with one
 * empty answer per question, so OpenCode's question tool reports "Unanswered" and the
 * agent's turn continues. A reject would end the turn. These tests drive the real
 * gateway path — `runOpenCodeCore` → real `createQuestionCoordinator` / registry / gate →
 * real `createQuestionEffects` → real `createRemoteQuestionClient` → the generated
 * SDK → a real HTTP socket — into a fake server that implements upstream's reply
 * semantics and is *conditioned on what it actually receives*:
 *
 * - a well-formed body for a pending question ⇒ `question.replied` is emitted on the
 *   event stream, then the agent's continuation text and the root idle;
 * - a malformed body ⇒ 400 and **no** echo, so the run never completes;
 * - a reject ⇒ `question.rejected` and an idle with **no** continuation text.
 *
 * Only the event stream and the v1 session calls are doubles (as in `run-core.test.ts`);
 * the question HTTP path is real. Upstream refs (anomalyco/opencode @ v1.18.34,
 * packages/opencode/src):
 *   - server/routes/instance/httpapi/groups/question.ts:12-16,32-37  reply payload + route
 *   - question/index.ts:114-132                                      reply: publish question.replied, Deferred.succeed
 *   - question/index.ts:134-148                                      reject: Deferred.fail(RejectedError)
 *   - tool/question.ts:30-36                                         empty answer ⇒ "Unanswered", ordinary output
 *   - session/processor.ts:200,694                                   RejectedError ⇒ blocked ⇒ turn stops
 *
 * Deliberate strictness: upstream does not check `answers.length` against the number of
 * questions (a missing answer just formats as "Unanswered"). The fake does, because the
 * gateway's contract is one inner array per question and we want drift to be loud.
 */

import type {AddressInfo} from 'node:net'
import type {OpenCodeServerHandle} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {GatewayLogger} from '../discord/client.js'
import type {DiscordStreamSink} from '../discord/streaming.js'

import {createServer} from 'node:http'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createQuestionCoordinator} from '../approvals/question-coordinator.js'
import {createQuestionRegistry} from '../approvals/question-registry.js'
import {createRequestGate} from '../approvals/request-gate.js'
import {createQuestionEffects} from './question-client.js'
import {runOpenCodeCore} from './run-core.js'

const DIRECTORY = '/workspace/repos/acme/widget'
const TOKEN = 'fake-bearer-token'
const SESSION_ID = 'sess-123'
const SCOPE = 'thread-1'
const QUESTION_TEXT = 'Which environment?'
const CONTINUATION_MARKER = 'AGENT-CONTINUES-AFTER-QUESTION'

// ---------------------------------------------------------------------------
// Fake OpenCode: upstream question semantics over a real HTTP socket
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly method: string
  readonly path: string
  readonly directory: string | null
  readonly rawBody: string
  readonly status: number
}

interface FakeQuestion {
  readonly id: string
  readonly prompts: readonly string[]
}

/** Mirrors tool/question.ts:30-36 — the tool output the agent sees for the answers it was given. */
function upstreamToolOutput(prompts: readonly string[], answers: readonly (readonly string[])[]): string {
  const formatted = prompts
    .map((prompt, index) => {
      const answer = answers[index]
      return `"${prompt}"="${answer !== undefined && answer.length > 0 ? answer.join(', ') : 'Unanswered'}"`
    })
    .join(', ')
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

/** Mirrors the reply payload schema (groups/question.ts:12-16): `{answers: Array<Array<string>>}`. */
function parseReplyBody(rawBody: string): readonly (readonly string[])[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return undefined
  }
  if (parsed == null || typeof parsed !== 'object' || !('answers' in parsed)) return undefined
  const {answers} = parsed
  if (!Array.isArray(answers)) return undefined
  const rows: (readonly string[])[] = []
  for (const row of answers as unknown[]) {
    if (!Array.isArray(row) || !(row as unknown[]).every(value => typeof value === 'string')) return undefined
    rows.push(row as string[])
  }
  return rows
}

async function startFakeOpenCode() {
  const queue: object[] = []
  let wake: (() => void) | null = null
  const lifecycle = {closed: false}
  const emit = (event: object): void => {
    queue.push(event)
    const resume = wake
    wake = null
    resume?.()
  }
  async function* stream(): AsyncGenerator<object> {
    while (true) {
      if (lifecycle.closed) return
      const next = queue.shift()
      if (next === undefined) {
        await new Promise<void>(resolve => {
          wake = resolve
        })
      } else {
        yield next
      }
    }
  }

  const pending = new Map<string, FakeQuestion>()
  const calls: RecordedCall[] = []
  const emitted: string[] = []
  const emitTracked = (event: {readonly type: string; readonly properties: object}): void => {
    emitted.push(event.type)
    emit(event)
  }

  const server = createServer((req, res) => {
    let rawBody = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      rawBody += chunk
    })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      const method = req.method ?? ''
      const directory = url.searchParams.get('directory')
      const finish = (status: number, body: unknown): void => {
        calls.push({method, path: url.pathname, directory, rawBody, status})
        res.writeHead(status, {'content-type': 'application/json'})
        res.end(JSON.stringify(body))
      }

      if (req.headers.authorization !== `Bearer ${TOKEN}`) return finish(401, {name: 'Unauthorized'})
      const match = /^\/question\/([^/]+)\/(reply|reject)$/.exec(url.pathname)
      if (method !== 'POST' || match === null) return finish(404, {name: 'NotFound'})
      const [, requestID = '', action] = match
      // OpenCode routes by `directory` to the instance that owns the question; a miss is "not found".
      const question = directory === DIRECTORY ? pending.get(requestID) : undefined

      if (action === 'reply') {
        const answers = parseReplyBody(rawBody)
        if (answers === undefined) return finish(400, {name: 'BadRequest'})
        if (question === undefined) return finish(404, {name: 'QuestionNotFoundError'})
        // Gateway contract (stricter than upstream): exactly one inner array per question.
        if (answers.length !== question.prompts.length) return finish(400, {name: 'BadRequest'})

        pending.delete(requestID)
        emitTracked({type: 'question.replied', properties: {sessionID: SESSION_ID, requestID, answers}})
        finish(200, true)
        // The question tool resolves with an ordinary result and the turn continues.
        setTimeout(() => {
          emitTracked({
            type: 'message.part.delta',
            properties: {
              sessionID: SESSION_ID,
              field: 'text',
              delta: {type: 'text', text: `${CONTINUATION_MARKER}: ${upstreamToolOutput(question.prompts, answers)}`},
            },
          })
          emitTracked({type: 'session.idle', properties: {sessionID: SESSION_ID}})
        }, 5)
        return undefined
      }

      if (question === undefined) return finish(404, {name: 'QuestionNotFoundError'})
      pending.delete(requestID)
      emitTracked({type: 'question.rejected', properties: {sessionID: SESSION_ID, requestID}})
      finish(200, true)
      // RejectedError ⇒ processor `blocked` ⇒ the turn stops: idle, with no continuation text.
      setTimeout(() => {
        emitTracked({type: 'session.idle', properties: {sessionID: SESSION_ID}})
      }, 5)
      return undefined
    })
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    baseURL,
    stream: stream(),
    calls,
    emitted,
    pending,
    /** The agent's `question` tool call: registers a pending question and publishes `question.asked`. */
    ask: (id: string, prompts: readonly string[] = [QUESTION_TEXT]): void => {
      pending.set(id, {id, prompts})
      emitTracked({
        type: 'question.asked',
        properties: {
          id,
          sessionID: SESSION_ID,
          questions: prompts.map(prompt => ({
            question: prompt,
            header: 'Q',
            options: [{label: 'staging', description: 'Deploy to staging'}],
          })),
        },
      })
    },
    close: async (): Promise<void> => {
      lifecycle.closed = true
      emit({type: 'noop'})
      server.closeAllConnections()
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

type FakeOpenCode = Awaited<ReturnType<typeof startFakeOpenCode>>

// ---------------------------------------------------------------------------
// Run harness: real run-core + coordinator + registry + gate + effects + client
// ---------------------------------------------------------------------------

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeSink(): DiscordStreamSink {
  let buffer = ''
  return {
    append: (text: string) => {
      buffer += text
    },
    flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 0}),
    buffered: () => buffer,
    markVisibleOutputSent: vi.fn(),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
    hasVisibleOutput: vi.fn().mockReturnValue(false),
  }
}

function makePermissionCoordinator(): PermissionCoordinator {
  const owned = new Set<string>()
  return {
    onPermissionAsked: vi.fn().mockResolvedValue('once'),
    onPermissionReplied: vi.fn(),
    pending: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
    addOwnedSession: vi.fn((sessionID: string) => {
      owned.add(sessionID)
    }),
    isOwned: vi.fn((sessionID: string) => owned.has(sessionID)),
  }
}

function makeHandle(stream: AsyncGenerator<object>, baseURL: string): OpenCodeServerHandle {
  const client = {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: SESSION_ID}, error: null}),
      promptAsync: vi.fn().mockResolvedValue({data: {}, error: null}),
      children: vi.fn().mockResolvedValue({data: [], error: null}),
      status: vi.fn().mockResolvedValue({data: {}, error: null}),
      abort: vi.fn().mockResolvedValue({data: {}, error: null}),
    },
    event: {subscribe: vi.fn().mockResolvedValue({stream})},
    postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
  }
  return {client, server: {url: baseURL, close: vi.fn()}, shutdown: vi.fn()} as unknown as OpenCodeServerHandle
}

const RUN_BOUND_MS = 2_000

/** Resolves with the run's outcome, or rejects with a clear message if it has not settled in time. */
async function settleWithin<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not settle within ${ms}ms`))
    }, ms)
  })
  try {
    return await Promise.race([promise, bound])
  } finally {
    clearTimeout(timer)
  }
}

let fake: FakeOpenCode | undefined
const aborts: AbortController[] = []

afterEach(async () => {
  for (const controller of aborts.splice(0)) controller.abort()
  await fake?.close()
  fake = undefined
})

async function startRun(options: {readonly deadlineMs: number}) {
  const upstream = await startFakeOpenCode()
  fake = upstream
  const logger = makeLogger()
  const gate = createRequestGate({logger})
  const registry = createQuestionRegistry({logger, gate})
  // The real effects over the real remote client; only the base URL points at the fake.
  const effects = createQuestionEffects({baseURL: upstream.baseURL, token: TOKEN, directory: DIRECTORY})
  const questions = createQuestionCoordinator({
    logger,
    registry,
    effects,
    scopeId: SCOPE,
    computeDeadlineMs: () => options.deadlineMs,
  })
  const handle = makeHandle(upstream.stream, upstream.baseURL)
  const sink = makeSink()
  const controller = new AbortController()
  aborts.push(controller)

  const done = runOpenCodeCore({
    handle,
    directory: DIRECTORY,
    promptText: 'Fix the bug please',
    sink,
    signal: controller.signal,
    logger,
    coordinator: makePermissionCoordinator(),
    questions,
    onHumanWaitTerminal: gate.onTerminal,
    // Generous: the question wait pauses the watchdog; a stuck run must fail our bound, not this.
    inactivityTimeoutMs: 30_000,
  })
  // Avoid an unhandled rejection if a regression leaves the run failing before we await it.
  done.catch(() => undefined)
  await vi.waitFor(() => {
    expect(vi.mocked(handle.client.session.promptAsync)).toHaveBeenCalled()
  })

  return {upstream, registry, questions, sink, done}
}

function replyCalls(upstream: FakeOpenCode): readonly RecordedCall[] {
  return upstream.calls.filter(call => call.path.endsWith('/reply'))
}

function rejectCalls(upstream: FakeOpenCode): readonly RecordedCall[] {
  return upstream.calls.filter(call => call.path.endsWith('/reject'))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('#1736 question skip — end to end against upstream reply semantics', () => {
  it('deadline skip: sends {answers:[[]]}, OpenCode echoes the reply, the agent continues and the run completes', async () => {
    // #given a pending question with a short real deadline and nobody answering
    const run = await startRun({deadlineMs: 50})
    run.upstream.ask('que_1')

    // #when the deadline passes
    await settleWithin(run.done, RUN_BOUND_MS, 'run')

    // #then exactly one reply — to the right endpoint, with the canonical directory and one empty answer
    const replies = replyCalls(run.upstream)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({method: 'POST', path: '/question/que_1/reply', directory: DIRECTORY, status: 200})
    expect(JSON.parse(replies[0]?.rawBody ?? 'null')).toStrictEqual({answers: [[]]})
    expect(rejectCalls(run.upstream)).toEqual([])

    // #and upstream echoed the reply (only after a valid body), and the turn continued
    expect(run.upstream.emitted).toContain('question.replied')
    expect(run.upstream.emitted).not.toContain('question.rejected')
    expect(run.sink.buffered()).toContain(CONTINUATION_MARKER)
    expect(run.sink.buffered()).toContain(`"${QUESTION_TEXT}"="Unanswered"`)
    expect(run.registry.pending()).toEqual([])
  })

  it('operator skip: sends {answers:[[]]}, OpenCode echoes the reply, the agent continues and the run completes', async () => {
    // #given a pending question with a long deadline
    const run = await startRun({deadlineMs: 60_000})
    run.upstream.ask('que_1')
    await vi.waitFor(() => {
      expect(run.registry.has('que_1')).toBe(true)
    })

    // #when an operator skips it
    const outcome = await run.registry.decide({
      requestID: 'que_1',
      scopeId: SCOPE,
      decision: {kind: 'skip'},
      actor: {kind: 'discord-user', userId: 'user-1'},
    })
    await settleWithin(run.done, RUN_BOUND_MS, 'run')

    // #then the POST was accepted, the body is the skip shape, and nothing was rejected
    expect(outcome).toEqual({kind: 'ok'})
    const replies = replyCalls(run.upstream)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({method: 'POST', path: '/question/que_1/reply', directory: DIRECTORY, status: 200})
    expect(JSON.parse(replies[0]?.rawBody ?? 'null')).toStrictEqual({answers: [[]]})
    expect(rejectCalls(run.upstream)).toEqual([])

    // #and the turn continued with an "Unanswered" tool result
    expect(run.sink.buffered()).toContain(CONTINUATION_MARKER)
    expect(run.sink.buffered()).toContain(`"${QUESTION_TEXT}"="Unanswered"`)
  })

  it('a multi-question skip sends one empty array per question', async () => {
    // #given a two-question ask
    const run = await startRun({deadlineMs: 50})
    run.upstream.ask('que_2', ['Which environment?', 'Which region?'])

    // #when it is skipped at the deadline
    await settleWithin(run.done, RUN_BOUND_MS, 'run')

    // #then arity matches (the fake would have answered 400 otherwise) and both read "Unanswered"
    expect(JSON.parse(replyCalls(run.upstream)[0]?.rawBody ?? 'null')).toStrictEqual({answers: [[], []]})
    expect(run.sink.buffered()).toContain('"Which environment?"="Unanswered", "Which region?"="Unanswered"')
  })
})

async function post(upstream: FakeOpenCode, path: string, body: string) {
  return fetch(`${upstream.baseURL}${path}?directory=${encodeURIComponent(DIRECTORY)}`, {
    method: 'POST',
    headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
    body,
  })
}

describe('#1736 fake upstream semantics (the fake itself is conditioned on what it receives)', () => {
  it.each([
    ['not JSON', 'nope'],
    ['no answers field', '{}'],
    ['answers is not an array', '{"answers":"x"}'],
    ['an answer is not an array', '{"answers":["staging"]}'],
    ['an answer holds a non-string', '{"answers":[[1]]}'],
    ['answers: [] for a 1-question ask (arity)', '{"answers":[]}'],
    ['two answers for a 1-question ask (arity)', '{"answers":[[],[]]}'],
  ])('%s ⇒ 400, no echo, question still pending', async (_label, body) => {
    // #given
    fake = await startFakeOpenCode()
    fake.ask('que_1')
    const emittedBefore = fake.emitted.length

    // #when
    const response = await post(fake, '/question/que_1/reply', body)

    // #then
    expect(response.status).toBe(400)
    expect(fake.emitted).toHaveLength(emittedBefore)
    expect(fake.pending.has('que_1')).toBe(true)
  })

  it('a valid body replies once, echoes question.replied, and a second reply is 404', async () => {
    // #given
    fake = await startFakeOpenCode()
    fake.ask('que_1')

    // #when
    const first = await post(fake, '/question/que_1/reply', '{"answers":[[]]}')
    const second = await post(fake, '/question/que_1/reply', '{"answers":[[]]}')

    // #then
    expect(first.status).toBe(200)
    expect(fake.emitted.filter(type => type === 'question.replied')).toHaveLength(1)
    expect(second.status).toBe(404)
  })

  it('reject emits question.rejected and ends the turn with no continuation text', async () => {
    // #given
    fake = await startFakeOpenCode()
    fake.ask('que_1')

    // #when
    const response = await post(fake, '/question/que_1/reject', '')
    await vi.waitFor(() => {
      expect(fake?.emitted).toContain('session.idle')
    })

    // #then
    expect(response.status).toBe(200)
    expect(fake.emitted).toContain('question.rejected')
    expect(fake.emitted).not.toContain('question.replied')
    expect(fake.emitted).not.toContain('message.part.delta')
  })

  it('a wrong directory or missing auth is refused with no echo', async () => {
    // #given
    fake = await startFakeOpenCode()
    fake.ask('que_1')
    const emittedBefore = fake.emitted.length

    // #when
    const wrongDirectory = await fetch(`${fake.baseURL}/question/que_1/reply?directory=%2Felsewhere`, {
      method: 'POST',
      headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
      body: '{"answers":[[]]}',
    })
    const noAuth = await fetch(`${fake.baseURL}/question/que_1/reply?directory=${encodeURIComponent(DIRECTORY)}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{"answers":[[]]}',
    })

    // #then
    expect(wrongDirectory.status).toBe(404)
    expect(noAuth.status).toBe(401)
    expect(fake.emitted).toHaveLength(emittedBefore)
  })
})
