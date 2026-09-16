/**
 * Unit 9: gate every terminal path.
 *
 * `runPromptAttempt` (and the private `startV2SessionWait` it calls) own two
 * of the four independently-terminal paths named in the plan:
 *  - the v2 `session.wait()` success path
 *  - the early return after `collectEventResults()` when `promptStartResult
 *    != null` (the synchronous-completion path used when `startPrompt`
 *    itself resolves with a result, bypassing the poll/wait watchdog
 *    entirely) — found during research, not named in the origin requirements
 *
 * Existing characterization coverage for `runPromptAttempt` (arming, stream
 * teardown, the false-pass regression fixes, deadline handling) lives in
 * `opencode.test.ts` and is untouched by this unit — these tests only target
 * the new `ownershipLedger` gate, plus one integration test proving the
 * paths race safely together.
 */
import type {Event} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {AttemptResult} from './prompt-sender.js'
import type {ExecutionDeadline} from './retry.js'
import type {ErrorInfo} from './types.js'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'

// Default: v2 wait is unavailable so tests that don't explicitly mock it fall back to poll —
// matches opencode.test.ts's module-level default; per-test vi.doMock + vi.resetModules()
// overrides it where the v2 path itself is under test.
vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn().mockReturnValue({
    v2: {session: {wait: vi.fn().mockRejectedValue(new Error('v2 not available in test'))}},
  }),
}))

interface TestWaitParams {
  readonly sessionID: string
}
interface TestWaitOptions {
  readonly signal: AbortSignal
}
interface TestWaitResponse {
  readonly data?: undefined
  readonly error?: unknown
}
type TestWaitFn = (params: TestWaitParams, options: TestWaitOptions) => Promise<TestWaitResponse>

function makeV2Module(waitFn: TestWaitFn) {
  return {
    createOpencodeClient: vi.fn().mockReturnValue({v2: {session: {wait: waitFn}}}),
  }
}

function createMockEventStream(events: Event[] = []): AsyncIterable<Event> {
  return (async function* () {
    for (const event of events) {
      yield event
    }
  })()
}

// Events yielded immediately race the `currentTurnArmed` flip that happens after
// `listSessionMessageIds()` resolves (a macrotask away, not just a microtask) when `startPrompt`
// is supplied -- an unarmed event is silently dropped (retry.ts's `processEventStream` gate).
// Deferring the first yield past a `setTimeout(0)` guarantees arming has already happened.
function createArmedEventStream(events: Event[] = []): AsyncIterable<Event> {
  return (async function* () {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    for (const event of events) {
      yield event
    }
  })()
}

const COMPLETED_ATTEMPT_RESULT: AttemptResult = {
  success: true,
  error: null,
  llmError: null,
  outcome: 'completed',
  shouldRetry: false,
  settlement: {kind: 'completion-observed'},
  eventStreamResult: {
    tokens: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
  },
}

// A submission failure -- the only shape `startPrompt` ever returns non-null in production (see
// `sendPromptToSession`'s `createSubmissionFailure`): the prompt never reached the model at all.
const FAILED_ATTEMPT_RESULT: AttemptResult = {
  success: false,
  error: 'prompt submission failed: 503',
  llmError: null,
  outcome: 'submit_failed',
  shouldRetry: false,
  settlement: {kind: 'failure-observed'},
  eventStreamResult: {
    tokens: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
  },
}

const RATE_LIMIT_ERROR: ErrorInfo = {
  type: 'rate_limit',
  message: 'rate limited',
  retryable: true,
}

// llmError travels separately from `error` on `AttemptResult` -- a submission failure can carry
// both a human-readable `error` string and a classified `llmError` the retry loop keys off of.
const FAILED_ATTEMPT_RESULT_WITH_LLM_ERROR: AttemptResult = {
  ...FAILED_ATTEMPT_RESULT,
  llmError: RATE_LIMIT_ERROR,
}

describe('runPromptAttempt — ownership ledger gating (Unit 9)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.resetModules()
    vi.clearAllMocks()
  })

  describe('v2 session-wait success path', () => {
    it('happy path: completes when nothing is outstanding', async () => {
      // #given wait() resolves after the terminal signal is observed, and the ledger has nothing outstanding
      let resolveWait!: () => void
      const waitFn = vi.fn<TestWaitFn>().mockImplementation(
        async () =>
          new Promise<TestWaitResponse>(resolve => {
            resolveWait = () => resolve({data: undefined, error: undefined})
          }),
      )
      vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
      const {runPromptAttempt} = await import('./retry.js')
      const ledger = createOwnershipLedger()
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
      const eventStream = createMockEventStream([
        {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
      ])
      setTimeout(() => resolveWait(), 20)

      // #when
      const result = await runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        400,
        mockLogger,
        eventStream,
        'http://localhost:1234',
        undefined,
        undefined,
        undefined,
        undefined,
        ledger,
      )

      // #then — completes exactly as it does today; the poll was never the authority
      expect(result.success).toBe(true)
      expect(waitFn).toHaveBeenCalled()
      expect(mockClient.session.status).not.toHaveBeenCalled()
    })

    it('edge case: does not resolve complete while owned work is outstanding', async () => {
      // #given wait() resolves after the terminal signal is observed, but the ledger has outstanding work
      let resolveWait!: () => void
      const waitFn = vi.fn<TestWaitFn>().mockImplementation(
        async () =>
          new Promise<TestWaitResponse>(resolve => {
            resolveWait = () => resolve({data: undefined, error: undefined})
          }),
      )
      vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
      const {runPromptAttempt} = await import('./retry.js')
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
      const eventStream = createMockEventStream([
        {
          type: 'message.part.delta',
          properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'hello'}},
        } as unknown as Event,
        {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
      ])
      setTimeout(() => resolveWait(), 20)

      // #when — timeoutMs comfortably exceeds one poll interval so the (also gated) poll watchdog
      // gets a chance to actually run, rather than timing out before its first tick
      const result = await runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        1_500,
        mockLogger,
        eventStream,
        'http://localhost:1234',
        undefined,
        undefined,
        undefined,
        undefined,
        ledger,
      )

      // #then — wait() would normally report success here; instead it fell back to the (also
      // gated) poll, which times out because the poll status never reports anything terminal
      expect(waitFn).toHaveBeenCalled()
      expect(mockClient.session.status).toHaveBeenCalled()
      expect(result.success).toBe(false)
      expect(result.error).toContain('Poll timeout')
    })
  })

  describe('early prompt-start return', () => {
    it('happy path: completes when nothing is outstanding', async () => {
      // #given startPrompt resolves immediately with a completed result, and the ledger has nothing outstanding
      const {runPromptAttempt} = await import('./retry.js')
      const ledger = createOwnershipLedger()
      const startPrompt = vi.fn(async () => COMPLETED_ATTEMPT_RESULT)
      const mockClient = {session: {status: vi.fn()}}

      // #when
      const result = await runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        400,
        mockLogger,
        createMockEventStream([]),
        undefined,
        startPrompt,
        undefined,
        undefined,
        undefined,
        ledger,
      )

      // #then — resolves through the same early exit it does today; poll is never consulted
      expect(startPrompt).toHaveBeenCalledOnce()
      expect(result).toBe(COMPLETED_ATTEMPT_RESULT)
      expect(mockClient.session.status).not.toHaveBeenCalled()
    })

    it('edge case: does not end the run while owned work is outstanding', async () => {
      // #given startPrompt resolves immediately with a completed result (the synchronous-completion
      // path), but the ledger has outstanding work
      const {runPromptAttempt} = await import('./retry.js')
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      const startPrompt = vi.fn(async () => COMPLETED_ATTEMPT_RESULT)
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}

      // #when — timeoutMs comfortably exceeds one poll interval so the watchdog fallen into gets
      // a chance to actually run, rather than timing out before its first tick
      const result = await runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        1_500,
        mockLogger,
        createMockEventStream([]),
        undefined,
        startPrompt,
        undefined,
        undefined,
        undefined,
        ledger,
      )

      // #then — declined the early exit and fell through to the (also gated) watchdog, which
      // times out because nothing else signals completion either
      expect(startPrompt).toHaveBeenCalledOnce()
      expect(result).not.toBe(COMPLETED_ATTEMPT_RESULT)
      expect(mockClient.session.status).toHaveBeenCalled()
      expect(result.success).toBe(false)
      expect(result.error).toContain('Poll timeout')
    })
  })

  it('no-ledger path is inert: behavior is unchanged when ownershipLedger is omitted', async () => {
    // #given startPrompt resolves immediately with a completed result and no ledger argument at all
    const {runPromptAttempt} = await import('./retry.js')
    const startPrompt = vi.fn(async () => COMPLETED_ATTEMPT_RESULT)
    const mockClient = {session: {status: vi.fn()}}

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
      'ses_123',
      '/workspace',
      400,
      mockLogger,
      createMockEventStream([]),
      undefined,
      startPrompt,
    )

    // #then — resolves immediately through the early exit, exactly as every single-session run does today
    expect(result).toBe(COMPLETED_ATTEMPT_RESULT)
    expect(mockClient.session.status).not.toHaveBeenCalled()
  })

  it('integration: paths racing with work outstanding produce drain, not completion', async () => {
    // #given the v2 wait, the sticky terminal flags (via session.idle), and the stable
    // completed-assistant poll ALL become eligible to report completion at roughly the same time —
    // and the ledger has outstanding work throughout
    let resolveWait!: () => void
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(
      async () =>
        new Promise<TestWaitResponse>(resolve => {
          resolveWait = () => resolve({data: undefined, error: undefined})
        }),
    )
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'background task')
    const mockClient = {
      session: {
        // Baseline call sees nothing; every poll after it sees a stable completed assistant
        // message — eligible for the completed-assistant path once two consecutive polls confirm it.
        messages: vi
          .fn()
          .mockResolvedValueOnce({data: []})
          .mockResolvedValue({
            data: [{info: {id: 'msg_new', role: 'assistant', time: {created: 1, completed: 2}}}],
          }),
        // Idle status — eligible for the sticky-flags-via-polling branch too.
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
    }
    const eventStream = createMockEventStream([
      {
        type: 'message.part.delta',
        properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'hi'}},
      } as unknown as Event,
      // Sticky-flags-via-event-stream path becomes eligible too.
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ])
    setTimeout(() => resolveWait(), 20)
    // startPrompt (returning null) is what makes runPromptAttempt establish baselineMessageIds at
    // all — without it the completed-assistant path can never become eligible in this flow.
    const startPrompt = vi.fn(async () => null)

    // #when — timeoutMs comfortably exceeds one poll interval so every racing path gets a real chance
    const result = await runPromptAttempt(
      mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
      'ses_123',
      '/workspace',
      1_500,
      mockLogger,
      eventStream,
      'http://localhost:1234',
      startPrompt,
      undefined,
      undefined,
      undefined,
      ledger,
    )

    // #then — every racing path had a chance to win and every one of them deferred; the run
    // drains to a timeout instead of reporting completion out from under the outstanding work
    expect(waitFn).toHaveBeenCalled()
    expect(mockClient.session.status).toHaveBeenCalled()
    expect(mockClient.session.messages).toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toContain('Poll timeout')
  })

  describe('deferred promptStartResult failure survives the watchdog', () => {
    it('a failed prompt whose completion is deferred by outstanding owned work still reports its error when the attempt finally resolves', async () => {
      // #given wait() eventually reports success, the ledger has outstanding work, and startPrompt
      // itself already failed (a submission failure) before the ledger deferral kicked in
      let resolveWait!: () => void
      const waitFn = vi.fn<TestWaitFn>().mockImplementation(
        async () =>
          new Promise<TestWaitResponse>(resolve => {
            resolveWait = () => resolve({data: undefined, error: undefined})
          }),
      )
      vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
      const {runPromptAttempt} = await import('./retry.js')
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      const startPrompt = vi.fn(async () => FAILED_ATTEMPT_RESULT)
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
      // No current-turn activity events: a submission failure means the turn never actually
      // started, so nothing streams for it -- only the deferred watchdog observes completion.
      const eventStream = createMockEventStream([
        {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
      ])
      setTimeout(() => resolveWait(), 20)

      // #when
      const result = await runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        1_500,
        mockLogger,
        eventStream,
        'http://localhost:1234',
        startPrompt,
        undefined,
        undefined,
        undefined,
        ledger,
      )

      // #then — the watchdog observed completion, but the deferred submission failure survives
      // instead of being reported as a false success. The old `deadlineConcluded` side flag is
      // gone (Steps 3b/5 of the restructure): the reported failure itself, plus its `outcome` --
      // `submit_failed`, since the turn never actually started -- is what now proves the
      // preserved-submission-failure fold-back ran, not a side flag distinguishing a
      // deadline-forced conclusion from one the ledger simply resolved on its own.
      expect(startPrompt).toHaveBeenCalledOnce()
      expect(waitFn).toHaveBeenCalled()
      expect(result.success).toBe(false)
      expect(result.error).toBe(FAILED_ATTEMPT_RESULT.error)
      expect(result.llmError).toBeNull()
      expect(result.outcome).toBe('submit_failed')
      expect(result.shouldRetry).toBe(false)
    })

    it('the same for llmError, which travels separately from error', async () => {
      // #given the same deferred-failure shape, but the submission failure also carries a classified llmError
      let resolveWait!: () => void
      const waitFn = vi.fn<TestWaitFn>().mockImplementation(
        async () =>
          new Promise<TestWaitResponse>(resolve => {
            resolveWait = () => resolve({data: undefined, error: undefined})
          }),
      )
      vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
      const {runPromptAttempt} = await import('./retry.js')
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      const startPrompt = vi.fn(async () => FAILED_ATTEMPT_RESULT_WITH_LLM_ERROR)
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
      const eventStream = createMockEventStream([
        {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
      ])
      setTimeout(() => resolveWait(), 20)

      // #when
      const result = await runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        1_500,
        mockLogger,
        eventStream,
        'http://localhost:1234',
        startPrompt,
        undefined,
        undefined,
        undefined,
        ledger,
      )

      // #then — the classified llmError survives the deferral just as `error` does. The
      // event-stream result now carries the same winning failure's llmError too: the reducer
      // generalizes what was previously a provider-only merge to any winning failure source,
      // fixing the old fixture's inconsistent split (top-level llmError set, eventStreamResult's
      // left null) rather than reproducing it.
      expect(result.success).toBe(false)
      expect(result.error).toBe(FAILED_ATTEMPT_RESULT_WITH_LLM_ERROR.error)
      expect(result.llmError).toBe(RATE_LIMIT_ERROR)
      expect(result.outcome).toBe('submit_failed')
      expect(result.eventStreamResult.llmError).toBe(RATE_LIMIT_ERROR)
    })

    it('a successful prompt deferred by outstanding work is unaffected', async () => {
      // #given the same deferral, but startPrompt itself succeeded (COMPLETED_ATTEMPT_RESULT) — the
      // ledger gate must still hold the run open for owned work, and no failure should be fabricated
      const {runPromptAttempt} = await import('./retry.js')
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      const startPrompt = vi.fn(async () => COMPLETED_ATTEMPT_RESULT)
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}

      // #when — no v2 wait mock is installed, so this falls back to poll, which times out because
      // nothing else signals completion — exactly today's behavior for a deferred success
      const result = await runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        1_500,
        mockLogger,
        createMockEventStream([]),
        undefined,
        startPrompt,
        undefined,
        undefined,
        undefined,
        ledger,
      )

      // #then — declined the early exit exactly as before; nothing about the failure-preservation
      // fix changes the outcome for a successful deferred prompt
      expect(startPrompt).toHaveBeenCalledOnce()
      expect(result).not.toBe(COMPLETED_ATTEMPT_RESULT)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Poll timeout')
    })

    it('the deferred failure survives a shared ExecutionDeadline expiring mid-drain: reports the original failure, not a timeout', async () => {
      // #given a failed promptStartResult deferred by outstanding owned work, no other completion
      // signal (no serverUrl -- v2 wait is never even attempted), and a shared deadline that expires
      // while the watchdog is still polling. This is the exact ordering the regression exploited: the
      // deadline-expiration throw used to run before the deferred-failure fold-back.
      vi.useFakeTimers()
      try {
        const {runPromptAttempt} = await import('./retry.js')
        const ledger = createOwnershipLedger()
        ledger.adopt('ses_child', 'background task')
        const startPrompt = vi.fn(async () => FAILED_ATTEMPT_RESULT)
        const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
        // No current-turn activity events: a submission failure means the turn never actually started.
        const eventStream = createMockEventStream([])
        const deadlineAt = Date.now() + 1_000
        const deadline: ExecutionDeadline = {
          timeoutMs: 1_000,
          signal: new AbortController().signal,
          isExpired: () => Date.now() >= deadlineAt,
          isTimedOut: () => false,
          remainingMs: () => Math.max(0, deadlineAt - Date.now()),
          run: async operation => operation(),
          dispose: vi.fn(),
        }

        // #when
        const resultPromise = runPromptAttempt(
          mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
          'ses_123',
          '/workspace',
          1_500,
          mockLogger,
          eventStream,
          undefined,
          startPrompt,
          deadline,
          undefined,
          undefined,
          ledger,
        )
        await vi.advanceTimersByTimeAsync(0)
        vi.setSystemTime(deadlineAt + 1)
        await vi.advanceTimersByTimeAsync(1_500)
        const result = await resultPromise

        // #then — the deferred submission failure is reported as itself; the deadline settlement
        // never gets to override it, because a preserved submission failure always outranks a bare
        // `deadline` settlement's fallback in `reduceAttemptOutcome` (Steps 3b/5 of the restructure).
        // The old `deadlineConcluded` side flag is gone -- `deadline.isExpired()` (checked
        // independently below) is now how a caller learns the deadline genuinely is what ended this
        // wait, without that fact being able to overwrite the settled failure's cause or evidence.
        expect(result.success).toBe(false)
        expect(result.error).toBe(FAILED_ATTEMPT_RESULT.error)
        expect(result.outcome).not.toBe('timeout')
        expect(result.outcome).toBe('submit_failed')
        expect(deadline.isExpired()).toBe(true)
        // Row 8: the settlement itself -- not merely `deadline.isExpired()` observed independently
        // above -- is what execution.ts now reads to decide abort. Here it genuinely is `deadline`:
        // the watchdog's own poll observation settled as `deadline` (no completion, no ledger
        // resolution) before the preserved submission failure was folded in as the reported error.
        expect(result.settlement.kind).toBe('deadline')
      } finally {
        vi.useRealTimers()
      }
    })

    it('the deferred-failure merge path with a meaningful event observed: llmError precedence, computed outcome, and shouldRetry', async () => {
      // #given the ledger defers completion, an activity event arms firstMeaningfulEventReceived,
      // and the event stream separately observes its own (distinct) llmError via a session.error
      // event -- the merge must prefer the stream-observed llmError over the deferred one, exactly
      // as the non-deferred early-exit path already does
      let resolveWait!: () => void
      const waitFn = vi.fn<TestWaitFn>().mockImplementation(
        async () =>
          new Promise<TestWaitResponse>(resolve => {
            resolveWait = () => resolve({data: undefined, error: undefined})
          }),
      )
      vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
      const {runPromptAttempt} = await import('./retry.js')
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      const startPrompt = vi.fn(async () => FAILED_ATTEMPT_RESULT_WITH_LLM_ERROR)
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
      const eventStream = createArmedEventStream([
        {
          type: 'message.part.delta',
          properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'hi'}},
        } as unknown as Event,
        // Distinct rate_limit llmError from the one on FAILED_ATTEMPT_RESULT_WITH_LLM_ERROR --
        // classified from status alone, so its message differs ('status=429' vs 'rate limited').
        {
          type: 'session.error',
          properties: {sessionID: 'ses_123', error: {status: 429}},
        } as unknown as Event,
        {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
      ])
      setTimeout(() => resolveWait(), 20)

      // #when
      const result = await runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        1_500,
        mockLogger,
        eventStream,
        'http://localhost:1234',
        startPrompt,
        undefined,
        undefined,
        undefined,
        ledger,
      )

      // #then — matches the non-deferred early-exit path's merge rules exactly: the stream-observed
      // llmError wins, the outcome is derived from its retryability, and shouldRetry follows outcome
      expect(result.success).toBe(false)
      expect(result.llmError?.type).toBe('rate_limit')
      expect(result.llmError?.message).toBe('status=429')
      expect(result.llmError?.message).not.toBe(RATE_LIMIT_ERROR.message)
      expect(result.outcome).toBe('turn_failed_retryable')
      expect(result.shouldRetry).toBe(true)
    })

    it('an expired deadline still prevents a further retry attempt, even though the preserved failure computes shouldRetry: true', async () => {
      // #given the same deferred-failure-with-retryable-llmError shape as above, but this time the
      // shared deadline expires mid-drain instead of resolving via wait(). The fix must preserve the
      // failure (and its honestly-computed shouldRetry: true) without extending the deadline itself --
      // a caller gating retries on deadline.isExpired() (as executeOpenCode does) must still see it expired.
      vi.useFakeTimers()
      try {
        const {runPromptAttempt} = await import('./retry.js')
        const ledger = createOwnershipLedger()
        ledger.adopt('ses_child', 'background task')
        const startPrompt = vi.fn(async () => FAILED_ATTEMPT_RESULT_WITH_LLM_ERROR)
        const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
        const eventStream = createArmedEventStream([
          {
            type: 'message.part.delta',
            properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'hi'}},
          } as unknown as Event,
        ])
        const deadlineAt = Date.now() + 1_000
        const deadline: ExecutionDeadline = {
          timeoutMs: 1_000,
          signal: new AbortController().signal,
          isExpired: () => Date.now() >= deadlineAt,
          isTimedOut: () => false,
          remainingMs: () => Math.max(0, deadlineAt - Date.now()),
          run: async operation => operation(),
          dispose: vi.fn(),
        }

        // #when
        const resultPromise = runPromptAttempt(
          mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
          'ses_123',
          '/workspace',
          1_500,
          mockLogger,
          eventStream,
          undefined,
          startPrompt,
          deadline,
          undefined,
          undefined,
          ledger,
        )
        await vi.advanceTimersByTimeAsync(0)
        vi.setSystemTime(deadlineAt + 1)
        await vi.advanceTimersByTimeAsync(1_500)
        const result = await resultPromise

        // #then — the failure (and its honest shouldRetry: true) is reported, but the shared deadline
        // the caller checks independently is still expired: a retry loop gated on isExpired() stops here
        expect(result.success).toBe(false)
        expect(result.outcome).toBe('turn_failed_retryable')
        expect(result.shouldRetry).toBe(true)
        expect(deadline.isExpired()).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a successful prompt deferred by outstanding work is unaffected even when the shared deadline expires mid-drain', async () => {
      // #given the ledger defers a *successful* promptStartResult, and the deadline expires before
      // any other completion signal arrives -- unlike a deferred failure, a deferred success never
      // populates preservedSubmissionFailure, so the watchdog's `deadline` settlement has no
      // failure to preserve and reduces to a typed timeout result (Steps 3b/5 replaced the old
      // post-race `throw createDeadlineExceededError(...)` with this typed result; the earlier
      // admission-time throws inside `deadline.run()`, e.g. for `startPrompt`/event subscription,
      // are untouched by this restructure)
      vi.useFakeTimers()
      try {
        const {runPromptAttempt} = await import('./retry.js')
        const ledger = createOwnershipLedger()
        ledger.adopt('ses_child', 'background task')
        const startPrompt = vi.fn(async () => COMPLETED_ATTEMPT_RESULT)
        const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
        const eventStream = createMockEventStream([])
        const deadlineAt = Date.now() + 1_000
        const deadline: ExecutionDeadline = {
          timeoutMs: 1_000,
          signal: new AbortController().signal,
          isExpired: () => Date.now() >= deadlineAt,
          isTimedOut: () => false,
          remainingMs: () => Math.max(0, deadlineAt - Date.now()),
          run: async operation => operation(),
          dispose: vi.fn(),
        }

        // #when
        const resultPromise = runPromptAttempt(
          mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
          'ses_123',
          '/workspace',
          1_500,
          mockLogger,
          eventStream,
          undefined,
          startPrompt,
          deadline,
          undefined,
          undefined,
          ledger,
        )
        await vi.advanceTimersByTimeAsync(0)
        vi.setSystemTime(deadlineAt + 1)
        await vi.advanceTimersByTimeAsync(1_500)
        const result = await resultPromise

        // #then — a deferred success with no other completion signal times out, now as a typed
        // result rather than a thrown DeadlineExceededError
        expect(result.success).toBe(false)
        expect(result.outcome).toBe('timeout')
        expect(result.error).toBe('Attempt did not settle before the execution deadline')
      } finally {
        vi.useRealTimers()
      }
    })

    it('existing retry behavior with no ledger is unchanged', async () => {
      // #given a failed promptStartResult and no ledger argument at all
      const {runPromptAttempt} = await import('./retry.js')
      const startPrompt = vi.fn(async () => FAILED_ATTEMPT_RESULT)
      const mockClient = {session: {status: vi.fn()}}

      // #when
      const result = await runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        400,
        mockLogger,
        createMockEventStream([]),
        undefined,
        startPrompt,
      )

      // #then — resolves immediately through the existing (non-deferred) early exit, exactly as
      // every run without a ledger does today; the new deferral machinery never engages
      expect(result).toBe(FAILED_ATTEMPT_RESULT)
      expect(mockClient.session.status).not.toHaveBeenCalled()
    })
  })
})

/**
 * Acceptance matrix for the Steps 3b/5 restructure (`startV2SessionWait` → `AttemptObservation`,
 * `runPromptAttempt`'s single post-race reduction). Proves the *settlement cause* each row
 * produces, observed through `outcome`/`success`/`error` -- the only surface `AttemptResult`
 * exposes -- `AttemptResult.settlement` is now part of that surface too (added when the settlement
 * cause was threaded across the prompt-sender.ts boundary), so the higher-value rows below also
 * assert it directly; the causal mapping itself remains exhaustively unit-tested in
 * `attempt-outcome.test.ts`. Whether an abort follows is decided one layer up, in `execution.ts`
 * (out of scope here).
 *
 * Rows 6 and 8 are proven by existing tests above (`deferred promptStartResult failure survives
 * the watchdog` → "a failed prompt whose completion is deferred..." for Row 6, "the deferred
 * failure survives a shared ExecutionDeadline expiring mid-drain..." for Row 8) rather than
 * duplicated here.
 */
describe('runPromptAttempt — settlement causality matrix (Steps 3b/5)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('rows 1 & 12 — completes well within budget with no ledger involved', async () => {
    // #given a comfortable, never-expiring deadline and a plain wait() success
    let resolveWait!: () => void
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(
      async () =>
        new Promise<TestWaitResponse>(resolve => {
          resolveWait = () => resolve({data: undefined, error: undefined})
        }),
    )
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {session: {status: vi.fn()}}
    const eventStream = createMockEventStream([
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ])
    setTimeout(() => resolveWait(), 20)

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
      'ses_123',
      '/workspace',
      60_000,
      mockLogger,
      eventStream,
      'http://localhost:1234',
    )

    // #then — completion-observed, no failures → success
    expect(result.success).toBe(true)
    expect(result.outcome).toBe('completed')
  })

  it('rows 2 & 5 — a completion the race already won survives the clock latching only afterward, during cleanup', async () => {
    // #given wait() resolves the terminal signal while the deadline still reads unexpired; only
    // after the race has settled does the clock flip -- the exact shape of the deleted
    // `outcome: 'timeout', success: true` return this restructure replaces (see the module doc on
    // `attempt-outcome.ts` and the "one case to get right" note in the restructure brief)
    vi.useFakeTimers()
    try {
      let resolveWait!: () => void
      const waitFn = vi.fn<TestWaitFn>().mockImplementation(
        async () =>
          new Promise<TestWaitResponse>(resolve => {
            resolveWait = () => resolve({data: undefined, error: undefined})
          }),
      )
      vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
      const {runPromptAttempt} = await import('./retry.js')
      const mockClient = {session: {status: vi.fn()}}
      const eventStream = createMockEventStream([
        {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
      ])
      let expired = false
      const deadline: ExecutionDeadline = {
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        isExpired: () => expired,
        isTimedOut: () => expired,
        remainingMs: () => (expired ? 0 : 1_000),
        run: async operation => operation(),
        dispose: vi.fn(),
      }

      // #when
      const resultPromise = runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        1_500,
        mockLogger,
        eventStream,
        'http://localhost:1234',
        undefined,
        deadline,
      )
      await vi.advanceTimersByTimeAsync(0)
      resolveWait()
      await vi.advanceTimersByTimeAsync(20)
      // The race has settled on completion by now; only now does the clock latch, simulating
      // expiry occurring purely during `collectEventResults()`'s bounded cleanup.
      expired = true
      const result = await resultPromise

      // #then — the winner (completion-observed) is retained unchanged regardless of what the
      // clock does afterward
      expect(result.success).toBe(true)
      expect(result.outcome).toBe('completed')
      expect(result.settlement.kind).toBe('completion-observed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('row 3 — a terminal provider failure settles before the deadline', async () => {
    // #given a session.error classified as a terminal provider failure, well within budget
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {name: 'ProviderAuthError', data: {providerID: 'sentinel-provider', message: 'sentinel-token'}},
        },
      } as unknown as Event,
    ])

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
      'ses_123',
      '/workspace',
      60_000,
      mockLogger,
      eventStream,
      undefined,
    )

    // #then — failure-observed (provider) → terminal failure, not completion
    expect(result.success).toBe(false)
    expect(result.outcome).toBe('turn_failed_terminal')
    expect(result.llmError?.type).toBe('provider_auth_error')
  })

  it('rows 4 & 14 — a terminal provider failure the race already won survives the clock latching at/just after the boundary', async () => {
    // #given the same terminal provider failure as Row 3, but the deadline flips to expired
    // immediately after the poll observes it -- simulating the failure winning right at (Row 14)
    // or just after (Row 4) the boundary, with the clock only catching up during cleanup
    vi.useFakeTimers()
    try {
      const {runPromptAttempt} = await import('./retry.js')
      const mockClient = {
        session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})},
      }
      const eventStream = createMockEventStream([
        {
          type: 'session.error',
          properties: {
            sessionID: 'ses_123',
            error: {name: 'ProviderAuthError', data: {providerID: 'sentinel-provider', message: 'sentinel-token'}},
          },
        } as unknown as Event,
      ])
      let expired = false
      const deadline: ExecutionDeadline = {
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        isExpired: () => expired,
        isTimedOut: () => expired,
        remainingMs: () => (expired ? 0 : 1_000),
        run: async operation => operation(),
        dispose: vi.fn(),
      }

      // #when
      const resultPromise = runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        1_500,
        mockLogger,
        eventStream,
        undefined,
        undefined,
        deadline,
      )
      await vi.advanceTimersByTimeAsync(0)
      // The provider failure is classified as soon as the event is consumed, well before any poll
      // interval elapses — flip the clock immediately after to simulate the boundary, then let the
      // poll loop's own 500ms interval elapse once so it re-checks and observes the now-classified
      // failure ahead of the now-expired deadline.
      expired = true
      await vi.advanceTimersByTimeAsync(500)
      const result = await resultPromise

      // #then — the winning failure-observed settlement is retained; the deadline does not
      // downgrade or reclassify it into a timeout
      expect(result.success).toBe(false)
      expect(result.outcome).toBe('turn_failed_terminal')
      expect(result.outcome).not.toBe('timeout')
      expect(result.llmError?.type).toBe('provider_auth_error')
      expect(result.settlement.kind).toBe('failure-observed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('row 9 — a genuine deadline settlement, with no completion and no failure to preserve, reduces to a typed timeout', async () => {
    // #given no ledger, no wait() (no serverUrl), and a poll that never observes anything
    // terminal before a real, short-lived ExecutionDeadline actually expires — the complement to
    // Rows 1/2/3/4/5/12/14 above: here the deadline genuinely is what ends the attempt
    vi.useFakeTimers()
    try {
      const {runPromptAttempt, createExecutionDeadline} = await import('./retry.js')
      const deadline = createExecutionDeadline(50, mockLogger)
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}

      // #when
      const resultPromise = runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        60_000,
        mockLogger,
        createMockEventStream([]),
        undefined,
        undefined,
        deadline,
      )
      await vi.advanceTimersByTimeAsync(200)
      const result = await resultPromise

      // #then — settlement: deadline, no failures → typed timeout, not a false completion
      expect(result.success).toBe(false)
      expect(result.outcome).toBe('timeout')
      expect(result.error).toBe('Attempt did not settle before the execution deadline')
      expect(result.settlement.kind).toBe('deadline')
      deadline.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('row 10 — a genuine (non-timeout) exception from prompt submission propagates unchanged even though the deadline has already expired', async () => {
    // #given a real thrown error, unrelated to the deadline, with the deadline already expired
    const {runPromptAttempt} = await import('./retry.js')
    const deadline: ExecutionDeadline = {
      timeoutMs: 1,
      signal: new AbortController().signal,
      isExpired: () => true,
      isTimedOut: () => true,
      remainingMs: () => 0,
      run: async operation => operation(),
      dispose: vi.fn(),
    }
    const boom = new Error('submission transport exploded')
    const startPrompt = vi.fn(async (): Promise<never> => {
      throw boom
    })
    const mockClient = {session: {status: vi.fn()}}

    // #when / #then — the exception is not reinterpreted as a deadline conclusion; it propagates as
    // itself, exactly as `createExecutionDeadline`'s own race-causality tests already establish
    await expect(
      runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        400,
        mockLogger,
        createMockEventStream([]),
        undefined,
        startPrompt,
        deadline,
      ),
    ).rejects.toBe(boom)
  })

  it('row 11 — the same genuine exception propagates unchanged when the deadline has not expired', async () => {
    // #given the complement of Row 10: identical exception, deadline nowhere near expiry
    const {runPromptAttempt} = await import('./retry.js')
    const deadline: ExecutionDeadline = {
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      isExpired: () => false,
      isTimedOut: () => false,
      remainingMs: () => 60_000,
      run: async operation => operation(),
      dispose: vi.fn(),
    }
    const boom = new Error('submission transport exploded')
    const startPrompt = vi.fn(async (): Promise<never> => {
      throw boom
    })
    const mockClient = {session: {status: vi.fn()}}

    // #when / #then
    await expect(
      runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        400,
        mockLogger,
        createMockEventStream([]),
        undefined,
        startPrompt,
        deadline,
      ),
    ).rejects.toBe(boom)
  })

  it('row 7 — a deferred failure resolved before the watchdog engages survives a deadline that only expires afterward, during artifact cleanup', async () => {
    // #given the ledger defers a failed promptStartResult, wait() resolves quickly (well before any
    // deadline concern), and only after the race has settled does the clock flip -- the Row 6/Row 7
    // pair mirrors Rows 1/2 and 3/4 for the deferred-submission-failure path specifically
    vi.useFakeTimers()
    try {
      let resolveWait!: () => void
      const waitFn = vi.fn<TestWaitFn>().mockImplementation(
        async () =>
          new Promise<TestWaitResponse>(resolve => {
            resolveWait = () => resolve({data: undefined, error: undefined})
          }),
      )
      vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
      const {runPromptAttempt} = await import('./retry.js')
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      const startPrompt = vi.fn(async () => FAILED_ATTEMPT_RESULT)
      const mockClient = {session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})}}
      const eventStream = createMockEventStream([
        {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
      ])
      let expired = false
      const deadline: ExecutionDeadline = {
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        isExpired: () => expired,
        isTimedOut: () => expired,
        remainingMs: () => (expired ? 0 : 1_000),
        run: async operation => operation(),
        dispose: vi.fn(),
      }

      // #when
      const resultPromise = runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        1_500,
        mockLogger,
        eventStream,
        'http://localhost:1234',
        startPrompt,
        deadline,
        undefined,
        undefined,
        ledger,
      )
      await vi.advanceTimersByTimeAsync(0)
      resolveWait()
      await vi.advanceTimersByTimeAsync(20)
      // The deferred failure has already resolved via the watchdog by now; only now does the clock
      // latch, simulating expiry occurring purely during later (e.g. artifact) cleanup. The ledger
      // stays outstanding for the rest of this test, so let the poll loop's own 500ms interval
      // elapse once so it re-checks and observes the now-expired deadline.
      expired = true
      await vi.advanceTimersByTimeAsync(500)
      const result = await resultPromise

      // #then — the preserved submission failure is reported as itself, not overridden into a bare
      // typed timeout by the settlement fallback -- `outcomeForFailure` still wins over
      // `settlementFallback` even though the settlement here genuinely is `deadline`. NOTE: this
      // fixture's ledger (`ledger.adopt` above) is never settled, so it stays permanently
      // outstanding; the deadline is therefore what genuinely ends this attempt (settlement:
      // 'deadline'), not an early resolution -- this test's name ("row 7") predates `settlement`
      // being on `AttemptResult` and does not actually exercise the "resolved early" half of Row
      // 7/Row 6's pairing (that requires `ledger.settle()` before the deadline flips, which this
      // fixture does not do). The genuine ledger-present-decided-before-expiry proof for Row 7 is
      // `execution.test.ts`'s "row 7" test, which settles its ledger before the deadline advances.
      expect(result.success).toBe(false)
      expect(result.error).toBe(FAILED_ATTEMPT_RESULT.error)
      expect(result.outcome).toBe('submit_failed')
      expect(result.outcome).not.toBe('timeout')
      expect(result.settlement.kind).toBe('deadline')
    } finally {
      vi.useRealTimers()
    }
  })

  it('row 13 — a completion settlement is not reopened by a continuation event still in flight when bounded cleanup gives up', async () => {
    // #given wait() resolves completion right after session.idle; a further event (simulating a
    // continuation write still landing on the wire) is queued behind it but never actually lands
    // within this attempt's bounded cleanup window — the settled decision must stand regardless
    vi.useFakeTimers()
    try {
      let resolveWait!: () => void
      const waitFn = vi.fn<TestWaitFn>().mockImplementation(
        async () =>
          new Promise<TestWaitResponse>(resolve => {
            resolveWait = () => resolve({data: undefined, error: undefined})
          }),
      )
      vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
      const {runPromptAttempt} = await import('./retry.js')
      const mockClient = {session: {status: vi.fn()}}
      const eventStream = (async function* (): AsyncIterable<Event> {
        yield {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event
        // A continuation that never actually lands within this attempt's bounded cleanup window --
        // it must never get a chance to change a decision the race already made.
        await new Promise<void>(() => undefined)
        yield {
          type: 'session.error',
          properties: {
            sessionID: 'ses_123',
            error: {name: 'ProviderAuthError', data: {providerID: 'p', message: 'late'}},
          },
        } as unknown as Event
      })()

      // #when
      const resultPromise = runPromptAttempt(
        mockClient as unknown as Parameters<typeof runPromptAttempt>[0],
        'ses_123',
        '/workspace',
        400,
        mockLogger,
        eventStream,
        'http://localhost:1234',
      )
      await vi.advanceTimersByTimeAsync(0)
      resolveWait()
      // Past `EVENT_PROCESSOR_SHUTDOWN_TIMEOUT_MS` (2_000ms): bounded cleanup gives up waiting for
      // the stream to close on its own rather than let the queued continuation reopen anything.
      await vi.advanceTimersByTimeAsync(2_500)
      const result = await resultPromise

      // #then — completion wins outright; the queued continuation event never gets a chance to
      // reopen it
      expect(result.success).toBe(true)
      expect(result.outcome).toBe('completed')
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * `createExecutionDeadline`'s `run()`: the race between an operation and the deadline must be
 * decided once, by whichever settles first, and never re-explained afterwards by rereading the
 * clock. Each pair below shares identical timing but differs only in which side actually won,
 * proving the winner -- not the clock state at inspection time -- decides the outcome.
 */
describe('createExecutionDeadline — run() race causality', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("propagates the operation's own rejection when it arrives after wall-clock expiry but before the timeout latch fires", async () => {
    // #given a deadline whose wall clock has passed deadlineAt, but whose setTimeout callback
    // (latchTimeout) has not yet run -- isExpired() has not been consulted by anything since call
    // time, so the deadline racer has not genuinely won.
    const {createExecutionDeadline} = await import('./retry.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    let rejectOperation!: (error: unknown) => void
    const operation = vi.fn(
      async () =>
        new Promise((_resolve, reject) => {
          rejectOperation = reject
        }),
    )
    const ownError = new Error('operation failed on its own terms')

    // #when
    const resultPromise = deadline.run(operation, 'test operation')
    await Promise.resolve() // let operation() actually run and capture rejectOperation
    vi.setSystemTime(Date.now() + 1_500) // wall clock now past deadlineAt; timer has not ticked
    rejectOperation(ownError)

    // #then — the operation's own error propagates, not DeadlineExceededError
    await expect(resultPromise).rejects.toBe(ownError)
    deadline.dispose()
  })

  it("returns the operation's own success when it arrives after wall-clock expiry but before the timeout latch fires", async () => {
    // #given — sibling of the previous test: identical timing, non-deadline (successful) cause
    const {createExecutionDeadline} = await import('./retry.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    let resolveOperation!: (value: string) => void
    const operation = vi.fn(
      async () =>
        new Promise<string>(resolve => {
          resolveOperation = resolve
        }),
    )

    // #when
    const resultPromise = deadline.run(operation, 'test operation')
    await Promise.resolve() // let operation() actually run and capture resolveOperation
    vi.setSystemTime(Date.now() + 1_500) // wall clock now past deadlineAt; timer has not ticked
    resolveOperation('operation value')

    // #then — the operation's own value is returned; observing quiescence never erases a result
    await expect(resultPromise).resolves.toBe('operation value')
    deadline.dispose()
  })

  it('throws DeadlineExceededError when the operation is still pending and the timeout latch genuinely fires', async () => {
    // #given an operation that never settles on its own
    const {createExecutionDeadline} = await import('./retry.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    const operation = vi.fn(async () => new Promise<string>(() => undefined))

    // #when — the timeout latch genuinely fires (its setTimeout callback runs) while the
    // operation is still pending: the deadline racer wins for real
    const resultPromise = deadline.run(operation, 'test operation')

    // #then
    await Promise.all([
      expect(resultPromise).rejects.toMatchObject({name: 'DeadlineExceededError'}),
      vi.advanceTimersByTimeAsync(1_000),
    ])
    deadline.dispose()
  })

  it("returns the operation's own success when it settles before the timeout latch fires", async () => {
    // #given — sibling of the previous test: same genuine-race timing, operation wins instead of
    // the deadline. Also the "existing behavior for operations comfortably inside the budget is
    // unchanged" case.
    const {createExecutionDeadline} = await import('./retry.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    const operation = vi.fn(async () => 'operation value')

    // #when
    const result = await deadline.run(operation, 'test operation')

    // #then
    expect(result).toBe('operation value')
    expect(operation).toHaveBeenCalledOnce()
    deadline.dispose()
  })

  it("propagates the operation's own rejection when it settles before the timeout latch fires", async () => {
    // #given — sibling of the two previous tests: same genuine-race timing, operation wins the
    // race via its own rejection instead of the deadline winning or the operation succeeding
    const {createExecutionDeadline} = await import('./retry.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    const ownError = new Error('operation failed on its own terms')
    const operation = vi.fn(async () => {
      throw ownError
    })

    // #when / #then — the operation's own error propagates, not DeadlineExceededError
    await expect(deadline.run(operation, 'test operation')).rejects.toBe(ownError)
    deadline.dispose()
  })

  it('rejects at admission with DeadlineExceededError when the deadline has already expired before run() is called, without invoking the operation', async () => {
    // #given a deadline whose wall clock has already passed deadlineAt before run() is ever called
    // -- this is a valid admission-time clock check, not a retrospective one
    const {createExecutionDeadline} = await import('./retry.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    const operation = vi.fn(async () => 'should not run')
    vi.setSystemTime(Date.now() + 1_500)

    // #when / #then
    await expect(deadline.run(operation, 'test operation')).rejects.toMatchObject({name: 'DeadlineExceededError'})
    expect(operation).not.toHaveBeenCalled()
    deadline.dispose()
  })

  it('invokes and resolves the operation normally when submitted comfortably within the deadline budget', async () => {
    // #given — sibling of the admission-rejection test: same admission decision point, non-deadline
    // (successful, well within budget) cause
    const {createExecutionDeadline} = await import('./retry.js')
    const deadline = createExecutionDeadline(10_000, mockLogger)
    const operation = vi.fn(async () => 'operation value')

    // #when
    const result = await deadline.run(operation, 'test operation')

    // #then
    expect(result).toBe('operation value')
    expect(operation).toHaveBeenCalledOnce()
    deadline.dispose()
  })
})
