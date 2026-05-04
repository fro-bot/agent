import type {Logger} from './types.js'
import {describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {buildCIConfig} from './ci-config.js'

function createLogger(): Logger {
  return createMockLogger()
}

describe('buildCIConfig', () => {
  describe('enabled mode (enableOmo: true)', () => {
    it('returns autoupdate baseline with systematic plugin when no user config', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0', enableOmo: true}, logger)

      // #then
      expect(result.error).toBeNull()
      expect(result.config).toEqual({autoupdate: false, plugin: ['@fro.bot/systematic@2.1.0']})
    })

    it('merges user config keys and appends systematic plugin', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {opencodeConfig: '{"model":"claude-opus-4-5","autoupdate":true}', systematicVersion: '2.1.0', enableOmo: true},
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      expect(result.config).toEqual({
        autoupdate: true,
        model: 'claude-opus-4-5',
        plugin: ['@fro.bot/systematic@2.1.0'],
      })
    })

    it('appends systematic plugin to existing plugin array', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {opencodeConfig: '{"plugin":["custom-plugin@1.0.0"]}', systematicVersion: '2.1.0', enableOmo: true},
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      expect(result.config).toEqual({
        autoupdate: false,
        plugin: ['custom-plugin@1.0.0', '@fro.bot/systematic@2.1.0'],
      })
    })

    it('does not duplicate systematic plugin when already present', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"plugin":["custom-plugin@1.0.0","@fro.bot/systematic@9.9.9"]}',
          systematicVersion: '2.1.0',
          enableOmo: true,
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      expect(result.config).toEqual({
        autoupdate: false,
        plugin: ['custom-plugin@1.0.0', '@fro.bot/systematic@9.9.9'],
      })
    })

    it('does not pin default_agent in enabled mode', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {opencodeConfig: '{"default_agent":"sisyphus"}', systematicVersion: '2.1.0', enableOmo: true},
        logger,
      )

      // #then - enabled mode preserves user agent
      expect(result.error).toBeNull()
      expect(result.config.default_agent).toBe('sisyphus')
    })

    it('preserves oh-my-openagent plugin in enabled mode', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"plugin":["custom-plugin@1.0.0","oh-my-openagent@3.7.4"]}',
          systematicVersion: '2.1.0',
          enableOmo: true,
        },
        logger,
      )

      // #then - oMo plugin kept in enabled mode
      expect(result.error).toBeNull()
      expect(result.config.plugin).toContain('oh-my-openagent@3.7.4')
    })
  })

  describe('disabled mode (enableOmo: false)', () => {
    it('returns autoupdate baseline with systematic plugin and pinned default_agent when no user config', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0', enableOmo: false}, logger)

      // #then
      expect(result.error).toBeNull()
      expect(result.config).toEqual({
        autoupdate: false,
        plugin: ['@fro.bot/systematic@2.1.0'],
        default_agent: 'build',
      })
    })

    it('pins default_agent to build even when user config sets sisyphus', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {opencodeConfig: '{"default_agent":"sisyphus"}', systematicVersion: '2.1.0', enableOmo: false},
        logger,
      )

      // #then - disabled mode pins build
      expect(result.error).toBeNull()
      expect(result.config.default_agent).toBe('build')
      expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('default_agent'))
    })

    it('pins default_agent to build over user-provided value even when user sets build explicitly', () => {
      // #given - user already set build; no rewrite warning about default_agent should fire
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {opencodeConfig: '{"default_agent":"build"}', systematicVersion: '2.1.0', enableOmo: false},
        logger,
      )

      // #then - safely idempotent
      expect(result.error).toBeNull()
      expect(result.config.default_agent).toBe('build')
    })

    it('strips oh-my-openagent bare entry from plugin array', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"plugin":["custom-plugin@1.0.0","oh-my-openagent"]}',
          systematicVersion: '2.1.0',
          enableOmo: false,
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      expect(result.config.plugin).toEqual(['custom-plugin@1.0.0', '@fro.bot/systematic@2.1.0'])
      expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('plugin'))
    })

    it('strips oh-my-openagent@latest from plugin array', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"plugin":["custom-plugin@1.0.0","oh-my-openagent@latest"]}',
          systematicVersion: '2.1.0',
          enableOmo: false,
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      expect(result.config.plugin).toEqual(['custom-plugin@1.0.0', '@fro.bot/systematic@2.1.0'])
      expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('plugin'))
    })

    it('strips oh-my-openagent@x.y.z from plugin array', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"plugin":["custom-plugin@1.0.0","oh-my-openagent@3.7.4"]}',
          systematicVersion: '2.1.0',
          enableOmo: false,
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      expect(result.config.plugin).toEqual(['custom-plugin@1.0.0', '@fro.bot/systematic@2.1.0'])
      expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('plugin'))
    })

    it('strips legacy plugins (plural) key containing oh-my-openagent', () => {
      // #given
      const logger = createLogger()

      // #when - legacy "plugins" with oMo entries
      const result = buildCIConfig(
        {
          opencodeConfig: '{"plugins":["oh-my-openagent@3.7.4","other-plugin@1.0.0"],"plugin":["custom@1.0.0"]}',
          systematicVersion: '2.1.0',
          enableOmo: false,
        },
        logger,
      )

      // #then - legacy plugins key is deleted entirely, primary plugin untouched for non-oMo entries
      expect(result.error).toBeNull()
      expect(result.config).not.toHaveProperty('plugins')
      expect(result.config.plugin).toContain('custom@1.0.0')
      expect(result.config.default_agent).toBe('build')
      expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('plugins'))
    })

    it('keeps unrelated plugin entries and strips only oh-my-openagent', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"plugin":["plugin-a@1.0.0","oh-my-openagent@3.7.4","plugin-b@2.0.0"]}',
          systematicVersion: '2.1.0',
          enableOmo: false,
        },
        logger,
      )

      // #then - only oMo removed
      expect(result.error).toBeNull()
      expect(result.config.plugin).toEqual(['plugin-a@1.0.0', 'plugin-b@2.0.0', '@fro.bot/systematic@2.1.0'])
      expect(result.config.default_agent).toBe('build')
    })

    it('emits single warning when multiple fields are rewritten', () => {
      // #given
      const logger = createLogger()

      // #when - user has both default_agent and oMo plugin
      const result = buildCIConfig(
        {
          opencodeConfig: '{"default_agent":"sisyphus","plugin":["oh-my-openagent@3.7.4","tool@1.0.0"]}',
          systematicVersion: '2.1.0',
          enableOmo: false,
        },
        logger,
      )

      // #then - one warning naming all rewritten fields
      expect(result.error).toBeNull()
      // Two warning calls: one from rewritten fields, one from debug logging
      const warningCalls = (logger.warning as ReturnType<typeof import('vitest').vi.fn>).mock.calls
      const rewriteWarning = warningCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('OpenCode config rewritten'),
      )
      expect(rewriteWarning).toBeDefined()
      expect(rewriteWarning![0]).toContain('plugin')
      expect(rewriteWarning![0]).toContain('default_agent')
      expect(rewriteWarning![0]).toContain('enable-omo: false')
    })

    it('does not emit rewrite warning when no user config changes needed', () => {
      // #given - user provides no config at all
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0', enableOmo: false}, logger)

      // #then - default_agent pinned but no user value was overridden, so no rewrite warning
      expect(result.error).toBeNull()
      expect(result.config.default_agent).toBe('build')
      // No warning about rewriting because default_agent wasn't user-provided
      const warningCalls = (logger.warning as ReturnType<typeof import('vitest').vi.fn>).mock.calls
      const rewriteWarning = warningCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('OpenCode config rewritten'),
      )
      expect(rewriteWarning).toBeUndefined()
    })

    it('appends systematic plugin even when no user config', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0', enableOmo: false}, logger)

      // #then
      expect(result.error).toBeNull()
      expect(result.config.plugin).toContain('@fro.bot/systematic@2.1.0')
    })
  })

  describe('error handling', () => {
    it('returns error for invalid JSON', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {opencodeConfig: '{invalid-json}', systematicVersion: '2.1.0', enableOmo: false},
        logger,
      )

      // #then
      expect(result.error).toBe('opencode-config must be valid JSON')
    })

    it('returns error for non-object JSON values', () => {
      // #given
      const logger = createLogger()

      // #when
      const nullResult = buildCIConfig({opencodeConfig: 'null', systematicVersion: '2.1.0', enableOmo: false}, logger)
      const arrayResult = buildCIConfig(
        {opencodeConfig: '[1,2,3]', systematicVersion: '2.1.0', enableOmo: false},
        logger,
      )
      const numberResult = buildCIConfig({opencodeConfig: '42', systematicVersion: '2.1.0', enableOmo: false}, logger)
      const stringResult = buildCIConfig(
        {opencodeConfig: '"hello"', systematicVersion: '2.1.0', enableOmo: false},
        logger,
      )

      // #then
      expect(nullResult.error).toBe('opencode-config must be a JSON object')
      expect(arrayResult.error).toBe('opencode-config must be a JSON object')
      expect(numberResult.error).toBe('opencode-config must be a JSON object')
      expect(stringResult.error).toBe('opencode-config must be a JSON object')
    })
  })
})
