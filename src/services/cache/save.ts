import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import {createS3Adapter, syncSessionsToStore} from '@fro-bot/runtime'
import {STORAGE_VERSION} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'
import {buildSaveCacheKey} from './cache-key.js'
import {buildSaveCachePaths, deleteAuthJson} from './paths.js'
import {defaultCacheAdapter, type SaveCacheOptions} from './types.js'

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

/**
 * Returns true if there is any real cacheable content: either storagePath has files,
 * or any SQLite DB-family file (opencode.db, opencode.db-wal, opencode.db-shm) exists
 * and is non-empty in cachePaths.
 *
 * OpenCode 1.17.x persists sessions in opencode.db at path.dirname(storagePath), NOT
 * inside storagePath itself. Without this check the old guard would return false on every
 * real run, skipping the cache save and breaking session continuity.
 *
 * WAL mode note: server.close() sends proc.kill() without awaiting a checkpoint, so a
 * valid session can have opencode.db at 0 bytes with all data still in opencode.db-wal.
 * We must treat any non-empty DB-family file as sufficient evidence of cacheable content.
 */
async function hasCacheableContent(storagePath: string, cachePaths: readonly string[]): Promise<boolean> {
  if (await directoryHasContent(storagePath)) {
    return true
  }

  // Check all three SQLite DB-family files — any non-empty one is sufficient.
  // buildSaveCachePaths already includes wal/shm only when they exist on disk, so
  // checking cachePaths membership is the right gate (avoids redundant stat calls).
  const dbFamilyBasenames = new Set(['opencode.db', 'opencode.db-wal', 'opencode.db-shm'])
  const dbFamilyPaths = cachePaths.filter(p => dbFamilyBasenames.has(path.basename(p)))

  for (const dbPath of dbFamilyPaths) {
    try {
      const stat = await fs.stat(dbPath)
      if (stat.size > 0) {
        return true
      }
    } catch {
      // file missing or inaccessible — not cacheable from this source
    }
  }

  return false
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
  const cachePaths = await buildSaveCachePaths(storagePath, projectIdPath, opencodeVersion)

  logger.info('Saving cache', {saveKey, paths: cachePaths})

  try {
    await deleteAuthJson(authPath, storagePath, logger)

    const hasContent = await hasCacheableContent(storagePath, cachePaths)
    if (hasContent === false) {
      logger.info('No storage content to cache')
      return false
    }

    await writeStorageVersion(storagePath)

    if (options.storeConfig?.enabled === true) {
      try {
        const adapter = options.storeAdapter ?? createS3Adapter(options.storeConfig, logger)
        const syncResult = await syncSessionsToStore(
          adapter,
          options.storeConfig,
          components.agentIdentity,
          components.repo,
          storagePath,
          logger,
        )
        logger.info('Object store session sync completed', syncResult)
      } catch (error) {
        logger.warning('Object store session sync failed (non-fatal)', {
          error: toErrorMessage(error),
        })
      }
    }

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
