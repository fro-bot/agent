import type {V2FormField} from '@fro-bot/runtime'
import type {QuestionCoordinator} from '../approvals/question-coordinator.js'
import type {FormDirectoryV2} from './question-client-v2.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  awaitLaunchWorkRun,
  buildMockRunState,
  makeBinding,
  makeDeps,
  makeInMemoryRequest,
  makeMessage,
  makeThread,
  mockRunOpenCodeCoreV2,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import {createQuestionRegistry} from '../approvals/question-registry.js'
import {createRequestGate} from '../approvals/request-gate.js'
import {abortRegistry} from './abort-registry.js'
import * as attachModule from './opencode-attach-v2.js'
import * as runCoreModule from './run-core-shared.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// Question bridging — run.ts wiring: the shared gate reaches the run, the
// effects answer the run's forms on its V2 client, and pending questions are
// rejected at teardown.
// ---------------------------------------------------------------------------

const ANY_SIGNAL: unknown = expect.any(AbortSignal)
const ANY_STRING: unknown = expect.any(String)
const ANY_FUNCTION: unknown = expect.any(Function)
const ANY_SINK: unknown = expect.objectContaining({send: ANY_FUNCTION})

const WIRE_RUN_ID = 'question-run-id-1'
const SECRET_TEXT = 'S3CRET-HOOK-ERROR'

/** The run's V2 client: a question is a form, answered with `replyForm` and dismissed with `cancelForm`. */
function makeV2Client() {
  const reply = vi.fn().mockResolvedValue({success: true as const, data: undefined})
  const reject = vi.fn().mockResolvedValue({success: true as const, data: undefined})
  vi.mocked(attachModule.attachOpencodeV2).mockReturnValue({
    replyForm: reply,
    cancelForm: reject,
  } as unknown as ReturnType<typeof attachModule.attachOpencodeV2>)
  return {reply, reject}
}

function makeQuestionDeps() {
  const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
  const requestGate = createRequestGate({logger})
  const questionRegistry = createQuestionRegistry({logger, gate: requestGate})
  return {logger, requestGate, questionRegistry, deps: makeDeps({logger, questionRegistry, requestGate})}
}

const ASKED = {
  requestID: 'que_1',
  sessionID: 'sess-1',
  questions: [{question: 'Which environment?', header: 'Env', options: [], multiple: false, custom: true}],
} as const

const ASKED_FIELDS: readonly V2FormField[] = [
  {key: 'q0', type: 'string', title: 'Env', description: 'Which environment?', options: []},
]

/** What the run loop records for an open question form, so the effects can answer it. */
function rememberAsked(forms: FormDirectoryV2 | undefined): void {
  if (forms === undefined) throw new Error('runOpenCodeCoreV2 received no form directory')
  forms.remember('que_1', {sessionId: 'sess-1', fields: ASKED_FIELDS})
}

/** The question coordinator `run.ts` handed to `runOpenCodeCoreV2`. */
function capturedQuestions(): QuestionCoordinator {
  const params = mockRunOpenCodeCoreV2.mock.calls[0]?.[0]
  if (params?.questions === undefined) throw new Error('runOpenCodeCoreV2 received no question coordinator')
  return params.questions
}

/** Ask `ASKED` the way the run loop does: record its form, then hand it to the coordinator. */
async function ask(asked: Parameters<QuestionCoordinator['onAsked']>[0] = ASKED) {
  rememberAsked(mockRunOpenCodeCoreV2.mock.calls[0]?.[0]?.forms)
  return capturedQuestions().onAsked(asked)
}

describe('run question wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    abortRegistry.delete(WIRE_RUN_ID)
  })

  it('passes the question coordinator and the gate subscription to runOpenCodeCoreV2', async () => {
    // #given deps carrying the shared registry and gate
    const {runMention} = await import('./run.js')
    setupHappyPath()
    makeV2Client()
    const {deps, requestGate} = makeQuestionDeps()

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then
    const params = mockRunOpenCodeCoreV2.mock.calls[0]?.[0]
    expect(params?.questions).toBeDefined()
    expect(params?.onHumanWaitTerminal).toBe(requestGate.onTerminal)
  })

  it('without a question registry the run hands run-core no question handler (dependency-gated)', async () => {
    // #given deps without the question wiring
    const {runMention} = await import('./run.js')
    setupHappyPath()

    // #when
    await runMention(makeMessage(), makeBinding(), makeDeps())

    // #then
    const params = mockRunOpenCodeCoreV2.mock.calls[0]?.[0]
    expect(params?.questions).toBeUndefined()
    expect(params?.onHumanWaitTerminal).toBeUndefined()
  })

  it('attaches the V2 client with the workspace URL and bearer token', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    makeV2Client()
    const {deps} = makeQuestionDeps()

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then
    expect(attachModule.attachOpencodeV2).toHaveBeenCalledExactlyOnceWith(
      'http://workspace:9200',
      'secret-bearer-token',
    )
  })

  it('effects: skip replies to the form with no answers', async () => {
    // #given a question registered through the run's coordinator
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {reply} = makeV2Client()
    const thread = makeThread()
    const {deps, questionRegistry} = makeQuestionDeps()
    await runMention(makeMessage(thread), makeBinding(), deps)
    await expect(ask()).resolves.toBe('registered')

    // #when an operator skips it
    const outcome = await questionRegistry.decide({
      requestID: 'que_1',
      scopeId: thread.id,
      decision: {kind: 'skip'},
      actor: {kind: 'discord-user', userId: 'user-1'},
    })

    // #then the reply carries the asking session, the form id and an empty answer
    expect(outcome).toEqual({kind: 'ok'})
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({sessionId: 'sess-1', formId: 'que_1', answer: {}, signal: ANY_SIGNAL}),
    )
  })

  it('effects: a Discord run binds the question to its thread; the answer reaches the form', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {reply} = makeV2Client()
    const thread = makeThread()
    const {deps, questionRegistry} = makeQuestionDeps()
    await runMention(makeMessage(thread), makeBinding(), deps)
    await ask({
      ...ASKED,
      questions: [
        {question: 'Pick', header: 'P', options: [{label: 'a', description: ''}], multiple: false, custom: false},
      ],
    })

    // #then the pending question is scoped to the thread
    expect(questionRegistry.describePendingForScope(thread.id).map(dto => dto.requestID)).toEqual(['que_1'])

    // #when answered
    await questionRegistry.decide({
      requestID: 'que_1',
      scopeId: thread.id,
      decision: {kind: 'answer', answers: [['a']]},
      actor: {kind: 'discord-user', userId: 'user-1'},
    })

    // #then
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({sessionId: 'sess-1', formId: 'que_1', answer: {q0: 'a'}}),
    )
  })

  it('effects: a failed form reply is an error result, never a throw', async () => {
    // #given the reply fails
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {reply} = makeV2Client()
    reply.mockResolvedValue({success: false as const, error: {kind: 'http', status: 404}})
    const thread = makeThread()
    const {deps, questionRegistry, logger} = makeQuestionDeps()
    await runMention(makeMessage(thread), makeBinding(), deps)
    await ask()

    // #when
    const outcome = await questionRegistry.decide({
      requestID: 'que_1',
      scopeId: thread.id,
      decision: {kind: 'skip'},
      actor: {kind: 'discord-user', userId: 'user-1'},
    })

    // #then the gate sees a failed reply (claim released), and no response text reached the logs
    expect(outcome).toEqual({kind: 'reply-failed'})
    expect(questionRegistry.describePendingForScope(thread.id)).toHaveLength(1)
    expect(JSON.stringify(logger.error.mock.calls) + JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'secret answer text',
    )
  })

  it('teardown after the run loop throws cancels the pending question’s form', async () => {
    // #given a question registered during a run that then fails
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {reject, reply} = makeV2Client()
    const {deps, questionRegistry} = makeQuestionDeps()
    mockRunOpenCodeCoreV2.mockImplementation(async params => {
      rememberAsked(params.forms)
      await params.questions?.onAsked(ASKED)
      throw new runCoreModule.RunCoreError('timeout', 'boom')
    })

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then the question was rejected (ending the turn), not skipped, and left the registry
    expect(reject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({sessionId: 'sess-1', formId: 'que_1', signal: ANY_SIGNAL}),
    )
    expect(reply).not.toHaveBeenCalled()
    expect(questionRegistry.pending()).toEqual([])
  })

  it('teardown after a normal finish also rejects a question still pending', async () => {
    // #given
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {reject} = makeV2Client()
    const {deps, questionRegistry} = makeQuestionDeps()
    mockRunOpenCodeCoreV2.mockImplementation(async params => {
      rememberAsked(params.forms)
      await params.questions?.onAsked(ASKED)
    })

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then
    expect(reject).toHaveBeenCalledOnce()
    expect(questionRegistry.pending()).toEqual([])
  })

  it('operator cancel with a question pending: the question is rejected and the run settles CANCELLED', async () => {
    // #given a cancel that fires while a question is pending
    const {launchWork} = await import('./run.js')
    setupHappyPath()
    const {reject} = makeV2Client()
    const cancelledState = buildMockRunState({phase: 'CANCELLED', run_id: WIRE_RUN_ID})
    mockRuntime.transitionRun.mockResolvedValue({
      success: true as const,
      data: {etag: 'etag-x', state: cancelledState},
    })
    mockRunOpenCodeCoreV2.mockImplementation(async params => {
      rememberAsked(params.forms)
      await params.questions?.onAsked(ASKED)
      abortRegistry.abort(WIRE_RUN_ID, 'operator cancel', {
        kind: 'web-operator',
        githubUserId: 42,
        login: 'octocat',
        sessionCorrelationId: 'sess-1',
        cancelledAt: '2026-07-03T00:00:00.000Z',
      })
      throw new runCoreModule.RunCoreError('timeout', 'run-core: signal aborted')
    })
    const request = makeInMemoryRequest()
    ;(request as {runId?: string}).runId = WIRE_RUN_ID
    const {deps, questionRegistry} = makeQuestionDeps()

    // #when
    await awaitLaunchWorkRun(launchWork, request, deps)

    // #then
    expect(reject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({sessionId: 'sess-1', formId: 'que_1'}))
    expect(questionRegistry.pending()).toEqual([])
    const phases = mockRuntime.transitionRun.mock.calls.map((call: unknown[]) => call[4] as string)
    expect(phases).toContain('CANCELLED')
    expect(phases).not.toContain('FAILED')
  })

  it('announces a registered question through the injected hook with the run identity, after registration', async () => {
    // #given deps whose hook records whether the registry already held the question when it ran
    const {runMention} = await import('./run.js')
    setupHappyPath()
    makeV2Client()
    const {deps, questionRegistry} = makeQuestionDeps()
    const heldWhenAnnounced: boolean[] = []
    const announce = vi.fn((request: {readonly requestID: string}) => {
      heldWhenAnnounced.push(questionRegistry.has(request.requestID))
    })
    const createQuestionOnRegistered = vi.fn(() => announce)
    await runMention(makeMessage(), makeBinding(), {...deps, createQuestionOnRegistered})

    // #when the run's coordinator registers a question
    await ask()

    // #then the hook was built once with the run's id and repo, and ran after registration
    expect(createQuestionOnRegistered).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: ANY_STRING,
        repo: 'acme/widget',
        surface: 'discord',
        replySink: ANY_SINK,
      }),
    )
    expect(announce).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({requestID: 'que_1'}))
    expect(heldWhenAnnounced).toEqual([true])

    // #and the registry binds the question to that same run, so web routes can find it
    const builtFor = createQuestionOnRegistered.mock.calls[0] as unknown as [{runId: string}]
    expect(questionRegistry.describePendingForRun(builtFor[0].runId).map(dto => dto.requestID)).toEqual(['que_1'])
  })

  it('a throwing announce hook never changes the ask outcome; the question stays registered', async () => {
    // #given a hook that throws
    const {runMention} = await import('./run.js')
    setupHappyPath()
    makeV2Client()
    const {deps, questionRegistry, logger} = makeQuestionDeps()
    const createQuestionOnRegistered = vi.fn(() => () => {
      throw new Error(SECRET_TEXT)
    })
    await runMention(makeMessage(), makeBinding(), {...deps, createQuestionOnRegistered})

    // #when
    const outcome = await ask()

    // #then still registered, and the log carries no error text
    expect(outcome).toBe('registered')
    expect(questionRegistry.has('que_1')).toBe(true)
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET_TEXT)
  })

  it('nudges operators by push once per registered question with the run id only', async () => {
    // #given a push dispatcher
    const {runMention} = await import('./run.js')
    setupHappyPath()
    makeV2Client()
    const {deps} = makeQuestionDeps()
    const dispatchQuestionPending = vi.fn().mockResolvedValue(undefined)
    const operatorPushDispatcher = {
      dispatchApprovalPending: vi.fn().mockResolvedValue(undefined),
      dispatchQuestionPending,
      dispatchRunFailed: vi.fn().mockResolvedValue(undefined),
    }
    await runMention(makeMessage(), makeBinding(), {...deps, operatorPushDispatcher})

    // #when a question registers, then the same id is asked again
    await ask()
    await ask()

    // #then one push, carrying only the run id — never the request id or any text
    expect(dispatchQuestionPending).toHaveBeenCalledExactlyOnceWith(expect.any(String))
    expect(JSON.stringify(dispatchQuestionPending.mock.calls)).not.toContain('Which environment?')
    expect(JSON.stringify(dispatchQuestionPending.mock.calls)).not.toContain('que_1')
    expect(operatorPushDispatcher.dispatchApprovalPending).not.toHaveBeenCalled()
  })

  it('a question skipped for lack of budget is neither announced nor pushed', async () => {
    // #given a run with no budget for a deadline, a hook, and a push dispatcher
    const {runMention} = await import('./run.js')
    setupHappyPath()
    makeV2Client()
    const {deps} = makeQuestionDeps()
    const announce = vi.fn()
    const dispatchQuestionPending = vi.fn().mockResolvedValue(undefined)
    await runMention(makeMessage(), makeBinding(), {
      ...deps,
      runTimeoutMs: 60_000,
      createQuestionOnRegistered: () => announce,
      operatorPushDispatcher: {
        dispatchApprovalPending: vi.fn().mockResolvedValue(undefined),
        dispatchQuestionPending,
        dispatchRunFailed: vi.fn().mockResolvedValue(undefined),
      },
    })

    // #when
    const outcome = await ask()

    // #then no human wait begins, so no announcement and no nudge
    expect(outcome).toBe('skipped')
    expect(announce).not.toHaveBeenCalled()
    expect(dispatchQuestionPending).not.toHaveBeenCalled()
  })

  it('a rejecting push dispatcher never affects the ask', async () => {
    // #given a dispatcher whose promise rejects
    const {runMention} = await import('./run.js')
    setupHappyPath()
    makeV2Client()
    const {deps} = makeQuestionDeps()
    await runMention(makeMessage(), makeBinding(), {
      ...deps,
      operatorPushDispatcher: {
        dispatchApprovalPending: vi.fn().mockResolvedValue(undefined),
        dispatchQuestionPending: vi.fn().mockRejectedValue(new Error('push boom')),
        dispatchRunFailed: vi.fn().mockResolvedValue(undefined),
      },
    })

    // #when / #then
    await expect(ask()).resolves.toBe('registered')
  })

  it('computes the question deadline from the budget left when the question is asked', async () => {
    // #given a run whose whole budget is below the deadline floor
    const {runMention} = await import('./run.js')
    setupHappyPath()
    const {reply} = makeV2Client()
    const {deps, questionRegistry} = makeQuestionDeps()
    const shortDeps = {...deps, runTimeoutMs: 60_000}
    await runMention(makeMessage(), makeBinding(), shortDeps)

    // #when a question is asked
    const outcome = await ask()

    // #then it is skipped immediately (empty reply) instead of registered
    expect(outcome).toBe('skipped')
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({sessionId: 'sess-1', formId: 'que_1', answer: {}}),
    )
    expect(questionRegistry.pending()).toEqual([])
  })
})
