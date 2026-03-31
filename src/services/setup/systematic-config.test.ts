import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {writeSystematicConfig} from './systematic-config.js'

describe('writeSystematicConfig', () => {
  let tmpDir: string
  let logger: Logger

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'systematic-config-test-'))
    logger = createMockLogger()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('creates config directory if it does not exist', async () => {
    // #given
    const configDir = path.join(tmpDir, 'nested', 'dir', 'opencode')
    const configJson = JSON.stringify({mode: 'strict'})

    // #when
    await writeSystematicConfig(configJson, configDir, logger)

    // #then
    const filePath = path.join(configDir, 'systematic.json')
    const content = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(content)).toEqual({mode: 'strict'})
  })

  it('writes config to systematic.json in configDir', async () => {
    // #given
    const configJson = JSON.stringify({agents: {default: 'sisyphus'}, mode: 'strict'})

    // #when
    await writeSystematicConfig(configJson, tmpDir, logger)

    // #then
    const filePath = path.join(tmpDir, 'systematic.json')
    const content = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(content)).toEqual({agents: {default: 'sisyphus'}, mode: 'strict'})
  })

  it('deep-merges with existing config, user values win', async () => {
    // #given
    const existingConfig = {mode: 'permissive', agents: {default: 'oracle', fallback: 'hephaestus'}}
    const filePath = path.join(tmpDir, 'systematic.json')
    await fs.writeFile(filePath, JSON.stringify(existingConfig))
    const userConfig = JSON.stringify({mode: 'strict', agents: {default: 'sisyphus'}})

    // #when
    await writeSystematicConfig(userConfig, tmpDir, logger)

    // #then
    const content = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(content)).toEqual({
      mode: 'strict',
      agents: {default: 'sisyphus', fallback: 'hephaestus'},
    })
  })

  it('throws on invalid JSON input', async () => {
    // #given
    const invalidJson = '{invalid json}'

    // #when / #then
    await expect(writeSystematicConfig(invalidJson, tmpDir, logger)).rejects.toThrow()
  })

  it('throws when input JSON is not an object', async () => {
    // #given
    const jsonNull = 'null'
    const jsonArray = '[1,2,3]'
    const jsonNumber = '42'

    // #when / #then
    await expect(writeSystematicConfig(jsonNull, tmpDir, logger)).rejects.toThrow(
      'systematic-config must be a JSON object (non-null, non-array)',
    )
    await expect(writeSystematicConfig(jsonArray, tmpDir, logger)).rejects.toThrow(
      'systematic-config must be a JSON object (non-null, non-array)',
    )
    await expect(writeSystematicConfig(jsonNumber, tmpDir, logger)).rejects.toThrow(
      'systematic-config must be a JSON object (non-null, non-array)',
    )
  })

  it('overwrites existing file when existing config is invalid JSON', async () => {
    // #given
    const filePath = path.join(tmpDir, 'systematic.json')
    await fs.writeFile(filePath, 'not valid json {{{')
    const userConfig = JSON.stringify({mode: 'strict'})

    // #when
    await writeSystematicConfig(userConfig, tmpDir, logger)

    // #then
    const content = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(content)).toEqual({mode: 'strict'})
  })
})
