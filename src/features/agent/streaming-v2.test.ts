import {createOwnershipLedger} from '@fro-bot/runtime'
import {
  CHILD_SESSION_ID,
  EXECUTION_STARTED_FRAME,
  EXECUTION_SUCCEEDED_FRAME,
  PARENT_SESSION_ID,
  QUESTION_FORM_CREATED_FRAME,
  QUESTION_FORM_ID,
  REASONING_FRAMES,
  SERVER_CONNECTED_FRAME,
  SESSION_MOVED_FRAME,
  SUBAGENT_BACKGROUND_SUCCESS_FRAME,
  SUBAGENT_NOTICE_ENQUEUED_FRAME,
  TEXT_DELTA_FRAME,
  TEXT_ENDED_FRAME,
  TEXT_SESSION_ID,
} from '@fro-bot/runtime/event-v2-fixtures'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  classifyV2Error,
  createActivityTrackerV2,
  processEventStreamV2,
  type ProcessEventStreamV2Options,
  type RootTerminalV2,
} from './streaming-v2.js'

const consoleMock = vi.hoisted(() => ({outputTextContent: vi.fn(), outputToolExecution: vi.fn()}))
vi.mock('../../shared/console.js', () => consoleMock)

function frame(type: string, data: unknown): {readonly type: string; readonly data: unknown} {
  return {type, data}
}

async function* frames(items: readonly unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item
}

function run(
  items: readonly unknown[],
  overrides: Partial<ProcessEventStreamV2Options> = {},
  sessionId = TEXT_SESSION_ID,
) {
  const tracker = createActivityTrackerV2()
  const logger = createMockLogger()
  const controller = new AbortController()
  const result = processEventStreamV2({
    stream: frames(items),
    sessionId,
    signal: controller.signal,
    logger,
    tracker,
    ...overrides,
  })
  return {result, tracker, logger, controller}
}

/** A run whose stream delivers `items` and then stays open until aborted. */
function openRun(items: readonly unknown[], overrides: Partial<ProcessEventStreamV2Options>, sessionId: string) {
  const controller = new AbortController()
  let delivered!: () => void
  const settled = new Promise<void>(resolve => {
    delivered = resolve
  })
  async function* open(): AsyncGenerator<unknown> {
    for (const item of items) yield item
    delivered()
    await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), {once: true}))
  }
  const result = processEventStreamV2({
    stream: open(),
    sessionId,
    signal: controller.signal,
    logger: createMockLogger(),
    tracker: createActivityTrackerV2(),
    ...overrides,
  })
  return {result, controller, settled}
}

async function* brokenStream(): AsyncGenerator<unknown> {
  yield SERVER_CONNECTED_FRAME
  yield TEXT_ENDED_FRAME
  throw new TypeError('socket closed')
}

describe('processEventStreamV2', () => {
  beforeEach(() => {
    consoleMock.outputTextContent.mockClear()
    consoleMock.outputToolExecution.mockClear()
  })

  it('streams text to the console once per part and never reasoning text', async () => {
    // #given
    const items = [
      SERVER_CONNECTED_FRAME,
      EXECUTION_STARTED_FRAME,
      ...REASONING_FRAMES,
      TEXT_DELTA_FRAME,
      TEXT_ENDED_FRAME,
      EXECUTION_SUCCEEDED_FRAME,
    ]
    const terminals: RootTerminalV2[] = []

    // #when
    const {result, tracker} = run(items, {onRootTerminal: terminal => terminals.push(terminal)})
    await result

    // #then
    expect(consoleMock.outputTextContent.mock.calls).toEqual([['all done']])
    expect(JSON.stringify(consoleMock.outputTextContent.mock.calls)).not.toContain('PRIVATE CHAIN OF THOUGHT')
    expect(terminals).toEqual([{kind: 'succeeded'}])
    expect(tracker.rootTerminal).toEqual({kind: 'succeeded'})
  })

  it('writes text that only arrived as deltas when the stream ends', async () => {
    // #given
    const items = [SERVER_CONNECTED_FRAME, TEXT_DELTA_FRAME]
    const controller = new AbortController()

    // #when
    const {result} = run(items, {signal: controller.signal})
    await result

    // #then
    expect(consoleMock.outputTextContent.mock.calls).toEqual([['all done']])
  })

  it('reports the subscription live on the first server.connected and a replaced stream as a discontinuity', async () => {
    // #given
    const onStreamConnected = vi.fn()

    // #when
    const {result, tracker} = run([SERVER_CONNECTED_FRAME, SERVER_CONNECTED_FRAME], {onStreamConnected})
    const outcome = await result

    // #then
    expect(onStreamConnected).toHaveBeenCalledTimes(1)
    expect(outcome.discontinuity?.message).toContain('replaced')
    expect(tracker.streamBlind).toBe(true)
  })

  it('records a stream that ends on its own as a discontinuity but not an abort or a thrown abort', async () => {
    // #given
    const ended = run([SERVER_CONNECTED_FRAME])
    const aborted = run([SERVER_CONNECTED_FRAME])
    aborted.controller.abort()

    // #when
    const [endedResult, abortedResult] = await Promise.all([ended.result, aborted.result])

    // #then
    expect(endedResult.discontinuity?.message).toBe('Event stream ended unexpectedly')
    expect(abortedResult.discontinuity).toBeUndefined()
  })

  it('records a stream that throws mid-run and keeps what it gathered', async () => {
    // #given
    const tracker = createActivityTrackerV2()

    // #when
    const outcome = await processEventStreamV2({
      stream: brokenStream(),
      sessionId: TEXT_SESSION_ID,
      signal: new AbortController().signal,
      logger: createMockLogger(),
      tracker,
    })

    // #then
    expect(outcome.discontinuity).toEqual({message: 'socket closed', errorName: 'TypeError'})
    expect(consoleMock.outputTextContent.mock.calls).toEqual([['all done']])
  })

  it('clears the root result when a new turn starts, so an earlier success cannot release the run', async () => {
    // #given
    const items = [EXECUTION_SUCCEEDED_FRAME, EXECUTION_STARTED_FRAME]

    // #when
    const {result, tracker} = run(items)
    await result

    // #then
    expect(tracker.rootTerminal).toBeNull()
    expect(tracker.rootExecutionStarted).toBe(true)
  })

  it('ignores the terminal events of a child as the root result', async () => {
    // #given
    const items = [frame('session.execution.succeeded', {sessionID: CHILD_SESSION_ID})]

    // #when
    const {result, tracker} = run(items, {}, PARENT_SESSION_ID)
    await result

    // #then
    expect(tracker.rootTerminal).toBeNull()
  })

  describe('permissions', () => {
    it('rejects an ask through the responder and keeps consuming', async () => {
      // #given
      const onPermissionAsked = vi.fn().mockResolvedValue(undefined)
      const items = [
        frame('permission.asked', {
          id: 'per_1',
          sessionID: TEXT_SESSION_ID,
          action: 'external_directory',
          resources: ['/etc/passwd'],
        }),
        EXECUTION_SUCCEEDED_FRAME,
      ]

      // #when
      const {result, tracker} = run(items, {onPermissionAsked})
      await result

      // #then
      expect(onPermissionAsked).toHaveBeenCalledWith({
        requestId: 'per_1',
        sessionId: TEXT_SESSION_ID,
        action: 'external_directory',
        resources: ['/etc/passwd'],
      })
      expect(tracker.rootTerminal).toEqual({kind: 'succeeded'})
    })

    it('rejects an ask from a session it does not track, since the Action owns the server', async () => {
      // #given
      const onPermissionAsked = vi.fn().mockResolvedValue(undefined)
      const items = [frame('permission.asked', {id: 'per_2', sessionID: 'ses_stranger', action: 'edit', resources: []})]

      // #when
      await run(items, {onPermissionAsked}).result

      // #then
      expect(onPermissionAsked).toHaveBeenCalledWith(expect.objectContaining({sessionId: 'ses_stranger'}))
    })

    it('logs a reply that fails and carries on without failing the run', async () => {
      // #given
      const onPermissionAsked = vi.fn().mockRejectedValue(new Error('reply timed out'))
      const items = [
        frame('permission.asked', {id: 'per_3', sessionID: TEXT_SESSION_ID, action: 'edit', resources: []}),
        EXECUTION_SUCCEEDED_FRAME,
      ]

      // #when
      const {result, tracker, logger} = run(items, {onPermissionAsked})
      await result
      await Promise.resolve()

      // #then
      expect(tracker.rootTerminal).toEqual({kind: 'succeeded'})
      expect(logger.warning).toHaveBeenCalledWith(
        'Failed to reject OpenCode V2 permission request',
        expect.objectContaining({error: 'reply timed out'}),
      )
    })
  })

  describe('forms', () => {
    it('cancels a question form at once and the run continues', async () => {
      // #given
      const onFormAsked = vi.fn().mockResolvedValue(undefined)
      const items = [QUESTION_FORM_CREATED_FRAME, EXECUTION_SUCCEEDED_FRAME]

      // #when
      const {result, tracker} = run(items, {onFormAsked}, TEXT_SESSION_ID)
      await result

      // #then
      expect(onFormAsked).toHaveBeenCalledWith({formId: QUESTION_FORM_ID, sessionId: expect.any(String) as string})
      expect(tracker.rootTerminal).toEqual({kind: 'succeeded'})
    })

    it('logs a cancel that fails and the run continues', async () => {
      // #given
      const onFormAsked = vi.fn().mockRejectedValue(new Error('cancel refused'))
      const items = [QUESTION_FORM_CREATED_FRAME, EXECUTION_SUCCEEDED_FRAME]

      // #when
      const {result, tracker, logger} = run(items, {onFormAsked})
      await result
      await Promise.resolve()

      // #then
      expect(tracker.rootTerminal).toEqual({kind: 'succeeded'})
      expect(tracker.terminalProviderError).toBeUndefined()
      expect(logger.warning).toHaveBeenCalledWith(
        'Failed to cancel OpenCode V2 form; the run continues',
        expect.objectContaining({error: 'cancel refused'}),
      )
    })
  })

  describe('failures', () => {
    it('classifies a failed root execution and records it as the terminal failure', async () => {
      // #given
      const items = [
        frame('session.execution.failed', {
          sessionID: TEXT_SESSION_ID,
          error: {type: 'provider.auth', message: 'bad key sk-secret', status: 401},
        }),
      ]

      // #when
      const {result, tracker} = run(items)
      const outcome = await result

      // #then
      expect(tracker.rootTerminal).toEqual({kind: 'failed'})
      expect(tracker.terminalProviderError?.type).toBe('provider_auth_error')
      expect(outcome.llmError?.type).toBe('provider_auth_error')
      expect(JSON.stringify(outcome.llmError)).not.toContain('sk-secret')
    })

    it('records an interrupted root turn with its reason', async () => {
      // #given
      const items = [frame('session.execution.interrupted', {sessionID: TEXT_SESSION_ID, reason: 'shutdown'})]

      // #when
      const {result, tracker} = run(items)
      await result

      // #then
      expect(tracker.rootTerminal).toEqual({kind: 'interrupted', reason: 'shutdown'})
    })

    it('treats a provider retry as activity, not a failure', async () => {
      // #given
      const items = [
        frame('session.retry.scheduled', {
          sessionID: TEXT_SESSION_ID,
          attempt: 1,
          at: 1,
          error: {type: 'provider.rate-limit', message: 'slow', status: 429},
        }),
      ]

      // #when
      const {result, tracker} = run(items)
      await result

      // #then
      expect(tracker.rootTerminal).toBeNull()
      expect(tracker.terminalProviderError).toBeUndefined()
      expect(tracker.firstMeaningfulEventReceived).toBe(true)
    })

    it('fails the run and asks for the session to stop when an owned session moves', async () => {
      // #given
      const onFatal = vi.fn()
      const items = [SESSION_MOVED_FRAME]
      const moved = (SESSION_MOVED_FRAME.data as {sessionID: string}).sessionID

      // #when
      const {result, tracker} = run(items, {onFatal}, moved)
      await result

      // #then
      expect(onFatal).toHaveBeenCalledWith('session_moved')
      expect(tracker.rootTerminal).toEqual({kind: 'failed'})
      expect(tracker.terminalProviderError?.retryable).toBe(false)
    })
  })

  describe('ownership and artifacts', () => {
    it('adopts a background child from its dispatch and settles it from the notice', async () => {
      // #given
      const ledger = createOwnershipLedger()
      const items = [
        frame('session.tool.input.started', {
          sessionID: PARENT_SESSION_ID,
          id: 'call_16_0',
          assistantMessageID: 'msg_x',
          name: 'subagent',
        }),
        SUBAGENT_BACKGROUND_SUCCESS_FRAME,
      ]

      // #when — the stream stays open until aborted, so the loss of the stream does not mark the entry unknown
      const open = openRun([...items, SUBAGENT_NOTICE_ENQUEUED_FRAME], {ownershipLedger: ledger}, PARENT_SESSION_ID)
      await open.settled
      open.controller.abort()
      await open.result

      // #then
      expect(ledger.isTracked(CHILD_SESSION_ID)).toBe(true)
      expect(ledger.snapshot().map(entry => entry.state)).toEqual(['settled'])
    })

    it('marks outstanding owned work unknown when the stream is lost', async () => {
      // #given
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD_SESSION_ID, 'child')

      // #when
      await run([SERVER_CONNECTED_FRAME], {ownershipLedger: ledger}, PARENT_SESSION_ID).result

      // #then
      expect(ledger.unknown()).toBe(1)
    })

    it('detects a pull request URL from a shell call', async () => {
      // #given
      const items = [
        frame('session.tool.input.started', {sessionID: TEXT_SESSION_ID, id: 'c1', name: 'shell'}),
        frame('session.tool.called', {
          sessionID: TEXT_SESSION_ID,
          id: 'c1',
          input: {command: 'gh pr create --title t'},
        }),
        frame('session.tool.success', {
          sessionID: TEXT_SESSION_ID,
          id: 'c1',
          content: [{type: 'text', text: 'https://github.com/fro-bot/agent/pull/42'}],
          metadata: {},
        }),
      ]

      // #when
      const outcome = await run(items).result

      // #then
      expect(outcome.prsCreated).toEqual(['https://github.com/fro-bot/agent/pull/42'])
      expect(consoleMock.outputToolExecution).toHaveBeenCalledWith('shell', 'gh pr create --title t')
    })
  })
})

describe('classifyV2Error', () => {
  const base = {status: null, retryAfterMs: null} as const

  it('maps the V2 error families to the Action failure classes', () => {
    // #given / #when / #then
    expect(classifyV2Error({...base, type: 'provider.auth', message: 'x'}, null)).toMatchObject({
      terminal: true,
      error: {type: 'provider_auth_error'},
    })
    for (const type of ['provider.quota', 'provider.free-limit', 'provider.budget-limit']) {
      expect(classifyV2Error({...base, type, message: 'x'}, null)).toMatchObject({
        terminal: true,
        error: {type: 'quota_exceeded'},
      })
    }
    expect(classifyV2Error({...base, type: 'provider.transport', message: 'x'}, null)).toMatchObject({
      terminal: false,
      error: {type: 'llm_fetch_error', retryable: true},
    })
    expect(
      classifyV2Error({...base, type: 'provider.rate-limit', status: 429, message: 'x'}, null).error.retryable,
    ).toBe(true)
    expect(classifyV2Error({...base, type: 'provider.invalid-request', message: 'x'}, null).error.retryable).toBe(false)
  })

  it('never echoes the upstream message into the label detail', () => {
    // #given / #when
    const observed = classifyV2Error({...base, type: 'provider.invalid-request', message: 'secret-body'}, null)

    // #then
    expect(JSON.stringify(observed.error)).not.toContain('secret-body')
  })
})
