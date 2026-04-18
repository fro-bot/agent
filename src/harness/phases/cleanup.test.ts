import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMetricsCollector} from '../../features/observability/index.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {ok} from '../../shared/types.js'

vi.mock('@actions/core', () => ({
  saveState: vi.fn(),
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

vi.mock('../../services/cache/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../services/cache/index.js')>()
  return {
    ...original,
    buildCacheKeyComponents: vi.fn(() => ({agentIdentity: 'github'})),
    saveCache: vi.fn(async () => true),
  }
})

vi.mock('../../services/object-store/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../services/object-store/index.js')>()
  return {
    ...original,
    createS3Adapter: vi.fn(),
    syncArtifactsToStore: vi.fn(async () => ({uploaded: 0, failed: 0})),
    syncMetadataToStore: vi.fn(async () => ({success: true})),
  }
})

vi.mock('../../services/session/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../services/session/index.js')>()
  return {
    ...original,
    pruneSessions: vi.fn(async () => ({prunedCount: 0, remainingCount: 0})),
  }
})

describe('runCleanup', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.GITHUB_WORKSPACE = '/tmp/workspace'
    process.env.GITHUB_RUN_ID = '12345'
    process.env.GITHUB_RUN_ATTEMPT = '2'
    delete process.env.OPENCODE_PROMPT_ARTIFACT
  })

  afterEach(() => {
    delete process.env.GITHUB_WORKSPACE
    delete process.env.GITHUB_RUN_ID
    delete process.env.GITHUB_RUN_ATTEMPT
    delete process.env.OPENCODE_PROMPT_ARTIFACT
  })

  it('uploads artifacts and metadata with metrics when storeConfig is enabled', async () => {
    const {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} =
      await import('../../services/object-store/index.js')
    vi.mocked(createS3Adapter).mockReturnValue({
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => ok([]),
    })

    const metrics = createMetricsCollector()
    metrics.start()
    metrics.setCacheStatus('hit')
    metrics.setCacheSource('storage')
    metrics.addSessionUsed('ses_existing')
    metrics.addSessionCreated('ses_new')
    metrics.setTokenUsage({input: 1, output: 2, reasoning: 3, cache: {read: 4, write: 5}}, 'model-x', 1.25)
    metrics.end()

    const {runCleanup} = await import('./cleanup.js')
    await runCleanup({
      bootstrapLogger: createMockLogger(),
      reactionCtx: null,
      githubClient: null,
      agentSuccess: true,
      attachmentResult: null,
      serverHandle: null,
      detectedOpencodeVersion: '1.0.0',
      storeConfig: {enabled: true, bucket: 'bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
      metrics,
      agentIdentity: 'github',
      repo: 'owner/repo',
      runId: 'run-123',
    })

    expect(createS3Adapter).toHaveBeenCalled()
    expect(syncArtifactsToStore).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({enabled: true}),
      'github',
      'owner/repo',
      'run-123',
      expect.any(String),
      expect.any(Object),
    )
    expect(syncMetadataToStore).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({enabled: true}),
      'github',
      'owner/repo',
      'run-123',
      expect.objectContaining({
        runId: 'run-123',
        cacheStatus: 'hit',
        cacheSource: 'storage',
        tokenUsage: {input: 1, output: 2, reasoning: 3, cache: {read: 4, write: 5}},
        sessionIds: ['ses_existing', 'ses_new'],
      }),
      expect.any(Object),
    )
  })

  it('skips artifact and metadata uploads when storeConfig is disabled', async () => {
    const {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} =
      await import('../../services/object-store/index.js')
    const {runCleanup} = await import('./cleanup.js')

    await runCleanup({
      bootstrapLogger: createMockLogger(),
      reactionCtx: null,
      githubClient: null,
      agentSuccess: true,
      attachmentResult: null,
      serverHandle: null,
      detectedOpencodeVersion: '1.0.0',
      storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
      metrics: createMetricsCollector(),
      agentIdentity: 'github',
      repo: 'owner/repo',
      runId: 'run-123',
    })

    expect(createS3Adapter).not.toHaveBeenCalled()
    expect(syncArtifactsToStore).not.toHaveBeenCalled()
    expect(syncMetadataToStore).not.toHaveBeenCalled()
  })

  it('does not fail cleanup when artifact upload fails', async () => {
    const {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} =
      await import('../../services/object-store/index.js')
    vi.mocked(createS3Adapter).mockReturnValue({
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => ok([]),
    })
    vi.mocked(syncArtifactsToStore).mockResolvedValue({uploaded: 0, failed: 1})

    const {runCleanup} = await import('./cleanup.js')
    await expect(
      runCleanup({
        bootstrapLogger: createMockLogger(),
        reactionCtx: null,
        githubClient: null,
        agentSuccess: true,
        attachmentResult: null,
        serverHandle: null,
        detectedOpencodeVersion: '1.0.0',
        storeConfig: {
          enabled: true,
          bucket: 'bucket',
          region: 'us-east-1',
          prefix: 'fro-bot-state',
        },
        metrics: createMetricsCollector(),
        agentIdentity: 'github',
        repo: 'owner/repo',
        runId: 'run-123',
      }),
    ).resolves.toBeUndefined()

    expect(syncMetadataToStore).toHaveBeenCalled()
  })
})
