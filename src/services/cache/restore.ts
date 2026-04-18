import type {CacheResult} from '../../shared/types.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import {STORAGE_VERSION} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createS3Adapter, syncSessionsFromStore} from '../object-store/index.js'
import {buildPrimaryCacheKey, buildRestoreKeys} from './cache-key.js'
import {buildRestoreCachePaths, deleteAuthJson, isAuthPathSafe, isPathInsideDirectory} from './paths.js'
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

async function cleanStorage(storagePath: string): Promise<void> {
  try {
    await fs.rm(storagePath, {recursive: true, force: true})
    await fs.mkdir(storagePath, {recursive: true})
  } catch {}
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
    await fs.mkdir(storagePath, {recursive: true})
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

  return {
    hit: false,
    key: null,
    restoredPath: null,
    corrupted: false,
    source: null,
  }
}

async function restoreAfterCorruption(options: RestoreCacheOptions, restoredKey: string): Promise<CacheResult> {
  const fallback = await restoreFromObjectStore(options)
  if (fallback.hit === true) {
    return fallback
  }

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

  try {
    const restoredKey = await cacheAdapter.restoreCache(cachePaths, primaryKey, [...restoreKeys])

    if (restoredKey == null) {
      logger.info('Cache miss - starting with fresh state')
      await fs.mkdir(storagePath, {recursive: true})
      return await restoreFromObjectStore(options)
    }

    logger.info('Cache restored', {restoredKey})

    const isCorrupted = await checkStorageCorruption(storagePath, logger)
    if (isCorrupted === true) {
      logger.warning('Cache corruption detected - proceeding with clean state')
      await cleanStorage(storagePath)
      return await restoreAfterCorruption(options, restoredKey)
    }

    const versionMatch = await checkStorageVersion(storagePath, logger)
    if (versionMatch === false) {
      logger.warning('Storage version mismatch - proceeding with clean state')
      await cleanStorage(storagePath)
      return await restoreAfterCorruption(options, restoredKey)
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
    return restoreFromObjectStore(options)
  }
}
