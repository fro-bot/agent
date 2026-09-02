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

// Restore mode always includes -wal and -shm even if absent: @actions/cache tolerates
// missing paths in the archive, and accepting both sidecars on restore preserves
// compatibility with caches written before either was dropped from the save set (see
// buildSaveCachePaths below). Save mode pushes storagePath and opencode.db
// unconditionally, whether or not they exist yet, and never includes -wal or -shm at all,
// regardless of whether either exists on disk. This is safe: @actions/cache's saveCache
// resolves every given path via glob and only throws "Path(s) ... do(es) not exist" when
// that resolution comes back empty for all of them, not when some of them are individually
// missing, and storagePath plus opencode.db are the two paths that make that failure
// unreachable in practice. -shm is a machine-local wal-index that SQLite never syncs, so a
// copy transported from another runner is stale by construction. -wal is excluded for a
// different reason: saveCache checkpoints before this function ever runs, so a healthy
// save's write-ahead log is already empty or absent by the time paths are built here, and
// deliberately not re-checking for a nonempty one keeps the invariant unconditional rather
// than incidental -- a save can never re-introduce the hot-WAL cache entries this repair
// was built to break out of, even if some future change altered checkpoint ordering.

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

export async function buildRestoreCachePaths(
  storagePath: string,
  projectIdPath: string | undefined,
  opencodeVersion: string | null | undefined,
): Promise<string[]> {
  const paths = [storagePath]
  if (projectIdPath != null) {
    paths.push(projectIdPath)
  }
  if (await isSqliteBackend(opencodeVersion ?? null)) {
    paths.push(...buildDbFamilyPaths(storagePath))
  }
  return paths
}

export async function buildSaveCachePaths(
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
