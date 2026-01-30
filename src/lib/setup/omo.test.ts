import type {OmoInstallDeps} from './omo.js'
import type {ExecAdapter, ToolCacheAdapter} from './types.js'
import {Buffer} from 'node:buffer'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../test-helpers.js'
import {installBun, isBunAvailable} from './bun.js'
import {installOmo, verifyOmoInstallation} from './omo.js'

// Mock the bun module
vi.mock('./bun.js', () => ({
  isBunAvailable: vi.fn(),
  installBun: vi.fn(),
}))

// Mock exec adapter
function createMockExecAdapter(overrides: Partial<ExecAdapter> = {}): ExecAdapter {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: '', stderr: ''}),
    ...overrides,
  }
}

// Mock tool cache adapter
function createMockToolCache(overrides: Partial<ToolCacheAdapter> = {}): ToolCacheAdapter {
  return {
    downloadTool: vi.fn().mockResolvedValue('/tmp/bun.zip'),
    extractTar: vi.fn().mockResolvedValue('/tmp/bun-extracted'),
    extractZip: vi.fn().mockResolvedValue('/tmp/bun-extracted'),
    cacheDir: vi.fn().mockResolvedValue('/cached/bun'),
    find: vi.fn().mockReturnValue(''),
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
    toolCache: createMockToolCache(),
    addPath: vi.fn(),
    ...overrides,
  }
}

describe('omo', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Default: Bun is available
    vi.mocked(isBunAvailable).mockResolvedValue(true)
    vi.mocked(installBun).mockResolvedValue({path: '/cached/bun', version: '1.2.5', cached: false})
  })

  describe('installOmo', () => {
    it('returns success on successful installation', async () => {
      // #given
      const mockDeps = createMockDeps({
        execAdapter: createMockExecAdapter({
          exec: vi
            .fn()
            .mockImplementation(
              async (_cmd, _args, options: {listeners?: {stdout?: (chunk: Buffer) => void}}): Promise<number> => {
                // Simulate successful output with version
                if (options?.listeners?.stdout != null) {
                  options.listeners.stdout(Buffer.from('Installing oh-my-opencode@1.2.3\n'))
                }
                return 0
              },
            ),
        }),
      })

      // #when
      const result = await installOmo(mockDeps)

      // #then
      expect(result.installed).toBe(true)
      expect(result.version).toBe('1.2.3')
      expect(result.error).toBeNull()
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
      const result = await installOmo(mockDeps)

      // #then
      expect(result.installed).toBe(true)
      expect(result.version).toBeNull()
      expect(result.error).toBeNull()
    })

    it('returns failure on non-zero exit code', async () => {
      // #given
      const mockDeps = createMockDeps({
        execAdapter: createMockExecAdapter({
          exec: vi.fn().mockResolvedValue(1),
        }),
      })

      // #when
      const result = await installOmo(mockDeps)

      // #then
      expect(result.installed).toBe(false)
      expect(result.version).toBeNull()
      expect(result.error).toContain('exit code 1')
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
      const result = await installOmo(mockDeps)

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
      await installOmo(mockDeps)

      // #then
      expect(mockLogger.info).toHaveBeenCalledWith('Installing Oh My OpenCode plugin', expect.any(Object))
      expect(mockLogger.info).toHaveBeenCalledWith('oMo plugin installed', expect.any(Object))
    })

    it('calls bunx with headless options using defaults', async () => {
      // #given
      const execMock = vi.fn().mockResolvedValue(0)
      const mockDeps = createMockDeps({
        execAdapter: createMockExecAdapter({exec: execMock}),
      })

      // #when
      await installOmo(mockDeps)

      // #then
      expect(execMock).toHaveBeenCalledWith(
        'bunx',
        [
          'oh-my-opencode',
          'install',
          '--no-tui',
          '--claude=no',
          '--copilot=no',
          '--gemini=no',
          '--openai=no',
          '--opencode-zen=no',
          '--zai-coding-plan=no',
        ],
        expect.objectContaining({silent: true}),
      )
    })

    it('calls bunx with custom options when provided', async () => {
      // #given
      const execMock = vi.fn().mockResolvedValue(0)
      const mockDeps = createMockDeps({
        execAdapter: createMockExecAdapter({exec: execMock}),
      })

      // #when
      await installOmo(mockDeps, {
        claude: 'yes',
        copilot: 'yes',
        gemini: 'yes',
        openai: 'yes',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
      })

      // #then
      expect(execMock).toHaveBeenCalledWith(
        'bunx',
        [
          'oh-my-opencode',
          'install',
          '--no-tui',
          '--claude=yes',
          '--copilot=yes',
          '--gemini=yes',
          '--openai=yes',
          '--opencode-zen=no',
          '--zai-coding-plan=no',
        ],
        expect.objectContaining({silent: true}),
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
      const result = await installOmo(mockDeps)

      // #then
      expect(result.installed).toBe(false)
      const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls
      expect(errorCalls.length).toBeGreaterThan(0)
      const lastCall = errorCalls.at(-1)
      expect(lastCall?.[0]).toContain('exit code 1')
      expect(lastCall?.[1]).toBeDefined()
      expect(typeof lastCall?.[1]).toBe('object')
      expect((lastCall?.[1] as {output?: string}).output).toContain('stdout output')
    })

    it('installs Bun when not available', async () => {
      // #given
      vi.mocked(isBunAvailable).mockResolvedValueOnce(false)
      const mockLogger = createMockLogger()
      const mockDeps = createMockDeps({logger: mockLogger})

      // #when
      await installOmo(mockDeps)

      // #then
      expect(isBunAvailable).toHaveBeenCalled()
      expect(installBun).toHaveBeenCalledWith(
        mockDeps.logger,
        mockDeps.toolCache,
        mockDeps.execAdapter,
        mockDeps.addPath,
      )
      expect(mockLogger.info).toHaveBeenCalledWith('Bun not found, installing...')
    })

    it('skips Bun installation when already available', async () => {
      // #given
      vi.mocked(isBunAvailable).mockResolvedValueOnce(true)
      const mockLogger = createMockLogger()
      const mockDeps = createMockDeps({logger: mockLogger})

      // #when
      await installOmo(mockDeps)

      // #then
      expect(isBunAvailable).toHaveBeenCalled()
      expect(installBun).not.toHaveBeenCalled()
    })

    it('returns failure when Bun installation fails', async () => {
      // #given
      vi.mocked(isBunAvailable).mockResolvedValueOnce(false)
      vi.mocked(installBun).mockRejectedValueOnce(new Error('Download failed'))
      const mockLogger = createMockLogger()
      const mockDeps = createMockDeps({logger: mockLogger})

      // #when
      const result = await installOmo(mockDeps)

      // #then
      expect(result.installed).toBe(false)
      expect(result.error).toContain('Bun installation failed')
      expect(result.error).toContain('Download failed')
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to install Bun runtime', expect.any(Object))
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

      // #then
      expect(result).toBe(true)
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

      // #then
      expect(result).toBe(false)
    })

    it('returns false on exception', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockRejectedValue(new Error('Failed')),
      })

      // #when
      const result = await verifyOmoInstallation(mockLogger, mockExec)

      // #then
      expect(result).toBe(false)
      expect(mockLogger.debug).toHaveBeenCalledWith('Could not verify oMo installation')
    })
  })
})
