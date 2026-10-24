import type {ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
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
  readonly storeConfig?: ObjectStoreConfig
  readonly storeAdapter?: ObjectStoreAdapter
  readonly cacheAdapter?: CacheAdapter
}

/**
 * Whether a save may publish the session to the shared object store.
 *
 * - `publish` (the default): upload `sessions/opencode.db` when the object store is enabled. Only a
 *   caller that holds the coordination lease may choose this: the object is shared by every run of the
 *   repo, and the upload is an unconditional last-writer-wins `PutObject`.
 * - `withhold`: write only to the Actions cache. For a caller that does not hold the lease, such as the
 *   post hook, which runs after the main step has released it.
 *
 * Named separately from the absence of `storeConfig`: a missing `storeConfig` means "no object store is
 * configured", which is a different fact from "a store exists but this caller must not publish to it".
 */
export type ObjectStorePublish = 'publish' | 'withhold'

export interface SaveCacheOptions {
  readonly components: CacheKeyComponents
  readonly runId: number
  readonly logger: Logger
  readonly storagePath: string
  readonly authPath: string
  readonly projectIdPath?: string
  readonly opencodeVersion?: string | null
  readonly storeConfig?: ObjectStoreConfig
  readonly storeAdapter?: ObjectStoreAdapter
  readonly objectStorePublish?: ObjectStorePublish
  readonly cacheAdapter?: CacheAdapter
}
