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
  outsideDirectories: ['/fro-bot-gate-sentinel/outside', '/runner/_temp/fro-bot-attachments/other-run'],
  allowedDirectories: [RESPONSE_DIR, ATTACHMENT_DIR],
  deniedActions: ['opencode_session_move', 'opencode_worktree_create'],
}

function makeLogger(): Logger {
  return {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}
}

function goodRules(): readonly PermissionRuleV2[] {
  return buildPermissionRulesV2({
    allowedExternalDirectories: [RESPONSE_DIR, ATTACHMENT_DIR],
    editDenyResources: [],
    denyQuestion: true,
  })
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
  it('passes for every tool-capable agent, subagents included, and skips agents that cannot run tools', async () => {
    // #given
    const logger = makeLogger()
    const source = sourceOf(envelope(effectiveAgents(goodRules())))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, logger)

    // #then
    expect(reportOf(result)).toEqual({checkedAgents: ['build', 'general', 'explore'], skippedAgents: ['title']})
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
    expect(violationsOf(result).map(v => [v.agentId, v.check])).toContainEqual(['build', 'outside-not-denied'])
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
    expect(violationsOf(result).some(v => v.agentId === 'explore' && v.check === 'outside-not-denied')).toBe(true)
  })

  it('fails when the response-file exception is missing', async () => {
    // #given
    const rules = buildPermissionRulesV2({
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
    expect(violations.every(v => v.subject === externalDirectoryResource(RESPONSE_DIR))).toBe(true)
  })

  it('fails when the attachment exception is missing', async () => {
    // #given
    const rules = buildPermissionRulesV2({
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
    expect(violations.every(v => v.subject === externalDirectoryResource(ATTACHMENT_DIR))).toBe(true)
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

  it('treats an unanswered ask as missing for the deny, the exception and the forbidden tools', async () => {
    // #given: an agent whose rules say nothing about these resources, so each evaluates to the default ask
    const silent: readonly PermissionRuleV2[] = [{action: 'read', resource: '*', effect: 'allow'}]
    const source = sourceOf(envelope([{id: 'build', permissions: silent}]))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    const violations = violationsOf(result)
    expect(new Set(violations.map(v => v.check))).toEqual(
      new Set(['outside-not-denied', 'exception-not-allowed', 'action-not-denied']),
    )
    expect(violations.every(v => v.effect === 'ask')).toBe(true)
  })

  it('evaluates a directory given with a trailing slash as the same resource', async () => {
    // #given
    const rules = buildPermissionRulesV2({
      allowedExternalDirectories: [RESPONSE_DIR, ATTACHMENT_DIR],
      editDenyResources: [],
      denyQuestion: true,
    })
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
    expect(violations.every(v => v.subject === 'opencode_session_move')).toBe(true)
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
    expect(reportOf(result).checkedAgents).toEqual(['build', 'general', 'explore'])
  })

  it('fails closed when no agent can run tools', async () => {
    // #given
    const source = sourceOf(envelope([{id: 'title', permissions: [{action: '*', resource: '*', effect: 'deny'}]}]))

    // #when
    const result = await verifyPermissionRules(source, EXPECTATIONS, makeLogger())

    // #then
    expect(errorOf(result).kind).toBe('no-tool-capable-agents')
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
