import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'

export const OPENCODE_SQLITE_VERSION = '1.2.0'

/**
 * Canonical names of the OpenCode session database and its SQLite sidecars.
 *
 * These live here, in the lowest layer that knows about the database, because every
 * consumer either is in this package or depends on it: the object-store sync beside
 * this module, and the Action's cache path builder downstream. Defining them anywhere
 * else forces a second copy across the package boundary, and two lists that must agree
 * about which files constitute the database are the shape that drifts.
 *
 * `-shm` is a machine-local wal-index that SQLite never syncs and rebuilds on demand.
 * It belongs in this family for deletion and restore-tolerance, but must never be
 * captured for transport to another runner.
 */
export const DB_MAIN_BASENAME = 'opencode.db'
export const DB_WAL_BASENAME = `${DB_MAIN_BASENAME}-wal`
export const DB_SHM_BASENAME = `${DB_MAIN_BASENAME}-shm`
export const DB_FAMILY_BASENAMES: readonly string[] = [DB_MAIN_BASENAME, DB_WAL_BASENAME, DB_SHM_BASENAME]

/** The subset safe to move between machines: the database and its write-ahead log. */
export const DB_TRANSPORTABLE_BASENAMES: readonly string[] = [DB_MAIN_BASENAME, DB_WAL_BASENAME]

export function getOpenCodeDbPath(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME
  const basePath = xdgDataHome ?? path.join(os.homedir(), '.local', 'share')
  return path.join(basePath, 'opencode', DB_MAIN_BASENAME)
}

export async function isSqliteBackend(version: string | null): Promise<boolean> {
  if (version != null) {
    return compareVersions(version, OPENCODE_SQLITE_VERSION) >= 0
  }
  try {
    await fs.access(getOpenCodeDbPath())
    return true
  } catch {
    return false
  }
}

export function baseVersion(v: string): string {
  const withoutBuild = v.split('+')[0] ?? v
  return withoutBuild.split('-')[0] ?? withoutBuild
}

export function compareVersions(a: string, b: string): number {
  const partsA = baseVersion(a).split('.').map(Number)
  const partsB = baseVersion(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
