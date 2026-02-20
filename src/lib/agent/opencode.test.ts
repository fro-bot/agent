import type {Event} from '@opencode-ai/sdk'
import type {Logger} from '../logger.js'
import type {OpenCodeServerHandle} from './opencode.js'
import type {ExecutionConfig, PromptOptions} from './types.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import process from 'node:process'

import * as exec from '@actions/exec'
import {createOpencode} from '@opencode-ai/sdk'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as envUtils from '../../utils/env.js'
import {createMockLogger} from '../test-helpers.js'
import {
  bootstrapOpenCodeServer,
  ensureOpenCodeAvailable,
  executeOpenCode,
  logServerEvent,
  pollForSessionCompletion,
  verifyOpenCodeAvailable,
  waitForEventProcessorShutdown,
} from './opencode.js'

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

// Mock buildAgentPrompt
vi.mock('./prompt.js', () => ({
  buildAgentPrompt: vi.fn().mockReturnValue('Built prompt with sessionId'),
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
  const statusSequence = options.statusSequence ?? [options.sessionStatus ?? {ses_123: {type: 'idle'}}]
  let statusIndex = 0
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
      promptAsync: options.throwOnPrompt
        ? vi.fn().mockRejectedValue(new Error('Prompt failed'))
        : vi.fn().mockResolvedValue({data: options.promptResponse}),
      status: vi.fn().mockImplementation(async () => {
        const statusResponse = statusSequence[Math.min(statusIndex, statusSequence.length - 1)]
        statusIndex += 1
        return {data: statusResponse}
      }),
    },
    event: {
      subscribe: vi.fn().mockResolvedValue(createMockEventStream(options.events ?? [])),
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
    expect(promptCall?.body?.agent).toBe('Sisyphus')
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
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then

    const callArgs = vi.mocked(mockClient.session.promptAsync).mock.calls[0]?.[0] as {
      body?: {agent?: string}
    }
    expect(callArgs?.body?.agent).toBe('CustomAgent')
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
        agent: 'Sisyphus',
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
    expect(mockLogger.warning).toHaveBeenCalledWith('OpenCode not available')
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
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn().mockResolvedValue(createMockEventStream([])),
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
        subscribe: vi.fn().mockResolvedValue(createMockEventStream([])),
      },
    }

    vi.mocked(createOpencode).mockResolvedValue({
      client: mockClient,
      server: mockServer,
    } as unknown as Awaited<ReturnType<typeof createOpencode>>)

    // #when
    const resultPromise = executeOpenCode(createMockPromptOptions(), mockLogger)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5000)
      await vi.advanceTimersByTimeAsync(2000)
    }
    const result = await resultPromise

    // #then
    expect(promptCallCount).toBe(3)
    expect(result.success).toBe(false)
    expect(result.llmError).not.toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith('LLM fetch error: max retries exhausted', expect.any(Object))
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
        subscribe: vi.fn().mockResolvedValue(createMockEventStream([])),
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
    let subscribeCallCount = 0

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
          subscribeCallCount++
          const events: Event[] =
            subscribeCallCount === 1
              ? []
              : [
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
                ]
          return Promise.resolve(createMockEventStream(events))
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
        status: vi.fn().mockResolvedValue({data: {ses_123: {type: 'idle'}}}),
      },
      event: {
        subscribe: vi.fn().mockResolvedValue(createMockEventStream([])),
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

    // #when
    try {
      await ensureOpenCodeAvailable({
        logger: mockLogger,
        opencodeVersion: 'latest',
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

  it('returns error after retry grace cycles exhausted', async () => {
    // #given
    const mockClient = {
      session: {
        status: vi.fn().mockResolvedValue({
          data: {ses_123: {type: 'retry', attempt: 1, message: 'Server crashed', next: 0}},
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
    expect(result.completed).toBe(false)
    expect(result.error).toContain('retry cycles')
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

    // #when
    const result = await pollForSessionCompletion(
      mockClient as unknown as Awaited<ReturnType<typeof createOpencode>>['client'],
      'ses_123',
      '/workspace',
      abortController.signal,
      mockLogger,
      1000,
    )

    // #then
    expect(result.completed).toBe(false)
    expect(result.error).toContain('Poll timeout')
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

    // #when
    const start = Date.now()
    await waitForEventProcessorShutdown(processor, 100)
    const elapsed = Date.now() - start

    // #then
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(1000)
  })
})
