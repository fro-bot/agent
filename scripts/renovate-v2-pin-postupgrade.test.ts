import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

// Source of truth: `allowedCommands` in bfra-me/renovate-action `action.yaml` (the `zzglobal_config` block), which the
// self-hosted runner applies and this repo cannot override. Only the patterns the V2-pin rule relies on are copied; if
// the action changes them, update these two and the rule's commands together. A command outside this list is silently
// refused on the runner, which leaves the pin PR with stale digests.
const ALLOWED_COMMANDS: readonly RegExp[] = [
  /^(bun|pnpm|yarn) install( --force)?( --frozen-lockfile)?( --ignore-scripts)?$/,
  /^(?:bun|npm|pnpm|yarn)(?:\srun)?\s(?:bootstrap|build(-release)?|check|clean|fix|format|generate|lint|postupgrade|typecheck|update-snapshots)$/,
]

const renovateText = readFileSync(new URL('../.github/renovate.json5', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  readonly scripts: Readonly<Record<string, string>>
}

// `.github/renovate.json5` is JSON5 and the repo has no JSON5 parser (see packages/harness/src/pin-invariants.test.ts), so
// the rule is cut out as text: from its `matchFileNames` line to the rule's closing brace at packageRules indent.
const ruleMatch = /matchFileNames: \['packages\/runtime\/src\/shared\/opencode-v2-pin\.json'\][\s\S]*?\n {4}\},/.exec(
  renovateText,
)
const rule = ruleMatch?.[0] ?? ''

function ruleCommands(): readonly string[] {
  const list = /postUpgradeTasks:\s*\{[\s\S]*?commands:\s*\[([^\]]*)\]/.exec(rule)?.[1] ?? ''
  return [...list.matchAll(/'([^']+)'/g)].map(match => match[1] ?? '')
}

describe('OpenCode V2 pin Renovate rule', () => {
  it('runs install, the digest sync, then build, in that order', () => {
    // #given the rule that matches the pin file
    expect(rule).not.toBe('')

    // #when reading its post-upgrade commands / #then the sync sits between install and build, branch mode
    expect(ruleCommands()).toEqual(['bun install --ignore-scripts', 'bun run postupgrade', 'bun run build'])
    expect(rule).toMatch(/executionMode: 'branch'/)
  })

  it('uses only commands the self-hosted runner allows', () => {
    // #given the commands / #when each is checked against the runner's allowedCommands
    const refused = ruleCommands().filter(command => !ALLOWED_COMMANDS.some(pattern => pattern.test(command)))

    // #then none is refused (`node scripts/...` would be)
    expect(refused).toEqual([])
    expect(ALLOWED_COMMANDS.some(pattern => pattern.test('node scripts/sync-opencode-v2-pin.ts'))).toBe(false)
  })

  it('no longer asks a human to run the sync', () => {
    // #given / #when / #then
    expect(rule).not.toContain('prBodyNotes')
  })

  it('has a postupgrade script that runs the sync under bun, and the build script it chains to', () => {
    // #given the root scripts / #when / #then
    expect(packageJson.scripts.postupgrade).toBe('bun scripts/sync-opencode-v2-pin.ts')
    expect(packageJson.scripts.build).toBeDefined()
  })
})
