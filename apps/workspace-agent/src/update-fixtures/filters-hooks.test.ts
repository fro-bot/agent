/**
 * Unit 2 adversarial fixture suite — filter drivers, hooks, and fsmonitor.
 *
 * Filters (clean/smudge/process/required, from local config, an include, `.git/info/attributes`,
 * or an incoming `.gitattributes`) and hooks (post-merge, reference-transaction, post-checkout,
 * core.fsmonitor) are exactly the mechanisms `inspect.ts` already neutralizes for its read-only
 * `git status` call. Update and recovery run git operations `inspect.ts` never needs to
 * (`git add`, `git merge --ff-only`, `git read-tree -u`, `git checkout`) against an
 * agent-writable checkout, so the same classes of planted config must be proven to reach THOSE
 * operations too, and proven blocked by the admission checks Unit 3 will add.
 *
 * See docs/plans/2026-09-24-001-feat-workspace-checkout-update-recovery-plan.md, Unit 2's
 * "Filters" and "Hooks" scenario bullets.
 */

import {mkdir, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {inventoryCheckoutConfig} from '../checkout-profile.js'
import {buildLocalUpdateGitProfile} from '../git-safety.js'
import {
  commitFile,
  gitAsync,
  gitSync,
  initRepo,
  isolatedGitEnv,
  makeTempDir,
  sentinelFired,
  sentinelPath,
  writeExecutableScript,
} from './helpers.js'

let checkoutDir: string
let checkoutHome: string
let sentinelDir: string

beforeEach(async () => {
  checkoutDir = await makeTempDir('filters-hooks-checkout-')
  checkoutHome = await makeTempDir('filters-hooks-home-')
  sentinelDir = await makeTempDir('filters-hooks-sentinel-')
  initRepo(checkoutDir, isolatedGitEnv(checkoutHome))
})

afterEach(async () => {
  await rm(checkoutDir, {recursive: true, force: true})
  await rm(checkoutHome, {recursive: true, force: true})
  await rm(sentinelDir, {recursive: true, force: true})
})

function fireSentinelCommand(): string {
  return `echo fired >> "${sentinelPath(sentinelDir)}"`
}

describe('filters — control (real git, no protection): each source genuinely triggers the driver', () => {
  it('local config, driver name with an embedded dot AND an embedded "=" (a valid config subsection name)', async () => {
    // #given a filter driver named `my.filter=x` (dot AND `=`) with `required=true`, confirmed
    // against real git 2.55.0 to parse correctly as one subsection name via plain `git config`
    const env = isolatedGitEnv(checkoutHome)
    gitSync(checkoutDir, ['config', 'filter.my.filter=x.clean', fireSentinelCommand()], env)
    gitSync(checkoutDir, ['config', 'filter.my.filter=x.required', 'true'], env)
    await writeFile(join(checkoutDir, '.gitattributes'), '*.bin filter=my.filter=x\n')
    gitSync(checkoutDir, ['add', '.gitattributes'], env)
    gitSync(checkoutDir, ['commit', '-q', '-m', 'attrs'], env)
    await writeFile(join(checkoutDir, 'f.bin'), 'hello')

    // #when — `git add` runs the clean filter for any file it stages
    const outcome = await gitAsync(checkoutDir, ['add', 'f.bin'], env)

    // #then
    expect(outcome.ok).toBe(true)
    expect(await sentinelFired(sentinelDir)).toBe(true)
  })

  it('a driver defined only in an INCLUDED config file (include.path)', async () => {
    const env = isolatedGitEnv(checkoutHome)
    const includedConfigPath = join(sentinelDir, 'included.gitconfig')
    await writeFile(includedConfigPath, `[filter "included"]\n\tclean = ${fireSentinelCommand()}\n\trequired = true\n`)
    gitSync(checkoutDir, ['config', 'include.path', includedConfigPath], env)
    await writeFile(join(checkoutDir, '.gitattributes'), '*.bin filter=included\n')
    gitSync(checkoutDir, ['add', '.gitattributes'], env)
    gitSync(checkoutDir, ['commit', '-q', '-m', 'attrs'], env)
    await writeFile(join(checkoutDir, 'f.bin'), 'hello')

    const outcome = await gitAsync(checkoutDir, ['add', 'f.bin'], env)

    expect(outcome.ok).toBe(true)
    expect(await sentinelFired(sentinelDir)).toBe(true)
  })

  it('a driver assigned via `.git/info/attributes` (git-dir-local, never committed to the tree)', async () => {
    const env = isolatedGitEnv(checkoutHome)
    gitSync(checkoutDir, ['config', 'filter.infoattr.clean', fireSentinelCommand()], env)
    gitSync(checkoutDir, ['config', 'filter.infoattr.required', 'true'], env)
    await writeFile(join(checkoutDir, '.git', 'info', 'attributes'), '*.bin filter=infoattr\n')
    await writeFile(join(checkoutDir, 'f.bin'), 'hello')

    const outcome = await gitAsync(checkoutDir, ['add', 'f.bin'], env)

    expect(outcome.ok).toBe(true)
    expect(await sentinelFired(sentinelDir)).toBe(true)
  })

  it('a driver whose ASSIGNMENT arrives via an incoming .gitattributes, materialized by checkout/read-tree', async () => {
    // #given: the driver itself is defined locally (e.g. left over from a legitimate earlier
    // setup) with a SMUDGE step, but no file in the current tree uses it yet
    const env = isolatedGitEnv(checkoutHome)
    // `clean = cat` is a real, working pass-through identity filter — it must actually succeed so
    // that `git add` below (a SETUP step, not the attack) does not fail for an unrelated reason.
    gitSync(checkoutDir, ['config', 'filter.incoming.clean', 'cat'], env)
    gitSync(checkoutDir, ['config', 'filter.incoming.smudge', fireSentinelCommand()], env)
    gitSync(checkoutDir, ['config', 'filter.incoming.required', 'true'], env)
    commitFile(checkoutDir, env, 'base.txt', 'base', 'base commit')

    // The "incoming" commit adds a NEW .gitattributes assignment plus a matching new file \u2014
    // exactly the shape an update's fetched history could bring in.
    await writeFile(join(checkoutDir, '.gitattributes'), '*.bin filter=incoming\n')
    gitSync(checkoutDir, ['add', '.gitattributes'], env)
    await writeFile(join(checkoutDir, 'new.bin'), 'payload')
    gitSync(checkoutDir, ['add', 'new.bin'], env)
    gitSync(checkoutDir, ['commit', '-q', '-m', 'incoming'], env)
    const incomingSha = gitSync(checkoutDir, ['rev-parse', 'HEAD'], env).trim()
    gitSync(checkoutDir, ['reset', '-q', '--hard', 'HEAD~1'], env)
    expect(await sentinelFired(sentinelDir)).toBe(false)

    // #when — materializing the incoming tree runs the smudge filter for the new file, exactly
    // as a fast-forward merge or a recovery `read-tree --reset -u` would
    const outcome = await gitAsync(checkoutDir, ['read-tree', '--reset', '-u', incomingSha], env)

    // #then
    expect(outcome.ok).toBe(true)
    expect(await sentinelFired(sentinelDir)).toBe(true)
  })

  it('a `process` filter driver is invoked (protocol handshake failure does not prevent the invocation itself)', async () => {
    const env = isolatedGitEnv(checkoutHome)
    const scriptPath = join(sentinelDir, 'process-filter.sh')
    await writeExecutableScript(scriptPath, `${fireSentinelCommand()}\nexit 1`)
    gitSync(checkoutDir, ['config', 'filter.proc.process', scriptPath], env)
    gitSync(checkoutDir, ['config', 'filter.proc.required', 'false'], env)
    await writeFile(join(checkoutDir, '.gitattributes'), '*.bin filter=proc\n')
    gitSync(checkoutDir, ['add', '.gitattributes'], env)
    gitSync(checkoutDir, ['commit', '-q', '-m', 'attrs'], env)
    await writeFile(join(checkoutDir, 'f.bin'), 'hello')

    await gitAsync(checkoutDir, ['add', 'f.bin'], env)

    expect(await sentinelFired(sentinelDir)).toBe(true)
  })
})

describe('filters — protected (Unit 3 checkout-profile.ts, not implemented yet): admission refuses any filter.* key before merge', () => {
  it('a checkout carrying a local filter.* key is refused by config inventory before any merge runs', async () => {
    // #given the same hostile local-config vector as the first control above
    const env = isolatedGitEnv(checkoutHome)
    gitSync(checkoutDir, ['config', 'filter.my.filter=x.clean', fireSentinelCommand()], env)
    gitSync(checkoutDir, ['config', 'filter.my.filter=x.required', 'true'], env)

    // #when admission inventories the checkout's config
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit
    // 3 lands. It documents the exact contract: any filter.* key must refuse admission, whatever
    // its source (local config, an include, info/attributes, or an incoming .gitattributes all
    // resolve to the SAME local filter.* key requirement) \u2014 so refusing on the key's presence
    // covers every "Filters" scenario above without needing to special-case each source.
    const outcome = await inventoryCheckoutConfig({checkoutPath: checkoutDir, timeoutMs: 5_000})

    // #then
    expect(outcome.kind).toBe('refused')
    const disallowedKeys = outcome.kind === 'refused' ? outcome.disallowedKeys : []
    expect(disallowedKeys.some(key => key.startsWith('filter.'))).toBe(true)
  })
})

describe('hooks — control (real git, no protection): each hook and fsmonitor genuinely fires', () => {
  it('post-merge and reference-transaction fire on a fast-forward merge', async () => {
    // #given an upstream repo one commit ahead, and hooks installed in the checkout
    const env = isolatedGitEnv(checkoutHome)
    const upstream = await makeTempDir('filters-hooks-upstream-')
    const upstreamEnv = isolatedGitEnv(await makeTempDir('filters-hooks-upstream-home-'))
    initRepo(upstream, upstreamEnv)
    commitFile(upstream, upstreamEnv, 'a.txt', 'one', 'c1')

    gitSync(checkoutDir, ['remote', 'add', 'origin', upstream], env)
    await gitAsync(checkoutDir, ['fetch', '-q', 'origin'], env)
    await gitAsync(checkoutDir, ['checkout', '-q', '-b', 'main', 'origin/main'], env)

    await mkdir(join(checkoutDir, '.git', 'hooks'), {recursive: true})
    await writeExecutableScript(
      join(checkoutDir, '.git', 'hooks', 'post-merge'),
      `echo post-merge >> "${sentinelPath(sentinelDir)}"`,
    )
    await writeExecutableScript(
      join(checkoutDir, '.git', 'hooks', 'reference-transaction'),
      `echo reference-transaction >> "${sentinelPath(sentinelDir)}"\ncat > /dev/null`,
    )

    commitFile(upstream, upstreamEnv, 'b.txt', 'two', 'c2')
    await gitAsync(checkoutDir, ['fetch', '-q', 'origin'], env)

    // #when
    const outcome = await gitAsync(checkoutDir, ['merge', '--ff-only', 'origin/main'], env)

    // #then
    expect(outcome.ok).toBe(true)
    const fired = await sentinelFired(sentinelDir)
    expect(fired).toBe(true)
  })

  it('post-checkout fires when a checkout materializes a different tree', async () => {
    const env = isolatedGitEnv(checkoutHome)
    const first = commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    commitFile(checkoutDir, env, 'b.txt', 'two', 'c2')
    await mkdir(join(checkoutDir, '.git', 'hooks'), {recursive: true})
    await writeExecutableScript(join(checkoutDir, '.git', 'hooks', 'post-checkout'), fireSentinelCommand())

    const outcome = await gitAsync(checkoutDir, ['checkout', '-q', first], env)

    expect(outcome.ok).toBe(true)
    expect(await sentinelFired(sentinelDir)).toBe(true)
  })

  it('core.fsmonitor fires on a plain status read', async () => {
    const env = isolatedGitEnv(checkoutHome)
    commitFile(checkoutDir, env, 'a.txt', 'one', 'c1')
    const scriptPath = join(sentinelDir, 'fsmonitor.sh')
    await writeExecutableScript(scriptPath, `${fireSentinelCommand()}\nprintf '1\\n'`)
    gitSync(checkoutDir, ['config', 'core.fsmonitor', scriptPath], env)

    await gitAsync(checkoutDir, ['status', '--porcelain'], env)

    expect(await sentinelFired(sentinelDir)).toBe(true)
  })
})

describe('hooks — protected (Unit 3 git-safety.ts, not implemented yet): the local update profile forces hooks and fsmonitor off DURING THE ACTUAL MUTATION', () => {
  it('buildLocalUpdateGitProfile disables hooks and fsmonitor across a real fast-forward merge, not merely a read-only status', async () => {
    // #given an upstream one commit ahead — read-only `status` never invokes post-merge or
    // reference-transaction at all, so asserting protection against those hooks requires actually
    // running the mutation `update.ts` will run: `merge --ff-only --no-overwrite-ignore`. A profile
    // that only forces `--no-optional-locks`/`-c core.fsmonitor=false` for a STATUS call (as
    // GIT_SAFETY_ARGS already does) would pass a status-only version of this test trivially; this
    // version does not let that happen — confirmed by hand (see the control describe block above)
    // that plain `merge --ff-only` genuinely fires post-merge, reference-transaction, AND fsmonitor.
    const env = isolatedGitEnv(checkoutHome)
    const upstream = await makeTempDir('filters-hooks-upstream-')
    const upstreamEnv = isolatedGitEnv(await makeTempDir('filters-hooks-upstream-home-'))
    initRepo(upstream, upstreamEnv)
    commitFile(upstream, upstreamEnv, 'a.txt', 'one', 'c1')

    gitSync(checkoutDir, ['remote', 'add', 'origin', upstream], env)
    await gitAsync(checkoutDir, ['fetch', '-q', 'origin'], env)
    await gitAsync(checkoutDir, ['checkout', '-q', '-b', 'main', 'origin/main'], env)

    await mkdir(join(checkoutDir, '.git', 'hooks'), {recursive: true})
    await writeExecutableScript(
      join(checkoutDir, '.git', 'hooks', 'post-merge'),
      `echo post-merge >> "${sentinelPath(sentinelDir)}"`,
    )
    await writeExecutableScript(
      join(checkoutDir, '.git', 'hooks', 'reference-transaction'),
      `echo reference-transaction >> "${sentinelPath(sentinelDir)}"\ncat > /dev/null`,
    )
    const fsmonitorScript = join(sentinelDir, 'fsmonitor.sh')
    await writeExecutableScript(fsmonitorScript, `${fireSentinelCommand()}\nprintf '1\\n'`)
    gitSync(checkoutDir, ['config', 'core.fsmonitor', fsmonitorScript], env)

    // Fetch the new upstream commit BEFORE building the local profile — fetching is the NETWORK
    // profile's job (git-safety.ts's buildNetworkGitProfile), not the local profile's; only the
    // merge step below is what buildLocalUpdateGitProfile is responsible for protecting. The fetch
    // itself legitimately fires reference-transaction (it updates refs/remotes/origin/main) — that
    // is expected and unrelated to what this test asserts, so the sentinel is cleared afterward to
    // give the protected merge below a clean baseline to assert against.
    commitFile(upstream, upstreamEnv, 'b.txt', 'two', 'c2')
    await gitAsync(checkoutDir, ['fetch', '-q', 'origin'], env)
    await rm(sentinelPath(sentinelDir), {force: true})

    // #when the PRODUCTION local profile runs the real fast-forward merge
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit
    // 3 lands.
    const profile = buildLocalUpdateGitProfile({checkoutPath: checkoutDir})
    const mergeOutcome = await gitAsync(
      profile.cwd,
      [...profile.args, 'merge', '--ff-only', '--no-overwrite-ignore', 'origin/main'],
      profile.env,
    )

    // #then — the merge itself must still have SUCCEEDED (protection must not just make the
    // operation fail outright — it must complete while neutralizing every hook/fsmonitor)
    expect(mergeOutcome.ok).toBe(true)
    expect(await sentinelFired(sentinelDir)).toBe(false)
  })
})
