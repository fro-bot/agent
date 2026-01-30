import type {Logger} from './logger.js'
import type {CacheResult} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import * as cache from '@actions/cache'
import {toErrorMessage} from '../utils/errors.js'
import {buildPrimaryCacheKey, buildRestoreKeys, buildSaveCacheKey, type CacheKeyComponents} from './cache-key.js'
import {STORAGE_VERSION} from './constants.js'

/**
 * Adapter interface for cache operations.
 * Allows injection of mock implementations for testing.
 */
export interface CacheAdapter {
  readonly restoreCache: (paths: string[], primaryKey: string, restoreKeys: string[]) => Promise<string | undefined>
  readonly saveCache: (paths: string[], key: string) => Promise<number>
}

/**
 * Default cache adapter using @actions/cache.
 */
export const defaultCacheAdapter: CacheAdapter = {
  restoreCache: async (paths, primaryKey, restoreKeys) => cache.restoreCache(paths, primaryKey, restoreKeys),
  saveCache: async (paths, key) => cache.saveCache(paths, key),
}

export interface RestoreCacheOptions {
  readonly components: CacheKeyComponents
  readonly logger: Logger
  readonly storagePath: string
  readonly authPath: string
  readonly projectIdPath?: string
  readonly cacheAdapter?: CacheAdapter
}

export interface SaveCacheOptions {
  readonly components: CacheKeyComponents
  readonly runId: number
  readonly logger: Logger
  readonly storagePath: string
  readonly authPath: string
  readonly projectIdPath?: string
  readonly cacheAdapter?: CacheAdapter
}

/**
 * Restore OpenCode storage from cache.
 *
 * Cache miss is not an error - returns hit: false.
 * Corruption is detected and reported but does not throw.
 */
export async function restoreCache(options: RestoreCacheOptions): Promise<CacheResult> {
  const {components, logger, storagePath, authPath, projectIdPath, cacheAdapter = defaultCacheAdapter} = options

  if (process.env.SKIP_CACHE === 'true') {
    logger.debug('Skipping cache restore (SKIP_CACHE=true)')
    await fs.mkdir(storagePath, {recursive: true})
    return {
      hit: false,
      key: null,
      restoredPath: null,
      corrupted: false,
    }
  }

  const primaryKey = buildPrimaryCacheKey(components)
  const restoreKeys = buildRestoreKeys(components)
  const cachePaths = projectIdPath == null ? [storagePath] : [storagePath, projectIdPath]

  logger.info('Restoring cache', {primaryKey, restoreKeys: [...restoreKeys], paths: cachePaths})

  try {
    const restoredKey = await cacheAdapter.restoreCache(cachePaths, primaryKey, [...restoreKeys])

    if (restoredKey == null) {
      logger.info('Cache miss - starting with fresh state')
      await fs.mkdir(storagePath, {recursive: true})
      return {
        hit: false,
        key: null,
        restoredPath: null,
        corrupted: false,
      }
    }

    logger.info('Cache restored', {restoredKey})

    const isCorrupted = await checkStorageCorruption(storagePath, logger)
    if (isCorrupted === true) {
      logger.warning('Cache corruption detected - proceeding with clean state')
      await cleanStorage(storagePath)
      return {
        hit: true,
        key: restoredKey,
        restoredPath: storagePath,
        corrupted: true,
      }
    }

    const versionMatch = await checkStorageVersion(storagePath, logger)
    if (versionMatch === false) {
      logger.warning('Storage version mismatch - proceeding with clean state')
      await cleanStorage(storagePath)
      return {
        hit: true,
        key: restoredKey,
        restoredPath: storagePath,
        corrupted: true,
      }
    }

    await deleteAuthJson(authPath, storagePath, logger)

    return {
      hit: true,
      key: restoredKey,
      restoredPath: storagePath,
      corrupted: false,
    }
  } catch (error) {
    logger.warning('Cache restore failed', {
      error: toErrorMessage(error),
    })
    return {
      hit: false,
      key: null,
      restoredPath: null,
      corrupted: false,
    }
  }
}

/**
 * Save OpenCode storage to cache.
 *
 * Always runs, even on job failure (caller should use if: always()).
 * Excludes auth.json from being saved.
 */
export async function saveCache(options: SaveCacheOptions): Promise<boolean> {
  const {components, runId, logger, storagePath, authPath, projectIdPath, cacheAdapter = defaultCacheAdapter} = options

  if (process.env.SKIP_CACHE === 'true') {
    logger.debug('Skipping cache save (SKIP_CACHE=true)')
    return true
  }

  const saveKey = buildSaveCacheKey(components, runId)
  const cachePaths = projectIdPath == null ? [storagePath] : [storagePath, projectIdPath]

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

/**
 * Check if a file path is inside a directory.
 * Prevents accidental deletion of files outside the cache scope.
 */
export function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
  const resolvedFile = path.resolve(filePath)
  const resolvedDir = path.resolve(directoryPath)
  return resolvedFile.startsWith(resolvedDir + path.sep)
}

/**
 * Delete auth.json to prevent credential caching.
 * Only deletes if the file is inside the storage path being cached.
 */
async function deleteAuthJson(authPath: string, storagePath: string, logger: Logger): Promise<void> {
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

/**
 * Check for obvious storage corruption.
 */
async function checkStorageCorruption(storagePath: string, logger: Logger): Promise<boolean> {
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

/**
 * Check storage version compatibility.
 */
async function checkStorageVersion(storagePath: string, logger: Logger): Promise<boolean> {
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
 * Write storage version marker.
 */
async function writeStorageVersion(storagePath: string): Promise<void> {
  const versionFile = path.join(storagePath, '.version')
  await fs.mkdir(storagePath, {recursive: true})
  await fs.writeFile(versionFile, String(STORAGE_VERSION), 'utf8')
}

async function cleanStorage(storagePath: string): Promise<void> {
  try {
    await fs.rm(storagePath, {recursive: true, force: true})
    await fs.mkdir(storagePath, {recursive: true})
  } catch {}
}

/**
 * Check if directory exists and has content.
 */
async function directoryHasContent(dirPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dirPath)
    return entries.length > 0
  } catch {
    return false
  }
}

/**
 * Ensure auth.json is not in a path that would be cached.
 *
 * This is a safety check to prevent accidental credential caching.
 * auth.json should be in the parent opencode directory, not inside storage/.
 *
 * @param authPath - Path to auth.json file
 * @param storagePath - Path to OpenCode storage directory (cached)
 * @returns true if auth.json is safely outside the storage path
 */
export function isAuthPathSafe(authPath: string, storagePath: string): boolean {
  return !isPathInsideDirectory(authPath, storagePath)
}
