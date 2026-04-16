import type {Logger} from '../../shared/logger.js'
import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/index.js'
import type {CacheKeyComponents} from './cache-key.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {err, ok} from '../../shared/types.js'
import {restoreCache, saveCache, type CacheAdapter, type RestoreCacheOptions, type SaveCacheOptions} from './index.js'

const testComponents: CacheKeyComponents = {
  agentIdentity: 'github',
  repo: 'owner/repo',
  ref: 'main',
  os: 'Linux',
}

const testStoreConfig: ObjectStoreConfig = {
  enabled: true,
  bucket: 'test-bucket',
  region: 'us-east-1',
  prefix: 'fro-bot-state',
}

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warning: () => {},
    error: () => {},
  }
}

function createMockCacheAdapter(restoreResult: string | undefined): {
  adapter: CacheAdapter
  restoreCache: ReturnType<typeof vi.fn<CacheAdapter['restoreCache']>>
  saveCache: ReturnType<typeof vi.fn<CacheAdapter['saveCache']>>
} {
  const restoreCache = vi.fn<CacheAdapter['restoreCache']>(async () => restoreResult)
  const saveCache = vi.fn<CacheAdapter['saveCache']>(async () => 1)

  return {
    adapter: {
      restoreCache,
      saveCache,
    },
    restoreCache,
    saveCache,
  }
}

function createInMemoryStoreAdapter(options?: {
  readonly initialObjects?: ReadonlyMap<string, Buffer>
  readonly uploadError?: Error
}): {
  adapter: ObjectStoreAdapter
  objects: Map<string, Buffer>
  upload: ReturnType<typeof vi.fn<ObjectStoreAdapter['upload']>>
  download: ReturnType<typeof vi.fn<ObjectStoreAdapter['download']>>
  list: ReturnType<typeof vi.fn<ObjectStoreAdapter['list']>>
} {
  const objects = new Map(options?.initialObjects ?? [])

  const upload = vi.fn<ObjectStoreAdapter['upload']>(async (key, localPath) => {
    if (options?.uploadError != null) {
      return err(options.uploadError)
    }

    const contents = await fs.readFile(localPath)
    objects.set(key, contents)
    return ok(undefined)
  })

  const download = vi.fn<ObjectStoreAdapter['download']>(async (key, localPath) => {
    const contents = objects.get(key)
    if (contents == null) {
      return err(new Error(`Missing object for key: ${key}`))
    }

    await fs.mkdir(path.dirname(localPath), {recursive: true})
    await fs.writeFile(localPath, contents)
    return ok(undefined)
  })

  const list = vi.fn<ObjectStoreAdapter['list']>(async prefix => {
    const keys = [...objects.keys()]
      .filter(key => key.startsWith(prefix))
      .sort((left, right) => left.localeCompare(right))

    return ok(keys)
  })

  return {
    adapter: {
      upload,
      download,
      list,
    },
    objects,
    upload,
    download,
    list,
  }
}

describe('restore/save object-store integration flow', () => {
  let tempDir: string
  let storagePath: string
  let authPath: string
  let dbPath: string
  let sessionFilePath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-save-flow-'))
    storagePath = path.join(tempDir, 'workspace', 'storage')
    authPath = path.join(tempDir, 'auth.json')
    dbPath = path.join(path.dirname(storagePath), 'opencode.db')
    sessionFilePath = path.join(storagePath, 'session.json')
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('handles first run with cache miss and empty object store', async () => {
    const cache = createMockCacheAdapter(undefined)
    const store = createInMemoryStoreAdapter()
    const restoreOptions: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: cache.adapter,
      storeConfig: testStoreConfig,
      storeAdapter: store.adapter,
    }

    // #given a cache miss and an empty object store

    // #when restoring cache
    const restoreResult = await restoreCache(restoreOptions)

    // #then restore returns a miss with no source
    expect(restoreResult).toMatchObject({
      hit: false,
      source: null,
    })

    // #when OpenCode creates session state locally
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(sessionFilePath, '{"session":"created"}', 'utf8')
    await fs.writeFile(dbPath, 'first-run-db', 'utf8')

    const saveOptions: SaveCacheOptions = {
      components: testComponents,
      runId: 101,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: cache.adapter,
      storeConfig: testStoreConfig,
      storeAdapter: store.adapter,
    }

    // #when saving cache
    const saveResult = await saveCache(saveOptions)

    // #then object store and cache both receive the save
    expect(saveResult).toBe(true)
    expect(store.objects.get('fro-bot-state/github/owner-repo/sessions/opencode.db')?.toString('utf8')).toBe(
      'first-run-db',
    )
    expect(cache.saveCache).toHaveBeenCalledWith([storagePath, dbPath], expect.any(String))
  })

  it('restores from object store on second run after cache miss', async () => {
    const cache = createMockCacheAdapter(undefined)
    const store = createInMemoryStoreAdapter({
      initialObjects: new Map([['fro-bot-state/github/owner-repo/sessions/opencode.db', Buffer.from('second-run-db')]]),
    })

    const restoreOptions: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: cache.adapter,
      storeConfig: testStoreConfig,
      storeAdapter: store.adapter,
    }

    // #given a cache miss and an object store populated with a session database

    // #when restoring cache
    const restoreResult = await restoreCache(restoreOptions)

    // #then the session is restored from object storage
    expect(restoreResult).toMatchObject({
      hit: true,
      source: 'storage',
    })
    expect(await fs.readFile(dbPath, 'utf8')).toBe('second-run-db')
    expect((await fs.stat(storagePath)).isDirectory()).toBe(true)
  })

  it('prefers cache hit over object-store restore and still uploads on save', async () => {
    const cache = createMockCacheAdapter('restored-cache-key')
    const store = createInMemoryStoreAdapter({
      initialObjects: new Map([
        ['fro-bot-state/github/owner-repo/sessions/opencode.db', Buffer.from('stale-store-db')],
      ]),
    })

    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(sessionFilePath, '{"session":"cached"}', 'utf8')
    await fs.writeFile(dbPath, 'cache-hit-db', 'utf8')

    const restoreOptions: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: cache.adapter,
      storeConfig: testStoreConfig,
      storeAdapter: store.adapter,
    }

    // #given a cache hit and a populated object store

    // #when restoring cache
    const restoreResult = await restoreCache(restoreOptions)

    // #then cache is used and object store is not consulted for restore
    expect(restoreResult).toMatchObject({
      hit: true,
      source: 'cache',
    })
    expect(store.list).not.toHaveBeenCalled()

    const saveOptions: SaveCacheOptions = {
      components: testComponents,
      runId: 303,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: cache.adapter,
      storeConfig: testStoreConfig,
      storeAdapter: store.adapter,
    }

    // #when saving cache after the cache-hit restore
    const saveResult = await saveCache(saveOptions)

    // #then both object store and cache receive the updated session database
    expect(saveResult).toBe(true)
    expect(store.objects.get('fro-bot-state/github/owner-repo/sessions/opencode.db')?.toString('utf8')).toBe(
      'cache-hit-db',
    )
    expect(cache.saveCache).toHaveBeenCalledWith([storagePath, dbPath], expect.any(String))
  })

  it('rejects malicious object-store keys during restore', async () => {
    const cache = createMockCacheAdapter(undefined)
    const store = createInMemoryStoreAdapter({
      initialObjects: new Map([['fro-bot-state/github/owner-repo/sessions/../escape.db', Buffer.from('escape')]]),
    })

    const restoreOptions: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: cache.adapter,
      storeConfig: testStoreConfig,
      storeAdapter: store.adapter,
    }

    const escapedPath = path.join(tempDir, 'escape.db')

    // #given a malicious object-store key attempting path traversal

    // #when restoring cache
    const restoreResult = await restoreCache(restoreOptions)

    // #then the malicious key is rejected and no file is written outside the session directory
    expect(restoreResult).toMatchObject({
      hit: false,
      source: null,
    })
    await expect(fs.access(escapedPath)).rejects.toThrow()
  })

  it('keeps cache save non-fatal when object-store upload fails', async () => {
    const cache = createMockCacheAdapter(undefined)
    const store = createInMemoryStoreAdapter({uploadError: new Error('upload failed')})

    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(sessionFilePath, '{"session":"created"}', 'utf8')
    await fs.writeFile(dbPath, 'upload-failure-db', 'utf8')

    const saveOptions: SaveCacheOptions = {
      components: testComponents,
      runId: 505,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: cache.adapter,
      storeConfig: testStoreConfig,
      storeAdapter: store.adapter,
    }

    // #given object-store upload always fails during save

    // #when saving cache
    const saveResult = await saveCache(saveOptions)

    // #then cache save still succeeds
    expect(saveResult).toBe(true)
    expect(cache.saveCache).toHaveBeenCalledWith([storagePath, dbPath], expect.any(String))
  })
})
