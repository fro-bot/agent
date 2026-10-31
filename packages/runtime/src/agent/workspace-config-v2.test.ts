import type {Logger} from '../shared/logger.js'
import type {PermissionRuleV2} from './permission-rules-v2.js'

import {describe, expect, it, vi} from 'vitest'

import {evaluatePermissionV2, verifyPermissionRules} from './permission-gate-v2.js'
import {buildWorkspaceConfigV2} from './workspace-config-v2.js'

function makeLogger(): Logger {
  return {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}
}

function build(inputs: Parameters<typeof buildWorkspaceConfigV2>[0] = {plugins: []}) {
  const result = buildWorkspaceConfigV2(inputs, makeLogger())
  if (!result.success) throw new Error(`expected a config, got: ${result.error}`)
  return result.data
}

function rulesOf(content: Readonly<Record<string, unknown>>): readonly PermissionRuleV2[] {
  return content.permissions as readonly PermissionRuleV2[]
}

describe('buildWorkspaceConfigV2', () => {
  it('emits the V2 keys with the plugin list the installers supply', () => {
    // #given / #when
    const {content} = build({plugins: ['file:///usr/local/lib/fro-bot/plugins/a.mjs', '@fro.bot/systematic@9.9.9']})

    // #then
    expect(content.plugins).toEqual(['file:///usr/local/lib/fro-bot/plugins/a.mjs', '@fro.bot/systematic@9.9.9'])
    expect(content.update).toBe('disable')
    expect(content.default_agent).toBe('build')
    expect(content.experimental).toEqual({subagent_depth: 1})
  })

  it('de-duplicates plugins', () => {
    // #given / #when
    const {content} = build({plugins: ['a', 'b', 'a']})

    // #then
    expect(content.plugins).toEqual(['a', 'b'])
  })

  it('places the deny in permissions, not in policies or the V1 spellings', () => {
    // #given / #when
    const {content} = build()

    // #then
    expect(Array.isArray(content.permissions)).toBe(true)
    for (const key of ['policies', 'permission', 'agent', 'agents', 'plugin', 'autoupdate', 'subagent_depth']) {
      expect(content).not.toHaveProperty(key)
    }
  })

  it('asks before outside-checkout access with no exceptions by default', () => {
    // #given / #when
    const {content, expectations} = build()
    const rules = rulesOf(content)

    // #then
    expect(rules.filter(rule => rule.action === 'external_directory')).toEqual([
      {action: 'external_directory', resource: '*', effect: 'ask'},
    ])
    expect(expectations.outsidePolicy).toBe('ask-or-deny')
    expect(expectations.allowedDirectories).toEqual([])
  })

  it('excepts the directories it is given', () => {
    // #given / #when
    const {content, expectations} = build({plugins: [], allowedExternalDirectories: ['/var/lib/fro-bot/shared']})

    // #then
    expect(evaluatePermissionV2('external_directory', '/var/lib/fro-bot/shared/*', rulesOf(content))).toBe('allow')
    expect(evaluatePermissionV2('external_directory', '/etc/*', rulesOf(content))).toBe('ask')
    expect(expectations.allowedDirectories).toEqual(['/var/lib/fro-bot/shared'])
  })

  describe('bundled skills directory', () => {
    const PACKAGE =
      '/home/opencode/.cache/opencode/npm/@fro.bot/systematic@9.9.9/1800000000000/node_modules/@fro.bot/systematic'
    const SKILLS = `${PACKAGE}/skills`

    it('reads skill references without an ask, and nothing else outside the checkout', () => {
      // #given
      const {content} = build({plugins: [], bundledSkillsDirectories: [SKILLS]})
      const rules = rulesOf(content)

      // #then the skills directory is allowed
      expect(evaluatePermissionV2('external_directory', `${SKILLS}/*`, rules)).toBe('allow')
      // #then a sibling inside the package, the package root, the cache and an unrelated path still ask
      expect(evaluatePermissionV2('external_directory', `${PACKAGE}/*`, rules)).toBe('ask')
      expect(evaluatePermissionV2('external_directory', `${PACKAGE}/dist/*`, rules)).toBe('ask')
      expect(evaluatePermissionV2('external_directory', '/home/opencode/.cache/opencode/*', rules)).toBe('ask')
      expect(evaluatePermissionV2('external_directory', '/etc/*', rules)).toBe('ask')
    })

    it('denies the edit, write and patch tools there, and leaves other external edits alone', () => {
      // #given
      const rules = rulesOf(build({plugins: [], bundledSkillsDirectories: [SKILLS]}).content)

      // #then V2 asks `edit` about the absolute path of a file outside the checkout
      expect(evaluatePermissionV2('edit', `${SKILLS}/ce-review/scripts/validate-review.mjs`, rules)).toBe('deny')
      expect(evaluatePermissionV2('edit', `${SKILLS}/ce-review/references/x.md`, rules)).toBe('deny')
      expect(evaluatePermissionV2('edit', `${PACKAGE}/package.json`, rules)).toBe('ask')
      expect(evaluatePermissionV2('edit', 'src/index.ts', rules)).toBe('ask')
    })

    it('is an authorized exception, so the permission gate passes for every agent', async () => {
      // #given
      const {content, expectations} = build({plugins: [], bundledSkillsDirectories: [SKILLS]})
      const configured = rulesOf(content)
      const agents = [
        {id: 'build', permissions: [{action: '*', resource: '*', effect: 'allow'}, ...configured]},
        {id: 'explore', permissions: [{action: 'external_directory', resource: '*', effect: 'allow'}, ...configured]},
      ]

      // #when
      const result = await verifyPermissionRules(
        {listAgents: async () => ({location: {}, data: agents})},
        expectations,
        makeLogger(),
      )

      // #then
      expect(expectations.allowedDirectories).toEqual([SKILLS])
      expect(result.success).toBe(true)
    })

    it('is not tolerated by the gate when the expectations do not name it', async () => {
      // #given rules carrying the skills allow, checked against expectations that do not authorize it
      const {content} = build({plugins: [], bundledSkillsDirectories: [SKILLS]})
      const {expectations} = build({plugins: []})
      const agents = [{id: 'build', permissions: rulesOf(content)}]

      // #when
      const result = await verifyPermissionRules(
        {listAgents: async () => ({location: {}, data: agents})},
        expectations,
        makeLogger(),
      )

      // #then an allow the gate does not know about fails it
      expect(result.success).toBe(false)
    })

    it.each(['skills', '/srv/skills?', '/srv/*/skills', '/'])(
      'rejects the unusable directory %j instead of widening it',
      directory => {
        expect(buildWorkspaceConfigV2({plugins: [], bundledSkillsDirectories: [directory]}, makeLogger()).success).toBe(
          false,
        )
      },
    )
  })

  it('keeps question so the gateway can relay it, and still denies .env and the two tools', () => {
    // #given / #when
    const rules = rulesOf(build().content)

    // #then
    expect(evaluatePermissionV2('question', '*', rules)).toBe('ask')
    expect(rules.some(rule => rule.action === 'question')).toBe(false)
    expect(evaluatePermissionV2('read', '.env', rules)).toBe('deny')
    expect(evaluatePermissionV2('edit', '.env', rules)).toBe('deny')
    expect(evaluatePermissionV2('opencode_session_move', '*', rules)).toBe('deny')
    expect(evaluatePermissionV2('opencode_worktree_create', '*', rules)).toBe('deny')
  })

  it('rejects a relative exception directory', () => {
    // #given / #when
    const result = buildWorkspaceConfigV2({plugins: [], allowedExternalDirectories: ['shared']}, makeLogger())

    // #then
    expect(result.success).toBe(false)
  })

  it.each([
    ['a ? in the name', '/srv/cache?'],
    ['a * in the name', '/srv/cache*'],
    ['a * segment', '/srv/*/cache'],
    ['the filesystem root', '/'],
  ])('rejects an exception directory with %s instead of widening it into a grant', (_label, directory) => {
    // #given / #when
    const result = buildWorkspaceConfigV2({plugins: [], allowedExternalDirectories: [directory]}, makeLogger())

    // #then
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).toContain(directory)
  })

  it('fails its own gate when a targeted external_directory allow follows the boundary', async () => {
    // #given
    const {content, expectations} = build()
    const agents = [
      {
        id: 'build',
        permissions: [...rulesOf(content), {action: 'external_directory', resource: '/etc/*', effect: 'allow'}],
      },
    ]

    // #when
    const result = await verifyPermissionRules(
      {listAgents: async () => ({location: {}, data: agents})},
      expectations,
      makeLogger(),
    )

    // #then
    expect(result.success).toBe(false)
  })

  it('fails its own gate when the boundary resolves to allow', async () => {
    // #given
    const {content, expectations} = build()
    const agents = [
      {
        id: 'build',
        permissions: [...rulesOf(content), {action: 'external_directory', resource: '*', effect: 'allow'}],
      },
    ]

    // #when
    const result = await verifyPermissionRules(
      {listAgents: async () => ({location: {}, data: agents})},
      expectations,
      makeLogger(),
    )

    // #then
    expect(result.success).toBe(false)
  })

  it('passes its own gate for build and for a subagent', async () => {
    // #given
    const {content, expectations} = build({plugins: [], allowedExternalDirectories: ['/var/lib/fro-bot/shared']})
    const configured = rulesOf(content)
    const agents = [
      {id: 'build', permissions: [{action: '*', resource: '*', effect: 'allow'}, ...configured]},
      {
        id: 'explore',
        permissions: [
          {action: '*', resource: '*', effect: 'deny'},
          {action: 'read', resource: '*', effect: 'allow'},
          {action: 'external_directory', resource: '*', effect: 'allow'},
          ...configured,
        ],
      },
    ]

    // #when
    const result = await verifyPermissionRules(
      {listAgents: async () => ({location: {}, data: agents})},
      expectations,
      makeLogger(),
    )

    // #then
    expect(result.success).toBe(true)
  })
})
