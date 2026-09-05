import type {ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {CacheKeyComponents} from './cache-key.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {ok} from '../../shared/types.js'
import {
  checkpointDatabase,
  isAuthPathSafe,
  isPathInsideDirectory,
  restoreCache,
  saveCache,
  type CacheAdapter,
  type RestoreCacheOptions,
  type SaveCacheOptions,
} from './index.js'

// Test fixtures
const testComponents: CacheKeyComponents = {
  agentIdentity: 'github',
  repo: 'owner/repo',
  ref: 'main',
  os: 'Linux',
}

// Create a silent logger for tests
function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warning: () => {},
    error: () => {},
  }
}

// Create a mock cache adapter for testing
function createMockCacheAdapter(options: {
  restoreResult?: string | undefined
  saveResult?: number
  saveError?: Error
}): CacheAdapter {
  return {
    restoreCache: async () => options.restoreResult,
    saveCache: async () => {
      if (options.saveError != null) {
        throw options.saveError
      }
      return options.saveResult ?? 1
    },
  }
}

function createMockStoreAdapter(overrides: Partial<ObjectStoreAdapter> = {}): ObjectStoreAdapter {
  return {
    upload: async () => ok(undefined),
    download: async () => ok(undefined),
    list: async () => ok([]),
    ...overrides,
  }
}

const testStoreConfig: ObjectStoreConfig = {
  enabled: true,
  bucket: 'test-bucket',
  region: 'us-east-1',
  prefix: 'fro-bot-state',
}

describe('restoreCache', () => {
  let tempDir: string
  let storagePath: string
  let authPath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-test-'))
    storagePath = path.join(tempDir, 'storage')
    authPath = path.join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('returns hit: false on cache miss', async () => {
    // #given a cache adapter that returns undefined (miss)
    const adapter = createMockCacheAdapter({restoreResult: undefined})
    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache
    const result = await restoreCache(options)

    // #then result indicates miss
    expect(result.hit).toBe(false)
    expect(result.key).toBeNull()
    expect(result.corrupted).toBe(false)
    expect(result.source).toBeNull()
  })

  it('returns hit: true with key on cache hit', async () => {
    // #given a cache adapter that returns a key (hit)
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const adapter = createMockCacheAdapter({restoreResult: restoredKey})

    // Create storage directory to simulate restored cache
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache
    const result = await restoreCache(options)

    // #then result indicates hit with correct key
    expect(result.hit).toBe(true)
    expect(result.key).toBe(restoredKey)
    expect(result.corrupted).toBe(false)
    expect(result.source).toBe('cache')
  })

  it('uses an object-store main DB before a cache hit', async () => {
    // #given a cache hit and an object store containing the main session database
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const cacheRestore = vi.fn<CacheAdapter['restoreCache']>(async () => 'cache-key')
    const storeAdapter = createMockStoreAdapter({
      list: vi.fn(async () => ok(['fro-bot-state/github/owner/repo/sessions/opencode.db'])),
      download: vi.fn(async (_key: string, localPath: string) => {
        await fs.mkdir(path.dirname(localPath), {recursive: true})
        await fs.writeFile(localPath, 'fresh-store-db')
        return ok(undefined)
      }),
    })

    // #when restoring cache
    const result = await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: {
        restoreCache: cacheRestore,
        saveCache: async () => 1,
      },
      storeConfig: testStoreConfig,
      storeAdapter,
    })

    // #then the object store wins and the Actions cache is not consulted
    expect(result).toMatchObject({hit: true, source: 'storage', restoredPath: storagePath})
    expect(cacheRestore).not.toHaveBeenCalled()
    await expect(fs.readFile(path.join(path.dirname(storagePath), 'opencode.db'), 'utf8')).resolves.toBe(
      'fresh-store-db',
    )
  })

  it('falls through to cache when object-store storage is corrupt', async () => {
    // #given a cache hit and an object store containing a corrupt session restore
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'cached-state')

    const cacheRestore = vi.fn<CacheAdapter['restoreCache']>(async () => {
      await fs.chmod(storagePath, 0o700)
      return 'cache-key'
    })
    const storeAdapter = createMockStoreAdapter({
      list: vi.fn(async () => ok(['fro-bot-state/github/owner/repo/sessions/opencode.db'])),
      download: vi.fn(async (_key: string, localPath: string) => {
        await fs.mkdir(path.dirname(localPath), {recursive: true})
        await fs.writeFile(localPath, 'corrupt-store-db')
        return ok(undefined)
      }),
    })
    // Make the restored storage path unreadable so checkStorageCorruption reports it as corrupt.
    await fs.chmod(storagePath, 0o000)

    try {
      // #when restoring cache
      const result = await restoreCache({
        components: testComponents,
        logger: createTestLogger(),
        storagePath,
        authPath,
        cacheAdapter: {
          restoreCache: cacheRestore,
          saveCache: async () => 1,
        },
        storeConfig: testStoreConfig,
        storeAdapter,
      })

      // #then corrupt object-store state falls through to the usable cache
      expect(result).toMatchObject({hit: true, source: 'cache', key: 'cache-key'})
      expect(cacheRestore).toHaveBeenCalledTimes(1)

      // #and the corrupt/suspect database downloaded from the object store is removed, not left behind
      await fs.chmod(storagePath, 0o700)
      await expect(fs.access(path.join(path.dirname(storagePath), 'opencode.db'))).rejects.toThrow()
    } finally {
      await fs.chmod(storagePath, 0o700)
    }
  })

  it('falls through to cache when object-store storage has a version mismatch', async () => {
    // #given a cache hit and an object store restore whose storage carries a stale version marker
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'cached-state')
    await fs.writeFile(path.join(storagePath, '.version'), '999')

    const cacheRestore = vi.fn<CacheAdapter['restoreCache']>(async () => 'cache-key')
    const storeAdapter = createMockStoreAdapter({
      list: vi.fn(async () => ok(['fro-bot-state/github/owner/repo/sessions/opencode.db'])),
      download: vi.fn(async (_key: string, localPath: string) => {
        await fs.mkdir(path.dirname(localPath), {recursive: true})
        await fs.writeFile(localPath, 'versioned-store-db')
        return ok(undefined)
      }),
    })

    // #when restoring cache
    const result = await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: {
        restoreCache: cacheRestore,
        saveCache: async () => 1,
      },
      storeConfig: testStoreConfig,
      storeAdapter,
    })

    // #then the version mismatch is caught before the object-store restore is accepted as a hit,
    // and it falls through to the Actions cache instead
    expect(result).toMatchObject({hit: true, source: 'cache', key: 'cache-key'})
    expect(cacheRestore).toHaveBeenCalledTimes(1)
    await expect(fs.access(path.join(path.dirname(storagePath), 'opencode.db'))).rejects.toThrow()
  })

  it('falls through to cache when object store restores only sidecars, deleting the untrusted downloaded wal first', async () => {
    // #given an object store with a sidecar but no main session database
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'cached-state')

    const cacheRestore = vi.fn<CacheAdapter['restoreCache']>(async () => 'cache-key')
    const storeList = vi.fn(async () => ok(['fro-bot-state/github/owner/repo/sessions/opencode.db-wal']))
    const storeDownload = vi.fn<ObjectStoreAdapter['download']>(async (_key, localPath) => {
      await fs.mkdir(path.dirname(localPath), {recursive: true})
      await fs.writeFile(localPath, 'sidecar')
      return ok(undefined)
    })
    const storeAdapter = createMockStoreAdapter({
      list: storeList,
      download: storeDownload,
    })

    // #when restoring cache
    const result = await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: {
        restoreCache: cacheRestore,
        saveCache: async () => 1,
      },
      storeConfig: testStoreConfig,
      storeAdapter,
    })

    // #then sidecars are not authoritative and the Actions cache is used. The downloaded
    // write-ahead log is untrusted (no main db arrived beside it to pair it with) and is
    // deleted immediately after the object-store sync returns, not left on disk for
    // whatever the Actions cache restores next to be paired with.
    expect(result).toMatchObject({hit: true, source: 'cache', key: 'cache-key'})
    expect(storeList).toHaveBeenCalledTimes(1)
    expect(storeDownload).toHaveBeenCalledTimes(1)
    await expect(fs.access(path.join(path.dirname(storagePath), 'opencode.db-wal'))).rejects.toThrow()
    expect(cacheRestore).toHaveBeenCalledTimes(1)
    expect(storeList.mock.invocationCallOrder[0]).toBeLessThan(cacheRestore.mock.invocationCallOrder[0] ?? 0)
  })

  it('deletes a sidecar-only object-store wal even when the Actions cache also misses (fresh db never pairs with a stale log)', async () => {
    // #given an object store with only a stale write-ahead log sidecar, and an Actions
    // cache that also misses — the harder ordering case: restoreCache's own miss branch
    // (restoredKey == null) never touches storagePath's sibling directory, so a wal left
    // behind here would still be sitting beside whatever fresh opencode.db bootstrap
    // creates next
    const cacheRestore = vi.fn<CacheAdapter['restoreCache']>(async () => undefined)
    const storeList = vi.fn(async () => ok(['fro-bot-state/github/owner/repo/sessions/opencode.db-wal']))
    const storeDownload = vi.fn<ObjectStoreAdapter['download']>(async (_key, localPath) => {
      await fs.mkdir(path.dirname(localPath), {recursive: true})
      await fs.writeFile(localPath, 'stale-generation-wal')
      return ok(undefined)
    })
    const storeAdapter = createMockStoreAdapter({list: storeList, download: storeDownload})

    // #when restoring cache
    const result = await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: {
        restoreCache: cacheRestore,
        saveCache: async () => 1,
      },
      storeConfig: testStoreConfig,
      storeAdapter,
    })

    // #then the restore is a genuine miss, and no stale write-ahead log survives to be
    // paired with a database OpenCode has not created yet
    expect(result).toMatchObject({hit: false, source: null})
    await expect(fs.access(path.join(path.dirname(storagePath), 'opencode.db-wal'))).rejects.toThrow()
  })

  it('falls through to cache when object store is disabled', async () => {
    // #given a cache hit and a disabled object store
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'cached-state')

    const cacheRestore = vi.fn<CacheAdapter['restoreCache']>(async () => 'cache-key')
    const storeList = vi.fn(async () => ok([]))

    // #when restoring cache
    const result = await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: {
        restoreCache: cacheRestore,
        saveCache: async () => 1,
      },
      storeConfig: {...testStoreConfig, enabled: false},
      storeAdapter: createMockStoreAdapter({list: storeList}),
    })

    // #then disabled object storage is a no-op and cache restore remains unchanged
    expect(result).toMatchObject({hit: true, source: 'cache', key: 'cache-key'})
    expect(cacheRestore).toHaveBeenCalledTimes(1)
    expect(storeList).not.toHaveBeenCalled()
  })

  it('falls through to cache when object store restore throws', async () => {
    // #given a cache hit and an object store that throws while listing
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'cached-state')

    const cacheRestore = vi.fn<CacheAdapter['restoreCache']>(async () => 'cache-key')
    const storeList = vi.fn(async () => {
      throw new Error('object store unavailable')
    })
    const storeAdapter = createMockStoreAdapter({
      list: storeList,
    })

    // #when restoring cache
    const result = await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: {
        restoreCache: cacheRestore,
        saveCache: async () => 1,
      },
      storeConfig: testStoreConfig,
      storeAdapter,
    })

    // #then the object-store failure is non-fatal and cache restore succeeds
    expect(result).toMatchObject({hit: true, source: 'cache', key: 'cache-key'})
    expect(storeList).toHaveBeenCalledTimes(1)
    expect(cacheRestore).toHaveBeenCalledTimes(1)
    expect(storeList.mock.invocationCallOrder[0]).toBeLessThan(cacheRestore.mock.invocationCallOrder[0] ?? 0)
  })

  it('returns a clean miss when cache and object store are both empty', async () => {
    // #given an empty cache and an empty enabled object store
    const cacheRestore = vi.fn<CacheAdapter['restoreCache']>(async () => undefined)
    const storeList = vi.fn(async () => ok([]))

    // #when restoring cache
    const result = await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: {
        restoreCache: cacheRestore,
        saveCache: async () => 1,
      },
      storeConfig: testStoreConfig,
      storeAdapter: createMockStoreAdapter({list: storeList}),
    })

    // #then the restore remains a clean miss
    expect(result).toEqual({
      hit: false,
      key: null,
      restoredPath: null,
      corrupted: false,
      source: null,
    })
    expect(storeList).toHaveBeenCalledTimes(1)
    expect(cacheRestore).toHaveBeenCalledTimes(1)
    expect(storeList.mock.invocationCallOrder[0]).toBeLessThan(cacheRestore.mock.invocationCallOrder[0] ?? 0)
  })

  it('detects corruption when storage is not a directory', async () => {
    // #given storage path is a file instead of directory
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const adapter = createMockCacheAdapter({restoreResult: restoredKey})

    // Create a file at storage path (corrupted state)
    await fs.mkdir(path.dirname(storagePath), {recursive: true})
    await fs.writeFile(storagePath, 'not a directory')

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache
    const result = await restoreCache(options)

    // #then result indicates corruption and falls back to miss semantics without object store
    expect(result.hit).toBe(false)
    expect(result.corrupted).toBe(true)
    expect(result.source).toBeNull()
  })

  it('detects version mismatch and treats as corruption', async () => {
    // #given storage with wrong version
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const adapter = createMockCacheAdapter({restoreResult: restoredKey})

    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, '.version'), '999') // Wrong version

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache
    const result = await restoreCache(options)

    // #then version mismatch is treated as corruption and falls back to miss semantics without object store
    expect(result.hit).toBe(false)
    expect(result.corrupted).toBe(true)
    expect(result.source).toBeNull()
  })

  it('removes the database family, not just storagePath, when declaring cache corruption', async () => {
    // #given a cache hit whose storage is corrupted, with a full DB family present beside it
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const adapter = createMockCacheAdapter({restoreResult: restoredKey})
    const dbDir = path.dirname(storagePath)

    await fs.mkdir(dbDir, {recursive: true})
    await fs.writeFile(storagePath, 'not a directory') // corrupts storage: file instead of dir
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'db data')
    await fs.writeFile(path.join(dbDir, 'opencode.db-wal'), 'wal data')
    await fs.writeFile(path.join(dbDir, 'opencode.db-shm'), 'shm data')

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache
    const result = await restoreCache(options)

    // #then corruption is reported and the whole database family is removed, not left behind
    expect(result.corrupted).toBe(true)
    await expect(fs.access(path.join(dbDir, 'opencode.db'))).rejects.toThrow()
    await expect(fs.access(path.join(dbDir, 'opencode.db-wal'))).rejects.toThrow()
    await expect(fs.access(path.join(dbDir, 'opencode.db-shm'))).rejects.toThrow()
  })

  it('removes the database family when the storage version mismatches', async () => {
    // #given a cache hit whose storage version does not match, with a DB family present
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const adapter = createMockCacheAdapter({restoreResult: restoredKey})
    const dbDir = path.dirname(storagePath)

    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, '.version'), '999')
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'db data')
    await fs.writeFile(path.join(dbDir, 'opencode.db-wal'), 'wal data')

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache
    const result = await restoreCache(options)

    // #then the mismatch clears the database family so the next run starts genuinely fresh
    expect(result.corrupted).toBe(true)
    await expect(fs.access(path.join(dbDir, 'opencode.db'))).rejects.toThrow()
    await expect(fs.access(path.join(dbDir, 'opencode.db-wal'))).rejects.toThrow()
  })

  it('does not throw when the database family is already absent during cleanup', async () => {
    // #given a corrupted restore where no DB-family file was ever written
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const adapter = createMockCacheAdapter({restoreResult: restoredKey})

    await fs.mkdir(path.dirname(storagePath), {recursive: true})
    await fs.writeFile(storagePath, 'not a directory')

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache (a missing database family must not be an error)
    const result = await restoreCache(options)

    // #then corruption is still reported cleanly, without throwing
    expect(result.corrupted).toBe(true)
  })

  it('excludes -wal and -shm from the restore path set (restore and save share one list, by construction)', async () => {
    // #given a cache adapter that records the paths requested for restore
    const restoreCacheSpy = vi.fn<CacheAdapter['restoreCache']>(async () => undefined)

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.17.6',
      cacheAdapter: {restoreCache: restoreCacheSpy, saveCache: async () => 1},
    }

    // #when restoring cache
    await restoreCache(options)

    // #then the restore-side path set matches the save-side one exactly: neither sidecar
    // is present. Restore and save now call the same buildCachePaths, so a version that
    // included -shm here (as a prior revision of this test asserted) would make every
    // save's @actions/cache version hash disagree with what restore requests, and no entry
    // written since would ever be found.
    const requestedPaths = restoreCacheSpy.mock.calls[0]?.[0]
    expect(requestedPaths).not.toContain(path.join(path.dirname(storagePath), 'opencode.db-shm'))
    expect(requestedPaths).not.toContain(path.join(path.dirname(storagePath), 'opencode.db-wal'))
  })

  it('deletes a restored opencode.db-shm before returning a hit', async () => {
    // #given a cache adapter that "restores" a stale shm sidecar alongside the db
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const dbDir = path.dirname(storagePath)
    const adapter: CacheAdapter = {
      restoreCache: async () => {
        await fs.mkdir(storagePath, {recursive: true})
        await fs.writeFile(path.join(dbDir, 'opencode.db'), 'db data')
        await fs.writeFile(path.join(dbDir, 'opencode.db-shm'), 'stale shm')
        return restoredKey
      },
      saveCache: async () => 1,
    }

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache
    const result = await restoreCache(options)

    // #then the restore succeeds but the stale, machine-local shm sidecar is deleted
    expect(result.hit).toBe(true)
    await expect(fs.access(path.join(dbDir, 'opencode.db-shm'))).rejects.toThrow()
    await expect(fs.access(path.join(dbDir, 'opencode.db'))).resolves.toBeUndefined()
  })

  it('suppresses ENOENT when no opencode.db-shm was restored', async () => {
    // #given a cache adapter that restores a plain db with no shm sidecar at all — the
    // errno guard's ENOENT branch must stay silent for this, the common case
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const dbDir = path.dirname(storagePath)
    const adapter: CacheAdapter = {
      restoreCache: async () => {
        await fs.mkdir(storagePath, {recursive: true})
        await fs.writeFile(path.join(dbDir, 'opencode.db'), 'db data')
        return restoredKey
      },
      saveCache: async () => 1,
    }
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }

    const result = await restoreCache({
      components: testComponents,
      logger,
      storagePath,
      authPath,
      cacheAdapter: adapter,
    })

    // #then the restore succeeds and the missing-shm ENOENT is suppressed, not logged
    expect(result.hit).toBe(true)
    expect(logger.warning).not.toHaveBeenCalled()
  })

  it('logs a warning instead of suppressing when opencode.db-shm exists but cannot be deleted', async () => {
    // #given opencode.db-shm is a directory, not a file — fs.unlink fails with a real
    // non-ENOENT error (EISDIR/EPERM depending on platform), which the errno guard must
    // not misclassify as "nothing to delete"
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const dbDir = path.dirname(storagePath)
    const adapter: CacheAdapter = {
      restoreCache: async () => {
        await fs.mkdir(storagePath, {recursive: true})
        await fs.writeFile(path.join(dbDir, 'opencode.db'), 'db data')
        await fs.mkdir(path.join(dbDir, 'opencode.db-shm'), {recursive: true})
        return restoredKey
      },
      saveCache: async () => 1,
    }
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }

    const result = await restoreCache({
      components: testComponents,
      logger,
      storagePath,
      authPath,
      cacheAdapter: adapter,
    })

    // #then the restore still succeeds, but the non-ENOENT deletion failure is logged
    expect(result.hit).toBe(true)
    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to delete restored opencode.db-shm',
      expect.objectContaining({error: expect.any(String) as unknown as string}),
    )
  })

  it('deletes auth.json if present inside storage after restore', async () => {
    // #given auth.json exists inside storage directory after cache restore
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const adapter = createMockCacheAdapter({restoreResult: restoredKey})

    await fs.mkdir(storagePath, {recursive: true})
    const authInsideStorage = path.join(storagePath, 'auth.json')
    await fs.writeFile(authInsideStorage, '{"token": "secret"}')

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath: authInsideStorage,
      cacheAdapter: adapter,
    }

    // #when restoring cache
    await restoreCache(options)

    // #then auth.json inside storage is deleted
    await expect(fs.access(authInsideStorage)).rejects.toThrow()
  })

  it('does NOT delete auth.json if outside storage path', async () => {
    // #given auth.json exists outside storage directory
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const adapter = createMockCacheAdapter({restoreResult: restoredKey})

    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(authPath, '{"token": "secret"}')

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache
    await restoreCache(options)

    // #then auth.json outside storage is NOT deleted
    await expect(fs.access(authPath)).resolves.toBeUndefined()
  })

  it('handles restore errors gracefully without throwing', async () => {
    // #given a cache adapter that throws
    const adapter: CacheAdapter = {
      restoreCache: async () => {
        throw new Error('Network error')
      },
      saveCache: async () => 1,
    }

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache (should not throw)
    const result = await restoreCache(options)

    // #then returns miss result
    expect(result.hit).toBe(false)
    expect(result.corrupted).toBe(false)
    expect(result.source).toBeNull()
  })

  it('accepts matching version file', async () => {
    // #given storage with correct version (1)
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const adapter = createMockCacheAdapter({restoreResult: restoredKey})

    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, '.version'), '1')
    await fs.writeFile(path.join(storagePath, 'data.db'), 'test')

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache
    const result = await restoreCache(options)

    // #then no corruption detected
    expect(result.hit).toBe(true)
    expect(result.corrupted).toBe(false)
    expect(result.source).toBe('cache')
  })

  it('treats missing version file as compatible (first run)', async () => {
    // #given storage without version file
    const restoredKey = 'opencode-storage-github-owner-repo-main-Linux'
    const adapter = createMockCacheAdapter({restoreResult: restoredKey})

    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'data.db'), 'test')

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when restoring cache
    const result = await restoreCache(options)

    // #then no corruption (legacy compatibility)
    expect(result.hit).toBe(true)
    expect(result.corrupted).toBe(false)
    expect(result.source).toBe('cache')
  })

  it('restores from object store on cache miss when configured', async () => {
    const list = vi.fn(async () => ok(['fro-bot-state/github/owner/repo/sessions/opencode.db']))
    const download = vi.fn(async (key: string, localPath: string) => {
      await fs.mkdir(path.dirname(localPath), {recursive: true})
      await fs.writeFile(localPath, key)
      return ok(undefined)
    })
    const storeAdapter = createMockStoreAdapter({list, download})

    const result = await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: createMockCacheAdapter({restoreResult: undefined}),
      storeConfig: testStoreConfig,
      storeAdapter,
    })

    expect(result).toMatchObject({hit: true, source: 'storage', corrupted: false, restoredPath: storagePath})
    expect(list).toHaveBeenCalledWith('fro-bot-state/github/owner/repo/sessions/')
    await expect(fs.readFile(path.join(path.dirname(storagePath), 'opencode.db'), 'utf8')).resolves.toContain(
      'opencode.db',
    )
  })

  it('returns miss with null source on cache miss when object store is not configured', async () => {
    const result = await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: createMockCacheAdapter({restoreResult: undefined}),
    })

    expect(result).toEqual({
      hit: false,
      key: null,
      restoredPath: null,
      corrupted: false,
      source: null,
    })
  })

  it('returns miss when object store download fails after cache miss', async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }
    const storeAdapter = createMockStoreAdapter({
      list: async () => ok(['fro-bot-state/github/owner/repo/sessions/opencode.db']),
      download: async () => ({success: false, error: new Error('download failed')}),
    })

    const result = await restoreCache({
      components: testComponents,
      logger,
      storagePath,
      authPath,
      cacheAdapter: createMockCacheAdapter({restoreResult: undefined}),
      storeConfig: testStoreConfig,
      storeAdapter,
    })

    expect(result).toEqual({
      hit: false,
      key: null,
      restoredPath: null,
      corrupted: false,
      source: null,
    })
    expect(logger.warning).toHaveBeenCalled()
  })

  it('returns miss when object store rejects malicious traversal key after cache miss', async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }
    const download = vi.fn(async () => ok(undefined))
    const storeAdapter = createMockStoreAdapter({
      list: async () => ok(['fro-bot-state/github/owner/repo/sessions/../escape.db']),
      download,
    })

    const result = await restoreCache({
      components: testComponents,
      logger,
      storagePath,
      authPath,
      cacheAdapter: createMockCacheAdapter({restoreResult: undefined}),
      storeConfig: testStoreConfig,
      storeAdapter,
    })

    expect(result.source).toBeNull()
    expect(result.hit).toBe(false)
    expect(download).not.toHaveBeenCalled()
    expect(logger.warning).toHaveBeenCalled()
  })

  it('restores a legacy Actions-cache db+wal pair via a genuine cacheAdapter.restoreCache call, then preserves its committed transaction through the restore-side checkpoint repair', async () => {
    // #given a legacy cache entry: one atomic Actions-cache archive holding both
    // opencode.db and a populated opencode.db-wal, written by a save that predates this
    // repository's checkpoint-before-save fix. Deliberately built INSIDE the cacheAdapter's
    // own restoreCache callback — mirroring what @actions/cache's real restoreCache does
    // when it extracts an archive — rather than pre-placed on disk before restoreCache is
    // called, so this pins a genuine restore rather than a local fixture the test set up
    // itself. The pair is genuinely consistent because one Actions-cache entry is one
    // atomic save, unlike an object-store restore: see deleteDownloadedObjectStoreWal's
    // doc comment in restore.ts for why that source is treated oppositely (discarded,
    // never checkpointed).
    const dbDir = path.dirname(storagePath)
    const legacyDbPath = path.join(dbDir, 'opencode.db')
    const legacyWalPath = `${legacyDbPath}-wal`
    let legacyDb: DatabaseSync | undefined

    const adapter: CacheAdapter = {
      restoreCache: async () => {
        await fs.mkdir(storagePath, {recursive: true})
        legacyDb = new DatabaseSync(legacyDbPath)
        legacyDb.exec('PRAGMA journal_mode=WAL')
        legacyDb.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
        legacyDb.exec("INSERT INTO sessions (data) VALUES ('legacy-committed-session')")
        return 'legacy-cache-key'
      },
      saveCache: async () => 1,
    }

    const options: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: adapter,
    }

    try {
      // #when restoring cache through the Actions-cache path (no object store configured)
      const result = await restoreCache(options)

      // #then the restore is a hit sourced from the cache, and the legacy pair is left
      // alone — restoreCache itself never checkpoints or deletes the write-ahead log for
      // this source, unlike the object-store path
      expect(result).toMatchObject({hit: true, source: 'cache', key: 'legacy-cache-key'})
      expect((await fs.stat(legacyWalPath)).size).toBeGreaterThan(0)

      // #when the restore-side repair runs next, exactly as runCacheRestore
      // (src/harness/phases/cache-restore.ts) does for every cacheStatus === 'hit' before
      // bootstrap ever opens the database
      const checkpointOutcome = await checkpointDatabase({
        dbPath: legacyDbPath,
        walPath: legacyWalPath,
        logger: createTestLogger(),
      })

      // #then the pair is checkpointed in place — not discarded — and the committed
      // transaction that lived only in the write-ahead log survives intact
      expect(checkpointOutcome.status).toBe('checkpointed')
      const verifyDb = new DatabaseSync(legacyDbPath)
      try {
        const rows = verifyDb.prepare('SELECT data FROM sessions').all()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.data).toBe('legacy-committed-session')
      } finally {
        verifyDb.close()
      }
    } finally {
      legacyDb?.close()
    }
  })
})

describe('saveCache', () => {
  let tempDir: string
  let storagePath: string
  let authPath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-test-'))
    storagePath = path.join(tempDir, 'storage')
    authPath = path.join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('returns true on successful save', async () => {
    // #given storage with content
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const adapter = createMockCacheAdapter({saveResult: 12345})
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then returns success
    expect(result).toMatchObject({cachePersisted: true, storePersisted: false, outcome: 'persisted'})
  })

  it('returns false and warns when save returns the failure sentinel', async () => {
    // #given storage with content and an adapter that reports an unsuccessful save
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }
    const adapter = createMockCacheAdapter({saveResult: -1})

    // #when saving cache
    const result = await saveCache({
      components: testComponents,
      runId: 98765,
      logger,
      storagePath,
      authPath,
      cacheAdapter: adapter,
    })

    // #then the failure sentinel is reported as an unpersisted cache
    expect(result).toMatchObject({cachePersisted: false, storePersisted: false, outcome: 'cache-rejected'})
    expect(logger.warning).toHaveBeenCalledWith('Cache save did not persist', {
      saveKey: 'opencode-storage-github-owner-repo-main-Linux-98765',
    })
  })

  it('treats a partially-failed sync as not persisted, even with uploads > 0', async () => {
    // #given storage with content, a sync that uploaded some files but failed others, and
    // a cache write that also fails -- the headline case: neither backend fully landed
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    vi.resetModules()
    vi.doMock('@fro-bot/runtime', async () => {
      const actual = await vi.importActual<typeof import('@fro-bot/runtime')>('@fro-bot/runtime')
      return {...actual, syncSessionsToStore: vi.fn(async () => ({uploaded: 2, failed: 1}))}
    })

    const {saveCache: saveCacheWithPartialSync} = await import('./index.js')
    const adapter = createMockCacheAdapter({saveResult: -1})

    // #when saving cache
    const result = await saveCacheWithPartialSync({
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
      storeConfig: testStoreConfig,
      storeAdapter: createMockStoreAdapter(),
    })

    // #then storePersisted is false despite uploaded > 0 -- a partial sync is not durable --
    // and cache-rejected drives the post hook to retry rather than skip
    expect(result).toEqual({cachePersisted: false, storePersisted: false, outcome: 'cache-rejected'})

    vi.doUnmock('@fro-bot/runtime')
    vi.resetModules()
  })

  it('writes to object store and cache when configured', async () => {
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    // A real hot-WAL database, deliberately left open rather than cleanly closed —
    // saveCache now checkpoints before building the upload set, so this must be real
    // SQLite for that checkpoint to succeed rather than decline the save.
    const dbDir = path.dirname(storagePath)
    const db = new DatabaseSync(path.join(dbDir, 'opencode.db'))
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    db.exec("INSERT INTO sessions (data) VALUES ('session-1')")
    // A page-aligned, zero-filled placeholder, not arbitrary text: a wrong-sized -shm
    // file segfaults node:sqlite (SIGBUS via mmap past EOF) the instant a database next
    // to it is opened — verified on both Node 24 and Bun.
    await fs.writeFile(path.join(dbDir, 'opencode.db-shm'), Buffer.alloc(32768))

    const upload = vi.fn<ObjectStoreAdapter['upload']>(async () => ok(undefined))
    const saveCacheSpy = vi.fn(async () => 1)

    const result = await saveCache({
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.3.13',
      cacheAdapter: {
        restoreCache: async () => undefined,
        saveCache: saveCacheSpy,
      },
      storeConfig: testStoreConfig,
      storeAdapter: createMockStoreAdapter({upload}),
    })

    // #then only the main db is uploaded — the write-ahead log never crosses the object-
    // store boundary, even though the test's own connection keeps it present (truncated
    // to zero bytes by the checkpoint, not unlinked, since the connection stays open)
    expect(result).toMatchObject({cachePersisted: true, storePersisted: true, outcome: 'persisted'})
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]?.[0]).toBe('fro-bot-state/github/owner/repo/sessions/opencode.db')
    expect(saveCacheSpy).toHaveBeenCalledTimes(1)
    expect(upload.mock.invocationCallOrder[0]).toBeLessThan(saveCacheSpy.mock.invocationCallOrder[0] ?? 0)

    db.close()
  })

  it('writes to cache only when object store is not configured', async () => {
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const saveCacheSpy = vi.fn(async () => 1)
    const storeAdapter = createMockStoreAdapter({upload: vi.fn(async () => ok(undefined))})

    const result = await saveCache({
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: {
        restoreCache: async () => undefined,
        saveCache: saveCacheSpy,
      },
      storeAdapter,
    })

    expect(result).toMatchObject({cachePersisted: true, storePersisted: false, outcome: 'persisted'})
    expect(saveCacheSpy).toHaveBeenCalledTimes(1)
    expect(storeAdapter.upload).not.toHaveBeenCalled()
  })

  it('continues cache save when object store upload fails', async () => {
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const dbDir = path.dirname(storagePath)
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'main db')

    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }
    const saveCacheSpy = vi.fn(async () => 1)

    const result = await saveCache({
      components: testComponents,
      runId: 98765,
      logger,
      storagePath,
      authPath,
      opencodeVersion: '1.3.13',
      cacheAdapter: {
        restoreCache: async () => undefined,
        saveCache: saveCacheSpy,
      },
      storeConfig: testStoreConfig,
      storeAdapter: createMockStoreAdapter({
        upload: async () => ({success: false, error: new Error('upload failed')}),
      }),
    })

    expect(result).toMatchObject({cachePersisted: true, storePersisted: false, outcome: 'persisted'})
    expect(saveCacheSpy).toHaveBeenCalledTimes(1)
    expect(logger.warning).toHaveBeenCalled()
  })

  it('reports cache-rejected but durable via the store when the object store persists and the cache write returns -1 (the case this plan exists for)', async () => {
    // #given storage with content, a real hot-WAL database so the pre-save checkpoint
    // succeeds, an object store that persists successfully, and a cache adapter that
    // returns the -1 failure sentinel
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const dbDir = path.dirname(storagePath)
    const db = new DatabaseSync(path.join(dbDir, 'opencode.db'))
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    db.exec("INSERT INTO sessions (data) VALUES ('session-1')")

    const upload = vi.fn<ObjectStoreAdapter['upload']>(async () => ok(undefined))
    const saveCacheSpy = vi.fn(async () => -1)

    const result = await saveCache({
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.3.13',
      cacheAdapter: {
        restoreCache: async () => undefined,
        saveCache: saveCacheSpy,
      },
      storeConfig: testStoreConfig,
      storeAdapter: createMockStoreAdapter({upload}),
    })

    // #then the object store durably persisted the session even though the cache write was
    // rejected — exactly the double-sync bug this result type exists to make visible
    expect(result).toMatchObject({cachePersisted: false, storePersisted: true, outcome: 'cache-rejected'})
    expect(upload).toHaveBeenCalledTimes(1)
    expect(saveCacheSpy).toHaveBeenCalledTimes(1)

    db.close()
  })

  it('skips both backends without attempting a checkpoint or upload when SKIP_CACHE=true', async () => {
    // #given storage with content, an object store configured, and SKIP_CACHE set
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const upload = vi.fn<ObjectStoreAdapter['upload']>(async () => ok(undefined))
    const saveCacheSpy = vi.fn(async () => 1)
    const previousSkipCache = process.env.SKIP_CACHE
    process.env.SKIP_CACHE = 'true'

    try {
      // #when saving cache
      const result = await saveCache({
        components: testComponents,
        runId: 98765,
        logger: createTestLogger(),
        storagePath,
        authPath,
        cacheAdapter: {
          restoreCache: async () => undefined,
          saveCache: saveCacheSpy,
        },
        storeConfig: testStoreConfig,
        storeAdapter: createMockStoreAdapter({upload}),
      })

      // #then the save is a deliberate no-op and neither backend is ever attempted —
      // not merely skipped after a checkpoint or content check ran
      expect(result).toMatchObject({
        cachePersisted: false,
        storePersisted: false,
        outcome: 'skipped-by-configuration',
      })
      expect(saveCacheSpy).not.toHaveBeenCalled()
      expect(upload).not.toHaveBeenCalled()
    } finally {
      if (previousSkipCache === undefined) {
        delete process.env.SKIP_CACHE
      } else {
        process.env.SKIP_CACHE = previousSkipCache
      }
    }
  })

  it('returns false when storage has no content', async () => {
    // #given empty storage directory
    await fs.mkdir(storagePath, {recursive: true})

    const adapter = createMockCacheAdapter({saveResult: 12345})
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then returns false (nothing to save)
    expect(result).toMatchObject({cachePersisted: false, storePersisted: false, outcome: 'skipped-empty'})
  })

  it('returns false when storage does not exist', async () => {
    // #given storage directory doesn't exist
    const adapter = createMockCacheAdapter({saveResult: 12345})
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then returns false
    expect(result).toMatchObject({cachePersisted: false, storePersisted: false, outcome: 'skipped-empty'})
  })

  // --- SQLite-backend regression tests (OpenCode 1.17.x) ---

  it('proceeds with save when storage is empty but opencode.db exists and is non-empty (SQLite backend)', async () => {
    // #given storagePath is empty (no session files) but opencode.db exists at dirname(storagePath)
    // This reproduces the production regression: OpenCode 1.17.x writes sessions to opencode.db,
    // not to storage/, so the old guard incorrectly returned false and skipped the cache save.
    const dbDir = path.dirname(storagePath)
    await fs.mkdir(dbDir, {recursive: true})
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'sqlite-session-data')
    // storagePath itself is NOT created — simulating a fresh run where only the DB exists

    const saveCacheSpy = vi.fn<CacheAdapter['saveCache']>(async () => 1)
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.17.6',
      cacheAdapter: {
        restoreCache: async () => undefined,
        saveCache: saveCacheSpy,
      },
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then save proceeds (DB content is sufficient) and cacheAdapter.saveCache is called
    expect(result).toMatchObject({cachePersisted: true, storePersisted: false, outcome: 'persisted'})
    expect(saveCacheSpy).toHaveBeenCalledTimes(1)
    const capturedPaths = saveCacheSpy.mock.calls[0]?.[0]
    expect(capturedPaths).toContain(path.join(dbDir, 'opencode.db'))
  })

  it('proceeds with save when storage is empty but opencode.db exists (storage dir created by writeStorageVersion)', async () => {
    // #given storagePath is empty, opencode.db exists — verifies writeStorageVersion still runs
    const dbDir = path.dirname(storagePath)
    await fs.mkdir(dbDir, {recursive: true})
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'sqlite-session-data')

    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.17.6',
      cacheAdapter: createMockCacheAdapter({saveResult: 1}),
    }

    // #when saving cache
    await saveCache(options)

    // #then writeStorageVersion ran: storagePath exists and .version file is present
    const versionContent = await fs.readFile(path.join(storagePath, '.version'), 'utf8')
    expect(versionContent).toBe('1')
  })

  it('returns false when storage is empty AND opencode.db is absent (genuinely empty)', async () => {
    // #given storagePath does not exist and no opencode.db — truly nothing to cache
    const saveCacheSpy = vi.fn(async () => 1)
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.17.6',
      cacheAdapter: {
        restoreCache: async () => undefined,
        saveCache: saveCacheSpy,
      },
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then returns false — no content from either source; adapter never called
    expect(result).toMatchObject({cachePersisted: false, storePersisted: false, outcome: 'skipped-empty'})
    expect(saveCacheSpy).not.toHaveBeenCalled()
  })

  it('returns false when storage is empty AND opencode.db exists but is zero-size', async () => {
    // #given storagePath does not exist and opencode.db is zero bytes — treat as no content
    const dbDir = path.dirname(storagePath)
    await fs.mkdir(dbDir, {recursive: true})
    await fs.writeFile(path.join(dbDir, 'opencode.db'), '')

    const saveCacheSpy = vi.fn(async () => 1)
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.17.6',
      cacheAdapter: {
        restoreCache: async () => undefined,
        saveCache: saveCacheSpy,
      },
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then returns false — zero-size DB is not real content; adapter never called
    expect(result).toMatchObject({cachePersisted: false, storePersisted: false, outcome: 'skipped-empty'})
    expect(saveCacheSpy).not.toHaveBeenCalled()
  })

  it('reports no cacheable content when the main db is zero-size, even if opencode.db-wal has data (WAL never crosses the save boundary)', async () => {
    // #given storagePath is empty, opencode.db is 0 bytes, and opencode.db-wal has data.
    // Before the write-ahead log was removed from the save boundary, this combination
    // proceeded with save because a save-only path builder captured a non-empty wal
    // directly. It no longer can: the log is never selected for transport on save (see
    // DB_TRANSPORTABLE_BASENAMES in packages/runtime/src/session/version.ts and
    // buildCachePaths in paths.ts), so its content is invisible to hasCacheableContent
    // regardless of size. In practice this exact shape — a genuinely zero-byte main db
    // with real committed data sitting only in its write-ahead log — does not occur for a
    // real SQLite database that has ever been opened for writing (checkpoint.ts's own
    // doc comment: the main file sits at its WAL-mode header-page size, never 0, the
    // moment a session exists), so this pins the boundary rather than a reachable case.
    const dbDir = path.dirname(storagePath)
    await fs.mkdir(dbDir, {recursive: true})
    await fs.writeFile(path.join(dbDir, 'opencode.db'), '') // zero-size main db
    await fs.writeFile(path.join(dbDir, 'opencode.db-wal'), 'wal-session-data') // non-empty WAL

    const saveCacheSpy = vi.fn<CacheAdapter['saveCache']>(async () => 1)
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.17.6',
      cacheAdapter: {
        restoreCache: async () => undefined,
        saveCache: saveCacheSpy,
      },
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then no cacheable content is reported and the adapter is never called — the WAL
    // content is real but unreachable through the save boundary
    expect(result).toMatchObject({cachePersisted: false, storePersisted: false, outcome: 'skipped-empty'})
    expect(saveCacheSpy).not.toHaveBeenCalled()
  })

  it('reports no cacheable content when only opencode.db-shm is non-empty (SHM-only)', async () => {
    // #given storagePath is empty, opencode.db is 0 bytes, and only opencode.db-shm has data
    // -shm never crosses the save boundary (buildCachePaths excludes it), so a
    // workspace whose only non-empty file is -shm has nothing real to cache.
    const dbDir = path.dirname(storagePath)
    await fs.mkdir(dbDir, {recursive: true})
    await fs.writeFile(path.join(dbDir, 'opencode.db'), '') // zero-size main db
    await fs.writeFile(path.join(dbDir, 'opencode.db-shm'), 'shm-header-data') // non-empty SHM

    const saveCacheSpy = vi.fn<CacheAdapter['saveCache']>(async () => 1)
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.17.6',
      cacheAdapter: {
        restoreCache: async () => undefined,
        saveCache: saveCacheSpy,
      },
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then no cacheable content is reported and the adapter is never called
    expect(result).toMatchObject({cachePersisted: false, storePersisted: false, outcome: 'skipped-empty'})
    expect(saveCacheSpy).not.toHaveBeenCalled()
  })

  it('returns false when storage empty AND all DB-family files absent or zero-size (genuinely empty, all variants)', async () => {
    // #given storagePath does not exist, opencode.db is zero, wal/shm absent — truly nothing
    const dbDir = path.dirname(storagePath)
    await fs.mkdir(dbDir, {recursive: true})
    await fs.writeFile(path.join(dbDir, 'opencode.db'), '') // zero-size
    // opencode.db-wal and opencode.db-shm are NOT created

    const saveCacheSpy = vi.fn(async () => 1)
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.17.6',
      cacheAdapter: {
        restoreCache: async () => undefined,
        saveCache: saveCacheSpy,
      },
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then returns false — no non-empty DB-family file; adapter never called
    expect(result).toMatchObject({cachePersisted: false, storePersisted: false, outcome: 'skipped-empty'})
    expect(saveCacheSpy).not.toHaveBeenCalled()
  })

  it('still saves when storagePath has content (legacy non-SQLite backend)', async () => {
    // #given storagePath has session files (legacy behavior must still work)
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'legacy session data')

    const saveCacheSpy = vi.fn(async () => 1)
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: {
        restoreCache: async () => undefined,
        saveCache: saveCacheSpy,
      },
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then save proceeds as before
    expect(result).toMatchObject({cachePersisted: true, storePersisted: false, outcome: 'persisted'})
    expect(saveCacheSpy).toHaveBeenCalledTimes(1)
  })

  it('handles "already exists" error gracefully', async () => {
    // #given storage with content and "already exists" error
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const adapter = createMockCacheAdapter({
      saveError: new Error(
        'Unable to reserve cache with key, another job may be creating this cache. More details: Cache already exists.',
      ),
    })
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then returns true (treated as success)
    expect(result).toMatchObject({cachePersisted: true, storePersisted: false, outcome: 'persisted'})
  })

  it('returns false on other save errors', async () => {
    // #given storage with content and generic error
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const adapter = createMockCacheAdapter({
      saveError: new Error('Network timeout'),
    })
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when saving cache
    const result = await saveCache(options)

    // #then returns false
    expect(result).toMatchObject({cachePersisted: false, storePersisted: false, outcome: 'cache-error'})
  })

  it('deletes auth.json inside storage before save', async () => {
    // #given storage with content and auth.json inside storage
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')
    const authInsideStorage = path.join(storagePath, 'auth.json')
    await fs.writeFile(authInsideStorage, '{"token": "secret"}')

    const adapter = createMockCacheAdapter({saveResult: 12345})
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath: authInsideStorage,
      cacheAdapter: adapter,
    }

    // #when saving cache
    await saveCache(options)

    // #then auth.json inside storage is deleted
    await expect(fs.access(authInsideStorage)).rejects.toThrow()
  })

  it('does NOT delete auth.json outside storage before save', async () => {
    // #given storage with content and auth.json outside storage
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')
    await fs.writeFile(authPath, '{"token": "secret"}')

    const adapter = createMockCacheAdapter({saveResult: 12345})
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when saving cache
    await saveCache(options)

    // #then auth.json outside storage is NOT deleted
    await expect(fs.access(authPath)).resolves.toBeUndefined()
  })

  it('suppresses ENOENT when auth.json does not exist inside storage', async () => {
    // #given storage with content but no auth.json inside it at all
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')
    const authInsideStorage = path.join(storagePath, 'auth.json')

    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }
    const adapter = createMockCacheAdapter({saveResult: 12345})

    // #when saving cache
    await saveCache({
      components: testComponents,
      runId: 98765,
      logger,
      storagePath,
      authPath: authInsideStorage,
      cacheAdapter: adapter,
    })

    // #then the missing-auth.json ENOENT is suppressed, not logged
    expect(logger.warning).not.toHaveBeenCalled()
  })

  it('logs a warning instead of suppressing when auth.json exists but cannot be deleted', async () => {
    // #given auth.json is a directory, not a file — fs.unlink fails with a real
    // non-ENOENT error, which the errno guard must not misclassify as "nothing to delete"
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')
    const authInsideStorage = path.join(storagePath, 'auth.json')
    await fs.mkdir(authInsideStorage, {recursive: true})

    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }
    const adapter = createMockCacheAdapter({saveResult: 12345})

    // #when saving cache
    await saveCache({
      components: testComponents,
      runId: 98765,
      logger,
      storagePath,
      authPath: authInsideStorage,
      cacheAdapter: adapter,
    })

    // #then the non-ENOENT deletion failure is logged
    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to delete auth.json',
      expect.objectContaining({error: expect.any(String) as unknown as string}),
    )
  })

  it('excludes both WAL and SHM from the save path set even when both exist', async () => {
    // #given storage with content, a real hot-WAL SQLite db, and an SHM file
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    // A real hot-WAL database, deliberately left open rather than cleanly closed —
    // saveCache now checkpoints before building the upload set, so this must be real
    // SQLite for that checkpoint to succeed rather than decline the save. The connection
    // stays open through the assertions below, so the write-ahead log is truncated to
    // zero bytes by the checkpoint but not unlinked — proving exclusion from cachePaths
    // is unconditional, not merely because the file happened to be absent.
    const dbDir = path.dirname(storagePath)
    const db = new DatabaseSync(path.join(dbDir, 'opencode.db'))
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    db.exec("INSERT INTO sessions (data) VALUES ('session-1')")
    // A page-aligned, zero-filled placeholder, not arbitrary text: a wrong-sized -shm
    // file segfaults node:sqlite (SIGBUS via mmap past EOF) the instant a database next
    // to it is opened — verified on both Node 24 and Bun.
    await fs.writeFile(path.join(dbDir, 'opencode.db-shm'), Buffer.alloc(32768))

    let capturedPaths: string[] = []
    const adapter: CacheAdapter = {
      restoreCache: async () => undefined,
      saveCache: async paths => {
        capturedPaths = paths
        return 1
      },
    }
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.3.13',
      cacheAdapter: adapter,
    }

    // #when saving cache
    await saveCache(options)

    // #then only the main db crosses the save boundary — neither sidecar does, even
    // though both exist on disk
    expect(capturedPaths).toContain(path.join(dbDir, 'opencode.db'))
    expect(capturedPaths).not.toContain(path.join(dbDir, 'opencode.db-wal'))
    expect(capturedPaths).not.toContain(path.join(dbDir, 'opencode.db-shm'))

    db.close()
  })

  it('omits WAL and SHM files when they do not exist', async () => {
    // #given storage with content and only the main db file (no WAL/SHM)
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const dbDir = path.dirname(storagePath)
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'main db')

    let capturedPaths: string[] = []
    const adapter: CacheAdapter = {
      restoreCache: async () => undefined,
      saveCache: async paths => {
        capturedPaths = paths
        return 1
      },
    }
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.3.13',
      cacheAdapter: adapter,
    }

    // #when saving cache
    await saveCache(options)

    // #then only the main db file is included (no WAL/SHM)
    expect(capturedPaths).toContain(path.join(dbDir, 'opencode.db'))
    expect(capturedPaths).not.toContain(path.join(dbDir, 'opencode.db-wal'))
    expect(capturedPaths).not.toContain(path.join(dbDir, 'opencode.db-shm'))
  })

  it('writes version marker before save', async () => {
    // #given storage with content
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const adapter = createMockCacheAdapter({saveResult: 12345})
    const options: SaveCacheOptions = {
      components: testComponents,
      runId: 98765,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: adapter,
    }

    // #when saving cache
    await saveCache(options)

    // #then .version file exists with correct content
    const versionContent = await fs.readFile(path.join(storagePath, '.version'), 'utf8')
    expect(versionContent).toBe('1')
  })
})

describe('isPathInsideDirectory', () => {
  it('returns true when file is inside directory', () => {
    // #given a file path inside a directory
    const filePath = '/home/user/storage/auth.json'
    const dirPath = '/home/user/storage'

    // #when checking containment
    const result = isPathInsideDirectory(filePath, dirPath)

    // #then returns true
    expect(result).toBe(true)
  })

  it('returns true for nested paths', () => {
    // #given a deeply nested file path
    const filePath = '/home/user/storage/deep/nested/file.txt'
    const dirPath = '/home/user/storage'

    // #when checking containment
    const result = isPathInsideDirectory(filePath, dirPath)

    // #then returns true
    expect(result).toBe(true)
  })

  it('returns false when file is outside directory', () => {
    // #given a file path outside the directory
    const filePath = '/home/user/config/auth.json'
    const dirPath = '/home/user/storage'

    // #when checking containment
    const result = isPathInsideDirectory(filePath, dirPath)

    // #then returns false
    expect(result).toBe(false)
  })

  it('returns false when file is sibling directory', () => {
    // #given a file in a sibling directory with similar prefix
    const filePath = '/home/user/storage-backup/auth.json'
    const dirPath = '/home/user/storage'

    // #when checking containment
    const result = isPathInsideDirectory(filePath, dirPath)

    // #then returns false (not fooled by prefix matching)
    expect(result).toBe(false)
  })

  it('returns false when paths are equal', () => {
    // #given equal paths
    const filePath = '/home/user/storage'
    const dirPath = '/home/user/storage'

    // #when checking containment
    const result = isPathInsideDirectory(filePath, dirPath)

    // #then returns false (file is not INSIDE, it IS the directory)
    expect(result).toBe(false)
  })
})

describe('isAuthPathSafe', () => {
  it('returns true when auth.json is outside storage', () => {
    // #given auth.json in parent directory, storage in sibling
    const authPath = '/home/user/.local/share/opencode/auth.json'
    const storagePath = '/home/user/.local/share/opencode/storage'

    // #when checking safety
    const result = isAuthPathSafe(authPath, storagePath)

    // #then returns true (safe - won't be cached)
    expect(result).toBe(true)
  })

  it('returns false when auth.json is inside storage', () => {
    // #given auth.json accidentally inside storage
    const authPath = '/home/user/storage/auth.json'
    const storagePath = '/home/user/storage'

    // #when checking safety
    const result = isAuthPathSafe(authPath, storagePath)

    // #then returns false (unsafe - would be cached!)
    expect(result).toBe(false)
  })

  it('returns false when auth.json is nested inside storage', () => {
    // #given auth.json in subdirectory of storage
    const authPath = '/home/user/storage/config/auth.json'
    const storagePath = '/home/user/storage'

    // #when checking safety
    const result = isAuthPathSafe(authPath, storagePath)

    // #then returns false (unsafe)
    expect(result).toBe(false)
  })

  it('returns true for typical XDG layout', () => {
    // #given standard XDG paths (auth.json and storage are siblings)
    const authPath = '/home/runner/.local/share/opencode/auth.json'
    const storagePath = '/home/runner/.local/share/opencode/storage'

    // #when checking safety
    const result = isAuthPathSafe(authPath, storagePath)

    // #then returns true
    expect(result).toBe(true)
  })
})
