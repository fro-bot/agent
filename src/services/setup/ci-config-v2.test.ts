import type {PermissionRuleV2} from '@fro-bot/runtime'
import {evaluatePermissionV2, verifyPermissionRules} from '@fro-bot/runtime'
import {describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {buildCIConfigV2} from './ci-config-v2.js'

const RUNNER_TEMP = '/home/runner/work/_temp'
const RESPONSE_DIR = `${RUNNER_TEMP}/fro-bot-response/12345-1`
const ATTACHMENT_DIR = `${RUNNER_TEMP}/fro-bot-attachments/12345-1`

const BASE_INPUTS = {
  opencodeConfig: null,
  plugins: ['@fro.bot/systematic@9.9.9'],
  runnerTemp: RUNNER_TEMP,
  runId: 12345,
  runAttempt: 1,
} as const

function build(overrides: Partial<Parameters<typeof buildCIConfigV2>[0]> = {}) {
  const logger = createMockLogger()
  const result = buildCIConfigV2({...BASE_INPUTS, ...overrides}, logger)
  if (!result.success) throw new Error(`expected a config, got: ${result.error}`)
  return {...result.data, logger}
}

function permissionsOf(content: Readonly<Record<string, unknown>>): readonly PermissionRuleV2[] {
  return content.permissions as readonly PermissionRuleV2[]
}

describe('buildCIConfigV2', () => {
  describe('V2 shape and placement', () => {
    it('emits the V2 keys and pins update, default agent and subagent depth', () => {
      // #given / #when
      const {content} = build()

      // #then
      expect(content.plugins).toEqual(['@fro.bot/systematic@9.9.9'])
      expect(content.update).toBe('disable')
      expect(content.default_agent).toBe('build')
      expect(content.experimental).toEqual({subagent_depth: 1})
    })

    it('puts the deny in the top-level permissions list and nowhere that does not hold', () => {
      // #given / #when
      const {content} = build()

      // #then
      expect(Array.isArray(content.permissions)).toBe(true)
      expect(content).not.toHaveProperty('policies')
      expect(content).not.toHaveProperty('permission')
      expect(content).not.toHaveProperty('agent')
      expect(content).not.toHaveProperty('agents')
      expect(content).not.toHaveProperty('autoupdate')
      expect(content).not.toHaveProperty('subagent_depth')
      expect(content).not.toHaveProperty('plugin')
      expect(JSON.stringify(content)).not.toContain('tool.use')
    })

    it('uses the native rule shape {action, resource, effect}', () => {
      // #given / #when
      const {content} = build()

      // #then
      for (const rule of permissionsOf(content)) {
        expect(Object.keys(rule).sort()).toEqual(['action', 'effect', 'resource'])
      }
    })
  })

  describe('deny set', () => {
    it('denies outside the checkout and excepts only this run response-file and attachment directories', () => {
      // #given / #when
      const {content} = build()
      const rules = permissionsOf(content)

      // #then
      expect(rules.filter(rule => rule.action === 'external_directory')).toEqual([
        {action: 'external_directory', resource: '*', effect: 'deny'},
        {action: 'external_directory', resource: `${RESPONSE_DIR}/*`, effect: 'allow'},
        {action: 'external_directory', resource: `${ATTACHMENT_DIR}/*`, effect: 'allow'},
      ])
    })

    it('tells the gate to expect the exceptions and to check sibling run directories stay denied', () => {
      // #given / #when
      const {expectations} = build()

      // #then
      expect(expectations.allowedDirectories).toEqual([RESPONSE_DIR, ATTACHMENT_DIR])
      expect(expectations.outsideDirectories).toEqual([
        '/fro-bot-gate-sentinel/outside',
        `${RUNNER_TEMP}/fro-bot-response/gate-sentinel-other-run`,
        `${RUNNER_TEMP}/fro-bot-attachments/gate-sentinel-other-run`,
      ])
      expect(expectations.deniedActions).toEqual(['opencode_session_move', 'opencode_worktree_create'])
    })

    it('does not except a sibling run directory', () => {
      // #given / #when
      const {content} = build()
      const rules = permissionsOf(content)

      // #then
      expect(evaluatePermissionV2('external_directory', `${RUNNER_TEMP}/fro-bot-response/99999-1/*`, rules)).toBe(
        'deny',
      )
      expect(evaluatePermissionV2('external_directory', `${RUNNER_TEMP}/fro-bot-attachments/99999-1/*`, rules)).toBe(
        'deny',
      )
      expect(evaluatePermissionV2('external_directory', '/etc/*', rules)).toBe('deny')
    })

    it('denies .env reads and edits and keeps .env.example readable', () => {
      // #given / #when
      const rules = permissionsOf(build().content)

      // #then
      for (const action of ['read', 'edit']) {
        expect(evaluatePermissionV2(action, '.env', rules)).toBe('deny')
        expect(evaluatePermissionV2(action, 'apps/web/.env', rules)).toBe('deny')
        expect(evaluatePermissionV2(action, '.env.production', rules)).toBe('deny')
        expect(evaluatePermissionV2(action, '.env.example', rules)).toBe('allow')
      }
      expect(evaluatePermissionV2('read', 'src/index.ts', rules)).toBe('ask')
    })

    it('denies edits of workspace-relative shadows of the response-file directory', () => {
      // #given / #when
      const rules = permissionsOf(build().content)

      // #then
      expect(evaluatePermissionV2('edit', '_temp/fro-bot-response/12345-1/n.md', rules)).toBe('deny')
      expect(evaluatePermissionV2('edit', 'fro-bot-response/12345-1/n.md', rules)).toBe('deny')
    })

    it('denies question in Action runs', () => {
      // #given / #when
      const rules = permissionsOf(build().content)

      // #then
      expect(evaluatePermissionV2('question', '*', rules)).toBe('deny')
    })

    it('denies the session-move and worktree-create tools', () => {
      // #given / #when
      const rules = permissionsOf(build().content)

      // #then
      expect(evaluatePermissionV2('opencode_session_move', '*', rules)).toBe('deny')
      expect(evaluatePermissionV2('opencode_worktree_create', '*', rules)).toBe('deny')
    })

    it('keeps the deny last so no built-in agent allow outranks it', () => {
      // #given
      const rules = permissionsOf(build().content)
      const builtinAllow: readonly PermissionRuleV2[] = [
        {action: 'external_directory', resource: '*', effect: 'allow'},
        {action: 'question', resource: '*', effect: 'allow'},
      ]

      // #when
      const effective = [...builtinAllow, ...rules]

      // #then
      expect(evaluatePermissionV2('external_directory', '/etc/*', effective)).toBe('deny')
      expect(evaluatePermissionV2('question', '*', effective)).toBe('deny')
    })
  })

  describe('integration workdir', () => {
    it('excepts a workdir inside RUNNER_TEMP', () => {
      // #given
      const workDir = `${RUNNER_TEMP}/integration`

      // #when
      const {content, expectations} = build({integrationWorkDir: workDir})

      // #then
      expect(evaluatePermissionV2('external_directory', `${workDir}/*`, permissionsOf(content))).toBe('allow')
      expect(expectations.allowedDirectories).toContain(workDir)
    })

    it('ignores a workdir outside RUNNER_TEMP with a warning', () => {
      // #given / #when
      const {content, logger} = build({integrationWorkDir: '/srv/other'})

      // #then
      expect(evaluatePermissionV2('external_directory', '/srv/other/*', permissionsOf(content))).toBe('deny')
      expect(logger.warning).toHaveBeenCalledWith('Ignoring integration workdir outside RUNNER_TEMP', expect.anything())
    })
  })

  describe('without RUNNER_TEMP', () => {
    it('keeps a flat outside deny with no exceptions', () => {
      // #given / #when
      const {content, expectations} = build({runnerTemp: undefined})

      // #then
      expect(permissionsOf(content).filter(rule => rule.action === 'external_directory')).toEqual([
        {action: 'external_directory', resource: '*', effect: 'deny'},
      ])
      expect(expectations.allowedDirectories).toEqual([])
    })
  })

  describe('operator config', () => {
    it('merges operator keys and de-duplicates plugins', () => {
      // #given
      const opencodeConfig = JSON.stringify({
        model: 'anthropic/claude-sonnet-4-6',
        plugins: ['@fro.bot/systematic@9.9.9', 'some-other-plugin'],
        experimental: {todo: true, subagent_depth: 5},
      })

      // #when
      const {content} = build({opencodeConfig})

      // #then
      expect(content.model).toBe('anthropic/claude-sonnet-4-6')
      expect(content.plugins).toEqual(['@fro.bot/systematic@9.9.9', 'some-other-plugin'])
      expect(content.experimental).toEqual({todo: true, subagent_depth: 1})
    })

    it('pins default agent and update over operator values', () => {
      // #given
      const opencodeConfig = JSON.stringify({default_agent: 'plan', update: 'auto'})

      // #when
      const {content} = build({opencodeConfig})

      // #then
      expect(content.default_agent).toBe('build')
      expect(content.update).toBe('disable')
    })

    it('removes operator permission spellings that would undo the deny, and says so', () => {
      // #given
      const opencodeConfig = JSON.stringify({
        permission: {external_directory: 'allow'},
        permissions: [{action: 'question', resource: '*', effect: 'allow'}],
        tools: {question: true},
        agent: {build: {permission: {question: 'allow'}, tools: {question: true}, model: 'a/b'}},
        agents: {build: {permissions: [{action: 'external_directory', resource: '*', effect: 'allow'}]}},
        mode: {build: {permission: {question: 'allow'}}},
        autoupdate: true,
        subagent_depth: 4,
      })

      // #when
      const {content, logger} = build({opencodeConfig})
      const serialized = JSON.stringify(content)

      // #then
      expect(content).not.toHaveProperty('permission')
      expect(content).not.toHaveProperty('tools')
      expect(content).not.toHaveProperty('autoupdate')
      expect(content).not.toHaveProperty('subagent_depth')
      expect(serialized).not.toContain('"permission"')
      expect(serialized).not.toContain('"tools"')
      expect(content.agent).toEqual({build: {model: 'a/b'}})
      expect(evaluatePermissionV2('question', '*', permissionsOf(content))).toBe('deny')
      expect(evaluatePermissionV2('external_directory', '/etc/*', permissionsOf(content))).toBe('deny')
      expect(logger.warning).toHaveBeenCalled()
    })

    it('rejects malformed operator JSON', () => {
      // #given / #when
      const result = buildCIConfigV2({...BASE_INPUTS, opencodeConfig: '{nope'}, createMockLogger())

      // #then
      expect(result).toEqual({success: false, error: 'opencode-config must be valid JSON'})
    })

    it('rejects an operator config that is not an object', () => {
      // #given / #when
      const result = buildCIConfigV2({...BASE_INPUTS, opencodeConfig: '[1]'}, createMockLogger())

      // #then
      expect(result).toEqual({success: false, error: 'opencode-config must be a JSON object'})
    })
  })

  it('rejects a relative RUNNER_TEMP, which would make the exception patterns meaningless', () => {
    // #given / #when
    const result = buildCIConfigV2({...BASE_INPUTS, runnerTemp: 'tmp'}, createMockLogger())

    // #then
    expect(result.success).toBe(false)
  })

  describe('permission gate', () => {
    const BUILTIN_EXPLORE: readonly PermissionRuleV2[] = [
      {action: '*', resource: '*', effect: 'deny'},
      {action: 'read', resource: '*', effect: 'allow'},
      {action: 'external_directory', resource: '*', effect: 'allow'},
    ]

    it('passes for build, general and explore built with these rules', async () => {
      // #given
      const {content, expectations} = build()
      const configured = permissionsOf(content)
      const agents = [
        {id: 'build', permissions: [{action: '*', resource: '*', effect: 'allow'}, ...configured]},
        {id: 'general', permissions: [{action: '*', resource: '*', effect: 'allow'}, ...configured]},
        {id: 'explore', permissions: [...BUILTIN_EXPLORE, ...configured]},
      ]

      // #when
      const result = await verifyPermissionRules(
        {listAgents: async () => ({location: {}, data: agents})},
        expectations,
        createMockLogger(),
      )

      // #then
      expect(result.success).toBe(true)
    })

    it('fails for a subagent that never received the rules', async () => {
      // #given
      const {content, expectations} = build()
      const agents = [
        {id: 'build', permissions: [{action: '*', resource: '*', effect: 'allow'}, ...permissionsOf(content)]},
        {id: 'general', permissions: [{action: '*', resource: '*', effect: 'allow'}]},
      ]

      // #when
      const result = await verifyPermissionRules(
        {listAgents: async () => ({location: {}, data: agents})},
        expectations,
        createMockLogger(),
      )

      // #then
      expect(result.success).toBe(false)
    })
  })
})
