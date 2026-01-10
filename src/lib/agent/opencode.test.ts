import type {Logger} from '../logger.js'
import type {ExecutionConfig} from './types.js'
import {Buffer} from 'node:buffer'
import {spawn} from 'node:child_process'
import * as exec from '@actions/exec'

import {createOpencodeClient} from '@opencode-ai/sdk'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {executeOpenCode, verifyOpenCodeAvailable} from './opencode.js'

// Mock @actions/exec
vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}))

// Mock @opencode-ai/sdk
vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: vi.fn(),
}))

// Mock node:child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

interface MockProcess {
  stdout: {
    on: ReturnType<typeof vi.fn>
  }
  stderr: {
    on: ReturnType<typeof vi.fn>
  }
  on: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  killed: boolean
}

function createMockProcess(): MockProcess {
  const stdoutCallbacks: Map<string, (data: Buffer) => void> = new Map()
  const stderrCallbacks: Map<string, (data: Buffer) => void> = new Map()
  const processCallbacks: Map<string, (...args: unknown[]) => void> = new Map()

  const proc: MockProcess = {
    stdout: {
      on: vi.fn((event: string, callback: (data: Buffer) => void) => {
        stdoutCallbacks.set(event, callback)
      }),
    },
    stderr: {
      on: vi.fn((event: string, callback: (data: Buffer) => void) => {
        stderrCallbacks.set(event, callback)
      }),
    },
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      processCallbacks.set(event, callback)
    }),
    kill: vi.fn(() => {
      proc.killed = true
      return true
    }),
    killed: false,
  }

  // Helper to emit events
  ;(proc as MockProcess & {emit: (target: string, event: string, ...args: unknown[]) => void}).emit = (
    target: string,
    event: string,
    ...args: unknown[]
  ) => {
    if (target === 'stdout') {
      stdoutCallbacks.get(event)?.(args[0] as Buffer)
    } else if (target === 'stderr') {
      stderrCallbacks.get(event)?.(args[0] as Buffer)
    } else if (target === 'process') {
      processCallbacks.get(event)?.(...args)
    }
  }

  return proc
}

function createMockClient(options: {
  promptResponse?: {parts: {type: string; text?: string}[]}
  throwOnPrompt?: boolean
  throwOnCreate?: boolean
  throwOnLog?: boolean
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
  }
}

type MockProcessWithEmit = MockProcess & {emit: (target: string, event: string, ...args: unknown[]) => void}

describe('executeOpenCode', () => {
  let mockLogger: Logger
  let mockProcess: MockProcessWithEmit

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockProcess = createMockProcess() as MockProcessWithEmit
    vi.clearAllMocks()

    // Default spawn mock
    vi.mocked(spawn).mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('spawns opencode server with correct arguments', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    // Simulate server ready after spawn
    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('opencode server listening on http://127.0.0.1:4096'))
    }, 10)

    // #when
    const result = await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(spawn).toHaveBeenCalledWith(
      'opencode',
      ['serve', '--hostname=127.0.0.1', '--port=4096'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
    expect(result.success).toBe(true)
  })

  it('uses custom opencodePath when provided', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    // #when
    await executeOpenCode('Test prompt', '/custom/opencode', mockLogger)

    // #then
    expect(spawn).toHaveBeenCalledWith('/custom/opencode', expect.arrayContaining(['serve']), expect.any(Object))
  })

  it('creates SDK client with server URL', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    // #when
    await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:4096',
    })
  })

  it('creates session and sends prompt', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    // #when
    const result = await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(mockClient.session.create).toHaveBeenCalled()
    expect(mockClient.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: {id: 'ses_123'},
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        body: expect.objectContaining({
          agent: 'Sisyphus',
          parts: [{type: 'text', text: 'Test prompt'}],
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
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    const config: ExecutionConfig = {
      agent: 'Sisyphus',
      model: {providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514'},
      timeoutMs: 1800000,
    }

    // #when
    await executeOpenCode('Test prompt', null, mockLogger, config)

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
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    const config: ExecutionConfig = {
      agent: 'Sisyphus',
      model: null,
      timeoutMs: 1800000,
    }

    // #when
    await executeOpenCode('Test prompt', null, mockLogger, config)

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
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    const config: ExecutionConfig = {
      agent: 'CustomAgent',
      model: null,
      timeoutMs: 1800000,
    }

    // #when
    await executeOpenCode('Test prompt', null, mockLogger, config)

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
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    // #when
    const result = await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeNull()
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })

  it('returns failure result when prompt fails', async () => {
    // #given
    const mockClient = createMockClient({throwOnPrompt: true})
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    // #when
    const result = await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain('Prompt failed')
  })

  it('returns failure result when session creation fails', async () => {
    // #given
    const mockClient = createMockClient({throwOnCreate: true})
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    // #when
    const result = await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain('Session creation failed')
  })

  it('cleans up server process on completion', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    // #when
    await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(mockProcess.kill).toHaveBeenCalled()
  })

  it('cleans up server process on error', async () => {
    // #given
    const mockClient = createMockClient({throwOnPrompt: true})
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    // #when
    await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(mockProcess.kill).toHaveBeenCalled()
  })

  it('logs execution info', async () => {
    // #given
    const mockClient = createMockClient({
      promptResponse: {parts: [{type: 'text', text: 'Response'}]},
    })
    vi.mocked(createOpencodeClient).mockReturnValue(mockClient as unknown as ReturnType<typeof createOpencodeClient>)

    setTimeout(() => {
      mockProcess.emit('stdout', 'data', Buffer.from('listening'))
    }, 10)

    // #when
    await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Executing OpenCode agent (SDK mode)',
      expect.objectContaining({
        promptLength: 11,
        agent: 'Sisyphus',
      }),
    )
  })

  it('returns failure when server fails to start', async () => {
    // #given
    setTimeout(() => {
      mockProcess.emit('process', 'error', new Error('Spawn failed'))
    }, 10)

    // #when
    const result = await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.error).toContain('Spawn failed')
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
