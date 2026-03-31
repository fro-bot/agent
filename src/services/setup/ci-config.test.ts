import type {Logger} from './types.js'
import {describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {buildCIConfig} from './ci-config.js'

function createLogger(): Logger {
  return createMockLogger()
}

describe('buildCIConfig', () => {
  it('returns autoupdate baseline with systematic plugin when no user config', () => {
    // #given
    const logger = createLogger()

    // #when
    const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

    // #then
    expect(result.error).toBeNull()
    expect(result.config).toEqual({autoupdate: false, plugins: ['@fro.bot/systematic@2.1.0']})
  })

  it('merges user config keys and appends systematic plugin', () => {
    // #given
    const logger = createLogger()

    // #when
    const result = buildCIConfig(
      {opencodeConfig: '{"model":"claude-opus-4-5","autoupdate":true}', systematicVersion: '2.1.0'},
      logger,
    )

    // #then
    expect(result.error).toBeNull()
    expect(result.config).toEqual({
      autoupdate: true,
      model: 'claude-opus-4-5',
      plugins: ['@fro.bot/systematic@2.1.0'],
    })
  })

  it('appends systematic plugin to existing plugins array', () => {
    // #given
    const logger = createLogger()

    // #when
    const result = buildCIConfig(
      {opencodeConfig: '{"plugins":["custom-plugin@1.0.0"]}', systematicVersion: '2.1.0'},
      logger,
    )

    // #then
    expect(result.error).toBeNull()
    expect(result.config).toEqual({
      autoupdate: false,
      plugins: ['custom-plugin@1.0.0', '@fro.bot/systematic@2.1.0'],
    })
  })

  it('does not duplicate systematic plugin when already present', () => {
    // #given
    const logger = createLogger()

    // #when
    const result = buildCIConfig(
      {
        opencodeConfig: '{"plugins":["custom-plugin@1.0.0","@fro.bot/systematic@9.9.9"]}',
        systematicVersion: '2.1.0',
      },
      logger,
    )

    // #then
    expect(result.error).toBeNull()
    expect(result.config).toEqual({
      autoupdate: false,
      plugins: ['custom-plugin@1.0.0', '@fro.bot/systematic@9.9.9'],
    })
  })

  it('returns error for invalid JSON', () => {
    // #given
    const logger = createLogger()

    // #when
    const result = buildCIConfig({opencodeConfig: '{invalid-json}', systematicVersion: '2.1.0'}, logger)

    // #then
    expect(result.error).toBe('opencode-config must be valid JSON')
  })

  it('returns error for non-object JSON values', () => {
    // #given
    const logger = createLogger()

    // #when
    const nullResult = buildCIConfig({opencodeConfig: 'null', systematicVersion: '2.1.0'}, logger)
    const arrayResult = buildCIConfig({opencodeConfig: '[1,2,3]', systematicVersion: '2.1.0'}, logger)
    const numberResult = buildCIConfig({opencodeConfig: '42', systematicVersion: '2.1.0'}, logger)
    const stringResult = buildCIConfig({opencodeConfig: '"hello"', systematicVersion: '2.1.0'}, logger)

    // #then
    expect(nullResult.error).toBe('opencode-config must be a JSON object')
    expect(arrayResult.error).toBe('opencode-config must be a JSON object')
    expect(numberResult.error).toBe('opencode-config must be a JSON object')
    expect(stringResult.error).toBe('opencode-config must be a JSON object')
  })
})
