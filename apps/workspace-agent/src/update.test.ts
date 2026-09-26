/**
 * Tests for update.ts (slice 2a: the network-free admission half) — exercised against REAL git
 * repositories in temp directories, exactly like checkout-profile.test.ts and
 * update-fixtures/*.test.ts. No git output is mocked; the only injected seam is `gitRunner`,
 * which every test either omits (falls through to the real, confirmed-termination `runGit`) or
 * wraps with a recording spy that still calls straight through to real git.
 */

import type {GitRunnerFn} from './git-safety.js'
import type {UpdateRequest} from './types.js'
import type {LoopbackListener} from './update-fixtures/helpers.js'
import type {JournalReconciliationLogger, UpdateHandlerDeps} from './update.js'

import {chmod, mkdir, rename, rm, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {buildCloneGitEnv} from './clone.js'
import {runGit} from './git-safety.js'
import {runPackStream} from './git-stream.js'
import {JOURNAL_DIR_NAME, WORKSPACE_STATE_DIR_NAME} from './identity.js'
import {readJournal, writeJournal} from './journal.js'
import {
  markRepoHeld,
  repoHoldReason,
  repoMutexKey,
  resetRepoHoldsForTesting,
  resetRepoLocksForTesting,
} from './repo-mutex.js'
import {bareRepoPath, startGitHttpServer, writeLoopbackAskpassHelper} from './update-fixtures/git-http-server.js'
import {
  commitFile,
  gitAsync,
  gitSync,
  initRepo,
  isolatedGitEnv,
  makeTempDir,
  opensslAvailable,
  sentinelFired,
  sentinelPath,
  startLoopbackListener,
} from './update-fixtures/helpers.js'
import {createInvocationTracker, executeUpdate, reconcileUpdateJournalsOnStartup} from './update.js'

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
  resetRepoHoldsForTesting()
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

/** A `JournalReconciliationLogger` that discards every call — for tests that only assert on journal state. */
function silentLogger(): JournalReconciliationLogger {
  return {info: () => {}, warn: () => {}, error: () => {}}
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

describe('createInvocationTracker (review round C, C2)', () => {
  it('sawUnconfirmed() is false until a git dispatch reports termination-unconfirmed, then stays true', async () => {
    const outcomes: GitRunnerFn = async () => ({kind: 'ok', stdout: '', stderr: ''})
    let callCount = 0
    const gitRunner: GitRunnerFn = async (args, options) => {
      callCount += 1
      if (callCount === 2) return {kind: 'termination-unconfirmed'}
      return outcomes(args, options)
    }
    const tracker = createInvocationTracker({gitRunner})

    await tracker.gitRunner([], {cwd: '/', env: {}, timeoutMs: 1000})
    expect(tracker.sawUnconfirmed()).toBe(false)

    await tracker.gitRunner([], {cwd: '/', env: {}, timeoutMs: 1000})
    expect(tracker.sawUnconfirmed()).toBe(true)

    // #and — sticky: a later confirmed 'ok' never clears it.
    await tracker.gitRunner([], {cwd: '/', env: {}, timeoutMs: 1000})
    expect(tracker.sawUnconfirmed()).toBe(true)
  })

  it('sawUnconfirmed() also becomes true (and stays true) from a pack-stream dispatch', async () => {
    const tracker = createInvocationTracker({
      gitRunner: async () => ({kind: 'ok', stdout: '', stderr: ''}),
      packStreamRunner: async () => ({kind: 'termination-unconfirmed'}),
    })
    const options = {
      writer: {command: 'git', args: [], cwd: '/', env: {}},
      reader: {command: 'git', args: [], cwd: '/', env: {}},
      maxBytes: 1,
      timeoutMs: 1000,
    }

    await tracker.packStreamRunner(options)
    expect(tracker.sawUnconfirmed()).toBe(true)
  })

  it("(C3) clamps every dispatch to the ACTIVE deadline's true remaining time — a multi-call helper reusing one stale timeoutMs snapshot cannot exceed the aggregate budget, and nothing spawns once expired", async () => {
    // #given a fake clock advanced by the fake runner itself (simulating each dispatch consuming
    // real wall-clock time) and a 500ms budget
    let now = 0
    const dispatchedTimeouts: number[] = []
    let dispatchCount = 0
    const gitRunner: GitRunnerFn = async (_args, options) => {
      dispatchCount += 1
      dispatchedTimeouts.push(options.timeoutMs)
      now += 300
      return {kind: 'ok', stdout: '', stderr: ''}
    }
    const tracker = createInvocationTracker({gitRunner})
    const deadlineAt = now + 500
    tracker.setDeadline({
      remainingMs: () => Math.max(0, deadlineAt - now),
      expired: () => now >= deadlineAt,
    })

    // #when — a "multi-call helper" that captured ONE remaining-time snapshot up front and reuses
    // it for every one of its own calls: the exact anti-pattern C3 fixes.
    const staleTimeoutMs = 500
    await tracker.gitRunner([], {cwd: '/', env: {}, timeoutMs: staleTimeoutMs})
    await tracker.gitRunner([], {cwd: '/', env: {}, timeoutMs: staleTimeoutMs})
    const third = await tracker.gitRunner([], {cwd: '/', env: {}, timeoutMs: staleTimeoutMs})

    // #then — dispatch 1 clamps to the full 500ms remaining; dispatch 2 clamps BELOW the stale
    // snapshot to the true 200ms remaining; dispatch 3 (600ms elapsed > 500ms budget) never spawns.
    expect(dispatchedTimeouts).toEqual([500, 200])
    expect(dispatchCount).toBe(2)
    expect(third).toEqual({kind: 'timeout'})
  })
})

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
    // #given a real network fixture, a checkout already at the remote's tip, and a `fetched`
    // journal left behind before any mutation began
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
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
      const result = await executeUpdate(req(), networkDeps(fixture))

      // #then — admission continued past the journal (this eligible checkout is fully in sync
      // with the remote), and the journal was cleared.
      expect(result).toEqual({
        kind: 'ready',
        change: 'unchanged',
        branch: 'main',
        sha: fixture.headSha,
        checkedAt: expect.any(String) as string,
      })
      expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: false, reason: 'absent'})
    } finally {
      await fixture.close()
    }
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
      appliedAt: new Date().toISOString(),
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

describe('executeUpdate — ensureBareFetchStore hardening (review round B, B6)', () => {
  // No network fixture needed for any of these — ensureBareFetchStore is the very first thing
  // runNetworkAndApply does, before any real network contact, so a bad fetch-store path always
  // fails before dialing out at all.

  it('refuses fetch-failed when the fetch store path is a symlink (never followed)', async () => {
    await setupEligibleCheckout()
    const fetchDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'fetch')
    await mkdir(fetchDir, {recursive: true})
    const elsewhere = await makeTempDir('update-test-fetchstore-elsewhere-')
    await symlink(elsewhere, join(fetchDir, `${OWNER}__${REPO}.git`))
    try {
      const result = await executeUpdate(req(), localDeps())
      expect(result).toEqual({kind: 'failed', reason: 'fetch-failed', mutationStarted: false, permanent: false})
    } finally {
      await rm(elsewhere, {recursive: true, force: true})
    }
  })

  it('refuses fetch-failed when the fetch store path exists but is a regular file, not a directory', async () => {
    await setupEligibleCheckout()
    const fetchDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'fetch')
    await mkdir(fetchDir, {recursive: true})
    await writeFile(join(fetchDir, `${OWNER}__${REPO}.git`), 'not a bare repo')

    const result = await executeUpdate(req(), localDeps())

    expect(result).toEqual({kind: 'failed', reason: 'fetch-failed', mutationStarted: false, permanent: false})
  })

  it('refuses fetch-failed on a non-ENOENT stat error — a path component is not a directory at all', async () => {
    await setupEligibleCheckout()
    const stateDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME)
    await mkdir(stateDir, {recursive: true})
    // `fetch` itself (the fetch store's PARENT) is a plain file, so lstat on the full nested
    // fetch-store path fails with ENOTDIR — a real non-ENOENT error, never mistaken for absence.
    await writeFile(join(stateDir, 'fetch'), 'blocking file')

    const result = await executeUpdate(req(), localDeps())

    expect(result).toEqual({kind: 'failed', reason: 'fetch-failed', mutationStarted: false, permanent: false})
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — fetch store leaf mode (review round C, C1)', () => {
  it('two consecutive successful /update runs under umask 022 — the store git init creates is never too wide for the second run', async () => {
    const fixture = await setupNetworkFixture()
    const priorUmask = process.umask(0o022)
    try {
      await cloneCheckoutAtHead(fixture)

      // #when — first run creates the fetch store from scratch via `ensureBareFetchStore`
      const first = await executeUpdate(req(), networkDeps(fixture))
      // #then — must succeed, never fetch-failed from a too-wide store
      expect(first.kind).toBe('ready')

      // #when — second run reuses the SAME store `ensureBareFetchStore` just created
      const second = await executeUpdate(req(), networkDeps(fixture))
      // #then — the pre-fix bug: git init's own umask-masked leaf mode failed this admission
      expect(second).toEqual({
        kind: 'ready',
        change: 'unchanged',
        branch: 'main',
        sha: fixture.headSha,
        checkedAt: expect.any(String) as string,
      })
    } finally {
      process.umask(priorUmask)
      await fixture.close()
    }
  })

  it("refuses fetch-failed against a preexisting fetch-store directory wider than 0700 — never chmod'ed", async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      const fetchStorePath = join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'fetch', `${OWNER}__${REPO}.git`)
      await mkdir(fetchStorePath, {recursive: true})
      // Explicit chmod — umask-independent — guarantees the mode regardless of the test runner's own umask.
      await chmod(fetchStorePath, 0o755)

      const result = await executeUpdate(req(), networkDeps(fixture))

      expect(result).toEqual({kind: 'failed', reason: 'fetch-failed', mutationStarted: false, permanent: false})
    } finally {
      await fixture.close()
    }
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — fail-closed-against-default (real /clone-shaped checkout)', () => {
  it('a checkout made the way /clone makes it (real git clone from the local HTTPS server) passes every admission step and reaches `ready`', async () => {
    // #given a bare "remote" repo served over real HTTPS by the Unit 2/slice-1 git-http-server
    // fixture, populated with one commit, and a checkout produced by a REAL `git clone` against
    // that server — the same askpass/env shape clone.ts's own writeAskpassHelper/buildCloneGitEnv
    // produce, swapped only for the loopback host (see git-http-server.ts's own doc comment on
    // why a second, host-parameterized askpass helper is test-only and safe here).
    const fixture = await setupNetworkFixture()
    const askpassDir = await makeTempDir('update-test-fixture-askpass-')
    try {
      const host = new URL(fixture.remoteBaseUrl).host
      const askpassPath = await writeLoopbackAskpassHelper(askpassDir, host)
      const cloneEnv = {
        ...buildCloneGitEnv('test-token', askpassPath, isolatedGitEnv(checkoutHome)),
        GIT_SSL_CAINFO: fixture.caBundlePath,
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
        ['clone', '-q', `${fixture.remoteBaseUrl}/${OWNER}/${REPO}.git`, destPathFor()],
        cloneEnv,
      )
      expect(clone.ok, `clone failed: ${clone.stderr}`).toBe(true)

      // #when
      const result = await executeUpdate(req(), networkDeps(fixture))

      // #then — every admission step passed, and the checkout was already at the remote's tip.
      expect(result).toEqual({
        kind: 'ready',
        change: 'unchanged',
        branch: 'main',
        sha: fixture.headSha,
        checkedAt: expect.any(String) as string,
      })
    } finally {
      await fixture.close()
      await rm(askpassDir, {recursive: true, force: true})
    }
  })
})

// ---------------------------------------------------------------------------
// Network fixture — a real "remote": a bare repo served over real HTTPS by the Unit 2/slice-1
// git-http-server fixture. Slice 2b's network+apply half is exercised against this for every
// scenario below (behind/unchanged/ahead/diverged/detached/non-default-branch/obstructed/remote
// failures/remote-moved/hung-apply/abort). Gated on OPENSSL_AVAILABLE like the fail-closed test
// above, since the fixture's self-signed cert needs a real `openssl` binary.
// ---------------------------------------------------------------------------

interface NetworkFixture {
  readonly remoteBaseUrl: string
  readonly caBundlePath: string
  readonly remoteRepoPath: string
  readonly headSha: string
  readonly token: string
  /** Commits and pushes directly to the bare "remote", simulating the remote moving. Returns the new tip SHA. */
  readonly pushCommit: (name: string, content: string, message: string) => string
  /** Injects (or clears) a canned failure for this fixture's own `<owner>/<repo>.git` path. */
  readonly setFailure: (failure: '403' | '404' | '429' | 'hang' | undefined) => void
  /** Total HTTP requests the fixture server has received so far — lets a test assert the real server was never contacted. */
  readonly requestCount: () => number
  readonly close: () => Promise<void>
}

async function setupNetworkFixture(
  options: {readonly owner?: string; readonly repo?: string; readonly requireToken?: string} = {},
): Promise<NetworkFixture> {
  const {owner = OWNER, repo = REPO, requireToken} = options
  const fixtureReposRoot = await makeTempDir('update-net-repos-')
  const workDir = await makeTempDir('update-net-work-')
  const workHome = await makeTempDir('update-net-work-home-')
  const token = requireToken ?? 'test-token'

  const remoteRepoPath = await bareRepoPath(fixtureReposRoot, owner, repo)
  gitSync(fixtureReposRoot, ['init', '-q', '--bare', '-b', 'main', remoteRepoPath], isolatedGitEnv(workHome))
  initRepo(workDir, isolatedGitEnv(workHome), 'main')
  const headSha = commitFile(workDir, isolatedGitEnv(workHome), 'README.md', 'hello\n', 'initial commit')
  gitSync(workDir, ['push', '-q', remoteRepoPath, 'main'], isolatedGitEnv(workHome))

  const server = await startGitHttpServer({reposRoot: fixtureReposRoot, requireToken})
  const repoPath = `${owner}/${repo}.git`
  return {
    remoteBaseUrl: server.baseUrl,
    caBundlePath: server.caBundlePath,
    remoteRepoPath,
    headSha,
    token,
    pushCommit(name, content, message) {
      const sha = commitFile(workDir, isolatedGitEnv(workHome), name, content, message)
      gitSync(workDir, ['push', '-q', remoteRepoPath, 'main'], isolatedGitEnv(workHome))
      return sha
    },
    setFailure(failure) {
      server.setFailure(repoPath, failure)
    },
    requestCount: () => server.requestCount(),
    async close() {
      await server.close()
      await rm(fixtureReposRoot, {recursive: true, force: true})
      await rm(workDir, {recursive: true, force: true})
      await rm(workHome, {recursive: true, force: true})
    },
  }
}

/** Deps for a fixture-backed test: `localDeps()` plus the fixture's remote URL/CA and a loopback-host askpass writer. `serviceHome` reuses `checkoutHome` — any writable per-test temp dir works for the network profile's HOME/cwd. */
function networkDeps(fixture: NetworkFixture, overrides: UpdateHandlerDeps = {}): UpdateHandlerDeps {
  const host = new URL(fixture.remoteBaseUrl).host
  return {
    ...localDeps(),
    remoteBaseUrl: fixture.remoteBaseUrl,
    caBundlePath: fixture.caBundlePath,
    askpassWriter: async dir => writeLoopbackAskpassHelper(dir, host),
    serviceHome: checkoutHome,
    ...overrides,
  }
}

/** Clones the checkout from the fixture's bare "remote" via LOCAL transport (fast; the checkout's own `remote.origin.url` is irrelevant — `executeUpdate` always builds the remote URL itself from `deps.remoteBaseUrl` + the request). Call BEFORE `fixture.pushCommit(...)` to set up a "behind" scenario. */
async function cloneCheckoutAtHead(fixture: NetworkFixture, owner = OWNER, repo = REPO): Promise<void> {
  await mkdir(join(reposRoot, owner), {recursive: true})
  gitSync(reposRoot, ['clone', '-q', fixture.remoteRepoPath, destPathFor(owner, repo)], isolatedGitEnv(checkoutHome))
}

/** Reads every `refs/fro-bot/fetch/*` ref left in the fixture's bare "remote" mirror under `reposRoot`'s fetch store \u2014 must always be empty after `executeUpdate` returns, success or failure. */
function listLeftoverFetchRefs(owner = OWNER, repo = REPO): readonly string[] {
  const fetchStorePath = join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'fetch', `${owner}__${repo}.git`)
  const outcome = gitSync(
    fetchStorePath,
    ['for-each-ref', '--format=%(refname)', 'refs/fro-bot/fetch/'],
    isolatedGitEnv(checkoutHome),
  )
  return outcome.split('\n').filter(line => line.length > 0)
}

describe.skipIf(!OPENSSL_AVAILABLE)(
  'executeUpdate — remote failure classification (real server, real git, real stderr)',
  () => {
    it('wrong token (401): fetch-auth-rejected, not permanent', async () => {
      const fixture = await setupNetworkFixture({requireToken: 'right-token'})
      try {
        await cloneCheckoutAtHead(fixture)
        const result = await executeUpdate({owner: OWNER, repo: REPO, token: 'wrong-token'}, networkDeps(fixture))
        expect(result).toEqual({
          kind: 'failed',
          reason: 'fetch-auth-rejected',
          mutationStarted: false,
          permanent: false,
        })
      } finally {
        await fixture.close()
      }
    })

    it('403: fetch-forbidden, PERMANENT', async () => {
      const fixture = await setupNetworkFixture()
      try {
        await cloneCheckoutAtHead(fixture)
        fixture.setFailure('403')
        const result = await executeUpdate(req(), networkDeps(fixture))
        expect(result).toEqual({kind: 'failed', reason: 'fetch-forbidden', mutationStarted: false, permanent: true})
      } finally {
        await fixture.close()
      }
    })

    it('404: fetch-not-found, PERMANENT', async () => {
      const fixture = await setupNetworkFixture()
      try {
        await cloneCheckoutAtHead(fixture)
        fixture.setFailure('404')
        const result = await executeUpdate(req(), networkDeps(fixture))
        expect(result).toEqual({kind: 'failed', reason: 'fetch-not-found', mutationStarted: false, permanent: true})
      } finally {
        await fixture.close()
      }
    })

    it('429: fetch-rate-limited, not permanent', async () => {
      const fixture = await setupNetworkFixture()
      try {
        await cloneCheckoutAtHead(fixture)
        fixture.setFailure('429')
        const result = await executeUpdate(req(), networkDeps(fixture))
        expect(result).toEqual({kind: 'failed', reason: 'fetch-rate-limited', mutationStarted: false, permanent: false})
      } finally {
        await fixture.close()
      }
    })

    it('unreachable (closed port): fetch-unreachable, not permanent, zero server requests', async () => {
      const fixture = await setupNetworkFixture()
      try {
        await cloneCheckoutAtHead(fixture)
        const result = await executeUpdate(req(), networkDeps(fixture, {remoteBaseUrl: 'https://127.0.0.1:1'}))
        expect(result).toEqual({kind: 'failed', reason: 'fetch-unreachable', mutationStarted: false, permanent: false})
        // #and (B7) — the real fixture server was never contacted at all; the override URL alone
        // was what failed.
        expect(fixture.requestCount()).toBe(0)
      } finally {
        await fixture.close()
      }
    })

    it('hang past the network budget: termination-unconfirmed (git-remote-https grandchild survives the kill), not permanent, and places a maintenance hold', async () => {
      // #given a fixture that accepts the connection and never responds — git's HTTP transport is
      // handled by a `git-remote-https` GRANDCHILD process, which can outlive a SIGTERM/SIGKILL of
      // the `git ls-remote`/`git fetch` parent (exactly the "grandchild holds stdout/stderr open"
      // scenario update-fixtures/pack.test.ts documents for the pack-stream case) — so this
      // real hang reports `termination-unconfirmed`, never a confirmed `fetch-timeout`.
      const fixture = await setupNetworkFixture()
      try {
        await cloneCheckoutAtHead(fixture)
        fixture.setFailure('hang')

        // #when
        const result = await executeUpdate(req(), networkDeps(fixture, {networkBudgetMs: 800}))

        // #then
        expect(result).toEqual({
          kind: 'failed',
          reason: 'termination-unconfirmed',
          mutationStarted: false,
          permanent: false,
        })

        // #and — the maintenance hold refuses a follow-up /update with zero git calls
        const {runner, calls} = makeGitRunnerSpy()
        const followUp = await executeUpdate(req(), localDeps({gitRunner: runner}))
        expect(followUp).toEqual({kind: 'refused', reason: 'maintenance-hold'})
        expect(calls).toEqual([])
      } finally {
        await fixture.close()
      }
    }, 15000)
  },
)

/** Forges every `ls-remote` call's outcome to canned failure stderr — for B3's sideband-spoofing tests, which never need a real server since they exercise pure stderr classification. */
function stderrRunner(stderr: string): GitRunnerFn {
  return async (args, options) => {
    if (args.includes('ls-remote')) return {kind: 'failed', code: 128, stdout: '', stderr}
    return runGit(args, options)
  }
}

describe('executeUpdate — remote failure classification: anchored against sideband spoofing (review round B, B3)', () => {
  it('a remote-prefixed 403/404 sideband line never classifies permanent', async () => {
    await setupEligibleCheckout()
    const stderr = "remote: error: 403\nremote: fatal: repository 'x' not found\n"

    const result = await executeUpdate(req(), localDeps({gitRunner: stderrRunner(stderr)}))

    expect(result).toEqual({kind: 'failed', reason: 'fetch-failed', mutationStarted: false, permanent: false})
  })

  it('a syntactically-correct 403 fatal line for a DIFFERENT url never classifies permanent', async () => {
    await setupEligibleCheckout()
    const stderr =
      "fatal: unable to access 'https://evil.example.com/acme/widgets.git/': The requested URL returned error: 403\n"

    const result = await executeUpdate(req(), localDeps({gitRunner: stderrRunner(stderr)}))

    expect(result).toEqual({kind: 'failed', reason: 'fetch-failed', mutationStarted: false, permanent: false})
  })

  it('a 403 fatal line with trailing junk after the code never classifies permanent', async () => {
    await setupEligibleCheckout()
    const url = `http://127.0.0.1:${remoteListener.port}/${OWNER}/${REPO}.git`
    const stderr = `fatal: unable to access '${url}/': The requested URL returned error: 403 (ignored)\n`

    const result = await executeUpdate(req(), localDeps({gitRunner: stderrRunner(stderr)}))

    expect(result).toEqual({kind: 'failed', reason: 'fetch-failed', mutationStarted: false, permanent: false})
  })

  it('the EXACT anchored line for the real url still classifies permanent (control)', async () => {
    await setupEligibleCheckout()
    const url = `http://127.0.0.1:${remoteListener.port}/${OWNER}/${REPO}.git`
    const stderr = `fatal: unable to access '${url}/': The requested URL returned error: 403\n`

    const result = await executeUpdate(req(), localDeps({gitRunner: stderrRunner(stderr)}))

    expect(result).toEqual({kind: 'failed', reason: 'fetch-forbidden', mutationStarted: false, permanent: true})
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — happy path (real network fixture)', () => {
  it('behind by two commits: fast-forwards to the remote tip, reports fromSha, and leaves no leftover fetch ref', async () => {
    // #given a checkout cloned before two more commits landed on the remote
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      const fromSha = fixture.headSha
      fixture.pushCommit('b.txt', 'two', 'c2')
      const toSha = fixture.pushCommit('c.txt', 'three', 'c3')

      // #when
      const result = await executeUpdate(req(), networkDeps(fixture))

      // #then
      expect(result).toEqual({
        kind: 'ready',
        change: 'fast-forward',
        branch: 'main',
        sha: toSha,
        fromSha,
        checkedAt: expect.any(String) as string,
      })
      const landedSha = gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()
      expect(landedSha).toBe(toSha)
      const status = gitSync(destPathFor(), ['status', '--porcelain'], isolatedGitEnv(checkoutHome))
      expect(status.trim()).toBe('')
      expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: false, reason: 'absent'})
      expect(listLeftoverFetchRefs()).toEqual([])
    } finally {
      await fixture.close()
    }
  })

  it('equal: reports unchanged without moving HEAD', async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      const result = await executeUpdate(req(), networkDeps(fixture))
      expect(result).toEqual({
        kind: 'ready',
        change: 'unchanged',
        branch: 'main',
        sha: fixture.headSha,
        checkedAt: expect.any(String) as string,
      })
      expect(listLeftoverFetchRefs()).toEqual([])
      // #and (B7) — HEAD genuinely never moved.
      const headSha = gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()
      expect(headSha).toBe(fixture.headSha)
    } finally {
      await fixture.close()
    }
  })

  it('(review round C, C4) a tracked file changed during the fetch seam refuses dirty, not ready, for an unchanged (ancestry-equal) result', async () => {
    // #given a checkout at the remote tip (ancestry will classify 'equal') where the SECOND
    // no-`--branch` porcelain status call — the C4 cleanliness re-check inside the ancestry-equal
    // branch, since the first is executeUpdate's own admission step 7 — is forged dirty, simulating
    // the agent dirtying the tree during the network round-trip.
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      let cleanlinessStatusCalls = 0
      const forgingRunner: GitRunnerFn = async (args, options) => {
        if (args.includes('status') && args.includes('--porcelain=v2') && !args.includes('--branch')) {
          cleanlinessStatusCalls += 1
          if (cleanlinessStatusCalls === 2) {
            return {kind: 'ok', stdout: '1 .M N... 100644 100644 100644 aaa bbb file.txt\0', stderr: ''}
          }
        }
        return runGit(args, options)
      }

      // #when
      const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: forgingRunner}))

      // #then — refused dirty, never ready; no merge ran, so the journal is cleared.
      expect(result).toEqual({kind: 'refused', reason: 'dirty', changedPaths: ['file.txt']})
      expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: false, reason: 'absent'})
    } finally {
      await fixture.close()
    }
  })

  it('(A3) post-merge verification catches a branch mismatch after a confirmed merge exit: apply-failed, mutationStarted:true, journal stays applying', async () => {
    // #given a real "behind" fast-forward, but the ONE `symbolic-ref --short HEAD` call in this
    // flow (verifyPostMergeState, POST-merge — nothing else calls it for a fresh, non-reconciled
    // update) is intercepted to report a branch other than the one the merge actually landed on.
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      fixture.pushCommit('b.txt', 'two', 'c2')
      const forgingRunner: GitRunnerFn = async (args, options) => {
        if (args.includes('symbolic-ref') && args.includes('--short') && args.includes('HEAD')) {
          return {kind: 'ok', stdout: 'not-main\n', stderr: ''}
        }
        return runGit(args, options)
      }

      // #when
      const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: forgingRunner}))

      // #then — the merge itself succeeded (a real fast-forward ran), but verification refused to
      // trust it: mutationStarted:true (the merge command WAS spawned), journal left at `applying`.
      expect(result).toEqual({kind: 'failed', reason: 'apply-failed', mutationStarted: true, permanent: false})
      const journal = await readJournal(journalsDirFor(), OWNER, REPO)
      expect(journal.ok).toBe(true)
      expect(journal.ok === true ? journal.journal.phase : undefined).toBe('applying')
    } finally {
      await fixture.close()
    }
  })

  it('(A3) post-merge verification catches a dirty tree after a confirmed merge exit: apply-failed, mutationStarted:true, journal stays applying', async () => {
    // #given a real "behind" fast-forward; `checkTempIndexCleanliness`'s underlying status call
    // (`git status --porcelain=v2`, WITHOUT `--branch` — distinct from inspectCheckout's own call)
    // fires THREE times in a normal flow: admission (executeUpdate step 7, against H), PRE-merge
    // (runFastForward's re-admission, against H again), and POST-merge (verifyPostMergeState,
    // against T). The THIRD occurrence — the post-merge one — is forged dirty.
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      fixture.pushCommit('b.txt', 'two', 'c2')
      let cleanlinessStatusCalls = 0
      const forgingRunner: GitRunnerFn = async (args, options) => {
        if (args.includes('status') && args.includes('--porcelain=v2') && !args.includes('--branch')) {
          cleanlinessStatusCalls += 1
          if (cleanlinessStatusCalls === 3) {
            return {kind: 'ok', stdout: '1 .M N... 100644 100644 100644 aaa bbb file.txt\0', stderr: ''}
          }
        }
        return runGit(args, options)
      }

      // #when
      const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: forgingRunner}))

      // #then
      expect(result).toEqual({kind: 'failed', reason: 'apply-failed', mutationStarted: true, permanent: false})
      const journal = await readJournal(journalsDirFor(), OWNER, REPO)
      expect(journal.ok).toBe(true)
      expect(journal.ok === true ? journal.journal.phase : undefined).toBe('applying')
    } finally {
      await fixture.close()
    }
  })

  it('(A4) pre-merge re-admission refuses when the branch changed since admission: apply-failed, mutationStarted:false, journal cleared', async () => {
    // #given a real "behind" fast-forward; `inspectCheckout`'s status call (`--porcelain=v2
    // --branch`) fires twice in a normal flow: once at ADMISSION (executeUpdate step 2), once in
    // runFastForward's PRE-merge re-verification (reverifyCheckoutState). The second occurrence
    // reports a different branch — simulating the agent switching branches mid-round-trip.
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      const fromSha = fixture.headSha
      fixture.pushCommit('b.txt', 'two', 'c2')
      let branchStatusCalls = 0
      const forgingRunner: GitRunnerFn = async (args, options) => {
        if (args.includes('status') && args.includes('--porcelain=v2') && args.includes('--branch')) {
          branchStatusCalls += 1
          if (branchStatusCalls === 2) {
            return {
              kind: 'ok',
              stdout: `# branch.oid ${fromSha}\n# branch.head agent-branch\n`,
              stderr: '',
            }
          }
        }
        return runGit(args, options)
      }

      // #when
      const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: forgingRunner}))

      // #then — the merge command was NEVER spawned (caught before the "point of no return"):
      // mutationStarted:false, journal CLEARED, not left at `applying`.
      expect(result).toEqual({kind: 'failed', reason: 'apply-failed', mutationStarted: false, permanent: false})
      expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: false, reason: 'absent'})
      const landedSha = gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()
      expect(landedSha).toBe(fromSha)
    } finally {
      await fixture.close()
    }
  })

  it("(A6) reconciling a crashed-after-applied journal reports the journal's OWN appliedAt, not a fresh timestamp", async () => {
    // #given a real fast-forward completes normally, landing the checkout at toSha
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      const fromSha = fixture.headSha
      const toSha = fixture.pushCommit('b.txt', 'two', 'c2')
      const firstResult = await executeUpdate(req(), networkDeps(fixture))
      expect(firstResult.kind).toBe('ready')

      await writeJournal(journalsDirFor(), {
        kind: 'update',
        owner: OWNER,
        repo: REPO,
        phase: 'applied',
        fromSha,
        toSha,
        startedAt: '2020-01-01T00:00:00.000Z',
        appliedAt: '2020-01-01T00:00:00.000Z',
      })

      const reconcileNow = (): Date => new Date(2099, 0, 1)
      const reconciled = await executeUpdate(req(), networkDeps(fixture, {now: reconcileNow}))

      expect(reconciled).toEqual({
        kind: 'ready',
        change: 'fast-forward',
        branch: 'main',
        sha: toSha,
        fromSha,
        checkedAt: '2020-01-01T00:00:00.000Z',
      })
    } finally {
      await fixture.close()
    }
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — policy: detached, non-default-branch, ahead, diverged', () => {
  it('detached HEAD: refuses detached without importing any objects', async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      gitSync(destPathFor(), ['checkout', '-q', fixture.headSha], isolatedGitEnv(checkoutHome))
      let packStreamCalls = 0
      const spyPackStreamRunner: typeof runPackStream = async options => {
        packStreamCalls += 1
        return runPackStream(options)
      }

      const result = await executeUpdate(req(), networkDeps(fixture, {packStreamRunner: spyPackStreamRunner}))

      expect(result).toEqual({kind: 'refused', reason: 'detached'})
      // #and (B7) — the pack-stream runner (the only thing that ever imports objects) was never called.
      expect(packStreamCalls).toBe(0)
    } finally {
      await fixture.close()
    }
  })

  it("non-default branch: refuses non-default-branch, naming the checkout's own branch", async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      gitSync(destPathFor(), ['checkout', '-q', '-b', 'feature'], isolatedGitEnv(checkoutHome))

      const result = await executeUpdate(req(), networkDeps(fixture))

      expect(result).toEqual({kind: 'refused', reason: 'non-default-branch', branch: 'feature'})
    } finally {
      await fixture.close()
    }
  })

  it('ahead: the checkout has a local commit the remote does not — refuses ahead', async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      commitFile(destPathFor(), isolatedGitEnv(checkoutHome), 'local-only.txt', 'local', 'local commit')

      const result = await executeUpdate(req(), networkDeps(fixture))

      expect(result).toEqual({kind: 'refused', reason: 'ahead'})
    } finally {
      await fixture.close()
    }
  })

  it('diverged: the checkout and the remote each have commits the other lacks — refuses diverged', async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      commitFile(destPathFor(), isolatedGitEnv(checkoutHome), 'local-only.txt', 'local', 'local commit')
      fixture.pushCommit('remote-only.txt', 'remote', 'remote commit')

      const result = await executeUpdate(req(), networkDeps(fixture))

      expect(result).toEqual({kind: 'refused', reason: 'diverged'})
    } finally {
      await fixture.close()
    }
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — obstruction preflight (real network fixture)', () => {
  it('an ignored file blocking an incoming path refuses obstructed, and leaves no leftover fetch ref', async () => {
    // #given a checkout with a locally-ignored (never tracked, never reported dirty) file at a
    // path the remote's next commit also introduces, with DIFFERENT content
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      await writeFile(join(destPathFor(), '.git', 'info', 'exclude'), 'obstructed.txt\n', {flag: 'a'})
      await writeFile(join(destPathFor(), 'obstructed.txt'), 'locally-ignored-content\n')
      fixture.pushCommit('obstructed.txt', 'incoming-content', 'adds obstructed.txt')

      // #when
      const result = await executeUpdate(req(), networkDeps(fixture))

      // #then
      expect(result.kind).toBe('refused')
      const obstructedPaths =
        result.kind === 'refused' && result.reason === 'obstructed' ? result.obstructions.map(o => o.path) : []
      expect(obstructedPaths).toContain('obstructed.txt')
      expect(listLeftoverFetchRefs()).toEqual([])
    } finally {
      await fixture.close()
    }
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — remote moved between observations', () => {
  it('moves twice in a row: retries the fetch-then-observe pair once, then fails remote-moved', async () => {
    // #given a fake gitRunner that answers every `ls-remote` with a DIFFERENT SHA each time
    // (simulating the remote's tip changing between every observation) and every `fetch` as a
    // trivial success \u2014 everything else (admission, bare-store init) still runs through real git.
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      let lsRemoteCalls = 0
      let fetchCalls = 0
      const movingRunner: GitRunnerFn = async (args, options) => {
        if (args.includes('ls-remote')) {
          lsRemoteCalls += 1
          const sha = 'a'.repeat(39) + String(lsRemoteCalls)
          return {kind: 'ok', stdout: `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n`, stderr: ''}
        }
        if (args.includes('fetch') && args.includes('--quiet')) {
          fetchCalls += 1
          return {kind: 'ok', stdout: '', stderr: ''}
        }
        return runGit(args, options)
      }

      // #when
      const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: movingRunner}))

      // #then — three observations total: the initial one, plus two retries of the pair. Exactly
      // two fetch attempts (one per retry), and (B1/B7) no refs/fro-bot/fetch/* ref survives either
      // attempt, even though NEITHER attempt's ref was ever the winner (the sequence ended in failure).
      expect(result).toEqual({kind: 'failed', reason: 'remote-moved', mutationStarted: false, permanent: false})
      expect(lsRemoteCalls).toBe(3)
      expect(fetchCalls).toBe(2)
      expect(listLeftoverFetchRefs()).toEqual([])
    } finally {
      await fixture.close()
    }
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — fetch ref leak prevention (review round B, B1)', () => {
  it("a moved-tip retry leaves no leftover fetch refs, even though the first attempt's ref was never the winner", async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      let fetchCalls = 0
      const forgingRunner: GitRunnerFn = async (args, options) => {
        if (args.includes('fetch') && args.includes('--quiet')) {
          fetchCalls += 1
          const outcome = await runGit(args, options)
          if (fetchCalls === 1) {
            fixture.pushCommit('moved.txt', 'moved', 'moved commit')
          }
          return outcome
        }
        return runGit(args, options)
      }

      const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: forgingRunner}))

      expect(result.kind).toBe('ready')
      expect(fetchCalls).toBe(2)
      expect(listLeftoverFetchRefs()).toEqual([])
    } finally {
      await fixture.close()
    }
  })

  it('a re-observe failure after a successful fetch leaves no leftover fetch ref', async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      let lsRemoteCalls = 0
      const forgingRunner: GitRunnerFn = async (args, options) => {
        if (args.includes('ls-remote')) {
          lsRemoteCalls += 1
          if (lsRemoteCalls === 2) {
            return {kind: 'failed', code: 1, stdout: '', stderr: 'fatal: unable to access something\n'}
          }
        }
        return runGit(args, options)
      }

      const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: forgingRunner}))

      expect(result.kind).toBe('failed')
      expect(listLeftoverFetchRefs()).toEqual([])
    } finally {
      await fixture.close()
    }
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)(
  'executeUpdate — ancestry hardening against a planted replace ref (review round B, B4)',
  () => {
    it('a replace ref for H planted after admission does not change the fast-forward classification', async () => {
      const fixture = await setupNetworkFixture()
      try {
        await cloneCheckoutAtHead(fixture)
        const fromSha = fixture.headSha
        const toSha = fixture.pushCommit('b.txt', 'two', 'c2')
        const env = isolatedGitEnv(checkoutHome)
        let planted = false
        let removed = false
        const forgingRunner: GitRunnerFn = async (args, options) => {
          if (!planted && args.includes('ls-remote')) {
            planted = true
            const indexPath = join(checkoutHome, 'empty-index-for-replace-ref-test')
            const emptyTree = gitSync(destPathFor(), ['write-tree'], {...env, GIT_INDEX_FILE: indexPath}).trim()
            const orphan = gitSync(destPathFor(), ['commit-tree', emptyTree, '-m', 'orphan'], env).trim()
            gitSync(destPathFor(), ['replace', fromSha, orphan], env)
          }
          if (planted && !removed && args.includes('ls-tree')) {
            removed = true
            gitSync(destPathFor(), ['replace', '-d', fromSha], env)
          }
          return runGit(args, options)
        }

        const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: forgingRunner}))

        expect(result).toEqual({
          kind: 'ready',
          change: 'fast-forward',
          branch: 'main',
          sha: toSha,
          fromSha,
          checkedAt: expect.any(String) as string,
        })
        expect(planted).toBe(true)
        expect(removed).toBe(true)
      } finally {
        await fixture.close()
      }
    })
  },
)

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — merge filter neutralization (review round B, B5)', () => {
  it('a filter driver added between the pre-merge config re-check and the merge (seam) never runs', async () => {
    const fixture = await setupNetworkFixture()
    const sentinelDir = await makeTempDir('update-test-filter-sentinel-')
    try {
      await cloneCheckoutAtHead(fixture)
      fixture.pushCommit('.gitattributes', '*.bin filter=evil\n', 'attrs')
      fixture.pushCommit('new.bin', 'payload', 'add new.bin')
      const env = isolatedGitEnv(checkoutHome)
      const sentinelCommand = `echo fired >> "${sentinelPath(sentinelDir)}"`
      let configInventoryCalls = 0
      const forgingRunner: GitRunnerFn = async (args, options) => {
        if (args.includes('--no-includes') && args.includes('--list')) {
          const outcome = await runGit(args, options)
          configInventoryCalls += 1
          if (configInventoryCalls === 2) {
            // The SECOND config-inventory call is runFastForward's own pre-merge re-check —
            // already passed by the time this runs. Planting the driver right after it (but
            // before enumerateFilterDrivers, the very next call) is the exact race B5 closes.
            gitSync(destPathFor(), ['config', 'filter.evil.smudge', sentinelCommand], env)
            gitSync(destPathFor(), ['config', 'filter.evil.required', 'true'], env)
          }
          return outcome
        }
        return runGit(args, options)
      }

      const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: forgingRunner}))

      expect(result.kind).toBe('ready')
      expect(configInventoryCalls).toBe(2)
      expect(await sentinelFired(sentinelDir)).toBe(false)
    } finally {
      await rm(sentinelDir, {recursive: true, force: true})
      await fixture.close()
    }
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — deadlines are shared, not per-call (review round B, B2)', () => {
  it('the network deadline is shared across ls-remote/fetch/re-observe — expiry fails fetch-timeout without a fresh per-call allowance', async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      let clock = 0
      const monotonicNow = (): number => clock
      let lsRemoteCalls = 0
      const forgingRunner: GitRunnerFn = async (args, options) => {
        if (args.includes('ls-remote')) {
          lsRemoteCalls += 1
          clock += 10_000
        }
        return runGit(args, options)
      }

      const result = await executeUpdate(
        req(),
        networkDeps(fixture, {gitRunner: forgingRunner, networkBudgetMs: 1_000, monotonicNow}),
      )

      expect(result).toEqual({kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false})
      // #and — the deadline expired right after the FIRST ls-remote; the fetch attempt that would
      // otherwise follow never got a fresh allowance and was never even dispatched.
      expect(lsRemoteCalls).toBe(1)
    } finally {
      await fixture.close()
    }
  })

  it('the apply deadline is shared across shaPresentInBare/import/merge — a slow first apply step exhausts it before the pack import ever runs', async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      fixture.pushCommit('b.txt', 'two', 'c2')
      let clock = 0
      const monotonicNow = (): number => clock
      let packStreamCalls = 0
      const spyPackStreamRunner: typeof runPackStream = async options => {
        packStreamCalls += 1
        return runPackStream(options)
      }
      const forgingRunner: GitRunnerFn = async (args, options) => {
        if (args.includes('cat-file') && args.includes('-e')) {
          clock += 10_000
        }
        return runGit(args, options)
      }

      const result = await executeUpdate(
        req(),
        networkDeps(fixture, {
          gitRunner: forgingRunner,
          packStreamRunner: spyPackStreamRunner,
          applyTimeoutMs: 1_000,
          monotonicNow,
        }),
      )

      expect(result).toEqual({kind: 'failed', reason: 'apply-failed', mutationStarted: false, permanent: false})
      expect(packStreamCalls).toBe(0)
      expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: false, reason: 'absent'})
    } finally {
      await fixture.close()
    }
  })
})

describe('executeUpdate — invocation tracker choke point, admission phase (review round C, C2d)', () => {
  it('an unconfirmed termination during admission (before any journal exists) places a maintenance hold', async () => {
    await setupEligibleCheckout()
    const forgingRunner: GitRunnerFn = async (args, options) => {
      if (args.includes('read-tree')) return {kind: 'termination-unconfirmed'}
      return runGit(args, options)
    }

    const result = await executeUpdate(req(), localDeps({gitRunner: forgingRunner}))

    expect(result).toEqual({
      kind: 'failed',
      reason: 'termination-unconfirmed',
      mutationStarted: false,
      permanent: false,
    })

    const {runner, calls} = makeGitRunnerSpy()
    const followUp = await executeUpdate(req(), localDeps({gitRunner: runner}))
    expect(followUp).toEqual({kind: 'refused', reason: 'maintenance-hold'})
    expect(calls).toEqual([])
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)(
  'executeUpdate — invocation tracker choke point, apply phase (review round C, C2a/b/c)',
  () => {
    it('(C2a) merge-base unconfirmed after the pack import: hold set, journal stays applying, result termination-unconfirmed', async () => {
      const fixture = await setupNetworkFixture()
      try {
        await cloneCheckoutAtHead(fixture)
        fixture.pushCommit('b.txt', 'two', 'c2')
        const forgingRunner: GitRunnerFn = async (args, options) => {
          if (args.includes('merge-base') && args.includes('--is-ancestor')) return {kind: 'termination-unconfirmed'}
          return runGit(args, options)
        }

        const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: forgingRunner}))

        expect(result).toEqual({
          kind: 'failed',
          reason: 'termination-unconfirmed',
          mutationStarted: 'possibly',
          permanent: false,
        })
        const journal = await readJournal(journalsDirFor(), OWNER, REPO)
        expect(journal.ok).toBe(true)
        expect(journal.ok === true ? journal.journal.phase : undefined).toBe('applying')

        const followUp = await executeUpdate(req(), networkDeps(fixture))
        expect(followUp).toEqual({kind: 'refused', reason: 'maintenance-hold'})
      } finally {
        await fixture.close()
      }
    })

    it('(C2b) the pre-merge cleanliness re-check unconfirmed: hold set, journal stays applying, result termination-unconfirmed', async () => {
      const fixture = await setupNetworkFixture()
      try {
        await cloneCheckoutAtHead(fixture)
        fixture.pushCommit('b.txt', 'two', 'c2')
        // Two `read-tree` calls happen in a normal "behind" flow: admission step 7 (against H), then
        // runFastForward's own pre-merge re-check (against H again) — forge the SECOND.
        let readTreeCalls = 0
        const forgingRunner: GitRunnerFn = async (args, options) => {
          if (args.includes('read-tree')) {
            readTreeCalls += 1
            if (readTreeCalls === 2) return {kind: 'termination-unconfirmed'}
          }
          return runGit(args, options)
        }

        const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: forgingRunner}))

        expect(result).toEqual({
          kind: 'failed',
          reason: 'termination-unconfirmed',
          mutationStarted: 'possibly',
          permanent: false,
        })
        const journal = await readJournal(journalsDirFor(), OWNER, REPO)
        expect(journal.ok).toBe(true)
        expect(journal.ok === true ? journal.journal.phase : undefined).toBe('applying')

        const followUp = await executeUpdate(req(), networkDeps(fixture))
        expect(followUp).toEqual({kind: 'refused', reason: 'maintenance-hold'})
      } finally {
        await fixture.close()
      }
    })

    it('(C2c) ref-cleanup update-ref unconfirmed after an otherwise successful update: hold set, result not ready', async () => {
      const fixture = await setupNetworkFixture()
      try {
        await cloneCheckoutAtHead(fixture)
        fixture.pushCommit('b.txt', 'two', 'c2')
        const forgingRunner: GitRunnerFn = async (args, options) => {
          if (args.includes('update-ref') && args.includes('-d')) return {kind: 'termination-unconfirmed'}
          return runGit(args, options)
        }

        const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: forgingRunner}))

        expect(result).toEqual({
          kind: 'failed',
          reason: 'termination-unconfirmed',
          mutationStarted: 'possibly',
          permanent: false,
        })

        const followUp = await executeUpdate(req(), networkDeps(fixture))
        expect(followUp).toEqual({kind: 'refused', reason: 'maintenance-hold'})
      } finally {
        await fixture.close()
      }
    })
  },
)

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — hung apply via an injectable seam', () => {
  it('a pack-stream that reports termination-unconfirmed fails possibly, leaves the journal at applying, places a maintenance hold, and a follow-up /update refuses maintenance-hold with zero git calls', async () => {
    // #given a fake packStreamRunner standing in for a hung `pack-objects | index-pack` pipe \u2014
    // deterministic and instant, unlike an actually-hung subprocess
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      fixture.pushCommit('b.txt', 'two', 'c2')
      const hungPackStreamRunner = async (): ReturnType<typeof runPackStream> => ({kind: 'termination-unconfirmed'})

      // #when
      const result = await executeUpdate(req(), networkDeps(fixture, {packStreamRunner: hungPackStreamRunner}))

      // #then
      expect(result).toEqual({
        kind: 'failed',
        reason: 'termination-unconfirmed',
        mutationStarted: 'possibly',
        permanent: false,
      })
      const journal = await readJournal(journalsDirFor(), OWNER, REPO)
      expect(journal.ok).toBe(true)
      expect(journal.ok === true ? journal.journal.phase : undefined).toBe('applying')

      // #when — a follow-up /update refuses WITHOUT any git call at all: the maintenance hold
      // (repo-mutex.ts) set by the unconfirmed pack-stream termination is checked FIRST, before
      // even journal reconciliation.
      const {runner, calls} = makeGitRunnerSpy()
      const followUp = await executeUpdate(req(), networkDeps(fixture, {gitRunner: runner}))

      // #then
      expect(followUp).toEqual({kind: 'refused', reason: 'maintenance-hold'})
      expect(calls).toEqual([])
    } finally {
      await fixture.close()
    }
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — client abort, before vs after the apply phase begins', () => {
  it('an already-aborted signal stops work before any mutation, reported as aborted (not a bare timeout)', async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      fixture.pushCommit('b.txt', 'two', 'c2')
      const controller = new AbortController()
      controller.abort()

      const result = await executeUpdate(req(), networkDeps(fixture, {signal: controller.signal}))

      // #then — step 8's own pre-network abort check (executeUpdate) fires first, so the network
      // half (and its bare fetch store) is never reached at all.
      expect(result).toEqual({kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false})
    } finally {
      await fixture.close()
    }
  })

  it('a disconnect fired once the journal reads applying is ignored \u2014 the mutation still completes', async () => {
    const fixture = await setupNetworkFixture()
    try {
      await cloneCheckoutAtHead(fixture)
      const fromSha = fixture.headSha
      const toSha = fixture.pushCommit('b.txt', 'two', 'c2')
      const controller = new AbortController()
      let journalPhaseAtInjection: string | undefined
      const abortMidStreamRunner: typeof runPackStream = async options => {
        // Simulates a client disconnect landing exactly once the mutation (pack import) is under
        // way — (B7) confirmed here by actually re-reading the journal, rather than assuming it.
        const journal = await readJournal(journalsDirFor(), OWNER, REPO)
        journalPhaseAtInjection =
          journal.ok === true && journal.journal.kind === 'update' ? journal.journal.phase : undefined
        controller.abort()
        return runPackStream(options)
      }

      const result = await executeUpdate(
        req(),
        networkDeps(fixture, {signal: controller.signal, packStreamRunner: abortMidStreamRunner}),
      )

      expect(result).toEqual({
        kind: 'ready',
        change: 'fast-forward',
        branch: 'main',
        sha: toSha,
        fromSha,
        checkedAt: expect.any(String) as string,
      })
      // #and (B7) — the disconnect really did land after the journal recorded `applying`, not
      // merely before the mutation happened to finish.
      expect(journalPhaseAtInjection).toBe('applying')
    } finally {
      await fixture.close()
    }
  })
})

describe('reconcileUpdateJournalsOnStartup', () => {
  it('clears a "fetched" journal for an eligible checkout', async () => {
    // #given
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
    await reconcileUpdateJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: silentLogger(),
    })

    // #then
    expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: false, reason: 'absent'})
  })

  it('clears an "applied" journal whose HEAD already matches the target SHA', async () => {
    // #given
    const {headSha} = await setupEligibleCheckout()
    await writeJournal(journalsDirFor(), {
      kind: 'update',
      owner: OWNER,
      repo: REPO,
      phase: 'applied',
      fromSha: '0'.repeat(40),
      toSha: headSha,
      startedAt: new Date().toISOString(),
      appliedAt: new Date().toISOString(),
    })

    // #when
    await reconcileUpdateJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: silentLogger(),
    })

    // #then
    expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: false, reason: 'absent'})
  })

  it('leaves an "applying" journal in place (needs-recovery is Unit 5\u2019s job, not startup\u2019s)', async () => {
    // #given
    await setupEligibleCheckout()
    const journal = {
      kind: 'update' as const,
      owner: OWNER,
      repo: REPO,
      phase: 'applying' as const,
      fromSha: '0'.repeat(40),
      toSha: '1'.repeat(40),
      startedAt: new Date().toISOString(),
    }
    await writeJournal(journalsDirFor(), journal)

    // #when
    await reconcileUpdateJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: silentLogger(),
    })

    // #then \u2014 untouched: a subsequent /update for this repo would still refuse needs-recovery
    expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: true, journal})
  })

  it('leaves a malformed journal file in place', async () => {
    // #given
    await setupEligibleCheckout()
    await mkdir(journalsDirFor(), {recursive: true, mode: 0o700})
    const filePath = join(journalsDirFor(), `${OWNER}__${REPO}.json`)
    await writeFile(filePath, '{not valid json')

    // #when
    await reconcileUpdateJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: silentLogger(),
    })

    // #then \u2014 still unparseable, i.e. still there and still malformed
    expect(await readJournal(journalsDirFor(), OWNER, REPO)).toMatchObject({ok: false, reason: 'malformed'})
  })

  it('reconciles multiple repositories\u2019 journals independently in one pass', async () => {
    // #given \u2014 one repo with a clearable "fetched" journal, another with a keep-in-place "applying" one
    await setupEligibleCheckout('acme', 'widgets')
    await writeJournal(journalsDirFor(), {
      kind: 'update',
      owner: 'acme',
      repo: 'widgets',
      phase: 'fetched',
      fromSha: '0'.repeat(40),
      toSha: '1'.repeat(40),
      startedAt: new Date().toISOString(),
    })
    await setupEligibleCheckout('acme', 'gadgets')
    await writeJournal(journalsDirFor(), {
      kind: 'update',
      owner: 'acme',
      repo: 'gadgets',
      phase: 'applying',
      fromSha: '0'.repeat(40),
      toSha: '1'.repeat(40),
      startedAt: new Date().toISOString(),
    })

    // #when
    await reconcileUpdateJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: silentLogger(),
    })

    // #then
    expect(await readJournal(journalsDirFor(), 'acme', 'widgets')).toEqual({ok: false, reason: 'absent'})
    expect((await readJournal(journalsDirFor(), 'acme', 'gadgets')).ok).toBe(true)
  })

  it('does nothing (never throws) when no journals directory exists', async () => {
    // #given \u2014 fresh reposRoot, no journals directory ever created
    // #when / #then
    await expect(reconcileUpdateJournalsOnStartup({reposRoot, logger: silentLogger()})).resolves.toBeUndefined()
  })

  it('(C5b) skips a repository already under a maintenance hold, leaving its journal untouched with zero git calls', async () => {
    await setupEligibleCheckout()
    const journal = {
      kind: 'update' as const,
      owner: OWNER,
      repo: REPO,
      phase: 'fetched' as const,
      fromSha: '0'.repeat(40),
      toSha: '1'.repeat(40),
      startedAt: new Date().toISOString(),
    }
    await writeJournal(journalsDirFor(), journal)
    markRepoHeld(repoMutexKey(OWNER, REPO), 'termination-unconfirmed')
    const {runner, calls} = makeGitRunnerSpy()

    await reconcileUpdateJournalsOnStartup({
      reposRoot,
      gitRunner: runner,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: silentLogger(),
    })

    expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: true, journal})
    expect(calls).toEqual([])
  })

  it('(C5b) an unconfirmed termination during reconciliation holds the repository and leaves its journal in place', async () => {
    const {headSha} = await setupEligibleCheckout()
    const journal = {
      kind: 'update' as const,
      owner: OWNER,
      repo: REPO,
      phase: 'applied' as const,
      fromSha: '0'.repeat(40),
      toSha: headSha,
      startedAt: new Date().toISOString(),
      appliedAt: new Date().toISOString(),
    }
    await writeJournal(journalsDirFor(), journal)
    const forgingRunner: GitRunnerFn = async (args, options) => {
      if (args.includes('rev-parse') && args.includes('--verify')) return {kind: 'termination-unconfirmed'}
      return runGit(args, options)
    }

    await reconcileUpdateJournalsOnStartup({
      reposRoot,
      gitRunner: forgingRunner,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: silentLogger(),
    })

    expect(await readJournal(journalsDirFor(), OWNER, REPO)).toEqual({ok: true, journal})
    expect(repoHoldReason(repoMutexKey(OWNER, REPO))).toBe('termination-unconfirmed')
  })
})
