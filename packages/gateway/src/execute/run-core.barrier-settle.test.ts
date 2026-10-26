/**
 * Human waits are fail-closed when the termination barrier STARTS, not after it ends.
 *
 * The barrier can take up to 15 s to confirm the root quiescent. Until now a pending approval or question stayed
 * live for that whole window and was only torn down by `run.ts`'s `finally`, so an `always` press inside it could
 * still reach OpenCode and persist a permission rule for a run that had already failed.
 *
 * These tests drive the real `runOpenCodeCore` with the real permission coordinator, question coordinator,
 * registries and request gate. Only OpenCode's reply endpoints and the session calls are doubles.
 */

import type {OpenCodeServerHandle} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {DiscordStreamSink} from '../discord/streaming.js'
import type {RunCoreError} from './run-core.js'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createPermissionCoordinator} from '../approvals/coordinator.js'
import {createQuestionCoordinator} from '../approvals/question-coordinator.js'
import {createQuestionRegistry} from '../approvals/question-registry.js'
import {createApprovalRegistry} from '../approvals/registry.js'
import {createRequestGate} from '../approvals/request-gate.js'
import {runOpenCodeCore} from './run-core.js'

const ROOT = 'sess-123'
const DIRECTORY = '/workspace/repo'
const SCOPE = 'chan-1'
const USER = {kind: 'discord-user', userId: 'user-1'} as const
/** Past the 15 s settle bound, so a barrier whose root never quiesces has concluded. */
const PAST_SETTLE_BOUND_MS = 20_000

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeSink(): DiscordStreamSink {
  return {
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 0}),
    buffered: () => '',
    markVisibleOutputSent: vi.fn(),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
    hasVisibleOutput: vi.fn().mockReturnValue(false),
  }
}

const permissionAsked = (requestID: string): object => ({
  type: 'permission.asked',
  properties: {id: requestID, sessionID: ROOT, permission: 'bash', patterns: [], tool: 'bash'},
})
const questionAsked = (requestID: string): object => ({
  type: 'question.asked',
  properties: {
    id: requestID,
    sessionID: ROOT,
    questions: [{question: 'Which environment?', header: 'Env', options: [{label: 'staging', description: 'Staging'}]}],
  },
})

interface Deferred {
  readonly promise: Promise<void>
  readonly release: () => void
}

function deferred(): Deferred {
  let release: () => void = () => {}
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return {promise, release}
}

type Outcome = {readonly ok: true} | {readonly ok: false; readonly error: RunCoreError}

/**
 * A run with one pending human request, ended by a closed stream. The root never reports quiescent, so the barrier
 * keeps polling until its bound: the window under test.
 */
function startRun(setup: {
  readonly postReply: (requestID: string, directory: string, decision: string) => Promise<{ok: boolean}>
  readonly rejectQuestion: (requestID: string) => Promise<{ok: true} | {ok: false; error: string}>
}) {
  vi.useFakeTimers()
  const logger = makeLogger()
  const gate = createRequestGate({logger})
  const approvals = createApprovalRegistry({logger, gate})
  const questionRegistry = createQuestionRegistry({logger, gate})
  const replyQuestion = vi.fn(async () => ({ok: true as const}))

  const coordinator = createPermissionCoordinator({
    logger,
    onPending: request => {
      approvals.register({
        requestID: request.requestID,
        sessionID: request.sessionID,
        approvalScopeId: SCOPE,
        directory: DIRECTORY,
        request,
        effects: {postReply: setup.postReply},
      })
    },
    onReplied: event => {
      approvals.confirmReply(event)
    },
    onDispose: sessionIDs => {
      // eslint-disable-next-line no-void
      void Promise.all(sessionIDs.map(async id => approvals.disposeRun(id, 'run ended')))
    },
  })
  const questions = createQuestionCoordinator({
    logger,
    registry: questionRegistry,
    effects: {replyQuestion, rejectQuestion: setup.rejectQuestion},
    scopeId: SCOPE,
    computeDeadlineMs: () => 600_000,
  })

  const queue: object[] = []
  let closed = false
  let wake: (() => void) | null = null
  async function* stream(): AsyncGenerator<object> {
    while (true) {
      const next = queue.shift()
      if (next !== undefined) {
        yield next
      } else if (closed) {
        return
      } else {
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    }
  }
  const wakeStream = (): void => {
    const resume = wake
    wake = null
    resume?.()
  }

  const abort = vi.fn(async () => ({data: {}, error: null}))
  const handle = {
    client: {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
        messages: vi.fn().mockResolvedValue({data: [], error: null}),
        promptAsync: vi.fn().mockResolvedValue({data: {}, error: null}),
        children: vi.fn().mockResolvedValue({data: [], error: null}),
        // The root stays busy: the barrier cannot confirm it quiescent and keeps polling until its bound.
        status: vi.fn().mockResolvedValue({data: {[ROOT]: {type: 'busy'}}, error: null}),
        abort,
      },
      event: {subscribe: vi.fn().mockResolvedValue({stream: stream()})},
      postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
    },
    server: {url: 'http://workspace:9200', close: vi.fn()},
    shutdown: vi.fn(),
  } as unknown as OpenCodeServerHandle

  let settled: Outcome | undefined
  // eslint-disable-next-line no-void
  void runOpenCodeCore({
    handle,
    directory: DIRECTORY,
    promptText: 'Fix the bug please',
    sink: makeSink(),
    signal: new AbortController().signal,
    logger,
    coordinator,
    questions,
    onHumanWaitTerminal: gate.onTerminal,
  }).then(
    () => {
      settled = {ok: true}
    },
    (error: unknown) => {
      settled = {ok: false, error: error as RunCoreError}
    },
  )

  return {
    approvals,
    questionRegistry,
    coordinator,
    questions,
    abort,
    replyQuestion,
    outcome: () => settled,
    emit: (event: object) => {
      queue.push(event)
      wakeStream()
    },
    /** The stream ends without the root going idle: a lost stream, which starts the barrier. */
    loseStream: () => {
      closed = true
      wakeStream()
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runOpenCodeCore — the barrier fail-closes pending human waits when it starts', () => {
  it('settles a pending approval before the root abort, and a press during the barrier cannot reach OpenCode', async () => {
    // #given a pending approval, and an OpenCode reply endpoint that is slow to answer the teardown's reject
    const rejectSent = deferred()
    const postReply = vi.fn(async (_requestID: string, _directory: string, _decision: string) => {
      await rejectSent.promise
      return {ok: true}
    })
    const run = startRun({postReply, rejectQuestion: async () => ({ok: true})})
    await vi.advanceTimersByTimeAsync(10)
    run.emit(permissionAsked('perm-1'))
    await vi.advanceTimersByTimeAsync(10)
    expect(run.approvals.has('perm-1')).toBe(true)
    expect(postReply).not.toHaveBeenCalled()

    // #when the stream is lost and the barrier starts, but is still confirming the root
    run.loseStream()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(run.outcome()).toBeUndefined()

    // #then the approval was rejected on the way in, before the root abort went out
    expect(postReply).toHaveBeenCalledExactlyOnceWith('perm-1', DIRECTORY, 'reject')
    const abortOrder = run.abort.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    expect(postReply.mock.invocationCallOrder[0]).toBeLessThan(abortOrder)

    // #and an `always` press inside the window settles nothing and sends nothing to OpenCode
    const duringBarrier = await run.approvals.handleDecision({
      requestID: 'perm-1',
      approvalScopeId: SCOPE,
      decision: 'always',
      actor: USER,
    })
    expect(['already-claimed', 'not-found']).toContain(duringBarrier)
    expect(postReply).toHaveBeenCalledTimes(1)

    // #and once the reject lands, the request is gone
    rejectSent.release()
    await vi.advanceTimersByTimeAsync(10)
    expect(run.approvals.has('perm-1')).toBe(false)
    expect(
      await run.approvals.handleDecision({
        requestID: 'perm-1',
        approvalScopeId: SCOPE,
        decision: 'always',
        actor: USER,
      }),
    ).toBe('not-found')
    expect(postReply).toHaveBeenCalledTimes(1)

    // #and the run still ends as a lost stream once the barrier gives up
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
    const outcome = run.outcome()
    expect(outcome?.ok === false && outcome.error.kind).toBe('stream-ended')
  })

  it('rejects a pending question when the barrier starts, and a skip or answer inside the window sends no reply', async () => {
    // #given a pending question, and an OpenCode reject endpoint that is slow to answer
    const rejectSent = deferred()
    const rejectQuestion = vi.fn(async (_requestID: string) => {
      await rejectSent.promise
      return {ok: true as const}
    })
    const run = startRun({postReply: async () => ({ok: true}), rejectQuestion})
    await vi.advanceTimersByTimeAsync(10)
    run.emit(questionAsked('que-1'))
    await vi.advanceTimersByTimeAsync(10)
    expect(rejectQuestion).not.toHaveBeenCalled()

    // #when the stream is lost and the barrier starts
    run.loseStream()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(run.outcome()).toBeUndefined()

    // #then the question was rejected before the root abort
    expect(rejectQuestion).toHaveBeenCalledExactlyOnceWith('que-1')
    const abortOrder = run.abort.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    expect(rejectQuestion.mock.invocationCallOrder[0]).toBeLessThan(abortOrder)

    // #and a skip pressed inside the window cannot answer it
    const during = await run.questionRegistry.decide({
      requestID: 'que-1',
      scopeId: SCOPE,
      decision: {kind: 'skip'},
      actor: USER,
    })
    expect(['already-claimed', 'not-found']).toContain(during.kind)
    expect(run.replyQuestion).not.toHaveBeenCalled()

    // #and after the reject lands it is gone
    rejectSent.release()
    await vi.advanceTimersByTimeAsync(10)
    const after = await run.questionRegistry.decide({
      requestID: 'que-1',
      scopeId: SCOPE,
      decision: {kind: 'skip'},
      actor: USER,
    })
    expect(after.kind).toBe('not-found')
    expect(run.replyQuestion).not.toHaveBeenCalled()
    expect(rejectQuestion).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
  })

  it("a later dispose by run.ts's finally sends no second reply", async () => {
    // #given an approval and a question, both settled by the barrier
    const postReply = vi.fn(async (_requestID: string, _directory: string, _decision: string) => ({ok: true}))
    const rejectQuestion = vi.fn(async (_requestID: string) => ({ok: true as const}))
    const run = startRun({postReply, rejectQuestion})
    await vi.advanceTimersByTimeAsync(10)
    run.emit(permissionAsked('perm-1'))
    run.emit(questionAsked('que-1'))
    await vi.advanceTimersByTimeAsync(10)
    run.loseStream()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)
    expect(run.outcome()?.ok).toBe(false)
    expect(postReply).toHaveBeenCalledTimes(1)
    expect(rejectQuestion).toHaveBeenCalledTimes(1)

    // #when run.ts's finally disposes both coordinators again
    run.coordinator.dispose('run ended')
    await run.questions.dispose('run ended')
    await vi.advanceTimersByTimeAsync(10)

    // #then nothing more goes to OpenCode
    expect(postReply).toHaveBeenCalledTimes(1)
    expect(rejectQuestion).toHaveBeenCalledTimes(1)
  })

  it('settles pending human waits on every failure the barrier handles, not only a lost stream', async () => {
    // #given a pending approval and a run whose own deadline then fires
    const postReply = vi.fn(async (_requestID: string, _directory: string, _decision: string) => ({ok: true}))
    const controller = new AbortController()
    vi.useFakeTimers()
    const logger = makeLogger()
    const gate = createRequestGate({logger})
    const approvals = createApprovalRegistry({logger, gate})
    const coordinator = createPermissionCoordinator({
      logger,
      onPending: request => {
        approvals.register({
          requestID: request.requestID,
          sessionID: request.sessionID,
          approvalScopeId: SCOPE,
          directory: DIRECTORY,
          request,
          effects: {postReply},
        })
      },
      onDispose: ids => {
        // eslint-disable-next-line no-void
        void Promise.all(ids.map(async id => approvals.disposeRun(id, 'run ended')))
      },
    })
    const queue: object[] = [permissionAsked('perm-9')]
    async function* stream(): AsyncGenerator<object> {
      const first = queue.shift()
      if (first !== undefined) yield first
      await new Promise<void>(() => {})
    }
    const handle = {
      client: {
        session: {
          create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
          messages: vi.fn().mockResolvedValue({data: [], error: null}),
          promptAsync: vi.fn().mockResolvedValue({data: {}, error: null}),
          children: vi.fn().mockResolvedValue({data: [], error: null}),
          status: vi.fn().mockResolvedValue({data: {}, error: null}),
          abort: vi.fn(async () => ({data: {}, error: null})),
        },
        event: {subscribe: vi.fn().mockResolvedValue({stream: stream()})},
        postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
      },
      server: {url: 'http://workspace:9200', close: vi.fn()},
      shutdown: vi.fn(),
    } as unknown as OpenCodeServerHandle
    let settled: Outcome | undefined
    // eslint-disable-next-line no-void
    void runOpenCodeCore({
      handle,
      directory: DIRECTORY,
      promptText: 'Fix the bug please',
      sink: makeSink(),
      signal: controller.signal,
      logger,
      coordinator,
      onHumanWaitTerminal: gate.onTerminal,
    }).then(
      () => {
        settled = {ok: true}
      },
      (error: unknown) => {
        settled = {ok: false, error: error as RunCoreError}
      },
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(approvals.has('perm-9')).toBe(true)

    // #when the wall clock fires
    controller.abort()
    await vi.advanceTimersByTimeAsync(PAST_SETTLE_BOUND_MS)

    // #then the approval was rejected by the barrier, exactly once
    expect(settled?.ok).toBe(false)
    expect(approvals.has('perm-9')).toBe(false)
    expect(postReply).toHaveBeenCalledExactlyOnceWith('perm-9', DIRECTORY, 'reject')
  })
})
