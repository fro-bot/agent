import type {createOpencode} from '@opencode-ai/sdk'
/**
 * Unit 9: gate every terminal path.
 *
 * `pollForSessionCompletion` independently ends a run through two of the four
 * paths named in the plan:
 *  - the stable completed-assistant poll (`detectMessageActivity`'s
 *    `messageResult` branch)
 *  - the sticky terminal flags (`activityTracker.sessionIdle` +
 *    `currentTurnTerminalSignalReceived`, checked twice in this function: once
 *    from the event-stream-observed flag directly, once from
 *    `session.status()` reporting `idle`)
 *
 * Existing characterization coverage for this function (busy/idle polling,
 * retry-status classification, deadline handling) lives in `opencode.test.ts`
 * and is untouched by this unit — these tests only target the new
 * `ownershipLedger` gate.
 */
import type {Logger} from '../../shared/logger.js'
import type {ActivityTracker} from './streaming.js'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {pollForSessionCompletion} from './session-poll.js'

type MockClient = Awaited<ReturnType<typeof createOpencode>>['client']

describe('pollForSessionCompletion — ownership ledger gating (Unit 9)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('happy path: sticky terminal flags (event-stream-observed idle) complete when nothing is outstanding', async () => {
    // #given a ledger with no outstanding entries and the sticky flags already set
    const ledger = createOwnershipLedger()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: true,
      sessionError: null,
    }

    // #when polled with the ledger supplied
    const result = await pollForSessionCompletion(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
      undefined,
      ledger,
    )

    // #then it completes exactly as it does today
    expect(result.completed).toBe(true)
    expect(result.error).toBeNull()
  })

  it('happy path: session.status "idle" completes when nothing is outstanding', async () => {
    // #given a ledger with no outstanding entries
    const ledger = createOwnershipLedger()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: false,
      sessionError: null,
    }

    // #when
    const result = await pollForSessionCompletion(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
      undefined,
      ledger,
    )

    // #then
    expect(result.completed).toBe(true)
  })

  it('edge case: sticky terminal flags do not resolve complete while owned work is outstanding, and resolve once drained', async () => {
    // #given a ledger with an outstanding background entry, and the sticky flags already set
    // (mirrors a run whose root session went idle while its subagent is still running)
    vi.useFakeTimers()
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'background task')
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})
    const mockClient = {session: {status: statusFn}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: true,
      sessionError: null,
    }

    const pollPromise = pollForSessionCompletion(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
      undefined,
      ledger,
    )

    // #when several poll cycles pass with the entry still outstanding
    await vi.advanceTimersByTimeAsync(1_500)

    // #then it has not resolved — the promise is still pending, proven by continuing to poll
    expect(statusFn.mock.calls.length).toBeGreaterThan(1)

    // #when the outstanding work settles
    ledger.settle('ses_child')
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pollPromise

    // #then it now resolves complete
    expect(result.completed).toBe(true)
    expect(result.error).toBeNull()
  })

  it('edge case: the stable completed-assistant poll does not resolve complete while owned work is outstanding, and resolves once drained', async () => {
    // #given a ledger with an outstanding background entry, and a completed assistant message
    // stable across consecutive polls (the signal `detectMessageActivity` treats as terminal)
    vi.useFakeTimers()
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'background task')
    const messagesFn = vi.fn().mockResolvedValue({
      data: [{info: {id: 'msg_new', role: 'assistant', time: {created: 1, completed: 2}}}],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      baselineMessageIds: new Set(),
      sessionIdle: false,
      sessionError: null,
    }

    const pollPromise = pollForSessionCompletion(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
      undefined,
      ledger,
    )

    // #when the same completed assistant message is observed across the two polls the stability
    // check requires (reaching the point where, ungated, the function would already have returned)
    await vi.advanceTimersByTimeAsync(1_000)
    const callsAtStability = messagesFn.mock.calls.length
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
    expect(callsAtStability).toBeGreaterThanOrEqual(2)

    // #then it keeps polling past that point instead of having returned — proof it did not resolve
    await vi.advanceTimersByTimeAsync(1_500)
    expect(messagesFn.mock.calls.length).toBeGreaterThan(callsAtStability)

    // #when the outstanding work settles
    ledger.settle('ses_child')
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pollPromise

    // #then it now resolves complete
    expect(result.completed).toBe(true)
    expect(result.error).toBeNull()
  })

  it('no-ledger path is inert: behavior is unchanged when ownershipLedger is omitted', async () => {
    // #given the sticky flags set and no ledger argument at all
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: true,
      sessionError: null,
    }

    // #when polled without a ledger
    const result = await pollForSessionCompletion(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )

    // #then it completes immediately, exactly as every single-session run does today
    expect(result.completed).toBe(true)
    expect(result.error).toBeNull()
  })
})
