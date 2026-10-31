import * as path from 'node:path'
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

function attachmentPattern(runnerTemp: string, runId: string, runAttempt: string): string {
  return `${runnerTemp}/fro-bot-attachments/${runId}-${runAttempt}/*`
}

const RUNNER_TEMP = '/home/runner/work/_temp'
const RUN_ID = '4242'
const RUN_ATTEMPT = '1'

beforeEach(() => {
  vi.stubEnv('RUNNER_TEMP', RUNNER_TEMP)
  vi.stubEnv('GITHUB_RUN_ID', RUN_ID)
  vi.stubEnv('GITHUB_RUN_ATTEMPT', RUN_ATTEMPT)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('effective child permission for the reference-file attachment directory', () => {
  it('a subagent dispatched from an agent with no external_directory override of its own can read the attachment directory (the fix this test pins)', () => {
    // #given the harness's own generated config
    const result = buildCIConfig(
      {
        opencodeConfig: null,
        systematicVersion: '1.0.0',
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
    const resolved = evaluate(
      'external_directory',
      attachmentPattern(RUNNER_TEMP, RUN_ID, RUN_ATTEMPT),
      subagentSessionPermission,
    )
    expect(resolved.action).toBe('allow')
  })

  it('still resolves to allow for the root session itself before any dispatch happens', () => {
    const result = buildCIConfig(
      {
        opencodeConfig: null,
        systematicVersion: '1.0.0',
      },
      createMockLogger(),
    )
    const permission = (result.config as {permission?: Record<string, unknown>}).permission
    if (permission == null) throw new Error('expected buildCIConfig to have set a top-level permission key')
    const globalUser = fromConfig(permission)
    const agentOwnRuleset = fromConfig({external_directory: {'*': 'ask'}})
    const rootSessionPermission = merge(agentOwnRuleset, globalUser)

    const resolved = evaluate(
      'external_directory',
      attachmentPattern(RUNNER_TEMP, RUN_ID, RUN_ATTEMPT),
      rootSessionPermission,
    )
    expect(resolved.action).toBe('allow')
  })

  it("kNOWN GAP, documented rather than silently assumed away: an agent-specific override appended after this project's global grant (e.g. a plugin's own agent config) still shadows it for that agent's OWN session -- this project's CI config cannot see or control a plugin's own agent definitions", () => {
    const result = buildCIConfig(
      {
        opencodeConfig: null,
        systematicVersion: '1.0.0',
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

    const resolved = evaluate(
      'external_directory',
      attachmentPattern(RUNNER_TEMP, RUN_ID, RUN_ATTEMPT),
      agentSessionPermission,
    )
    expect(resolved.action).toBe('deny')
  })

  it('matches the exact same effective-permission mechanism for the build agent via its own agent-specific block, not the global grant', () => {
    // #given the build agent, where `scopeExternalDirectoryPermission` writes a full,
    // self-contained override into `agent.build.permission` -- appended AFTER the global grant
    // for the `build` agent specifically
    const result = buildCIConfig({opencodeConfig: null, systematicVersion: '1.0.0'}, createMockLogger())
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
    const resolved = evaluate(
      'external_directory',
      attachmentPattern(RUNNER_TEMP, RUN_ID, RUN_ATTEMPT),
      buildSessionPermission,
    )
    expect(resolved.action).toBe('allow')

    // #then removing just the build-agent-specific entry (simulating the global grant alone)
    // would NOT have been enough for the build agent -- its own '*' deny still wins
    const withoutBuildOwnAttachmentEntry = buildAgentOverride.filter(
      rule =>
        !(
          rule.permission === 'external_directory' &&
          rule.pattern === attachmentPattern(RUNNER_TEMP, RUN_ID, RUN_ATTEMPT)
        ),
    )
    const withoutOwnEntry = merge(buildAgentDefaults, globalUser, withoutBuildOwnAttachmentEntry)
    const resolvedWithoutOwnEntry = evaluate(
      'external_directory',
      attachmentPattern(RUNNER_TEMP, RUN_ID, RUN_ATTEMPT),
      withoutOwnEntry,
    )
    expect(resolvedWithoutOwnEntry.action).toBe('deny')
  })

  it("does NOT grant a sibling run-attempt's attachment subdirectory under the same segment -- the disclosure this fix closes", () => {
    // #given the harness's own generated config for THIS run (RUN_ID/RUN_ATTEMPT)
    const result = buildCIConfig(
      {
        opencodeConfig: null,
        systematicVersion: '1.0.0',
      },
      createMockLogger(),
    )
    const permission = (result.config as {permission?: Record<string, unknown>}).permission
    if (permission == null) throw new Error('expected buildCIConfig to have set a top-level permission key')
    const globalUser = fromConfig(permission)
    const agentOwnRuleset = fromConfig({external_directory: {'*': 'ask'}})
    const rootSessionPermission = merge(agentOwnRuleset, globalUser)
    const subagentSessionPermission = deriveSubagentSessionPermission(rootSessionPermission)

    // #when a DIFFERENT run-attempt's attachment subdirectory (same segment, sibling directory
    // name) is checked against THIS run's grant
    const siblingRunPattern = attachmentPattern(RUNNER_TEMP, RUN_ID, '2')

    // #then it resolves to 'deny' (the global fail-closed default this run's grant never
    // touches), not 'allow' -- a segment-wide `<runnerTemp>/fro-bot-attachments/*` pattern would
    // have matched this too and resolved it to 'allow' instead
    const resolved = evaluate('external_directory', siblingRunPattern, subagentSessionPermission)
    expect(resolved.action).toBe('deny')
  })

  it("preserves an operator's own external_directory wildcard instead of overwriting it, appending the attachment rule after it", () => {
    // #given an operator-supplied opencode-config with its own external_directory wildcard
    const result = buildCIConfig(
      {
        opencodeConfig: JSON.stringify({permission: {external_directory: {'*': 'allow'}}}),
        systematicVersion: '1.0.0',
      },
      createMockLogger(),
    )
    const permission = (result.config as {permission?: Record<string, unknown>}).permission
    if (permission == null) throw new Error('expected buildCIConfig to have set a top-level permission key')
    const externalDirectory = permission.external_directory as Record<string, unknown>

    // #then the operator's own wildcard survives verbatim rather than being replaced with 'deny'
    expect(externalDirectory['*']).toBe('allow')

    // #then the specific attachment rule is still present, appended after the wildcard so
    // `findLast` still resolves the attachment path itself to 'allow'
    const globalUser = fromConfig(permission)
    const resolved = evaluate('external_directory', attachmentPattern(RUNNER_TEMP, RUN_ID, RUN_ATTEMPT), globalUser)
    expect(resolved.action).toBe('allow')

    // #then an unrelated pattern still resolves through the operator's preserved wildcard, not a
    // reintroduced hardcoded deny
    const unrelatedResolved = evaluate('external_directory', '/some/other/path/*', globalUser)
    expect(unrelatedResolved.action).toBe('allow')
  })
})

/**
 * The installed Systematic `skills/` directory (fro-bot/agent#2009). A skill reads its own `references/` and runs its
 * own `scripts/` from there. OpenCode adds an `external_directory` allow for it to the built-in agents' defaults, but
 * the build agent's block re-asserts `'*': 'deny'` after it, and `findLast` makes the deny win. The harness therefore
 * re-allows exactly that directory after the deny, and (see the edit tests) denies the edit tools there.
 */
const SKILLS_VERSION = '3.29.0'
const SYSTEMATIC_PACKAGE_DIR = `/home/runner/.cache/opencode/packages/@fro.bot/systematic@${SKILLS_VERSION}/node_modules/@fro.bot/systematic`
const SKILLS_DIR = `${SYSTEMATIC_PACKAGE_DIR}/skills`
const SKILLS_OPTIONS = {opencodeConfig: null, systematicVersion: SKILLS_VERSION, systematicSkillsDirs: [SKILLS_DIR]}

interface ConfigShape {
  permission?: Record<string, unknown>
  agent: {build: {permission: Record<string, unknown>}}
}

/** The build agent's effective ruleset as upstream composes it: defaults, then the global key, then `agent.build`. */
function buildAgentRuleset(config: ConfigShape, extraDefaults: Record<string, unknown> = {}): readonly Rule[] {
  const defaults = fromConfig({'*': 'allow', external_directory: {'*': 'ask'}, ...extraDefaults})
  return merge(defaults, fromConfig(config.permission ?? {}), fromConfig(config.agent.build.permission))
}

function configFor(options: Parameters<typeof buildCIConfig>[0] = SKILLS_OPTIONS): ConfigShape {
  return buildCIConfig(options, createMockLogger()).config as unknown as ConfigShape
}

describe('effective permission for the bundled Systematic skills directory', () => {
  it('lets the build agent read a skill reference and run a skill script', () => {
    // #given
    const ruleset = buildAgentRuleset(configFor())

    // #then the asks a read, a glob and a shell scan raise (`<parentDir>/*`) all resolve to allow
    expect(evaluate('external_directory', `${SKILLS_DIR}/ce-review/references/*`, ruleset).action).toBe('allow')
    expect(evaluate('external_directory', `${SKILLS_DIR}/ce-review/scripts/*`, ruleset).action).toBe('allow')
    expect(evaluate('external_directory', `${SKILLS_DIR}/*`, ruleset).action).toBe('allow')
  })

  it('keeps denying everything else outside the checkout: package siblings, the package, the cache, other versions', () => {
    const ruleset = buildAgentRuleset(configFor())

    // #then a sibling inside the package, outside skills/
    expect(evaluate('external_directory', `${SYSTEMATIC_PACKAGE_DIR}/dist/*`, ruleset).action).toBe('deny')
    expect(evaluate('external_directory', `${SYSTEMATIC_PACKAGE_DIR}/agents/*`, ruleset).action).toBe('deny')
    expect(evaluate('external_directory', `${SYSTEMATIC_PACKAGE_DIR}/*`, ruleset).action).toBe('deny')
    // #then a directory that merely shares the `skills` prefix
    expect(evaluate('external_directory', `${SYSTEMATIC_PACKAGE_DIR}/skills-evil/*`, ruleset).action).toBe('deny')
    // #then the cache root and the package cache
    expect(evaluate('external_directory', '/home/runner/.cache/opencode/*', ruleset).action).toBe('deny')
    expect(evaluate('external_directory', '/home/runner/.cache/opencode/packages/*', ruleset).action).toBe('deny')
    // #then another installed version of the same package
    const otherVersion = SKILLS_DIR.replace(SKILLS_VERSION, '3.28.0')
    expect(evaluate('external_directory', `${otherVersion}/ce-review/references/*`, ruleset).action).toBe('deny')
    // #then an unrelated external path
    expect(evaluate('external_directory', '/etc/*', ruleset).action).toBe('deny')
    expect(evaluate('external_directory', '/home/runner/.ssh/*', ruleset).action).toBe('deny')
  })

  it('keeps the response and attachment directories allowed', () => {
    const ruleset = buildAgentRuleset(configFor())

    expect(evaluate('external_directory', attachmentPattern(RUNNER_TEMP, RUN_ID, RUN_ATTEMPT), ruleset).action).toBe(
      'allow',
    )
    expect(
      evaluate('external_directory', `${RUNNER_TEMP}/fro-bot-response/${RUN_ID}-${RUN_ATTEMPT}/*`, ruleset).action,
    ).toBe('allow')
  })

  it('reaches a dispatched subagent through the parent session, for the build agent and for a plain root session', () => {
    const config = configFor()
    const rulesets = {
      'build agent': buildAgentRuleset(config),
      // The global key alone: what a root session of an agent with no `external_directory` block of its own resolves.
      'global key only': merge(fromConfig({external_directory: {'*': 'ask'}}), fromConfig(config.permission ?? {})),
    }

    for (const [label, parentSession] of Object.entries(rulesets)) {
      // #when a subagent is dispatched
      const child = deriveSubagentSessionPermission(parentSession)

      // #then it can read the skill references, and only those
      expect([label, evaluate('external_directory', `${SKILLS_DIR}/ce-review/references/*`, child).action]).toEqual([
        label,
        'allow',
      ])
      expect([label, evaluate('external_directory', `${SYSTEMATIC_PACKAGE_DIR}/dist/*`, child).action]).toEqual([
        label,
        'deny',
      ])
      expect([label, evaluate('external_directory', '/etc/*', child).action]).toEqual([label, 'deny'])
    }
  })

  it('adds nothing when the directory could not be resolved', () => {
    // #given setup found no installed plugin
    const config = configFor({opencodeConfig: null, systematicVersion: SKILLS_VERSION})
    const ruleset = buildAgentRuleset(config)

    // #then the skills directory stays denied and no skills-shaped rule was written anywhere
    expect(evaluate('external_directory', `${SKILLS_DIR}/ce-review/references/*`, ruleset).action).toBe('deny')
    expect(JSON.stringify(config)).not.toContain('node_modules')
    expect(JSON.stringify(config)).not.toContain('/skills/')
    // #then an empty resolution is the same as none
    expect(configFor({opencodeConfig: null, systematicVersion: SKILLS_VERSION, systematicSkillsDirs: []})).toEqual(
      config,
    )
  })

  it('still grants it without RUNNER_TEMP, where the response and attachment directories are not known', () => {
    // #given a local, non-Actions run
    vi.stubEnv('RUNNER_TEMP', '')

    // #when
    const config = configFor()
    const ruleset = buildAgentRuleset(config)

    // #then the skills directory is the only exception, behind a deny
    expect(evaluate('external_directory', `${SKILLS_DIR}/ce-review/references/*`, ruleset).action).toBe('allow')
    expect(evaluate('external_directory', '/etc/*', ruleset).action).toBe('deny')
  })

  it("keeps an operator's own external_directory wildcard and puts the skills allow after it", () => {
    const config = configFor({
      ...SKILLS_OPTIONS,
      opencodeConfig: JSON.stringify({permission: {external_directory: {'*': 'ask'}}}),
    })
    const globalRules = fromConfig(config.permission ?? {})

    expect(evaluate('external_directory', `${SKILLS_DIR}/ce-review/references/*`, globalRules).action).toBe('allow')
    expect(evaluate('external_directory', '/etc/*', globalRules).action).toBe('ask')
  })

  describe('edit tools', () => {
    // Upstream's edit, write and apply_patch ask `permission: "edit"` with `path.relative(instance.worktree, file)`
    // (tool/edit.ts:104, write.ts:56, apply_patch.ts:205), NOT the absolute path. An absolute `<dir>/*` deny would
    // therefore never match what they ask, so the deny has to match the relative spelling for any worktree.
    const WORKTREES = ['/home/runner/work/repo/repo', '/home/runner/work/repo/repo/packages/app', '/', '/workspace']
    const file = `${SKILLS_DIR}/ce-review/scripts/validate-review.mjs`

    it('an absolute-path pattern does not match what the edit tools ask (why the deny is anchored on the tail)', () => {
      for (const worktree of WORKTREES) {
        expect(wildcardMatch(path.relative(worktree, file), `${SKILLS_DIR}/*`)).toBe(false)
      }
    })

    it('denies edit, write and apply_patch there, whatever the worktree is', () => {
      const ruleset = buildAgentRuleset(configFor())
      const child = deriveSubagentSessionPermission(ruleset)

      for (const worktree of WORKTREES) {
        const asked = path.relative(worktree, file)
        // #then the build agent and a dispatched subagent (which inherits parent denies) are both refused
        expect([worktree, evaluate('edit', asked, ruleset).action]).toEqual([worktree, 'deny'])
        expect([worktree, evaluate('edit', asked, child).action]).toEqual([worktree, 'deny'])
        // #then and the absolute spelling too
        expect([worktree, evaluate('edit', file, ruleset).action]).toEqual([worktree, 'deny'])
      }
    })

    it('leaves edits elsewhere alone: the checkout, the package outside skills/, another version', () => {
      const ruleset = buildAgentRuleset(configFor())
      const worktree = WORKTREES[0] ?? ''

      expect(evaluate('edit', 'src/index.ts', ruleset).action).toBe('allow')
      expect(evaluate('edit', path.relative(worktree, `${SYSTEMATIC_PACKAGE_DIR}/package.json`), ruleset).action).toBe(
        'allow',
      )
      expect(evaluate('edit', path.relative(worktree, file.replace(SKILLS_VERSION, '3.28.0')), ruleset).action).toBe(
        'allow',
      )
    })

    it('keeps the operator edit rules that were already there', () => {
      const config = configFor({...SKILLS_OPTIONS, opencodeConfig: JSON.stringify({permission: {edit: 'ask'}})})
      const ruleset = buildAgentRuleset(config, {edit: 'ask'})

      expect(evaluate('edit', 'src/index.ts', ruleset).action).toBe('ask')
      expect(evaluate('edit', path.relative(WORKTREES[0] ?? '', file), ruleset).action).toBe('deny')
    })
  })
})
