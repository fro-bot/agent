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

import {homedir, tmpdir} from 'node:os'
import process from 'node:process'

import {afterAll} from 'vitest'

import {installHomeIsolation} from './vitest-home-isolation.js'

const isolation = installHomeIsolation({env: process.env, tmpRoot: tmpdir(), homedir})

if (isolation !== null) {
  // Removal runs in `afterAll`, once per test file. Vitest skips it for a file whose tests are all skipped or that
  // fails before its suite registers, and the pool ends such workers without any exit hook running (`exit` and
  // `SIGTERM` handlers were tried: the first never fires, the second fights tests that emit SIGTERM). Those files
  // leave an empty temp tree for the OS to reap.
  afterAll(isolation.cleanup)
}
