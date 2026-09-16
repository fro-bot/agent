import type {ErrorInfo} from '@fro-bot/runtime'
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
import {reduceAttemptOutcome} from './attempt-outcome.js'
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

  describe('failure-observed: session error persisting through the grace period captures classified evidence at construction (Finding 1 fix)', () => {
    const CLASSIFIED_ERROR: ErrorInfo = {
      type: 'llm_fetch_error',
      message: 'classified session failure',
      retryable: true,
    }

    it('attaches whatever classified evidence the SSE processor has already recorded on the tracker, without a later enrichment pass', async () => {
      // #given the SSE side of processing has already classified this session error onto the
      // tracker (genericError + classificationPath) by the time the grace period elapses -- this
      // producer must read that evidence itself, at construction, not rely on a caller reading the
      // tracker again afterward (the deleted `enrichSessionFailureWithClassifiedError`)
      vi.useFakeTimers()
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
      const activityTracker: ActivityTracker = {
        firstMeaningfulEventReceived: true,
        currentTurnTerminalSignalReceived: false,
        sessionIdle: false,
        sessionError: 'network error',
        genericError: CLASSIFIED_ERROR,
        classificationPath: 'fallback',
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
      expect(observation.failures).toHaveLength(1)
      expect(observation.failures[0]?.source).toBe('session')
      expect(observation.failures[0]?.llmError).toBe(CLASSIFIED_ERROR)
      expect(observation.failures[0]?.classificationPath).toBe('fallback')
    })

    it('complement: with no classified evidence recorded, the failure still reports its raw message with a null llmError', async () => {
      // #given the identical persisting-session-error shape, but nothing on the tracker has been
      // classified yet -- this must not fabricate evidence that was never observed
      vi.useFakeTimers()
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
      const activityTracker: ActivityTracker = {
        firstMeaningfulEventReceived: true,
        currentTurnTerminalSignalReceived: false,
        sessionIdle: false,
        sessionError: 'network error',
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
      expect(observation.failures[0]?.llmError).toBeNull()
      expect(observation.failures[0]?.message).toContain('network error')
    })

    it('a delayed continuation mutating the tracker after settlement cannot rewrite the already-returned observation', async () => {
      // #given the same settled observation as the first test in this block
      vi.useFakeTimers()
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
      const activityTracker: ActivityTracker = {
        firstMeaningfulEventReceived: true,
        currentTurnTerminalSignalReceived: false,
        sessionIdle: false,
        sessionError: 'network error',
        genericError: CLASSIFIED_ERROR,
        classificationPath: 'fallback',
      }
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

      // #when — a delayed continuation (e.g. a later SSE event) mutates the same tracker object
      // after this producer has already settled and returned
      activityTracker.terminalProviderError = {
        type: 'provider_auth_error',
        message: 'later provider failure',
        retryable: false,
      }
      activityTracker.classificationPath = 'structured'

      // #then — the already-returned observation's snapshot is untouched
      expect(observation.failures[0]?.llmError).toBe(CLASSIFIED_ERROR)
      expect(observation.failures[0]?.classificationPath).toBe('fallback')
      expect(observation.failures[0]?.source).toBe('session')
    })
  })
})

/**
 * Finding: `completionObservation()` hardcoded `failures: []`, so a completion decision reached
 * after an awaited request (`session.messages()` in `detectMessageActivity`, `session.status()`
 * in the idle-via-polling branch) could win with an empty snapshot even when the SSE processor
 * recorded a real failure on the shared tracker while that request was in flight -- reported as
 * success, silently swallowing the failure. The fix makes `activityTracker` a required parameter
 * of every observation constructor that can carry evidence, so a producer cannot omit the
 * snapshot and compile. Every test below has an explicit complement proving the mirror case does
 * NOT trip the same assertion, per the two prior one-sided review rounds on this exact module.
 */
/**
 * A `session.messages()` mock whose first call resolves immediately with the stable assistant
 * message (arming `detectMessageActivity`'s two-poll stability check), and whose second call
 * returns a promise the test controls directly -- simulating that request being in flight while
 * the SSE processor concurrently mutates `activityTracker`.
 */
function pendingMessagesClient(stableInfo: Record<string, unknown>) {
  let callCount = 0
  let resolveSecond: ((value: {data: unknown[]}) => void) | undefined
  const messagesFn = vi.fn().mockImplementation(async () => {
    callCount++
    if (callCount === 1) return {data: [{info: stableInfo}]}
    return new Promise<{data: unknown[]}>(resolve => {
      resolveSecond = resolve
    })
  })
  const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})
  return {
    client: {session: {messages: messagesFn, status: statusFn}},
    resolveSecond: async (): Promise<void> => {
      resolveSecond?.({data: [{info: stableInfo}]})
    },
  }
}

/**
 * A `session.status()` mock whose first call resolves `busy`, and whose second call returns a
 * promise the test controls directly -- simulating that request being in flight while the SSE
 * processor concurrently mutates `activityTracker`.
 */
function pendingStatusClient() {
  let callCount = 0
  let resolveSecond: ((value: {data: Record<string, {type: string}>}) => void) | undefined
  const statusFn = vi.fn().mockImplementation(async () => {
    callCount++
    if (callCount === 1) return {data: {ses_123: {type: 'busy'}}}
    return new Promise<{data: Record<string, {type: string}>}>(resolve => {
      resolveSecond = resolve
    })
  })
  return {
    client: {session: {status: statusFn}},
    resolveSecond: async (): Promise<void> => {
      resolveSecond?.({data: {ses_123: {type: 'idle'}}})
    },
  }
}

describe('completion-observed snapshots pending failure evidence at the decision point (session-poll false-success finding)', () => {
  let mockLogger: Logger

  const TERMINAL_PROVIDER_ERROR: ErrorInfo = {
    type: 'provider_auth_error',
    message: 'auth rejected mid-poll',
    retryable: false,
  }
  const GENERIC_SESSION_ERROR: ErrorInfo = {
    type: 'llm_fetch_error',
    message: 'classified session failure',
    retryable: true,
  }

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('provider failure delivered while session.messages() is in flight wins reduction — never success', async () => {
    // #given a completed-assistant message stable across two polls, with the confirming second
    // session.messages() request held in flight
    vi.useFakeTimers()
    const {client, resolveSecond} = pendingMessagesClient({id: 'msg_new', role: 'assistant', time: {completed: 2}})
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      baselineMessageIds: new Set(),
      sessionIdle: false,
      sessionError: null,
    }
    const observationPromise = pollForSessionCompletionObservation(
      client as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(500)
    expect(activityTracker.completedAssistantMessageId).toBe('msg_new')
    await vi.advanceTimersByTimeAsync(500)

    // #when an SSE-accepted provider failure lands on the tracker while that request is pending,
    // then the request resolves with the same stable message
    activityTracker.terminalProviderError = TERMINAL_PROVIDER_ERROR
    await resolveSecond()
    const observation = await observationPromise

    // #then the completion decision still fires (the cause is what stopped observation) but its
    // snapshot carries the failure, so reduction never reports success
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(observation.failures).toHaveLength(1)
    expect(observation.failures[0]?.llmError).toBe(TERMINAL_PROVIDER_ERROR)
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(false)
    expect(reduced.outcome).toBe('turn_failed_terminal')
  })

  it('complement: no failure delivered while session.messages() is in flight still reduces to success', async () => {
    // #given the identical stable-message setup, but nothing lands on the tracker while the
    // confirming request is pending
    vi.useFakeTimers()
    const {client, resolveSecond} = pendingMessagesClient({id: 'msg_new', role: 'assistant', time: {completed: 2}})
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      baselineMessageIds: new Set(),
      sessionIdle: false,
      sessionError: null,
    }
    const observationPromise = pollForSessionCompletionObservation(
      client as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)

    // #when the in-flight request resolves with no failure ever having landed on the tracker
    await resolveSecond()
    const observation = await observationPromise

    // #then completion reduces to success, exactly as a clean run does today
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(observation.failures).toEqual([])
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(true)
    expect(reduced.outcome).toBe('completed')
  })

  it('a generic session failure delivered while session.status() is in flight wins reduction — never success', async () => {
    // #given the sticky terminal flags already set (so the idle-via-polling branch is admitted),
    // and the confirming session.status() request held in flight
    vi.useFakeTimers()
    const {client, resolveSecond} = pendingStatusClient()
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: false,
      sessionError: null,
    }
    const observationPromise = pollForSessionCompletionObservation(
      client as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)

    // #when an SSE-observed generic session failure lands on the tracker while that request is
    // pending, then the request resolves idle
    activityTracker.sessionError = 'LLM fetch failed'
    activityTracker.genericError = GENERIC_SESSION_ERROR
    activityTracker.classificationPath = 'fallback'
    await resolveSecond()
    const observation = await observationPromise

    // #then the completion decision still fires, but its snapshot carries the failure
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(observation.failures).toHaveLength(1)
    expect(observation.failures[0]?.llmError).toBe(GENERIC_SESSION_ERROR)
    expect(observation.failures[0]?.classificationPath).toBe('fallback')
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(false)
    expect(reduced.outcome).toBe('turn_failed_retryable')
  })

  it('complement: no failure delivered while session.status() is in flight still reduces to success', async () => {
    // #given the identical sticky-flag setup, but nothing lands on the tracker while the
    // confirming request is pending
    vi.useFakeTimers()
    const {client, resolveSecond} = pendingStatusClient()
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: false,
      sessionError: null,
    }
    const observationPromise = pollForSessionCompletionObservation(
      client as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)

    // #when the in-flight request resolves idle with no failure ever having landed
    await resolveSecond()
    const observation = await observationPromise

    // #then completion reduces to success, exactly as a clean run does today
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(observation.failures).toEqual([])
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(true)
    expect(reduced.outcome).toBe('completed')
  })

  it('precedence: a terminal provider failure outranks a concurrently-present generic session failure in the completion snapshot', async () => {
    // #given both a generic session failure already recorded AND a terminal provider failure
    // landing while session.messages() is in flight -- pinning that the completion snapshot
    // applies the same provider-over-session precedence as every other producer in this module
    vi.useFakeTimers()
    const {client, resolveSecond} = pendingMessagesClient({id: 'msg_new', role: 'assistant', time: {completed: 2}})
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      baselineMessageIds: new Set(),
      sessionIdle: false,
      sessionError: null,
      genericError: GENERIC_SESSION_ERROR,
      classificationPath: 'fallback',
    }
    const observationPromise = pollForSessionCompletionObservation(
      client as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)

    // #when a terminal provider failure lands on the tracker while the confirming request is
    // pending, then the request resolves with the same stable message. `sessionError` (the
    // string that would trip this module's own grace-cycle continue branch) is deliberately left
    // unset here -- this test isolates the completion snapshot's own provider-over-session
    // precedence, not the grace-cycle path already covered elsewhere in this file.
    activityTracker.terminalProviderError = TERMINAL_PROVIDER_ERROR
    await resolveSecond()
    const observation = await observationPromise

    // #then the snapshot carries only the provider failure — the earlier generic one is
    // superseded, matching `getObservedFailure`'s own precedence and `mergeActivityError`'s
    // terminal-supersedes-generic behavior
    expect(observation.failures).toHaveLength(1)
    expect(observation.failures[0]?.llmError).toBe(TERMINAL_PROVIDER_ERROR)
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(false)
    expect(reduced.outcome).toBe('turn_failed_terminal')
    expect(reduced.llmError).toBe(TERMINAL_PROVIDER_ERROR)
  })

  it('immutability: a failure delivered after the completion decision does not retroactively enter the returned snapshot', async () => {
    // #given a completion observation that already settled with no failure present
    vi.useFakeTimers()
    const {client, resolveSecond} = pendingMessagesClient({id: 'msg_new', role: 'assistant', time: {completed: 2}})
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      baselineMessageIds: new Set(),
      sessionIdle: false,
      sessionError: null,
    }
    const observationPromise = pollForSessionCompletionObservation(
      client as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)
    await resolveSecond()
    const observation = await observationPromise
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(observation.failures).toEqual([])

    // #when a delayed continuation (e.g. a later SSE event) mutates the same tracker object after
    // this producer has already settled and returned
    activityTracker.terminalProviderError = TERMINAL_PROVIDER_ERROR

    // #then the already-returned observation's snapshot is untouched
    expect(observation.failures).toEqual([])
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(true)
  })
})

/**
 * Finding: `deadlineObservation()`, `cancelledObservation()`, and `watchdogObservation()`
 * hardcoded `failures: []` -- unlike `completionObservation()`/`sessionFailureObservation()`,
 * they took no `activityTracker` and could never snapshot pending evidence. A generic session
 * error sitting on the tracker (e.g. still inside `ERROR_GRACE_CYCLES`) was silently discarded
 * whenever one of these three fired first, and `reduceAttemptOutcome` fell through to
 * `settlementFallback`'s generic diagnostic -- the exact "expiry replaced the known error with a
 * generic timeout" defect this restructure exists to close. The fix gives all three the same
 * required-tracker snapshot treatment `completionObservation` already has, without changing the
 * settlement cause itself. Every test below has an explicit complement proving the mirror case
 * does NOT trip the same assertion.
 */
describe('deadline/cancelled/watchdog snapshot pending failure evidence at settlement (evidence-erasure fix)', () => {
  let mockLogger: Logger

  const GENERIC_SESSION_ERROR: ErrorInfo = {
    type: 'llm_fetch_error',
    message: 'classified session failure',
    retryable: true,
  }
  const TERMINAL_PROVIDER_ERROR: ErrorInfo = {
    type: 'provider_auth_error',
    message: 'auth rejected',
    retryable: false,
  }

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('deadline: a generic session error pending on the tracker is reported, not a generic timeout, and the settlement stays "deadline"', async () => {
    // #given a generic session error already recorded on the tracker (mirrors mergeActivityError's
    // coupling of sessionError + genericError), and a deadline that is already expired
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: 'network error',
      genericError: GENERIC_SESSION_ERROR,
      classificationPath: 'fallback',
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
      fakeExpiredDeadline(),
    )

    // #then the cause is still deadline, but the pending failure is reported instead of the
    // generic settlementFallback diagnostic
    expect(observation.settlement.kind).toBe('deadline')
    expect(observation.failures).toHaveLength(1)
    expect(observation.failures[0]?.source).toBe('session')
    expect(observation.failures[0]?.llmError).toBe(GENERIC_SESSION_ERROR)
    expect(observation.failures[0]?.classificationPath).toBe('fallback')
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(false)
    expect(reduced.error).toBe('classified session failure')
    expect(reduced.llmError).toBe(GENERIC_SESSION_ERROR)
    expect(reduced.settlement.kind).toBe('deadline')
  })

  it('complement: with genuinely no evidence, an expired deadline still produces the generic settlementFallback diagnostic', async () => {
    // #given no failure ever recorded on the tracker
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
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
      fakeExpiredDeadline(),
    )

    // #then settlementFallback stays reachable for the genuinely-no-evidence case
    expect(observation.settlement.kind).toBe('deadline')
    expect(observation.failures).toEqual([])
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(false)
    expect(reduced.outcome).toBe('timeout')
    expect(reduced.error).toBe('Attempt did not settle before the execution deadline')
    expect(reduced.llmError).toBeNull()
  })

  it('deadline: a terminal provider error still wins over a pending generic error, with classification intact', async () => {
    // #given both a pending generic error and an already-accepted terminal provider error on the
    // tracker, with the deadline also already expired
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: 'network error',
      genericError: GENERIC_SESSION_ERROR,
      classificationPath: 'fallback',
      terminalProviderError: TERMINAL_PROVIDER_ERROR,
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
      fakeExpiredDeadline(),
    )

    // #then this is a deliberate producer policy: an already-accepted provider error wins the
    // settlement cause itself, not just the evidence
    expect(observation.settlement.kind).toBe('failure-observed')
    expect(observation.settlement.kind).not.toBe('deadline')
    expect(observation.failures).toEqual([
      {source: 'provider', message: TERMINAL_PROVIDER_ERROR.message, llmError: TERMINAL_PROVIDER_ERROR},
    ])
  })

  it('cancelled: a generic session error pending on the tracker is reported, not lost, when externally cancelled', async () => {
    // #given an already-aborted signal and a generic session error already recorded on the tracker
    const abortController = new AbortController()
    abortController.abort()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: 'network error',
      genericError: GENERIC_SESSION_ERROR,
      classificationPath: 'fallback',
    }

    // #when
    const observation = await pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
      30_000,
      activityTracker,
    )

    // #then
    expect(observation.settlement.kind).toBe('cancelled')
    expect(observation.failures).toHaveLength(1)
    expect(observation.failures[0]?.llmError).toBe(GENERIC_SESSION_ERROR)
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(false)
    expect(reduced.error).toBe('classified session failure')
    expect(reduced.settlement.kind).toBe('cancelled')
  })

  it('complement: with genuinely no evidence, external cancellation still produces the generic settlementFallback diagnostic', async () => {
    // #given an already-aborted signal and nothing ever recorded on the tracker
    const abortController = new AbortController()
    abortController.abort()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }

    // #when
    const observation = await pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
      30_000,
      activityTracker,
    )

    // #then settlementFallback stays reachable for the genuinely-no-evidence case
    expect(observation.settlement.kind).toBe('cancelled')
    expect(observation.failures).toEqual([])
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(false)
    expect(reduced.outcome).toBe('turn_failed_terminal')
    expect(reduced.error).toBe('Aborted')
    expect(reduced.llmError).toBeNull()
  })

  it('cancelled: a terminal provider error still wins over a pending generic error, with classification intact', async () => {
    // #given both a pending generic error and an already-accepted terminal provider error on the
    // tracker, with the signal also already aborted
    const abortController = new AbortController()
    abortController.abort()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: 'network error',
      genericError: GENERIC_SESSION_ERROR,
      classificationPath: 'fallback',
      terminalProviderError: TERMINAL_PROVIDER_ERROR,
    }

    // #when
    const observation = await pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
      30_000,
      activityTracker,
    )

    // #then
    expect(observation.settlement.kind).toBe('failure-observed')
    expect(observation.settlement.kind).not.toBe('cancelled')
    expect(observation.failures).toEqual([
      {source: 'provider', message: TERMINAL_PROVIDER_ERROR.message, llmError: TERMINAL_PROVIDER_ERROR},
    ])
  })

  it('watchdog: a generic error pending on the tracker is reported, not lost, when the local poll timeout fires', async () => {
    // #given a structured failure recorded on the tracker (`genericError`), captured here with
    // `sessionError: null` to isolate the watchdog's own snapshot from the separate
    // ERROR_GRACE_CYCLES continuation path (already covered above and in the completion-observed
    // block) -- once the raw `sessionError` string is set, the grace-cycle branch always
    // `continue`s ahead of the watchdog check, matching the existing precedence test's shape
    // (`sessionError: null` + `genericError` set) elsewhere in this file.
    vi.useFakeTimers()
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
      genericError: GENERIC_SESSION_ERROR,
      classificationPath: 'fallback',
    }

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(2_000)
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('watchdog')
    expect(observation.failures).toHaveLength(1)
    expect(observation.failures[0]?.llmError).toBe(GENERIC_SESSION_ERROR)
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(false)
    expect(reduced.error).toBe('classified session failure')
    expect(reduced.settlement.kind).toBe('watchdog')
  })

  it('complement: with genuinely no evidence, the local poll timeout still produces the generic settlementFallback diagnostic', async () => {
    // #given no failure ever recorded, no shared deadline, so the local poll budget is authoritative
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

    // #then settlementFallback stays reachable for the genuinely-no-evidence case
    expect(observation.settlement.kind).toBe('watchdog')
    expect(observation.failures).toEqual([])
    assertWatchdogSettlement(observation.settlement)
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(false)
    expect(reduced.outcome).toBe('turn_failed_terminal')
    expect(reduced.error).toBe(observation.settlement.message)
    expect(reduced.llmError).toBeNull()
  })

  it('watchdog: a terminal provider error still wins over a pending generic error, with classification intact', async () => {
    // #given both a pending generic error and an already-accepted terminal provider error present
    // from the very first poll iteration -- the top-of-loop terminal check wins before the
    // watchdog's elapsed-time check is ever reached
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
      genericError: GENERIC_SESSION_ERROR,
      classificationPath: 'fallback',
      terminalProviderError: TERMINAL_PROVIDER_ERROR,
    }

    // #when
    const observation = await pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_000,
      activityTracker,
    )

    // #then
    expect(observation.settlement.kind).toBe('failure-observed')
    expect(observation.settlement.kind).not.toBe('watchdog')
    expect(observation.failures).toEqual([
      {source: 'provider', message: TERMINAL_PROVIDER_ERROR.message, llmError: TERMINAL_PROVIDER_ERROR},
    ])
  })

  it('immutability: a failure arriving after a deadline settlement does not retroactively enter the returned snapshot', async () => {
    // #given a deadline settlement that already fired with no evidence present
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }

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
    expect(observation.settlement.kind).toBe('deadline')
    expect(observation.failures).toEqual([])

    // #when a delayed continuation (e.g. a later SSE event) mutates the same tracker object after
    // this producer has already settled and returned
    activityTracker.sessionError = 'network error'
    activityTracker.genericError = GENERIC_SESSION_ERROR

    // #then the already-returned observation's snapshot is untouched
    expect(observation.failures).toEqual([])
    const reduced = reduceAttemptOutcome(observation, null, {accepted: true})
    expect(reduced.success).toBe(false)
    expect(reduced.outcome).toBe('timeout')
  })
})
