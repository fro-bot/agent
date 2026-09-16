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
import type {PromptOptions} from './types.js'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {createOpencode} from '@opencode-ai/sdk'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {runDrain} from '../../harness/phases/execute.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {executeOpenCode} from './execution.js'

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
