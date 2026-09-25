/**
 * Tests for update.ts (slice 2a: the network-free admission half) — exercised against REAL git
 * repositories in temp directories, exactly like checkout-profile.test.ts and
 * update-fixtures/*.test.ts. No git output is mocked; the only injected seam is `gitRunner`,
 * which every test either omits (falls through to the real, confirmed-termination `runGit`) or
 * wraps with a recording spy that still calls straight through to real git.
 */

import type {GitRunnerFn} from './git-safety.js'
import type {LoopbackListener} from './update-fixtures/helpers.js'
import type {UpdateHandlerDeps, UpdateRequest} from './update.js'

import {mkdir, rename, rm, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {buildCloneGitEnv} from './clone.js'
import {runGit} from './git-safety.js'
import {JOURNAL_DIR_NAME, WORKSPACE_STATE_DIR_NAME} from './identity.js'
import {readJournal, writeJournal} from './journal.js'
import {resetRepoLocksForTesting} from './repo-mutex.js'
import {bareRepoPath, startGitHttpServer, writeLoopbackAskpassHelper} from './update-fixtures/git-http-server.js'
import {
  commitFile,
  gitAsync,
  gitSync,
  initRepo,
  isolatedGitEnv,
  makeTempDir,
  opensslAvailable,
  startLoopbackListener,
} from './update-fixtures/helpers.js'
import {executeUpdate} from './update.js'

const OWNER = 'acme'
const REPO = 'widgets'
const OPENSSL_AVAILABLE = opensslAvailable()

let reposRoot: string
let checkoutHome: string
let remoteListener: LoopbackListener

beforeAll(async () => {
  remoteListener = await startLoopbackListener()
})

beforeEach(async () => {
  reposRoot = await makeTempDir('update-test-repos-')
  checkoutHome = await makeTempDir('update-test-checkout-home-')
  resetRepoLocksForTesting()
})

afterEach(async () => {
  await rm(reposRoot, {recursive: true, force: true})
  await rm(checkoutHome, {recursive: true, force: true})
})

afterAll(async () => {
  await remoteListener.close()
})

function destPathFor(owner = OWNER, repo = REPO): string {
  return join(reposRoot, owner, repo)
}

function journalsDirFor(): string {
  return join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
}

function req(owner = OWNER, repo = REPO): UpdateRequest {
  return {owner, repo, token: 'test-token'}
}

/**
 * Deps every test uses: the CURRENT process's own uid/gid (this host can't setuid(2) to
 * AGENT_UID/AGENT_GID), exactly mirroring inspect.test.ts's/checkout-profile.test.ts's own
 * `localDeps` pattern. `remoteBaseUrl` points at the shared loopback listener so any future
 * accidental network contact (this slice, or a regression in slice 2b) would show up as a
 * non-empty `remoteListener.requests`.
 */
function localDeps(overrides: UpdateHandlerDeps = {}): UpdateHandlerDeps {
  return {
    reposRoot,
    options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
    remoteBaseUrl: `http://127.0.0.1:${remoteListener.port}`,
    ...overrides,
  }
}

/**
 * Wraps the real `runGit` so a test can assert on every invocation's arg vector — the "network
 * profile never spawned" seam. `buildNetworkGitProfile` (git-safety.ts) always opens its arg
 * vector with `--git-dir <bareRepoPath>`; no purely local admission invocation this module makes
 * ever includes that flag.
 */
function makeGitRunnerSpy(): {readonly runner: GitRunnerFn; readonly calls: (readonly string[])[]} {
  const calls: (readonly string[])[] = []
  const runner: GitRunnerFn = async (args, options) => {
    calls.push(args)
    return runGit(args, options)
  }
  return {runner, calls}
}

function expectNoNetworkContact(calls: readonly (readonly string[])[]): void {
  expect(calls.some(args => args.includes('--git-dir'))).toBe(false)
  expect(remoteListener.requests.length).toBe(0)
}

/**
 * Creates an eligible checkout: a real `git clone` of a freshly committed local repo. Unit 2's
 * policy-profile.test.ts proves a local clone and an HTTPS clone produce identical `.git/config`
 * KEY sets (only values differ), so this is a faithful, much cheaper stand-in for the other
 * refusal-reason tests below — the dedicated "fail-closed-against-default" test at the end of this
 * file uses the real HTTPS fixture server instead, per the plan's own emphasis on that scenario.
 */
async function setupEligibleCheckout(owner = OWNER, repo = REPO): Promise<{readonly headSha: string}> {
  const sourceDir = await makeTempDir('update-test-source-')
  const sourceHome = await makeTempDir('update-test-source-home-')
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

describe('executeUpdate — journal reconciliation', () => {
  it('refuses needs-recovery when the journal is at phase "applying" — no network profile, no remote contact', async () => {
    // #given an eligible checkout with an `applying` journal left behind by a crashed mutation
    await setupEligibleCheckout()
    await writeJournal(journalsDirFor(), {
      kind: 'update',
      owner: OWNER,
      repo: REPO,
      phase: 'applying',
      fromSha: '0'.repeat(40),
      toSha: '1'.repeat(40),
      startedAt: new Date().toISOString(),
    })
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await executeUpdate(req(), localDeps({gitRunner: runner}))

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'needs-recovery'})
    expectNoNetworkContact(calls)
  })

  it('clears a "fetched" journal and continues admission (the checkout was untouched at H)', async () => {
    // #given an eligible checkout with a `fetched` journal left behind before any mutation began
    await setupEligibleCheckout()
    await writeJournal(journalsDirFor(), {
      kind: 'update',
      owner: OWNER,
      repo: REPO,
      phase: 'fetched',
      fromSha: '0'.repeat(40),
      toSha: '1'.repeat(40),
      startedAt: new Date().toISOString(),
    })

    // #when
    const result = await executeUpdate(req(), localDeps())

    // #then — admission continued past the journal (this eligible checkout reaches the
    // not-implemented network-half stub), and the journal was cleared.
    expect(result).toEqual({kind: 'failed', reason: 'not-implemented', mutationStarted: false, permanent: false})
    expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: false, reason: 'absent'})
  })

  it('reconciles an "applied" journal whose HEAD already matches the target SHA to `ready`, and clears it', async () => {
    // #given a checkout whose merge actually completed (HEAD already at toSha) before the crash
    const {headSha} = await setupEligibleCheckout()
    await writeJournal(journalsDirFor(), {
      kind: 'update',
      owner: OWNER,
      repo: REPO,
      phase: 'applied',
      fromSha: '0'.repeat(40),
      toSha: headSha,
      startedAt: new Date().toISOString(),
    })

    // #when
    const result = await executeUpdate(req(), localDeps())

    // #then
    expect(result).toEqual({
      kind: 'ready',
      change: 'fast-forward',
      branch: 'main',
      sha: headSha,
      fromSha: '0'.repeat(40),
      checkedAt: expect.any(String) as string,
    })
    expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: false, reason: 'absent'})
  })

  it('refuses needs-recovery when the journal file is malformed — never treated as absent', async () => {
    // #given an eligible checkout with a journal file that fails to parse
    await setupEligibleCheckout()
    await mkdir(journalsDirFor(), {recursive: true, mode: 0o700})
    await writeFile(join(journalsDirFor(), `${OWNER}__${REPO}.json`), '{not valid json')
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await executeUpdate(req(), localDeps({gitRunner: runner}))

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'needs-recovery'})
    expectNoNetworkContact(calls)
  })
})

describe('executeUpdate — canonical-path containment', () => {
  it('reports no-checkout when nothing exists at the repository path and no journal is in flight', async () => {
    // #given — no checkout, no journal
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await executeUpdate(req(), localDeps({gitRunner: runner}))

    // #then
    expect(result).toEqual({kind: 'no-checkout'})
    expectNoNetworkContact(calls)
  })

  it('refuses checkout-substituted when the repo path resolves to a DIFFERENT checkout via a symlink', async () => {
    // #given a real, separate checkout elsewhere under reposRoot, and destPath symlinked to it —
    // mirrors inspect.test.ts's own "repo directory symlinked to a different repo" scenario.
    await setupEligibleCheckout('other-owner', 'other-repo')
    await mkdir(join(reposRoot, OWNER), {recursive: true})
    await symlink(destPathFor('other-owner', 'other-repo'), destPathFor())
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await executeUpdate(req(), localDeps({gitRunner: runner}))

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'checkout-substituted'})
    expectNoNetworkContact(calls)
  })
})

describe('executeUpdate — layout and config admission', () => {
  it('refuses unsupported-layout when .git is a symlink resolving WITHIN the checkout (real git, real symlink)', async () => {
    // #given an eligible checkout whose `.git` is relocated to a sibling name inside the SAME
    // checkout directory and replaced with a symlink back to it. The symlink target still
    // resolves inside the checkout, so canonical-path containment (step 2, reused from
    // inspect.ts) passes and admission reaches checkCheckoutLayout's own symlink check (step 3) —
    // a target resolving OUTSIDE the checkout would instead be caught earlier as
    // checkout-substituted, a distinct scenario already covered above.
    await setupEligibleCheckout()
    const dest = destPathFor()
    const realGitDir = join(dest, '.git-real')
    await rename(join(dest, '.git'), realGitDir)
    await symlink(realGitDir, join(dest, '.git'))
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await executeUpdate(req(), localDeps({gitRunner: runner}))

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'unsupported-layout', layoutReason: 'symlinked-git-dir'})
    expectNoNetworkContact(calls)
  })

  it('refuses unsupported-config, naming the disallowed key, for a config value outside the closed allowlist', async () => {
    // #given an eligible checkout with a planted `http.proxy` — not on checkout-profile.ts's
    // closed allowlist of ordinary-fresh-clone keys
    await setupEligibleCheckout()
    gitSync(destPathFor(), ['config', 'http.proxy', 'http://127.0.0.1:1'], isolatedGitEnv(checkoutHome))
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await executeUpdate(req(), localDeps({gitRunner: runner}))

    // #then
    expect(result.kind).toBe('refused')
    expect(result.kind === 'refused' && result.reason === 'unsupported-config' ? result.disallowedKeys : []).toContain(
      'http.proxy',
    )
    expectNoNetworkContact(calls)
  })
})

describe('executeUpdate — operation state, cleanliness, submodules', () => {
  it('refuses operation-in-progress when a MERGE_HEAD marks an in-progress merge', async () => {
    // #given an eligible checkout with a MERGE_HEAD left behind, exactly as inspect.ts's own
    // detection expects (presence of the state file, never parsed output)
    await setupEligibleCheckout()
    await writeFile(join(destPathFor(), '.git', 'MERGE_HEAD'), `${'a'.repeat(40)}\n`)
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await executeUpdate(req(), localDeps({gitRunner: runner}))

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'operation-in-progress', operation: 'merge'})
    expectNoNetworkContact(calls)
  })

  it('refuses dirty, with a bounded sample of changed paths, for a tracked-file edit against a fresh temp index built from HEAD', async () => {
    // #given an eligible checkout with a real, uncommitted edit to a tracked file
    await setupEligibleCheckout()
    await writeFile(join(destPathFor(), 'README.md'), 'tampered\n')
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await executeUpdate(req(), localDeps({gitRunner: runner}))

    // #then
    expect(result.kind).toBe('refused')
    expect(result.kind === 'refused' && result.reason === 'dirty' ? result.changedPaths : []).toContain('README.md')
    expectNoNetworkContact(calls)
  })

  it('refuses submodule-initialized for a submodule the agent itself initialized in the checkout', async () => {
    // #given a repo with a submodule reference that is cloned WITHOUT initializing it (matching
    // clone.ts, which never passes --recurse-submodules), then explicitly initialized inside the
    // checkout — the exact "agent ran submodule update --init during a task" scenario this
    // refusal exists for.
    const subRepoDir = await makeTempDir('update-test-subrepo-')
    const subRepoHome = await makeTempDir('update-test-subrepo-home-')
    initRepo(subRepoDir, isolatedGitEnv(subRepoHome), 'main')
    commitFile(subRepoDir, isolatedGitEnv(subRepoHome), 's.txt', 's', 'sub commit')

    const sourceDir = await makeTempDir('update-test-source-')
    const sourceHome = await makeTempDir('update-test-source-home-')
    initRepo(sourceDir, isolatedGitEnv(sourceHome), 'main')
    commitFile(sourceDir, isolatedGitEnv(sourceHome), 'README.md', 'hello\n', 'initial commit')
    gitSync(
      sourceDir,
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', subRepoDir, 'subdir'],
      isolatedGitEnv(sourceHome),
    )
    gitSync(sourceDir, ['commit', '-q', '-m', 'add submodule'], isolatedGitEnv(sourceHome))

    await mkdir(join(reposRoot, OWNER), {recursive: true})
    gitSync(reposRoot, ['clone', '-q', sourceDir, destPathFor()], isolatedGitEnv(checkoutHome))
    gitSync(
      destPathFor(),
      ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'],
      isolatedGitEnv(checkoutHome),
    )
    await rm(subRepoDir, {recursive: true, force: true})
    await rm(subRepoHome, {recursive: true, force: true})
    await rm(sourceDir, {recursive: true, force: true})
    await rm(sourceHome, {recursive: true, force: true})
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await executeUpdate(req(), localDeps({gitRunner: runner}))

    // #then
    expect(result).toEqual({kind: 'refused', reason: 'submodule-initialized', submodules: ['subdir']})
    expectNoNetworkContact(calls)
  })
})

describe('executeUpdate — client abort', () => {
  it('stops before the network/apply half when the signal is already aborted, without spawning the network profile', async () => {
    // #given an otherwise fully eligible checkout, and a signal aborted before the call
    await setupEligibleCheckout()
    const controller = new AbortController()
    controller.abort()
    const {runner, calls} = makeGitRunnerSpy()

    // #when
    const result = await executeUpdate(req(), localDeps({gitRunner: runner, signal: controller.signal}))

    // #then — distinct from `not-implemented`: admission passed in full, but the abort was
    // honored before the network/apply half was ever reached.
    expect(result).toEqual({kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false})
    expectNoNetworkContact(calls)
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — fail-closed-against-default (real /clone-shaped checkout)', () => {
  it('a checkout made the way /clone makes it (real git clone from the local HTTPS server) passes every admission step and reaches the network half', async () => {
    // #given a bare "remote" repo served over real HTTPS by the Unit 2/slice-1 git-http-server
    // fixture, populated with one commit, and a checkout produced by a REAL `git clone` against
    // that server — the same askpass/env shape clone.ts's own writeAskpassHelper/buildCloneGitEnv
    // produce, swapped only for the loopback host (see git-http-server.ts's own doc comment on
    // why a second, host-parameterized askpass helper is test-only and safe here).
    const fixtureReposRoot = await makeTempDir('update-test-fixture-repos-')
    const fetchWorkDir = await makeTempDir('update-test-fixture-work-')
    const fetchWorkHome = await makeTempDir('update-test-fixture-work-home-')
    const askpassDir = await makeTempDir('update-test-fixture-askpass-')

    const remotePath = await bareRepoPath(fixtureReposRoot, OWNER, REPO)
    gitSync(fixtureReposRoot, ['init', '-q', '--bare', '-b', 'main', remotePath], isolatedGitEnv(fetchWorkHome))
    initRepo(fetchWorkDir, isolatedGitEnv(fetchWorkHome), 'main')
    commitFile(fetchWorkDir, isolatedGitEnv(fetchWorkHome), 'README.md', 'hello\n', 'initial commit')
    gitSync(fetchWorkDir, ['push', '-q', remotePath, 'main'], isolatedGitEnv(fetchWorkHome))

    const server = await startGitHttpServer({reposRoot: fixtureReposRoot})
    try {
      const host = new URL(server.baseUrl).host
      const askpassPath = await writeLoopbackAskpassHelper(askpassDir, host)
      const cloneEnv = {
        ...buildCloneGitEnv('test-token', askpassPath, isolatedGitEnv(checkoutHome)),
        GIT_SSL_CAINFO: server.caBundlePath,
      }
      await mkdir(join(reposRoot, OWNER), {recursive: true})
      // gitAsync, NOT gitSync: the fixture server runs IN this same process/event loop, and a
      // synchronous `execFileSync` blocks that event loop for the whole call, starving the
      // server of the very loop it needs to accept the connection and answer the TLS handshake —
      // exactly why every OTHER real-network call in this fixture family (git-http-server.test.ts)
      // uses the async form for calls that actually hit the server, and `gitSync` only for local,
      // no-network setup.
      const clone = await gitAsync(
        reposRoot,
        ['clone', '-q', `${server.baseUrl}/${OWNER}/${REPO}.git`, destPathFor()],
        cloneEnv,
      )
      expect(clone.ok, `clone failed: ${clone.stderr}`).toBe(true)

      // #when
      const result = await executeUpdate(req(), localDeps())

      // #then — every admission step passed; the network/apply half (slice 2b) is the only thing
      // stopping this from being `ready`.
      expect(result).toEqual({kind: 'failed', reason: 'not-implemented', mutationStarted: false, permanent: false})
    } finally {
      await server.close()
      await rm(fixtureReposRoot, {recursive: true, force: true})
      await rm(fetchWorkDir, {recursive: true, force: true})
      await rm(fetchWorkHome, {recursive: true, force: true})
      await rm(askpassDir, {recursive: true, force: true})
    }
  })
})
