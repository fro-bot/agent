/**
 * The generation selector of `runExecute`: one choice, made once, that covers the main run AND the overflow-recovery
 * restart. The V1 side is pinned by `execute.test.ts` (unedited); this file pins that V1 stays off the V2 executor and
 * that a V2 run never reaches the V1 one.
 */
import type {OpenCodeV2ServerHandle, OwnershipLedger, SessionSearchResult} from '@fro-bot/runtime'
import type {AgentResult} from '../../features/agent/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult, CacheRestoreV2PhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import type {SessionPrepPhaseResult} from './session-prep.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {ARCHIVE_TIMEOUT_MS} from './execute-v2.js'
import {runExecute} from './execute.js'

const mocks = vi.hoisted(() => ({
  executeOpenCode: vi.fn(),
  executeOpenCodeV2: vi.fn(),
  archiveSession: vi.fn(),
  searchSessions: vi.fn(),
  writeSessionSummary: vi.fn(),
  findLatestSession: vi.fn(),
  updateSession: vi.fn(),
  addSyntheticMessage: vi.fn(),
  stopAndConfirmQuietV2: vi.fn(),
  getInput: vi.fn(),
  logger: {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()},
}))

vi.mock('@actions/core', () => ({
  getInput: mocks.getInput,
  saveState: vi.fn(),
  setOutput: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'})),
  rm: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@fro-bot/runtime', async importOriginal => {
  const original: typeof import('@fro-bot/runtime') = await importOriginal()
  return {
    ...original,
    archiveSession: mocks.archiveSession,
    findLatestSession: mocks.findLatestSession,
    searchSessions: mocks.searchSessions,
    writeSessionSummary: mocks.writeSessionSummary,
    resolveResponseDelivery: vi.fn(() => ({delivery: 'file-convention', credential: 'withhold'})),
  }
})
vi.mock('../../features/agent/index.js', () => ({
  executeOpenCode: mocks.executeOpenCode,
  resolveOutputMode: vi.fn(() => 'branch-pr'),
}))
vi.mock('../../features/agent/execution-v2.js', () => ({
  executeOpenCodeV2: mocks.executeOpenCodeV2,
  createActionClientV2: vi.fn(() => ({
    updateSession: mocks.updateSession,
    addSyntheticMessage: mocks.addSyntheticMessage,
  })),
}))
vi.mock('../../features/agent/drain-v2.js', () => ({stopAndConfirmQuietV2: mocks.stopAndConfirmQuietV2}))
vi.mock('../../shared/logger.js', () => ({createLogger: vi.fn(() => mocks.logger)}))

const OVERFLOW = {
  type: 'context_overflow',
  message: 'The model context window was exceeded.',
  retryable: false,
} as const

function agentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: false,
    exitCode: 1,
    duration: 1,
    sessionId: 'overflowed-session',
    error: 'context overflow',
    tokenUsage: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: OVERFLOW,
    observationGap: false,
    ...overrides,
  }
}

function bootstrap(): BootstrapPhaseResult {
  return {
    inputs: {
      githubToken: 't',
      authJson: '{}',
      trustedHeadSha: '',
      prompt: null,
      outputMode: 'branch-pr',
      sessionRetention: 50,
      storeConfig: {enabled: false, bucket: '', region: '', prefix: 'test'},
      agent: null,
      model: null,
      timeoutMs: 1_000,
      serverBootstrapTimeoutMs: 5000,
      opencodeVersion: '2.2.5',
      skipCache: false,
      systematicVersion: '1.0.0',
      opencodeConfig: null,
      systematicConfig: null,
      dedupWindow: 0,
      responseMode: 'github',
      reviewSkipLabel: null,
      brokeredPushExtraPaths: [],
    },
    logger: mocks.logger,
    opencodeResult: {path: 'opencode', version: '2.2.5', didSetup: false},
    delivery: 'model-gh',
    responseFilePath: null,
    responseFilePathCandidates: null,
    trustedHeadSha: '',
  } as unknown as BootstrapPhaseResult
}

function routing(): RoutingPhaseResult {
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
  } as unknown as RoutingPhaseResult
}

function sessionPrep(): SessionPrepPhaseResult {
  return {
    recentSessions: [],
    priorWorkContext: [],
    attachmentResult: null,
    normalizedWorkspace: '/workspace',
    logicalKey: {key: 'pr:42', entityType: 'pr', entityId: '42'},
    continueSessionId: 'overflowed-session',
    isContinuation: true,
    sessionTitle: 'Review pull request',
  }
}

function metrics(): MetricsCollector {
  return {
    start: vi.fn(),
    end: vi.fn(),
    setCacheStatus: vi.fn(),
    setCacheSource: vi.fn(),
    addSessionUsed: vi.fn(),
    addSessionCreated: vi.fn(),
    addPRCreated: vi.fn(),
    addCommitCreated: vi.fn(),
    incrementComments: vi.fn(),
    setTokenUsage: vi.fn(),
    recordError: vi.fn(),
    getMetrics: vi.fn(),
  }
}

function v1CacheRestore(): CacheRestorePhaseResult {
  return {
    cacheResult: {hit: true, key: 'k', restoredPath: '/c', corrupted: false, source: 'cache'},
    cacheStatus: 'hit',
    serverHandle: {
      client: {} as CacheRestorePhaseResult['serverHandle']['client'],
      server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
      shutdown: vi.fn().mockResolvedValue({quiesced: true}),
    },
  }
}

function v2CacheRestore(): CacheRestoreV2PhaseResult {
  return {
    generation: 'v2',
    cacheResult: {hit: true, key: 'k', restoredPath: '/c', corrupted: false, source: 'cache'},
    cacheStatus: 'hit',
    serverHandle: {
      url: 'http://127.0.0.1:4096',
      directory: '/workspace',
      fetch: vi.fn(),
      registerOwnedSession: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as OpenCodeV2ServerHandle,
  }
}

describe('runExecute generation selector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getInput.mockReturnValue('branch-pr')
    mocks.archiveSession.mockResolvedValue(true)
    mocks.searchSessions.mockResolvedValue([])
    mocks.updateSession.mockResolvedValue({success: true, data: undefined})
    mocks.addSyntheticMessage.mockResolvedValue({success: true, data: undefined})
    mocks.stopAndConfirmQuietV2.mockResolvedValue({quiet: true})
  })

  it('leaves a V1 run on the V1 executor and never touches the V2 one', async () => {
    // #given
    mocks.executeOpenCode.mockResolvedValue(agentResult({success: true, exitCode: 0, error: null, llmError: null}))

    // #when
    const result = await runExecute(bootstrap(), routing(), v1CacheRestore(), sessionPrep(), metrics(), 0)

    // #then
    expect(result.success).toBe(true)
    expect(mocks.executeOpenCode).toHaveBeenCalledTimes(1)
    expect(mocks.executeOpenCodeV2).not.toHaveBeenCalled()
    expect(mocks.writeSessionSummary).toHaveBeenCalledTimes(1)
    expect(mocks.addSyntheticMessage).not.toHaveBeenCalled()
  })

  it('runs a V2 run on the V2 executor with the invocation ledger and never touches the V1 one', async () => {
    // #given
    const cacheRestore = v2CacheRestore()
    mocks.executeOpenCodeV2.mockResolvedValue(
      agentResult({success: true, exitCode: 0, error: null, llmError: null, sessionId: 'ses_v2'}),
    )

    // #when
    const result = await runExecute(bootstrap(), routing(), cacheRestore, sessionPrep(), metrics(), 0)

    // #then
    expect(result).toMatchObject({success: true, sessionId: 'ses_v2'})
    expect(mocks.executeOpenCode).not.toHaveBeenCalled()
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledTimes(1)
    const call = mocks.executeOpenCodeV2.mock.calls[0]
    expect(call?.[3]).toBe(cacheRestore.serverHandle)
    expect(call?.[4]).toBe(result.ownershipLedger)
    // The summary is not written through the SDK client, and not yet through the V2 route either: a queued synthetic
    // message would keep the root's inbox non-empty, and the release waits for an empty one. It is held for the release.
    expect(mocks.writeSessionSummary).not.toHaveBeenCalled()
    expect(mocks.addSyntheticMessage).not.toHaveBeenCalled()
    expect(result.deferredSummary?.sessionId).toBe('ses_v2')
    expect(result.deferredSummary?.text).toContain('Fro Bot Run Summary')
  })

  it('routes the overflow-recovery restart through the V2 executor, archiving over the V2 route', async () => {
    // #given the first V2 attempt overflows and the restart succeeds
    mocks.executeOpenCodeV2
      .mockResolvedValueOnce(agentResult())
      .mockResolvedValueOnce(
        agentResult({success: true, exitCode: 0, error: null, llmError: null, sessionId: 'recovered'}),
      )
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValue(1_100)

    // #when
    let result: Awaited<ReturnType<typeof runExecute>>
    try {
      result = await runExecute(bootstrap(), routing(), v2CacheRestore(), sessionPrep(), metrics(), 0)
    } finally {
      nowSpy.mockRestore()
    }

    // #then both calls ran on V2, V1 ran nothing, and the overflowed session was archived by the V2 route
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledTimes(2)
    expect(mocks.executeOpenCode).not.toHaveBeenCalled()
    expect(mocks.archiveSession).not.toHaveBeenCalled()
    expect(mocks.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: 'overflowed-session', archived: true}),
    )
    const restartConfig = mocks.executeOpenCodeV2.mock.calls[1]?.[2] as {continueSessionId?: string} | undefined
    expect(restartConfig?.continueSessionId).toBeUndefined()
    expect(result).toMatchObject({
      success: true,
      sessionId: 'recovered',
      overflowRecovery: {recovered: true, archivedSessionId: 'overflowed-session', archiveSucceeded: true},
    })
    // The restart gets a fresh ledger, not the exhausted one.
    expect(mocks.executeOpenCodeV2.mock.calls[1]?.[4]).not.toBe(mocks.executeOpenCodeV2.mock.calls[0]?.[4])
  })

  it('carries the replacement run observation and summary across an overflow restart, and stops the overflowed one', async () => {
    // #given an overflowed run that kept an observation, and a replacement that keeps its own
    const overflowedStop = vi.fn(async () => ({}) as never)
    const replacementStop = vi.fn(async () => ({}) as never)
    const observation = (stop: typeof overflowedStop) => ({tracker: {} as never, snapshot: () => ({}) as never, stop})
    mocks.executeOpenCodeV2
      .mockResolvedValueOnce({...agentResult(), liveObservation: observation(overflowedStop)})
      .mockResolvedValueOnce({
        ...agentResult({success: true, exitCode: 0, error: null, llmError: null, sessionId: 'recovered'}),
        liveObservation: observation(replacementStop),
      })

    // #when
    const result = await runExecute(bootstrap(), routing(), v2CacheRestore(), sessionPrep(), metrics(), 0)

    // #then the overflowed observation ended at the restart; the result carries the replacement's, and the summary is
    // the replacement session's
    expect(overflowedStop).toHaveBeenCalledTimes(1)
    expect(replacementStop).not.toHaveBeenCalled()
    expect(result.liveObservation?.stop).toBe(replacementStop)
    expect(result.deferredSummary?.sessionId).toBe('recovered')
  })

  it('keeps the overflowed observation in the result when no restart happens, for the release to stop', async () => {
    // #given an overflow whose stop could not be confirmed
    const stop = vi.fn(async () => ({}) as never)
    mocks.stopAndConfirmQuietV2.mockResolvedValue({quiet: false, reason: 'the directory was active'})
    mocks.executeOpenCodeV2.mockResolvedValueOnce({
      ...agentResult(),
      liveObservation: {tracker: {} as never, snapshot: () => ({}) as never, stop},
    })

    // #when
    const result = await runExecute(bootstrap(), routing(), v2CacheRestore(), sessionPrep(), metrics(), 0)

    // #then it is neither stopped here nor dropped
    expect(stop).not.toHaveBeenCalled()
    expect(result.liveObservation?.stop).toBe(stop)
  })

  it('ends an archive request that never answers at its bound, and still restarts', async () => {
    // #given an archive call that ignores its signal and never settles
    vi.useFakeTimers()
    try {
      mocks.updateSession.mockImplementation(async () => new Promise<never>(() => undefined))
      mocks.executeOpenCodeV2
        .mockResolvedValueOnce(agentResult())
        .mockResolvedValueOnce(agentResult({success: true, exitCode: 0, error: null, llmError: null}))
      let result: Awaited<ReturnType<typeof runExecute>> | undefined

      // #when
      // No Action deadline, so the time the archive burns does not use up the restart's budget.
      const noDeadline = {...bootstrap(), inputs: {...bootstrap().inputs, timeoutMs: 0}}
      const running = runExecute(noDeadline, routing(), v2CacheRestore(), sessionPrep(), metrics(), 0).then(value => {
        result = value
      })
      await vi.advanceTimersByTimeAsync(ARCHIVE_TIMEOUT_MS - 1_000)
      expect(result).toBeUndefined()
      await vi.advanceTimersByTimeAsync(2_000)
      await running

      // #then the archive was given up on (fail-soft), the restart ran, and the signal told the request to stop
      expect(result?.overflowRecovery).toMatchObject({archiveSucceeded: false, recovered: true})
      expect(mocks.executeOpenCodeV2).toHaveBeenCalledTimes(2)
      const passed = mocks.updateSession.mock.calls[0]?.[0] as {signal?: AbortSignal} | undefined
      expect(passed?.signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('records a failed V2 archive and still restarts', async () => {
    // #given
    mocks.updateSession.mockResolvedValue({success: false, error: {kind: 'http', status: 500}})
    mocks.executeOpenCodeV2
      .mockResolvedValueOnce(agentResult())
      .mockResolvedValueOnce(agentResult({success: true, exitCode: 0, error: null, llmError: null}))

    // #when
    const result = await runExecute(bootstrap(), routing(), v2CacheRestore(), sessionPrep(), metrics(), 0)

    // #then
    expect(result.overflowRecovery).toMatchObject({archiveSucceeded: false})
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledTimes(2)
  })

  it('does not archive or restart when a child survives the stop, and reports the run incomplete', async () => {
    // #given an overflowed session whose child the stop could not bring down. A restart is not scripted: a second call
    // would resolve to undefined and fail the run loudly.
    mocks.stopAndConfirmQuietV2.mockResolvedValue({quiet: false, reason: 'the directory was active'})
    mocks.executeOpenCodeV2.mockImplementationOnce(
      async (_p: unknown, _l: unknown, _c: unknown, _h: unknown, ledger: OwnershipLedger) => {
        ledger.adopt('ses_child', 'child')
        return agentResult()
      },
    )

    // #when
    const result = await runExecute(bootstrap(), routing(), v2CacheRestore(), sessionPrep(), metrics(), 0)

    // #then nothing was archived and no replacement prompt went out
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledTimes(1)
    expect(mocks.updateSession).not.toHaveBeenCalledWith(expect.objectContaining({archived: true}))
    expect(mocks.searchSessions).not.toHaveBeenCalled()

    // #and the overflowed result stands, failed and unresolved, for the normal stop and decline path
    expect(result).toMatchObject({
      success: false,
      sessionId: 'overflowed-session',
      recoveryBoundaryUnresolved: true,
      llmError: {type: 'context_overflow'},
    })
    expect(result.overflowRecovery).toBeUndefined()
  })

  it('does not restart when the stop could not confirm the directory quiet, even with an empty ledger', async () => {
    // #given
    mocks.stopAndConfirmQuietV2.mockResolvedValue({quiet: false, reason: 'the directory was active'})
    mocks.executeOpenCodeV2.mockResolvedValueOnce(agentResult())

    // #when
    const result = await runExecute(bootstrap(), routing(), v2CacheRestore(), sessionPrep(), metrics(), 0)

    // #then an empty ledger does not make an unconfirmed stop look clean
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledTimes(1)
    expect(mocks.updateSession).not.toHaveBeenCalledWith(expect.objectContaining({archived: true}))
    expect(result.recoveryBoundaryUnresolved).toBe(true)
  })

  it('does not restart when the stop reads quiet but the ledger still holds a child', async () => {
    // #given the gate passed, but the child was never settled in the ledger
    mocks.executeOpenCodeV2.mockImplementationOnce(
      async (_p: unknown, _l: unknown, _c: unknown, _h: unknown, ledger: OwnershipLedger) => {
        ledger.adopt('ses_child', 'child')
        return agentResult()
      },
    )

    // #when
    const result = await runExecute(bootstrap(), routing(), v2CacheRestore(), sessionPrep(), metrics(), 0)

    // #then
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledTimes(1)
    expect(result.recoveryBoundaryUnresolved).toBe(true)
  })

  it('stops the overflowed session children and shells and waits for the directory before it archives', async () => {
    // #given an overflowed session that owns a child, and a stop that settles it
    const calls: string[] = []
    mocks.stopAndConfirmQuietV2.mockImplementation(
      async (context: {ledger: OwnershipLedger; rootSessionId: string}) => {
        calls.push('stop')
        context.ledger.settle('ses_child')
        return {quiet: true}
      },
    )
    mocks.updateSession.mockImplementation(async () => {
      calls.push('archive')
      return {success: true, data: undefined}
    })
    mocks.executeOpenCodeV2
      .mockImplementationOnce(async (_p: unknown, _l: unknown, _c: unknown, _h: unknown, ledger: OwnershipLedger) => {
        ledger.adopt('ses_child', 'child')
        return agentResult()
      })
      .mockResolvedValueOnce(agentResult({success: true, exitCode: 0, error: null, llmError: null}))

    // #when
    const result = await runExecute(bootstrap(), routing(), v2CacheRestore(), sessionPrep(), metrics(), 0)

    // #then the stop is aimed at the overflowed session's directory and comes first; nothing is left unresolved
    expect(calls.slice(0, 2)).toEqual(['stop', 'archive'])
    expect(mocks.stopAndConfirmQuietV2).toHaveBeenCalledWith(
      expect.objectContaining({directory: '/workspace', rootSessionId: 'overflowed-session'}),
    )
    expect(result.recoveryBoundaryUnresolved).toBe(false)
  })

  it('searches prior work for the V2 restart over the V2 session routes, excluding the overflowed session', async () => {
    // #given
    const fetchRoute = vi.fn(async (path: string) => {
      if (path.startsWith('/api/session?')) {
        return new Response(JSON.stringify({data: [], cursor: {}}), {status: 200})
      }
      return new Response('{}', {status: 404})
    })
    const cacheRestore = v2CacheRestore()
    const withFetch: CacheRestoreV2PhaseResult = {
      ...cacheRestore,
      serverHandle: {...cacheRestore.serverHandle, fetch: fetchRoute},
    }
    mocks.executeOpenCodeV2
      .mockResolvedValueOnce(agentResult())
      .mockResolvedValueOnce(agentResult({success: true, exitCode: 0, error: null, llmError: null}))
    const recoveryContext: readonly SessionSearchResult[] = []

    // #when
    const result = await runExecute(bootstrap(), routing(), withFetch, sessionPrep(), metrics(), 0)

    // #then the V1 search was never used, and the V2 listing went through the server's own route
    expect(mocks.searchSessions).not.toHaveBeenCalled()
    expect(fetchRoute).toHaveBeenCalledWith(expect.stringContaining('/api/session?'), expect.anything())
    expect(result.overflowRecovery?.recovered).toBe(true)
    expect(recoveryContext).toEqual([])
  })
})
