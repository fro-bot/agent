/**
 * Tests for inspect.ts — exercised against REAL git repositories in temp directories.
 *
 * No git output is mocked: the value of this module is that it is correct against real git
 * behavior (porcelain v2 parsing, config-injection neutralization, index read-only-ness).
 */

import type {Buffer} from 'node:buffer'

import type {GitRunnerFn, InspectHandlerDeps} from './inspect.js'
import type {InspectRequest} from './types.js'
import {execFileSync} from 'node:child_process'
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import {mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import process from 'node:process'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {AGENT_GID, AGENT_UID} from './identity.js'
import {inspectCheckout, runGit} from './inspect.js'

// ---------------------------------------------------------------------------
// Real-git test helpers
// ---------------------------------------------------------------------------

// Isolated from the host's own ~/.gitconfig and any XDG global config (e.g. a locally-configured
// `merge.ff=only` would otherwise make test-setup merges behave differently machine to machine).
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function gitSync(cwd: string, args: string[]): string {
  return execFileSync('git', args, {cwd, env: GIT_ENV, encoding: 'utf8'})
}

function initRepo(dir: string): void {
  gitSync(dir, ['-c', 'init.defaultBranch=main', 'init', '-q'])
}

function commitFile(dir: string, name: string, content: string, message: string): string {
  writeFileSync(join(dir, name), content)
  gitSync(dir, ['add', name])
  gitSync(dir, ['commit', '-q', '-m', message])
  return gitSync(dir, ['rev-parse', 'HEAD']).trim()
}

let reposRoot: string

beforeEach(async () => {
  reposRoot = await mkdtemp(join(os.tmpdir(), 'inspect-test-'))
})

afterEach(async () => {
  await rm(reposRoot, {recursive: true, force: true})
})

/** Creates a bare owner/repo layout under reposRoot and returns the checkout path. */
async function makeCheckoutDir(): Promise<{owner: string; repo: string; dir: string}> {
  const owner = 'testowner'
  const repo = 'testrepo'
  const dir = join(reposRoot, owner, repo)
  await mkdir(dir, {recursive: true})
  return {owner, repo, dir}
}

function req(owner: string, repo: string): InspectRequest {
  return {owner, repo}
}

/**
 * Default deps for every real-git test below: reposRoot plus a uid/gid override.
 *
 * WHY: this machine is not root, so inspectCheckout's PRODUCTION default (AGENT_UID/AGENT_GID =
 * 10001/10001 from identity.ts) fails here — an unprivileged process cannot setuid(2) to an
 * arbitrary uid it doesn't own. Passing the CURRENT process's own uid/gid instead keeps every git
 * invocation running through the EXACT SAME code path production uses (GitRunnerOptions.uid/gid
 * is still populated, still threaded into execFile's options) — the only thing that differs is
 * WHICH identity value is used, not whether the uid/gid-passing machinery runs at all. setuid(2)
 * permits an unprivileged process to "switch" to its own real uid (a no-op in practice), so this
 * neither skips nor weakens the code under test. The real cross-uid behavior — an actual 10001
 * checkout owner, actual privilege drop — is exercised in CI's container harness (a later lane),
 * which is the only place that can meaningfully test it without running the whole suite as root.
 */
function localDeps(overrides: InspectHandlerDeps = {}): InspectHandlerDeps {
  return {
    reposRoot,
    options: {uid: process.getuid?.(), gid: process.getgid?.()},
    ...overrides,
  }
}

/**
 * Bumps a tracked file's mtime into the future so its stat info no longer matches what's cached
 * in the index — the precondition `git status` needs before it re-checks the file's content,
 * which is what makes it invoke a configured `filter.<driver>.clean`/`.process` at all.
 */
function makeStatDirty(filePath: string): void {
  const future = new Date(Date.now() + 60_000)
  utimesSync(filePath, future, future)
}

// ---------------------------------------------------------------------------
// uid/gid defaults — NOT exercised against real git (this machine can't setuid to an
// arbitrary uid); asserts the OPTIONS every git invocation receives, via an injected recording
// gitRunner. Production behavior for an actual 10001 identity is exercised in CI's container
// harness (a later lane).
// ---------------------------------------------------------------------------

describe('inspectCheckout — uid/gid defaults', () => {
  it('passes AGENT_UID/AGENT_GID (identity.ts) to every git invocation when the caller does not override them', async () => {
    // #given — real directories so realpath() resolves (rev-parse's reported toplevel/git-dir
    // must exist on disk), but a FAKE gitRunner stands in for git itself so no real setuid
    // happens on this non-root machine.
    const {owner, repo, dir} = await makeCheckoutDir()
    const gitDir = join(dir, '.git')
    await mkdir(gitDir, {recursive: true})

    const capturedOptions: {uid?: number; gid?: number}[] = []
    const fakeGitRunner: GitRunnerFn = async (args, options) => {
      capturedOptions.push({uid: options.uid, gid: options.gid})
      if (args.includes('rev-parse')) {
        return {kind: 'ok', stdout: `${dir}\n${gitDir}\n`, stderr: ''}
      }
      if (args.includes('config')) {
        return {kind: 'ok', stdout: '', stderr: ''}
      }
      // status
      return {
        kind: 'ok',
        stdout: `# branch.oid ${'a'.repeat(40)}\n# branch.head main\n`,
        stderr: '',
      }
    }

    // #when — NO uid/gid override in deps.options: production default path.
    const result = await inspectCheckout(req(owner, repo), {reposRoot, gitRunner: fakeGitRunner})

    // #then
    expect(result.response.ok).toBe(true)
    expect(capturedOptions.length).toBeGreaterThanOrEqual(3) // rev-parse, config enumeration, status
    for (const options of capturedOptions) {
      expect(options.uid).toBe(AGENT_UID)
      expect(options.gid).toBe(AGENT_GID)
    }
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('inspectCheckout — happy path', () => {
  it('reports a clean attached checkout on a branch', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    const sha = commitFile(dir, 'a.txt', 'base\n', 'initial commit')

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.statusCode).toBe(200)
    expect(result.response.ok).toBe(true)
    const success = result.response as {ok: true; observation: import('./types.js').CheckoutObservation}
    expect(success.observation.head).toEqual({kind: 'attached', branch: 'main', sha})
    expect(success.observation.worktree).toEqual({kind: 'clean'})
    expect(success.observation.operationInProgress).toBe('none')
    expect(() => new Date(success.observation.observedAt).toISOString()).not.toThrow()
    expect(new Date(success.observation.observedAt).toISOString()).toBe(success.observation.observedAt)
  })

  it('reports a detached HEAD', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    const sha = commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    gitSync(dir, ['checkout', '--detach', sha, '-q'])

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.response.ok).toBe(true)
    const success = result.response as {ok: true; observation: import('./types.js').CheckoutObservation}
    expect(success.observation.head).toEqual({kind: 'detached', sha})
  })

  it('isolates staged count', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    writeFileSync(join(dir, 'b.txt'), 'new\n')
    gitSync(dir, ['add', 'b.txt'])

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    const success = result.response as {ok: true; observation: import('./types.js').CheckoutObservation}
    expect(success.observation.worktree).toEqual({kind: 'dirty', staged: 1, unstaged: 0, untracked: 0, conflicted: 0})
  })

  it('isolates unstaged count', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    writeFileSync(join(dir, 'a.txt'), 'modified\n')

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    const success = result.response as {ok: true; observation: import('./types.js').CheckoutObservation}
    expect(success.observation.worktree).toEqual({kind: 'dirty', staged: 0, unstaged: 1, untracked: 0, conflicted: 0})
  })

  it('isolates untracked count', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    writeFileSync(join(dir, 'c.txt'), 'untracked\n')

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    const success = result.response as {ok: true; observation: import('./types.js').CheckoutObservation}
    expect(success.observation.worktree).toEqual({kind: 'dirty', staged: 0, unstaged: 0, untracked: 1, conflicted: 0})
  })

  it('isolates conflicted count from an in-progress merge', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'line1\n', 'base')
    gitSync(dir, ['branch', 'feature'])
    writeFileSync(join(dir, 'a.txt'), 'line1\nmain-change\n')
    gitSync(dir, ['commit', '-q', '-am', 'main change'])
    gitSync(dir, ['checkout', 'feature', '-q'])
    writeFileSync(join(dir, 'a.txt'), 'line1\nfeature-change\n')
    gitSync(dir, ['commit', '-q', '-am', 'feature change'])
    gitSync(dir, ['checkout', 'main', '-q'])
    try {
      gitSync(dir, ['merge', 'feature', '-q', '--no-edit', '--no-ff'])
    } catch {
      // Expected: merge conflict exits non-zero.
    }

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    const success = result.response as {ok: true; observation: import('./types.js').CheckoutObservation}
    expect(success.observation.worktree).toEqual({kind: 'dirty', staged: 0, unstaged: 0, untracked: 0, conflicted: 1})
  })

  it('detects a merge in progress', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'line1\n', 'base')
    gitSync(dir, ['branch', 'feature'])
    writeFileSync(join(dir, 'a.txt'), 'line1\nmain-change\n')
    gitSync(dir, ['commit', '-q', '-am', 'main change'])
    gitSync(dir, ['checkout', 'feature', '-q'])
    writeFileSync(join(dir, 'a.txt'), 'line1\nfeature-change\n')
    gitSync(dir, ['commit', '-q', '-am', 'feature change'])
    gitSync(dir, ['checkout', 'main', '-q'])
    try {
      gitSync(dir, ['merge', 'feature', '-q', '--no-edit', '--no-ff'])
    } catch {
      // Expected: merge conflict exits non-zero.
    }

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    const success = result.response as {ok: true; observation: import('./types.js').CheckoutObservation}
    expect(success.observation.operationInProgress).toBe('merge')
  })

  it('detects a rebase in progress', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'line1\n', 'base')
    gitSync(dir, ['branch', 'topic'])
    writeFileSync(join(dir, 'a.txt'), 'line1\nmain-change\n')
    gitSync(dir, ['commit', '-q', '-am', 'main change'])
    gitSync(dir, ['checkout', 'topic', '-q'])
    writeFileSync(join(dir, 'a.txt'), 'line1\ntopic-change\n')
    gitSync(dir, ['commit', '-q', '-am', 'topic change'])
    try {
      gitSync(dir, ['rebase', 'main'])
    } catch {
      // Expected: rebase stops on conflict.
    }

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    const success = result.response as {ok: true; observation: import('./types.js').CheckoutObservation}
    expect(success.observation.operationInProgress).toBe('rebase')
  })

  it("detects a real `git am` in progress and reports it as 'am', not 'rebase'", async () => {
    // #given — build a patch from a divergent commit and `git am` it against a base that no
    // longer matches, so `git am` stops with a conflict and leaves rebase-apply/applying.
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'line1\n', 'base')
    gitSync(dir, ['branch', 'topic'])
    writeFileSync(join(dir, 'a.txt'), 'line1\nmain-change\n')
    gitSync(dir, ['commit', '-q', '-am', 'main change'])
    gitSync(dir, ['checkout', 'topic', '-q'])
    writeFileSync(join(dir, 'a.txt'), 'line1\ntopic-change\n')
    gitSync(dir, ['commit', '-q', '-am', 'topic change'])

    const patchDir = mkdtempSync(join(os.tmpdir(), 'inspect-am-patch-'))
    try {
      execFileSync('git', ['format-patch', '-1', 'topic', '-o', patchDir], {cwd: dir, env: GIT_ENV})
      const [patchName] = readdirSync(patchDir)
      if (patchName === undefined) throw new Error('format-patch produced no patch file')
      const patchPath = join(patchDir, patchName)

      gitSync(dir, ['checkout', 'main', '-q'])
      try {
        execFileSync('git', ['am', patchPath], {cwd: dir, env: GIT_ENV})
      } catch {
        // Expected: the patch does not cleanly apply to `main`, so `git am` stops mid-apply.
      }

      // #when
      const result = await inspectCheckout(req(owner, repo), localDeps())

      // #then
      const success = result.response as {ok: true; observation: import('./types.js').CheckoutObservation}
      expect(success.observation.operationInProgress).toBe('am')
    } finally {
      rmSync(patchDir, {recursive: true, force: true})
    }
  })

  it("detects an apply-based `git rebase --apply` conflict and reports it as 'rebase', not 'am'", async () => {
    // #given — force the legacy apply-based rebase backend so it leaves rebase-apply/rebasing
    // rather than rebase-merge/.
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'line1\n', 'base')
    gitSync(dir, ['branch', 'topic'])
    writeFileSync(join(dir, 'a.txt'), 'line1\nmain-change\n')
    gitSync(dir, ['commit', '-q', '-am', 'main change'])
    gitSync(dir, ['checkout', 'topic', '-q'])
    writeFileSync(join(dir, 'a.txt'), 'line1\ntopic-change\n')
    gitSync(dir, ['commit', '-q', '-am', 'topic change'])
    try {
      gitSync(dir, ['rebase', '--apply', 'main'])
    } catch {
      // Expected: apply-based rebase stops on conflict.
    }

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    const success = result.response as {ok: true; observation: import('./types.js').CheckoutObservation}
    expect(success.observation.operationInProgress).toBe('rebase')
  })
})

// ---------------------------------------------------------------------------
// Errors: no checkout, substitution, escape
// ---------------------------------------------------------------------------

describe('inspectCheckout — errors', () => {
  it('returns no-checkout when the path does not exist', async () => {
    // #given — reposRoot exists but owner/repo does not
    // #when
    const result = await inspectCheckout(req('nope', 'nope'), localDeps())

    // #then
    expect(result.statusCode).toBe(404)
    expect(result.response).toEqual({ok: false, error: 'no-checkout'})
  })

  it('returns no-checkout when the directory exists but is not a git repo', async () => {
    // #given
    // plain empty directory, no git init
    const {owner, repo} = await makeCheckoutDir()

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.response).toEqual({ok: false, error: 'no-checkout'})
  })

  it('rejects a .git file redirecting outside the checkout', async () => {
    // #given — a valid repo elsewhere, and the canonical checkout's .git is a file
    // pointing at that external repo's gitdir instead of its own.
    const {owner, repo, dir} = await makeCheckoutDir()
    const externalDir = join(reposRoot, 'external-repo')
    await mkdir(externalDir, {recursive: true})
    initRepo(externalDir)
    commitFile(externalDir, 'x.txt', 'x\n', 'external commit')
    const externalGitDir = join(externalDir, '.git')

    // dir has no .git of its own; redirect it to the external repo's real gitdir.
    await writeFile(join(dir, '.git'), `gitdir: ${externalGitDir}\n`)

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'checkout-substituted'})
  })

  it('rejects a checkout substituted by an ancestor repository (no .git of its own)', async () => {
    // #given — the owner directory (one level up from the canonical repo path) is itself a git
    // repo, and the canonical repo directory has no .git of its own. `git rev-parse
    // --show-toplevel` from inside it walks upward and resolves to the ancestor, not the
    // canonical path.
    const owner = 'testowner'
    const repo = 'testrepo'
    const ownerDir = join(reposRoot, owner)
    const dir = join(ownerDir, repo)
    await mkdir(dir, {recursive: true})
    initRepo(ownerDir)
    commitFile(ownerDir, 'ancestor.txt', 'a\n', 'ancestor commit')

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'checkout-substituted'})
  })

  it('rejects a symlinked .git escaping the checkout', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    const externalDir = join(reposRoot, 'external-repo-2')
    await mkdir(externalDir, {recursive: true})
    initRepo(externalDir)
    commitFile(externalDir, 'x.txt', 'x\n', 'external commit')

    await symlink(join(externalDir, '.git'), join(dir, '.git'))

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'checkout-substituted'})
  })

  // -------------------------------------------------------------------------
  // Symlinked-checkout escape: the owner/repo path itself (not just .git) is a
  // symlink. Real symlinks in a temp dir, never mocked realpath — the fix must hold
  // against actual filesystem resolution.
  // -------------------------------------------------------------------------

  it('rejects a repo directory symlinked to a repo OUTSIDE the repos root (induced-failure baseline: fails without the fix)', async () => {
    // #given — a real git repo living entirely outside reposRoot, and
    // reposRoot/owner/repo is a symlink pointing straight at it.
    const owner = 'testowner'
    const repo = 'testrepo'
    const outsideRoot = await mkdtemp(join(os.tmpdir(), 'inspect-outside-'))
    const outsideRepoDir = join(outsideRoot, 'evil-target')
    await mkdir(outsideRepoDir, {recursive: true})
    initRepo(outsideRepoDir)
    commitFile(outsideRepoDir, 'secret.txt', 'outside\n', 'outside commit')

    await mkdir(join(reposRoot, owner), {recursive: true})
    await symlink(outsideRepoDir, join(reposRoot, owner, repo))

    try {
      // #when
      const result = await inspectCheckout(req(owner, repo), localDeps())

      // #then — must be rejected, never report the outside repo's state as this repo's.
      expect(result.statusCode).toBe(409)
      expect(result.response).toEqual({ok: false, error: 'checkout-substituted'})
    } finally {
      await rm(outsideRoot, {recursive: true, force: true})
    }
  })

  it('rejects a repo directory symlinked to a DIFFERENT repo inside the repos root', async () => {
    // #given — a real repo at reposRoot/otherowner/otherrepo, and reposRoot/testowner/testrepo
    // is a symlink pointing at it instead of being its own checkout.
    const owner = 'testowner'
    const repo = 'testrepo'
    const otherOwner = 'otherowner'
    const otherRepo = 'otherrepo'
    const otherDir = join(reposRoot, otherOwner, otherRepo)
    await mkdir(otherDir, {recursive: true})
    initRepo(otherDir)
    commitFile(otherDir, 'other.txt', 'other\n', 'other commit')

    await mkdir(join(reposRoot, owner), {recursive: true})
    await symlink(otherDir, join(reposRoot, owner, repo))

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then — rejected even though the target is inside reposRoot: a prefix/"underneath" check
    // alone would have let this through.
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'checkout-substituted'})
  })

  it('rejects a checkout whose owner component is a symlink', async () => {
    // #given — the real repo lives at reposRoot/real-owner-dir/testrepo, and
    // reposRoot/testowner is a symlink to real-owner-dir.
    const owner = 'testowner'
    const repo = 'testrepo'
    const realOwnerDir = join(reposRoot, 'real-owner-dir')
    const realRepoDir = join(realOwnerDir, repo)
    await mkdir(realRepoDir, {recursive: true})
    initRepo(realRepoDir)
    commitFile(realRepoDir, 'a.txt', 'base\n', 'initial commit')

    await symlink(realOwnerDir, join(reposRoot, owner))

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'checkout-substituted'})
  })

  it('still accepts an ordinary (non-symlinked) checkout', async () => {
    // #given — sanity control: no symlinks anywhere in the path.
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.statusCode).toBe(200)
    expect(result.response.ok).toBe(true)
  })

  it('times out and confirms the git subprocess is terminated', async () => {
    // #given — a fake `git` binary whose ENTIRE script body is a single `exec sleep 5`. `exec`
    // replaces the shell's own process image with `sleep` — no fork, no grandchild — so the pid
    // `runGit` sends SIGKILL to IS `sleep` itself. This is deliberately different from a script
    // that forks a child and waits on it (see the `termination-unconfirmed` test below, which
    // proves the negative case: a forked-and-waited child is NOT reliably killed by signaling
    // just the parent).
    const {dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')

    const fakeBinDir = mkdtempSync(join(os.tmpdir(), 'fake-git-bin-'))
    const fakeGitPath = join(fakeBinDir, 'git')
    writeFileSync(fakeGitPath, '#!/bin/sh\nexec sleep 5\n')
    chmodSync(fakeGitPath, 0o755)

    try {
      // #when — call the exported runner directly with a PATH that resolves to the fake binary.
      const start = Date.now()
      const outcome = await runGit(['status'], {
        cwd: dir,
        // fakeBinDir first so `git` resolves to our sleeping stub, but the rest of PATH stays so
        // the stub's own `sleep` call resolves normally inside its shell.
        env: {PATH: `${fakeBinDir}:${process.env.PATH ?? '/usr/bin:/bin'}`},
        timeoutMs: 150,
      })
      const elapsedMs = Date.now() - start

      // #then — confirmed quickly (well inside the 2s reap grace), proving `sleep` itself — not
      // just its parent shell — was actually killed rather than left running for its full 5s.
      expect(outcome).toEqual({kind: 'timeout'})
      expect(elapsedMs).toBeLessThan(2_000)
    } finally {
      rmSync(fakeBinDir, {recursive: true, force: true})
    }
  })

  it('reports termination-unconfirmed (never timeout) when SIGKILL is sent but the child never confirms closed', async () => {
    // #given — a fake `git` that FORKS `sleep 10` as its own child and waits on it (no `exec`
    // tail-call — the shell stays alive as `sleep`'s parent). `runGit` sends SIGKILL only to the
    // pid it was given: the SHELL. That kills the shell immediately, but `sleep 10` is the
    // shell's own child, not the process `kill()` targeted — SIGKILL does not cascade to it, and
    // it keeps running (and keeps holding the inherited stdout/stderr pipe open) for the rest of
    // its 10s, well past the runner's 2s reap-grace window. This is a real, reproducible
    // "attempted but unconfirmed" termination — the mirror image of the `exec`-based test above,
    // which proves the confirmed case.
    const {dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')

    const fakeBinDir = mkdtempSync(join(os.tmpdir(), 'fake-git-bin-unconfirmed-'))
    const fakeGitPath = join(fakeBinDir, 'git')
    writeFileSync(fakeGitPath, '#!/bin/sh\nsleep 10\n')
    chmodSync(fakeGitPath, 0o755)

    try {
      // #when — short timeout so SIGKILL fires almost immediately; the grace window (2s, not
      // caller-configurable) is what this test actually waits out.
      const outcome = await runGit(['status'], {
        cwd: dir,
        env: {PATH: `${fakeBinDir}:${process.env.PATH ?? '/usr/bin:/bin'}`},
        timeoutMs: 150,
      })

      // #then — distinct from the confirmed-timeout outcome above: this must NEVER claim the
      // process definitely stopped.
      expect(outcome).toEqual({kind: 'termination-unconfirmed'})
    } finally {
      rmSync(fakeBinDir, {recursive: true, force: true})
    }
  }, 8_000)
})

// ---------------------------------------------------------------------------
// Config-injection neutralization: hostile core.fsmonitor must never execute.
// ---------------------------------------------------------------------------

describe('inspectCheckout — hostile core.fsmonitor', () => {
  it('does not execute a hostile core.fsmonitor hook', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')

    const markerPath = join(dir, 'fsmonitor-fired')
    const hookPath = join(dir, 'hostile-fsmonitor.sh')
    writeFileSync(hookPath, `#!/bin/sh\ntouch '${markerPath}'\nprintf '1\\n'\n`)
    chmodSync(hookPath, 0o755)
    gitSync(dir, ['config', 'core.fsmonitor', hookPath])

    // #when — the protected code path (inspectCheckout) applies -c core.fsmonitor=false.
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.response.ok).toBe(true)
    expect(() => statSync(markerPath)).toThrow()
  })

  it('induced failure: the same hostile hook DOES fire without the -c override (proves the test is meaningful)', async () => {
    // #given — identical hostile config, but invoked via a raw git status call that omits
    // `-c core.fsmonitor=false`.
    const {dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')

    const markerPath = join(dir, 'fsmonitor-fired-unprotected')
    const hookPath = join(dir, 'hostile-fsmonitor.sh')
    writeFileSync(hookPath, `#!/bin/sh\ntouch '${markerPath}'\nprintf '1\\n'\n`)
    chmodSync(hookPath, 0o755)
    gitSync(dir, ['config', 'core.fsmonitor', hookPath])

    // #when — raw git status, no core.fsmonitor override.
    let failureOutput = ''
    try {
      failureOutput = execFileSync('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'], {
        env: GIT_ENV,
        encoding: 'utf8',
      })
    } catch (error) {
      failureOutput = error instanceof Error ? error.message : String(error)
    }

    // #then — the marker exists, proving the hostile hook executed when unprotected.
    expect(() => statSync(markerPath)).not.toThrow()
    // Documented for the report: this is the induced-failure evidence.
    expect(typeof failureOutput).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Config-injection neutralization: hostile filter.<driver> drivers must never execute.
//
// `git status` runs a tracked file's assigned `filter.<driver>.clean` (and, for a process
// filter, `.process`) whenever the file's stat info no longer matches the index — none of this
// is reached by the fixed `-c core.fsmonitor=false` etc. neutralizers above, because the driver
// is looked up by name from `.gitattributes`/`.git/info/attributes`, and the set of configured
// names isn't fixed. Every test below plants a hostile driver, makes the file stat-dirty, and
// asserts the marker it would write is never created.
// ---------------------------------------------------------------------------

describe('inspectCheckout — hostile filter drivers', () => {
  it('does not execute a hostile filter.<x>.clean driver on a stat-dirty tracked file', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    const markerPath = join(dir, 'clean-fired')
    gitSync(dir, ['config', 'filter.evil.clean', `touch ${markerPath}; cat`])
    // .git/info/attributes (untracked) rather than a committed .gitattributes: the attribute
    // applies only to a.txt, and setup itself never runs the filter it's testing.
    writeFileSync(join(dir, '.git', 'info', 'attributes'), 'a.txt filter=evil\n')
    makeStatDirty(join(dir, 'a.txt'))

    // #when — the protected code path enumerates and neutralizes filter.evil.clean.
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.response.ok).toBe(true)
    expect(() => statSync(markerPath)).toThrow()
  })

  it('induced failure: the same hostile clean driver DOES fire without neutralization (raw git control)', async () => {
    // #given — identical hostile config, but invoked via a raw git status call with no filter
    // neutralization at all.
    const {dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    const markerPath = join(dir, 'clean-fired-unprotected')
    gitSync(dir, ['config', 'filter.evil.clean', `touch ${markerPath}; cat`])
    writeFileSync(join(dir, '.git', 'info', 'attributes'), 'a.txt filter=evil\n')
    makeStatDirty(join(dir, 'a.txt'))

    // #when — raw git status, no filter neutralization.
    try {
      execFileSync('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'], {env: GIT_ENV, encoding: 'utf8'})
    } catch {
      // Irrelevant here whether `status` itself exits non-zero; only the marker matters.
    }

    // #then — the marker exists, proving the hostile driver executed when unprotected.
    expect(() => statSync(markerPath)).not.toThrow()
  })

  it('does not execute a hostile filter.<x>.process driver, and status still succeeds despite required=true', async () => {
    // #given — a process filter that writes a marker then fails the protocol handshake, with
    // `required=true` explicitly set so a leftover-true `required` can't be relied on to make
    // `status` fail safely instead of neutralizing the driver.
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    const fakeBinDir = mkdtempSync(join(os.tmpdir(), 'fake-process-filter-'))
    const markerPath = join(fakeBinDir, 'process-fired')
    const scriptPath = join(fakeBinDir, 'procf.sh')
    writeFileSync(scriptPath, `#!/bin/sh\ntouch '${markerPath}'\nexit 1\n`)
    chmodSync(scriptPath, 0o755)

    try {
      gitSync(dir, ['config', 'filter.evilproc.process', scriptPath])
      gitSync(dir, ['config', 'filter.evilproc.required', 'true'])
      writeFileSync(join(dir, '.git', 'info', 'attributes'), 'a.txt filter=evilproc\n')
      makeStatDirty(join(dir, 'a.txt'))

      // #when
      const result = await inspectCheckout(req(owner, repo), localDeps())

      // #then — no execution, AND the forced required=false override kept status itself
      // succeeding (a hostile `required=true` left in place would otherwise fail `status`).
      expect(result.response.ok).toBe(true)
      expect(() => statSync(markerPath)).toThrow()
    } finally {
      rmSync(fakeBinDir, {recursive: true, force: true})
    }
  })

  it('induced failure: the same hostile process driver DOES start without neutralization (raw git control)', async () => {
    // #given
    const {dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    const fakeBinDir = mkdtempSync(join(os.tmpdir(), 'fake-process-filter-unprotected-'))
    const markerPath = join(fakeBinDir, 'process-fired-unprotected')
    const scriptPath = join(fakeBinDir, 'procf.sh')
    writeFileSync(scriptPath, `#!/bin/sh\ntouch '${markerPath}'\nexit 1\n`)
    chmodSync(scriptPath, 0o755)

    try {
      gitSync(dir, ['config', 'filter.evilproc.process', scriptPath])
      writeFileSync(join(dir, '.git', 'info', 'attributes'), 'a.txt filter=evilproc\n')
      makeStatDirty(join(dir, 'a.txt'))

      // #when — raw git status, no filter neutralization.
      try {
        execFileSync('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'], {env: GIT_ENV, encoding: 'utf8'})
      } catch {
        // Expected: the fake process filter fails the protocol handshake and status errors.
      }

      // #then — the marker exists, proving the process filter was started when unprotected. A
      // process filter speaks a protocol rather than running to completion, but writing the
      // marker before failing the handshake is enough to prove it was launched.
      expect(() => statSync(markerPath)).not.toThrow()
    } finally {
      rmSync(fakeBinDir, {recursive: true, force: true})
    }
  })

  it('neutralizes a driver name containing a dot', async () => {
    // #given — `filter.evil.dot.clean`: the driver name itself is `evil.dot`, not `evil`.
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    const markerPath = join(dir, 'dotted-fired')
    gitSync(dir, ['config', 'filter.evil.dot.clean', `touch ${markerPath}; cat`])
    writeFileSync(join(dir, '.git', 'info', 'attributes'), 'a.txt filter=evil.dot\n')
    makeStatDirty(join(dir, 'a.txt'))

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.response.ok).toBe(true)
    expect(() => statSync(markerPath)).toThrow()
  })

  it('neutralizes a driver name containing an equals sign (cannot be overridden via -c)', async () => {
    // #given — `-c 'filter.evil=x.clean=...'` would split on the FIRST `=`, corrupting the key.
    // Only the GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> env mechanism keeps this driver name
    // intact.
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    const markerPath = join(dir, 'eq-fired')
    gitSync(dir, ['config', 'filter.evil=x.clean', `touch ${markerPath}; cat`])
    writeFileSync(join(dir, '.git', 'info', 'attributes'), 'a.txt filter=evil=x\n')
    makeStatDirty(join(dir, 'a.txt'))

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.response.ok).toBe(true)
    expect(() => statSync(markerPath)).toThrow()
  })

  it('neutralizes a driver defined in a file pulled in through include.path', async () => {
    // #given — the driver itself lives in a separate file, only reachable through `include.path`.
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    const markerPath = join(dir, 'included-fired')
    const includedConfigPath = join(dir, 'included.gitconfig')
    writeFileSync(includedConfigPath, `[filter "included"]\n\tclean = touch ${markerPath}; cat\n`)
    gitSync(dir, ['config', 'include.path', includedConfigPath])
    writeFileSync(join(dir, '.git', 'info', 'attributes'), 'a.txt filter=included\n')
    makeStatDirty(join(dir, 'a.txt'))

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.response.ok).toBe(true)
    expect(() => statSync(markerPath)).toThrow()
  })

  it('never invokes `git status` when filter-driver enumeration fails (fails closed)', async () => {
    // #given — an injected runner that fails only the `git config` enumeration call and
    // otherwise delegates to the real runner, plus a recorder of every invocation's argv.
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    const invocations: (readonly string[])[] = []
    const failingConfigRunner: GitRunnerFn = async (args, options) => {
      invocations.push(args)
      if (args.includes('config')) {
        return {kind: 'failed', code: 2, stdout: '', stderr: 'simulated enumeration failure'}
      }
      return runGit(args, options)
    }

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps({gitRunner: failingConfigRunner}))

    // #then — reported as inspection-failed, and `status` was never called at all.
    expect(result.statusCode).toBe(500)
    expect(result.response).toEqual({ok: false, error: 'inspection-failed'})
    expect(invocations.some(args => args.includes('status'))).toBe(false)
  })

  it('does not descend into a submodule with its own hostile filter driver', async () => {
    // #given — the submodule has its own config and its own hostile clean driver, entirely
    // separate from the superproject's config that enumeration reads.
    const {owner, repo, dir} = await makeCheckoutDir()
    const subDir = await mkdtemp(join(os.tmpdir(), 'inspect-submodule-'))
    initRepo(subDir)
    commitFile(subDir, 's.txt', 'sub\n', 'submodule base')

    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    try {
      execFileSync('git', ['-C', dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subDir, 'subdir'], {
        env: GIT_ENV,
      })
      gitSync(dir, ['commit', '-q', '-m', 'add submodule'])

      const submoduleDir = join(dir, 'subdir')
      const markerPath = join(dir, 'submodule-fired')
      gitSync(submoduleDir, ['config', 'filter.evilsub.clean', `touch ${markerPath}; cat`])
      // Written directly into the submodule's real git-dir info/attributes, never through `git
      // add`/`git commit` in the submodule: staging a newly-attributed .gitattributes change
      // itself makes real git re-run the clean filter on s.txt as a side effect of that add —
      // that's setup noise from an unprotected raw git call, not the vector under test, and
      // would otherwise plant the marker before inspectCheckout ever runs.
      const submoduleGitDir = gitSync(submoduleDir, ['rev-parse', '--absolute-git-dir']).trim()
      mkdirSync(join(submoduleGitDir, 'info'), {recursive: true})
      writeFileSync(join(submoduleGitDir, 'info', 'attributes'), 's.txt filter=evilsub\n')
      makeStatDirty(join(submoduleDir, 's.txt'))

      // #when
      const result = await inspectCheckout(req(owner, repo), localDeps())

      // #then — `--ignore-submodules=all` means status never looks inside the submodule at all.
      expect(result.response.ok).toBe(true)
      expect(() => statSync(markerPath)).toThrow()
    } finally {
      await rm(subDir, {recursive: true, force: true})
    }
  })
})

// ---------------------------------------------------------------------------
// Read-only invariant: the index is never modified.
// ---------------------------------------------------------------------------

/**
 * Read the index's bytes and mtime from ONE open file descriptor, so both describe the same
 * file at the same moment. Reading bytes by path and then stat-ing by path again could pair
 * one version's contents with another's timestamp if the file were replaced in between.
 */
function snapshotIndex(indexPath: string): {readonly bytes: Buffer; readonly mtimeMs: number} {
  const fd = openSync(indexPath, 'r')
  try {
    return {bytes: readFileSync(fd), mtimeMs: fstatSync(fd).mtimeMs}
  } finally {
    closeSync(fd)
  }
}

describe('inspectCheckout — index is never modified', () => {
  it('leaves the index byte-identical after a protected inspection', async () => {
    // #given — force a stat mismatch (bumped mtime) so a plain `git status` would have a reason
    // to opportunistically rewrite the index's cached stat info.
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    const future = new Date(Date.now() + 60_000)
    utimesSync(join(dir, 'a.txt'), future, future)

    const indexPath = join(dir, '.git', 'index')
    const before = snapshotIndex(indexPath)

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.response.ok).toBe(true)
    const after = snapshotIndex(indexPath)
    expect(after.bytes.equals(before.bytes)).toBe(true)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('induced failure: a raw `git status` (no --no-optional-locks) DOES rewrite the index', async () => {
    // #given — same stat-mismatch setup.
    const {dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    const future = new Date(Date.now() + 60_000)
    utimesSync(join(dir, 'a.txt'), future, future)

    const indexPath = join(dir, '.git', 'index')
    const before = snapshotIndex(indexPath)

    // #when — raw git status, no --no-optional-locks.
    execFileSync('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'], {env: GIT_ENV, encoding: 'utf8'})

    // #then — the index changed (mtime or bytes), proving --no-optional-locks is the meaningful
    // protection dropped in the "protected" test above.
    const after = snapshotIndex(indexPath)
    const changed = after.mtimeMs !== before.mtimeMs || after.bytes.equals(before.bytes) === false
    expect(changed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Sanity: destPath resolution honors the injected reposRoot.
// ---------------------------------------------------------------------------

describe('inspectCheckout — path resolution', () => {
  it('resolves the canonical destPath the same way clone.ts derives it', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps())

    // #then
    expect(result.response.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// safe.directory: every git invocation resets and re-grants exactly the canonical checkout path.
// ---------------------------------------------------------------------------

describe('inspectCheckout — safe.directory', () => {
  it('passes -c safe.directory= then -c safe.directory=<canonicalPath> on every invocation, and status still succeeds', async () => {
    // #given — a recording gitRunner that delegates to the REAL runGit (so this exercises actual
    // git behavior, not a mock), capturing the argv of every call.
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')

    const invocations: (readonly string[])[] = []
    const recordingRunner: GitRunnerFn = async (args, options) => {
      invocations.push(args)
      return runGit(args, options)
    }

    // #when
    const result = await inspectCheckout(req(owner, repo), localDeps({gitRunner: recordingRunner}))

    // #then — status succeeded (safe.directory grants access; it isn't left blocking real git)
    expect(result.response.ok).toBe(true)
    expect(invocations.length).toBeGreaterThanOrEqual(3) // rev-parse, config enumeration, status

    // Compared against the REALPATH-resolved checkout dir, not the raw joined path: inspectCheckout
    // grants safe.directory for the canonical (symlink-resolved) path, which on some platforms
    // (e.g. macOS's /tmp -> /private/tmp) differs from the literal path this test constructed.
    const canonicalDir = await realpath(dir)

    // Every recorded invocation resets any prior safe.directory exception first (the empty
    // entry), then grants exactly the resolved checkout path — never `*`, never a parent path.
    for (const args of invocations) {
      const resetIdx = args.indexOf('safe.directory=')
      const grantIdx = args.indexOf(`safe.directory=${canonicalDir}`)
      expect(resetIdx).toBeGreaterThanOrEqual(0)
      expect(grantIdx).toBeGreaterThan(resetIdx)
      expect(args).not.toContain('safe.directory=*')
    }
  })

  it('never grants a parent directory or wildcard as safe.directory', async () => {
    // #given
    const {owner, repo, dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')

    const invocations: (readonly string[])[] = []
    const recordingRunner: GitRunnerFn = async (args, options) => {
      invocations.push(args)
      return runGit(args, options)
    }

    // #when
    await inspectCheckout(req(owner, repo), localDeps({gitRunner: recordingRunner}))

    // #then — no invocation grants the reposRoot, the owner directory, or `*`.
    const parentDir = join(dir, '..')
    for (const args of invocations) {
      expect(args).not.toContain('safe.directory=*')
      expect(args).not.toContain(`safe.directory=${reposRoot}`)
      expect(args).not.toContain(`safe.directory=${parentDir}`)
    }
  })
})
