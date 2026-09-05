import type {ObjectStoreAdapter} from '@fro-bot/runtime'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMetricsCollector} from '../../features/observability/index.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {err, ok} from '../../shared/types.js'

// This suite drives the REAL saveCache (src/services/cache/save.ts) through the REAL
// runCleanup and runPost, mocking only the leaf boundaries: @actions/cache's saveCache
// (the Actions cache backend) and @fro-bot/runtime's createS3Adapter (the object-store
// backend). cleanup-decline-retry.test.ts mocks saveCache itself wholesale, so it cannot
// observe whether the object-store upload is actually repeated -- only this suite can,
// by counting calls at the real store adapter's own upload() boundary.
const mocks = vi.hoisted(() => ({
  stateStore: new Map<string, string>(),
}))

vi.mock('@actions/core', () => ({
  saveState: vi.fn((key: string, value: string) => {
    mocks.stateStore.set(key, value)
  }),
  getState: vi.fn((key: string) => mocks.stateStore.get(key) ?? ''),
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@actions/cache', () => ({
  saveCache: vi.fn(),
  restoreCache: vi.fn(),
}))

vi.mock('../../features/agent/index.js', () => ({
  completeAcknowledgment: vi.fn(),
}))

vi.mock('../../features/attachments/index.js', () => ({
  cleanupTempFiles: vi.fn(),
}))

vi.mock('../../services/artifact/index.js', () => ({
  uploadLogArtifact: vi.fn(),
}))

vi.mock('@fro-bot/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {
    ...original,
    createS3Adapter: vi.fn(),
    pruneSessions: vi.fn(async () => ({prunedCount: 0, remainingCount: 0})),
    syncArtifactsToStore: vi.fn(async () => ({uploaded: 0, failed: 0})),
    syncMetadataToStore: vi.fn(async () => ({success: true})),
  }
})

describe('cleanup + post integration: the object-store boundary is touched at most once per run', () => {
  let tempDir: string
  let storeAdapter: ObjectStoreAdapter

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.stateStore.clear()

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-post-integration-'))
    const openCodeDir = path.join(tempDir, 'opencode')
    const storagePath = path.join(openCodeDir, 'storage')
    await fs.mkdir(storagePath, {recursive: true})
    await fs.writeFile(path.join(storagePath, 'session.db'), 'session content')
    // The single file syncSessionsToStore ever uploads (DB_TRANSPORTABLE_BASENAMES) --
    // present and non-empty so the real object-store sync has something to upload.
    await fs.writeFile(path.join(openCodeDir, 'opencode.db'), 'main db content')

    process.env.XDG_DATA_HOME = tempDir
    process.env.GITHUB_WORKSPACE = tempDir
    process.env.GITHUB_RUN_ID = '99999'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    process.env.GITHUB_REF_NAME = 'main'
    process.env.RUNNER_OS = 'Linux'
    delete process.env.OPENCODE_PROMPT_ARTIFACT
    delete process.env.SKIP_CACHE

    storeAdapter = {
      upload: vi.fn(async () => ok(undefined)),
      download: vi.fn(async () => ok(undefined)),
      list: vi.fn(async () => ok([])),
    }
    const {createS3Adapter} = await import('@fro-bot/runtime')
    vi.mocked(createS3Adapter).mockReturnValue(storeAdapter)
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
    delete process.env.XDG_DATA_HOME
    delete process.env.GITHUB_WORKSPACE
    delete process.env.GITHUB_RUN_ID
    delete process.env.GITHUB_RUN_ATTEMPT
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_REF_NAME
    delete process.env.RUNNER_OS
  })

  const runCleanupPhase = async (): Promise<void> => {
    const {runCleanup} = await import('./cleanup.js')
    await runCleanup({
      bootstrapLogger: createMockLogger(),
      reactionCtx: null,
      githubClient: null,
      agentSuccess: true,
      attachmentResult: null,
      serverHandle: null,
      sessionRetention: null,
      detectedOpencodeVersion: '1.0.0',
      storeConfig: {enabled: true, bucket: 'bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
      metrics: createMetricsCollector(),
      agentIdentity: 'github',
      // Deliberately empty: this is the separate artifact/metadata sync branch in
      // cleanup.ts (gated on repo/runId, not on storeConfig alone), which would add
      // unrelated createS3Adapter/upload noise to the session-sync boundary this test
      // exists to observe.
      repo: '',
      runId: '',
      lockEtag: null,
    })
  }

  const runPostPhase = async (): Promise<ReturnType<typeof createMockLogger>> => {
    mocks.stateStore.set('shouldSaveCache', 'true')
    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})
    return logger
  }

  it('reports store-only when the object store persisted but the Actions cache write was rejected, and the post hook skips without repeating the upload', async () => {
    // #given the headline double-sync bug this plan exists to fix: the Actions cache
    // write returns its -1 rejection sentinel
    const {saveCache: actionsCacheSaveCache} = await import('@actions/cache')
    vi.mocked(actionsCacheSaveCache).mockResolvedValue(-1)

    // #when the real cleanup path saves
    await runCleanupPhase()

    // #then the object store durably persisted the session, so CACHE_SAVED records
    // store-only rather than not-persisted
    expect(mocks.stateStore.get('cacheSaved')).toBe('store-only')
    expect(storeAdapter.upload).toHaveBeenCalledTimes(1)

    // #when the post hook runs later, after the main step has ended
    const logger = await runPostPhase()

    // #then the post hook does not retry the save at all -- proving the store boundary
    // was not touched a second time, not merely that a "skipped" log line was printed
    expect(storeAdapter.upload).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping post-action: state persisted to the object store by main action',
      expect.objectContaining({cacheSaved: 'store-only'}),
    )
  })

  it('reports durable when the Actions cache write itself succeeds, and the post hook skips without repeating the upload', async () => {
    // #given the Actions cache write succeeds (mirrors the store-only case above)
    const {saveCache: actionsCacheSaveCache} = await import('@actions/cache')
    vi.mocked(actionsCacheSaveCache).mockResolvedValue(12345)

    // #when the real cleanup path saves
    await runCleanupPhase()

    // #then CACHE_SAVED records durable -- the cache write itself persisted
    expect(mocks.stateStore.get('cacheSaved')).toBe('durable')
    expect(storeAdapter.upload).toHaveBeenCalledTimes(1)

    // #when the post hook runs later
    const logger = await runPostPhase()

    // #then the post hook skips the retry, and the object-store boundary is untouched
    // a second time
    expect(storeAdapter.upload).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping post-action: cache saved by main action',
      expect.objectContaining({cacheSaved: 'durable'}),
    )
  })

  it('negative control: neither backend persists at cleanup time, so CACHE_SAVED is not-persisted and the post hook retries through a second full upload', async () => {
    // #given both backends fail during cleanup: the Actions cache write returns its -1
    // sentinel, and the object-store upload itself fails (not merely disabled)
    const {saveCache: actionsCacheSaveCache} = await import('@actions/cache')
    vi.mocked(actionsCacheSaveCache).mockResolvedValueOnce(-1)
    vi.mocked(storeAdapter.upload).mockResolvedValueOnce(err(new Error('simulated upload failure')))

    // #when the real cleanup path saves
    await runCleanupPhase()

    // #then neither backend persisted, so CACHE_SAVED is not-persisted (not store-only) --
    // the state that must trigger a post-hook retry
    expect(mocks.stateStore.get('cacheSaved')).toBe('not-persisted')
    expect(storeAdapter.upload).toHaveBeenCalledTimes(1)

    // #given the retry this time succeeds on both backends -- and the post hook can
    // reconstruct storeConfig from state, mirroring what the main step's bootstrap phase
    // (not exercised by this suite) normally writes via core.saveState
    vi.mocked(actionsCacheSaveCache).mockResolvedValueOnce(67890)
    vi.mocked(storeAdapter.upload).mockResolvedValueOnce(ok(undefined))
    mocks.stateStore.set('storeConfig.enabled', 'true')
    mocks.stateStore.set('storeConfig.bucket', 'bucket')
    mocks.stateStore.set('storeConfig.prefix', 'fro-bot-state')

    // #then immediately before the post hook runs, the boundary is still untouched a
    // second time -- the retry below is what causes the second upload, not something
    // runCleanup already did
    expect(storeAdapter.upload).toHaveBeenCalledTimes(1)

    // #when the post hook runs later
    const logger = await runPostPhase()

    // #then the post hook actually retried the save -- a full second run reaches the
    // object-store boundary again, unlike the durable/store-only cases above where the
    // boundary is touched exactly once total
    expect(storeAdapter.upload).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith('Post-action cache saved', expect.any(Object))

    // #then the second upload is attributable to the post hook's retry of the *same*
    // session database -- same key and local path as cleanup's own upload -- not some
    // unrelated upload the post phase happened to trigger
    const uploadMock = vi.mocked(storeAdapter.upload)
    expect(uploadMock.mock.calls[1]).toEqual(uploadMock.mock.calls[0])
  })
})
