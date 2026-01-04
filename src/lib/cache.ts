import type {Logger} from './logger.js'
import type {CacheResult} from './types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import * as cache from '@actions/cache'
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
  readonly cacheAdapter?: CacheAdapter
}

export interface SaveCacheOptions {
  readonly components: CacheKeyComponents
  readonly runId: number
  readonly logger: Logger
  readonly storagePath: string
  readonly authPath: string
  readonly cacheAdapter?: CacheAdapter
}

/**
 * Restore OpenCode storage from cache.
 *
 * Cache miss is not an error - returns hit: false.
 * Corruption is detected and reported but does not throw.
 */
export async function restoreCache(options: RestoreCacheOptions): Promise<CacheResult> {
  const {components, logger, storagePath, authPath, cacheAdapter = defaultCacheAdapter} = options

  // Skip cache operations in test environments
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

  logger.info('Restoring cache', {primaryKey, restoreKeys: [...restoreKeys]})

  try {
    const restoredKey = await cacheAdapter.restoreCache([storagePath], primaryKey, [...restoreKeys])

    if (restoredKey == null) {
      logger.info('Cache miss - starting with fresh state')
      // Ensure storage directory exists for fresh start
      await fs.mkdir(storagePath, {recursive: true})
      return {
        hit: false,
        key: null,
        restoredPath: null,
        corrupted: false,
      }
    }

    logger.info('Cache restored', {restoredKey})

    // Check for corruption
    const isCorrupted = await checkStorageCorruption(storagePath, logger)
    if (isCorrupted) {
      logger.warning('Cache corruption detected - proceeding with clean state')
      await cleanStorage(storagePath)
      return {
        hit: true,
        key: restoredKey,
        restoredPath: storagePath,
        corrupted: true,
      }
    }

    // Verify storage version
    const versionMatch = await checkStorageVersion(storagePath, logger)
    if (!versionMatch) {
      logger.warning('Storage version mismatch - proceeding with clean state')
      await cleanStorage(storagePath)
      return {
        hit: true,
        key: restoredKey,
        restoredPath: storagePath,
        corrupted: true,
      }
    }

    // Delete auth.json if it somehow got cached
    await deleteAuthJson(authPath, logger)

    return {
      hit: true,
      key: restoredKey,
      restoredPath: storagePath,
      corrupted: false,
    }
  } catch (error) {
    // Cache restore failure should not fail the run
    logger.warning('Cache restore failed', {
      error: error instanceof Error ? error.message : String(error),
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
  const {components, runId, logger, storagePath, authPath, cacheAdapter = defaultCacheAdapter} = options

  // Skip cache operations in test environments
  if (process.env.SKIP_CACHE === 'true') {
    logger.debug('Skipping cache save (SKIP_CACHE=true)')
    return true
  }

  const saveKey = buildSaveCacheKey(components, runId)

  logger.info('Saving cache', {saveKey})

  try {
    // Ensure auth.json is not in storage before saving
    await deleteAuthJson(authPath, logger)

    // Check if storage exists and has content
    const storageExists = await directoryHasContent(storagePath)
    if (!storageExists) {
      logger.info('No storage content to cache')
      return false
    }

    // Write storage version marker
    await writeStorageVersion(storagePath)

    await cacheAdapter.saveCache([storagePath], saveKey)
    logger.info('Cache saved', {saveKey})
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) {
      // Cache with this key already exists - not an error
      logger.info('Cache key already exists, skipping save')
      return true
    }

    logger.warning('Cache save failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Delete auth.json to prevent credential caching.
 */
async function deleteAuthJson(authPath: string, logger: Logger): Promise<void> {
  try {
    await fs.unlink(authPath)
    logger.debug('Deleted auth.json before cache operation')
  } catch (error) {
    // File doesn't exist - that's fine
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warning('Failed to delete auth.json', {
        error: error instanceof Error ? error.message : String(error),
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
    if (!stat.isDirectory()) {
      return true
    }

    // Check if directory is readable
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
    // No version file - treat as compatible (first run or legacy)
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

/**
 * Clean storage directory for fresh start.
 */
async function cleanStorage(storagePath: string): Promise<void> {
  try {
    await fs.rm(storagePath, {recursive: true, force: true})
    await fs.mkdir(storagePath, {recursive: true})
  } catch {
    // Best effort - continue even if cleanup fails
  }
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
