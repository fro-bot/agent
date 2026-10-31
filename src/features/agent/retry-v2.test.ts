/**
 * One V2 prompt attempt: completion is raced between the session-wait route and the poll watchdog, and the wait route
 * is a hint that never completes an attempt by itself (it answers at once for a prompt that is not admitted yet).
 */
import type {Logger} from '../../shared/logger.js'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {createFakeServer, frame, ROOT_SESSION_ID, STARTED, SUCCEEDED} from './execution-v2.fixture.js'
import {runPromptAttemptV2} from './retry-v2.js'
import {createDeadlineExceededError, createExecutionDeadline} from './retry.js'
import {observeRootTerminal} from './session-poll-v2.js'
import {createActivityTrackerV2} from './streaming-v2.js'

vi.mock('../../shared/console.js', () => ({outputTextContent: vi.fn(), outputToolExecution: vi.fn()}))

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

  it('lets an accepted terminal provider failure win without a root result', () => {
    // #given
    const tracker = createActivityTrackerV2()
    tracker.terminalProviderError = {type: 'provider_auth_error', message: 'x', retryable: false}

    // #when / #then
    expect(observeRootTerminal(tracker, logger)?.settlement.kind).toBe('failure-observed')
  })
})
