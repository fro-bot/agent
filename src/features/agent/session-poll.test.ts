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
import type {AttemptObservation, AttemptSettlement, FailureObservation} from './attempt-outcome.js'
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
  toPollResult,
} from './session-poll.js'
import {
  armRootFreshness,
  createRootFreshnessTracker,
  invalidateRootFreshness,
  markRootIdleCandidate,
  registerPendingRootUserMessage,
  requireRootRevalidation,
  resolvePendingRootUserMessage,
} from './streaming.js'

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

  it('replaces: a stale idle-candidate is not revived by ledger drain once renewed root activity invalidated it — fresh idle after drain still completes', async () => {
    // #given the OLD defect: `sessionIdle`/`currentTurnTerminalSignalReceived` are sticky flags
    // that, once set, never reset — so any later ledger drain would resolve complete even if real
    // root activity happened in between (REST reporting `busy` the whole time, ignored either way,
    // since the event-idle shortcut never consulted it). `rootFreshness` closes this: idle evidence
    // is stamped with a revision, and any renewed root activity invalidates it, so a ledger drain
    // after that renewed activity must NOT be treated as authorizing the stale candidate.
    vi.useFakeTimers()
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'background task')
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})
    const mockClient = {session: {status: statusFn}}
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    markRootIdleCandidate(rootFreshness)
    // Renewed root activity after the idle mark — a real run would see this via a subsequent
    // event (a new tool call, text delta, or an injected parent turn); simulated directly here.
    invalidateRootFreshness(rootFreshness)
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: true,
      sessionError: null,
      rootFreshness,
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

    // #when the outstanding work settles — under the old defect this alone would resolve complete
    ledger.settle('ses_child')
    await vi.advanceTimersByTimeAsync(1_500)

    // #then it has NOT resolved — the stale idle-candidate (invalidated by renewed activity) is
    // never accepted, proven by the poll continuing to run
    expect(statusFn.mock.calls.length).toBeGreaterThan(1)

    // #when the root genuinely goes idle again (fresh candidate at the current revision)
    markRootIdleCandidate(rootFreshness)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pollPromise

    // #then — complement: a legitimate fresh completion still succeeds once drained
    expect(result.completed).toBe(true)
    expect(result.error).toBeNull()
  })

  it('replaces: the message-fallback candidate requires status corroboration and a qualified tuple, not just a stable completed assistant', async () => {
    // #given the OLD defect: `detectMessageActivity` treated ANY completed-assistant message
    // (missing `finish`/`parentID`, and never checked against `session.status()`) as terminal —
    // so a stable message alone completed the run even while REST kept reporting `busy` the whole
    // time. The fix requires `finish` (not `tool-calls`/`unknown`) plus REST status corroboration
    // (idle or absent) before a candidate is admitted, in addition to the pre-existing ownership
    // ledger gate this unit targets.
    vi.useFakeTimers()
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'background task')
    const messagesFn = vi.fn().mockResolvedValue({
      data: [
        {
          info: {id: 'msg_new', role: 'assistant', time: {created: 1, completed: 2}, finish: 'stop'},
        },
      ],
    })
    // REST reports busy for the whole run — under the fix this must block admission regardless of
    // ledger state, since status no longer corroborates inactivity.
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
    // check requires
    await vi.advanceTimersByTimeAsync(1_000)
    const callsAtStability = messagesFn.mock.calls.length
    expect(callsAtStability).toBeGreaterThanOrEqual(2)
    // #then — unlike the old behavior, the terminal flag is NOT mutated by the message-fallback
    // candidate alone; only actual admission (status-corroborated, ledger-drained) sets it
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)

    // #when the outstanding work settles, but REST still reports busy
    ledger.settle('ses_child')
    await vi.advanceTimersByTimeAsync(1_500)

    // #then it still has NOT resolved — status never corroborated inactivity
    expect(messagesFn.mock.calls.length).toBeGreaterThan(callsAtStability)

    // #when status finally reports idle
    statusFn.mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pollPromise

    // #then — complement: a legitimate, fully-qualified, status-corroborated completion succeeds
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
    // #given a completed assistant message stable across the two polls the check requires,
    // qualified with `finish` and corroborated by an idle status
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [{info: {id: 'msg_new', role: 'assistant', time: {created: 1, completed: 2}, finish: 'stop'}}],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
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
    // #given the identical qualified stable-message setup, but the deadline is already expired
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [{info: {id: 'msg_new', role: 'assistant', time: {created: 1, completed: 2}, finish: 'stop'}}],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
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
    // async session.messages() request and the corroborating session.status() request have
    // already run
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

    // #then — the qualified candidate was found and status-corroborated, but admission itself is
    // rejected because the deadline had already expired at the decision point; the terminal flag
    // (Phase B) is reserved for actual admission, never mutated by the candidate alone
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)
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
  // Idle, not busy: the qualified-tuple predicate (Phase B) requires status to corroborate
  // inactivity before a message-fallback candidate can be admitted, so these fixtures represent a
  // session that has genuinely finished -- matching `stableInfo`'s own `finish`/`time.completed`.
  const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
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
    const {client, resolveSecond} = pendingMessagesClient({
      id: 'msg_new',
      role: 'assistant',
      time: {completed: 2},
      finish: 'stop',
      parentID: 'msg_parent',
    })
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
    const {client, resolveSecond} = pendingMessagesClient({
      id: 'msg_new',
      role: 'assistant',
      time: {completed: 2},
      finish: 'stop',
      parentID: 'msg_parent',
    })
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
    const {client, resolveSecond} = pendingMessagesClient({
      id: 'msg_new',
      role: 'assistant',
      time: {completed: 2},
      finish: 'stop',
      parentID: 'msg_parent',
    })
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
    const {client, resolveSecond} = pendingMessagesClient({
      id: 'msg_new',
      role: 'assistant',
      time: {completed: 2},
      finish: 'stop',
      parentID: 'msg_parent',
    })
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

/**
 * Non-blocking review finding on the approved background-subagent-ownership-plan PR:
 * `pollForSessionCompletion`'s `toPollResult` adapter mapped any `completion-observed`
 * settlement straight to `{completed: true, error: null}` *before* consulting the failure
 * snapshot the settlement carries. Since `completionObservation()` can now snapshot a real
 * failure recorded while an awaited request was in flight (see the block above,
 * "completion-observed snapshots pending failure evidence..."), the legacy adapter could report
 * success for a completion that carries a genuine provider or session failure. There are no
 * production callers of the adapter today (`retry.ts` moved to
 * `pollForSessionCompletionObservation`), but 31 existing tests exercise it and any future
 * caller would get a silently wrong answer. The fix: `toPollResult` now consults the failure
 * snapshot first, mapping a failure-bearing completion the same way it maps a `failure-observed`
 * settlement — via `selectAdapterFailure`'s provider-over-session precedence. The settlement
 * cause itself (`completion-observed`) is untouched; only this legacy projection changed.
 */
describe('pollForSessionCompletion adapter does not report success for a completion that carries a failure', () => {
  let mockLogger: Logger

  const TERMINAL_PROVIDER_ERROR: ErrorInfo = {
    type: 'provider_auth_error',
    message: 'auth rejected mid-poll (adapter fixture)',
    retryable: false,
  }
  const GENERIC_SESSION_ERROR: ErrorInfo = {
    type: 'llm_fetch_error',
    message: 'classified session failure (adapter fixture)',
    retryable: true,
  }

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a provider failure delivered while session.messages() is in flight is reported by the adapter, not swallowed as success', async () => {
    // #given the identical race as the modern-API fixture above: a stable completed-assistant
    // message with the confirming second session.messages() request held in flight
    vi.useFakeTimers()
    const {client, resolveSecond} = pendingMessagesClient({
      id: 'msg_new',
      role: 'assistant',
      time: {completed: 2},
      finish: 'stop',
      parentID: 'msg_parent',
    })
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      baselineMessageIds: new Set(),
      sessionIdle: false,
      sessionError: null,
    }
    const resultPromise = pollForSessionCompletion(
      client as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_000)

    // #when an SSE-accepted provider failure lands on the tracker while that request is pending
    activityTracker.terminalProviderError = TERMINAL_PROVIDER_ERROR
    await resolveSecond()
    const result = await resultPromise

    // #then the legacy `{completed, error}` shape must report the failure, not success
    expect(result.completed).toBe(false)
    expect(result.error).toBe(TERMINAL_PROVIDER_ERROR.message)
  })

  it('same fixture through the modern API: settlement stays completion-observed and the failure snapshot carries the provider error', async () => {
    // #given the identical race, run through `pollForSessionCompletionObservation` directly —
    // this pins that fixing the adapter did not move or weaken the settlement cause itself
    vi.useFakeTimers()
    const {client, resolveSecond} = pendingMessagesClient({
      id: 'msg_new',
      role: 'assistant',
      time: {completed: 2},
      finish: 'stop',
      parentID: 'msg_parent',
    })
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
    await vi.advanceTimersByTimeAsync(1_000)
    activityTracker.terminalProviderError = TERMINAL_PROVIDER_ERROR
    await resolveSecond()
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(observation.failures).toHaveLength(1)
    expect(observation.failures[0]?.llmError).toBe(TERMINAL_PROVIDER_ERROR)
  })

  it('a generic session failure delivered while session.status() is in flight is reported by the adapter, not swallowed as success', async () => {
    // #given the sticky terminal flags already set, and the confirming session.status() request
    // held in flight
    vi.useFakeTimers()
    const {client, resolveSecond} = pendingStatusClient()
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: true,
      sessionIdle: false,
      sessionError: null,
    }
    const resultPromise = pollForSessionCompletion(
      client as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_000)

    // #when an SSE-observed generic session failure lands on the tracker while that request is
    // pending, then the request resolves idle
    activityTracker.sessionError = 'LLM fetch failed'
    activityTracker.genericError = GENERIC_SESSION_ERROR
    activityTracker.classificationPath = 'fallback'
    await resolveSecond()
    const result = await resultPromise

    // #then
    expect(result.completed).toBe(false)
    expect(result.error).toBe(GENERIC_SESSION_ERROR.message)
  })

  it('same fixture through the modern API: settlement stays completion-observed and the failure snapshot carries the session error', async () => {
    // #given the identical race, run through `pollForSessionCompletionObservation` directly
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
    await vi.advanceTimersByTimeAsync(1_000)
    activityTracker.sessionError = 'LLM fetch failed'
    activityTracker.genericError = GENERIC_SESSION_ERROR
    activityTracker.classificationPath = 'fallback'
    await resolveSecond()
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(observation.failures).toHaveLength(1)
    expect(observation.failures[0]?.llmError).toBe(GENERIC_SESSION_ERROR)
  })

  it('precedence: a synthetic completion snapshot carrying both a provider and a session failure projects the provider message, matching reduceAttemptOutcome', () => {
    // #given a completion observation whose failure snapshot carries both sources at once — not
    // reachable through the real constructors in this module (they only ever snapshot a single
    // failure, already precedence-resolved by `getObservedFailure`), but exercised directly here
    // to pin that the adapter's own precedence rule matches `selectWinningFailure` in
    // attempt-outcome.ts rather than relying on array order
    const sessionFailure: FailureObservation = {
      source: 'session',
      message: 'session-sourced message should lose',
      llmError: GENERIC_SESSION_ERROR,
    }
    const providerFailure: FailureObservation = {
      source: 'provider',
      message: TERMINAL_PROVIDER_ERROR.message,
      llmError: TERMINAL_PROVIDER_ERROR,
    }
    const observation: AttemptObservation = {
      settlement: {kind: 'completion-observed'},
      failures: [sessionFailure, providerFailure],
    }

    // #when
    const result = toPollResult(observation)

    // #then
    expect(result).toEqual({completed: false, error: TERMINAL_PROVIDER_ERROR.message})
  })

  it('complement: a clean completion with no failures still projects to {completed: true, error: null}', () => {
    // #given a completion observation with an empty failure snapshot — the ordinary, successful
    // case this adapter must keep working exactly as before
    const observation: AttemptObservation = {
      settlement: {kind: 'completion-observed'},
      failures: [],
    }

    // #when
    const result = toPollResult(observation)

    // #then
    expect(result).toEqual({completed: true, error: null})
  })
})

function qualifiedPredicateBaseActivityTracker(): ActivityTracker {
  return {
    firstMeaningfulEventReceived: false,
    currentTurnTerminalSignalReceived: false,
    baselineMessageIds: new Set(),
    sessionIdle: false,
    sessionError: null,
  }
}

describe('detectMessageActivity qualified-tuple predicate (Phase B)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("a stable assistant with finish 'tool-calls' never completes — the prompt loop would still run another iteration", async () => {
    // #given a completed-looking assistant message stable across polls, but finish is 'tool-calls'
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [{info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'tool-calls'}}],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then it times out rather than reporting a false completion
    expect(observation.settlement.kind).toBe('watchdog')
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)
  })

  it("a stable assistant with finish 'unknown' never completes", async () => {
    // #given
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [{info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'unknown'}}],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('watchdog')
  })

  it('a stable assistant missing finish entirely never completes', async () => {
    // #given — the exact fixture shape that used to be sufficient before Phase B
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [{info: {id: 'msg_new', role: 'assistant', time: {completed: 2}}}],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('watchdog')
  })

  it('a completed stop finish with a still-running tool part never completes — a non-provider-executed continuation is pending', async () => {
    // #given finish is 'stop' but a tool part is still 'running' — the loop has not actually finished
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [
        {
          info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop'},
          parts: [{type: 'tool', state: {status: 'running'}}],
        },
      ],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('watchdog')
  })

  it('a completed stop finish with a still-pending tool part never completes — a non-provider-executed continuation is pending', async () => {
    // #given finish is 'stop' but a tool part is still 'pending' — symmetric with the 'running'
    // case above; upstream does not distinguish pending from running here
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [
        {
          info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop'},
          parts: [{type: 'tool', state: {status: 'pending'}}],
        },
      ],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('watchdog')
  })

  it('a completed stop finish with a completed, non-provider-executed tool part never completes — the model has not received the result yet (upstream divergence #1)', async () => {
    // #given upstream (packages/opencode/src/session/prompt.ts hasToolCalls) does not filter on
    // tool part status at all — a *completed* tool part still requires another prompt-loop
    // iteration unless it is provider-executed or an orphaned interrupted tool. Admitting
    // completion here would be the premature-completion defect class this subsystem exists to close.
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [
        {
          info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop'},
          parts: [{type: 'tool', state: {status: 'completed'}}],
        },
      ],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('watchdog')
  })

  it('complement: a completed stop finish with only a provider-executed tool part DOES complete', async () => {
    // #given a completed tool part carrying metadata.providerExecuted: true — the model never
    // needs this result back, so it is not a continuation requirement regardless of status
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [
        {
          info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop'},
          parts: [{type: 'tool', state: {status: 'completed'}, metadata: {providerExecuted: true}}],
        },
      ],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

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

  it('a pending, provider-executed tool part does NOT block completion — status is irrelevant once providerExecuted is true (upstream divergence #3)', async () => {
    // #given a 'pending' tool part, but metadata.providerExecuted is true — upstream's hasToolCalls
    // excludes provider-executed parts entirely, regardless of status. The old rule refused this
    // (a false refusal, pushing a legitimate completion to the watchdog).
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [
        {
          info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop'},
          parts: [{type: 'tool', state: {status: 'pending'}, metadata: {providerExecuted: true}}],
        },
      ],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

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

  it('a completed stop finish with an error tool part lacking interrupted: true never completes (upstream divergence #2)', async () => {
    // #given an 'error' status tool part with no metadata.interrupted flag at all — this is NOT
    // the orphaned-interrupted-tool case cleanup() produces; upstream's isOrphanedInterruptedTool
    // requires interrupted === true specifically, so this part still counts toward hasToolCalls
    // and still requires another prompt-loop iteration. The old rule treated any 'error' status as
    // resolved, which swallowed this non-orphan case by accident.
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [
        {
          info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop'},
          parts: [{type: 'tool', state: {status: 'error'}}],
        },
      ],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then
    expect(observation.settlement.kind).toBe('watchdog')
  })

  it('complement: a completed stop finish with an error tool part carrying state.metadata.interrupted === true DOES complete', async () => {
    // #given the actual orphaned-interrupted-tool shape cleanup() produces: 'error' status AND
    // state.metadata.interrupted === true. This is not pending work and must not block completion.
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [
        {
          info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop'},
          parts: [{type: 'tool', state: {status: 'error', metadata: {interrupted: true}}}],
        },
      ],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

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
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
  })

  it.each([
    ['missing state entirely', {type: 'tool'}],
    ['error status with missing metadata', {type: 'tool', state: {status: 'error'}}],
    [
      'error status with interrupted present but not strictly true',
      {type: 'tool', state: {status: 'error', metadata: {interrupted: 'true'}}},
    ],
    ['error status with interrupted false', {type: 'tool', state: {status: 'error', metadata: {interrupted: false}}}],
  ])(
    'a malformed or partial tool part (%s) does not qualify as an orphan and still blocks completion',
    async (_label, malformedPart) => {
      // #given the orphan check is the permissive branch, so any ambiguity in the wire payload
      // must fall on the side of NOT qualifying as an orphan — a missing/malformed field must not
      // accidentally admit a premature completion
      vi.useFakeTimers()
      const messagesFn = vi.fn().mockResolvedValue({
        data: [
          {
            info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop'},
            parts: [malformedPart],
          },
        ],
      })
      const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
      const mockClient = {session: {messages: messagesFn, status: statusFn}}
      const activityTracker = qualifiedPredicateBaseActivityTracker()

      // #when
      const observationPromise = pollForSessionCompletionObservation(
        mockClient as unknown as MockClient,
        'ses_123',
        '/workspace',
        new AbortController().signal,
        mockLogger,
        1_200,
        activityTracker,
      )
      await vi.advanceTimersByTimeAsync(1_500)
      const observation = await observationPromise

      // #then
      expect(observation.settlement.kind).toBe('watchdog')
    },
  )

  it('an assistant message with no tool parts at all still completes', async () => {
    // #given finish is 'stop' and the parts array carries no tool parts at all — the baseline case
    // where the continuation check degrades to a no-op
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [
        {
          info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop'},
          parts: [{type: 'text', text: 'done'}],
        },
      ],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

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
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
  })

  it('an assistant message carrying its own error field settles as a classified failure, not a generic timeout', async () => {
    // #given a completed-looking assistant message whose `error` field reports a provider auth
    // failure — this must be classified through the same bounded precedence as SSE session.error,
    // not dropped and left to time out generically
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [
        {
          info: {
            id: 'msg_new',
            role: 'assistant',
            time: {completed: 2},
            finish: 'error',
            error: {name: 'ProviderAuthError', message: 'invalid api key'},
          },
        },
      ],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

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

    // #then — a failure, immediately, never a completion and never a generic watchdog timeout
    expect(observation.settlement.kind).toBe('failure-observed')
    expect(observation.failures).toHaveLength(1)
    expect(observation.failures[0]?.llmError).not.toBeNull()
  })

  it('busy status invalidates a prior message-fallback candidate even though it carries no classifiable failure', async () => {
    // #given a qualified stable candidate, but the CORROBORATING status poll comes back busy on
    // this iteration and idle only afterward — renewed activity must invalidate the candidate
    vi.useFakeTimers()
    let statusCall = 0
    const messagesFn = vi.fn().mockResolvedValue({
      data: [{info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop'}}],
    })
    const statusFn = vi.fn().mockImplementation(async () => {
      statusCall++
      // Busy for the first several polls (covering both the stability-confirming poll and the
      // first corroboration attempt), idle afterward.
      return {data: {ses_123: {type: statusCall <= 3 ? 'busy' : 'idle'}}}
    })
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

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
    await vi.advanceTimersByTimeAsync(3_000)
    const observation = await observationPromise

    // #then it eventually completes once status genuinely corroborates inactivity, but not before
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(statusCall).toBeGreaterThan(3)
  })
})

/**
 * Coverage gap closed per code review: three qualified-tuple-adjacent guards had no test pinning
 * that removing them changes behavior.
 *  - `session-poll.ts:655/665-668` (the status-revision guard): captured before issuing the
 *    corroborating `session.status()` request, so renewed root activity observed while that
 *    request is in flight must invalidate the response even though the response itself reports
 *    idle. Previously only exercised before any request started (`retry.test.ts`) or via the
 *    sticky-flag idle path (`pendingStatusClient` above), never through the message-fallback
 *    candidate this guard actually protects.
 *  - `session-poll.ts:453-466` (the pending-parent barrier): previously only exercised via the
 *    tracker's own unit tests (`streaming.test.ts`), never through the real poll path.
 *  - The `session.status()`-rejects-with-a-qualified-candidate combination: the only status
 *    rejection test (`session-poll.test.ts:611`) ran with no qualified candidate present.
 */

/**
 * A `session.messages()` mock that resolves the same stable qualified assistant message on every
 * call (arming `detectMessageActivity`'s two-poll stability check), paired with a `session.status()`
 * mock whose first call resolves `busy` and whose second call returns a promise the test controls
 * directly — the same in-flight shape as `pendingStatusClient` above, but paired with a
 * message-fallback candidate so the status-revision guard at session-poll.ts:655 can be exercised
 * through the real poll path instead of only the sticky-flag idle path.
 */
function pendingStatusClientWithStableCandidate(stableInfo: Record<string, unknown>) {
  const messagesFn = vi.fn().mockResolvedValue({data: [{info: stableInfo}]})
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
    client: {session: {messages: messagesFn, status: statusFn}},
    resolveSecond: async (): Promise<void> => {
      resolveSecond?.({data: {ses_123: {type: 'idle'}}})
    },
  }
}

describe('root-freshness revision guard through the poll path (session-poll.ts:655)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('in-flight invalidation: renewed root activity while session.status() is pending refuses a candidate that would otherwise be admitted', async () => {
    // #given a qualified completed-assistant candidate stable across two polls, with the
    // corroborating session.status() request held in flight
    vi.useFakeTimers()
    const {client, resolveSecond} = pendingStatusClientWithStableCandidate({
      id: 'msg_new',
      role: 'assistant',
      time: {completed: 2},
      finish: 'stop',
      parentID: 'msg_parent',
    })
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    const activityTracker: ActivityTracker = {...qualifiedPredicateBaseActivityTracker(), rootFreshness}

    const observationPromise = pollForSessionCompletionObservation(
      client as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    let settled = false
    // eslint-disable-next-line no-void
    void observationPromise.then(() => {
      settled = true
    })
    // First poll: the message is observed (unconfirmed) and status reports busy, which itself
    // advances the revision — matching real event-driven invalidation.
    await vi.advanceTimersByTimeAsync(500)
    // Second poll: the same message confirms the candidate, and the corroborating status request
    // is issued and held pending.
    await vi.advanceTimersByTimeAsync(500)

    // #when renewed root activity is observed while that request is still in flight, then the
    // request resolves idle
    invalidateRootFreshness(rootFreshness)
    await resolveSecond()

    // #then the idle response is not honored on this cycle — completion is not admitted
    expect(settled).toBe(false)

    // #and the candidate never settles as completion-observed for this poll — it times out
    // instead of being silently retried into a later false admission
    await vi.advanceTimersByTimeAsync(500)
    const observation = await observationPromise
    expect(observation.settlement.kind).not.toBe('completion-observed')
    expect(observation.settlement.kind).toBe('watchdog')
  })

  it('complement: no renewed root activity while session.status() is pending still admits the same candidate', async () => {
    // #given the identical setup, but nothing invalidates freshness while the corroborating
    // request is pending
    vi.useFakeTimers()
    const {client, resolveSecond} = pendingStatusClientWithStableCandidate({
      id: 'msg_new',
      role: 'assistant',
      time: {completed: 2},
      finish: 'stop',
      parentID: 'msg_parent',
    })
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    const activityTracker: ActivityTracker = {...qualifiedPredicateBaseActivityTracker(), rootFreshness}

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

    // #when the in-flight request resolves idle with no renewed activity ever observed
    await resolveSecond()
    const observation = await observationPromise

    // #then completion is admitted, exactly as the non-racing case does
    expect(observation.settlement.kind).toBe('completion-observed')
  })
})

describe('pending-parent barrier through the poll path (session-poll.ts:453-466)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('the poll path resolves the barrier when it observes a candidate whose parentID matches the pending message, and completion proceeds (Findings 4/5)', async () => {
    // #given a candidate answering the pending parent message itself. Before Findings 4/5, the
    // barrier had no resolution path outside the (SSE-only) streaming path -- when SSE has dropped,
    // the poll path could observe this exact confirming reply and still refuse forever. The fix
    // reuses `resolvePendingRootUserMessage()` from inside `detectMessageActivity()` so the poll
    // path can clear the barrier itself.
    vi.useFakeTimers()
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    registerPendingRootUserMessage(rootFreshness, 'msg_pending')
    const messagesFn = vi.fn().mockResolvedValue({
      data: [{info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop', parentID: 'msg_pending'}}],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker: ActivityTracker = {...qualifiedPredicateBaseActivityTracker(), rootFreshness}

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

    // #then the barrier is resolved by the matching reply and completion is admitted, and the
    // barrier itself is left clear for any later evidence
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
    expect(rootFreshness.pendingParentMessageId).toBeNull()
  })

  it('complement: the barrier still blocks a plain status-idle admission (no message candidate) until the matching reply is actually observed', async () => {
    // #given no `session.messages()` available at all -- so `detectMessageActivity()` (and its new
    // resolution path) never runs -- but the terminal signal was already observed some other way
    // (e.g. an SSE `session.idle`), and `session.status()` corroborates idle. This isolates the
    // OUTER `pendingParentMessageId` check (session-poll.ts, on the plain-status-idle path) which
    // is the only guard left for this path once the barrier hasn't been resolved by anything
    vi.useFakeTimers()
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    registerPendingRootUserMessage(rootFreshness, 'msg_pending')
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {status: statusFn}}
    const activityTracker: ActivityTracker = {
      ...qualifiedPredicateBaseActivityTracker(),
      currentTurnTerminalSignalReceived: true,
      rootFreshness,
    }

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then it times out rather than admitting completion while the barrier remains unresolved
    expect(observation.settlement.kind).toBe('watchdog')
    expect(rootFreshness.pendingParentMessageId).toBe('msg_pending')
  })

  it('complement: once the pending-parent barrier is cleared, the same candidate is admitted', async () => {
    // #given the identical setup, but the barrier is resolved before polling begins
    vi.useFakeTimers()
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    registerPendingRootUserMessage(rootFreshness, 'msg_pending')
    resolvePendingRootUserMessage(rootFreshness, 'msg_pending')
    const messagesFn = vi.fn().mockResolvedValue({
      data: [{info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop', parentID: 'msg_pending'}}],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker: ActivityTracker = {...qualifiedPredicateBaseActivityTracker(), rootFreshness}

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

    // #then completion is admitted once the barrier no longer blocks it
    expect(observation.settlement.kind).toBe('completion-observed')
  })

  it('complement: a parentID that does not match the latest root user message is refused even with no pending barrier', async () => {
    // #given the barrier is clear, but the candidate answers a different (stale) parent than the
    // latest known root user message
    vi.useFakeTimers()
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    invalidateRootFreshness(rootFreshness, 'msg_actual_parent')
    const messagesFn = vi.fn().mockResolvedValue({
      data: [
        {
          info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop', parentID: 'msg_wrong_parent'},
        },
      ],
    })
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker: ActivityTracker = {...qualifiedPredicateBaseActivityTracker(), rootFreshness}

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then it times out rather than admitting completion for the wrong parent
    expect(observation.settlement.kind).toBe('watchdog')
  })
})

describe('session.status() rejection racing a qualified completed-assistant candidate (session-poll.test.ts:611 gap)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a stable qualified candidate does not admit completion when session.status() rejects — it keeps polling and completes only after a later successful corroboration', async () => {
    // #given a stable qualified completed-assistant message available on every poll, and
    // session.status() rejecting on its first call — an ordinary transport failure racing with an
    // otherwise-ready candidate
    vi.useFakeTimers()
    const messagesFn = vi.fn().mockResolvedValue({
      data: [{info: {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop', parentID: 'msg_parent'}}],
    })
    let statusCallCount = 0
    const statusFn = vi.fn().mockImplementation(async () => {
      statusCallCount++
      if (statusCallCount === 1) throw new Error('transient network error')
      return {data: {ses_123: {type: 'idle'}}}
    })
    const mockClient = {session: {messages: messagesFn, status: statusFn}}
    const activityTracker = qualifiedPredicateBaseActivityTracker()

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
    await vi.advanceTimersByTimeAsync(500)

    // #then the first poll observed the candidate (unconfirmed) and the racing status request
    // failed without settling anything
    expect(activityTracker.completedAssistantMessageId).toBe('msg_new')

    await vi.advanceTimersByTimeAsync(500)
    const observation = await observationPromise

    // #then it never resolved on the failed attempt — it kept polling and completed only once
    // session.status() corroborated inactivity on the following call
    expect(statusCallCount).toBe(2)
    expect(observation.settlement.kind).toBe('completion-observed')
  })
})

describe('Finding 1 — a delayed idle re-stamped as current requires REST corroboration', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a delayed idle arriving after a revision bump does not authorize completion until REST corroborates', async () => {
    // #given a root that already reported idle once (generation 1), then renewed activity bumped
    // the generation (an injected turn, or any other renewed root activity) -- superseding that
    // idle candidate. SSE carries no sequence number, so the idle re-observed for the new
    // generation cannot be distinguished from the stale generation-1 idle arriving late.
    vi.useFakeTimers()
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    markRootIdleCandidate(rootFreshness)
    invalidateRootFreshness(rootFreshness)
    // The delayed/re-arriving idle event gets re-stamped as belonging to the new generation.
    markRootIdleCandidate(rootFreshness)
    const activityTracker: ActivityTracker = {
      ...qualifiedPredicateBaseActivityTracker(),
      currentTurnTerminalSignalReceived: true,
      sessionIdle: true,
      rootFreshness,
    }
    // REST never corroborates this generation as idle (a real run would eventually see this
    // resolve, but this pins the gate while it doesn't).
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})
    const mockClient = {session: {status: statusFn}}

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then it times out rather than admitting completion for the unrevalidated idle
    expect(observation.settlement.kind).toBe('watchdog')
    expect(statusFn).toHaveBeenCalled()
  })

  it('complement: an idle arriving with no intervening bump still completes normally, with no extra corroboration required', async () => {
    // #given a single-generation turn: armed, then idle -- no prior idle candidate was ever
    // superseded, so `invalidateRootFreshness` never had reason to raise the revalidation
    // requirement. `session.status()` is wired to reject if called at all, proving the SSE fast
    // path admits completion without ever needing it.
    vi.useFakeTimers()
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    markRootIdleCandidate(rootFreshness)
    const activityTracker: ActivityTracker = {
      ...qualifiedPredicateBaseActivityTracker(),
      currentTurnTerminalSignalReceived: true,
      sessionIdle: true,
      rootFreshness,
    }
    const statusFn = vi.fn().mockRejectedValue(new Error('should not be called on the fast path'))
    const mockClient = {session: {status: statusFn}}

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
    await vi.advanceTimersByTimeAsync(500)
    const observation = await observationPromise

    // #then completion is admitted directly via the SSE-observed idle evidence
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(statusFn).not.toHaveBeenCalled()
  })
})

describe('REST corroboration clears the revalidation requirement (Findings 1/4/5)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a REST corroboration clears the revalidation requirement so a post-discontinuity run can still complete', async () => {
    // #given an SSE discontinuity already required revalidation (the pre-existing trigger for
    // `restConfirmationRequired`, e.g. a dropped observation channel) -- the terminal signal was
    // observed before the drop, but is not yet trusted
    vi.useFakeTimers()
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    markRootIdleCandidate(rootFreshness)
    requireRootRevalidation(rootFreshness)
    const activityTracker: ActivityTracker = {
      ...qualifiedPredicateBaseActivityTracker(),
      currentTurnTerminalSignalReceived: true,
      sessionIdle: true,
      rootFreshness,
    }
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {status: statusFn}}

    // #when a REST poll corroborates the current generation
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(500)
    const observation = await observationPromise

    // #then the run completes once REST corroborates, and the requirement is left clear
    expect(observation.settlement.kind).toBe('completion-observed')
    expect(rootFreshness.restConfirmationRequired).toBe(false)
  })

  it('complement: the requirement stays set until corroboration actually happens', async () => {
    // #given the identical post-discontinuity setup, but REST itself is also unavailable -- no
    // successful `session.status()` response ever arrives to corroborate anything
    vi.useFakeTimers()
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    markRootIdleCandidate(rootFreshness)
    requireRootRevalidation(rootFreshness)
    const activityTracker: ActivityTracker = {
      ...qualifiedPredicateBaseActivityTracker(),
      currentTurnTerminalSignalReceived: true,
      sessionIdle: true,
      rootFreshness,
    }
    const statusFn = vi.fn().mockRejectedValue(new Error('REST unavailable'))
    const mockClient = {session: {status: statusFn}}

    // #when
    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then it times out rather than admitting completion -- the requirement was never cleared
    expect(observation.settlement.kind).toBe('watchdog')
    expect(rootFreshness.restConfirmationRequired).toBe(true)
  })
})

describe("Finding 3 — the candidate's own revision is re-checked at final admission", () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a candidate observed before a bump is refused when admission happens after it, even when the status() request itself never raced anything', async () => {
    // #given a stable qualified candidate that reaches two-poll confirmation. Renewed root
    // activity is injected deterministically into the gap between `detectMessageActivity()`
    // returning the qualified candidate and the caller capturing `statusRequestRevision` a few
    // lines later, by intercepting reads of `rootFreshness.revision` and bumping on the first read
    // whose immediate caller is `pollForSessionCompletionObservation` itself (identified via the
    // call stack) rather than `detectMessageActivity` or `hasFreshIdleCandidate` -- that is
    // precisely the `statusRequestRevision = ...` line, so the bump lands strictly after the
    // candidate already qualified but strictly before that snapshot is taken. `session.status()`
    // itself is never in flight when the bump happens, and its own request-vs-response revision
    // comparison (`staleAgainstRenewedActivity`) sees no drift -- only the candidate's own carried
    // revision (Finding 3) proves this candidate is from the superseded generation.
    vi.useFakeTimers()
    const stableInfo = {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop', parentID: 'msg_parent'}
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    const activityTracker: ActivityTracker = {...qualifiedPredicateBaseActivityTracker(), rootFreshness}

    const messagesFn = vi.fn().mockResolvedValue({data: [{info: stableInfo}]})
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}

    const observationPromise = pollForSessionCompletionObservation(
      mockClient as unknown as MockClient,
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      1_200,
      activityTracker,
    )

    // First poll: the message is observed but not yet confirmed. `pollForSessionCompletionObservation`
    // itself also reads `.revision` once this poll (its own `statusRequestRevision` capture) --
    // arm the interception only afterward, so it targets the SECOND (confirming) poll's read.
    await vi.advanceTimersByTimeAsync(500)
    expect(activityTracker.completedAssistantMessageId).toBe('msg_new')

    let triggered = false
    let backing = rootFreshness.revision
    Object.defineProperty(rootFreshness, 'revision', {
      configurable: true,
      enumerable: true,
      get(): number {
        if (!triggered) {
          const callerLine = (new Error('stack-probe').stack ?? '').split('\n')[2] ?? ''
          if (
            callerLine.includes('pollForSessionCompletionObservation') &&
            !callerLine.includes('detectMessageActivity')
          ) {
            triggered = true
            invalidateRootFreshness(rootFreshness)
          }
        }
        return backing
      },
      set(value: number) {
        backing = value
      },
    })

    await vi.advanceTimersByTimeAsync(1_500)
    const observation = await observationPromise

    // #then the stale candidate is not admitted as a completion -- it times out rather than
    // being silently retried into a later false admission
    expect(observation.settlement.kind).toBe('watchdog')
    expect(triggered).toBe(true)
  })

  it('complement: a candidate with no bump between observation and admission is admitted', async () => {
    // #given the identical stable qualified candidate, with nothing invalidating freshness at any
    // point during confirmation or admission
    vi.useFakeTimers()
    const stableInfo = {id: 'msg_new', role: 'assistant', time: {completed: 2}, finish: 'stop', parentID: 'msg_parent'}
    const rootFreshness = createRootFreshnessTracker()
    armRootFreshness(rootFreshness)
    const activityTracker: ActivityTracker = {...qualifiedPredicateBaseActivityTracker(), rootFreshness}
    const messagesFn = vi.fn().mockResolvedValue({data: [{info: stableInfo}]})
    const statusFn = vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}})
    const mockClient = {session: {messages: messagesFn, status: statusFn}}

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
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)
    const observation = await observationPromise

    // #then completion is admitted exactly as the non-racing case does
    expect(observation.settlement.kind).toBe('completion-observed')
  })
})
