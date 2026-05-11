import type {SetupInputs} from './types.js'

import * as fs from 'node:fs/promises'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as tc from '@actions/tool-cache'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {runSetup} from './setup.js'
import * as toolsCache from './tools-cache.js'

function createSetupInputs(overrides: Partial<SetupInputs> = {}): SetupInputs {
  return {
    opencodeVersion: '1.2.24',
    authJson: '{"anthropic": {"api_key": "sk-ant-test"}}',
    appId: null,
    privateKey: null,
    opencodeConfig: null,
    systematicConfig: null,
    enableOmo: false,
    omoVersion: '3.7.4',
    systematicVersion: '2.1.0',
    omoProviders: {
      claude: 'no',
      copilot: 'no',
      gemini: 'no',
      openai: 'no',
      opencodeZen: 'no',
      zaiCodingPlan: 'no',
      kimiForCoding: 'no',
    },
    ...overrides,
  }
}

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

vi.mock('@actions/github', () => ({
  getOctokit: vi.fn(),
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

// Mock tools-cache module
vi.mock('./tools-cache.js', () => ({
  restoreToolsCache: vi.fn(),
  saveToolsCache: vi.fn(),
}))

vi.mock('./adapters.js', () => ({
  createToolCacheAdapter: vi.fn(() => ({
    find: vi.mocked(tc.find),
    downloadTool: vi.mocked(tc.downloadTool),
    extractTar: vi.mocked(tc.extractTar),
    extractZip: vi.mocked(tc.extractZip),
    cacheDir: vi.mocked(tc.cacheDir),
  })),
  createExecAdapter: vi.fn(() => ({
    exec: vi.mocked(exec.exec),
    getExecOutput: vi.mocked(exec.getExecOutput),
  })),
}))

// Mock bun module
vi.mock('./bun.js', () => ({
  installBun: vi.fn().mockResolvedValue({path: '/cached/bun', version: '1.3.5', cached: true}),
  DEFAULT_BUN_VERSION: '1.3.5',
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
    process.env.RUNNER_TOOL_CACHE = '/opt/hostedtoolcache'

    // Default mock implementations
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'github-token': 'ghs_test_token',
        'auth-json': '{"anthropic": {"api_key": "sk-ant-test"}}',
        'opencode-version': '1.2.24',
      }
      return inputs[name] ?? ''
    })
    vi.mocked(core.getBooleanInput).mockReturnValue(false)

    vi.mocked(github.getOctokit).mockReturnValue({
      rest: {
        users: {
          getAuthenticated: vi.fn().mockResolvedValue({data: {login: 'fro-bot[bot]', type: 'Bot'}}),
          getByUsername: vi.fn().mockResolvedValue({data: {id: 123456, login: 'fro-bot[bot]'}}),
        },
      },
    } as never)

    // Default tools cache: miss
    vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({hit: false, restoredKey: null})
    vi.mocked(toolsCache.saveToolsCache).mockResolvedValue(true)

    // Default exec.getExecOutput mock
    vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
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
        if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === '/user') {
          return {exitCode: 0, stdout: 'fro-bot', stderr: ''}
        }
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

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => Promise.resolve({tag_name: 'v1.0.300'}),
        }),
      )

      // #when
      const result = await runSetup(createSetupInputs(), 'ghs_test_token')

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
      await runSetup(createSetupInputs(), 'ghs_test_token')

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
      await runSetup(createSetupInputs(), 'ghs_test_token')

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
      await runSetup(createSetupInputs(), 'ghs_test_token')

      // #then
      expect(core.exportVariable).toHaveBeenCalledWith('GH_TOKEN', 'ghs_test_token')
    })

    it('exports OPENCODE_CONFIG_CONTENT environment variable', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      await runSetup(createSetupInputs(), 'ghs_test_token')

      // #then
      expect(core.exportVariable).toHaveBeenCalledWith('OPENCODE_CONFIG_CONTENT', expect.any(String))
    })

    it('fails when opencode-config parses to JSON null', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      const result = await runSetup(createSetupInputs({opencodeConfig: 'null'}), 'ghs_test_token')

      // #then
      expect(result).toBe(null)
      expect(core.setFailed).toHaveBeenCalledWith('opencode-config must be a JSON object')
    })

    it('fails with explicit message when opencode-config is invalid JSON', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      const result = await runSetup(createSetupInputs({opencodeConfig: '{invalid-json}'}), 'ghs_test_token')

      // #then
      expect(result).toBe(null)
      expect(core.setFailed).toHaveBeenCalledWith('opencode-config must be valid JSON')
    })

    it('fails when opencode-config is an array', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      const result = await runSetup(createSetupInputs({opencodeConfig: '["model", "claude-opus-4"]'}), 'ghs_test_token')

      // #then
      expect(result).toBe(null)
      expect(core.setFailed).toHaveBeenCalledWith('opencode-config must be a JSON object')
    })

    it('fails when opencode-config is a number', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      const result = await runSetup(createSetupInputs({opencodeConfig: '42'}), 'ghs_test_token')

      // #then
      expect(result).toBe(null)
      expect(core.setFailed).toHaveBeenCalledWith('opencode-config must be a JSON object')
    })

    it('fails when opencode-config is a string', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      const result = await runSetup(createSetupInputs({opencodeConfig: '"just-a-string"'}), 'ghs_test_token')

      // #then
      expect(result).toBe(null)
      expect(core.setFailed).toHaveBeenCalledWith('opencode-config must be a JSON object')
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
      await runSetup(createSetupInputs(), 'ghs_test_token')

      // #then
      expect(core.setOutput).toHaveBeenCalledWith('opencode-path', expect.any(String))
      expect(core.setOutput).toHaveBeenCalledWith('auth-json-path', expect.stringContaining('auth.json'))
    })

    it('calls setFailed on unrecoverable error', async () => {
      // #given
      // #when
      await runSetup(createSetupInputs({authJson: 'invalid json {'}), 'ghs_test_token')

      // #then
      expect(core.setFailed).toHaveBeenCalled()
    })

    it('configures git identity from GitHub token user', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      await runSetup(createSetupInputs(), 'ghs_test_token')

      // #then
      expect(exec.exec).toHaveBeenCalledWith('git', ['config', '--global', 'user.name', 'fro-bot[bot]'], undefined)
      expect(exec.exec).toHaveBeenCalledWith(
        'git',
        ['config', '--global', 'user.email', '123456+fro-bot[bot]@users.noreply.github.com'],
        undefined,
      )
    })

    it('skips git identity when already configured', async () => {
      // #given
      vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
      vi.mocked(exec.getExecOutput).mockImplementation(async (cmd: string, args?: string[]) => {
        if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.name') {
          return {exitCode: 0, stdout: 'Existing User\n', stderr: ''}
        }
        if (cmd === 'git' && args?.[0] === 'config' && args?.[1] === 'user.email') {
          return {exitCode: 0, stdout: 'existing@example.com\n', stderr: ''}
        }
        return {exitCode: 0, stdout: '', stderr: ''}
      })
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      await runSetup(createSetupInputs(), 'ghs_test_token')

      // #then
      expect(exec.exec).not.toHaveBeenCalledWith('git', expect.arrayContaining(['user.name']), expect.anything())
      expect(exec.exec).not.toHaveBeenCalledWith('git', expect.arrayContaining(['user.email']), expect.anything())
    })

    describe('disabled mode (enableOmo: false, default)', () => {
      beforeEach(() => {
        vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
        vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
        vi.mocked(exec.exec).mockResolvedValue(0)
        vi.mocked(fs.writeFile).mockResolvedValue()
        vi.mocked(fs.mkdir).mockResolvedValue(undefined)
        vi.mocked(fs.access).mockRejectedValue(new Error('not found'))
      })

      it('returns omoStatus skipped and writes config with default_agent build', async () => {
        // #given - default disabled mode

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        expect(result?.omoStatus).toBe('skipped')
        expect(core.exportVariable).toHaveBeenCalledWith('OPENCODE_CONFIG_CONTENT', expect.any(String))

        // Verify the config JSON has default_agent: build
        const configExportCall = vi
          .mocked(core.exportVariable)
          .mock.calls.find(([name]) => name === 'OPENCODE_CONFIG_CONTENT')
        expect(configExportCall).toBeDefined()
        const configJson = configExportCall![1] as string
        const config = JSON.parse(configJson) as Record<string, unknown>
        expect(config.default_agent).toBe('build')
      })

      it('creates the OpenCode config directory before writing disabled-mode config', async () => {
        // #given - disabled mode does not run oMo, so setup owns config dir creation

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        expect(fs.mkdir).toHaveBeenCalledWith(expect.stringMatching(/\.config\/opencode$/), {recursive: true})
        expect(fs.writeFile).toHaveBeenCalledWith(
          expect.stringMatching(/\.config\/opencode\/opencode\.json$/),
          expect.any(String),
        )
      })

      it('does not call Bun installer, bunx, installOmo, or writeOmoConfig', async () => {
        // #given
        const bunModule = await import('./bun.js')

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        expect(bunModule.installBun).not.toHaveBeenCalled()

        // Should not call bunx (oMo installer)
        const execCalls = vi.mocked(exec.exec).mock.calls
        const bunxCalls = execCalls.filter(([cmd]) => cmd === 'bunx')
        expect(bunxCalls).toHaveLength(0)

        // Should not write oh-my-openagent.json
        const writeFileCalls = vi.mocked(fs.writeFile).mock.calls
        const omoConfigCall = writeFileCalls.find(
          ([filePath]) => typeof filePath === 'string' && filePath.includes('oh-my-openagent.json'),
        )
        expect(omoConfigCall).toBeUndefined()
      })

      it('does not export oMo telemetry env vars in disabled mode', async () => {
        // #given

        // #when
        await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(core.exportVariable).not.toHaveBeenCalledWith('OMO_SEND_ANONYMOUS_TELEMETRY', '0')
        expect(core.exportVariable).not.toHaveBeenCalledWith('OMO_DISABLE_POSTHOG', '1')
      })

      it('writes Systematic config when provided in disabled mode', async () => {
        // #given
        const systematicConfig = JSON.stringify({agents: {default: 'build'}, mode: 'strict'})

        // #when
        const result = await runSetup(createSetupInputs({systematicConfig}), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        const writeFileCalls = vi.mocked(fs.writeFile).mock.calls
        const systematicConfigCall = writeFileCalls.find(
          ([filePath]) => typeof filePath === 'string' && filePath.includes('systematic.json'),
        )
        expect(systematicConfigCall).toBeDefined()
        const written = JSON.parse(systematicConfigCall![1] as string) as Record<string, unknown>
        expect(written).toMatchObject({agents: {default: 'build'}, mode: 'strict'})
      })

      it('writes fresh config without merging existing opencode.json', async () => {
        // #given - simulate existing opencode.json with stale oMo data
        vi.mocked(fs.readFile).mockResolvedValue(
          JSON.stringify({default_agent: 'sisyphus', plugin: ['oh-my-openagent@3.7.4']}),
        )

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then - fresh config has build, no oMo plugin
        expect(result).not.toBeNull()
        const configExportCall = vi
          .mocked(core.exportVariable)
          .mock.calls.find(([name]) => name === 'OPENCODE_CONFIG_CONTENT')
        expect(configExportCall).toBeDefined()
        const config = JSON.parse(configExportCall![1] as string) as Record<string, unknown>
        expect(config.default_agent).toBe('build')

        // Should NOT contain oh-my-openagent
        const configPlugins = config.plugin as unknown[]
        expect(configPlugins?.some(p => typeof p === 'string' && p.includes('oh-my-openagent'))).toBe(false)
      })

      it('warns when user config has oh-my-openagent plugin', async () => {
        // #given
        const opencodeConfig = JSON.stringify({
          plugin: ['tool@1.0.0', 'oh-my-openagent@3.7.4'],
        })

        // #when
        const result = await runSetup(createSetupInputs({opencodeConfig}), 'ghs_test_token')

        // #then - warning emitted
        expect(result).not.toBeNull()
        expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('plugin'))
      })
    })

    describe('enabled mode (enableOmo: true)', () => {
      beforeEach(() => {
        vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
        vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
        vi.mocked(exec.exec).mockResolvedValue(0)
        vi.mocked(fs.writeFile).mockResolvedValue()
        vi.mocked(fs.mkdir).mockResolvedValue(undefined)
        vi.mocked(fs.access).mockRejectedValue(new Error('not found'))
        vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('not found'), {code: 'ENOENT'}))
      })

      it('installs Bun and oMo, returns omoStatus installed', async () => {
        // #given - bunx succeeds
        const bunModule = await import('./bun.js')

        // #when
        const result = await runSetup(createSetupInputs({enableOmo: true}), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        expect(bunModule.installBun).toHaveBeenCalled()
        expect(core.exportVariable).toHaveBeenCalledWith('OMO_SEND_ANONYMOUS_TELEMETRY', '0')
        expect(core.exportVariable).toHaveBeenCalledWith('OMO_DISABLE_POSTHOG', '1')
        expect(result?.omoStatus).toBe('installed')
      })

      it('returns omoStatus failed when oMo installer fails', async () => {
        // #given - bunx oMo fails
        vi.mocked(exec.exec).mockImplementation(async (cmd: string) => {
          if (cmd === 'bunx') {
            throw new Error('bunx failed')
          }
          return 0
        })

        // #when
        const result = await runSetup(createSetupInputs({enableOmo: true}), 'ghs_test_token')

        // #then - should warn but continue (RFC-011 graceful degradation)
        expect(result).not.toBeNull()
        expect(result?.omoStatus).toBe('failed')
        expect(core.setFailed).not.toHaveBeenCalled()
        expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('oMo installation failed'))
      })

      it('returns omoStatus failed when Bun installation fails', async () => {
        // #given - Bun install throws
        const bunModule = await import('./bun.js')
        vi.mocked(bunModule.installBun).mockRejectedValueOnce(new Error('download failed'))

        // #when
        const result = await runSetup(createSetupInputs({enableOmo: true}), 'ghs_test_token')

        // #then - setup continues but oMo is not attempted
        expect(result).not.toBeNull()
        expect(result?.omoStatus).toBe('failed')
        expect(core.setFailed).not.toHaveBeenCalled()
        expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Bun installation failed'))
        expect(exec.exec).not.toHaveBeenCalledWith('bunx', expect.anything(), expect.anything())
      })

      it('does not pin default_agent in enabled mode', async () => {
        // #given

        // #when
        const result = await runSetup(createSetupInputs({enableOmo: true}), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        const configExportCall = vi
          .mocked(core.exportVariable)
          .mock.calls.find(([name]) => name === 'OPENCODE_CONFIG_CONTENT')
        expect(configExportCall).toBeDefined()
        const config = JSON.parse(configExportCall![1] as string) as Record<string, unknown>
        // Without user config, no default_agent should be set
        expect(config.default_agent).toBeUndefined()
      })

      it('preserves user plugin array with oMo installer plugin entries', async () => {
        // #given - existing opencode.json with oMo plugin
        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({plugin: ['oh-my-openagent@3.7.4', 'custom@1.0.0']}))

        // #when
        const result = await runSetup(
          createSetupInputs({enableOmo: true, opencodeConfig: '{"plugin":["custom-plugin@1.0.0"]}'}),
          'ghs_test_token',
        )

        // #then - existing oMo plugin merged with CI plugin
        expect(result).not.toBeNull()
        const configExportCall = vi
          .mocked(core.exportVariable)
          .mock.calls.find(([name]) => name === 'OPENCODE_CONFIG_CONTENT')
        expect(configExportCall).toBeDefined()
        const config = JSON.parse(configExportCall![1] as string) as Record<string, unknown>
        const plugins = config.plugin as unknown[]
        expect(plugins).toContain('oh-my-openagent@3.7.4')
        expect(plugins).toContain('custom-plugin@1.0.0')
      })

      it('writes Systematic config when provided in enabled mode', async () => {
        // #given
        const systematicConfig = JSON.stringify({agents: {default: 'sisyphus'}})

        // #when
        const result = await runSetup(createSetupInputs({enableOmo: true, systematicConfig}), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        const writeFileCalls = vi.mocked(fs.writeFile).mock.calls
        const systematicConfigCall = writeFileCalls.find(
          ([filePath]) => typeof filePath === 'string' && filePath.includes('systematic.json'),
        )
        expect(systematicConfigCall).toBeDefined()
        const written = JSON.parse(systematicConfigCall![1] as string) as Record<string, unknown>
        expect(written).toMatchObject({agents: {default: 'sisyphus'}})
      })
    })

    describe('tools cache integration', () => {
      beforeEach(() => {
        process.env.RUNNER_TOOL_CACHE = '/opt/hostedtoolcache'

        vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
        vi.mocked(exec.getExecOutput).mockImplementation(async (cmd: string, args?: string[]) => {
          if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === '/user') {
            return {exitCode: 0, stdout: 'fro-bot', stderr: ''}
          }
          return {exitCode: 0, stdout: '', stderr: ''}
        })
        vi.mocked(exec.exec).mockResolvedValue(0)
        vi.mocked(fs.writeFile).mockResolvedValue()
        vi.mocked(fs.mkdir).mockResolvedValue(undefined)
        vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({hit: false, restoredKey: null})
        vi.mocked(toolsCache.saveToolsCache).mockResolvedValue(true)
      })

      it('calls restoreToolsCache before install functions', async () => {
        // #given

        // #when
        await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(toolsCache.restoreToolsCache).toHaveBeenCalledTimes(1)
        const callArgs = vi.mocked(toolsCache.restoreToolsCache).mock.calls[0]?.[0]
        expect(callArgs).toBeDefined()
        expect(callArgs?.toolCachePath).toContain('opencode')
        expect(callArgs?.omoConfigPath).toContain('opencode')
        expect(callArgs?.opencodeCachePath).toContain('opencode')
        expect(callArgs?.systematicVersion).toBe('2.1.0')
      })

      it('passes disabled cacheMode to restoreToolsCache when enableOmo is false', async () => {
        // #given - default disabled mode

        // #when
        await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        const callArgs = vi.mocked(toolsCache.restoreToolsCache).mock.calls[0]?.[0]
        expect(callArgs?.cacheMode).toBe('disabled')
      })

      it('passes enabled cacheMode to restoreToolsCache when enableOmo is true', async () => {
        // #given - enabled mode

        // #when
        await runSetup(createSetupInputs({enableOmo: true}), 'ghs_test_token')

        // #then
        const callArgs = vi.mocked(toolsCache.restoreToolsCache).mock.calls[0]?.[0]
        expect(callArgs?.cacheMode).toBe('enabled')
      })

      it('passes disabled cacheMode to saveToolsCache when enableOmo is false', async () => {
        // #given - default disabled mode

        // #when
        await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        const saveArgs = vi.mocked(toolsCache.saveToolsCache).mock.calls[0]?.[0]
        expect(saveArgs?.cacheMode).toBe('disabled')
      })

      it('passes enabled cacheMode to saveToolsCache when enableOmo is true on cache miss', async () => {
        // #given - enabled mode with cache miss
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({hit: false, restoredKey: null})
        vi.mocked(toolsCache.saveToolsCache).mockResolvedValue(true)

        // #when
        await runSetup(createSetupInputs({enableOmo: true}), 'ghs_test_token')

        // #then
        const saveArgs = vi.mocked(toolsCache.saveToolsCache).mock.calls[0]?.[0]
        expect(saveArgs?.cacheMode).toBe('enabled')
      })

      it('calls saveToolsCache after successful installs on cache miss', async () => {
        // #given

        // #when
        await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(toolsCache.saveToolsCache).toHaveBeenCalledTimes(1)
        const saveArgs = vi.mocked(toolsCache.saveToolsCache).mock.calls[0]?.[0]
        expect(saveArgs).toBeDefined()
        expect(saveArgs?.toolCachePath).toContain('opencode')
      })

      it('skips installs and save on tools cache hit when binary is findable', async () => {
        // #given
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({
          hit: true,
          restoredKey: 'opencode-tools-Linux-oc-1.0.300-omo-3.5.5-sys-2.1.0',
        })
        vi.mocked(tc.find).mockReturnValue('/opt/hostedtoolcache/opencode/1.0.300/x64')

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(tc.downloadTool).not.toHaveBeenCalled()
        expect(toolsCache.saveToolsCache).not.toHaveBeenCalled()
        expect(result).not.toBeNull()
        expect(result?.toolsCacheStatus).toBe('hit')
      })

      it('falls through to install when tools cache hits but binary not findable', async () => {
        // #given
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({
          hit: true,
          restoredKey: 'opencode-tools-Linux-oc-1.0.299-omo-3.5.5-sys-2.1.0',
        })
        vi.mocked(tc.find).mockReturnValue('')
        vi.mocked(tc.downloadTool).mockResolvedValue('/tmp/opencode.tar.gz')
        vi.mocked(tc.extractTar).mockResolvedValue('/tmp/opencode')
        vi.mocked(tc.extractZip).mockResolvedValue('/tmp/opencode')
        vi.mocked(tc.cacheDir).mockResolvedValue('/opt/hostedtoolcache/opencode/1.0.300/x64')
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({tag_name: 'v1.0.300'}),
          }),
        )
        vi.mocked(exec.getExecOutput).mockImplementation(async (cmd: string, args?: string[]) => {
          if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === '/user') {
            return {exitCode: 0, stdout: 'fro-bot', stderr: ''}
          }
          if (cmd === 'file') {
            const isZip = process.platform === 'darwin' || process.platform === 'win32'
            return {exitCode: 0, stdout: isZip ? 'Zip archive data' : 'gzip compressed data', stderr: ''}
          }
          return {exitCode: 0, stdout: '', stderr: ''}
        })

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(tc.downloadTool).toHaveBeenCalled()
        expect(result).not.toBeNull()
        expect(core.addPath).toHaveBeenCalledWith('/opt/hostedtoolcache/opencode/1.0.300/x64')
      })

      it('never adds raw toolCachePath directory to PATH', async () => {
        // #given
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({
          hit: true,
          restoredKey: 'opencode-tools-Linux-oc-1.0.299-omo-3.5.5-sys-2.1.0',
        })
        vi.mocked(tc.find).mockReturnValue('')
        vi.mocked(tc.downloadTool).mockResolvedValue('/tmp/opencode.tar.gz')
        vi.mocked(tc.extractTar).mockResolvedValue('/tmp/opencode')
        vi.mocked(tc.extractZip).mockResolvedValue('/tmp/opencode')
        vi.mocked(tc.cacheDir).mockResolvedValue('/opt/hostedtoolcache/opencode/1.0.300/x64')
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({tag_name: 'v1.0.300'}),
          }),
        )
        vi.mocked(exec.getExecOutput).mockImplementation(async (cmd: string, args?: string[]) => {
          if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === '/user') {
            return {exitCode: 0, stdout: 'fro-bot', stderr: ''}
          }
          if (cmd === 'file') {
            const isZip = process.platform === 'darwin' || process.platform === 'win32'
            return {exitCode: 0, stdout: isZip ? 'Zip archive data' : 'gzip compressed data', stderr: ''}
          }
          return {exitCode: 0, stdout: '', stderr: ''}
        })

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(core.setFailed).not.toHaveBeenCalled()
        expect(core.addPath).not.toHaveBeenCalledWith('/opt/hostedtoolcache/opencode')
        expect(result).not.toBeNull()
      })

      it('includes toolsCacheStatus in SetupResult on cache miss', async () => {
        // #given

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        expect(result?.toolsCacheStatus).toBe('miss')
      })

      it('does not call saveToolsCache on tools cache hit', async () => {
        // #given
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({
          hit: true,
          restoredKey: 'opencode-tools-Linux-oc-1.0.300-omo-3.5.5-sys-2.1.0',
        })

        // #when
        await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(toolsCache.saveToolsCache).not.toHaveBeenCalled()
      })
    })

    describe('Systematic config in both modes', () => {
      beforeEach(() => {
        vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
        vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
        vi.mocked(exec.exec).mockResolvedValue(0)
        vi.mocked(fs.writeFile).mockResolvedValue()
        vi.mocked(fs.mkdir).mockResolvedValue(undefined)
        vi.mocked(fs.access).mockRejectedValue(new Error('not found'))
      })

      it('writes Systematic config in disabled mode even if Bun would have failed', async () => {
        // #given - Systematic config provided in disabled mode (no Bun involved)
        const systematicConfig = JSON.stringify({mode: 'test'})

        // #when
        const result = await runSetup(createSetupInputs({systematicConfig}), 'ghs_test_token')

        // #then - Systematic config still written
        expect(result).not.toBeNull()
        const writeFileCalls = vi.mocked(fs.writeFile).mock.calls
        const systematicConfigCall = writeFileCalls.find(
          ([filePath]) => typeof filePath === 'string' && filePath.includes('systematic.json'),
        )
        expect(systematicConfigCall).toBeDefined()
      })

      it('writes Systematic config in enabled mode', async () => {
        // #given
        const systematicConfig = JSON.stringify({mode: 'test'})

        // #when
        const result = await runSetup(createSetupInputs({enableOmo: true, systematicConfig}), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        const writeFileCalls = vi.mocked(fs.writeFile).mock.calls
        const systematicConfigCall = writeFileCalls.find(
          ([filePath]) => typeof filePath === 'string' && filePath.includes('systematic.json'),
        )
        expect(systematicConfigCall).toBeDefined()
      })

      it('does not write systematic.json when systematic-config is not provided', async () => {
        // #given - no systematicConfig

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        const writeFileCalls = vi.mocked(fs.writeFile).mock.calls
        const systematicConfigCall = writeFileCalls.find(
          ([filePath]) => typeof filePath === 'string' && filePath.includes('systematic.json'),
        )
        expect(systematicConfigCall).toBeUndefined()
      })

      it('continues setup and warns when systematic-config JSON is invalid', async () => {
        // #given
        // #when
        const result = await runSetup(createSetupInputs({systematicConfig: '{invalid json}'}), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        expect(core.setFailed).not.toHaveBeenCalled()
        expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('systematic-config write failed'))
      })
    })
  })
})
