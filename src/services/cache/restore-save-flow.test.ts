import type {ObjectStoreAdapter, ObjectStoreConfig} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {CacheKeyComponents} from './cache-key.js'
import {Buffer} from 'node:buffer'
import * as fs from 'node:fs/promises'
import {createRequire} from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
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

// `getCacheVersion` is not in @actions/cache's exports map, so load it from the resolved package directory
// (paths.test.ts loads it the same way).
function loadGetCacheVersion(): (paths: string[]) => string {
  const cacheUtilsPath = path.join(
    path.dirname(fileURLToPath(import.meta.resolve('@actions/cache'))),
    'internal/cacheUtils.js',
  )
  const cacheUtils = createRequire(import.meta.url)(cacheUtilsPath) as {getCacheVersion: (paths: string[]) => string}
  return cacheUtils.getCacheVersion
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
    expect(saveResult).toMatchObject({cachePersisted: true, storePersisted: true, outcome: 'persisted'})
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
    expect(saveResult).toMatchObject({cachePersisted: true, storePersisted: true, outcome: 'persisted'})
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
    expect(saveResult).toMatchObject({cachePersisted: true, outcome: 'persisted'})
    expect(cache.saveCache).toHaveBeenCalledWith([storagePath, dbPath], expect.any(String))
  })

  it('excludes both opencode.db-wal and opencode.db-shm from the object store even when both exist locally', async () => {
    const cache = createMockCacheAdapter(undefined)
    const store = createInMemoryStoreAdapter()

    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(sessionFilePath, '{"session":"created"}', 'utf8')

    // A real hot-WAL database, deliberately left open rather than cleanly closed —
    // mirrors server.close() sending proc.kill() without awaiting a checkpoint. saveCache
    // now checkpoints before building the upload set, so this must be real SQLite for
    // that checkpoint to succeed rather than decline the save. The connection stays open
    // through the assertions below, so the checkpoint truncates the write-ahead log to
    // zero bytes but does not unlink it — proving exclusion is by design (never selected
    // for transport), not merely because the file happened to be absent.
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

    // #given a hot-WAL db, its (now-truncated-but-still-present) write-ahead log, and a
    // shm sidecar all present locally

    // #when saving cache
    const saveResult = await saveCache(saveOptions)

    // #then the object store receives only the main db — neither sidecar ever crosses the
    // boundary — and the cache adapter agrees
    expect(saveResult).toMatchObject({cachePersisted: true, storePersisted: true, outcome: 'persisted'})
    expect(store.objects.has('fro-bot-state/github/owner/repo/sessions/opencode.db')).toBe(true)
    expect(store.objects.has('fro-bot-state/github/owner/repo/sessions/opencode.db-wal')).toBe(false)
    expect(store.objects.has('fro-bot-state/github/owner/repo/sessions/opencode.db-shm')).toBe(false)
    expect(cache.saveCache).toHaveBeenCalledWith([storagePath, dbPath], expect.any(String))

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
    // the object store is never uploaded to either -- a declined save must leave the
    // bucket exactly as it was, so a subsequent successful save is what overwrites it
    // rather than this run shipping a half-checkpointed database -- and the decline is
    // surfaced via the job summary
    expect(saveResult).toMatchObject({cachePersisted: false, storePersisted: false, outcome: 'checkpoint-declined'})
    expect(cache.saveCache).not.toHaveBeenCalled()
    expect(store.upload).not.toHaveBeenCalled()
    expect(store.objects.size).toBe(0)
    expect(warningSpy).toHaveBeenCalledWith(
      'Declining cache save: SQLite checkpoint did not complete',
      expect.objectContaining({reason: expect.any(String) as unknown as string}),
    )
    expect(core.summary.addHeading).toHaveBeenCalledWith('Fro Bot Agent Run — Cache Save Declined', 2)
    expect(core.summary.write).toHaveBeenCalled()

    // #and the body is HTML: a Reason paragraph with a <strong> label and the note as a blockquote,
    // each on its own line with no blank line (which would hand the rest to the Markdown parser)
    const declineBody = String(vi.mocked(core.summary).addRaw.mock.calls[0]![0])
    expect(declineBody).toMatch(
      /^<p>The session cache was not saved at this point because the SQLite write-ahead log could not be checkpointed\.<\/p>\n<p><strong>Reason:<\/strong> [^<>]+<\/p>\n<blockquote>A retry from the post-action hook may still save the cache later in this run\. Only if that retry also fails does the next run risk restoring an older session\.<\/blockquote>\n$/,
    )
    expect(declineBody).not.toContain('**')
    expect(declineBody).not.toContain('\n\n')

    holder.exec('COMMIT')
    holder.close()
  })

  it('deletes the downloaded write-ahead log even when the object-store download loop throws partway through (regression: deletion previously lived inside the try it could never reach)', async () => {
    // #given a healthy-looking object-store restore where opencode.db and opencode.db-wal
    // both download successfully, but a later key in the same listing throws mid-loop --
    // mirroring content-sync.ts's real throw site (fs.mkdir per key) under ENOSPC/EACCES.
    // Keys download in the store's listed order (lexicographic, matching real S3), so
    // 'opencode.db' and 'opencode.db-wal' both land on disk before the trigger key is ever
    // reached, proving the wal was genuinely downloaded and not merely absent.
    const store = createInMemoryStoreAdapter({
      initialObjects: new Map([
        ['fro-bot-state/github/owner/repo/sessions/opencode.db', Buffer.from('object-store-db')],
        ['fro-bot-state/github/owner/repo/sessions/opencode.db-wal', Buffer.from('stale-generation-wal')],
        ['fro-bot-state/github/owner/repo/sessions/zzz-throw-trigger', Buffer.from('irrelevant')],
      ]),
    })
    store.download.mockImplementation(async (key, localPath) => {
      if (key.endsWith('zzz-throw-trigger')) {
        throw new Error('ENOSPC: no space left on device, mkdir')
      }
      await fs.mkdir(path.dirname(localPath), {recursive: true})
      await fs.writeFile(localPath, store.objects.get(key) ?? Buffer.alloc(0))
      return ok(undefined)
    })

    // The Actions cache is what the object-store throw falls through to. Its own
    // restoreCache writes a fresh opencode.db, simulating a real @actions/cache extract --
    // the shape that would silently pair with a leftover object-store wal if the deletion
    // above never ran.
    const actionsCacheRestore = vi.fn<CacheAdapter['restoreCache']>(async () => {
      await fs.mkdir(storagePath, {recursive: true})
      await fs.writeFile(dbPath, 'actions-cache-db', 'utf8')
      return 'actions-cache-key'
    })

    const restoreOptions: RestoreCacheOptions = {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion: '1.2.0',
      cacheAdapter: {restoreCache: actionsCacheRestore, saveCache: async () => 1},
      storeConfig: testStoreConfig,
      storeAdapter: store.adapter,
    }

    // #when restoring cache
    const restoreResult = await restoreCache(restoreOptions)

    // #then the object-store throw is treated as a miss and the Actions cache wins, but --
    // the property this test exists to pin -- the write-ahead log downloaded moments
    // earlier from the object store does not survive to be paired with it
    expect(restoreResult).toMatchObject({hit: true, source: 'cache', key: 'actions-cache-key'})
    expect(actionsCacheRestore).toHaveBeenCalledTimes(1)
    await expect(fs.readFile(dbPath, 'utf8')).resolves.toBe('actions-cache-db')
    await expect(fs.access(`${dbPath}-wal`)).rejects.toThrow()
  })
})

// Answers a restore call only when its restore key is in `hits`, and records every call so a test can pin
// the tier order. A missing mapping is a miss.
function createTieredCacheAdapter(hits: Readonly<Record<string, string>> = {}) {
  const restoreCache = vi.fn<CacheAdapter['restoreCache']>(async (_paths, _primaryKey, restoreKeys) => {
    for (const restoreKey of restoreKeys) {
      const hit = hits[restoreKey]
      if (hit !== undefined) return hit
    }
    return undefined
  })
  const saveCache = vi.fn<CacheAdapter['saveCache']>(async () => 1)
  return {adapter: {restoreCache, saveCache} satisfies CacheAdapter, restoreCache, saveCache}
}

function restoredRestoreKeys(restoreCache: ReturnType<typeof createTieredCacheAdapter>['restoreCache']): string[][] {
  return restoreCache.mock.calls.map(([, , restoreKeys]) => restoreKeys)
}

describe('restore/save flow across session generations', () => {
  const v1ObjectKey = 'fro-bot-state/github/owner/repo/sessions/opencode.db'
  const v2ObjectKey = 'fro-bot-state/github/owner/repo/sessions-v2/opencode.db'
  const v2BranchKey = 'opencode-v2-storage-github-owner-repo-main-'
  const v1BranchKey = 'opencode-storage-github-owner-repo-main-'
  const v2RepoKey = 'opencode-v2-storage-github-owner-repo-'
  const v1RepoKey = 'opencode-storage-github-owner-repo-'

  let tempDir: string
  let storagePath: string
  let authPath: string
  let dbPath: string

  beforeEach(async () => {
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '1')
    vi.stubEnv('GITHUB_JOB', '')
    vi.stubEnv('INPUT_MATRIX-CONTEXT', '')
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-save-generations-'))
    storagePath = path.join(tempDir, 'workspace', 'storage')
    authPath = path.join(tempDir, 'auth.json')
    dbPath = path.join(path.dirname(storagePath), 'opencode.db')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  function restoreOptions(
    opencodeVersion: string | null,
    cache: CacheAdapter,
    store?: ObjectStoreAdapter,
  ): RestoreCacheOptions {
    return {
      components: testComponents,
      logger: createTestLogger(),
      storagePath,
      authPath,
      opencodeVersion,
      cacheAdapter: cache,
      ...(store === undefined ? {} : {storeConfig: testStoreConfig, storeAdapter: store}),
    }
  }

  describe('object-store tiers', () => {
    it('restores S3 V2 over S3 V1 and never consults the cache when both exist', async () => {
      // #given both generations in the bucket and a cache that would also hit
      const cache = createTieredCacheAdapter({[v2BranchKey]: 'v2-branch-hit'})
      const store = createInMemoryStoreAdapter({
        initialObjects: new Map([
          [v1ObjectKey, Buffer.from('v1-db')],
          [v2ObjectKey, Buffer.from('v2-db')],
        ]),
      })

      // #when a V2 run restores
      const result = await restoreCache(restoreOptions('2.2.0', cache.adapter, store.adapter))

      // #then the V2 object wins, the V1 prefix is never listed, and the cache is not consulted
      expect(result).toMatchObject({hit: true, source: 'storage'})
      await expect(fs.readFile(dbPath, 'utf8')).resolves.toBe('v2-db')
      expect(store.list.mock.calls.map(([prefix]) => prefix)).toEqual(['fro-bot-state/github/owner/repo/sessions-v2/'])
      expect(cache.restoreCache).not.toHaveBeenCalled()
    })

    it('falls through to S3 V1 when S3 V2 is absent, without consulting the cache', async () => {
      // #given only a V1 object in the bucket
      const cache = createTieredCacheAdapter({[v2BranchKey]: 'v2-branch-hit'})
      const store = createInMemoryStoreAdapter({initialObjects: new Map([[v1ObjectKey, Buffer.from('v1-db')]])})

      // #when a V2 run restores
      const result = await restoreCache(restoreOptions('2.2.0', cache.adapter, store.adapter))

      // #then V2 is tried first, V1 is restored second, and the cache stays untouched
      expect(result).toMatchObject({hit: true, source: 'storage'})
      await expect(fs.readFile(dbPath, 'utf8')).resolves.toBe('v1-db')
      expect(store.list.mock.calls.map(([prefix]) => prefix)).toEqual([
        'fro-bot-state/github/owner/repo/sessions-v2/',
        'fro-bot-state/github/owner/repo/sessions/',
      ])
      expect(cache.restoreCache).not.toHaveBeenCalled()
    })

    it('falls through to S3 V1 when the V2 listing fails', async () => {
      // #given a V2 listing that errors and a V1 object that exists
      const cache = createTieredCacheAdapter()
      const store = createInMemoryStoreAdapter({initialObjects: new Map([[v1ObjectKey, Buffer.from('v1-db')]])})
      store.list.mockImplementationOnce(async () => err(new Error('listing denied')))

      // #when a V2 run restores
      const result = await restoreCache(restoreOptions('2.2.0', cache.adapter, store.adapter))

      // #then the V1 object still restores
      expect(result).toMatchObject({hit: true, source: 'storage'})
      await expect(fs.readFile(dbPath, 'utf8')).resolves.toBe('v1-db')
    })

    it('falls through to the cache tiers when neither S3 generation exists', async () => {
      // #given an empty bucket and a cache hit on the V2 branch tier
      const cache = createTieredCacheAdapter({[v2BranchKey]: 'opencode-v2-storage-github-owner-repo-main-Linux-1-1'})
      const store = createInMemoryStoreAdapter()
      await fs.mkdir(storagePath, {recursive: true})

      // #when a V2 run restores
      const result = await restoreCache(restoreOptions('2.2.0', cache.adapter, store.adapter))

      // #then both S3 prefixes were tried and the cache supplied the hit
      expect(result).toMatchObject({hit: true, source: 'cache'})
      expect(store.list).toHaveBeenCalledTimes(2)
      expect(restoredRestoreKeys(cache.restoreCache)).toEqual([[v2BranchKey]])
    })

    it('never lists sessions-v2 during a V1 restore', async () => {
      // #given both generations in the bucket
      const cache = createTieredCacheAdapter()
      const store = createInMemoryStoreAdapter({
        initialObjects: new Map([
          [v1ObjectKey, Buffer.from('v1-db')],
          [v2ObjectKey, Buffer.from('v2-db')],
        ]),
      })

      // #when a V1 run (and a run with no version state) restores
      await restoreCache(restoreOptions('1.19.4', cache.adapter, store.adapter))
      await restoreCache(restoreOptions(null, cache.adapter, store.adapter))

      // #then only the V1 prefix is ever listed and only V1 data lands
      expect(store.list.mock.calls.map(([prefix]) => prefix)).toEqual([
        'fro-bot-state/github/owner/repo/sessions/',
        'fro-bot-state/github/owner/repo/sessions/',
      ])
      await expect(fs.readFile(dbPath, 'utf8')).resolves.toBe('v1-db')
    })
  })

  describe('Actions cache tiers', () => {
    const tierCases = [
      {
        name: 'V2 branch',
        hits: {[v2BranchKey]: 'v2-branch-entry', [v1BranchKey]: 'v1-branch-entry', [v2RepoKey]: 'v2-repo-entry'},
        expectedKey: 'v2-branch-entry',
        expectedCalls: [[v2BranchKey]],
      },
      {
        name: 'V1 branch (V2 branch missed)',
        hits: {[v1BranchKey]: 'v1-branch-entry', [v2RepoKey]: 'v2-repo-entry', [v1RepoKey]: 'v1-repo-entry'},
        expectedKey: 'v1-branch-entry',
        expectedCalls: [[v2BranchKey], [v1BranchKey]],
      },
      {
        name: 'V2 repo (both branch tiers missed)',
        hits: {[v2RepoKey]: 'v2-repo-entry', [v1RepoKey]: 'v1-repo-entry'},
        expectedKey: 'v2-repo-entry',
        expectedCalls: [[v2BranchKey], [v1BranchKey], [v2RepoKey]],
      },
      {
        name: 'V1 repo (every earlier tier missed)',
        hits: {[v1RepoKey]: 'v1-repo-entry'},
        expectedKey: 'v1-repo-entry',
        expectedCalls: [[v2BranchKey], [v1BranchKey], [v2RepoKey], [v1RepoKey]],
      },
    ] as const

    it.each(tierCases)('stops at the $name tier and tries tiers in order up to it', async tier => {
      // #given a V2 run with no object store and a cache that hits from this tier down
      const cache = createTieredCacheAdapter(tier.hits)
      await fs.mkdir(storagePath, {recursive: true})

      // #when restoring
      const result = await restoreCache(restoreOptions('2.2.0', cache.adapter))

      // #then the tiers were tried in order, stopping at the first hit
      expect(result).toMatchObject({hit: true, source: 'cache', key: tier.expectedKey})
      expect(restoredRestoreKeys(cache.restoreCache)).toEqual(tier.expectedCalls)
    })

    it('treats a V2 repo hit as winning over a V1 repo entry, but a V1 branch entry as winning over a V2 repo entry', async () => {
      // #given the cache holds V1 data for the branch and V2 data for the repo
      const cache = createTieredCacheAdapter({[v1BranchKey]: 'v1-branch-entry', [v2RepoKey]: 'v2-repo-entry'})
      await fs.mkdir(storagePath, {recursive: true})

      // #when a V2 run restores
      const result = await restoreCache(restoreOptions('2.2.0', cache.adapter))

      // #then the V2 branch tier misses and the V1 branch tier wins, as the precedence order says
      expect(result).toMatchObject({hit: true, key: 'v1-branch-entry'})
    })

    it('reports a miss after trying all four tiers', async () => {
      // #given an empty cache
      const cache = createTieredCacheAdapter()

      // #when a V2 run restores
      const result = await restoreCache(restoreOptions('2.2.0', cache.adapter))

      // #then every tier was tried in order and the restore is a miss with a prepared storage directory
      expect(result).toMatchObject({hit: false, source: null})
      expect(restoredRestoreKeys(cache.restoreCache)).toEqual([[v2BranchKey], [v1BranchKey], [v2RepoKey], [v1RepoKey]])
      expect((await fs.stat(storagePath)).isDirectory()).toBe(true)
    })

    it.each(['2.2.0', 'v2.2.0'])(
      "asks each tier with that generation's own primary key and path list for %s",
      async v2Version => {
        // #given an empty cache, a project id path, and the path list a current V1 SQLite save writes
        const cache = createTieredCacheAdapter()
        const projectIdPath = path.join(tempDir, '.git', 'opencode')
        const v1SaveCache = createTieredCacheAdapter()
        await fs.mkdir(storagePath, {recursive: true})
        await fs.writeFile(dbPath, 'v1-run-db', 'utf8')
        await saveCache({
          components: testComponents,
          runId: 1,
          logger: createTestLogger(),
          storagePath,
          authPath,
          projectIdPath,
          opencodeVersion: '1.19.4',
          cacheAdapter: v1SaveCache.adapter,
        })
        const v1SavePaths = v1SaveCache.saveCache.mock.calls[0]?.[0] ?? []

        // #when a V2 run restores
        await restoreCache({...restoreOptions(v2Version, cache.adapter), projectIdPath})

        // #then the V2 tiers use the V2 primary key and the V1 tiers use the V1 primary key
        const primaryKeys = cache.restoreCache.mock.calls.map(([, primaryKey]) => primaryKey)
        expect(primaryKeys).toEqual([
          'opencode-v2-storage-github-owner-repo-main-Linux',
          'opencode-storage-github-owner-repo-main-Linux',
          'opencode-v2-storage-github-owner-repo-main-Linux',
          'opencode-storage-github-owner-repo-main-Linux',
        ])
        for (const [paths] of cache.restoreCache.mock.calls) {
          expect(paths).toEqual([storagePath, projectIdPath, dbPath])
        }

        // #then each V1 tier asks for the entry version a V1 SQLite save writes, so it can match an existing entry
        expect(v1SavePaths).toEqual([storagePath, projectIdPath, dbPath])
        const getCacheVersion = loadGetCacheVersion()
        const v1TierCalls = cache.restoreCache.mock.calls.filter(
          ([, primaryKey]) => primaryKey === 'opencode-storage-github-owner-repo-main-Linux',
        )
        expect(v1TierCalls).toHaveLength(2)
        for (const [paths] of v1TierCalls) {
          expect(getCacheVersion(paths)).toBe(getCacheVersion([...v1SavePaths]))
        }
      },
    )

    it('makes exactly one V1 call, with V1 keys only, when there is no V2 version state', async () => {
      // #given a cache that misses, and each form of "no V2 version state"
      for (const version of [null, undefined, '1.2.0', '1.19.4+harness.5bde2635']) {
        const cache = createTieredCacheAdapter()

        // #when restoring
        await restoreCache(restoreOptions(version ?? null, cache.adapter))

        // #then the restore is byte-identical to the pre-V2 call: one call, V1 primary key, V1 restore keys
        expect(cache.restoreCache).toHaveBeenCalledTimes(1)
        expect(cache.restoreCache.mock.calls[0]?.[1]).toBe('opencode-storage-github-owner-repo-main-Linux')
        expect(cache.restoreCache.mock.calls[0]?.[2]).toEqual([v1BranchKey, v1RepoKey])
      }
    })
  })

  describe('saves', () => {
    it('writes V2 keys only: sessions-v2 in the bucket and opencode-v2-storage in the cache', async () => {
      // #given a V2 run with a database to persist
      const cache = createTieredCacheAdapter()
      const store = createInMemoryStoreAdapter()
      await fs.mkdir(storagePath, {recursive: true})
      await fs.writeFile(dbPath, 'v2-run-db', 'utf8')

      // #when saving
      const result = await saveCache({
        components: testComponents,
        runId: 707,
        logger: createTestLogger(),
        storagePath,
        authPath,
        opencodeVersion: '2.2.0',
        cacheAdapter: cache.adapter,
        storeConfig: testStoreConfig,
        storeAdapter: store.adapter,
      })

      // #then both backends persisted, and nothing was written under a V1 name
      expect(result).toMatchObject({cachePersisted: true, storePersisted: true, outcome: 'persisted'})
      expect([...store.objects.keys()]).toEqual([v2ObjectKey])
      expect(cache.saveCache).toHaveBeenCalledTimes(1)
      expect(cache.saveCache).toHaveBeenCalledWith(
        [storagePath, dbPath],
        'opencode-v2-storage-github-owner-repo-main-Linux-707-1',
      )
      await expect(fs.readFile(path.join(storagePath, '.version'), 'utf8')).resolves.toBe('1')
    })

    it('does not touch an existing V1 object or V1 cache entry when a V2 run saves', async () => {
      // #given a bucket that holds a V1 session
      const cache = createTieredCacheAdapter()
      const store = createInMemoryStoreAdapter({initialObjects: new Map([[v1ObjectKey, Buffer.from('v1-db')]])})
      await fs.mkdir(storagePath, {recursive: true})
      await fs.writeFile(dbPath, 'v2-run-db', 'utf8')

      // #when a V2 run saves
      await saveCache({
        components: testComponents,
        runId: 808,
        logger: createTestLogger(),
        storagePath,
        authPath,
        opencodeVersion: '2.2.0',
        cacheAdapter: cache.adapter,
        storeConfig: testStoreConfig,
        storeAdapter: store.adapter,
      })

      // #then the V1 object is intact and the V2 object sits beside it
      expect(store.objects.get(v1ObjectKey)?.toString('utf8')).toBe('v1-db')
      expect(store.objects.get(v2ObjectKey)?.toString('utf8')).toBe('v2-run-db')
      expect(store.upload.mock.calls.map(([key]) => key)).toEqual([v2ObjectKey])
    })

    it('does not treat a cacheId of -1 as a persisted V2 cache save', async () => {
      // #given a V2 run whose cache write reports the -1 sentinel
      const cache = createTieredCacheAdapter()
      cache.saveCache.mockResolvedValue(-1)
      await fs.mkdir(storagePath, {recursive: true})
      await fs.writeFile(dbPath, 'v2-run-db', 'utf8')

      // #when saving
      const result = await saveCache({
        components: testComponents,
        runId: 909,
        logger: createTestLogger(),
        storagePath,
        authPath,
        opencodeVersion: '2.2.0',
        cacheAdapter: cache.adapter,
      })

      // #then the save is reported as rejected, not persisted
      expect(result).toMatchObject({cachePersisted: false, outcome: 'cache-rejected'})
    })

    it('saves under V1 keys only when there is no V2 version state', async () => {
      // #given each form of "no V2 version state" and a database to persist
      for (const [index, version] of [null, undefined, '1.2.0'].entries()) {
        const cache = createTieredCacheAdapter()
        const store = createInMemoryStoreAdapter()
        await fs.mkdir(storagePath, {recursive: true})
        await fs.writeFile(path.join(storagePath, 'session.json'), '{"session":"created"}', 'utf8')
        await fs.writeFile(dbPath, 'v1-run-db', 'utf8')

        // #when saving
        await saveCache({
          components: testComponents,
          runId: 1000 + index,
          logger: createTestLogger(),
          storagePath,
          authPath,
          ...(version === undefined ? {} : {opencodeVersion: version}),
          cacheAdapter: cache.adapter,
          storeConfig: testStoreConfig,
          storeAdapter: store.adapter,
        })

        // #then only V1 names are written
        expect([...store.objects.keys()]).toEqual([v1ObjectKey])
        expect(cache.saveCache).toHaveBeenCalledTimes(1)
        expect(cache.saveCache.mock.calls[0]?.[1]).toBe(
          `opencode-storage-github-owner-repo-main-Linux-${1000 + index}-1`,
        )
      }
    })
  })

  describe('round trip', () => {
    it("restores a V2 run's saved session on the next V2 run", async () => {
      // #given a first V2 run that saved to an empty bucket
      const cache = createTieredCacheAdapter()
      const store = createInMemoryStoreAdapter()
      await fs.mkdir(storagePath, {recursive: true})
      await fs.writeFile(dbPath, 'first-v2-run', 'utf8')
      await saveCache({
        components: testComponents,
        runId: 1,
        logger: createTestLogger(),
        storagePath,
        authPath,
        opencodeVersion: '2.2.0',
        cacheAdapter: cache.adapter,
        storeConfig: testStoreConfig,
        storeAdapter: store.adapter,
      })
      await fs.rm(dbPath)

      // #when the next V2 run restores
      const result = await restoreCache(restoreOptions('2.2.0', cache.adapter, store.adapter))

      // #then it gets the V2 session back from the V2 object
      expect(result).toMatchObject({hit: true, source: 'storage'})
      await expect(fs.readFile(dbPath, 'utf8')).resolves.toBe('first-v2-run')
    })
  })
})
