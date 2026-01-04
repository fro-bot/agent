import type {ExecAdapter, Logger} from './types.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {configureGhAuth, configureGitIdentity, getBotLogin, getBotUserId} from './gh-auth.js'

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

describe('gh-auth', () => {
  let mockLogger: Logger
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    mockLogger = createMockLogger()
    originalEnv = {...process.env}
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  describe('configureGhAuth', () => {
    it('prefers app token over default token', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'fro-bot[bot]\n',
          stderr: '',
        }),
      })

      // #when
      const result = await configureGhAuth('app-token-123', 'default-token', mockLogger, mockExec)

      // #then
      expect(result.method).toBe('app-token')
      expect(result.authenticated).toBe(true)
      expect(process.env.GH_TOKEN).toBe('app-token-123')
    })

    it('falls back to github token when app token is null', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'user123\n',
          stderr: '',
        }),
      })

      // #when
      const result = await configureGhAuth(null, 'github-token-456', mockLogger, mockExec)

      // #then
      expect(result.method).toBe('github-token')
      expect(result.authenticated).toBe(true)
      expect(process.env.GH_TOKEN).toBe('github-token-456')
    })

    it('returns not authenticated when both tokens are empty', async () => {
      // #given
      const mockExec = createMockExecAdapter()

      // #when
      const result = await configureGhAuth(null, '', mockLogger, mockExec)

      // #then
      expect(result.method).toBe('none')
      expect(result.authenticated).toBe(false)
      expect(result.botLogin).toBe(null)
    })

    it('returns botLogin from gh api response', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'my-app[bot]\n',
          stderr: '',
        }),
      })

      // #when
      const result = await configureGhAuth('app-token', 'default', mockLogger, mockExec)

      // #then
      expect(result.botLogin).toBe('my-app[bot]')
    })

    it('handles gh api failure gracefully', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockRejectedValue(new Error('gh api failed')),
      })

      // #when
      const result = await configureGhAuth('app-token', 'default', mockLogger, mockExec)

      // #then
      expect(result.authenticated).toBe(true)
      expect(result.botLogin).toBe(null)
    })
  })

  describe('getBotLogin', () => {
    it('extracts login from gh api response', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'fro-bot[bot]\n',
          stderr: '',
        }),
      })

      // #when
      const login = await getBotLogin('token', mockLogger, mockExec)

      // #then
      expect(login).toBe('fro-bot[bot]')
    })

    it('returns null on empty response', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
        }),
      })

      // #when
      const login = await getBotLogin('token', mockLogger, mockExec)

      // #then
      expect(login).toBe(null)
    })

    it('returns null on error', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockRejectedValue(new Error('Network error')),
      })

      // #when
      const login = await getBotLogin('token', mockLogger, mockExec)

      // #then
      expect(login).toBe(null)
    })
  })

  describe('configureGitIdentity', () => {
    it('configures git identity with app slug', async () => {
      // #given
      const mockExec = createMockExecAdapter()
      const execFn = mockExec.exec as ReturnType<typeof vi.fn>

      // #when
      await configureGitIdentity('fro-bot', '123456', mockLogger, mockExec)

      // #then
      expect(execFn).toHaveBeenCalledWith('git', ['config', '--global', 'user.name', 'fro-bot[bot]'], undefined)
      expect(execFn).toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.email', '123456+fro-bot[bot]@users.noreply.github.com'],
        undefined,
      )
    })

    it('uses default identity when app slug is null', async () => {
      // #given
      const mockExec = createMockExecAdapter()
      const execFn = mockExec.exec as ReturnType<typeof vi.fn>

      // #when
      await configureGitIdentity(null, null, mockLogger, mockExec)

      // #then
      expect(execFn).toHaveBeenCalledWith('git', ['config', '--global', 'user.name', 'fro-bot[bot]'], undefined)
      expect(execFn).toHaveBeenCalledWith('git', ['config', '--global', 'user.email', 'agent@fro.bot'], undefined)
    })

    it('uses default email when userId is null but slug exists', async () => {
      // #given
      const mockExec = createMockExecAdapter()
      const execFn = mockExec.exec as ReturnType<typeof vi.fn>

      // #when
      await configureGitIdentity('my-app', null, mockLogger, mockExec)

      // #then
      expect(execFn).toHaveBeenCalledWith('git', ['config', '--global', 'user.name', 'my-app[bot]'], undefined)
      expect(execFn).toHaveBeenCalledWith('git', ['config', '--global', 'user.email', 'agent@fro.bot'], undefined)
    })
  })

  describe('getBotUserId', () => {
    it('extracts user ID from gh api response', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: '123456789\n',
          stderr: '',
        }),
      })

      // #when
      const userId = await getBotUserId('fro-bot', 'token', mockLogger, mockExec)

      // #then
      expect(userId).toBe('123456789')
    })

    it('returns null on empty response', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: '',
          stderr: '',
        }),
      })

      // #when
      const userId = await getBotUserId('fro-bot', 'token', mockLogger, mockExec)

      // #then
      expect(userId).toBe(null)
    })

    it('returns null on error', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: vi.fn().mockRejectedValue(new Error('User not found')),
      })

      // #when
      const userId = await getBotUserId('fro-bot', 'token', mockLogger, mockExec)

      // #then
      expect(userId).toBe(null)
    })

    it('calls correct gh api endpoint', async () => {
      // #given
      const mockGetExecOutput = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '12345\n',
        stderr: '',
      })
      const mockExec = createMockExecAdapter({
        getExecOutput: mockGetExecOutput,
      })

      // #when
      await getBotUserId('my-app', 'token123', mockLogger, mockExec)

      // #then
      expect(mockGetExecOutput).toHaveBeenCalledWith(
        'gh',
        ['api', '/users/my-app[bot]', '--jq', '.id'],
        expect.objectContaining({
          env: expect.objectContaining({GH_TOKEN: 'token123'}) as Record<string, string>,
        }),
      )
    })
  })
})
