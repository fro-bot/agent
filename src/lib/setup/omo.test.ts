import type {OmoInstallDeps} from './omo.js'
import type {ExecAdapter} from './types.js'
import {Buffer} from 'node:buffer'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../test-helpers.js'
import {installOmo, verifyOmoInstallation} from './omo.js'

// Mock exec adapter
function createMockExecAdapter(overrides: Partial<ExecAdapter> = {}): ExecAdapter {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: '', stderr: ''}),
    ...overrides,
  }
}

/**
 * Create mock dependencies for installOmo function testing.
 * Provides all required dependencies with sensible defaults that can be overridden.
 */
function createMockDeps(overrides: Partial<OmoInstallDeps> = {}): OmoInstallDeps {
  return {
    logger: createMockLogger(),
    execAdapter: createMockExecAdapter(),
    ...overrides,
  }
}

describe('omo', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('installOmo', () => {
    it('returns success on successful installation', async () => {
      // #given - bunx oh-my-opencode install succeeds
      const execMock = vi
        .fn()
        .mockImplementation(
          async (_cmd, _args, options: {listeners?: {stdout?: (chunk: Buffer) => void}}): Promise<number> => {
            if (options?.listeners?.stdout != null) {
              options.listeners.stdout(Buffer.from('Installing oh-my-opencode@1.2.3\n'))
            }
            return 0
          },
        )
      const mockDeps = createMockDeps({
        execAdapter: createMockExecAdapter({exec: execMock}),
      })

      // #when
      const result = await installOmo('1.2.3', mockDeps)

      // #then
      expect(result.installed).toBe(true)
      expect(result.version).toBe('1.2.3')
      expect(result.error).toBeNull()
      expect(execMock).toHaveBeenCalledTimes(1)
      expect(execMock).toHaveBeenCalledWith(
        'bunx',
        [
          'oh-my-opencode@1.2.3',
          'install',
          '--no-tui',
          '--claude=no',
          '--copilot=no',
          '--gemini=no',
          '--openai=no',
          '--opencode-zen=no',
          '--zai-coding-plan=no',
          '--kimi-for-coding=no',
        ],
        expect.any(Object),
      )
    })

    it('returns success without version when version not in output', async () => {
      // #given
      const mockDeps = createMockDeps({
        execAdapter: createMockExecAdapter({
          exec: vi
            .fn()
            .mockImplementation(
              async (_cmd, _args, options: {listeners?: {stdout?: (chunk: Buffer) => void}}): Promise<number> => {
                if (options?.listeners?.stdout != null) {
                  options.listeners.stdout(Buffer.from('Installation complete\n'))
                }
                return 0
              },
            ),
        }),
      })

      // #when
      const result = await installOmo('3.5.5', mockDeps)

      // #then - falls back to input version when regex detection fails
      expect(result.installed).toBe(true)
      expect(result.version).toBe('3.5.5')
      expect(result.error).toBeNull()
    })

    it('returns failure when bunx oh-my-opencode install fails', async () => {
      // #given - bunx command fails
      const execMock = vi.fn().mockResolvedValue(1)
      const mockDeps = createMockDeps({
        execAdapter: createMockExecAdapter({exec: execMock}),
      })

      // #when
      const result = await installOmo('3.5.5', mockDeps)

      // #then
      expect(result.installed).toBe(false)
      expect(result.version).toBeNull()
      expect(result.error).toContain('exit code 1')
      expect(execMock).toHaveBeenCalledTimes(1)
    })

    it('returns failure on exception', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockDeps = createMockDeps({
        logger: mockLogger,
        execAdapter: createMockExecAdapter({
          exec: vi.fn().mockRejectedValue(new Error('Command not found')),
        }),
      })

      // #when
      const result = await installOmo('3.5.5', mockDeps)

      // #then
      expect(result.installed).toBe(false)
      expect(result.error).toContain('Command not found')
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('logs info on successful installation', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockDeps = createMockDeps({logger: mockLogger})

      // #when
      await installOmo('3.5.5', mockDeps)

      // #then
      expect(mockLogger.info).toHaveBeenCalledWith('Installing Oh My OpenCode plugin', expect.any(Object))
      expect(mockLogger.info).toHaveBeenCalledWith('oMo plugin installed', expect.any(Object))
    })

    it('uses pinned version in bunx call', async () => {
      // #given
      const execMock = vi.fn().mockResolvedValue(0)
      const mockDeps = createMockDeps({
        execAdapter: createMockExecAdapter({exec: execMock}),
      })

      // #when
      await installOmo('3.5.5', mockDeps)

      // #then - bunx call should use version parameter
      expect(execMock).toHaveBeenCalledWith(
        'bunx',
        expect.arrayContaining(['oh-my-opencode@3.5.5']),
        expect.any(Object),
      )
    })

    it('calls bunx with headless options using defaults', async () => {
      // #given
      const execMock = vi.fn().mockResolvedValue(0)
      const mockDeps = createMockDeps({
        execAdapter: createMockExecAdapter({exec: execMock}),
      })

      // #when
      await installOmo('3.5.5', mockDeps)

      // #then - bunx call includes headless options
      expect(execMock).toHaveBeenCalledWith(
        'bunx',
        [
          'oh-my-opencode@3.5.5',
          'install',
          '--no-tui',
          '--claude=no',
          '--copilot=no',
          '--gemini=no',
          '--openai=no',
          '--opencode-zen=no',
          '--zai-coding-plan=no',
          '--kimi-for-coding=no',
        ],
        expect.objectContaining({ignoreReturnCode: true}),
      )
    })

    it('calls bunx with custom options when provided', async () => {
      // #given
      const execMock = vi.fn().mockResolvedValue(0)
      const mockDeps = createMockDeps({
        execAdapter: createMockExecAdapter({exec: execMock}),
      })

      // #when
      await installOmo('3.5.5', mockDeps, {
        claude: 'yes',
        copilot: 'yes',
        gemini: 'yes',
        openai: 'yes',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
      })

      // #then - bunx call includes custom options
      expect(execMock).toHaveBeenCalledWith(
        'bunx',
        [
          'oh-my-opencode@3.5.5',
          'install',
          '--no-tui',
          '--claude=yes',
          '--copilot=yes',
          '--gemini=yes',
          '--openai=yes',
          '--opencode-zen=no',
          '--zai-coding-plan=no',
          '--kimi-for-coding=no',
        ],
        expect.objectContaining({ignoreReturnCode: true}),
      )
    })

    it('calls bunx with kimi-for-coding=yes when option is set', async () => {
      // #given
      const execMock = vi.fn().mockResolvedValue(0)
      const mockDeps = createMockDeps({
        execAdapter: createMockExecAdapter({exec: execMock}),
      })

      // #when
      await installOmo('3.5.5', mockDeps, {kimiForCoding: 'yes'})

      // #then - bunx call includes kimi-for-coding=yes
      expect(execMock).toHaveBeenCalledWith(
        'bunx',
        [
          'oh-my-opencode@3.5.5',
          'install',
          '--no-tui',
          '--claude=no',
          '--copilot=no',
          '--gemini=no',
          '--openai=no',
          '--opencode-zen=no',
          '--zai-coding-plan=no',
          '--kimi-for-coding=yes',
        ],
        expect.objectContaining({ignoreReturnCode: true}),
      )
    })

    it('captures both stdout and stderr', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockDeps = createMockDeps({
        logger: mockLogger,
        execAdapter: createMockExecAdapter({
          exec: vi
            .fn()
            .mockImplementation(
              async (
                _cmd,
                _args,
                options: {listeners?: {stdout?: (chunk: Buffer) => void; stderr?: (chunk: Buffer) => void}},
              ): Promise<number> => {
                if (options?.listeners?.stdout != null) {
                  options.listeners.stdout(Buffer.from('stdout output'))
                }
                if (options?.listeners?.stderr != null) {
                  options.listeners.stderr(Buffer.from('stderr output'))
                }
                return 1
              },
            ),
        }),
      })

      // #when
      const result = await installOmo('3.5.5', mockDeps)

      // #then - single bunx call captures both stdout and stderr
      expect(result.installed).toBe(false)
      const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls
      expect(errorCalls.length).toBeGreaterThan(0)
      const lastCall = errorCalls.at(-1)
      expect(lastCall?.[0]).toContain('exit code 1')
      expect(lastCall?.[1]).toBeDefined()
      expect(typeof lastCall?.[1]).toBe('object')
      expect((lastCall?.[1] as {output?: string}).output).toContain('stdout output')
    })
  })

  describe('verifyOmoInstallation', () => {
    it('returns true when config file exists', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: '-rw-r--r-- 1 user user 123 Jan 1 00:00 oh-my-opencode.json',
          stderr: '',
        }),
      })

      // #when
      const result = await verifyOmoInstallation(mockLogger, mockExec)

      // #then - only checks config file, not binary
      expect(result).toBe(true)
      expect(mockExec.getExecOutput).toHaveBeenCalledTimes(1)
      expect(mockExec.getExecOutput).toHaveBeenCalledWith(
        'ls',
        ['-la', '~/.config/opencode/oh-my-opencode.json'],
        expect.any(Object),
      )
    })

    it('returns false when config file does not exist', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 1,
          stdout: 'No such file or directory',
          stderr: '',
        }),
      })

      // #when
      const result = await verifyOmoInstallation(mockLogger, mockExec)

      // #then - detects missing config file
      expect(result).toBe(false)
      expect(mockExec.getExecOutput).toHaveBeenCalledTimes(1)
    })

    it('returns false on exception', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockRejectedValue(new Error('Failed')),
      })

      // #when
      const result = await verifyOmoInstallation(mockLogger, mockExec)

      // #then - handles errors gracefully
      expect(result).toBe(false)
      expect(mockLogger.debug).toHaveBeenCalledWith('Could not verify oMo installation')
      expect(mockExec.getExecOutput).toHaveBeenCalledTimes(1)
    })
  })
})
