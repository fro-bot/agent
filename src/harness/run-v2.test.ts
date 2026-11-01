import type {OpenCodeV2ServerHandle, OwnershipLedger} from '@fro-bot/runtime'
import type {BootstrapPhaseResult} from './phases/bootstrap.js'
import type {CacheRestoreV2PhaseResult} from './phases/cache-restore.js'
import type {RoutingPhaseResult} from './phases/routing.js'
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
  runDrain: vi.fn().mockResolvedValue({expired: false, cancelledCount: 0, settledCount: 0, unknownCount: 0}),
  runExecute: vi.fn(),
  resolveRequestedOutputModeState: vi.fn(() => 'omitted'),
}))

vi.mock('./phases/finalize.js', () => ({
  runFinalize: vi.fn(),
  runFinalizeWithResult: vi.fn().mockResolvedValue({exitCode: 0, deliveryKind: 'none'}),
}))

vi.mock('./phases/release-v2.js', () => ({
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
    },
    logger: createLogger({phase: 'test'}),
    opencodeResult: {path: 'opencode', version: '1.0.0', didSetup: false},
    delivery: 'model-gh',
    responseFilePath: null,
    responseFilePathCandidates: null,
    trustedHeadSha: '',
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
  const cacheRestore: CacheRestoreV2PhaseResult = {
    generation: 'v2',
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

  it('runs execution on the V2 handle, releases it through the V2 drain instead of the V1 client, and cleans up', async () => {
    // #given a V2 cache-restore result whose handle has no SDK client
    const {runExecute, runDrain} = await import('./phases/execute.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    const {cacheRestore, v2Handle, ledger} = await arrange()

    // #when
    await run()

    // #then the V1 drain (which needs the SDK client) is not called; the V2 release is, for a succeeded run, with the
    // ledger, the root session and the retention the run was configured with
    expect(vi.mocked(runDrain)).not.toHaveBeenCalled()
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

    // #and cleanup is handed the V2 server in its own field, and no V1 handle
    const cleanupOptions = vi.mocked(runCleanup).mock.calls[0]?.[0]
    expect(cleanupOptions?.serverHandleV2).toBe(v2Handle)
    expect(cleanupOptions?.serverHandle).toBeNull()
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

  it('hands the execute phase observation and summary to the release, explicitly', async () => {
    // #given an execute result that carries both
    const {runReleaseV2} = await import('./phases/release-v2.js')
    const liveObservation = {tracker: {}, snapshot: vi.fn(), stop: vi.fn()} as never
    const deferredSummary = {sessionId: 'ses_v2', summary: {} as never}
    await arrange({extras: {liveObservation, deferredSummary}})

    // #when
    await run()

    // #then the release receives exactly those values
    const options = vi.mocked(runReleaseV2).mock.calls[0]?.[0]
    expect(options?.liveObservation).toBe(liveObservation)
    expect(options?.deferredSummary).toBe(deferredSummary)
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
