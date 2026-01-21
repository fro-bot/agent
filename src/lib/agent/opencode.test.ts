import type {Logger} from '../logger.js'
import type {ExecutionConfig, PromptOptions} from './types.js'
import {Buffer} from 'node:buffer'
import * as exec from '@actions/exec'

import {createOpencode} from '@opencode-ai/sdk'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {ensureOpenCodeAvailable, executeOpenCode, verifyOpenCodeAvailable} from './opencode.js'

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

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

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
    },
    customPrompt: null,
    cacheStatus: 'hit',
    ...overrides,
  }
}

interface OpenCodeEvent {
  type: string
  properties: Record<string, unknown>
}

function createMockEventStream(events: OpenCodeEvent[] = []): {
  stream: AsyncIterable<OpenCodeEvent>
} {
  return {
    stream: (async function* () {
      for (const event of events) {
        yield event
      }
    })(),
  }
}

function createMockClient(options: {
  promptResponse?: {parts: {type: string; text?: string}[]}
  throwOnPrompt?: boolean
  throwOnCreate?: boolean
  throwOnLog?: boolean
  events?: OpenCodeEvent[]
}) {
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
      prompt: options.throwOnPrompt
        ? vi.fn().mockRejectedValue(new Error('Prompt failed'))
        : vi.fn().mockResolvedValue({data: options.promptResponse}),
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
    expect(mockClient.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: {id: 'ses_123'},
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        body: expect.objectContaining({
          agent: 'Sisyphus',
          parts: [{type: 'text', text: 'Built prompt with sessionId'}],
        }),
      }),
    )
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
      agent: 'Sisyphus',
      model: {providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514'},
      timeoutMs: 1800000,
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then
    expect(mockClient.session.prompt).toHaveBeenCalledWith(
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

  it('does not include model when not configured', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    const mockOpencode = createMockOpencode({client: mockClient})
    vi.mocked(createOpencode).mockResolvedValue(mockOpencode as unknown as Awaited<ReturnType<typeof createOpencode>>)

    const config: ExecutionConfig = {
      agent: 'Sisyphus',
      model: null,
      timeoutMs: 1800000,
    }

    // #when
    await executeOpenCode(createMockPromptOptions(), mockLogger, config)

    // #then
    const promptCalls = vi.mocked(mockClient.session.prompt).mock.calls
    const firstCall = promptCalls[0] as [{body?: {model?: unknown}}] | undefined
    const promptCall = firstCall?.[0]
    expect(promptCall?.body?.model).toBeUndefined()
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
    const callArgs = vi.mocked(mockClient.session.prompt).mock.calls[0]?.[0] as {
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
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects fetch failed in exception thrown from executeOpenCode', async () => {
    // #given
    vi.mocked(createOpencode).mockRejectedValue(new Error('fetch failed'))

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.llmError).not.toBeNull()
    expect(result.llmError?.type).toBe('llm_fetch_error')
  })

  it('detects ECONNREFUSED in exception thrown from executeOpenCode', async () => {
    // #given
    vi.mocked(createOpencode).mockRejectedValue(new Error('ECONNREFUSED: connection refused'))

    // #when
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

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
    const result = await executeOpenCode(createMockPromptOptions(), mockLogger)

    // #then
    expect(result.success).toBe(true)
    expect(result.llmError).toBeNull()
  })
})
