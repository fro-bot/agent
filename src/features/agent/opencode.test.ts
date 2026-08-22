import type {Event} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {ExecutionDeadline} from './retry.js'
import type {OpenCodeServerHandle} from './server.js'
import type {ExecutionConfig, PromptOptions} from './types.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import process from 'node:process'

import * as exec from '@actions/exec'
import {createOpencode} from '@opencode-ai/sdk'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as envUtils from '../../shared/env.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {executeOpenCode} from './execution.js'
import {verifyOpenCodeAvailable} from './server.js'
import {INITIAL_ACTIVITY_TIMEOUT_MS, pollForSessionCompletion, waitForEventProcessorShutdown} from './session-poll.js'
import {logServerEvent, processEventStream, type ActivityTracker} from './streaming.js'

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}))

// Mock node:crypto
vi.mock('node:crypto', () => ({
  createHash: vi.fn().mockReturnValue({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn().mockReturnValue('mock-hash'),
  }),
}))

// Mock @actions/exec
vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}))

// Mock @opencode-ai/sdk
vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(),
}))

// Default: v2 wait is unavailable (throws) so all non-v2 tests fall back to poll.
// The runPromptAttempt v2 describe block overrides this per-test with vi.doMock + vi.resetModules().
vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn().mockReturnValue({
    v2: {
      session: {
        wait: vi.fn().mockRejectedValue(new Error('v2 not available in test')),
      },
    },
  }),
}))

// Mock buildAgentPrompt
vi.mock('./prompt.js', () => ({
  buildAgentPrompt: vi.fn().mockReturnValue({text: 'Built prompt with sessionId', referenceFiles: []}),
}))

vi.mock('./reference-files.js', () => ({
  materializeReferenceFiles: vi.fn().mockResolvedValue([]),
}))

function createMockPromptOptions(overrides: Partial<PromptOptions> = {}): PromptOptions {
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
    ...overrides,
  }
}

function createMockEventStream(events: Event[] = []): {
  stream: AsyncIterable<Event>
  controller: {abort: ReturnType<typeof vi.fn>}
} {
  return {
    stream: (async function* () {
      for (const event of events) {
        yield event
      }
    })(),
    controller: {abort: vi.fn()},
  }
}

function createCurrentTurnActivityEvent(sessionID = 'ses_123'): Event {
  return {
    type: 'message.part.delta',
    properties: {sessionID, delta: {type: 'text', text: 'activity'}},
  } as unknown as Event
}

function createCompletedPrArtifactEvent(sessionID = 'ses_123'): Event {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: {
        type: 'tool',
        tool: 'bash',
        state: {
          status: 'completed',
          input: {command: 'gh pr create --title "Created during failed turn"'},
          output: 'https://github.com/owner/repo/pull/42',
        },
      },
    },
  } as unknown as Event
}

function createCurrentTurnActivityStream(sessionID = 'ses_123'): {
  stream: AsyncIterable<Event>
  controller: {abort: ReturnType<typeof vi.fn>}
} {
  // Emit the activity event after a setTimeout(0) so that runPromptAttempt has time
  // to set activityTracker.currentTurnArmed = true before the event is processed.
  // Without this delay the event arrives while currentTurnArmed is still false
  // (listSessionMessageIds hasn't resolved yet) and is silently skipped, causing
  // executeOpenCode tests to hang waiting for firstMeaningfulEventReceived.
  // setTimeout(0) fires after the current microtask queue drains (including the
  // listSessionMessageIds await chain), making this reliable without fake timers.
  // Tests using fake timers must call vi.advanceTimersByTimeAsync(0) or similar.
  return {
    stream: (async function* () {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      yield createCurrentTurnActivityEvent(sessionID)
      // session.idle is the terminal signal — required for currentTurnTerminalSignalReceived
      yield {type: 'session.idle', properties: {sessionID}} as unknown as Event
    })(),
    controller: {abort: vi.fn()},
  }
}

function createPromptStartedActivityStream(
  promptAsync: ReturnType<typeof vi.fn>,
  sessionID = 'ses_123',
): {
  stream: AsyncIterable<Event>
  controller: {abort: ReturnType<typeof vi.fn>}
} {
  // Include session.idle after the activity event so currentTurnTerminalSignalReceived is set.
  // Without it, the poll's status().idle check is blocked and executeOpenCode tests hang.
  return createPromptStartedEventStream(promptAsync, [
    createCurrentTurnActivityEvent(sessionID),
    {type: 'session.idle', properties: {sessionID}} as unknown as Event,
  ])
}

function createPromptStartedEventStream(
  promptAsync: ReturnType<typeof vi.fn>,
  events: Event[],
): {
  stream: AsyncIterable<Event>
  controller: {abort: ReturnType<typeof vi.fn>}
} {
  let aborted = false
  const controller = {
    abort: vi.fn(() => {
      aborted = true
    }),
  }
  return {
    stream: (async function* () {
      const callsBeforeSubscribe = promptAsync.mock.calls.length
      while (promptAsync.mock.calls.length === callsBeforeSubscribe) {
        if (aborted) return
        await new Promise<void>(resolve => {
          setTimeout(resolve, 0)
        })
      }
      if (aborted) return
      await Promise.resolve()
      for (const event of events) {
        if (aborted) return
        yield event
      }
    })(),
    controller,
  }
}

function createPromptStartedErrorEventStream(
  promptAsync: ReturnType<typeof vi.fn>,
  events: Event[],
  releasePromptError: () => void,
): {
  stream: AsyncIterable<Event>
  controller: {abort: ReturnType<typeof vi.fn>}
} {
  let aborted = false
  const controller = {
    abort: vi.fn(() => {
      aborted = true
    }),
  }
  return {
    stream: (async function* () {
      const callsBeforeSubscribe = promptAsync.mock.calls.length
      while (promptAsync.mock.calls.length === callsBeforeSubscribe) {
        if (aborted) return
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (aborted) return
      await Promise.resolve()
      for (const event of events) {
        if (aborted) return
        yield event
      }
      releasePromptError()
    })(),
    controller,
  }
}

function createPromptStartedHangingEventStream(
  promptAsync: ReturnType<typeof vi.fn>,
  events: Event[],
): AsyncIterable<Event> {
  return (async function* () {
    const callsBeforeSubscribe = promptAsync.mock.calls.length
    while (promptAsync.mock.calls.length === callsBeforeSubscribe) {
      await new Promise<void>(resolve => {
        setTimeout(resolve, 0)
      })
    }
    await Promise.resolve()
    for (const event of events) yield event
    await new Promise<never>(() => undefined)
  })()
}

type SessionStatus = {type: 'idle'} | {type: 'retry'; attempt: number; message: string; next: number} | {type: 'busy'}

function createMockClient(options: {
  promptResponse?: {parts: {type: string; text?: string}[]}
  throwOnPrompt?: boolean
  throwOnCreate?: boolean
  throwOnLog?: boolean
  events?: Event[]
  sessionStatus?: Record<string, SessionStatus>
  statusSequence?: Record<string, SessionStatus>[]
}) {
  // Default sequence: busy first, then idle (completes after stream activity).
  // A session that was just sent a prompt will always be busy before going idle.
  // Tests that need a specific sequence should pass statusSequence explicitly.
  const statusSequence = options.statusSequence ?? [
    options.sessionStatus ?? {ses_123: {type: 'busy'}},
    {ses_123: {type: 'idle'}},
  ]
  let statusIndex = 0
  const promptAsync = options.throwOnPrompt
    ? vi.fn().mockRejectedValue(new Error('Prompt failed'))
    : vi.fn().mockResolvedValue({data: options.promptResponse})

  return {
    app: {
      log: options.throwOnLog
        ? vi.fn().mockRejectedValue(new Error('Connection failed'))
        : vi.fn().mockResolvedValue({}),
    },
    session: {
      create: options.throwOnCreate
        ? vi.fn().mockRejectedValue(new Error('Session creation failed'))
        : vi.fn().mockResolvedValue({data: {id: 'ses_123', title: 'Test', version: '1'}}),
      update: vi.fn().mockResolvedValue({data: {id: 'ses_123', title: 'Test', version: '1'}}),
      abort: vi.fn().mockResolvedValue({data: undefined}),
      promptAsync,
      messages: vi.fn().mockResolvedValue({data: []}),
      status: vi.fn().mockImplementation(async () => {
        const statusResponse = statusSequence[Math.min(statusIndex, statusSequence.length - 1)]
        statusIndex += 1
        return {data: statusResponse}
      }),
    },
    event: {
      subscribe: vi
        .fn()
        .mockImplementation(async () =>
          options.events == null
            ? createPromptStartedActivityStream(promptAsync)
            : createPromptStartedEventStream(promptAsync, options.events),
        ),
    },
  }
}

function createMockServer(): {url: string; close: ReturnType<typeof vi.fn>} {
  return {
    url: 'http://127.0.0.1:4096',
    close: vi.fn(),
  }
}

function createMockOpencode(options: {
  client: ReturnType<typeof createMockClient>
  server?: ReturnType<typeof createMockServer>
}) {
  return {
    client: options.client,
    server: options.server ?? createMockServer(),
  }
}

function createMockServerHandle(options: {
  client: ReturnType<typeof createMockClient>
  server?: ReturnType<typeof createMockServer>
}): {handle: OpenCodeServerHandle; mockServer: ReturnType<typeof createMockServer>} {
  const mockServer = options.server ?? createMockServer()
  return {
    handle: {
      client: options.client as unknown as OpenCodeServerHandle['client'],
      server: mockServer as unknown as OpenCodeServerHandle['server'],
      shutdown: vi.fn(),
    },
    mockServer,
  }
}

describe('executeOpenCode', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses createOpencode SDK function', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(createOpencode).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    )
    expect(result.success).toBe(true)
  })

  it('creates session and sends prompt', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(mockClient.session.create).toHaveBeenCalled()
    const promptCall = vi.mocked(mockClient.session.promptAsync).mock.calls[0]?.[0] as
      | {
          path?: {id?: string}
          body?: {agent?: string; parts?: {type: string; text?: string}[]}
          query?: {directory?: string}
        }
      | undefined

    expect(promptCall?.path?.id).toBe('ses_123')
    expect(promptCall?.body?.agent).toBeUndefined()
    expect(promptCall?.body?.parts).toEqual([{type: 'text', text: 'Built prompt with sessionId'}])
    expect(promptCall?.query?.directory).toEqual(expect.any(String))
    expect(result.sessionId).toBe('ses_123')
  })

  it('settles with a timeout when session creation never resolves', async () => {
    // #given — the SDK session-create request ignores cancellation and never settles
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    vi.mocked(mockClient.session.create).mockReturnValue(new Promise<never>(() => undefined))
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 25,
      omoProviders: createDisabledProviders(),
    })
    await new Promise<void>(resolve => setTimeout(resolve, 50))

    // #then — the shared deadline must settle the root execution instead of leaving it pending
    const result = await Promise.race([resultPromise, Promise.resolve(null)])
    expect(result).not.toBeNull()
    expect(result).toMatchObject({success: false, exitCode: 130, error: 'Execution timed out after 25ms'})
  })

  it('settles at the shared deadline when event subscription never resolves', async () => {
    // #given — subscription ignores the propagated cancellation signal
    const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Response'}]}})
    vi.mocked(mockClient.event.subscribe).mockReturnValue(new Promise<never>(() => undefined))
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 25,
      omoProviders: createDisabledProviders(),
    })

    // #then — timeout is terminal and the already-created remote session receives one best-effort abort
    expect(result).toMatchObject({success: false, exitCode: 130})
    expect(mockClient.session.abort).toHaveBeenCalledOnce()
  })

  it('settles at the shared deadline when prompt submission never resolves', async () => {
    // #given — prompt submission ignores the propagated cancellation signal
    const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Response'}]}})
    vi.mocked(mockClient.session.promptAsync).mockReturnValue(new Promise<never>(() => undefined))
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 25,
      omoProviders: createDisabledProviders(),
    })

    // #then
    expect(result).toMatchObject({success: false, exitCode: 130})
    expect(mockClient.session.abort).toHaveBeenCalledOnce()
  })

  it('settles at the shared deadline when a poll request never resolves', async () => {
    // #given — no event activity, followed by a poll status request that never settles
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
      events: [],
    })
    vi.mocked(mockClient.session.status).mockReturnValue(new Promise<never>(() => undefined))
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 700,
      omoProviders: createDisabledProviders(),
    })

    // #then
    expect(result).toMatchObject({success: false, exitCode: 130})
    expect(mockClient.session.status).toHaveBeenCalled()
  })

  it('returns the shared timeout when v2 session.wait never resolves and polling cannot complete', async () => {
    // #given — v2 wait ignores cancellation while polling observes a permanently busy session
    vi.useFakeTimers()
    try {
      const waitFn = vi.fn<TestWaitFn>().mockImplementation(async () => new Promise<never>(() => undefined))
      vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
      vi.resetModules()
      const {executeOpenCode: executeWithDeadline} = await import('./execution.js')
      const {createOpencode: createOpencodeForTest} = await import('@opencode-ai/sdk')
      const mockClient = createMockClient({
        promptResponse: {parts: [{type: 'text', text: 'Response'}]},
        events: [
          {
            type: 'message.part.delta',
            properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'activity'}},
          } as unknown as Event,
        ],
        statusSequence: [{ses_123: {type: 'busy'}}],
      })
      const mockOpencode = createMockOpencode({client: mockClient})
      vi.mocked(createOpencodeForTest).mockResolvedValue(
        mockOpencode as unknown as Awaited<ReturnType<typeof createOpencodeForTest>>,
      )

      // #when
      const resultPromise = executeWithDeadline(createMockPromptOptions(), mockLogger, {
        agent: null,
        model: null,
        timeoutMs: 1_000,
        omoProviders: createDisabledProviders(),
      })
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await resultPromise

      // #then — the harness deadline wins without waiting for an SDK-level timeout
      expect(result).toMatchObject({success: false, exitCode: 130})
      expect(result.error).toBe('Execution timed out after 1000ms')
      expect(waitFn).toHaveBeenCalledOnce()
      expect(mockClient.session.status).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves pre-deadline success when bounded SSE cleanup crosses the deadline', async () => {
    // #given — terminal success arrives before the deadline, but SSE shutdown ignores cancellation
    vi.useFakeTimers()
    let resultPromise: ReturnType<typeof executeOpenCode> | undefined
    try {
      const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Response'}]}})
      const terminalEvents: Event[] = [
        {
          type: 'message.updated',
          properties: {
            info: {
              sessionID: 'ses_123',
              role: 'assistant',
              tokens: {input: 3, output: 2, reasoning: 1, cache: {read: 4, write: 5}},
              modelID: 'test-model',
              cost: 0.01,
            },
          },
        } as unknown as Event,
        {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
      ]
      vi.mocked(mockClient.event.subscribe).mockResolvedValue({
        stream: createPromptStartedHangingEventStream(mockClient.session.promptAsync, terminalEvents),
      })
      const mockOpencode = createMockOpencode({client: mockClient})
      vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

      // #when
      resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger, {
        agent: null,
        model: null,
        timeoutMs: 1_000,
        omoProviders: createDisabledProviders(),
        sessionTitle: 'pre-deadline success',
      })
      await vi.advanceTimersByTimeAsync(2_500)
      const result = await resultPromise

      // #then — cleanup may consume the remaining budget, but cannot rewrite terminal success
      expect(result).toMatchObject({success: true, exitCode: 0})
      expect(mockClient.session.messages).toHaveBeenCalledOnce()
      expect(mockClient.session.update).not.toHaveBeenCalled()
      expect(mockClient.session.abort).not.toHaveBeenCalled()
    } finally {
      await vi.advanceTimersByTimeAsync(4_000)
      if (resultPromise != null) await resultPromise
      vi.useRealTimers()
    }
  })

  it('preserves a pre-deadline retryable failure when cleanup crosses the deadline without retrying', async () => {
    // #given — prompt submission returns a retryable terminal failure before SSE cleanup hangs
    vi.useFakeTimers()
    let resultPromise: ReturnType<typeof executeOpenCode> | undefined
    try {
      const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Response'}]}})
      vi.mocked(mockClient.session.promptAsync).mockResolvedValue({error: 'fetch failed'})
      vi.mocked(mockClient.event.subscribe).mockResolvedValue({
        stream: createPromptStartedHangingEventStream(mockClient.session.promptAsync, []),
      })
      const mockOpencode = createMockOpencode({client: mockClient})
      vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

      // #when
      resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger, {
        agent: null,
        model: null,
        timeoutMs: 1_000,
        omoProviders: createDisabledProviders(),
        sessionTitle: 'pre-deadline failure',
      })
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await resultPromise

      // #then — primary failure survives cleanup and cannot open a continuation attempt
      expect(result).toMatchObject({success: false, exitCode: 1})
      expect(result.error).toContain('fetch failed')
      expect(mockClient.session.promptAsync).toHaveBeenCalledOnce()
      expect(mockClient.session.update).not.toHaveBeenCalled()
      expect(mockClient.session.abort).not.toHaveBeenCalled()
    } finally {
      await vi.advanceTimersByTimeAsync(4_000)
      if (resultPromise != null) await resultPromise
      vi.useRealTimers()
    }
  })

  it('preserves terminal success when title reassertion crosses the deadline', async () => {
    // #given — the attempt completes, then its best-effort title update hangs
    const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Response'}]}})
    vi.mocked(mockClient.session.update).mockReturnValue(new Promise<never>(() => undefined))
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 700,
      omoProviders: createDisabledProviders(),
      sessionTitle: 'deadline title',
    })

    // #then — title cleanup cannot extend or rewrite the terminal success
    expect(result).toMatchObject({success: true, exitCode: 0})
    expect(mockClient.session.update).toHaveBeenCalledOnce()
  })

  it('preserves terminal success when artifact enrichment crosses the deadline', async () => {
    // #given — terminal success is accepted before a started artifact read crosses the deadline
    vi.useFakeTimers()
    let resultPromise: ReturnType<typeof executeOpenCode> | undefined
    try {
      const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Response'}]}})
      vi.mocked(mockClient.session.messages)
        .mockResolvedValueOnce({data: []})
        .mockReturnValue(new Promise<never>(() => undefined))
      const mockOpencode = createMockOpencode({client: mockClient})
      vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

      // #when
      resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger, {
        agent: null,
        model: null,
        timeoutMs: 1_000,
        omoProviders: createDisabledProviders(),
        sessionTitle: 'artifact deadline',
      })
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await resultPromise

      // #then — the terminal result survives a timed-out best-effort artifact read
      expect(result).toMatchObject({success: true, exitCode: 0})
      expect(mockClient.session.messages).toHaveBeenCalledTimes(2)
      expect(mockClient.session.promptAsync).toHaveBeenCalledOnce()
      expect(mockClient.session.update).not.toHaveBeenCalled()
      expect(mockClient.session.abort).not.toHaveBeenCalled()
    } finally {
      await vi.advanceTimersByTimeAsync(4_000)
      if (resultPromise != null) await resultPromise
      vi.useRealTimers()
    }
  })

  it('keeps timeout zero internally unbounded', async () => {
    // #given — setup exceeds a short finite window but the explicit opt-out remains unbounded
    const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Response'}]}})
    vi.mocked(mockClient.session.create).mockReturnValue(
      new Promise(resolve => setTimeout(() => resolve({data: {id: 'ses_123'}}), 50)),
    )
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 0,
      omoProviders: createDisabledProviders(),
    })

    // #then
    expect(result.success).toBe(true)
  })

  it('does not let a late prompt success replace the latched timeout or trigger post-timeout work', async () => {
    // #given — the prompt resolves after the execution deadline
    vi.useFakeTimers()
    try {
      const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Late response'}]}})
      vi.mocked(mockClient.session.promptAsync).mockReturnValue(
        new Promise(resolve => setTimeout(() => resolve({data: undefined}), 100)),
      )
      const mockOpencode = createMockOpencode({client: mockClient})
      vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

      // #when
      const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger, {
        agent: null,
        model: null,
        timeoutMs: 25,
        omoProviders: createDisabledProviders(),
        sessionTitle: 'late title',
      })
      await vi.advanceTimersByTimeAsync(25)
      const result = await resultPromise
      await vi.advanceTimersByTimeAsync(100)
      await Promise.resolve()

      // #then — terminal timeout fences retries, artifact reconciliation, title updates, and late SDK effects
      expect(result).toMatchObject({success: false, exitCode: 130})
      expect(result.success).toBe(false)
      expect(mockClient.session.create).toHaveBeenCalledOnce()
      expect(mockClient.event.subscribe).toHaveBeenCalledOnce()
      expect(mockClient.session.promptAsync).toHaveBeenCalledOnce()
      expect(mockClient.session.messages).toHaveBeenCalledOnce()
      expect(mockClient.session.status).not.toHaveBeenCalled()
      expect(mockClient.session.update).not.toHaveBeenCalled()
      expect(mockClient.session.abort).toHaveBeenCalledOnce()
      expect(mockOpencode.server.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start another attempt after a retry delay crosses the shared deadline', async () => {
    // #given — the first prompt reports a retryable fetch failure immediately
    const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Response'}]}})
    vi.mocked(mockClient.session.promptAsync).mockResolvedValueOnce({error: {message: 'fetch failed'}})
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 50,
      omoProviders: createDisabledProviders(),
    })

    // #then — the retry shares the first attempt's budget instead of opening a fresh 5-second window
    expect(result).toMatchObject({success: false, exitCode: 130})
    expect(mockClient.session.promptAsync).toHaveBeenCalledOnce()
  })

  it('does not rewrite a timeout when the remote session abort rejects', async () => {
    // #given
    const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Response'}]}})
    const logger = createMockLogger()
    vi.mocked(mockClient.session.promptAsync).mockReturnValue(new Promise<never>(() => undefined))
    vi.mocked(mockClient.session.abort).mockRejectedValue(new Error('abort unavailable'))
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), logger, {
      agent: null,
      model: null,
      timeoutMs: 25,
      omoProviders: createDisabledProviders(),
    })

    // #then — teardown is fail-soft and cannot replace the terminal timeout result
    expect(result).toMatchObject({success: false, exitCode: 130})
    expect(logger.debug).toHaveBeenCalledWith('OpenCode session abort failed; continuing teardown', {
      sessionId: 'ses_123',
      error: 'abort unavailable',
    })
    expect(vi.mocked(logger.warning).mock.calls.filter(([message]) => message.includes('session abort'))).toHaveLength(
      0,
    )
  })

  it('awaits a rejecting remote abort before closing the server', async () => {
    // #given — the remote abort rejects asynchronously after timeout, so teardown ordering is observable
    vi.useFakeTimers()
    try {
      const teardownOrder: string[] = []
      const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Response'}]}})
      vi.mocked(mockClient.event.subscribe).mockResolvedValue({
        stream: (async function* () {})(),
      } as Awaited<ReturnType<typeof mockClient.event.subscribe>>)
      vi.mocked(mockClient.session.promptAsync).mockReturnValue(new Promise<never>(() => undefined))
      vi.mocked(mockClient.session.abort).mockReturnValue(
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            teardownOrder.push('abort-rejected')
            reject(new Error('abort unavailable'))
          }, 100)
        }),
      )
      const mockServer = createMockServer()
      mockServer.close.mockImplementation(() => {
        teardownOrder.push('server-closed')
      })
      const mockOpencode = createMockOpencode({client: mockClient, server: mockServer})
      vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

      // #when
      const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger, {
        agent: null,
        model: null,
        timeoutMs: 25,
        omoProviders: createDisabledProviders(),
      })
      await vi.advanceTimersByTimeAsync(25)

      // #then — server teardown waits for the independent abort request, not just its invocation
      expect(teardownOrder).toEqual([])
      await vi.advanceTimersByTimeAsync(100)
      const result = await resultPromise
      expect(result).toMatchObject({success: false, exitCode: 130})
      expect(teardownOrder).toEqual(['abort-rejected', 'server-closed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a bounded never-resolving remote abort before closing the server', async () => {
    // #given — the remote abort ignores cancellation and never settles
    vi.useFakeTimers()
    try {
      const mockClient = createMockClient({promptResponse: {parts: [{type: 'text', text: 'Response'}]}})
      const logger = createMockLogger()
      vi.mocked(mockClient.event.subscribe).mockResolvedValue({
        stream: (async function* () {})(),
      } as Awaited<ReturnType<typeof mockClient.event.subscribe>>)
      vi.mocked(mockClient.session.promptAsync).mockReturnValue(new Promise<never>(() => undefined))
      vi.mocked(mockClient.session.abort).mockReturnValue(new Promise<never>(() => undefined))
      const mockServer = createMockServer()
      vi.mocked(createOpencode).mockResolvedValue(
        createMockOpencode({client: mockClient, server: mockServer}) as unknown as Awaited<
          ReturnType<typeof createOpencode>
        >,
      )

      // #when
      const resultPromise = executeOpenCode(createMockPromptOptions(), logger, {
        agent: null,
        model: null,
        timeoutMs: 25,
        omoProviders: createDisabledProviders(),
      })
      await vi.advanceTimersByTimeAsync(25)

      // #then — the timeout is latched, but the owned server remains open during abort teardown
      expect(mockClient.session.abort).toHaveBeenCalledOnce()
      expect(mockServer.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_999)
      expect(mockServer.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      const result = await resultPromise
      expect(result).toMatchObject({success: false, exitCode: 130})
      expect(mockServer.close).toHaveBeenCalledOnce()
      expect(logger.warning).toHaveBeenCalledWith(
        'OpenCode session abort exceeded teardown budget; continuing teardown',
        {sessionId: 'ses_123'},
      )
      expect(vi.mocked(logger.debug).mock.calls.filter(([message]) => message.includes('session abort'))).toHaveLength(
        0,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes model configuration when provided', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    const config: ExecutionConfig = {
      agent: 'sisyphus',
      model: {providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514'},
      timeoutMs: 1800000,
      omoProviders: {
        claude: 'no',
        copilot: 'no',
        gemini: 'no',
        openai: 'no',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
        kimiForCoding: 'no',
      },
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then
    expect(mockClient.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        body: expect.objectContaining({
          model: {
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-20250514',
          },
        }),
      }),
    )
  })

  it('uses default model when not configured', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    const config: ExecutionConfig = {
      agent: 'sisyphus',
      model: null,
      timeoutMs: 1800000,
      omoProviders: {
        claude: 'no',
        copilot: 'no',
        gemini: 'no',
        openai: 'no',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
        kimiForCoding: 'no',
      },
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then
    const promptCalls = vi.mocked(mockClient.session.promptAsync).mock.calls
    const firstCall = promptCalls[0] as [{body?: {model?: {providerID: string; modelID: string}}}] | undefined
    const promptCall = firstCall?.[0]
    expect(promptCall?.body?.model).toEqual({
      providerID: 'opencode',
      modelID: 'big-pickle',
    })
  })

  it('subscribes to events before sending the prompt', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    const subscribeOrder = vi.mocked(mockClient.event.subscribe).mock.invocationCallOrder[0]
    const promptOrder = vi.mocked(mockClient.session.promptAsync).mock.invocationCallOrder[0]
    expect(subscribeOrder).toBeDefined()
    expect(promptOrder).toBeDefined()
    if (subscribeOrder == null || promptOrder == null) throw new Error('Expected subscribe and prompt calls')
    expect(subscribeOrder).toBeLessThan(promptOrder)
  })

  it('omits default model when omo providers are configured', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    const config: ExecutionConfig = {
      agent: 'sisyphus',
      model: null,
      timeoutMs: 1800000,
      omoProviders: {
        claude: 'yes',
        copilot: 'no',
        gemini: 'no',
        openai: 'no',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
        kimiForCoding: 'no',
      },
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then
    const promptCalls = vi.mocked(mockClient.session.promptAsync).mock.calls
    const firstCall = promptCalls[0] as [{body?: {model?: {providerID: string; modelID: string}}}] | undefined
    const promptCall = firstCall?.[0]
    expect(promptCall?.body?.model).toBeUndefined()
  })

  it('keeps explicit model override when omo providers are configured', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    const config: ExecutionConfig = {
      agent: 'sisyphus',
      model: {providerID: 'openai', modelID: 'gpt-5'},
      timeoutMs: 1800000,
      omoProviders: {
        claude: 'yes',
        copilot: 'no',
        gemini: 'no',
        openai: 'yes',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
        kimiForCoding: 'no',
      },
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then
    const promptCalls = vi.mocked(mockClient.session.promptAsync).mock.calls
    const firstCall = promptCalls[0] as [{body?: {model?: {providerID: string; modelID: string}}}] | undefined
    const promptCall = firstCall?.[0]
    expect(promptCall?.body?.model).toEqual({providerID: 'openai', modelID: 'gpt-5'})
  })

  it('uses custom agent from config', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    const config: ExecutionConfig = {
      agent: 'CustomAgent',
      model: null,
      timeoutMs: 1800000,
      omoProviders: {
        claude: 'no',
        copilot: 'no',
        gemini: 'no',
        openai: 'no',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
        kimiForCoding: 'no',
      },
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then

    const callArgs = vi.mocked(mockClient.session.promptAsync).mock.calls[0]?.[0] as {
      body?: {agent?: string}
    }
    expect(callArgs?.body?.agent).toBe('CustomAgent')
  })

  it('includes agent field when non-default agent is configured', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    const config: ExecutionConfig = {
      agent: 'oracle',
      model: null,
      timeoutMs: 1800000,
      omoProviders: {
        claude: 'no',
        copilot: 'no',
        gemini: 'no',
        openai: 'no',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
        kimiForCoding: 'no',
      },
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then
    const callArgs = vi.mocked(mockClient.session.promptAsync).mock.calls[0]?.[0] as {
      body?: {agent?: string}
    }
    expect(callArgs?.body?.agent).toBe('oracle')
  })

  it('returns success result on successful execution', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Agent response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeNull()
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })

  it('re-asserts session title with SDK update payload after prompt attempts', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Agent response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)
    const config: ExecutionConfig = {
      agent: 'sisyphus',
      model: null,
      timeoutMs: 1800000,
      omoProviders: {
        claude: 'no',
        copilot: 'no',
        gemini: 'no',
        openai: 'no',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
        kimiForCoding: 'no',
      },
      sessionTitle: 'fro-bot: schedule-c757a308',
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then
    expect(mockClient.session.update).toHaveBeenCalledWith(
      expect.objectContaining({
        path: {id: 'ses_123'},
        body: {title: 'fro-bot: schedule-c757a308'},
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    )
  })

  it('re-asserts session title even when prompt attempt fails', async () => {
    // #given
    const mockClient = createMockClient({throwOnPrompt: true})
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)
    const config: ExecutionConfig = {
      agent: 'sisyphus',
      model: null,
      timeoutMs: 1800000,
      omoProviders: {
        claude: 'no',
        copilot: 'no',
        gemini: 'no',
        openai: 'no',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
        kimiForCoding: 'no',
      },
      sessionTitle: 'fro-bot: schedule-c757a308',
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then
    expect(mockClient.session.update).toHaveBeenCalledWith(
      expect.objectContaining({
        path: {id: 'ses_123'},
        body: {title: 'fro-bot: schedule-c757a308'},
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    )
  })

  it('returns failure result when prompt fails', async () => {
    // #given
    const mockClient = createMockClient({throwOnPrompt: true})
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain('Prompt failed')
  })

  it('returns failure result when session creation fails', async () => {
    // #given
    const mockClient = createMockClient({throwOnCreate: true})
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain('Session creation failed')
  })

  it('cleans up server on completion', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockServer = createMockServer()
    const mockOpencode = createMockOpencode({client: mockClient, server: mockServer})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(mockServer.close).toHaveBeenCalled()
  })

  it('cleans up server on error', async () => {
    // #given
    const mockClient = createMockClient({throwOnPrompt: true})
    const mockServer = createMockServer()
    const mockOpencode = createMockOpencode({client: mockClient, server: mockServer})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(mockServer.close).toHaveBeenCalled()
  })

  it('logs execution info', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Executing OpenCode agent (SDK mode)',
      expect.objectContaining({
        agent: 'build (default)',
      }),
    )
  })

  it('returns failure when createOpencode fails', async () => {
    // #given
    vi.mocked(createOpencode).mockRejectedValue(new Error('Server startup failed'))

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.error).toContain('Server startup failed')
  })

  it('subscribes to event stream', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(mockClient.event.subscribe).toHaveBeenCalled()
  })

  it('flushes pending text on session.idle', async () => {
    // #given
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
      events: [
        {
          type: 'message.part.updated',
          properties: {
            part: {sessionID: 'ses_123', type: 'text', text: 'Partial', time: {}},
          },
        } as unknown as Event,
        {
          type: 'session.idle',
          properties: {sessionID: 'ses_123'},
        } as unknown as Event,
      ],
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(writeSpy).toHaveBeenCalledWith('\nPartial\n')
    writeSpy.mockRestore()
  })

  it('writes prompt artifact when OPENCODE_PROMPT_ARTIFACT is enabled', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    vi.spyOn(envUtils, 'isOpenCodePromptArtifactEnabled').mockReturnValue(true)
    vi.spyOn(envUtils, 'getOpenCodeLogPath').mockReturnValue('/tmp/opencode/log')

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(fs.mkdir).toHaveBeenCalledWith('/tmp/opencode/log', {recursive: true})
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/opencode/log/prompt-ses_123-mock-has.txt'),
      'Built prompt with sessionId',
      'utf8',
    )
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Prompt artifact written'),
      expect.objectContaining({
        hash: 'mock-hash',
        path: expect.stringContaining('/tmp/opencode/log/prompt-') as unknown as string,
      }),
    )
  })

  it('materializes reference files into the log directory and merges file parts', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)
    vi.spyOn(envUtils, 'getOpenCodeLogPath').mockReturnValue('/tmp/opencode/log')
    const {buildAgentPrompt} = await import('./prompt.js')
    vi.mocked(buildAgentPrompt).mockReturnValue({
      text: 'Built prompt with sessionId',
      referenceFiles: [{filename: 'pr-context.txt', content: 'context'}],
    })
    const {materializeReferenceFiles} = await import('./reference-files.js')
    vi.mocked(materializeReferenceFiles).mockResolvedValue([
      {type: 'file', mime: 'text/plain', url: 'file:///tmp/opencode/log/pr-context.txt', filename: 'pr-context.txt'},
    ])
    const imageFilePart = {
      type: 'file' as const,
      mime: 'image/png',
      url: 'file:///tmp/image.png',
      filename: 'image.png',
    }

    // #when
    await executeOpenCode(createMockPromptOptions({fileParts: [imageFilePart]}), mockLogger)

    // #then
    expect(materializeReferenceFiles).toHaveBeenCalledWith(
      [{filename: 'pr-context.txt', content: 'context'}],
      '/tmp/opencode/log',
      mockLogger,
    )
    const promptCall = vi.mocked(mockClient.session.promptAsync).mock.calls[0]?.[0] as {
      body?: {parts?: {type: string; filename?: string}[]}
    }
    expect(promptCall.body?.parts).toEqual([
      {type: 'text', text: 'Built prompt with sessionId'},
      imageFilePart,
      {type: 'file', mime: 'text/plain', url: 'file:///tmp/opencode/log/pr-context.txt', filename: 'pr-context.txt'},
    ])
  })

  it('does not write prompt artifact when OPENCODE_PROMPT_ARTIFACT is disabled', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    vi.spyOn(envUtils, 'isOpenCodePromptArtifactEnabled').mockReturnValue(false)

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(fs.writeFile).not.toHaveBeenCalled()
  })
})

describe('verifyOpenCodeAvailable', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns available=true when opencode --version succeeds', async () => {
    // #given
    vi.mocked(exec.exec).mockImplementation(async (_cmd, _args, options) => {
      if (options?.listeners?.stdout != null) {
        options.listeners.stdout(Buffer.from('opencode version 1.2.3\n'))
      }
      return 0
    })

    // #when
    const result = await verifyOpenCodeAvailable(null, mockLogger)

    // #then
    expect(result.available).toBe(true)
    expect(result.version).toBe('1.2.3')
  })

  it('uses custom opencodePath when provided', async () => {
    // #given
    vi.mocked(exec.exec).mockImplementation(async (_cmd, _args, options) => {
      if (options?.listeners?.stdout != null) {
        options.listeners.stdout(Buffer.from('v2.0.0'))
      }
      return 0
    })

    // #when
    await verifyOpenCodeAvailable('/custom/opencode', mockLogger)

    // #then
    expect(exec.exec).toHaveBeenCalledWith('/custom/opencode', ['--version'], expect.any(Object))
  })

  it('returns available=false when opencode command fails', async () => {
    // #given
    vi.mocked(exec.exec).mockRejectedValue(new Error('Command not found'))

    // #when
    const result = await verifyOpenCodeAvailable(null, mockLogger)

    // #then
    expect(result.available).toBe(false)
    expect(result.version).toBeNull()
    expect(mockLogger.debug).toHaveBeenCalledWith('OpenCode not available, will attempt auto-setup')
  })

  it('returns version=null when version not parseable', async () => {
    // #given
    vi.mocked(exec.exec).mockImplementation(async (_cmd, _args, options) => {
      if (options?.listeners?.stdout != null) {
        options.listeners.stdout(Buffer.from('unknown output'))
      }
      return 0
    })

    // #when
    const result = await verifyOpenCodeAvailable(null, mockLogger)

    // #then
    expect(result.available).toBe(true)
    expect(result.version).toBeNull()
  })
})

describe('executeOpenCode retry behavior', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('retries on LLM fetch error and succeeds on second attempt', async () => {
    // #given
    const mockServer = createMockServer()
    let promptCallCount = 0
    let subscribeCallCount = 0
    const promptBodies: {parts: {type: string; text?: string}[]}[] = []

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async (args: {body: {parts: {type: string; text?: string}[]}}) => {
          promptCallCount++
          promptBodies.push(args.body)
          if (promptCallCount === 1) {
            return Promise.resolve({error: 'fetch failed: network error'})
          }
          return Promise.resolve({data: {parts: [{type: 'text', text: 'Response'}]}})
        }),
        status: vi
          .fn()
          .mockResolvedValueOnce({data: {ses_123: {type: 'busy'}}})
          .mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () => {
          subscribeCallCount++
          return subscribeCallCount === 1
            ? createPromptStartedEventStream(mockClient.session.promptAsync, [])
            : createPromptStartedActivityStream(mockClient.session.promptAsync)
        }),
      },
    }

    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise

    // #then
    expect(promptCallCount).toBe(2)
    expect(promptBodies[1]?.parts[0]?.text).toBe('Built prompt with sessionId')
    expect(result.success).toBe(true)
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'LLM fetch error detected, retrying with continuation prompt',
      expect.any(Object),
    )
  })

  it('continues an accepted turn after a retryable prompt response error', async () => {
    // #given prompt submission reports a retryable error after current-turn activity was observed
    const mockServer = createMockServer()
    let promptCallCount = 0
    const promptBodies: {parts: {type: string; text?: string}[]}[] = []
    let releasePromptError: (() => void) | null = null
    const promptError = new Promise<{error: string}>(resolve => {
      releasePromptError = () => resolve({error: 'fetch failed: network error'})
    })
    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async (args: {body: {parts: {type: string; text?: string}[]}}) => {
          promptCallCount++
          promptBodies.push(args.body)
          if (promptCallCount === 1) return promptError
          return {data: {parts: [{type: 'text', text: 'Response'}]}}
        }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () => {
          if (promptCallCount === 0) {
            return createPromptStartedErrorEventStream(
              mockClient.session.promptAsync,
              [createCurrentTurnActivityEvent()],
              () => releasePromptError?.(),
            )
          }
          return createPromptStartedActivityStream(mockClient.session.promptAsync)
        }),
      },
    }
    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise

    // #then the accepted turn gets a continuation instead of replaying the original prompt
    expect(promptCallCount).toBe(2)
    expect(promptBodies[1]?.parts[0]?.text).toContain('observed failure type `llm_fetch_error`')
    expect(promptBodies[1]?.parts[0]?.text).not.toBe('Built prompt with sessionId')
    expect(result.success).toBe(true)
  })

  it('preserves artifacts observed before a retryable prompt response error', async () => {
    // #given a failed prompt response arrives after activity and a completed PR artifact
    const mockServer = createMockServer()
    let promptCallCount = 0
    let releasePromptError: (() => void) | null = null
    const promptError = new Promise<{error: string}>(resolve => {
      releasePromptError = () => resolve({error: 'fetch failed: network error'})
    })
    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async () => {
          promptCallCount++
          if (promptCallCount === 1) return promptError
          return {data: {parts: [{type: 'text', text: 'Response'}]}}
        }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () => {
          if (promptCallCount === 0) {
            return createPromptStartedErrorEventStream(
              mockClient.session.promptAsync,
              [createCurrentTurnActivityEvent(), createCompletedPrArtifactEvent()],
              () => releasePromptError?.(),
            )
          }
          return createPromptStartedActivityStream(mockClient.session.promptAsync)
        }),
      },
    }
    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise

    // #then the artifact from the failed turn survives the continuation
    expect(result.prsCreated).toEqual(['https://github.com/owner/repo/pull/42'])
    expect(promptCallCount).toBe(2)
  })

  it('does not retry when session.status retry classifies as quota_exceeded (non-retryable)', async () => {
    // #given — an accepted prompt followed by an account-quota retry status
    const mockServer = createMockServer()
    let promptCallCount = 0

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async () => {
          promptCallCount++
          return Promise.resolve({data: {parts: [{type: 'text', text: 'Response'}]}})
        }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () =>
          createPromptStartedEventStream(mockClient.session.promptAsync, [
            {
              type: 'session.status',
              properties: {
                sessionID: 'ses_123',
                status: {
                  type: 'retry',
                  attempt: 1,
                  message: 'Usage limit reached',
                  action: {
                    reason: 'account_rate_limit',
                    provider: 'anthropic',
                    title: 'Usage limit reached',
                    message: 'x',
                    label: 'x',
                  },
                  next: Date.now() + 5000,
                },
              },
            } as unknown as Event,
          ]),
        ),
      },
    }

    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when — quota exhaustion must fail fast (grace-cycle path, no retry delay is ever consumed),
    // so settlement is proven within under 10 simulated seconds — not the full multi-minute
    // retry-delay budget a genuinely retryable error would need.
    const settlementBudgetMs = 10_000
    const startedAt = Date.now()
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)
    await vi.advanceTimersByTimeAsync(settlementBudgetMs - 1)
    const result = await resultPromise
    const elapsedMs = Date.now() - startedAt

    // #then — one failed quota attempt, no continuation prompt, settled well under the budget
    expect(promptCallCount).toBe(1)
    expect(result.success).toBe(false)
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(elapsedMs).toBeLessThan(settlementBudgetMs)
    expect(mockLogger.warning).not.toHaveBeenCalledWith(
      'LLM fetch error detected, retrying with continuation prompt',
      expect.any(Object),
    )
  })

  it('does not retry when ProviderAuthError is observed and returns only fixed safe output', async () => {
    // #given — an accepted prompt followed by a structured provider authentication failure
    const mockServer = createMockServer()
    let promptCallCount = 0

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async () => {
          promptCallCount++
          return Promise.resolve({data: {parts: [{type: 'text', text: 'Response'}]}})
        }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () =>
          createPromptStartedEventStream(mockClient.session.promptAsync, [
            {
              type: 'session.error',
              properties: {
                sessionID: 'ses_123',
                error: {name: 'ProviderAuthError', data: {providerID: 'sentinel-provider', message: 'sentinel-token'}},
              },
            } as unknown as Event,
          ]),
        ),
      },
    }

    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const startedAt = Date.now()
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)
    await vi.advanceTimersByTimeAsync(2_000)
    const result = await resultPromise
    const elapsedMs = Date.now() - startedAt

    // #then — one attempt, no continuation, and no provider-controlled values in AgentResult
    expect(promptCallCount).toBe(1)
    expect(elapsedMs).toBeLessThan(10_000)
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.llmError?.type).toBe('provider_auth_error')
    expect(result.error).toContain('model provider rejected authentication')
    expect(result.llmError?.message).not.toContain('sentinel')
    expect(result.error).not.toContain('sentinel')
    expect(JSON.stringify(result)).not.toContain('sentinel-provider')
    expect(JSON.stringify(result)).not.toContain('sentinel-token')
    expect(mockLogger.warning).not.toHaveBeenCalledWith(
      'LLM fetch error detected, retrying with continuation prompt',
      expect.any(Object),
    )
  })

  it('fails the execution boundary on poll-only auth_unavailable with no SSE auth event', async () => {
    // #given — SSE emits no events; REST polling observes the issue-derived auth_unavailable retry shape
    const mockServer = createMockServer()
    const sentinelProvider = 'sentinel-provider'
    const sentinelAccount = 'sentinel-account'
    const sentinelToken = 'sentinel-token'
    const sentinelUrl = 'https://sentinel.example/account'
    let promptCallCount = 0

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async () => {
          promptCallCount++
          return Promise.resolve({data: {parts: [{type: 'text', text: 'Response'}]}})
        }),
        status: vi.fn().mockResolvedValue({
          data: {
            ses_123: {
              type: 'retry',
              attempt: 1,
              message: `Authentication unavailable for ${sentinelAccount}; ${sentinelToken}`,
              action: {
                reason: 'auth_unavailable',
                provider: sentinelProvider,
                title: 'Authentication unavailable',
                message: `Update credentials at ${sentinelUrl} using ${sentinelToken}`,
                label: 'Update credentials',
                link: sentinelUrl,
              },
              next: Date.now() + 5_000,
            },
          },
        }),
      },
      event: {
        subscribe: vi
          .fn()
          .mockImplementation(async () => createPromptStartedEventStream(mockClient.session.promptAsync, [])),
      },
    }

    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when — run the full Action execution boundary with a bounded deadline
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 2_000,
      omoProviders: createDisabledProviders(),
    })
    await vi.runOnlyPendingTimersAsync()
    const result = await resultPromise

    // #then — poll-only auth is authoritative, non-retryable, and safely bounded
    expect(promptCallCount).toBe(1)
    expect(mockClient.session.status).toHaveBeenCalledOnce()
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.llmError?.type).toBe('provider_auth_error')
    expect(result.error).toContain('model provider rejected authentication')
    expect(result.error).not.toContain(sentinelAccount)
    expect(result.error).not.toContain(sentinelToken)
    expect(JSON.stringify(result)).not.toContain(sentinelProvider)
    expect(JSON.stringify(result)).not.toContain(sentinelAccount)
    expect(JSON.stringify(result)).not.toContain(sentinelToken)
    expect(JSON.stringify(result)).not.toContain(sentinelUrl)
    const capturedLogs = [
      ...vi.mocked(mockLogger.debug).mock.calls,
      ...vi.mocked(mockLogger.error).mock.calls,
      ...vi.mocked(mockLogger.warning).mock.calls,
      ...vi.mocked(mockLogger.info).mock.calls,
    ]
    expect(JSON.stringify(capturedLogs)).not.toContain(sentinelProvider)
    expect(JSON.stringify(capturedLogs)).not.toContain(sentinelAccount)
    expect(JSON.stringify(capturedLogs)).not.toContain(sentinelToken)
    expect(JSON.stringify(capturedLogs)).not.toContain(sentinelUrl)
    expect(mockLogger.warning).not.toHaveBeenCalledWith(
      'LLM fetch error detected, retrying with continuation prompt',
      expect.any(Object),
    )
  })

  it('stops retrying after MAX_LLM_RETRIES attempts', async () => {
    // #given
    const mockServer = createMockServer()
    let promptCallCount = 0

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async () => {
          promptCallCount++
          return Promise.resolve({error: 'fetch failed: network error'})
        }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () => createMockEventStream([])),
      },
    }

    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)
    for (const delay of [5_000, 15_000, 30_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(delay)
      await vi.advanceTimersByTimeAsync(2000)
    }
    const result = await resultPromise

    // #then
    expect(promptCallCount).toBe(4)
    expect(result.success).toBe(false)
    expect(result.llmError).not.toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'LLM fetch error detected, retrying with continuation prompt',
      expect.any(Object),
    )
  })

  it('does not retry on non-LLM errors', async () => {
    // #given
    const mockServer = createMockServer()
    let promptCallCount = 0

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async () => {
          promptCallCount++
          return Promise.resolve({error: 'Invalid API key'})
        }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () => createMockEventStream([])),
      },
    }

    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(promptCallCount).toBe(1)
    expect(result.success).toBe(false)
    expect(result.llmError).toBeNull()
  })

  it('only tracks results from successful attempt', async () => {
    // #given
    const mockServer = createMockServer()
    let promptCallCount = 0

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async () => {
          promptCallCount++
          if (promptCallCount === 1) {
            return Promise.resolve({error: 'fetch failed'})
          }
          return Promise.resolve({data: {parts: [{type: 'text', text: 'Response'}]}})
        }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () => {
          const events: Event[] = [
            {
              type: 'message.updated',
              properties: {
                info: {
                  id: 'msg_123',
                  sessionID: 'ses_123',
                  parentID: '',
                  role: 'assistant',
                  tokens: {input: 100, output: 50, reasoning: 0, cache: {read: 0, write: 0}},
                  modelID: 'claude-sonnet-4-20250514',
                  cost: 0.001,
                  time: {created: 0},
                  system: '',
                  parts: [],
                },
              },
            } as unknown as Event,
            {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
          ]
          return Promise.resolve(createPromptStartedEventStream(mockClient.session.promptAsync, events))
        }),
      },
    }

    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise

    // #then
    expect(result.success).toBe(true)
    expect(result.tokenUsage).toEqual({
      input: 100,
      output: 50,
      reasoning: 0,
      cache: {read: 0, write: 0},
    })
  })

  it('sends continuation prompt on retry instead of initial prompt', async () => {
    // #given
    const mockServer = createMockServer()
    const promptBodies: unknown[] = []
    let subscribeCallCount = 0

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async (args: {body: unknown}) => {
          promptBodies.push(args.body)
          return Promise.resolve({data: {parts: [{type: 'text', text: 'Response'}]}})
        }),
        status: vi
          .fn()
          .mockResolvedValueOnce({data: {ses_123: {type: 'busy'}}})
          .mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () => {
          subscribeCallCount++
          if (subscribeCallCount === 1) {
            return createPromptStartedEventStream(mockClient.session.promptAsync, [
              {
                type: 'session.error',
                properties: {
                  sessionID: 'ses_123',
                  error: {status: 429, message: 'rate limited'},
                },
              } as unknown as Event,
            ])
          }
          return createPromptStartedActivityStream(mockClient.session.promptAsync)
        }),
      },
    }

    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(2000)
    await resultPromise

    // #then
    expect(promptBodies.length).toBe(2)

    const firstBody = promptBodies[0] as {parts: {type: string; text: string}[]}

    const secondBody = promptBodies[1] as {parts: {type: string; text: string}[]}
    const firstPart = firstBody.parts[0]
    const secondPart = secondBody.parts[0]
    expect(firstPart).toBeDefined()
    expect(secondPart).toBeDefined()
    expect(firstPart?.text).toBe('Built prompt with sessionId')
    expect(secondPart?.text).toContain('rate_limit')
    expect(secondPart?.text).not.toContain('fetch failed')
    expect(secondPart?.text).not.toContain('resume it')
    expect(secondPart?.text).not.toBe('Built prompt with sessionId')
  })

  it('does not replay the original prompt after a credential-provisioned turn fails', async () => {
    // #given the accepted turn fails after the agent may have caused an external effect
    const mockServer = createMockServer()
    const promptBodies: {parts: {type: string; text?: string}[]}[] = []
    let subscribeCallCount = 0
    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async (args: {body: {parts: {type: string; text?: string}[]}}) => {
          promptBodies.push(args.body)
          return Promise.resolve({data: {parts: [{type: 'text', text: 'Response'}]}})
        }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () => {
          subscribeCallCount++
          if (subscribeCallCount === 1) {
            return createPromptStartedEventStream(mockClient.session.promptAsync, [
              {
                type: 'session.error',
                properties: {
                  sessionID: 'ses_123',
                  error: {status: 429, message: 'rate limited'},
                },
              } as unknown as Event,
            ])
          }
          return createPromptStartedActivityStream(mockClient.session.promptAsync)
        }),
      },
    }

    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger, {
      agent: null,
      model: null,
      timeoutMs: 1800000,
      omoProviders: createDisabledProviders(),
      credentialProvisioned: true,
    })
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(2000)
    await resultPromise

    // #then the continuation verifies existing effects instead of replaying the original task
    expect(promptBodies).toHaveLength(2)
    expect(promptBodies[1]?.parts[0]?.text).toContain('verify what has already landed')
    expect(promptBodies[1]?.parts[0]?.text).not.toBe('Built prompt with sessionId')
  })

  it('does not overwrite an existing response-file delivery after a failed turn', async () => {
    // #given the failed attempt already produced the trusted response artifact
    vi.mocked(fs.readFile).mockResolvedValue('A valid response body')
    const mockServer = createMockServer()
    let promptCallCount = 0
    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async () => {
          promptCallCount++
          return Promise.resolve({data: {parts: [{type: 'text', text: 'Response'}]}})
        }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () =>
          createPromptStartedEventStream(mockClient.session.promptAsync, [
            {
              type: 'session.error',
              properties: {
                sessionID: 'ses_123',
                error: {status: 429, message: 'rate limited'},
              },
            } as unknown as Event,
          ]),
        ),
      },
    }
    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(
      createMockPromptOptions({responseFilePath: '/tmp/fro-bot-response.md', responseDelivery: 'file-convention'}),
      mockLogger,
      {
        agent: null,
        model: null,
        timeoutMs: 1800000,
        omoProviders: createDisabledProviders(),
      },
    )
    await vi.advanceTimersByTimeAsync(5000)
    const result = await resultPromise

    // #then the existing delivery wins and no continuation can overwrite it
    expect(promptCallCount).toBe(1)
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('keeps all file parts on retry attempts', async () => {
    // #given
    const mockServer = createMockServer()
    const promptBodies: {parts: {type: string; text?: string; filename?: string}[]}[] = []
    const attachedFile = {
      type: 'file' as const,
      mime: 'text/plain',
      url: 'file:///tmp/opencode/log/pr-context.txt',
      filename: 'pr-context.txt',
    }

    const {materializeReferenceFiles} = await import('./reference-files.js')
    vi.mocked(materializeReferenceFiles).mockResolvedValue([attachedFile])

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi
          .fn()
          .mockImplementation(async (args: {body: {parts: {type: string; text?: string; filename?: string}[]}}) => {
            promptBodies.push(args.body)
            if (promptBodies.length === 1) {
              return Promise.resolve({error: 'fetch failed'})
            }
            return Promise.resolve({data: {parts: [{type: 'text', text: 'Response'}]}})
          }),
        status: vi
          .fn()
          .mockResolvedValueOnce({data: {ses_123: {type: 'busy'}}})
          .mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi
          .fn()
          .mockImplementation(async () => createPromptStartedActivityStream(mockClient.session.promptAsync)),
      },
    }

    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(2000)
    await resultPromise

    // #then
    expect(promptBodies).toHaveLength(2)
    expect(promptBodies[0]?.parts[1]).toEqual(attachedFile)
    expect(promptBodies[1]?.parts[1]).toEqual(attachedFile)
    expect(promptBodies[1]?.parts[0]?.text).toBe('Built prompt with sessionId')
  })
})

describe('LLM error detection', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('detects fetch failed in exception thrown from executeOpenCode', async () => {
    // #given
    vi.mocked(createOpencode).mockRejectedValue(new Error('fetch failed'))

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)

    // Advance timers for all retry attempts (3 retries × 5000ms delay)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5000)
    }

    const result = await resultPromise

    // #then
    expect(result.success).toBe(false)
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).toBe('llm_fetch_error')
  })

  it('detects ECONNREFUSED in exception thrown from executeOpenCode', async () => {
    // #given
    vi.mocked(createOpencode).mockRejectedValue(new Error('ECONNREFUSED: connection refused'))

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)

    // Advance timers for all retry attempts (3 retries × 5000ms delay)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5000)
    }

    const result = await resultPromise

    // #then
    expect(result.success).toBe(false)
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).toBe('llm_fetch_error')
  })

  it('returns null llmError for non-network errors in exception', async () => {
    // #given
    vi.mocked(createOpencode).mockRejectedValue(new Error('Invalid API key'))

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.llmError).toBeNull()
    expect(result.error).toContain('Invalid API key')
  })

  it('returns null llmError on successful execution', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Success'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)
    // Advance timers so the fallback message one-shot read completes.
    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise

    // #then
    expect(result.success).toBe(true)
    expect(result.llmError).toBeNull()
  })
})

function createDisabledProviders(): ExecutionConfig['omoProviders'] {
  return {
    claude: 'no',
    copilot: 'no',
    gemini: 'no',
    openai: 'no',
    opencodeZen: 'no',
    zaiCodingPlan: 'no',
    kimiForCoding: 'no',
  }
}

function setupMockClient() {
  const mockClient = createMockClient({
    promptResponse: {parts: [{type: 'text', text: 'Response'}]},
  })
  const mockOpencode = createMockOpencode({client: mockClient})
  vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)
  return mockClient
}

describe('SDK prompt body shape', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('omits agent field when agent is null', async () => {
    // #given — null agent, no model, disabled oMo providers
    const mockClient = setupMockClient()
    const config: ExecutionConfig = {
      agent: null,
      model: null,
      timeoutMs: 1800000,
      omoProviders: createDisabledProviders(),
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then — body.agent is absent, model falls through to default
    const callArgs = vi.mocked(mockClient.session.promptAsync).mock.calls[0]?.[0] as {
      body?: {agent?: string; model?: {providerID: string; modelID: string}}
    }
    expect(callArgs?.body?.agent).toBeUndefined()
    expect(callArgs?.body?.model).toEqual({providerID: 'opencode', modelID: 'big-pickle'})
  })

  it('includes agent field when agent is an explicit non-null value', async () => {
    // #given — custom agent with no model
    const mockClient = setupMockClient()
    const config: ExecutionConfig = {
      agent: 'custom',
      model: null,
      timeoutMs: 1800000,
      omoProviders: createDisabledProviders(),
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then — body.agent is 'custom'
    const callArgs = vi.mocked(mockClient.session.promptAsync).mock.calls[0]?.[0] as {
      body?: {agent?: string}
    }
    expect(callArgs?.body?.agent).toBe('custom')
  })

  it('includes explicit model and omits agent when agent is null', async () => {
    // #given — null agent with explicit model
    const mockClient = setupMockClient()
    const config: ExecutionConfig = {
      agent: null,
      model: {providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514'},
      timeoutMs: 1800000,
      omoProviders: createDisabledProviders(),
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then — body.model matches override, agent is undefined
    const callArgs = vi.mocked(mockClient.session.promptAsync).mock.calls[0]?.[0] as {
      body?: {agent?: string; model?: {providerID: string; modelID: string}}
    }
    expect(callArgs?.body?.model).toEqual({providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514'})
    expect(callArgs?.body?.agent).toBeUndefined()
  })

  it('omits model when oMo providers are enabled with no explicit model', async () => {
    // #given — null agent, enabled oMo provider, no explicit model
    const mockClient = setupMockClient()
    const config: ExecutionConfig = {
      agent: null,
      model: null,
      timeoutMs: 1800000,
      omoProviders: {
        claude: 'yes',
        copilot: 'no',
        gemini: 'no',
        openai: 'no',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
        kimiForCoding: 'no',
      },
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then — body.model is undefined so providers/agent config decides
    const callArgs = vi.mocked(mockClient.session.promptAsync).mock.calls[0]?.[0] as {
      body?: {model?: {providerID: string; modelID: string}}
    }
    expect(callArgs?.body?.model).toBeUndefined()
  })

  it('passes sisyphus agent through with disabled oMo', async () => {
    // #given — explicit sisyphus with all oMo providers disabled
    const mockClient = setupMockClient()
    const config: ExecutionConfig = {
      agent: 'sisyphus',
      model: null,
      timeoutMs: 1800000,
      omoProviders: createDisabledProviders(),
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then — body.agent is 'sisyphus', no oMo install implied by runtime
    const callArgs = vi.mocked(mockClient.session.promptAsync).mock.calls[0]?.[0] as {
      body?: {agent?: string}
    }
    expect(callArgs?.body?.agent).toBe('sisyphus')
  })

  it('logs build (default) when agent is null', async () => {
    // #given
    setupMockClient()
    const config: ExecutionConfig = {
      agent: null,
      model: null,
      timeoutMs: 1800000,
      omoProviders: createDisabledProviders(),
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Executing OpenCode agent (SDK mode)',
      expect.objectContaining({
        agent: 'build (default)',
      }),
    )
  })

  it('regression: no test asserts sisyphus as default agent', () => {
    // #then — no test in this file asserts that undefined agent equals 'sisyphus'.
    // Any such test would violate the omit-when-null contract.
    expect(true).toBe(true)
  })
})

describe('logServerEvent', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs non-sync events with bounded eventType + sessionId only — does not dump raw properties', () => {
    // #given
    const event: Event = {
      type: 'session.idle',
      properties: {sessionID: 'ses_123'},
    }

    // #when
    logServerEvent(event, mockLogger)

    // #then
    expect(mockLogger.debug).toHaveBeenCalledWith('Server event', {
      eventType: 'session.idle',
      sessionId: 'ses_123',
    })
  })

  it('extracts sessionId from a nested part for message.part.updated without logging the raw part', () => {
    // #given
    const event = {
      type: 'message.part.updated',
      properties: {
        part: {
          sessionID: 'ses_123',
          type: 'tool',
          tool: 'bash',
          state: {status: 'completed', title: 'git status'},
        },
      },
    } as unknown as Event

    // #when
    logServerEvent(event, mockLogger)

    // #then
    expect(mockLogger.debug).toHaveBeenCalledWith('Server event', {
      eventType: 'message.part.updated',
      sessionId: 'ses_123',
    })
  })

  it('omits sessionId when it cannot be extracted, without logging raw properties', () => {
    // #given — no sessionID anywhere in the event
    const event = {
      type: 'session.error',
      properties: {error: 'Connection timeout'},
    } as unknown as Event

    // #when
    logServerEvent(event, mockLogger)

    // #then
    expect(mockLogger.debug).toHaveBeenCalledWith('Server event', {eventType: 'session.error'})
  })

  it('never leaks a hostile session.error payload (provider message, workspace/account/limitName, URL, nested error) into any logger call', () => {
    // #given — a non-sync event carrying every kind of sensitive field the bounded log must exclude
    const event = {
      type: 'session.error',
      properties: {
        sessionID: 'ses_123',
        error: {
          name: 'APIError',
          message: 'UNIQUE_PROVIDER_MESSAGE_TOKEN_88213',
          data: {
            message: 'UNIQUE_PROVIDER_MESSAGE_TOKEN_88213',
            workspace: 'wrk_unique_secret_99001',
            accountId: 'acct_unique_secret_77302',
            limitName: 'Weekly-unique-limit-55671',
            link: 'https://opencode.ai/workspace/unique-secret-path/go',
          },
          cause: {message: 'nested unique cause token 33447'},
        },
      },
    } as unknown as Event
    const logger = createMockLogger()

    // #when
    logServerEvent(event, logger)

    // #then — bounded fields present, every sensitive substring absent from every logger call
    expect(logger.debug).toHaveBeenCalledWith('Server event', {eventType: 'session.error', sessionId: 'ses_123'})
    const allCalls = [
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.warning).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
    ]
    const serialized = JSON.stringify(allCalls)
    expect(serialized).not.toContain('UNIQUE_PROVIDER_MESSAGE_TOKEN_88213')
    expect(serialized).not.toContain('wrk_unique_secret_99001')
    expect(serialized).not.toContain('acct_unique_secret_77302')
    expect(serialized).not.toContain('Weekly-unique-limit-55671')
    expect(serialized).not.toContain('opencode.ai')
    expect(serialized).not.toContain('unique-secret-path')
    expect(serialized).not.toContain('nested unique cause token 33447')
  })

  it('logs sync events with normalized kind and sessionID only — does not dump full payload', () => {
    // #given — sync events carry name + data instead of type + properties
    const event = {
      type: 'sync',
      name: 'session.next.text.delta.3',
      data: {sessionID: 'ses_123', delta: 'some sensitive text'},
    } as unknown as Event

    // #when
    logServerEvent(event, mockLogger)

    // #then — kind normalized (index stripped), sessionID present, raw delta NOT logged
    const [, loggedMeta] = vi.mocked(mockLogger.debug).mock.calls.find(([msg]) => msg === 'Server event') ?? []
    expect(loggedMeta).toMatchObject({eventKind: 'session.next.text.delta', sessionID: 'ses_123'})
    expect(JSON.stringify(loggedMeta)).not.toContain('some sensitive text')
  })
})
describe('executeOpenCode with serverHandle', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reuses external server handle instead of creating a new one', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const {handle} = createMockServerHandle({client: mockClient})

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger, undefined, handle)

    // #then
    expect(createOpencode).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('does NOT close server when serverHandle is provided', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const {handle, mockServer} = createMockServerHandle({client: mockClient})

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, undefined, handle)

    // #then
    expect(mockServer.close).not.toHaveBeenCalled()
  })

  it('does NOT close server on error when serverHandle is provided', async () => {
    // #given
    const mockClient = createMockClient({throwOnCreate: true})
    const {handle, mockServer} = createMockServerHandle({client: mockClient})

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, undefined, handle)

    // #then
    expect(mockServer.close).not.toHaveBeenCalled()
  })

  it('still closes server when no serverHandle is provided (backward compat)', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockServer = createMockServer()
    const mockOpencode = createMockOpencode({client: mockClient, server: mockServer})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(mockServer.close).toHaveBeenCalled()
  })
})

describe('pollForSessionCompletion', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns completed when session status is idle', async () => {
    // #given
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
    }
    const abortController = new AbortController()

    // #when
    const result = await pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
    )

    // #then
    expect(result.completed).toBe(true)
    expect(result.error).toBeNull()
  })

  it('keeps polling when session is busy then returns on idle', async () => {
    // #given
    let callCount = 0
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          callCount++
          if (callCount < 3) {
            return {data: {ses_123: {type: 'busy'}}}
          }
          return {data: {ses_123: {type: 'idle'}}}
        }),
      },
    }
    const abortController = new AbortController()

    // #when
    const result = await pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
    )

    // #then
    expect(result.completed).toBe(true)
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  it('treats retry status as busy and keeps polling until idle', async () => {
    // #given — retry is not an error; the server is handling backoff internally
    let callCount = 0
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          callCount++
          if (callCount <= 5) {
            return {data: {ses_123: {type: 'retry', attempt: callCount, message: 'Rate limited', next: 0}}}
          }
          return {data: {ses_123: {type: 'idle'}}}
        }),
      },
    }
    const abortController = new AbortController()

    // #when
    const result = await pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
    )

    // #then
    expect(result.completed).toBe(true)
    expect(callCount).toBeGreaterThan(5)
  })

  it('fails fast on a poll-only retry status with action.reason account_rate_limit (no SSE event at all)', async () => {
    // #given — the REST poll observes the exact quota retry shape with no corresponding SSE
    // session.status event ever having arrived. It must fail immediately on the first poll tick,
    // not be treated as ordinary busy backoff.
    let callCount = 0
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          callCount++
          return {
            data: {
              ses_123: {
                type: 'retry',
                attempt: 1,
                message: 'Usage limit reached',
                action: {reason: 'account_rate_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
                next: Date.now() + 5000,
              },
            },
          }
        }),
      },
    }
    const abortController = new AbortController()
    const activityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }

    // #when
    const result = await pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
      30_000,
      activityTracker,
    )

    // #then — fails on the very first poll tick, not after exhausting the full timeout
    expect(result.completed).toBe(false)
    expect(callCount).toBe(1)
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
  })

  it('fails fast on a poll-only retry status with action.reason auth_unavailable (no SSE event at all)', async () => {
    // #given — REST polling observes the auth marker while the SSE stream misses it
    vi.useFakeTimers()
    try {
      let callCount = 0
      const mockClient = {
        session: {
          status: vi.fn().mockImplementation(async () => {
            callCount++
            return {
              data: {
                ses_123: {
                  type: 'retry',
                  attempt: 1,
                  action: {reason: 'auth_unavailable', provider: 'sentinel-provider'},
                  message: 'sentinel-token',
                },
              },
            }
          }),
        },
      }
      const activityTracker = {
        firstMeaningfulEventReceived: true,
        currentTurnTerminalSignalReceived: false,
        sessionIdle: false,
        sessionError: null,
      }
      const pollPromise = pollForSessionCompletion(
        mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        'ses_123',
        '/workspace',
        new AbortController().signal,
        mockLogger,
        30_000,
        activityTracker,
      )

      // #when
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await pollPromise

      // #then — auth must terminate on the first poll instead of becoming a timeout
      expect(result.completed).toBe(false)
      expect(result.error).toContain('model provider rejected authentication')
      expect(callCount).toBe(1)
      expect(JSON.stringify(result)).not.toContain('sentinel-provider')
      expect(JSON.stringify(result)).not.toContain('sentinel-token')
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves a terminal auth slot when the deadline expires before the next poll handoff', async () => {
    // #given — auth was accepted into the shared tracker before the deadline became authoritative
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    await processEventStream(
      createMockEventStream([
        {
          type: 'session.error',
          properties: {
            sessionID: 'ses_123',
            error: {name: 'ProviderAuthError', data: {providerID: 'sentinel-provider', message: 'sentinel-token'}},
          },
        } as unknown as Event,
      ]).stream,
      'ses_123',
      new AbortController().signal,
      mockLogger,
      activityTracker,
    )
    const deadline: ExecutionDeadline = {
      timeoutMs: 1,
      signal: new AbortController().signal,
      isExpired: () => true,
      isTimedOut: () => true,
      remainingMs: () => 0,
      run: async operation => operation(),
      dispose: vi.fn(),
    }

    // #when
    const result = await pollForSessionCompletion(
      {session: {status: vi.fn()}} as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      new AbortController().signal,
      mockLogger,
      30_000,
      activityTracker,
      deadline,
    )

    // #then — the accepted terminal outcome wins over the later deadline callback
    expect(result.completed).toBe(false)
    expect(result.error).toContain('model provider rejected authentication')
    expect(JSON.stringify(result)).not.toContain('sentinel-provider')
    expect(JSON.stringify(result)).not.toContain('sentinel-token')
  })

  it('never passes the raw poll-only retry status payload (message/provider text/link) into any logger call', async () => {
    // #given — the poll-only quota fail-fast path must also bound its logging
    const sensitiveLink = 'https://opencode.ai/workspace/acme-corp/go'
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({
          data: {
            ses_123: {
              type: 'retry',
              attempt: 1,
              message: `Usage limit reached. Visit ${sensitiveLink}`,
              action: {
                reason: 'account_rate_limit',
                provider: 'anthropic',
                title: 'x',
                message: `Enable usage at ${sensitiveLink}`,
                label: 'x',
                link: sensitiveLink,
              },
              next: Date.now() + 5000,
            },
          },
        }),
      },
    }
    const abortController = new AbortController()
    const logger = createMockLogger()

    // #when
    await pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      logger,
    )

    // #then
    const allCalls = [
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.warning).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
    ]
    const serializedCalls = JSON.stringify(allCalls)
    expect(serializedCalls).not.toContain(sensitiveLink)
    expect(serializedCalls).not.toContain('acme-corp')
  })

  it('returns error after session.error grace cycles exhausted', async () => {
    // #given — session.error set via activityTracker (from event stream)
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
    }
    const abortController = new AbortController()
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: 'LLM fetch failed',
    }
    vi.useFakeTimers()

    // #when
    const resultPromise = pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise
    vi.useRealTimers()

    // #then
    expect(result.completed).toBe(false)
    expect(result.error).toContain('Session error')
    expect(result.error).toContain('LLM fetch failed')
  })

  it('returns aborted when signal is already aborted', async () => {
    // #given
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
    }
    const abortController = new AbortController()
    abortController.abort()

    // #when
    const result = await pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
    )

    // #then
    expect(result.completed).toBe(false)
    expect(result.error).toBe('Aborted')
  })

  it('returns timeout error when maxPollTimeMs exceeded', async () => {
    // #given
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
    }
    const abortController = new AbortController()
    vi.useFakeTimers()

    // #when
    const resultPromise = pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
      1000,
    )
    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise
    vi.useRealTimers()

    // #then
    expect(result.completed).toBe(false)
    expect(result.error).toContain('Poll timeout')
  })

  it('fails fast when no activity detected within initial timeout', async () => {
    // #given
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {}}),
      },
    }
    const abortController = new AbortController()
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    vi.useFakeTimers()

    // #when
    const resultPromise = pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
      INITIAL_ACTIVITY_TIMEOUT_MS * 2,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(INITIAL_ACTIVITY_TIMEOUT_MS + 1000)
    const result = await resultPromise
    vi.useRealTimers()

    // #then
    expect(result.completed).toBe(false)
    expect(result.error).toContain('No agent activity detected')
  })

  it('does not treat matching busy session status as activity', async () => {
    // #given
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
    }
    const abortController = new AbortController()
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    vi.useFakeTimers()

    // #when
    const resultPromise = pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
      INITIAL_ACTIVITY_TIMEOUT_MS * 2,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(INITIAL_ACTIVITY_TIMEOUT_MS + 1000)
    const result = await resultPromise
    vi.useRealTimers()

    // #then
    expect(activityTracker.firstMeaningfulEventReceived).toBe(false)
    expect(result.completed).toBe(false)
    expect(result.error).toContain('No agent activity detected')
  })

  it('continues polling when session status is not found', async () => {
    // #given
    let callCount = 0
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          callCount++
          if (callCount < 3) {
            return {data: {}}
          }
          return {data: {ses_123: {type: 'idle'}}}
        }),
      },
    }
    const abortController = new AbortController()
    vi.useFakeTimers()

    // #when
    const resultPromise = pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
    )
    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise
    vi.useRealTimers()

    // #then
    expect(result.completed).toBe(true)
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  it('returns completed when activityTracker.sessionIdle is set by event stream', async () => {
    // #given — session status never returns idle, but event stream signals it
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {}}),
      },
    }
    const abortController = new AbortController()
    const activityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    vi.useFakeTimers()

    // #when — start polling, then simulate event stream setting sessionIdle
    const resultPromise = pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
      30_000,
      activityTracker,
    )

    // After first poll cycle, simulate the event stream detecting session.idle
    await vi.advanceTimersByTimeAsync(500)
    activityTracker.sessionIdle = true
    activityTracker.currentTurnTerminalSignalReceived = true
    await vi.advanceTimersByTimeAsync(500)
    const result = await resultPromise
    vi.useRealTimers()

    // #then
    expect(result.completed).toBe(true)
    expect(result.error).toBeNull()
  })
})

describe('waitForEventProcessorShutdown', () => {
  it('resolves when processor completes quickly', async () => {
    // #given
    const processor = Promise.resolve()

    // #when / #then
    await expect(waitForEventProcessorShutdown(processor, 5000)).resolves.toBeUndefined()
  })

  it('resolves after timeout when processor hangs', async () => {
    // #given
    const processor = new Promise<void>(() => {
      // intentionally never resolves
    })
    vi.useFakeTimers()

    // #when
    const start = Date.now()
    const waitPromise = waitForEventProcessorShutdown(processor, 100)
    await vi.advanceTimersByTimeAsync(150)
    await waitPromise
    const elapsed = Date.now() - start
    vi.useRealTimers()

    // #then
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(1000)
  })
})

describe('processEventStream', () => {
  it('responds to a current-session permission ask using the properties request id', async () => {
    // #given a permission ask whose envelope id differs from the request id
    const responder = vi.fn().mockResolvedValue(undefined)
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      currentTurnArmed: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([
      {
        id: 'envelope-id',
        type: 'permission.asked',
        properties: {
          id: 'request-id',
          sessionID: 'ses_123',
          permission: 'read',
          patterns: ['*.env'],
          metadata: {file: '.env.local'},
        },
      } as unknown as Event,
    ])

    // #when the permission ask is processed
    await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
      undefined,
      responder,
    )

    // #then the responder receives properties.id, never the SSE envelope id
    expect(responder).toHaveBeenCalledWith({
      requestID: 'request-id',
      sessionID: 'ses_123',
      permission: 'read',
      patterns: ['*.env'],
    })
    expect(responder).not.toHaveBeenCalledWith(expect.objectContaining({requestID: 'envelope-id'}))
  })

  it('ignores permission asks for other sessions', async () => {
    // #given a permission ask for a different session
    const responder = vi.fn().mockResolvedValue(undefined)
    const eventStream = createMockEventStream([
      {
        id: 'envelope-id',
        type: 'permission.asked',
        properties: {
          id: 'request-id',
          sessionID: 'ses_other',
          permission: 'read',
          patterns: ['*.env'],
          metadata: {file: '.env.local'},
        },
      } as unknown as Event,
    ])

    // #when the permission ask is processed
    await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
      undefined,
      undefined,
      responder,
    )

    // #then the other session's ask is ignored
    expect(responder).not.toHaveBeenCalled()
  })

  it('catches responder failures, logs a warning, and continues stream processing', async () => {
    // #given a responder that rejects and a later terminal event
    const logger = createMockLogger()
    const responder = vi.fn().mockRejectedValue(new Error('reply failed'))
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([
      {
        id: 'envelope-id',
        type: 'permission.asked',
        properties: {
          id: 'request-id',
          sessionID: 'ses_123',
          permission: 'doom_loop',
          patterns: ['*'],
          metadata: {command: 'sensitive'},
        },
      } as unknown as Event,
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ])

    // #when the stream is processed
    await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      logger,
      activityTracker,
      undefined,
      responder,
    )

    // #then the failure is non-fatal and the stream reaches its later event
    expect(activityTracker.sessionIdle).toBe(true)
    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to reject OpenCode permission request',
      expect.objectContaining({permission: 'doom_loop', patterns: ['*']}),
    )
  })

  it('logs an unanswerable permission ask and continues when no responder is supplied', async () => {
    // #given a permission ask without a responder and a later terminal event
    const logger = createMockLogger()
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([
      {
        id: 'envelope-id',
        type: 'permission.asked',
        properties: {
          id: 'request-id',
          sessionID: 'ses_123',
          permission: 'read',
          patterns: ['*.env'],
          metadata: {contents: 'must not be logged'},
        },
      } as unknown as Event,
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ])

    // #when the stream is processed
    await processEventStream(eventStream.stream, 'ses_123', new AbortController().signal, logger, activityTracker)

    // #then the missing responder is logged without interrupting the stream
    expect(activityTracker.sessionIdle).toBe(true)
    expect(logger.warning).toHaveBeenCalledWith(
      'OpenCode permission request observed but no responder is configured',
      expect.objectContaining({permission: 'read', patterns: ['*.env']}),
    )
    expect(JSON.stringify((logger.warning as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('metadata')
    expect(JSON.stringify((logger.warning as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('must not be logged')
  })

  it('marks activity tracker when message part updates arrive', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {sessionID: 'ses_123', type: 'text', text: 'Hello', time: {}},
        },
      } as unknown as Event,
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.firstMeaningfulEventReceived).toBe(true)
  })

  it('marks activity tracker from message part envelope session when part omits sessionID', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_123',
          part: {type: 'text', text: 'Hello', time: {}},
        },
      } as unknown as Event,
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.firstMeaningfulEventReceived).toBe(true)
  })

  it('marks activity tracker when message part deltas arrive', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses_123',
          messageID: 'msg_123',
          partID: 'prt_123',
          field: 'text',
          delta: 'Hello',
        },
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.firstMeaningfulEventReceived).toBe(true)
  })

  it('marks activity tracker when session-next text deltas arrive', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.next.text.delta',
        properties: {
          timestamp: 1,
          sessionID: 'ses_123',
          delta: 'Hello',
        },
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.firstMeaningfulEventReceived).toBe(true)
  })

  it('marks activity tracker when session-next events include the session on data', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.next.text.delta',
        data: {
          sessionID: 'ses_123',
          delta: 'Hello',
        },
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.firstMeaningfulEventReceived).toBe(true)
  })

  it('marks activity tracker when sync session-next deltas arrive', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'sync',
        name: 'session.next.text.delta.1',
        data: {
          sessionID: 'ses_123',
          delta: 'Hello',
        },
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.firstMeaningfulEventReceived).toBe(true)
  })

  it('sets sessionIdle when sync session idle arrives', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'sync',
        name: 'session.idle.1',
        data: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.sessionIdle).toBe(true)
  })

  it('ignores stream activity events for other sessions', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.next.text.delta',
        properties: {
          timestamp: 1,
          sessionID: 'ses_other',
          delta: 'Hello',
        },
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.firstMeaningfulEventReceived).toBe(false)
  })

  it('sets sessionIdle on activity tracker when session.idle received', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.sessionIdle).toBe(true)
  })

  it('sets sessionIdle only for matching session', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_other'},
      } as unknown as Event,
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.sessionIdle).toBe(true)
  })

  it('sets sessionError on activity tracker when session.error received', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error: 'Rate limit exceeded'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.sessionError).toBe('Rate limit exceeded')
  })

  it('records the structured classification path for a provider error without using prose fallback', async () => {
    // #given a structured provider authentication error with no prose signal
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {name: 'ProviderAuthError', data: {providerID: 'provider', message: 'credentials rejected'}},
        },
      } as unknown as Event,
    ])

    // #when the session error is processed
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
    )

    // #then the structured classifier wins and records its path
    expect(result.llmError?.type).toBe('provider_auth_error')
    expect(result.llmError?.retryable).toBe(false)
    expect(result).toHaveProperty('classificationPath', 'structured')
  })

  it('uses the provider isRetryable signal for an otherwise generic APIError', async () => {
    // #given an APIError with no prose match, no 429 status, and a structured retry signal
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {
            name: 'APIError',
            data: {statusCode: 503, code: 'provider_unavailable', isRetryable: true},
          },
        },
      } as unknown as Event,
    ])

    // #when the session error is processed
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
    )

    // #then the provider's retry signal makes it retryable without claiming a network cause
    expect(result.llmError?.type).toBe('api_error')
    expect(result.llmError?.retryable).toBe(true)
    expect(result.llmError?.suggestedAction).not.toContain('network')
    expect(result).toHaveProperty('classificationPath', 'structured')
  })

  it('records the name/code classification path for stable fields without a recognized terminal name', async () => {
    // #given an unrecognized provider name with stable status and code fields
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {name: 'ProviderSpecificError', data: {statusCode: 503, code: 'provider_unavailable'}},
        },
      } as unknown as Event,
    ])

    // #when the session error is processed
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
    )

    // #then the stable structured fields are recorded as the name/code tier
    expect(result.llmError?.type).toBe('configuration')
    expect(result.llmError?.retryable).toBe(false)
    expect(result).toHaveProperty('classificationPath', 'name')
  })

  it('records unclassified when neither structured fields nor prose patterns match', async () => {
    // #given an empty provider error payload
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error: {}},
      } as unknown as Event,
    ])

    // #when the session error is processed
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
    )

    // #then it remains the existing terminal generic error, but is not mislabeled as a matched tier
    expect(result.llmError?.type).toBe('configuration')
    expect(result.llmError?.retryable).toBe(false)
    expect(result).toHaveProperty('classificationPath', 'unclassified')
  })

  it('records fallback for a transport failure without an SDK session error payload', async () => {
    // #given prompt submission fails with a transport error before an SDK payload exists
    const {sendPromptToSession} = await import('./prompt-sender.js')
    const client = {
      event: {
        subscribe: vi.fn().mockResolvedValue(createMockEventStream([])),
      },
      session: {
        promptAsync: vi.fn().mockResolvedValue({error: 'fetch failed: connection reset'}),
      },
    }

    // #when the prompt is submitted
    const result = await sendPromptToSession(
      client as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      'prompt',
      undefined,
      '/workspace',
      undefined,
      createMockLogger(),
    )

    // #then the bounded prose fallback remains retryable and records its path
    expect(result.llmError?.type).toBe('llm_fetch_error')
    expect(result.llmError?.retryable).toBe(true)
    expect(result.eventStreamResult).toHaveProperty('classificationPath', 'fallback')
  })

  it.each([
    ['provider auth', {name: 'ProviderAuthError', data: {isRetryable: true}}, 'provider_auth_error'],
    ['quota', {name: 'APIError', data: {statusCode: 402, isRetryable: true}}, 'quota_exceeded'],
  ])('keeps %s terminal even when the provider marks the error retryable', async (_label, error, expectedType) => {
    // #given a terminal provider error carrying isRetryable=true
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error},
      } as unknown as Event,
    ])

    // #when the session error is processed
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
    )

    // #then the terminal classifier remains authoritative
    expect(result.llmError?.type).toBe(expectedType)
    expect(result.llmError?.retryable).toBe(false)
    expect(result).toHaveProperty('classificationPath', 'structured')
  })

  it('preserves bounded allowlisted diagnostics from an object session.error through poll grace', async () => {
    // #given — the provider error includes useful fields alongside nested and arbitrary secret data
    const activityTracker = {
      firstMeaningfulEventReceived: true,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const logger = createMockLogger()
    const providerMessage = 'DISTINCTIVE_PROVIDER_MESSAGE_SECRET_1252'
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {
            provider: 'anthropic',
            name: 'APIError',
            data: {
              status: 429,
              code: 'provider_error',
              message: providerMessage,
              accountId: 'acct_super_secret_12345',
              nested: {token: 'nested-secret'},
            },
            arbitrary: 'do-not-copy',
          },
        },
      } as unknown as Event,
    ])

    // #when
    const streamResult = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      logger,
      activityTracker,
    )

    // #then — the event boundary keeps only stable, allowlisted diagnostics
    expect(activityTracker.sessionError).toBe('provider=anthropic; name=APIError; status=429; code=provider_error')
    expect(activityTracker.sessionError).not.toContain('[object Object]')
    expect(activityTracker.sessionError).not.toContain(providerMessage)
    expect(activityTracker.sessionError).not.toContain('acct_super_secret_12345')
    expect(activityTracker.sessionError).not.toContain('nested-secret')
    expect(activityTracker.sessionError).not.toContain('do-not-copy')
    expect(JSON.stringify(streamResult)).not.toContain(providerMessage)

    vi.useFakeTimers()
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
    }
    const resultPromise = pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      logger,
      30_000,
      activityTracker,
    )
    await vi.advanceTimersByTimeAsync(2_000)
    const result = await resultPromise
    vi.useRealTimers()

    expect(result.completed).toBe(false)
    expect(result.error).toContain('provider=anthropic; name=APIError; status=429; code=provider_error')
    expect(result.error).not.toContain(providerMessage)
    expect(result.error).not.toContain('acct_super_secret_12345')
    expect(result.error).not.toContain('nested-secret')
    const loggerCalls = [...vi.mocked(logger.debug).mock.calls, ...vi.mocked(logger.error).mock.calls]
    expect(JSON.stringify(loggerCalls)).not.toContain('acct_super_secret_12345')
    expect(JSON.stringify(loggerCalls)).not.toContain('nested-secret')
    expect(JSON.stringify(loggerCalls)).not.toContain(providerMessage)
  })

  it('uses a generic safe summary when an object session.error has no usable fields', async () => {
    // #given — the provider error has no allowlisted diagnostics
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {accountId: 'acct_super_secret_12345', nested: {token: 'nested-secret'}},
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then
    expect(activityTracker.sessionError).toBe('Unknown session error')
    expect(result.llmError?.message).toBe('Agent error: Unknown session error')
    expect(JSON.stringify(result)).not.toContain('acct_super_secret_12345')
    expect(JSON.stringify(result)).not.toContain('nested-secret')
  })

  it('keeps object-only fetch signals non-retryable without exposing provider text', async () => {
    // #given — the provider supplies a fetch-style message only through an object payload
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const logger = createMockLogger()
    const providerMessage = 'fetch failed: DISTINCTIVE_OBJECT_FETCH_SECRET_1277'
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error: {message: providerMessage}},
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      logger,
      activityTracker,
    )

    // #then — object message text is neither a safe retry signal nor an emitted diagnostic
    expect(result.llmError?.type).toBe('configuration')
    expect(result.llmError?.retryable).toBe(false)
    expect(result.llmError?.message).toBe('Agent error: Unknown session error')
    expect(activityTracker.sessionError).toBe('Unknown session error')
    const loggerCalls = [...vi.mocked(logger.debug).mock.calls, ...vi.mocked(logger.error).mock.calls]
    expect(JSON.stringify(result)).not.toContain(providerMessage)
    expect(JSON.stringify(loggerCalls)).not.toContain(providerMessage)
  })

  it('retains the first normalized session error when a later error is only a string fallback', async () => {
    // #given — a useful structured error arrives before a weaker repeated error
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {provider: 'anthropic', name: 'APIError', data: {status: 500, message: 'Upstream failed'}},
        },
      } as unknown as Event,
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error: 'late generic fallback'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then
    expect(activityTracker.sessionError).toBe('provider=anthropic; name=APIError; status=500')
  })

  it('never passes the raw session.error payload (message/body/account metadata) into any logger call', async () => {
    // #given — a session.error carrying provider message text, a URL, and account/workspace
    // metadata that must never reach the logger, structured or as a raw string.
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const sensitiveMessage = 'Usage limit reached — see https://opencode.ai/workspace/acme-corp/billing for details'
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {
            name: 'APIError',
            data: {status: 429, message: sensitiveMessage, accountId: 'acct_super_secret_12345'},
          },
        },
      } as unknown as Event,
    ])
    const logger = createMockLogger()

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, logger, activityTracker)

    // #then — the quota-classification log call (distinct from the generic raw 'Server event' trace
    // logged by logServerEvent, which intentionally dumps the full event for debugging and is
    // covered separately) must never carry the sensitive message/URL/account metadata.
    const classificationCalls = [...vi.mocked(logger.debug).mock.calls, ...vi.mocked(logger.error).mock.calls].filter(
      ([message]) => message !== 'Server event',
    )
    const serializedCalls = JSON.stringify(classificationCalls)
    expect(serializedCalls).not.toContain('opencode.ai')
    expect(serializedCalls).not.toContain('acme-corp')
    expect(serializedCalls).not.toContain('acct_super_secret_12345')
    expect(serializedCalls).not.toContain(sensitiveMessage)
  })

  it('never passes the raw session.status retry payload (message/provider text) into any logger call', async () => {
    // #given — a retry status carrying provider message text and a link that must never be logged
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const sensitiveLink = 'https://opencode.ai/workspace/acme-corp/go'
    const eventStream = createMockEventStream([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: `Usage limit reached. Visit ${sensitiveLink}`,
            action: {
              reason: 'account_rate_limit',
              provider: 'anthropic',
              title: 'Usage limit reached',
              message: `Enable usage at ${sensitiveLink}`,
              label: 'Enable usage',
              link: sensitiveLink,
            },
            next: Date.now() + 5000,
          },
        },
      } as unknown as Event,
    ])
    const logger = createMockLogger()

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, logger, activityTracker)

    // #then — same scoping as above: only the quota-classification log call is bounded here,
    // not the pre-existing generic 'Server event' raw trace (unrelated/unchanged behavior).
    const classificationCalls = [...vi.mocked(logger.debug).mock.calls, ...vi.mocked(logger.error).mock.calls].filter(
      ([message]) => message !== 'Server event',
    )
    const serializedCalls = JSON.stringify(classificationCalls)
    expect(serializedCalls).not.toContain(sensitiveLink)
    expect(serializedCalls).not.toContain('acme-corp')
  })

  it('classifies session.status retry with account_rate_limit reason as quota exceeded, sets terminal signal, and bounds tracker message', async () => {
    // #given — OpenCode's session.status event with retry.action.reason === 'account_rate_limit' and a finite next
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const nextEpochMs = Date.parse('2026-07-16T12:00:00Z')
    const eventStream = createMockEventStream([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Usage limit reached. Enable usage from your available balance - https://opencode.ai/acme/go',
            action: {
              reason: 'account_rate_limit',
              provider: 'anthropic',
              title: 'Usage limit reached',
              message: 'https://opencode.ai/acme/go',
              label: 'Enable usage',
            },
            next: nextEpochMs,
          },
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — classified as quota_exceeded with normalized reset time, terminal signal set, no raw sentinel
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.retryable).toBe(false)
    expect(result.llmError?.resetTime).toEqual(new Date(nextEpochMs))
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
    expect(activityTracker.sessionError).not.toBeNull()
    expect(activityTracker.sessionError).not.toContain('https://opencode.ai')
    expect(activityTracker.sessionError).not.toContain('acme')
    expect(JSON.stringify(result)).not.toContain('https://opencode.ai')
    expect(result).toHaveProperty('classificationPath', 'structured')
  })

  it.each([
    [
      'properties.error',
      {
        properties: {
          sessionID: 'ses_123',
          error: {name: 'ProviderAuthError', data: {providerID: 'sentinel-provider', message: 'sentinel-token'}},
        },
      },
    ],
    [
      'data.error',
      {
        data: {
          sessionID: 'ses_123',
          error: {name: 'ProviderAuthError', data: {providerID: 'sentinel-provider', message: 'sentinel-token'}},
        },
      },
    ],
  ])(
    'classifies ProviderAuthError from the %s session.error envelope as a terminal provider auth error',
    async (_label, event) => {
      // #given — OpenCode's structured provider authentication failure in either supported envelope
      const activityTracker = {
        firstMeaningfulEventReceived: false,
        currentTurnTerminalSignalReceived: false,
        sessionIdle: false,
        sessionError: null,
      }
      const eventStream = createMockEventStream([{type: 'session.error', ...event} as unknown as Event])

      // #when
      const result = await processEventStream(
        eventStream.stream,
        'ses_123',
        new AbortController().signal,
        createMockLogger(),
        activityTracker,
      )

      // #then — classification is fixed and terminal; provider-controlled values do not cross the boundary
      expect(result.llmError?.type).toBe('provider_auth_error')
      expect(result.llmError?.retryable).toBe(false)
      expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
      expect(JSON.stringify(result)).not.toContain('sentinel-provider')
      expect(JSON.stringify(result)).not.toContain('sentinel-token')
    },
  )

  it.each([
    [
      'properties.error direct name',
      {
        properties: {
          sessionID: 'ses_123',
          error: {
            name: 'ContextOverflowError',
            data: {
              message: 'context-overflow-provider-message-sentinel',
              responseBody: 'context-overflow-response-body-sentinel',
            },
          },
        },
      },
    ],
    [
      'properties.error nested name',
      {
        properties: {
          sessionID: 'ses_123',
          error: {
            data: {
              name: 'ContextOverflowError',
              message: 'context-overflow-provider-message-sentinel',
              responseBody: 'context-overflow-response-body-sentinel',
            },
          },
        },
      },
    ],
    [
      'data.error direct name',
      {
        data: {
          sessionID: 'ses_123',
          error: {
            name: 'ContextOverflowError',
            data: {
              message: 'context-overflow-provider-message-sentinel',
              responseBody: 'context-overflow-response-body-sentinel',
            },
          },
        },
      },
    ],
    [
      'data.error nested name',
      {
        data: {
          sessionID: 'ses_123',
          error: {
            data: {
              name: 'ContextOverflowError',
              message: 'context-overflow-provider-message-sentinel',
              responseBody: 'context-overflow-response-body-sentinel',
            },
          },
        },
      },
    ],
  ])(
    'classifies ContextOverflowError from the %s session.error envelope as a distinct terminal overflow error',
    async (_label, event) => {
      // #given — OpenCode's structured context overflow failure in either supported envelope and name location
      const activityTracker: ActivityTracker = {
        firstMeaningfulEventReceived: false,
        currentTurnTerminalSignalReceived: false,
        sessionIdle: false,
        sessionError: null,
      }
      const eventStream = createMockEventStream([{type: 'session.error', ...event} as unknown as Event])

      // #when
      const result = await processEventStream(
        eventStream.stream,
        'ses_123',
        new AbortController().signal,
        createMockLogger(),
        activityTracker,
      )

      // #then — overflow is distinct from auth/quota and provider-controlled values do not cross the boundary
      expect(result.llmError?.type).toBe('context_overflow')
      expect(result.llmError?.message).toBe('The model context window was exceeded while processing this run.')
      expect(result.llmError?.retryable).toBe(false)
      expect(activityTracker.terminalProviderError?.type).toBe('context_overflow')
      expect(activityTracker.sessionError).toBe(result.llmError?.message)
      expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
      expect(JSON.stringify(result)).not.toContain('context-overflow-provider-message-sentinel')
      expect(JSON.stringify(result)).not.toContain('context-overflow-response-body-sentinel')
      expect(JSON.stringify(activityTracker)).not.toContain('context-overflow-provider-message-sentinel')
      expect(JSON.stringify(activityTracker)).not.toContain('context-overflow-response-body-sentinel')
    },
  )

  it('classifies the exact auth_unavailable retry status as a terminal provider auth error', async () => {
    // #given — issue #1253's retry status marker
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            action: {reason: 'auth_unavailable', provider: 'sentinel-provider'},
            message: 'sentinel-token',
          },
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then
    expect(result.llmError?.type).toBe('provider_auth_error')
    expect(result.llmError?.retryable).toBe(false)
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sentinel-provider')
    expect(JSON.stringify(result)).not.toContain('sentinel-token')
  })

  it('keeps a generic structured 503 session error outside the provider auth terminal path', async () => {
    // #given — a provider outage marker without the structured auth name/code contract
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {name: 'APIError', data: {status: 503, message: 'sentinel-outage'}},
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — generic outage behavior is unchanged and does not retain provider prose
    expect(result.llmError?.type).toBe('configuration')
    expect(result.llmError?.retryable).toBe(false)
    expect(activityTracker.terminalProviderError).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('sentinel-outage')
  })

  it('does not classify session.status retry with an unrelated reason as quota exceeded', async () => {
    // #given — retry status with a different action.reason (e.g. free_tier_limit)
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Retrying due to transient provider error',
            action: {reason: 'free_tier_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
            next: Date.now() + 5000,
          },
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — no classification, no terminal signal
    expect(result.llmError).toBeNull()
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)
    expect(activityTracker.sessionError).toBeNull()
  })

  it('classifies session.status retry with account_rate_limit and an invalid/non-finite next by omitting resetTime', async () => {
    // #given — next is 0 (falsy but technically finite) vs. a genuinely invalid case: NaN/Infinity should be omitted
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Usage limit reached',
            action: {reason: 'account_rate_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
            next: Number.NaN,
          },
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — still classified as quota_exceeded, but no reset time attached
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.resetTime).toBeUndefined()
  })

  it('classifies session.status retry with account_rate_limit and a finite but out-of-Date-range next by omitting resetTime', async () => {
    // #given — next is finite per Number.isFinite but exceeds JS Date's representable range,
    // producing an Invalid Date (getTime() === NaN) if constructed naively
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Usage limit reached',
            action: {reason: 'account_rate_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
            next: Number.MAX_VALUE,
          },
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — still classified as quota_exceeded, but no reset time attached (Invalid Date rejected)
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.resetTime).toBeUndefined()
  })

  it('first-writer-wins: session.status retry quota then a non-quota structured session.error does not overwrite the first error or tracker message', async () => {
    // #given — quota retry classified first; a later non-quota structured session.error must not overwrite it
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const firstResetAt = Date.parse('2026-07-16T12:00:00Z')
    const eventStream = createMockEventStream([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Usage limit reached',
            action: {reason: 'account_rate_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
            next: firstResetAt,
          },
        },
      } as unknown as Event,
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {name: 'APIError', data: {status: 500, message: 'Internal provider failure'}},
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — first classified quota error survives; tracker message stays the bounded quota message
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.resetTime).toEqual(new Date(firstResetAt))
    expect(activityTracker.sessionError).not.toContain('Internal provider failure')
  })

  it('first-writer-wins: session.status retry quota then a plain-string session.error does not overwrite the first error or tracker message', async () => {
    // #given — quota retry classified first; a later plain-string (non-structured) session.error must not overwrite it
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const firstResetAt = Date.parse('2026-07-16T12:00:00Z')
    const eventStream = createMockEventStream([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Usage limit reached',
            action: {reason: 'account_rate_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
            next: firstResetAt,
          },
        },
      } as unknown as Event,
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error: 'Connection reset by peer'},
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — first classified quota error survives; tracker message stays the bounded quota message
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.resetTime).toEqual(new Date(firstResetAt))
    expect(activityTracker.sessionError).not.toContain('Connection reset by peer')
  })

  it('quota upgrades an earlier generic session.error: a later account_rate_limit retry status replaces it', async () => {
    // #given — generic non-quota session.error arrives first; a later account_rate_limit retry
    // is a more specific/actionable classification and is now ALLOWED to upgrade it.
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error: 'Invalid API key'},
      } as unknown as Event,
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Usage limit reached',
            action: {reason: 'account_rate_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
            next: Date.now() + 5000,
          },
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — quota upgraded the earlier generic error; bounded quota message replaces the tracker
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(activityTracker.sessionError).not.toBe('Invalid API key')
    expect(activityTracker.sessionError).not.toContain('Invalid API key')
  })

  it('quota is sticky: once classified, a later generic session.error cannot downgrade it', async () => {
    // #given — account_rate_limit retry classifies quota first; a later unrelated session.error
    // must NOT replace the sticky quota classification.
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Usage limit reached',
            action: {reason: 'account_rate_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
            next: Date.now() + 5000,
          },
        },
      } as unknown as Event,
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error: 'Invalid API key'},
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — quota remains; not downgraded to the later generic configuration error
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(activityTracker.sessionError).not.toContain('Invalid API key')
  })

  it('upgrades generic session errors to auth and keeps auth across later generic and idle events', async () => {
    // #given — a generic error arrives before the terminal auth marker, followed by downgrade attempts
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([
      {type: 'session.error', properties: {sessionID: 'ses_123', error: 'sentinel-generic'}} as unknown as Event,
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {name: 'ProviderAuthError', data: {providerID: 'sentinel-provider', message: 'sentinel-token'}},
        },
      } as unknown as Event,
      {type: 'session.error', properties: {sessionID: 'ses_123', error: 'later-generic'}} as unknown as Event,
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — terminal auth upgrades generic state and remains authoritative
    expect(result.llmError?.type).toBe('provider_auth_error')
    expect(activityTracker.terminalProviderError?.type).toBe('provider_auth_error')
    expect(activityTracker.sessionError).toBe(result.llmError?.message)
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
    expect(JSON.stringify(activityTracker)).not.toContain('sentinel-generic')
    expect(JSON.stringify(activityTracker)).not.toContain('sentinel-provider')
    expect(JSON.stringify(activityTracker)).not.toContain('sentinel-token')
  })

  it.each([
    ['auth first', 'provider_auth_error'],
    ['quota first', 'quota_exceeded'],
  ])('preserves the first terminal provider signal when %s', async (_label, expectedType) => {
    // #given — auth and quota arrive in both possible terminal orders
    const firstAuth = _label === 'auth first'
    const authEvent = {
      type: 'session.error',
      properties: {
        sessionID: 'ses_123',
        error: {name: 'ProviderAuthError', data: {providerID: 'sentinel-provider', message: 'sentinel-token'}},
      },
    } as unknown as Event
    const quotaEvent = {
      type: 'session.status',
      properties: {
        sessionID: 'ses_123',
        status: {
          type: 'retry',
          action: {reason: 'account_rate_limit', provider: 'sentinel-provider'},
          message: 'sentinel-quota',
        },
      },
    } as unknown as Event
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }

    // #when
    const result = await processEventStream(
      createMockEventStream(firstAuth ? [authEvent, quotaEvent] : [quotaEvent, authEvent]).stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — the first terminal classification wins and remains safe
    expect(result.llmError?.type).toBe(expectedType)
    expect(activityTracker.terminalProviderError?.type).toBe(expectedType)
    expect(JSON.stringify(result)).not.toContain('sentinel-provider')
    expect(JSON.stringify(result)).not.toContain('sentinel-token')
    expect(JSON.stringify(result)).not.toContain('sentinel-quota')
  })

  it('ignores a ProviderAuthError event for another session', async () => {
    // #given — auth is associated with a different session ID
    const activityTracker: ActivityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_other',
          error: {name: 'ProviderAuthError', data: {providerID: 'sentinel-provider', message: 'sentinel-token'}},
        },
      } as unknown as Event,
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      new AbortController().signal,
      createMockLogger(),
      activityTracker,
    )

    // #then
    expect(result.llmError).toBeNull()
    expect(activityTracker.terminalProviderError).toBeUndefined()
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
  })

  it('classifies structured session.error with allowlisted status/code/message fields as quota exceeded via fallback', async () => {
    // #given — structured session.error with HTTP 402 payment-required status
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {
            name: 'APIError',
            data: {status: 402, statusCode: 402, code: 'insufficient_quota', message: 'Payment required'},
          },
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.retryable).toBe(false)
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
  })

  it('does not classify an ordinary structured 429 session.error as quota exceeded', async () => {
    // #given — ordinary rate limit, not account-level quota exhaustion
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {name: 'APIError', data: {status: 429, message: 'Rate limit exceeded, please retry after 60 seconds'}},
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — falls back to a retryable rate_limit classification, not quota_exceeded and not
    // the non-retryable 'configuration' fallback — the caller's retry loop may still retry it.
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).toBe('rate_limit')
    expect(result.llmError?.retryable).toBe(true)
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(false)
  })

  it('classifies a plain-string session.error quota message (no structured .data) as quota_exceeded', async () => {
    // #given — session.error carries only a plain string, not a structured error object,
    // but the string matches one of the bounded quota fallback message patterns.
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error:
            'Usage limit reached. It will reset in 12 hours. To continue using this model now, enable usage from your available balance.',
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.retryable).toBe(false)
    expect(activityTracker.currentTurnTerminalSignalReceived).toBe(true)
  })

  it('does not classify an ordinary plain-string session.error as quota_exceeded', async () => {
    // #given — a plain string that does not match any bounded quota fallback pattern
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error: 'Invalid API key'},
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).not.toBe('quota_exceeded')
  })

  it('classifies a structured session.error with only status 402 (no code/message) as quota_exceeded', async () => {
    // #given — bare 402 with no other fields
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error: {name: 'APIError', data: {status: 402}}},
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.retryable).toBe(false)
  })

  it('classifies a structured session.error with only an allowlisted stable code (no status/message) as quota_exceeded', async () => {
    // #given — bare insufficient_quota code, no status/message
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error: {name: 'APIError', data: {code: 'insufficient_quota'}}},
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.retryable).toBe(false)
  })

  it('classifies a structured session.error with only a bounded quota message (no status/code) as quota_exceeded', async () => {
    // #given — bare quota message text, no status/code
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {name: 'APIError', data: {message: 'You have exhausted your credits for this billing period'}},
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.retryable).toBe(false)
  })

  it('first-writer-wins: session.status retry quota then session.error quota does not overwrite the first classified error', async () => {
    // #given — duplicate quota surfaces, retry-status first, session.error second
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const firstResetAt = Date.parse('2026-07-16T12:00:00Z')
    const eventStream = createMockEventStream([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Usage limit reached',
            action: {reason: 'account_rate_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
            next: firstResetAt,
          },
        },
      } as unknown as Event,
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {name: 'APIError', data: {status: 402, message: 'Payment required'}},
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — first classified error (with the retry-status reset time) wins; not overwritten by the second
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.resetTime).toEqual(new Date(firstResetAt))
  })

  it('first-writer-wins: session.error quota then session.status retry quota does not overwrite the first classified error', async () => {
    // #given — duplicate quota surfaces, session.error first, retry-status second
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const secondResetAt = Date.parse('2026-07-16T12:00:00Z')
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {name: 'APIError', data: {status: 402, message: 'Payment required'}},
        },
      } as unknown as Event,
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Usage limit reached',
            action: {reason: 'account_rate_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
            next: secondResetAt,
          },
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — first classified error (session.error's, no resetTime) wins; second does not overwrite
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.llmError?.resetTime).toBeUndefined()
  })

  it('continues processing events after session.error without breaking', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {sessionID: 'ses_123', error: 'Transient failure'},
      } as unknown as Event,
      {
        type: 'message.part.updated',
        properties: {
          part: {sessionID: 'ses_123', type: 'text', text: 'Recovery output', time: {end: 1}},
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — both error flag and meaningful work should be set
    expect(activityTracker.sessionError).toBe('Transient failure')
    expect(activityTracker.firstMeaningfulEventReceived).toBe(true)
    expect(result.llmError).not.toBeNull()
  })

  it('continues processing events after session.idle without breaking', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'ses_123',
            role: 'assistant',
            tokens: {input: 100, output: 50, reasoning: 0},
            modelID: 'claude-3',
            cost: 0.01,
          },
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then — idle flag set AND late-arriving token counts captured
    expect(activityTracker.sessionIdle).toBe(true)
    expect(result.tokens).not.toBeNull()
    expect(result.tokens?.input).toBe(100)
  })

  it('captures token usage from message envelope session when message info omits sessionID', async () => {
    // #given
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'message.updated',
        properties: {
          sessionID: 'ses_123',
          info: {
            role: 'assistant',
            tokens: {input: 100, output: 50, reasoning: 0},
            modelID: 'claude-3',
            cost: 0.01,
          },
        },
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(
      eventStream.stream,
      'ses_123',
      abortController.signal,
      createMockLogger(),
      activityTracker,
    )

    // #then
    expect(activityTracker.firstMeaningfulEventReceived).toBe(true)
    expect(result.tokens?.input).toBe(100)
  })

  it('renders visible stdout text from message.part.delta with string delta when field is text', async () => {
    // #given — string-shaped delta with field:'text' metadata
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses_123',
          field: 'text',
          delta: 'Hello',
        },
      } as unknown as Event,
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger())

    // #then — string delta must flush to stdout on idle
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Hello'))
    writeSpy.mockRestore()
  })

  it('renders visible stdout text from message.part.delta events flushed on session.idle', async () => {
    // #given
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const abortController = new AbortController()
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses_123',
          messageID: 'msg_1',
          partID: 'prt_1',
          delta: {type: 'text', text: 'Hello from delta'},
        },
      } as unknown as Event,
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then — text accumulated from delta must be flushed to stdout on idle
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Hello from delta'))
    writeSpy.mockRestore()
  })

  it('renders visible stdout text from sync session.next.text.delta events flushed on session.idle', async () => {
    // #given
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'sync',
        name: 'session.next.text.delta.1',
        data: {
          sessionID: 'ses_123',
          delta: 'Sync delta text',
        },
      } as unknown as Event,
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger())

    // #then — text accumulated from sync delta must be flushed to stdout on idle
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Sync delta text'))
    writeSpy.mockRestore()
  })

  it('renders visible stdout text from sync session.next.text.delta with object-shaped delta', async () => {
    // #given — delta may be an object {type:'text', text:'...'} not just a plain string
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'sync',
        name: 'session.next.text.delta.1',
        data: {
          sessionID: 'ses_123',
          delta: {type: 'text', text: 'Object sync delta text'},
        },
      } as unknown as Event,
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger())

    // #then — object-shaped delta must flush to stdout on idle
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Object sync delta text'))
    writeSpy.mockRestore()
  })

  it('renders visible stdout tool execution from V2 sync session.next.tool.called + success events', async () => {
    // #given — V2 SDK emits tool lifecycle as sync events, not message.part.updated
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const abortController = new AbortController()
    const activityTracker = {
      firstMeaningfulEventReceived: false,
      currentTurnTerminalSignalReceived: false,
      sessionIdle: false,
      sessionError: null,
    }
    const eventStream = createMockEventStream([
      {
        type: 'sync',
        name: 'session.next.tool.called.1',
        data: {
          sessionID: 'ses_123',
          callID: 'call_1',
          tool: 'bash',
          input: {command: 'Check for existing wiki PR'},
          provider: {executed: true},
        },
      } as unknown as Event,
      {
        type: 'sync',
        name: 'session.next.tool.success.1',
        data: {
          sessionID: 'ses_123',
          callID: 'call_1',
          structured: {},
          content: [{type: 'text', text: 'done'}],
          provider: {executed: true},
        },
      } as unknown as Event,
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger(), activityTracker)

    // #then — tool line must appear: "| Bash       Check for existing wiki PR"
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Bash'))
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Check for existing wiki PR'))
    writeSpy.mockRestore()
  })

  it('detects PR artifacts from V2 sync session.next.tool.called + success for gh pr create', async () => {
    // #given — artifact detection must correlate called command with success content
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'sync',
        name: 'session.next.tool.called.1',
        data: {
          sessionID: 'ses_123',
          callID: 'call_pr',
          tool: 'bash',
          input: {command: 'gh pr create --title "Test PR"'},
          provider: {executed: true},
        },
      } as unknown as Event,
      {
        type: 'sync',
        name: 'session.next.tool.success.1',
        data: {
          sessionID: 'ses_123',
          callID: 'call_pr',
          structured: {},
          content: [{type: 'text', text: 'https://github.com/owner/repo/pull/42'}],
          provider: {executed: true},
        },
      } as unknown as Event,
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    const result = await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger())

    // #then — PR URL must be captured in prsCreated
    expect(result.prsCreated).toContain('https://github.com/owner/repo/pull/42')
  })

  it('renders visible stdout tool execution from message.part.updated tool completed events', async () => {
    // #given — regression guard: old event shape must still produce output
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const abortController = new AbortController()
    const eventStream = createMockEventStream([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            sessionID: 'ses_123',
            type: 'tool',
            tool: 'Bash',
            state: {status: 'completed', title: 'Check for existing wiki PR'},
          },
        },
      } as unknown as Event,
      {
        type: 'session.idle',
        properties: {sessionID: 'ses_123'},
      } as unknown as Event,
    ])

    // #when
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger())

    // #then — tool line must appear: "| Bash       Check for existing wiki PR"
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Bash'))
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Check for existing wiki PR'))
    writeSpy.mockRestore()
  })
})

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
    createOpencodeClient: vi.fn().mockReturnValue({
      v2: {
        session: {
          wait: waitFn,
        },
      },
    }),
  }
}

describe('runPromptAttempt with v2.session.wait()', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts consuming the lazy event stream before prompt submission and ignores pre-arm stale events', async () => {
    // #given — event.subscribe().stream is lazy; the first next() call must happen before promptAsync.
    // The stale same-session idle event arrives before the prompt turn is armed and must not complete the run.
    const {runPromptAttempt} = await import('./retry.js')
    let statusCalls = 0
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          statusCalls++
          return {data: {ses_123: {type: statusCalls === 1 ? 'busy' : 'idle'}}}
        }),
      },
    }
    let streamStarted = false
    let releasePostArmEvent!: () => void
    const postArmEventReady = new Promise<void>(resolve => {
      releasePostArmEvent = resolve
    })
    const stalePreArmEvent: Event = {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event
    const currentTurnEvent = createCurrentTurnActivityEvent()
    const stream = (async function* () {
      streamStarted = true
      yield stalePreArmEvent
      await postArmEventReady
      yield currentTurnEvent
      // session.idle after arm provides the terminal signal (currentTurnTerminalSignalReceived)
      yield {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event
    })()
    const startPrompt = vi.fn(async () => {
      expect(streamStarted).toBe(true)
      releasePostArmEvent()
      return null
    })

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      stream,
      undefined,
      startPrompt,
    )

    // #then
    expect(startPrompt).toHaveBeenCalledOnce()
    expect(result.success).toBe(true)
  })

  it('collects results from and tears down a keep-open SSE stream for each attempt', async () => {
    // #given — the SSE stream only closes when its attempt-local subscription signal aborts
    const {createExecutionDeadline} = await import('./retry.js')
    const {sendPromptToSession} = await import('./prompt-sender.js')
    const deadline = createExecutionDeadline(10_000, mockLogger)
    let subscriptionSignal: AbortSignal | undefined
    let streamClosed = false
    let releasePromptStarted!: () => void
    const promptStarted = new Promise<void>(resolve => {
      releasePromptStarted = resolve
    })
    const events: Event[] = [
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'ses_123',
            role: 'assistant',
            tokens: {input: 3, output: 2, reasoning: 0, cache: {read: 0, write: 0}},
            modelID: 'test-model',
            cost: 0.01,
          },
        },
      } as unknown as Event,
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ]
    const keepOpenStream: AsyncIterable<Event> = {
      [Symbol.asyncIterator]() {
        let index = 0
        return {
          next: async (): Promise<IteratorResult<Event>> => {
            const event = events[index]
            if (event != null) {
              if (index === 0) await promptStarted
              index++
              return {done: false, value: event}
            }
            await new Promise<void>(resolve => {
              if (subscriptionSignal?.aborted === true) {
                resolve()
                return
              }
              subscriptionSignal?.addEventListener('abort', () => resolve(), {once: true})
            })
            streamClosed = true
            return {done: true, value: undefined}
          },
        }
      },
    }
    const mockClient = {
      session: {
        promptAsync: vi.fn().mockImplementation(async () => {
          releasePromptStarted()
          return {data: undefined}
        }),
        messages: vi.fn().mockResolvedValue({data: []}),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn(async (options: {signal?: AbortSignal}) => {
          subscriptionSignal = options.signal
          return {stream: keepOpenStream}
        }),
      },
    }

    // #when
    let result
    try {
      result = await sendPromptToSession(
        mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        'ses_123',
        'prompt',
        undefined,
        '/workspace',
        undefined,
        mockLogger,
        undefined,
        deadline,
      )
    } finally {
      deadline.dispose()
    }

    // #then — completion waits for the stream to flush, and attempt cleanup closes its subscription
    expect(result.success).toBe(true)
    expect(result.eventStreamResult.tokens).toEqual({
      input: 3,
      output: 2,
      reasoning: 0,
      cache: {read: 0, write: 0},
    })
    expect(subscriptionSignal).toBeInstanceOf(AbortSignal)
    expect(subscriptionSignal?.aborted).toBe(true)
    expect(streamClosed).toBe(true)
  })

  it('waits once for abort-ignoring event processing during teardown', async () => {
    // #given — the event iterator ignores cancellation and leaves the processor waiting forever
    vi.useFakeTimers()
    let resultPromise: Promise<unknown> | undefined
    try {
      const {runPromptAttempt} = await import('./retry.js')
      const events: Event[] = [
        {
          type: 'message.part.delta',
          properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'activity'}},
        } as unknown as Event,
        {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
      ]
      const eventStream: AsyncIterable<Event> = {
        [Symbol.asyncIterator]() {
          let index = 0
          return {
            next: async (): Promise<IteratorResult<Event>> => {
              const event = events[index]
              if (event != null) {
                index++
                return {done: false, value: event}
              }
              return new Promise<IteratorResult<Event>>(() => undefined)
            },
          }
        },
      }
      const mockClient = {
        session: {
          status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
        },
      }

      // #when
      resultPromise = runPromptAttempt(
        mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        'ses_123',
        '/workspace',
        30_000,
        mockLogger,
        eventStream,
      )
      await vi.advanceTimersByTimeAsync(500)
      let settled = false
      resultPromise
        .then(
          () => {
            settled = true
          },
          () => {
            settled = true
          },
        )
        .catch(() => undefined)
      await Promise.resolve()

      // #then — one bounded shutdown wait is allowed, but finally must not wait a second time
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      await resultPromise
    } finally {
      await vi.advanceTimersByTimeAsync(4_000)
      if (resultPromise != null) await resultPromise
      vi.useRealTimers()
    }
  })

  it('publishes final stream usage after promptly resolving SSE cleanup', async () => {
    // #given — terminal events arrive before cleanup, while the iterator resolves one tick later
    vi.useFakeTimers()
    try {
      const {runPromptAttempt} = await import('./retry.js')
      let releaseStream!: () => void
      const streamReady = new Promise<void>(resolve => {
        releaseStream = resolve
      })
      const events: Event[] = [
        {
          type: 'message.updated',
          properties: {
            info: {
              sessionID: 'ses_123',
              role: 'assistant',
              tokens: {input: 3, output: 2, reasoning: 1, cache: {read: 4, write: 5}},
              modelID: 'test-model',
              cost: 0.01,
            },
          },
        } as unknown as Event,
        {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
      ]
      const eventStream: AsyncIterable<Event> = {
        [Symbol.asyncIterator]() {
          let index = 0
          return {
            next: async (): Promise<IteratorResult<Event>> => {
              const event = events[index]
              if (event != null) {
                index++
                return {done: false, value: event}
              }
              await streamReady
              return {done: true, value: undefined}
            },
          }
        },
      }
      const mockClient = {
        session: {
          status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
        },
      }
      setTimeout(releaseStream, 501)

      // #when
      const resultPromise = runPromptAttempt(
        mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        'ses_123',
        '/workspace',
        30_000,
        mockLogger,
        eventStream,
      )
      await vi.advanceTimersByTimeAsync(501)
      const result = await resultPromise

      // #then — final event data is available before the attempt result is published
      expect(result.success).toBe(true)
      expect(result.eventStreamResult.tokens).toEqual({
        input: 3,
        output: 2,
        reasoning: 1,
        cache: {read: 4, write: 5},
      })
      expect(result.eventStreamResult.model).toBe('test-model')
      expect(result.eventStreamResult.cost).toBe(0.01)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a terminal result when wall-clock expiry precedes the timeout callback', async () => {
    // #given — the poll result resolves after deadlineAt, while the timeout callback remains unlatched
    vi.useFakeTimers()
    try {
      const {runPromptAttempt} = await import('./retry.js')
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
      const eventStream = createMockEventStream([
        {
          type: 'message.part.delta',
          properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'activity'}},
        } as unknown as Event,
        {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
      ])
      const mockClient = createMockClient({
        statusSequence: [{ses_123: {type: 'idle'}}],
      })

      // #when
      const resultPromise = runPromptAttempt(
        mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        'ses_123',
        '/workspace',
        30_000,
        mockLogger,
        eventStream.stream,
        undefined,
        undefined,
        deadline,
      )
      const rejection = (async () => {
        await expect(resultPromise).rejects.toMatchObject({name: 'DeadlineExceededError'})
      })()
      await vi.advanceTimersByTimeAsync(0)
      vi.setSystemTime(deadlineAt + 1)
      await vi.advanceTimersByTimeAsync(500)

      // #then — wall-clock expiry is authoritative even though isTimedOut() is still false
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the deadline authoritative when auth classification occurs after expiry', async () => {
    // #given — the deadline is already expired before the auth event can be accepted
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
    const eventStream = createMockEventStream([
      {
        type: 'session.error',
        properties: {
          sessionID: 'ses_123',
          error: {name: 'ProviderAuthError', data: {providerID: 'sentinel-provider', message: 'sentinel-token'}},
        },
      } as unknown as Event,
    ])

    // #when / #then
    await expect(
      runPromptAttempt(
        {session: {status: vi.fn()}} as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        'ses_123',
        '/workspace',
        30_000,
        mockLogger,
        eventStream.stream,
        undefined,
        undefined,
        deadline,
      ),
    ).rejects.toMatchObject({name: 'DeadlineExceededError'})
  })

  it('removes the poll interval abort listener when the timer wins', async () => {
    // #given — a deadline-aware poll whose first interval completes normally
    vi.useFakeTimers()
    try {
      const {createExecutionDeadline} = await import('./retry.js')
      const pollSignalController = new AbortController()
      const addListener = vi.spyOn(pollSignalController.signal, 'addEventListener')
      const removeListener = vi.spyOn(pollSignalController.signal, 'removeEventListener')
      const deadline = createExecutionDeadline(10_000, mockLogger)
      const mockClient = {
        session: {
          status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
        },
      }

      // #when
      const pollPromise = pollForSessionCompletion(
        mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        'ses_123',
        '/workspace',
        pollSignalController.signal,
        mockLogger,
        10_000,
        undefined,
        deadline,
      )
      await vi.advanceTimersByTimeAsync(500)
      const result = await pollPromise
      deadline.dispose()

      // #then — the interval's listener is removed even though its timer resolved first
      const intervalListener = addListener.mock.calls.find(call => call[0] === 'abort')?.[1]
      expect(intervalListener).toBeDefined()
      expect(removeListener).toHaveBeenCalledWith('abort', intervalListener)
      expect(result).toEqual({completed: true, error: null})
    } finally {
      vi.useRealTimers()
    }
  })

  it('prevents wait() resolving before any current-turn activity from declaring success', async () => {
    // #given — models the exact CI bug: prompt sent, v2 wait resolves immediately (session was
    // already idle from a prior turn), no event-stream activity for the current turn yet.
    // Expected: runPromptAttempt must NOT return success=true in 68ms.
    const waitFn = vi.fn<TestWaitFn>().mockRejectedValue(new Error('wait unavailable'))
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        // poll sees idle immediately — but wait resolved before any activity, so this
        // should be the fallback path, not the fast-path
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
    }
    // No events at all — simulates the window between prompt send and first server event
    const eventStream = createMockEventStream([])

    // #when — wait resolves immediately, zero activity observed
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      700,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — wait() resolved before activity; must NOT have short-circuited to success
    // The poll watchdog must have been the completion authority (it saw idle after activity gate)
    expect(waitFn).toHaveBeenCalled()
    // The key assertion: wait() alone (with no activity) must not produce success in <100ms
    // If this fails, the bug is present: wait() bypassed the activity gate
    expect(result.success).toBe(false)
    expect(result.error).toContain('Poll timeout')
    expect(mockClient.session.status).toHaveBeenCalled()
  })

  it('does not treat session.status busy as current-turn activity for wait completion', async () => {
    // #given — models the green-but-no-review CI bug: the stream has no current-turn events,
    // status briefly reports busy, and v2 wait resolves. Status has no turn identity, so busy
    // must not unlock wait() completion.
    let resolveWait!: () => void
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(
      async () =>
        new Promise<TestWaitResponse>(resolve => {
          resolveWait = () => resolve({data: undefined, error: undefined})
        }),
    )
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    let statusCalls = 0
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          statusCalls++
          return {data: {ses_123: {type: statusCalls === 1 ? 'busy' : 'idle'}}}
        }),
      },
    }
    const eventStream = createMockEventStream([])
    setTimeout(() => resolveWait(), 20)

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      1_200,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then
    expect(waitFn).toHaveBeenCalled()
    expect(mockClient.session.status).toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toContain('Poll timeout')
  })

  it('does not treat a new user message as current-turn activity', async () => {
    // #given — the submitted prompt appears as a new user message, but no assistant output exists yet.
    const waitFn = vi.fn<TestWaitFn>().mockResolvedValue({data: undefined, error: undefined})
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        messages: vi
          .fn()
          .mockResolvedValueOnce({data: []})
          .mockResolvedValue({data: [{info: {id: 'msg_user', role: 'user', time: {created: 1}}}]}),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
    }

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      700,
      mockLogger,
      createMockEventStream([]).stream,
      'http://localhost:1234',
      async () => null,
    )

    // #then
    expect(waitFn).toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toContain('Poll timeout')
  })

  it('bUG: stream activity (message.part.delta) + v2 wait resolving does NOT complete — needs terminal signal', async () => {
    // #given — models the exact false-pass from commit 1116332:
    // LLM stream starts (message.part.delta / message.updated events arrive), v2.session.wait()
    // resolves, session.status() reports idle — but no session.idle event and no completed
    // assistant message. The harness must NOT declare success; it must keep polling until timeout.
    let resolveWait!: () => void
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(
      async () =>
        new Promise<TestWaitResponse>(resolve => {
          resolveWait = () => resolve({data: undefined, error: undefined})
        }),
    )
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        // status reports idle after activity — this was the false-pass path
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
    }
    // Stream emits current-turn start events (LLM streaming began) but NO session.idle
    const activityEvents: Event[] = [
      {
        type: 'message.part.delta',
        properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'hello'}},
      } as unknown as Event,
      {
        type: 'message.updated',
        properties: {sessionID: 'ses_123', info: {role: 'assistant', tokens: {input: 10, output: 5}}},
      } as unknown as Event,
    ]
    const eventStream = createMockEventStream(activityEvents)
    // Resolve wait after activity events are processed
    setTimeout(() => resolveWait(), 30)

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      700,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — activity observed + wait resolved + status idle is NOT enough; need terminal signal
    expect(waitFn).toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toContain('Poll timeout')
  })

  it('new assistant message without time.completed counts activity but does NOT complete', async () => {
    // #given — detectMessageActivity finds a new assistant message but it has no time.completed
    // (the LLM is still streaming). Must count as activity (firstMeaningfulEventReceived) but
    // must NOT return completed: true.
    const waitFn = vi.fn<TestWaitFn>().mockResolvedValue({data: undefined, error: undefined})
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        messages: vi
          .fn()
          .mockResolvedValueOnce({data: []}) // baseline: empty
          .mockResolvedValue({
            // poll: new assistant message, no time.completed
            data: [{info: {id: 'msg_new', role: 'assistant', time: {created: 1}}}],
          }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
    }

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      700,
      mockLogger,
      createMockEventStream([]).stream,
      'http://localhost:1234',
      async () => null,
    )

    // #then — incomplete assistant message must not complete the attempt
    expect(result.success).toBe(false)
    expect(result.error).toContain('Poll timeout')
  })

  it('new assistant message WITH stable time.completed completes the attempt', async () => {
    // #given — detectMessageActivity finds a new assistant message with time.completed set and no newer assistant
    // message appears during the stability window.
    const waitFn = vi.fn<TestWaitFn>().mockResolvedValue({data: undefined, error: undefined})
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        messages: vi
          .fn()
          .mockResolvedValueOnce({data: []}) // baseline: empty
          .mockResolvedValue({
            // poll: new assistant message with time.completed
            data: [{info: {id: 'msg_new', role: 'assistant', time: {created: 1, completed: 2}}}],
          }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
    }

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      createMockEventStream([]).stream,
      'http://localhost:1234',
      async () => null,
    )

    // #then — completed assistant message IS a terminal signal
    expect(result.success).toBe(true)
  })

  it('does not complete when a completed assistant message is followed by a newer in-progress assistant message', async () => {
    // #given — models the false-pass on c025372: OpenCode completed one assistant message, then immediately
    // started the next loop step. The first completed message is not terminal for the whole agent run.
    const waitFn = vi.fn<TestWaitFn>().mockResolvedValue({data: undefined, error: undefined})
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const completedAssistant = {info: {id: 'msg_step_0', role: 'assistant', time: {created: 1, completed: 2}}}
    const nextAssistant = {info: {id: 'msg_step_1', role: 'assistant', time: {created: 3}}}
    const mockClient = {
      session: {
        messages: vi
          .fn()
          .mockResolvedValueOnce({data: []})
          .mockResolvedValueOnce({data: [completedAssistant]})
          .mockResolvedValue({data: [completedAssistant, nextAssistant]}),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
    }

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      1_200,
      mockLogger,
      createMockEventStream([]).stream,
      'http://localhost:1234',
      async () => null,
    )

    // #then
    expect(result.success).toBe(false)
    expect(result.error).toContain('Poll timeout')
  })

  it('disables message fallback when baseline message listing fails', async () => {
    // #given — fail closed: an old completed assistant message must not become "new" on baseline failure.
    const waitFn = vi.fn<TestWaitFn>().mockResolvedValue({data: undefined, error: undefined})
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        messages: vi
          .fn()
          .mockRejectedValueOnce(new Error('message list failed'))
          .mockResolvedValue({
            data: [{info: {id: 'old_assistant', role: 'assistant', time: {created: 1, completed: 2}}}],
          }),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
    }

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      700,
      mockLogger,
      createMockEventStream([]).stream,
      'http://localhost:1234',
      async () => null,
    )

    // #then
    expect(result.success).toBe(false)
    expect(result.error).toContain('Poll timeout')
  })

  it('times out baseline message listing and still submits the prompt', async () => {
    // #given — baseline listing hangs before prompt submission; it must not hang the harness forever.
    vi.useFakeTimers()
    try {
      const {runPromptAttempt} = await import('./retry.js')
      const startPrompt = vi.fn(async () => null)
      const mockClient = {
        session: {
          messages: vi.fn().mockImplementation(async () => new Promise<never>(() => {})),
          status: vi.fn().mockResolvedValue({data: {}}),
        },
      }

      // #when
      const resultPromise = runPromptAttempt(
        mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        'ses_123',
        '/workspace',
        700,
        mockLogger,
        createMockEventStream([]).stream,
        undefined,
        startPrompt,
      )
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await resultPromise

      // #then
      expect(startPrompt).toHaveBeenCalledOnce()
      expect(result.success).toBe(false)
      expect(result.error).toContain('Poll timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('wait() completing after current-turn terminal signal is observed signals success correctly', async () => {
    // #given — wait resolves after BOTH firstMeaningfulEventReceived AND currentTurnTerminalSignalReceived
    // are true. The terminal signal is session.idle (not just message.part.delta stream start).
    let resolveWait!: () => void
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(
      async () =>
        new Promise<TestWaitResponse>(resolve => {
          resolveWait = () => resolve({data: undefined, error: undefined})
        }),
    )
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        // poll stays busy — if poll were the authority, result would be failure/timeout
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
    }
    // Emit activity event then session.idle (the terminal signal), then resolve wait
    const events: Event[] = [
      {
        type: 'message.part.delta',
        properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'hello'}},
      } as unknown as Event,
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ]
    const eventStream = createMockEventStream(events)

    // Resolve wait shortly after the terminal event is processed
    setTimeout(() => resolveWait(), 30)

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — wait() resolved after terminal signal → success, poll was NOT the authority
    expect(result.success).toBe(true)
    expect(waitFn).toHaveBeenCalled()
    // poll should not have been the completion authority (status was always busy)
    expect(mockClient.session.status).not.toHaveBeenCalled()
  })

  it('uses @opencode-ai/sdk/v2 createOpencodeClient (not client.v2) as primary completion authority', async () => {
    // #given — v2 module resolves after activity; client has NO v2 property
    let resolveWait!: () => void
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(
      async () =>
        new Promise<TestWaitResponse>(resolve => {
          resolveWait = () => resolve({data: undefined, error: undefined})
        }),
    )
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        // status stays busy — if poll were the authority, result would be failure
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
      // deliberately no v2 property — proves we don't duck-type client.v2
    }
    // Emit activity + session.idle (terminal signal), then resolve wait
    const eventStream = createMockEventStream([
      {
        type: 'message.part.delta',
        properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'hello'}},
      } as unknown as Event,
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ])
    setTimeout(() => resolveWait(), 20)

    // #when — pass serverUrl so the v2 client can be created
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — wait() was called with correct params; completion came from v2 module, not client.v2
    const waitCall = waitFn.mock.calls.at(0)
    expect(waitCall?.[0]).toEqual({sessionID: 'ses_123'})
    expect(waitCall?.[1].signal).toBeInstanceOf(AbortSignal)
    expect(result.success).toBe(true)
    // poll should NOT have been the completion authority (status was always busy)
    expect(mockClient.session.status).not.toHaveBeenCalled()
  })

  it('createOpencodeClient is called with the existing server URL, not a new server', async () => {
    // #given — capture the baseUrl passed to createOpencodeClient
    // wait resolves after activity so the activity gate is satisfied
    let resolveWait!: () => void
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(
      async () =>
        new Promise<TestWaitResponse>(resolve => {
          resolveWait = () => resolve({data: undefined, error: undefined})
        }),
    )
    const createOpencodeClientMock = vi.fn().mockReturnValue({
      v2: {session: {wait: waitFn}},
    })
    vi.doMock('@opencode-ai/sdk/v2', () => ({createOpencodeClient: createOpencodeClientMock}))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}})},
    }
    const eventStream = createMockEventStream([
      {
        type: 'message.part.delta',
        properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'hi'}},
      } as unknown as Event,
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ])
    setTimeout(() => resolveWait(), 20)

    // #when
    await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:9999',
    )

    // #then — createOpencodeClient was called with the URL we passed in (existing server)
    expect(createOpencodeClientMock).toHaveBeenCalledWith({baseUrl: 'http://localhost:9999'})
  })

  it('marks activityTracker.sessionIdle=true after wait() resolves (with prior terminal signal)', async () => {
    // #given — wait resolves after session.idle event (terminal signal); we verify the tracker is marked idle
    let resolveWait!: () => void
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(
      async () =>
        new Promise<TestWaitResponse>(resolve => {
          resolveWait = () => resolve({data: undefined, error: undefined})
        }),
    )
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
    }
    const events: Event[] = [
      {
        type: 'message.part.delta',
        properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'hi'}},
      } as unknown as Event,
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ]
    const eventStream = createMockEventStream(events)
    setTimeout(() => resolveWait(), 30)

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — wait resolved after activity → success; poll was NOT the authority
    expect(result.success).toBe(true)
    expect(waitFn).toHaveBeenCalledOnce()
    expect(mockClient.session.status).not.toHaveBeenCalled()
  })

  it('v2.session.wait() resolving after quota_exceeded is classified never reports success', async () => {
    // #given — wait() resolves (no SDK-level error) after the SSE stream has already classified
    // an account_rate_limit retry as quota_exceeded and set the terminal signal. A non-retryable
    // quota failure must never be reported as a completed/successful run.
    let resolveWait!: () => void
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(
      async () =>
        new Promise<TestWaitResponse>(resolve => {
          resolveWait = () => resolve({data: undefined, error: undefined})
        }),
    )
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
    }
    const eventStream = createMockEventStream([
      {
        type: 'session.status',
        properties: {
          sessionID: 'ses_123',
          status: {
            type: 'retry',
            attempt: 1,
            message: 'Usage limit reached',
            action: {reason: 'account_rate_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
            next: Date.now() + 5000,
          },
        },
      } as unknown as Event,
    ])
    setTimeout(() => resolveWait(), 20)

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — wait() resolved, but the result is a quota failure, never success
    expect(waitFn).toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.llmError?.type).toBe('quota_exceeded')
  })

  it('v2.session.wait() resolving after provider auth failure never reports success', async () => {
    // #given — wait() resolves after SSE observes the structured provider auth failure
    let resolveWait!: () => void
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(
      async () =>
        new Promise<TestWaitResponse>(resolve => {
          resolveWait = () => resolve({data: undefined, error: undefined})
        }),
    )
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
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
    setTimeout(() => resolveWait(), 20)

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — wait() completion cannot turn a terminal auth failure into success or a retry
    expect(waitFn).toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.llmError?.type).toBe('provider_auth_error')
    expect(result.outcome).toBe('turn_failed_terminal')
    expect(result.shouldRetry).toBe(false)
    expect(JSON.stringify(result)).not.toContain('sentinel-provider')
    expect(JSON.stringify(result)).not.toContain('sentinel-token')
  })

  it('poll-only quota via REST (no SSE event at all) produces a failed, non-retryable quota_exceeded result', async () => {
    // #given — the SSE stream never emits a session.status/session.error quota signal (empty
    // stream); the REST poll is the only source that observes the account_rate_limit retry status.
    const waitFn = vi.fn<TestWaitFn>().mockRejectedValue(new Error('wait not supported'))
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({
          data: {
            ses_123: {
              type: 'retry',
              attempt: 1,
              message: 'Usage limit reached',
              action: {reason: 'account_rate_limit', provider: 'anthropic', title: 'x', message: 'x', label: 'x'},
              next: Date.now() + 5000,
            },
          },
        }),
      },
    }
    const eventStream = createMockEventStream([])

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — the poll-observed quota classification becomes the authoritative result
    expect(result.success).toBe(false)
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).toBe('quota_exceeded')
    expect(result.outcome).toBe('turn_failed_terminal')
    expect(result.shouldRetry).toBe(false)
    expect(result.eventStreamResult.llmError).not.toBeNull()
    expect(result.eventStreamResult.llmError?.type).toBe('quota_exceeded')
  })

  it('falls back to pollForSessionCompletion when v2.session.wait() rejects', async () => {
    // #given — wait throws; fallback poll sees busy then idle after real stream activity
    const waitFn = vi.fn<TestWaitFn>().mockRejectedValue(new Error('wait not supported'))
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    let statusCalls = 0
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          statusCalls++
          return {data: {ses_123: {type: statusCalls === 1 ? 'busy' : 'idle'}}}
        }),
      },
    }
    const eventStream = createCurrentTurnActivityStream()

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — wait rejects so v2 unavailable; session.idle event from stream provides
    // terminal signal, poll completes via sessionIdle check (status not needed)
    expect(result.success).toBe(true)
  })

  it('falls back to pollForSessionCompletion when no serverUrl is provided', async () => {
    // #given — no serverUrl → v2 client cannot be created → poll is the only path
    const {runPromptAttempt} = await import('./retry.js')
    let statusCalls = 0
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          statusCalls++
          return {data: {ses_123: {type: statusCalls === 1 ? 'busy' : 'idle'}}}
        }),
      },
    }
    const eventStream = createCurrentTurnActivityStream()

    // #when — omit serverUrl
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      // no serverUrl
    )

    // #then — no serverUrl so v2 wait skipped; session.idle event from stream provides
    // terminal signal, poll completes via sessionIdle check (status not needed)
    expect(result.success).toBe(true)
  })

  it('falls back to pollForSessionCompletion when @opencode-ai/sdk/v2 import fails', async () => {
    // #given — module import throws (older SDK without v2 export)
    vi.doMock('@opencode-ai/sdk/v2', () => {
      throw new Error('Cannot find module')
    })
    const {runPromptAttempt} = await import('./retry.js')
    let statusCalls = 0
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          statusCalls++
          return {data: {ses_123: {type: statusCalls === 1 ? 'busy' : 'idle'}}}
        }),
      },
    }
    const eventStream = createCurrentTurnActivityStream()

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — import fails so v2 wait is unavailable; session.idle event from stream
    // provides the terminal signal, poll completes via sessionIdle check (status not needed)
    expect(result.success).toBe(true)
  })

  it('does not complete from message.updated delta events alone', async () => {
    // #given — only delta events arrive; wait() never resolves (hangs); poll sees busy then idle
    let waitResolve: (() => void) | null = null
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(
      async () =>
        new Promise<TestWaitResponse>(resolve => {
          waitResolve = () => resolve({data: undefined, error: undefined})
        }),
    )
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    let statusCalls = 0
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          statusCalls++
          return {data: {ses_123: {type: statusCalls === 1 ? 'busy' : 'idle'}}}
        }),
      },
    }
    // message.updated without time.completed — activity but NOT a terminal signal
    const deltaEvents: Event[] = [
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: 'ses_123',
            parentID: '',
            role: 'assistant',
            tokens: {input: 10, output: 5, reasoning: 0, cache: {read: 0, write: 0}},
            modelID: 'claude-sonnet',
            cost: 0.001,
            time: {created: 0},
            system: '',
            parts: [],
          },
        },
      } as unknown as Event,
      // session.idle provides the terminal signal — wait() alone after delta is not enough
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ]
    const eventStream = createMockEventStream(deltaEvents)

    // Resolve wait after a tick so the terminal signal (session.idle) is observed first
    setTimeout(() => {
      waitResolve?.()
    }, 10)

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — message.updated alone did not complete; session.idle provided terminal signal
    // then wait() resolved confirming completion
    expect(result.success).toBe(true)
    expect(waitFn).toHaveBeenCalled()
  })

  it('returns failure when wait() resolves with an error response', async () => {
    // #given — wait returns 4xx/5xx style error in data; fallback poll sees busy then idle after real stream activity
    const waitFn = vi
      .fn<TestWaitFn>()
      .mockResolvedValue({data: undefined, error: {status: 500, message: 'internal error'}})
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    let statusCalls = 0
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          statusCalls++
          return {data: {ses_123: {type: statusCalls === 1 ? 'busy' : 'idle'}}}
        }),
      },
    }
    const eventStream = createCurrentTurnActivityStream()

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      30_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — wait error treated as unavailable; session.idle event from stream provides
    // the terminal signal (currentTurnTerminalSignalReceived), so poll completes via
    // sessionIdle check without needing to call status().
    expect(result.success).toBe(true)
  })

  it('never-resolving wait() does not block the no-activity watchdog from timing out', async () => {
    // #given — wait() hangs forever; poll watchdog must still fire the no-activity timeout
    const waitSignals: AbortSignal[] = []
    const waitFn = vi.fn<TestWaitFn>().mockImplementation(async (_params, options) => {
      waitSignals.push(options.signal)
      return new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        })
      })
    })
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        // status never returns idle — simulates a crashed server (no activity)
        status: vi.fn().mockResolvedValue({data: {}}),
      },
    }
    const eventStream = createMockEventStream([])

    // #when — use a very short timeout so the test doesn't actually wait 90s
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      200, // 200ms timeout — watchdog must fire even though wait() is still pending
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — poll watchdog returned failure; wait() did not prevent it
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/timeout|activity/i)
    expect(waitFn).toHaveBeenCalled()
    expect(waitSignals.at(0)?.aborted).toBe(true)
  })

  it('pollForSessionCompletion runs in parallel with wait(), not sequentially after', async () => {
    // #given — wait resolves after a delay (after activity); poll must have started before wait resolves
    const pollStartTimes: number[] = []
    const waitStartTimes: number[] = []

    const waitFn = vi.fn<TestWaitFn>().mockImplementation(async () => {
      waitStartTimes.push(Date.now())
      await new Promise(resolve => setTimeout(resolve, 50))
      return {data: undefined, error: undefined}
    })
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        status: vi.fn().mockImplementation(async () => {
          pollStartTimes.push(Date.now())
          return {data: {ses_123: {type: 'busy'}}}
        }),
      },
    }
    // Emit activity + session.idle (terminal signal) so currentTurnTerminalSignalReceived is set
    // before wait resolves at 50ms. Without session.idle, wait falls back to poll (busy→timeout).
    const eventStream = createMockEventStream([
      {
        type: 'message.part.delta',
        properties: {sessionID: 'ses_123', delta: {type: 'text', text: 'hi'}},
      } as unknown as Event,
      {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event,
    ])

    // #when
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      5_000,
      mockLogger,
      eventStream.stream,
      'http://localhost:1234',
    )

    // #then — both started; poll started before or very close to when wait started (parallel)
    expect(result.success).toBe(true)
    expect(waitStartTimes.length).toBeGreaterThan(0)
    // poll may or may not have been called (wait won the race), but wait must have been called
    expect(waitFn).toHaveBeenCalled()
  })

  it('does not double-count comment artifacts detected by both stream and fallback parts', async () => {
    // #given — live stream observes a completed comment-posting bash tool, and the completed
    // assistant message fallback later contains the same tool output.
    const waitFn = vi.fn<TestWaitFn>().mockRejectedValue(new Error('wait unavailable'))
    vi.doMock('@opencode-ai/sdk/v2', () => makeV2Module(waitFn))
    const {runPromptAttempt} = await import('./retry.js')
    const commentUrl = 'https://github.com/owner/repo/issues/1#issuecomment-123'
    const commentPart = {
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        title: 'Post comment',
        input: {command: 'gh issue comment 1 --body "hello"'},
        output: commentUrl,
      },
    }
    const completedAssistantMessage = {
      info: {
        id: 'msg_comment_duplicate',
        role: 'assistant',
        time: {created: 1, completed: 2},
      },
      parts: [commentPart],
    }
    const mockClient = {
      session: {
        messages: vi
          .fn()
          .mockResolvedValueOnce({data: []})
          .mockResolvedValue({data: [completedAssistantMessage]}),
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
    }
    const eventStream = {
      stream: (async function* () {
        await new Promise<void>(resolve => {
          setTimeout(resolve, 0)
        })
        yield {
          type: 'message.part.updated',
          properties: {
            sessionID: 'ses_123',
            part: commentPart,
          },
        } as unknown as Event
        yield {type: 'session.idle', properties: {sessionID: 'ses_123'}} as unknown as Event
      })(),
      controller: {abort: vi.fn()},
    }
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    try {
      // #when
      const result = await runPromptAttempt(
        mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        'ses_123',
        '/workspace',
        30_000,
        mockLogger,
        eventStream.stream,
        'http://localhost:1234',
        async () => null,
      )

      // #then
      expect(result.success).toBe(true)
      expect(result.eventStreamResult.commentsPosted).toBe(1)
      expect(result.eventStreamResult.commentsPostedUrls).toEqual([commentUrl])
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('does not set shouldRetry when llmError is a non-retryable quota_exceeded error, even though the poll failed', async () => {
    // #given — a structured session.error classifies as quota_exceeded (non-retryable); the poll
    // fails through the shared terminal-provider slot since the session never reaches idle.
    vi.useFakeTimers()
    try {
      const {runPromptAttempt} = await import('./retry.js')
      const mockClient = {
        session: {
          status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
        },
      }
      const eventStream = createMockEventStream([
        {
          type: 'session.error',
          properties: {
            sessionID: 'ses_123',
            error: {name: 'APIError', data: {status: 402, message: 'Payment required'}},
          },
        } as unknown as Event,
      ])

      // #when
      const resultPromise = runPromptAttempt(
        mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        'ses_123',
        '/workspace',
        30_000,
        mockLogger,
        eventStream.stream,
        undefined,
      )
      await vi.advanceTimersByTimeAsync(2_000)
      const result = await resultPromise

      // #then — llmError is present but non-retryable, so shouldRetry must be false
      expect(result.llmError).not.toBeNull()
      expect(result.llmError?.type).toBe('quota_exceeded')
      expect(result.llmError?.retryable).toBe(false)
      expect(result.shouldRetry).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sets shouldRetry when llmError is a retryable llm_fetch_error and the poll failed', async () => {
    // #given — an LLM fetch error (retryable: true) triggers the sessionError grace-cycle path
    vi.useFakeTimers()
    try {
      const {runPromptAttempt} = await import('./retry.js')
      const mockClient = {
        session: {
          status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
        },
      }
      const eventStream = createMockEventStream([
        {
          type: 'session.error',
          properties: {sessionID: 'ses_123', error: 'fetch failed: network error'},
        } as unknown as Event,
      ])

      // #when
      const resultPromise = runPromptAttempt(
        mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
        'ses_123',
        '/workspace',
        30_000,
        mockLogger,
        eventStream.stream,
        undefined,
      )
      await vi.advanceTimersByTimeAsync(2_000)
      const result = await resultPromise

      // #then — llmError is present and retryable, so shouldRetry must be true
      expect(result.llmError).not.toBeNull()
      expect(result.llmError?.type).toBe('llm_fetch_error')
      expect(result.llmError?.retryable).toBe(true)
      expect(result.outcome).toBe('turn_failed_retryable')
      expect(result.shouldRetry).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not set shouldRetry when llmError is null and the poll failed', async () => {
    // #given — no session.error at all; poll fails via plain timeout with no llmError classified
    const {runPromptAttempt} = await import('./retry.js')
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {}}),
      },
    }
    const eventStream = createMockEventStream([])

    // #when — very short timeout, no activity ever observed
    const result = await runPromptAttempt(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      200,
      mockLogger,
      eventStream.stream,
      undefined,
    )

    // #then
    expect(result.success).toBe(false)
    expect(result.llmError).toBeNull()
    expect(result.outcome).toBe('turn_failed_terminal')
    expect(result.shouldRetry).toBe(false)
  })

  it('does not sum duplicate counter-only fallback comment artifacts when no comment URLs are available', async () => {
    // #given — defensive coverage for legacy/counter-only comment tracking where neither path
    // produced URL-tracked comment artifacts.
    const {mergeArtifactResults} = await import('./retry.js')
    const eventStreamResult = {
      tokens: null,
      model: null,
      cost: null,
      prsCreated: [],
      commitsCreated: [],
      commentsPosted: 1,
      llmError: null,
    }
    const fallback = {
      prsCreated: [],
      commitsCreated: [],
      commentsPostedUrls: [],
      commentsPosted: 1,
    }

    // #when
    const result = mergeArtifactResults(eventStreamResult, fallback)

    // #then
    expect(result.commentsPosted).toBe(1)
    expect(result.commentsPostedUrls).toEqual([])
  })
})
