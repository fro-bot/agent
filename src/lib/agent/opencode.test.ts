import type {Logger} from '../logger.js'
import {Buffer} from 'node:buffer'
import process from 'node:process'
import * as exec from '@actions/exec'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {executeOpenCode, verifyOpenCodeAvailable} from './opencode.js'

// Mock @actions/exec
vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}))

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

describe('executeOpenCode', () => {
  let mockLogger: Logger
  const originalPlatform = process.platform

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(process, 'platform', {value: originalPlatform})
  })

  it('executes opencode with prompt and returns success result', async () => {
    // #given
    vi.mocked(exec.exec).mockResolvedValue(0)

    // #when
    const result = await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeNull()
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })

  it('uses stdbuf wrapper on Linux for real-time streaming', async () => {
    // #given
    Object.defineProperty(process, 'platform', {value: 'linux', configurable: true})
    vi.mocked(exec.exec).mockResolvedValue(0)

    // #when
    await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    const expectedEnv = expect.objectContaining({PROMPT: 'Test prompt'}) as Record<string, string>
    const expectedOptions = expect.objectContaining({env: expectedEnv}) as exec.ExecOptions
    expect(exec.exec).toHaveBeenCalledWith('stdbuf', ['-oL', '-eL', 'opencode', 'run', '"$PROMPT"'], expectedOptions)
  })

  it('executes directly on macOS without stdbuf', async () => {
    // #given
    Object.defineProperty(process, 'platform', {value: 'darwin', configurable: true})
    vi.mocked(exec.exec).mockResolvedValue(0)

    // #when
    await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    const expectedEnv = expect.objectContaining({PROMPT: 'Test prompt'}) as Record<string, string>
    const expectedOptions = expect.objectContaining({env: expectedEnv}) as exec.ExecOptions
    expect(exec.exec).toHaveBeenCalledWith('opencode', ['run', '"$PROMPT"'], expectedOptions)
  })

  it('executes directly on Windows without stdbuf', async () => {
    // #given
    Object.defineProperty(process, 'platform', {value: 'win32', configurable: true})
    vi.mocked(exec.exec).mockResolvedValue(0)

    // #when
    await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(exec.exec).toHaveBeenCalledWith(
      'opencode',
      ['run', '"$PROMPT"'],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({env: expect.objectContaining({PROMPT: 'Test prompt'})}),
    )
  })

  it('uses provided opencodePath instead of default', async () => {
    // #given
    Object.defineProperty(process, 'platform', {value: 'darwin', configurable: true})
    vi.mocked(exec.exec).mockResolvedValue(0)

    // #when
    await executeOpenCode('Test prompt', '/custom/path/opencode', mockLogger)

    // #then
    const expectedEnv = expect.objectContaining({PROMPT: 'Test prompt'}) as Record<string, string>
    const expectedOptions = expect.objectContaining({env: expectedEnv}) as exec.ExecOptions
    expect(exec.exec).toHaveBeenCalledWith('/custom/path/opencode', ['run', '"$PROMPT"'], expectedOptions)
  })

  it('returns failure result on non-zero exit code', async () => {
    // #given
    vi.mocked(exec.exec).mockResolvedValue(1)

    // #when
    const result = await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('returns failure result on execution error', async () => {
    // #given
    vi.mocked(exec.exec).mockRejectedValue(new Error('Command not found'))

    // #when
    const result = await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.error).toBe('Command not found')
  })

  it('logs execution info and completion', async () => {
    // #given
    vi.mocked(exec.exec).mockResolvedValue(0)

    // #when
    await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Executing OpenCode agent',
      expect.objectContaining({
        promptLength: 11,
        platform: expect.any(String) as string,
      }),
    )
    expect(mockLogger.info).toHaveBeenCalledWith(
      'OpenCode execution completed',
      expect.objectContaining({
        exitCode: 0,
        durationMs: expect.any(Number) as number,
      }),
    )
  })

  it('logs error on execution failure', async () => {
    // #given
    vi.mocked(exec.exec).mockRejectedValue(new Error('Failed'))

    // #when
    await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(mockLogger.error).toHaveBeenCalledWith(
      'OpenCode execution failed',
      expect.objectContaining({
        error: 'Failed',
        durationMs: expect.any(Number) as number,
      }),
    )
  })

  it('returns null sessionId', async () => {
    // #given
    vi.mocked(exec.exec).mockResolvedValue(0)

    // #when
    const result = await executeOpenCode('Test prompt', null, mockLogger)

    // #then
    expect(result.sessionId).toBeNull()
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
