/**
 * Vitest `setupFiles` module: runs every test file against a throwaway HOME and XDG tree.
 *
 * Without it, any code path that resolves a default location (`os.homedir()`, `$XDG_CONFIG_HOME/opencode`,
 * `$XDG_DATA_HOME/opencode`, ...) would read and write the developer's real home when a test forgets to mock the
 * filesystem or point at a temp dir. That is how the Action's task-reuse guard once ended up in a developer's real
 * `~/.config/opencode` (#1769). Tests that care about a specific location still set their own env and restore it;
 * the restore puts back the isolated value, never the real one.
 *
 * `setupFiles` run inside each test file's worker before the test module graph is imported, so module-level
 * captures such as `os.homedir()` in `src/services/cache/dedup.ts` already see the isolated paths.
 *
 * Live evals (`FRO_BOT_EVAL=1`) opt out: the eval runner builds its own sandbox HOME and has to read the operator's
 * real `auth.json` to provision a provider credential.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'

import {afterAll} from 'vitest'

if (process.env.FRO_BOT_EVAL !== '1') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'fro-bot-test-home-'))
  const home = join(root, 'home')
  const isolated = {
    HOME: home,
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
    XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'),
    XDG_CACHE_HOME: join(root, 'xdg', 'cache'),
  } as const

  for (const [key, dir] of Object.entries(isolated)) {
    mkdirSync(dir, {recursive: true})
    process.env[key] = dir
  }

  // `os.homedir()` reads `$HOME` on POSIX (libuv `uv_os_homedir`) on every call. It does so against the real process
  // environment, so a `worker_threads` pool, whose `process.env` is a copy, would silently keep the real home.
  // Fail loudly instead of running unisolated.
  if (homedir() !== home) {
    rmSync(root, {recursive: true, force: true})
    throw new Error(
      `Vitest home isolation failed: os.homedir() returned ${homedir()} after setting HOME=${home}. ` +
        'Use a process-based pool (forks) so HOME overrides reach os.homedir().',
    )
  }

  // Removal runs in `afterAll`, once per test file. Vitest skips it for a file whose tests are all skipped or that
  // fails before its suite registers, and the pool ends such workers without any exit hook running (`exit` and
  // `SIGTERM` handlers were tried: the first never fires, the second fights tests that emit SIGTERM). Those files
  // leave an empty temp tree for the OS to reap.
  afterAll(() => rmSync(root, {recursive: true, force: true}))
}
