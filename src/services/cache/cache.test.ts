import type {ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {CacheKeyComponents} from './cache-key.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {ok} from '../../shared/types.js'
import {
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

  it('does not call object store on cache hit', async () => {
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const storeAdapter = createMockStoreAdapter({
      list: vi.fn(async () => ok([])),
    })

    const result = await restoreCache({
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      cacheAdapter: createMockCacheAdapter({restoreResult: 'cache-key'}),
      storeConfig: testStoreConfig,
      storeAdapter,
    })

    expect(result).toMatchObject({hit: true, source: 'cache'})
    expect(storeAdapter.list).not.toHaveBeenCalled()
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
    expect(result).toBe(true)
  })

  it('writes to object store and cache when configured', async () => {
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const dbDir = path.dirname(storagePath)
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'main db')
    await fs.writeFile(path.join(dbDir, 'opencode.db-wal'), 'wal data')
    await fs.writeFile(path.join(dbDir, 'opencode.db-shm'), 'shm data')

    const upload = vi.fn(async () => ok(undefined))
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

    expect(result).toBe(true)
    expect(upload).toHaveBeenCalledTimes(3)
    expect(saveCacheSpy).toHaveBeenCalledTimes(1)
    expect(upload.mock.invocationCallOrder[0]).toBeLessThan(saveCacheSpy.mock.invocationCallOrder[0] ?? 0)
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

    expect(result).toBe(true)
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

    expect(result).toBe(true)
    expect(saveCacheSpy).toHaveBeenCalledTimes(1)
    expect(logger.warning).toHaveBeenCalled()
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
    expect(result).toBe(false)
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
    expect(result).toBe(false)
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
    expect(result).toBe(true)
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
    expect(result).toBe(false)
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

  it('includes SQLite WAL and SHM files when they exist', async () => {
    // #given storage with content, a SQLite db, WAL, and SHM files
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'test data')

    const dbDir = path.dirname(storagePath)
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'main db')
    await fs.writeFile(path.join(dbDir, 'opencode.db-wal'), 'wal data')
    await fs.writeFile(path.join(dbDir, 'opencode.db-shm'), 'shm data')

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

    // #then WAL and SHM files are included in cache paths
    expect(capturedPaths).toContain(path.join(dbDir, 'opencode.db'))
    expect(capturedPaths).toContain(path.join(dbDir, 'opencode.db-wal'))
    expect(capturedPaths).toContain(path.join(dbDir, 'opencode.db-shm'))
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
