/**
 * One V2 prompt attempt: completion is raced between the session-wait route and the poll watchdog, and the wait route
 * is a hint that never completes an attempt by itself (it answers at once for a prompt that is not admitted yet).
 */
import type {Logger} from '../../shared/logger.js'
import {createOwnershipLedger, shellLedgerKey} from '@fro-bot/runtime'
import {
  CHILD_SESSION_ID,
  SHELL_ID,
  SHELL_INBOX_ID,
  SHELL_NOTICE_ENQUEUED_FRAME,
  SUBAGENT_NOTICE_ENQUEUED_FRAME,
  SUBAGENT_NOTICE_MESSAGE,
} from '@fro-bot/runtime/event-v2-fixtures'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {createFakeServer, frame, ROOT_SESSION_ID, STARTED, SUCCEEDED} from './execution-v2.fixture.js'
import {runPromptAttemptV2} from './retry-v2.js'
import {createDeadlineExceededError, createExecutionDeadline} from './retry.js'
import {observeRootTerminal} from './session-poll-v2.js'
import {createActivityTrackerV2} from './streaming-v2.js'

const consoleMock = vi.hoisted(() => ({outputTextContent: vi.fn(), outputToolExecution: vi.fn()}))
vi.mock('../../shared/console.js', () => consoleMock)

async function advance(totalMs: number, stepMs = 100): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) await vi.advanceTimersByTimeAsync(stepMs)
}

describe('runPromptAttemptV2', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function attempt(
    server: ReturnType<typeof createFakeServer>,
    extra: Partial<Parameters<typeof runPromptAttemptV2>[0]> = {},
  ) {
    const attemptAbortController = new AbortController()
    const subscribed = await server.client.subscribeEvents({directory: '/d', signal: attemptAbortController.signal})
    if (!subscribed.success) throw new Error('subscribe failed in test')
    return runPromptAttemptV2({
      client: server.client,
      sessionId: ROOT_SESSION_ID,
      eventStream: subscribed.data,
      startPrompt: async () => {
        const prompted = await server.client.prompt({sessionId: ROOT_SESSION_ID, text: 'go', directory: '/d'})
        return prompted.success ? null : null
      },
      logger,
      attemptAbortController,
      ...extra,
    })
  }

  /** A root that succeeded while a child was still tracked; the child then settles through REST, before its notice. */
  async function succeededThenSettledByRest(extra: Parameters<typeof attempt>[1] = {}) {
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD_SESSION_ID, 'child')
    const server = createFakeServer({
      onPrompt: (_, pipe) => {
        pipe.push(STARTED)
        pipe.push(SUCCEEDED)
      },
    })
    const result = attempt(server, {ownershipLedger: ledger, keepObserving: true, ...extra})
    await advance(300)
    ledger.settle(CHILD_SESSION_ID)
    await advance(2_000)
    const outcome = await result
    return {server, ledger, outcome, live: outcome.liveObservation}
  }

  it('does not complete on a wait that answered before the prompt was admitted; it asks again', async () => {
    // #given the wait route answers at once, and the turn only starts and ends 1s after the prompt
    const server = createFakeServer({
      onPrompt: (_, pipe) => {
        setTimeout(() => pipe.push(STARTED), 600)
        setTimeout(() => pipe.push(SUCCEEDED), 1_000)
      },
    })

    // #when
    const result = attempt(server)
    await advance(300)

    // #then nothing completed from the early wait alone
    expect(server.calls.waitSession.mock.calls.length).toBeGreaterThanOrEqual(1)
    await advance(3_000)
    expect(await result).toMatchObject({success: true, outcome: 'completed'})
    // The wait route was asked again after the first early answer.
    expect(server.calls.waitSession.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('completes through the wait route once the root result for the current turn is recorded', async () => {
    // #given the wait resolves after the turn ended
    let release!: () => void
    const waitGate = new Promise<void>(resolve => {
      release = resolve
    })
    const server = createFakeServer({
      waitGate,
      onPrompt: (_, pipe) => {
        pipe.push(STARTED)
        pipe.push(SUCCEEDED)
      },
    })

    // #when
    const result = attempt(server, {poll: {pollIntervalMs: 60_000}})
    await advance(300)
    release()
    await advance(1_000)

    // #then
    expect(await result).toMatchObject({success: true, settlement: {kind: 'completion-observed'}})
  })

  describe('the session-wait route is bounded and re-issued', () => {
    const WAIT_BOUND_MS = 1_000
    const idle = {success: true, data: undefined} as const
    // Polling is held off so the wait route alone can complete the attempt.
    const pollOff = {pollIntervalMs: 600_000, initialActivityTimeoutMs: 600_000}

    it('re-issues a wait that outlives its bound; the next wait answers and completion follows', async () => {
      // #given a first wait that never answers (as the 300 s client timeout would end it) and a turn that ends after it
      const server = createFakeServer({
        onPrompt: (_, pipe) => {
          pipe.push(STARTED)
          setTimeout(() => pipe.push(SUCCEEDED), 1_500)
        },
        waitResponder: async (call, signal) => {
          if (call > 1) return idle
          await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), {once: true}))
          return {success: false, error: {kind: 'aborted'}}
        },
      })

      // #when
      const result = attempt(server, {poll: pollOff, waitBoundMs: WAIT_BOUND_MS})
      await advance(WAIT_BOUND_MS + 200)

      // #then the bound ended the first call and the wait was asked again, with no fallback to polling
      expect(server.calls.waitSession.mock.calls.length).toBeGreaterThanOrEqual(2)
      await advance(3_000)
      expect(await result).toMatchObject({success: true, settlement: {kind: 'completion-observed'}})
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('relying on the poll watchdog'),
        expect.anything(),
      )
    })

    it('hands each wait call its own signal, cut at the bound', async () => {
      // #given a wait that records whether its signal aborted
      const aborted: boolean[] = []
      const server = createFakeServer({
        onPrompt: (_, pipe) => {
          pipe.push(STARTED)
          setTimeout(() => pipe.push(SUCCEEDED), 2_500)
        },
        waitResponder: async (call, signal) => {
          if (call > 2) return idle
          await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), {once: true}))
          aborted.push(signal?.aborted === true)
          return {success: false, error: {kind: 'aborted'}}
        },
      })

      // #when two bounds elapse
      const result = attempt(server, {poll: pollOff, waitBoundMs: WAIT_BOUND_MS})
      await advance(2 * WAIT_BOUND_MS + 500)

      // #then both calls were cut by their own bound and the wait was asked a third time
      expect(aborted).toEqual([true, true])
      expect(server.calls.waitSession.mock.calls.length).toBeGreaterThanOrEqual(3)
      await advance(3_000)
      expect(await result).toMatchObject({success: true})
    })

    it.each([
      ['an HTTP error status', {kind: 'http', status: 500}],
      ['a transport failure that is not our bound', {kind: 'network', message: 'socket hang up'}],
    ] as const)('falls back to polling on %s, and says so at info', async (_label, error) => {
      // #given a wait that fails for real
      const server = createFakeServer({
        onPrompt: (_, pipe) => {
          pipe.push(STARTED)
          pipe.push(SUCCEEDED)
        },
        waitResponder: async () => ({success: false, error}),
      })

      // #when
      const result = attempt(server, {waitBoundMs: WAIT_BOUND_MS})
      await advance(2_000)

      // #then the poll watchdog completes the attempt, and the switch is visible in the Actions log
      expect(await result).toMatchObject({success: true, outcome: 'completed'})
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('relying on the poll watchdog'),
        expect.objectContaining({error: error.kind}),
      )
      expect(server.calls.waitSession).toHaveBeenCalledTimes(1)
    })
  })

  it('reports a failed root turn with its classified error', async () => {
    // #given
    const server = createFakeServer({
      onPrompt: (_, pipe) => {
        pipe.push(STARTED)
        pipe.push(
          frame('session.execution.failed', {
            sessionID: ROOT_SESSION_ID,
            error: {type: 'provider.quota', message: 'out of credit', status: 402},
          }),
        )
      },
    })

    // #when
    const result = attempt(server)
    await advance(2_000)

    // #then
    expect(await result).toMatchObject({
      success: false,
      outcome: 'turn_failed_terminal',
      llmError: {type: 'quota_exceeded'},
    })
  })

  it('treats an interrupt it did not send as a failed turn, not a success', async () => {
    // #given
    const server = createFakeServer({
      onPrompt: (_, pipe) => {
        pipe.push(STARTED)
        pipe.push(frame('session.execution.interrupted', {sessionID: ROOT_SESSION_ID, reason: 'shutdown'}))
      },
    })

    // #when
    const result = attempt(server)
    await advance(2_000)

    // #then
    const outcome = await result
    expect(outcome.success).toBe(false)
    expect(outcome.settlement.kind).toBe('cancelled')
  })

  it('reads the result from the persisted session state when the stream missed it', async () => {
    // #given the root ran (its start was seen), the stream then dropped, and the persisted state says succeeded
    const server = createFakeServer({
      onPrompt: (_, pipe) => {
        pipe.push(STARTED)
        setTimeout(() => pipe.end(), 200)
      },
    })
    server.getSession.mockResolvedValue({success: true, data: {outcome: 'succeeded'}})

    // #when
    const result = attempt(server, {poll: {restEveryTicks: 1}})
    await advance(10_000)

    // #then
    const outcome = await result
    expect(outcome).toMatchObject({success: true})
    expect(outcome.eventStreamResult.discontinuity).toBeDefined()
  })

  it("does not accept the previous run's persisted outcome when the root was never seen running", async () => {
    // #given a continued session whose last outcome is "succeeded", and a stream that connected and then died silently
    const server = createFakeServer({
      onPrompt: (_, pipe) => {
        setTimeout(() => pipe.end(), 100)
      },
    })
    server.getSession.mockResolvedValue({success: true, data: {outcome: 'succeeded'}})

    // #when
    const result = attempt(server, {poll: {restEveryTicks: 1, initialActivityTimeoutMs: 3_000}})
    await advance(10_000)

    // #then the watchdog ends it as a failure instead of trusting the stale outcome
    const outcome = await result
    expect(outcome.success).toBe(false)
    expect(outcome.settlement.kind).toBe('watchdog')
  })

  it('defers completion while owned work is outstanding and completes once it settles', async () => {
    // #given
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'child')
    const server = createFakeServer({
      onPrompt: (_, pipe) => {
        pipe.push(STARTED)
        pipe.push(SUCCEEDED)
      },
    })

    // #when
    const result = attempt(server, {ownershipLedger: ledger})
    await advance(3_000)
    let settledEarly = false
    // eslint-disable-next-line no-void
    void result.then(() => {
      settledEarly = true
    })
    await advance(100)

    // #then
    expect(settledEarly).toBe(false)

    // #when the child settles
    ledger.settle('ses_child')
    await advance(2_000)

    // #then
    expect(await result).toMatchObject({success: true})
  })

  describe('background work that outlives the root turn', () => {
    // The captured notices, addressed to the run's root (the fixtures were captured against other sessions).
    const childNotice = frame('session.inbox.enqueued', {
      ...(SUBAGENT_NOTICE_ENQUEUED_FRAME.data as object),
      sessionID: ROOT_SESSION_ID,
    })
    const shellNotice = frame('session.inbox.enqueued', {
      ...SHELL_NOTICE_ENQUEUED_FRAME.data,
      sessionID: ROOT_SESSION_ID,
    })
    const delivered = (inboxID: string) => frame('session.inbox.delivered', {sessionID: ROOT_SESSION_ID, inboxID})

    async function completesOnlyAfterTheTriggeredTurn(
      ledgerKey: string,
      notice: ReturnType<typeof frame>,
      inboxId: string,
    ) {
      // #given a root that succeeded while a background job still ran
      const ledger = createOwnershipLedger()
      ledger.adopt(ledgerKey, 'background work')
      const server = createFakeServer({
        onPrompt: (_, pipe) => {
          pipe.push(STARTED)
          pipe.push(SUCCEEDED)
          setTimeout(() => pipe.push(notice), 1_000)
          setTimeout(() => pipe.push(delivered(inboxId)), 3_000)
          setTimeout(() => pipe.push(STARTED), 3_100)
          setTimeout(() => pipe.push(SUCCEEDED), 4_000)
        },
      })
      let done = false

      // #when the job's notice lands: the ledger is settled, but the notice still owes the root a turn
      const result = attempt(server, {ownershipLedger: ledger})
      // eslint-disable-next-line no-void
      void result.then(() => {
        done = true
      })
      await advance(2_500)

      // #then the first idle is not terminal, and neither is a settled ledger
      expect(ledger.isDrainComplete()).toBe(true)
      expect(done).toBe(false)

      // #when the notice is delivered and the turn it started runs
      await advance(900)
      expect(done).toBe(false)
      await advance(1_500)

      // #then the attempt completes on that turn's own success
      return result
    }

    it('waits for the turn a background child notice triggers before completing', async () => {
      const outcome = await completesOnlyAfterTheTriggeredTurn(
        CHILD_SESSION_ID,
        childNotice,
        SUBAGENT_NOTICE_MESSAGE.id,
      )

      expect(outcome).toMatchObject({success: true, settlement: {kind: 'completion-observed'}})
    })

    it('waits for the turn a background shell notice triggers before completing', async () => {
      const outcome = await completesOnlyAfterTheTriggeredTurn(shellLedgerKey(SHELL_ID), shellNotice, SHELL_INBOX_ID)

      expect(outcome).toMatchObject({success: true, settlement: {kind: 'completion-observed'}})
    })

    it('settles a child whose notice the stream missed from the REST view when the root goes idle', async () => {
      // #given a child that is a finished direct child of the root, and no notice on the stream
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD_SESSION_ID, 'child')
      const server = createFakeServer({
        onPrompt: (_, pipe) => {
          pipe.push(STARTED)
          pipe.push(SUCCEEDED)
        },
      })
      vi.mocked(server.client.session.list).mockResolvedValue({
        data: [{id: CHILD_SESSION_ID, parentID: ROOT_SESSION_ID, time: {updated: 1}}],
      })

      // #when
      const result = attempt(server, {ownershipLedger: ledger, directory: '/d', reconcileIntervalMs: 600_000})
      await advance(2_000)

      // #then
      expect(ledger.snapshot().map(entry => entry.state)).toEqual(['settled'])
      expect(await result).toMatchObject({success: true})
    })

    it('settles a background shell that is gone from the shell list when the root goes idle', async () => {
      // #given a shell the server no longer lists and no longer knows
      const ledger = createOwnershipLedger()
      ledger.adopt(shellLedgerKey(SHELL_ID), 'background shell')
      const server = createFakeServer({
        onPrompt: (_, pipe) => {
          pipe.push(STARTED)
          pipe.push(SUCCEEDED)
        },
      })

      // #when
      const result = attempt(server, {ownershipLedger: ledger, directory: '/d', reconcileIntervalMs: 600_000})
      await advance(2_000)

      // #then
      expect(vi.mocked(server.client.listShells)).toHaveBeenCalled()
      expect(ledger.snapshot().map(entry => entry.state)).toEqual(['settled'])
      expect(await result).toMatchObject({success: true})
    })

    it('keeps waiting on a shell the server still lists as running', async () => {
      // #given
      const ledger = createOwnershipLedger()
      ledger.adopt(shellLedgerKey(SHELL_ID), 'background shell')
      const server = createFakeServer({
        onPrompt: (_, pipe) => {
          pipe.push(STARTED)
          pipe.push(SUCCEEDED)
        },
      })
      vi.mocked(server.client.listShells).mockResolvedValue({
        success: true,
        data: [{id: SHELL_ID, status: 'running'}],
      } as never)
      let done = false

      // #when
      const result = attempt(server, {ownershipLedger: ledger, directory: '/d', reconcileIntervalMs: 1_000})
      // eslint-disable-next-line no-void
      void result.then(() => {
        done = true
      })
      await advance(8_000)

      // #then
      expect(done).toBe(false)
      expect(ledger.outstanding()).toBe(1)

      // cleanup: let the attempt end through its own stop so the test leaves no pending timers
      ledger.settle(shellLedgerKey(SHELL_ID))
      await advance(2_000)
      await result
    })
  })

  describe('the event observation outlives a successful attempt', () => {
    const noticeEnqueued = frame('session.inbox.enqueued', {
      ...(SUBAGENT_NOTICE_ENQUEUED_FRAME.data as object),
      sessionID: ROOT_SESSION_ID,
    })
    const noticeDelivered = frame('session.inbox.delivered', {
      sessionID: ROOT_SESSION_ID,
      inboxID: SUBAGENT_NOTICE_MESSAGE.id,
    })
    const askedFrame = frame('permission.asked', {
      id: 'per_notice_turn',
      sessionID: ROOT_SESSION_ID,
      action: 'bash',
      resources: ['rm -rf /'],
    })
    const noticeText = frame('session.text.ended', {
      sessionID: ROOT_SESSION_ID,
      assistantMessageID: 'msg_notice_turn',
      ordinal: 0,
      text: 'The background child reported: all green.',
    })

    it('hands the processor over instead of stopping it, so the subscription stays open', async () => {
      // #given / #when
      const {outcome, live} = await succeededThenSettledByRest()

      // #then the observation rides on the result itself
      expect(outcome).toMatchObject({success: true})
      expect(live).toBeDefined()
      await live?.stop()
    })

    it('does not hand over when the caller cannot keep the subscription, or when the attempt failed', async () => {
      // #given a caller that did not ask to keep observing
      const server = createFakeServer({
        onPrompt: (_, pipe) => {
          pipe.push(STARTED)
          pipe.push(SUCCEEDED)
        },
      })

      // #when
      const result = attempt(server, {ownershipLedger: createOwnershipLedger()})
      await advance(2_000)

      // #then
      const outcome = await result
      expect(outcome).toMatchObject({success: true})
      expect(outcome.liveObservation).toBeUndefined()
    })

    it('records a failed turn the notice starts after the attempt returned, so the last turn decides', async () => {
      // #given
      const {server, live} = await succeededThenSettledByRest()

      // #when a notice turn runs and fails
      const pipe = server.pipes.at(-1)
      pipe?.push(noticeEnqueued)
      pipe?.push(noticeDelivered)
      pipe?.push(STARTED)
      pipe?.push(
        frame('session.execution.failed', {
          sessionID: ROOT_SESSION_ID,
          error: {type: 'provider.quota', message: 'out of credit', status: 402},
        }),
      )
      await advance(200)
      const result = await live?.stop()

      // #then
      expect(live?.tracker.rootTerminal).toEqual({kind: 'failed'})
      expect(result?.llmError).toMatchObject({type: 'quota_exceeded'})
    })

    it('still rejects a permission ask the notice turn raises', async () => {
      // #given
      const onPermissionAsked = vi.fn(async () => undefined)
      const {server, live} = await succeededThenSettledByRest({onPermissionAsked})

      // #when the notice turn asks for a permission after the attempt returned
      const pipe = server.pipes.at(-1)
      pipe?.push(noticeEnqueued)
      pipe?.push(STARTED)
      pipe?.push(askedFrame)
      await advance(200)
      await live?.stop()

      // #then
      expect(onPermissionAsked).toHaveBeenCalledWith(
        expect.objectContaining({requestId: 'per_notice_turn', sessionId: ROOT_SESSION_ID}),
      )
    })

    it("streams the text of a notice turn that succeeds, and ends on that turn's success", async () => {
      // #given
      consoleMock.outputTextContent.mockClear()
      const {server, live} = await succeededThenSettledByRest()

      // #when
      const pipe = server.pipes.at(-1)
      pipe?.push(noticeEnqueued)
      pipe?.push(noticeDelivered)
      pipe?.push(STARTED)
      pipe?.push(noticeText)
      pipe?.push(SUCCEEDED)
      await advance(200)
      await live?.stop()

      // #then the later turn's text was written, after the first turn's, and the root ended succeeded
      expect(consoleMock.outputTextContent).toHaveBeenCalledWith('The background child reported: all green.')
      expect(live?.tracker.rootTerminal).toEqual({kind: 'succeeded'})
    })
  })

  it('ends a turn that never shows activity as a watchdog failure', async () => {
    // #given a stream that connects and stays silent
    const server = createFakeServer({})

    // #when
    const result = attempt(server, {poll: {initialActivityTimeoutMs: 2_000}})
    await advance(5_000)

    // #then
    const outcome = await result
    expect(outcome.success).toBe(false)
    expect(outcome.settlement.kind).toBe('watchdog')
  })

  it('settles as a deadline when the shared deadline expires mid-turn', async () => {
    // #given
    const deadline = createExecutionDeadline(2_000, logger)
    const server = createFakeServer({onPrompt: (_, pipe) => pipe.push(STARTED)})

    // #when
    const result = attempt(server, {deadline})
    await advance(5_000)

    // #then
    const outcome = await result
    expect(outcome.success).toBe(false)
    expect(outcome.settlement.kind).toBe('deadline')
    deadline.dispose()
    expect(createDeadlineExceededError('x').name).toBe('DeadlineExceededError')
  })
})

describe('observeRootTerminal', () => {
  const logger = createMockLogger()

  it('is null before a root result and for a success that owned work still blocks', () => {
    // #given
    const tracker = createActivityTrackerV2()
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'child')

    // #when / #then
    expect(observeRootTerminal(tracker, logger)).toBeNull()
    tracker.rootTerminal = {kind: 'succeeded'}
    expect(observeRootTerminal(tracker, logger, ledger)).toBeNull()
    expect(observeRootTerminal(tracker, logger)?.settlement.kind).toBe('completion-observed')
  })

  it('defers a success while a completion notice is queued, unless the stream is known to have lost events', () => {
    // #given
    const tracker = createActivityTrackerV2()
    tracker.rootTerminal = {kind: 'succeeded'}
    tracker.queuedNoticeInboxIds.add('msg_1')

    // #when / #then
    expect(observeRootTerminal(tracker, logger)).toBeNull()
    tracker.streamBlind = true
    expect(observeRootTerminal(tracker, logger)?.settlement.kind).toBe('completion-observed')
  })

  it('lets an accepted terminal provider failure win without a root result', () => {
    // #given
    const tracker = createActivityTrackerV2()
    tracker.terminalProviderError = {type: 'provider_auth_error', message: 'x', retryable: false}

    // #when / #then
    expect(observeRootTerminal(tracker, logger)?.settlement.kind).toBe('failure-observed')
  })
})
