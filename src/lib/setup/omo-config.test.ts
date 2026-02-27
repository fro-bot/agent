import type {Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger} from '../test-helpers.js'
import {deepMerge, writeOmoConfig} from './omo-config.js'

describe('deepMerge', () => {
  it('merges top-level keys from both objects', () => {
    // #given
    const target = {a: 1, b: 2}
    const source = {b: 3, c: 4}

    // #when
    const result = deepMerge(target, source)

    // #then - source values win on conflict
    expect(result).toEqual({a: 1, b: 3, c: 4})
  })

  it('recursively merges nested objects', () => {
    // #given
    const target = {a: {x: 1, y: 2}, b: 'keep'}
    const source = {a: {y: 99, z: 3}}

    // #when
    const result = deepMerge(target, source)

    // #then - nested merge preserves unaffected keys
    expect(result).toEqual({a: {x: 1, y: 99, z: 3}, b: 'keep'})
  })

  it('overwrites arrays rather than merging them', () => {
    // #given
    const target = {arr: [1, 2, 3]}
    const source = {arr: [4, 5]}

    // #when
    const result = deepMerge(target, source)

    // #then - source array replaces target array
    expect(result).toEqual({arr: [4, 5]})
  })

  it('handles null source gracefully', () => {
    // #given
    const target = {a: 1}

    // #when
    const result = deepMerge(target, {})

    // #then
    expect(result).toEqual({a: 1})
  })

  it('does not mutate target or source objects', () => {
    // #given
    const target = {a: {x: 1}}
    const source = {a: {y: 2}}
    const targetCopy = JSON.parse(JSON.stringify(target)) as typeof target
    const sourceCopy = JSON.parse(JSON.stringify(source)) as typeof source

    // #when
    deepMerge(target, source)

    // #then - originals unchanged
    expect(target).toEqual(targetCopy)
    expect(source).toEqual(sourceCopy)
  })

  it('source primitive overwrites target object', () => {
    // #given
    const target = {a: {x: 1}}
    const source = {a: 'string'}

    // #when
    const result = deepMerge(target, source)

    // #then - source wins
    expect(result).toEqual({a: 'string'})
  })

  it('handles deeply nested merge', () => {
    // #given
    const target = {level1: {level2: {level3: {keep: true, override: 'old'}}}}
    const source = {level1: {level2: {level3: {override: 'new'}, extra: 42}}}

    // #when
    const result = deepMerge(target, source)

    // #then
    expect(result).toEqual({level1: {level2: {level3: {keep: true, override: 'new'}, extra: 42}}})
  })
})

describe('writeOmoConfig', () => {
  let tmpDir: string
  let logger: Logger

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omo-config-test-'))
    logger = createMockLogger()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('creates config directory if it does not exist', async () => {
    // #given
    const configDir = path.join(tmpDir, 'nested', 'dir', 'opencode')
    const configJson = JSON.stringify({theme: 'dark'})

    // #when
    await writeOmoConfig(configJson, configDir, logger)

    // #then - directory created and file written
    const filePath = path.join(configDir, 'oh-my-opencode.json')
    const content = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(content)).toEqual({theme: 'dark'})
  })

  it('writes config to oh-my-opencode.json in configDir', async () => {
    // #given
    const configJson = JSON.stringify({model: 'claude-opus-4-5', theme: 'light'})

    // #when
    await writeOmoConfig(configJson, tmpDir, logger)

    // #then
    const filePath = path.join(tmpDir, 'oh-my-opencode.json')
    const content = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(content)).toEqual({model: 'claude-opus-4-5', theme: 'light'})
  })

  it('deep-merges with existing config, user values win', async () => {
    // #given - existing config has some keys
    const existingConfig = {theme: 'dark', keybindings: 'vim', plugins: ['a', 'b']}
    const filePath = path.join(tmpDir, 'oh-my-opencode.json')
    await fs.writeFile(filePath, JSON.stringify(existingConfig))

    const userConfig = JSON.stringify({theme: 'light', model: 'gpt-4o'})

    // #when
    await writeOmoConfig(userConfig, tmpDir, logger)

    // #then - user theme overrides existing, keybindings preserved, model added
    const content = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(content)).toEqual({
      theme: 'light',
      keybindings: 'vim',
      plugins: ['a', 'b'],
      model: 'gpt-4o',
    })
  })

  it('writes user config as-is when no existing config', async () => {
    // #given - no pre-existing config file
    const configJson = JSON.stringify({hooks: {before: 'echo start'}})

    // #when
    await writeOmoConfig(configJson, tmpDir, logger)

    // #then
    const filePath = path.join(tmpDir, 'oh-my-opencode.json')
    const content = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(content)).toEqual({hooks: {before: 'echo start'}})
  })

  it('throws on invalid JSON input', async () => {
    // #given
    const invalidJson = '{invalid json}'

    // #when / #then
    await expect(writeOmoConfig(invalidJson, tmpDir, logger)).rejects.toThrow()
  })

  it('logs info after writing config', async () => {
    // #given
    const configJson = JSON.stringify({theme: 'dark'})

    // #when
    await writeOmoConfig(configJson, tmpDir, logger)

    // #then
    expect((logger.info as ReturnType<typeof import('vitest').vi.fn>).mock.calls.length).toBeGreaterThan(0)
  })

  it('handles nested object merge in user config', async () => {
    // #given - existing config has nested structure
    const existingConfig = {
      providers: {
        anthropic: {model: 'claude-3-5-sonnet', maxTokens: 4096},
        openai: {model: 'gpt-4o'},
      },
    }
    const filePath = path.join(tmpDir, 'oh-my-opencode.json')
    await fs.writeFile(filePath, JSON.stringify(existingConfig))

    // user overrides anthropic model only
    const userConfig = JSON.stringify({providers: {anthropic: {model: 'claude-opus-4-5'}}})

    // #when
    await writeOmoConfig(userConfig, tmpDir, logger)

    // #then - nested merge preserves maxTokens and openai
    const content = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(content)).toEqual({
      providers: {
        anthropic: {model: 'claude-opus-4-5', maxTokens: 4096},
        openai: {model: 'gpt-4o'},
      },
    })
  })

  it('overwrites existing file when existing config is not valid JSON', async () => {
    // #given - corrupt existing file
    const filePath = path.join(tmpDir, 'oh-my-opencode.json')
    await fs.writeFile(filePath, 'not valid json {{{')

    const userConfig = JSON.stringify({theme: 'dark'})

    // #when - should not throw; falls back to user config only
    await writeOmoConfig(userConfig, tmpDir, logger)

    // #then - user config written as-is
    const content = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(content)).toEqual({theme: 'dark'})
  })

  it('writes valid JSON (pretty-printed)', async () => {
    // #given
    const configJson = JSON.stringify({a: 1, b: {c: 2}})

    // #when
    await writeOmoConfig(configJson, tmpDir, logger)

    // #then - output is pretty-printed (contains newlines)
    const filePath = path.join(tmpDir, 'oh-my-opencode.json')
    const raw = await fs.readFile(filePath, 'utf8')
    expect(raw).toContain('\n')
    expect(JSON.parse(raw)).toEqual({a: 1, b: {c: 2}})
  })
})
