/**
 * Tests for recover.ts (Unit 5, slice 5a: preview only) \u2014 real git repositories in temp
 * directories, exactly like update.test.ts. The only injected seam is `gitRunner`.
 */

import type {AgentWalkRunner} from './agent-walk.js'
import type {GitRunnerFn} from './git-safety.js'
import type {ExecuteRecoveryDeps} from './recover.js'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {constants, existsSync, mkdirSync, statSync} from 'node:fs'
import {lstat, mkdir, open, readdir, readFile, readlink, rename, rm, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {runAgentWalk} from './agent-walk.js'
import {listBackups} from './backups.js'
import {runGit} from './git-safety.js'
import {AGENT_GID, AGENT_UID, JOURNAL_DIR_NAME, WORKSPACE_STATE_DIR_NAME} from './identity.js'
import {readJournal, writeJournal} from './journal.js'
import {executeRecovery, previewRecovery, reconcileRecoveryJournalsOnStartup} from './recover.js'
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
  gitSync,
  initRepo,
  isolatedGitEnv,
  makeTempDir,
  opensslAvailable,
} from './update-fixtures/helpers.js'
import {executeUpdate} from './update.js'

const OPENSSL_AVAILABLE = opensslAvailable()

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

interface NetworkFixture {
  readonly remoteBaseUrl: string
  readonly caBundlePath: string
  readonly remoteRepoPath: string
  readonly headSha: string
  readonly token: string
  readonly close: () => Promise<void>
}

/** A real HTTPS "remote" for executeRecovery's fetch phase — same fixture update.test.ts uses. */
async function setupNetworkFixture(owner = OWNER, repo = REPO): Promise<NetworkFixture> {
  const fixtureReposRoot = await makeTempDir('recover-net-repos-')
  const workDir = await makeTempDir('recover-net-work-')
  const workHome = await makeTempDir('recover-net-work-home-')
  const token = 'test-token'

  const remoteRepoPath = await bareRepoPath(fixtureReposRoot, owner, repo)
  gitSync(fixtureReposRoot, ['init', '-q', '--bare', '-b', 'main', remoteRepoPath], isolatedGitEnv(workHome))
  initRepo(workDir, isolatedGitEnv(workHome), 'main')
  const headSha = commitFile(workDir, isolatedGitEnv(workHome), 'README.md', 'hello\n', 'initial commit')
  gitSync(workDir, ['push', '-q', remoteRepoPath, 'main'], isolatedGitEnv(workHome))

  const server = await startGitHttpServer({reposRoot: fixtureReposRoot})
  return {
    remoteBaseUrl: server.baseUrl,
    caBundlePath: server.caBundlePath,
    remoteRepoPath,
    headSha,
    token,
    async close() {
      await server.close()
      await rm(fixtureReposRoot, {recursive: true, force: true})
      await rm(workDir, {recursive: true, force: true})
      await rm(workHome, {recursive: true, force: true})
    },
  }
}

function recoveryDeps(fixture: NetworkFixture, overrides: ExecuteRecoveryDeps = {}): ExecuteRecoveryDeps {
  const host = new URL(fixture.remoteBaseUrl).host
  return {
    ...deps(),
    remoteBaseUrl: fixture.remoteBaseUrl,
    caBundlePath: fixture.caBundlePath,
    askpassWriter: async dir => writeLoopbackAskpassHelper(dir, host),
    serviceHome: checkoutHome,
    ...overrides,
  }
}

function recoverReq(fixture: NetworkFixture, owner = OWNER, repo = REPO) {
  return {owner, repo, token: fixture.token, fingerprint: ''}
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
  it('(E2) reports an in-flight UPDATE journal as recoverable, never a dead-end refusal', async () => {
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
    expect(result).toEqual({
      kind: 'recoverable-update',
      update: {
        phase: 'applying',
        fromSha: '0'.repeat(40),
        toSha: '1'.repeat(40),
        startedAt: expect.any(String) as string,
        estimatedSizeBytes: expect.any(Number) as number,
        entryCount: expect.any(Number) as number,
        sizeMeasurementComplete: true,
        fingerprint: expect.any(String) as string,
      },
    })
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
      targetSha: '1'.repeat(40),
      branch: 'main',
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

describe('previewRecovery — D4: tracked, never returns a preview built on uncertainty', () => {
  it('holds the repository and refuses the preview when layout-child termination is unconfirmed', async () => {
    await setupCleanCheckout()

    const result = await previewRecovery(req(), deps({layoutRunner: async () => ({kind: 'termination-unconfirmed'})}))

    expect(result).toEqual({kind: 'failed', reason: 'termination-unconfirmed'})
    expect(repoHoldReason(repoMutexKey(OWNER, REPO))).toBe('termination-unconfirmed')
  })

  it('an unconfirmed config-inventory call sets the hold and fails termination-unconfirmed — never an opaque preview', async () => {
    await setupCleanCheckout()
    const forgingRunner: GitRunnerFn = async (args, options) => {
      if (args.includes('config') && args.includes('--list')) return {kind: 'termination-unconfirmed'}
      return runGit(args, options)
    }

    const result = await previewRecovery(req(), deps({gitRunner: forgingRunner}))

    expect(result).toEqual({kind: 'failed', reason: 'termination-unconfirmed'})
    expect(repoHoldReason(repoMutexKey(OWNER, REPO))).toBe('termination-unconfirmed')

    // #and — a follow-up preview refuses maintenance-hold with zero git calls
    const {runner, calls} = makeGitRunnerSpy()
    const followUp = await previewRecovery(req(), deps({gitRunner: runner}))
    expect(followUp).toEqual({kind: 'refused', reason: 'maintenance-hold'})
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

  it('is bounded by its own deadline — a tight budget against enough real entries caps before finishing, and reports sizeMeasurementComplete:false', async () => {
    // #given — (E5) the walk runs as a real subprocess with its OWN clock; enough real files make
    // a 1ms budget provably insufficient, unlike a synthetic-clock injection.
    await setupCleanCheckout()
    for (let i = 0; i < 2_000; i += 1) {
      await writeFile(join(destPathFor(), `extra-${i}.txt`), 'x')
    }

    // #when
    const result = await previewRecovery(req(), deps({walkDeadlineMs: 1}))

    // #then
    if (result.kind !== 'ok' || !result.preview.inspectionSafe) throw new Error('unreachable')
    expect(result.preview.entryCount).toBeLessThan(2_022)
    expect(result.preview.sizeMeasurementComplete).toBe(false)
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

describe('executeRecovery — happy path (real remote, real git)', {timeout: 30_000}, () => {
  it.skipIf(!OPENSSL_AVAILABLE)(
    'preserves a dirty checkout byte-for-byte in quarantine and installs a clean checkout a follow-up executeUpdate reports unchanged',
    async () => {
      // #given a dirty local checkout: untracked, ignored, and a local-only commit
      await setupCleanCheckout()
      const dest = destPathFor()
      await writeFile(join(dest, '.gitignore'), 'ignored.txt\n')
      gitSync(dest, ['add', '.gitignore'], isolatedGitEnv(checkoutHome))
      gitSync(dest, ['commit', '-q', '-m', 'add gitignore'], isolatedGitEnv(checkoutHome))
      await writeFile(join(dest, 'ignored.txt'), 'ignored content\n')
      await writeFile(join(dest, 'untracked.txt'), 'untracked content\n')
      const localSha = commitFile(dest, isolatedGitEnv(checkoutHome), 'local-only.txt', 'local', 'local-only commit')
      const originalManifest = await buildContentManifest(dest)

      const preview = await previewRecovery(req(), deps())
      if (preview.kind !== 'ok' || !preview.preview.inspectionSafe) throw new Error('unreachable')
      const fingerprint = preview.preview.fingerprint

      const fixture = await setupNetworkFixture()
      try {
        // #when
        const result = await executeRecovery({...recoverReq(fixture), fingerprint}, recoveryDeps(fixture))

        // #then
        expect(result.kind).toBe('ok')
        if (result.kind !== 'ok') throw new Error('unreachable')
        expect(result.sha).toBe(fixture.headSha)
        expect(result.branch).toBe('main')

        // #and — quarantine preserved the original byte for byte, including .git
        const envelopePath = join(
          reposRoot,
          WORKSPACE_STATE_DIR_NAME,
          'quarantine',
          `${OWNER}__${REPO}`,
          result.recoveryId,
        )
        const quarantinePath = join(envelopePath, 'checkout')
        expect(existsSync(join(envelopePath, 'metadata.json'))).toBe(true)
        expect(gitSync(quarantinePath, ['log', '-1', '--format=%H'], isolatedGitEnv(checkoutHome)).trim()).toBe(
          localSha,
        )
        expect(await readFile(join(quarantinePath, 'untracked.txt'), 'utf8')).toBe('untracked content\n')
        expect(await readFile(join(quarantinePath, 'ignored.txt'), 'utf8')).toBe('ignored content\n')
        // #and — (E9) a COMPLETE content manifest (path/type/mode/size/sha256/symlink target) of
        // the quarantined tree, INCLUDING `.git`, is byte-for-byte identical to the original.
        expect(await buildContentManifest(quarantinePath)).toEqual(originalManifest)

        // #and — installed checkout is clean on the default branch
        expect(gitSync(dest, ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()).toBe(fixture.headSha)
        expect(gitSync(dest, ['status', '--porcelain'], isolatedGitEnv(checkoutHome)).trim()).toBe('')
        expect(gitSync(dest, ['symbolic-ref', '--short', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()).toBe('main')
        // #and — (E9) agent-owned, when this test itself runs as root (a helper, not an inline
        // conditional, so the assertion is never skipped silently by lint-suppressed intent)
        assertAgentOwnedIfRoot(dest)

        // #and — a follow-up executeUpdate sees it as unchanged
        const host = new URL(fixture.remoteBaseUrl).host
        const updateResult = await executeUpdate(
          {owner: OWNER, repo: REPO, token: fixture.token},
          {
            reposRoot,
            options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
            remoteBaseUrl: fixture.remoteBaseUrl,
            caBundlePath: fixture.caBundlePath,
            askpassWriter: async d => writeLoopbackAskpassHelper(d, host),
            serviceHome: checkoutHome,
          },
        )
        expect(updateResult).toMatchObject({kind: 'ready', change: 'unchanged'})
      } finally {
        await fixture.close()
      }
    },
  )
})

describe('executeRecovery -- F8: genuine split-identity ownership (root only)', {timeout: 30_000}, () => {
  it.skipIf(process.getuid?.() !== 0)(
    'installs the checkout owned by the REAL agent uid/gid, distinct from the root service; the quarantine envelope and its metadata stay root-owned',
    async () => {
      // #given -- a clean checkout, with ancestor dirs made traversable by a uid/gid OTHER than
      // root's own (0), so the agent identity below is genuinely a different, unprivileged user --
      // not root pretending to be the agent (the bug F8 flags in the OLD `process.getuid?.()`-for-
      // both-sides tests).
      await setupCleanCheckout()
      execFileSync('chmod', ['-R', 'a+rX', reposRoot])
      const preview = await previewRecovery(req(), deps())
      if (preview.kind !== 'ok') throw new Error('unreachable')

      const fixture = await setupNetworkFixture()
      try {
        // #when -- confirm runs with the REAL agent identity, not root's own uid/gid
        const result = await executeRecovery(
          {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
          recoveryDeps(fixture, {options: {uid: AGENT_UID, gid: AGENT_GID, timeoutMs: 10_000}}),
        )

        // #then
        expect(result.kind).toBe('ok')
        if (result.kind !== 'ok') throw new Error('unreachable')

        const installedSt = statSync(destPathFor())
        expect(installedSt.uid).toBe(AGENT_UID)
        expect(installedSt.gid).toBe(AGENT_GID)

        const envelopePath = join(
          reposRoot,
          WORKSPACE_STATE_DIR_NAME,
          'quarantine',
          `${OWNER}__${REPO}`,
          result.recoveryId,
        )
        const envelopeSt = statSync(envelopePath)
        expect(envelopeSt.uid).toBe(0)
        expect(envelopeSt.gid).toBe(0)
        const metadataSt = statSync(join(envelopePath, 'metadata.json'))
        expect(metadataSt.uid).toBe(0)
        expect(metadataSt.gid).toBe(0)
      } finally {
        await fixture.close()
      }
    },
  )
})

describe(
  'executeRecovery -- E9: envelope collision safety (original checkout contains metadata.json)',
  {timeout: 30_000},
  () => {
    it.skipIf(!OPENSSL_AVAILABLE)(
      'a tracked metadata.json FILE inside the original is preserved untouched under checkout/, alongside correct service metadata',
      async () => {
        await setupCleanCheckout()
        const dest = destPathFor()
        const localSha = commitFile(
          dest,
          isolatedGitEnv(checkoutHome),
          'metadata.json',
          '{"app":"data"}',
          'app metadata file',
        )
        const preview = await previewRecovery(req(), deps())
        if (preview.kind !== 'ok') throw new Error('unreachable')

        const fixture = await setupNetworkFixture()
        try {
          const result = await executeRecovery(
            {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
            recoveryDeps(fixture),
          )

          expect(result.kind).toBe('ok')
          if (result.kind !== 'ok') throw new Error('unreachable')
          const envelopePath = join(
            reposRoot,
            WORKSPACE_STATE_DIR_NAME,
            'quarantine',
            `${OWNER}__${REPO}`,
            result.recoveryId,
          )
          expect(await readFile(join(envelopePath, 'checkout', 'metadata.json'), 'utf8')).toBe('{"app":"data"}')
          expect(
            gitSync(join(envelopePath, 'checkout'), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim(),
          ).toBe(localSha)
          const serviceMetadata = JSON.parse(await readFile(join(envelopePath, 'metadata.json'), 'utf8')) as {
            source: string
          }
          expect(serviceMetadata.source).toBe('recovery')
        } finally {
          await fixture.close()
        }
      },
    )

    it.skipIf(!OPENSSL_AVAILABLE)(
      'a tracked metadata.json/ DIRECTORY inside the original is preserved untouched under checkout/, alongside correct service metadata',
      async () => {
        await setupCleanCheckout()
        const dest = destPathFor()
        await mkdir(join(dest, 'metadata.json'), {recursive: true})
        const localSha = commitFile(
          dest,
          isolatedGitEnv(checkoutHome),
          'metadata.json/inner.txt',
          'inner',
          'app metadata dir',
        )
        const preview = await previewRecovery(req(), deps())
        if (preview.kind !== 'ok') throw new Error('unreachable')

        const fixture = await setupNetworkFixture()
        try {
          const result = await executeRecovery(
            {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
            recoveryDeps(fixture),
          )

          expect(result.kind).toBe('ok')
          if (result.kind !== 'ok') throw new Error('unreachable')
          const envelopePath = join(
            reposRoot,
            WORKSPACE_STATE_DIR_NAME,
            'quarantine',
            `${OWNER}__${REPO}`,
            result.recoveryId,
          )
          const originalMetadataDir = join(envelopePath, 'checkout', 'metadata.json')
          expect(existsSync(originalMetadataDir)).toBe(true)
          expect((await lstat(originalMetadataDir)).isDirectory()).toBe(true)
          expect(await readFile(join(originalMetadataDir, 'inner.txt'), 'utf8')).toBe('inner')
          expect(
            gitSync(join(envelopePath, 'checkout'), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim(),
          ).toBe(localSha)
          expect((await lstat(join(envelopePath, 'metadata.json'))).isFile()).toBe(true)
          const serviceMetadata = JSON.parse(await readFile(join(envelopePath, 'metadata.json'), 'utf8')) as {
            source: string
          }
          expect(serviceMetadata.source).toBe('recovery')
        } finally {
          await fixture.close()
        }
      },
    )
  },
)

describe('executeRecovery — opaque checkout (hostile config)', {timeout: 30_000}, () => {
  it.skipIf(!OPENSSL_AVAILABLE)('recovers a hostile-config checkout without ever running git in it', async () => {
    // #given a checkout with a planted filter driver — not on the closed config allowlist
    await setupCleanCheckout()
    gitSync(destPathFor(), ['config', 'filter.evil.clean', 'cat'], isolatedGitEnv(checkoutHome))
    const preview = await previewRecovery(req(), deps())
    if (preview.kind !== 'ok' || preview.preview.inspectionSafe) throw new Error('unreachable')
    const {runner, calls} = makeGitRunnerSpy()

    const fixture = await setupNetworkFixture()
    try {
      // #when
      const result = await executeRecovery(
        {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
        recoveryDeps(fixture, {gitRunner: runner}),
      )

      // #then
      expect(result.kind).toBe('ok')
      // #and — every call BEFORE staging's `git init` (the first command that ever touches the
      // fresh checkout, never the original) is limited to the admission re-check's own inert
      // `git config --list` — no working-tree-reading command (`status`/`read-tree`/`checkout`)
      // ever ran against the ORIGINAL hostile checkout.
      const initIndex = calls.findIndex(args => args.includes('init'))
      expect(initIndex).toBeGreaterThan(-1)
      const beforeBuild = calls.slice(0, initIndex)
      expect(
        beforeBuild.some(args => args.includes('status') || args.includes('read-tree') || args.includes('checkout')),
      ).toBe(false)
    } finally {
      await fixture.close()
    }
  })
})

describe('executeRecovery — fingerprint mismatch refuses checkout-changed', {timeout: 30_000}, () => {
  it.skipIf(!OPENSSL_AVAILABLE)('a new local commit landing after preview refuses and moves nothing', async () => {
    // #given
    await setupCleanCheckout()
    const preview = await previewRecovery(req(), deps())
    if (preview.kind !== 'ok') throw new Error('unreachable')
    commitFile(destPathFor(), isolatedGitEnv(checkoutHome), 'b.txt', 'two', 'second commit')

    const fixture = await setupNetworkFixture()
    try {
      // #when
      const result = await executeRecovery(
        {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
        recoveryDeps(fixture),
      )

      // #then
      expect(result).toEqual({kind: 'refused', reason: 'checkout-changed'})
      expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()).not.toBe(
        fixture.headSha,
      )
    } finally {
      await fixture.close()
    }
  })

  it.skipIf(!OPENSSL_AVAILABLE)(
    'a tracked file touched after preview (no new commit) also refuses checkout-changed',
    async () => {
      // #given
      await setupCleanCheckout()
      const preview = await previewRecovery(req(), deps())
      if (preview.kind !== 'ok') throw new Error('unreachable')
      await writeFile(join(destPathFor(), 'README.md'), 'tampered\n')

      const fixture = await setupNetworkFixture()
      try {
        // #when
        const result = await executeRecovery(
          {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
          recoveryDeps(fixture),
        )

        // #then
        expect(result).toEqual({kind: 'refused', reason: 'checkout-changed'})
      } finally {
        await fixture.close()
      }
    },
  )
})

/** Writes a fake, already-quarantined generation directly to disk (bypassing recovery) so quota tests can seed `listBackups` cheaply. */
async function createFakeGeneration(owner: string, repo: string, id: string, sizeBytes: number): Promise<void> {
  const dir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'quarantine', `${owner}__${repo}`, id)
  await mkdir(dir, {recursive: true})
  await writeFile(
    join(dir, 'metadata.json'),
    JSON.stringify({recoveryId: id, owner, repo, createdAt: new Date().toISOString(), sizeBytes, entryCount: 1}),
  )
}

describe('executeRecovery — quota and disk-space preflight refuse before building', {timeout: 30_000}, () => {
  it.skipIf(!OPENSSL_AVAILABLE)('refuses quota-exceeded at 5 generations, moving nothing', async () => {
    // #given
    await setupCleanCheckout()
    for (let i = 0; i < 5; i += 1) await createFakeGeneration(OWNER, REPO, `gen-${i}`, 1)
    const preview = await previewRecovery(req(), deps())
    if (preview.kind !== 'ok') throw new Error('unreachable')

    const fixture = await setupNetworkFixture()
    try {
      // #when
      const result = await executeRecovery(
        {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
        recoveryDeps(fixture),
      )

      // #then
      expect(result).toMatchObject({kind: 'refused', reason: 'quota-exceeded'})
      expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim().length).toBe(40)
    } finally {
      await fixture.close()
    }
  })

  it.skipIf(!OPENSSL_AVAILABLE)('refuses insufficient-disk-space before building, via an injected statfs', async () => {
    // #given
    await setupCleanCheckout()
    const preview = await previewRecovery(req(), deps())
    if (preview.kind !== 'ok') throw new Error('unreachable')
    const statfsFn = async () => ({bavail: 1, bsize: 1})

    const fixture = await setupNetworkFixture()
    try {
      // #when
      const result = await executeRecovery(
        {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
        recoveryDeps(fixture, {statfsFn}),
      )

      // #then
      expect(result).toEqual({kind: 'refused', reason: 'insufficient-disk-space'})
      expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim().length).toBe(40)
    } finally {
      await fixture.close()
    }
  })
})

describe('executeRecovery — E4a: an incomplete size walk at confirm time refuses, never admits a lower bound', () => {
  it.skipIf(!OPENSSL_AVAILABLE)(
    'refuses inspection-failed when the walk was incomplete at preview time, even though the fingerprint still matches',
    async () => {
      // #given a checkout large enough that a 1ms walk budget cannot finish
      await setupCleanCheckout()
      for (let i = 0; i < 2_000; i += 1) {
        await writeFile(join(destPathFor(), `extra-${i}.txt`), 'x')
      }
      const preview = await previewRecovery(req(), deps({walkDeadlineMs: 1}))
      if (preview.kind !== 'ok' || !preview.preview.inspectionSafe) throw new Error('unreachable')
      expect(preview.preview.sizeMeasurementComplete).toBe(false)

      const fixture = await setupNetworkFixture()
      try {
        // #when — confirm re-measures with the SAME tight deadline
        const result = await executeRecovery(
          {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
          recoveryDeps(fixture, {walkDeadlineMs: 1}),
        )

        // #then
        expect(result).toEqual({kind: 'failed', reason: 'inspection-failed'})
        expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim().length).toBe(40)
      } finally {
        await fixture.close()
      }
    },
  )
})

describe('executeRecovery — H4: an unconfirmed PRE-RENAME walk aborts before any mutation', () => {
  it.skipIf(!OPENSSL_AVAILABLE)(
    'the original stays at its canonical path, no envelope is created, the hold is set, and the journal is kept',
    async () => {
      // #given a normal, safely-inspectable checkout
      await setupCleanCheckout()
      const preview = await previewRecovery(req(), deps())
      if (preview.kind !== 'ok' || !preview.preview.inspectionSafe) throw new Error('unreachable')

      const fixture = await setupNetworkFixture()
      try {
        // #given — the FIRST walk (confirm-time preview re-derivation) succeeds normally; the
        // SECOND walk (quarantine's own pre-rename measurement) reports termination-unconfirmed
        let walkCalls = 0
        const walkRunner: AgentWalkRunner = async options => {
          walkCalls += 1
          if (walkCalls === 2) return {kind: 'termination-unconfirmed'}
          return runAgentWalk(options)
        }

        // #when
        const result = await executeRecovery(
          {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
          recoveryDeps(fixture, {walkRunner}),
        )

        // #then
        expect(result).toEqual({kind: 'failed', reason: 'termination-unconfirmed'})
        expect(walkCalls).toBeGreaterThanOrEqual(2)
        // #and — the original is untouched at its canonical path
        expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim().length).toBe(40)
        // #and — no quarantine envelope was ever created
        const quarantineRepoDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'quarantine', `${OWNER}__${REPO}`)
        expect(existsSync(quarantineRepoDir)).toBe(false)
        // #and — the repo hold is set
        expect(repoHoldReason(repoMutexKey(OWNER, REPO))).toBe('termination-unconfirmed')
        // #and — the journal from the in-flight recovery is KEPT, never cleared
        const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
        expect((await readJournal(journalsDir, OWNER, REPO)).ok).toBe(true)
      } finally {
        await fixture.close()
      }
    },
  )
})

describe('executeRecovery — E4: retention accounting fails closed', () => {
  it.skipIf(!OPENSSL_AVAILABLE)(
    'refuses quota-exceeded when an existing generation has unknown (malformed-metadata) size, even with room left on paper',
    async () => {
      // #given one generation with valid, tiny metadata (nowhere near quota) but a SECOND with malformed metadata
      await setupCleanCheckout()
      await createFakeGeneration(OWNER, REPO, 'gen-good', 1)
      const dir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'quarantine', `${OWNER}__${REPO}`, 'gen-bad')
      await mkdir(dir, {recursive: true})
      await writeFile(join(dir, 'metadata.json'), '{not valid json')
      const preview = await previewRecovery(req(), deps())
      if (preview.kind !== 'ok') throw new Error('unreachable')

      const fixture = await setupNetworkFixture()
      try {
        // #when
        const result = await executeRecovery(
          {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
          recoveryDeps(fixture),
        )

        // #then
        expect(result).toMatchObject({kind: 'refused', reason: 'quota-exceeded'})
      } finally {
        await fixture.close()
      }
    },
  )
})

describe('executeRecovery — no checkout installs without quarantine', {timeout: 30_000}, () => {
  it.skipIf(!OPENSSL_AVAILABLE)('installs a fresh checkout with no prior generation written', async () => {
    // #given no checkout at all for this owner/repo
    const preview = await previewRecovery(req(), deps())
    expect(preview).toEqual({kind: 'no-checkout'})

    const fixture = await setupNetworkFixture()
    try {
      // #when
      const result = await executeRecovery({...recoverReq(fixture), fingerprint: ''}, recoveryDeps(fixture))

      // #then
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') throw new Error('unreachable')
      expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()).toBe(fixture.headSha)
      const backupsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'quarantine', `${OWNER}__${REPO}`)
      await expect(readFile(join(backupsDir, result.recoveryId, 'metadata.json'), 'utf8')).rejects.toThrow()
    } finally {
      await fixture.close()
    }
  })
})

describe('executeRecovery — concurrency serializes with itself and with executeUpdate', {timeout: 30_000}, () => {
  it.skipIf(!OPENSSL_AVAILABLE)(
    'a second concurrent recover, started with the same (now-stale) fingerprint, is fully serialized behind the first',
    async () => {
      // #given
      await setupCleanCheckout()
      const preview = await previewRecovery(req(), deps())
      if (preview.kind !== 'ok') throw new Error('unreachable')
      const fixture = await setupNetworkFixture()
      try {
        // #when — both start in the same tick; the per-repo mutex must fully serialize them
        const [first, second] = await Promise.all([
          executeRecovery({...recoverReq(fixture), fingerprint: preview.preview.fingerprint}, recoveryDeps(fixture)),
          executeRecovery({...recoverReq(fixture), fingerprint: preview.preview.fingerprint}, recoveryDeps(fixture)),
        ])

        // #then — one recovers; the other, running only AFTER the first fully finished, sees the
        // ALREADY-RECOVERED checkout and refuses on its own now-stale fingerprint. Never both `ok`.
        const kinds = [first.kind, second.kind].sort()
        expect(kinds).toEqual(['ok', 'refused'])
        const refused = first.kind === 'refused' ? first : second
        expect(refused).toEqual({kind: 'refused', reason: 'checkout-changed'})
      } finally {
        await fixture.close()
      }
    },
  )

  it.skipIf(!OPENSSL_AVAILABLE)(
    'recover and update on the same repo serialize — update sees the post-recovery state',
    async () => {
      // #given
      await setupCleanCheckout()
      const preview = await previewRecovery(req(), deps())
      if (preview.kind !== 'ok') throw new Error('unreachable')
      const fixture = await setupNetworkFixture()
      const host = new URL(fixture.remoteBaseUrl).host
      try {
        // #when
        const [recovered, updated] = await Promise.all([
          executeRecovery({...recoverReq(fixture), fingerprint: preview.preview.fingerprint}, recoveryDeps(fixture)),
          executeUpdate(
            {owner: OWNER, repo: REPO, token: fixture.token},
            {
              reposRoot,
              options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
              remoteBaseUrl: fixture.remoteBaseUrl,
              caBundlePath: fixture.caBundlePath,
              askpassWriter: async d => writeLoopbackAskpassHelper(d, host),
              serviceHome: checkoutHome,
            },
          ),
        ])

        // #then — recovery wins the lock first (called first, synchronous acquire); update, having
        // waited for the lock, runs against the recovered checkout and reports it unchanged.
        expect(recovered.kind).toBe('ok')
        expect(updated).toMatchObject({kind: 'ready', change: 'unchanged'})
      } finally {
        await fixture.close()
      }
    },
  )
})

describe(
  'executeRecovery — unconfirmed subprocess termination holds the repo and keeps the journal',
  {timeout: 30_000},
  () => {
    it.skipIf(!OPENSSL_AVAILABLE)(
      'an unconfirmed termination during the build phase fails termination-unconfirmed, sets the hold, and never clears the journal',
      async () => {
        // #given a clean checkout and a packStreamRunner whose only call reports uncertainty
        await setupCleanCheckout()
        const preview = await previewRecovery(req(), deps())
        if (preview.kind !== 'ok') throw new Error('unreachable')
        const packStreamRunner = async () => ({kind: 'termination-unconfirmed'}) as const

        const fixture = await setupNetworkFixture()
        try {
          // #when
          const result = await executeRecovery(
            {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
            recoveryDeps(fixture, {packStreamRunner}),
          )

          // #then
          expect(result).toEqual({kind: 'failed', reason: 'termination-unconfirmed'})
          expect(repoHoldReason(repoMutexKey(OWNER, REPO))).toBe('termination-unconfirmed')
          const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
          const journal = await readJournal(journalsDir, OWNER, REPO)
          expect(journal.ok).toBe(true)
          if (!journal.ok) throw new Error('unreachable')
          expect(journal.journal.phase).toBe('building')
          // #and — the original checkout was never touched
          if (!preview.preview.inspectionSafe) throw new Error('unreachable')
          expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()).toBe(
            preview.preview.headSha,
          )
        } finally {
          await fixture.close()
        }
      },
    )

    it.skipIf(!OPENSSL_AVAILABLE)(
      'an unconfirmed bare-store init (before ANY journal exists) still holds the repository via the shared D1 choke point',
      async () => {
        // #given a normal preview for a valid fingerprint, then a gitRunner whose bare fetch-store
        // `git init --bare` call — the very first mutating call `runRecoveryMutation` makes, before
        // any journal is written — reports uncertainty
        await setupCleanCheckout()
        const preview = await previewRecovery(req(), deps())
        if (preview.kind !== 'ok') throw new Error('unreachable')
        const forgingRunner: GitRunnerFn = async (args, options) => {
          if (args.includes('init') && args.includes('--bare')) return {kind: 'termination-unconfirmed'}
          return runGit(args, options)
        }

        const fixture = await setupNetworkFixture()
        try {
          // #when
          const result = await executeRecovery(
            {...recoverReq(fixture), fingerprint: preview.preview.fingerprint},
            recoveryDeps(fixture, {gitRunner: forgingRunner}),
          )

          // #then — the shared choke point (update.ts's `runTrackedInvocation`) overrides the naive
          // `fetch-failed` result and sets the hold, even though nothing was ever journaled.
          expect(result).toEqual({kind: 'failed', reason: 'termination-unconfirmed'})
          expect(repoHoldReason(repoMutexKey(OWNER, REPO))).toBe('termination-unconfirmed')
        } finally {
          await fixture.close()
        }
      },
    )
  },
)

interface ManifestEntry {
  readonly path: string
  readonly type: 'file' | 'dir' | 'symlink' | 'other'
  readonly mode: number
  readonly size: number
  readonly sha256: string | undefined
  readonly symlinkTarget: string | undefined
}

/** (E9) A complete content-manifest of `root`: relative path, type, mode, size, sha256 of bytes (files only), symlink target (symlinks only). Sorted for a stable comparison. */
async function buildContentManifest(root: string): Promise<readonly ManifestEntry[]> {
  const entries: ManifestEntry[] = []
  async function walk(relPath: string): Promise<void> {
    const absPath = join(root, relPath)
    const st = await lstat(absPath)
    const mode = st.mode & 0o777
    if (st.isSymbolicLink()) {
      const target = await readlink(absPath)
      entries.push({path: relPath, type: 'symlink', mode, size: st.size, sha256: undefined, symlinkTarget: target})
      return
    }
    if (st.isDirectory()) {
      entries.push({path: relPath, type: 'dir', mode, size: 0, sha256: undefined, symlinkTarget: undefined})
      const names = await readdir(absPath)
      for (const name of [...names].sort()) await walk(relPath === '.' ? name : join(relPath, name))
      return
    }
    let fileSt = st
    let sha256: string | undefined
    if (st.isFile()) {
      // Read and capture metadata from the same descriptor; O_NOFOLLOW prevents a path swap to a
      // symlink between lstat and open from escaping the manifest root.
      const handle = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        fileSt = await handle.stat()
        if (!fileSt.isFile()) throw new Error(`Expected regular file while building manifest: ${relPath}`)
        sha256 = createHash('sha256')
          .update(await handle.readFile())
          .digest('hex')
      } finally {
        await handle.close()
      }
    }
    entries.push({
      path: relPath,
      type: st.isFile() ? 'file' : 'other',
      mode: fileSt.mode & 0o777,
      size: fileSt.size,
      sha256,
      symlinkTarget: undefined,
    })
  }
  await walk('.')
  return [...entries].sort((a, b) => a.path.localeCompare(b.path))
}

/** (E9) Asserts agent ownership ONLY when this test process itself runs as root — setuid to a non-root uid is otherwise a no-op the OS silently refuses outside a real container, exactly like every other uid/gid assertion in this suite. */
function assertAgentOwnedIfRoot(path: string): void {
  if (process.getuid?.() !== 0) return
  const st = statSync(path)
  expect(st.uid).toBe(AGENT_UID)
  expect(st.gid).toBe(AGENT_GID)
}

const noopLogger = {info: () => {}, warn: () => {}, error: () => {}}

function stagingPathFor(recoveryId: string): string {
  return join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'staging', `recover-${recoveryId}`)
}

/** A real, minimal git repo at `path` \u2014 stands in for a completed (or partial) staging build during crash-reconciliation tests. */
function createStagingCheckout(path: string, branch = 'main'): string {
  mkdirSync(path, {recursive: true})
  initRepo(path, isolatedGitEnv(checkoutHome), branch)
  return commitFile(path, isolatedGitEnv(checkoutHome), 'README.md', 'recovered\n', 'recovered commit')
}

describe('reconcileRecoveryJournalsOnStartup — D1: exceptions bypass the hold', () => {
  it('an unconfirmed termination followed by an unexpected throw still holds the repository and leaves its journal in place', async () => {
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const recoveryId = 'gen-d1'
    await mkdir(join(reposRoot, OWNER), {recursive: true})
    const installedSha = createStagingCheckout(destPathFor())
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: OWNER,
      repo: REPO,
      phase: 'verifying',
      recoveryId,
      targetSha: installedSha,
      branch: 'main',
      startedAt: new Date().toISOString(),
    })
    const forgingRunner: GitRunnerFn = async (args, options) => {
      if (args.includes('rev-parse') && args.includes('--verify')) return {kind: 'termination-unconfirmed'}
      return runGit(args, options)
    }
    let warnCalls = 0
    const throwingLogger = {
      info: () => {},
      warn: () => {
        warnCalls += 1
        if (warnCalls === 1) throw new Error('boom: logger misbehaved')
      },
      error: () => {},
    }

    await expect(
      reconcileRecoveryJournalsOnStartup({
        reposRoot,
        gitRunner: forgingRunner,
        options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
        logger: throwingLogger,
      }),
    ).resolves.toBeUndefined()

    expect((await readJournal(journalsDir, OWNER, REPO)).ok).toBe(true)
    expect(repoHoldReason(repoMutexKey(OWNER, REPO))).toBe('termination-unconfirmed')
    expect(warnCalls).toBe(2)
  })
})

describe('reconcileRecoveryJournalsOnStartup — crash reconciliation at each phase boundary', () => {
  it('building: removes the partial staging dir and clears the journal; the original (if any) is untouched', async () => {
    // #given
    const {headSha} = await setupCleanCheckout()
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const recoveryId = 'gen-building'
    mkdirSync(stagingPathFor(recoveryId), {recursive: true})
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: OWNER,
      repo: REPO,
      phase: 'building',
      recoveryId,
      targetSha: '1'.repeat(40),
      branch: 'main',
      startedAt: new Date().toISOString(),
    })

    // #when
    await reconcileRecoveryJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: noopLogger,
    })

    // #then
    const journal = await readJournal(journalsDir, OWNER, REPO)
    expect(journal.ok).toBe(false)
    expect(existsSync(stagingPathFor(recoveryId))).toBe(false)
    expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()).toBe(headSha)
  })

  it('quarantining: the original (still at the checkout path) is moved to quarantine, then staging installs and verifies', async () => {
    // #given the original checkout is still at the canonical path, and a completed staging build
    // already exists at the deterministic recovery path
    await setupCleanCheckout()
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const recoveryId = 'gen-quarantining'
    const recoveredSha = createStagingCheckout(stagingPathFor(recoveryId))
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: OWNER,
      repo: REPO,
      phase: 'quarantining',
      recoveryId,
      targetSha: recoveredSha,
      branch: 'main',
      startedAt: new Date().toISOString(),
    })

    // #when
    await reconcileRecoveryJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: noopLogger,
    })

    // #then — journal cleared, original preserved (metadataOk:false is acceptable — evidence was
    // no longer available at reconciliation time), staging installed and verified
    const journal = await readJournal(journalsDir, OWNER, REPO)
    expect(journal.ok).toBe(false)
    const quarantinePath = join(
      reposRoot,
      WORKSPACE_STATE_DIR_NAME,
      'quarantine',
      `${OWNER}__${REPO}`,
      recoveryId,
      'checkout',
    )
    expect(existsSync(join(quarantinePath, '.git'))).toBe(true)
    expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()).toBe(recoveredSha)
    expect(existsSync(stagingPathFor(recoveryId))).toBe(false)
  })

  it('installing: the checkout path is empty and staging is complete — staging is renamed into place and verified', async () => {
    // #given no checkout at the canonical path (already quarantined in a real recovery), staging complete
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const recoveryId = 'gen-installing'
    const recoveredSha = createStagingCheckout(stagingPathFor(recoveryId))
    await mkdir(join(reposRoot, OWNER), {recursive: true})
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: OWNER,
      repo: REPO,
      phase: 'installing',
      recoveryId,
      targetSha: recoveredSha,
      branch: 'main',
      startedAt: new Date().toISOString(),
    })

    // #when
    await reconcileRecoveryJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: noopLogger,
    })

    // #then
    const journal = await readJournal(journalsDir, OWNER, REPO)
    expect(journal.ok).toBe(false)
    expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()).toBe(recoveredSha)
    expect(existsSync(stagingPathFor(recoveryId))).toBe(false)
  })

  it('verifying: the fresh checkout is already installed — verified and the journal cleared', async () => {
    // #given the fresh checkout is already fully installed at the canonical path
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const recoveryId = 'gen-verifying'
    await mkdir(join(reposRoot, OWNER), {recursive: true})
    const recoveredSha = createStagingCheckout(destPathFor())
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: OWNER,
      repo: REPO,
      phase: 'verifying',
      recoveryId,
      targetSha: recoveredSha,
      branch: 'main',
      startedAt: new Date().toISOString(),
    })

    // #when
    await reconcileRecoveryJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: noopLogger,
    })

    // #then
    const journal = await readJournal(journalsDir, OWNER, REPO)
    expect(journal.ok).toBe(false)
    expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()).toBe(recoveredSha)
  })

  it('(D5) verifying: an installed checkout at the WRONG target sha is left in place, never cleared', async () => {
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const recoveryId = 'gen-verifying-mismatch'
    await mkdir(join(reposRoot, OWNER), {recursive: true})
    createStagingCheckout(destPathFor())
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: OWNER,
      repo: REPO,
      phase: 'verifying',
      recoveryId,
      targetSha: '1'.repeat(40),
      branch: 'main',
      startedAt: new Date().toISOString(),
    })

    await reconcileRecoveryJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: noopLogger,
    })

    expect((await readJournal(journalsDir, OWNER, REPO)).ok).toBe(true)
  })

  it('(D5) installing: both the checkout path and the staging directory are missing — left in place, never reports success', async () => {
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const recoveryId = 'gen-installing-both-missing'
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: OWNER,
      repo: REPO,
      phase: 'installing',
      recoveryId,
      targetSha: '1'.repeat(40),
      branch: 'main',
      startedAt: new Date().toISOString(),
    })

    await reconcileRecoveryJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: noopLogger,
    })

    expect((await readJournal(journalsDir, OWNER, REPO)).ok).toBe(true)
    expect(existsSync(destPathFor())).toBe(false)
  })
})

describe('reconcileRecoveryJournalsOnStartup — G3: sealed-fallback termination-unconfirmed stops replay and sets the hold', () => {
  it('an injected sealed walker reporting termination-unconfirmed leaves the journal untouched, installs nothing, and sets the repo hold', async () => {
    // #given the rename half is already done (checkout/ populated, no original left at the
    // canonical path) and metadata.json is absent — exactly the F7 scenario that reaches the
    // sealed-tree fallback, since the envelope's ancestors block a plain agent-uid pathname walk.
    await setupCleanCheckout()
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const recoveryId = 'gen-g3'
    const recoveredSha = createStagingCheckout(stagingPathFor(recoveryId))
    const envelopePath = join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'quarantine', `${OWNER}__${REPO}`, recoveryId)
    await mkdir(join(envelopePath, 'checkout'), {recursive: true})
    await rename(destPathFor(), join(envelopePath, 'checkout'))
    const originalJournal = {
      kind: 'recovery' as const,
      owner: OWNER,
      repo: REPO,
      phase: 'quarantining' as const,
      recoveryId,
      targetSha: recoveredSha,
      branch: 'main',
      startedAt: new Date().toISOString(),
    }
    await writeJournal(journalsDir, originalJournal)

    // #when — the injected sealed walker reports uncertainty instead of a real measurement
    await reconcileRecoveryJournalsOnStartup({
      reposRoot,
      sealedWalkRunner: async () => ({kind: 'termination-unconfirmed'}),
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: noopLogger,
    })

    // #then — journal unchanged (still `quarantining`, still present), no metadata written,
    // nothing installed at the canonical path, and the repo hold is set
    expect(await readJournal(journalsDir, OWNER, REPO)).toEqual({ok: true, journal: originalJournal})
    expect(existsSync(join(envelopePath, 'metadata.json'))).toBe(false)
    expect(existsSync(destPathFor())).toBe(false)
    expect(repoHoldReason(repoMutexKey(OWNER, REPO))).toBe('termination-unconfirmed')
  })
})

describe('reconcileRecoveryJournalsOnStartup — F7: completes missing metadata even when the rename already happened', () => {
  it('a replay whose PRIOR attempt already renamed checkout/ but crashed before writing metadata.json still writes it', async () => {
    // #given the rename half is already done (a prior replay attempt got this far and crashed) --
    // `checkout/` is populated, but metadata.json was never written.
    await setupCleanCheckout()
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const recoveryId = 'gen-f7'
    const recoveredSha = createStagingCheckout(stagingPathFor(recoveryId))
    const envelopePath = join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'quarantine', `${OWNER}__${REPO}`, recoveryId)
    await mkdir(join(envelopePath, 'checkout'), {recursive: true})
    await rename(destPathFor(), join(envelopePath, 'checkout'))
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: OWNER,
      repo: REPO,
      phase: 'quarantining',
      recoveryId,
      targetSha: recoveredSha,
      branch: 'main',
      startedAt: new Date().toISOString(),
    })

    // #when
    await reconcileRecoveryJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: noopLogger,
    })

    // #then — metadata.json now exists and parses; the rename was NOT re-attempted (idempotent)
    expect(existsSync(join(envelopePath, 'metadata.json'))).toBe(true)
    const metadata = JSON.parse(await readFile(join(envelopePath, 'metadata.json'), 'utf8')) as {source: string}
    expect(metadata.source).toBe('reconciliation')
    expect(existsSync(join(envelopePath, 'checkout', '.git'))).toBe(true)
    expect(gitSync(destPathFor(), ['rev-parse', 'HEAD'], isolatedGitEnv(checkoutHome)).trim()).toBe(recoveredSha)
  })

  it('a replay whose PRIOR attempt already wrote VALID metadata never overwrites it (source/provenance preserved)', async () => {
    await setupCleanCheckout()
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const recoveryId = 'gen-f7-valid'
    const recoveredSha = createStagingCheckout(stagingPathFor(recoveryId))
    const envelopePath = join(reposRoot, WORKSPACE_STATE_DIR_NAME, 'quarantine', `${OWNER}__${REPO}`, recoveryId)
    await mkdir(join(envelopePath, 'checkout'), {recursive: true})
    await rename(destPathFor(), join(envelopePath, 'checkout'))
    const validMetadata = {
      recoveryId,
      owner: OWNER,
      repo: REPO,
      createdAt: new Date().toISOString(),
      sizeBytes: 123,
      entryCount: 4,
      sizeComplete: true,
      source: 'recovery',
      originalHeadSha: 'a'.repeat(40),
      originalBranch: 'main',
    }
    await writeFile(join(envelopePath, 'metadata.json'), JSON.stringify(validMetadata))
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: OWNER,
      repo: REPO,
      phase: 'quarantining',
      recoveryId,
      targetSha: recoveredSha,
      branch: 'main',
      startedAt: new Date().toISOString(),
    })

    await reconcileRecoveryJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: noopLogger,
    })

    const metadata = JSON.parse(await readFile(join(envelopePath, 'metadata.json'), 'utf8')) as {
      source: string
      originalHeadSha: string
    }
    expect(metadata.source).toBe('recovery')
    expect(metadata.originalHeadSha).toBe('a'.repeat(40))
  })
})

describe('executeRecovery — F3: a confirmed pre-quarantine failure restores the superseded update journal', () => {
  it.skipIf(!OPENSSL_AVAILABLE)(
    'a confirmed build failure restores the ORIGINAL update journal, and /update then refuses needs-recovery',
    async () => {
      await setupCleanCheckout()
      const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
      const updateJournal = {
        kind: 'update' as const,
        owner: OWNER,
        repo: REPO,
        phase: 'applying' as const,
        fromSha: '0'.repeat(40),
        toSha: '1'.repeat(40),
        startedAt: new Date().toISOString(),
      }
      await writeJournal(journalsDir, updateJournal)
      const preview = await previewRecovery(req(), deps())
      if (preview.kind !== 'recoverable-update') throw new Error('unreachable')

      const fixture = await setupNetworkFixture()
      try {
        const packStreamRunner = async () =>
          ({
            kind: 'failed',
            reason: 'writer-failed',
            writer: {exitCode: 1, signal: null},
            reader: {exitCode: null, signal: null},
          }) as const
        const result = await executeRecovery(
          {...recoverReq(fixture), fingerprint: preview.update.fingerprint},
          recoveryDeps(fixture, {packStreamRunner}),
        )

        expect(result).toEqual({kind: 'failed', reason: 'build-failed'})
        const journal = await readJournal(journalsDir, OWNER, REPO)
        expect(journal).toEqual({ok: true, journal: updateJournal})

        const host = new URL(fixture.remoteBaseUrl).host
        const updateResult = await executeUpdate(
          {owner: OWNER, repo: REPO, token: fixture.token},
          {
            reposRoot,
            options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
            remoteBaseUrl: fixture.remoteBaseUrl,
            caBundlePath: fixture.caBundlePath,
            askpassWriter: async d => writeLoopbackAskpassHelper(d, host),
            serviceHome: checkoutHome,
          },
        )
        expect(updateResult).toEqual({kind: 'refused', reason: 'needs-recovery'})
      } finally {
        await fixture.close()
      }
    },
  )

  it('a crash-then-reconcile at the building phase restores the superseded update journal', async () => {
    await mkdir(join(reposRoot, OWNER), {recursive: true})
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const updateJournal = {
      kind: 'update' as const,
      owner: OWNER,
      repo: REPO,
      phase: 'applying' as const,
      fromSha: '0'.repeat(40),
      toSha: '1'.repeat(40),
      startedAt: new Date().toISOString(),
    }
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner: OWNER,
      repo: REPO,
      phase: 'building',
      recoveryId: 'gen-f3',
      targetSha: '2'.repeat(40),
      branch: 'main',
      startedAt: new Date().toISOString(),
      supersededUpdate: updateJournal,
    })

    await reconcileRecoveryJournalsOnStartup({
      reposRoot,
      options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
      logger: noopLogger,
    })

    const journal = await readJournal(journalsDir, OWNER, REPO)
    expect(journal).toEqual({ok: true, journal: updateJournal})
  })
})

describe('executeRecovery — E2: recovers an interrupted UPDATE journal', () => {
  it.skipIf(!OPENSSL_AVAILABLE)(
    'update stuck at applying \u2192 preview shows it recoverable \u2192 recover succeeds \u2192 a follow-up /update then returns unchanged',
    async () => {
      // #given a checkout with an interrupted update journal (phase: applying) \u2014 /update itself
      // would refuse this as needs-recovery
      await setupCleanCheckout()
      const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
      await writeJournal(journalsDir, {
        kind: 'update',
        owner: OWNER,
        repo: REPO,
        phase: 'applying',
        fromSha: '0'.repeat(40),
        toSha: '1'.repeat(40),
        startedAt: new Date().toISOString(),
      })

      const preview = await previewRecovery(req(), deps())
      expect(preview).toEqual({
        kind: 'recoverable-update',
        update: {
          phase: 'applying',
          fromSha: '0'.repeat(40),
          toSha: '1'.repeat(40),
          startedAt: expect.any(String) as string,
          estimatedSizeBytes: expect.any(Number) as number,
          entryCount: expect.any(Number) as number,
          sizeMeasurementComplete: true,
          fingerprint: expect.any(String) as string,
        },
      })
      if (preview.kind !== 'recoverable-update') throw new Error('unreachable')

      const fixture = await setupNetworkFixture()
      try {
        // #when
        const result = await executeRecovery(
          {...recoverReq(fixture), fingerprint: preview.update.fingerprint},
          recoveryDeps(fixture),
        )

        // #then
        expect(result.kind).toBe('ok')
        if (result.kind !== 'ok') throw new Error('unreachable')
        expect(result.sha).toBe(fixture.headSha)
        // #and — the old update journal is gone (superseded, then cleared on recovery success)
        expect((await readJournal(journalsDir, OWNER, REPO)).ok).toBe(false)

        // #and — a follow-up /update sees the recovered checkout as unchanged
        const host = new URL(fixture.remoteBaseUrl).host
        const updateResult = await executeUpdate(
          {owner: OWNER, repo: REPO, token: fixture.token},
          {
            reposRoot,
            options: {uid: process.getuid?.(), gid: process.getgid?.(), timeoutMs: 10_000},
            remoteBaseUrl: fixture.remoteBaseUrl,
            caBundlePath: fixture.caBundlePath,
            askpassWriter: async d => writeLoopbackAskpassHelper(d, host),
            serviceHome: checkoutHome,
          },
        )
        expect(updateResult).toMatchObject({kind: 'ready', change: 'unchanged'})
      } finally {
        await fixture.close()
      }
    },
  )

  it.skipIf(!OPENSSL_AVAILABLE)(
    'regression: a second, normal recovery succeeds after an interrupted-update recovery -- the generation is never permanently hasUnknownSize',
    async () => {
      await setupCleanCheckout()
      const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
      await writeJournal(journalsDir, {
        kind: 'update',
        owner: OWNER,
        repo: REPO,
        phase: 'applying',
        fromSha: '0'.repeat(40),
        toSha: '1'.repeat(40),
        startedAt: new Date().toISOString(),
      })
      const firstPreview = await previewRecovery(req(), deps())
      if (firstPreview.kind !== 'recoverable-update') throw new Error('unreachable')

      const fixture = await setupNetworkFixture()
      try {
        const first = await executeRecovery(
          {...recoverReq(fixture), fingerprint: firstPreview.update.fingerprint},
          recoveryDeps(fixture),
        )
        expect(first.kind).toBe('ok')

        const backups = await listBackups(OWNER, REPO, {reposRoot})
        expect(backups.kind).toBe('ok')
        if (backups.kind !== 'ok') throw new Error('unreachable')
        expect(backups.backups).toHaveLength(1)
        expect(backups.backups[0]?.metadataOk).toBe(true)
        expect(backups.backups[0]?.sizeComplete).toBe(true)

        const secondPreview = await previewRecovery(req(), deps())
        if (secondPreview.kind !== 'ok') throw new Error('unreachable')
        const second = await executeRecovery(
          {...recoverReq(fixture), fingerprint: secondPreview.preview.fingerprint},
          recoveryDeps(fixture),
        )

        expect(second.kind).toBe('ok')
      } finally {
        await fixture.close()
      }
    },
  )
  it.skipIf(!OPENSSL_AVAILABLE)(
    'a RECOVERY journal in progress still refuses outright, never treated as recoverable',
    async () => {
      // #given
      await setupCleanCheckout()
      const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
      await writeJournal(journalsDir, {
        kind: 'recovery',
        owner: OWNER,
        repo: REPO,
        phase: 'quarantining',
        recoveryId: 'gen-1',
        targetSha: '1'.repeat(40),
        branch: 'main',
        startedAt: new Date().toISOString(),
      })

      // #when
      const result = await previewRecovery(req(), deps())

      // #then
      expect(result).toEqual({kind: 'refused', reason: 'journal-in-progress', phase: 'quarantining'})
    },
  )
})
