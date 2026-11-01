import type {ExecAdapter} from './types.js'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DEFAULT_SYSTEMATIC_VERSION, FRO_BOT_PLUGIN_PACKAGE, FRO_BOT_PLUGIN_VERSION} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  arePluginsCachedV2,
  installPluginsV2,
  PLUGIN_INSTALL_TIMEOUT_MS,
  pluginCacheDir,
  resolvePluginSpecsV2,
} from './plugin-install-v2.js'

const SYSTEMATIC_SPEC = `@fro.bot/systematic@${DEFAULT_SYSTEMATIC_VERSION}`
const FRO_BOT_SPEC = `${FRO_BOT_PLUGIN_PACKAGE}@${FRO_BOT_PLUGIN_VERSION}`
const SPECS = [SYSTEMATIC_SPEC, FRO_BOT_SPEC] as const

type ExecCall = Parameters<NonNullable<ExecAdapter['execWithTimeout']>>

describe('resolvePluginSpecsV2', () => {
  it('resolves "latest" and an empty input to the pinned version and pins the fro.bot plugin', () => {
    const expected = {specs: SPECS, systematicVersion: DEFAULT_SYSTEMATIC_VERSION}
    expect(resolvePluginSpecsV2('latest')).toEqual({success: true, data: expected})
    expect(resolvePluginSpecsV2('  ')).toEqual({success: true, data: expected})
  })

  it('keeps an exact version', () => {
    expect(resolvePluginSpecsV2('3.27.1')).toEqual({
      success: true,
      data: {specs: ['@fro.bot/systematic@3.27.1', FRO_BOT_SPEC], systematicVersion: '3.27.1'},
    })
  })

  it.each(['^3.27.0', '~3.27', '3.x', 'next', '3.27.0-rc.1', 'git+https://example.test/x.git', '../x'])(
    'rejects %j with a named error',
    input => {
      const result = resolvePluginSpecsV2(input)

      expect(result).toMatchObject({success: false, error: {kind: 'invalid-version'}})
    },
  )
})

/** A fake `opencode plugin add` that fills the cache like the real one and writes the global config it writes. */
function fakeOpenCode(behaviour: {readonly emptyCache?: boolean} = {}): {
  readonly adapter: ExecAdapter
  readonly calls: ExecCall[]
} {
  const calls: ExecCall[] = []
  const execWithTimeout = vi.fn<NonNullable<ExecAdapter['execWithTimeout']>>(async (...call) => {
    calls.push(call)
    const env = call[3]?.env ?? {}
    const spec = call[1]?.[2] ?? ''
    const cache = pluginCacheDir(env.XDG_CACHE_HOME ?? '', spec)
    await mkdir(cache, {recursive: true})
    if (behaviour.emptyCache !== true) await writeFile(join(cache, 'package.json'), '{}')
    const globalConfig = join(env.XDG_CONFIG_HOME ?? '', 'opencode')
    await mkdir(globalConfig, {recursive: true})
    await writeFile(join(globalConfig, 'opencode.json'), JSON.stringify({plugins: [spec]}))
    return 0
  })
  return {adapter: {exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()}, calls}
}

describe('installPluginsV2', () => {
  let root: string
  let cacheHome: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'plugin-install-v2-test-'))
    cacheHome = join(root, 'cache')
    await mkdir(cacheHome, {recursive: true})
  })

  afterEach(async () => {
    await rm(root, {recursive: true, force: true})
  })

  it('installs each spec with plugin add under the 420 s bound', async () => {
    // #given
    const {adapter, calls} = fakeOpenCode()

    // #when
    const result = await installPluginsV2({
      logger: createMockLogger(),
      execAdapter: adapter,
      opencodeBinaryPath: '/cached/opencode',
      specs: SPECS,
      cacheHome,
      env: {PATH: '/usr/bin'},
    })

    // #then
    expect(result.success).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls.map(call => call[0])).toEqual(['/cached/opencode', '/cached/opencode'])
    expect(calls.map(call => call[1])).toEqual([
      ['plugin', 'add', SYSTEMATIC_SPEC],
      ['plugin', 'add', FRO_BOT_SPEC],
    ])
    expect(calls.map(call => call[2])).toEqual([PLUGIN_INSTALL_TIMEOUT_MS, PLUGIN_INSTALL_TIMEOUT_MS])
    expect(PLUGIN_INSTALL_TIMEOUT_MS).toBe(420_000)
    expect(await arePluginsCachedV2(cacheHome, SPECS)).toBe(true)
  })

  it('runs the child with a scrubbed environment and isolated config, data and database', async () => {
    // #given a parent environment full of secrets
    const {adapter, calls} = fakeOpenCode()
    const parentEnv = {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ghs_SECRET',
      ANTHROPIC_API_KEY: 'sk-ant-SECRET',
      AWS_SECRET_ACCESS_KEY: 'aws-SECRET',
      INPUT_AUTH_JSON: '{"anthropic":{"type":"api","key":"sk-ant-SECRET"}}',
      NPM_CONFIG_TOKEN: 'npm-SECRET',
      XDG_CONFIG_HOME: '/real/config',
      XDG_DATA_HOME: '/real/data',
    }

    // #when
    await installPluginsV2({
      logger: createMockLogger(),
      execAdapter: adapter,
      opencodeBinaryPath: '/cached/opencode',
      specs: [SYSTEMATIC_SPEC],
      cacheHome,
      env: parentEnv,
    })

    // #then
    const env = calls[0]?.[3]?.env ?? {}
    expect(JSON.stringify(env)).not.toContain('SECRET')
    expect(env.XDG_CACHE_HOME).toBe(cacheHome)
    expect(env.XDG_CONFIG_HOME).not.toBe('/real/config')
    expect(env.XDG_DATA_HOME).not.toBe('/real/data')
    expect(env.OPENCODE_DB).toBeDefined()
    expect(env.OPENCODE_DB?.startsWith(join(tmpdir(), 'fro-bot-plugin-install-'))).toBe(true)
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify({plugins: []}))
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    expect(calls[0]?.[3]?.cwd?.startsWith(join(tmpdir(), 'fro-bot-plugin-install-'))).toBe(true)
  })

  it('leaves no global opencode.json behind: the write plugin add makes lands in a directory that is removed', async () => {
    // #given
    const {adapter, calls} = fakeOpenCode()

    // #when
    await installPluginsV2({
      logger: createMockLogger(),
      execAdapter: adapter,
      opencodeBinaryPath: '/cached/opencode',
      specs: [SYSTEMATIC_SPEC],
      cacheHome,
      env: {PATH: '/usr/bin'},
    })

    // #then the global config the fake wrote is gone with its throwaway root, and the cache stays
    const configHome = calls[0]?.[3]?.env?.XDG_CONFIG_HOME ?? ''
    await expect(stat(join(configHome, 'opencode', 'opencode.json'))).rejects.toMatchObject({code: 'ENOENT'})
    expect(await readFile(join(pluginCacheDir(cacheHome, SYSTEMATIC_SPEC), 'package.json'), 'utf8')).toBe('{}')
  })

  it('fails with a named timeout error when an install runs past its bound, and installs nothing after it', async () => {
    // #given a registry that never answers
    const execWithTimeout = vi.fn<NonNullable<ExecAdapter['execWithTimeout']>>(async () => 'timed-out')
    const logger = createMockLogger()

    // #when
    const result = await installPluginsV2({
      logger,
      execAdapter: {exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()},
      opencodeBinaryPath: '/cached/opencode',
      specs: SPECS,
      cacheHome,
      env: {PATH: '/usr/bin'},
    })

    // #then
    expect(result).toMatchObject({success: false, error: {kind: 'install-timeout', spec: SYSTEMATIC_SPEC}})
    expect(execWithTimeout).toHaveBeenCalledTimes(1)
    expect(logger.warning).toHaveBeenCalledWith(
      'OpenCode V2 plugin install timed out',
      expect.objectContaining({spec: SYSTEMATIC_SPEC, timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS}),
    )
  })

  it('bounds an adapter without a timeout seam by racing the exec against a timer', async () => {
    // #given an exec that never settles
    const exec = vi.fn<ExecAdapter['exec']>(async () => new Promise<number>(() => undefined))

    // #when
    const result = await installPluginsV2({
      logger: createMockLogger(),
      execAdapter: {exec, getExecOutput: vi.fn()},
      opencodeBinaryPath: '/cached/opencode',
      specs: [FRO_BOT_SPEC],
      cacheHome,
      timeoutMs: 50,
      env: {PATH: '/usr/bin'},
    })

    // #then
    expect(result).toMatchObject({success: false, error: {kind: 'install-timeout', spec: FRO_BOT_SPEC}})
  })

  it('fails with a named error on a non-zero exit', async () => {
    const execWithTimeout = vi.fn<NonNullable<ExecAdapter['execWithTimeout']>>(async () => 1)

    const result = await installPluginsV2({
      logger: createMockLogger(),
      execAdapter: {exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()},
      opencodeBinaryPath: '/cached/opencode',
      specs: SPECS,
      cacheHome,
      env: {PATH: '/usr/bin'},
    })

    expect(result).toMatchObject({success: false, error: {kind: 'install-failed', spec: SYSTEMATIC_SPEC}})
  })

  it('fails with a named error when the exec itself throws, without forwarding the throw into the result', async () => {
    const execWithTimeout = vi.fn<NonNullable<ExecAdapter['execWithTimeout']>>(async () => {
      throw new Error('spawn /cached/opencode ENOENT token=SECRET')
    })

    const result = await installPluginsV2({
      logger: createMockLogger(),
      execAdapter: {exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()},
      opencodeBinaryPath: '/cached/opencode',
      specs: [SYSTEMATIC_SPEC],
      cacheHome,
      env: {PATH: '/usr/bin'},
    })

    expect(result).toMatchObject({success: false, error: {kind: 'install-failed'}})
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('fails when a zero exit leaves an empty cache directory', async () => {
    const {adapter} = fakeOpenCode({emptyCache: true})

    const result = await installPluginsV2({
      logger: createMockLogger(),
      execAdapter: adapter,
      opencodeBinaryPath: '/cached/opencode',
      specs: SPECS,
      cacheHome,
      env: {PATH: '/usr/bin'},
    })

    expect(result).toMatchObject({success: false, error: {kind: 'cache-empty', spec: SYSTEMATIC_SPEC}})
  })

  it('fails when a zero exit leaves no cache directory at all', async () => {
    const execWithTimeout = vi.fn<NonNullable<ExecAdapter['execWithTimeout']>>(async () => 0)

    const result = await installPluginsV2({
      logger: createMockLogger(),
      execAdapter: {exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()},
      opencodeBinaryPath: '/cached/opencode',
      specs: [FRO_BOT_SPEC],
      cacheHome,
      env: {PATH: '/usr/bin'},
    })

    expect(result).toMatchObject({success: false, error: {kind: 'cache-empty', spec: FRO_BOT_SPEC}})
  })

  it.each(['@fro.bot/systematic@^3.0.0', '@fro.bot/systematic@latest', '@fro.bot/systematic', 'left-pad@1.0.0'])(
    'refuses the non-exact spec %j before running anything',
    async spec => {
      const execWithTimeout = vi.fn<NonNullable<ExecAdapter['execWithTimeout']>>(async () => 0)

      const result = await installPluginsV2({
        logger: createMockLogger(),
        execAdapter: {exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()},
        opencodeBinaryPath: '/cached/opencode',
        specs: [spec],
        cacheHome,
        env: {PATH: '/usr/bin'},
      })

      expect(result).toMatchObject({success: false, error: {kind: 'invalid-version'}})
      expect(execWithTimeout).not.toHaveBeenCalled()
    },
  )
})

describe('arePluginsCachedV2', () => {
  it('is false for a missing or empty cache directory and true once every spec is populated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-cached-v2-test-'))
    try {
      expect(await arePluginsCachedV2(root, SPECS)).toBe(false)
      await mkdir(pluginCacheDir(root, SYSTEMATIC_SPEC), {recursive: true})
      await mkdir(pluginCacheDir(root, FRO_BOT_SPEC), {recursive: true})
      expect(await arePluginsCachedV2(root, SPECS)).toBe(false)
      await writeFile(join(pluginCacheDir(root, SYSTEMATIC_SPEC), 'a'), '')
      expect(await arePluginsCachedV2(root, SPECS)).toBe(false)
      await writeFile(join(pluginCacheDir(root, FRO_BOT_SPEC), 'a'), '')
      expect(await arePluginsCachedV2(root, SPECS)).toBe(true)
    } finally {
      await rm(root, {recursive: true, force: true})
    }
  })
})
