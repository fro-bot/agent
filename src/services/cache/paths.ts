import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {isSqliteBackend} from '@fro-bot/runtime'
import {toErrorMessage} from '../../shared/errors.js'

export function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
  const resolvedFile = path.resolve(filePath)
  const resolvedDir = path.resolve(directoryPath)
  return resolvedFile.startsWith(resolvedDir + path.sep)
}

export function isAuthPathSafe(authPath: string, storagePath: string): boolean {
  return !isPathInsideDirectory(authPath, storagePath)
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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warning('Failed to delete auth.json', {
        error: toErrorMessage(error),
      })
    }
  }
}

// Restore mode always includes -wal and -shm even if absent: @actions/cache tolerates
// missing paths in the archive. Save mode filters by existence because @actions/cache
// fails if any save path is missing at archive time.
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
    const dbPath = path.join(path.dirname(storagePath), 'opencode.db')
    paths.push(dbPath, `${dbPath}-wal`, `${dbPath}-shm`)
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
    const dbPath = path.join(path.dirname(storagePath), 'opencode.db')
    paths.push(dbPath)
    for (const suffix of ['-wal', '-shm']) {
      try {
        await fs.access(`${dbPath}${suffix}`)
        paths.push(`${dbPath}${suffix}`)
      } catch {
        // sidecar file missing — safe to skip
      }
    }
  }
  return paths
}
