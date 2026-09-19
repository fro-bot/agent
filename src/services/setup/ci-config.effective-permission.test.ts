import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {buildCIConfig} from './ci-config.js'

/**
 * `scopeAttachmentDirectoryPermission` (ci-config.ts) writes a top-level, global
 * `permission.external_directory` grant so a dispatched subagent inherits read access to the
 * reference-file attachment directory. A test that only asserts the SHAPE of the generated
 * `opencode.json` -- "does this key exist" -- would pass even if that grant never actually
 * reached a subagent's session, which is exactly the defect a naive fix could reintroduce (see
 * this project's own `agent.build.permission` shadowing the same global grant for the `build`
 * agent, which is why that block re-asserts the attachment pattern itself).
 *
 * These tests instead RESOLVE the config through a minimal, faithful reimplementation of
 * upstream's own merge/evaluate/inheritance algorithm, verified against `anomalyco/opencode` at
 * the pinned tag (`packages/harness/harness.config.json`'s `base_version` -- the vendored clone
 * other comments in this codebase cite is not present on this host, so this file records the
 * verified shape inline instead):
 *
 * - `packages/opencode/src/permission/index.ts` `fromConfig`: expands a config permission object
 *   into a flat rule list (`{permission, pattern, action}`) -- one rule per key when the value is
 *   a bare string (`pattern: '*'`), one rule per (pattern, action) entry when the value is an
 *   object.
 * - `merge`: a bare `.flat()` -- rulesets are concatenated, nothing more.
 * - `evaluate`: `rulesets.flat().findLast(rule => match(permission) && match(pattern))` -- the
 *   LAST array entry matching BOTH fields wins; an unmatched request falls back to `ask`.
 * - `packages/opencode/src/agent/agent.ts` builds each built-in agent's ruleset as
 *   `Permission.merge(defaults, <agent-specific defaults>, user)`, where `user =
 *   Permission.fromConfig(cfg.permission ?? {})` -- i.e. THIS project's top-level `permission`
 *   key, appended LAST, so it overrides that agent's own built-in defaults for any pattern it
 *   also names.
 * - `packages/opencode/src/agent/subagent-permissions.ts` `deriveSubagentSessionPermission`: a
 *   dispatched subagent's session inherits ONLY the parent SESSION's `external_directory` rules
 *   and its `deny` rules directly -- not the whole ruleset, and not recomputed from the
 *   subagent's own named agent's config.
 */
interface Rule {
  readonly permission: string
  readonly pattern: string
  readonly action: 'allow' | 'ask' | 'deny'
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`)
}

function wildcardMatch(value: string, pattern: string): boolean {
  return wildcardToRegExp(pattern).test(value)
}

function fromConfig(permission: Record<string, unknown>): readonly Rule[] {
  const rules: Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === 'string') {
      rules.push({permission: key, pattern: '*', action: value as Rule['action']})
      continue
    }
    if (value != null && typeof value === 'object') {
      for (const [pattern, action] of Object.entries(value as Record<string, string>)) {
        rules.push({permission: key, pattern, action: action as Rule['action']})
      }
    }
  }
  return rules
}

function merge(...rulesets: readonly (readonly Rule[])[]): readonly Rule[] {
  return rulesets.flat()
}

function evaluate(permission: string, pattern: string, ...rulesets: readonly (readonly Rule[])[]): Rule {
  const flat = rulesets.flat()
  for (let index = flat.length - 1; index >= 0; index--) {
    const rule = flat[index]
    if (rule != null && wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) {
      return rule
    }
  }
  return {permission, pattern: '*', action: 'ask'}
}

/**
 * Upstream's `deriveSubagentSessionPermission`, minus the `todowrite`/`task` defaults this
 * simulation doesn't need to exercise (those don't affect `external_directory` resolution).
 */
function deriveSubagentSessionPermission(parentSessionPermission: readonly Rule[]): readonly Rule[] {
  return parentSessionPermission.filter(rule => rule.permission === 'external_directory' || rule.action === 'deny')
}

function attachmentPattern(runnerTemp: string): string {
  return `${runnerTemp}/fro-bot-attachments/*`
}

const RUNNER_TEMP = '/home/runner/work/_temp'

beforeEach(() => {
  vi.stubEnv('RUNNER_TEMP', RUNNER_TEMP)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('effective child permission for the reference-file attachment directory', () => {
  it('a subagent dispatched from an agent with no external_directory override of its own can read the attachment directory (the fix this test pins)', () => {
    // #given the harness's own generated OMO Slim config -- the mode where subagent dispatch
    // actually happens
    const result = buildCIConfig(
      {
        opencodeConfig: null,
        systematicVersion: '1.0.0',
        enableOmo: false,
        enableOmoSlim: true,
        omoSlimVersion: '1.1.1',
      },
      createMockLogger(),
    )
    const permission = (result.config as {permission?: Record<string, unknown>}).permission
    if (permission == null) throw new Error('expected buildCIConfig to have set a top-level permission key')
    const globalUser = fromConfig(permission)

    // #given a hypothetical agent's own ruleset with NO external_directory override -- e.g. an
    // orchestrator or dispatched subagent whose own config never mentions external_directory
    const agentOwnRuleset = fromConfig({external_directory: {'*': 'ask'}})
    const rootSessionPermission = merge(agentOwnRuleset, globalUser)

    // #when a subagent is dispatched from that root session
    const subagentSessionPermission = deriveSubagentSessionPermission(rootSessionPermission)

    // #then the attachment directory ask resolves to allow for the SUBAGENT's own session --
    // not merely present somewhere in the generated JSON
    const resolved = evaluate('external_directory', attachmentPattern(RUNNER_TEMP), subagentSessionPermission)
    expect(resolved.action).toBe('allow')
  })

  it('still resolves to allow for the root session itself before any dispatch happens', () => {
    const result = buildCIConfig(
      {
        opencodeConfig: null,
        systematicVersion: '1.0.0',
        enableOmo: false,
        enableOmoSlim: true,
        omoSlimVersion: '1.1.1',
      },
      createMockLogger(),
    )
    const permission = (result.config as {permission?: Record<string, unknown>}).permission
    if (permission == null) throw new Error('expected buildCIConfig to have set a top-level permission key')
    const globalUser = fromConfig(permission)
    const agentOwnRuleset = fromConfig({external_directory: {'*': 'ask'}})
    const rootSessionPermission = merge(agentOwnRuleset, globalUser)

    const resolved = evaluate('external_directory', attachmentPattern(RUNNER_TEMP), rootSessionPermission)
    expect(resolved.action).toBe('allow')
  })

  it("kNOWN GAP, documented rather than silently assumed away: an agent-specific override appended after this project's global grant (e.g. a plugin's own agent config) still shadows it for that agent's OWN session -- this project's CI config cannot see or control a plugin's own agent definitions", () => {
    const result = buildCIConfig(
      {
        opencodeConfig: null,
        systematicVersion: '1.0.0',
        enableOmo: false,
        enableOmoSlim: true,
        omoSlimVersion: '1.1.1',
      },
      createMockLogger(),
    )
    const permission = (result.config as {permission?: Record<string, unknown>}).permission
    if (permission == null) throw new Error('expected buildCIConfig to have set a top-level permission key')
    const globalUser = fromConfig(permission)
    const agentOwnRuleset = fromConfig({external_directory: {'*': 'ask'}})
    // Mirrors upstream's `cfg.agent` loop: `item.permission = merge(item.permission,
    // fromConfig(value.permission))` -- the agent-specific block is appended LAST.
    const pluginAgentSpecificOverride = fromConfig({external_directory: 'deny'})
    const agentSessionPermission = merge(agentOwnRuleset, globalUser, pluginAgentSpecificOverride)

    const resolved = evaluate('external_directory', attachmentPattern(RUNNER_TEMP), agentSessionPermission)
    expect(resolved.action).toBe('deny')
  })

  it('matches the exact same effective-permission mechanism for the build agent (disabled mode) via its own agent-specific block, not the global grant', () => {
    // #given disabled mode, where `scopeExternalDirectoryPermission` writes a full,
    // self-contained override into `agent.build.permission` -- appended AFTER the global grant
    // for the `build` agent specifically
    const result = buildCIConfig(
      {opencodeConfig: null, systematicVersion: '1.0.0', enableOmo: false},
      createMockLogger(),
    )
    const config = result.config as {
      permission?: Record<string, unknown>
      agent: {build: {permission: Record<string, unknown>}}
    }
    if (config.permission == null) throw new Error('expected a global grant even though build overrides it')
    const globalUser = fromConfig(config.permission)
    const buildAgentDefaults = fromConfig({external_directory: {'*': 'ask'}})
    const buildAgentOverride = fromConfig(config.agent.build.permission)
    const buildSessionPermission = merge(buildAgentDefaults, globalUser, buildAgentOverride)

    // #then the build agent's OWN re-asserted pattern is what actually grants it -- proving the
    // build-agent-scoped duplicate in `scopeExternalDirectoryPermission` is load-bearing, not
    // redundant, exactly as its doc comment claims
    const resolved = evaluate('external_directory', attachmentPattern(RUNNER_TEMP), buildSessionPermission)
    expect(resolved.action).toBe('allow')

    // #then removing just the build-agent-specific entry (simulating the global grant alone)
    // would NOT have been enough for the build agent -- its own '*' deny still wins
    const withoutBuildOwnAttachmentEntry = buildAgentOverride.filter(
      rule => !(rule.permission === 'external_directory' && rule.pattern === attachmentPattern(RUNNER_TEMP)),
    )
    const withoutOwnEntry = merge(buildAgentDefaults, globalUser, withoutBuildOwnAttachmentEntry)
    const resolvedWithoutOwnEntry = evaluate('external_directory', attachmentPattern(RUNNER_TEMP), withoutOwnEntry)
    expect(resolvedWithoutOwnEntry.action).toBe('deny')
  })
})
