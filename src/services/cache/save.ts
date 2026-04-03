import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import {STORAGE_VERSION} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'
import {isSqliteBackend} from '../session/version.js'
import {buildSaveCacheKey} from './cache-key.js'
import {isPathInsideDirectory} from './restore.js'
import {defaultCacheAdapter, type SaveCacheOptions} from './types.js'

async function buildCachePaths(
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
    // Include WAL and SHM files if they exist — SQLite WAL mode stores
    // recent writes in these files until checkpointed to the main DB.
    // Without them, sessions created during the current run are lost.
    for (const suffix of ['-wal', '-shm']) {
      try {
        await fs.access(`${dbPath}${suffix}`)
        paths.push(`${dbPath}${suffix}`)
      } catch {
        // File doesn't exist — server may not be using WAL mode or
        // WAL was already checkpointed. Safe to skip.
      }
    }
  }
  return paths
}

async function deleteAuthJson(
  authPath: string,
  storagePath: string,
  logger: SaveCacheOptions['logger'],
): Promise<void> {
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

async function writeStorageVersion(storagePath: string): Promise<void> {
  const versionFile = path.join(storagePath, '.version')
  await fs.mkdir(storagePath, {recursive: true})
  await fs.writeFile(versionFile, String(STORAGE_VERSION), 'utf8')
}

async function directoryHasContent(dirPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dirPath)
    return entries.length > 0
  } catch {
    return false
  }
}

export async function saveCache(options: SaveCacheOptions): Promise<boolean> {
  const {
    components,
    runId,
    logger,
    storagePath,
    authPath,
    projectIdPath,
    opencodeVersion,
    cacheAdapter = defaultCacheAdapter,
  } = options

  if (process.env.SKIP_CACHE === 'true') {
    logger.debug('Skipping cache save (SKIP_CACHE=true)')
    return true
  }

  const saveKey = buildSaveCacheKey(components, runId)
  const cachePaths = await buildCachePaths(storagePath, projectIdPath, opencodeVersion)

  logger.info('Saving cache', {saveKey, paths: cachePaths})

  try {
    await deleteAuthJson(authPath, storagePath, logger)

    const storageExists = await directoryHasContent(storagePath)
    if (storageExists === false) {
      logger.info('No storage content to cache')
      return false
    }

    await writeStorageVersion(storagePath)

    await cacheAdapter.saveCache(cachePaths, saveKey)
    logger.info('Cache saved', {saveKey})
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) {
      logger.info('Cache key already exists, skipping save')
      return true
    }

    logger.warning('Cache save failed', {
      error: toErrorMessage(error),
    })
    return false
  }
}
