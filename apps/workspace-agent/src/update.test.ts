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
import {runPackStream} from './git-stream.js'
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
      } finally {
        await fixture.close()
      }
    })

    it('hang past the network budget: fetch-timeout, not permanent', async () => {
      const fixture = await setupNetworkFixture()
      try {
        await cloneCheckoutAtHead(fixture)
        fixture.setFailure('hang')
        const result = await executeUpdate(req(), networkDeps(fixture, {networkBudgetMs: 800}))
        expect(result).toEqual({kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false})
      } finally {
        await fixture.close()
      }
    }, 15000)
  },
)

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

      const result = await executeUpdate(req(), networkDeps(fixture))

      expect(result).toEqual({kind: 'refused', reason: 'detached'})
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
      const movingRunner: GitRunnerFn = async (args, options) => {
        if (args.includes('ls-remote')) {
          lsRemoteCalls += 1
          const sha = 'a'.repeat(39) + String(lsRemoteCalls)
          return {kind: 'ok', stdout: `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n`, stderr: ''}
        }
        if (args.includes('fetch') && args.includes('--quiet')) return {kind: 'ok', stdout: '', stderr: ''}
        return runGit(args, options)
      }

      // #when
      const result = await executeUpdate(req(), networkDeps(fixture, {gitRunner: movingRunner}))

      // #then \u2014 three observations total: the initial one, plus two retries of the pair.
      expect(result).toEqual({kind: 'failed', reason: 'remote-moved', mutationStarted: false, permanent: false})
      expect(lsRemoteCalls).toBe(3)
    } finally {
      await fixture.close()
    }
  })
})

describe.skipIf(!OPENSSL_AVAILABLE)('executeUpdate — hung apply via an injectable seam', () => {
  it('a pack-stream that reports termination-unconfirmed fails possibly, leaves the journal at applying, and a follow-up /update refuses needs-recovery with zero git calls', async () => {
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

      // #when \u2014 a follow-up /update reconciles the journal WITHOUT any git call at all (journal
      // reconciliation for `applying` refuses immediately, before touching the checkout or network)
      const {runner, calls} = makeGitRunnerSpy()
      const followUp = await executeUpdate(req(), networkDeps(fixture, {gitRunner: runner}))

      // #then
      expect(followUp).toEqual({kind: 'refused', reason: 'needs-recovery'})
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
      const abortMidStreamRunner: typeof runPackStream = async options => {
        // Simulates a client disconnect landing exactly once the mutation (pack import) is under way.
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
    } finally {
      await fixture.close()
    }
  })
})
