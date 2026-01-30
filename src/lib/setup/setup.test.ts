import * as fs from 'node:fs/promises'

import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as tc from '@actions/tool-cache'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {runSetup} from './setup.js'

// Mock @actions/core before importing setup
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setOutput: vi.fn(),
  exportVariable: vi.fn(),
  addPath: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  isDebug: vi.fn(() => false),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}))

// Mock @actions/tool-cache
vi.mock('@actions/tool-cache', () => ({
  find: vi.fn(),
  downloadTool: vi.fn(),
  extractTar: vi.fn(),
  extractZip: vi.fn(),
  cacheDir: vi.fn(),
}))

// Mock @actions/exec
vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}))

// Mock @actions/cache
vi.mock('@actions/cache', () => ({
  restoreCache: vi.fn(),
  saveCache: vi.fn(),
}))

// Mock @octokit/auth-app
vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}))

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}))

describe('setup', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetAllMocks()
    process.env = {...originalEnv}
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    process.env.GITHUB_REF_NAME = 'main'
    process.env.RUNNER_OS = 'Linux'
    process.env.RUNNER_ARCH = 'X64'
    process.env.XDG_DATA_HOME = '/tmp/test-data'

    // Default mock implementations
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'github-token': 'ghs_test_token',
        'auth-json': '{"anthropic": {"api_key": "sk-ant-test"}}',
        'opencode-version': 'latest',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(core.getBooleanInput).mockReturnValue(false)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('runSetup', () => {
    it('installs OpenCode when not cached', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('')
      vi.mocked(tc.downloadTool).mockResolvedValue('/tmp/opencode.zip')
      vi.mocked(tc.extractZip).mockResolvedValue('/tmp/opencode')
      vi.mocked(tc.extractTar).mockResolvedValue('/tmp/opencode')
      vi.mocked(tc.cacheDir).mockResolvedValue('/cached/opencode')
      vi.mocked(exec.getExecOutput).mockImplementation(async (cmd: string, args?: string[]) => {
        // Mock bot login
        if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === '/user') {
          return {exitCode: 0, stdout: 'fro-bot', stderr: ''}
        }
        // Mock file validation - return appropriate type based on actual platform
        if (cmd === 'file') {
          const isZipPlatform = process.platform === 'darwin' || process.platform === 'win32'
          const output = isZipPlatform ? 'Zip archive data' : 'gzip compressed data'
          return {exitCode: 0, stdout: output, stderr: ''}
        }
        return {exitCode: 0, stdout: '', stderr: ''}
      })
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // Mock fetch for getLatestVersion
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => Promise.resolve({tag_name: 'v1.0.300'}),
        }),
      )

      // #when
      const result = await runSetup()

      // #then
      expect(core.setFailed).not.toHaveBeenCalled()
      expect(result).not.toBeNull()
      expect(tc.downloadTool).toHaveBeenCalled()
      expect(core.addPath).toHaveBeenCalled()
    })

    it('uses cached OpenCode when available', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({
        exitCode: 0,
        stdout: '{"tag_name": "v1.0.300"}',
        stderr: '',
      })
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      await runSetup()

      // #then
      expect(tc.downloadTool).not.toHaveBeenCalled()
      expect(core.addPath).toHaveBeenCalledWith('/cached/opencode/1.0.300')
    })

    it('writes auth.json with correct permissions', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({
        exitCode: 0,
        stdout: '{"tag_name": "v1.0.300"}',
        stderr: '',
      })
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      await runSetup()

      // #then
      expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('auth.json'), expect.any(String), {mode: 0o600})
    })

    it('exports GH_TOKEN environment variable', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({
        exitCode: 0,
        stdout: '{"tag_name": "v1.0.300"}',
        stderr: '',
      })
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      await runSetup()

      // #then
      expect(core.exportVariable).toHaveBeenCalledWith('GH_TOKEN', 'ghs_test_token')
    })

    it('sets outputs for opencode-path and auth-json-path', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({
        exitCode: 0,
        stdout: '{"tag_name": "v1.0.300"}',
        stderr: '',
      })
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      await runSetup()

      // #then
      expect(core.setOutput).toHaveBeenCalledWith('opencode-path', expect.any(String))
      expect(core.setOutput).toHaveBeenCalledWith('auth-json-path', expect.stringContaining('auth.json'))
    })

    it('fails setup when oMo installation fails', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({
        exitCode: 0,
        stdout: '{"tag_name": "v1.0.300"}',
        stderr: '',
      })
      vi.mocked(exec.exec).mockRejectedValue(new Error('bunx failed'))
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      const result = await runSetup()

      // #then - should fail the action
      expect(result).toBeNull()
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('oMo'))
    })

    it('restores cache when available', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({
        exitCode: 0,
        stdout: '{"tag_name": "v1.0.300"}',
        stderr: '',
      })
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(cache.restoreCache).mockResolvedValue('cache-key-hit')
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      await runSetup()

      // #then
      expect(cache.restoreCache).toHaveBeenCalled()
      expect(core.setOutput).toHaveBeenCalledWith('cache-status', 'hit')
    })

    it('reports cache miss when no cache found', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({
        exitCode: 0,
        stdout: '{"tag_name": "v1.0.300"}',
        stderr: '',
      })
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(cache.restoreCache).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      await runSetup()

      // #then
      expect(core.setOutput).toHaveBeenCalledWith('cache-status', 'miss')
    })

    it('calls setFailed on unrecoverable error', async () => {
      // #given
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        if (name === 'auth-json') return 'invalid json {'
        return ''
      })

      // #when
      await runSetup()

      // #then
      expect(core.setFailed).toHaveBeenCalled()
    })

    it('configures git identity', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockImplementation(async (cmd: string, args?: string[]) => {
        // Mock version check
        if (cmd === 'gh' && args?.[0] === 'api' && args?.[1]?.includes('releases')) {
          return {exitCode: 0, stdout: '{"tag_name": "v1.0.300"}', stderr: ''}
        }
        // Mock bot login
        if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === '/user') {
          return {exitCode: 0, stdout: 'fro-bot', stderr: ''}
        }
        return {exitCode: 0, stdout: '', stderr: ''}
      })
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      await runSetup()

      // #then
      expect(exec.exec).toHaveBeenCalledWith('git', ['config', '--global', 'user.name', expect.any(String)], undefined)
      expect(exec.exec).toHaveBeenCalledWith('git', ['config', '--global', 'user.email', expect.any(String)], undefined)
    })
  })
})
