/**
 * Startup gate over the effective permission rules of a running OpenCode v2 server.
 *
 * After spawn, `GET /api/agent` returns every registered agent with its effective rules: the agent's built-in rules
 * with the configured `permissions` appended (`protocol/src/groups/agent.ts` `agent.list`, response
 * `{location, data: Agent.Info[]}`; `schema/src/agent.ts` `Agent.Info.permissions` is `{action, resource, effect}[]`).
 * The gate evaluates sentinel resources against each tool-capable agent, subagents included, and fails if an outside
 * deny, a delivery-path exception or a forbidden-tool deny is missing.
 *
 * It checks that the rules exist, not that the server enforces them. It does not check `question` or `.env`.
 */

import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import type {PermissionEffectV2, PermissionRuleV2} from './permission-rules-v2.js'

import {err, ok} from '@bfra.me/es/result'
import {z} from 'zod'

import {externalDirectoryResource} from './permission-rules-v2.js'

/** The only thing the gate needs from a server handle. A thrown error means the list could not be read. */
export interface AgentListSource {
  /** The parsed JSON body of `GET /api/agent`. */
  readonly listAgents: () => Promise<unknown>
}

export interface PermissionGateExpectations {
  /** Directories outside the checkout that must evaluate to `deny`. */
  readonly outsideDirectories: readonly string[]
  /** Delivery-path directories that must evaluate to `allow`. */
  readonly allowedDirectories: readonly string[]
  /** Tool actions that must evaluate to `deny`. */
  readonly deniedActions: readonly string[]
}

export type PermissionGateCheck = 'outside-not-denied' | 'exception-not-allowed' | 'action-not-denied'

export interface PermissionGateViolation {
  readonly agentId: string
  readonly check: PermissionGateCheck
  /** The resource, or the action name, that was evaluated. */
  readonly subject: string
  readonly effect: PermissionEffectV2
}

export interface PermissionGateReport {
  readonly checkedAgents: readonly string[]
  readonly skippedAgents: readonly string[]
}

export type PermissionGateError =
  | {readonly kind: 'agent-list-unavailable'; readonly message: string}
  | {readonly kind: 'malformed-agent-list'; readonly message: string}
  | {readonly kind: 'no-tool-capable-agents'; readonly message: string}
  | {readonly kind: 'rules-missing'; readonly message: string; readonly violations: readonly PermissionGateViolation[]}

/** Actions that read or write paths. An agent that denies all of them cannot reach the filesystem. */
const PATH_TOOL_ACTIONS = ['shell', 'read', 'edit', 'glob', 'grep'] as const

const AgentListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      permissions: z.array(
        z.object({
          action: z.string(),
          resource: z.string(),
          effect: z.enum(['allow', 'ask', 'deny']),
        }),
      ),
    }),
  ),
})

/** Port of `Wildcard.match` (`core/src/util/wildcard.ts`). */
function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll('\\', '/')
  let escaped = pattern
    .replaceAll('\\', '/')
    .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll('*', '.*')
    .replaceAll('?', '.')

  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`

  return new RegExp(`^${escaped}$`, 's').test(normalized)
}

/** Port of `Permission.evaluate` (`core/src/permission.ts`): the last matching rule wins, and no match asks. */
export function evaluatePermissionV2(
  action: string,
  resource: string,
  rules: readonly PermissionRuleV2[],
): PermissionEffectV2 {
  const match = rules.findLast(rule => wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource))
  return match?.effect ?? 'ask'
}

function canRunTools(rules: readonly PermissionRuleV2[]): boolean {
  return PATH_TOOL_ACTIONS.some(action => evaluatePermissionV2(action, '*', rules) !== 'deny')
}

function checkAgent(
  agentId: string,
  rules: readonly PermissionRuleV2[],
  expectations: PermissionGateExpectations,
): readonly PermissionGateViolation[] {
  const violations: PermissionGateViolation[] = []

  for (const directory of expectations.outsideDirectories) {
    const subject = externalDirectoryResource(directory)
    const effect = evaluatePermissionV2('external_directory', subject, rules)
    if (effect !== 'deny') violations.push({agentId, check: 'outside-not-denied', subject, effect})
  }

  for (const directory of expectations.allowedDirectories) {
    const subject = externalDirectoryResource(directory)
    const effect = evaluatePermissionV2('external_directory', subject, rules)
    if (effect !== 'allow') violations.push({agentId, check: 'exception-not-allowed', subject, effect})
  }

  for (const action of expectations.deniedActions) {
    const effect = evaluatePermissionV2(action, '*', rules)
    if (effect !== 'deny') violations.push({agentId, check: 'action-not-denied', subject: action, effect})
  }

  return violations
}

export async function verifyPermissionRules(
  source: AgentListSource,
  expectations: PermissionGateExpectations,
  logger: Logger,
): Promise<Result<PermissionGateReport, PermissionGateError>> {
  let body: unknown
  try {
    body = await source.listAgents()
  } catch (error) {
    return err({
      kind: 'agent-list-unavailable',
      message: `Could not read the effective agent rules: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const parsed = AgentListSchema.safeParse(body)
  if (!parsed.success) {
    return err({
      kind: 'malformed-agent-list',
      message: `The agent list does not have the expected shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    })
  }

  const checkedAgents: string[] = []
  const skippedAgents: string[] = []
  const violations: PermissionGateViolation[] = []

  for (const agent of parsed.data.data) {
    if (!canRunTools(agent.permissions)) {
      skippedAgents.push(agent.id)
      continue
    }
    checkedAgents.push(agent.id)
    violations.push(...checkAgent(agent.id, agent.permissions, expectations))
  }

  if (checkedAgents.length === 0) {
    return err({
      kind: 'no-tool-capable-agents',
      message: 'The server lists no agent that can run tools, so the permission rules cannot be verified.',
    })
  }

  if (violations.length > 0) {
    const detail = violations.map(v => `${v.agentId}: ${v.check} ${v.subject} (${v.effect})`).join('; ')
    return err({kind: 'rules-missing', message: `Effective permission rules are incomplete: ${detail}`, violations})
  }

  logger.debug('Permission gate passed', {checkedAgents, skippedAgents})
  return ok({checkedAgents, skippedAgents})
}
