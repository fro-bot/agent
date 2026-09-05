import type {CacheResult} from '../../shared/types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import {createS3Adapter, syncSessionsFromStore} from '@fro-bot/runtime'
import {STORAGE_VERSION} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'
import {buildPrimaryCacheKey, buildRestoreKeys} from './cache-key.js'
import {
  buildCachePaths,
  buildDbFamilyPaths,
  buildDbShmPath,
  buildDbWalPath,
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

// The object store carries no generation marker across its two independently-overwritten
// keys (see DB_TRANSPORTABLE_BASENAMES in packages/runtime/src/session/version.ts), so a
// downloaded write-ahead log cannot be trusted to belong to the opencode.db object it
// arrived beside — unlike an Actions-cache entry, where one archive is one atomic save and
// a legacy db+wal pair is genuinely consistent by construction. Healthy saves no longer
// upload this file at all, so any object still present is either a pre-fix artifact or,
// worse, a stale generation the non-atomic upload sequence left behind after a healthy
// save reused the same db key. Reproduced against real node:sqlite: pairing a fresh
// database with an older log this way can either surface as an outright "database disk
// image is malformed" or, worse, checkpoint successfully while silently replaying stale
// rows the fresh database never had. Deleting the downloaded copy before anything opens
// the database trades a definite, bounded loss — this generation's last transactions, if
// the log genuinely still held any uncheckpointed writes from between saves — for an
// open-ended one: a silent rollback to an arbitrary older generation with no error, no log
// line, and no way for a later run to tell it happened. That trade is not free, but it is
// the only one of the two failure modes that is bounded, visible, and consistent every time
// (see checkpoint.ts's doc comment for the real-node:sqlite reproduction of that silent-
// replay case).
//
// Called from a `finally` around the whole object-store restore attempt in
// restoreFromObjectStore below, not inline after syncSessionsFromStore's own return — a
// call sitting inside that function's try block only runs on the non-throwing path, and
// syncSessionsFromStore's download loop has a real throw site (fs.mkdir per key,
// content-sync.ts) that a bare inline call would silently skip, leaving the very log this
// function exists to remove sitting on disk for whatever the Actions-cache restore
// extracts next. A `finally` fires on every exit from that try: the thrown-error path, and
// every early return inside it (a corrupt or version-mismatched hit, and the successful hit
// itself). It deliberately does NOT run when the object store is disabled — that guard
// returns before the try block is ever entered — so a self-hosted runner with the object
// store turned off never has a locally-persistent write-ahead log touched by this function.
// Nothing between the try block's start and its end ever opens the database with
// node:sqlite (checkStorageCorruption/checkStorageVersion only stat/read the storage
// directory and its .version marker), so running the deletion at any point up to and
// including the try's exit is still strictly before anything could open it.
async function deleteDownloadedObjectStoreWal(
  storagePath: string,
  logger: RestoreCacheOptions['logger'],
): Promise<void> {
  const walPath = buildDbWalPath(storagePath)
  try {
    await fs.unlink(walPath)
    logger.debug('Deleted write-ahead log downloaded from object store (untrusted pairing, see restore.ts)')
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      logger.warning('Failed to delete write-ahead log downloaded from object store', {
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
  } finally {
    await deleteDownloadedObjectStoreWal(storagePath, logger)
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
  const cachePaths = await buildCachePaths(storagePath, projectIdPath, opencodeVersion)

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
