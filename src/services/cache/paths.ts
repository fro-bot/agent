import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  DB_FAMILY_BASENAMES,
  DB_MAIN_BASENAME,
  DB_SHM_BASENAME,
  DB_WAL_BASENAME,
  isSqliteBackend,
} from '@fro-bot/runtime'
import {toErrorMessage} from '../../shared/errors.js'

export function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
  const resolvedFile = path.resolve(filePath)
  const resolvedDir = path.resolve(directoryPath)
  return resolvedFile.startsWith(resolvedDir + path.sep)
}

export function isAuthPathSafe(authPath: string, storagePath: string): boolean {
  return !isPathInsideDirectory(authPath, storagePath)
}

/**
 * Type guard for Node's `NodeJS.ErrnoException` convention (a `.code` string attached to
 * filesystem errors). A broad `catch (error)` cannot assume every thrown value carries
 * `.code` — asserting it via `as NodeJS.ErrnoException` is a cast on an unverified shape,
 * which is the same risk `as any` and `@ts-ignore` carry. This narrows before reading it.
 *
 * Shared by both delete-and-tolerate-ENOENT call sites in this module and in restore.ts
 * (deleteRestoredShm imports this rather than redefining it — restore.ts already depends
 * on paths.ts, so this direction adds no new edge).
 */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error
}

export async function deleteAuthJson(authPath: string, storagePath: string, logger: Logger): Promise<void> {
  if (!isPathInsideDirectory(authPath, storagePath)) {
    logger.debug('auth.json is outside storage path - skipping deletion', {
      authPath,
      storagePath,
    })
    return
  }

  try {
    await fs.unlink(authPath)
    logger.debug('Deleted auth.json from cache storage')
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      logger.warning('Failed to delete auth.json', {
        error: toErrorMessage(error),
      })
    }
  }
}

// @actions/cache derives a cache entry's *version* (a hash it uses alongside the key to
// decide whether a save is restorable) from this exact path list — see getCacheVersion in
// @actions/cache's cacheUtils.js. Restore and save must therefore build the list the same
// way, from the same function, or a save's version silently stops matching what restore
// asks for and every entry it writes becomes permanently unrestorable (this happened once
// already: #1519 dropped the -wal/-shm sidecars from a save-only helper and broke restores
// repo-wide for days before anyone noticed, because a version mismatch looks exactly like
// a cold cache, not an error). -shm is never included: it's a machine-local wal-index
// SQLite never syncs, so a copy from another runner is stale by construction. -wal is
// never included either: callers checkpoint before calling this, so a healthy save's
// write-ahead log is already empty or absent by the time paths are built.

/**
 * Re-exported, not redefined. `@fro-bot/runtime` owns these names because the object-store
 * sync lives there and cannot import from this package — defining them here too would leave
 * two lists that must agree about which files constitute the database, which is the drift
 * shape this repository has been bitten by before.
 */
export {DB_FAMILY_BASENAMES, DB_MAIN_BASENAME, DB_SHM_BASENAME, DB_WAL_BASENAME} from '@fro-bot/runtime'

/** Builds absolute paths for every DB-family file beside `storagePath`, present or not. */
export function buildDbFamilyPaths(storagePath: string): string[] {
  const dbDir = path.dirname(storagePath)
  return DB_FAMILY_BASENAMES.map(basename => path.join(dbDir, basename))
}

/** The machine-local wal-index sidecar path beside `storagePath`. Never valid to transport. */
export function buildDbShmPath(storagePath: string): string {
  return path.join(path.dirname(storagePath), DB_SHM_BASENAME)
}

/**
 * The write-ahead log path beside `storagePath`. Exported for the object-store restore
 * path (`restore.ts`'s `deleteDownloadedObjectStoreWal`), which must delete a downloaded
 * write-ahead log before anything opens the database -- see `DB_TRANSPORTABLE_BASENAMES`
 * in `packages/runtime/src/session/version.ts` for why that log can no longer be trusted.
 */
export function buildDbWalPath(storagePath: string): string {
  return path.join(path.dirname(storagePath), DB_WAL_BASENAME)
}

/**
 * The single path list passed to both `@actions/cache`'s restoreCache and saveCache.
 * Called identically by restore.ts and save.ts — see the comment above for why a second,
 * merely-equivalent definition is not an acceptable alternative.
 *
 * Only pure when `opencodeVersion` is a string: a `null` version makes `isSqliteBackend`
 * probe whether the global `opencode.db` exists on disk at call time (see
 * `packages/runtime/src/session/version.ts`), so the result depends on filesystem state,
 * not just these arguments — restore and save must be given the same version for the
 * shared-hash guarantee above to hold.
 */
export async function buildCachePaths(
  storagePath: string,
  projectIdPath: string | undefined,
  opencodeVersion: string | null | undefined,
): Promise<string[]> {
  const paths = [storagePath]
  if (projectIdPath != null) {
    paths.push(projectIdPath)
  }
  if (await isSqliteBackend(opencodeVersion ?? null)) {
    const dbDir = path.dirname(storagePath)
    const dbPath = path.join(dbDir, DB_MAIN_BASENAME)
    paths.push(dbPath)
  }
  return paths
}
