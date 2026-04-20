import type {ObjectStoreAdapter, ObjectStoreConfig} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {err, ok} from '../../../../src/shared/types.js'
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

  it('uploads all 3 DB files when present', async () => {
    await fs.writeFile(path.join(dbDir, 'opencode.db'), 'db')
    await fs.writeFile(path.join(dbDir, 'opencode.db-wal'), 'wal')
    await fs.writeFile(path.join(dbDir, 'opencode.db-shm'), 'shm')

    const upload = vi.fn<ObjectStoreAdapter['upload']>(async () => ok(undefined))
    const adapter = createAdapter({upload})

    const result = await syncSessionsToStore(adapter, config, 'github', 'owner/repo', storagePath, createLogger())

    expect(result).toEqual({uploaded: 3, failed: 0})
    expect(upload).toHaveBeenCalledTimes(3)
    expect(upload.mock.calls.map(([key]) => key)).toEqual([
      'fro-bot-state/github/owner/repo/sessions/opencode.db',
      'fro-bot-state/github/owner/repo/sessions/opencode.db-wal',
      'fro-bot-state/github/owner/repo/sessions/opencode.db-shm',
    ])
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
