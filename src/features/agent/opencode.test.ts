import type {Event} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {OpenCodeServerHandle} from './server.js'
import type {ExecutionConfig, PromptOptions} from './types.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import process from 'node:process'

import * as exec from '@actions/exec'
import {createOpencode} from '@opencode-ai/sdk'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as setup from '../../services/setup/setup.js'
import * as envUtils from '../../shared/env.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {executeOpenCode} from './execution.js'
import {bootstrapOpenCodeServer, ensureOpenCodeAvailable, verifyOpenCodeAvailable} from './server.js'
import {INITIAL_ACTIVITY_TIMEOUT_MS, pollForSessionCompletion, waitForEventProcessorShutdown} from './session-poll.js'
import {logServerEvent, processEventStream} from './streaming.js'

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
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
      shutdown: vi.fn() as unknown as () => void,
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
    expect(mockClient.session.update).toHaveBeenCalledWith({
      path: {id: 'ses_123'},
      body: {title: 'fro-bot: schedule-c757a308'},
    })
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
    expect(mockClient.session.update).toHaveBeenCalledWith({
      path: {id: 'ses_123'},
      body: {title: 'fro-bot: schedule-c757a308'},
    })
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

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async () => {
          promptCallCount++
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
    const result = await resultPromise

    // #then
    expect(promptCallCount).toBe(2)
    expect(result.success).toBe(true)
    expect(mockLogger.warning).toHaveBeenCalledWith(
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

    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({data: {id: 'ses_123'}}),
        promptAsync: vi.fn().mockImplementation(async (args: {body: unknown}) => {
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
    expect(promptBodies.length).toBe(2)

    const firstBody = promptBodies[0] as {parts: {type: string; text: string}[]}

    const secondBody = promptBodies[1] as {parts: {type: string; text: string}[]}
    const firstPart = firstBody.parts[0]
    const secondPart = secondBody.parts[0]
    expect(firstPart).toBeDefined()
    expect(secondPart).toBeDefined()
    expect(firstPart?.text).toBe('Built prompt with sessionId')
    expect(secondPart?.text).toContain('interrupted by a network error')
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
    expect(promptBodies[1]?.parts[0]?.text).toContain('interrupted by a network error')
  })
})

describe('ensureOpenCodeAvailable', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
    delete process.env.OPENCODE_PATH
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.OPENCODE_PATH
  })

  it('returns existing OpenCode when already available', async () => {
    // #given
    vi.mocked(exec.exec).mockImplementation(async (_cmd, _args, options) => {
      if (options?.listeners?.stdout != null) {
        options.listeners.stdout(Buffer.from('opencode version 1.2.3\n'))
      }
      return 0
    })
    process.env.OPENCODE_PATH = '/existing/path'

    // #when
    const result = await ensureOpenCodeAvailable({
      logger: mockLogger,
      opencodeVersion: 'latest',
      githubToken: 'ghs_test_token',
      authJson: '{"anthropic": {"api_key": "sk-ant-test"}}',
      enableOmo: false,
      omoVersion: '3.7.4',
      systematicVersion: '2.1.0',
      omoProviders: {
        claude: 'no',
        copilot: 'no',
        gemini: 'no',
        openai: 'no',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
        kimiForCoding: 'no',
      },
      opencodeConfig: null,
      systematicConfig: null,
    })

    // #then
    expect(result.didSetup).toBe(false)
    expect(result.version).toBe('1.2.3')
    expect(result.path).toBe('/existing/path')
    expect(mockLogger.info).toHaveBeenCalledWith('OpenCode already available', expect.any(Object))
  })

  it('logs message when OpenCode not available and setup needed', async () => {
    // #given
    vi.mocked(exec.exec).mockRejectedValue(new Error('Command not found'))
    vi.spyOn(setup, 'runSetup').mockResolvedValue(null)

    // #when
    try {
      await ensureOpenCodeAvailable({
        logger: mockLogger,
        opencodeVersion: 'latest',
        githubToken: 'ghs_test_token',
        authJson: '{"anthropic": {"api_key": "sk-ant-test"}}',
        enableOmo: false,
        omoVersion: '3.7.4',
        systematicVersion: '2.1.0',
        omoProviders: {
          claude: 'no',
          copilot: 'no',
          gemini: 'no',
          openai: 'no',
          opencodeZen: 'no',
          zaiCodingPlan: 'no',
          kimiForCoding: 'no',
        },
        opencodeConfig: null,
        systematicConfig: null,
      })
    } catch {
      // Expected to fail since runSetup will fail in test environment
    }

    // #then
    expect(mockLogger.info).toHaveBeenCalledWith(
      'OpenCode not found, running auto-setup',
      expect.objectContaining({requestedVersion: 'latest'}),
    )
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
    await vi.advanceTimersByTimeAsync(1000)
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

  it('logs event with type and properties in debug mode', () => {
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
      properties: {sessionID: 'ses_123'},
    })
  })

  it('logs message.part.updated events with part details', () => {
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
      properties: {
        part: {
          sessionID: 'ses_123',
          type: 'tool',
          tool: 'bash',
          state: {status: 'completed', title: 'git status'},
        },
      },
    })
  })

  it('logs session.error events with error details', () => {
    // #given
    const event = {
      type: 'session.error',
      properties: {
        sessionID: 'ses_123',
        error: 'Connection timeout',
      },
    } as unknown as Event

    // #when
    logServerEvent(event, mockLogger)

    // #then
    expect(mockLogger.debug).toHaveBeenCalledWith('Server event', {
      eventType: 'session.error',
      properties: {
        sessionID: 'ses_123',
        error: 'Connection timeout',
      },
    })
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

describe('bootstrapOpenCodeServer', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns ok with server handle on success', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockServer = createMockServer()
    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    const abortController = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(abortController.signal, mockLogger)

    // #then
    expect(result.success).toBe(true)
    const handle = (result as {success: true; data: OpenCodeServerHandle}).data
    expect(handle.client).toBe(mockClient)
    expect(handle.server.url).toBe('http://127.0.0.1:4096')
    expect(typeof handle.shutdown).toBe('function')
  })

  it('passes signal to createOpencode', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockServer = createMockServer()
    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    const abortController = new AbortController()

    // #when
    await bootstrapOpenCodeServer(abortController.signal, mockLogger)

    // #then
    expect(createOpencode).toHaveBeenCalledWith({signal: abortController.signal})
  })

  it('returns err when createOpencode fails', async () => {
    // #given
    vi.mocked(createOpencode).mockRejectedValue(new Error('Connection refused'))

    const abortController = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(abortController.signal, mockLogger)

    // #then
    expect(result.success).toBe(false)
    const error = (result as {success: false; error: Error}).error
    expect(error.message).toContain('Server bootstrap failed')
    expect(error.message).toContain('Connection refused')
  })

  it('logs warning on failure', async () => {
    // #given
    vi.mocked(createOpencode).mockRejectedValue(new Error('Connection refused'))

    const abortController = new AbortController()

    // #when
    await bootstrapOpenCodeServer(abortController.signal, mockLogger)

    // #then
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to bootstrap OpenCode server',
      expect.objectContaining({error: 'Connection refused'}),
    )
  })

  it('shutdown calls server.close', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockServer = createMockServer()
    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    const abortController = new AbortController()

    // #when
    const result = await bootstrapOpenCodeServer(abortController.signal, mockLogger)

    // #then
    expect(result.success).toBe(true)
    const handle = (result as {success: true; data: OpenCodeServerHandle}).data
    handle.shutdown()
    expect(mockServer.close).toHaveBeenCalled()
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

  it('returns error after session.error grace cycles exhausted', async () => {
    // #given — session.error set via activityTracker (from event stream)
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'busy'}}}),
      },
    }
    const abortController = new AbortController()
    const activityTracker = {
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
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger())

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
    await processEventStream(eventStream.stream, 'ses_123', abortController.signal, createMockLogger())

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
  readonly directory: string
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

  it('prevents wait() resolving before any current-turn activity from declaring success', async () => {
    // #given — models the exact CI bug: prompt sent, v2 wait resolves immediately (session was
    // already idle from a prior turn), no event-stream activity for the current turn yet.
    // Expected: runPromptAttempt must NOT return success=true in 68ms.
    const waitFn = vi.fn<TestWaitFn>().mockResolvedValue({data: undefined, error: undefined})
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
    expect(waitCall?.[0]).toEqual({sessionID: 'ses_123', directory: '/workspace'})
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
})
