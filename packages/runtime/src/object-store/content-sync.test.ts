import type {ObjectStoreAdapter, ObjectStoreConfig} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DB_V2_MAIN_BASENAME} from '../session/version.js'
import {err, ok} from '../shared/types.js'
import {syncArtifactsToStore, syncMetadataToStore, syncSessionsFromStore, syncSessionsToStore} from './index.js'

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createAdapter(overrides: Partial<ObjectStoreAdapter> = {}): ObjectStoreAdapter {
  return {
    upload: async () => ok(undefined),
    download: async () => ok(undefined),
    list: async () => ok([]),
    conditionalPut: async () => ok({etag: 'etag-1'}),
    conditionalDelete: async () => ok(undefined),
    getObject: async () => ok({data: '{}', etag: 'etag-1'}),
    ...overrides,
  }
}

const config: ObjectStoreConfig = {
  enabled: true,
  bucket: 'test-bucket',
  region: 'us-east-1',
  prefix: 'fro-bot-state',
}

describe('content sync', () => {
  let tempDir: string
  let storagePath: string
  let dbDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'content-sync-'))
    storagePath = path.join(tempDir, 'storage')
    dbDir = path.dirname(storagePath)
    await fs.mkdir(storagePath, {recursive: true})
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('uploads only the main db when db, wal, and shm are all present, excluding both sidecars', async () => {
    // #given a db, a wal, and a shm file all present on disk
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'db')
    await fs.writeFile(path.join(dbDir, 'opencode.db-wal'), 'wal')
    await fs.writeFile(path.join(dbDir, 'opencode.db-shm'), 'shm')

    const upload = vi.fn<ObjectStoreAdapter['upload']>(async () => ok(undefined))
    const adapter = createAdapter({upload})

    // #when syncing sessions to the store
    const result = await syncSessionsToStore(adapter, config, 'github', 'owner/repo', storagePath, createLogger())

    // #then only db is uploaded; neither the write-ahead log nor shm ever cross the
    // boundary (see DB_TRANSPORTABLE_BASENAMES in ../session/version.js for why the log
    // was removed: per-key upload/overwrite here is not atomic across two files)
    expect(result).toEqual({uploaded: 1, failed: 0})
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls.map(([key]) => key)).toEqual(['fro-bot-state/github/owner/repo/sessions/opencode.db'])
  })

  it('uploads 1 DB file when WAL and SHM are absent', async () => {
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'db')

    const upload = vi.fn<ObjectStoreAdapter['upload']>(async () => ok(undefined))
    const adapter = createAdapter({upload})

    const result = await syncSessionsToStore(adapter, config, 'github', 'owner/repo', storagePath, createLogger())

    expect(result).toEqual({uploaded: 1, failed: 0})
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith(
      'fro-bot-state/github/owner/repo/sessions/opencode.db',
      path.join(dbDir, 'opencode.db'),
    )
  })

  it('logs but does not throw on upload failure', async () => {
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'db')

    const logger = createLogger()
    const adapter = createAdapter({
      upload: async () => err(new Error('upload failed')),
    })

    await expect(syncSessionsToStore(adapter, config, 'github', 'owner/repo', storagePath, logger)).resolves.toEqual({
      uploaded: 0,
      failed: 1,
    })
    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to upload session database file to object store',
      expect.any(Object),
    )
  })

  it('uploads all files in log directory under artifacts run prefix', async () => {
    const logPath = path.join(tempDir, 'logs')
    await fs.mkdir(path.join(logPath, 'nested'), {recursive: true})
    await fs.writeFile(path.join(logPath, 'prompt-main.txt'), 'prompt')
    await fs.writeFile(path.join(logPath, 'pr-description.txt'), 'pr')
    await fs.writeFile(path.join(logPath, 'nested', 'issue-description.txt'), 'issue')

    const upload = vi.fn<ObjectStoreAdapter['upload']>(async () => ok(undefined))
    const adapter = createAdapter({upload})

    const result = await syncArtifactsToStore(
      adapter,
      config,
      'github',
      'owner/repo',
      'run-123',
      logPath,
      createLogger(),
    )

    expect(result).toEqual({uploaded: 3, failed: 0})
    expect(upload).toHaveBeenCalledTimes(3)
    expect(upload.mock.calls).toEqual([
      [
        'fro-bot-state/github/owner/repo/artifacts/run-123/nested/issue-description.txt',
        path.join(logPath, 'nested', 'issue-description.txt'),
      ],
      [
        'fro-bot-state/github/owner/repo/artifacts/run-123/pr-description.txt',
        path.join(logPath, 'pr-description.txt'),
      ],
      ['fro-bot-state/github/owner/repo/artifacts/run-123/prompt-main.txt', path.join(logPath, 'prompt-main.txt')],
    ])
  })

  it('returns zero counts when log path does not exist', async () => {
    const upload = vi.fn<ObjectStoreAdapter['upload']>(async () => ok(undefined))
    const adapter = createAdapter({upload})

    const result = await syncArtifactsToStore(
      adapter,
      config,
      'github',
      'owner/repo',
      'run-123',
      path.join(tempDir, 'missing-logs'),
      createLogger(),
    )

    expect(result).toEqual({uploaded: 0, failed: 0})
    expect(upload).not.toHaveBeenCalled()
  })

  it('continues artifact uploads when one upload fails', async () => {
    const logPath = path.join(tempDir, 'logs')
    await fs.mkdir(logPath, {recursive: true})
    await fs.writeFile(path.join(logPath, 'prompt-main.txt'), 'prompt')
    await fs.writeFile(path.join(logPath, 'issue-description.txt'), 'issue')

    const logger = createLogger()
    const upload = vi.fn<ObjectStoreAdapter['upload']>(async (key: string) => {
      if (key.endsWith('prompt-main.txt')) {
        return err(new Error('upload failed'))
      }
      return ok(undefined)
    })
    const adapter = createAdapter({upload})

    const result = await syncArtifactsToStore(adapter, config, 'github', 'owner/repo', 'run-123', logPath, logger)

    expect(result).toEqual({uploaded: 1, failed: 1})
    expect(logger.warning).toHaveBeenCalledWith('Failed to upload artifact file to object store', expect.any(Object))
  })

  it('serializes metadata and uploads it under metadata run key', async () => {
    const upload = vi.fn<ObjectStoreAdapter['upload']>(async (_key: string, localPath: string) => {
      const payload: unknown = JSON.parse(await fs.readFile(localPath, 'utf8'))
      expect(payload).toEqual({runId: 'run-123', cacheStatus: 'hit'})
      return ok(undefined)
    })
    const adapter = createAdapter({upload})

    const result = await syncMetadataToStore(
      adapter,
      config,
      'github',
      'owner/repo',
      'run-123',
      {runId: 'run-123', cacheStatus: 'hit'},
      createLogger(),
    )

    expect(result).toEqual({success: true})
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]?.[0]).toBe('fro-bot-state/github/owner/repo/metadata/run-123.json')
  })

  it('cleans up metadata temp file after upload', async () => {
    let tempFilePath = ''
    const upload = vi.fn<ObjectStoreAdapter['upload']>(async (_key: string, localPath: string) => {
      tempFilePath = localPath
      await expect(fs.access(localPath)).resolves.toBeUndefined()
      return ok(undefined)
    })
    const adapter = createAdapter({upload})

    await syncMetadataToStore(adapter, config, 'github', 'owner/repo', 'run-123', {ok: true}, createLogger())

    await expect(fs.access(tempFilePath)).rejects.toThrow()
  })

  it('returns success false when metadata upload fails', async () => {
    const logger = createLogger()
    const adapter = createAdapter({
      upload: async () => err(new Error('upload failed')),
    })

    const result = await syncMetadataToStore(adapter, config, 'github', 'owner/repo', 'run-123', {ok: true}, logger)

    expect(result).toEqual({success: false})
    expect(logger.warning).toHaveBeenCalledWith('Failed to upload run metadata to object store', expect.any(Object))
  })

  it('downloads all keys returned by list', async () => {
    const list = vi.fn<ObjectStoreAdapter['list']>(async () =>
      ok([
        'fro-bot-state/github/owner/repo/sessions/opencode.db',
        'fro-bot-state/github/owner/repo/sessions/opencode.db-wal',
        'fro-bot-state/github/owner/repo/sessions/opencode.db-shm',
      ]),
    )
    const download = vi.fn<ObjectStoreAdapter['download']>(async (key: string, localPath: string) => {
      await fs.mkdir(path.dirname(localPath), {recursive: true})
      await fs.writeFile(localPath, key)
      return ok(undefined)
    })
    const adapter = createAdapter({list, download})

    const result = await syncSessionsFromStore(adapter, config, 'github', 'owner/repo', storagePath, createLogger())

    expect(result).toEqual({downloaded: 3, failed: 0, mainDbRestored: true})
    expect(list).toHaveBeenCalledWith('fro-bot-state/github/owner/repo/sessions/')
    expect(download).toHaveBeenCalledTimes(3)
    const currentDbDir = path.dirname(storagePath)
    await expect(fs.readFile(path.join(currentDbDir, 'opencode.db'), 'utf8')).resolves.toContain('opencode.db')
    await expect(fs.readFile(path.join(currentDbDir, 'opencode.db-wal'), 'utf8')).resolves.toContain('opencode.db-wal')
    await expect(fs.readFile(path.join(currentDbDir, 'opencode.db-shm'), 'utf8')).resolves.toContain('opencode.db-shm')
  })

  it('rejects keys that fail path traversal validation', async () => {
    const logger = createLogger()
    const download = vi.fn(async () => ok(undefined))
    const adapter = createAdapter({
      list: async () => ok(['fro-bot-state/github/owner/repo/sessions/../escape.db']),
      download,
    })

    const result = await syncSessionsFromStore(adapter, config, 'github', 'owner/repo', storagePath, logger)

    expect(result).toEqual({downloaded: 0, failed: 1, mainDbRestored: false})
    expect(download).not.toHaveBeenCalled()
    expect(logger.warning).toHaveBeenCalledWith('Rejected object store session key during download', expect.any(Object))
  })

  it('returns downloaded 0 on empty list', async () => {
    const adapter = createAdapter({list: async () => ok([])})

    const result = await syncSessionsFromStore(adapter, config, 'github', 'owner/repo', storagePath, createLogger())

    expect(result).toEqual({downloaded: 0, failed: 0, mainDbRestored: false})
  })
})

function createStore(initial: Readonly<Record<string, string>> = {}) {
  const objects = new Map(Object.entries(initial))
  const upload = vi.fn<ObjectStoreAdapter['upload']>(async (key, localPath) => {
    objects.set(key, await fs.readFile(localPath, 'utf8'))
    return ok(undefined)
  })
  const download = vi.fn<ObjectStoreAdapter['download']>(async (key, localPath) => {
    const contents = objects.get(key)
    if (contents === undefined) return err(new Error(`missing ${key}`))
    await fs.mkdir(path.dirname(localPath), {recursive: true})
    await fs.writeFile(localPath, contents)
    return ok(undefined)
  })
  // Prefix filtering like a real bucket listing, so a key that shares a prefix by accident would show up.
  const list = vi.fn<ObjectStoreAdapter['list']>(async prefix =>
    ok([...objects.keys()].filter(key => key.startsWith(prefix)).sort()),
  )
  return {adapter: createAdapter({upload, download, list}), objects, upload, download, list}
}

describe('content sync, V2 generation', () => {
  const v1Prefix = 'fro-bot-state/github/owner/repo/sessions/'
  const v2Prefix = 'fro-bot-state/github/owner/repo/sessions-v2/'
  let tempDir: string
  let storagePath: string
  let dbDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'content-sync-v2-'))
    storagePath = path.join(tempDir, 'storage')
    dbDir = path.dirname(storagePath)
    await fs.mkdir(storagePath, {recursive: true})
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('uploads only the V2 main database under the sessions-v2 prefix', async () => {
    // #given a V2 database with both sidecars on disk
    await fs.writeFile(path.join(dbDir, DB_V2_MAIN_BASENAME), 'v2-db')
    await fs.writeFile(path.join(dbDir, `${DB_V2_MAIN_BASENAME}-wal`), 'wal')
    await fs.writeFile(path.join(dbDir, `${DB_V2_MAIN_BASENAME}-shm`), 'shm')
    const store = createStore()

    // #when syncing a V2 session to the store
    const result = await syncSessionsToStore(
      store.adapter,
      config,
      'github',
      'owner/repo',
      storagePath,
      createLogger(),
      'v2',
    )

    // #then exactly one object is written, at the V2 key, and nothing lands under the V1 prefix
    expect(result).toEqual({uploaded: 1, failed: 0})
    expect(store.upload.mock.calls.map(([key]) => key)).toEqual([`${v2Prefix}${DB_V2_MAIN_BASENAME}`])
    expect([...store.objects.keys()].some(key => key.startsWith(v1Prefix))).toBe(false)
  })

  it('writes the exact S3 key <prefix>/github/<owner>/<repo>/sessions-v2/opencode.db', async () => {
    // #given a V2 database #when uploading #then the key is pinned literally
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'v2-db')
    const store = createStore()

    await syncSessionsToStore(store.adapter, config, 'github', 'owner/repo', storagePath, createLogger(), 'v2')

    expect([...store.objects.keys()]).toEqual(['fro-bot-state/github/owner/repo/sessions-v2/opencode.db'])
  })

  it('downloads from the sessions-v2 prefix and reports the main database restored', async () => {
    // #given only a V2 object in the store
    const store = createStore({[`${v2Prefix}opencode.db`]: 'v2-db'})

    // #when restoring a V2 session
    const result = await syncSessionsFromStore(
      store.adapter,
      config,
      'github',
      'owner/repo',
      storagePath,
      createLogger(),
      'v2',
    )

    // #then the V2 prefix is listed and the database lands beside the storage directory
    expect(result).toEqual({downloaded: 1, failed: 0, mainDbRestored: true})
    expect(store.list).toHaveBeenCalledWith(v2Prefix)
    await expect(fs.readFile(path.join(dbDir, 'opencode.db'), 'utf8')).resolves.toBe('v2-db')
  })

  it('reports a V2 miss when only V1 objects exist', async () => {
    // #given only a V1 object #when restoring V2 #then it is a miss and nothing is downloaded
    const store = createStore({[`${v1Prefix}opencode.db`]: 'v1-db'})

    const result = await syncSessionsFromStore(
      store.adapter,
      config,
      'github',
      'owner/repo',
      storagePath,
      createLogger(),
      'v2',
    )

    expect(result).toEqual({downloaded: 0, failed: 0, mainDbRestored: false})
    expect(store.download).not.toHaveBeenCalled()
  })

  it('never lists or downloads sessions-v2 objects when restoring V1', async () => {
    // #given both generations in the bucket
    const store = createStore({
      [`${v1Prefix}opencode.db`]: 'v1-db',
      [`${v2Prefix}opencode.db`]: 'v2-db',
    })

    // #when restoring with the default (V1) and the explicit V1 generation
    const implicit = await syncSessionsFromStore(
      store.adapter,
      config,
      'github',
      'owner/repo',
      storagePath,
      createLogger(),
    )
    const explicit = await syncSessionsFromStore(
      store.adapter,
      config,
      'github',
      'owner/repo',
      storagePath,
      createLogger(),
      'v1',
    )

    // #then only the V1 object is downloaded, because 'sessions/' never prefixes 'sessions-v2/'
    expect(implicit).toEqual({downloaded: 1, failed: 0, mainDbRestored: true})
    expect(explicit).toEqual(implicit)
    expect(store.download.mock.calls.map(([key]) => key)).toEqual([`${v1Prefix}opencode.db`, `${v1Prefix}opencode.db`])
    expect(store.list.mock.calls.map(([prefix]) => prefix)).toEqual([v1Prefix, v1Prefix])
  })

  it('keeps V1 uploads byte-identical when the generation is omitted', async () => {
    // #given a database #when uploading without a generation #then it lands under sessions/ only
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'db')
    const store = createStore()

    await syncSessionsToStore(store.adapter, config, 'github', 'owner/repo', storagePath, createLogger())

    expect([...store.objects.keys()]).toEqual([`${v1Prefix}opencode.db`])
  })
})
