import type {Logger} from '../../shared/logger.js'
import type {CacheKeyComponents} from './cache-key.js'
import * as cache from '@actions/cache'

export interface CacheAdapter {
  readonly restoreCache: (paths: string[], primaryKey: string, restoreKeys: string[]) => Promise<string | undefined>
  readonly saveCache: (paths: string[], key: string) => Promise<number>
}

function createDefaultCacheAdapter(): CacheAdapter {
  return {
    restoreCache: async (paths, primaryKey, restoreKeys) => cache.restoreCache(paths, primaryKey, restoreKeys),
    saveCache: async (paths, key) => cache.saveCache(paths, key),
  }
}

export const defaultCacheAdapter: CacheAdapter = createDefaultCacheAdapter()

export interface RestoreCacheOptions {
  readonly components: CacheKeyComponents
  readonly logger: Logger
  readonly storagePath: string
  readonly authPath: string
  readonly projectIdPath?: string
  readonly opencodeVersion?: string | null
  readonly cacheAdapter?: CacheAdapter
}

export interface SaveCacheOptions {
  readonly components: CacheKeyComponents
  readonly runId: number
  readonly logger: Logger
  readonly storagePath: string
  readonly authPath: string
  readonly projectIdPath?: string
  readonly opencodeVersion?: string | null
  readonly cacheAdapter?: CacheAdapter
}
