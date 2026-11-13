import type {OpenCodeV2ServerHandle, OwnershipLedger} from '@fro-bot/runtime'
import type {BootstrapPhaseResult} from './phases/bootstrap.js'
import type {CacheRestorePhaseResult} from './phases/cache-restore.js'
import type {RoutingPhaseResult} from './phases/routing.js'
import type {SandboxLifecycle, SandboxReleaseResult} from './phases/sandbox-lifecycle.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createLogger} from '../shared/logger.js'
import {run} from './run.js'

vi.mock('@actions/core', () => ({
  getInput: vi.fn(() => ''),
  saveState: vi.fn(),
  setFailed: vi.fn(),
}))

vi.mock('../features/agent/index.js', () => ({
  applyTerminalReaction: vi.fn(),
}))

vi.mock('../features/observability/index.js', () => ({
  createMetricsCollector: vi.fn(() => ({
    start: vi.fn(),
    end: vi.fn(),
    recordError: vi.fn(),
  })),
  writeInvocationOutcomeSummary: vi.fn(),
}))

vi.mock('../shared/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  })),
}))

vi.mock('./config/outputs.js', () => ({
  setActionOutputs: vi.fn(),
  setInvocationOutcomeOutput: vi.fn(),
}))

vi.mock('./config/state-keys.js', () => ({
  STATE_KEYS: {
    SHOULD_SAVE_CACHE: 'should-save-cache',
    CACHE_SAVED: 'cache-saved',
    ISOLATED_RUN: 'isolated-run',
    SANDBOX_STATE: 'sandbox-state',
  },
}))

vi.mock('./phases/acknowledge.js', () => ({
  runAcknowledge: vi.fn(),
}))

vi.mock('./phases/bootstrap.js', () => ({
  runBootstrap: vi.fn(),
}))

vi.mock('./phases/cache-restore.js', () => ({
  runCacheRestore: vi.fn(),
}))

vi.mock('./phases/repo-skills.js', () => ({
  runRepoSkills: vi.fn(async () => null),
  removeRepoSkillsStaging: vi.fn(async () => undefined),
}))

vi.mock('./phases/cleanup.js', () => ({
  runCleanup: vi.fn().mockResolvedValue({quiescenceConfirmed: true, continuityUnverified: false}),
}))

vi.mock('./phases/coordination-decline.js', () => ({
  runCoordinationDecline: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./phases/coordination-clear.js', () => ({
  runBlockedLabelClear: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./phases/dedup.js', () => ({
  runDedup: vi.fn(),
  saveDedupMarker: vi.fn(),
}))

vi.mock('./phases/acquire-lock.js', () => ({
  runAcquireLock: vi.fn(),
}))

// Lets one test drive the REAL runAcquireLock against a rejecting lock primitive.
vi.mock('@fro-bot/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {...original, acquireLock: vi.fn(), createS3Adapter: vi.fn(() => ({}))}
})

vi.mock('./phases/execute.js', () => ({
  computeDrainDeadlineMs: vi.fn(() => 60_000),
  runExecute: vi.fn(),
  resolveRequestedOutputModeState: vi.fn(() => 'omitted'),
}))

vi.mock('./phases/finalize.js', () => ({
  runFinalize: vi.fn(),
  runFinalizeWithResult: vi.fn().mockResolvedValue({exitCode: 0, deliveryKind: 'none'}),
}))

// Only the release itself is faked: the options builder stays real, so these tests assert the handoff `run.ts` makes.
vi.mock('./phases/release-v2.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./phases/release-v2.js')>()),
  runReleaseV2: vi.fn(),
}))

vi.mock('./phases/review-reconciliation.js', () => ({
  runReviewReconciliation: vi.fn().mockResolvedValue(undefined),
}))

const reviewDeliveryReceiptOpsMocks = vi.hoisted(() => ({
  createReviewDeliveryReceiptOperations: vi.fn(() => ({
    reserve: vi.fn(),
    recordDelivered: vi.fn(),
    release: vi.fn(),
  })),
}))

vi.mock('../services/github/review-delivery-receipt.js', () => ({
  createReviewDeliveryReceiptOperations: reviewDeliveryReceiptOpsMocks.createReviewDeliveryReceiptOperations,
}))

vi.mock('./phases/routing.js', () => ({
  runRouting: vi.fn(),
}))

vi.mock('./phases/session-prep.js', () => ({
  runSessionPrep: vi.fn(),
}))

function createBootstrap(): BootstrapPhaseResult {
  return {
    inputs: {
      githubToken: 'github-token',
      authJson: '{}',
      trustedHeadSha: '',
      prompt: null,
      outputMode: 'auto',
      sessionRetention: 50,
      storeConfig: {enabled: false, bucket: '', region: '', prefix: ''},
      agent: null,
      model: null,
      timeoutMs: 1_000,
      serverBootstrapTimeoutMs: 5000,
      opencodeVersion: '1.0.0',
      skipCache: false,
      systematicVersion: '1.0.0',
      opencodeConfig: null,
      systematicConfig: null,
      dedupWindow: 0,
      responseMode: 'github',
      reviewSkipLabel: null,
      brokeredPushExtraPaths: [],
      repoSkills: false,
      isolateAgent: false,
    },
    logger: createLogger({phase: 'test'}),
    opencodeResult: {path: 'opencode', version: '1.0.0'},
    delivery: 'model-gh',
    responseFilePath: null,
    responseFilePathCandidates: null,
    trustedHeadSha: '',
    sandboxTools: null,
  }
}

function createRouting(): RoutingPhaseResult {
  return {
    githubClient: {} as RoutingPhaseResult['githubClient'],
    triggerResult: {
      shouldProcess: true,
      context: {
        eventType: 'pull_request',
        eventName: 'pull_request',
        repo: {owner: 'owner', repo: 'repo'},
        ref: 'refs/pull/42/merge',
        sha: 'sha',
        runId: 123,
        actor: 'actor',
        action: 'opened',
        author: {login: 'author', association: 'CONTRIBUTOR', isBot: false},
        target: null,
        commentBody: null,
        commentId: null,
        hasMention: false,
        command: null,
        isBotReviewRequested: false,
        raw: {},
      },
    },
    agentContext: {
      eventName: 'pull_request',
      repo: 'owner/repo',
      ref: 'refs/pull/42/merge',
      actor: 'actor',
      runId: '123',
      issueNumber: 42,
      issueTitle: 'Review pull request',
      issueType: 'pr',
      commentBody: null,
      commentAuthor: null,
      commentId: null,
      defaultBranch: 'main',
      diffContext: null,
      hydratedContext: null,
      authorAssociation: 'CONTRIBUTOR',
      isRequestedReviewer: false,
    },
    botLogin: 'fro-bot',
  }
}

const QUIET_RELEASE = {
  drain: {expired: false, cancelledCount: 0, settledCount: 0, unknownCount: 0},
  persistenceDeclineReason: undefined,
}

async function arrange(
  options: {
    readonly executeSuccess?: boolean
    readonly executeError?: Error
    readonly ledger?: OwnershipLedger
    readonly extras?: Partial<Awaited<ReturnType<typeof import('./phases/execute.js').runExecute>>>
  } = {},
) {
  const {runBootstrap} = await import('./phases/bootstrap.js')
  const {runRouting} = await import('./phases/routing.js')
  const {runDedup} = await import('./phases/dedup.js')
  const {runAcquireLock} = await import('./phases/acquire-lock.js')
  const {runAcknowledge} = await import('./phases/acknowledge.js')
  const {runCacheRestore} = await import('./phases/cache-restore.js')
  const {runSessionPrep} = await import('./phases/session-prep.js')
  const {runExecute} = await import('./phases/execute.js')
  const {runReviewReconciliation} = await import('./phases/review-reconciliation.js')
  const {runFinalizeWithResult} = await import('./phases/finalize.js')
  const {runCleanup} = await import('./phases/cleanup.js')
  const {runReleaseV2} = await import('./phases/release-v2.js')

  const bootstrap = createBootstrap()
  vi.mocked(runBootstrap).mockResolvedValue({
    ...bootstrap,
    opencodeResult: {...bootstrap.opencodeResult, version: '2.2.5'},
  })
  vi.mocked(runRouting).mockResolvedValue(createRouting())
  vi.mocked(runDedup).mockResolvedValue({shouldProceed: true, entity: {entityType: 'pr', entityNumber: 42}})
  vi.mocked(runAcquireLock).mockResolvedValue({outcome: 's3-disabled'})
  vi.mocked(runAcknowledge).mockResolvedValue({
    repo: 'owner/repo',
    commentId: 99,
    issueNumber: 42,
    issueType: 'pr',
    botLogin: 'fro-bot',
  })
  const v2Handle = {url: 'http://127.0.0.1:1', shutdown: vi.fn()} as unknown as OpenCodeV2ServerHandle
  const cacheRestore: CacheRestorePhaseResult = {
    cacheResult: {hit: false, key: 'k', restoredPath: null, corrupted: false, source: null},
    cacheStatus: 'miss',
    serverHandle: v2Handle,
  }
  vi.mocked(runCacheRestore).mockResolvedValue(cacheRestore)
  vi.mocked(runSessionPrep).mockResolvedValue({
    recentSessions: [],
    priorWorkContext: [],
    attachmentResult: null,
    normalizedWorkspace: '/w',
    logicalKey: null,
    continueSessionId: null,
    isContinuation: false,
    sessionTitle: null,
  })
  const ledger = options.ledger ?? ({outstanding: () => 0, unknown: () => 0} as unknown as OwnershipLedger)
  if (options.executeError === undefined) {
    vi.mocked(runExecute).mockResolvedValue({
      success: options.executeSuccess ?? true,
      exitCode: 0,
      sessionId: 'ses_v2',
      error: null,
      tokenUsage: null,
      model: null,
      cost: null,
      prsCreated: [],
      commitsCreated: [],
      commentsPosted: 0,
      llmError: null,
      resolvedOutputMode: 'working-dir',
      outputModeMigration: {requested: 'omitted', resolved: 'working-dir'},
      observationGap: false,
      recoveryBoundaryUnresolved: false,
      executionDurationMs: 10,
      ownershipLedger: ledger,
      ...options.extras,
    })
  } else {
    vi.mocked(runExecute).mockRejectedValue(options.executeError)
  }
  vi.mocked(runReviewReconciliation).mockResolvedValue({reconciled: false, reason: 'not-applicable'})
  vi.mocked(runFinalizeWithResult).mockResolvedValue({exitCode: 0, deliveryKind: 'none'})
  vi.mocked(runCleanup).mockResolvedValue({quiescenceConfirmed: true, continuityUnverified: false})
  vi.mocked(runReleaseV2).mockResolvedValue(QUIET_RELEASE)
  return {cacheRestore, v2Handle, ledger}
}

describe('run on an OpenCode V2 server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('decides repo skills after routing and hands the result to the cache-restore start', async () => {
    // #given a trusted run whose repo skills phase staged a source
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    const {runRepoSkills} = await import('./phases/repo-skills.js')
    await arrange()
    const source = {symlinkedSkillIds: [], sourceDir: '/tmp/x/source-tree/.agents/skills', stagingRoot: '/tmp/x'}
    vi.mocked(runRepoSkills).mockResolvedValue(source)

    // #when
    await run()

    // #then the phase saw the bootstrap and routing results, and the start received its source
    const [bootstrapArg, routingArg] = vi.mocked(runRepoSkills).mock.calls[0] ?? []
    expect(bootstrapArg?.opencodeResult.version).toBe('2.2.5')
    expect(routingArg?.botLogin).toBe('fro-bot')
    expect(vi.mocked(runCacheRestore).mock.calls[0]?.[2]).toBe(source)
  })

  describe('repo skills staging cleanup', () => {
    const source = {
      symlinkedSkillIds: [],
      sourceDir: '/tmp/fro-bot-repo-skills-x/source-tree/.agents/skills',
      stagingRoot: '/tmp/fro-bot-repo-skills-x',
    }

    it('removes the staging root after cleanup has stopped the server, on a successful run', async () => {
      // #given a run that staged repo skills and succeeds
      const {runCleanup} = await import('./phases/cleanup.js')
      const {removeRepoSkillsStaging, runRepoSkills} = await import('./phases/repo-skills.js')
      await arrange()
      vi.mocked(runRepoSkills).mockResolvedValue(source)

      // #when
      await run()

      // #then it is removed once, and only after runCleanup (which shuts the server down) returned
      expect(vi.mocked(removeRepoSkillsStaging)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(removeRepoSkillsStaging)).toHaveBeenCalledWith(source.stagingRoot)
      const cleanupOrder = vi.mocked(runCleanup).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
      const removalOrder = vi.mocked(removeRepoSkillsStaging).mock.invocationCallOrder[0] ?? 0
      expect(removalOrder).toBeGreaterThan(cleanupOrder)
    })

    it('removes it when a phase throws after the server started', async () => {
      // #given execution that throws
      const {removeRepoSkillsStaging, runRepoSkills} = await import('./phases/repo-skills.js')
      await arrange({executeError: new Error('boom')})
      vi.mocked(runRepoSkills).mockResolvedValue(source)

      // #when
      await run()

      // #then the finally block still removes it
      expect(vi.mocked(removeRepoSkillsStaging)).toHaveBeenCalledWith(source.stagingRoot)
    })

    it('removes it when the server failed to start', async () => {
      // #given a cache-restore (server start) that fails
      const {runCacheRestore} = await import('./phases/cache-restore.js')
      const {removeRepoSkillsStaging, runRepoSkills} = await import('./phases/repo-skills.js')
      await arrange()
      vi.mocked(runRepoSkills).mockResolvedValue(source)
      vi.mocked(runCacheRestore).mockResolvedValue(null)

      // #when
      const exitCode = await run()

      // #then the run failed and the staging root is removed anyway
      expect(exitCode).toBe(1)
      expect(vi.mocked(removeRepoSkillsStaging)).toHaveBeenCalledWith(source.stagingRoot)
    })

    it('asks for no removal when nothing was staged', async () => {
      // #given a run without repo skills
      const {removeRepoSkillsStaging, runRepoSkills} = await import('./phases/repo-skills.js')
      await arrange()
      vi.mocked(runRepoSkills).mockResolvedValue(null)

      // #when
      await run()

      // #then the (no-op) removal receives null
      expect(vi.mocked(removeRepoSkillsStaging)).toHaveBeenCalledWith(null)
    })
  })

  it('runs execution on the V2 handle, releases it through the V2 release, and cleans up', async () => {
    // #given a cache-restore result carrying the V2 handle
    const {runExecute} = await import('./phases/execute.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    const {cacheRestore, v2Handle, ledger} = await arrange()

    // #when
    await run()

    // #then the release runs for a succeeded run, with the ledger, the root session and the retention the run was
    // configured with
    expect(vi.mocked(runExecute).mock.calls[0]?.[2]).toBe(cacheRestore)
    expect(vi.mocked(runReleaseV2)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runReleaseV2).mock.calls[0]?.[0]).toMatchObject({
      serverHandle: v2Handle,
      executionSucceeded: true,
      rootSessionId: 'ses_v2',
      ledger,
      deadlineMs: 60_000,
      sessionRetention: 50,
    })

    // #and cleanup is handed the V2 server
    const cleanupOptions = vi.mocked(runCleanup).mock.calls[0]?.[0]
    expect(cleanupOptions?.serverHandleV2).toBe(v2Handle)
    expect(cleanupOptions?.skipSessionPersistence).toBe(false)
  })

  it('reports an expired drain as an incomplete invocation even when the stop that followed was confirmed', async () => {
    // #given a drain that ran out of time, a stop that then confirmed the directory quiet, and nothing left unknown
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    const {setInvocationOutcomeOutput} = await import('./config/outputs.js')
    await arrange()
    vi.mocked(runReleaseV2).mockResolvedValue({
      drain: {expired: true, cancelledCount: 0, settledCount: 0, unknownCount: 0},
      persistenceDeclineReason: undefined,
    })

    // #when
    const exitCode = await run()

    // #then the response was produced before the owned work finished, so publication is vetoed and the run is incomplete
    expect(vi.mocked(runFinalizeWithResult).mock.calls[0]?.[7]).toMatchObject({knownExecutionVeto: true})
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('incomplete')
    expect(exitCode).toBe(1)
  })

  it('fails the run when the last root turn, started by a notice after the attempt, failed', async () => {
    // #given an attempt that succeeded and a release that saw the turn a notice started fail
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    await arrange()
    vi.mocked(runReleaseV2).mockResolvedValue({
      ...QUIET_RELEASE,
      observed: {
        result: {
          tokens: null,
          model: null,
          cost: null,
          prsCreated: [],
          commitsCreated: [],
          commentsPosted: 0,
          llmError: null,
        },
        rootTerminal: {kind: 'failed'},
        failure: {type: 'quota_exceeded', message: 'out of credit', retryable: false},
        usage: null,
      },
    })

    // #when
    await run()

    // #then finalize is handed a failed execution, not the attempt's success
    const finalized = vi.mocked(runFinalizeWithResult).mock.calls[0]?.[3]
    expect(finalized).toMatchObject({success: false, exitCode: 1, error: 'out of credit'})
  })

  it('lets unresolved ownership veto publication, persistence and the invocation outcome together', async () => {
    // #given a ledger entry the drain could not account for, and a release that reports it
    const {createOwnershipLedger} = await import('@fro-bot/runtime')
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    const {setInvocationOutcomeOutput} = await import('./config/outputs.js')
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'child')
    ledger.markUnknown('ses_child')
    await arrange({ledger})
    vi.mocked(runReleaseV2).mockResolvedValue({
      drain: {expired: false, cancelledCount: 0, settledCount: 0, unknownCount: 1},
      persistenceDeclineReason: undefined,
    })

    // #when
    const exitCode = await run()

    // #then publication is vetoed before it happens
    expect(vi.mocked(runFinalizeWithResult).mock.calls[0]?.[7]).toMatchObject({knownExecutionVeto: true})

    // #and cleanup is handed the very ledger whose unknown entry makes persistence unsafe, so it declines the save
    const cleanupOptions = vi.mocked(runCleanup).mock.calls[0]?.[0]
    expect(cleanupOptions?.ownershipLedger).toBe(ledger)
    expect(cleanupOptions?.ownershipLedger?.isPersistenceSafe()).toBe(false)

    // #and the invocation is reported incomplete, with the reason named
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('incomplete')
    expect(exitCode).toBe(1)
  })

  it('withholds publication and the save when the server exit could not be confirmed after a clean drain', async () => {
    // #given a quiet drain with settled ownership, and a shutdown that threw or came back unconfirmed
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    const {setInvocationOutcomeOutput} = await import('./config/outputs.js')
    await arrange()
    vi.mocked(runReleaseV2).mockResolvedValue({
      drain: {expired: false, cancelledCount: 0, settledCount: 0, unknownCount: 0},
      persistenceDeclineReason: 'the OpenCode server exit could not be confirmed',
      serverExitUnconfirmed: true,
    })

    // #when
    const exitCode = await run()

    // #then the pre-publication veto (approval, brokered push, endorsing comment) is raised, as the drain facts are clean
    expect(vi.mocked(runFinalizeWithResult).mock.calls[0]?.[7]).toMatchObject({knownExecutionVeto: true})

    // #and the save is declined with the release's reason
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({
      skipSessionPersistence: true,
      persistenceDeclineReason: 'the OpenCode server exit could not be confirmed',
    })
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('incomplete')
    expect(exitCode).toBe(1)
  })

  it('declines the save and vetoes publication for a prompt whose acknowledgment was lost, after the stop path', async () => {
    // #given an execution that failed because its prompt POST failed after it may have been sent
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    const core = await import('@actions/core')
    await arrange({executeSuccess: false, extras: {sendUncertain: true}})

    // #when
    await run()

    // #then the release was the STOP path (not a drain), and a confirmed-quiet directory still does not allow the save
    expect(vi.mocked(runReleaseV2).mock.calls[0]?.[0]).toMatchObject({executionSucceeded: false})
    expect(vi.mocked(runFinalizeWithResult).mock.calls[0]?.[7]).toMatchObject({knownExecutionVeto: true})
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({
      skipSessionPersistence: true,
      persistenceDeclineReason: expect.stringContaining('acknowledgment was lost') as string,
    })
    expect(vi.mocked(core.saveState)).toHaveBeenCalledWith('should-save-cache', 'false')
  })

  it('does not report a drain that finished in time as incomplete', async () => {
    // #given
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {setInvocationOutcomeOutput} = await import('./config/outputs.js')
    await arrange()

    // #when
    const exitCode = await run()

    // #then
    expect(vi.mocked(runFinalizeWithResult).mock.calls[0]?.[7]).toMatchObject({knownExecutionVeto: false})
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('succeeded')
    expect(exitCode).toBe(0)
  })

  it('hands the execute phase observation to the release, explicitly', async () => {
    // #given an execute result that carries one
    const {runReleaseV2} = await import('./phases/release-v2.js')
    const liveObservation = {tracker: {}, snapshot: vi.fn(), stop: vi.fn()} as never
    await arrange({extras: {liveObservation}})

    // #when
    await run()

    // #then the release receives exactly that value
    const options = vi.mocked(runReleaseV2).mock.calls[0]?.[0]
    expect(options?.liveObservation).toBe(liveObservation)
  })

  it('stops, rather than drains, a run whose execution did not succeed', async () => {
    // #given
    const {runReleaseV2} = await import('./phases/release-v2.js')
    await arrange({executeSuccess: false})

    // #when
    await run()

    // #then
    expect(vi.mocked(runReleaseV2).mock.calls[0]?.[0]).toMatchObject({executionSucceeded: false})
  })

  it('does not save the session when the release could not confirm the directory quiet', async () => {
    // #given
    const core = await import('@actions/core')
    const {runCleanup} = await import('./phases/cleanup.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    await arrange()
    vi.mocked(runReleaseV2).mockResolvedValue({
      drain: {expired: true, cancelledCount: 0, settledCount: 0, unknownCount: 1},
      persistenceDeclineReason: 'the run directory could not be confirmed quiet',
    })

    // #when
    await run()

    // #then the existing decline path is used: cleanup skips the save with the reason, and the post hook is told not to
    const cleanupOptions = vi.mocked(runCleanup).mock.calls[0]?.[0]
    expect(cleanupOptions).toMatchObject({
      skipSessionPersistence: true,
      persistenceDeclineReason: 'the run directory could not be confirmed quiet',
    })
    expect(vi.mocked(core.saveState)).toHaveBeenCalledWith('should-save-cache', 'false')
  })

  it('stops the directory in the finally block when a phase threw before the release, then cleans up', async () => {
    // #given execution that throws
    const {runCleanup} = await import('./phases/cleanup.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    const {v2Handle} = await arrange({executeError: new Error('boom')})
    const order: string[] = []
    vi.mocked(runReleaseV2).mockImplementation(async () => {
      order.push('release')
      return {...QUIET_RELEASE, persistenceDeclineReason: 'the run directory could not be confirmed quiet'}
    })
    vi.mocked(runCleanup).mockImplementation(async () => {
      order.push('cleanup')
      return {quiescenceConfirmed: true, continuityUnverified: false}
    })

    // #when
    const exitCode = await run()

    // #then
    expect(exitCode).toBe(1)
    expect(order).toEqual(['release', 'cleanup'])
    expect(vi.mocked(runReleaseV2).mock.calls[0]?.[0]).toMatchObject({
      serverHandle: v2Handle,
      executionSucceeded: false,
      rootSessionId: null,
    })
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({skipSessionPersistence: true})
  })

  it('releases the server once: a run that already released it is not released again in the finally block', async () => {
    // #given
    const {runReleaseV2} = await import('./phases/release-v2.js')
    await arrange()

    // #when
    await run()

    // #then
    expect(vi.mocked(runReleaseV2)).toHaveBeenCalledTimes(1)
  })
})

// Session state on the runner is only worth saving for a run that restored the cache and started the V2 server: until
// then the database on disk is whatever the runner already held, not this invocation's history.
async function cleanupOptions() {
  const {runCleanup} = await import('./phases/cleanup.js')
  return vi.mocked(runCleanup).mock.calls[0]?.[0]
}

describe('run persistence: only a run that started the V2 server may save session state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('declines the save when bootstrap rejects the inputs (a V1 version, or malformed input)', async () => {
    // #given bootstrap that returns null, as it does after an input or setup failure
    const {runBootstrap} = await import('./phases/bootstrap.js')
    await arrange()
    vi.mocked(runBootstrap).mockResolvedValue(null)

    // #when
    const exitCode = await run()

    // #then cleanup still runs, but with the save declined and a reason that says why
    expect(exitCode).toBe(1)
    const options = await cleanupOptions()
    expect(options).toMatchObject({skipSessionPersistence: true})
    expect(options?.persistenceDeclineReason).toMatch(/before the OpenCode V2 server started/)
  })

  it('declines the save when bootstrap throws (a setup failure such as a download error)', async () => {
    // #given
    const {runBootstrap} = await import('./phases/bootstrap.js')
    await arrange()
    vi.mocked(runBootstrap).mockRejectedValue(new Error('download failed: 504'))

    // #when
    await run()

    // #then
    expect(await cleanupOptions()).toMatchObject({skipSessionPersistence: true})
  })

  it('declines the save when routing skips the event', async () => {
    // #given a skipped event: nothing was restored for it
    const {runRouting} = await import('./phases/routing.js')
    await arrange()
    vi.mocked(runRouting).mockResolvedValue({skipped: true, skipReason: 'no_mention', skipMessage: 'nothing to do'})

    // #when
    await run()

    // #then
    expect(await cleanupOptions()).toMatchObject({skipSessionPersistence: true})
  })

  it('declines the save when dedup skips the run', async () => {
    // #given
    const {runDedup} = await import('./phases/dedup.js')
    await arrange()
    vi.mocked(runDedup).mockResolvedValue({shouldProceed: false} as Awaited<ReturnType<typeof runDedup>>)

    // #when
    await run()

    // #then
    expect(await cleanupOptions()).toMatchObject({skipSessionPersistence: true})
  })

  it('declines the save when the cache restore phase throws before the server is up', async () => {
    // #given
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    await arrange()
    vi.mocked(runCacheRestore).mockRejectedValue(new Error('restore blew up'))

    // #when
    await run()

    // #then
    expect(await cleanupOptions()).toMatchObject({skipSessionPersistence: true})
  })

  it('does not decline a run that started the server, even when execution then throws', async () => {
    // #given a server that started and an execution that crashed afterwards
    await arrange({executeError: new Error('boom')})

    // #when
    await run()

    // #then the save is not declined by this rule (the release and ledger gates still apply downstream)
    const options = await cleanupOptions()
    expect(options?.skipSessionPersistence).not.toBe(true)
  })

  it('does not decline a run that completed normally', async () => {
    // #given
    await arrange()

    // #when
    await run()

    // #then
    const options = await cleanupOptions()
    expect(options?.skipSessionPersistence).not.toBe(true)
    expect(options?.persistenceDeclineReason).toBeUndefined()
  })

  it('arms the post-hook save only once the server has started', async () => {
    // #given
    const core = await import('@actions/core')
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    const {cacheRestore} = await arrange()
    const order: string[] = []
    vi.mocked(runCacheRestore).mockImplementation(async () => {
      order.push('server-started')
      return cacheRestore
    })
    vi.mocked(core.saveState).mockImplementation((key, value) => {
      if (key === 'should-save-cache') order.push(`should-save-cache=${String(value)}`)
    })

    // #when
    await run()

    // #then it is false at the start and true only after the server started
    expect(order.slice(0, 3)).toEqual(['should-save-cache=false', 'server-started', 'should-save-cache=true'])
  })
})

describe('run with isolate-agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function fakeSandbox(outcome: SandboxReleaseResult) {
    const release = vi.fn(async () => outcome)
    return {sandbox: {prepare: vi.fn(), launch: vi.fn(), release} as unknown as SandboxLifecycle, release}
  }

  const RESTORED: SandboxReleaseResult = {stop: 'stopped', restore: 'restored'}

  async function arrangeIsolated(outcome: SandboxReleaseResult, options: Parameters<typeof arrange>[0] = {}) {
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    const arranged = await arrange(options)
    const {sandbox, release} = fakeSandbox(outcome)
    vi.mocked(runCacheRestore).mockResolvedValue({...arranged.cacheRestore, sandbox})
    return {...arranged, release}
  }

  async function arrangeFailedStart(outcome: SandboxReleaseResult) {
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    const arranged = await arrange({})
    const {sandbox, release} = fakeSandbox(outcome)
    // The lifecycle belongs to the bootstrap result, so the run holds it even though the start returned nothing.
    const bootstrap = createBootstrap()
    vi.mocked(runBootstrap).mockResolvedValue({
      ...bootstrap,
      opencodeResult: {...bootstrap.opencodeResult, version: '2.2.5'},
      sandbox,
    })
    vi.mocked(runCacheRestore).mockResolvedValue(null)
    return {...arranged, release}
  }

  it('releases the sandbox after the server release and before finalize, then lets finalize and cleanup proceed', async () => {
    // #given an isolated run whose sandbox stops and restores cleanly
    const core = await import('@actions/core')
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    const {release} = await arrangeIsolated(RESTORED)

    // #when
    const exitCode = await run()

    // #then order: server release, sandbox release, finalize
    expect(exitCode).toBe(0)
    expect(release).toHaveBeenCalledTimes(1)
    const order = (mock: {mock: {invocationCallOrder: number[]}}): number => mock.mock.invocationCallOrder[0] ?? 0
    expect(order(vi.mocked(runReleaseV2))).toBeLessThan(order(release))
    expect(order(release)).toBeLessThan(order(vi.mocked(runFinalizeWithResult)))
    // #and the post hook is told this state came from a sandbox before the save is armed
    const saved = vi.mocked(core.saveState).mock.calls.map(call => `${call[0]}=${call[1]}`)
    expect(saved.indexOf('isolated-run=true')).toBeGreaterThanOrEqual(0)
    expect(saved.indexOf('isolated-run=true')).toBeLessThan(saved.lastIndexOf('should-save-cache=true'))
    // #and persistence is not declined
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({
      skipSessionPersistence: false,
      sandboxOutputUntrusted: false,
    })
  })

  it.each([
    ['an unconfirmed stop', {stop: 'unconfirmed', restore: 'unsafe', reason: 'sandbox processes survived'} as const],
    ['an unsafe take-back', {stop: 'stopped', restore: 'unsafe', reason: 'ancestor /x is a symlink'} as const],
  ])('fails closed on %s: no response read, no push, no review, no save', async (_label, outcome) => {
    // #given a sandbox that cannot be confirmed stopped and restored
    const core = await import('@actions/core')
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {runReviewReconciliation} = await import('./phases/review-reconciliation.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    await arrangeIsolated(outcome)

    // #when
    const exitCode = await run()

    // #then nothing that reads or publishes the sandbox's output ran, the run failed, and persistence is declined
    expect(exitCode).toBe(1)
    expect(vi.mocked(runFinalizeWithResult)).not.toHaveBeenCalled()
    expect(vi.mocked(runReviewReconciliation)).not.toHaveBeenCalled()
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({
      skipSessionPersistence: true,
      sandboxOutputUntrusted: true,
    })
    expect(
      String(
        (vi.mocked(runCleanup).mock.calls[0]?.[0] as {persistenceDeclineReason?: string}).persistenceDeclineReason,
      ),
    ).toContain(outcome.reason)
    expect(vi.mocked(core.saveState)).toHaveBeenCalledWith('should-save-cache', 'false')
    expect(vi.mocked(core.setFailed)).toHaveBeenCalledWith(expect.stringContaining(outcome.reason))
  })

  it('fails the run, with no response read and no save, when the key proxy exited on its own', async () => {
    // #given a sandbox that restored cleanly but whose key proxy died before the teardown asked it to stop
    const core = await import('@actions/core')
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    await arrangeIsolated({stop: 'stopped', restore: 'restored', proxy: 'crashed'})

    // #when
    const exitCode = await run()

    // #then the run fails before anything is published, and persistence is declined; the sandbox output stays trusted
    expect(exitCode).toBe(1)
    expect(vi.mocked(runFinalizeWithResult)).not.toHaveBeenCalled()
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({
      skipSessionPersistence: true,
      sandboxOutputUntrusted: false,
    })
    expect(
      String(
        (vi.mocked(runCleanup).mock.calls[0]?.[0] as {persistenceDeclineReason?: string}).persistenceDeclineReason,
      ),
    ).toContain('key proxy')
    expect(vi.mocked(core.saveState)).toHaveBeenCalledWith('should-save-cache', 'false')
    expect(vi.mocked(core.setFailed)).toHaveBeenCalledWith(expect.stringContaining('key proxy'))
  })

  it('treats a key proxy whose exit was not confirmed like an unsafe sandbox: nothing is read or saved', async () => {
    // #given a release that reports the proxy unconfirmed (which makes the restore unsafe)
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    await arrangeIsolated({
      stop: 'stopped',
      restore: 'unsafe',
      reason: 'the key proxy exit could not be confirmed, so the run cannot be trusted',
      proxy: 'unconfirmed',
    })

    // #when
    const exitCode = await run()

    // #then
    expect(exitCode).toBe(1)
    expect(vi.mocked(runFinalizeWithResult)).not.toHaveBeenCalled()
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({
      skipSessionPersistence: true,
      sandboxOutputUntrusted: true,
    })
  })

  it('stops the key proxy (inside the sandbox release) before cleanup saves anything', async () => {
    // #given a clean isolated run that owned a proxy
    const {runCleanup} = await import('./phases/cleanup.js')
    const {release} = await arrangeIsolated({stop: 'stopped', restore: 'restored', proxy: 'stopped'})

    // #when
    const exitCode = await run()

    // #then the release (which stops the proxy last) ran before cleanup, and persistence was not declined
    expect(exitCode).toBe(0)
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runCleanup).mock.invocationCallOrder[0] ?? 0)
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({skipSessionPersistence: false})
  })

  it('declines persistence when the exception path finds the key proxy died', async () => {
    // #given an exception mid-execution and a proxy that had already died
    const {runCleanup} = await import('./phases/cleanup.js')
    await arrangeIsolated({stop: 'stopped', restore: 'restored', proxy: 'crashed'}, {executeError: new Error('boom')})

    // #when
    await run()

    // #then
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({
      skipSessionPersistence: true,
      sandboxOutputUntrusted: false,
    })
  })

  describe('a start that fails after the sandbox was prepared', () => {
    it('reads and publishes no sandbox-writable log when the release after the failed start was unsafe', async () => {
      // #given the V2 start failed after the sandbox was prepared, and its release was not confirmed restored
      const {runCleanup} = await import('./phases/cleanup.js')
      const {release} = await arrangeFailedStart({
        stop: 'stopped',
        restore: 'unsafe',
        reason: 'ancestor /x is a symlink',
      })

      // #when
      const exitCode = await run()

      // #then the run failed, the same (memoized) release was consulted, and cleanup is told to touch neither log backend
      expect(exitCode).toBe(1)
      expect(release).toHaveBeenCalled()
      expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({
        skipSessionPersistence: true,
        sandboxOutputUntrusted: true,
      })
    })

    it('keeps the log backends open when the release after the failed start was confirmed restored', async () => {
      // #given the same failed start with a clean release
      const {runCleanup} = await import('./phases/cleanup.js')
      await arrangeFailedStart(RESTORED)

      // #when
      const exitCode = await run()

      // #then persistence is still declined (the start failed) but the logs are trusted
      expect(exitCode).toBe(1)
      expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({
        skipSessionPersistence: true,
        sandboxOutputUntrusted: false,
      })
    })
  })

  it('stops and restores the sandbox on an exception mid-execution, before cleanup saves anything', async () => {
    // #given execution that throws
    const {runCleanup} = await import('./phases/cleanup.js')
    const {release} = await arrangeIsolated(RESTORED, {executeError: new Error('boom')})

    // #when
    const exitCode = await run()

    // #then the finally path released the sandbox first, and cleanup ran after it
    expect(exitCode).toBe(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runCleanup).mock.invocationCallOrder[0] ?? 0)
  })

  it('declines persistence when the exception path cannot restore the sandbox', async () => {
    // #given an exception and a sandbox that cannot be restored
    const {runCleanup} = await import('./phases/cleanup.js')
    await arrangeIsolated(
      {stop: 'unconfirmed', restore: 'unsafe', reason: 'still running'},
      {executeError: new Error('boom')},
    )

    // #when
    await run()

    // #then
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({
      skipSessionPersistence: true,
      sandboxOutputUntrusted: true,
    })
  })

  it('touches no sandbox state when the run is not isolated', async () => {
    // #given a normal run
    const core = await import('@actions/core')
    await arrange()

    // #when
    await run()

    // #then the isolated marker is never written
    expect(vi.mocked(core.saveState).mock.calls.some(call => call[0] === 'isolated-run')).toBe(false)
  })
})
