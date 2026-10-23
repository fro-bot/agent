/**
 * End-to-end check of the post hook's retry against the REAL `saveCache`: with the main step's lease
 * already released, the retry must write the Actions cache and must not issue a single object-store
 * write. `post.test.ts` mocks `saveCache`, so it can only prove the option is passed; this proves the
 * upload does not happen.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../shared/test-helpers.js'
import {ok} from '../shared/types.js'

const mocks = vi.hoisted(() => ({
  cacheSave: vi.fn(),
  upload: vi.fn(),
}))

vi.mock('@actions/core', () => ({
  getState: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@actions/cache', () => ({
  restoreCache: vi.fn(),
  saveCache: mocks.cacheSave,
}))

vi.mock('../services/artifact/index.js', () => ({uploadLogArtifact: vi.fn()}))

vi.mock('@fro-bot/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {
    ...original,
    createS3Adapter: vi.fn(() => ({
      upload: mocks.upload,
      download: async () => ok(undefined),
      list: async () => ok([]),
    })),
    releaseLockIfHolder: vi.fn(async () => ok('released')),
    syncArtifactsToStore: vi.fn(async () => ({uploaded: 0, failed: 0})),
    syncMetadataToStore: vi.fn(async () => ({success: true})),
  }
})

const STORE_STATE: Record<string, string> = {
  'storeConfig.enabled': 'true',
  'storeConfig.bucket': 'test-bucket',
  'storeConfig.region': 'us-east-1',
  'storeConfig.prefix': 'fro-bot-state',
}

async function stubState(state: Record<string, string>): Promise<void> {
  const core = await import('@actions/core')
  vi.mocked(core.getState).mockImplementation((key: string) => state[key] ?? '')
}

describe('post hook retry against the real saveCache', () => {
  let tempDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'post-publish-'))
    // A real session database the object-store sync WOULD upload, in the place the post hook looks.
    const dataHome = path.join(tempDir, 'data')
    const opencodeDir = path.join(dataHome, 'opencode')
    await fs.mkdir(path.join(opencodeDir, 'storage'), {recursive: true})
    await fs.writeFile(path.join(opencodeDir, 'storage', 'session.json'), '{}')
    const db = new DatabaseSync(path.join(opencodeDir, 'opencode.db'))
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    db.exec("INSERT INTO sessions (data) VALUES ('older-local-session')")
    db.close()
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    vi.stubEnv('GITHUB_WORKSPACE', path.join(tempDir, 'workspace'))
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo')
    vi.stubEnv('GITHUB_REF_NAME', 'main')
    vi.stubEnv('GITHUB_RUN_ID', '12345')
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '1')
    vi.stubEnv('GITHUB_JOB', '')
    vi.stubEnv('RUNNER_OS', 'Linux')
    vi.stubEnv('SKIP_CACHE', '')
    mocks.cacheSave.mockResolvedValue(7)
    mocks.upload.mockResolvedValue(ok(undefined))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('retries the Actions cache and issues NO object-store write after the main step released the lease', async () => {
    // #given the main step ended with the lease released and the cache save recorded as not persisted
    await stubState({shouldSaveCache: 'true', cacheSaved: 'not-persisted', ...STORE_STATE})

    // #when the post hook runs
    const {runPost} = await import('./post.js')
    await runPost({logger: createMockLogger()})

    // #then the Actions cache was written, and the shared session object was never touched
    expect(mocks.cacheSave).toHaveBeenCalledTimes(1)
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('issues no object-store write when the lock state is garbled either', async () => {
    // #given
    await stubState({
      shouldSaveCache: 'true',
      cacheSaved: 'not-persisted',
      lockHolderId: '\u0000garbage',
      lockAcquisitionToken: '',
      ...STORE_STATE,
    })

    // #when
    const {runPost} = await import('./post.js')
    await runPost({logger: createMockLogger()})

    // #then
    expect(mocks.cacheSave).toHaveBeenCalledTimes(1)
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('still retries the Actions cache when no object store is configured', async () => {
    // #given
    await stubState({shouldSaveCache: 'true', cacheSaved: 'not-persisted'})

    // #when
    const {runPost} = await import('./post.js')
    await runPost({logger: createMockLogger()})

    // #then
    expect(mocks.cacheSave).toHaveBeenCalledTimes(1)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
})
