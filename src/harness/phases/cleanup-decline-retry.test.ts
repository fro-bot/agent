import type {CleanupPhaseOptions} from './cleanup.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMetricsCollector} from '../../features/observability/index.js'
import {createMockLogger} from '../../shared/test-helpers.js'

// This suite exercises runCleanup and runPost together against a single shared,
// in-memory GitHub Actions state store, the way the real STATE_* environment handoff
// behaves across the main action and the post hook. Their own colocated test files each
// mock @actions/core independently and never observe the other phase, so neither one can
// verify the relationship this plan's Unit 2 depends on: runCleanup writes CACHE_SAVED
// (the CacheSaveStateValue enum, src/shared/cache-save-result.ts) on every save attempt,
// and runPost's own decline check reads it back to decide whether a retry is needed.
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
    delete process.env.SKIP_CACHE
  })

  const runCleanupWith = async (storeEnabled = false): Promise<void> => {
    const {runCleanup} = await import('./cleanup.js')
    await runCleanup({
      bootstrapLogger: createMockLogger(),
      reactionCtx: null,
      githubClient: null,
      attachmentResult: null,
      serverHandle: null,
      sessionRetention: null,
      detectedOpencodeVersion: '1.0.0',
      storeConfig: storeEnabled
        ? {enabled: true, bucket: 'bucket', region: 'us-east-1', prefix: 'fro-bot-state'}
        : {enabled: false, bucket: '', region: '', prefix: ''},
      metrics: createMetricsCollector(),
      agentIdentity: 'github',
      repo: 'owner/repo',
      runId: 'run-123',
      lockEtag: null,
    })
  }

  it('records not-persisted when cleanup declines, so the post hook retries and succeeds', async () => {
    // #given cleanup's own checkpoint-and-save declines (e.g. the OpenCode child was still
    // shutting down when cleanup ran)
    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValueOnce({
      cachePersisted: false,
      storePersisted: false,
      outcome: 'checkpoint-declined',
    })

    await runCleanupWith()

    // #then cleanup declined and recorded not-persisted (written on every path a result
    // exists now, not only on success) — this is exactly what makes the post hook's own
    // decline check retry, rather than skipping under the false assumption that cleanup
    // already achieved durability
    expect(saveCache).toHaveBeenCalledTimes(1)
    expect(mocks.stateStore.get('cacheSaved')).toBe('not-persisted')

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

  it('records not-persisted when cleanup finds no cacheable content, so the post hook retries rather than skipping', async () => {
    // #given hasCacheableContent is a point-in-time filesystem observation, not a
    // configuration constant like SKIP_CACHE -- a false reading here must not be trusted
    // to hold true a second time when the post hook checks later
    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValueOnce({
      cachePersisted: false,
      storePersisted: false,
      outcome: 'skipped-empty',
    })

    await runCleanupWith()

    // #then cleanup found nothing to save and recorded not-persisted, not skipped -- the
    // distinction this item exists for
    expect(saveCache).toHaveBeenCalledTimes(1)
    expect(mocks.stateStore.get('cacheSaved')).toBe('not-persisted')

    // #when the post hook runs later
    mocks.stateStore.set('shouldSaveCache', 'true')
    vi.mocked(saveCache).mockResolvedValueOnce({cachePersisted: true, storePersisted: false, outcome: 'persisted'})

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    // #then the post hook retries -- proof it bites: a cheap repeated no-op is far better
    // than treating an empty-at-the-time observation as a permanent, unretryable skip
    expect(saveCache).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith('Post-action cache saved', expect.any(Object))
  })

  it('skips the retry when cleanup already achieved durable persistence', async () => {
    // #given cleanup's save succeeds
    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValueOnce({cachePersisted: true, storePersisted: false, outcome: 'persisted'})

    await runCleanupWith()

    // #then CACHE_SAVED is recorded as durable
    expect(mocks.stateStore.get('cacheSaved')).toBe('durable')

    // #when the post hook runs later
    mocks.stateStore.set('shouldSaveCache', 'true')

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    // #then the post hook sees the durable save and never retries it
    expect(saveCache).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith('Skipping post-action: cache saved by main action', expect.any(Object))
  })

  it('does not repeat the save (and its object-store upload) when the store persisted but the cache write was rejected', async () => {
    // #given the headline double-sync bug this plan exists to fix: the object store
    // already durably persisted the session, but the Actions cache write itself returned
    // its -1 rejection sentinel
    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValueOnce({
      cachePersisted: false,
      storePersisted: true,
      outcome: 'cache-rejected',
    })

    await runCleanupWith(true)

    // #then CACHE_SAVED records store-only — durable through the object store, even
    // though the cache write itself failed
    expect(mocks.stateStore.get('cacheSaved')).toBe('store-only')

    // #when the post hook runs later
    mocks.stateStore.set('shouldSaveCache', 'true')

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    // #then the post hook does not repeat saveCache at all — proving no second full
    // object-store upload happens, not merely that a "skipped" log line was printed.
    // saveCache is the single seam that performs the object-store sync (syncSessionsToStore
    // inside save.ts), so a call count of 1 here is direct proof the upload was not repeated.
    expect(saveCache).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping post-action: state persisted to the object store by main action',
      expect.any(Object),
    )
  })

  it('skips the post-hook save entirely when SKIP_CACHE was set, without attempting a save', async () => {
    // #given a deliberate operator opt-out
    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValueOnce({
      cachePersisted: false,
      storePersisted: false,
      outcome: 'skipped-by-configuration',
    })

    await runCleanupWith()

    expect(mocks.stateStore.get('cacheSaved')).toBe('skipped')

    mocks.stateStore.set('shouldSaveCache', 'true')

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    // #then the post hook never attempts a save for a deliberate skip — retrying would
    // just repeat the same no-op the operator asked for
    expect(saveCache).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith('Skipping post-action: main action skipped the save', expect.any(Object))
  })

  it('retries when the state key holds an unrecognized value (e.g. the boolean "true" from an older action version)', async () => {
    // #given a garbled or stale CACHE_SAVED value that never went through
    // toCacheSaveStateValue -- an absent or unrecognized value must retry, not skip,
    // because the post hook is the last chance to persist state for the run
    mocks.stateStore.set('shouldSaveCache', 'true')
    mocks.stateStore.set('cacheSaved', 'true')

    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValueOnce({cachePersisted: true, storePersisted: false, outcome: 'persisted'})

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    expect(saveCache).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith('Post-action cache saved', expect.any(Object))
  })

  it('reaches both a green (durable) and a red (not-persisted) cache-save-result output from the real cleanup path (reachable-red-state bar)', async () => {
    // #given a rejecting cache adapter drives cleanup's own save through the real
    // toCacheSaveStateValue -> setCacheSaveResultOutput path -- not a mock of the mapper
    const {saveCache} = await import('../../services/cache/index.js')
    const {setOutput} = await import('@actions/core')

    vi.mocked(saveCache).mockResolvedValueOnce({
      cachePersisted: false,
      storePersisted: false,
      outcome: 'cache-rejected',
    })

    await runCleanupWith()

    // #then the red state is reachable: nothing durable happened
    expect(setOutput).toHaveBeenCalledWith('cache-save-result', 'not-persisted')

    // #when the same real path runs again with a cache write that succeeds
    vi.mocked(saveCache).mockResolvedValueOnce({cachePersisted: true, storePersisted: false, outcome: 'persisted'})

    await runCleanupWith()

    // #then the green state is reachable from the identical call site
    expect(setOutput).toHaveBeenCalledWith('cache-save-result', 'durable')
  })

  it('maps a real skipped-empty cleanup to the not-persisted output, not a rejected-write label', async () => {
    // #given no cacheable content existed -- distinct from a rejected write, but the
    // cache-save-result output collapses both into not-persisted (the job summary is what
    // names which actually happened)
    const {saveCache} = await import('../../services/cache/index.js')
    const {setOutput} = await import('@actions/core')

    vi.mocked(saveCache).mockResolvedValueOnce({
      cachePersisted: false,
      storePersisted: false,
      outcome: 'skipped-empty',
    })

    await runCleanupWith()

    // #then the output is not-persisted, exactly like a rejected write would produce
    expect(setOutput).toHaveBeenCalledWith('cache-save-result', 'not-persisted')
  })

  it('distinguishes a checkpoint-declined retry-in-progress from a rejected cache write in its log line, and never calls either "no cache content to save"', async () => {
    mocks.stateStore.set('shouldSaveCache', 'true')
    mocks.stateStore.set('cacheSaved', 'not-persisted')

    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValueOnce({
      cachePersisted: false,
      storePersisted: false,
      outcome: 'checkpoint-declined',
    })

    const {runPost} = await import('../post.js')
    const declinedLogger = createMockLogger()
    await runPost({logger: declinedLogger})

    expect(declinedLogger.info).toHaveBeenCalledWith(
      'Post-action cache save did not persist (checkpoint-declined)',
      expect.any(Object),
    )
    expect(declinedLogger.info).not.toHaveBeenCalledWith('Post-action: no cache content to save', expect.any(Object))

    mocks.stateStore.set('cacheSaved', 'not-persisted')
    vi.mocked(saveCache).mockResolvedValueOnce({
      cachePersisted: false,
      storePersisted: false,
      outcome: 'cache-rejected',
    })

    const rejectedLogger = createMockLogger()
    await runPost({logger: rejectedLogger})

    expect(rejectedLogger.info).toHaveBeenCalledWith(
      'Post-action cache save did not persist (cache-rejected)',
      expect.any(Object),
    )
    expect(rejectedLogger.info).not.toHaveBeenCalledWith('Post-action: no cache content to save', expect.any(Object))
  })
})

describe('the post hook honors a persistence-safety decline instead of retrying it (declined-for-safety)', () => {
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
    delete process.env.SKIP_CACHE
  })

  const runCleanupWithOverrides = async (overrides: Partial<CleanupPhaseOptions>): Promise<void> => {
    const {runCleanup} = await import('./cleanup.js')
    await runCleanup({
      bootstrapLogger: createMockLogger(),
      reactionCtx: null,
      githubClient: null,
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
      ...overrides,
    })
  }

  it('a run declining for a failed lease renewal is not retried by the post step', async () => {
    // #given a coordination lease this run held whose renewal has already failed -- another
    // surface (the Discord gateway, or a retried Action run) may hold the lock now
    const {saveCache} = await import('../../services/cache/index.js')
    const lease = {
      hasFailed: () => true,
      currentEtag: () => '"etag-initial"',
      stop: vi.fn().mockResolvedValue(undefined),
    }

    await runCleanupWithOverrides({lockEtag: '"etag-initial"', leaseRenewal: lease})

    // #then cleanup declined and recorded declined-for-safety, not not-persisted
    expect(saveCache).not.toHaveBeenCalled()
    expect(mocks.stateStore.get('cacheSaved')).toBe('declined-for-safety')

    // #when the post hook runs later
    mocks.stateStore.set('shouldSaveCache', 'true')

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    // #then the post hook never calls saveCache -- the process boundary does not resolve a
    // failed lease renewal, so it must not override cleanup's decline
    expect(saveCache).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping post-action: honoring persistence safety decline from main action, not retrying',
      expect.any(Object),
    )
  })

  it('a run declining for unconfirmed server quiescence is not retried by the post step', async () => {
    // #given the OpenCode server's shutdown could not confirm it had stopped writing
    const {saveCache} = await import('../../services/cache/index.js')
    const serverHandle = {
      client: {} as never,
      server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
      shutdown: vi.fn().mockResolvedValue({quiesced: false}),
    }

    await runCleanupWithOverrides({
      serverHandle,
      storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
    })

    expect(saveCache).not.toHaveBeenCalled()
    expect(mocks.stateStore.get('cacheSaved')).toBe('declined-for-safety')

    mocks.stateStore.set('shouldSaveCache', 'true')

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    // #then unconfirmed quiescence means the OpenCode child's exit was never verified -- a
    // runner does not guarantee orphaned children are reaped between steps, so the post
    // hook's own process-boundary argument cannot resolve this either
    expect(saveCache).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping post-action: honoring persistence safety decline from main action, not retrying',
      expect.any(Object),
    )
  })

  it('a run declining for unresolved background-subagent ownership is not retried by the post step', async () => {
    // #given the ownership ledger has an entry that never settled
    const {saveCache} = await import('../../services/cache/index.js')
    const {createOwnershipLedger} = await import('@fro-bot/runtime')
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'reviewer')
    ledger.markUnknown('ses_child')

    await runCleanupWithOverrides({
      ownershipLedger: ledger,
      storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
    })

    expect(saveCache).not.toHaveBeenCalled()
    expect(mocks.stateStore.get('cacheSaved')).toBe('declined-for-safety')

    mocks.stateStore.set('shouldSaveCache', 'true')

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    expect(saveCache).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      'Skipping post-action: honoring persistence safety decline from main action, not retrying',
      expect.any(Object),
    )
  })

  it('still retries a genuine not-persisted from an ordinary failed save -- this must not regress', async () => {
    // #given an ordinary checkpoint decline, unrelated to persistence safety
    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValueOnce({
      cachePersisted: false,
      storePersisted: false,
      outcome: 'checkpoint-declined',
    })

    await runCleanupWithOverrides({storeConfig: {enabled: false, bucket: '', region: '', prefix: ''}})

    expect(mocks.stateStore.get('cacheSaved')).toBe('not-persisted')

    mocks.stateStore.set('shouldSaveCache', 'true')
    vi.mocked(saveCache).mockResolvedValueOnce({cachePersisted: true, storePersisted: false, outcome: 'persisted'})

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    // #then the post hook retries -- an ordinary not-persisted must not be swept into the
    // new safety-decline skip path (1 attempt at cleanup + 1 retry at post)
    expect(saveCache).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith('Post-action cache saved', expect.any(Object))
  })

  it('the job summary reports a safety-decline skip distinctly from an ordinary already-durable skip', async () => {
    // #given a safety decline (lease renewal failed)
    const {saveCache} = await import('../../services/cache/index.js')
    const lease = {
      hasFailed: () => true,
      currentEtag: () => '"etag-initial"',
      stop: vi.fn().mockResolvedValue(undefined),
    }
    await runCleanupWithOverrides({lockEtag: '"etag-initial"', leaseRenewal: lease})
    mocks.stateStore.set('shouldSaveCache', 'true')

    const core = await import('@actions/core')
    const {runPost} = await import('../post.js')
    await runPost({logger: createMockLogger()})

    // #then the post step writes its own labeled job-summary row naming the safety skip --
    // a silent skip would be as misleading as the silent retry this fix prevents
    expect(core.summary.addHeading).toHaveBeenCalledWith(
      'Session Persistence (post-action: safety decline honored, not retried)',
      3,
    )

    // #when a different run already achieved durable persistence at cleanup time (an
    // ordinary skip, not a safety decline)
    vi.clearAllMocks()
    mocks.stateStore.clear()
    vi.mocked(saveCache).mockResolvedValueOnce({cachePersisted: true, storePersisted: false, outcome: 'persisted'})
    await runCleanupWithOverrides({storeConfig: {enabled: false, bucket: '', region: '', prefix: ''}})
    mocks.stateStore.set('shouldSaveCache', 'true')

    // #and only the post hook's own summary calls are inspected below -- cleanup.ts writes
    // its own 'Session Persistence' row for the durable save, which is a separate, correct
    // row from a separate phase and not what this assertion is about
    vi.mocked(core.summary.addHeading).mockClear()

    const logger = createMockLogger()
    await runPost({logger})

    // #then the post step never writes a 'Session Persistence' job-summary row at all for an
    // ordinary already-durable skip -- distinct from the safety-decline row above, which
    // always writes one. The log line alone names the ordinary case.
    expect(core.summary.addHeading).not.toHaveBeenCalledWith(expect.stringContaining('Session Persistence'), 3)
    expect(logger.info).toHaveBeenCalledWith('Skipping post-action: cache saved by main action', expect.any(Object))
  })

  it('an absent or unrecognized CACHE_SAVED state value still fails toward retrying (not toward the new safety skip)', async () => {
    // #given a garbled/absent state value -- parseCacheSaveStateValue must keep mapping this
    // to not-persisted, never to declined-for-safety, since declined-for-safety is written
    // only deliberately by runCleanup and an unrecognized value carries no such guarantee.
    // The post hook is the last chance to persist state, so the safe direction here is still
    // "retry", not "skip" -- that direction is unchanged by this fix.
    mocks.stateStore.set('shouldSaveCache', 'true')
    mocks.stateStore.set('cacheSaved', 'garbled-value')

    const {saveCache} = await import('../../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValueOnce({cachePersisted: true, storePersisted: false, outcome: 'persisted'})

    const {runPost} = await import('../post.js')
    const logger = createMockLogger()
    await runPost({logger})

    expect(saveCache).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith('Post-action cache saved', expect.any(Object))
  })
})
