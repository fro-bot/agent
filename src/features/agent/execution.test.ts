/**
 * Unit 11: closing the ownership-ledger chain in `executeOpenCode`.
 *
 * Units 8, 9, and 10 built `processEventStream`, `runPromptAttempt`,
 * `pollForSessionCompletion`, and `runDrain` to accept an optional
 * `OwnershipLedger`, but nothing in production ever constructed or threaded
 * one through the real call chain until this unit. These tests exercise
 * `executeOpenCode` -> `sendPromptToSession` -> `runPromptAttempt` ->
 * `processEventStream` for real, with only the OpenCode SDK boundary (the
 * mock server client and its event stream) replaced -- proving the wiring
 * itself, not a mocked collaborator that would report success regardless.
 */
import type {Event} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {AttemptResult} from './prompt-sender.js'
import type {ExecutionDeadline} from './retry.js'
import type {PromptOptions} from './types.js'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {createOpencode} from '@opencode-ai/sdk'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {runDrain} from '../../harness/phases/execute.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {executeOpenCode} from './execution.js'
import {MAX_LLM_RETRIES} from './retry.js'

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}))

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(),
}))

// v2 wait is unavailable in this test environment, so every attempt falls back to poll.
vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn().mockReturnValue({
    v2: {session: {wait: vi.fn().mockRejectedValue(new Error('v2 not available in test'))}},
  }),
}))

vi.mock('./prompt.js', () => ({
  buildAgentPrompt: vi.fn().mockReturnValue({text: 'Built prompt', referenceFiles: []}),
}))

vi.mock('./reference-files.js', () => ({
  materializeReferenceFiles: vi.fn().mockResolvedValue([]),
}))

function createMockPromptOptions(): PromptOptions {
  return {
    context: {
      eventName: 'issue_comment',
      repo: 'owner/repo',
      ref: 'refs/heads/main',
      actor: 'test-user',
      runId: '12345',
      issueNumber: 42,
      issueTitle: 'Test Issue',
      issueType: 'issue',
      commentBody: 'Test comment',
      commentAuthor: 'commenter',
      commentId: 999,
      defaultBranch: 'main',
      diffContext: null,
      hydratedContext: null,
      authorAssociation: null,
      isRequestedReviewer: false,
    },
    customPrompt: null,
    cacheStatus: 'hit',
    responseSurface: 'issue-comment',
  }
}

function backgroundDispatchEvent(sessionID: string, jobId: string, label = 'background task'): Event {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: {
        type: 'tool',
        tool: 'task',
        state: {status: 'completed', title: label, metadata: {background: true, jobId}},
      },
    },
  } as unknown as Event
}

function injectedCompletionEvent(rootSessionID: string, childSessionID: string): Event {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: rootSessionID,
      part: {
        type: 'text',
        text: `<task id="${childSessionID}" state="completed">\ndone\n</task>`,
        time: {start: 1, end: 2},
      },
    },
  } as unknown as Event
}

function activityEvent(sessionID: string): Event {
  return {
    type: 'message.part.delta',
    properties: {sessionID, delta: {type: 'text', text: 'activity'}},
  } as unknown as Event
}

function idleEvent(sessionID: string): Event {
  return {type: 'session.idle', properties: {sessionID}} as unknown as Event
}

function permissionAskedEvent(sessionID: string, requestID = 'request-id'): Event {
  return {
    type: 'permission.asked',
    properties: {id: requestID, sessionID, permission: 'bash', patterns: ['*']},
  } as unknown as Event
}

/** Yields `events` only once `promptAsync` has actually been called -- mirrors opencode.test.ts's timing fixture. */
function createPromptStartedEventStream(
  promptAsync: ReturnType<typeof vi.fn>,
  events: readonly Event[],
): AsyncIterable<Event> {
  return (async function* () {
    const callsBeforeSubscribe = promptAsync.mock.calls.length
    while (promptAsync.mock.calls.length === callsBeforeSubscribe) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    await Promise.resolve()
    for (const event of events) yield event
    await new Promise<never>(() => undefined)
  })()
}

function createMockClient(events: readonly Event[]) {
  const promptAsync = vi.fn().mockResolvedValue({data: {parts: [{type: 'text', text: 'ok'}]}})
  const statusSequence = [{ses_root: {type: 'busy'}}, {ses_root: {type: 'idle'}}]
  let statusIndex = 0
  return {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: 'ses_root', title: 'Test', version: '1'}}),
      update: vi.fn().mockResolvedValue({data: {}}),
      abort: vi.fn().mockResolvedValue({data: undefined}),
      promptAsync,
      messages: vi.fn().mockResolvedValue({data: []}),
      children: vi.fn().mockResolvedValue({data: []}),
      status: vi.fn().mockImplementation(async () => {
        const response = statusSequence[Math.min(statusIndex, statusSequence.length - 1)]
        statusIndex += 1
        return {data: response}
      }),
    },
    event: {
      subscribe: vi.fn().mockImplementation(async () => ({
        stream: createPromptStartedEventStream(promptAsync, events),
      })),
    },
  }
}

function mockSendPromptToSession(result: AttemptResult): ReturnType<typeof vi.fn> {
  const sendPromptToSession = vi.fn().mockResolvedValue(result)
  vi.doMock('./prompt-sender.js', () => ({
    sendPromptToSession,
    buildContinuationPrompt: vi.fn().mockReturnValue('continue from where the previous turn left off'),
  }))
  return sendPromptToSession
}

function mockOpencodeClient(): ReturnType<typeof createMockClient> {
  const client = createMockClient([])
  vi.mocked(createOpencode).mockResolvedValue({
    client: client as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
    server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
  })
  return client
}

/**
 * A controllable `ExecutionDeadline` double: `run()` mirrors the real admission check (throws a
 * `DeadlineExceededError`-named error when already expired), but `isExpired()`/`isTimedOut()` are
 * driven entirely by the test, not wall-clock time -- lets each row flip expiry at an exact point
 * in the sequence instead of racing fake timers.
 */
function createControlledDeadline(): {
  readonly deadline: ExecutionDeadline
  readonly setExpired: (value: boolean) => void
} {
  let expired = false
  const deadline: ExecutionDeadline = {
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    isExpired: () => expired,
    isTimedOut: () => expired,
    remainingMs: () => (expired ? 0 : 1_000),
    run: async operation => {
      if (expired) {
        const error = new Error('deadline exceeded (test double)')
        error.name = 'DeadlineExceededError'
        throw error
      }
      return operation()
    },
    dispose: vi.fn(),
  }
  return {deadline, setExpired: (value: boolean) => (expired = value)}
}

async function mockControlledDeadline(): Promise<ReturnType<typeof createControlledDeadline>> {
  const actualRetry = await vi.importActual<typeof import('./retry.js')>('./retry.js')
  const controlled = createControlledDeadline()
  vi.doMock('./retry.js', () => ({
    ...actualRetry,
    createExecutionDeadline: vi.fn().mockReturnValue(controlled.deadline),
  }))
  return controlled
}

describe('executeOpenCode — ownership ledger threading (Unit 11)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adopts and settles a real background dispatch end to end, then reaches drain with the populated ledger', async () => {
    // #given a caller-constructed ledger and a real SDK event stream carrying a background
    // dispatch (adopt) followed by its injected completion turn (settle) before session.idle
    const client = createMockClient([
      activityEvent('ses_root'),
      backgroundDispatchEvent('ses_root', 'ses_child', 'background task'),
      injectedCompletionEvent('ses_root', 'ses_child'),
      idleEvent('ses_root'),
    ])
    vi.mocked(createOpencode).mockResolvedValue({
      client: client as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
    })
    const ledger = createOwnershipLedger()

    // #when executeOpenCode runs the real chain (execution.ts -> prompt-sender.ts ->
    // retry.ts -> streaming.ts) with the ledger threaded through
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger, undefined, undefined, ledger)

    // #then the run succeeded through the real chain, and the SAME ledger object the caller
    // passed in recorded the dispatch and its settlement -- not a mock reporting success
    // regardless of whether adoption ever happened
    expect(result.success).toBe(true)
    expect(ledger.snapshot()).toContainEqual({sessionId: 'ses_child', label: 'background task', state: 'settled'})
    expect(ledger.outstanding()).toBe(0)

    // #and the populated ledger drains cleanly through the real runDrain used by the harness
    const drainOutcome = await runDrain({
      ledger,
      client: client as unknown as Parameters<typeof runDrain>[0]['client'],
      parentSessionId: 'ses_root',
      deadlineMs: 60_000,
      logger: mockLogger,
    })
    expect(drainOutcome).toMatchObject({expired: false, unknownCount: 0})
  })

  it('preserves the same ledger object across a retried attempt, rather than rebuilding it per attempt', async () => {
    // #given a first attempt that fails with a retryable LLM error and a second that succeeds --
    // forcing executeOpenCode's attempt loop to call sendPromptToSession twice
    vi.useFakeTimers()
    vi.resetModules()
    const retryableFailure = {
      success: false,
      error: 'transient rate limit',
      llmError: {type: 'rate_limit', message: 'rate limited', retryable: true},
      outcome: 'turn_failed_retryable',
      shouldRetry: true,
      settlement: {kind: 'failure-observed'},
      eventStreamResult: {
        tokens: null,
        model: null,
        cost: null,
        prsCreated: [],
        commitsCreated: [],
        commentsPosted: 0,
        llmError: {type: 'rate_limit', message: 'rate limited', retryable: true},
      },
    }
    const success = {
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
    const sendPromptToSession = vi.fn().mockResolvedValueOnce(retryableFailure).mockResolvedValueOnce(success)
    vi.doMock('./prompt-sender.js', () => ({
      sendPromptToSession,
      buildContinuationPrompt: vi.fn().mockReturnValue('continue from where the previous turn left off'),
    }))

    try {
      const {executeOpenCode: freshExecuteOpenCode} = await import('./execution.js')
      vi.mocked(createOpencode).mockResolvedValue({
        client: createMockClient([]) as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
      })
      const ledger = createOwnershipLedger()

      // #when executeOpenCode retries once
      const resultPromise = freshExecuteOpenCode(createMockPromptOptions(), mockLogger, undefined, undefined, ledger)
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await resultPromise

      // #then both attempts received the identical ledger reference -- the ledger is
      // constructed once outside the attempt loop, not rebuilt per attempt
      expect(sendPromptToSession).toHaveBeenCalledTimes(2)
      const firstLedgerArg = sendPromptToSession.mock.calls[0]?.[10] as unknown
      const secondLedgerArg = sendPromptToSession.mock.calls[1]?.[10] as unknown
      expect(firstLedgerArg).toBe(ledger)
      expect(secondLedgerArg).toBe(ledger)
      expect(result.success).toBe(true)
    } finally {
      vi.doUnmock('./prompt-sender.js')
      vi.resetModules()
      vi.useRealTimers()
    }
  })
})

function createDisabledProviders() {
  return {
    claude: 'no',
    copilot: 'no',
    gemini: 'no',
    openai: 'no',
    opencodeZen: 'no',
    zaiCodingPlan: 'no',
    kimiForCoding: 'no',
  } as const
}

/**
 * Prompt submission that fails immediately, and a session that never reports idle -- the poll
 * watchdog never completes on its own, so only the shared deadline forces a resolution.
 */
function createStuckMockClient(promptOutcome: {error: string} | {data: {parts: {type: string; text: string}[]}}) {
  const promptAsync = vi.fn().mockResolvedValue(promptOutcome)
  return {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: 'ses_root', title: 'Test', version: '1'}}),
      update: vi.fn().mockResolvedValue({data: {}}),
      abort: vi.fn().mockResolvedValue({data: undefined}),
      promptAsync,
      messages: vi.fn().mockResolvedValue({data: []}),
      children: vi.fn().mockResolvedValue({data: []}),
      status: vi.fn().mockResolvedValue({data: {ses_root: {type: 'busy'}}}),
    },
    event: {
      subscribe: vi.fn().mockImplementation(async () => ({
        stream: createPromptStartedEventStream(promptAsync, []),
      })),
    },
  }
}

describe('executeOpenCode — deadline teardown consults the shared deadline directly (round 3 regression)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports the original failure and aborts the expired remote session when a deferred failure survives deadline expiry', async () => {
    // #given a failed prompt submission (a real LLM-fetch-classified failure, not a synthesized
    // timeout), outstanding owned work that defers completion, and no other completion signal --
    // the session never reports idle, so only the shared deadline can end the attempt
    vi.useFakeTimers()
    const client = createStuckMockClient({error: 'fetch failed'})
    vi.mocked(createOpencode).mockResolvedValue({
      client: client as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
    })
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'background task')

    // #when the shared deadline expires while the ledger is still blocking completion
    const resultPromise = executeOpenCode(
      createMockPromptOptions(),
      mockLogger,
      {
        agent: null,
        model: null,
        timeoutMs: 1_000,
        omoProviders: createDisabledProviders(),
      },
      undefined,
      ledger,
    )
    await vi.advanceTimersByTimeAsync(4_000)
    const result = await resultPromise

    // #then the attempt reports the original submission failure, never a synthesized timeout message
    expect(result.success).toBe(false)
    expect(result.error).toBe('fetch failed')
    expect(result.error).not.toContain('Execution timed out')

    // #and no retry was attempted after the deadline expired, even though the preserved failure is
    // classified retryable (an LLM fetch error) and would otherwise be eligible for a resend
    expect(client.session.promptAsync).toHaveBeenCalledOnce()

    // #and teardown still aborts the remote session: the shared deadline is consulted directly in
    // executeOpenCode's finalizer instead of a caller-tracked flag, so a normal return that happened
    // only because a deferred failure survived deadline expiry still triggers cleanup
    expect(client.session.abort).toHaveBeenCalledOnce()
  })

  it('a successful deferred prompt at expiry is unaffected: still resolves to a timeout, with the remote session aborted', async () => {
    // #given a prompt submission that succeeds (startPrompt returns null, exactly as production's
    // sendPromptToSession does on success), outstanding owned work that defers completion, and no
    // other completion signal -- the deadline-expiration throw fires exactly as it did before this
    // fix, because no failure was ever preserved to suppress it
    vi.useFakeTimers()
    const client = createStuckMockClient({data: {parts: [{type: 'text', text: 'ok'}]}})
    vi.mocked(createOpencode).mockResolvedValue({
      client: client as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
    })
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'background task')

    // #when the shared deadline expires while the ledger is still blocking completion
    const resultPromise = executeOpenCode(
      createMockPromptOptions(),
      mockLogger,
      {
        agent: null,
        model: null,
        timeoutMs: 1_000,
        omoProviders: createDisabledProviders(),
      },
      undefined,
      ledger,
    )
    await vi.advanceTimersByTimeAsync(4_000)
    const result = await resultPromise

    // #then this remains a generic timeout, exactly as before -- the fix only changes the
    // deferred-*failure* path
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(130)
    expect(result.error).toBe('Execution timed out after 1000ms')

    // #and teardown still aborts the remote session
    expect(client.session.abort).toHaveBeenCalledOnce()
  })
})

const EMPTY_EVENT_STREAM_RESULT = {
  tokens: null,
  model: null,
  cost: null,
  prsCreated: [],
  commitsCreated: [],
  commentsPosted: 0,
  llmError: null,
}

describe('executeOpenCode — finalizer abort matrix (step 6 of the settlement restructure)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.doUnmock('./prompt-sender.js')
    vi.doUnmock('./retry.js')
    vi.doUnmock('./prompt.js')
    vi.resetModules()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // Row 1 (complement of the many existing "expired during cleanup" success tests in
  // opencode.test.ts, e.g. 'preserves terminal success when title reassertion crosses the
  // deadline') -- completed, deadline never expires, no abort.
  it('row 1: completed while the deadline has not expired does not abort', async () => {
    mockSendPromptToSession({
      success: true,
      error: null,
      llmError: null,
      outcome: 'completed',
      shouldRetry: false,
      settlement: {kind: 'completion-observed'},
      eventStreamResult: EMPTY_EVENT_STREAM_RESULT,
    })
    const {executeOpenCode: freshExecuteOpenCode} = await import('./execution.js')
    const client = mockOpencodeClient()

    const result = await freshExecuteOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 60_000,
      omoProviders: createDisabledProviders(),
    })

    expect(result.success).toBe(true)
    expect(client.session.abort).not.toHaveBeenCalled()
  })

  // Row 3 (complement of the existing opencode.test.ts row-4 pin, 'preserves a pre-deadline
  // retryable failure when cleanup crosses the deadline without retrying') -- a terminal failure
  // decided well before the deadline, deadline still open, no abort.
  it('row 3: a terminal failure decided before the deadline expires does not abort', async () => {
    mockSendPromptToSession({
      success: false,
      error: 'model provider rejected the request',
      llmError: null,
      outcome: 'turn_failed_terminal',
      shouldRetry: false,
      settlement: {kind: 'failure-observed'},
      eventStreamResult: EMPTY_EVENT_STREAM_RESULT,
    })
    const {executeOpenCode: freshExecuteOpenCode} = await import('./execution.js')
    const client = mockOpencodeClient()

    const result = await freshExecuteOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 60_000,
      omoProviders: createDisabledProviders(),
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('model provider rejected the request')
    expect(client.session.abort).not.toHaveBeenCalled()
  })

  // Rows 6/7: a ledger-deferred failure that resolved on its own, before the deadline. Row 6 asks
  // before the deadline later expires at all; row 7 asks with the deadline expiring afterward
  // during unrelated cleanup (inspectResponseFile, mocked here to flip the deadline double after
  // `sendPromptToSession` has already settled). Neither aborts -- the failure was decided, not the
  // deadline. This replaces the old "round 6 regression" coverage, which pinned a `deadlineConcluded`
  // field retry.ts no longer populates (removed in steps 3b/5 of this restructure); these two prove
  // the same real property against `executeOpenCode`'s own capture, not a fabricated field.
  it('row 6: a ledger-deferred failure resolved before the deadline does not abort', async () => {
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'background task')
    ledger.settle('ses_child')
    mockSendPromptToSession({
      success: false,
      error: 'ledger-deferred failure resolved before the deadline',
      llmError: null,
      outcome: 'turn_failed_terminal',
      shouldRetry: false,
      settlement: {kind: 'failure-observed'},
      eventStreamResult: EMPTY_EVENT_STREAM_RESULT,
    })
    const {executeOpenCode: freshExecuteOpenCode} = await import('./execution.js')
    const client = mockOpencodeClient()

    const result = await freshExecuteOpenCode(
      createMockPromptOptions(),
      mockLogger,
      {agent: null, model: null, timeoutMs: 60_000, omoProviders: createDisabledProviders()},
      undefined,
      ledger,
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('ledger-deferred failure resolved before the deadline')
    expect(client.session.abort).not.toHaveBeenCalled()
  })

  it('row 7: a ledger-deferred failure resolved before the deadline does not abort even when the deadline expires during later cleanup', async () => {
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'background task')
    ledger.settle('ses_child')
    const {setExpired} = await mockControlledDeadline()
    mockSendPromptToSession({
      success: false,
      error: 'ledger-deferred failure resolved before the deadline',
      llmError: null,
      outcome: 'turn_failed_terminal',
      shouldRetry: false,
      settlement: {kind: 'failure-observed'},
      eventStreamResult: EMPTY_EVENT_STREAM_RESULT,
    })
    // inspectResponseFile runs strictly after executeOpenCode captures this attempt's settle-time
    // deadline state -- flipping expiry here simulates unrelated post-decision cleanup crossing the
    // deadline, exactly like the real reassertSessionTitle/SSE-shutdown timing this test stands in for.
    vi.doMock('./response-file.js', () => ({
      inspectResponseFile: vi.fn().mockImplementation(async () => {
        setExpired(true)
        return 'absent'
      }),
    }))
    const {executeOpenCode: freshExecuteOpenCode} = await import('./execution.js')
    const client = mockOpencodeClient()

    const result = await freshExecuteOpenCode(
      createMockPromptOptions(),
      mockLogger,
      {agent: null, model: null, timeoutMs: 1_000, omoProviders: createDisabledProviders()},
      undefined,
      ledger,
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('ledger-deferred failure resolved before the deadline')
    expect(result.error).not.toContain('Execution timed out')
    expect(client.session.abort).not.toHaveBeenCalled()
  })

  it('retry-exhaustion reaches the same post-loop path as any other decided failure: the last attempt governs abort, not a separate branch', async () => {
    // #given every attempt (up to MAX_LLM_RETRIES) reports a retryable failure that resolved well
    // before the deadline -- proving retry exhaustion shares the same per-attempt-captured cause as
    // a single decisive break, not a separate code path
    vi.useFakeTimers()
    const retryableFailure: AttemptResult = {
      success: false,
      error: 'retryable failure resolved before the deadline',
      llmError: {type: 'rate_limit', message: 'rate limited', retryable: true},
      outcome: 'turn_failed_retryable',
      shouldRetry: true,
      settlement: {kind: 'failure-observed'},
      eventStreamResult: EMPTY_EVENT_STREAM_RESULT,
    }
    const sendPromptToSession = mockSendPromptToSession(retryableFailure)
    const {executeOpenCode: freshExecuteOpenCode} = await import('./execution.js')
    const client = mockOpencodeClient()

    // #when — a generous budget so the loop exhausts retries on its own merits, not because the
    // shared deadline expired mid-retry
    const resultPromise = freshExecuteOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 600_000,
      omoProviders: createDisabledProviders(),
    })
    await vi.advanceTimersByTimeAsync(600_000)
    const result = await resultPromise

    // #then — every attempt was used, the final failure is reported, and no abort fires
    expect(sendPromptToSession).toHaveBeenCalledTimes(MAX_LLM_RETRIES)
    expect(result.success).toBe(false)
    expect(result.error).toBe('retryable failure resolved before the deadline')
    expect(client.session.abort).not.toHaveBeenCalled()
  })

  // Rows 10/11: an unexpected, non-deadline-tagged exception. Row 10 proves the deliberate
  // asymmetry from the brief's note -- nothing was decided, so an already-expired clock still
  // aborts (absence of a settlement, not the clock deciding). Row 11 is its required complement.
  it.each([
    {
      expiredAtThrow: true,
      expectAbort: true,
      label: 'row 10: an unexpired-untagged exception aborts when the deadline had already expired',
    },
    {
      expiredAtThrow: false,
      expectAbort: false,
      label: 'row 11: an unexpired-untagged exception does not abort when the deadline has not expired',
    },
  ])('$label', async ({expiredAtThrow, expectAbort}) => {
    const {setExpired} = await mockControlledDeadline()
    // Session creation (an earlier deadline.run() call) must still succeed, so the deadline flips
    // to expired only once the unrelated exception is about to throw -- proving the exception
    // itself is what execution.ts reacts to, not an already-failing setup step.
    vi.doMock('./prompt.js', () => ({
      buildAgentPrompt: vi.fn().mockImplementation(() => {
        setExpired(expiredAtThrow)
        throw new Error('unexpected failure unrelated to the deadline')
      }),
    }))
    const {executeOpenCode: freshExecuteOpenCode} = await import('./execution.js')
    const client = mockOpencodeClient()

    const result = await freshExecuteOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 1_000,
      omoProviders: createDisabledProviders(),
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('unexpected failure unrelated to the deadline')
    expect(result.exitCode).toBe(1)
    expect(client.session.abort).toHaveBeenCalledTimes(expectAbort ? 1 : 0)
  })

  // Row 12: plain success, no ledger, well inside budget -- the baseline case every other row is a
  // deviation from.
  it('row 12: success with no ledger, inside budget, does not abort', async () => {
    mockSendPromptToSession({
      success: true,
      error: null,
      llmError: null,
      outcome: 'completed',
      shouldRetry: false,
      settlement: {kind: 'completion-observed'},
      eventStreamResult: EMPTY_EVENT_STREAM_RESULT,
    })
    const {executeOpenCode: freshExecuteOpenCode} = await import('./execution.js')
    const client = mockOpencodeClient()

    const result = await freshExecuteOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 60_000,
      omoProviders: createDisabledProviders(),
    })

    expect(result.success).toBe(true)
    expect(client.session.abort).not.toHaveBeenCalled()
  })

  // Lifecycle: a retryable failure with the ledger still outstanding must not start a continuation,
  // even though the outcome alone would otherwise qualify.
  it('lifecycle: a retryable failure with an outstanding ledger entry starts no continuation', async () => {
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'background task') // never settled -- outstanding for the whole run
    const retryableFailure: AttemptResult = {
      success: false,
      error: 'retryable failure with owned work still outstanding',
      llmError: {type: 'rate_limit', message: 'rate limited', retryable: true},
      outcome: 'turn_failed_retryable',
      shouldRetry: true,
      settlement: {kind: 'failure-observed'},
      eventStreamResult: EMPTY_EVENT_STREAM_RESULT,
    }
    const sendPromptToSession = mockSendPromptToSession(retryableFailure)
    const {executeOpenCode: freshExecuteOpenCode} = await import('./execution.js')
    mockOpencodeClient()

    const result = await freshExecuteOpenCode(
      createMockPromptOptions(),
      mockLogger,
      {agent: null, model: null, timeoutMs: 60_000, omoProviders: createDisabledProviders()},
      undefined,
      ledger,
    )

    expect(sendPromptToSession).toHaveBeenCalledOnce()
    expect(result.success).toBe(false)
    expect(result.error).toBe('retryable failure with owned work still outstanding')
  })

  it('aborts unfinished remote work when isExpired() is true but isTimedOut() remains false (the finalizer must consult isExpired(), not isTimedOut())', async () => {
    // #given a deadline double whose isTimedOut() never latches -- only isExpired() reports the
    // expiry. The existing "unlatched" regression coverage pins this distinction inside
    // runPromptAttempt (retry.ts); nothing previously pinned it at the executeOpenCode finalizer
    // itself, so this is a genuinely new assertion. The finalizer itself never calls either --
    // this proves the *admission* check at the top of the retry loop (which does) correctly sets
    // the selected stopping cause the finalizer then trusts.
    const actualRetry = await vi.importActual<typeof import('./retry.js')>('./retry.js')
    const deadline: ExecutionDeadline = {
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      isExpired: () => true,
      isTimedOut: () => false,
      remainingMs: () => 0,
      run: async operation => operation(),
      dispose: vi.fn(),
    }
    vi.doMock('./retry.js', () => ({
      ...actualRetry,
      createExecutionDeadline: vi.fn().mockReturnValue(deadline),
    }))
    const {executeOpenCode: freshExecuteOpenCode} = await import('./execution.js')
    const client = mockOpencodeClient()

    // #when — the deadline reports expired from the very first check, before any attempt is made
    const result = await freshExecuteOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 1_000,
      omoProviders: createDisabledProviders(),
    })

    // #then — no attempt was ever made (immediate timeoutResult()), yet the finalizer still aborts
    // the created remote session exactly once because isExpired() is true, proving it does not gate
    // on isTimedOut() instead
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(130)
    expect(client.session.abort).toHaveBeenCalledOnce()
  })
})

describe('executeOpenCode — permission reply validation and bounded retry (review fix)', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects a permission reply whose SDK response carries an embedded error, retries once, and logs the confirmed failure (not a silently-swallowed success)', async () => {
    // #given the SDK's own HTTP client resolving with an embedded `error` field on every
    // attempt — exactly the shape a genuinely failed reply takes upstream (mirrors
    // `sendPromptToSession`'s `response.error` check on the same client), which a naive
    // `await` without inspecting the response would previously have treated as success
    const postSessionIdPermissionsPermissionId = vi.fn().mockResolvedValue({data: undefined, error: 'denied: boom'})
    const mockClient = {
      ...createMockClient([activityEvent('ses_root'), permissionAskedEvent('ses_root'), idleEvent('ses_root')]),
      postSessionIdPermissionsPermissionId,
    }
    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
    })

    // #when executeOpenCode runs the real chain end to end
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then the run itself is unaffected (the reply is fire-and-continue, Finding 3) --
    expect(result.success).toBe(true)
    // #then the reply was retried up to the bounded attempt limit, not accepted on the first
    // resolved-but-failed response
    expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(2)
    // #then the failure actually reached the log — the embedded `error` was inspected, not
    // discarded the way a bare `await` on the SDK call would
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to reject OpenCode permission request',
      expect.objectContaining({eventSessionID: 'ses_root', error: expect.stringContaining('denied: boom') as string}),
    )
  })

  it('complement: an ordinary successful reply still settles and is not reported as a failure', async () => {
    // #given the SDK resolving with real data and no embedded error — the ordinary case
    const postSessionIdPermissionsPermissionId = vi.fn().mockResolvedValue({data: {}, error: undefined})
    const mockClient = {
      ...createMockClient([activityEvent('ses_root'), permissionAskedEvent('ses_root'), idleEvent('ses_root')]),
      postSessionIdPermissionsPermissionId,
    }
    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
    })

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then exactly one attempt, no failure logged
    expect(result.success).toBe(true)
    expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1)
    expect(mockLogger.warning).not.toHaveBeenCalledWith(
      'Failed to reject OpenCode permission request',
      expect.anything(),
    )
  })
})
