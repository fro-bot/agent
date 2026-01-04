import type {CacheKeyComponents} from './cache-key.js'
import type {Logger} from './logger.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {restoreCache, saveCache, type CacheAdapter, type RestoreCacheOptions, type SaveCacheOptions} from './cache.js'

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

    // #then result indicates corruption
    expect(result.hit).toBe(true)
    expect(result.corrupted).toBe(true)
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

    // #then version mismatch is treated as corruption
    expect(result.hit).toBe(true)
    expect(result.corrupted).toBe(true)
  })

  it('deletes auth.json if present after restore', async () => {
    // #given auth.json exists after cache restore
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

    // #then auth.json is deleted
    await expect(fs.access(authPath)).rejects.toThrow()
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

  it('deletes auth.json before save', async () => {
    // #given storage with content and auth.json present
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

    // #then auth.json is deleted
    await expect(fs.access(authPath)).rejects.toThrow()
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
