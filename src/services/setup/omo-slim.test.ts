import type {ExecAdapter} from './types.js'
import {Buffer} from 'node:buffer'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {installOmoSlim, verifyOmoSlimInstallation} from './omo-slim.js'

// Mock exec adapter
function createMockExecAdapter(overrides: Partial<ExecAdapter> = {}): ExecAdapter {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: '', stderr: ''}),
    ...overrides,
  }
}

describe('omo-slim', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('installOmoSlim', () => {
    it('calls bunx with correct args for openai preset (default)', async () => {
      // #given - bunx oh-my-opencode-slim install succeeds
      const execMock = vi.fn().mockResolvedValue(0)
      const logger = createMockLogger()
      const execAdapter = createMockExecAdapter({exec: execMock})

      // #when
      const result = await installOmoSlim('1.1.1', {logger, execAdapter}, 'openai')

      // #then
      expect(result.installed).toBe(true)
      expect(result.version).toBe('1.1.1')
      expect(result.error).toBeNull()
      expect(execMock).toHaveBeenCalledTimes(1)
      expect(execMock).toHaveBeenCalledWith(
        'bunx',
        ['oh-my-opencode-slim@1.1.1', 'install', '--no-tui', '--reset', '--preset=openai'],
        expect.any(Object),
      )
    })

    it('calls bunx with correct args for opencode-go preset', async () => {
      // #given
      const execMock = vi.fn().mockResolvedValue(0)
      const execAdapter = createMockExecAdapter({exec: execMock})

      // #when
      const result = await installOmoSlim('1.1.1', {logger: createMockLogger(), execAdapter}, 'opencode-go')

      // #then
      expect(result.installed).toBe(true)
      expect(execMock).toHaveBeenCalledWith(
        'bunx',
        ['oh-my-opencode-slim@1.1.1', 'install', '--no-tui', '--reset', '--preset=opencode-go'],
        expect.any(Object),
      )
    })

    it('returns success and falls back to input version when no version in output', async () => {
      // #given
      const execMock = vi
        .fn()
        .mockImplementation(
          async (_cmd, _args, options: {listeners?: {stdout?: (chunk: Buffer) => void}}): Promise<number> => {
            if (options?.listeners?.stdout != null) {
              options.listeners.stdout(Buffer.from('Installation complete\n'))
            }
            return 0
          },
        )
      const execAdapter = createMockExecAdapter({exec: execMock})

      // #when
      const result = await installOmoSlim('1.1.1', {logger: createMockLogger(), execAdapter}, 'openai')

      // #then
      expect(result.installed).toBe(true)
      expect(result.version).toBe('1.1.1')
      expect(result.error).toBeNull()
    })

    it('returns failure when bunx returns non-zero exit code', async () => {
      // #given
      const execMock = vi.fn().mockResolvedValue(1)
      const execAdapter = createMockExecAdapter({exec: execMock})

      // #when
      const result = await installOmoSlim('1.1.1', {logger: createMockLogger(), execAdapter}, 'openai')

      // #then
      expect(result.installed).toBe(false)
      expect(result.version).toBeNull()
      expect(result.error).toContain('exit code 1')
      expect(execMock).toHaveBeenCalledTimes(1)
    })

    it('returns failure and logs error on exception', async () => {
      // #given
      const logger = createMockLogger()
      const execAdapter = createMockExecAdapter({
        exec: vi.fn().mockRejectedValue(new Error('Command not found')),
      })

      // #when
      const result = await installOmoSlim('1.1.1', {logger, execAdapter}, 'openai')

      // #then
      expect(result.installed).toBe(false)
      expect(result.error).toContain('Command not found')
      expect(logger.error).toHaveBeenCalled()
    })

    it('logs info on successful installation', async () => {
      // #given
      const logger = createMockLogger()
      const execAdapter = createMockExecAdapter()

      // #when
      await installOmoSlim('1.1.1', {logger, execAdapter}, 'openai')

      // #then
      expect(logger.info).toHaveBeenCalledWith('Installing Oh My OpenCode Slim plugin', expect.any(Object))
      expect(logger.info).toHaveBeenCalledWith('OMO Slim plugin installed', expect.any(Object))
    })

    it('does NOT include --skip-auth flag (unlike oMo)', async () => {
      // #given
      const execMock = vi.fn().mockResolvedValue(0)
      const execAdapter = createMockExecAdapter({exec: execMock})

      // #when
      await installOmoSlim('1.1.1', {logger: createMockLogger(), execAdapter}, 'openai')

      // #then
      const call = execMock.mock.calls[0]
      expect(call).toBeDefined()
      const args: string[] = call![1] as string[]
      expect(args).not.toContain('--skip-auth')
    })
  })

  describe('verifyOmoSlimInstallation', () => {
    it('returns true when config file exists', async () => {
      // #given
      const logger = createMockLogger()
      const execAdapter = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: 'oh-my-opencode-slim.json', stderr: ''}),
      })

      // #when
      const result = await verifyOmoSlimInstallation(logger, execAdapter)

      // #then
      expect(result).toBe(true)
    })

    it('returns false when config file does not exist', async () => {
      // #given
      const logger = createMockLogger()
      const execAdapter = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({exitCode: 1, stdout: 'No such file', stderr: ''}),
      })

      // #when
      const result = await verifyOmoSlimInstallation(logger, execAdapter)

      // #then
      expect(result).toBe(false)
    })

    it('returns false on exception', async () => {
      // #given
      const logger = createMockLogger()
      const execAdapter = createMockExecAdapter({
        getExecOutput: vi.fn().mockRejectedValue(new Error('ls failed')),
      })

      // #when
      const result = await verifyOmoSlimInstallation(logger, execAdapter)

      // #then
      expect(result).toBe(false)
    })
  })
})
