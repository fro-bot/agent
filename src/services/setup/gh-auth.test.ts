import type {ExecAdapter, Logger} from './types.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {delimiter, join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {createMockOctokit} from '../github/test-helpers.js'
import {createExecAdapter} from './adapters.js'
import {configureGhAuth, configureGitIdentity, getBotLogin, getBotUserId} from './gh-auth.js'
import {removeGhConfigDir} from './gh-config-dir.js'

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    mkdtemp: vi.fn(actual.mkdtemp),
    chmod: vi.fn(actual.chmod),
  }
})

vi.mock('./gh-config-dir.js', async () => {
  const actual = await vi.importActual<typeof import('./gh-config-dir.js')>('./gh-config-dir.js')
  return {...actual, removeGhConfigDir: vi.fn(actual.removeGhConfigDir)}
})

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
      const mockExec = createMockExecAdapter()

      // #when
      const result = await configureGhAuth(mockOctokit, 'app-token-123', 'default-token', mockLogger, mockExec)

      // #then
      expect(result.method).toBe('app-token')
      expect(result.authenticated).toBe(true)
      expect(process.env.GH_TOKEN).toBe('app-token-123')
    })

    it('falls back to github token when app token is null', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const mockExec = createMockExecAdapter()

      // #when
      const result = await configureGhAuth(mockOctokit, null, 'github-token-456', mockLogger, mockExec)

      // #then
      expect(result.method).toBe('github-token')
      expect(result.authenticated).toBe(true)
      expect(process.env.GH_TOKEN).toBe('github-token-456')
    })

    it('returns not authenticated when both tokens are empty', async () => {
      // #given - no client needed when no tokens
      const mockExec = createMockExecAdapter()

      // #when
      const result = await configureGhAuth(null, null, '', mockLogger, mockExec)

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
      const mockExec = createMockExecAdapter()

      // #when
      const result = await configureGhAuth(mockOctokit, 'app-token', 'default', mockLogger, mockExec)

      // #then
      expect(result.botLogin).toBe('my-app[bot]')
    })

    it('handles API failure gracefully', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      vi.mocked(mockOctokit.rest.users.getAuthenticated).mockRejectedValue(new Error('API failed'))
      const mockExec = createMockExecAdapter()

      // #when
      const result = await configureGhAuth(mockOctokit, 'app-token', 'default', mockLogger, mockExec)

      // #then
      expect(result.authenticated).toBe(true)
      expect(result.botLogin).toBe('fro-bot[bot]')
    })

    it('creates a GH_CONFIG_DIR and sets process.env.GH_CONFIG_DIR to it', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const mockExec = createMockExecAdapter()

      // #when
      await configureGhAuth(mockOctokit, 'app-token-123', 'default-token', mockLogger, mockExec)

      // #then
      expect(process.env.GH_CONFIG_DIR).toBeTruthy()
      const stat = await fs.stat(process.env.GH_CONFIG_DIR as string)
      expect(stat.isDirectory()).toBe(true)
      await fs.rm(process.env.GH_CONFIG_DIR as string, {recursive: true, force: true})
    })

    it('invokes gh auth login with the token via stdin input, never in argv', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const getExecOutput = vi.fn().mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      const mockExec = createMockExecAdapter({getExecOutput})
      const token = 'super-secret-token-xyz'

      // #when
      await configureGhAuth(mockOctokit, token, 'default', mockLogger, mockExec)

      // #then
      expect(getExecOutput).toHaveBeenCalledWith(
        'gh',
        ['auth', 'login', '--with-token'],
        expect.objectContaining({input: Buffer.from(token, 'utf8')}),
      )
      const call = getExecOutput.mock.calls[0] as unknown[]
      const args = call[1] as string[]
      expect(args.some(arg => arg.includes(token))).toBe(false)
      if (process.env.GH_CONFIG_DIR != null) {
        await fs.rm(process.env.GH_CONFIG_DIR, {recursive: true, force: true})
      }
    })

    it('strips GH_TOKEN and GITHUB_TOKEN from the gh auth login exec env, keeping GH_CONFIG_DIR', async () => {
      // #given
      process.env.GH_TOKEN = 'sentinel-gh-token'
      process.env.GITHUB_TOKEN = 'sentinel-github-token'
      const mockOctokit = createMockOctokit()
      const getExecOutput = vi.fn().mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      const mockExec = createMockExecAdapter({getExecOutput})

      // #when
      await configureGhAuth(mockOctokit, 'app-token-123', 'default-token', mockLogger, mockExec)

      // #then
      const call = getExecOutput.mock.calls[0] as unknown[]
      const options = call[2] as {env?: Record<string, string>}
      expect(options.env?.GH_TOKEN).toBeUndefined()
      expect(options.env?.GITHUB_TOKEN).toBeUndefined()
      expect(options.env?.GH_CONFIG_DIR).toBeTruthy()
      // harness process.env.GH_TOKEN must remain intact (line 28 behavior unchanged)
      expect(process.env.GH_TOKEN).toBe('app-token-123')
      if (process.env.GH_CONFIG_DIR != null) {
        await fs.rm(process.env.GH_CONFIG_DIR, {recursive: true, force: true})
      }
    })

    it('still sets process.env.GH_TOKEN unchanged', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const mockExec = createMockExecAdapter()

      // #when
      const result = await configureGhAuth(mockOctokit, null, 'unchanged-token', mockLogger, mockExec)

      // #then
      expect(process.env.GH_TOKEN).toBe('unchanged-token')
      expect(result.authenticated).toBe(true)
      if (process.env.GH_CONFIG_DIR != null) {
        await fs.rm(process.env.GH_CONFIG_DIR, {recursive: true, force: true})
      }
    })

    it('degrades gracefully and still resolves when the off-env auth block throws', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const mockExec = createMockExecAdapter()
      vi.mocked(fs.mkdtemp).mockRejectedValueOnce(new Error('EACCES: permission denied'))

      // #when
      const result = await configureGhAuth(mockOctokit, 'app-token', 'default', mockLogger, mockExec)

      // #then
      expect(result).toEqual(expect.objectContaining({authenticated: true}))
      expect(process.env.GH_TOKEN).toBe('app-token')
      expect(mockLogger.warning).toHaveBeenCalledWith(
        'Failed to configure off-environment gh auth; child gh CLI will be unauthenticated',
        expect.anything(),
      )
    })

    it('chmods hosts.yml to 0600 when gh auth login succeeds', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const getExecOutput = vi.fn().mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      const mockExec = createMockExecAdapter({getExecOutput})
      const chmodMock = vi.mocked(fs.chmod)

      // #when
      await configureGhAuth(mockOctokit, 'app-token', 'default', mockLogger, mockExec)

      // #then
      const ghConfigDir = process.env.GH_CONFIG_DIR as string
      expect(chmodMock).toHaveBeenCalledWith(join(ghConfigDir, 'hosts.yml'), 0o600)
      await fs.rm(ghConfigDir, {recursive: true, force: true})
    })

    it('logs a warning and does not throw when gh auth login fails', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const getExecOutput = vi.fn().mockResolvedValue({exitCode: 1, stdout: '', stderr: 'auth failed'})
      const mockExec = createMockExecAdapter({getExecOutput})

      // #when
      const result = await configureGhAuth(mockOctokit, 'app-token', 'default', mockLogger, mockExec)

      // #then
      expect(result.authenticated).toBe(true)
      expect(mockLogger.warning).toHaveBeenCalledWith(
        expect.stringContaining('gh auth login failed'),
        expect.anything(),
      )
      // The global env must NOT be repointed at the temp config dir on a failed login —
      // otherwise gh in the child would be redirected to an empty config dir instead of
      // falling back to any pre-existing default. Assert it is unchanged from before the
      // call rather than unset, so an ambient GH_CONFIG_DIR in the environment does not
      // make this test brittle.
      expect(process.env.GH_CONFIG_DIR).toBe(originalEnv.GH_CONFIG_DIR)
    })

    // Regression for #2164: `@actions/exec` writes `input` with `stdin.end(input)` and attaches no stdin 'error'
    // listener, so a `gh` that exits without reading stdin turned EPIPE into an unhandled 'error' event that killed
    // the whole Action. A real token is tiny and only hits EPIPE intermittently on Linux (never on macOS); a token
    // larger than the pipe buffer (64 KiB) leaves unread data in the pipe when the child exits on every platform, so
    // the write deterministically fails with EPIPE.
    it.skipIf(process.platform === 'win32')(
      'takes the gh auth login failed warning path, without crashing, when gh exits without reading stdin',
      async () => {
        // #given a real `gh` that exits non-zero immediately, never reading stdin, and a token far past the pipe buffer
        const stubDir = await fs.mkdtemp(join(tmpdir(), 'gh-stub-'))
        const stubPath = join(stubDir, 'gh')
        await fs.writeFile(stubPath, '#!/bin/sh\nexit 1\n')
        await fs.chmod(stubPath, 0o755)
        process.env.PATH = `${stubDir}${delimiter}${process.env.PATH ?? ''}`
        delete process.env.GH_CONFIG_DIR
        const mockOctokit = createMockOctokit()
        const token = 'x'.repeat(1024 * 1024)

        try {
          // #when
          const result = await configureGhAuth(mockOctokit, token, 'default', mockLogger, createExecAdapter())

          // #then the failure is a warning, not an unhandled 'error' event
          expect(result.authenticated).toBe(true)
          expect(mockLogger.warning).toHaveBeenCalledWith(
            expect.stringContaining('gh auth login failed'),
            expect.objectContaining({exitCode: 1}),
          )
          expect(process.env.GH_CONFIG_DIR).toBeUndefined()
        } finally {
          await fs.rm(stubDir, {recursive: true, force: true})
        }
      },
    )

    it('runs gh auth login through execWithTimeout, with the token on stdin and never in argv', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const execWithTimeout = vi.fn().mockResolvedValue(0)
      const getExecOutput = vi.fn()
      const mockExec = createMockExecAdapter({execWithTimeout, getExecOutput})
      const token = 'super-secret-token-seam'

      // #when
      await configureGhAuth(mockOctokit, token, 'default', mockLogger, mockExec)

      // #then
      expect(getExecOutput).not.toHaveBeenCalled()
      expect(execWithTimeout).toHaveBeenCalledWith(
        'gh',
        ['auth', 'login', '--with-token'],
        expect.any(Number),
        expect.objectContaining({input: Buffer.from(token, 'utf8')}),
      )
      const call = execWithTimeout.mock.calls[0] as unknown[]
      expect((call[1] as string[]).some(arg => arg.includes(token))).toBe(false)
      expect(JSON.stringify(vi.mocked(mockLogger.info).mock.calls)).not.toContain(token)
      if (process.env.GH_CONFIG_DIR != null) {
        await fs.rm(process.env.GH_CONFIG_DIR, {recursive: true, force: true})
      }
    })

    it('warns and leaves GH_CONFIG_DIR unchanged when gh auth login times out', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const execWithTimeout = vi.fn().mockResolvedValue('timed-out')
      const mockExec = createMockExecAdapter({execWithTimeout})
      delete process.env.GH_CONFIG_DIR

      // #when
      const result = await configureGhAuth(mockOctokit, 'app-token', 'default', mockLogger, mockExec)

      // #then
      expect(result.authenticated).toBe(true)
      expect(mockLogger.warning).toHaveBeenCalledWith(
        expect.stringContaining('gh auth login failed'),
        expect.objectContaining({exitCode: 'timed-out'}),
      )
      expect(process.env.GH_CONFIG_DIR).toBeUndefined()
    })

    it('sets process.env.GH_CONFIG_DIR to the temp dir only when gh auth login succeeds', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const getExecOutput = vi.fn().mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      const mockExec = createMockExecAdapter({getExecOutput})

      // #when
      await configureGhAuth(mockOctokit, 'app-token', 'default', mockLogger, mockExec)

      // #then
      expect(process.env.GH_CONFIG_DIR).toBeTruthy()
      const stat = await fs.stat(process.env.GH_CONFIG_DIR as string)
      expect(stat.isDirectory()).toBe(true)
      await fs.rm(process.env.GH_CONFIG_DIR as string, {recursive: true, force: true})
    })

    it('withholds the child credential when provisionChildCredential is false: no process.env.GH_TOKEN, no hosts.yml, no GH_CONFIG_DIR export', async () => {
      // #given
      const mockOctokit = createMockOctokit()
      const getExecOutput = vi.fn().mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      const mockExec = createMockExecAdapter({getExecOutput})
      const token = 'super-secret-token-withheld'
      delete process.env.GH_TOKEN
      delete process.env.GH_CONFIG_DIR

      // #when
      const result = await configureGhAuth(mockOctokit, token, 'default', mockLogger, mockExec, false)

      // #then
      expect(result.authenticated).toBe(true)
      // Name-independent scan: no value visible via configureGhAuth's own env-value surface
      // carries the token string.
      expect(Object.values(process.env)).not.toContain(token)
      expect(process.env.GH_TOKEN).toBeUndefined()
      expect(process.env.GH_CONFIG_DIR).toBeUndefined()
      // gh auth login (which writes hosts.yml) must never be invoked.
      expect(getExecOutput).not.toHaveBeenCalled()
    })

    it('clears an ambient process.env.GH_CONFIG_DIR from a prior workflow step when withholding the child credential', async () => {
      // #given a pre-existing GH_CONFIG_DIR left over from an earlier authed step (e.g.
      // actions/checkout with a token, or a prior gh auth login) — this must not leak
      // through to the model's child even though it wasn't set by configureGhAuth itself.
      const mockOctokit = createMockOctokit()
      const mockExec = createMockExecAdapter()
      process.env.GH_CONFIG_DIR = '/tmp/ambient-gh-config-from-prior-step'

      // #when withholding the child credential
      const result = await configureGhAuth(mockOctokit, 'app-token', 'default', mockLogger, mockExec, false)

      // #then the ambient config dir is gone
      expect(result.authenticated).toBe(true)
      expect(process.env.GH_CONFIG_DIR).toBeUndefined()
    })

    it('still resolves botLogin via the passed-in Octokit client when withholding the child credential', async () => {
      // #given — the action's own in-process Octokit client is unaffected by withholding.
      const mockOctokit = createMockOctokit()
      vi.mocked(mockOctokit.rest.users.getAuthenticated).mockResolvedValue({
        data: {login: 'fro-bot[bot]', type: 'Bot'},
      } as never)
      const mockExec = createMockExecAdapter()

      // #when
      const result = await configureGhAuth(mockOctokit, 'app-token', 'default', mockLogger, mockExec, false)

      // #then
      expect(result.botLogin).toBe('fro-bot[bot]')
      expect(result.authenticated).toBe(true)
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

// Stands in for `gh auth login --with-token`: writes hosts.yml where GH_CONFIG_DIR points, then reports `exit`.
function loginThatWritesHostsYml(exit: number | 'timed-out') {
  return vi.fn(
    async (_cmd: string, _args: string[] | undefined, _timeout: number, options?: {env?: Record<string, string>}) => {
      const dir = options?.env?.GH_CONFIG_DIR as string
      await fs.writeFile(join(dir, 'hosts.yml'), 'github.com:\n  oauth_token: secret\n', {mode: 0o600})
      return exit
    },
  )
}

describe("gh-auth: the run's gh config directory (#2156)", () => {
  let originalEnv: NodeJS.ProcessEnv
  let runnerTemp: string
  let mockLogger: Logger

  beforeEach(async () => {
    originalEnv = {...process.env}
    mockLogger = createMockLogger()
    runnerTemp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'gh-auth-runner-')))
    process.env.RUNNER_TEMP = runnerTemp
    delete process.env.GH_CONFIG_DIR
  })

  afterEach(async () => {
    process.env = originalEnv
    vi.restoreAllMocks()
    await fs.rm(runnerTemp, {recursive: true, force: true})
  })

  async function configDirs(): Promise<string[]> {
    return (await fs.readdir(runnerTemp)).filter(name => name.startsWith('gh-config-'))
  }

  it('records the directory the moment it exists, before gh auth login runs', async () => {
    // #given a login that checks what had been recorded when it started
    const record = vi.fn()
    let recordedAtLogin: string | null | undefined
    let existedAtLogin = false
    const execWithTimeout = vi.fn(
      async (_cmd: string, _args: string[] | undefined, _t: number, options?: {env?: Record<string, string>}) => {
        recordedAtLogin = record.mock.calls[0]?.[0] as string | undefined
        existedAtLogin =
          recordedAtLogin !== undefined &&
          (await fs.lstat(recordedAtLogin).then(
            () => true,
            () => false,
          ))
        expect(options?.env?.GH_CONFIG_DIR).toBe(recordedAtLogin)
        return 0
      },
    )
    const mockExec = createMockExecAdapter({execWithTimeout})

    // #when
    await configureGhAuth(createMockOctokit(), 'app-token', 'default', mockLogger, mockExec, true, record)

    // #then a process killed during the login would already have left a record naming a directory that exists
    expect(recordedAtLogin).toMatch(/gh-config-/)
    expect(existedAtLogin).toBe(true)
    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith(process.env.GH_CONFIG_DIR)
  })

  it('removes the directory and clears the record when gh auth login exits non-zero after writing hosts.yml', async () => {
    // #given
    const record = vi.fn()
    const execWithTimeout = loginThatWritesHostsYml(1)
    const mockExec = createMockExecAdapter({execWithTimeout})

    // #when
    const result = await configureGhAuth(
      createMockOctokit(),
      'app-token',
      'default',
      mockLogger,
      mockExec,
      true,
      record,
    )

    // #then the token-bearing directory is gone, was never published, and no stale record is left
    expect(result.authenticated).toBe(true)
    expect(await configDirs()).toEqual([])
    expect(process.env.GH_CONFIG_DIR).toBeUndefined()
    expect(record.mock.calls.map(call => (call[0] === null ? null : 'dir'))).toEqual(['dir', null])
    expect(mockLogger.warning).toHaveBeenCalledWith(
      expect.stringContaining('gh auth login failed'),
      expect.objectContaining({exitCode: 1}),
    )
  })

  it('removes the directory and clears the record when gh auth login times out after writing hosts.yml', async () => {
    // #given
    const record = vi.fn()
    const mockExec = createMockExecAdapter({execWithTimeout: loginThatWritesHostsYml('timed-out')})

    // #when
    await configureGhAuth(createMockOctokit(), 'app-token', 'default', mockLogger, mockExec, true, record)

    // #then
    expect(await configDirs()).toEqual([])
    expect(process.env.GH_CONFIG_DIR).toBeUndefined()
    expect(record.mock.calls.map(call => (call[0] === null ? null : 'dir'))).toEqual(['dir', null])
  })

  it('removes the directory when running gh throws (gh missing from PATH)', async () => {
    // #given
    const record = vi.fn()
    const execWithTimeout = vi.fn().mockRejectedValue(Object.assign(new Error('spawn gh ENOENT'), {code: 'ENOENT'}))
    const mockExec = createMockExecAdapter({execWithTimeout})

    // #when
    const result = await configureGhAuth(
      createMockOctokit(),
      'app-token',
      'default',
      mockLogger,
      mockExec,
      true,
      record,
    )

    // #then
    expect(result.authenticated).toBe(true)
    expect(await configDirs()).toEqual([])
    expect(record.mock.calls.map(call => (call[0] === null ? null : 'dir'))).toEqual(['dir', null])
  })

  it('warns and keeps the record when the directory of a failed login cannot be removed', async () => {
    // #given a failed login whose cleanup fails
    const record = vi.fn()
    vi.mocked(removeGhConfigDir).mockResolvedValueOnce('failed')
    const mockExec = createMockExecAdapter({execWithTimeout: loginThatWritesHostsYml(1)})

    // #when
    const result = await configureGhAuth(
      createMockOctokit(),
      'app-token',
      'default',
      mockLogger,
      mockExec,
      true,
      record,
    )

    // #then setup carries on, and the record stays so the end-of-run cleanup and the post hook retry it
    expect(result.authenticated).toBe(true)
    expect(mockLogger.warning).toHaveBeenCalledWith(expect.stringContaining('could not be removed'), expect.anything())
    expect(record.mock.calls.map(call => (call[0] === null ? null : 'dir'))).toEqual(['dir'])
    expect(process.env.GH_CONFIG_DIR).toBeUndefined()
  })

  it('leaves a successful login unchanged: published, kept, recorded once', async () => {
    // #given
    const record = vi.fn()
    const mockExec = createMockExecAdapter({execWithTimeout: loginThatWritesHostsYml(0)})

    // #when
    await configureGhAuth(createMockOctokit(), 'app-token', 'default', mockLogger, mockExec, true, record)

    // #then
    const [dir] = await configDirs()
    expect(dir).toBeDefined()
    expect(process.env.GH_CONFIG_DIR).toBe(join(runnerTemp, dir as string))
    await expect(fs.lstat(join(runnerTemp, dir as string, 'hosts.yml'))).resolves.toBeDefined()
    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith(process.env.GH_CONFIG_DIR)
    expect(removeGhConfigDir).not.toHaveBeenCalled()
  })

  it('records nothing when the credential is withheld (no directory is created)', async () => {
    // #given
    const record = vi.fn()
    const execWithTimeout = vi.fn().mockResolvedValue(0)

    // #when
    await configureGhAuth(
      createMockOctokit(),
      'app-token',
      'default',
      mockLogger,
      createMockExecAdapter({execWithTimeout}),
      false,
      record,
    )

    // #then
    expect(record).not.toHaveBeenCalled()
    expect(await configDirs()).toEqual([])
  })
})
