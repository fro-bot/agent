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

describe('run on an OpenCode V2 server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs execution on the V2 handle, does not drain it through the V1 client, and cleans up the V2 server', async () => {
    // #given a V2 cache-restore result whose handle has no SDK client, and execution that left a child unresolved
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {runRouting} = await import('./phases/routing.js')
    const {runDedup} = await import('./phases/dedup.js')
    const {runAcquireLock} = await import('./phases/acquire-lock.js')
    const {runAcknowledge} = await import('./phases/acknowledge.js')
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    const {runSessionPrep} = await import('./phases/session-prep.js')
    const {runExecute, runDrain} = await import('./phases/execute.js')
    const {runReviewReconciliation} = await import('./phases/review-reconciliation.js')
    const {runFinalizeWithResult} = await import('./phases/finalize.js')
    const {runCleanup} = await import('./phases/cleanup.js')

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
    const outstanding = {outstanding: () => 1, unknown: () => 2} as unknown as OwnershipLedger
    vi.mocked(runExecute).mockResolvedValue({
      success: true,
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
      ownershipLedger: outstanding,
    })
    vi.mocked(runReviewReconciliation).mockResolvedValue({reconciled: false, reason: 'not-applicable'})
    vi.mocked(runFinalizeWithResult).mockResolvedValue({exitCode: 0, deliveryKind: 'none'})
    vi.mocked(runCleanup).mockResolvedValue({quiescenceConfirmed: true, continuityUnverified: false})

    // #when
    await run()

    // #then the V1 drain (which needs the SDK client) is not called, and the ledger it would have drained is reported
    // unresolved to the outcome assessment through the finalize options
    expect(vi.mocked(runDrain)).not.toHaveBeenCalled()
    expect(vi.mocked(runExecute).mock.calls[0]?.[2]).toBe(cacheRestore)

    // #and cleanup is handed the V2 server in its own field, and no V1 handle
    const cleanupOptions = vi.mocked(runCleanup).mock.calls[0]?.[0]
    expect(cleanupOptions?.serverHandleV2).toBe(v2Handle)
    expect(cleanupOptions?.serverHandle).toBeNull()
  })
})
