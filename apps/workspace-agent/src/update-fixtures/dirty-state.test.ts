/**
 * Unit 2 adversarial fixture suite — hidden dirty state.
 *
 * An agent-writable `.git/index` can be told to lie to `git status`: `--assume-unchanged` and
 * `--skip-worktree` bits make git skip re-reading a path's real content, and
 * `status.showUntrackedFiles=no` suppresses new files from the report entirely.
 * `checkTempIndexCleanliness` (checkout-profile.ts, Unit 3, not implemented yet) must ignore the
 * checkout's own `.git/index` for this decision and instead compare the working tree against a
 * FRESH temporary index built straight from HEAD, which carries none of these bits.
 *
 * NOT REPRODUCED (see the report for why): "a manipulated stat cache" and "sparse and split
 * index" from the plan's scenario list. Real git 2.55.0's racy-git protection re-hashes content
 * whenever a file's mtime is not strictly newer than the index's recorded timestamp, so a
 * same-mtime tamper is still detected by plain `git status` — there is no hiding effect to
 * demonstrate. A sparse-checkout cone also did not hide an out-of-cone modification from `git
 * status` in testing; sparse-checkout is refused outright by the config-inventory admission check
 * (checkout-profile.ts) regardless, so it is covered there rather than here. Faking either
 * fixture instead of reproducing it would be exactly the "check written from inside its own
 * premise" anti-pattern this suite exists to avoid.
 *
 * See docs/plans/2026-09-24-001-feat-workspace-checkout-update-recovery-plan.md, Unit 2's "Hidden
 * dirty state" scenario bullet.
 */

import {rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {checkTempIndexCleanliness} from '../checkout-profile.js'
import {commitFile, gitSync, initRepo, isolatedGitEnv, makeTempDir} from './helpers.js'

let checkoutDir: string
let checkoutHome: string
let headSha: string

beforeEach(async () => {
  checkoutDir = await makeTempDir('dirty-state-checkout-')
  checkoutHome = await makeTempDir('dirty-state-home-')
  initRepo(checkoutDir, isolatedGitEnv(checkoutHome))
  headSha = commitFile(checkoutDir, isolatedGitEnv(checkoutHome), 'a.txt', 'original', 'c1')
})

afterEach(async () => {
  await rm(checkoutDir, {recursive: true, force: true})
  await rm(checkoutHome, {recursive: true, force: true})
})

/** Raw-git equivalent of what `checkTempIndexCleanliness` must do: a temp index built fresh from `sha`, compared against the real working tree, ignoring the checkout's own (possibly lying) index entirely. */
async function rawTempIndexDiff(sha: string, env: Readonly<Record<string, string>>): Promise<string> {
  const tempIndexPath = join(await makeTempDir('dirty-state-tmpindex-'), 'index')
  const tempEnv = {...env, GIT_INDEX_FILE: tempIndexPath}
  gitSync(checkoutDir, ['read-tree', sha], tempEnv)
  return gitSync(checkoutDir, ['diff', '--stat'], tempEnv)
}

describe('dirty state — assume-unchanged (real git, no stub)', () => {
  it('exploit: plain `git status` reports clean despite a real, different-content edit', async () => {
    const env = isolatedGitEnv(checkoutHome)
    gitSync(checkoutDir, ['update-index', '--assume-unchanged', 'a.txt'], env)
    await writeFile(join(checkoutDir, 'a.txt'), 'TAMPERED')

    const status = gitSync(checkoutDir, ['status', '--porcelain'], env)

    expect(status.trim()).toBe('')
  })

  it('control: the temp-index comparison still reports the file as changed', async () => {
    const env = isolatedGitEnv(checkoutHome)
    gitSync(checkoutDir, ['update-index', '--assume-unchanged', 'a.txt'], env)
    await writeFile(join(checkoutDir, 'a.txt'), 'TAMPERED')

    const diff = await rawTempIndexDiff(headSha, env)

    expect(diff).toContain('a.txt')
  })
})

describe('dirty state — skip-worktree (real git, no stub)', () => {
  it('exploit: plain `git status` reports clean despite a real, different-content edit', async () => {
    const env = isolatedGitEnv(checkoutHome)
    gitSync(checkoutDir, ['update-index', '--skip-worktree', 'a.txt'], env)
    await writeFile(join(checkoutDir, 'a.txt'), 'TAMPERED')

    const status = gitSync(checkoutDir, ['status', '--porcelain'], env)

    expect(status.trim()).toBe('')
  })

  it('control: the temp-index comparison still reports the file as changed', async () => {
    const env = isolatedGitEnv(checkoutHome)
    gitSync(checkoutDir, ['update-index', '--skip-worktree', 'a.txt'], env)
    await writeFile(join(checkoutDir, 'a.txt'), 'TAMPERED')

    const diff = await rawTempIndexDiff(headSha, env)

    expect(diff).toContain('a.txt')
  })
})

describe('dirty state — status.showUntrackedFiles=no (real git, no stub)', () => {
  it('exploit: plain `git status -c status.showUntrackedFiles=no` hides a brand-new untracked file', async () => {
    const env = isolatedGitEnv(checkoutHome)
    await writeFile(join(checkoutDir, 'untracked.txt'), 'new content')

    const status = gitSync(checkoutDir, ['-c', 'status.showUntrackedFiles=no', 'status', '--porcelain'], env)

    expect(status.trim()).toBe('')
  })

  it('control: the default (never overridden) showUntrackedFiles setting still reports it', async () => {
    const env = isolatedGitEnv(checkoutHome)
    await writeFile(join(checkoutDir, 'untracked.txt'), 'new content')

    const status = gitSync(checkoutDir, ['status', '--porcelain'], env)

    expect(status).toContain('untracked.txt')
  })
})

describe('dirty state — protected (Unit 3 checkout-profile.ts, not implemented yet)', () => {
  it('checkTempIndexCleanliness reports clean for a genuinely untouched checkout', async () => {
    // #given a checkout with NO tampering at all — this is the case a trivial "always dirty"
    // implementation would fail, since it must distinguish this from every hidden-dirt fixture
    // below
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit
    // 3 lands.
    const outcome = await checkTempIndexCleanliness({checkoutPath: checkoutDir, headSha, timeoutMs: 5_000})

    // #then
    expect(outcome.kind).toBe('clean')
  })

  it('checkTempIndexCleanliness reports dirty for an assume-unchanged-hidden edit, naming the exact tampered path', async () => {
    // #given the same assume-unchanged exploit fixture as above
    const env = isolatedGitEnv(checkoutHome)
    gitSync(checkoutDir, ['update-index', '--assume-unchanged', 'a.txt'], env)
    await writeFile(join(checkoutDir, 'a.txt'), 'TAMPERED')

    // #when
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit
    // 3 lands. It documents the exact contract: the checkout's own index (with its
    // assume-unchanged bit) must never be consulted for this decision, and the reported
    // changedPaths must name the ACTUAL tampered file, not just a non-empty placeholder.
    const outcome = await checkTempIndexCleanliness({checkoutPath: checkoutDir, headSha, timeoutMs: 5_000})

    // #then
    expect(outcome.kind).toBe('dirty')
    const changedPaths = outcome.kind === 'dirty' ? outcome.changedPaths : []
    expect(changedPaths).toContain('a.txt')
  })
})
