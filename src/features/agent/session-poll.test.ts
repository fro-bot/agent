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
import type {AttemptSettlement} from './attempt-outcome.js'
import type {ExecutionDeadline} from './retry.js'
import type {ActivityTracker} from './streaming.js'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  INITIAL_ACTIVITY_TIMEOUT_MS,
  pollForSessionCompletion,
  pollForSessionCompletionObservation,
} from './session-poll.js'

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

/**
 * Step 3a of the settlement restructure: `pollForSessionCompletionObservation` establishes its
 * own `AttemptSettlement` cause inside the branch that decides to return, instead of a caller
 * inferring it from a post-hoc clock read. See `attempt-outcome.ts`'s module doc for the
 * governing invariant: selecting an error never proves quiescence, and observing quiescence
 * never erases an error.
 *
 * Every settlement-cause assertion below has a sibling proving the neighbouring case does NOT
 * produce it -- one-sided coverage is exactly how the seven earlier review rounds let this bug
 * pattern through.
 */
function assertWatchdogSettlement(
  settlement: AttemptSettlement,
): asserts settlement is Extract<AttemptSettlement, {kind: 'watchdog'}> {
  if (settlement.kind !== 'watchdog') {
    throw new Error(`expected a watchdog settlement, got ${settlement.kind}`)
  }
}

function fakeExpiredDeadline(): ExecutionDeadline {
  return {
    timeoutMs: 1,
    signal: new AbortController().signal,
    isExpired: () => true,
    isTimedOut: () => true,
    remainingMs: () => 0,
    run: async operation => operation(),
    dispose: vi.fn(),
  }
}

/**
 * A deadline whose `isExpired()` reports `false` for the first `n - 1` calls and `true` from the
 * nth call onward. Used to make a deadline expire precisely at a specific check site (e.g. the
 * completion-admission check after an async request) rather than from the very first
 * top-of-loop check, so these tests exercise the admission check itself and not just the
 * earlier, coarser top-of-loop guard.
 */
function fakeDeadlineExpiringAtCall(n: number): ExecutionDeadline {
  let calls = 0
  return {
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    isExpired: () => {
      calls++
      return calls >= n
    },
    isTimedOut: () => false,
    remainingMs: () => 60_000,
    run: async operation => operation(),
    dispose: vi.fn(),
  }
}

function fakeLiveDeadline(): ExecutionDeadline {
  return {
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    isExpired: () => false,
    isTimedOut: () => false,
    remainingMs: () => 60_000,
    run: async operation => operation(),
    dispose: vi.fn(),
  }
}

describe('pollForSessionCompletionObservation — settlement causes', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('completion-observed: sticky terminal flags (event-stream-observed idle)', async () => {
    // #given no deadline and the sticky flags already set
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: true,
      sessionError: null,
    }

    // #when
    const observation = await pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )

    // #then
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(observation.failures).toEqual([])
  })

  it('complement: sticky terminal flags do NOT admit completion once the deadline has expired', async () => {
    // #given the exact same sticky-flag state as above, but a deadline that is still live for
    // the top-of-loop check and expires precisely at the completion-admission check itself —
    // this exercises the admission check added at the decision point, not the earlier coarser
    // top-of-loop guard.
    vi.useFakeTimers()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: true,
      sessionError: null,
    }

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
      fakeDeadlineExpiringAtCall(2),
    )
    await vi.advanceTimersByTimeAsync(500)
    const observation = await observationPromise

    // #then — rejected, and rejected specifically as a deadline conclusion, not completion
    expect(observation.settlement.kind).toBe('deadline')
  })

  it('completion-observed: stable completed-assistant message across two polls', async () => {
    // #given a completed assistant message stable across the two polls the check requires
    vi.useFakeTimers()
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

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_000)
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('completion-observed')
  })

  it('complement: a completed assistant message first stable AFTER the deadline is still rejected', async () => {
    // #given the identical stable-message setup, but the deadline is already expired
    vi.useFakeTimers()
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

    // #when — the deadline is live for both top-of-loop checks (iteration 1 and 2) and expires
    // precisely at the completion-admission check on iteration 2, after the stability-confirming
    // async session.messages() request has already run
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
      fakeDeadlineExpiringAtCall(3),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    const observation = await observationPromise

    // #then — the stability check still ran and set the terminal signal, but admission is
    // rejected because the deadline had already expired when the decision was made
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
    expect(observation.settlement.kind).toBe('deadline')
  })

  it('completion-observed: session.status "idle"', async () => {
    // #given
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: false,
      sessionError: null,
    }

    // #when
    const observation = await pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )

    // #then
    expect(observation.settlement.kind).toBe('completion-observed')
  })

  it('complement: session.status "idle" observed after the deadline is still rejected', async () => {
    // #given the identical idle-status setup, but a deadline that is live for the top-of-loop
    // check and expires precisely at the completion-admission check, after the async
    // session.status() request that produced the idle status has already resolved
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: false,
      sessionError: null,
    }

    // #when
    const observation = await pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
      fakeDeadlineExpiringAtCall(2),
    )

    // #then
    expect(observation.settlement.kind).toBe('deadline')
  })

  it('failure-observed: an already-accepted provider error wins even with the clock already expired (round-7 case)', async () => {
    // #given a provider-terminal error already accepted into the shared tracker, and a deadline
    // that reports expired from the very first check
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
      terminalProviderError: {type: 'provider_auth_error', message: 'auth rejected', retryable: false},
    }
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}

    // #when
    const observation = await pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
      fakeExpiredDeadline(),
    )

    // #then — this is a deliberate producer policy, not a mislabeled deadline conclusion
    expect(observation.settlement.kind).toBe('failure-observed')
    expect(observation.settlement.kind).not.toBe('deadline')
    expect(observation.failures).toEqual([
      {source: 'provider', message: 'auth rejected', llmError: activityTracker.terminalProviderError},
    ])
  })

  it('complement: with no accepted provider error, the same expired clock settles as deadline instead', async () => {
    // #given the identical expired deadline, but no terminal provider error has been accepted
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}

    // #when
    const observation = await pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
      fakeExpiredDeadline(),
    )

    // #then
    expect(observation.settlement.kind).toBe('deadline')
  })

  it('failure-observed: generic session error grace period exhaustion', async () => {
    // #given a persistent session.error observed via the event stream
    vi.useFakeTimers()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: 'LLM fetch failed',
    }

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(2_000)
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('failure-observed')
    expect(observation.failures[0]?.source).toBe('session')
    expect(observation.failures[0]?.message).toContain('LLM fetch failed')
  })

  it('complement: an ordinary request error does not settle — it polls and retries instead', async () => {
    // #given session.status() rejects once, then reports idle — an ordinary transport failure,
    // not a session.error or provider-terminal signal
    vi.useFakeTimers()
    let callCount = 0
    const statusFn = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) throw new Error('transient network error')
      return {data: {ses_123: {type: 'idle'}}}
    })
    const mockClient = {session: {status: statusFn}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: false,
      sessionError: null,
    }

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then — the transient error was absorbed by the poll-and-retry loop, not turned into a
    // settlement; the second call succeeded and completed normally
    expect(callCount).toBeGreaterThanOrEqual(2)
    expect(observation.settlement.kind).toBe('completion-observed')
  })

  it('cancelled: signal already aborted, no deadline in play', async () => {
    // #given an externally aborted signal and no shared deadline at all
    const abortController = new AbortController()
    abortController.abort()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}

    // #when
    const observation = await pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
    )

    // #then
    expect(observation.settlement.kind).toBe('cancelled')
  })

  it('complement: the same aborted signal settles as deadline, not cancelled, once the deadline has expired', async () => {
    // #given the identical aborted signal, but a deadline that reports expired
    const abortController = new AbortController()
    abortController.abort()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}

    // #when
    const observation = await pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
      30_000,
      undefined,
      fakeExpiredDeadline(),
    )

    // #then
    expect(observation.settlement.kind).toBe('deadline')
    expect(observation.settlement.kind).not.toBe('cancelled')
  })

  it('watchdog: local poll timeout (maxPollTimeMs) exceeded with no shared deadline', async () => {
    // #given no deadline, so the local poll budget is authoritative
    vi.useFakeTimers()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_000,
    )
    await vi.advanceTimersByTimeAsync(2_000)
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('watchdog')
    assertWatchdogSettlement(observation.settlement)
    expect(observation.settlement.message).toContain('Poll timeout')
  })

  it('complement: the same elapsed time does not watchdog-settle when a shared deadline governs instead', async () => {
    // #given an identical low maxPollTimeMs, but a live (non-expired) shared deadline present —
    // the local poll-timeout watchdog is only authoritative when there is no shared deadline
    vi.useFakeTimers()
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})
    const mockClient = {session: {status: statusFn}}

    // #when — intentionally not awaited to completion: this deadline never expires and the
    // client never reports idle, so the promise would never settle within the test
    pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_000,
      undefined,
      fakeLiveDeadline(),
    ).catch(() => {})
    await vi.advanceTimersByTimeAsync(2_000)

    // #then — still polling, proven by repeated status calls instead of a settled result
    expect(statusFn.mock.calls.length).toBeGreaterThan(1)
  })

  it('watchdog: inactivity — no meaningful activity within the initial activity timeout', async () => {
    // #given no activity ever observed
    vi.useFakeTimers()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      INITIAL_ACTIVITY_TIMEOUT_MS * 2,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(INITIAL_ACTIVITY_TIMEOUT_MS + 1_000)
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('watchdog')
    assertWatchdogSettlement(observation.settlement)
    expect(observation.settlement.message).toContain('No agent activity detected')
  })

  it('complement: activity observed in time avoids the inactivity watchdog', async () => {
    // #given activity is already flagged as received before the same elapsed window
    vi.useFakeTimers()
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})
    const mockClient = {session: {status: statusFn}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }

    // #when — intentionally not awaited to completion: the session stays busy forever within
    // this test, so the promise would never settle
    pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      INITIAL_ACTIVITY_TIMEOUT_MS * 2,
      activityTracker,
    ).catch(() => {})
    await vi.advanceTimersByTimeAsync(INITIAL_ACTIVITY_TIMEOUT_MS + 1_000)

    // #then — still polling (busy, no terminal signal), proven by repeated status calls instead
    // of an inactivity settlement
    expect(statusFn.mock.calls.length).toBeGreaterThan(1)
  })
})
