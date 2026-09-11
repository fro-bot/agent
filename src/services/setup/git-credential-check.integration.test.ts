import type {Result} from '../../shared/types.js'
import type {ExecAdapter, ExecOptions} from './types.js'

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {afterEach, beforeAll, describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {createExecAdapter} from './adapters.js'
import {assertNoPersistedGitCredentials} from './git-credential-check.js'

/**
 * Real-`git` fixtures for the effective-config preflight. Every fixture is a fresh temp
 * directory; nothing here ever reads or writes host git config, host credentials, or performs
 * network access. Only fake, synthetic credential values are used.
 *
 * Reason strings below are intentionally re-typed (not imported) from the production error
 * constants — these tests must fail if the production wording drifts, not silently track it.
 */

const HEADER_FOUND_REASON = 'found in the effective git config'
const ORIGIN_EMBEDDED_REASON = 'embedded in the origin remote URL'
const CONFIG_VERIFICATION_REASON = 'Git config verification could not complete'
const REPO_CONTEXT_VERIFICATION_REASON = 'Git repository context verification could not complete'

/** Deep-equality assertion: fails loudly (not silently) if `result.success` is unexpectedly `true`. */
function expectDenied(result: Result<void, string>, reasonSubstring: string): void {
  expect(result).toEqual({success: false, error: expect.stringContaining(reasonSubstring) as string})
}

const tempDirs: string[] = []

/** Real `git --version`, captured once for failure-message context only — never asserted on. */
let gitVersionForDiagnostics = 'unknown'

beforeAll(async () => {
  const result = await createExecAdapter().getExecOutput('git', ['--version'], {ignoreReturnCode: true, silent: true})
  if (result.exitCode === 0) gitVersionForDiagnostics = result.stdout.trim()
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async dir => fs.rm(dir, {recursive: true, force: true})))
})

/**
 * Canonicalized ceiling for `GIT_CEILING_DIRECTORIES`: the real OS temp root, computed once. Every
 * fixture directory lives under this, so setting it stops `rev-parse` discovery from walking
 * above the ephemeral fixture tree into an unrelated ancestor repository (e.g. this session's own
 * checkout, were the OS temp root ever nested under one) — the genuinely-non-repository fixture
 * must fail because it IS a non-repository, not because discovery happened to stop early or late
 * for an unrelated reason.
 */
const CEILING_DIR = await fs.realpath(os.tmpdir())

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  // macOS `mktemp`/`os.tmpdir()` can return a `/tmp/...` path that is itself a symlink to
  // `/private/tmp/...` — canonicalize via `realpath` so fixture paths and Git's own
  // self-reported (already-canonical) `.git` dir path always agree. A mismatch here would
  // silently make `includeIf.gitdir` fixtures never match, invalidating the fixture rather than
  // the code under test.
  const real = await fs.realpath(dir)
  tempDirs.push(dir)
  return real
}

async function run(cmd: string, args: string[], cwd: string, env: Record<string, string>): Promise<void> {
  const adapter = createExecAdapter()
  const result = await adapter.getExecOutput(cmd, args, {cwd, env, ignoreReturnCode: true, silent: true})
  if (result.exitCode !== 0) {
    throw new Error(
      `fixture setup failed (git: ${gitVersionForDiagnostics}): ${cmd} ${args.join(' ')} ` +
        `(exit ${result.exitCode}): ${result.stderr}`,
    )
  }
}

/**
 * Isolated child environment for fixture setup and for the adapter under test: a benign PATH (so
 * the real `git` binary still resolves), a private HOME/XDG_CONFIG_HOME, no inherited GIT_* or
 * credential-shaped variables, and a `GIT_CEILING_DIRECTORIES` bound to the real OS temp root so
 * discovery can never cross above it. `GIT_CONFIG_NOSYSTEM` blocks the real `/etc/gitconfig`.
 */
function isolatedEnv(homeDir: string, xdgDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: homeDir,
    XDG_CONFIG_HOME: xdgDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: CEILING_DIR,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    ...extra,
  }
}

/**
 * Wraps the production exec adapter so every real-git call runs against the isolated fixture
 * environment, regardless of what the production code under test passes as `options.env`.
 * Deliberately does NOT merge `options.env` wholesale — that would leak the production repo-probe
 * stage's `{...process.env, LC_ALL: 'C'}` spread (built from the *test process's* real
 * environment) straight back into the child. Only the one key the production code actually needs
 * conveyed (`LC_ALL`) is carried over; everything else comes from the fixed fixture env.
 */
function createIsolatedRealGitAdapter(fixedEnv: Record<string, string>): ExecAdapter {
  const real = createExecAdapter()
  return {
    exec: real.exec,
    getExecOutput: async (cmd: string, args?: string[], options?: ExecOptions) => {
      const env: Record<string, string> = {...fixedEnv}
      if (options?.env?.LC_ALL !== undefined) env.LC_ALL = options.env.LC_ALL
      return real.getExecOutput(cmd, args, {...options, env})
    },
  }
}

async function initRepo(env: Record<string, string>, options: {bare?: boolean} = {}): Promise<string> {
  const parent = await mkTempDir('git-cred-check-repo-')
  const repoDir = options.bare === true ? path.join(parent, 'repo.git') : path.join(parent, 'repo')
  await fs.mkdir(repoDir, {recursive: true})
  await run('git', options.bare === true ? ['init', '-q', '--bare'] : ['init', '-q'], repoDir, env)
  return repoDir
}

describe('assertNoPersistedGitCredentials (real git)', () => {
  it('denies a clean repo whose origin carries a synthetic credential (control case), for the origin reason', async () => {
    // #given
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)
    await run(
      'git',
      ['remote', 'add', 'origin', 'https://x-access-token:faketoken@github.test/owner/repo.git'],
      repoDir,
      env,
    )

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then
    expectDenied(result, ORIGIN_EMBEDDED_REASON)
  })

  it('allows a clean repo with a credential-free origin', async () => {
    // #given
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)
    await run('git', ['remote', 'add', 'origin', 'https://github.test/owner/repo.git'], repoDir, env)

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then
    expect(result.success).toBe(true)
  })

  it('allows a valid repository with no origin remote configured', async () => {
    // #given
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then
    expect(result.success).toBe(true)
  })

  it('denies a direct local http.<url>.extraheader header (baseline the old code already caught)', async () => {
    // #given
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)
    await run(
      'git',
      ['config', '--local', 'http.https://github.test/.extraheader', 'AUTHORIZATION: basic ZmFrZQ=='],
      repoDir,
      env,
    )

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then
    expectDenied(result, HEADER_FOUND_REASON)
  })

  it('denies a bare KEY (no URL subsection) http.extraheader — MISSED by the old regex even under --includes (regex vector, not scope)', async () => {
    // #given a normal (non-bare-repo) repo with `http.extraheader` set directly (no `.<url>.` segment)
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)
    await run('git', ['config', '--local', 'http.extraheader', 'AUTHORIZATION: basic ZmFrZQ=='], repoDir, env)

    // #expect: the OLD regex (`^http\..*\.extraheader$`, requires a URL subsection), even run
    // unscoped with `--includes`, still misses a bare `http.extraheader` key. This isolates the
    // regex bug from the `--local` scope bug proven by the includeIf/worktree tests below — fixing
    // scope alone would not have caught this.
    const oldRegexAdapter = createIsolatedRealGitAdapter(env)
    const oldRegexCheck = await oldRegexAdapter.getExecOutput(
      'git',
      ['config', '--includes', '--get-regexp', String.raw`^http\..*\.extraheader$`],
      {cwd: repoDir, ignoreReturnCode: true, silent: true},
    )
    expect(oldRegexCheck.exitCode).toBe(1)

    // #when the new regex (`^http\.(.*\.)?extraheader$`, subsection optional) runs
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then denies for the header-found reason, and never reflects the fake header value
    expectDenied(result, HEADER_FOUND_REASON)
    expect(result.success === false && result.error).not.toContain('ZmFrZQ==')
    expect(result.success === false && result.error).not.toContain('AUTHORIZATION')
  })

  it('denies a header injected via includeIf.gitdir — MISSED by config --local (checkout v6 vector)', async () => {
    // #given a repo whose local config includes an external file scoped by an exact gitdir match
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)
    const includeDir = await mkTempDir('git-cred-check-include-')
    const includeFile = path.join(includeDir, 'creds.gitconfig')
    await fs.writeFile(
      includeFile,
      '[http "https://github.test/"]\n\textraheader = AUTHORIZATION: basic aW5jbHVkZQ==\n',
    )
    const absoluteGitDir = path.join(repoDir, '.git')
    await fs.appendFile(
      path.join(repoDir, '.git', 'config'),
      `\n[includeIf "gitdir:${absoluteGitDir}"]\n\tpath = ${includeFile}\n`,
    )

    // #expect: the OLD `--local` query misses this entirely (proves the vector, not the fix)
    const oldStyleAdapter = createIsolatedRealGitAdapter(env)
    const oldStyleCheck = await oldStyleAdapter.getExecOutput(
      'git',
      ['config', '--local', '--get-regexp', String.raw`^http\..*\.extraheader$`],
      {cwd: repoDir, ignoreReturnCode: true, silent: true},
    )
    expect(oldStyleCheck.exitCode).toBe(1)

    // #when the new unscoped `--includes` check runs
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then
    expectDenied(result, HEADER_FOUND_REASON)
  })

  it('allows a matched includeIf condition whose target file is absent — Git treats a missing include as nothing to include, not an error', async () => {
    // #given a repo whose includeIf condition matches but the `path` target does not exist on disk
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)
    const includeDir = await mkTempDir('git-cred-check-include-')
    const missingIncludeFile = path.join(includeDir, 'does-not-exist.gitconfig')
    const absoluteGitDir = path.join(repoDir, '.git')
    await fs.appendFile(
      path.join(repoDir, '.git', 'config'),
      `\n[includeIf "gitdir:${absoluteGitDir}"]\n\tpath = ${missingIncludeFile}\n`,
    )

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then a matched-but-absent include is not the same failure mode as a matched-but-malformed
    // one (asserted separately below) — Git silently has nothing to include, so this allows
    expect(result.success).toBe(true)
  })

  it('denies a worktree-scoped header — MISSED by config --local (worktree-scope vector)', async () => {
    // #given a repo with extensions.worktreeConfig and a header set only in the worktree config
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)
    await run('git', ['config', 'extensions.worktreeConfig', 'true'], repoDir, env)
    await run(
      'git',
      ['config', '--worktree', 'http.https://github.test/.extraheader', 'AUTHORIZATION: basic d29ya3RyZWU='],
      repoDir,
      env,
    )

    // #expect: the OLD `--local` query misses worktree-scoped config
    const oldStyleAdapter = createIsolatedRealGitAdapter(env)
    const oldStyleCheck = await oldStyleAdapter.getExecOutput(
      'git',
      ['config', '--local', '--get-regexp', String.raw`^http\..*\.extraheader$`],
      {cwd: repoDir, ignoreReturnCode: true, silent: true},
    )
    expect(oldStyleCheck.exitCode).toBe(1)

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then
    expectDenied(result, HEADER_FOUND_REASON)
  })

  it('denies a bare repository with a header — MISSED by a workspace/.git existence check (bare vector)', async () => {
    // #given a bare repo (no working tree, no `<repo>/.git` path) with a direct header
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env, {bare: true})
    await run('git', ['config', 'http.https://github.test/.extraheader', 'AUTHORIZATION: basic YmFyZQ=='], repoDir, env)

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then
    expectDenied(result, HEADER_FOUND_REASON)
  })

  it('denies a bare repository with a credentialed origin, for the origin reason specifically (proves stage 1 passed, bare is not mistaken for a stage-1 failure)', async () => {
    // #given a bare repo with NO header — only the credentialed origin
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env, {bare: true})
    await run(
      'git',
      ['remote', 'add', 'origin', 'https://x-access-token:faketoken@github.test/owner/repo.git'],
      repoDir,
      env,
    )

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then the deny must be the origin-embedded reason — if it were misfiring at stage 1 (config)
    // or stage 2 (repo-context) for bare repos in general, this would show a different reason
    expectDenied(result, ORIGIN_EMBEDDED_REASON)
  })

  it('denies a synthetic global-scope header (GIT_CONFIG_GLOBAL override, no real host config touched)', async () => {
    // #given
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const globalDir = await mkTempDir('git-cred-check-global-')
    const globalConfig = path.join(globalDir, 'global.gitconfig')
    await fs.writeFile(globalConfig, '[http "https://github.test/"]\n\textraheader = AUTHORIZATION: basic Z2xvYmFs\n')
    const env = isolatedEnv(homeDir, xdgDir, {GIT_CONFIG_GLOBAL: globalConfig})
    const repoDir = await initRepo(env)

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then
    expectDenied(result, HEADER_FOUND_REASON)
  })

  it('denies a synthetic system-scope header (GIT_CONFIG_SYSTEM override, never real /etc/gitconfig)', async () => {
    // #given
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const systemDir = await mkTempDir('git-cred-check-system-')
    const systemConfig = path.join(systemDir, 'system.gitconfig')
    await fs.writeFile(systemConfig, '[http "https://github.test/"]\n\textraheader = AUTHORIZATION: basic c3lzdGVt\n')
    const env = isolatedEnv(homeDir, xdgDir, {GIT_CONFIG_SYSTEM: systemConfig, GIT_CONFIG_NOSYSTEM: '0'})
    const repoDir = await initRepo(env)

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then
    expectDenied(result, HEADER_FOUND_REASON)
  })

  it('allows a genuinely non-repository workspace, with a warning', async () => {
    // #given a plain empty directory, never initialized as a repo, under the same ceiling as
    // every other fixture so discovery cannot accidentally climb into an ancestor repo
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const nonRepoDir = await mkTempDir('git-cred-check-nonrepo-')
    const logger = createMockLogger()

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), nonRepoDir, logger)

    // #then
    expect(result.success).toBe(true)
    expect(logger.warning).toHaveBeenCalled()
  })

  it('denies a malformed local config (parse error, not proof of absence)', async () => {
    // #given
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)
    await fs.appendFile(path.join(repoDir, '.git', 'config'), '[bad\n')

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then a verification failure is not misdiagnosed as a found credential
    expectDenied(result, CONFIG_VERIFICATION_REASON)
    expect(result.success === false && result.error).not.toContain('persist-credentials: false')
  })

  it('denies a matched but malformed includeIf target file (parse error inside the include)', async () => {
    // #given
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)
    const includeDir = await mkTempDir('git-cred-check-include-')
    const includeFile = path.join(includeDir, 'broken.gitconfig')
    await fs.writeFile(includeFile, '[bad\n')
    const absoluteGitDir = path.join(repoDir, '.git')
    await fs.appendFile(
      path.join(repoDir, '.git', 'config'),
      `\n[includeIf "gitdir:${absoluteGitDir}"]\n\tpath = ${includeFile}\n`,
    )

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), repoDir, createMockLogger())

    // #then a verification failure is not misdiagnosed as a found credential
    expectDenied(result, CONFIG_VERIFICATION_REASON)
    expect(result.success === false && result.error).not.toContain('persist-credentials: false')
  })

  it('denies a repository subdirectory with a header, for the header reason (proves discovery is not a naive workspace/.git check)', async () => {
    // #given a nested subdirectory of a real repo carrying a header
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)
    await run(
      'git',
      ['config', '--local', 'http.https://github.test/.extraheader', 'AUTHORIZATION: basic c3ViZGly'],
      repoDir,
      env,
    )
    const subDir = path.join(repoDir, 'nested', 'dir')
    await fs.mkdir(subDir, {recursive: true})

    // #when checked from the subdirectory (auto-discovery walks up to the repo root)
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), subDir, createMockLogger())

    // #then the header reason, proving discovery found the header and did not stop early/late
    expectDenied(result, HEADER_FOUND_REASON)
  })

  it('denies a repository subdirectory with only a credentialed origin, for the origin reason', async () => {
    // #given a nested subdirectory of a real repo with no header, only a credentialed origin
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const repoDir = await initRepo(env)
    await run(
      'git',
      ['remote', 'add', 'origin', 'https://x-access-token:faketoken@github.test/owner/repo.git'],
      repoDir,
      env,
    )
    const subDir = path.join(repoDir, 'nested', 'dir')
    await fs.mkdir(subDir, {recursive: true})

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), subDir, createMockLogger())

    // #then
    expectDenied(result, ORIGIN_EMBEDDED_REASON)
  })

  it('denies an invalid GIT_DIR at the repo-context stage — a real failure distinct from "no repository"', async () => {
    // #given: empirically, `git config --get-regexp` against a nonexistent GIT_DIR/config exits 1
    // (no matches — a missing local config file is not a parse error), so stage 1 passes cleanly
    // and the deny must come from stage 2 (`rev-parse`), not stage 1. Proven here, not assumed.
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const nonexistentGitDir = path.join(await mkTempDir('git-cred-check-invalid-'), 'nonexistent', '.git')
    const env = isolatedEnv(homeDir, xdgDir, {GIT_DIR: nonexistentGitDir})
    const workDir = await mkTempDir('git-cred-check-work-')

    const configStageCheck = await createIsolatedRealGitAdapter(env).getExecOutput(
      'git',
      ['config', '--includes', '--name-only', '--get-regexp', String.raw`^http\.(.*\.)?extraheader$`],
      {cwd: workDir, ignoreReturnCode: true, silent: true},
    )
    expect(configStageCheck.exitCode).toBe(1)
    expect(configStageCheck.stdout.trim()).toBe('')

    // #when
    const result = await assertNoPersistedGitCredentials(createIsolatedRealGitAdapter(env), workDir, createMockLogger())

    // #then fail closed at the repo-context stage specifically — this is a real error, not the
    // canonical "not a git repository" exception, and never misdiagnosed as a found credential
    expectDenied(result, REPO_CONTEXT_VERIFICATION_REASON)
    expect(result.success === false && result.error).not.toContain('persist-credentials: false')
  })

  it('allows a clean parent repo with an unrelated header-carrying child repo nested inside it (documents the non-recursive bound)', async () => {
    // #given a clean parent repo, and a fully independent nested child repo (its own `.git`) with
    // a header — nested/submodule-style discovery is explicitly out of scope for this check
    const homeDir = await mkTempDir('git-cred-check-home-')
    const xdgDir = await mkTempDir('git-cred-check-xdg-')
    const env = isolatedEnv(homeDir, xdgDir)
    const parentRepoDir = await initRepo(env)
    const childRepoDir = path.join(parentRepoDir, 'nested', 'child')
    await fs.mkdir(childRepoDir, {recursive: true})
    await run('git', ['init', '-q'], childRepoDir, env)
    await run(
      'git',
      ['config', '--local', 'http.https://github.test/.extraheader', 'AUTHORIZATION: basic Y2hpbGQ='],
      childRepoDir,
      env,
    )

    // #when checked independently
    const parentResult = await assertNoPersistedGitCredentials(
      createIsolatedRealGitAdapter(env),
      parentRepoDir,
      createMockLogger(),
    )
    const childResult = await assertNoPersistedGitCredentials(
      createIsolatedRealGitAdapter(env),
      childRepoDir,
      createMockLogger(),
    )

    // #then the parent check never descends into the nested child repo's config; the child check,
    // run against its own workspace, independently finds its own header
    expect(parentResult.success).toBe(true)
    expectDenied(childResult, HEADER_FOUND_REASON)
  })
})
