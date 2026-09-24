/**
 * Real-execution regression tests for `writeAskpassHelper` and `buildCloneGitEnv`.
 *
 * `clone.test.ts` mocks `node:fs/promises` and `execFile` at module level, so it can only
 * assert *what arguments the code passed* (e.g. mode 0o600 vs 0o700, or which env vars were
 * set) — it never actually asks the OS to execute the file that was written, or asks a real
 * git to resolve a real URL through real config. That's exactly the gap that let a
 * non-executable askpass helper ship: the mocked test asserted the wrong mode and passed.
 *
 * This file intentionally mocks nothing. It calls the real `writeAskpassHelper` and
 * `buildCloneGitEnv` against real temp directories, then drives a real `git` through them —
 * proving git can actually execute the helper, and that the sealed env actually blocks a
 * config-driven credential redirect — not just that the code requested the right arguments.
 *
 * Environment isolation: every git invocation here builds a minimal, explicit env (no
 * `...process.env` spread) with `cwd` outside any repository, `GIT_CONFIG_GLOBAL` pinned to a
 * controlled file (or `/dev/null`), and `GIT_CONFIG_NOSYSTEM=1`. Without this, an inherited
 * `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT`/`GIT_DIR`/`GIT_ASKPASS`/`SSH_ASKPASS`, or a
 * developer's or CI runner's own global/system `credential.helper`, could answer a prompt or
 * mask a redirect before the code under test gets a chance to — and the test would pass
 * without proving anything.
 */
import type {ExecFileException} from 'node:child_process'

import {execFile} from 'node:child_process'
import {mkdtemp, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'
import {buildCloneGitEnv, writeAskpassHelper} from './clone.js'

const DUMMY_TOKEN = 'dummy-token-value'
const SYSTEM_PATH = process.env.PATH ?? '/usr/bin:/bin'

/**
 * Runs `git` with an explicit, minimal env and cwd, and readable failures.
 *
 * On failure, rejects with an Error whose message includes git's stderr and exit
 * status/signal — not the bare Node "Command failed" message — so a CI failure shows *why*
 * git failed (e.g. "cannot exec '<path>': Permission denied") instead of just that it did.
 */
async function runGit(args: readonly string[], options: {env: Record<string, string>; cwd: string}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd: options.cwd, env: options.env}, (error, stdout, stderr) => {
      if (error) {
        reject(describeGitFailure(args, error, stderr))
        return
      }
      resolve(stdout)
    })
  })
}

/** Same as {@link runGit}, but also writes `stdin` before closing it (for `credential fill`). */
async function runGitWithStdin(
  args: readonly string[],
  stdin: string,
  options: {env: Record<string, string>; cwd: string},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {cwd: options.cwd, env: options.env}, (error, stdout, stderr) => {
      if (error) {
        reject(describeGitFailure(args, error, stderr))
        return
      }
      resolve(stdout)
    })
    child.stdin?.end(stdin)
  })
}

function describeGitFailure(args: readonly string[], error: ExecFileException, stderr: string): Error {
  const status = error.signal !== null && error.signal !== undefined ? `signal ${error.signal}` : `code ${error.code}`
  const detail = stderr.trim().length > 0 ? stderr.trim() : error.message
  return new Error(`git ${args.join(' ')} failed (${status}): ${detail}`)
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

  it('writes an mkdtemp dir with mode 0700', async () => {
    // #given / #when
    dir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-test-'))

    // #then
    const dirStat = await stat(dir)
    expect(dirStat.mode & 0o777).toBe(0o700)
  })

  it('writes the helper itself with real mode 0700, and git can execute it under a real credential challenge', async () => {
    // #given
    dir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-test-'))
    homeDir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-home-'))
    const askpassPath = await writeAskpassHelper(dir)

    // #then (mode) — the real mode on disk, not a mocked open() argument.
    const helperStat = await stat(askpassPath)
    expect(helperStat.mode & 0o777).toBe(0o700)

    // #when (execution) — minimal, explicit env; cwd outside any repo; helper on the
    // command line, not inherited, so nothing else can answer the prompt first.
    const stdout = await runGitWithStdin(
      ['-c', 'credential.helper=', 'credential', 'fill'],
      'protocol=https\nhost=example.invalid\n',
      {
        cwd: dir,
        env: {
          PATH: SYSTEM_PATH,
          HOME: homeDir,
          GIT_ASKPASS: askpassPath,
          GIT_TERMINAL_PROMPT: '0',
          GITHUB_TOKEN: DUMMY_TOKEN,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    )

    // #then (execution)
    expect(stdout).toContain('username=x-access-token')
    expect(stdout).toContain(`password=${DUMMY_TOKEN}`)
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
    const stdout = await runGit(['ls-remote', '--get-url', REDIRECT_URL], {cwd: homeDir, env})

    // #then — GIT_CONFIG_GLOBAL=/dev/null means the planted $HOME/.gitconfig is never
    // read, so the URL git would actually use is unchanged.
    expect(stdout.trim()).toBe(REDIRECT_URL)
  })

  it('control: the same rule, supplied as GIT_CONFIG_GLOBAL without sealing, does redirect (proves the fixture is real)', async () => {
    // #given
    homeDir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-home-'))
    const configPath = join(homeDir, 'evil-gitconfig')
    await writeFile(configPath, REDIRECT_CONFIG)

    // #when — raw git, no sealing: GIT_CONFIG_GLOBAL points straight at the malicious file.
    const stdout = await runGit(['ls-remote', '--get-url', REDIRECT_URL], {
      cwd: homeDir,
      env: {PATH: SYSTEM_PATH, HOME: homeDir, GIT_CONFIG_GLOBAL: configPath},
    })

    // #then — proves the fixture really redirects when nothing blocks it.
    expect(stdout.trim()).toBe('https://evil.example/acme/widgets.git')
  })
})
