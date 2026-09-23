/**
 * Tests for inspect.ts — exercised against REAL git repositories in temp directories.
 *
 * No git output is mocked: the value of this module is that it is correct against real git
 * behavior (porcelain v2 parsing, config-injection neutralization, index read-only-ness).
 */

import type {InspectRequest} from './types.js'

import {execFileSync} from 'node:child_process'
import {chmodSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync} from 'node:fs'
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import process from 'node:process'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
    const result = await inspectCheckout(req('nope', 'nope'), {reposRoot})

    // #then
    expect(result.statusCode).toBe(404)
    expect(result.response).toEqual({ok: false, error: 'no-checkout'})
  })

  it('returns no-checkout when the directory exists but is not a git repo', async () => {
    // #given
    // plain empty directory, no git init
    const {owner, repo} = await makeCheckoutDir()

    // #when
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

    // #then
    expect(result.statusCode).toBe(409)
    expect(result.response).toEqual({ok: false, error: 'checkout-substituted'})
  })

  it('times out and confirms the git subprocess is terminated', async () => {
    // #given — a fake `git` binary on PATH that sleeps, then would (if not killed) write a
    // marker file. A short timeout should kill it before the marker is ever written.
    const {dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')

    const fakeBinDir = mkdtempSync(join(os.tmpdir(), 'fake-git-bin-'))
    const markerPath = join(fakeBinDir, 'marker')
    const fakeGitPath = join(fakeBinDir, 'git')
    writeFileSync(fakeGitPath, `#!/bin/sh\nsleep 5\ntouch '${markerPath}'\n`)
    chmodSync(fakeGitPath, 0o755)

    try {
      // #when — call the exported runner directly with a PATH that resolves to the fake binary.
      const outcome = await runGit(['status'], {
        cwd: dir,
        // fakeBinDir first so `git` resolves to our sleeping stub, but the rest of PATH stays so
        // the stub's own `sleep`/`touch` calls resolve normally inside its shell.
        env: {PATH: `${fakeBinDir}:${process.env.PATH ?? '/usr/bin:/bin'}`},
        timeoutMs: 150,
      })

      // #then
      expect(outcome).toEqual({kind: 'timeout'})
      // The fake binary's `sleep 5` must have been interrupted before it could `touch` the
      // marker — proves the subprocess was actually killed, not merely abandoned.
      expect(() => statSync(markerPath)).toThrow()
    } finally {
      rmSync(fakeBinDir, {recursive: true, force: true})
    }
  })
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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

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
// Read-only invariant: the index is never modified.
// ---------------------------------------------------------------------------

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
    const beforeBytes = readFileSync(indexPath)
    const beforeMtime = statSync(indexPath).mtimeMs

    // #when
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

    // #then
    expect(result.response.ok).toBe(true)
    const afterBytes = readFileSync(indexPath)
    const afterMtime = statSync(indexPath).mtimeMs
    expect(afterBytes.equals(beforeBytes)).toBe(true)
    expect(afterMtime).toBe(beforeMtime)
  })

  it('induced failure: a raw `git status` (no --no-optional-locks) DOES rewrite the index', async () => {
    // #given — same stat-mismatch setup.
    const {dir} = await makeCheckoutDir()
    initRepo(dir)
    commitFile(dir, 'a.txt', 'base\n', 'initial commit')
    const future = new Date(Date.now() + 60_000)
    utimesSync(join(dir, 'a.txt'), future, future)

    const indexPath = join(dir, '.git', 'index')
    const beforeBytes = readFileSync(indexPath)
    const beforeMtime = statSync(indexPath).mtimeMs

    // #when — raw git status, no --no-optional-locks.
    execFileSync('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'], {env: GIT_ENV, encoding: 'utf8'})

    // #then — the index changed (mtime or bytes), proving --no-optional-locks is the meaningful
    // protection dropped in the "protected" test above.
    const afterBytes = readFileSync(indexPath)
    const afterMtime = statSync(indexPath).mtimeMs
    const changed = afterMtime !== beforeMtime || !afterBytes.equals(beforeBytes)
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
    const result = await inspectCheckout(req(owner, repo), {reposRoot})

    // #then
    expect(result.response.ok).toBe(true)
  })
})
