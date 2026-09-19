import type {OwnershipLedger} from '@fro-bot/runtime'
import type {LeaseController} from './phases/acquire-lock.js'
import type {BootstrapPhaseResult} from './phases/bootstrap.js'
import type {CacheRestorePhaseResult} from './phases/cache-restore.js'
import type {RoutingPhaseResult} from './phases/routing.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createLogger} from '../shared/logger.js'
import {setActionOutputs} from './config/outputs.js'
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

vi.mock('./phases/dedup.js', () => ({
  runDedup: vi.fn(),
  saveDedupMarker: vi.fn(),
}))

vi.mock('./phases/acquire-lock.js', () => ({
  runAcquireLock: vi.fn(),
}))

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

vi.mock('./phases/review-reconciliation.js', () => ({
  runReviewReconciliation: vi.fn().mockResolvedValue(undefined),
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
      enableOmo: false,
      enableOmoSlim: false,
      opencodeVersion: '1.0.0',
      skipCache: false,
      omoVersion: '1.0.0',
      systematicVersion: '1.0.0',
      omoProviders: {
        claude: 'no',
        copilot: 'no',
        gemini: 'no',
        openai: 'no',
        opencodeZen: 'no',
        zaiCodingPlan: 'no',
        kimiForCoding: 'no',
      },
      omoSlimPreset: 'openai',
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

describe('run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const unavailableOutputModeMigration = {
    requested: 'omitted' as const,
    resolved: null,
  }

  function expectUnavailableOutputs(): void {
    expect(vi.mocked(setActionOutputs)).toHaveBeenCalledWith({
      sessionId: null,
      resolvedOutputMode: null,
      outputModeMigration: unavailableOutputModeMigration,
      deliveryKind: 'none',
      cacheStatus: 'miss',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      duration: expect.any(Number),
    })
    expect(vi.mocked(setActionOutputs)).toHaveBeenCalledTimes(1)
  }

  it('emits empty resolved-output-mode when bootstrap fails', async () => {
    const {runBootstrap} = await import('./phases/bootstrap.js')

    vi.mocked(runBootstrap).mockResolvedValue(null)

    const exitCode = await run()

    expect(exitCode).toBe(1)
    expect(vi.mocked(setActionOutputs)).toHaveBeenCalledWith({
      sessionId: null,
      resolvedOutputMode: null,
      outputModeMigration: unavailableOutputModeMigration,
      deliveryKind: 'none',
      cacheStatus: 'miss',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      duration: expect.any(Number),
    })
  })

  it('preserves the requested output-mode state when bootstrap fails before resolution', async () => {
    // #given an explicit output-mode input that is available before bootstrap completes
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {resolveRequestedOutputModeState} = await import('./phases/execute.js')

    vi.mocked(resolveRequestedOutputModeState).mockReturnValueOnce('explicit')
    vi.mocked(runBootstrap).mockResolvedValue(null)

    // #when bootstrap fails before an event-bound mode can be resolved
    const exitCode = await run()

    // #then the unavailable result preserves the request while keeping resolution null
    expect(exitCode).toBe(1)
    expect(vi.mocked(setActionOutputs)).toHaveBeenCalledWith(
      expect.objectContaining({
        outputModeMigration: {requested: 'explicit', resolved: null},
      }),
    )
  })

  it('emits empty resolved-output-mode when an unhandled error reaches the catch block', async () => {
    const {runBootstrap} = await import('./phases/bootstrap.js')

    vi.mocked(runBootstrap).mockRejectedValue(new Error('boom'))

    const exitCode = await run()

    expect(exitCode).toBe(1)
    expect(vi.mocked(setActionOutputs)).toHaveBeenCalledWith({
      sessionId: null,
      resolvedOutputMode: null,
      outputModeMigration: unavailableOutputModeMigration,
      deliveryKind: 'none',
      cacheStatus: 'miss',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      duration: expect.any(Number),
    })
  })

  it('emits the unavailable output contract when routing skips before execution', async () => {
    // #given bootstrap succeeds but routing intentionally declines the event
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {runRouting} = await import('./phases/routing.js')
    const {setInvocationOutcomeOutput} = await import('./config/outputs.js')
    const {saveDedupMarker} = await import('./phases/dedup.js')

    vi.mocked(runBootstrap).mockResolvedValue(createBootstrap())
    vi.mocked(runRouting).mockResolvedValue(null)

    // #when the run reaches the pre-execute routing skip
    const exitCode = await run()

    // #then the skip remains successful and publishes the stable empty contract
    expect(exitCode).toBe(0)
    expectUnavailableOutputs()
    // #and this invocation attempted no delivery, so it is reported as 'skipped' -- not the
    // 'succeeded' a stale exitCode===0 read would previously have produced, and not the
    // 'incomplete' that would force the exit code to 1 for every routine skip
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('skipped')
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
  })

  it('emits the unavailable output contract when dedup suppresses execution', async () => {
    // #given routing succeeds but the dedup sentinel suppresses this run
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {runRouting} = await import('./phases/routing.js')
    const {runDedup} = await import('./phases/dedup.js')
    const {runAcquireLock} = await import('./phases/acquire-lock.js')
    const {setInvocationOutcomeOutput} = await import('./config/outputs.js')
    const {saveDedupMarker} = await import('./phases/dedup.js')

    vi.mocked(runBootstrap).mockResolvedValue(createBootstrap())
    vi.mocked(runRouting).mockResolvedValue(createRouting())
    vi.mocked(runDedup).mockResolvedValue({shouldProceed: false, entity: null})

    // #when the run reaches the dedup skip
    const exitCode = await run()

    // #then the run exits successfully, publishes outputs, and does not acquire a lock
    expect(exitCode).toBe(0)
    expectUnavailableOutputs()
    expect(runAcquireLock).not.toHaveBeenCalled()
    // #and a deduplicated repeat is reported as 'skipped', not 'succeeded'
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('skipped')
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
  })

  it('emits the unavailable output contract when the coordination lock is held', async () => {
    // #given routing and dedup succeed but another surface holds the coordination lock --
    // dedup succeeding first means both dedupEntity and triggerContext are already
    // populated by the time the lock check short-circuits the run, so only the 'skipped'
    // outcome (not a stale 'succeeded') stops the dedup marker from being saved below
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {runRouting} = await import('./phases/routing.js')
    const {runDedup, saveDedupMarker} = await import('./phases/dedup.js')
    const {runAcquireLock} = await import('./phases/acquire-lock.js')
    const {setInvocationOutcomeOutput} = await import('./config/outputs.js')

    vi.mocked(runBootstrap).mockResolvedValue(createBootstrap())
    vi.mocked(runRouting).mockResolvedValue(createRouting())
    vi.mocked(runDedup).mockResolvedValue({shouldProceed: true, entity: {entityType: 'pr', entityNumber: 42}})
    vi.mocked(runAcquireLock).mockResolvedValue({outcome: 'held-by-other', holder: null})

    // #when the run reaches the coordination-lock skip
    const exitCode = await run()

    // #then the run exits successfully with outputs and does not acknowledge or execute
    expect(exitCode).toBe(0)
    expectUnavailableOutputs()
    const {runAcknowledge} = await import('./phases/acknowledge.js')
    const {runExecute} = await import('./phases/execute.js')
    expect(runAcknowledge).not.toHaveBeenCalled()
    expect(runExecute).not.toHaveBeenCalled()
    // #and a lock-contended run is reported as 'skipped', not 'succeeded' -- and, because a
    // contended run delivered nothing, it must not mark itself deduplicated even though a
    // dedup entity was already assigned before the lock check ran
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('skipped')
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
  })

  it('emits failed (not succeeded) when bootstrap fails, matching the returned exit code', async () => {
    // #given bootstrap fails -- an early `return 1` whose value `finally` cannot see or
    // change (return expressions evaluate before `finally` runs)
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {setInvocationOutcomeOutput} = await import('./config/outputs.js')
    const {saveDedupMarker} = await import('./phases/dedup.js')

    vi.mocked(runBootstrap).mockResolvedValue(null)

    // #when the run fails to bootstrap
    const exitCode = await run()

    // #then the run reports failed -- not the 'succeeded' the stale exitCode===0 read in
    // `finally` used to produce for this exact path
    expect(exitCode).toBe(1)
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('failed')
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
  })

  it('emits failed (not succeeded) when cache restore fails', async () => {
    // #given bootstrap, routing, dedup, and lock acquisition all succeed, but cache restore
    // fails -- another early `return 1` with the same finally-cannot-see-the-return shape
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {runRouting} = await import('./phases/routing.js')
    const {runDedup} = await import('./phases/dedup.js')
    const {runAcquireLock} = await import('./phases/acquire-lock.js')
    const {runAcknowledge} = await import('./phases/acknowledge.js')
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    const {setInvocationOutcomeOutput} = await import('./config/outputs.js')
    const {saveDedupMarker} = await import('./phases/dedup.js')

    vi.mocked(runBootstrap).mockResolvedValue(createBootstrap())
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
    vi.mocked(runCacheRestore).mockResolvedValue(null)

    // #when the run fails to restore cache
    const exitCode = await run()

    // #then the run reports failed -- not 'succeeded', and no dedup marker is written for a
    // run that never delivered anything
    expect(exitCode).toBe(1)
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('failed')
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
  })

  it('drains owned work after execution and strictly before review reconciliation, finalize (publish), and cleanup (prune/shutdown/persist/release)', async () => {
    // #given a full happy path through every phase up to and past execution, with an
    // acquired coordination lock so the lease renewal controller has a real identity to
    // trace into cleanup
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {runRouting} = await import('./phases/routing.js')
    const {runDedup} = await import('./phases/dedup.js')
    const {runAcquireLock} = await import('./phases/acquire-lock.js')
    const {runAcknowledge} = await import('./phases/acknowledge.js')
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    const {runSessionPrep} = await import('./phases/session-prep.js')
    const {runExecute, runDrain, computeDrainDeadlineMs} = await import('./phases/execute.js')
    const {runReviewReconciliation} = await import('./phases/review-reconciliation.js')
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {runCleanup} = await import('./phases/cleanup.js')

    const callOrder: string[] = []
    // Identity markers, not shapes: the wiring under test is "does the same instance reach
    // the next phase", which a same-shaped stand-in would not catch.
    const ledgerInstance = {} as OwnershipLedger
    const renewalController: LeaseController = {
      hasFailed: () => false,
      currentEtag: () => 'lock-etag-renewed',
      stop: vi.fn().mockResolvedValue(undefined),
    }
    // A deliberately arbitrary, non-round value: if `runDrain`'s deadline were ever pinned
    // to a hardcoded literal instead of derived from `computeDrainDeadlineMs`'s return, this
    // value would not appear and the assertion below would fail for the right reason.
    const derivedDeadlineMs = 741_213

    vi.mocked(runBootstrap).mockResolvedValue(createBootstrap())
    vi.mocked(runRouting).mockResolvedValue(createRouting())
    vi.mocked(runDedup).mockResolvedValue({shouldProceed: true, entity: null})
    vi.mocked(runAcquireLock).mockResolvedValue({
      outcome: 'acquired',
      lockEtag: 'lock-etag',
      renewal: renewalController,
    })
    vi.mocked(runAcknowledge).mockResolvedValue({
      repo: 'owner/repo',
      commentId: null,
      issueNumber: 42,
      issueType: 'pr',
      botLogin: 'fro-bot',
    })
    vi.mocked(runCacheRestore).mockImplementation(async () => {
      callOrder.push('cache-restore')
      return {
        cacheResult: {hit: false, key: 'cache-key', restoredPath: '', corrupted: false, source: 'cache'},
        cacheStatus: 'miss',
        serverHandle: {
          client: {} as CacheRestorePhaseResult['serverHandle']['client'],
          server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
          shutdown: vi.fn().mockResolvedValue({quiesced: true}),
        },
      }
    })
    vi.mocked(runSessionPrep).mockResolvedValue({
      recentSessions: [],
      priorWorkContext: [],
      attachmentResult: null,
      normalizedWorkspace: '/workspace',
      logicalKey: null,
      continueSessionId: null,
      isContinuation: false,
      sessionTitle: null,
    })
    vi.mocked(runExecute).mockImplementation(async () => {
      callOrder.push('execute')
      return {
        success: true,
        exitCode: 0,
        sessionId: 'ses_root',
        error: null,
        tokenUsage: null,
        model: null,
        cost: null,
        prsCreated: [],
        commitsCreated: [],
        commentsPosted: 0,
        llmError: null,
        resolvedOutputMode: 'branch-pr',
        outputModeMigration: {requested: 'omitted', resolved: 'branch-pr'},
        observationGap: false,
        recoveryBoundaryUnresolved: false,
        executionDurationMs: 10,
        ownershipLedger: ledgerInstance,
      }
    })
    vi.mocked(computeDrainDeadlineMs).mockReturnValue(derivedDeadlineMs)
    vi.mocked(runDrain).mockImplementation(async () => {
      callOrder.push('drain')
      return {expired: false, cancelledCount: 0, settledCount: 0, unknownCount: 0}
    })
    vi.mocked(runReviewReconciliation).mockImplementation(async () => {
      callOrder.push('review-reconciliation')
      return {reconciled: false, reason: 'not-applicable'}
    })
    vi.mocked(runFinalizeWithResult).mockImplementation(async () => {
      callOrder.push('finalize')
      return {exitCode: 0, deliveryKind: 'none'}
    })
    vi.mocked(runCleanup).mockImplementation(async () => {
      callOrder.push('cleanup')
      return {quiescenceConfirmed: true, continuityUnverified: false}
    })

    // #when the run executes end to end
    const exitCode = await run()

    // #then drain runs after execution and strictly before review reconciliation
    // (which can post a review), finalize (which publishes the response), and
    // cleanup (prune, shutdown, persist, lock release) -- matching cleanup.test.ts's
    // ordering-assertion style
    expect(exitCode).toBe(0)
    expect(callOrder).toEqual(['cache-restore', 'execute', 'drain', 'review-reconciliation', 'finalize', 'cleanup'])

    // #then drain receives the same ledger instance execution produced (identity, not shape)
    // and the parent session id from the execute result -- a regression that dropped either
    // wire would silently disable drain while this test's ordering assertion stayed green
    expect(vi.mocked(runDrain)).toHaveBeenCalledWith(
      expect.objectContaining({
        ledger: ledgerInstance,
        parentSessionId: 'ses_root',
      }),
    )

    // #then drain's deadline is derived through computeDrainDeadlineMs from the remaining
    // timeout budget, not a hardcoded value -- assert both that the deadline actually used
    // is the function's return value, and that the function was fed the run's real timeout
    // and execution-duration inputs
    expect(vi.mocked(computeDrainDeadlineMs)).toHaveBeenCalledWith(1_000, 10)
    expect(vi.mocked(runDrain)).toHaveBeenCalledWith(expect.objectContaining({deadlineMs: derivedDeadlineMs}))

    // #then cleanup receives the same ledger instance and the lease controller acquired
    // during the lock phase -- dropping either would silently disable persistence gating
    // or lease renewal while every other assertion in this run stayed green
    expect(vi.mocked(runCleanup)).toHaveBeenCalledWith(
      expect.objectContaining({
        ownershipLedger: ledgerInstance,
        leaseRenewal: renewalController,
      }),
    )
  })

  it('passes no lease to cleanup when no coordination lock was acquired', async () => {
    // #given the lock-free path: S3 coordination is disabled, so runAcquireLock never
    // produces a lease renewal controller
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {runRouting} = await import('./phases/routing.js')
    const {runDedup} = await import('./phases/dedup.js')
    const {runAcquireLock} = await import('./phases/acquire-lock.js')
    const {runAcknowledge} = await import('./phases/acknowledge.js')
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    const {runSessionPrep} = await import('./phases/session-prep.js')
    const {runExecute} = await import('./phases/execute.js')
    const {runCleanup} = await import('./phases/cleanup.js')

    vi.mocked(runBootstrap).mockResolvedValue(createBootstrap())
    vi.mocked(runRouting).mockResolvedValue(createRouting())
    vi.mocked(runDedup).mockResolvedValue({shouldProceed: true, entity: null})
    vi.mocked(runAcquireLock).mockResolvedValue({outcome: 's3-disabled'})
    vi.mocked(runAcknowledge).mockResolvedValue({
      repo: 'owner/repo',
      commentId: null,
      issueNumber: 42,
      issueType: 'pr',
      botLogin: 'fro-bot',
    })
    vi.mocked(runCacheRestore).mockResolvedValue({
      cacheResult: {hit: false, key: 'cache-key', restoredPath: '', corrupted: false, source: 'cache'},
      cacheStatus: 'miss',
      serverHandle: {
        client: {} as CacheRestorePhaseResult['serverHandle']['client'],
        server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
        shutdown: vi.fn().mockResolvedValue({quiesced: true}),
      },
    })
    vi.mocked(runSessionPrep).mockResolvedValue({
      recentSessions: [],
      priorWorkContext: [],
      attachmentResult: null,
      normalizedWorkspace: '/workspace',
      logicalKey: null,
      continueSessionId: null,
      isContinuation: false,
      sessionTitle: null,
    })
    vi.mocked(runExecute).mockResolvedValue({
      success: true,
      exitCode: 0,
      sessionId: 'ses_root',
      error: null,
      tokenUsage: null,
      model: null,
      cost: null,
      prsCreated: [],
      commitsCreated: [],
      commentsPosted: 0,
      llmError: null,
      resolvedOutputMode: 'branch-pr',
      outputModeMigration: {requested: 'omitted', resolved: 'branch-pr'},
      observationGap: false,
      recoveryBoundaryUnresolved: false,
      executionDurationMs: 10,
    })

    // #when the run executes end to end without ever acquiring a lock
    const exitCode = await run()

    // #then the run still completes successfully, and cleanup is told explicitly that
    // there is no lease to renew or release -- it must not fail for want of one it never held
    expect(exitCode).toBe(0)
    expect(vi.mocked(runCleanup)).toHaveBeenCalledWith(expect.objectContaining({leaseRenewal: null}))
  })
})

// Shared happy-path wiring for every phase up to and including drain -- each test below
// overrides only the specific fact under test (execution.observationGap, drain's
// unknownCount, finalize's exitCode, or cleanup's teardown safety evidence), so a test
// failing here fails for that one fact, not because the scaffolding drifted. Module-scoped
// (not nested in the describe below) since it closes over nothing test-local.
async function mockHappyPathThrough(overrides?: {
  readonly executionSuccess?: boolean
  readonly observationGap?: boolean
  readonly drainUnknownCount?: number
  readonly finalizeExitCode?: number
  readonly deliveryKind?: 'none' | 'comment' | 'review'
  readonly cleanupSafety?: {readonly quiescenceConfirmed: boolean; readonly continuityUnverified: boolean}
}): Promise<{
  readonly saveDedupMarker: typeof import('./phases/dedup.js').saveDedupMarker
  readonly applyTerminalReaction: typeof import('../features/agent/index.js').applyTerminalReaction
  readonly setInvocationOutcomeOutput: typeof import('./config/outputs.js').setInvocationOutcomeOutput
}> {
  const {runBootstrap} = await import('./phases/bootstrap.js')
  const {runRouting} = await import('./phases/routing.js')
  const {runDedup, saveDedupMarker} = await import('./phases/dedup.js')
  const {runAcquireLock} = await import('./phases/acquire-lock.js')
  const {runAcknowledge} = await import('./phases/acknowledge.js')
  const {runCacheRestore} = await import('./phases/cache-restore.js')
  const {runSessionPrep} = await import('./phases/session-prep.js')
  const {runExecute, runDrain} = await import('./phases/execute.js')
  const {runReviewReconciliation} = await import('./phases/review-reconciliation.js')
  const {runFinalizeWithResult} = await import('./phases/finalize.js')
  const {runCleanup} = await import('./phases/cleanup.js')
  const {applyTerminalReaction} = await import('../features/agent/index.js')
  const {setInvocationOutcomeOutput} = await import('./config/outputs.js')

  vi.mocked(runBootstrap).mockResolvedValue(createBootstrap())
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
  vi.mocked(runCacheRestore).mockResolvedValue({
    cacheResult: {hit: false, key: 'cache-key', restoredPath: '', corrupted: false, source: 'cache'},
    cacheStatus: 'miss',
    serverHandle: {
      client: {} as CacheRestorePhaseResult['serverHandle']['client'],
      server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
      shutdown: vi.fn().mockResolvedValue({quiesced: true}),
    },
  })
  vi.mocked(runSessionPrep).mockResolvedValue({
    recentSessions: [],
    priorWorkContext: [],
    attachmentResult: null,
    normalizedWorkspace: '/workspace',
    logicalKey: null,
    continueSessionId: null,
    isContinuation: false,
    sessionTitle: null,
  })
  vi.mocked(runExecute).mockResolvedValue({
    success: overrides?.executionSuccess ?? true,
    exitCode: overrides?.executionSuccess === false ? 1 : 0,
    sessionId: 'ses_root',
    error: overrides?.executionSuccess === false ? 'boom' : null,
    tokenUsage: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
    resolvedOutputMode: 'branch-pr',
    outputModeMigration: {requested: 'omitted', resolved: 'branch-pr'},
    observationGap: overrides?.observationGap ?? false,
    recoveryBoundaryUnresolved: false,
    executionDurationMs: 10,
    ownershipLedger: {} as OwnershipLedger,
  })
  const unknownCount = overrides?.drainUnknownCount ?? 0
  vi.mocked(runDrain).mockResolvedValue({
    expired: unknownCount > 0,
    cancelledCount: 0,
    settledCount: 0,
    unknownCount,
  })
  vi.mocked(runReviewReconciliation).mockResolvedValue({reconciled: false, reason: 'not-applicable'})
  vi.mocked(runFinalizeWithResult).mockResolvedValue({
    exitCode: overrides?.finalizeExitCode ?? (overrides?.executionSuccess === false ? 1 : 0),
    deliveryKind: overrides?.deliveryKind ?? 'comment',
  })
  vi.mocked(runCleanup).mockResolvedValue(
    overrides?.cleanupSafety ?? {quiescenceConfirmed: true, continuityUnverified: false},
  )

  return {saveDedupMarker, applyTerminalReaction, setInvocationOutcomeOutput}
}

describe('invocation outcome cross-product (src/harness/outcome.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('useful response + observation gap -> incomplete, no dedup marker, no success reaction', async () => {
    // #given a clean, successful delivery, but the execution recorded an observation gap
    const {saveDedupMarker, applyTerminalReaction, setInvocationOutcomeOutput} = await mockHappyPathThrough({
      observationGap: true,
    })

    // #when the run executes end to end
    const exitCode = await run()

    // #then exit code is forced non-zero, dedup is withheld, and the reaction reflects
    // incomplete -- not success, even though delivery itself succeeded
    expect(exitCode).toBe(1)
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
    expect(vi.mocked(applyTerminalReaction)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'incomplete',
      expect.anything(),
    )
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('incomplete')
  })

  it('useful response + unresolved ownership (drain unknownCount > 0) -> incomplete, no dedup, no success reaction', async () => {
    // #given a clean, successful delivery, but drain could not confirm all owned work
    const {saveDedupMarker, applyTerminalReaction, setInvocationOutcomeOutput} = await mockHappyPathThrough({
      drainUnknownCount: 2,
    })

    const exitCode = await run()

    expect(exitCode).toBe(1)
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
    expect(vi.mocked(applyTerminalReaction)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'incomplete',
      expect.anything(),
    )
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('incomplete')
  })

  it('useful response + unconfirmed server quiescence (learned only from cleanup) -> incomplete, no dedup', async () => {
    // #given every execution/drain fact clean, but cleanup could not confirm the OpenCode
    // server actually quiesced before the checkpoint -- learned only AFTER finalize published
    const {saveDedupMarker, setInvocationOutcomeOutput} = await mockHappyPathThrough({
      cleanupSafety: {quiescenceConfirmed: false, continuityUnverified: false},
    })

    const exitCode = await run()

    expect(exitCode).toBe(1)
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('incomplete')
  })

  it('useful response + unverified lease continuity (learned only from cleanup) -> incomplete, no dedup', async () => {
    // #given every execution/drain fact clean, but the coordination lease's continuity was
    // never verified for this invocation
    const {saveDedupMarker, setInvocationOutcomeOutput} = await mockHappyPathThrough({
      cleanupSafety: {quiescenceConfirmed: true, continuityUnverified: true},
    })

    const exitCode = await run()

    expect(exitCode).toBe(1)
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('incomplete')
  })

  it('incomplete + review already delivered -> dedup marker IS written, exit code and invocation-outcome still report incomplete', async () => {
    // #given an incomplete outcome (observation gap) whose finalize call already delivered a
    // review -- reviews have no marker-based find-and-update path the way comments do, so a
    // rerun invited by the non-zero exit would submit a second review rather than recognize
    // the first
    const {saveDedupMarker, applyTerminalReaction, setInvocationOutcomeOutput} = await mockHappyPathThrough({
      observationGap: true,
      deliveryKind: 'review',
    })

    // #when the run executes end to end
    const exitCode = await run()

    // #then the marker IS written -- the deliberate exception -- but the exit code and the
    // invocation-outcome/reaction still report 'incomplete', not a completion claim
    expect(exitCode).toBe(1)
    expect(vi.mocked(saveDedupMarker)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyTerminalReaction)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'incomplete',
      expect.anything(),
    )
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('incomplete')
  })

  it('incomplete + comment already delivered (not review) -> no dedup marker, complement of the review exception', async () => {
    // #given the same incomplete outcome, but finalize delivered only a comment -- comments
    // have a marker-based find-and-update path, so the review exception must not apply
    const {saveDedupMarker, setInvocationOutcomeOutput} = await mockHappyPathThrough({
      observationGap: true,
      deliveryKind: 'comment',
    })

    const exitCode = await run()

    expect(exitCode).toBe(1)
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('incomplete')
  })

  it('incomplete + nothing delivered -> no dedup marker, complement of the review exception', async () => {
    // #given the same incomplete outcome, but finalize delivered nothing at all
    const {saveDedupMarker, setInvocationOutcomeOutput} = await mockHappyPathThrough({
      observationGap: true,
      deliveryKind: 'none',
    })

    const exitCode = await run()

    expect(exitCode).toBe(1)
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('incomplete')
  })

  it('the same response with no uncertainty -> existing successful behavior, unchanged: dedup saved, success reaction, exit 0', async () => {
    // #given every verification fact clean and delivery succeeded -- the complement of every
    // incomplete case above
    const {saveDedupMarker, applyTerminalReaction, setInvocationOutcomeOutput} = await mockHappyPathThrough({})

    const exitCode = await run()

    expect(exitCode).toBe(0)
    expect(vi.mocked(saveDedupMarker)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyTerminalReaction)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'succeeded',
      expect.anything(),
    )
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('succeeded')
  })

  it('genuine failure + uncertainty -> failure preserved, incompleteness retained (still reports incomplete, not failed)', async () => {
    // #given execution failed AND verification is also incomplete
    const {saveDedupMarker, applyTerminalReaction, setInvocationOutcomeOutput} = await mockHappyPathThrough({
      executionSuccess: false,
      observationGap: true,
      finalizeExitCode: 1,
    })

    const exitCode = await run()

    // #then incomplete (the stricter axis) wins the reported outcome, exit stays non-zero
    // either way, no dedup, no success reaction
    expect(exitCode).toBe(1)
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
    expect(vi.mocked(applyTerminalReaction)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'incomplete',
      expect.anything(),
    )
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('incomplete')
  })

  it('genuine failure with no verification uncertainty -> failed (not incomplete), no dedup, no success reaction', async () => {
    // #given execution failed but every verification fact is clean -- the complement proving
    // incompleteness (not mere failure) is what selects 'incomplete' above
    const {saveDedupMarker, applyTerminalReaction, setInvocationOutcomeOutput} = await mockHappyPathThrough({
      executionSuccess: false,
      finalizeExitCode: 1,
    })

    const exitCode = await run()

    expect(exitCode).toBe(1)
    expect(vi.mocked(saveDedupMarker)).not.toHaveBeenCalled()
    expect(vi.mocked(applyTerminalReaction)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'failed',
      expect.anything(),
    )
    expect(vi.mocked(setInvocationOutcomeOutput)).toHaveBeenCalledWith('failed')
  })
})
