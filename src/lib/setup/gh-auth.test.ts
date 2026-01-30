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
