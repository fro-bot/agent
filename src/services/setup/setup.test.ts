import type {SetupInputs} from './types.js'

import * as fs from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as tc from '@actions/tool-cache'
import {DEFAULT_SYSTEMATIC_VERSION, FRO_BOT_PLUGIN_VERSION} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {getPlatformInfo, installOpenCode, RECORDED_V2_PIN} from './opencode.js'
import * as pluginInstallV2 from './plugin-install-v2.js'
import * as sessionToolsConfig from './session-tools-config.js'
import {runSetup} from './setup.js'
import * as systematicPlugin from './systematic-plugin.js'
import * as toolsCache from './tools-cache.js'

function createSetupInputs(overrides: Partial<SetupInputs> = {}): SetupInputs {
  return {
    opencodeVersion: '1.2.24',
    authJson: '{"anthropic": {"api_key": "sk-ant-test"}}',
    appId: null,
    privateKey: null,
    opencodeConfig: null,
    systematicConfig: null,
    systematicVersion: '2.1.0',
    credential: 'provision',
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
  mkdtemp: vi.fn().mockResolvedValue('/tmp/gh-config-mock'),
  chmod: vi.fn().mockResolvedValue(undefined),
}))

// Mock tools-cache module
vi.mock('./tools-cache.js', () => ({
  restoreToolsCache: vi.fn(),
  saveToolsCache: vi.fn(),
}))

// Real opencode.js, except installOpenCode is a pass-through spy so a test can stand in a successful V2
// install (a real one needs the genuine release archive).
vi.mock('./opencode.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./opencode.js')>()
  return {...actual, installOpenCode: vi.fn(actual.installOpenCode)}
})

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

// Mock session-tools-config module so tests can assert the native session tools file is
// actually written, not just that some unrelated mkdir happened.
vi.mock('./session-tools-config.js', () => ({
  writeSessionToolsFile: vi.fn().mockResolvedValue(undefined),
}))

// The V2 plugin install is a real-filesystem module; this suite mocks node:fs/promises, so its own tests
// (plugin-install-v2.test.ts) cover the install and this suite covers how setup uses it.
vi.mock('./plugin-install-v2.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./plugin-install-v2.js')>()
  return {...actual, installPluginsV2: vi.fn(), arePluginsCachedV2: vi.fn()}
})

vi.mock('./systematic-plugin.js', () => ({
  installSystematicPlugin: vi.fn().mockResolvedValue({status: 'installed', duration: 1}),
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

    // Scrub ambient NPM_CONFIG_* (bun/npm test runners set NPM_CONFIG_USERCONFIG and lowercase
    // npm_config_*) so tests that assert on their presence/absence in the warning message control
    // it explicitly. Case-insensitive, matching the diagnostic itself. The whole env is a fresh
    // copy per test and the original object is restored in afterEach, so this never leaks.
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase().startsWith('NPM_CONFIG_')) delete process.env[key]
    }

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

    // Re-apply session-tools-config mock cleared by vi.resetAllMocks() above.
    vi.mocked(sessionToolsConfig.writeSessionToolsFile).mockResolvedValue(undefined)
    vi.mocked(systematicPlugin.installSystematicPlugin).mockResolvedValue({status: 'installed', duration: 1})
    vi.mocked(pluginInstallV2.arePluginsCachedV2).mockResolvedValue(false)
    vi.mocked(pluginInstallV2.installPluginsV2).mockResolvedValue({success: true, data: undefined})
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
      vi.mocked(fs.mkdtemp).mockResolvedValue('/tmp/gh-config-mock')
      vi.mocked(fs.chmod).mockResolvedValue(undefined)

      // #when
      await runSetup(createSetupInputs({credential: 'provision'}), 'ghs_test_token')

      // #then — characterization: autonomous triggers ('provision') keep today's behavior.
      expect(core.exportVariable).toHaveBeenCalledWith('GH_TOKEN', 'ghs_test_token')
      expect(core.exportVariable).toHaveBeenCalledWith('GH_CONFIG_DIR', expect.any(String))
    })

    it('withholds the credential everywhere the child can read it when credential is "withhold"', async () => {
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
      const token = 'ghs_should_never_leak'
      const originalGhToken = process.env.GH_TOKEN
      const originalGhConfigDir = process.env.GH_CONFIG_DIR
      delete process.env.GH_TOKEN
      delete process.env.GH_CONFIG_DIR

      try {
        // #when
        await runSetup(createSetupInputs({credential: 'withhold'}), token)

        // #then
        // Name-independent scan of exportVariable call *values* — the token string must
        // not appear in any exported name/value pair (this simulates the $GITHUB_ENV write).
        const exportCalls = vi.mocked(core.exportVariable).mock.calls
        for (const [name, value] of exportCalls) {
          expect(name).not.toBe('GH_TOKEN')
          expect(name).not.toBe('GH_CONFIG_DIR')
          expect(String(value)).not.toContain(token)
        }
        // Name-independent scan of the harness process env values.
        expect(Object.values(process.env)).not.toContain(token)
        expect(process.env.GH_TOKEN).toBeUndefined()
        expect(process.env.GH_CONFIG_DIR).toBeUndefined()
        // gh auth login (which would write hosts.yml) must never be invoked.
        const ghAuthLoginCalls = vi
          .mocked(exec.getExecOutput)
          .mock.calls.filter(call => call[0] === 'gh' && call[1]?.[0] === 'auth')
        expect(ghAuthLoginCalls).toHaveLength(0)
      } finally {
        if (originalGhToken != null) {
          process.env.GH_TOKEN = originalGhToken
        }
        if (originalGhConfigDir != null) {
          process.env.GH_CONFIG_DIR = originalGhConfigDir
        }
      }
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

      // #then the opencode-path output is the install DIRECTORY, matching what goes on PATH and
      // what RFC-011 documents. It is deliberately not the executable — consumers add it to PATH.
      expect(core.setOutput).toHaveBeenCalledWith('opencode-path', '/cached/opencode/1.0.300')
      expect(core.setOutput).toHaveBeenCalledWith('auth-json-path', expect.stringContaining('auth.json'))

      // #and the setup action does not export OPENCODE_PATH. RFC-012 says so, and that claim is
      // load-bearing: the variable is read back as an executable by verifyOpenCodeAvailable and by
      // @fro.bot/harness's resolveBinary(), while this action's own value here is the directory.
      // Exporting it would put a directory somewhere three consumers spawn.
      // Asserted on the call arguments rather than with `not.toHaveBeenCalledWith(..., anything())`:
      // expect.anything() does not match undefined, so an export wired to an optional field --
      // exactly the shape a regression would take -- would slip past that form.
      expect(vi.mocked(core.exportVariable).mock.calls.map(call => call[0])).not.toContain('OPENCODE_PATH')
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

    describe('default config', () => {
      beforeEach(() => {
        vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
        vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
        vi.mocked(exec.exec).mockResolvedValue(0)
        vi.mocked(fs.writeFile).mockResolvedValue()
        vi.mocked(fs.mkdir).mockResolvedValue(undefined)
        vi.mocked(fs.access).mockRejectedValue(new Error('not found'))
      })

      it('writes config with default_agent build', async () => {
        // #given - default inputs

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
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

      it('creates the OpenCode config directory before writing the config', async () => {
        // #given - setup owns config dir creation; with XDG_CONFIG_HOME unset the
        // default is `~/.config/opencode` under the suite's isolated (temp) HOME
        delete process.env.XDG_CONFIG_HOME
        const configDir = join(homedir(), '.config', 'opencode')

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        expect(fs.mkdir).toHaveBeenCalledWith(configDir, {recursive: true})
        expect(fs.writeFile).toHaveBeenCalledWith(join(configDir, 'opencode.json'), expect.any(String))
      })

      it('writes Systematic config when provided', async () => {
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

      it('always attempts to write the session tools file', async () => {
        // #given

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        expect(sessionToolsConfig.writeSessionToolsFile).toHaveBeenCalledTimes(1)
        const [configDirArg] = vi.mocked(sessionToolsConfig.writeSessionToolsFile).mock.calls[0] ?? []
        expect(typeof configDirArg).toBe('string')
      })

      it('warns that OPENCODE_PURE is withheld from the server when the runner sets it', async () => {
        // #given an operator environment with OPENCODE_PURE
        process.env.OPENCODE_PURE = 'true'

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then setup still succeeds (the variable is denied by filterAgentEnv, not by failing the run) but says so
        expect(result).not.toBeNull()
        expect(core.setFailed).not.toHaveBeenCalled()
        expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('OPENCODE_PURE is set'))
      })

      it.each(['', '0', 'false'])('does not warn about OPENCODE_PURE when it is %j', async value => {
        // #given GitHub Actions materializing an unset `env:` input as '' (or an explicit off value)
        process.env.OPENCODE_PURE = value

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(result).not.toBeNull()
        expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('OPENCODE_PURE is set'))
      })

      it('writes fresh config without merging existing opencode.json', async () => {
        // #given - simulate an existing opencode.json with stale data
        vi.mocked(fs.readFile).mockResolvedValue(
          JSON.stringify({default_agent: 'custom', plugin: ['stale-plugin@3.7.4']}),
        )

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then - fresh config has build and none of the stale plugins
        expect(result).not.toBeNull()
        const configExportCall = vi
          .mocked(core.exportVariable)
          .mock.calls.find(([name]) => name === 'OPENCODE_CONFIG_CONTENT')
        expect(configExportCall).toBeDefined()
        expect(typeof configExportCall?.[1]).toBe('string')
        const config = JSON.parse(String(configExportCall?.[1])) as Record<string, unknown>
        expect(config.default_agent).toBe('build')

        const configPlugins = config.plugin as unknown[]
        expect(configPlugins?.some(p => typeof p === 'string' && p.includes('stale-plugin'))).toBe(false)
      })
    })

    describe('tools cache integration', () => {
      beforeEach(() => {
        process.env.RUNNER_TOOL_CACHE = '/opt/hostedtoolcache'

        // Default: the OpenCode binary itself is NOT found in tool-cache, so a genuine fresh
        // install runs (opencodeResult.cached === false) and the systematic-install gate fires.
        // Tests that want a genuine cache hit (binary present) override tc.find explicitly.
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
        expect(callArgs?.opencodeCachePath).toContain('opencode')
        expect(callArgs?.systematicVersion).toBe('2.1.0')
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

      it('does not save cache when the plugin install times out', async () => {
        // #given an install that exhausts its budget without completing
        vi.mocked(systematicPlugin.installSystematicPlugin).mockResolvedValue({status: 'timed-out', duration: 420_000})

        // #when setup runs
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then the incomplete install is not persisted in the cache
        expect(toolsCache.saveToolsCache).not.toHaveBeenCalled()
        expect(result).not.toBeNull()
      })

      it('continues setup when the plugin install times out', async () => {
        // #given an install that exhausts its budget without completing
        vi.mocked(systematicPlugin.installSystematicPlugin).mockResolvedValue({status: 'timed-out', duration: 420_000})

        // #when setup runs
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then setup still finishes
        expect(result).not.toBeNull()
      })

      it('continues setup without saving cache when the plugin install fails', async () => {
        // #given an install that exits unsuccessfully
        vi.mocked(systematicPlugin.installSystematicPlugin).mockResolvedValue({status: 'failed', duration: 1_000})

        // #when setup runs
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then setup still finishes, but the incomplete install is not persisted in the cache
        expect(toolsCache.saveToolsCache).not.toHaveBeenCalled()
        expect(core.warning).toHaveBeenCalledWith(
          'Skipping tools cache save because Systematic plugin install did not complete',
        )
        expect(result).not.toBeNull()
      })

      it('names the scrubbed NPM_CONFIG_* keys in the warning when the parent env had them set', async () => {
        // #given an install that fails, with an NPM_CONFIG_* var set in the parent env
        vi.mocked(systematicPlugin.installSystematicPlugin).mockResolvedValue({status: 'failed', duration: 1_000})
        process.env.NPM_CONFIG_REGISTRY = 'https://registry.example.com'

        try {
          // #when setup runs
          await runSetup(createSetupInputs(), 'ghs_test_token')

          // #then the warning names the scrubbed key (never the value)
          expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('NPM_CONFIG_REGISTRY'))
          const warningArg = vi
            .mocked(core.warning)
            .mock.calls.find(
              ([message]) => typeof message === 'string' && message.includes('Skipping tools cache save'),
            )?.[0]
          expect(warningArg).not.toContain('registry.example.com')
        } finally {
          delete process.env.NPM_CONFIG_REGISTRY
        }
      })

      it('does not mention NPM_CONFIG_* in the warning when none is set', async () => {
        // #given an install that fails, with no NPM_CONFIG_* vars in the parent env
        vi.mocked(systematicPlugin.installSystematicPlugin).mockResolvedValue({status: 'failed', duration: 1_000})

        // #when setup runs
        await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then the base message is unchanged
        expect(core.warning).toHaveBeenCalledWith(
          'Skipping tools cache save because Systematic plugin install did not complete',
        )
      })

      it('installs the Systematic plugin after writing config and before saving a cache miss', async () => {
        // #given a tools cache miss

        // #when setup writes its config and completes installation
        await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then OpenCode performs the plugin install before the tools cache is saved, using the
        // resolved binary path (not the bare 'opencode' command name, and not the install
        // directory — spawning that fails EACCES)
        expect(systematicPlugin.installSystematicPlugin).toHaveBeenCalledWith(
          expect.objectContaining({
            opencodeBinaryPath: join('/opt/hostedtoolcache/opencode/1.0.300/x64', 'opencode'),
            systematicVersion: '2.1.0',
          }),
        )
        const installOrder = vi.mocked(systematicPlugin.installSystematicPlugin).mock.invocationCallOrder[0]
        const saveOrder = vi.mocked(toolsCache.saveToolsCache).mock.invocationCallOrder[0]
        expect(installOrder).toBeDefined()
        expect(saveOrder).toBeDefined()
        expect(installOrder).toBeLessThan(saveOrder ?? Number.POSITIVE_INFINITY)
      })

      it('skips installs and save on tools cache hit when binary is findable', async () => {
        // #given
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({
          hit: true,
          restoredKey: 'opencode-tools-v2-Linux-oc-1.0.300-sys-2.1.0',
        })
        vi.mocked(tc.find).mockReturnValue('/opt/hostedtoolcache/opencode/1.0.300/x64')

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(tc.downloadTool).not.toHaveBeenCalled()
        expect(toolsCache.saveToolsCache).not.toHaveBeenCalled()
        expect(systematicPlugin.installSystematicPlugin).not.toHaveBeenCalled()
        expect(result).not.toBeNull()
        expect(result?.toolsCacheStatus).toBe('hit')
      })

      it('keeps V1 cache identities unchanged: no digest id, bare version lookup', async () => {
        // #given a V1 pin with a warm tools cache and a warm tool cache
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({hit: true, restoredKey: 'opencode-tools-v2-key'})
        vi.mocked(tc.find).mockReturnValue('/opt/hostedtoolcache/opencode/1.19.4/x64')

        // #when
        const result = await runSetup(createSetupInputs({opencodeVersion: '1.19.4'}), 'ghs_test_token')

        // #then
        const restoreArgs = vi.mocked(toolsCache.restoreToolsCache).mock.calls[0]?.[0]
        expect(restoreArgs?.opencodeVersion).toBe('1.19.4')
        expect(restoreArgs).not.toHaveProperty('opencodeDigestId')
        expect(tc.find).toHaveBeenCalledWith('opencode', '1.19.4')
        expect(tc.downloadTool).not.toHaveBeenCalled()
        expect(result?.toolsCacheStatus).toBe('hit')
      })

      describe('stock V2 pin', () => {
        const platform = getPlatformInfo()
        const recordedDigest = RECORDED_V2_PIN.assets[`opencode-${platform.os}-${platform.arch}${platform.ext}`] ?? ''
        const digestId = `sha256-${recordedDigest.slice(0, 16)}`
        const boundVersion = `${RECORDED_V2_PIN.version}-${digestId}`
        // V2 takes API-key entries only (they become key files at spawn time), so these inputs carry one.
        const v2Inputs = () =>
          createSetupInputs({
            opencodeVersion: RECORDED_V2_PIN.version,
            authJson: '{"anthropic": {"type": "api", "key": "sk-ant-test"}}',
          })

        it('keys the persistent tools cache by the recorded digest', async () => {
          // #when
          await runSetup(v2Inputs(), 'ghs_test_token')

          // #then the restore key carries the digest id, so a pre-change V2 key cannot match
          expect(digestId).toMatch(/^sha256-[0-9a-f]{16}$/)
          const restoreArgs = vi.mocked(toolsCache.restoreToolsCache).mock.calls[0]?.[0]
          expect(restoreArgs?.opencodeVersion).toBe(RECORDED_V2_PIN.version)
          expect(restoreArgs?.opencodeDigestId).toBe(digestId)
        })

        it('does not reuse a pre-change V2 entry from a warm local tool cache', async () => {
          // #given the local tool cache only holds the entry cached under the bare version
          vi.mocked(tc.find).mockImplementation((_name: string, version: string) =>
            version === RECORDED_V2_PIN.version ? '/opt/hostedtoolcache/opencode/legacy' : '',
          )

          // #when
          await runSetup(v2Inputs(), 'ghs_test_token')

          // #then the legacy entry is never offered, and a verified install is attempted
          expect(core.addPath).not.toHaveBeenCalledWith('/opt/hostedtoolcache/opencode/legacy')
          expect(tc.find).not.toHaveBeenCalledWith('opencode', RECORDED_V2_PIN.version)
          expect(tc.find).toHaveBeenCalledWith('opencode', boundVersion, platform.arch)
          expect(tc.downloadTool).toHaveBeenCalled()
        })

        it('does not use an older V2 tools-cache restore hit', async () => {
          // #given a tools-cache restore reports a hit (an older entry) and the legacy binary is findable
          vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({
            hit: true,
            restoredKey: `opencode-tools-v2-Linux-oc-${RECORDED_V2_PIN.version}-sys-2.1.0`,
          })
          vi.mocked(tc.find).mockImplementation((_name: string, version: string) =>
            version === RECORDED_V2_PIN.version ? '/opt/hostedtoolcache/opencode/legacy' : '',
          )

          // #when
          await runSetup(v2Inputs(), 'ghs_test_token')

          // #then the setup-level shortcut does not accept the legacy binary
          expect(core.addPath).not.toHaveBeenCalledWith('/opt/hostedtoolcache/opencode/legacy')
          expect(tc.downloadTool).toHaveBeenCalled()
        })

        it('reuses a V2 entry bound to the recorded digest on a tools-cache hit', async () => {
          // #given a restore hit (which carries the plugin cache) and a binary cached under the digest-bound identity
          vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({hit: true, restoredKey: 'bound-key'})
          vi.mocked(pluginInstallV2.arePluginsCachedV2).mockResolvedValue(true)
          vi.mocked(tc.find).mockImplementation((_name: string, version: string) =>
            version === boundVersion ? '/opt/hostedtoolcache/opencode/bound' : '',
          )

          // #when
          const result = await runSetup(v2Inputs(), 'ghs_test_token')

          // #then
          expect(tc.downloadTool).not.toHaveBeenCalled()
          expect(core.addPath).toHaveBeenCalledWith('/opt/hostedtoolcache/opencode/bound')
          expect(result?.toolsCacheStatus).toBe('hit')
          expect(toolsCache.saveToolsCache).not.toHaveBeenCalled()
        })

        it('saves the tools cache under the digest-bound key after a fresh verified install', async () => {
          // #given a cold tools cache and a successful (stood-in) verified install
          vi.mocked(installOpenCode).mockResolvedValueOnce({
            path: '/opt/hostedtoolcache/opencode/fresh',
            version: RECORDED_V2_PIN.version,
            cached: false,
          })

          // #when
          await runSetup(v2Inputs(), 'ghs_test_token')

          // #then
          const saveArgs = vi.mocked(toolsCache.saveToolsCache).mock.calls[0]?.[0]
          expect(saveArgs?.opencodeVersion).toBe(RECORDED_V2_PIN.version)
          expect(saveArgs?.opencodeDigestId).toBe(digestId)
        })

        it('fails an unpinned V2 version before any cache is consulted, even with warm caches', async () => {
          // #given warm caches that would accept anything
          vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({hit: true, restoredKey: 'warm'})
          vi.mocked(tc.find).mockReturnValue('/opt/hostedtoolcache/opencode/warm')

          // #when
          const result = await runSetup(createSetupInputs({opencodeVersion: '2.9.9'}), 'ghs_test_token')

          // #then
          expect(result).toBeNull()
          expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(/2\.9\.9.*no recorded digest/))
          expect(toolsCache.restoreToolsCache).not.toHaveBeenCalled()
          expect(tc.find).not.toHaveBeenCalled()
          expect(tc.downloadTool).not.toHaveBeenCalled()
          expect(core.addPath).not.toHaveBeenCalled()
        })

        describe('plugins, config and credentials on V2', () => {
          const SYSTEMATIC_SPEC = '@fro.bot/systematic@2.1.0'
          const FRO_BOT_SPEC = `@fro.bot/opencode-plugin@${FRO_BOT_PLUGIN_VERSION}`
          const CANARY = 'sk-ant-CANARY-setup-v2'

          beforeEach(() => {
            vi.mocked(installOpenCode).mockResolvedValue({
              path: '/opt/hostedtoolcache/opencode/fresh',
              version: RECORDED_V2_PIN.version,
              cached: false,
            })
          })

          const withAuth = (authJson: string, overrides: Partial<SetupInputs> = {}) =>
            createSetupInputs({opencodeVersion: RECORDED_V2_PIN.version, authJson, ...overrides})

          it('installs both plugins at exact versions through the V2 installer and not through the V1 one', async () => {
            // #when
            const result = await runSetup(v2Inputs(), 'ghs_test_token')

            // #then
            expect(result).not.toBeNull()
            const call = vi.mocked(pluginInstallV2.installPluginsV2).mock.calls[0]?.[0]
            expect(call?.specs).toEqual([SYSTEMATIC_SPEC, FRO_BOT_SPEC])
            expect(call?.opencodeBinaryPath).toBe('/opt/hostedtoolcache/opencode/fresh/opencode')
            expect(systematicPlugin.installSystematicPlugin).not.toHaveBeenCalled()
          })

          it('resolves "latest" to the pinned Systematic version before installing', async () => {
            // #when
            await runSetup(
              withAuth('{"anthropic": {"type": "api", "key": "k"}}', {systematicVersion: 'latest'}),
              'ghs_test_token',
            )

            // #then
            const call = vi.mocked(pluginInstallV2.installPluginsV2).mock.calls[0]?.[0]
            expect(call?.specs[0]).toBe(`@fro.bot/systematic@${DEFAULT_SYSTEMATIC_VERSION}`)
            const restoreArgs = vi.mocked(toolsCache.restoreToolsCache).mock.calls[0]?.[0]
            expect(restoreArgs?.systematicVersion).toBe(DEFAULT_SYSTEMATIC_VERSION)
          })

          it('rejects a version range before any cache is consulted', async () => {
            // #when
            const result = await runSetup(
              withAuth('{"anthropic": {"type": "api", "key": "k"}}', {systematicVersion: '^3.0.0'}),
              'ghs_test_token',
            )

            // #then
            expect(result).toBeNull()
            expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('exact x.y.z'))
            expect(toolsCache.restoreToolsCache).not.toHaveBeenCalled()
            expect(pluginInstallV2.installPluginsV2).not.toHaveBeenCalled()
          })

          it('keys the tools cache by the fro.bot plugin version on restore and save', async () => {
            // #when
            await runSetup(v2Inputs(), 'ghs_test_token')

            // #then
            expect(vi.mocked(toolsCache.restoreToolsCache).mock.calls[0]?.[0].frobotPluginVersion).toBe(
              FRO_BOT_PLUGIN_VERSION,
            )
            expect(vi.mocked(toolsCache.saveToolsCache).mock.calls[0]?.[0].frobotPluginVersion).toBe(
              FRO_BOT_PLUGIN_VERSION,
            )
          })

          it('does not reinstall plugins the restored cache already holds', async () => {
            // #given
            vi.mocked(pluginInstallV2.arePluginsCachedV2).mockResolvedValue(true)
            vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({hit: true, restoredKey: 'bound-key'})

            // #when
            const result = await runSetup(v2Inputs(), 'ghs_test_token')

            // #then
            expect(result).not.toBeNull()
            expect(pluginInstallV2.installPluginsV2).not.toHaveBeenCalled()
          })

          it('fails startup with a named plugin-install error when the install times out or fails', async () => {
            // #given
            vi.mocked(pluginInstallV2.installPluginsV2).mockResolvedValue({
              success: false,
              error: {
                kind: 'install-timeout',
                spec: SYSTEMATIC_SPEC,
                message: `Installing OpenCode plugin ${SYSTEMATIC_SPEC} exceeded 420s`,
              },
            })

            // #when
            const result = await runSetup(v2Inputs(), 'ghs_test_token')

            // #then
            expect(result).toBeNull()
            expect(core.setFailed).toHaveBeenCalledWith(
              `OpenCode plugin install failed: Installing OpenCode plugin ${SYSTEMATIC_SPEC} exceeded 420s`,
            )
            expect(toolsCache.saveToolsCache).not.toHaveBeenCalled()
            expect(core.setOutput).not.toHaveBeenCalledWith('opencode-path', expect.anything())
          })

          it('writes no auth.json, no config file, no exported config and no V1 session tools file', async () => {
            // #when
            await runSetup(withAuth(JSON.stringify({anthropic: {type: 'api', key: CANARY}})), 'ghs_test_token')

            // #then nothing carries the key and nothing is written where V2's migration would import it
            const written = vi.mocked(fs.writeFile).mock.calls.map(call => String(call[0]))
            expect(written.some(file => file.endsWith('auth.json'))).toBe(false)
            expect(JSON.stringify(vi.mocked(fs.writeFile).mock.calls)).not.toContain(CANARY)
            expect(core.exportVariable).not.toHaveBeenCalledWith('OPENCODE_CONFIG_CONTENT', expect.anything())
            expect(core.setOutput).not.toHaveBeenCalledWith('auth-json-path', expect.anything())
            expect(sessionToolsConfig.writeSessionToolsFile).not.toHaveBeenCalled()
          })

          it.each([
            ['oauth', {type: 'oauth', refresh: 'REFRESH-CANARY', access: 'ACCESS-CANARY', expires: 1}],
            ['wellknown', {type: 'wellknown', key: 'WK-CANARY', token: 'TOKEN-CANARY'}],
          ])('fails startup naming the provider for a %s entry, without echoing it', async (_label, entry) => {
            // #given
            const authJson = JSON.stringify({anthropic: {type: 'api', key: CANARY}, 'github-copilot': entry})

            // #when
            const result = await runSetup(withAuth(authJson), 'ghs_test_token')

            // #then
            expect(result).toBeNull()
            const failures = JSON.stringify(vi.mocked(core.setFailed).mock.calls)
            expect(failures).toContain('github-copilot')
            for (const secret of [CANARY, 'CANARY']) expect(failures).not.toContain(secret)
            expect(toolsCache.restoreToolsCache).not.toHaveBeenCalled()
            expect(pluginInstallV2.installPluginsV2).not.toHaveBeenCalled()
          })

          it('keeps the V1 behaviour for a V1 pin: V1 install, auth.json, config', async () => {
            // #given the default V1 inputs
            vi.mocked(tc.find).mockReturnValue('/opt/hostedtoolcache/opencode/v1')
            vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({hit: false, restoredKey: null})

            // #when
            await runSetup(createSetupInputs(), 'ghs_test_token')

            // #then
            expect(systematicPlugin.installSystematicPlugin).toHaveBeenCalled()
            expect(pluginInstallV2.installPluginsV2).not.toHaveBeenCalled()
            expect(core.exportVariable).toHaveBeenCalledWith('OPENCODE_CONFIG_CONTENT', expect.any(String))
            expect(sessionToolsConfig.writeSessionToolsFile).toHaveBeenCalled()
            expect(vi.mocked(toolsCache.restoreToolsCache).mock.calls[0]?.[0]).not.toHaveProperty('frobotPluginVersion')
          })
        })
      })

      it('falls through to install when tools cache hits but binary not findable', async () => {
        // #given
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({
          hit: true,
          restoredKey: 'opencode-tools-v2-Linux-oc-1.0.299-sys-2.1.0',
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

        // #then a cache hit with a missing binary still triggers a real reinstall, and the gate
        // (opencodeResult.cached !== true) still fires the Systematic install + cache save
        expect(tc.downloadTool).toHaveBeenCalled()
        expect(result).not.toBeNull()
        expect(core.addPath).toHaveBeenCalledWith('/opt/hostedtoolcache/opencode/1.0.300/x64')
        expect(systematicPlugin.installSystematicPlugin).toHaveBeenCalledWith(
          expect.objectContaining({opencodeBinaryPath: join('/opt/hostedtoolcache/opencode/1.0.300/x64', 'opencode')}),
        )
        expect(toolsCache.saveToolsCache).toHaveBeenCalledTimes(1)
      })

      it('hands the plugin installer an executable, never the directory it puts on PATH', async () => {
        // #given a normal install — `OpenCodeInstallResult.path` is the tool-cache DIRECTORY

        // #when setup runs
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then the two consumers of that directory must not receive the same string: core.addPath
        // takes the directory, while the install child is spawned directly and must get the binary
        // inside it. Collapsing these spawns a directory and fails EACCES in milliseconds, which
        // is fail-soft — the tools cache save is skipped and never warms again.
        const addedPath = vi.mocked(core.addPath).mock.calls.at(0)?.[0]
        const installArgs = vi.mocked(systematicPlugin.installSystematicPlugin).mock.calls.at(0)?.[0]
        expect(addedPath).toBe('/opt/hostedtoolcache/opencode/1.0.300/x64')
        expect(installArgs?.opencodeBinaryPath).not.toBe(addedPath)
        expect(installArgs?.opencodeBinaryPath).toBe(join(addedPath ?? '', 'opencode'))

        // #and the returned result carries both halves under names that say which is which. These
        // are adjacent fields of one object literal differing by a single call, so without this
        // the split is enforced only by that call and a comment.
        expect(result?.opencodePath).toBe(addedPath)
        expect(result?.opencodeBinaryPath).toBe(join(addedPath ?? '', 'opencode'))
        expect(result?.opencodeBinaryPath).not.toBe(result?.opencodePath)
      })

      it('still installs and saves on a tools cache miss when the tool cache already holds the binary', async () => {
        // #given the tools cache key missed (e.g. a bumped systematicVersion, or an earlier
        // invocation whose save was skipped) but RUNNER_TOOL_CACHE still resolves the binary, so
        // installOpenCode reports cached: true without the Actions tools cache being involved
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({hit: false, restoredKey: null})
        vi.mocked(tc.find).mockReturnValue('/opt/hostedtoolcache/opencode/1.0.300/x64')

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then the plugin install and the cache save both still run — gating on the binary alone
        // would skip both here and leave the config pointing at a plugin version never installed
        expect(tc.downloadTool).not.toHaveBeenCalled()
        expect(systematicPlugin.installSystematicPlugin).toHaveBeenCalledWith(
          expect.objectContaining({opencodeBinaryPath: join('/opt/hostedtoolcache/opencode/1.0.300/x64', 'opencode')}),
        )
        expect(toolsCache.saveToolsCache).toHaveBeenCalledTimes(1)
        expect(result?.toolsCacheStatus).toBe('miss')
      })

      it('never adds raw toolCachePath directory to PATH', async () => {
        // #given
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({
          hit: true,
          restoredKey: 'opencode-tools-v2-Linux-oc-1.0.299-sys-2.1.0',
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
        // #given a cache hit where the binary is actually found (opencodeResult.cached === true)
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({
          hit: true,
          restoredKey: 'opencode-tools-v2-Linux-oc-1.0.300-sys-2.1.0',
        })
        vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')

        // #when
        await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(toolsCache.saveToolsCache).not.toHaveBeenCalled()
      })
    })

    describe('Systematic config', () => {
      beforeEach(() => {
        vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
        vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
        vi.mocked(exec.exec).mockResolvedValue(0)
        vi.mocked(fs.writeFile).mockResolvedValue()
        vi.mocked(fs.mkdir).mockResolvedValue(undefined)
        vi.mocked(fs.access).mockRejectedValue(new Error('not found'))
      })

      it('writes Systematic config', async () => {
        // #given - Systematic config provided
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
