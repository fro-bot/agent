import type {Logger} from '../shared/logger.js'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {ensureOpenCodeAvailable} from './ensure-opencode.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn<Logger['debug']>(),
    info: vi.fn<Logger['info']>(),
    warning: vi.fn<Logger['warning']>(),
    error: vi.fn<Logger['error']>(),
  }
}

const INSTALL_DIR = '/opt/hostedtoolcache/opencode/2.2.6-sha256-0123456789abcdef/x64'
const INSTALL_BINARY = `${INSTALL_DIR}/opencode`
const PINNED_VERSION = '2.2.6'

function createEnsureOptions(logger: Logger) {
  return {
    logger,
    opencodeVersion: PINNED_VERSION,
    githubToken: 'ghs_test',
    authJson: '{}',
    systematicVersion: '3.16.3',
    opencodeConfig: null,
    systematicConfig: null,
    credential: 'provision',
  } as const
}
function createSetupAdapter() {
  return {
    runSetup: vi.fn(async () => ({
      opencodePath: INSTALL_DIR,
      opencodeBinaryPath: INSTALL_BINARY,
      opencodeVersion: PINNED_VERSION,
    })),
    addToPath: vi.fn(),
  }
}

describe('ensureOpenCodeAvailable', () => {
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = {...process.env}
    delete process.env.OPENCODE_PATH
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      process.env[key] = value
    }
    vi.clearAllMocks()
  })

  it("always runs setup, with the request and this run's credentials", async () => {
    // #given
    const logger = createMockLogger()
    const setupAdapter = createSetupAdapter()

    // #when
    const result = await ensureOpenCodeAvailable(createEnsureOptions(logger), setupAdapter)

    // #then setup is handed the request and the token; there is no earlier availability check to skip it
    expect(setupAdapter.runSetup).toHaveBeenCalledTimes(1)
    expect(setupAdapter.runSetup).toHaveBeenCalledWith(
      expect.objectContaining({opencodeVersion: PINNED_VERSION, authJson: '{}', credential: 'provision'}),
      'ghs_test',
    )
    expect(result).toEqual({path: INSTALL_BINARY, version: PINNED_VERSION})
  })

  it('exports OPENCODE_PATH as an executable while PATH gets the directory', async () => {
    // #given a completed setup, which yields the install directory and the binary inside it
    const logger = createMockLogger()
    const setupAdapter = createSetupAdapter()

    // #when setup runs
    const result = await ensureOpenCodeAvailable(createEnsureOptions(logger), setupAdapter)

    // #then the two consumers get different halves. OPENCODE_PATH is read back as an executable by
    // @fro.bot/harness's resolveBinary() and by every child that inherits it; assigning the directory made them exec it.
    expect(setupAdapter.addToPath).toHaveBeenCalledWith(INSTALL_DIR)
    expect(process.env.OPENCODE_PATH).toBe(INSTALL_BINARY)
    expect(process.env.OPENCODE_PATH).not.toBe(INSTALL_DIR)
    expect(result.path).toBe(INSTALL_BINARY)
  })

  it('replaces a pre-set OPENCODE_PATH with the binary setup installed, and says so', async () => {
    // #given an operator override naming some other executable
    const logger = createMockLogger()
    process.env.OPENCODE_PATH = '/usr/local/bin/my-opencode'
    const setupAdapter = createSetupAdapter()

    // #when
    const result = await ensureOpenCodeAvailable(createEnsureOptions(logger), setupAdapter)

    // #then setup still ran, the Action uses its binary, and the replacement is visible in the log
    expect(setupAdapter.runSetup).toHaveBeenCalledTimes(1)
    expect(process.env.OPENCODE_PATH).toBe(INSTALL_BINARY)
    expect(result.path).toBe(INSTALL_BINARY)
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('OPENCODE_PATH points at a different binary'),
      expect.objectContaining({replacedPath: '/usr/local/bin/my-opencode', usedPath: INSTALL_BINARY}),
    )
  })

  it('does not warn when OPENCODE_PATH already names the binary setup installed', async () => {
    // #given a second invocation in the same job, which inherits the first one's export
    const logger = createMockLogger()
    process.env.OPENCODE_PATH = INSTALL_BINARY

    // #when
    await ensureOpenCodeAvailable(createEnsureOptions(logger), createSetupAdapter())

    // #then
    expect(logger.warning).not.toHaveBeenCalled()
  })

  it('throws when setup returns null, and exports nothing', async () => {
    // #given a setup that fails (it has already reported why)
    const logger = createMockLogger()
    const setupAdapter = {runSetup: vi.fn(async () => null), addToPath: vi.fn()}

    // #when / #then
    await expect(ensureOpenCodeAvailable(createEnsureOptions(logger), setupAdapter)).rejects.toThrow(
      'Auto-setup failed: runSetup returned null',
    )
    expect(process.env.OPENCODE_PATH).toBeUndefined()
    expect(setupAdapter.addToPath).not.toHaveBeenCalled()
  })
})
