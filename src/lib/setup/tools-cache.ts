import type {Logger} from '../logger.js'
import * as cache from '@actions/cache'
import {toErrorMessage} from '../../utils/errors.js'
import {TOOLS_CACHE_PREFIX} from '../constants.js'

export interface ToolsCacheKeyComponents {
  readonly os: string
  readonly opencodeVersion: string
  readonly omoVersion: string
}

export interface ToolsCacheAdapter {
  readonly restoreCache: (paths: string[], primaryKey: string, restoreKeys: string[]) => Promise<string | undefined>
  readonly saveCache: (paths: string[], key: string) => Promise<number>
}

export const defaultToolsCacheAdapter: ToolsCacheAdapter = {
  restoreCache: async (paths, primaryKey, restoreKeys) => cache.restoreCache(paths, primaryKey, restoreKeys),
  saveCache: async (paths, key) => cache.saveCache(paths, key),
}

export interface RestoreToolsCacheOptions {
  readonly logger: Logger
  readonly os: string
  readonly opencodeVersion: string
  readonly omoVersion: string
  readonly toolCachePath: string
  readonly bunCachePath: string
  readonly omoConfigPath: string
  readonly cacheAdapter?: ToolsCacheAdapter
}

export interface SaveToolsCacheOptions {
  readonly logger: Logger
  readonly os: string
  readonly opencodeVersion: string
  readonly omoVersion: string
  readonly toolCachePath: string
  readonly bunCachePath: string
  readonly omoConfigPath: string
  readonly cacheAdapter?: ToolsCacheAdapter
}

export interface ToolsCacheResult {
  readonly hit: boolean
  readonly restoredKey: string | null
}

export function buildToolsCacheKey(components: ToolsCacheKeyComponents): string {
  const {os, opencodeVersion, omoVersion} = components
  return `${TOOLS_CACHE_PREFIX}-${os}-oc-${opencodeVersion}-omo-${omoVersion}`
}

export function buildToolsRestoreKeys(components: ToolsCacheKeyComponents): readonly string[] {
  const {os, opencodeVersion, omoVersion} = components

  return [`${TOOLS_CACHE_PREFIX}-${os}-oc-${opencodeVersion}-omo-${omoVersion}-`] as const
}

export async function restoreToolsCache(options: RestoreToolsCacheOptions): Promise<ToolsCacheResult> {
  const {
    logger,
    os,
    opencodeVersion,
    omoVersion,
    toolCachePath,
    bunCachePath,
    omoConfigPath,
    cacheAdapter = defaultToolsCacheAdapter,
  } = options

  const primaryKey = buildToolsCacheKey({os, opencodeVersion, omoVersion})
  const restoreKeys = buildToolsRestoreKeys({os, opencodeVersion, omoVersion})
  const cachePaths = [toolCachePath, bunCachePath, omoConfigPath]

  logger.info('Restoring tools cache', {primaryKey, restoreKeys: [...restoreKeys], paths: cachePaths})

  try {
    const restoredKey = await cacheAdapter.restoreCache(cachePaths, primaryKey, [...restoreKeys])

    if (restoredKey == null) {
      logger.info('Tools cache miss - will install tools')
      return {
        hit: false,
        restoredKey: null,
      }
    }

    logger.info('Tools cache restored', {restoredKey})
    return {
      hit: true,
      restoredKey,
    }
  } catch (error) {
    logger.warning('Tools cache restore failed', {
      error: toErrorMessage(error),
    })
    return {
      hit: false,
      restoredKey: null,
    }
  }
}

export async function saveToolsCache(options: SaveToolsCacheOptions): Promise<boolean> {
  const {
    logger,
    os,
    opencodeVersion,
    omoVersion,
    toolCachePath,
    bunCachePath,
    omoConfigPath,
    cacheAdapter = defaultToolsCacheAdapter,
  } = options

  const saveKey = buildToolsCacheKey({os, opencodeVersion, omoVersion})
  const cachePaths = [toolCachePath, bunCachePath, omoConfigPath]

  logger.info('Saving tools cache', {saveKey, paths: cachePaths})

  try {
    await cacheAdapter.saveCache(cachePaths, saveKey)
    logger.info('Tools cache saved', {saveKey})
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) {
      logger.info('Tools cache key already exists, skipping save')
      return true
    }

    logger.warning('Tools cache save failed', {
      error: toErrorMessage(error),
    })
    return false
  }
}
