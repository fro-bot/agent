import type {Logger} from './types.js'
import {describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {buildCIConfig, pluginPrefix} from './ci-config.js'

function createLogger(): Logger {
  return createMockLogger()
}

describe('buildCIConfig', () => {
  describe('pluginPrefix', () => {
    it('strips version suffix from scoped package names', () => {
      expect(pluginPrefix('@scope/name@1.0.0')).toBe('@scope/name')
    })

    it('strips version suffix from unscoped package names', () => {
      expect(pluginPrefix('name@1.0.0')).toBe('name')
    })
  })

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
        agent: {
          build: {
            permission: {
              external_directory: 'deny',
            },
          },
        },
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

    it('denies external directory access for the build agent so disabled mode cannot block on permission prompts', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0', enableOmo: false}, logger)

      // #then
      expect(result.error).toBeNull()
      expect(result.config).toMatchObject({
        agent: {
          build: {
            permission: {
              external_directory: 'deny',
            },
          },
        },
      })
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

  describe('slim mode (enableOmoSlim: true)', () => {
    it('includes oh-my-opencode-slim plugin and systematic in plugin array', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: null,
          systematicVersion: '2.1.0',
          enableOmo: false,
          enableOmoSlim: true,
          omoSlimVersion: '1.1.1',
          omoSlimPreset: 'openai',
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      const plugins = result.config.plugin as string[]
      expect(plugins).toContain('oh-my-opencode-slim@1.1.1')
      expect(plugins.filter(p => p.startsWith('@fro.bot/systematic'))).toHaveLength(1)
    })

    it('pins default_agent to orchestrator unconditionally', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"default_agent":"build"}',
          systematicVersion: '2.1.0',
          enableOmo: false,
          enableOmoSlim: true,
          omoSlimVersion: '1.1.1',
          omoSlimPreset: 'openai',
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      expect(result.config.default_agent).toBe('orchestrator')
    })

    it('does NOT deny external_directory for build agent in slim mode', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: null,
          systematicVersion: '2.1.0',
          enableOmo: false,
          enableOmoSlim: true,
          omoSlimVersion: '1.1.1',
          omoSlimPreset: 'openai',
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      // external_directory deny should NOT be set in slim mode
      const agent = result.config.agent as Record<string, unknown> | undefined
      const build = (agent?.build ?? {}) as Record<string, unknown>
      const permission = (build.permission ?? {}) as Record<string, unknown>
      expect(permission.external_directory).not.toBe('deny')
    })

    it('does NOT include oh-my-openagent in slim mode', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: null,
          systematicVersion: '2.1.0',
          enableOmo: false,
          enableOmoSlim: true,
          omoSlimVersion: '1.1.1',
          omoSlimPreset: 'openai',
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      const plugins = result.config.plugin as string[]
      expect(plugins.every(p => !p.startsWith('oh-my-openagent'))).toBe(true)
    })

    it('strips pre-existing oh-my-openagent from opencodeConfig in slim mode (cache restore edge case)', () => {
      // #given - config pre-seeded with OMO entry from cache restore
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"plugin":["oh-my-openagent@3.0.0"]}',
          systematicVersion: '2.1.0',
          enableOmo: false,
          enableOmoSlim: true,
          omoSlimVersion: '1.1.1',
          omoSlimPreset: 'openai',
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      const plugins = result.config.plugin as string[]
      expect(plugins.every(p => !p.startsWith('oh-my-openagent'))).toBe(true)
      expect(plugins).toContain('oh-my-opencode-slim@1.1.1')
    })

    it('includes opencode-go preset in slim plugin specifier', () => {
      // #given
      const logger = createLogger()

      // #when - preset doesn't affect the plugin specifier, but verifies we pass through
      const result = buildCIConfig(
        {
          opencodeConfig: null,
          systematicVersion: '2.1.0',
          enableOmo: false,
          enableOmoSlim: true,
          omoSlimVersion: '1.1.1',
          omoSlimPreset: 'opencode-go',
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      const plugins = result.config.plugin as string[]
      expect(plugins).toContain('oh-my-opencode-slim@1.1.1')
      expect(result.config.default_agent).toBe('orchestrator')
    })
  })

  describe('dual-plugin guard', () => {
    it('returns error when both oh-my-openagent and oh-my-opencode-slim would be present', () => {
      // #given - opencodeConfig has both OMO and slim
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"plugin":["oh-my-openagent@3.0.0","oh-my-opencode-slim@1.1.1"]}',
          systematicVersion: '2.1.0',
          enableOmo: true,
          enableOmoSlim: false,
          omoSlimVersion: '1.1.1',
          omoSlimPreset: 'openai',
        },
        logger,
      )

      // #then
      expect(result.error).toBe('oMo and OMO Slim plugins cannot both be present')
    })
  })

  describe('R19 version-gated allowlist', () => {
    it('returns error for unverified omoSlimVersion in slim mode', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: null,
          systematicVersion: '2.1.0',
          enableOmo: false,
          enableOmoSlim: true,
          omoSlimVersion: '9.9.9',
          omoSlimPreset: 'openai',
        },
        logger,
      )

      // #then
      expect(result.error).toContain('9.9.9')
      expect(result.error).toContain('not verified')
      expect(result.error).toContain('1.1.1')
    })

    it('succeeds for verified version 1.1.1', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: null,
          systematicVersion: '2.1.0',
          enableOmo: false,
          enableOmoSlim: true,
          omoSlimVersion: '1.1.1',
          omoSlimPreset: 'openai',
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
    })
  })
})
