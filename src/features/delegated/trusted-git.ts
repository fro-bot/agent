import type {ExecAdapter} from '../../services/setup/types.js'

import {Buffer} from 'node:buffer'
import process from 'node:process'

/**
 * The one way the Action runs git against a checkout after the model has run.
 *
 * With `isolate-agent` the model can rewrite anything under the checkout's `.git`. Take-back puts the pre-model
 * `config`, `config.worktree`, `hooks/` and `info/` back before these calls (`sandbox-handoff.ts`), so the config a
 * call reads is trusted and the index, refs and objects are read as data. This wrapper is the second layer:
 * - config that could still run code is switched off on the command line (`core.fsmonitor`, `core.hooksPath`);
 * - the callers add `--no-textconv --no-ext-diff --ignore-submodules=all` where the subcommand takes them;
 * - the environment is replaced, not inherited: no global or system config, a pinned `PATH`, no pager, no prompts and no
 *   optional index writes;
 * - the call is bounded, and on expiry the adapter kills the child's whole process group.
 *
 * Non-isolated runs use the same wrapper. The model there shares the Action's uid and could rewrite any copy, so only
 * the command-line layer applies; that is unchanged from before for a regular checkout.
 */

/** Directories searched for `git` and for anything it spawns. Never the caller's `PATH`. */
export const TRUSTED_GIT_PATH = '/usr/local/bin:/usr/bin:/bin'

export const TRUSTED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  // Windows has no such layout; its git is found on the inherited path.
  ...(process.platform === 'win32' ? {} : {PATH: TRUSTED_GIT_PATH}),
}

/** Global options in front of every trusted call. */
export const TRUSTED_GIT_GLOBAL_ARGS = [
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
] as const

export type TrustedGitRun =
  | {readonly kind: 'completed'; readonly exitCode: number; readonly stdout: string; readonly stderr: string}
  | {readonly kind: 'timed-out'}
  | {readonly kind: 'unavailable'}

export interface TrustedGitOptions {
  readonly timeoutMs: number
  /**
   * When true a missing `execWithTimeout` is `unavailable` (the caller skips) instead of an unbounded call. Production
   * adapters always have it; this is for callers that must never run unbounded.
   */
  readonly requireTimeout?: boolean
}

/**
 * Runs `git <global args> <args>` in `repoRoot`. `args` must be argv-form: never a string the model controls.
 */
export async function runTrustedGit(
  execAdapter: ExecAdapter,
  args: readonly string[],
  repoRoot: string,
  options: TrustedGitOptions,
): Promise<TrustedGitRun> {
  const argv = [...TRUSTED_GIT_GLOBAL_ARGS, ...args]

  if (execAdapter.execWithTimeout != null) {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const exitCode = await execAdapter.execWithTimeout('git', argv, options.timeoutMs, {
      cwd: repoRoot,
      env: {...TRUSTED_GIT_ENV},
      listeners: {stdout: data => stdout.push(data), stderr: data => stderr.push(data)},
    })
    if (exitCode === 'timed-out') return {kind: 'timed-out'}
    return {
      kind: 'completed',
      exitCode,
      stdout: Buffer.concat(stdout).toString('utf-8'),
      stderr: Buffer.concat(stderr).toString('utf-8'),
    }
  }

  if (options.requireTimeout === true) return {kind: 'unavailable'}

  const result = await execAdapter.getExecOutput('git', argv, {
    cwd: repoRoot,
    env: {...TRUSTED_GIT_ENV},
    ignoreReturnCode: true,
    silent: true,
  })
  return {kind: 'completed', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr}
}
