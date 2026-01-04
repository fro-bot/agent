import type {ExecAdapter, Logger} from './types.js'
import {Buffer} from 'node:buffer'
import {describe, expect, it, vi} from 'vitest'
import {installOmo, verifyOmoInstallation} from './omo.js'

// Mock logger
function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

// Mock exec adapter
function createMockExecAdapter(overrides: Partial<ExecAdapter> = {}): ExecAdapter {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: '', stderr: ''}),
    ...overrides,
  }
}

describe('omo', () => {
  describe('installOmo', () => {
    it('returns success on successful installation', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockExec = createMockExecAdapter({
        exec: vi
          .fn()
          .mockImplementation(async (_cmd, _args, options: {listeners?: {stdout?: (chunk: Buffer) => void}}) => {
            // Simulate successful output with version
            if (options?.listeners?.stdout != null) {
              options.listeners.stdout(Buffer.from('Installing oh-my-opencode@1.2.3\n'))
            }
            return 0
          }),
      })

      // #when
      const result = await installOmo(mockLogger, mockExec)

      // #then
      expect(result.installed).toBe(true)
      expect(result.version).toBe('1.2.3')
      expect(result.error).toBeNull()
    })

    it('returns success without version when version not in output', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockExec = createMockExecAdapter({
        exec: vi
          .fn()
          .mockImplementation(async (_cmd, _args, options: {listeners?: {stdout?: (chunk: Buffer) => void}}) => {
            if (options?.listeners?.stdout != null) {
              options.listeners.stdout(Buffer.from('Installation complete\n'))
            }
            return 0
          }),
      })

      // #when
      const result = await installOmo(mockLogger, mockExec)

      // #then
      expect(result.installed).toBe(true)
      expect(result.version).toBeNull()
      expect(result.error).toBeNull()
    })

    it('returns failure on non-zero exit code', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockExec = createMockExecAdapter({
        exec: vi.fn().mockResolvedValue(1),
      })

      // #when
      const result = await installOmo(mockLogger, mockExec)

      // #then
      expect(result.installed).toBe(false)
      expect(result.version).toBeNull()
      expect(result.error).toContain('exit code 1')
    })

    it('returns failure on exception', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockExec = createMockExecAdapter({
        exec: vi.fn().mockRejectedValue(new Error('Command not found')),
      })

      // #when
      const result = await installOmo(mockLogger, mockExec)

      // #then
      expect(result.installed).toBe(false)
      expect(result.error).toBe('Command not found')
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('logs info on successful installation', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockExec = createMockExecAdapter()

      // #when
      await installOmo(mockLogger, mockExec)

      // #then
      expect(mockLogger.info).toHaveBeenCalledWith('Installing Oh My OpenCode plugin', expect.any(Object))
      expect(mockLogger.info).toHaveBeenCalledWith('oMo plugin installed', expect.any(Object))
    })

    it('calls npx with headless options using defaults', async () => {
      // #given
      const mockLogger = createMockLogger()
      const execMock = vi.fn().mockResolvedValue(0)
      const mockExec = createMockExecAdapter({exec: execMock})

      // #when
      await installOmo(mockLogger, mockExec)

      // #then
      expect(execMock).toHaveBeenCalledWith(
        'npx',
        ['oh-my-opencode', 'install', '--no-tui', '--claude=max20', '--chatgpt=no', '--gemini=no'],
        expect.objectContaining({silent: true}),
      )
    })

    it('calls npx with custom options when provided', async () => {
      // #given
      const mockLogger = createMockLogger()
      const execMock = vi.fn().mockResolvedValue(0)
      const mockExec = createMockExecAdapter({exec: execMock})

      // #when
      await installOmo(mockLogger, mockExec, {claude: 'yes', chatgpt: 'yes', gemini: 'yes'})

      // #then
      expect(execMock).toHaveBeenCalledWith(
        'npx',
        ['oh-my-opencode', 'install', '--no-tui', '--claude=yes', '--chatgpt=yes', '--gemini=yes'],
        expect.objectContaining({silent: true}),
      )
    })

    it('captures both stdout and stderr', async () => {
      // #given
      const mockLogger = createMockLogger()
      const mockExec = createMockExecAdapter({
        exec: vi
          .fn()
          .mockImplementation(
            async (
              _cmd,
              _args,
              options: {listeners?: {stdout?: (chunk: Buffer) => void; stderr?: (chunk: Buffer) => void}},
            ) => {
              if (options?.listeners?.stdout != null) {
                options.listeners.stdout(Buffer.from('stdout output'))
              }
              if (options?.listeners?.stderr != null) {
                options.listeners.stderr(Buffer.from('stderr output'))
              }
              return 1 // Non-zero to trigger warning
            },
          ),
      })

      // #when
      const result = await installOmo(mockLogger, mockExec)

      // #then
      expect(result.installed).toBe(false)
      const warningCalls = (mockLogger.warning as ReturnType<typeof vi.fn>).mock.calls
      expect(warningCalls.length).toBeGreaterThan(0)
      const lastCall = warningCalls.at(-1)
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
