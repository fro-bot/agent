/**
 * Permission rules and config content for OpenCode v2.2.0.
 *
 * The rules go in the top-level `permissions` list of the content passed through `OPENCODE_CONFIG_CONTENT`.
 * Other placements do not hold (probes P4, P6, P12):
 * - the global config file is overridden by a project `opencode.json`;
 * - `policies` in the content are lifted by a project policy, and leave the tool offered;
 * - a V1-spelled `agent.<id>.permission` allow in the same content overrides the deny for that agent.
 *
 * The server appends the configured `permissions` after each agent's built-in rules (`core/src/config/plugin/agent.ts`)
 * and evaluates with last-match-wins (`core/src/permission.ts` `evaluate`), so these rules outrank every built-in allow.
 * Spawns must also set `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
 */

import type {Result} from '@bfra.me/es/result'
import type {PermissionGateExpectations} from './permission-gate-v2.js'

import * as path from 'node:path'
import {err, ok} from '@bfra.me/es/result'

export type PermissionEffectV2 = 'allow' | 'ask' | 'deny'

/** The native rule shape (`schema/src/permission.ts` `Rule`). */
export interface PermissionRuleV2 {
  readonly action: string
  readonly resource: string
  readonly effect: PermissionEffectV2
}

/** Permission action names of the Code Mode `opencode` tools that move a session or create a worktree. */
export const FORBIDDEN_TOOL_ACTIONS_V2 = ['opencode_session_move', 'opencode_worktree_create'] as const

/** The resource the server asks about for a file in `directory` (`core/src/file-access.ts` `resolve`). */
export function externalDirectoryResource(directory: string): string {
  return `${directory.replaceAll('\\', '/').replace(/\/+$/, '')}/*`
}

/**
 * An exception directory becomes the pattern `<dir>/*`, and the server reads `*` and `?` in a pattern as wildcards.
 * So a directory must be a literal, absolute path: `/srv/cache?` would otherwise also grant `/srv/cache1/*`.
 * The filesystem root is refused because `/` normalizes to the pattern `/*`, which matches every path.
 */
function validateExceptionDirectory(directory: string): Result<string, string> {
  if (!path.isAbsolute(directory)) {
    return err(`Exception directories must be absolute paths, got: ${directory}`)
  }
  if (/[*?]/.test(directory)) {
    return err(`Exception directories must not contain the wildcard characters * or ?, got: ${directory}`)
  }
  if (directory.replaceAll('\\', '/').replace(/\/+$/, '') === '') {
    return err(`Exception directories must not be the filesystem root, got: ${directory}`)
  }
  return ok(directory)
}

export interface PermissionRulesInput {
  /** What a directory outside the checkout resolves to: `deny` in the Action, `ask` in the gateway workspace. */
  readonly outsideEffect: Exclude<PermissionEffectV2, 'allow'>
  /** Directories outside the checkout that stay reachable. Each becomes one `<dir>/*` allow after the outside rule. */
  readonly allowedExternalDirectories: readonly string[]
  /** `edit` resources denied outright, for example workspace-relative shadows of the response-file directory. */
  readonly editDenyResources: readonly string[]
  /** Deny `question`. Set in the Action, where nobody can answer. */
  readonly denyQuestion: boolean
}

/**
 * The ordered rule list. Order matters: the specific allows come after the `*` outside rule they carve out of.
 * Fails when an exception directory is not a literal absolute path (see `validateExceptionDirectory`).
 */
export function buildPermissionRulesV2(input: PermissionRulesInput): Result<readonly PermissionRuleV2[], string> {
  for (const directory of input.allowedExternalDirectories) {
    const valid = validateExceptionDirectory(directory)
    if (!valid.success) return valid
  }

  const rules: PermissionRuleV2[] = [{action: 'external_directory', resource: '*', effect: input.outsideEffect}]

  for (const directory of input.allowedExternalDirectories) {
    rules.push({action: 'external_directory', resource: externalDirectoryResource(directory), effect: 'allow'})
  }

  // `.env` files: the built-in agents leave `read *.env` at `ask`, which hangs a turn nobody can answer.
  for (const action of ['read', 'edit']) {
    rules.push(
      {action, resource: '*.env', effect: 'deny'},
      {action, resource: '*.env.*', effect: 'deny'},
      {action, resource: '*.env.example', effect: 'allow'},
    )
  }

  for (const resource of input.editDenyResources) {
    rules.push({action: 'edit', resource, effect: 'deny'})
  }

  if (input.denyQuestion) {
    rules.push({action: 'question', resource: '*', effect: 'deny'})
  }

  for (const action of FORBIDDEN_TOOL_ACTIONS_V2) {
    rules.push({action, resource: '*', effect: 'deny'})
  }

  return ok(rules)
}

export interface ConfigContentInput {
  /** Plugin specs from the surface installers. */
  readonly plugins: readonly string[]
  readonly rules: readonly PermissionRuleV2[]
}

/** The keys both surfaces set, in V2 spelling. Nested subagents stay off. */
export function buildConfigContentV2(input: ConfigContentInput): Record<string, unknown> {
  return {
    update: 'disable',
    default_agent: 'build',
    experimental: {subagent_depth: 1},
    plugins: [...new Set(input.plugins)],
    permissions: [...input.rules],
  }
}

export interface BuiltConfigV2 {
  /** The JSON object for `OPENCODE_CONFIG_CONTENT`. */
  readonly content: Readonly<Record<string, unknown>>
  /** What `verifyPermissionRules` must find in the effective rules after spawn. */
  readonly expectations: PermissionGateExpectations
}
