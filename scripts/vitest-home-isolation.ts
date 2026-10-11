/**
 * Pure-ish core of the Vitest home-isolation setup (see `vitest-home-isolation.setup.ts` for the why).
 *
 * Lives apart from the setup file so it can be unit-tested against a plain env object: the setup file runs it against
 * the real `process.env` on import, which a test cannot exercise without mutating the very environment it runs in.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs'
import {join} from 'node:path'

export interface HomeIsolationOptions {
  /** Environment to mutate. The setup file passes `process.env`; tests pass a plain object. */
  readonly env: Record<string, string | undefined>
  /** Directory that holds the throwaway tree (its `realpath` is used). */
  readonly tmpRoot: string
  /** Resolver for the effective home, i.e. `os.homedir`. Probed after `HOME` is overridden. */
  readonly homedir: () => string
}

export interface HomeIsolation {
  readonly root: string
  /** Removes the whole tree; safe to call more than once. */
  readonly cleanup: () => void
}

/**
 * Points `HOME` and `XDG_{CONFIG,DATA,STATE,CACHE}_HOME` at a fresh temp tree and returns its handle.
 *
 * Returns `null` without touching `env` when `FRO_BOT_EVAL=1`: the live eval runner builds its own sandbox HOME and has
 * to read the operator's real `auth.json`. Fails closed: when `homedir()` does not follow the `HOME` override (a
 * `worker_threads` pool, whose `process.env` is a copy), the tree is removed and an error is thrown rather than running
 * unisolated.
 */
export function installHomeIsolation({env, tmpRoot, homedir}: HomeIsolationOptions): HomeIsolation | null {
  if (env.FRO_BOT_EVAL === '1') return null

  const root = mkdtempSync(join(realpathSync(tmpRoot), 'fro-bot-test-home-'))
  const home = join(root, 'home')
  const isolated = {
    HOME: home,
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
    XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'),
    XDG_CACHE_HOME: join(root, 'xdg', 'cache'),
  } as const

  const cleanup = (): void => rmSync(root, {recursive: true, force: true})

  for (const [key, dir] of Object.entries(isolated)) {
    mkdirSync(dir, {recursive: true})
    env[key] = dir
  }

  // `os.homedir()` reads `$HOME` on POSIX (libuv `uv_os_homedir`) on every call. It does so against the real process
  // environment, so a `worker_threads` pool, whose `process.env` is a copy, would silently keep the real home.
  // Fail loudly instead of running unisolated.
  const resolved = homedir()
  if (resolved !== home) {
    cleanup()
    throw new Error(
      `Vitest home isolation failed: os.homedir() returned ${resolved} after setting HOME=${home}. ` +
        'Use a process-based pool (forks) so HOME overrides reach os.homedir().',
    )
  }

  return {root, cleanup}
}
