import {Buffer} from 'node:buffer'
import * as exec from '@actions/exec'
import {ensureOpenCodeAvailable} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DEFAULT_OPENCODE_VERSION} from '../../shared/constants.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {configureGhAuth, configureGitIdentity} from './gh-auth.js'
import {installOpenCode} from './opencode.js'
import {runtimeSetupAdapter} from './runtime-setup-adapter.js'
import {writeSystematicConfig} from './systematic-config.js'

// Drives the REAL ensureOpenCodeAvailable -> runtimeSetupAdapter -> runSetup chain, faking only the leaves (the
// installer, the tools cache, the plugin installer, gh/git and the config writer) and the process boundary. The point:
// setup holds the per-invocation work (gh auth, git identity, the systematic config), so a binary that already reports
// the pinned version on the runner must never let it be skipped.

vi.mock('@actions/core', () => ({
  addPath: vi.fn(),
  exportVariable: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}))
vi.mock('@actions/github', () => ({getOctokit: vi.fn(() => ({}))}))
vi.mock('@actions/exec', () => ({exec: vi.fn(), getExecOutput: vi.fn()}))
vi.mock('./gh-auth.js', () => ({
  configureGhAuth: vi.fn(async () => ({botLogin: 'fro-bot[bot]'})),
  configureGitIdentity: vi.fn(async () => undefined),
}))
vi.mock('./systematic-config.js', () => ({writeSystematicConfig: vi.fn(async () => undefined)}))
vi.mock('./tools-cache.js', () => ({
  restoreToolsCache: vi.fn(async () => ({hit: true})),
  saveToolsCache: vi.fn(async () => undefined),
}))
vi.mock('./plugin-install-v2.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./plugin-install-v2.js')>()),
  arePluginsCachedV2: vi.fn(async () => true),
  installPluginsV2: vi.fn(),
}))
vi.mock('./opencode.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./opencode.js')>()),
  installOpenCode: vi.fn(),
}))

const SETUP_DIR = '/runner/toolcache/opencode/2.2.6-sha256-abc/x64'
const PREINSTALLED = '/usr/local/bin/preinstalled-opencode'
const SYSTEMATIC_CONFIG = '{"disabled_hooks":["example"]}'

function options(opencodeVersion: string) {
  return {
    logger: createMockLogger(),
    opencodeVersion,
    githubToken: 'ghs_fresh_token',
    authJson: '{"anthropic":{"type":"api","key":"sk-ant-fresh"}}',
    systematicVersion: '3.32.1',
    opencodeConfig: null,
    systematicConfig: SYSTEMATIC_CONFIG,
    credential: 'provision' as const,
  }
}

describe('ensureOpenCodeAvailable always runs setup, whatever binary is already on the runner', () => {
  const originalOpencodePath = process.env.OPENCODE_PATH

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.OPENCODE_PATH
    // A binary that answers `--version` with exactly the pin, wherever it is found: what a self-hosted runner, or an
    // earlier fro-bot step in the same job (setup's addPath persists), leaves behind.
    vi.mocked(exec.exec).mockImplementation(async (_cmd, _args, execOptions) => {
      execOptions?.listeners?.stdout?.(Buffer.from(`opencode v${DEFAULT_OPENCODE_VERSION}\n`))
      return 0
    })
    vi.mocked(installOpenCode).mockResolvedValue({
      path: SETUP_DIR,
      version: DEFAULT_OPENCODE_VERSION,
      cached: true,
    })
  })

  afterEach(() => {
    if (originalOpencodePath === undefined) delete process.env.OPENCODE_PATH
    else process.env.OPENCODE_PATH = originalOpencodePath
  })

  it.each([
    ['on PATH, with opencode-version latest', undefined, 'latest'],
    ['on PATH, with the unset-input default (the pin)', undefined, DEFAULT_OPENCODE_VERSION],
    ['via OPENCODE_PATH, with opencode-version latest', PREINSTALLED, 'latest'],
    ['via OPENCODE_PATH, with the explicit pin', PREINSTALLED, DEFAULT_OPENCODE_VERSION],
  ])(
    'a pinned binary %s still gets gh auth, git identity and the systematic config, and setup supplies the binary',
    async (_label, preinstalledPath, requested) => {
      // #given
      if (preinstalledPath !== undefined) process.env.OPENCODE_PATH = preinstalledPath

      // #when
      const result = await ensureOpenCodeAvailable(options(requested), runtimeSetupAdapter)

      // #then the per-invocation work ran with this run's credentials and config
      expect(installOpenCode).toHaveBeenCalledTimes(1)
      expect(configureGhAuth).toHaveBeenCalledTimes(1)
      expect(vi.mocked(configureGhAuth).mock.calls[0]?.[2]).toBe('ghs_fresh_token')
      expect(configureGitIdentity).toHaveBeenCalledTimes(1)
      expect(writeSystematicConfig).toHaveBeenCalledWith(SYSTEMATIC_CONFIG, expect.any(String), expect.anything())

      // #and the binary the Action goes on to use is the one setup provides, not the pre-installed one
      expect(result.path).toBe(`${SETUP_DIR}/opencode`)
      expect(result.path).not.toBe(PREINSTALLED)
      expect(result.version).toBe(DEFAULT_OPENCODE_VERSION)
      expect(process.env.OPENCODE_PATH).toBe(`${SETUP_DIR}/opencode`)
    },
  )
})
