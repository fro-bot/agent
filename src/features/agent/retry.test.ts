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
import type {ErrorInfo} from './types.js'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {beforeEach, describe, expect, it, vi} from 'vitest'
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

const COMPLETED_ATTEMPT_RESULT: AttemptResult = {
  success: true,
  error: null,
  llmError: null,
  outcome: 'completed',
  shouldRetry: false,
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
      // instead of being reported as a false success
      expect(startPrompt).toHaveBeenCalledOnce()
      expect(waitFn).toHaveBeenCalled()
      expect(result).toBe(FAILED_ATTEMPT_RESULT)
      expect(result.success).toBe(false)
      expect(result.error).toBe(FAILED_ATTEMPT_RESULT.error)
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

      // #then — the classified llmError survives the deferral just as `error` does
      expect(result).toBe(FAILED_ATTEMPT_RESULT_WITH_LLM_ERROR)
      expect(result.success).toBe(false)
      expect(result.error).toBe(FAILED_ATTEMPT_RESULT_WITH_LLM_ERROR.error)
      expect(result.llmError).toBe(RATE_LIMIT_ERROR)
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
