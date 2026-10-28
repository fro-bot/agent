import type {Logger} from '../../shared/logger.js'
import * as cache from '@actions/cache'
import {TOOLS_CACHE_PREFIX} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'

export interface ToolsCacheKeyComponents {
  readonly os: string
  readonly opencodeVersion: string
  /**
   * Digest component of a stock V2 key (`StockV2Policy.cacheId`). Omitted for V1 and harness pins, whose
   * keys are unchanged. It makes a V2 key unmatchable by an entry saved before digests were recorded
   * or for a different digest.
   */
  readonly opencodeDigestId?: string
  readonly systematicVersion: string
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
  readonly opencodeDigestId?: string
  readonly systematicVersion: string
  readonly toolCachePath: string
  readonly opencodeCachePath: string
  readonly cacheAdapter?: ToolsCacheAdapter
}

export interface SaveToolsCacheOptions {
  readonly logger: Logger
  readonly os: string
  readonly opencodeVersion: string
  readonly opencodeDigestId?: string
  readonly systematicVersion: string
  readonly toolCachePath: string
  readonly opencodeCachePath: string
  readonly cacheAdapter?: ToolsCacheAdapter
}

export interface ToolsCacheResult {
  readonly hit: boolean
  readonly restoredKey: string | null
}

function openCodeKeyPart({opencodeVersion, opencodeDigestId}: ToolsCacheKeyComponents): string {
  return opencodeDigestId === undefined ? opencodeVersion : `${opencodeVersion}-${opencodeDigestId}`
}

export function buildToolsCacheKey(components: ToolsCacheKeyComponents): string {
  const {os, systematicVersion} = components

  return `${TOOLS_CACHE_PREFIX}-${os}-oc-${openCodeKeyPart(components)}-sys-${systematicVersion}`
}

export function buildToolsRestoreKeys(components: ToolsCacheKeyComponents): readonly string[] {
  const {os, systematicVersion} = components

  return [`${TOOLS_CACHE_PREFIX}-${os}-oc-${openCodeKeyPart(components)}-sys-${systematicVersion}-`] as const
}

export function buildCachePaths(options: {toolCachePath: string; opencodeCachePath: string}): readonly string[] {
  return [options.toolCachePath, options.opencodeCachePath]
}

export async function restoreToolsCache(options: RestoreToolsCacheOptions): Promise<ToolsCacheResult> {
  const {
    logger,
    os,
    opencodeVersion,
    opencodeDigestId,
    systematicVersion,
    toolCachePath,
    opencodeCachePath,
    cacheAdapter = defaultToolsCacheAdapter,
  } = options

  const primaryKey = buildToolsCacheKey({os, opencodeVersion, opencodeDigestId, systematicVersion})
  const restoreKeys = buildToolsRestoreKeys({os, opencodeVersion, opencodeDigestId, systematicVersion})
  const cachePaths = buildCachePaths({toolCachePath, opencodeCachePath})

  logger.info('Restoring tools cache', {primaryKey, restoreKeys: [...restoreKeys], paths: cachePaths})

  try {
    const restoredKey = await cacheAdapter.restoreCache([...cachePaths], primaryKey, [...restoreKeys])

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
    opencodeDigestId,
    systematicVersion,
    toolCachePath,
    opencodeCachePath,
    cacheAdapter = defaultToolsCacheAdapter,
  } = options

  const saveKey = buildToolsCacheKey({os, opencodeVersion, opencodeDigestId, systematicVersion})
  const cachePaths = buildCachePaths({toolCachePath, opencodeCachePath})

  logger.info('Saving tools cache', {saveKey, paths: cachePaths})

  try {
    const cacheId = await cacheAdapter.saveCache([...cachePaths], saveKey)
    // @actions/cache returns -1 for both write failures and reservation collisions. The
    // adapter exposes no reason, so report the save as unpersisted rather than claiming success.
    if (cacheId === -1) {
      logger.warning('Tools cache save did not persist', {saveKey})
      return false
    }

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
