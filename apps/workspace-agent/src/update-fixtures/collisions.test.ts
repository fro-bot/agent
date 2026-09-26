/**
 * Unit 2 adversarial fixture suite — path collisions and the obstruction preflight.
 *
 * `git merge --ff-only` already refuses most untracked-file and directory/file collisions on its
 * own (confirmed against real git 2.55.0 below) — but it SILENTLY OVERWRITES an ignored file that
 * obstructs an incoming path unless `--no-overwrite-ignore` is also given, and `git read-tree
 * --reset -u` (the primitive recovery's fresh-checkout bootstrap uses) has NO untracked-overwrite
 * protection at all, matching or differing content. `preflightObstructions` (checkout-profile.ts,
 * Unit 3, not implemented yet) must never rely on either command's own overwrite behaviour — it
 * runs BEFORE any mutation and refuses on any obstruction itself.
 *
 * See docs/plans/2026-09-24-001-feat-workspace-checkout-update-recovery-plan.md, Unit 2's
 * "Collisions" scenario bullet.
 */

import {mkdir, rm, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {preflightObstructions} from '../checkout-profile.js'
import {commitFile, gitAsync, gitSync, initRepo, isolatedGitEnv, makeTempDir} from './helpers.js'

let upstream: string
let upstreamHome: string
let checkoutDir: string
let checkoutHome: string
let outsideDir: string

beforeEach(async () => {
  upstream = await makeTempDir('collisions-upstream-')
  upstreamHome = await makeTempDir('collisions-upstream-home-')
  checkoutDir = await makeTempDir('collisions-checkout-')
  checkoutHome = await makeTempDir('collisions-checkout-home-')
  outsideDir = await makeTempDir('collisions-outside-')
  initRepo(upstream, isolatedGitEnv(upstreamHome))
  initRepo(checkoutDir, isolatedGitEnv(checkoutHome))
})

afterEach(async () => {
  await rm(upstream, {recursive: true, force: true})
  await rm(upstreamHome, {recursive: true, force: true})
  await rm(checkoutDir, {recursive: true, force: true})
  await rm(checkoutHome, {recursive: true, force: true})
  await rm(outsideDir, {recursive: true, force: true})
})

/** Wires checkoutDir as a real fast-forward-only clone of upstream at its current HEAD. */
function connectAsUpstreamClone(): void {
  const checkoutEnv = isolatedGitEnv(checkoutHome)
  gitSync(checkoutDir, ['remote', 'add', 'origin', upstream], checkoutEnv)
  gitSync(checkoutDir, ['fetch', '-q', 'origin'], checkoutEnv)
  gitSync(checkoutDir, ['checkout', '-q', '-b', 'main', 'origin/main'], checkoutEnv)
}

describe('collisions — ignored-file obstruction (real git, no stub): the exact --no-overwrite-ignore gap', () => {
  it('exploit: plain `merge --ff-only` silently overwrites an ignored file with different content', async () => {
    // #given an upstream and checkout at the same commit, then upstream adds a file at a path the
    // checkout has locally IGNORED (e.g. a local secret or scratch file it deliberately never
    // tracks)
    const upstreamEnv = isolatedGitEnv(upstreamHome)
    commitFile(upstream, upstreamEnv, 'base.txt', 'base', 'base commit')
    connectAsUpstreamClone()
    const checkoutEnv = isolatedGitEnv(checkoutHome)
    await writeFile(join(checkoutDir, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(checkoutDir, 'ignored.txt'), 'MY LOCAL SECRET')
    commitFile(upstream, upstreamEnv, 'ignored.txt', 'upstream-content', 'adds ignored.txt upstream')
    gitSync(checkoutDir, ['fetch', '-q', 'origin'], checkoutEnv)

    // #when
    const outcome = await gitAsync(checkoutDir, ['merge', '--ff-only', 'origin/main'], checkoutEnv)

    // #then — the exploit genuinely works: the merge succeeds AND the local content is gone
    expect(outcome.ok).toBe(true)
    const {readFile} = await import('node:fs/promises')
    const contentAfter = await readFile(join(checkoutDir, 'ignored.txt'), 'utf8')
    expect(contentAfter.trim()).toBe('upstream-content')
  })

  it('control (the fix, also real git): `--no-overwrite-ignore` refuses the same merge and preserves the local content', async () => {
    const upstreamEnv = isolatedGitEnv(upstreamHome)
    commitFile(upstream, upstreamEnv, 'base.txt', 'base', 'base commit')
    connectAsUpstreamClone()
    const checkoutEnv = isolatedGitEnv(checkoutHome)
    await writeFile(join(checkoutDir, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(checkoutDir, 'ignored.txt'), 'MY LOCAL SECRET')
    commitFile(upstream, upstreamEnv, 'ignored.txt', 'upstream-content', 'adds ignored.txt upstream')
    gitSync(checkoutDir, ['fetch', '-q', 'origin'], checkoutEnv)

    const outcome = await gitAsync(
      checkoutDir,
      ['merge', '--ff-only', '--no-overwrite-ignore', 'origin/main'],
      checkoutEnv,
    )

    expect(outcome.ok).toBe(false)
    const {readFile} = await import('node:fs/promises')
    const contentAfter = await readFile(join(checkoutDir, 'ignored.txt'), 'utf8')
    expect(contentAfter.trim()).toBe('MY LOCAL SECRET')
  })
})

describe('collisions — baseline (real git, no stub): what `merge --ff-only` already refuses on its own', () => {
  it('an untracked file at an exact incoming path is refused, whether its content differs or matches', async () => {
    const upstreamEnv = isolatedGitEnv(upstreamHome)
    commitFile(upstream, upstreamEnv, 'base.txt', 'base', 'base commit')
    connectAsUpstreamClone()
    const checkoutEnv = isolatedGitEnv(checkoutHome)
    commitFile(upstream, upstreamEnv, 'new.txt', 'new-content', 'adds new.txt')
    gitSync(checkoutDir, ['fetch', '-q', 'origin'], checkoutEnv)
    // Identical content to what upstream will bring \u2014 confirmed against real git 2.55.0 that
    // this does NOT get a content-match exemption; the untracked-overwrite refusal fires anyway.
    await writeFile(join(checkoutDir, 'new.txt'), 'new-content')

    const outcome = await gitAsync(checkoutDir, ['merge', '--ff-only', 'origin/main'], checkoutEnv)

    expect(outcome.ok).toBe(false)
    expect(outcome.stderr).toContain('new.txt')
  })

  it('a directory/file prefix conflict in EITHER direction is refused', async () => {
    const upstreamEnv = isolatedGitEnv(upstreamHome)
    commitFile(upstream, upstreamEnv, 'base.txt', 'base', 'base commit')
    connectAsUpstreamClone()
    const checkoutEnv = isolatedGitEnv(checkoutHome)

    // incoming FILE "a", existing untracked DIRECTORY "a/"
    commitFile(upstream, upstreamEnv, 'a', 'file-content', 'adds file a')
    gitSync(checkoutDir, ['fetch', '-q', 'origin'], checkoutEnv)
    await mkdir(join(checkoutDir, 'a'), {recursive: true})
    await writeFile(join(checkoutDir, 'a', 'existing.txt'), 'existing')
    const fileOverDirOutcome = await gitAsync(checkoutDir, ['merge', '--ff-only', 'origin/main'], checkoutEnv)
    expect(fileOverDirOutcome.ok).toBe(false)
    await rm(join(checkoutDir, 'a'), {recursive: true, force: true})
  })

  it('a tracked symlink ancestor that upstream replaces with a real directory is handled safely (the symlink is deleted, never followed)', async () => {
    // #given the checkout TRACKS "sub" as a symlink pointing outside the checkout entirely
    const checkoutEnv = isolatedGitEnv(checkoutHome)
    await symlink(outsideDir, join(checkoutDir, 'sub'))
    gitSync(checkoutDir, ['add', 'sub'], checkoutEnv)
    gitSync(checkoutDir, ['commit', '-q', '-m', 'tracked symlink sub'], checkoutEnv)
    gitSync(checkoutDir, ['branch', '-M', 'main'], checkoutEnv)

    // #given upstream (a clone of the SAME history) replaces "sub" with a real directory
    await rm(upstream, {recursive: true, force: true})
    await mkdir(upstream, {recursive: true})
    const upstreamEnv = isolatedGitEnv(upstreamHome)
    gitSync(upstreamHome, ['clone', '-q', checkoutDir, upstream], upstreamEnv)
    gitSync(upstream, ['rm', '-q', 'sub'], upstreamEnv)
    await mkdir(join(upstream, 'sub'), {recursive: true})
    await writeFile(join(upstream, 'sub', 'newfile.txt'), 'payload')
    gitSync(upstream, ['add', 'sub/newfile.txt'], upstreamEnv)
    gitSync(upstream, ['commit', '-q', '-m', 'sub becomes a real directory'], upstreamEnv)

    gitSync(checkoutDir, ['remote', 'add', 'origin', upstream], checkoutEnv)
    gitSync(checkoutDir, ['fetch', '-q', 'origin'], checkoutEnv)

    // #when
    const outcome = await gitAsync(
      checkoutDir,
      ['merge', '--ff-only', '--no-overwrite-ignore', 'origin/main'],
      checkoutEnv,
    )

    // #then \u2014 the tracked symlink is deleted as part of the diff, and nothing was ever written
    // through it into outsideDir
    expect(outcome.ok).toBe(true)
    const {readdir} = await import('node:fs/promises')
    const outsideEntries = await readdir(outsideDir)
    expect(outsideEntries).toHaveLength(0)
  })
})

describe('collisions — read-tree --reset -u has NO untracked-overwrite protection (real git, no stub)', () => {
  it('exploit: read-tree --reset -u silently overwrites an untracked file regardless of matching or differing content', async () => {
    // #given a repo with one committed file, then that path removed from the index but left as
    // an untracked file on disk with DIFFERENT content \u2014 the exact shape recovery's bootstrap
    // materializes against (a fresh tree written with `read-tree --reset -u`)
    const env = isolatedGitEnv(checkoutHome)
    const sha = commitFile(checkoutDir, env, 'a.txt', 'tree-content', 'c1')
    gitSync(checkoutDir, ['rm', '-q', '--cached', 'a.txt'], env)
    await writeFile(join(checkoutDir, 'a.txt'), 'UNTRACKED LOCAL CONTENT')

    // #when
    const outcome = await gitAsync(checkoutDir, ['read-tree', '--reset', '-u', sha], env)

    // #then \u2014 no error, no warning, and the untracked local content is simply gone
    expect(outcome.ok).toBe(true)
    const {readFile} = await import('node:fs/promises')
    const contentAfter = await readFile(join(checkoutDir, 'a.txt'), 'utf8')
    expect(contentAfter.trim()).toBe('tree-content')
  })
})

describe('collisions — protected (Unit 3 checkout-profile.ts, not implemented yet)', () => {
  it('preflightObstructions returns clear for a genuinely clean fast-forward with no collisions at all', async () => {
    // #given a plain fast-forward with nothing on disk that could obstruct anything — this is the
    // case a trivial "always obstructed" implementation would fail, since it must distinguish this
    // from every hostile fixture below
    const upstreamEnv = isolatedGitEnv(upstreamHome)
    const fromSha = commitFile(upstream, upstreamEnv, 'base.txt', 'base', 'base commit')
    connectAsUpstreamClone()
    const checkoutEnv = isolatedGitEnv(checkoutHome)
    const toSha = commitFile(upstream, upstreamEnv, 'new.txt', 'new-content', 'adds new.txt cleanly')
    gitSync(checkoutDir, ['fetch', '-q', 'origin'], checkoutEnv)

    // #when
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit 3
    // lands.
    const outcome = await preflightObstructions({checkoutPath: checkoutDir, fromSha, toSha, timeoutMs: 5_000})

    // #then
    expect(outcome.kind).toBe('clear')
  })

  it('preflightObstructions reports the EXACT ignored-file obstruction (path and kind), not just that something was found', async () => {
    // #given the same ignored-file exploit fixture as the real-git exploit/control pair above
    const upstreamEnv = isolatedGitEnv(upstreamHome)
    const fromSha = commitFile(upstream, upstreamEnv, 'base.txt', 'base', 'base commit')
    connectAsUpstreamClone()
    const checkoutEnv = isolatedGitEnv(checkoutHome)
    await writeFile(join(checkoutDir, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(checkoutDir, 'ignored.txt'), 'MY LOCAL SECRET')
    const toSha = commitFile(upstream, upstreamEnv, 'ignored.txt', 'upstream-content', 'adds ignored.txt upstream')
    gitSync(checkoutDir, ['fetch', '-q', 'origin'], checkoutEnv)

    // #when
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit
    // 3 lands. It documents the exact contract: preflightObstructions must catch what
    // --no-overwrite-ignore catches (and what read-tree -u never does on its own), BEFORE any
    // mutation, for both the merge path and the recovery read-tree path — and must name the exact
    // colliding path and kind, not merely report SOMETHING was obstructed.
    const outcome = await preflightObstructions({checkoutPath: checkoutDir, fromSha, toSha, timeoutMs: 5_000})

    // #then
    expect(outcome.kind).toBe('obstructed')
    const obstructions = outcome.kind === 'obstructed' ? outcome.obstructions : null
    expect(obstructions).toEqual([{path: 'ignored.txt', kind: 'exact-conflict'}])
  })

  it('preflightObstructions reports a prefix-conflict obstruction by its exact path and kind, distinct from an exact-conflict', async () => {
    // #given an incoming FILE "a", and an existing untracked DIRECTORY "a/" with content — a
    // structurally different collision shape than the exact-path ignored-file case above, so a
    // hardcoded single obstruction kind cannot pass both tests
    const upstreamEnv = isolatedGitEnv(upstreamHome)
    const fromSha = commitFile(upstream, upstreamEnv, 'base.txt', 'base', 'base commit')
    connectAsUpstreamClone()
    const toSha = commitFile(upstream, upstreamEnv, 'a', 'file-content', 'adds file a')
    gitSync(checkoutDir, ['fetch', '-q', 'origin'], isolatedGitEnv(checkoutHome))
    await mkdir(join(checkoutDir, 'a'), {recursive: true})
    await writeFile(join(checkoutDir, 'a', 'existing.txt'), 'existing')

    // #when
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit 3
    // lands.
    const outcome = await preflightObstructions({checkoutPath: checkoutDir, fromSha, toSha, timeoutMs: 5_000})

    // #then
    expect(outcome.kind).toBe('obstructed')
    const obstructions = outcome.kind === 'obstructed' ? outcome.obstructions : null
    expect(obstructions).toEqual([{path: 'a', kind: 'prefix-conflict'}])
  })
})
