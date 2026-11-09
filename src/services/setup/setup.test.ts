import type {SetupInputs} from './types.js'

import * as fs from 'node:fs/promises'
import {join} from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as tc from '@actions/tool-cache'
import {DEFAULT_SYSTEMATIC_VERSION, FRO_BOT_PLUGIN_VERSION} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {getPlatformInfo, installOpenCode, RECORDED_V2_PIN} from './opencode.js'
import * as pluginInstallV2 from './plugin-install-v2.js'
import {runSetup} from './setup.js'
import * as toolsCache from './tools-cache.js'

function createSetupInputs(overrides: Partial<SetupInputs> = {}): SetupInputs {
  return {
    opencodeVersion: RECORDED_V2_PIN.version,
    authJson: '{"anthropic": {"type": "api", "key": "sk-ant-test"}}',
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

// The V2 plugin install is a real-filesystem module; this suite mocks node:fs/promises, so its own tests
// (plugin-install-v2.test.ts) cover the install and this suite covers how setup uses it.
vi.mock('./plugin-install-v2.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./plugin-install-v2.js')>()
  return {...actual, installPluginsV2: vi.fn(), arePluginsCachedV2: vi.fn()}
})

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

    vi.mocked(pluginInstallV2.arePluginsCachedV2).mockResolvedValue(false)
    vi.mocked(pluginInstallV2.installPluginsV2).mockResolvedValue({success: true, data: undefined})
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('runSetup', () => {
    it('installs the recorded pin when OpenCode is not cached', async () => {
      // #given a miss in the tool cache, and an install that succeeds
      vi.mocked(tc.find).mockReturnValue('')
      vi.mocked(installOpenCode).mockResolvedValueOnce({
        path: '/opt/hostedtoolcache/opencode/fresh',
        version: RECORDED_V2_PIN.version,
        cached: false,
      })
      vi.mocked(exec.exec).mockResolvedValue(0)
      vi.mocked(fs.writeFile).mockResolvedValue()
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockRejectedValue(new Error('not found'))

      // #when
      const result = await runSetup(createSetupInputs(), 'ghs_test_token')

      // #then the pin is what gets installed and put on PATH
      expect(core.setFailed).not.toHaveBeenCalled()
      expect(result).not.toBeNull()
      expect(vi.mocked(installOpenCode).mock.calls[0]?.[0]).toBe(RECORDED_V2_PIN.version)
      expect(core.addPath).toHaveBeenCalledWith('/opt/hostedtoolcache/opencode/fresh')
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

    it('sets the opencode-path output and no auth-json-path output', async () => {
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
      expect(core.setOutput).toHaveBeenCalledWith('opencode-version', RECORDED_V2_PIN.version)
      // auth.json is never written, so there is no path to report
      expect(vi.mocked(core.setOutput).mock.calls.map(call => call[0])).not.toContain('auth-json-path')

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

    describe('Systematic config and OPENCODE_PURE', () => {
      beforeEach(() => {
        vi.mocked(tc.find).mockReturnValue('/cached/opencode/1.0.300')
        vi.mocked(exec.getExecOutput).mockResolvedValue({exitCode: 0, stdout: '', stderr: ''})
        vi.mocked(exec.exec).mockResolvedValue(0)
        vi.mocked(fs.writeFile).mockResolvedValue()
        vi.mocked(fs.mkdir).mockResolvedValue(undefined)
        vi.mocked(fs.access).mockRejectedValue(new Error('not found'))
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

      it('installs the plugins and saves the tools cache on a miss, plugins first', async () => {
        // #given a tools-cache miss and a binary the tool cache already holds
        vi.mocked(tc.find).mockReturnValue('/opt/hostedtoolcache/opencode/2.2.6-sha/x64')

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then the plugins are installed with the executable (never the directory put on PATH), and only then saved
        expect(result?.toolsCacheStatus).toBe('miss')
        const addedPath = vi.mocked(core.addPath).mock.calls.at(0)?.[0]
        expect(addedPath).toBe('/opt/hostedtoolcache/opencode/2.2.6-sha/x64')
        const installArgs = vi.mocked(pluginInstallV2.installPluginsV2).mock.calls.at(0)?.[0]
        expect(installArgs?.opencodeBinaryPath).toBe(join(addedPath ?? '', 'opencode'))
        expect(installArgs?.opencodeBinaryPath).not.toBe(addedPath)
        expect(result?.opencodePath).toBe(addedPath)
        expect(result?.opencodeBinaryPath).toBe(join(addedPath ?? '', 'opencode'))
        expect(toolsCache.saveToolsCache).toHaveBeenCalledTimes(1)
        expect(vi.mocked(toolsCache.saveToolsCache).mock.calls[0]?.[0].toolCachePath).toContain('opencode')
        const installOrder = vi.mocked(pluginInstallV2.installPluginsV2).mock.invocationCallOrder[0]
        const saveOrder = vi.mocked(toolsCache.saveToolsCache).mock.invocationCallOrder[0]
        expect(installOrder).toBeLessThan(saveOrder ?? Number.POSITIVE_INFINITY)
      })

      it('skips the plugin install and the save on a tools-cache hit that already holds the plugins', async () => {
        // #given a hit, a findable binary and plugins the restored cache already holds
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({hit: true, restoredKey: 'opencode-tools-v2-key'})
        vi.mocked(tc.find).mockReturnValue('/opt/hostedtoolcache/opencode/2.2.6-sha/x64')
        vi.mocked(pluginInstallV2.arePluginsCachedV2).mockResolvedValue(true)

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then
        expect(tc.downloadTool).not.toHaveBeenCalled()
        expect(pluginInstallV2.installPluginsV2).not.toHaveBeenCalled()
        expect(toolsCache.saveToolsCache).not.toHaveBeenCalled()
        expect(result?.toolsCacheStatus).toBe('hit')
      })

      it('reinstalls when the tools cache hits but the binary is not findable, and never puts the cache root on PATH', async () => {
        // #given a hit whose binary is missing from the tool cache
        vi.mocked(toolsCache.restoreToolsCache).mockResolvedValue({hit: true, restoredKey: 'opencode-tools-v2-key'})
        vi.mocked(pluginInstallV2.arePluginsCachedV2).mockResolvedValue(true)
        vi.mocked(installOpenCode).mockResolvedValueOnce({
          path: '/opt/hostedtoolcache/opencode/2.2.6-sha/x64',
          version: RECORDED_V2_PIN.version,
          cached: false,
        })

        // #when
        const result = await runSetup(createSetupInputs(), 'ghs_test_token')

        // #then the binary is reinstalled and the install directory (not the raw cache root) goes on PATH
        expect(installOpenCode).toHaveBeenCalledTimes(1)
        expect(core.addPath).toHaveBeenCalledWith('/opt/hostedtoolcache/opencode/2.2.6-sha/x64')
        expect(core.addPath).not.toHaveBeenCalledWith('/opt/hostedtoolcache/opencode')
        expect(result).not.toBeNull()
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

        it('resolves "latest" to the recorded pin with no network lookup', async () => {
          // #given a network that would name an unverified stock release as upstream's latest
          const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({tag_name: 'v1.19.5'}), {status: 200}))
          vi.mocked(installOpenCode).mockResolvedValueOnce({
            path: '/opt/hostedtoolcache/opencode/fresh',
            version: RECORDED_V2_PIN.version,
            cached: false,
          })

          // #when
          await runSetup({...v2Inputs(), opencodeVersion: 'latest'}, 'ghs_test_token')

          // #then the pin is what gets cache-keyed and installed, and upstream is never asked
          const restoreArgs = vi.mocked(toolsCache.restoreToolsCache).mock.calls[0]?.[0]
          expect(restoreArgs?.opencodeVersion).toBe(RECORDED_V2_PIN.version)
          expect(restoreArgs?.opencodeDigestId).toBe(digestId)
          expect(vi.mocked(installOpenCode).mock.calls[0]?.[0]).toBe(RECORDED_V2_PIN.version)
          expect(fetchSpy).not.toHaveBeenCalled()
          fetchSpy.mockRestore()
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

          it('installs both plugins at exact versions through the V2 installer', async () => {
            // #when
            const result = await runSetup(v2Inputs(), 'ghs_test_token')

            // #then
            expect(result).not.toBeNull()
            const call = vi.mocked(pluginInstallV2.installPluginsV2).mock.calls[0]?.[0]
            expect(call?.specs).toEqual([SYSTEMATIC_SPEC, FRO_BOT_SPEC])
            expect(call?.opencodeBinaryPath).toBe('/opt/hostedtoolcache/opencode/fresh/opencode')
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

          it('writes no auth.json, no config file and no exported config', async () => {
            // #when
            await runSetup(withAuth(JSON.stringify({anthropic: {type: 'api', key: CANARY}})), 'ghs_test_token')

            // #then nothing carries the key and nothing is written where V2's migration would import it
            const written = vi.mocked(fs.writeFile).mock.calls.map(call => String(call[0]))
            expect(written.some(file => file.endsWith('auth.json'))).toBe(false)
            expect(JSON.stringify(vi.mocked(fs.writeFile).mock.calls)).not.toContain(CANARY)
            expect(core.exportVariable).not.toHaveBeenCalledWith('OPENCODE_CONFIG_CONTENT', expect.anything())
            expect(core.setOutput).not.toHaveBeenCalledWith('auth-json-path', expect.anything())
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
        })
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
