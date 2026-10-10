import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  defaultOpenCodeConfigDir,
  normalizeTaskReuseGuardPlugins,
  noTaskReusePluginPath,
  noTaskReusePluginSpec,
  provisionTaskReuseGuard,
  writeNoTaskReuseFile,
} from './no-task-reuse-config.js'

describe('noTaskReusePluginPath / noTaskReusePluginSpec', () => {
  it('places the guard in <configDir>/fro-bot, a directory OpenCode does not auto-scan for plugins', () => {
    // #given a config dir
    const configDir = '/runner/home/.config/opencode'

    // #when
    const guardPath = noTaskReusePluginPath(configDir)

    // #then it is not under plugin/ or plugins/ (OpenCode auto-loads those, which would load it twice)
    expect(guardPath).toBe('/runner/home/.config/opencode/fro-bot/no-task-reuse.mjs')
    expect(guardPath).not.toMatch(/\/plugins?\//)
  })

  it('is an absolute file:// URL that round-trips to the path', () => {
    // #given
    const configDir = '/runner/home dir/.config/opencode'

    // #when
    const spec = noTaskReusePluginSpec(configDir)

    // #then the URL is escaped and decodes back to exactly the file the writer targets
    expect(spec.startsWith('file:///')).toBe(true)
    expect(fileURLToPath(spec)).toBe(noTaskReusePluginPath(configDir))
  })

  it('defaults the config dir to ~/.config/opencode', () => {
    // #given/#when/#then
    expect(defaultOpenCodeConfigDir({})).toBe(path.join(os.homedir(), '.config', 'opencode'))
  })

  it('follows XDG_CONFIG_HOME, the directory the server reads its global config from', () => {
    // #given a runner that relocates XDG_CONFIG_HOME (filterAgentEnv forwards XDG_* to the server)
    // #when/#then the guard is registered where the server looks, not under a hard-coded ~/.config
    expect(defaultOpenCodeConfigDir({XDG_CONFIG_HOME: '/srv/xdg'})).toBe('/srv/xdg/opencode')
  })

  it('ignores an empty XDG_CONFIG_HOME (GitHub Actions materializes unset env as an empty string)', () => {
    // #given/#when/#then
    expect(defaultOpenCodeConfigDir({XDG_CONFIG_HOME: '  '})).toBe(path.join(os.homedir(), '.config', 'opencode'))
  })
})

describe('normalizeTaskReuseGuardPlugins', () => {
  const GUARD = 'file:///cfg/fro-bot/no-task-reuse.mjs'

  it('removes string and tuple guard entries and appends exactly one bare spec last', () => {
    // #given guard entries leading, repeated and carrying options, around other plugins
    const logger = createMockLogger()

    // #when
    const result = normalizeTaskReuseGuardPlugins(
      [GUARD, 'a@1', [GUARD, {x: 1}], 'b@2', GUARD, ['c@3', {y: 2}]],
      GUARD,
      logger,
    )

    // #then unrelated entries (tuples included) keep their order and the guard closes the list
    expect(result).toEqual(['a@1', 'b@2', ['c@3', {y: 2}], GUARD])
  })

  it('warns only when a guard entry carried options', () => {
    // #given
    const quiet = createMockLogger()
    const loud = createMockLogger()

    // #when
    normalizeTaskReuseGuardPlugins([GUARD, GUARD], GUARD, quiet)
    normalizeTaskReuseGuardPlugins([[GUARD, {x: 1}]], GUARD, loud)

    // #then
    expect(quiet.warning).not.toHaveBeenCalled()
    expect(loud.warning).toHaveBeenCalledWith(expect.stringContaining('options for the task-reuse guard'))
  })

  it.each([undefined, null, 'a-plugin', {plugin: 1}])(
    'yields just the guard for a non-array plugin value %j',
    value => {
      // #given/#when/#then
      expect(normalizeTaskReuseGuardPlugins(value, GUARD, createMockLogger())).toEqual([GUARD])
    },
  )
})

describe('writeNoTaskReuseFile', () => {
  let tmpDir: string
  let logger: Logger

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-task-reuse-config-test-'))
    logger = createMockLogger()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  async function writeAsset(content: string): Promise<URL> {
    const assetPath = path.join(tmpDir, 'asset', 'no-task-reuse.js')
    await fs.mkdir(path.dirname(assetPath), {recursive: true})
    await fs.writeFile(assetPath, content)
    return pathToFileURL(assetPath)
  }

  it('copies the asset byte-for-byte to the path the config references, and returns that path', async () => {
    // #given a bundled asset and a config dir that does not exist yet
    const configDir = path.join(tmpDir, 'config')
    const content = 'export const rejectTaskReuse = () => {}\nexport default {id: "fro-bot.no-task-reuse"}\n'
    const assetUrl = await writeAsset(content)

    // #when
    const written = await writeNoTaskReuseFile(configDir, logger, () => assetUrl)

    // #then the file the config's file:// spec points at holds the asset's exact content
    expect(written).toBe(noTaskReusePluginPath(configDir))
    expect(await fs.readFile(fileURLToPath(noTaskReusePluginSpec(configDir)), 'utf8')).toBe(content)
  })

  it('overwrites a stale copy left by a restored cache', async () => {
    // #given a config dir that already holds an outdated guard
    const configDir = path.join(tmpDir, 'config')
    await fs.mkdir(path.dirname(noTaskReusePluginPath(configDir)), {recursive: true})
    await fs.writeFile(noTaskReusePluginPath(configDir), 'stale')
    const assetUrl = await writeAsset('fresh')

    // #when
    await writeNoTaskReuseFile(configDir, logger, () => assetUrl)

    // #then
    expect(await fs.readFile(noTaskReusePluginPath(configDir), 'utf8')).toBe('fresh')
  })

  it('throws, naming the asset, and writes nothing when the asset is missing (fail-closed)', async () => {
    // #given an asset URL that does not exist
    const configDir = path.join(tmpDir, 'config')
    const missing = pathToFileURL(path.join(tmpDir, 'asset', 'missing.js'))

    // #when/#then setup must fail rather than run without the guard
    await expect(writeNoTaskReuseFile(configDir, logger, () => missing)).rejects.toThrow(/task-reuse guard plugin/)
    await expect(fs.access(noTaskReusePluginPath(configDir))).rejects.toThrow()
  })
})

describe('provisionTaskReuseGuard', () => {
  let tmpDir: string
  let configDir: string
  let assetUrl: URL
  let logger: Logger

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provision-guard-test-'))
    configDir = path.join(tmpDir, 'config', 'opencode')
    const assetPath = path.join(tmpDir, 'asset', 'no-task-reuse.js')
    await fs.mkdir(path.dirname(assetPath), {recursive: true})
    await fs.writeFile(assetPath, 'export default {}\n')
    assetUrl = pathToFileURL(assetPath)
    logger = createMockLogger()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  const configPath = () => path.join(configDir, 'opencode.json')
  const readConfig = async () => JSON.parse(await fs.readFile(configPath(), 'utf8')) as Record<string, unknown>

  it('writes the plugin file and creates a config registering it when the runner has no OpenCode config at all', async () => {
    // #given a preinstalled-OpenCode runner: no config dir, no opencode.json (setup never ran)
    // #when
    await provisionTaskReuseGuard(configDir, logger, () => assetUrl)

    // #then both the file and its registration exist
    expect(await fs.readFile(noTaskReusePluginPath(configDir), 'utf8')).toBe('export default {}\n')
    expect(await readConfig()).toEqual({plugin: [noTaskReusePluginSpec(configDir)]})
  })

  it('preserves every other key and plugin of an existing config and appends the guard last', async () => {
    // #given an operator config
    await fs.mkdir(configDir, {recursive: true})
    await fs.writeFile(
      configPath(),
      JSON.stringify({model: 'x/y', permission: {bash: 'ask'}, plugin: ['a@1', ['b@2', {k: 1}]]}),
    )

    // #when
    await provisionTaskReuseGuard(configDir, logger, () => assetUrl)

    // #then
    expect(await readConfig()).toEqual({
      model: 'x/y',
      permission: {bash: 'ask'},
      plugin: ['a@1', ['b@2', {k: 1}], noTaskReusePluginSpec(configDir)],
    })
  })

  it('re-orders a guard-first list with duplicates and tuples to exactly one bare entry, last', async () => {
    // #given
    const spec = noTaskReusePluginSpec(configDir)
    await fs.mkdir(configDir, {recursive: true})
    await fs.writeFile(configPath(), JSON.stringify({plugin: [spec, 'a@1', [spec, {off: true}], spec, 'b@2']}))

    // #when
    await provisionTaskReuseGuard(configDir, logger, () => assetUrl)

    // #then
    expect((await readConfig()).plugin).toEqual(['a@1', 'b@2', spec])
  })

  it('replaces a non-array plugin value with the guard, with a warning', async () => {
    // #given
    await fs.mkdir(configDir, {recursive: true})
    await fs.writeFile(configPath(), JSON.stringify({plugin: 'not-a-list'}))

    // #when
    await provisionTaskReuseGuard(configDir, logger, () => assetUrl)

    // #then
    expect((await readConfig()).plugin).toEqual([noTaskReusePluginSpec(configDir)])
    expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('plugin must be an array'), expect.anything())
  })

  it('is idempotent: a second call leaves the config file untouched', async () => {
    // #given a provisioned runner
    await provisionTaskReuseGuard(configDir, logger, () => assetUrl)
    const before = await fs.stat(configPath())
    await new Promise(resolve => setTimeout(resolve, 20))

    // #when
    await provisionTaskReuseGuard(configDir, logger, () => assetUrl)

    // #then the file was not rewritten and no temp file lingers
    expect((await fs.stat(configPath())).mtimeMs).toBe(before.mtimeMs)
    expect((await fs.readdir(configDir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps the existing file mode when it rewrites the config', async () => {
    // #given an owner-only config (it may hold provider keys)
    await fs.mkdir(configDir, {recursive: true})
    await fs.writeFile(configPath(), JSON.stringify({plugin: []}), {mode: 0o600})
    await fs.chmod(configPath(), 0o600)

    // #when
    await provisionTaskReuseGuard(configDir, logger, () => assetUrl)

    // #then
    expect((await fs.stat(configPath())).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['is not valid JSON', '{not json'],
    ['is not a JSON object', '["a"]'],
  ])('throws and leaves the config untouched when opencode.json %s (fail-closed)', async (_label, contents) => {
    // #given a config OpenCode itself would discard
    await fs.mkdir(configDir, {recursive: true})
    await fs.writeFile(configPath(), contents)

    // #when/#then the run must fail rather than start an unguarded server or clobber the operator's file
    await expect(provisionTaskReuseGuard(configDir, logger, () => assetUrl)).rejects.toThrow(/task-reuse guard/)
    expect(await fs.readFile(configPath(), 'utf8')).toBe(contents)
  })

  it('throws, and writes no registration, when the plugin asset is missing (fail-closed)', async () => {
    // #given
    const missing = pathToFileURL(path.join(tmpDir, 'asset', 'missing.js'))

    // #when/#then
    await expect(provisionTaskReuseGuard(configDir, logger, () => missing)).rejects.toThrow(/task-reuse guard plugin/)
    await expect(fs.access(configPath())).rejects.toThrow()
  })
})
