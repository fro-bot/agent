import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {writeSessionToolsFile} from './session-tools-config.js'

describe('writeSessionToolsFile', () => {
  let tmpDir: string
  let logger: Logger

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-tools-config-test-'))
    logger = createMockLogger()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('copies the asset to <configDir>/tool/session.js', async () => {
    // #given
    const configDir = path.join(tmpDir, 'config')
    const assetDir = path.join(tmpDir, 'asset')
    await fs.mkdir(assetDir, {recursive: true})
    const assetPath = path.join(assetDir, 'session-tools.js')
    const assetContent = 'export const list = () => {}\nexport const read = () => {}\n'
    await fs.writeFile(assetPath, assetContent)

    // #when
    await writeSessionToolsFile(configDir, logger, () => new URL(`file://${assetPath}`))

    // #then
    const written = await fs.readFile(path.join(configDir, 'tool', 'session.js'), 'utf8')
    expect(written).toBe(assetContent)
  })

  it('creates the tool directory if it does not exist', async () => {
    // #given
    const configDir = path.join(tmpDir, 'nested', 'config')
    const assetDir = path.join(tmpDir, 'asset')
    await fs.mkdir(assetDir, {recursive: true})
    const assetPath = path.join(assetDir, 'session-tools.js')
    await fs.writeFile(assetPath, 'export const list = () => {}\n')

    // #when
    await writeSessionToolsFile(configDir, logger, () => new URL(`file://${assetPath}`))

    // #then
    const written = await fs.readFile(path.join(configDir, 'tool', 'session.js'), 'utf8')
    expect(written).toBe('export const list = () => {}\n')
  })

  it('warns and returns without throwing when the asset is missing', async () => {
    // #given
    const configDir = path.join(tmpDir, 'config')
    const missingAssetPath = path.join(tmpDir, 'does-not-exist', 'session-tools.js')

    // #when
    await expect(
      writeSessionToolsFile(configDir, logger, () => new URL(`file://${missingAssetPath}`)),
    ).resolves.toBeUndefined()

    // #then
    expect(vi.mocked(logger.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Session tools asset unavailable') as string,
      expect.objectContaining({path: expect.stringContaining('does-not-exist') as string}) as Record<string, unknown>,
    )
    await expect(fs.access(path.join(configDir, 'tool', 'session.js'))).rejects.toThrow()
  })

  it('overwrites an existing session.js file', async () => {
    // #given
    const configDir = path.join(tmpDir, 'config')
    const toolDir = path.join(configDir, 'tool')
    await fs.mkdir(toolDir, {recursive: true})
    await fs.writeFile(path.join(toolDir, 'session.js'), 'export const list = () => "stale"\n')

    const assetDir = path.join(tmpDir, 'asset')
    await fs.mkdir(assetDir, {recursive: true})
    const assetPath = path.join(assetDir, 'session-tools.js')
    const freshContent = 'export const list = () => "fresh"\n'
    await fs.writeFile(assetPath, freshContent)

    // #when
    await writeSessionToolsFile(configDir, logger, () => new URL(`file://${assetPath}`))

    // #then
    const written = await fs.readFile(path.join(toolDir, 'session.js'), 'utf8')
    expect(written).toBe(freshContent)
  })
})
