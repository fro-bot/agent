import {createOwnershipLedger, shellLedgerKey} from '@fro-bot/runtime'
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
  SHELL_COMMAND,
  SHELL_CREATED_FRAME,
  SHELL_ID,
  SHELL_NOTICE_ENQUEUED_FRAME,
  SHELL_SESSION_ID,
  SUBAGENT_BACKGROUND_SUCCESS_FRAME,
  SUBAGENT_NOTICE_ENQUEUED_FRAME,
  SUBAGENT_NOTICE_MESSAGE,
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

  describe('ownership through a foreground subagent', () => {
    const MSG = 'msg_foreground_parent'
    const CALL = 'call_fg_1'
    const subagentStarted = frame('session.tool.input.started', {
      sessionID: PARENT_SESSION_ID,
      id: CALL,
      assistantMessageID: MSG,
      name: 'subagent',
    })
    const foregroundProgress = frame('session.tool.progress', {
      sessionID: PARENT_SESSION_ID,
      id: CALL,
      assistantMessageID: MSG,
      metadata: {sessionID: CHILD_SESSION_ID, status: 'running'},
    })
    const foregroundSuccess = frame('session.tool.success', {
      sessionID: PARENT_SESSION_ID,
      id: CALL,
      assistantMessageID: MSG,
      content: [{type: 'text', text: 'done'}],
      metadata: {sessionID: CHILD_SESSION_ID, status: 'completed', truncated: false},
      executed: false,
    })
    const childShellCreated = {
      ...SHELL_CREATED_FRAME,
      data: {info: {...SHELL_CREATED_FRAME.data.info, metadata: {sessionID: CHILD_SESSION_ID}}},
    }
    const childShellNotice = {
      ...SHELL_NOTICE_ENQUEUED_FRAME,
      data: {...SHELL_NOTICE_ENQUEUED_FRAME.data, sessionID: CHILD_SESSION_ID},
    }

    async function stateAfter(items: readonly unknown[]) {
      const ledger = createOwnershipLedger()
      const open = openRun(items, {ownershipLedger: ledger}, PARENT_SESSION_ID)
      await open.settled
      open.controller.abort()
      await open.result
      return Object.fromEntries(ledger.snapshot().map(entry => [entry.sessionId, entry.state]))
    }

    it('adopts the child a foreground call names, owns its background shell, and settles the child at the call end', async () => {
      // #given a foreground child that starts a background shell and returns while the shell still runs
      const state = await stateAfter([subagentStarted, foregroundProgress, childShellCreated, foregroundSuccess])

      // #then the child is settled by its call, and the shell it left behind is still the run's, outstanding
      expect(state).toEqual({[CHILD_SESSION_ID]: 'settled', [`shell:${SHELL_ID}`]: 'outstanding'})
    })

    it("settles that shell from its notice, which is addressed to the child's inbox", async () => {
      // #given / #when
      const state = await stateAfter([
        subagentStarted,
        foregroundProgress,
        childShellCreated,
        foregroundSuccess,
        childShellNotice,
      ])

      // #then
      expect(state).toEqual({[CHILD_SESSION_ID]: 'settled', [`shell:${SHELL_ID}`]: 'settled'})
    })

    it('accounts for events a descendant emitted before the dispatch named it, in their original order', async () => {
      // #given the shell and its notice arrive BEFORE the progress that attributes the child to the run
      const state = await stateAfter([childShellCreated, childShellNotice, subagentStarted, foregroundProgress])

      // #then both were replayed on adoption: the shell was adopted and then settled by its notice
      expect(state).toEqual({[CHILD_SESSION_ID]: 'outstanding', [`shell:${SHELL_ID}`]: 'settled'})
    })

    it('never adopts what a session outside the run tree does', async () => {
      // #given a shell created by a stranger, and a dispatch that names a different child
      const stranger = {
        ...SHELL_CREATED_FRAME,
        data: {info: {...SHELL_CREATED_FRAME.data.info, metadata: {sessionID: SHELL_SESSION_ID}}},
      }

      // #when / #then
      expect(await stateAfter([stranger, subagentStarted, foregroundProgress])).toEqual({
        [CHILD_SESSION_ID]: 'outstanding',
      })
    })

    it('keeps tool names, inputs and shell ids apart when two sessions reuse a call id', async () => {
      // #given the root and a tracked child, each running a backgrounded shell under the SAME call id, interleaved
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD_SESSION_ID, 'child')
      const started = (sessionID: string, assistantMessageID: string) =>
        frame('session.tool.input.started', {sessionID, id: 'call_shared', assistantMessageID, name: 'shell'})
      const succeeded = (sessionID: string, assistantMessageID: string, shellID: string) =>
        frame('session.tool.success', {
          sessionID,
          id: 'call_shared',
          assistantMessageID,
          content: [{type: 'text', text: 'moved to the background'}],
          metadata: {status: 'running', truncated: false, shellID},
          executed: false,
        })
      const items = [
        started(PARENT_SESSION_ID, 'msg_root'),
        started(CHILD_SESSION_ID, 'msg_child'),
        succeeded(PARENT_SESSION_ID, 'msg_root', 'sh_root'),
        succeeded(CHILD_SESSION_ID, 'msg_child', 'sh_child'),
      ]

      // #when
      const open = openRun(items, {ownershipLedger: ledger}, PARENT_SESSION_ID)
      await open.settled
      open.controller.abort()
      await open.result

      // #then both shells were adopted; one call's end did not delete the other's name
      expect(ledger.isTracked(shellLedgerKey('sh_root'))).toBe(true)
      expect(ledger.isTracked(shellLedgerKey('sh_child'))).toBe(true)
    })
  })

  describe('shell logs', () => {
    const CALL = {sessionID: SHELL_SESSION_ID, id: 'call_log', assistantMessageID: 'msg_log'}
    const toolStarted = frame('session.tool.input.started', {...CALL, name: 'shell'})
    const toolSucceeded = (status: 'completed' | 'running') =>
      frame('session.tool.success', {
        ...CALL,
        content: [{type: 'text', text: 'output'}],
        metadata: {status, truncated: false, shellID: SHELL_ID},
        executed: false,
      })

    async function run(items: readonly unknown[]) {
      const ledger = createOwnershipLedger()
      const logger = createMockLogger()
      const open = openRun(items, {ownershipLedger: ledger, logger}, SHELL_SESSION_ID)
      await open.settled
      open.controller.abort()
      await open.result
      const infoMessages = vi.mocked(logger.info).mock.calls.map(([message]) => message)
      return {ledger, logger, infoMessages}
    }

    it('logs a background shell as adopted, then once more as kept, with the ids and no command', async () => {
      // #given a shell that started and whose call returned still running
      const {ledger, logger, infoMessages} = await run([toolStarted, SHELL_CREATED_FRAME, toolSucceeded('running')])

      // #then adoption is labelled neutrally and the background verdict is logged exactly once
      expect(infoMessages.filter(message => message === 'Shell adopted into ownership ledger')).toHaveLength(1)
      expect(infoMessages.filter(message => message === 'Background shell kept in ownership ledger')).toHaveLength(1)
      expect(logger.info).toHaveBeenCalledWith('Background shell kept in ownership ledger', {
        sessionId: SHELL_SESSION_ID,
        shellId: SHELL_ID,
      })
      expect(ledger.isTracked(shellLedgerKey(SHELL_ID))).toBe(true)
      // the model-controlled command text appears in no log line
      expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(SHELL_COMMAND)
    })

    it('does not call a foreground shell a background shell, and releases it without an info line', async () => {
      // #given a shell that started and whose call completed in the foreground
      const {ledger, logger, infoMessages} = await run([toolStarted, SHELL_CREATED_FRAME, toolSucceeded('completed')])

      // #then it was adopted at start, never called background, and released at the call's end
      expect(infoMessages).toContain('Shell adopted into ownership ledger')
      expect(infoMessages).not.toContain('Background shell kept in ownership ledger')
      expect(infoMessages).not.toContain('Background shell adopted into ownership ledger')
      expect(ledger.isTracked(shellLedgerKey(SHELL_ID))).toBe(false)
      expect(logger.warning).not.toHaveBeenCalled()
    })
  })

  describe('the turn a notice owes the root', () => {
    const started = frame('session.execution.started', {sessionID: PARENT_SESSION_ID})
    const succeeded = frame('session.execution.succeeded', {sessionID: PARENT_SESSION_ID})
    const delivered = frame('session.inbox.delivered', {
      sessionID: PARENT_SESSION_ID,
      inboxID: SUBAGENT_NOTICE_MESSAGE.id,
    })

    async function trackerAfter(items: readonly unknown[]) {
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD_SESSION_ID, 'child')
      const tracker = createActivityTrackerV2()
      const open = openRun(items, {ownershipLedger: ledger, tracker}, PARENT_SESSION_ID)
      await open.settled
      open.controller.abort()
      await open.result
      return tracker
    }

    it('fences the previous success from a notice queued for an idle root until the triggered turn starts', async () => {
      // #given an idle root with a notice queued, then delivered, and the triggered turn not started yet
      const queued = await trackerAfter([started, succeeded, SUBAGENT_NOTICE_ENQUEUED_FRAME])
      const deliveredIdle = await trackerAfter([started, succeeded, SUBAGENT_NOTICE_ENQUEUED_FRAME, delivered])
      const running = await trackerAfter([started, succeeded, SUBAGENT_NOTICE_ENQUEUED_FRAME, delivered, started])

      // #then the fence holds through the gap (queued, and delivered-but-not-started) and lifts at the start
      expect(queued).toMatchObject({rootTerminal: null, turnOwed: true})
      expect(deliveredIdle).toMatchObject({rootTerminal: null, turnOwed: true})
      expect(running).toMatchObject({rootTerminal: null, turnOwed: false, rootRunning: true})
    })

    it('owes nothing when a running root takes the notice into the turn it is in', async () => {
      // #given a notice queued and delivered while the root's turn is running, which then ends
      const tracker = await trackerAfter([started, SUBAGENT_NOTICE_ENQUEUED_FRAME, delivered, succeeded])

      // #then the turn's own success stands: no second turn is owed, so the run cannot wait for one that never comes
      expect(tracker).toMatchObject({rootTerminal: {kind: 'succeeded'}, turnOwed: false})
      expect(tracker.queuedNoticeInboxIds.size).toBe(0)
    })

    it('fences a notice that was queued while the root ran and is delivered once it is idle', async () => {
      // #given a notice queued during a turn that then ended, and delivered afterwards to the idle root
      const afterTurn = await trackerAfter([started, SUBAGENT_NOTICE_ENQUEUED_FRAME, succeeded])
      const afterDelivery = await trackerAfter([started, SUBAGENT_NOTICE_ENQUEUED_FRAME, succeeded, delivered])

      // #then the queued notice defers the success; once delivered, the turn it owes holds the fence by itself
      expect(afterTurn).toMatchObject({rootTerminal: {kind: 'succeeded'}, turnOwed: false})
      expect(afterTurn.queuedNoticeInboxIds.size).toBe(1)
      expect(afterDelivery).toMatchObject({rootTerminal: null, turnOwed: true})
      expect(afterDelivery.queuedNoticeInboxIds.size).toBe(0)
    })

    it('advances the revision for each change of what the result means', async () => {
      // #given / #when
      const tracker = await trackerAfter([started, succeeded, SUBAGENT_NOTICE_ENQUEUED_FRAME, delivered, started])

      // #then started, terminal, enqueue, delivery, started
      expect(tracker.rootRevision).toBe(5)
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
          assistantMessageID: 'msg_18389bbfb001CZWJmESBpyKCto',
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

    it('adopts a background shell the moment an owned session creates it', async () => {
      // #given
      const ledger = createOwnershipLedger()

      // #when — `shell.created` precedes the tool result, so adoption cannot wait for the call to return
      const open = openRun([SHELL_CREATED_FRAME], {ownershipLedger: ledger}, SHELL_SESSION_ID)
      await open.settled
      const adopted = ledger.snapshot().map(entry => entry.sessionId)
      const outstanding = ledger.outstanding()
      open.controller.abort()
      await open.result

      // #then
      expect(adopted).toEqual([`shell:${SHELL_ID}`])
      expect(outstanding).toBe(1)
    })

    it('does not adopt a shell that an unowned session started', async () => {
      // #given
      const ledger = createOwnershipLedger()

      // #when
      const open = openRun([SHELL_CREATED_FRAME], {ownershipLedger: ledger}, PARENT_SESSION_ID)
      await open.settled
      open.controller.abort()
      await open.result

      // #then
      expect(ledger.snapshot()).toEqual([])
    })

    it('settles a shell adopted from shell.created when its completion notice arrives', async () => {
      // #given
      const ledger = createOwnershipLedger()

      // #when
      const open = openRun(
        [SHELL_CREATED_FRAME, SHELL_NOTICE_ENQUEUED_FRAME],
        {ownershipLedger: ledger},
        SHELL_SESSION_ID,
      )
      await open.settled
      open.controller.abort()
      await open.result

      // #then
      expect(ledger.snapshot().map(entry => entry.state)).toEqual(['settled'])
    })

    it('does not treat the root as finished while a completion notice is queued and has not started a turn', async () => {
      // #given a root that succeeded, then a background child's notice is queued for it
      const started = frame('session.execution.started', {sessionID: PARENT_SESSION_ID})
      const succeeded = frame('session.execution.succeeded', {sessionID: PARENT_SESSION_ID})
      const delivered = frame('session.inbox.delivered', {
        sessionID: PARENT_SESSION_ID,
        inboxID: SUBAGENT_NOTICE_MESSAGE.id,
      })
      const snapshotAfter = async (items: readonly unknown[]) => {
        const ledger = createOwnershipLedger()
        ledger.adopt(CHILD_SESSION_ID, 'child')
        const tracker = createActivityTrackerV2()
        const open = openRun(items, {ownershipLedger: ledger, tracker}, PARENT_SESSION_ID)
        await open.settled
        open.controller.abort()
        await open.result
        return {terminal: tracker.rootTerminal, queued: [...tracker.queuedNoticeInboxIds]}
      }

      // #when / #then — the earlier success no longer stands and the queued notice is remembered
      expect(await snapshotAfter([started, succeeded, SUBAGENT_NOTICE_ENQUEUED_FRAME])).toEqual({
        terminal: null,
        queued: [SUBAGENT_NOTICE_MESSAGE.id],
      })
      // delivery alone is not the end of the turn it starts
      expect(await snapshotAfter([started, succeeded, SUBAGENT_NOTICE_ENQUEUED_FRAME, delivered])).toEqual({
        terminal: null,
        queued: [],
      })
      // the triggered turn finishing is
      expect(
        await snapshotAfter([started, succeeded, SUBAGENT_NOTICE_ENQUEUED_FRAME, delivered, started, succeeded]),
      ).toEqual({terminal: {kind: 'succeeded'}, queued: []})
      // a turn that ended while the notice was still queued did not take it in: its success is not the end either, even
      // after the delivery (which starts the turn the notice is owed)
      expect(await snapshotAfter([started, SUBAGENT_NOTICE_ENQUEUED_FRAME, succeeded])).toEqual({
        terminal: {kind: 'succeeded'},
        queued: [SUBAGENT_NOTICE_MESSAGE.id],
      })
      expect(await snapshotAfter([started, SUBAGENT_NOTICE_ENQUEUED_FRAME, succeeded, delivered])).toEqual({
        terminal: null,
        queued: [],
      })
    })

    it('keeps a failed root failed when a notice arrives after it', async () => {
      // #given
      const tracker = createActivityTrackerV2()
      const failed = frame('session.execution.failed', {
        sessionID: PARENT_SESSION_ID,
        error: {type: 'unknown', message: 'x'},
      })

      // #when
      const open = openRun([failed, SUBAGENT_NOTICE_ENQUEUED_FRAME], {tracker}, PARENT_SESSION_ID)
      await open.settled
      open.controller.abort()
      await open.result

      // #then
      expect(tracker.rootTerminal).toEqual({kind: 'failed'})
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
