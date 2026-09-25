/**
 * Smoke test for the local HTTPS git-http-backend fixture (git-http-server.ts) — proves the seam
 * works through the PRODUCTION network profile builder (`buildNetworkGitProfile`, git-safety.ts),
 * the exact function `/update` (Unit 4) will use against `https://github.com`.
 *
 * Askpass seam: production's `writeAskpassHelper` (clone.ts) only answers for the exact literal
 * host `github.com` — deliberately, so a redirect can never make it answer for an attacker-chosen
 * host (see clone.askpass.test.ts). This fixture serves `https://127.0.0.1:<port>`, which that
 * helper will never match, so every test here writes its OWN askpass script via
 * `writeLoopbackAskpassHelper`, parameterized on this fixture's own loopback host — see that
 * function's doc comment in git-http-server.ts for why parameterizing is safe there and nowhere
 * else. `buildNetworkGitProfile` itself is exercised completely unmodified.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'
import {buildNetworkGitProfile} from '../git-safety.js'
import {bareRepoPath, startGitHttpServer, writeLoopbackAskpassHelper} from './git-http-server.js'
import {commitFile, gitAsync, gitSync, initRepo, isolatedGitEnv, makeTempDir, opensslAvailable} from './helpers.js'

/** Computed once at module load: this fixture's self-signed cert needs a real `openssl` binary — reported as a skip, not a silent pass, when unavailable (mirrors transport.test.ts's own gate). */
const OPENSSL_AVAILABLE = opensslAvailable()

const OWNER = 'acme'
const REPO = 'widgets'

interface Fixture {
  readonly reposRoot: string
  readonly sourceSha: string
  readonly fetchStoreDir: string
  readonly serviceHome: string
  readonly askpassDir: string
  readonly cleanup: () => Promise<void>
}

/**
 * Builds the source-of-truth bare repo the fixture will serve at `<reposRoot>/<owner>/<repo>.git`
 * (populated by pushing a real commit from a throwaway working repo), plus a separate, empty bare
 * "fetch store" repo standing in for the protected bare mirror `/update` fetches INTO. Returns the
 * expected default-branch SHA and every directory a test needs, plus one `cleanup()` for all of
 * them.
 */
async function setupFixture(): Promise<Fixture> {
  const reposRoot = await makeTempDir('git-http-server-repos-')
  const fetchStoreDir = await makeTempDir('git-http-server-fetchstore-')
  const serviceHome = await makeTempDir('git-http-server-service-home-')
  const askpassDir = await makeTempDir('git-http-server-askpass-')
  const workDir = await mkdtemp(join(os.tmpdir(), 'git-http-server-work-'))
  const workHome = await mkdtemp(join(os.tmpdir(), 'git-http-server-work-home-'))

  const remotePath = await bareRepoPath(reposRoot, OWNER, REPO)
  gitSync(reposRoot, ['init', '-q', '--bare', '-b', 'main', remotePath], isolatedGitEnv(serviceHome))

  initRepo(workDir, isolatedGitEnv(workHome), 'main')
  const sourceSha = commitFile(workDir, isolatedGitEnv(workHome), 'README.md', 'hello\n', 'initial commit')
  gitSync(workDir, ['push', '-q', remotePath, 'main'], isolatedGitEnv(workHome))

  gitSync(fetchStoreDir, ['init', '-q', '--bare'], isolatedGitEnv(serviceHome))

  return {
    reposRoot,
    sourceSha,
    fetchStoreDir,
    serviceHome,
    askpassDir,
    async cleanup() {
      await Promise.all(
        [reposRoot, fetchStoreDir, serviceHome, askpassDir, workDir, workHome].map(async dir =>
          rm(dir, {recursive: true, force: true}),
        ),
      )
    },
  }
}

describe.skipIf(!OPENSSL_AVAILABLE)('git-http-server fixture — through the production network profile', () => {
  let fixture: Fixture | undefined

  afterEach(async () => {
    if (fixture !== undefined) {
      await fixture.cleanup()
      fixture = undefined
    }
  })

  it('auth required, right token: ls-remote and fetch both succeed and land the expected SHA', async () => {
    // #given a server that requires Basic auth with a known token
    fixture = await setupFixture()
    const server = await startGitHttpServer({reposRoot: fixture.reposRoot, requireToken: 'right-token'})
    try {
      const host = new URL(server.baseUrl).host
      const askpassPath = await writeLoopbackAskpassHelper(fixture.askpassDir, host)
      const profile = buildNetworkGitProfile({
        bareRepoPath: fixture.fetchStoreDir,
        serviceHome: fixture.serviceHome,
        askpassPath,
        token: 'right-token',
        caBundlePath: server.caBundlePath,
        parentEnv: process.env,
      })
      const url = `${server.baseUrl}/${OWNER}/${REPO}.git`

      // #when — ls-remote --symref, exactly what /update's first observation will run
      const lsRemote = await gitAsync(profile.cwd, [...profile.args, 'ls-remote', '--symref', url, 'HEAD'], profile.env)

      // #then
      expect(lsRemote.ok, `ls-remote failed: ${lsRemote.stderr}`).toBe(true)
      expect(lsRemote.stdout).toContain('ref: refs/heads/main\tHEAD')
      expect(lsRemote.stdout).toContain(`${fixture.sourceSha}\tHEAD`)

      // #when — fetch the default branch into a unique ref, exactly what /update's apply-source
      // fetch will run
      const fetchOutcome = await gitAsync(
        profile.cwd,
        [...profile.args, 'fetch', url, 'main:refs/update/smoke-test'],
        profile.env,
      )

      // #then
      expect(fetchOutcome.ok, `fetch failed: ${fetchOutcome.stderr}`).toBe(true)
      const landedSha = gitSync(
        fixture.fetchStoreDir,
        ['rev-parse', 'refs/update/smoke-test'],
        isolatedGitEnv(fixture.serviceHome),
      ).trim()
      expect(landedSha).toBe(fixture.sourceSha)
    } finally {
      await server.close()
    }
  })

  it('auth required, wrong token: ls-remote fails and never leaks the checkout into a fetched state', async () => {
    // #given a server that requires a specific token, and a profile carrying a DIFFERENT one
    fixture = await setupFixture()
    const server = await startGitHttpServer({reposRoot: fixture.reposRoot, requireToken: 'right-token'})
    try {
      const host = new URL(server.baseUrl).host
      const askpassPath = await writeLoopbackAskpassHelper(fixture.askpassDir, host)
      const profile = buildNetworkGitProfile({
        bareRepoPath: fixture.fetchStoreDir,
        serviceHome: fixture.serviceHome,
        askpassPath,
        token: 'wrong-token',
        caBundlePath: server.caBundlePath,
        parentEnv: process.env,
      })
      const url = `${server.baseUrl}/${OWNER}/${REPO}.git`

      // #when
      const lsRemote = await gitAsync(profile.cwd, [...profile.args, 'ls-remote', '--symref', url, 'HEAD'], profile.env)

      // #then
      expect(lsRemote.ok).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('404: ls-remote fails with a 404 from the fixture, no auth involved', async () => {
    // #given
    fixture = await setupFixture()
    const server = await startGitHttpServer({reposRoot: fixture.reposRoot})
    try {
      server.setFailure(`${OWNER}/${REPO}.git`, '404')
      const host = new URL(server.baseUrl).host
      const askpassPath = await writeLoopbackAskpassHelper(fixture.askpassDir, host)
      const profile = buildNetworkGitProfile({
        bareRepoPath: fixture.fetchStoreDir,
        serviceHome: fixture.serviceHome,
        askpassPath,
        token: 'unused-token',
        caBundlePath: server.caBundlePath,
        parentEnv: process.env,
      })
      const url = `${server.baseUrl}/${OWNER}/${REPO}.git`

      // #when
      const lsRemote = await gitAsync(profile.cwd, [...profile.args, 'ls-remote', '--symref', url, 'HEAD'], profile.env)

      // #then
      expect(lsRemote.ok).toBe(false)
      expect(lsRemote.stderr).toContain('404')
    } finally {
      await server.close()
    }
  })

  it('403: ls-remote fails with a 403 from the fixture', async () => {
    // #given
    fixture = await setupFixture()
    const server = await startGitHttpServer({reposRoot: fixture.reposRoot})
    try {
      server.setFailure(`${OWNER}/${REPO}.git`, '403')
      const host = new URL(server.baseUrl).host
      const askpassPath = await writeLoopbackAskpassHelper(fixture.askpassDir, host)
      const profile = buildNetworkGitProfile({
        bareRepoPath: fixture.fetchStoreDir,
        serviceHome: fixture.serviceHome,
        askpassPath,
        token: 'unused-token',
        caBundlePath: server.caBundlePath,
        parentEnv: process.env,
      })
      const url = `${server.baseUrl}/${OWNER}/${REPO}.git`

      // #when
      const lsRemote = await gitAsync(profile.cwd, [...profile.args, 'ls-remote', '--symref', url, 'HEAD'], profile.env)

      // #then
      expect(lsRemote.ok).toBe(false)
      expect(lsRemote.stderr).toContain('403')
    } finally {
      await server.close()
    }
  })
})
