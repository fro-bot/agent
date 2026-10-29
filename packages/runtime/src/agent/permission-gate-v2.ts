/**
 * Startup gate over the effective permission rules of a running OpenCode v2 server.
 *
 * After spawn, `GET /api/agent` returns every registered agent with its effective rules: the agent's built-in rules
 * with the configured `permissions` appended (`protocol/src/groups/agent.ts` `agent.list`, response
 * `{location, data: Agent.Info[]}`; `schema/src/agent.ts` `Agent.Info.permissions` is `{action, resource, effect}[]`).
 * Configured `permissions` apply to every agent, so the gate checks every agent, including ones that look tool-less.
 *
 * The check is structural, not sampled. For each guarded action it finds the boundary, the last rule whose action
 * pattern matches and whose resource is exactly `*`. The boundary overrides everything before it. The boundary's effect
 * must satisfy the surface policy, and every later rule that matches the action must either carry a permitted effect
 * or sit on an authorized exception pattern, compared as exact strings. Sampling paths cannot prove this, because a
 * targeted allow such as `external_directory /etc/*` matches no sentinel.
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

/**
 * What the outside-checkout boundary may be, and what later rules may be besides authorized exceptions.
 * - `deny`: the Action, where nobody can answer an ask.
 * - `ask-or-deny`: the gateway workspace, where an ask goes to Discord approval. `allow` never passes.
 */
export type OutsidePolicyV2 = 'deny' | 'ask-or-deny'

const OUTSIDE_POLICY_EFFECTS = {
  deny: ['deny'],
  'ask-or-deny': ['ask', 'deny'],
} as const satisfies Record<OutsidePolicyV2, readonly PermissionEffectV2[]>

export interface PermissionGateExpectations {
  /** The effects the outside-checkout boundary, and any later rule that is not an exception, may have. */
  readonly outsidePolicy: OutsidePolicyV2
  /** Literal exception directories. Each must evaluate to `allow`, and its `<dir>/*` pattern is the only authorized one. */
  readonly allowedDirectories: readonly string[]
  /** Tool actions that must be denied for every resource. No exception is authorized. */
  readonly deniedActions: readonly string[]
}

export type PermissionGateCheck = 'outside-policy-violated' | 'exception-not-allowed' | 'action-not-denied'

export interface PermissionGateViolation {
  readonly agentId: string
  readonly check: PermissionGateCheck
  readonly action: string
  readonly resource: string
  /** The offending rule's effect, or `none` when the agent has no boundary rule for the action. */
  readonly effect: PermissionEffectV2 | 'none'
}

export interface PermissionGateReport {
  readonly checkedAgents: readonly string[]
}

export type PermissionGateError =
  | {readonly kind: 'agent-list-unavailable'; readonly message: string}
  | {readonly kind: 'malformed-agent-list'; readonly message: string}
  | {readonly kind: 'no-agents'; readonly message: string}
  | {readonly kind: 'rules-missing'; readonly message: string; readonly violations: readonly PermissionGateViolation[]}

const EXTERNAL_DIRECTORY_ACTION = 'external_directory'

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

interface BoundaryCheck {
  readonly agentId: string
  readonly rules: readonly PermissionRuleV2[]
  readonly action: string
  readonly check: PermissionGateCheck
  /** The effects the boundary and later non-exception rules may have. */
  readonly permittedEffects: readonly PermissionEffectV2[]
  /** Resource patterns a later rule may carry whatever its effect, compared as exact strings. */
  readonly exceptionResources: readonly string[]
}

/** The boundary, then every later rule: the structural check described in the file header. */
function checkBoundary({
  agentId,
  rules,
  action,
  check,
  permittedEffects,
  exceptionResources,
}: BoundaryCheck): readonly PermissionGateViolation[] {
  const boundaryIndex = rules.findLastIndex(rule => wildcardMatch(action, rule.action) && rule.resource === '*')
  const boundary = rules[boundaryIndex]
  if (boundary === undefined) return [{agentId, check, action, resource: '*', effect: 'none'}]

  const violations: PermissionGateViolation[] = []
  if (!permittedEffects.includes(boundary.effect)) {
    violations.push({agentId, check, action, resource: '*', effect: boundary.effect})
  }

  for (const rule of rules.slice(boundaryIndex + 1)) {
    if (!wildcardMatch(action, rule.action)) continue
    if (permittedEffects.includes(rule.effect) || exceptionResources.includes(rule.resource)) continue
    violations.push({agentId, check, action, resource: rule.resource, effect: rule.effect})
  }

  return violations
}

function checkAgent(
  agentId: string,
  rules: readonly PermissionRuleV2[],
  expectations: PermissionGateExpectations,
): readonly PermissionGateViolation[] {
  const exceptionResources = expectations.allowedDirectories.map(externalDirectoryResource)

  const violations: PermissionGateViolation[] = [
    ...checkBoundary({
      agentId,
      rules,
      action: EXTERNAL_DIRECTORY_ACTION,
      check: 'outside-policy-violated',
      permittedEffects: OUTSIDE_POLICY_EFFECTS[expectations.outsidePolicy],
      exceptionResources,
    }),
  ]

  for (const resource of exceptionResources) {
    const effect = evaluatePermissionV2(EXTERNAL_DIRECTORY_ACTION, resource, rules)
    if (effect !== 'allow') {
      violations.push({agentId, check: 'exception-not-allowed', action: EXTERNAL_DIRECTORY_ACTION, resource, effect})
    }
  }

  for (const action of expectations.deniedActions) {
    violations.push(
      ...checkBoundary({
        agentId,
        rules,
        action,
        check: 'action-not-denied',
        permittedEffects: ['deny'],
        exceptionResources: [],
      }),
    )
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

  if (parsed.data.data.length === 0) {
    return err({
      kind: 'no-agents',
      message: 'The server lists no agents, so the permission rules cannot be verified.',
    })
  }

  const checkedAgents = parsed.data.data.map(agent => agent.id)
  const violations = parsed.data.data.flatMap(agent => checkAgent(agent.id, agent.permissions, expectations))

  if (violations.length > 0) {
    const detail = violations.map(v => `${v.agentId}: ${v.check} ${v.action} ${v.resource} (${v.effect})`).join('; ')
    return err({kind: 'rules-missing', message: `Effective permission rules are incomplete: ${detail}`, violations})
  }

  logger.debug('Permission gate passed', {checkedAgents})
  return ok({checkedAgents})
}
