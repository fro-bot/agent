/**
 * Tests for recover.ts (Unit 5, slice 5a: preview only) \u2014 real git repositories in temp
 * directories, exactly like update.test.ts. The only injected seam is `gitRunner`.
 */

import type {GitRunnerFn} from './git-safety.js'

import {mkdir, rename, rm, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {runGit} from './git-safety.js'
import {writeJournal} from './journal.js'
import {previewRecovery} from './recover.js'
import {markRepoHeld, repoMutexKey, resetRepoHoldsForTesting, resetRepoLocksForTesting} from './repo-mutex.js'
import {commitFile, gitSync, initRepo, isolatedGitEnv, makeTempDir} from './update-fixtures/helpers.js'

const OWNER = 'acme'
const REPO = 'widgets'

let reposRoot: string
let checkoutHome: string

beforeEach(async () => {
  reposRoot = await makeTempDir('recover-test-repos-')
  checkoutHome = await makeTempDir('recover-test-checkout-home-')
  resetRepoLocksForTesting()
  resetRepoHoldsForTesting()
})

afterEach(async () => {
  await rm(reposRoot, {recursive: true, force: true})
  await rm(checkoutHome, {recursive: true, force: true})
})

function destPathFor(owner = OWNER, repo = REPO): string {
  return join(reposRoot, owner, repo)
}

function deps(overrides: Parameters<typeof previewRecovery>[1] = {}): Parameters<typeof previewRecovery>[1] {
  return {reposRoot, options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000}, ...overrides}
}

function req(owner = OWNER, repo = REPO): {readonly owner: string; readonly repo: string} {
  return {owner, repo}
}

/** A real, freshly-committed, freshly-cloned checkout \u2014 clean, HEAD attached to main. */
async function setupCleanCheckout(owner = OWNER, repo = REPO): Promise<{readonly headSha: string}> {
  const sourceDir = await makeTempDir('recover-test-source-')
  const sourceHome = await makeTempDir('recover-test-source-home-')
  try {
    initRepo(sourceDir, isolatedGitEnv(sourceHome), 'main')
    const headSha = commitFile(sourceDir, isolatedGitEnv(sourceHome), 'README.md', 'hello\n', 'initial commit')
    await mkdir(join(reposRoot, owner), {recursive: true})
    gitSync(reposRoot, ['clone', '-q', sourceDir, destPathFor(owner, repo)], isolatedGitEnv(checkoutHome))
    return {headSha}
  } finally {
    await rm(sourceDir, {recursive: true, force: true})
    await rm(sourceHome, {recursive: true, force: true})
  }
}

function makeGitRunnerSpy(): {readonly runner: GitRunnerFn; readonly calls: (readonly string[])[]} {
  const calls: (readonly string[])[] = []
  const runner: GitRunnerFn = async (args, options) => {
    calls.push(args)
    return runGit(args, options)
  }
  return {runner, calls}
}

describe('previewRecovery — safe preview, clean and dirty checkouts', () => {
  it('a clean checkout previews inspectionSafe:true with zero dirty counts', async () => {
    // #given
    const {headSha} = await setupCleanCheckout()

    // #when
    const result = await previewRecovery(req(), deps())

    // #then
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.preview.inspectionSafe).toBe(true)
    if (!result.preview.inspectionSafe) throw new Error('unreachable')
    expect(result.preview.headSha).toBe(headSha)
    expect(result.preview.branch).toBe('main')
    expect(result.preview.dirty).toEqual({staged: 0, unstaged: 0, untracked: 0, conflicted: 0})
    expect(result.preview.operationInProgress).toBe('none')
    expect(result.preview.ignoredCount).toBe(0)
    expect(result.preview.entryCount).toBeGreaterThan(0)
  })

  it('reports untracked, ignored, and a local commit all at once', async () => {
    // #given
    await setupCleanCheckout()
    const dest = destPathFor()
    await writeFile(join(dest, '.gitignore'), 'ignored.txt\n')
    gitSync(dest, ['add', '.gitignore'], isolatedGitEnv(checkoutHome))
    gitSync(dest, ['commit', '-q', '-m', 'add gitignore'], isolatedGitEnv(checkoutHome))
    await writeFile(join(dest, 'ignored.txt'), 'ignored content\n')
    await writeFile(join(dest, 'untracked.txt'), 'untracked content\n')
    const localSha = commitFile(dest, isolatedGitEnv(checkoutHome), 'local-only.txt', 'local', 'local-only commit')

    // #when
    const result = await previewRecovery(req(), deps())

    // #then
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok' || !result.preview.inspectionSafe) throw new Error('unreachable')
    expect(result.preview.headSha).toBe(localSha)
    expect(result.preview.dirty.untracked).toBe(1)
    expect(result.preview.ignoredCount).toBe(1)
  })
})

describe('previewRecovery — hostile config degrades to an opaque preview', () => {
  it('a disallowed config key (filter.*) previews inspectionSafe:false and never runs a working-tree-reading git command', async () => {
    // #given a checkout with a planted filter driver \u2014 not on the closed config allowlist
    await setupCleanCheckout()
    gitSync(destPathFor(), ['config', 'filter.evil.clean', 'cat'], isolatedGitEnv(checkoutHome))
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await previewRecovery(req(), deps({gitRunner: runner}))

    // #then
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.preview.inspectionSafe).toBe(false)
    expect(result.preview.entryCount).toBeGreaterThan(0)
    // #and \u2014 admission's own inert `git config --list` call is expected (it's how unsafety is
    // DETECTED), but no command that reads working-tree content or could invoke a filter driver
    // (`status`, `read-tree`, `checkout`, ...) is ever spawned.
    expect(calls.some(args => args.includes('status'))).toBe(false)
    expect(calls.some(args => args.includes('read-tree'))).toBe(false)
    expect(calls.some(args => args.includes('checkout'))).toBe(false)
  })

  it('an unsupported-layout checkout (symlinked .git) previews inspectionSafe:false with no config call either', async () => {
    // #given
    await setupCleanCheckout()
    const dest = destPathFor()
    const realGitDir = join(dest, '.git-real')
    await rename(join(dest, '.git'), realGitDir)
    await symlink(realGitDir, join(dest, '.git'))
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await previewRecovery(req(), deps({gitRunner: runner}))

    // #then
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.preview.inspectionSafe).toBe(false)
    // #and \u2014 layout is pure filesystem; unsafety is already established before any git call.
    expect(calls).toEqual([])
  })
})

describe('previewRecovery — fingerprint', () => {
  it('is stable across repeated previews of an unchanged checkout', async () => {
    // #given
    await setupCleanCheckout()

    // #when
    const first = await previewRecovery(req(), deps())
    const second = await previewRecovery(req(), deps())

    // #then
    if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('unreachable')
    expect(first.preview.fingerprint).toBe(second.preview.fingerprint)
  })

  it('changes when a new commit lands', async () => {
    // #given
    await setupCleanCheckout()
    const before = await previewRecovery(req(), deps())
    commitFile(destPathFor(), isolatedGitEnv(checkoutHome), 'b.txt', 'two', 'second commit')

    // #when
    const after = await previewRecovery(req(), deps())

    // #then
    if (before.kind !== 'ok' || after.kind !== 'ok') throw new Error('unreachable')
    expect(before.preview.fingerprint).not.toBe(after.preview.fingerprint)
  })

  it('changes when a tracked file is touched (dirty counts change) without a new commit', async () => {
    // #given
    await setupCleanCheckout()
    const before = await previewRecovery(req(), deps())
    await writeFile(join(destPathFor(), 'README.md'), 'tampered\n')

    // #when
    const after = await previewRecovery(req(), deps())

    // #then
    if (before.kind !== 'ok' || after.kind !== 'ok') throw new Error('unreachable')
    expect(before.preview.fingerprint).not.toBe(after.preview.fingerprint)
  })

  it('for an opaque preview, uses only size+entryCount \u2014 stable across a change that does not alter either', async () => {
    // #given a hostile-config checkout (opaque) whose file COUNT and byte size we hold constant
    await setupCleanCheckout()
    gitSync(destPathFor(), ['config', 'filter.evil.clean', 'cat'], isolatedGitEnv(checkoutHome))
    const before = await previewRecovery(req(), deps())

    // #when \u2014 overwrite README.md with content of the SAME byte length (size unchanged)
    await writeFile(join(destPathFor(), 'README.md'), 'HELLO\n')
    const after = await previewRecovery(req(), deps())

    // #then
    if (before.kind !== 'ok' || after.kind !== 'ok') throw new Error('unreachable')
    expect(before.preview.inspectionSafe).toBe(false)
    expect(after.preview.inspectionSafe).toBe(false)
    expect(before.preview.fingerprint).toBe(after.preview.fingerprint)
  })
})

describe('previewRecovery — journal-in-progress and maintenance-hold refusals', () => {
  it('refuses journal-in-progress, naming the exact phase, for an in-flight update journal', async () => {
    // #given
    await setupCleanCheckout()
    const journalsDir = join(reposRoot, '.workspace-agent', 'journals')
    await writeJournal(journalsDir, {
      kind: 'update',
      owner: OWNER,
      repo: REPO,
      phase: 'applying',
      fromSha: '0'.repeat(40),
      toSha: '1'.repeat(40),
      startedAt: new Date().toISOString(),
    })

    // #when
    const result = await previewRecovery(req(), deps())

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'journal-in-progress', phase: 'applying'})
  })

  it('refuses journal-in-progress for an in-flight RECOVERY journal too', async () => {
    // #given
    await setupCleanCheckout()
    const journalsDir = join(reposRoot, '.workspace-agent', 'journals')
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: OWNER,
      repo: REPO,
      phase: 'quarantining',
      recoveryId: 'gen-1',
      startedAt: new Date().toISOString(),
    })

    // #when
    const result = await previewRecovery(req(), deps())

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'journal-in-progress', phase: 'quarantining'})
  })

  it('refuses maintenance-hold before even checking the journal, with zero git calls', async () => {
    // #given
    await setupCleanCheckout()
    markRepoHeld(repoMutexKey(OWNER, REPO), 'termination-unconfirmed')
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await previewRecovery(req(), deps({gitRunner: runner}))

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'maintenance-hold'})
    expect(calls).toEqual([])
  })
})

describe('previewRecovery — the filesystem size/entry-count walk is bounded, and never follows a symlink', () => {
  it('is bounded by its own entry cap', async () => {
    // #given
    await setupCleanCheckout()
    for (let i = 0; i < 20; i += 1) {
      await writeFile(join(destPathFor(), `extra-${i}.txt`), 'x')
    }

    // #when
    const result = await previewRecovery(req(), deps({walkMaxEntries: 5}))

    // #then
    if (result.kind !== 'ok' || !result.preview.inspectionSafe) throw new Error('unreachable')
    expect(result.preview.entryCount).toBe(5)
  })

  it('is bounded by its own deadline \u2014 an already-elapsed deadline stops right after the root', async () => {
    // #given an injected clock that reports the deadline as already blown on the very next check
    await setupCleanCheckout()
    let calls = 0
    const monotonicNow = (): number => {
      calls += 1
      // Call 1 computes the deadline; call 2 is the root's OWN check (must still pass, so the
      // root itself is counted); call 3+ (every child) reports the deadline as already blown.
      return calls <= 2 ? 0 : 1_000_000
    }

    // #when
    const result = await previewRecovery(req(), deps({walkDeadlineMs: 100, monotonicNow}))

    // #then
    if (result.kind !== 'ok' || !result.preview.inspectionSafe) throw new Error('unreachable')
    expect(result.preview.entryCount).toBe(1)
  })

  it('counts a symlink itself but never follows it into whatever it points to', async () => {
    // #given a baseline preview, then a symlink inside the checkout pointing at a directory with
    // a large file OUTSIDE it
    await setupCleanCheckout()
    const before = await previewRecovery(req(), deps())
    const outsideDir = await makeTempDir('recover-test-symlink-target-')
    await writeFile(join(outsideDir, 'big.txt'), 'x'.repeat(10_000))
    await symlink(outsideDir, join(destPathFor(), 'link-to-outside'))

    try {
      // #when
      const after = await previewRecovery(req(), deps())

      // #then
      if (before.kind !== 'ok' || !before.preview.inspectionSafe) throw new Error('unreachable')
      if (after.kind !== 'ok' || !after.preview.inspectionSafe) throw new Error('unreachable')
      expect(after.preview.entryCount).toBe(before.preview.entryCount + 1)
      expect(after.preview.estimatedSizeBytes - before.preview.estimatedSizeBytes).toBeLessThan(1_000)
    } finally {
      await rm(outsideDir, {recursive: true, force: true})
    }
  })
})
