import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  defaultOpenCodeConfigDir,
  noTaskReusePluginPath,
  noTaskReusePluginSpec,
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
    expect(defaultOpenCodeConfigDir()).toBe(path.join(os.homedir(), '.config', 'opencode'))
  })
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
