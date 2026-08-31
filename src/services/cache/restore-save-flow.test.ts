import type {ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {CacheKeyComponents} from './cache-key.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import * as core from '@actions/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {err, ok} from '../../shared/types.js'
import {restoreCache, saveCache, type CacheAdapter, type RestoreCacheOptions, type SaveCacheOptions} from './index.js'

// The checkpoint decline path writes a job summary via core.summary. None of these tests
// depend on real @actions/core behavior otherwise (logging uses the local test logger
// stub, and object-store calls use the in-memory adapter below), so mocking it here is safe.
vi.mock('@actions/core', () => ({
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}))

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
    expect(store.objects.get('fro-bot-state/github/owner/repo/sessions/opencode.db')?.toString('utf8')).toBe(
      'first-run-db',
    )
    expect(cache.saveCache).toHaveBeenCalledWith([storagePath, dbPath], expect.any(String))
  })

  it('restores from object store on second run after cache miss', async () => {
    const cache = createMockCacheAdapter(undefined)
    const store = createInMemoryStoreAdapter({
      initialObjects: new Map([['fro-bot-state/github/owner/repo/sessions/opencode.db', Buffer.from('second-run-db')]]),
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

  it('prefers fresh object-store restore over stale cache and still uploads on save', async () => {
    const cache = createMockCacheAdapter('restored-cache-key')
    const store = createInMemoryStoreAdapter({
      initialObjects: new Map([
        ['fro-bot-state/github/owner/repo/sessions/opencode.db', Buffer.from('fresh-store-db')],
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

    // #given a stale cache hit and a fresher object store

    // #when restoring cache
    const restoreResult = await restoreCache(restoreOptions)

    // #then object storage is authoritative and the cache is not consulted for restore
    expect(restoreResult).toMatchObject({
      hit: true,
      source: 'storage',
    })
    expect(cache.restoreCache).not.toHaveBeenCalled()
    expect(await fs.readFile(dbPath, 'utf8')).toBe('fresh-store-db')

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

    // #when saving cache after the object-store restore
    const saveResult = await saveCache(saveOptions)

    // #then both object store and cache receive the authoritative session database
    expect(saveResult).toBe(true)
    expect(store.objects.get('fro-bot-state/github/owner/repo/sessions/opencode.db')?.toString('utf8')).toBe(
      'fresh-store-db',
    )
    expect(cache.saveCache).toHaveBeenCalledWith([storagePath, dbPath], expect.any(String))
  })

  it('rejects malicious object-store keys during restore', async () => {
    const cache = createMockCacheAdapter(undefined)
    const store = createInMemoryStoreAdapter({
      initialObjects: new Map([['fro-bot-state/github/owner/repo/sessions/../escape.db', Buffer.from('escape')]]),
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

  it('excludes opencode.db-shm from the object store even when it exists locally', async () => {
    const cache = createMockCacheAdapter(undefined)
    const store = createInMemoryStoreAdapter()

    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(sessionFilePath, '{"session":"created"}', 'utf8')

    // A real hot-WAL database, deliberately left open rather than cleanly closed —
    // mirrors server.close() sending proc.kill() without awaiting a checkpoint. saveCache
    // now checkpoints before building the upload set, so this must be real SQLite for
    // that checkpoint to succeed rather than decline the save.
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    db.exec("INSERT INTO sessions (data) VALUES ('session-1')")
    // A page-aligned, zero-filled placeholder — NOT arbitrary text. A wrong-sized -shm
    // file causes node:sqlite to segfault (SIGBUS via mmap past EOF) the instant a
    // database next to it is opened, verified on both Node 24 and Bun. This exact size
    // is what a real SQLite-managed -shm looks like, so it exercises exclusion without
    // crashing the checkpoint this save now performs.
    await fs.writeFile(`${dbPath}-shm`, Buffer.alloc(32768))

    const saveOptions: SaveCacheOptions = {
      components: testComponents,
      runId: 606,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: cache.adapter,
      storeConfig: testStoreConfig,
      storeAdapter: store.adapter,
    }

    // #given a hot-WAL db, its write-ahead log, and a shm sidecar all present locally

    // #when saving cache
    const saveResult = await saveCache(saveOptions)

    // #then the object store receives db and wal but never shm, and the cache adapter agrees
    expect(saveResult).toBe(true)
    expect(store.objects.has('fro-bot-state/github/owner/repo/sessions/opencode.db')).toBe(true)
    expect(store.objects.has('fro-bot-state/github/owner/repo/sessions/opencode.db-wal')).toBe(true)
    expect(store.objects.has('fro-bot-state/github/owner/repo/sessions/opencode.db-shm')).toBe(false)
    expect(cache.saveCache).toHaveBeenCalledWith([storagePath, dbPath, `${dbPath}-wal`], expect.any(String))

    db.close()
  })

  it('deletes a stale opencode.db-shm restored from the object store before returning a hit', async () => {
    const cache = createMockCacheAdapter(undefined)
    const store = createInMemoryStoreAdapter({
      initialObjects: new Map([
        ['fro-bot-state/github/owner/repo/sessions/opencode.db', Buffer.from('object-store-db')],
        // A shm object uploaded before this fix shipped; download must remain tolerant of it.
        ['fro-bot-state/github/owner/repo/sessions/opencode.db-shm', Buffer.from('stale-machine-local-shm')],
      ]),
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

    // #given an object store still holding a pre-fix shm object alongside the main db

    // #when restoring cache
    const restoreResult = await restoreCache(restoreOptions)

    // #then the restore is a hit, the db is present, and the stale local shm copy is deleted
    expect(restoreResult).toMatchObject({hit: true, source: 'storage'})
    expect(await fs.readFile(dbPath, 'utf8')).toBe('object-store-db')
    await expect(fs.access(`${dbPath}-shm`)).rejects.toThrow()
  })

  it('declines the save when the checkpoint cannot complete, and surfaces the reason in the log and job summary', async () => {
    const cache = createMockCacheAdapter(undefined)
    const store = createInMemoryStoreAdapter()

    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(sessionFilePath, '{"session":"created"}', 'utf8')

    // A database held under an exclusive lock by an in-progress transaction on another
    // connection — the harness's only signal that a writer is still alive, since
    // serverHandle.shutdown() cannot observe the child process's exit.
    const holder = new DatabaseSync(dbPath)
    holder.exec('PRAGMA journal_mode=WAL')
    holder.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    holder.exec("INSERT INTO sessions (data) VALUES ('session-1')")
    holder.exec('PRAGMA locking_mode=EXCLUSIVE')
    holder.exec('BEGIN IMMEDIATE')
    holder.exec("INSERT INTO sessions (data) VALUES ('in-flight')")

    const warningSpy = vi.fn<Logger['warning']>()
    const logger: Logger = {...createTestLogger(), warning: warningSpy}

    const saveOptions: SaveCacheOptions = {
      components: testComponents,
      runId: 707,
      logger,
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: cache.adapter,
      storeConfig: testStoreConfig,
      storeAdapter: store.adapter,
    }

    // #given a database the checkpoint cannot merge because another connection holds it locked

    // #when saving cache
    const saveResult = await saveCache(saveOptions)

    // #then the save is declined, the reason is logged, the cache adapter is never invoked,
    // and the decline is surfaced via the job summary
    expect(saveResult).toBe(false)
    expect(cache.saveCache).not.toHaveBeenCalled()
    expect(warningSpy).toHaveBeenCalledWith(
      'Declining cache save: SQLite checkpoint did not complete',
      expect.objectContaining({reason: expect.any(String) as unknown as string}),
    )
    expect(core.summary.addHeading).toHaveBeenCalledWith('Fro Bot Agent Run — Cache Save Declined', 2)
    expect(core.summary.write).toHaveBeenCalled()

    holder.exec('COMMIT')
    holder.close()
  })
})
