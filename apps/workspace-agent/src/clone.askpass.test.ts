/**
 * Real-execution regression test for the GIT_ASKPASS helper written by
 * `writeAskpassHelper`.
 *
 * `clone.test.ts` mocks `node:fs/promises` and `execFile` at module level, so it can only
 * assert *what arguments the code passed* (e.g. mode 0o600 vs 0o700) — it never actually
 * asks the OS to execute the file that was written. That's exactly the gap that let a
 * non-executable askpass helper ship: the mocked test asserted the wrong mode and passed.
 *
 * This file intentionally mocks nothing. It calls the real `writeAskpassHelper` against a
 * real `mkdtemp` directory, then drives a real `git credential fill` through the real
 * helper it wrote, proving git can actually execute the file — not just that the code
 * requested some mode.
 */
import {execFile} from 'node:child_process'
import {mkdtemp, rm, stat} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import process from 'node:process'

import {afterEach, describe, expect, it} from 'vitest'
import {writeAskpassHelper} from './clone.js'

const DUMMY_TOKEN = 'dummy-token-value'

/**
 * Runs `git credential fill` with GIT_ASKPASS pointed at `askpassPath`, feeding it a
 * minimal `protocol=https\nhost=example.invalid\n` credential description on stdin —
 * exactly what git sends when a clone needs credentials it doesn't already have.
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are pinned to `/dev/null` so a developer's or
 * CI runner's own credential helper cannot answer the prompt before the askpass helper
 * gets a chance to.
 */
async function runGitCredentialFill(askpassPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['credential', 'fill'],
      {
        env: {
          ...process.env,
          GIT_ASKPASS: askpassPath,
          GIT_TERMINAL_PROMPT: '0',
          GITHUB_TOKEN: DUMMY_TOKEN,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
    child.stdin?.end('protocol=https\nhost=example.invalid\n')
  })
}

describe('writeAskpassHelper — real execution', () => {
  let dir: string | null = null

  afterEach(async () => {
    if (dir !== null) {
      await rm(dir, {recursive: true, force: true})
      dir = null
    }
  })

  it('writes an mkdtemp dir with mode 0700', async () => {
    // #given / #when
    dir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-test-'))

    // #then
    const dirStat = await stat(dir)
    expect(dirStat.mode & 0o777).toBe(0o700)
  })

  it('git can execute the written helper to answer a real credential challenge', async () => {
    // #given
    dir = await mkdtemp(join(os.tmpdir(), 'workspace-agent-askpass-test-'))
    const askpassPath = await writeAskpassHelper(dir)

    // #when
    const stdout = await runGitCredentialFill(askpassPath)

    // #then
    expect(stdout).toContain('username=x-access-token')
    expect(stdout).toContain(`password=${DUMMY_TOKEN}`)
  })
})
