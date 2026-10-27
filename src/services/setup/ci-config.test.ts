import type {Logger} from './types.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {buildCIConfig} from './ci-config.js'

function createLogger(): Logger {
  return createMockLogger()
}

const ORIGINAL_RUNNER_TEMP = process.env.RUNNER_TEMP

beforeEach(() => {
  delete process.env.RUNNER_TEMP
  // Fixed, deterministic run identity for every test in this file -- the attachment directory
  // pattern is now run-attempt-scoped (Finding 1), so leaving GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT
  // to whatever the actual environment happens to hold (a real value when this suite runs inside
  // an actual GitHub Actions job) would make the literal patterns asserted below flaky.
  vi.stubEnv('GITHUB_RUN_ID', '12345')
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '1')
})

afterEach(() => {
  if (ORIGINAL_RUNNER_TEMP === undefined) {
    delete process.env.RUNNER_TEMP
  } else {
    process.env.RUNNER_TEMP = ORIGINAL_RUNNER_TEMP
  }
  vi.unstubAllEnvs()
})

describe('buildCIConfig', () => {
  describe('default CI config', () => {
    it('returns autoupdate baseline with systematic plugin and pinned default_agent when no user config', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

      // #then
      expect(result.error).toBeNull()
      expect(result.config).toEqual({
        autoupdate: false,
        plugin: ['@fro.bot/systematic@2.1.0'],
        default_agent: 'build',
        subagent_depth: 1,
        agent: {
          build: {
            permission: {
              doom_loop: 'deny',
              read: {
                '*.env': 'deny',
                '*.env.*': 'deny',
                '*.env.example': 'allow',
              },
              edit: {},
              external_directory: 'deny',
            },
          },
        },
      })
    })

    it('pins default_agent to build even when user config sets another agent', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: '{"default_agent":"custom"}', systematicVersion: '2.1.0'}, logger)

      // #then - build is pinned
      expect(result.error).toBeNull()
      expect(result.config.default_agent).toBe('build')
      expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('default_agent'))
    })

    it('pins default_agent to build over user-provided value even when user sets build explicitly', () => {
      // #given - user already set build; no rewrite warning about default_agent should fire
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: '{"default_agent":"build"}', systematicVersion: '2.1.0'}, logger)

      // #then - safely idempotent
      expect(result.error).toBeNull()
      expect(result.config.default_agent).toBe('build')
    })

    it('strips the legacy plugins (plural) key', () => {
      // #given
      const logger = createLogger()

      // #when - legacy "plugins" entries
      const result = buildCIConfig(
        {
          opencodeConfig: '{"plugins":["legacy-plugin@3.7.4","other-plugin@1.0.0"],"plugin":["custom@1.0.0"]}',
          systematicVersion: '2.1.0',
        },
        logger,
      )

      // #then - legacy plugins key is deleted entirely, primary plugin untouched
      expect(result.error).toBeNull()
      expect(result.config).not.toHaveProperty('plugins')
      expect(result.config.plugin).toContain('custom@1.0.0')
      expect(result.config.default_agent).toBe('build')
      expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('plugins'))
    })

    it('emits single warning when multiple fields are rewritten', () => {
      // #given
      const logger = createLogger()

      // #when - user has both default_agent and the legacy plugins key
      const result = buildCIConfig(
        {
          opencodeConfig: '{"default_agent":"custom","plugins":["legacy@1.0.0"],"plugin":["tool@1.0.0"]}',
          systematicVersion: '2.1.0',
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
      expect(rewriteWarning![0]).toContain('plugins')
      expect(rewriteWarning![0]).toContain('default_agent')
    })

    it('does not emit rewrite warning when no user config changes needed', () => {
      // #given - user provides no config at all
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

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

    it('denies reachable native asks while preserving user read rules and putting managed rules last', () => {
      // #given user-supplied permission rules with a native wildcard and custom entries
      const logger = createLogger()
      const result = buildCIConfig(
        {
          opencodeConfig: JSON.stringify({
            agent: {
              build: {
                permission: {
                  doom_loop: 'ask',
                  read: {'*': 'allow', '*.env.example': 'ask', custom: 'deny', '*.env': 'ask'},
                  edit: {existing: 'ask'},
                  external_directory: 'ask',
                },
              },
            },
          }),
          systematicVersion: '2.1.0',
        },
        logger,
      )

      // #then the known asks are denied and read rule ordering remains load-bearing
      expect(result.error).toBeNull()
      const build = (result.config.agent as Record<string, unknown>).build as Record<string, unknown>
      const permission = build.permission as Record<string, unknown>
      expect(permission.doom_loop).toBe('deny')
      expect(permission.read).toEqual({
        '*': 'allow',
        custom: 'deny',
        '*.env': 'deny',
        '*.env.*': 'deny',
        '*.env.example': 'allow',
      })
      expect(Object.keys(permission.read as Record<string, unknown>)).toEqual([
        '*',
        'custom',
        '*.env',
        '*.env.*',
        '*.env.example',
      ])
      expect(permission.edit).toEqual({existing: 'ask'})
      expect(permission.external_directory).toBe('deny')
    })

    it('appends systematic plugin even when no user config', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

      // #then
      expect(result.error).toBeNull()
      expect(result.config.plugin).toContain('@fro.bot/systematic@2.1.0')
    })

    it('denies external directory access for the build agent so it cannot block on permission prompts', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

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

    it('allows the response-file dir under RUNNER_TEMP for the build agent while denying everything else external', () => {
      // #given
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

      // #then
      expect(result.error).toBeNull()
      expect(result.config).toMatchObject({
        agent: {
          build: {
            permission: {
              external_directory: {
                '*': 'deny',
                '/home/runner/work/_temp/fro-bot-response/*': 'allow',
              },
            },
          },
        },
      })
    })

    it('denies the in-workspace response directory without denying unrelated checkout paths', () => {
      // #given a runner temp directory and a normal checkout
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')

      // #when building the default config
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

      // #then only the response directory is denied for edit permission
      expect(result.config).toMatchObject({
        agent: {
          build: {
            permission: {
              edit: {
                '_temp/fro-bot-response/*': 'deny',
                'fro-bot-response/*': 'deny',
              },
            },
          },
        },
      })
      const build = (result.config.agent as Record<string, unknown>).build as Record<string, unknown>
      const edit = ((build.permission as Record<string, unknown>).edit ?? {}) as Record<string, unknown>
      expect(edit['src/other-file.ts']).toBeUndefined()
    })

    it('preserves an existing scalar edit policy while adding the scoped deny', () => {
      // #given an explicit scalar edit policy
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')
      const result = buildCIConfig(
        {
          opencodeConfig: JSON.stringify({agent: {build: {permission: {edit: 'deny'}}}}),
          systematicVersion: '2.1.0',
        },
        logger,
      )

      // #then the scalar policy remains the default for unrelated paths
      const permission = (result.config.agent as Record<string, unknown>).build as Record<string, unknown>
      const edit = ((permission.permission as Record<string, unknown>).edit ?? {}) as Record<string, unknown>
      expect(edit['*']).toBe('deny')
      expect(edit['_temp/fro-bot-response/*']).toBe('deny')
      expect(edit['fro-bot-response/*']).toBe('deny')
      expect(Object.keys(edit)).toEqual(['*', '_temp/fro-bot-response/*', 'fro-bot-response/*'])
    })

    it('preserves existing edit object entries in order and appends the scoped deny', () => {
      // #given an explicit object edit policy without the response-file deny
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')
      const result = buildCIConfig(
        {
          opencodeConfig: JSON.stringify({
            agent: {build: {permission: {edit: {src: 'ask', docs: 'deny'}}}},
          }),
          systematicVersion: '2.1.0',
        },
        logger,
      )

      // #then original entries are preserved and the deny is appended last
      const permission = (result.config.agent as Record<string, unknown>).build as Record<string, unknown>
      const edit = ((permission.permission as Record<string, unknown>).edit ?? {}) as Record<string, unknown>
      expect(edit).toEqual({
        src: 'ask',
        docs: 'deny',
        '_temp/fro-bot-response/*': 'deny',
        'fro-bot-response/*': 'deny',
      })
      expect(Object.keys(edit)).toEqual(['src', 'docs', '_temp/fro-bot-response/*', 'fro-bot-response/*'])
    })

    it('moves an existing response-file deny to the end of the edit policy', () => {
      // #given an existing deny followed by a broad allow
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')
      const result = buildCIConfig(
        {
          opencodeConfig: JSON.stringify({
            agent: {
              build: {
                permission: {
                  edit: {
                    '_temp/fro-bot-response/*': 'allow',
                    'fro-bot-response/*': 'allow',
                    '*': 'allow',
                  },
                },
              },
            },
          }),
          systematicVersion: '2.1.0',
        },
        logger,
      )

      // #then delete-then-re-add ordering makes the scoped deny last
      const permission = (result.config.agent as Record<string, unknown>).build as Record<string, unknown>
      const edit = ((permission.permission as Record<string, unknown>).edit ?? {}) as Record<string, unknown>
      expect(edit).toEqual({
        '*': 'allow',
        '_temp/fro-bot-response/*': 'deny',
        'fro-bot-response/*': 'deny',
      })
      expect(Object.keys(edit)).toEqual(['*', '_temp/fro-bot-response/*', 'fro-bot-response/*'])
    })

    it('allows the explicitly designated integration workdir after the response-file dir', () => {
      // #given
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: null,
          systematicVersion: '2.1.0',
          integrationWorkDir: '/home/runner/work/_temp/harness-integrate-work',
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      const config = result.config as {agent: {build: {permission: {external_directory: Record<string, unknown>}}}}
      const externalDirectory = config.agent.build.permission.external_directory
      expect(externalDirectory).toEqual({
        '*': 'deny',
        '/home/runner/work/_temp/fro-bot-response/*': 'allow',
        '/home/runner/work/_temp/fro-bot-attachments/12345-1/*': 'allow',
        '/home/runner/work/_temp/harness-integrate-work/*': 'allow',
      })
      expect(Object.keys(externalDirectory)).toEqual([
        '*',
        '/home/runner/work/_temp/fro-bot-response/*',
        '/home/runner/work/_temp/fro-bot-attachments/12345-1/*',
        '/home/runner/work/_temp/harness-integrate-work/*',
      ])
    })

    it('keeps the response-file allowlist when the integration workdir is unknown', () => {
      // #given
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

      // #then - generic runs retain response delivery without guessing an integration path
      expect(result.error).toBeNull()
      expect(result.config).toMatchObject({
        agent: {
          build: {
            permission: {
              external_directory: {
                '*': 'deny',
                '/home/runner/work/_temp/fro-bot-response/*': 'allow',
              },
            },
          },
        },
      })
    })

    it('omits an integration workdir outside RUNNER_TEMP while preserving the deny and response allow', () => {
      // #given
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: null,
          systematicVersion: '2.1.0',
          integrationWorkDir: '/home/runner/work/other/harness-integrate-work',
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      expect(result.config).toMatchObject({
        agent: {
          build: {
            permission: {
              external_directory: {
                '*': 'deny',
                '/home/runner/work/_temp/fro-bot-response/*': 'allow',
              },
            },
          },
        },
      })
      expect(logger.warning).toHaveBeenCalledWith('Ignoring integration workdir outside RUNNER_TEMP', {
        integrationWorkDir: '/home/runner/work/other/harness-integrate-work',
        runnerTemp: '/home/runner/work/_temp',
      })
    })

    it('omits an integration workdir whose traversal escapes RUNNER_TEMP', () => {
      // #given
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: null,
          systematicVersion: '2.1.0',
          integrationWorkDir: '/home/runner/work/_temp/../../etc',
        },
        logger,
      )

      // #then
      const config = result.config as {agent: {build: {permission: {external_directory: Record<string, unknown>}}}}
      expect(config.agent.build.permission.external_directory).toEqual({
        '*': 'deny',
        '/home/runner/work/_temp/fro-bot-response/*': 'allow',
        '/home/runner/work/_temp/fro-bot-attachments/12345-1/*': 'allow',
      })
      expect(logger.warning).toHaveBeenCalledWith('Ignoring integration workdir outside RUNNER_TEMP', {
        integrationWorkDir: '/home/runner/work/_temp/../../etc',
        runnerTemp: '/home/runner/work/_temp',
      })
    })

    it('omits a sibling-prefix integration workdir', () => {
      // #given
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: null,
          systematicVersion: '2.1.0',
          integrationWorkDir: '/home/runner/work/_tempevil/harness-integrate-work',
        },
        logger,
      )

      // #then
      const config = result.config as {agent: {build: {permission: {external_directory: Record<string, unknown>}}}}
      expect(config.agent.build.permission.external_directory).toEqual({
        '*': 'deny',
        '/home/runner/work/_temp/fro-bot-response/*': 'allow',
        '/home/runner/work/_temp/fro-bot-attachments/12345-1/*': 'allow',
      })
      expect(logger.warning).toHaveBeenCalledWith('Ignoring integration workdir outside RUNNER_TEMP', {
        integrationWorkDir: '/home/runner/work/_tempevil/harness-integrate-work',
        runnerTemp: '/home/runner/work/_temp',
      })
    })

    it('falls back to a flat deny when RUNNER_TEMP is unset (fail safe, never guesses a broad allow)', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

      // #then
      expect(result.error).toBeNull()
      const config = result.config as {agent: {build: {permission: Record<string, unknown>}}}
      expect(config.agent.build.permission.external_directory).toBe('deny')
      expect(Object.keys(config.agent.build.permission)).not.toContain('fro-bot-response')
    })

    it('overrides a user-supplied external_directory string with our scoped map', () => {
      // #given
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"agent":{"build":{"permission":{"external_directory":"allow"}}}}',
          systematicVersion: '2.1.0',
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      expect(result.config).toMatchObject({
        agent: {
          build: {
            permission: {
              external_directory: {
                '*': 'deny',
                '/home/runner/work/_temp/fro-bot-response/*': 'allow',
              },
            },
          },
        },
      })
    })

    it('overrides a user-supplied external_directory map with our scoped map', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"agent":{"build":{"permission":{"external_directory":{"/etc/**":"allow","*":"allow"}}}}}',
          systematicVersion: '2.1.0',
        },
        logger,
      )

      // #then
      expect(result.error).toBeNull()
      const config = result.config as {agent: {build: {permission: Record<string, unknown>}}}
      expect(config.agent.build.permission.external_directory).toBe('deny')
    })
  })

  describe('scopeAttachmentDirectoryPermission (top-level grant)', () => {
    it('grants the attachment directory at the top-level permission key', () => {
      // #given
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

      // #then the global grant exists independently of the build-agent-scoped one
      expect(result.error).toBeNull()
      expect(result.config).toMatchObject({
        permission: {
          external_directory: {
            '*': 'deny',
            '/home/runner/work/_temp/fro-bot-attachments/12345-1/*': 'allow',
          },
        },
      })
    })

    it('preserves an existing user-supplied top-level permission key alongside the grant', () => {
      // #given a user config that already sets an unrelated top-level permission entry
      const logger = createLogger()
      vi.stubEnv('RUNNER_TEMP', '/home/runner/work/_temp')

      // #when
      const result = buildCIConfig(
        {
          opencodeConfig: '{"permission":{"bash":"allow"}}',
          systematicVersion: '2.1.0',
        },
        logger,
      )

      // #then the user's unrelated entry survives, and the grant is layered in
      expect(result.error).toBeNull()
      const permission = (result.config as {permission: Record<string, unknown>}).permission
      expect(permission.bash).toBe('allow')
      expect(permission.external_directory).toEqual({
        '*': 'deny',
        '/home/runner/work/_temp/fro-bot-attachments/12345-1/*': 'allow',
      })
    })

    it('fail-safe: does not add a top-level permission key at all when RUNNER_TEMP is unset', () => {
      // #given RUNNER_TEMP is unset (deleted by beforeEach)
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

      // #then no broad allow pattern is guessed
      expect(result.config).not.toHaveProperty('permission')
    })
  })

  describe('error handling', () => {
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

  describe('R12 subagent_depth pin', () => {
    it('pins subagent_depth to 1 when no user config is supplied', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: null, systematicVersion: '2.1.0'}, logger)

      // #then
      expect(result.error).toBeNull()
      expect(result.config.subagent_depth).toBe(1)
    })

    it('overrides an operator-supplied subagent_depth and records a warning', () => {
      // #given - operator config sets a deeper subagent_depth
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: '{"subagent_depth":3}', systematicVersion: '2.1.0'}, logger)

      // #then - pinned to 1 rather than silently honoring the operator value, and the override is recorded
      expect(result.error).toBeNull()
      expect(result.config.subagent_depth).toBe(1)
      expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining('subagent_depth'))
    })

    it('does not warn when the operator already supplied 1', () => {
      // #given
      const logger = createLogger()

      // #when
      const result = buildCIConfig({opencodeConfig: '{"subagent_depth":1}', systematicVersion: '2.1.0'}, logger)

      // #then
      expect(result.error).toBeNull()
      expect(result.config.subagent_depth).toBe(1)
      const warningCalls = (logger.warning as ReturnType<typeof import('vitest').vi.fn>).mock.calls
      const depthWarning = warningCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('subagent_depth'),
      )
      expect(depthWarning).toBeUndefined()
    })
  })
})
