import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMetricsCollector} from '../../features/observability/index.js'
import {createMockLogger} from '../../shared/test-helpers.js'

// This suite exercises runCleanup and runPost together against a single shared,
// in-memory GitHub Actions state store, the way the real STATE_* environment handoff
// behaves across the main action and the post hook. Their own colocated test files each
// mock @actions/core independently and never observe the other phase, so neither one can
// verify the relationship save.ts's decline comment documents: runCleanup only marks
// CACHE_SAVED on a successful save, which is precisely what lets runPost's own decline
// check (cacheSaved !== 'true') retry a save that cleanup declined.
const mocks = vi.hoisted(() => ({
  stateStore: new Map<string, string>(),
}))

vi.mock('@actions/core', () => ({
  saveState: vi.fn((key: string, value: string) => {
    mocks.stateStore.set(key, value)
  }),
  getState: vi.fn((key: string) => mocks.stateStore.get(key) ?? ''),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
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
    buildCacheKeyComponents: vi.fn(() => ({agentIdentity: 'github', repo: 'owner/repo', ref: 'main', os: 'Linux'})),
    saveCache: vi.fn(),
  }
})

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

describe('a cleanup-declined cache save is retried by the post hook (decline recovery)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateStore.clear()
    process.env.GITHUB_WORKSPACE = '/tmp/workspace'
    process.env.GITHUB_RUN_ID = '12345'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    process.env.GITHUB_REF_NAME = 'main'
    process.env.RUNNER_OS = 'Linux'
    delete process.env.OPENCODE_PROMPT_ARTIFACT
  })

  it('leaves CACHE_SAVED unset when cleanup declines, so the post hook retries and succeeds', async () => {
    // #given cleanup's own checkpoint-and-save declines (e.g. the OpenCode child was still
    // shutting down when cleanup ran)
    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValueOnce({
      cachePersisted: false,
      storePersisted: false,
      outcome: 'checkpoint-declined',
    })

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
      storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
      metrics: createMetricsCollector(),
      agentIdentity: 'github',
      repo: 'owner/repo',
      runId: 'run-123',
      lockEtag: null,
    })

    // #then cleanup declined and never marked the cache saved — this is exactly what
    // makes the post hook's own decline check (cacheSaved !== 'true') retry, rather than
    // skipping under the false assumption that cleanup already saved it
    expect(saveCache).toHaveBeenCalledTimes(1)
    expect(mocks.stateStore.get('cacheSaved')).toBeUndefined()

    // #when the post hook runs later, after the main step (and the OpenCode child) has
    // ended — routing.ts sets shouldSaveCache during the run, before cleanup or post ever
    // look at it, so this mirrors real handoff state rather than cleanup's own concern
    mocks.stateStore.set('shouldSaveCache', 'true')
    vi.mocked(saveCache).mockResolvedValueOnce({cachePersisted: true, storePersisted: false, outcome: 'persisted'})

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    // #then the post hook retries the save cleanup declined, and this time it succeeds —
    // this retry is the reason a declined save rarely costs a run its session work
    expect(saveCache).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith('Post-action cache saved', expect.any(Object))
  })

  it('skips the retry when cleanup already saved successfully', async () => {
    // #given cleanup's save succeeds
    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValueOnce({cachePersisted: true, storePersisted: false, outcome: 'persisted'})

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
      storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
      metrics: createMetricsCollector(),
      agentIdentity: 'github',
      repo: 'owner/repo',
      runId: 'run-123',
      lockEtag: null,
    })

    // #then CACHE_SAVED is recorded
    expect(mocks.stateStore.get('cacheSaved')).toBe('true')

    // #when the post hook runs later
    mocks.stateStore.set('shouldSaveCache', 'true')

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    // #then the post hook sees the successful save and never retries it
    expect(saveCache).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping post-action: cache already saved by main action',
      expect.any(Object),
    )
  })
})
