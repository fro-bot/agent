import type {ExecAdapter, Logger} from './types.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger, createMockOctokit} from '../test-helpers.js'
import {configureGhAuth, configureGitIdentity, getBotLogin, getBotUserId} from './gh-auth.js'

function createMockExecAdapter(overrides: Partial<ExecAdapter> = {}): ExecAdapter {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({exitCode: 0, stdout: '', stderr: ''}),
    ...overrides,
  }
}

function createGitConfigMock(name: string | null, email: string | null) {
  return vi.fn().mockImplementation(async (_cmd: string, args?: string[]) => {
    if (args?.[0] === 'config' && args?.[1] === 'user.name') {
      return name == null ? {exitCode: 1, stdout: '', stderr: ''} : {exitCode: 0, stdout: `${name}\n`, stderr: ''}
    }
    if (args?.[0] === 'config' && args?.[1] === 'user.email') {
      return email == null ? {exitCode: 1, stdout: '', stderr: ''} : {exitCode: 0, stdout: `${email}\n`, stderr: ''}
    }
    return {exitCode: 0, stdout: '', stderr: ''}
  })
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
      const mockOctokit = createMockOctokit()

      // #when
      const result = await configureGhAuth(mockOctokit, 'app-token-123', 'default-token', mockLogger)

      // #then
      expect(result.method).toBe('app-token')
      expect(result.authenticated).toBe(true)
      expect(process.env.GH_TOKEN).toBe('app-token-123')
    })

    it('falls back to github token when app token is null', async () => {
      // #given
      const mockOctokit = createMockOctokit()

      // #when
      const result = await configureGhAuth(mockOctokit, null, 'github-token-456', mockLogger)

      // #then
      expect(result.method).toBe('github-token')
      expect(result.authenticated).toBe(true)
      expect(process.env.GH_TOKEN).toBe('github-token-456')
    })

    it('returns not authenticated when both tokens are empty', async () => {
      // #given - no client needed when no tokens

      // #when
      const result = await configureGhAuth(null, null, '', mockLogger)

      // #then
      expect(result.method).toBe('none')
      expect(result.authenticated).toBe(false)
      expect(result.botLogin).toBe(null)
    })

    it('returns botLogin from Octokit API response', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      vi.mocked(mockOctokit.rest.users.getAuthenticated).mockResolvedValue({
        data: {login: 'my-app[bot]', type: 'Bot'},
      } as never)

      // #when
      const result = await configureGhAuth(mockOctokit, 'app-token', 'default', mockLogger)

      // #then
      expect(result.botLogin).toBe('my-app[bot]')
    })

    it('handles API failure gracefully', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      vi.mocked(mockOctokit.rest.users.getAuthenticated).mockRejectedValue(new Error('API failed'))

      // #when
      const result = await configureGhAuth(mockOctokit, 'app-token', 'default', mockLogger)

      // #then
      expect(result.authenticated).toBe(true)
      expect(result.botLogin).toBe('fro-bot[bot]')
    })
  })

  describe('getBotLogin', () => {
    it('extracts login from Octokit API response', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      vi.mocked(mockOctokit.rest.users.getAuthenticated).mockResolvedValue({
        data: {login: 'fro-bot[bot]', type: 'Bot'},
      } as never)

      // #when
      const login = await getBotLogin(mockOctokit, mockLogger)

      // #then
      expect(login).toBe('fro-bot[bot]')
    })

    it('returns null on error', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      vi.mocked(mockOctokit.rest.users.getAuthenticated).mockRejectedValue(new Error('Network error'))

      // #when
      const login = await getBotLogin(mockOctokit, mockLogger)

      // #then
      expect(login).toBe(null)
    })
  })

  describe('configureGitIdentity', () => {
    it('skips configuration when both user.name and user.email are already set', async () => {
      // #given
      const mockExec = createMockExecAdapter({
        getExecOutput: createGitConfigMock('Existing User', 'existing@example.com'),
      })
      const mockOctokit = createMockOctokit()
      const execFn = mockExec.exec as ReturnType<typeof vi.fn>

      // #when
      await configureGitIdentity(mockOctokit, 'fro-bot[bot]', mockLogger, mockExec)

      // #then
      expect(execFn).not.toHaveBeenCalled()
    })

    it('configures both name and email when neither is set', async () => {
      // #given
      const mockOctokit = createMockOctokit({
        getUserByUsername: vi.fn().mockResolvedValue({data: {id: 123456, login: 'fro-bot[bot]'}}),
      })
      const mockExec = createMockExecAdapter({
        getExecOutput: createGitConfigMock(null, null),
      })
      const execFn = mockExec.exec as ReturnType<typeof vi.fn>

      // #when
      await configureGitIdentity(mockOctokit, 'fro-bot[bot]', mockLogger, mockExec)

      // #then
      expect(execFn).toHaveBeenCalledWith('git', ['config', '--global', 'user.name', 'fro-bot[bot]'], undefined)
      expect(execFn).toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.email', '123456+fro-bot[bot]@users.noreply.github.com'],
        undefined,
      )
    })

    it('configures only email when user.name is already set', async () => {
      // #given
      const mockOctokit = createMockOctokit({
        getUserByUsername: vi.fn().mockResolvedValue({data: {id: 789, login: 'fro-bot[bot]'}}),
      })
      const mockExec = createMockExecAdapter({
        getExecOutput: createGitConfigMock('Existing User', null),
      })
      const execFn = mockExec.exec as ReturnType<typeof vi.fn>

      // #when
      await configureGitIdentity(mockOctokit, 'fro-bot[bot]', mockLogger, mockExec)

      // #then
      expect(execFn).not.toHaveBeenCalledWith('git', expect.arrayContaining(['user.name']), expect.anything())
      expect(execFn).toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.email', '789+fro-bot[bot]@users.noreply.github.com'],
        undefined,
      )
    })

    it('configures only name when user.email is already set', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const mockExec = createMockExecAdapter({
        getExecOutput: createGitConfigMock(null, 'existing@example.com'),
      })
      const execFn = mockExec.exec as ReturnType<typeof vi.fn>

      // #when
      await configureGitIdentity(mockOctokit, 'my-app[bot]', mockLogger, mockExec)

      // #then
      expect(execFn).toHaveBeenCalledWith('git', ['config', '--global', 'user.name', 'my-app[bot]'], undefined)
      expect(execFn).not.toHaveBeenCalledWith('git', expect.arrayContaining(['user.email']), expect.anything())
    })

    it('throws when botLogin is null and config is not already set', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const mockExec = createMockExecAdapter({
        getExecOutput: createGitConfigMock(null, null),
      })

      // #when / #then
      await expect(configureGitIdentity(mockOctokit, null, mockLogger, mockExec)).rejects.toThrow(
        'Cannot configure Git identity: no authenticated GitHub user',
      )
    })

    it('throws when user ID lookup fails', async () => {
      // #given
      const mockOctokit = createMockOctokit({
        getUserByUsername: vi.fn().mockRejectedValue(new Error('Not found')),
      })
      const mockExec = createMockExecAdapter({
        getExecOutput: createGitConfigMock(null, null),
      })

      // #when / #then
      await expect(configureGitIdentity(mockOctokit, 'unknown-bot[bot]', mockLogger, mockExec)).rejects.toThrow(
        "Cannot configure Git identity: failed to look up user ID for 'unknown-bot[bot]'",
      )
    })

    it('does not require botLogin when identity is already fully configured', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const mockExec = createMockExecAdapter({
        getExecOutput: createGitConfigMock('Some User', 'user@example.com'),
      })

      // #when / #then — should not throw despite null botLogin
      await expect(configureGitIdentity(mockOctokit, null, mockLogger, mockExec)).resolves.toBeUndefined()
    })

    it('looks up user by login to build noreply email', async () => {
      // #given
      const getUserByUsername = vi.fn().mockResolvedValue({data: {id: 42, login: 'mrbrown'}})
      const mockOctokit = createMockOctokit({getUserByUsername})
      const mockExec = createMockExecAdapter({
        getExecOutput: createGitConfigMock(null, null),
      })

      // #when
      await configureGitIdentity(mockOctokit, 'mrbrown', mockLogger, mockExec)

      // #then
      expect(getUserByUsername).toHaveBeenCalledWith({username: 'mrbrown'})
      const execFn = mockExec.exec as ReturnType<typeof vi.fn>
      expect(execFn).toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.email', '42+mrbrown@users.noreply.github.com'],
        undefined,
      )
    })
  })

  describe('getBotUserId', () => {
    it('extracts user ID from Octokit API response', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      vi.mocked(mockOctokit.rest.users.getByUsername).mockResolvedValue({
        data: {id: 123456789, login: 'fro-bot[bot]'},
      } as never)

      // #when
      const userId = await getBotUserId(mockOctokit, 'fro-bot', mockLogger)

      // #then
      expect(userId).toBe('123456789')
    })

    it('returns null on error', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      vi.mocked(mockOctokit.rest.users.getByUsername).mockRejectedValue(new Error('User not found'))

      // #when
      const userId = await getBotUserId(mockOctokit, 'fro-bot', mockLogger)

      // #then
      expect(userId).toBe(null)
    })

    it('calls correct Octokit API endpoint', async () => {
      // #given
      const mockOctokit = createMockOctokit()

      // #when
      await getBotUserId(mockOctokit, 'my-app', mockLogger)

      // #then
      expect(mockOctokit.rest.users.getByUsername).toHaveBeenCalledWith({username: 'my-app[bot]'})
    })
  })
})
