/**
 * Real-execution regression tests for `writeAskpassHelper` and `buildCloneGitEnv`.
 *
 * `clone.test.ts` mocks `node:fs/promises` and `execFile` at module level, so it can only
 * assert *what arguments the code passed* (e.g. mode 0o600 vs 0o700, which env vars were set,
 * or which literal strings appear in the script body) — it never actually asks the OS to
 * execute the file that was written, or asks a real git to evaluate a real prompt or resolve
 * a real URL through real config. That's exactly the gap that let a non-executable askpass
 * helper ship: the mocked test asserted the wrong mode and passed.
 *
 * This file intentionally mocks nothing. It calls the real `writeAskpassHelper` and
 * `buildCloneGitEnv` against real temp directories, then drives a real `git` through them —
 * proving git can actually execute the helper, that the helper answers only the exact
 * `https://github.com` prompt (and refuses everything else, including a redirect-lookalike
 * host or a downgraded scheme), and that the sealed env actually blocks a config-driven
 * credential redirect from both global and system config — not just that the code requested
 * the right arguments.
 *
 * Prompt text: git's askpass prompts (`Username for '<scheme>://<host>': ` and
 * `Password for '<scheme>://<user>@<host>': `) were captured from real git (not assumed) by
 * pointing a recording GIT_ASKPASS script at a local HTTP(S) server that answers 401 and
 * reading `$1`. See the code review report for the transcript.
 *
 * Environment isolation: every git invocation here builds a minimal, explicit env (no
 * `...process.env` spread) with `cwd` outside any repository, `GIT_CONFIG_GLOBAL` pinned to a
 * controlled file (or `/dev/null`), and `GIT_CONFIG_NOSYSTEM` explicitly controlled per test.
 * Without this, an inherited `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT`/`GIT_DIR`/
 * `GIT_ASKPASS`/`SSH_ASKPASS`, or a developer's or CI runner's own global/system
 * `credential.helper`, could answer a prompt or mask a redirect before the code under test
 * gets a chance to — and the test would pass without proving anything.
 */
import {execFile} from 'node:child_process'
import {mkdtemp, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'
import {buildCloneGitEnv, writeAskpassHelper} from './clone.js'

const DUMMY_TOKEN = 'dummy-token-value'
const SYSTEM_PATH = process.env.PATH ?? '/usr/bin:/bin'

interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs git with an explicit, minimal env and cwd. Always resolves (never rejects) so callers
 * can inspect stdout/stderr/exit code even on failure — the refusal-path tests below need to
 * prove nothing leaked into either stream, which a throw-on-failure helper would hide.
 */
async function execGit(
  args: readonly string[],
  options: {env: Record<string, string>; cwd: string; stdin?: string},
): Promise<GitResult> {
  return new Promise(resolve => {
    const child = execFile('git', args, {cwd: options.cwd, env: options.env}, (error, stdout, stderr) => {
      const rawCode = error?.code
      const code = error === null ? 0 : typeof rawCode === 'number' ? rawCode : 1
      resolve({code, stdout, stderr})
    })
    child.stdin?.end(options.stdin ?? '')
  })
}

/**
 * Throws a readable error — including git's stderr and exit code, not just "it failed" — if
 * `result.code !== 0`. Used wherever a test expects git to succeed, so a CI failure shows why
 * git failed instead of just that it did.
 */
function expectGitSuccess(args: readonly string[], result: GitResult): void {
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (code ${result.code}): ${result.stderr.trim() || '(no stderr)'}`)
  }
}

/** Runs `git credential fill` for `protocol://host` through the real written helper. */
async function fillCredential(params: {
  askpassPath: string
  cwd: string
  homeDir: string
  protocol: string
  host: string
}): Promise<GitResult> {
  return execGit(['-c', 'credential.helper=', 'credential', 'fill'], {
    cwd: params.cwd,
    stdin: `protocol=${params.protocol}\nhost=${params.host}\n`,
    env: {
      PATH: SYSTEM_PATH,
      HOME: params.homeDir,
      GIT_ASKPASS: params.askpassPath,
      GIT_TERMINAL_PROMPT: '0',
      GITHUB_TOKEN: DUMMY_TOKEN,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
}

describe('writeAskpassHelper — real execution', () => {
  let dir: string | null = null
  let homeDir: string | null = null

  afterEach(async () => {
    if (dir !== null) {
      await rm(dir, {recursive: true, force: true})
      dir = null
    }
    if (homeDir !== null) {
      await rm(homeDir, {recursive: true, force: true})
      homeDir = null
    }
  })

  it('writes the helper with real mode 0700, and git fills the exact https://github.com credential prompt', async () => {
    // #given
    dir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-test-'))
    homeDir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-home-'))
    const askpassPath = await writeAskpassHelper(dir)

    // #then (mode) — the real mode on disk, not a mocked open() argument.
    const helperStat = await stat(askpassPath)
    expect(helperStat.mode & 0o777).toBe(0o700)

    // #when (execution) — minimal, explicit env; cwd outside any repo.
    const args = ['-c', 'credential.helper=', 'credential', 'fill']
    const result = await fillCredential({askpassPath, cwd: dir, homeDir, protocol: 'https', host: 'github.com'})

    // #then (execution)
    expectGitSuccess(args, result)
    expect(result.stdout).toContain('username=x-access-token')
    expect(result.stdout).toContain(`password=${DUMMY_TOKEN}`)
  })

  it('sets the helper to 0700 even under a restrictive process umask (chmod, not the masked open() mode, sets it)', async () => {
    // #given
    dir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-test-'))
    const priorUmask = process.umask(0o177)

    // #when
    let askpassPath: string
    try {
      askpassPath = await writeAskpassHelper(dir)
    } finally {
      process.umask(priorUmask)
    }

    // #then
    const helperStat = await stat(askpassPath)
    expect(helperStat.mode & 0o777).toBe(0o700)
  })

  it('refuses a non-github.com host (evil.example): git fails, and the token appears nowhere in stdout or stderr', async () => {
    // #given
    dir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-test-'))
    homeDir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-home-'))
    const askpassPath = await writeAskpassHelper(dir)

    // #when
    const result = await fillCredential({askpassPath, cwd: dir, homeDir, protocol: 'https', host: 'evil.example'})

    // #then
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain(DUMMY_TOKEN)
    expect(result.stderr).not.toContain(DUMMY_TOKEN)
  })

  it('refuses a lookalike host (github.com.evil.example): git fails, and the token appears nowhere in stdout or stderr', async () => {
    // #given
    dir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-test-'))
    homeDir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-home-'))
    const askpassPath = await writeAskpassHelper(dir)

    // #when
    const result = await fillCredential({
      askpassPath,
      cwd: dir,
      homeDir,
      protocol: 'https',
      host: 'github.com.evil.example',
    })

    // #then
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain(DUMMY_TOKEN)
    expect(result.stderr).not.toContain(DUMMY_TOKEN)
  })

  it('refuses an http (not https) github.com prompt: git fails, and the token appears nowhere in stdout or stderr', async () => {
    // #given
    dir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-test-'))
    homeDir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-home-'))
    const askpassPath = await writeAskpassHelper(dir)

    // #when
    const result = await fillCredential({askpassPath, cwd: dir, homeDir, protocol: 'http', host: 'github.com'})

    // #then
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain(DUMMY_TOKEN)
    expect(result.stderr).not.toContain(DUMMY_TOKEN)
  })
})

describe('buildCloneGitEnv — real config-redirect sealing', () => {
  let homeDir: string | null = null

  afterEach(async () => {
    if (homeDir !== null) {
      await rm(homeDir, {recursive: true, force: true})
      homeDir = null
    }
  })

  const REDIRECT_URL = 'https://github.com/acme/widgets.git'
  const REDIRECT_CONFIG = '[url "https://evil.example/"]\n\tinsteadOf = https://github.com/\n'

  it('the redirect is blocked: sealed clone env resolves the URL unchanged despite a planted global insteadOf rule', async () => {
    // #given — a "global" gitconfig, at the conventional $HOME/.gitconfig location,
    // planting a redirect from github.com to an attacker-controlled host.
    homeDir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-home-'))
    await writeFile(join(homeDir, '.gitconfig'), REDIRECT_CONFIG)

    // #when — the exact production env-building function, not a hand copy.
    const env = buildCloneGitEnv(DUMMY_TOKEN, '/nonexistent-askpass.sh', {PATH: SYSTEM_PATH, HOME: homeDir})
    const args = ['ls-remote', '--get-url', REDIRECT_URL]
    const result = await execGit(args, {cwd: homeDir, env})

    // #then — GIT_CONFIG_GLOBAL=/dev/null means the planted $HOME/.gitconfig is never
    // read, so the URL git would actually use is unchanged.
    expectGitSuccess(args, result)
    expect(result.stdout.trim()).toBe(REDIRECT_URL)
  })

  it('control: the same rule, supplied as GIT_CONFIG_GLOBAL without sealing, does redirect (proves the fixture is real)', async () => {
    // #given
    homeDir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-home-'))
    const configPath = join(homeDir, 'evil-gitconfig')
    await writeFile(configPath, REDIRECT_CONFIG)

    // #when — raw git, no sealing: GIT_CONFIG_GLOBAL points straight at the malicious file.
    const args = ['ls-remote', '--get-url', REDIRECT_URL]
    const result = await execGit(args, {
      cwd: homeDir,
      env: {PATH: SYSTEM_PATH, HOME: homeDir, GIT_CONFIG_GLOBAL: configPath},
    })

    // #then — proves the fixture really redirects when nothing blocks it.
    expectGitSuccess(args, result)
    expect(result.stdout.trim()).toBe('https://evil.example/acme/widgets.git')
  })

  it('a planted system config insteadOf rule is ignored: GIT_CONFIG_NOSYSTEM=1 wins over GIT_CONFIG_SYSTEM', async () => {
    // #given — a "system" gitconfig planting the same redirect, supplied via GIT_CONFIG_SYSTEM
    // on top of the exact production env (which already sets GIT_CONFIG_NOSYSTEM=1).
    homeDir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-home-'))
    const systemConfigPath = join(homeDir, 'evil-system-gitconfig')
    await writeFile(systemConfigPath, REDIRECT_CONFIG)

    // #when
    const env = {
      ...buildCloneGitEnv(DUMMY_TOKEN, '/nonexistent-askpass.sh', {PATH: SYSTEM_PATH, HOME: homeDir}),
      GIT_CONFIG_SYSTEM: systemConfigPath,
    }
    const args = ['ls-remote', '--get-url', REDIRECT_URL]
    const result = await execGit(args, {cwd: homeDir, env})

    // #then — GIT_CONFIG_NOSYSTEM=1 wins: the planted system config is never read.
    expectGitSuccess(args, result)
    expect(result.stdout.trim()).toBe(REDIRECT_URL)
  })

  it('control: the same system config, without GIT_CONFIG_NOSYSTEM, does redirect (proves the fixture is real)', async () => {
    // #given
    homeDir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-home-'))
    const systemConfigPath = join(homeDir, 'evil-system-gitconfig')
    await writeFile(systemConfigPath, REDIRECT_CONFIG)

    // #when — raw git, no NOSYSTEM: GIT_CONFIG_SYSTEM points straight at the malicious file.
    const args = ['ls-remote', '--get-url', REDIRECT_URL]
    const result = await execGit(args, {
      cwd: homeDir,
      env: {PATH: SYSTEM_PATH, HOME: homeDir, GIT_CONFIG_SYSTEM: systemConfigPath},
    })

    // #then
    expectGitSuccess(args, result)
    expect(result.stdout.trim()).toBe('https://evil.example/acme/widgets.git')
  })
})
