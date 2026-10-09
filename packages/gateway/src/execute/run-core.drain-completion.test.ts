/**
 * Drain completion for a gateway run that adopted background work.
 *
 * Upstream's `task` tool (`tool/task.ts` @ v1.18.34) marks a background child non-live FIRST, then persists a
 * synthetic `<task id="{childSessionId}" state="completed|error">` user message on the PARENT, then starts a new
 * root turn. Ledger reconciliation settles an entry the moment its child is non-live, so a drained ledger can
 * precede the parent's follow-up turn. These tests pin that a run which adopted a background dispatch completes
 * only when the ledger has settled AND each child's notice (or cancel evidence) was seen AND the root is fresh
 * and REST agrees — and that a run which never adopted anything is untouched.
 *
 * Every ordering is decided by controlled streams and deferred promises; fake timers only drive the documented
 * cadences (reconcile interval, 1s validation retry, 5s request cap). Upstream refs (anomalyco/opencode v1.18.34,
 * packages/opencode/src):
 *   - tool/task.ts:64-79     renderOutput: `<task id="{sessionID}" state="…">` — the id is the CHILD session id
 *   - tool/task.ts:225-253   inject(): synthetic text part on the PARENT; no `time` on the part
 *   - tool/task.ts:256-263   notify(): only `completed` and `error` inject; anything else (cancelled) injects nothing
 *   - packages/core/src/v1/session.ts:50   `MessageAbortedError` — `info.error.name` of an interrupted assistant message
 */

import type {OpenCodeServerHandle} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {QuestionSideEffects} from '../approvals/question-registry.js'
import type {GatewayLogger} from '../discord/client.js'

import {createOwnershipLedger, DEFAULT_LEDGER_RECONCILE_INTERVAL_MS} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createQuestionCoordinator} from '../approvals/question-coordinator.js'
import {createQuestionRegistry} from '../approvals/question-registry.js'
import {createRequestGate} from '../approvals/request-gate.js'
import {RunCoreError, runOpenCodeCore, wrapLedgerWithHooks} from './run-core.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = 'sess-123'
const CHILD = 'sess-child-1'
const CHILD2 = 'sess-child-2'
const DIRECTORY = '/workspace/repo'
const WINDOW = 5_000

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return {promise, resolve}
}

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeSink(): {readonly append: (text: string) => void; readonly appended: string[]} {
  const appended: string[] = []
  return {
    append: text => {
      appended.push(text)
    },
    appended,
  }
}

/** A controllable event stream: push events one at a time, or end it (a closed SSE connection). */
function makeControlledStream(): {
  readonly stream: AsyncGenerator<object>
  readonly emitNext: (event: object) => void
  readonly end: () => void
} {
  const queue: object[] = []
  let ended = false
  let wake: (() => void) | null = null
  const resume = () => {
    const resolve = wake
    wake = null
    resolve?.()
  }
  async function* generate(): AsyncGenerator<object> {
    while (true) {
      const next = queue.shift()
      if (next !== undefined) {
        yield next
      } else if (ended) {
        return
      } else {
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    }
  }
  return {
    stream: generate(),
    emitNext: event => {
      queue.push(event)
      resume()
    },
    end: () => {
      ended = true
      resume()
    },
  }
}

function makeCoordinator(): PermissionCoordinator {
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

// ── SSE events ──────────────────────────────────────────────────────────────

const idleEvent = (sessionID = ROOT): object => ({type: 'session.idle', properties: {sessionID}})

const statusEvent = (type: 'busy' | 'retry' | 'idle', sessionID = ROOT): object => ({
  type: 'session.status',
  properties: {sessionID, status: {type}},
})

const dispatchEvent = (jobId: string): object => ({
  type: 'message.part.updated',
  properties: {
    sessionID: ROOT,
    part: {
      type: 'tool',
      tool: 'task',
      sessionID: ROOT,
      state: {status: 'completed', title: 'background task', metadata: {background: true, jobId}},
    },
  },
})

const foregroundTaskEvent = (): object => ({
  type: 'message.part.updated',
  properties: {
    sessionID: ROOT,
    part: {type: 'tool', tool: 'task', sessionID: ROOT, state: {status: 'completed', title: 'subagent', metadata: {}}},
  },
})

/** Upstream's injected notice: a whole synthetic text part on a root user message, with no `time`. */
function noticeEvent(
  childId: string,
  options: {
    readonly state?: 'completed' | 'error'
    readonly messageID?: string
    readonly partID?: string
    readonly sessionID?: string
  } = {},
): object {
  const {state = 'completed', messageID = 'msg-n1', partID = 'part-n1', sessionID = ROOT} = options
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: {
        id: partID,
        messageID,
        sessionID,
        type: 'text',
        synthetic: true,
        text: `<task id="${childId}" state="${state}">\n<summary>Background task ${state}</summary>\n</task>`,
      },
    },
  }
}

const textDeltaEvent = (text: string, partID = 'part-reply', sessionID = ROOT): object => ({
  type: 'message.part.delta',
  properties: {sessionID, partID, delta: {type: 'text', text}, field: 'text'},
})

const toolCompletedEvent = (sessionID = ROOT): object => ({
  type: 'message.part.updated',
  properties: {
    sessionID,
    part: {type: 'tool', tool: 'bash', sessionID, state: {status: 'completed', input: {command: 'ls'}, title: 'ls'}},
  },
})

const sessionErrorEvent = (sessionID = ROOT): object => ({
  type: 'session.error',
  properties: {sessionID, error: 'boom'},
})

const questionAskedEvent = (requestID: string, sessionID = ROOT): object => ({
  type: 'question.asked',
  properties: {
    id: requestID,
    sessionID,
    questions: [{question: 'Which environment?', header: 'Env', options: [{label: 'staging', description: 'Staging'}]}],
  },
})

const questionRepliedEvent = (requestID: string, sessionID = ROOT): object => ({
  type: 'question.replied',
  properties: {sessionID, requestID, answers: [['staging']]},
})

const permissionAskedEvent = (requestID: string, sessionID = ROOT): object => ({
  type: 'permission.asked',
  properties: {id: requestID, sessionID, permission: 'bash', patterns: [], tool: 'bash'},
})

const permissionRepliedEvent = (requestID: string, sessionID = ROOT): object => ({
  type: 'permission.replied',
  properties: {sessionID, requestID, reply: 'once'},
})

// ── Persisted (REST) messages ───────────────────────────────────────────────

const userMessage = (id: string, noticeChildren: readonly {readonly id: string; readonly state?: string}[] = []) => ({
  info: {id, role: 'user', sessionID: ROOT},
  parts: noticeChildren.map((child, index) => ({
    id: `${id}-part-${index}`,
    type: 'text',
    synthetic: true,
    text: `<task id="${child.id}" state="${child.state ?? 'completed'}">`,
  })),
})

const assistantReply = (
  id: string,
  parentID: string,
  overrides: {readonly info?: object; readonly parts?: readonly object[]} = {},
) => ({
  info: {id, role: 'assistant', sessionID: ROOT, parentID, time: {completed: 1}, finish: 'stop', ...overrides.info},
  parts: overrides.parts ?? [],
})

const PROMPT = userMessage('msg-prompt')
const FIRST_REPLY = assistantReply('msg-reply-1', 'msg-prompt')
/** The prompt answered, then an injected notice naming `children`, answered by a qualified terminal reply. */
const completedTurns = (...children: readonly string[]): readonly object[] => [
  PROMPT,
  FIRST_REPLY,
  userMessage(
    'msg-n1',
    children.map(id => ({id})),
  ),
  assistantReply('msg-reply-2', 'msg-n1'),
]
/** Only the original prompt, answered: nothing about any background child has been injected yet. */
const quietTurns: readonly object[] = [PROMPT, FIRST_REPLY]

/** A request that never settles. */
const hangForever = async (): Promise<never> =>
  new Promise<never>(() => {
    /* never settles */
  })

const abortedAssistant = {
  info: {
    id: 'c-a1',
    role: 'assistant',
    sessionID: CHILD,
    time: {completed: 1},
    error: {name: 'MessageAbortedError', data: {message: 'Aborted'}},
  },
  parts: [],
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Outcome = {readonly ok: true} | {readonly ok: false; readonly error: unknown}

interface RunOptions {
  readonly live?: readonly string[]
  readonly deadlineMs?: number
  readonly inactivityTimeoutMs?: number
  readonly ownershipLedger?: ReturnType<typeof createOwnershipLedger>
  readonly children?: readonly string[]
  readonly withQuestions?: boolean
  readonly noLedger?: boolean
  /** `client.session.abort` implementation (the root and child teardown). Default: resolves OK immediately. */
  readonly sessionAbort?: (args: unknown) => Promise<unknown>
  readonly onBusy?: (busy: boolean) => void
}

function startRun(options: RunOptions = {}) {
  vi.useFakeTimers()
  const logger = makeLogger()
  const sink = makeSink()
  const controlled = makeControlledStream()
  const coordinator = makeCoordinator()
  const controller = new AbortController()
  if (options.deadlineMs !== undefined) setTimeout(() => controller.abort(), options.deadlineMs)

  const live = new Set<string>(options.live ?? [])
  const ownershipLedger = options.noLedger === true ? undefined : (options.ownershipLedger ?? createOwnershipLedger())
  const sessionAbort = vi.fn().mockImplementation(options.sessionAbort ?? (async () => ({data: {}, error: null})))
  const onActivity = vi.fn()
  const onBusy = vi.fn(options.onBusy)

  // Mutable REST fixture: tests replace these to script what the server reports.
  const fixture = {
    root: async (): Promise<unknown> => ({data: [...quietTurns], error: null}),
    child: async (_id: string): Promise<unknown> => ({data: [], error: null}),
    status: async (): Promise<unknown> => ({
      data: Object.fromEntries([...live].map(id => [id, {type: 'busy'}])),
      error: null,
    }),
  }
  let rootMessageCalls = 0

  const gate = createRequestGate({logger})
  const registry = createQuestionRegistry({logger, gate})
  const effects: QuestionSideEffects = {
    replyQuestion: vi.fn().mockResolvedValue({ok: true}),
    rejectQuestion: vi.fn().mockResolvedValue({ok: true}),
  }
  const questions = createQuestionCoordinator({
    logger,
    registry,
    effects,
    scopeId: 'thread-1',
    computeDeadlineMs: () => 60_000,
  })

  const client = {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
      promptAsync: vi.fn().mockResolvedValue({data: {}, error: null}),
      children: vi.fn().mockImplementation(async () => ({
        data: (options.children ?? [CHILD, CHILD2]).map(id => ({id})),
        error: null,
      })),
      status: vi.fn().mockImplementation(async () => fixture.status()),
      abort: sessionAbort,
      messages: vi.fn().mockImplementation(async (args: {readonly path: {readonly id: string}}) => {
        if (args.path.id === ROOT) {
          rootMessageCalls += 1
          return fixture.root()
        }
        return fixture.child(args.path.id)
      }),
    },
    event: {subscribe: vi.fn().mockResolvedValue({stream: controlled.stream})},
    postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
  }
  const handle = {
    client,
    server: {url: 'http://workspace:9200', close: vi.fn()},
    shutdown: vi.fn(),
  } as unknown as OpenCodeServerHandle

  let settled: Outcome | undefined
  const done = runOpenCodeCore({
    handle,
    directory: DIRECTORY,
    promptText: 'Fix the bug please',
    sink,
    signal: controller.signal,
    logger,
    coordinator,
    onActivity,
    onBusy,
    ...(options.withQuestions === true ? {questions, onHumanWaitTerminal: gate.onTerminal} : {}),
    ...(options.inactivityTimeoutMs === undefined ? {} : {inactivityTimeoutMs: options.inactivityTimeoutMs}),
    ...(ownershipLedger === undefined ? {} : {ownershipLedger}),
  }).then(
    () => {
      settled = {ok: true}
    },
    (error: unknown) => {
      settled = {ok: false, error}
    },
  )

  return {
    client,
    sink,
    logger,
    coordinator,
    controller,
    fixture,
    live,
    ownershipLedger,
    sessionAbort,
    onActivity,
    onBusy,
    registry,
    done,
    outcome: (): Outcome | undefined => settled,
    rootMessageCalls: () => rootMessageCalls,
    emit: async (event: object) => {
      controlled.emitNext(event)
      // Let the loop consume the event (and any REST it triggers) before the caller proceeds.
      await vi.advanceTimersByTimeAsync(1)
    },
    advance: async (ms: number) => vi.advanceTimersByTimeAsync(ms),
    closeStream: async () => {
      controlled.end()
      await vi.advanceTimersByTimeAsync(1)
    },
  }
}

type Run = ReturnType<typeof startRun>

function expectKind(outcome: Outcome | undefined, kind: string): void {
  expect(outcome?.ok).toBe(false)
  if (outcome?.ok === false) {
    expect(outcome.error).toBeInstanceOf(RunCoreError)
    expect((outcome.error as RunCoreError).kind).toBe(kind)
  }
}

/** Adopt `children` and take the root idle that begins the drain. Children are non-live unless `live`ed. */
async function adoptAndGoIdle(run: Run, ...children: readonly string[]): Promise<void> {
  for (const child of children) await run.emit(dispatchEvent(child))
  await run.emit(idleEvent())
}

/** A healthy root whose notice arrives over SSE and whose follow-up is persisted, with one fault injected. */
async function runWithFault(apply: (run: Run) => void, heal: (run: Run) => void) {
  const run = startRun({deadlineMs: 60_000})
  run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})
  apply(run)
  await run.emit(dispatchEvent(CHILD))
  await run.emit(noticeEvent(CHILD))
  await run.emit(idleEvent())
  await run.advance(7_000)
  // still failing → never success
  expect(run.outcome()).toBeUndefined()
  heal(run)
  await run.advance(1_000)
  await run.done
  return run
}

/** A settled child awaiting its notice, with a validation request held in flight that would admit success. */
async function awaitingEvidence(options: RunOptions = {}) {
  const run = startRun(options)
  const held = deferred<unknown>()
  run.fixture.root = async () => held.promise
  await run.emit(dispatchEvent(CHILD))
  await run.emit(noticeEvent(CHILD))
  await run.emit(idleEvent())
  expect(run.rootMessageCalls()).toBe(1)
  return {run, held}
}

async function expectNothingLeftBehind(run: Run, held: Deferred<unknown>) {
  // a late, fully admissible response after the run ended must not turn the failure into success
  held.resolve({data: [...completedTurns(CHILD)], error: null})
  await vi.advanceTimersByTimeAsync(5_000)
  expect(run.outcome()?.ok).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
}

/**
 * A follow-up whose reply carries `parts` as REST persisted them, with the notice already on the stream. The run is
 * returned unfinished: whether it completes depends on what the stream goes on to deliver.
 */
async function startFollowUp(
  parts: readonly object[],
  options: {readonly deadlineMs?: number; readonly earlierReply?: object} = {},
) {
  const run = startRun({deadlineMs: options.deadlineMs ?? 60_000})
  run.fixture.root = async () => ({
    data: [
      PROMPT,
      options.earlierReply ?? FIRST_REPLY,
      userMessage('msg-n1', [{id: CHILD}]),
      assistantReply('msg-reply-2', 'msg-n1', {parts}),
    ],
    error: null,
  })
  await run.emit(dispatchEvent(CHILD))
  await run.emit(noticeEvent(CHILD))
  return run
}

/** What the sink holds, without the dispatch's own tool-summary line. */
const replyOutput = (run: Run): string => run.sink.appended.join('').replace('\nbackground task\n', '')

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runOpenCodeCore — drain completion for background work', () => {
  it('1. a ledger that settles before the injected message and before busy does not complete the run; the follow-up turn does', async () => {
    // #given a live child, the root gone idle (drain), and then the child finishing
    const run = startRun({live: [CHILD]})
    await adoptAndGoIdle(run, CHILD)
    expect(run.ownershipLedger?.isDrainComplete()).toBe(false)
    run.live.delete(CHILD)

    // #when the reconcile pass settles the ledger while REST still shows no injected message
    await run.advance(DEFAULT_LEDGER_RECONCILE_INTERVAL_MS)
    await run.advance(5_000)

    // #then the ledger is drained, the server reports nothing live (status `{}`), and the run is still pending
    expect(run.ownershipLedger?.isDrainComplete()).toBe(true)
    expect(await run.client.session.status({query: {directory: DIRECTORY}})).toEqual({data: {}, error: null})
    expect(run.outcome()).toBeUndefined()

    // #when the notice, the parent's reply, and a fresh idle arrive
    run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})
    await run.emit(noticeEvent(CHILD))
    await run.emit(statusEvent('busy'))
    await run.emit(textDeltaEvent('follow-up text'))
    await run.emit(idleEvent())
    await run.done

    // #then the run completes and the follow-up reply reached the sink — the notice text never did
    expect(run.outcome()).toEqual({ok: true})
    expect(run.sink.appended.join('')).toContain('follow-up text')
    expect(run.sink.appended.join('')).not.toContain('<task id')
  })

  it('2. a notice persisted before busy, with no part.time, does not let the earlier idle complete the run', async () => {
    // #given an idle that precedes the child finishing, and REST that already shows the whole follow-up turn
    const run = startRun({live: [CHILD]})
    await adoptAndGoIdle(run, CHILD)
    run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})

    // #when the notice (a synthetic part with no `time`) is persisted, and only then the child settles
    await run.emit(noticeEvent(CHILD))
    run.live.delete(CHILD)
    await run.advance(DEFAULT_LEDGER_RECONCILE_INTERVAL_MS)
    await run.advance(3_000)

    // #then the earlier idle was invalidated by the injected turn: nothing completes yet
    expect(run.ownershipLedger?.isDrainComplete()).toBe(true)
    expect(run.outcome()).toBeUndefined()

    // #when the new turn runs and the root goes idle again
    await run.emit(statusEvent('busy'))
    await run.emit(textDeltaEvent('answering the notice'))
    await run.emit(idleEvent())
    await run.done

    // #then it completes on the fresh idle
    expect(run.outcome()).toEqual({ok: true})
  })

  it('3. busy arriving after the ledger settles invalidates the initial idle', async () => {
    // #given the ledger settled at the first idle, with REST showing no injected message yet
    const run = startRun()
    await adoptAndGoIdle(run, CHILD)
    expect(run.ownershipLedger?.isDrainComplete()).toBe(true)
    expect(run.outcome()).toBeUndefined()

    // #when REST comes to show the whole follow-up turn, but the only stream signal is the root going busy
    run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})
    await run.emit(statusEvent('busy'))
    await run.advance(5_000)

    // #then the initial idle is no longer current evidence, so REST alone cannot complete the run
    expect(run.outcome()).toBeUndefined()

    // #when the root goes idle again
    await run.emit(idleEvent())
    await run.done

    // #then the fresh idle completes it
    expect(run.outcome()).toEqual({ok: true})
  })

  it('4. a delayed old idle arriving during the new turn cannot be satisfied by the old reply', async () => {
    // #given a settled ledger and an injected notice whose turn is not yet answered
    const run = startRun()
    await adoptAndGoIdle(run, CHILD)
    run.fixture.root = async () => ({
      data: [PROMPT, FIRST_REPLY, userMessage('msg-n1', [{id: CHILD}])],
      error: null,
    })
    await run.emit(noticeEvent(CHILD))
    await run.emit(statusEvent('busy'))

    // #when an old idle shows up late, with the root not live and the previous reply qualified
    await run.emit(idleEvent())
    await run.advance(3_000)

    // #then the previous reply answers the previous parent, not the notice: no completion
    expect(run.outcome()).toBeUndefined()

    // #when the new turn's own reply is persisted and the root goes idle
    run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})
    await run.emit(textDeltaEvent('reply to the notice'))
    await run.emit(idleEvent())
    await run.done

    // #then it completes
    expect(run.outcome()).toEqual({ok: true})
  })

  it('5. a validation response racing a newer injection cannot admit completion', async () => {
    // #given two settled children, the first notice delivered, and REST responses held back
    const run = startRun()
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const full = {
      data: [
        PROMPT,
        FIRST_REPLY,
        userMessage('msg-n1', [{id: CHILD}]),
        userMessage('msg-n2', [{id: CHILD2}]),
        assistantReply('msg-reply-2', 'msg-n2'),
      ],
      error: null,
    }
    let calls = 0
    run.fixture.root = async () => {
      calls += 1
      if (calls === 1) return first.promise
      if (calls === 2) return second.promise
      return full
    }
    await run.emit(dispatchEvent(CHILD))
    await run.emit(dispatchEvent(CHILD2))
    await run.emit(noticeEvent(CHILD, {messageID: 'msg-n1', partID: 'part-n1'}))
    await run.emit(idleEvent())
    expect(calls).toBe(1)

    // #when a newer injection and a fresh idle arrive while that validation is in flight, then it answers
    await run.emit(noticeEvent(CHILD2, {messageID: 'msg-n2', partID: 'part-n2'}))
    await run.emit(idleEvent())
    first.resolve(full)
    await vi.advanceTimersByTimeAsync(1)

    // #then the late response is discarded (revision drift) and a fresh validation is requested instead
    expect(run.outcome()).toBeUndefined()
    expect(calls).toBe(2)

    // #when that validation answers
    second.resolve(full)
    await run.done

    // #then the run completes only now
    expect(run.outcome()).toEqual({ok: true})
  })

  it('5b. a stale REST transcript that predates the newest injected turn cannot admit completion', async () => {
    // #given two settled children whose notices have both reached the stream, and REST that lags: its latest
    // root user message is still msg-n1, which IS answered
    const run = startRun()
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const stale = {
      data: [PROMPT, FIRST_REPLY, userMessage('msg-n1', [{id: CHILD}]), assistantReply('msg-reply-1b', 'msg-n1')],
      error: null,
    }
    const full = {
      data: [
        PROMPT,
        FIRST_REPLY,
        userMessage('msg-n1', [{id: CHILD}]),
        assistantReply('msg-reply-1b', 'msg-n1'),
        userMessage('msg-n2', [{id: CHILD2}]),
        assistantReply('msg-reply-2', 'msg-n2'),
      ],
      error: null,
    }
    let calls = 0
    run.fixture.root = async () => {
      calls += 1
      if (calls === 1) return first.promise
      if (calls === 2) return second.promise
      return full
    }
    await run.emit(dispatchEvent(CHILD))
    await run.emit(dispatchEvent(CHILD2))
    await run.emit(noticeEvent(CHILD, {messageID: 'msg-n1', partID: 'part-n1'}))
    await run.emit(noticeEvent(CHILD2, {messageID: 'msg-n2', partID: 'part-n2'}))
    await run.emit(idleEvent())
    expect(calls).toBe(1)

    // #when the held validation answers with the stale transcript (nothing changed on the stream meanwhile)
    first.resolve(stale)
    await vi.advanceTimersByTimeAsync(1)

    // #then the stream's newest root user turn is missing from REST, so the answered msg-n1 reply is not enough
    expect(run.outcome()).toBeUndefined()

    // #when the retry fires and REST has caught up
    await run.advance(1_000)
    expect(calls).toBe(2)
    expect(run.outcome()).toBeUndefined()
    second.resolve(full)
    await run.done

    // #then the run completes only on the full transcript
    expect(run.outcome()).toEqual({ok: true})
  })

  describe('3. reply qualification decides the outcome alone', () => {
    /** The root is NOT live, the ledger is settled, the notice was seen, and the idle is current: only the reply varies. */
    async function runWithReply(reply: ReturnType<typeof assistantReply>) {
      const run = startRun({deadlineMs: 60_000})
      run.fixture.root = async () => ({
        data: [PROMPT, FIRST_REPLY, userMessage('msg-n1', [{id: CHILD}]), reply],
        error: null,
      })
      await run.emit(dispatchEvent(CHILD))
      await run.emit(noticeEvent(CHILD))
      await run.emit(idleEvent())
      return run
    }

    const interruptedOrphan = {type: 'tool', state: {status: 'error', metadata: {interrupted: true}}}

    it.each([
      ['time.completed is missing', assistantReply('r', 'msg-n1', {info: {time: {}}})],
      ['finish is tool-calls', assistantReply('r', 'msg-n1', {info: {finish: 'tool-calls'}})],
      ['finish is unknown', assistantReply('r', 'msg-n1', {info: {finish: 'unknown'}})],
      ['finish is missing', assistantReply('r', 'msg-n1', {info: {finish: undefined}})],
      ['the message carries an error', assistantReply('r', 'msg-n1', {info: {error: {name: 'APIError', data: {}}}})],
      [
        'a completed non-provider-executed tool part blocks it',
        assistantReply('r', 'msg-n1', {parts: [{type: 'tool', state: {status: 'completed'}}]}),
      ],
      [
        'a running tool part blocks it',
        assistantReply('r', 'msg-n1', {parts: [{type: 'tool', state: {status: 'running'}}]}),
      ],
      [
        'a tool error that is not marked interrupted blocks it',
        assistantReply('r', 'msg-n1', {
          parts: [{type: 'tool', state: {status: 'error', metadata: {interrupted: false}}}],
        }),
      ],
      [
        'an interrupted marker on a non-error tool does not exempt it',
        assistantReply('r', 'msg-n1', {
          parts: [{type: 'tool', state: {status: 'completed', metadata: {interrupted: true}}}],
        }),
      ],
    ])('%s: the run is held until a qualified reply exists', async (_label, reply) => {
      // #given a root that is not live, a settled ledger, an observed notice, and a current idle — but this reply
      const run = await runWithReply(reply)

      // #when several retries pass
      await run.advance(5_000)

      // #then the reply predicate alone kept the run pending
      expect(run.outcome()).toBeUndefined()

      // #when the reply becomes a qualified terminal one
      run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})
      await run.advance(1_000)
      await run.done

      // #then it completes
      expect(run.outcome()).toEqual({ok: true})
    })

    it.each([
      ['an interrupted orphan tool part is exempt', assistantReply('r', 'msg-n1', {parts: [interruptedOrphan]})],
      [
        'a provider-executed tool part is exempt',
        assistantReply('r', 'msg-n1', {
          parts: [{type: 'tool', metadata: {providerExecuted: true}, state: {status: 'completed'}}],
        }),
      ],
      ['a text-only reply qualifies', assistantReply('r', 'msg-n1', {parts: [{type: 'text', text: 'done'}]})],
    ])('%s: the run completes', async (_label, reply) => {
      // #given a root that is not live, a settled ledger, an observed notice, and a current idle
      // #when the reply carries only exempt or non-blocking parts
      const run = await runWithReply(reply)
      await run.done

      // #then it qualifies and the run completes
      expect(run.outcome()).toEqual({ok: true})
    })
  })

  it('5c. a notice recognised only on the stream (no part.time) is enough when REST carries no parseable notice part', async () => {
    // #given REST that holds the latest root user message and its reply, but with no synthetic task part at all
    const run = startRun({deadlineMs: 60_000})
    run.fixture.root = async () => ({
      data: [
        PROMPT,
        FIRST_REPLY,
        {info: {id: 'msg-n1', role: 'user', sessionID: ROOT}, parts: [{type: 'text', text: 'background update'}]},
        assistantReply('msg-reply-2', 'msg-n1'),
      ],
      error: null,
    })

    // #when the stream delivers the synthetic notice (whole part, no `time`) and the root goes idle
    await run.emit(dispatchEvent(CHILD))
    await run.emit(noticeEvent(CHILD))
    await run.emit(idleEvent())
    await run.done

    // #then completion depended on recognising that notice on the stream
    expect(run.outcome()).toEqual({ok: true})
  })

  it('6. several notices plus duplicates: one reply to the latest user message suffices and duplicates add nothing', async () => {
    // #given two settled children, both notices delivered, and the validation response held back
    const run = startRun()
    const held = deferred<unknown>()
    const full = {
      data: [
        PROMPT,
        FIRST_REPLY,
        userMessage('msg-n1', [{id: CHILD}]),
        userMessage('msg-n2', [{id: CHILD2}]),
        assistantReply('msg-reply-2', 'msg-n2'),
      ],
      error: null,
    }
    let calls = 0
    run.fixture.root = async () => {
      calls += 1
      return calls === 1 ? held.promise : full
    }
    await run.emit(dispatchEvent(CHILD))
    await run.emit(dispatchEvent(CHILD2))
    await run.emit(noticeEvent(CHILD, {messageID: 'msg-n1', partID: 'part-n1'}))
    await run.emit(noticeEvent(CHILD2, {messageID: 'msg-n2', partID: 'part-n2'}))
    await run.emit(idleEvent())
    expect(calls).toBe(1)

    // #when the same notices are redelivered while the validation is in flight, then it answers
    await run.emit(noticeEvent(CHILD, {messageID: 'msg-n1', partID: 'part-n1'}))
    await run.emit(noticeEvent(CHILD2, {messageID: 'msg-n2', partID: 'part-n2'}))
    held.resolve(full)
    await run.done

    // #then the single reply to the latest notice completed the run, on the first validation
    expect(run.outcome()).toEqual({ok: true})
    expect(calls).toBe(1)
  })

  it('7. completed and error notices both require the parent follow-up, and notice text never reaches the sink', async () => {
    // #given two settled children, one finished and one failed, both notices delivered
    const run = startRun()
    run.fixture.root = async () => ({
      data: [
        PROMPT,
        FIRST_REPLY,
        userMessage('msg-n1', [{id: CHILD, state: 'completed'}]),
        assistantReply('msg-reply-2', 'msg-n1'),
        userMessage('msg-n2', [{id: CHILD2, state: 'error'}]),
      ],
      error: null,
    })
    await run.emit(dispatchEvent(CHILD))
    await run.emit(dispatchEvent(CHILD2))
    await run.emit(noticeEvent(CHILD, {state: 'completed', messageID: 'msg-n1', partID: 'part-n1'}))
    await run.emit(noticeEvent(CHILD2, {state: 'error', messageID: 'msg-n2', partID: 'part-n2'}))
    // a delta for a notice part carries the harness text: it must be dropped, not streamed to the thread
    await run.emit(textDeltaEvent('<task id="sess-child-2" state="error">', 'part-n2'))
    await run.emit(idleEvent())
    await run.advance(3_000)

    // #then the completed notice's reply does not cover the later error notice: still pending
    expect(run.outcome()).toBeUndefined()

    // #when the error notice's own turn is answered
    run.fixture.root = async () => ({
      data: [
        PROMPT,
        FIRST_REPLY,
        userMessage('msg-n1', [{id: CHILD, state: 'completed'}]),
        assistantReply('msg-reply-2', 'msg-n1'),
        userMessage('msg-n2', [{id: CHILD2, state: 'error'}]),
        assistantReply('msg-reply-3', 'msg-n2'),
      ],
      error: null,
    })
    await run.emit(textDeltaEvent('handled the failure'))
    await run.emit(idleEvent())
    await run.done

    // #then it completes, with the reply but none of the notice text in the sink
    expect(run.outcome()).toEqual({ok: true})
    expect(run.sink.appended.join('')).toContain('handled the failure')
    expect(run.sink.appended.join('')).not.toContain('<task id')
  })

  it('8. a notice missed by the stream but persisted is discovered over REST', async () => {
    // #given a settled child whose notice never reached the stream, but REST shows the answered follow-up
    const run = startRun()
    run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})

    // #when the root goes idle
    await adoptAndGoIdle(run, CHILD)
    await run.done

    // #then the persisted notice counted toward the fence
    expect(run.outcome()).toEqual({ok: true})
  })

  describe('9. cancel exemption', () => {
    it('a child whose last assistant message ended aborted is exempt: the run completes without waiting for the deadline', async () => {
      // #given a settled child that was cancelled (upstream injects nothing), with the root quiet and answered
      const run = startRun({deadlineMs: 60_000})
      run.fixture.child = async id => ({data: id === CHILD ? [abortedAssistant] : [], error: null})

      // #when the root goes idle
      await adoptAndGoIdle(run, CHILD)
      await run.done

      // #then success, reached long before the deadline, and the child REST read was scoped to the run directory
      expect(run.outcome()).toEqual({ok: true})
      expect(run.client.session.messages).toHaveBeenCalledWith(
        expect.objectContaining({path: {id: CHILD}, query: {directory: DIRECTORY}}),
      )
    })

    it.each([
      ['REST returns an error', async () => ({data: undefined, error: {message: 'boom'}})],
      [
        'REST rejects',
        async () => {
          throw new Error('network down')
        },
      ],
      ['REST returns a non-array payload', async () => ({data: {not: 'a list'}, error: null})],
      ['the child has no assistant message', async () => ({data: [], error: null})],
      [
        'the last assistant message ended for another reason',
        async () => ({
          data: [{...abortedAssistant, info: {...abortedAssistant.info, error: {name: 'APIError', data: {}}}}],
          error: null,
        }),
      ],
      [
        'an earlier message was aborted but the last assistant message was not',
        async () => ({
          data: [
            abortedAssistant,
            {info: {id: 'c-a2', role: 'assistant', sessionID: CHILD, time: {completed: 2}, finish: 'stop'}, parts: []},
          ],
          error: null,
        }),
      ],
    ])(
      'unknown or failed evidence is NOT exempt (%s): the run reports incomplete at the deadline',
      async (_label, child) => {
        // #given a settled child with no notice and evidence that does not prove a cancel
        const run = startRun({deadlineMs: 20_000})
        run.fixture.child = child

        // #when the root goes idle and the deadline passes
        await adoptAndGoIdle(run, CHILD)
        await run.advance(19_000)
        expect(run.outcome()).toBeUndefined()
        await run.advance(2_000)
        await run.done

        // #then it is the existing drain-timeout, never success
        expectKind(run.outcome(), 'drain-timeout')
      },
    )
  })

  it('10. no notice and no cancel evidence never succeeds: the deadline reports incomplete', async () => {
    // #given a settled child, a quiet root with its prompt answered, and nothing else, ever
    const run = startRun({deadlineMs: 30_000})
    await adoptAndGoIdle(run, CHILD)

    // #when a long time passes with the root idle and REST healthy
    await run.advance(29_000)

    // #then no grace period turns that into success
    expect(run.outcome()).toBeUndefined()

    // #when the deadline passes
    await run.advance(2_000)
    await run.done

    // #then the existing incomplete classification is reported; the settled child is not re-cancelled, but the
    // root (which may be running a follow-up turn) is aborted and confirmed quiescent first
    expectKind(run.outcome(), 'drain-timeout')
    expect((run.outcome() as {error: RunCoreError}).error.quarantined).toBe(false)
    expect(run.sessionAbort).toHaveBeenCalledTimes(1)
    expect(run.sessionAbort).toHaveBeenCalledWith(expect.objectContaining({path: {id: ROOT}}))
  })

  describe('11. root REST corroboration and bounded requests', () => {
    it('root REST busy: no success until the root is no longer live', async () => {
      // #given a fully answered follow-up, but the server reports the root still live
      // #when that persists past several retries, and then the root stops being live
      const run = await runWithFault(
        r => r.live.add(ROOT),
        r => r.live.delete(ROOT),
      )

      // #then it stayed pending while the root was live (asserted inside the helper) and completes once it is not
      expect(run.outcome()).toEqual({ok: true})
    })

    it('liveness lookup failing: no success', async () => {
      // #given an already-settled ledger, so the failing status lookup is the validation's and not a reconcile pass
      const ownershipLedger = createOwnershipLedger()
      ownershipLedger.adopt(CHILD, 'background task')
      ownershipLedger.settle(CHILD)
      const run = startRun({ownershipLedger, deadlineMs: 60_000})
      run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})
      let healthy = false
      const original = run.fixture.status
      run.fixture.status = async () => (healthy ? original() : {data: undefined, error: {message: 'boom'}})
      await run.emit(noticeEvent(CHILD))
      await run.emit(idleEvent())
      await run.advance(7_000)

      // #then still failing: never success
      expect(run.outcome()).toBeUndefined()

      // #when it recovers
      healthy = true
      await run.advance(1_000)
      await run.done
      expect(run.outcome()).toEqual({ok: true})
    })

    it.each([
      ['malformed', async () => ({data: {not: 'a list'}, error: null})],
      ['an error response', async () => ({data: undefined, error: {message: 'boom'}})],
      [
        'a rejected request',
        async () => {
          throw new Error('network down')
        },
      ],
      ['an empty list', async () => ({data: [], error: null})],
    ])('root messages %s: no success', async (_label, broken) => {
      // #given a fully answered follow-up, but the root messages read is broken
      let healthy = false
      const run = await runWithFault(
        r => {
          const original = r.fixture.root
          r.fixture.root = async () => (healthy ? original() : broken())
        },
        () => {
          healthy = true
        },
      )

      // #then it stayed pending while the read was broken (asserted inside the helper) and completes once it heals
      expect(run.outcome()).toEqual({ok: true})
    })

    it('a hung root messages request is abandoned after the cap and retried; it never blocks forever or succeeds', async () => {
      // #given the first root messages request never answers
      const run = startRun({deadlineMs: 60_000})
      const healthy = async () => ({data: [...completedTurns(CHILD)], error: null})
      let calls = 0
      run.fixture.root = async () => {
        calls += 1
        return calls === 1
          ? new Promise<unknown>(() => {
              /* never settles */
            })
          : healthy()
      }
      await run.emit(dispatchEvent(CHILD))
      await run.emit(noticeEvent(CHILD))
      await run.emit(idleEvent())
      expect(calls).toBe(1)

      // #when less than the cap passes
      await run.advance(4_000)

      // #then it is still waiting on that one request
      expect(calls).toBe(1)
      expect(run.outcome()).toBeUndefined()

      // #when the cap passes
      await run.advance(1_100)
      await run.advance(1_000)
      await run.done

      // #then the request was abandoned, retried, and the retry completed the run
      expect(calls).toBeGreaterThanOrEqual(2)
      expect(run.outcome()).toEqual({ok: true})
    })

    it('a hung liveness request is abandoned after the cap as well', async () => {
      // #given a fully answered follow-up, and a validation-time liveness lookup that never answers
      const run = startRun({deadlineMs: 60_000})
      run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})
      const healthyStatus = run.fixture.status
      let statusCalls = 0
      run.fixture.status = async () => {
        statusCalls += 1
        // call 1 is the immediate reconcile pass at the first idle; the validation's lookup is a later call
        return statusCalls === 2
          ? new Promise<unknown>(() => {
              /* never settles */
            })
          : healthyStatus()
      }
      await run.emit(dispatchEvent(CHILD))
      await run.emit(noticeEvent(CHILD))
      await run.emit(idleEvent())

      // #when less than the cap passes
      await run.advance(4_000)

      // #then the run is still waiting on that lookup
      expect(run.outcome()).toBeUndefined()

      // #when the cap passes and the retry's lookup answers
      await run.advance(2_200)
      await run.done

      // #then the abandoned lookup did not block the retry, which completed the run
      expect(run.outcome()).toEqual({ok: true})
    })
  })

  it('12. a ledger unknown entry still blocks, whatever notices and replies exist', async () => {
    // #given an entry downgraded to unknown (not a child of this parent) with full notice and reply evidence
    const ownershipLedger = createOwnershipLedger()
    ownershipLedger.adopt(CHILD, 'background task')
    ownershipLedger.markUnknown(CHILD)
    const run = startRun({ownershipLedger, children: [], deadlineMs: 20_000})
    run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})

    // #when the notice and a fresh idle arrive
    await run.emit(noticeEvent(CHILD))
    await run.emit(idleEvent())
    await run.advance(15_000)

    // #then unknown is not proof of completion: still blocked
    expect(ownershipLedger.snapshot().find(entry => entry.sessionId === CHILD)?.state).toBe('unknown')
    expect(run.outcome()).toBeUndefined()

    // #when the deadline passes
    await run.advance(6_000)
    await run.done

    // #then it reports incomplete and cancels the unknown entry
    expectKind(run.outcome(), 'drain-timeout')
    expect(run.sessionAbort).toHaveBeenCalledWith(expect.objectContaining({path: {id: CHILD}}))
  })

  describe('13. human waits stay independent of completion', () => {
    it('a question and an approval released mid-drain, with text and tool activity, neither complete the run nor re-arm the watchdog', async () => {
      // #given a live child that asks a question and an approval while the root is idle (drain)
      const run = startRun({
        live: [CHILD],
        withQuestions: true,
        inactivityTimeoutMs: WINDOW,
        deadlineMs: 120_000,
      })
      await run.emit(dispatchEvent(CHILD))
      await run.emit(idleEvent())
      await run.emit(questionAskedEvent('que_1', CHILD))
      await run.emit(permissionAskedEvent('per_1', CHILD))
      run.onBusy.mockClear()

      // #when both are released, the child works, and the run goes quiet for several watchdog windows
      await run.emit(questionRepliedEvent('que_1', CHILD))
      await run.emit(permissionRepliedEvent('per_1', CHILD))
      await run.emit(textDeltaEvent('child output', 'part-c', CHILD))
      await run.emit(toolCompletedEvent(CHILD))
      await run.advance(WINDOW * 4)

      // #then nothing completed, the watchdog stayed paused, typing stayed off, and no work was cancelled
      expect(run.outcome()).toBeUndefined()
      expect(run.onBusy).not.toHaveBeenCalledWith(true)
      expect(run.sessionAbort).not.toHaveBeenCalled()

      // #when the child finishes and its notice is answered
      run.live.delete(CHILD)
      run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})
      await run.advance(DEFAULT_LEDGER_RECONCILE_INTERVAL_MS)
      await run.emit(noticeEvent(CHILD))
      await run.emit(idleEvent())
      await run.done

      // #then it completes on evidence, not on the released waits
      expect(run.outcome()).toEqual({ok: true})
    })

    it('a follow-up question holds completion through its unanswered root turn', async () => {
      // #given a settled child, its notice delivered, and the parent's follow-up turn blocked on a question
      const run = startRun({withQuestions: true, inactivityTimeoutMs: WINDOW, deadlineMs: 120_000})
      await adoptAndGoIdle(run, CHILD)
      run.live.add(ROOT)
      run.fixture.root = async () => ({
        data: [
          PROMPT,
          FIRST_REPLY,
          userMessage('msg-n1', [{id: CHILD}]),
          assistantReply('msg-reply-2', 'msg-n1', {info: {time: {}, finish: 'tool-calls'}}),
        ],
        error: null,
      })
      await run.emit(noticeEvent(CHILD))
      await run.emit(statusEvent('busy'))
      await run.emit(questionAskedEvent('que_followup'))

      // #when a stale idle arrives and the question stays unanswered well past the watchdog window
      await run.emit(idleEvent())
      await run.advance(WINDOW * 4)

      // #then the unanswered root turn holds the run (and the human wait holds the watchdog)
      expect(run.outcome()).toBeUndefined()

      // #when the question is answered and the parent finishes its turn
      run.live.delete(ROOT)
      run.fixture.root = async () => ({data: [...completedTurns(CHILD)], error: null})
      await run.emit(questionRepliedEvent('que_followup'))
      await run.emit(textDeltaEvent('done after the answer'))
      await run.emit(idleEvent())
      await run.done

      // #then it completes
      expect(run.outcome()).toEqual({ok: true})
    })
  })

  describe('14. runs that never adopted a background dispatch are untouched', () => {
    /** SDK call arguments without the AbortSignal (its internal wiring differs by construction, not behaviour). */
    const withoutSignal = (calls: readonly (readonly unknown[])[]) =>
      calls.map(call => call.map(arg => (arg !== null && typeof arg === 'object' ? {...arg, signal: undefined} : arg)))

    async function scriptedRun(kind: 'none' | 'empty' | 'foreground-only') {
      // every kind runs the same script, including a foreground `task` call (no `background` metadata)
      const run = startRun({noLedger: kind === 'none'})
      await run.emit(textDeltaEvent('hello '))
      await run.emit(foregroundTaskEvent())
      await run.emit(toolCompletedEvent())
      await run.emit(idleEvent())
      await run.done
      return {
        outcome: run.outcome(),
        sink: run.sink.appended,
        onBusy: run.onBusy.mock.calls,
        onActivity: run.onActivity.mock.calls,
        logs: [run.logger.debug, run.logger.info, run.logger.warn, run.logger.error].map(
          fn => vi.mocked(fn).mock.calls,
        ),
        sdk: {
          create: withoutSignal(run.client.session.create.mock.calls),
          promptAsync: withoutSignal(run.client.session.promptAsync.mock.calls),
          children: withoutSignal(run.client.session.children.mock.calls),
          status: withoutSignal(run.client.session.status.mock.calls),
          abort: withoutSignal(run.client.session.abort.mock.calls),
          messages: withoutSignal(run.client.session.messages.mock.calls),
          subscribe: run.client.event.subscribe.mock.calls.length,
        },
      }
    }

    it('no ledger, an empty ledger, and a foreground-only task all behave identically: same sink, callbacks, logs, SDK calls', async () => {
      // #given the same script (text, a foreground task, a tool completion, root idle) for each kind of run
      const none = await scriptedRun('none')
      vi.useRealTimers()
      const empty = await scriptedRun('empty')
      vi.useRealTimers()
      const foreground = await scriptedRun('foreground-only')

      // #when each has run the same script and reached its first root idle
      // #then the pre-existing return path: success on the first root idle
      expect(none.outcome).toEqual({ok: true})
      expect(none.onBusy).toEqual([[true], [false]])
      expect(none.sink).toContain('hello ')
      expect(none.logs[1]).toContainEqual([
        expect.objectContaining({sessionId: ROOT}),
        'run-core: session.idle received — stream complete',
      ])
      // #and no drain-completion REST was made, and nothing was reconciled or cancelled
      for (const result of [none, empty, foreground]) {
        expect(result.sdk.messages).toEqual([])
        expect(result.sdk.children).toEqual([])
        expect(result.sdk.status).toEqual([])
        expect(result.sdk.abort).toEqual([])
      }
      // #and the three runs are indistinguishable
      expect(empty).toEqual(none)
      expect(foreground).toEqual(none)
    })
  })

  describe('15. existing failure classifications are kept, and nothing outlives the run', () => {
    it('a cancel (the run signal aborting) while draining is the existing drain-timeout', async () => {
      // #given a drain awaiting evidence, with a validation held in flight
      const {run, held} = await awaitingEvidence()

      // #when the run is cancelled
      run.controller.abort()
      await run.advance(1)
      await run.done

      // #then it keeps its classification, and a late admissible response changes nothing
      expectKind(run.outcome(), 'drain-timeout')
      await expectNothingLeftBehind(run, held)
    })

    it('the deadline expiring while draining is the existing drain-timeout', async () => {
      // #given a drain awaiting evidence, with a validation held in flight
      const {run, held} = await awaitingEvidence({deadlineMs: 10_000})

      // #when the deadline passes
      await run.advance(10_100)
      await run.done

      // #then it keeps its classification, and a late admissible response changes nothing
      expectKind(run.outcome(), 'drain-timeout')
      await expectNothingLeftBehind(run, held)
    })

    it('the stream closing while draining is the existing stream-ended', async () => {
      // #given a drain awaiting evidence, with a validation held in flight
      const {run, held} = await awaitingEvidence()

      // #when the event stream closes
      await run.closeStream()
      await run.done

      // #then it keeps its classification, and a late admissible response changes nothing
      expectKind(run.outcome(), 'stream-ended')
      await expectNothingLeftBehind(run, held)
    })

    it('a root session error while draining is the existing session-error', async () => {
      // #given a drain awaiting evidence, with a validation held in flight
      const {run, held} = await awaitingEvidence()

      // #when the root reports a session error
      await run.emit(sessionErrorEvent())
      await run.done

      // #then it keeps its classification, and a late admissible response changes nothing
      expectKind(run.outcome(), 'session-error')
      await expectNothingLeftBehind(run, held)
    })
  })

  describe('16. failure teardown covers the parent follow-up turn', () => {
    const DEADLINE_MS = 10_000

    /** Children settled, the notice delivered, and the parent's follow-up turn running (root live, no reply yet). */
    async function inFollowUp(options: RunOptions = {}) {
      const run = startRun({deadlineMs: DEADLINE_MS, ...options})
      run.fixture.root = async () => ({
        data: [PROMPT, FIRST_REPLY, userMessage('msg-n1', [{id: CHILD}])],
        error: null,
      })
      await adoptAndGoIdle(run, CHILD)
      await run.emit(noticeEvent(CHILD))
      await run.emit(statusEvent('busy'))
      run.live.add(ROOT)
      expect(run.ownershipLedger?.isDrainComplete()).toBe(true)
      return run
    }

    it.each([
      ['the deadline expires', async (run: Run) => run.advance(DEADLINE_MS + 50)],
      [
        'the operator cancels',
        async (run: Run) => {
          run.controller.abort()
          await run.advance(50)
        },
      ],
    ])(
      '%s while the parent runs its follow-up: the root is aborted and confirmed quiescent before the run rejects',
      async (_label, interrupt) => {
        // #given the follow-up turn running, a root abort that takes ~700ms to actually stop it
        const order: string[] = []
        const run = await inFollowUp({
          sessionAbort: async () => {
            order.push('abort-root')
            setTimeout(() => run.live.delete(ROOT), 700)
            return {data: {}, error: null}
          },
        })
        const healthyStatus = run.fixture.status
        run.fixture.status = async () => {
          const result = await healthyStatus()
          if (order.includes('abort-root') && !run.live.has(ROOT)) order.push('confirmed-quiescent')
          return result
        }
        run.done.then(
          () => order.push('rejected'),
          () => order.push('rejected'),
        )

        // #when the run is interrupted
        await interrupt(run)
        await run.advance(400)

        // #then the root was told to stop (scoped to the run's directory) but the run has not yet released anything
        expect(run.sessionAbort).toHaveBeenCalledWith(
          expect.objectContaining({path: {id: ROOT}, query: {directory: DIRECTORY}}),
        )
        expect(run.outcome()).toBeUndefined()

        // #when the root stops
        await run.advance(1_200)
        await run.done

        // #then the run rejected only after quiescence was confirmed, with the existing classification, unquarantined
        expectKind(run.outcome(), 'drain-timeout')
        expect((run.outcome() as {error: RunCoreError}).error.quarantined).toBe(false)
        expect(order).toEqual(['abort-root', 'confirmed-quiescent', 'rejected'])
        expect(run.sessionAbort).not.toHaveBeenCalledWith(expect.objectContaining({path: {id: CHILD}}))
      },
    )

    it.each([
      ['the root never stops running', {sessionAbort: async () => ({data: {}, error: null})}, (_run: Run) => undefined],
      [
        'the abort call rejects and the root keeps running',
        {
          sessionAbort: async () => {
            throw new Error('server down')
          },
        },
        (_run: Run) => undefined,
      ],
      [
        'the abort call returns an error envelope and the root keeps running',
        {sessionAbort: async () => ({data: undefined, error: {message: 'nope'}})},
        (_run: Run) => undefined,
      ],
      [
        'the abort call hangs',
        {sessionAbort: async () => hangForever()},
        (run: Run) => {
          run.live.delete(ROOT)
        },
      ],
      [
        'the confirmation lookup keeps failing',
        {sessionAbort: async () => ({data: {}, error: null})},
        (run: Run) => {
          run.fixture.status = async () => ({data: undefined, error: {message: 'boom'}})
        },
      ],
      [
        'the confirmation lookup hangs',
        {sessionAbort: async () => ({data: {}, error: null})},
        (run: Run) => {
          run.fixture.status = async () => hangForever()
        },
      ],
    ])('%s: the barrier is bounded and the run is quarantined', async (_label, options, sabotage) => {
      // #given the follow-up turn running and the teardown sabotaged
      const run = await inFollowUp(options)
      sabotage(run)

      // #when the deadline expires
      await run.advance(DEADLINE_MS + 50)

      // #then it is still inside the teardown bound — nothing released yet
      await run.advance(14_000)
      expect(run.outcome()).toBeUndefined()

      // #when the bound passes
      await run.advance(1_500)
      await run.done

      // #then the run is quarantined with the original classification, and nothing keeps polling
      expectKind(run.outcome(), 'drain-timeout')
      expect((run.outcome() as {error: RunCoreError}).error.quarantined).toBe(true)
      await run.advance(2_000)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('a failed abort is not a quarantine when the root is nonetheless confirmed quiescent', async () => {
      // #given the follow-up turn already over from the server's point of view, and an abort that errors
      const run = await inFollowUp({sessionAbort: async () => ({data: undefined, error: {message: 'nope'}})})
      run.live.delete(ROOT)

      // #when the deadline expires
      await run.advance(DEADLINE_MS + 600)
      await run.done

      // #then the confirmation, not the abort receipt, is the authority
      expectKind(run.outcome(), 'drain-timeout')
      expect((run.outcome() as {error: RunCoreError}).error.quarantined).toBe(false)
    })
  })

  describe('17. runs that never adopted background work are unchanged on cancel and deadline', () => {
    it.each([
      ['no ledger', 'deadline', {noLedger: true}],
      ['no ledger', 'cancel', {noLedger: true}],
      ['an empty ledger', 'deadline', {}],
      ['an empty ledger', 'cancel', {}],
    ])(
      '%s, %s: no root abort, no liveness or messages lookups, original classification',
      async (_label, how, options) => {
        // #given a run with nothing adopted, mid-execution
        const run = startRun({deadlineMs: 10_000, ...options})
        await run.emit(textDeltaEvent('working…'))

        // #when it is cancelled or its deadline expires
        if (how === 'deadline') await run.advance(10_100)
        else {
          run.controller.abort()
          await run.advance(50)
        }
        await run.done

        // #then the pre-existing classification, unquarantined, and the SDK was touched exactly as before
        expectKind(run.outcome(), 'timeout')
        expect((run.outcome() as {error: RunCoreError}).error.quarantined).toBe(false)
        expect(run.client.session.create).toHaveBeenCalledTimes(1)
        expect(run.client.session.promptAsync).toHaveBeenCalledTimes(1)
        expect(run.client.event.subscribe).toHaveBeenCalledTimes(1)
        expect(run.client.session.abort).not.toHaveBeenCalled()
        expect(run.client.session.status).not.toHaveBeenCalled()
        expect(run.client.session.children).not.toHaveBeenCalled()
        expect(run.client.session.messages).not.toHaveBeenCalled()
      },
    )
  })

  describe('18. the delivery fence: completion waits for the follow-up reply to reach the sink, and never repairs it', () => {
    const textPart = (id: string, text: string, extra: object = {}) => ({id, type: 'text', text, ...extra})
    const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1
    const legacyDelta = (text: string): object => ({
      type: 'session.next.text.delta',
      properties: {sessionID: ROOT, delta: text},
    })

    it('a persisted part the stream never delivered holds the run until the deadline, and nothing is appended', async () => {
      // #given the follow-up reply is persisted, and the stream delivers none of it
      const run = await startFollowUp([textPart('part-r2', 'SECRET follow-up answer.')], {deadlineMs: 20_000})

      // #when the root goes idle and time passes up to the deadline
      await run.emit(idleEvent())
      await run.advance(19_000)

      // #then it is not admitted, and the sink holds nothing the stream did not put there
      expect(run.outcome()).toBeUndefined()
      expect(replyOutput(run)).toBe('')

      // #when the deadline passes
      await run.advance(1_500)
      await run.done

      // #then it reports incomplete, like any other missing drain evidence — never success, still nothing appended
      expectKind(run.outcome(), 'drain-timeout')
      expect(replyOutput(run)).toBe('')

      // #and the debug log names part ids, never reply text
      const debugLogs = JSON.stringify(vi.mocked(run.logger.debug).mock.calls)
      expect(debugLogs).toContain('reply-text-not-delivered')
      expect(debugLogs).toContain('part-r2')
      expect(JSON.stringify(vi.mocked(run.logger.info).mock.calls)).not.toContain('SECRET')
      expect(debugLogs).not.toContain('SECRET')
    })

    it('three persisted parts, only the middle streamed: held; nothing is appended on completion; the rest stream and it completes', async () => {
      // #given persisted One./Two./Three., of which the stream delivered only the middle one
      const run = await startFollowUp([textPart('p1', 'One. '), textPart('p2', 'Two. '), textPart('p3', 'Three.')])
      await run.emit(textDeltaEvent('Two. ', 'p2'))
      await run.emit(idleEvent())

      // #when time passes with the others undelivered
      await run.advance(5_000)

      // #then it is held, and the sink holds exactly what streamed — no part was appended on the gate's behalf
      expect(run.outcome()).toBeUndefined()
      expect(replyOutput(run)).toBe('Two. ')

      // #when the remaining parts stream in order, and the root goes idle
      await run.emit(textDeltaEvent('One. ', 'p1'))
      await run.emit(textDeltaEvent('Three.', 'p3'))
      await run.emit(idleEvent())
      await run.done

      // #then it completes, and the sink is exactly the stream's own appends (the middle part was already on
      // screen first; the fence guarantees completeness, it cannot and does not reorder)
      expect(run.outcome()).toEqual({ok: true})
      expect(replyOutput(run)).toBe('Two. One. Three.')
      expect(run.sink.appended.filter(chunk => chunk !== '\nbackground task\n')).toEqual(['Two. ', 'One. ', 'Three.'])
    })

    it('an earlier part streamed partially and a later part completely: held until the earlier part completes', async () => {
      // #given the first part only half delivered, the second one whole
      const run = await startFollowUp([textPart('p1', 'Alpha beta.'), textPart('p2', ' Gamma.')])
      await run.emit(textDeltaEvent('Alpha ', 'p1'))
      await run.emit(textDeltaEvent(' Gamma.', 'p2'))
      await run.emit(idleEvent())

      // #when time passes
      await run.advance(5_000)

      // #then the half-delivered part holds the run
      expect(run.outcome()).toBeUndefined()

      // #when the rest of the first part arrives
      await run.emit(textDeltaEvent('beta.', 'p1'))
      await run.emit(idleEvent())
      await run.done

      // #then it completes
      expect(run.outcome()).toEqual({ok: true})
    })

    it('a partial part-id-less delta ("Follow-up ") against persisted "Follow-up answer.": held, never duplicated; completes once the rest streams', async () => {
      // #given the legacy delta shape (no part id) delivered only a prefix
      const run = await startFollowUp([textPart('part-r2', 'Follow-up answer.')])
      await run.emit(legacyDelta('Follow-up '))
      await run.emit(idleEvent())

      // #when time passes
      await run.advance(5_000)

      // #then a prefix is never accepted, and nothing was appended on top of it
      expect(run.outcome()).toBeUndefined()
      expect(replyOutput(run)).toBe('Follow-up ')

      // #when the remainder streams
      await run.emit(legacyDelta('answer.'))
      await run.emit(idleEvent())
      await run.done

      // #then it completes with the text in the sink exactly once
      expect(run.outcome()).toEqual({ok: true})
      expect(replyOutput(run)).toBe('Follow-up answer.')
      expect(occurrences(replyOutput(run), 'Follow-up')).toBe(1)
    })

    it('part-id-less text is matched at the end of what was delivered, so earlier turns that streamed the same way do not interfere', async () => {
      // #given an earlier turn's part-id-less text, then the follow-up's, fully delivered
      const run = await startFollowUp([textPart('part-r2', 'Follow-up answer.')])
      await run.emit(legacyDelta('Earlier turn. '))
      await run.emit(legacyDelta('Follow-up answer.'))

      // #when the root goes idle
      await run.emit(idleEvent())
      await run.done

      // #then it is admitted
      expect(run.outcome()).toEqual({ok: true})
    })

    it('two part-id-less parts need both, in order, at the end of the delivered text', async () => {
      // #given persisted "One. " and "Two.", with the stream delivering only the second
      const run = await startFollowUp([textPart('p1', 'One. '), textPart('p2', 'Two.')])
      await run.emit(legacyDelta('Two.'))
      await run.emit(idleEvent())
      await run.advance(5_000)

      // #then the missing first part holds the run
      expect(run.outcome()).toBeUndefined()

      // #when the stream replays the turn's text in order
      await run.emit(legacyDelta('One. '))
      await run.emit(legacyDelta('Two.'))
      await run.emit(idleEvent())
      await run.done

      // #then it completes
      expect(run.outcome()).toEqual({ok: true})
    })

    it.each([
      [
        'a part-id delivery with extra trailing whitespace',
        [textPart('part-r2', 'Follow-up answer.')],
        [textDeltaEvent('Follow-up answer.\n', 'part-r2')],
      ],
      [
        'a part-id-less delivery with extra trailing whitespace',
        [textPart('part-r2', 'Follow-up answer.')],
        [legacyDelta('Follow-up answer.\n')],
      ],
      [
        'two part-id-less parts, extra whitespace only after the final one',
        [textPart('p1', 'One. '), textPart('p2', 'Two.')],
        [legacyDelta('One. '), legacyDelta('Two.\n\n')],
      ],
      [
        String.raw`a whitespace-only final part delivered exactly (legacy "One.\n" vs "One." + "\n")`,
        [textPart('p1', 'One.'), textPart('p2', '\n')],
        [legacyDelta('One.\n')],
      ],
      [
        String.raw`a whitespace-only final part plus extra trailing whitespace (legacy "One.\n\n" vs "One." + "\n")`,
        [textPart('p1', 'One.'), textPart('p2', '\n')],
        [legacyDelta('One.\n\n')],
      ],
      [
        'persisted trailing whitespace delivered exactly (part-id)',
        [textPart('part-r2', 'Follow-up answer.\n')],
        [textDeltaEvent('Follow-up answer.\n', 'part-r2')],
      ],
    ])('%s still admits', async (_label, parts, streamed) => {
      // #given the stream delivered the complete persisted text, plus at most extra trailing whitespace
      const run = await startFollowUp(parts)
      for (const event of streamed) await run.emit(event)

      // #when the root goes idle
      await run.emit(idleEvent())
      await run.done

      // #then it is admitted
      expect(run.outcome()).toEqual({ok: true})
    })

    it.each([
      [
        'a part-id-less delivery missing the separator between persisted parts ("One.Two." vs "One. " + "Two.")',
        [textPart('p1', 'One. '), textPart('p2', 'Two.')],
        [legacyDelta('One.Two.')],
      ],
      [
        'a part-id-less delivery missing persisted trailing whitespace',
        [textPart('part-r2', 'Follow-up answer.\n')],
        [legacyDelta('Follow-up answer.')],
      ],
      [
        'a part-id delivery missing persisted trailing whitespace',
        [textPart('part-r2', 'Follow-up answer.\n')],
        [textDeltaEvent('Follow-up answer.', 'part-r2')],
      ],
      [
        String.raw`a whitespace-only final part that was not delivered (legacy "One." vs "One." + "\n")`,
        [textPart('p1', 'One.'), textPart('p2', '\n')],
        [legacyDelta('One.')],
      ],
      [
        String.raw`a part-id-less delivery with a separator between the parts that the persisted text lacks ("One.\nTwo." vs "One." + "Two.")`,
        [textPart('p1', 'One.'), textPart('p2', 'Two.')],
        [legacyDelta('One.\n'), legacyDelta('Two.')],
      ],
    ])('%s does not cover the reply', async (_label, parts, streamed) => {
      // #given the stream delivered less than the complete persisted text (the persisted side is never trimmed)
      const run = await startFollowUp(parts)
      for (const event of streamed) await run.emit(event)
      await run.emit(idleEvent())

      // #when time passes
      await run.advance(5_000)

      // #then the run is held
      expect(run.outcome()).toBeUndefined()
    })

    it('a part delivered with different text than REST persisted is not equivalent', async () => {
      // #given the stream and REST disagree about the part's wording
      const run = await startFollowUp([textPart('part-r2', 'Final wording.')])
      await run.emit(textDeltaEvent('Draft wording.', 'part-r2'))
      await run.emit(idleEvent())

      // #when time passes
      await run.advance(5_000)

      // #then it is held
      expect(run.outcome()).toBeUndefined()
    })

    it('lost deltas followed by a surviving whole-part update: not delivery evidence, incomplete at the deadline, nothing appended', async () => {
      // #given every delta of the reply was lost, but the whole text part still arrived on message.part.updated
      const run = await startFollowUp([textPart('part-r2', 'Whole-part answer.')], {deadlineMs: 20_000})
      await run.emit({
        type: 'message.part.updated',
        properties: {
          sessionID: ROOT,
          part: {id: 'part-r2', messageID: 'msg-reply-2', sessionID: ROOT, type: 'text', text: 'Whole-part answer.'},
        },
      })

      // #when the root goes idle and time passes up to the deadline
      await run.emit(idleEvent())
      await run.advance(19_000)

      // #then it cannot be told apart from lost deltas: not admitted, and nothing reached the sink
      expect(run.outcome()).toBeUndefined()
      expect(replyOutput(run)).toBe('')

      // #when the deadline passes
      await run.advance(1_500)
      await run.done

      // #then it reports incomplete, with no admission-time append
      expectKind(run.outcome(), 'drain-timeout')
      expect(replyOutput(run)).toBe('')
    })

    it('a whole-part update never completes a partially delivered part-id-less reply', async () => {
      // #given a part-id-less prefix delivered, then the whole part seen on message.part.updated
      const run = await startFollowUp([textPart('part-r2', 'Follow-up answer.')])
      await run.emit(legacyDelta('Follow-up '))
      await run.emit({
        type: 'message.part.updated',
        properties: {
          sessionID: ROOT,
          part: {id: 'part-r2', messageID: 'msg-reply-2', sessionID: ROOT, type: 'text', text: 'Follow-up answer.'},
        },
      })
      await run.emit(idleEvent())

      // #when time passes
      await run.advance(5_000)

      // #then it is held
      expect(run.outcome()).toBeUndefined()
    })

    it('synthetic and ignored parts are not required to have been delivered', async () => {
      // #given an undelivered synthetic part and an undelivered ignored part beside the real, delivered one
      const run = await startFollowUp([
        textPart('part-synth', '<task id="sess-child-1" state="completed">', {synthetic: true}),
        textPart('part-ignored', 'ignored text', {ignored: true}),
        textPart('part-r2', 'Real answer.'),
      ])
      await run.emit(textDeltaEvent('Real answer.', 'part-r2'))

      // #when the root goes idle
      await run.emit(idleEvent())
      await run.done

      // #then only the real part was required; notice text never reached the sink
      expect(run.outcome()).toEqual({ok: true})
      expect(replyOutput(run)).toBe('Real answer.')
    })

    it("an earlier turn's undelivered text is not this fence's business", async () => {
      // #given the prompt turn's own reply carries text the stream never delivered
      const run = await startFollowUp([textPart('part-r2', 'Follow-up answer.')], {
        earlierReply: assistantReply('msg-reply-1', 'msg-prompt', {
          parts: [textPart('part-first', 'Earlier turn text.')],
        }),
      })
      await run.emit(textDeltaEvent('Follow-up answer.', 'part-r2'))

      // #when the root goes idle
      await run.emit(idleEvent())
      await run.done

      // #then the follow-up alone decided it
      expect(run.outcome()).toEqual({ok: true})
    })

    it("only ROOT text counts: a descendant streaming the same text does not deliver the root's reply", async () => {
      // #given a descendant that streamed text under the same part id, and no root delivery at all
      const run = await startFollowUp([textPart('part-r2', 'Follow-up answer.')])
      await run.emit(textDeltaEvent('Follow-up answer.', 'part-r2', CHILD))
      await run.emit(idleEvent())

      // #when time passes
      await run.advance(5_000)

      // #then the root's reply is still undelivered
      expect(run.outcome()).toBeUndefined()
    })

    it('rEST lagging behind the stream holds the run, and it retries on the existing cadence until REST catches up', async () => {
      // #given the stream delivered the whole reply, but REST so far persisted only the start of it
      const run = await startFollowUp([textPart('part-r2', 'Follow-up ')])
      await run.emit(textDeltaEvent('Follow-up answer.', 'part-r2'))
      await run.emit(idleEvent())
      await run.advance(3_000)
      expect(run.outcome()).toBeUndefined()

      // #when REST catches up
      run.fixture.root = async () => ({
        data: [
          PROMPT,
          FIRST_REPLY,
          userMessage('msg-n1', [{id: CHILD}]),
          assistantReply('msg-reply-2', 'msg-n1', {parts: [textPart('part-r2', 'Follow-up answer.')]}),
        ],
        error: null,
      })
      await run.advance(1_000)
      await run.done

      // #then the next retry admits it, with the text in the sink once
      expect(run.outcome()).toEqual({ok: true})
      expect(replyOutput(run)).toBe('Follow-up answer.')
    })
  })

  describe('19. in-flight validation is invalidated by each root activity trigger on its own', () => {
    const rootMessageUpdated = (): object => ({
      type: 'message.updated',
      properties: {info: {id: 'msg-x', role: 'assistant', sessionID: ROOT}},
    })

    /** A validation held in flight with fully admissible data; `trigger` then fires, a fresh idle stamps, and the response lands. */
    async function raceTrigger(trigger: object) {
      const run = startRun()
      const first = deferred<unknown>()
      const second = deferred<unknown>()
      const full = {data: [...completedTurns(CHILD)], error: null}
      let calls = 0
      run.fixture.root = async () => {
        calls += 1
        if (calls === 1) return first.promise
        if (calls === 2) return second.promise
        return full
      }
      await run.emit(dispatchEvent(CHILD))
      await run.emit(noticeEvent(CHILD))
      await run.emit(idleEvent())
      expect(calls).toBe(1)
      await run.emit(trigger)
      await run.emit(idleEvent())
      first.resolve(full)
      await vi.advanceTimersByTimeAsync(1)
      return {run, second, full, calls: () => calls}
    }

    it.each([
      ['root message.updated (assistant)', rootMessageUpdated()],
      ['root session.status retry', statusEvent('retry')],
      ['root session.status busy', statusEvent('busy')],
      ['root session.next.text.delta', {type: 'session.next.text.delta', properties: {sessionID: ROOT, delta: 'x'}}],
      [
        'root session.next.tool.called',
        {type: 'session.next.tool.called', properties: {sessionID: ROOT, callID: 'c1', tool: 'bash', input: {}}},
      ],
      [
        'root session.next.tool.success',
        {type: 'session.next.tool.success', properties: {sessionID: ROOT, callID: 'c-unknown'}},
      ],
      ['root message.part.delta', textDeltaEvent('x', 'part-live')],
      ['root tool part update', toolCompletedEvent()],
    ])('%s invalidates the validation that was in flight', async (_label, trigger) => {
      // #given a validation in flight when the trigger and a fresh idle arrive, then its (stale) response
      const {run, second, full, calls} = await raceTrigger(trigger)

      // #then that response is discarded: not admitted, and a fresh validation was requested
      expect(run.outcome()).toBeUndefined()
      expect(calls()).toBe(2)

      // #when the fresh validation answers
      second.resolve(full)
      await run.done

      // #then the run completes only now
      expect(run.outcome()).toEqual({ok: true})
    })

    it.each([
      [
        'a descendant message.updated',
        {type: 'message.updated', properties: {info: {id: 'msg-c', role: 'assistant', sessionID: CHILD}}},
      ],
      ['a descendant busy status', statusEvent('busy', CHILD)],
      ['a descendant text delta', textDeltaEvent('child output', 'part-child', CHILD)],
      ['a root idle status (not a busy/retry)', statusEvent('idle')],
    ])('%s does not invalidate it', async (_label, event) => {
      // #given a validation in flight when only non-root-activity events arrive
      const {run} = await raceTrigger(event)
      await run.done

      // #then the first response was admissible and admitted
      expect(run.outcome()).toEqual({ok: true})
    })
  })

  describe('20. things that are not notices never count toward the fence', () => {
    const noticeText = '<task id="sess-child-1" state="completed">\n<summary>done</summary>\n</task>'
    const runningText = '<task id="sess-child-1" state="running">\n<summary>started</summary>\n</task>'
    const messagePart = (part: object): object => ({
      type: 'message.part.updated',
      properties: {sessionID: ROOT, part: {id: 'part-n1', messageID: 'msg-n1', sessionID: ROOT, ...part}},
    })

    it.each([
      ['non-synthetic text containing the marker', {type: 'text', text: noticeText}],
      ['non-synthetic text with synthetic explicitly false', {type: 'text', synthetic: false, text: noticeText}],
      ['a running-state task tag', {type: 'text', synthetic: true, text: runningText}],
      ['a non-text part carrying the marker', {type: 'reasoning', synthetic: true, text: noticeText}],
      ['a tool part carrying the marker', {type: 'tool', synthetic: true, text: noticeText}],
    ])(
      '%s: no notice is recorded, on the stream or over REST, so the run waits for the deadline',
      async (_label, part) => {
        // #given a settled child whose only "notice" candidates are the negatives, on the stream AND persisted,
        // with a latest user message that is answered and a root that is not live
        const run = startRun({deadlineMs: 20_000})
        run.fixture.root = async () => ({
          data: [
            PROMPT,
            FIRST_REPLY,
            {info: {id: 'msg-n1', role: 'user', sessionID: ROOT}, parts: [{id: 'part-n1', ...part}]},
            assistantReply('msg-reply-2', 'msg-n1'),
          ],
          error: null,
        })

        // #when the stream delivers it and the root goes idle
        await run.emit(dispatchEvent(CHILD))
        await run.emit(messagePart(part))
        await run.emit(idleEvent())
        await run.advance(19_000)

        // #then it is still waiting: the fence was never satisfied
        expect(run.outcome()).toBeUndefined()

        // #when the deadline passes
        await run.advance(1_500)
        await run.done

        // #then it reports incomplete rather than success
        expectKind(run.outcome(), 'drain-timeout')
      },
    )
  })

  describe('21. a background task that reuses a settled child session is a NEW dispatch (#1753)', () => {
    // Upstream (tool/task.ts @ v1.18.34): `task_id` resumes the session (`sessions.get`, :136-138); the job id is the
    // session id; `background.extend` (:267) only succeeds while the job is RUNNING (core background-job.ts:264)
    // and renders "Background task updated" with no new notify; otherwise `background.start` (:284) creates a NEW
    // job under the same id (core :213-214 refuses only a running one), notifies (:317) and renders "started".

    /** A completed background `task` tool part, with the part identity that tells one dispatch from a replay. */
    const taskPart = (jobId: string, partID: string, kind: 'started' | 'updated' = 'started'): object => ({
      type: 'message.part.updated',
      properties: {
        sessionID: ROOT,
        part: {
          id: partID,
          type: 'tool',
          tool: 'task',
          sessionID: ROOT,
          state: {
            status: 'completed',
            title: 'background task',
            output: `<task id="${jobId}" state="running">\n<summary>Background task ${kind}</summary>\n</task>`,
            metadata: {background: true, jobId},
          },
        },
      },
    })

    /** The notice for dispatch `n`, with the same message/part ids the persisted copy carries. */
    const noticeN = (n: number, childId = CHILD): object =>
      noticeEvent(childId, {messageID: `msg-n${n}`, partID: `msg-n${n}-part-0`})

    /** Persisted root turns: the prompt answered, then `n` injected notices for CHILD, each answered. */
    const turnsWithNotices = (n: number): readonly object[] => [
      PROMPT,
      FIRST_REPLY,
      ...Array.from({length: n}, (_, index) => [
        userMessage(`msg-n${index + 1}`, [{id: CHILD}]),
        assistantReply(`msg-reply-${index + 2}`, `msg-n${index + 1}`),
      ]).flat(),
    ]

    const stateOf = (run: Run, id: string) =>
      run.ownershipLedger?.snapshot().find(entry => entry.sessionId === id)?.state

    /** Dispatch 1, the root idle that begins the drain, and the child finishing: the ledger settles, no notice yet. */
    async function firstDispatchSettled(options: RunOptions = {}) {
      const run = startRun({deadlineMs: 120_000, live: [CHILD], ...options})
      await run.emit(taskPart(CHILD, 'tool-1'))
      await run.emit(idleEvent())
      run.live.delete(CHILD)
      await run.emit(idleEvent())
      expect(stateOf(run, CHILD)).toBe('settled')
      return run
    }

    it('1. the second dispatch keeps the run open until its own notice and the parent reply to it are seen', async () => {
      // #given dispatch 1 finished, its notice was injected, and the parent is working on that follow-up
      const run = await firstDispatchSettled()
      run.fixture.root = async () => ({data: [...turnsWithNotices(1)], error: null})
      await run.emit(noticeN(1))
      await run.emit(statusEvent('busy'))

      // #when the parent dispatches the same task_id again, and the child is running again
      run.live.add(CHILD)
      await run.emit(taskPart(CHILD, 'tool-2'))

      // #then the entry is outstanding again, and the first dispatch's notice does not satisfy the run
      expect(stateOf(run, CHILD)).toBe('outstanding')
      await run.emit(idleEvent())
      await run.advance(5_000)
      expect(run.outcome()).toBeUndefined()

      // #when the second dispatch finishes and the ledger settles, but its notice has not been injected yet
      run.live.delete(CHILD)
      await run.emit(idleEvent())
      await run.advance(5_000)
      expect(stateOf(run, CHILD)).toBe('settled')

      // #then the stale first notice must not stand in for it
      expect(run.outcome()).toBeUndefined()

      // #when the second notice is injected, the parent answers it, and goes idle
      run.fixture.root = async () => ({data: [...turnsWithNotices(2)], error: null})
      await run.emit(noticeN(2))
      await run.emit(idleEvent())
      await run.done

      // #then the run completes
      expect(run.outcome()).toEqual({ok: true})
    })

    it("1b. the second dispatch's notice is not enough until the parent has answered it", async () => {
      // #given both dispatches settled with both notices seen, but REST shows the second notice unanswered
      const run = await firstDispatchSettled()
      run.fixture.root = async () => ({
        data: [...turnsWithNotices(1), userMessage('msg-n2', [{id: CHILD}])],
        error: null,
      })
      await run.emit(noticeN(1))
      run.live.add(CHILD)
      await run.emit(taskPart(CHILD, 'tool-2'))
      run.live.delete(CHILD)
      await run.emit(idleEvent())
      await run.emit(noticeN(2))
      await run.emit(idleEvent())

      // #when time passes
      await run.advance(5_000)

      // #then the latest root user message has no reply: held
      expect(run.outcome()).toBeUndefined()

      // #when the parent answers it
      run.fixture.root = async () => ({data: [...turnsWithNotices(2)], error: null})
      await run.advance(1_000)
      await run.done

      // #then it completes
      expect(run.outcome()).toEqual({ok: true})
    })

    it('2. a replayed event for the same dispatch is not a second dispatch', async () => {
      // #given dispatch 1 and 2 (both with their own tool part ids), each event also delivered a second time
      const run = await firstDispatchSettled()
      run.fixture.root = async () => ({data: [...turnsWithNotices(2)], error: null})
      await run.emit(taskPart(CHILD, 'tool-1'))
      await run.emit(noticeN(1))
      run.live.add(CHILD)
      await run.emit(taskPart(CHILD, 'tool-2'))
      await run.emit(taskPart(CHILD, 'tool-2'))
      run.live.delete(CHILD)
      await run.emit(idleEvent())

      // #when the second dispatch's notice arrives (twice), then a late replay of its tool event after it settled
      await run.emit(noticeN(2))
      await run.emit(noticeN(2))
      await run.emit(taskPart(CHILD, 'tool-2'))
      await run.emit(idleEvent())
      await run.done

      // #then two dispatches needed two notices — not three — and the replay did not reopen the settled entry
      expect(run.outcome()).toEqual({ok: true})
      expect(stateOf(run, CHILD)).toBe('settled')
    })

    it('3. cancel evidence from the first dispatch does not exempt the second', async () => {
      // #given dispatch 1 was cancelled (REST shows an aborted child message) and dispatch 2 reused the session
      const run = startRun({deadlineMs: 60_000, live: [CHILD]})
      run.fixture.child = async id => ({data: id === CHILD ? [abortedAssistant] : [], error: null})
      await run.emit(taskPart(CHILD, 'tool-1'))
      await run.emit(taskPart(CHILD, 'tool-2'))
      await run.emit(idleEvent())

      // #when the child stops and the ledger settles, with the root's prompt answered and no notice for either
      run.live.delete(CHILD)
      await run.emit(idleEvent())
      await run.advance(5_000)

      // #then the one aborted message covers one dispatch, not both: held
      expect(stateOf(run, CHILD)).toBe('settled')
      expect(run.outcome()).toBeUndefined()

      // #when the second dispatch is cancelled too (a second aborted message)
      const childPrompt = (id: string) => ({info: {id, role: 'user', sessionID: CHILD}, parts: []})
      run.fixture.child = async id =>
        id === CHILD
          ? {
              data: [
                childPrompt('c-u1'),
                abortedAssistant,
                childPrompt('c-u2'),
                {...abortedAssistant, info: {...abortedAssistant.info, id: 'c-a2'}},
              ],
              error: null,
            }
          : {data: [], error: null}
      await run.advance(1_000)
      await run.done

      // #then each dispatch had its own evidence, and the run completes
      expect(run.outcome()).toEqual({ok: true})
    })

    it('4. reconciliation does not settle the reopened entry while the second dispatch is live', async () => {
      // #given dispatch 1 settled, then a second dispatch reopened the entry and the child is running
      const run = await firstDispatchSettled()
      run.live.add(CHILD)
      await run.emit(taskPart(CHILD, 'tool-2'))
      expect(stateOf(run, CHILD)).toBe('outstanding')

      // #when the reconciler ticks and the root goes idle (both consult the live set)
      await run.advance(DEFAULT_LEDGER_RECONCILE_INTERVAL_MS + 1_000)
      await run.emit(idleEvent())

      // #then it stays outstanding and the run stays open
      expect(stateOf(run, CHILD)).toBe('outstanding')
      expect(run.outcome()).toBeUndefined()

      // #when the child actually stops
      run.live.delete(CHILD)
      await run.advance(DEFAULT_LEDGER_RECONCILE_INTERVAL_MS + 1_000)

      // #then the next pass settles it
      expect(stateOf(run, CHILD)).toBe('settled')
    })

    it('5. extending a still-running job injects no second notice, so it requires none', async () => {
      // #given one dispatch whose job the parent then extended while it was running ("Background task updated")
      const run = startRun({deadlineMs: 60_000, live: [CHILD]})
      run.fixture.root = async () => ({data: [...turnsWithNotices(1)], error: null})
      await run.emit(taskPart(CHILD, 'tool-1'))
      await run.emit(taskPart(CHILD, 'tool-2', 'updated'))
      await run.emit(idleEvent())

      // #when the job finishes and its single notice is injected
      run.live.delete(CHILD)
      await run.emit(noticeN(1))
      await run.emit(idleEvent())
      await run.done

      // #then one notice is enough
      expect(run.outcome()).toEqual({ok: true})
    })

    it('5b. a run whose background dispatches never reuse a session behaves as before', async () => {
      // #given two different children, one notice each
      const run = startRun({deadlineMs: 60_000})
      run.fixture.root = async () => ({
        data: [
          PROMPT,
          FIRST_REPLY,
          userMessage('msg-n1', [{id: CHILD}]),
          userMessage('msg-n2', [{id: CHILD2}]),
          assistantReply('msg-reply-2', 'msg-n2'),
        ],
        error: null,
      })
      await run.emit(taskPart(CHILD, 'tool-1'))
      await run.emit(taskPart(CHILD2, 'tool-2'))
      await run.emit(noticeEvent(CHILD, {messageID: 'msg-n1', partID: 'msg-n1-part-0'}))
      await run.emit(noticeEvent(CHILD2, {messageID: 'msg-n2', partID: 'msg-n2-part-0'}))

      // #when the root goes idle
      await run.emit(idleEvent())
      await run.done

      // #then it completes
      expect(run.outcome()).toEqual({ok: true})
    })

    it('6. a second notice the stream missed but REST persisted still counts', async () => {
      // #given both dispatches settled; only the first notice arrived over the stream
      const run = await firstDispatchSettled()
      run.fixture.root = async () => ({data: [...turnsWithNotices(2)], error: null})
      await run.emit(noticeN(1))
      run.live.add(CHILD)
      await run.emit(taskPart(CHILD, 'tool-2'))
      run.live.delete(CHILD)

      // #when the root goes idle
      await run.emit(idleEvent())
      await run.done

      // #then REST's persisted second notice satisfied the fence
      expect(run.outcome()).toEqual({ok: true})
    })

    it('7. a dispatch without a tool part identity keeps the old idempotent adoption (never reopens)', async () => {
      // #given dispatch 1 settled, then a completion event with no part id or callID names the same child
      const run = await firstDispatchSettled()
      await run.emit(dispatchEvent(CHILD))

      // #then it cannot be told from a replay, so the settled entry stays settled
      expect(stateOf(run, CHILD)).toBe('settled')
    })

    it('8. reopening an entry reports a change, so persistence hears about it; no-ops stay silent', () => {
      // #given a wrapped ledger with one settled entry
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      ledger.settle(CHILD)
      const onChange = vi.fn()
      const onAdopted = vi.fn()
      const wrapped = wrapLedgerWithHooks(ledger, onChange, onAdopted)

      // #when it is reopened, then reopened again
      wrapped.reopen(CHILD)
      wrapped.reopen(CHILD)

      // #then persistence was told once; the session was already registered with the coordinator
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onAdopted).not.toHaveBeenCalled()
      expect(ledger.snapshot()[0]?.state).toBe('outstanding')
    })
  })
})
