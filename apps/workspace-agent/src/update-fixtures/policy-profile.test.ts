/**
 * Unit 2 adversarial fixture suite — policy outcomes, the config-profile allowlist, and the git
 * version pin.
 *
 * Unlike every other file in this directory, "Policy" is almost entirely REAL-GIT, no-stub
 * territory: classifying equal/behind/ahead/diverged/detached/non-default-branch/moved-remote/
 * initialized-submodule is Unit 4's job (`update.ts`), not Unit 3's — this file proves the git
 * primitives Unit 4 will build that classification on top of actually report what they claim to.
 * "Config profile" and "Version" DO exercise Unit 3 (`checkout-profile.ts`'s config inventory),
 * since deriving and enforcing the fresh-clone allowlist is squarely Unit 3's contract.
 *
 * See docs/plans/2026-09-24-001-feat-workspace-checkout-update-recovery-plan.md, Unit 2's
 * "Policy", "Config profile", and "Version" scenario bullets.
 */

import {execFileSync} from 'node:child_process'
import {rm} from 'node:fs/promises'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {inventoryCheckoutConfig} from '../checkout-profile.js'
import {commitFile, currentGitVersion, gitSync, initRepo, isolatedGitEnv, makeTempDir} from './helpers.js'

let repoA: string
let homeA: string
let repoB: string
let homeB: string

beforeEach(async () => {
  repoA = await makeTempDir('policy-a-')
  homeA = await makeTempDir('policy-a-home-')
  repoB = await makeTempDir('policy-b-')
  homeB = await makeTempDir('policy-b-home-')
  initRepo(repoA, isolatedGitEnv(homeA))
})

afterEach(async () => {
  await rm(repoA, {recursive: true, force: true})
  await rm(homeA, {recursive: true, force: true})
  await rm(repoB, {recursive: true, force: true})
  await rm(homeB, {recursive: true, force: true})
})

describe('version (real git, no stub)', () => {
  it('reports and asserts a real, well-formed git version', () => {
    const version = currentGitVersion()

    // eslint-disable-next-line no-console -- Unit 2 requires the git version to be logged, not just checked
    console.log(`[update-fixtures/policy-profile] git version under test: ${version}`)
    expect(version).toMatch(/^git version \d+\.\d+\.\d+/)
  })
})

describe('policy — ancestry classification (real git, no stub)', () => {
  it('equal: local HEAD and remote HEAD are the same commit', async () => {
    const envA = isolatedGitEnv(homeA)
    const sha = commitFile(repoA, envA, 'a.txt', 'one', 'c1')
    gitSync(repoA, ['clone', '-q', repoA, repoB], isolatedGitEnv(homeB))
    const envB = isolatedGitEnv(homeB)

    const remoteSha = gitSync(repoB, ['ls-remote', repoA, 'HEAD'], envB).split('\t')[0]?.trim()
    const localSha = gitSync(repoB, ['rev-parse', 'HEAD'], envB).trim()

    expect(localSha).toBe(sha)
    expect(remoteSha).toBe(sha)
  })

  it('behind: the local branch is a strict ancestor of the remote tip', async () => {
    const envA = isolatedGitEnv(homeA)
    const h = commitFile(repoA, envA, 'a.txt', 'one', 'c1')
    gitSync(repoA, ['clone', '-q', repoA, repoB], isolatedGitEnv(homeB))
    const envB = isolatedGitEnv(homeB)
    const t = commitFile(repoA, envA, 'b.txt', 'two', 'c2')
    // The local checkout (repoB) must actually FETCH the new remote tip before it can classify
    // its own ancestry relationship to it — exactly the re-observation step update.ts performs.
    gitSync(repoB, ['fetch', '-q', 'origin'], envB)

    let isAncestor = true
    try {
      execFileSync('git', ['-C', repoB, 'merge-base', '--is-ancestor', h, t], {env: envB})
    } catch {
      isAncestor = false
    }

    expect(isAncestor).toBe(true)
    expect(h).not.toBe(t)
  })

  it('ahead: the local branch has commits the remote does not, so the remote is the ancestor', async () => {
    const envA = isolatedGitEnv(homeA)
    commitFile(repoA, envA, 'a.txt', 'one', 'c1')
    gitSync(repoA, ['clone', '-q', repoA, repoB], isolatedGitEnv(homeB))
    const envB = isolatedGitEnv(homeB)
    const localAhead = commitFile(repoB, envB, 'local.txt', 'local-only', 'local commit')
    const remoteTip = gitSync(repoA, ['rev-parse', 'HEAD'], envA).trim()

    let isAncestor = true
    try {
      execFileSync('git', ['-C', repoB, 'merge-base', '--is-ancestor', remoteTip, localAhead], {env: envB})
    } catch {
      isAncestor = false
    }

    expect(isAncestor).toBe(true)
  })

  it('diverged: neither branch is an ancestor of the other', async () => {
    const envA = isolatedGitEnv(homeA)
    commitFile(repoA, envA, 'base.txt', 'base', 'base')
    gitSync(repoA, ['clone', '-q', repoA, repoB], isolatedGitEnv(homeB))
    const envB = isolatedGitEnv(homeB)
    const remoteTip = commitFile(repoA, envA, 'remote-only.txt', 'r', 'remote commit')
    const localTip = commitFile(repoB, envB, 'local-only.txt', 'l', 'local commit')
    // repoB must actually have BOTH tips in its own object database before a real ancestry check
    // means anything — otherwise "not an ancestor" and "unknown object" are indistinguishable.
    gitSync(repoB, ['fetch', '-q', 'origin'], envB)

    const isAncestorEitherWay = (from: string, to: string): boolean => {
      try {
        execFileSync('git', ['-C', repoB, 'merge-base', '--is-ancestor', from, to], {env: envB})
        return true
      } catch {
        return false
      }
    }

    expect(isAncestorEitherWay(remoteTip, localTip)).toBe(false)
    expect(isAncestorEitherWay(localTip, remoteTip)).toBe(false)
  })

  it('detached HEAD: `symbolic-ref -q HEAD` fails, and succeeds once back on a branch', async () => {
    const env = isolatedGitEnv(homeA)
    const sha = commitFile(repoA, env, 'a.txt', 'one', 'c1')
    gitSync(repoA, ['checkout', '-q', sha], env)

    let detachedFails = false
    try {
      execFileSync('git', ['-C', repoA, 'symbolic-ref', '-q', 'HEAD'], {env})
    } catch {
      detachedFails = true
    }
    expect(detachedFails).toBe(true)

    gitSync(repoA, ['checkout', '-q', 'main'], env)
    const branchRef = gitSync(repoA, ['symbolic-ref', '-q', 'HEAD'], env).trim()
    expect(branchRef).toBe('refs/heads/main')
  })

  it("non-default branch: the checked-out branch name differs from the remote's reported default branch", async () => {
    // #given repoA acts as the "remote": its HEAD symref stays on `main`, untouched
    const envA = isolatedGitEnv(homeA)
    commitFile(repoA, envA, 'a.txt', 'one', 'c1')
    // #given repoB is the "checkout": cloned from repoA, then switched to a DIFFERENT local branch
    gitSync(repoA, ['clone', '-q', repoA, repoB], isolatedGitEnv(homeB))
    const envB = isolatedGitEnv(homeB)
    gitSync(repoB, ['checkout', '-q', '-b', 'feature'], envB)

    // #when — observing the REMOTE's (repoA's) default branch, versus the CHECKOUT's (repoB's)
    // current branch
    const symrefLine = gitSync(repoB, ['ls-remote', '--symref', 'origin', 'HEAD'], envB).split('\n')[0] ?? ''
    const defaultBranchMatch = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(symrefLine)
    const currentBranch = gitSync(repoB, ['symbolic-ref', '--short', 'HEAD'], envB).trim()

    // #then
    expect(defaultBranchMatch?.[1]).toBe('main')
    expect(currentBranch).toBe('feature')
  })

  it('remote moved between observations: an `ls-remote` taken later reports a different SHA', async () => {
    const env = isolatedGitEnv(homeA)
    commitFile(repoA, env, 'a.txt', 'one', 'c1')
    const firstObservation = gitSync(repoA, ['ls-remote', repoA, 'HEAD'], env).split('\t')[0]?.trim()

    commitFile(repoA, env, 'b.txt', 'two', 'c2')
    const secondObservation = gitSync(repoA, ['ls-remote', repoA, 'HEAD'], env).split('\t')[0]?.trim()

    expect(firstObservation).not.toBe(secondObservation)
  })

  it('initialized submodule: `git submodule status` distinguishes initialized from deinitialized', async () => {
    const subEnv = isolatedGitEnv(homeB)
    initRepo(repoB, subEnv)
    commitFile(repoB, subEnv, 's.txt', 's', 'sub commit')

    const env = isolatedGitEnv(homeA)
    commitFile(repoA, env, 'a.txt', 'one', 'c1')
    gitSync(repoA, ['-c', 'protocol.file.allow=always', 'submodule', 'add', repoB, 'subdir'], env)

    const initializedStatus = gitSync(repoA, ['submodule', 'status'], env)
    expect(initializedStatus.startsWith(' ')).toBe(true)

    gitSync(repoA, ['submodule', 'deinit', '-f', 'subdir'], env)
    const deinitializedStatus = gitSync(repoA, ['submodule', 'status'], env)
    expect(deinitializedStatus.startsWith('-')).toBe(true)
  })
})

describe('config profile — fresh-clone allowlist (Unit 3 checkout-profile.ts, not implemented yet)', () => {
  it('the key set produced by a real fresh clone passes the allowlist', async () => {
    // #given a REAL `git clone` made by the same git binary under test \u2014 never hardcoded from
    // documentation, per the plan's "Deferred to Implementation" note
    const envA = isolatedGitEnv(homeA)
    commitFile(repoA, envA, 'a.txt', 'one', 'c1')
    const clonePath = await makeTempDir('policy-freshclone-')
    const cloneHome = await makeTempDir('policy-freshclone-home-')
    const cloneEnv = isolatedGitEnv(cloneHome)
    gitSync(cloneHome, ['clone', '-q', repoA, clonePath], cloneEnv)

    const freshCloneKeys = gitSync(clonePath, ['config', '--local', '--list', '--no-includes'], cloneEnv)
    // eslint-disable-next-line no-console -- documents the actual allowlist candidate for Unit 3
    console.log(`[update-fixtures/policy-profile] fresh-clone config keys:\n${freshCloneKeys}`)

    // #when
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit
    // 3 lands.
    const outcome = await inventoryCheckoutConfig({checkoutPath: clonePath, timeoutMs: 5_000})

    // #then
    expect(outcome.kind).toBe('allowed')
    await rm(clonePath, {recursive: true, force: true})
    await rm(cloneHome, {recursive: true, force: true})
  })

  it('adding a single disallowed key refuses, naming that key', async () => {
    const envA = isolatedGitEnv(homeA)
    commitFile(repoA, envA, 'a.txt', 'one', 'c1')
    const clonePath = await makeTempDir('policy-freshclone-')
    const cloneHome = await makeTempDir('policy-freshclone-home-')
    const cloneEnv = isolatedGitEnv(cloneHome)
    gitSync(cloneHome, ['clone', '-q', repoA, clonePath], cloneEnv)
    gitSync(clonePath, ['config', 'http.proxy', 'http://127.0.0.1:1'], cloneEnv)

    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit
    // 3 lands.
    const outcome = await inventoryCheckoutConfig({checkoutPath: clonePath, timeoutMs: 5_000})

    expect(outcome.kind).toBe('refused')
    const disallowedKeys = outcome.kind === 'refused' ? outcome.disallowedKeys : []
    expect(disallowedKeys).toContain('http.proxy')
    await rm(clonePath, {recursive: true, force: true})
    await rm(cloneHome, {recursive: true, force: true})
  })
})
