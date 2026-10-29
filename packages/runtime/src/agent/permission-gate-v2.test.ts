import type {Logger} from '../shared/logger.js'
import type {
  PermissionGateError,
  PermissionGateExpectations,
  PermissionGateReport,
  PermissionGateViolation,
} from './permission-gate-v2.js'
import type {PermissionRuleV2} from './permission-rules-v2.js'

import {describe, expect, it, vi} from 'vitest'

import {evaluatePermissionV2, verifyPermissionRules} from './permission-gate-v2.js'
import {buildPermissionRulesV2, externalDirectoryResource} from './permission-rules-v2.js'

const RESPONSE_DIR = '/runner/_temp/fro-bot-response/42-1'
const ATTACHMENT_DIR = '/runner/_temp/fro-bot-attachments/42-1'

const EXPECTATIONS: PermissionGateExpectations = {
  outsidePolicy: 'deny',
  allowedDirectories: [RESPONSE_DIR, ATTACHMENT_DIR],
  deniedActions: ['opencode_session_move', 'opencode_worktree_create'],
}

function makeLogger(): Logger {
  return {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}
}

function rulesFor(input: Parameters<typeof buildPermissionRulesV2>[0]): readonly PermissionRuleV2[] {
  const built = buildPermissionRulesV2(input)
  if (!built.success) throw new Error(`expected rules, got: ${built.error}`)
  return built.data
}

function goodRules(): readonly PermissionRuleV2[] {
  return rulesFor({
    outsideEffect: 'deny',
    allowedExternalDirectories: [RESPONSE_DIR, ATTACHMENT_DIR],
    editDenyResources: [],
    denyQuestion: true,
  })
}

const WORKSPACE_EXPECTATIONS: PermissionGateExpectations = {...EXPECTATIONS, outsidePolicy: 'ask-or-deny'}

function workspaceRules(...extra: readonly PermissionRuleV2[]): readonly PermissionRuleV2[] {
  return [
    ...rulesFor({
      outsideEffect: 'ask',
      allowedExternalDirectories: [RESPONSE_DIR, ATTACHMENT_DIR],
      editDenyResources: [],
      denyQuestion: false,
    }),
    ...extra,
  ]
}

// The built-in agent rulesets in v2.2.0 (`core/src/plugin/agent.ts`, `schema/src/agent.ts`), before the
// configured `permissions` are appended to every agent.
const BUILTIN: Readonly<Record<string, readonly PermissionRuleV2[]>> = {
  build: [
    {action: '*', resource: '*', effect: 'allow'},
    {action: 'read', resource: '*.env', effect: 'ask'},
    {action: 'question', resource: '*', effect: 'allow'},
  ],
  general: [
    {action: '*', resource: '*', effect: 'allow'},
    {action: 'question', resource: '*', effect: 'deny'},
    {action: 'subagent', resource: '*', effect: 'deny'},
  ],
  explore: [
    {action: '*', resource: '*', effect: 'allow'},
    {action: '*', resource: '*', effect: 'deny'},
    {action: 'shell', resource: '*', effect: 'allow'},
    {action: 'read', resource: '*', effect: 'allow'},
    {action: 'external_directory', resource: '*', effect: 'allow'},
  ],
  title: [
    {action: '*', resource: '*', effect: 'allow'},
    {action: '*', resource: '*', effect: 'deny'},
  ],
}

function effectiveAgents(
  configured: readonly PermissionRuleV2[],
  overrides: Readonly<Record<string, readonly PermissionRuleV2[]>> = {},
) {
  return Object.entries(BUILTIN).map(([id, builtin]) => ({
    id,
    name: id,
    mode: id === 'general' || id === 'explore' ? 'subagent' : 'primary',
    hidden: false,
    permissions: [...builtin, ...(overrides[id] ?? configured)],
  }))
}

type GateResult = Awaited<ReturnType<typeof verifyPermissionRules>>

function errorOf(result: GateResult): PermissionGateError {
  if (result.success) throw new Error('expected the gate to fail')
  return result.error
}

function violationsOf(result: GateResult): readonly PermissionGateViolation[] {
  const error = errorOf(result)
  if (error.kind !== 'rules-missing') throw new Error(`expected rules-missing, got ${error.kind}`)
  return error.violations
}

function reportOf(result: GateResult): PermissionGateReport {
  if (!result.success) throw new Error(`expected the gate to pass: ${result.error.message}`)
  return result.data
}

function sourceOf(body: unknown) {
  return {listAgents: async () => body}
}

function envelope(agents: readonly unknown[]) {
  return {location: {directory: '/work/checkout'}, data: agents}
}

describe('evaluatePermissionV2', () => {
  it('lets the last matching rule win and defaults to ask', () => {
    // #given
    const rules: readonly PermissionRuleV2[] = [
      {action: 'external_directory', resource: '*', effect: 'deny'},
      {action: 'external_directory', resource: '/ok/*', effect: 'allow'},
    ]

    // #when / #then
    expect(evaluatePermissionV2('external_directory', '/ok/*', rules)).toBe('allow')
    expect(evaluatePermissionV2('external_directory', '/elsewhere/*', rules)).toBe('deny')
    expect(evaluatePermissionV2('shell', 'ls', rules)).toBe('ask')
  })

  it('lets a trailing-space wildcard match the bare command', () => {
    // #given
    const rules: readonly PermissionRuleV2[] = [{action: 'shell', resource: 'git *', effect: 'deny'}]

    // #when / #then
    expect(evaluatePermissionV2('shell', 'git', rules)).toBe('deny')
    expect(evaluatePermissionV2('shell', 'git status', rules)).toBe('deny')
    expect(evaluatePermissionV2('shell', 'gitx', rules)).toBe('ask')
  })

  it('matches action wildcards like the server does', () => {
    // #given
    const rules: readonly PermissionRuleV2[] = [{action: '*', resource: '*', effect: 'deny'}]

    // #when / #then
    expect(evaluatePermissionV2('opencode_session_move', '*', rules)).toBe('deny')
  })
})

describe('verifyPermissionRules', () => {
  it('passes and checks every agent, subagents and tool-less agents included', async () => {
    // #given
    const logger = makeLogger()
    const source = sourceOf(envelope(effectiveAgents(goodRules())))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, logger)

    // #then
    expect(reportOf(result)).toEqual({checkedAgents: ['build', 'general', 'explore', 'title']})
  })

  it('fails when the outside deny is missing from one agent', async () => {
    // #given
    const withoutOutsideDeny = goodRules().filter(
      rule => !(rule.action === 'external_directory' && rule.effect === 'deny'),
    )
    const source = sourceOf(envelope(effectiveAgents(goodRules(), {build: withoutOutsideDeny})))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    expect(violationsOf(result).map(v => [v.agentId, v.check])).toContainEqual(['build', 'outside-policy-violated'])
  })

  it('fails an Action expectation when the outside rule is ask, because the Action requires deny', async () => {
    // #given
    const askOutside = rulesFor({
      outsideEffect: 'ask',
      allowedExternalDirectories: [RESPONSE_DIR, ATTACHMENT_DIR],
      editDenyResources: [],
      denyQuestion: true,
    })
    const source = sourceOf(envelope(effectiveAgents(askOutside)))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    const violations = violationsOf(result)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.every(v => v.check === 'outside-policy-violated' && v.effect === 'ask')).toBe(true)
  })

  it('passes a workspace expectation when the outside rule is ask, or deny', async () => {
    // #given
    const asked = await verifyPermissionRules(
      sourceOf(envelope(effectiveAgents(workspaceRules()))),
      WORKSPACE_EXPECTATIONS,
      makeLogger(),
    )
    const denied = await verifyPermissionRules(
      sourceOf(envelope(effectiveAgents(goodRules()))),
      WORKSPACE_EXPECTATIONS,
      makeLogger(),
    )

    // #then
    expect(reportOf(asked).checkedAgents).toEqual(['build', 'general', 'explore', 'title'])
    expect(reportOf(denied).checkedAgents).toEqual(['build', 'general', 'explore', 'title'])
  })

  it('fails a workspace expectation when the boundary resolves to allow', async () => {
    // #given
    const overridden = workspaceRules({action: 'external_directory', resource: '*', effect: 'allow'})
    const source = sourceOf(envelope(effectiveAgents(goodRules(), {build: overridden})))

    // #when
    const result = await verifyPermissionRules(source, WORKSPACE_EXPECTATIONS, makeLogger())

    // #then
    const violations = violationsOf(result)
    expect(violations.every(v => v.agentId === 'build' && v.check === 'outside-policy-violated')).toBe(true)
    expect(violations.every(v => v.effect === 'allow')).toBe(true)
  })

  it('fails when a subagent is missing the deny while build has it', async () => {
    // #given
    const subagentRules: readonly PermissionRuleV2[] = []
    const source = sourceOf(envelope(effectiveAgents(goodRules(), {general: subagentRules})))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    const agentIds = new Set(violationsOf(result).map(v => v.agentId))
    expect(agentIds.has('general')).toBe(true)
    expect(agentIds.has('build')).toBe(false)
  })

  it('fails when a later allow overrides the deny under last-match-wins', async () => {
    // #given
    const overridden: readonly PermissionRuleV2[] = [
      ...goodRules(),
      {action: 'external_directory', resource: '*', effect: 'allow'},
    ]
    const source = sourceOf(envelope(effectiveAgents(goodRules(), {explore: overridden})))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    expect(violationsOf(result).some(v => v.agentId === 'explore' && v.check === 'outside-policy-violated')).toBe(true)
  })

  it('fails when the response-file exception is missing', async () => {
    // #given
    const rules = rulesFor({
      outsideEffect: 'deny',
      allowedExternalDirectories: [ATTACHMENT_DIR],
      editDenyResources: [],
      denyQuestion: true,
    })
    const source = sourceOf(envelope(effectiveAgents(rules)))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    const violations = violationsOf(result)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.every(v => v.check === 'exception-not-allowed')).toBe(true)
    expect(violations.every(v => v.resource === externalDirectoryResource(RESPONSE_DIR))).toBe(true)
  })

  it('fails when the attachment exception is missing', async () => {
    // #given
    const rules = rulesFor({
      outsideEffect: 'deny',
      allowedExternalDirectories: [RESPONSE_DIR],
      editDenyResources: [],
      denyQuestion: true,
    })
    const source = sourceOf(envelope(effectiveAgents(rules)))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    const violations = violationsOf(result)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.every(v => v.resource === externalDirectoryResource(ATTACHMENT_DIR))).toBe(true)
  })

  it('fails when a sibling run directory is allowed by an over-broad exception', async () => {
    // #given
    const broad: readonly PermissionRuleV2[] = [
      ...goodRules(),
      {action: 'external_directory', resource: '/runner/_temp/fro-bot-attachments/*', effect: 'allow'},
    ]
    const source = sourceOf(envelope(effectiveAgents(goodRules(), {build: broad})))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    expect(violationsOf(result).length).toBeGreaterThan(0)
  })

  it('fails an agent with no boundary rule, no exception and no forbidden-tool deny', async () => {
    // #given: an agent whose rules say nothing about these actions, so each evaluates to the default ask
    const silent: readonly PermissionRuleV2[] = [{action: 'read', resource: '*', effect: 'allow'}]
    const source = sourceOf(envelope([{id: 'build', permissions: silent}]))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    const violations = violationsOf(result)
    expect(new Set(violations.map(v => v.check))).toEqual(
      new Set(['outside-policy-violated', 'exception-not-allowed', 'action-not-denied']),
    )
    expect(violations.filter(v => v.check === 'exception-not-allowed').every(v => v.effect === 'ask')).toBe(true)
    expect(violations.filter(v => v.check !== 'exception-not-allowed').every(v => v.effect === 'none')).toBe(true)
  })

  it('evaluates a directory given with a trailing slash as the same resource', async () => {
    // #given
    const rules = goodRules()
    const source = sourceOf(envelope(effectiveAgents(rules)))

    // #when
    const result = await verifyPermissionRules(
      source,
      {...EXPECTATIONS, allowedDirectories: [`${RESPONSE_DIR}/`, `${ATTACHMENT_DIR}//`]},
      makeLogger(),
    )

    // #then
    expect(externalDirectoryResource(`${RESPONSE_DIR}/`)).toBe(`${RESPONSE_DIR}/*`)
    expect(reportOf(result).checkedAgents.length).toBeGreaterThan(0)
  })

  it('fails when a forbidden tool action is not denied', async () => {
    // #given
    const withoutMoveDeny = goodRules().filter(rule => rule.action !== 'opencode_session_move')
    const source = sourceOf(envelope(effectiveAgents(withoutMoveDeny)))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    const violations = violationsOf(result)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.every(v => v.check === 'action-not-denied')).toBe(true)
    expect(violations.every(v => v.action === 'opencode_session_move')).toBe(true)
  })

  describe('structural boundary check', () => {
    const SCOPED_USER: readonly PermissionRuleV2[] = [
      {action: '*', resource: '*', effect: 'deny'},
      {action: 'read', resource: '/etc/*', effect: 'allow'},
      {action: 'external_directory', resource: '*', effect: 'allow'},
    ]

    function withTrailing(
      base: readonly PermissionRuleV2[],
      ...extra: readonly PermissionRuleV2[]
    ): readonly PermissionRuleV2[] {
      return [...base, ...extra]
    }

    it('verifies a subagent whose only tool use is resource-scoped, next to a compliant build agent', async () => {
      // #given: `scoped` evaluates to deny for resource `*` on every path tool, yet can read /etc and reach any directory
      const agents = [
        ...effectiveAgents(goodRules()),
        {id: 'scoped', name: 'scoped', mode: 'subagent', hidden: false, permissions: SCOPED_USER},
      ]

      // #when
      const result = await verifyPermissionRules(sourceOf(envelope(agents)), EXPECTATIONS, makeLogger())

      // #then
      const violations = violationsOf(result)
      expect(new Set(violations.map(v => v.agentId))).toEqual(new Set(['scoped']))
      expect(violations).toContainEqual({
        agentId: 'scoped',
        check: 'outside-policy-violated',
        action: 'external_directory',
        resource: '*',
        effect: 'allow',
      })
    })

    it.each([
      ['the Action', EXPECTATIONS, goodRules()],
      ['the workspace', WORKSPACE_EXPECTATIONS, workspaceRules()],
    ])('fails %s when a later targeted external_directory allow is appended', async (_label, expectations, base) => {
      // #given
      const hostile = withTrailing(base, {action: 'external_directory', resource: '/etc/*', effect: 'allow'})
      const source = sourceOf(envelope(effectiveAgents(base, {build: hostile})))

      // #when
      const result = await verifyPermissionRules(source, expectations, makeLogger())

      // #then
      const violations = violationsOf(result)
      expect(violations).toEqual([
        {
          agentId: 'build',
          check: 'outside-policy-violated',
          action: 'external_directory',
          resource: '/etc/*',
          effect: 'allow',
        },
      ])
      expect(errorOf(result).message).toContain('build')
      expect(errorOf(result).message).toContain('/etc/*')
    })

    it.each([
      ['the Action', EXPECTATIONS, goodRules()],
      ['the workspace', WORKSPACE_EXPECTATIONS, workspaceRules()],
    ])('fails %s when a later wildcard-action rule allows a targeted resource', async (_label, expectations, base) => {
      // #given
      const hostile = withTrailing(base, {action: '*', resource: '/etc/*', effect: 'allow'})
      const source = sourceOf(envelope(effectiveAgents(base, {explore: hostile})))

      // #when
      const result = await verifyPermissionRules(source, expectations, makeLogger())

      // #then
      // #and the same rule also reopens both forbidden tools
      const violations = violationsOf(result)
      expect(new Set(violations.map(v => v.agentId))).toEqual(new Set(['explore']))
      expect(violations.every(v => v.resource === '/etc/*' && v.effect === 'allow')).toBe(true)
      expect(violations.map(v => v.action).toSorted()).toEqual([
        'external_directory',
        'opencode_session_move',
        'opencode_worktree_create',
      ])
    })

    it('accepts a later ask on the workspace and fails it on the Action', async () => {
      // #given
      const ask: PermissionRuleV2 = {action: 'external_directory', resource: '/var/data/*', effect: 'ask'}

      // #when
      const workspace = await verifyPermissionRules(
        sourceOf(envelope(effectiveAgents(workspaceRules(ask)))),
        WORKSPACE_EXPECTATIONS,
        makeLogger(),
      )
      const action = await verifyPermissionRules(
        sourceOf(envelope(effectiveAgents(withTrailing(goodRules(), ask)))),
        EXPECTATIONS,
        makeLogger(),
      )

      // #then
      expect(workspace.success).toBe(true)
      expect(violationsOf(action).every(v => v.check === 'outside-policy-violated' && v.effect === 'ask')).toBe(true)
      expect(violationsOf(action).every(v => v.resource === '/var/data/*')).toBe(true)
    })

    it('accepts a later deny for a targeted resource', async () => {
      // #given
      const hostile = withTrailing(goodRules(), {action: 'external_directory', resource: '/etc/*', effect: 'deny'})
      const source = sourceOf(envelope(effectiveAgents(goodRules(), {build: hostile})))

      // #when
      const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

      // #then
      expect(result.success).toBe(true)
    })

    it('ignores rules before the boundary, which the * boundary overrides', async () => {
      // #given
      const prefixed: readonly PermissionRuleV2[] = [
        {action: 'external_directory', resource: '/etc/*', effect: 'allow'},
        ...goodRules(),
      ]
      const source = sourceOf(envelope(effectiveAgents(goodRules(), {build: prefixed})))

      // #when
      const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

      // #then
      expect(result.success).toBe(true)
    })

    it('ignores later rules for other actions', async () => {
      // #given
      const extra = withTrailing(goodRules(), {action: 'read', resource: '/etc/*', effect: 'allow'})
      const source = sourceOf(envelope(effectiveAgents(goodRules(), {build: extra})))

      // #when
      const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

      // #then
      expect(result.success).toBe(true)
    })

    it('treats a later rule on the exact exception pattern as authorized', async () => {
      // #given
      const repeated = withTrailing(goodRules(), {
        action: 'external_directory',
        resource: externalDirectoryResource(RESPONSE_DIR),
        effect: 'allow',
      })
      const source = sourceOf(envelope(effectiveAgents(goodRules(), {build: repeated})))

      // #when
      const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

      // #then
      expect(result.success).toBe(true)
    })

    it('fails when a later ask downgrades an exception on the exact pattern', async () => {
      // #given
      const downgraded = withTrailing(workspaceRules(), {
        action: 'external_directory',
        resource: externalDirectoryResource(RESPONSE_DIR),
        effect: 'ask',
      })
      const source = sourceOf(envelope(effectiveAgents(goodRules(), {build: downgraded})))

      // #when
      const result = await verifyPermissionRules(source, WORKSPACE_EXPECTATIONS, makeLogger())

      // #then
      expect(violationsOf(result)).toEqual([
        {
          agentId: 'build',
          check: 'exception-not-allowed',
          action: 'external_directory',
          resource: externalDirectoryResource(RESPONSE_DIR),
          effect: 'ask',
        },
      ])
    })

    it.each(['opencode_session_move', 'opencode_worktree_create'])(
      'fails when a later rule allows a resource of the forbidden tool %s',
      async action => {
        // #given
        const hostile = withTrailing(goodRules(), {action, resource: 'sessions/*', effect: 'allow'})
        const source = sourceOf(envelope(effectiveAgents(goodRules(), {general: hostile})))

        // #when
        const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

        // #then
        expect(violationsOf(result)).toEqual([
          {agentId: 'general', check: 'action-not-denied', action, resource: 'sessions/*', effect: 'allow'},
        ])
      },
    )

    it('fails when a later wildcard-action ask makes a forbidden tool askable', async () => {
      // #given
      const hostile = withTrailing(goodRules(), {action: '*', resource: 'x', effect: 'ask'})
      const source = sourceOf(envelope(effectiveAgents(goodRules(), {build: hostile})))

      // #when
      const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

      // #then
      const violations = violationsOf(result)
      expect(violations.map(v => v.action).toSorted()).toEqual([
        'external_directory',
        'opencode_session_move',
        'opencode_worktree_create',
      ])
    })

    it('names the missing boundary with effect none', async () => {
      // #given
      const source = sourceOf(envelope([{id: 'bare', permissions: [{action: 'read', resource: '*', effect: 'allow'}]}]))

      // #when
      const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

      // #then
      expect(violationsOf(result)).toContainEqual({
        agentId: 'bare',
        check: 'outside-policy-violated',
        action: 'external_directory',
        resource: '*',
        effect: 'none',
      })
    })
  })

  it('does not check question or .env rules', async () => {
    // #given
    const rules = goodRules().filter(
      rule => rule.action !== 'question' && rule.action !== 'read' && rule.action !== 'edit',
    )
    const source = sourceOf(envelope(effectiveAgents(rules)))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    expect(reportOf(result).checkedAgents).toEqual(['build', 'general', 'explore', 'title'])
  })

  it('fails closed when the server lists no agents', async () => {
    // #given
    const source = sourceOf(envelope([]))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    expect(errorOf(result).kind).toBe('no-agents')
  })

  it.each([
    ['null', null],
    ['a bare array', []],
    ['no data field', {location: {}}],
    ['data that is not an array', {data: 'nope'}],
    ['an agent without an id', {data: [{permissions: []}]}],
    ['an agent without permissions', {data: [{id: 'build'}]}],
    [
      'a rule with an unknown effect',
      {data: [{id: 'build', permissions: [{action: 'a', resource: 'r', effect: 'maybe'}]}]},
    ],
    [
      'a rule in the v1 spelling',
      {data: [{id: 'build', permissions: [{permission: 'a', pattern: 'r', action: 'deny'}]}]},
    ],
  ])('rejects a malformed /api/agent body: %s', async (_label, body) => {
    // #when
    const result = await verifyPermissionRules(sourceOf(body), EXPECTATIONS, makeLogger())

    // #then
    expect(errorOf(result).kind).toBe('malformed-agent-list')
  })

  it('reports an unreachable agent list without leaking the thrown error object', async () => {
    // #given
    const source = {
      listAgents: async () => {
        throw new Error('503 Location plugins did not finish activating')
      },
    }

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    const error = errorOf(result)
    expect(error.kind).toBe('agent-list-unavailable')
    expect(error.message).toContain('503')
  })
})
