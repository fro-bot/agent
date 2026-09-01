import type {CacheResult} from '../../shared/types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import {createS3Adapter, syncSessionsFromStore} from '@fro-bot/runtime'
import {STORAGE_VERSION} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'
import {buildPrimaryCacheKey, buildRestoreKeys} from './cache-key.js'
import {
  buildDbFamilyPaths,
  buildDbShmPath,
  buildRestoreCachePaths,
  deleteAuthJson,
  isAuthPathSafe,
  isErrnoException,
  isPathInsideDirectory,
} from './paths.js'
import {defaultCacheAdapter, type RestoreCacheOptions} from './types.js'

export {isAuthPathSafe, isPathInsideDirectory}

async function checkStorageCorruption(storagePath: string, logger: RestoreCacheOptions['logger']): Promise<boolean> {
  try {
    const stat = await fs.stat(storagePath)
    if (stat.isDirectory() === false) {
      return true
    }

    await fs.readdir(storagePath)
    return false
  } catch {
    logger.debug('Storage path not accessible - treating as corrupted')
    return true
  }
}

async function checkStorageVersion(storagePath: string, logger: RestoreCacheOptions['logger']): Promise<boolean> {
  const versionFile = path.join(storagePath, '.version')
  try {
    const content = await fs.readFile(versionFile, 'utf8')
    const version = Number.parseInt(content.trim(), 10)
    if (version !== STORAGE_VERSION) {
      logger.info('Storage version mismatch', {expected: STORAGE_VERSION, found: version})
      return false
    }
    return true
  } catch {
    logger.debug('No version file found - treating as compatible')
    return true
  }
}

/**
 * Wipes the storage directory and the DB-family files beside it (opencode.db and its
 * write-ahead log/shm sidecars), then recreates an empty storage directory. Exported so
 * callers outside restoreCache — the restore-side repair in cache-restore.ts — can route
 * a structurally corrupt database (SQLite itself reports the file unusable, not merely
 * busy) into the same clean-slate path this module already uses for corrupted or
 * version-mismatched storage.
 */
export async function cleanStorage(storagePath: string): Promise<void> {
  try {
    await fs.rm(storagePath, {recursive: true, force: true})
    await fs.mkdir(storagePath, {recursive: true})
  } catch {}

  // The database family lives beside storagePath (path.dirname(storagePath)), not inside
  // it. "Proceeding with clean state" must actually be clean, or the database survives
  // every call site below untouched and the next restore finds it again.
  for (const dbFile of buildDbFamilyPaths(storagePath)) {
    try {
      await fs.rm(dbFile, {force: true})
    } catch {}
  }
}

// opencode.db-shm is a machine-local wal-index that SQLite never syncs. A copy restored
// from another runner is stale by construction and safe to delete locally — SQLite
// rebuilds it on demand. Deleting it (rather than waiting for old cache entries to age
// out) removes the hazard immediately after every restore, cache or object-store.
async function deleteRestoredShm(storagePath: string, logger: RestoreCacheOptions['logger']): Promise<void> {
  const shmPath = buildDbShmPath(storagePath)
  try {
    await fs.unlink(shmPath)
    logger.debug('Deleted restored opencode.db-shm (machine-local, stale by construction)')
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      logger.warning('Failed to delete restored opencode.db-shm', {
        error: toErrorMessage(error),
      })
    }
  }
}

async function restoreFromObjectStore(options: RestoreCacheOptions): Promise<CacheResult> {
  const {storeConfig, storeAdapter, logger, storagePath, components} = options

  if (storeConfig?.enabled !== true) {
    return {
      hit: false,
      key: null,
      restoredPath: null,
      corrupted: false,
      source: null,
    }
  }

  try {
    const adapter = storeAdapter ?? createS3Adapter(storeConfig, logger)
    const syncResult = await syncSessionsFromStore(
      adapter,
      storeConfig,
      components.agentIdentity,
      components.repo,
      storagePath,
      logger,
    )

    if (syncResult.mainDbRestored === true) {
      // The object store sync writes opencode.db beside storagePath; ensure this cache directory exists before returning.
      await fs.mkdir(storagePath, {recursive: true})
      await deleteRestoredShm(storagePath, logger)

      // A successful object-store restore used to return here, before either integrity
      // check ever ran — the path that wins on restore had no checks. A corrupt or
      // version-mismatched database in the bucket must not be accepted as a hit.
      const isCorrupted = await checkStorageCorruption(storagePath, logger)
      if (isCorrupted === true) {
        logger.warning('Object store restore produced corrupt storage - falling back to cache')
        await cleanStorage(storagePath)
        return {
          hit: false,
          key: null,
          restoredPath: null,
          corrupted: true,
          source: null,
        }
      }

      const versionMatch = await checkStorageVersion(storagePath, logger)
      if (versionMatch === false) {
        logger.warning('Object store restore has storage version mismatch - falling back to cache')
        await cleanStorage(storagePath)
        return {
          hit: false,
          key: null,
          restoredPath: null,
          corrupted: true,
          source: null,
        }
      }

      return {
        hit: true,
        key: null,
        restoredPath: storagePath,
        corrupted: false,
        source: 'storage',
      }
    }

    if (syncResult.downloaded > 0) {
      logger.warning('Object store returned session sidecar files without main DB - treating as miss', {
        downloaded: syncResult.downloaded,
        failed: syncResult.failed,
      })
    }
  } catch (error) {
    logger.warning('Object store restore failed - treating as miss', {
      error: toErrorMessage(error),
    })
  }

  return {
    hit: false,
    key: null,
    restoredPath: null,
    corrupted: false,
    source: null,
  }
}

function restoreAfterCorruption(restoredKey: string): CacheResult {
  return {
    hit: false,
    key: restoredKey,
    restoredPath: null,
    corrupted: true,
    source: null,
  }
}

export async function restoreCache(options: RestoreCacheOptions): Promise<CacheResult> {
  const {
    components,
    logger,
    storagePath,
    authPath,
    projectIdPath,
    opencodeVersion,
    cacheAdapter = defaultCacheAdapter,
  } = options

  if (process.env.SKIP_CACHE === 'true') {
    logger.debug('Skipping cache restore (SKIP_CACHE=true)')
    await fs.mkdir(storagePath, {recursive: true})
    return {
      hit: false,
      key: null,
      restoredPath: null,
      corrupted: false,
      source: null,
    }
  }

  const primaryKey = buildPrimaryCacheKey(components)
  const restoreKeys = buildRestoreKeys(components)
  const cachePaths = await buildRestoreCachePaths(storagePath, projectIdPath, opencodeVersion)

  logger.info('Restoring cache', {primaryKey, restoreKeys: [...restoreKeys], paths: cachePaths})

  const objectStoreResult = await restoreFromObjectStore(options)
  if (objectStoreResult.hit === true) {
    return objectStoreResult
  }

  try {
    const restoredKey = await cacheAdapter.restoreCache(cachePaths, primaryKey, [...restoreKeys])

    if (restoredKey == null) {
      logger.info('Cache miss - starting with fresh state')
      await fs.mkdir(storagePath, {recursive: true})
      return objectStoreResult
    }

    logger.info('Cache restored', {restoredKey})
    await deleteRestoredShm(storagePath, logger)

    const isCorrupted = await checkStorageCorruption(storagePath, logger)
    if (isCorrupted === true) {
      logger.warning('Cache corruption detected - proceeding with clean state')
      await cleanStorage(storagePath)
      return restoreAfterCorruption(restoredKey)
    }

    const versionMatch = await checkStorageVersion(storagePath, logger)
    if (versionMatch === false) {
      logger.warning('Storage version mismatch - proceeding with clean state')
      await cleanStorage(storagePath)
      return restoreAfterCorruption(restoredKey)
    }

    await deleteAuthJson(authPath, storagePath, logger)

    return {
      hit: true,
      key: restoredKey,
      restoredPath: storagePath,
      corrupted: false,
      source: 'cache',
    }
  } catch (error) {
    logger.warning('Cache restore failed', {
      error: toErrorMessage(error),
    })
    return objectStoreResult
  }
}
