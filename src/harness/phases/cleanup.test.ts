import type {LeaseController} from './acquire-lock.js'
import type {CleanupPhaseOptions} from './cleanup.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMetricsCollector} from '../../features/observability/index.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {err, ok} from '../../shared/types.js'

vi.mock('@actions/core', () => ({
  saveState: vi.fn(),
  setOutput: vi.fn(),
  warning: vi.fn(),
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
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
    saveCache: vi.fn(async () => ({cachePersisted: true, storePersisted: false, outcome: 'persisted'})),
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
    releaseLock: vi.fn(async () => ok(undefined)),
  }
})

describe('runCleanup', () => {
  const createServerHandle = (): NonNullable<CleanupPhaseOptions['serverHandle']> => ({
    client: {} as NonNullable<CleanupPhaseOptions['serverHandle']>['client'],
    server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
    shutdown: vi.fn().mockResolvedValue({quiesced: true}),
  })

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
    const {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} = await import('@fro-bot/runtime')
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
      sessionRetention: null,
      detectedOpencodeVersion: '1.0.0',
      storeConfig: {enabled: true, bucket: 'bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
      metrics,
      agentIdentity: 'github',
      repo: 'owner/repo',
      runId: 'run-123',
      lockEtag: null,
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

    // #then the marker is saved after the metadata upload succeeds -- this is what lets
    // post.ts's retry branch tell "cleanup ran and uploaded the rich payload" apart from
    // "cleanup never ran", where CACHE_SAVED's not-persisted value alone is ambiguous
    const {saveState} = await import('@actions/core')
    expect(saveState).toHaveBeenCalledWith('cleanupMetadataWritten', 'true')
  })

  it('does not mark cleanup metadata written when the upload fails', async () => {
    // #given the metadata upload itself fails -- the rich payload never landed, so post.ts
    // must still be free to write its own placeholder rather than silently skipping
    const {createS3Adapter, syncMetadataToStore} = await import('@fro-bot/runtime')
    vi.mocked(createS3Adapter).mockReturnValue({
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => ok([]),
    })
    vi.mocked(syncMetadataToStore).mockResolvedValueOnce({success: false})

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
      repo: 'owner/repo',
      runId: 'run-123',
      lockEtag: null,
    })

    // #then
    const {saveState} = await import('@actions/core')
    expect(saveState).not.toHaveBeenCalledWith('cleanupMetadataWritten', 'true')
  })

  it('skips artifact and metadata uploads when storeConfig is disabled', async () => {
    const {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} = await import('@fro-bot/runtime')
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

    expect(createS3Adapter).not.toHaveBeenCalled()
    expect(syncArtifactsToStore).not.toHaveBeenCalled()
    expect(syncMetadataToStore).not.toHaveBeenCalled()
  })

  it.each([
    {missing: 'repo', repo: '', runId: 'run-123'},
    {missing: 'runId', repo: 'owner/repo', runId: ''},
  ])(
    'skips object-store sync when $missing is missing while preserving cache and prompt artifact cleanup',
    async ({repo, runId}) => {
      const {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} = await import('@fro-bot/runtime')
      const {saveCache} = await import('../../services/cache/index.js')
      const {uploadLogArtifact} = await import('../../services/artifact/index.js')
      const {runCleanup} = await import('./cleanup.js')
      process.env.OPENCODE_PROMPT_ARTIFACT = 'true'

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
        repo,
        runId,
        lockEtag: null,
      })

      expect(createS3Adapter).not.toHaveBeenCalled()
      expect(syncArtifactsToStore).not.toHaveBeenCalled()
      expect(syncMetadataToStore).not.toHaveBeenCalled()
      expect(saveCache).toHaveBeenCalled()
      expect(uploadLogArtifact).toHaveBeenCalled()
    },
  )

  it('does not fail cleanup when artifact upload fails', async () => {
    const {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} = await import('@fro-bot/runtime')
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
        sessionRetention: null,
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
        lockEtag: null,
      }),
    ).resolves.toBeUndefined()

    expect(syncMetadataToStore).toHaveBeenCalled()
  })

  it('passes configured session retention to pruning while preserving the age limit', async () => {
    // #given a live server and a configured session retention value
    const {pruneSessions} = await import('@fro-bot/runtime')
    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup prunes sessions
    await runCleanup({
      bootstrapLogger: createMockLogger(),
      reactionCtx: null,
      githubClient: null,
      agentSuccess: true,
      attachmentResult: null,
      serverHandle: createServerHandle(),
      sessionRetention: 10,
      detectedOpencodeVersion: '1.0.0',
      storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
      metrics: createMetricsCollector(),
      agentIdentity: 'github',
      repo: 'owner/repo',
      runId: 'run-123',
      lockEtag: null,
    })

    // #then the configured count is used without changing the age limit
    expect(pruneSessions).toHaveBeenCalledWith(
      {},
      '/tmp/workspace',
      {maxSessions: 10, maxAgeDays: 30},
      expect.any(Object),
    )
  })

  it('keeps the current pruning config when the default retention is used', async () => {
    // #given a live server and the input's default retention value
    const {DEFAULT_PRUNING_CONFIG, pruneSessions} = await import('@fro-bot/runtime')
    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup prunes sessions
    await runCleanup({
      bootstrapLogger: createMockLogger(),
      reactionCtx: null,
      githubClient: null,
      agentSuccess: true,
      attachmentResult: null,
      serverHandle: createServerHandle(),
      sessionRetention: 50,
      detectedOpencodeVersion: '1.0.0',
      storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
      metrics: createMetricsCollector(),
      agentIdentity: 'github',
      repo: 'owner/repo',
      runId: 'run-123',
      lockEtag: null,
    })

    // #then pruning receives today's hardcoded config unchanged
    expect(pruneSessions).toHaveBeenCalledWith({}, '/tmp/workspace', DEFAULT_PRUNING_CONFIG, expect.any(Object))
  })

  it('keeps the current pruning config when no retention is configured', async () => {
    // #given a live server and no retention value at all — the branch a consumer
    // who never set the input actually takes, which differs from passing the
    // default value explicitly
    const {DEFAULT_PRUNING_CONFIG, pruneSessions} = await import('@fro-bot/runtime')
    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup prunes sessions
    await runCleanup({
      bootstrapLogger: createMockLogger(),
      reactionCtx: null,
      githubClient: null,
      agentSuccess: true,
      attachmentResult: null,
      serverHandle: createServerHandle(),
      sessionRetention: null,
      detectedOpencodeVersion: '1.0.0',
      storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
      metrics: createMetricsCollector(),
      agentIdentity: 'github',
      repo: 'owner/repo',
      runId: 'run-123',
      lockEtag: null,
    })

    // #then behaviour is byte-identical to today's — this is the property that
    // makes wiring the input safe to ship rather than a behaviour change
    expect(pruneSessions).toHaveBeenCalledWith({}, '/tmp/workspace', DEFAULT_PRUNING_CONFIG, expect.any(Object))
  })

  it('warns when shutdown() cannot confirm quiescence, so an operator can see the checkpoint that follows may have raced a writer', async () => {
    // #given a server handle whose shutdown() times out without confirming the child
    // exited — every other test in this suite mocks shutdown as quiesced: true, so this
    // branch (cleanup.ts's `if (!shutdownResult.quiesced)`) is otherwise never observed
    const logger = createMockLogger()
    const serverHandle: NonNullable<CleanupPhaseOptions['serverHandle']> = {
      client: {} as NonNullable<CleanupPhaseOptions['serverHandle']>['client'],
      server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
      shutdown: vi.fn().mockResolvedValue({quiesced: false}),
    }
    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup shuts the server down
    await runCleanup({
      bootstrapLogger: logger,
      reactionCtx: null,
      githubClient: null,
      agentSuccess: true,
      attachmentResult: null,
      serverHandle,
      sessionRetention: null,
      detectedOpencodeVersion: '1.0.0',
      storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
      metrics: createMetricsCollector(),
      agentIdentity: 'github',
      repo: 'owner/repo',
      runId: 'run-123',
      lockEtag: null,
    })

    // #then the unconfirmed quiescence is surfaced as a warning, distinct from the
    // separate 'Server shutdown failed' warning that only fires when shutdown() itself
    // throws
    expect(serverHandle.shutdown).toHaveBeenCalledTimes(1)
    expect(logger.warning).toHaveBeenCalledWith(
      'OpenCode server did not confirm shutdown within the quiescence window; the checkpoint that follows may race a still-live writer',
    )
    expect(logger.warning).not.toHaveBeenCalledWith('Server shutdown failed (non-fatal)', expect.any(Object))
  })

  it('continues past a throwing cache-save-result output write to still upload artifacts and save state', async () => {
    // #given core.setOutput throws (e.g. no GITHUB_OUTPUT file available) -- this must not
    // short-circuit the summary write, artifact upload, or the CACHE_SAVED state handoff
    // the post hook depends on
    const {saveState, setOutput, warning} = await import('@actions/core')
    vi.mocked(setOutput).mockImplementationOnce(() => {
      throw new Error('no GITHUB_OUTPUT file')
    })
    process.env.OPENCODE_PROMPT_ARTIFACT = 'true'
    const {uploadLogArtifact} = await import('../../services/artifact/index.js')
    vi.mocked(uploadLogArtifact).mockResolvedValueOnce(true)

    const logger = createMockLogger()
    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup runs and the output write throws
    await expect(
      runCleanup({
        bootstrapLogger: logger,
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
      }),
    ).resolves.toBeUndefined()

    // #then the throw is caught and logged via cacheLogger (core.warning), not left to
    // crash cleanup
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Failed to set cache-save-result output (non-fatal)'))
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('no GITHUB_OUTPUT file'))
    // #and CACHE_SAVED state was still saved for the post hook to read back
    expect(saveState).toHaveBeenCalledWith('cacheSaved', 'durable')
    // #and the artifact upload still ran afterward
    expect(uploadLogArtifact).toHaveBeenCalled()
  })

  it('skips pruning when there is no live server handle', async () => {
    // #given no live server handle
    const {pruneSessions} = await import('@fro-bot/runtime')
    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup runs
    await runCleanup({
      bootstrapLogger: createMockLogger(),
      reactionCtx: null,
      githubClient: null,
      agentSuccess: true,
      attachmentResult: null,
      serverHandle: null,
      sessionRetention: 10,
      detectedOpencodeVersion: '1.0.0',
      storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
      metrics: createMetricsCollector(),
      agentIdentity: 'github',
      repo: 'owner/repo',
      runId: 'run-123',
      lockEtag: null,
    })

    // #then pruning is skipped
    expect(pruneSessions).not.toHaveBeenCalled()
  })
})

describe('runCleanup persistence safety gate (plan Unit 12)', () => {
  const createServerHandle = (quiesced = true): NonNullable<CleanupPhaseOptions['serverHandle']> => ({
    client: {} as NonNullable<CleanupPhaseOptions['serverHandle']>['client'],
    server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
    shutdown: vi.fn().mockResolvedValue({quiesced}),
  })

  const createLeaseController = (overrides?: Partial<LeaseController>): LeaseController => ({
    hasFailed: () => false,
    currentEtag: () => '"etag-initial"',
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  })

  const baseOptions = (overrides?: Partial<CleanupPhaseOptions>): CleanupPhaseOptions => ({
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
    ...overrides,
  })

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.GITHUB_WORKSPACE = '/tmp/workspace'
    process.env.GITHUB_RUN_ID = '12345'
    process.env.GITHUB_RUN_ATTEMPT = '1'
  })

  afterEach(() => {
    delete process.env.GITHUB_WORKSPACE
    delete process.env.GITHUB_RUN_ID
    delete process.env.GITHUB_RUN_ATTEMPT
  })

  it('declines cache persistence when the ownership ledger has an unknown entry', async () => {
    // #given a ledger with a session that was adopted and never confirmed settled
    const {createOwnershipLedger} = await import('@fro-bot/runtime')
    const {saveCache} = await import('../../services/cache/index.js')
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'reviewer')
    ledger.markUnknown('ses_child')
    expect(ledger.isPersistenceSafe()).toBe(false)

    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup runs
    await runCleanup(baseOptions({ownershipLedger: ledger}))

    // #then saveCache is never attempted -- persistence is declined, not merely retried.
    // 'declined-for-safety', not 'not-persisted': that value tells the post hook to honor
    // the decline instead of silently retrying it (see cache-save-result.ts).
    expect(saveCache).not.toHaveBeenCalled()
    const {saveState, setOutput} = await import('@actions/core')
    expect(saveState).toHaveBeenCalledWith('cacheSaved', 'declined-for-safety')
    // #and the public cache-save-result Action output reflects the same decline, not just
    // the internal CACHE_SAVED state handoff -- a caller watching only the output would
    // otherwise never see a real safety decline happen
    expect(setOutput).toHaveBeenCalledWith('cache-save-result', 'declined-for-safety')
  })

  it('persists normally when the ownership ledger is empty (every run today, unchanged behavior)', async () => {
    // #given an empty ledger -- persistence-safe by definition
    const {createOwnershipLedger} = await import('@fro-bot/runtime')
    const {saveCache} = await import('../../services/cache/index.js')
    const ledger = createOwnershipLedger()
    expect(ledger.isPersistenceSafe()).toBe(true)

    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup runs
    await runCleanup(baseOptions({ownershipLedger: ledger}))

    // #then saveCache proceeds as normal
    expect(saveCache).toHaveBeenCalledTimes(1)
  })

  it('declines cache persistence when server shutdown could not confirm quiescence', async () => {
    // #given shutdown() reports quiesced: false
    const {saveCache} = await import('../../services/cache/index.js')
    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup runs
    await runCleanup(baseOptions({serverHandle: createServerHandle(false)}))

    // #then saveCache is never attempted, and the state is 'declined-for-safety' so the
    // post hook honors the decline instead of retrying it
    expect(saveCache).not.toHaveBeenCalled()
    const {saveState} = await import('@actions/core')
    expect(saveState).toHaveBeenCalledWith('cacheSaved', 'declined-for-safety')
  })

  it('declines cache persistence when the lease renewal has failed, without stopping renewal first', async () => {
    // #given a coordination lease held by this run whose renewal has already failed --
    // "fails closed": this run can no longer be certain no other surface is writing
    const {saveCache} = await import('../../services/cache/index.js')
    const lease = createLeaseController({hasFailed: () => true})
    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup runs
    await runCleanup(
      baseOptions({
        storeConfig: {enabled: true, bucket: 'bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
        lockEtag: '"etag-initial"',
        leaseRenewal: lease,
      }),
    )

    // #then saveCache is never attempted, and the decline reason names the lease
    expect(saveCache).not.toHaveBeenCalled()
    const core = await import('@actions/core')
    const remediationText = vi.mocked(core.summary.addRaw).mock.calls.flat().join(' ')
    expect(remediationText).toContain('lease could not be renewed')
    // #and the state is 'declined-for-safety' -- the post hook must honor this decline,
    // not retry it, since a failed lease is exactly the case the process boundary can't help
    const {saveState} = await import('@actions/core')
    expect(saveState).toHaveBeenCalledWith('cacheSaved', 'declined-for-safety')
    // #and stop() is still called exactly once, after the decision, not to make it
    expect(lease.stop).toHaveBeenCalledTimes(1)
  })

  it('persists normally when this run holds no lock (leaseRenewal is null) -- never fails for want of a lease it never held', async () => {
    // #given S3 disabled or acquisition failed: no LeaseController at all
    const {saveCache} = await import('../../services/cache/index.js')
    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup runs
    await runCleanup(baseOptions({leaseRenewal: null}))

    // #then saveCache proceeds as normal -- R22a
    expect(saveCache).toHaveBeenCalledTimes(1)
    const {saveState} = await import('@actions/core')
    expect(saveState).toHaveBeenCalledWith('cacheSaved', 'durable')
  })

  it('surfaces a declined persistence as a visible, named reason in the job summary, not a silent skip', async () => {
    // #given the review finding this unit exists to fix: an unknown ledger entry must not
    // silently skip persistence
    const {createOwnershipLedger} = await import('@fro-bot/runtime')
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'reviewer')
    ledger.markUnknown('ses_child')

    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup runs
    await runCleanup(baseOptions({ownershipLedger: ledger}))

    // #then a reader sees why, in the same 'Session Persistence' row writeCacheSaveResultSummary
    // always writes -- not a second, separate channel
    const core = await import('@actions/core')
    expect(core.summary.addHeading).toHaveBeenCalledWith('Session Persistence', 3)
    const remediationText = vi.mocked(core.summary.addRaw).mock.calls.flat().join(' ')
    expect(remediationText).toContain('**Reason:**')
    expect(remediationText).toContain('background subagent work')
  })

  it('releases the lock using the lease-renewed ETag, not the stale acquisition ETag', async () => {
    // #given renewal ticked at least once and moved the lock record's ETag forward
    const {releaseLock} = await import('@fro-bot/runtime')
    const lease = createLeaseController({currentEtag: () => '"etag-renewed"'})
    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup runs and releases the lock
    await runCleanup(
      baseOptions({
        storeConfig: {enabled: true, bucket: 'bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
        lockEtag: '"etag-initial"',
        leaseRenewal: lease,
      }),
    )

    // #then release uses the renewed ETag, never the stale acquisition-time one
    expect(lease.stop).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledWith(expect.any(Object), 'owner/repo', '"etag-renewed"', expect.any(Object))
  })

  it('still reaches lock release after a hung renewal, and a failed conditional delete does not throw out of cleanup', async () => {
    // #given stop() returned after its grace period because the in-flight renewal never
    // settled -- currentEtag() is therefore stale, so the conditional delete at release
    // time is expected to fail its precondition (the safe direction: this run may no
    // longer actually hold the lock)
    const {releaseLock} = await import('@fro-bot/runtime')
    vi.mocked(releaseLock).mockResolvedValueOnce(err(new Error('precondition failed')))
    const lease = createLeaseController({currentEtag: () => '"etag-stale"'})
    const {runCleanup} = await import('./cleanup.js')

    // #when cleanup runs despite the hung renewal
    await expect(
      runCleanup(
        baseOptions({
          storeConfig: {enabled: true, bucket: 'bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
          lockEtag: '"etag-initial"',
          leaseRenewal: lease,
        }),
      ),
    ).resolves.toBeUndefined()

    // #then release is still attempted with the (stale) etag stop() settled on, and the
    // failed conditional delete is swallowed -- non-fatal, matching every other release failure
    expect(lease.stop).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledWith(expect.any(Object), 'owner/repo', '"etag-stale"', expect.any(Object))
  })
})
