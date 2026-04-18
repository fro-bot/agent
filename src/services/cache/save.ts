import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import process from 'node:process'
import {STORAGE_VERSION} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createS3Adapter, syncSessionsToStore} from '../object-store/index.js'
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

    const storageExists = await directoryHasContent(storagePath)
    if (storageExists === false) {
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
