import type {OpenCodeV2ServerHandle, SessionSearchResult} from '@fro-bot/runtime'
import type {executeOpenCodeV2} from '../../features/agent/execution-v2.js'
import type {AgentResult} from '../../features/agent/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import type {SessionPrepPhaseResult} from './session-prep.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {computeDrainDeadlineMs, DEFAULT_DRAIN_TEARDOWN_RESERVE_MS, runExecute} from './execute.js'

const mocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
  stopAndConfirmQuietV2: vi.fn(),
  parseResponseFile: vi.fn(),
  readResponseFile: vi.fn(),
  executeOpenCodeV2: vi.fn<typeof executeOpenCodeV2>(),
  removeResponseFile: vi.fn(),
  resolveResponseDelivery: vi.fn(() => ({delivery: 'file-convention', credential: 'withhold'})),
  resolveOutputMode: vi.fn(),
  saveState: vi.fn(),
  getInput: vi.fn(),
  setOutput: vi.fn(),
  warning: vi.fn(),
  searchSessions: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@actions/core', () => ({
  getInput: mocks.getInput,
  saveState: mocks.saveState,
  setOutput: mocks.setOutput,
  warning: mocks.warning,
}))

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readResponseFile,
  rm: mocks.removeResponseFile,
}))

vi.mock('@fro-bot/runtime', async importOriginal => {
  const original: typeof import('@fro-bot/runtime') = await importOriginal()
  return {
    ...original,
    parseResponseFile: mocks.parseResponseFile,
    resolveResponseDelivery: mocks.resolveResponseDelivery,
  }
})

vi.mock('@fro-bot/runtime/session-v2', async importOriginal => {
  const original: typeof import('@fro-bot/runtime/session-v2') = await importOriginal()
  return {...original, searchSessionsV2: mocks.searchSessions}
})

vi.mock('../../features/agent/index.js', () => ({
  resolveOutputMode: mocks.resolveOutputMode,
}))

vi.mock('../../features/agent/execution-v2.js', () => ({
  executeOpenCodeV2: mocks.executeOpenCodeV2,
  createActionClientV2: vi.fn(() => ({updateSession: mocks.updateSession})),
}))

vi.mock('../../features/agent/drain-v2.js', () => ({stopAndConfirmQuietV2: mocks.stopAndConfirmQuietV2}))

vi.mock('../../shared/logger.js', () => ({createLogger: vi.fn(() => mocks.logger)}))

function createAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
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
    llmError: {
      type: 'context_overflow',
      message: 'The model context window was exceeded.',
      retryable: false,
    },
    observationGap: false,
    ...overrides,
  }
}

function createBootstrap(
  timeoutMs: number,
  overrides: Partial<Pick<BootstrapPhaseResult, 'delivery' | 'responseFilePath'>> = {},
): BootstrapPhaseResult {
  return {
    inputs: {
      githubToken: 'github-token',
      authJson: '{}',
      trustedHeadSha: '',
      prompt: null,
      outputMode: 'branch-pr',
      sessionRetention: 50,
      storeConfig: {enabled: false, bucket: '', region: '', prefix: 'test'},
      agent: null,
      model: null,
      timeoutMs,
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
    },
    logger: mocks.logger,
    opencodeResult: {path: 'opencode', version: '1.0.0'},
    delivery: overrides.delivery ?? 'model-gh',
    responseFilePath: overrides.responseFilePath ?? null,
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

function createSessionPrep(): SessionPrepPhaseResult {
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

function createCacheRestore(): CacheRestorePhaseResult {
  return {
    cacheResult: {hit: true, key: 'cache-key', restoredPath: '/cache', corrupted: false, source: 'cache'},
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

function createMetrics(): MetricsCollector {
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

describe('runExecute overflow recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.executeOpenCodeV2.mockReset()
    mocks.readResponseFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mocks.parseResponseFile.mockReset()
    mocks.resolveResponseDelivery.mockReturnValue({delivery: 'file-convention', credential: 'withhold'})
    mocks.resolveOutputMode.mockReturnValue('branch-pr')
    mocks.getInput.mockReturnValue('branch-pr')
    mocks.updateSession.mockResolvedValue({success: true, data: undefined})
    mocks.stopAndConfirmQuietV2.mockResolvedValue({quiet: true})
    mocks.removeResponseFile.mockResolvedValue(undefined)
    mocks.searchSessions.mockResolvedValue({success: true, data: []})
  })

  it('does not warn on legacy branch/PR language while resolving auto safely', async () => {
    // #given a manual auto request whose prompt contains former legacy delivery language
    vi.stubEnv('SKIP_AGENT_EXECUTION', 'true')
    mocks.getInput.mockReturnValue('auto')
    mocks.resolveOutputMode.mockReturnValue('working-dir')
    const baseBootstrap = createBootstrap(1_000)
    const bootstrap: BootstrapPhaseResult = {
      ...baseBootstrap,
      inputs: {...baseBootstrap.inputs, outputMode: 'auto', prompt: 'please create a pr'},
    }
    const baseRouting = createRouting()
    const routing: RoutingPhaseResult = {
      ...baseRouting,
      triggerResult: {
        ...baseRouting.triggerResult,
        context: {...baseRouting.triggerResult.context, eventType: 'workflow_dispatch', eventName: 'workflow_dispatch'},
      },
    }

    // #when the execute phase resolves the delivery contract
    const result = await runExecute(bootstrap, routing, createCacheRestore(), createSessionPrep(), createMetrics())

    // #then prompt wording has no effect and does not emit a migration warning
    expect(result.resolvedOutputMode).toBe('working-dir')
    expect(mocks.warning).not.toHaveBeenCalled()
    expect(result.outputModeMigration).toEqual({requested: 'auto', resolved: 'working-dir'})
    expect(mocks.setOutput).not.toHaveBeenCalled()
  })

  it.each([
    {input: '', configured: 'auto', resolved: 'working-dir', requested: 'omitted'},
    {input: 'auto', configured: 'auto', resolved: 'working-dir', requested: 'auto'},
    {input: 'branch-pr', configured: 'branch-pr', resolved: 'branch-pr', requested: 'explicit'},
  ] as const)(
    'emits the requested-state migration record for $requested',
    async ({input, configured, resolved, requested}) => {
      // #given a valid manual output-mode request in each public compatibility state
      vi.stubEnv('SKIP_AGENT_EXECUTION', 'true')
      mocks.getInput.mockReturnValue(input)
      mocks.resolveOutputMode.mockReturnValue(resolved)
      const baseBootstrap = createBootstrap(1_000)
      const bootstrap: BootstrapPhaseResult = {
        ...baseBootstrap,
        inputs: {...baseBootstrap.inputs, outputMode: configured},
      }
      const baseRouting = createRouting()
      const routing: RoutingPhaseResult = {
        ...baseRouting,
        triggerResult: {
          ...baseRouting.triggerResult,
          context: {
            ...baseRouting.triggerResult.context,
            eventType: 'workflow_dispatch',
            eventName: 'workflow_dispatch',
          },
        },
      }

      // #when the execute phase resolves and publishes the migration contract
      const result = await runExecute(bootstrap, routing, createCacheRestore(), createSessionPrep(), createMetrics())

      // #then the scalar result and structured output preserve the requested state
      expect(result.resolvedOutputMode).toBe(resolved)
      expect(result.outputModeMigration).toEqual({requested, resolved})
      expect(mocks.setOutput).not.toHaveBeenCalled()
    },
  )

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('archives the overflowed session and restarts once with fresh bounded context', async () => {
    // #given the first execution overflows without delivering a response
    const recoveryContext: readonly SessionSearchResult[] = [{sessionId: 'prior-session', matches: []}]
    const firstResult = createAgentResult()
    const recoveredResult = createAgentResult({
      success: true,
      exitCode: 0,
      error: null,
      sessionId: 'recovered-session',
      commentsPosted: 1,
      llmError: null,
    })
    mocks.searchSessions.mockResolvedValue({success: true, data: recoveryContext})
    mocks.executeOpenCodeV2.mockResolvedValueOnce(firstResult).mockResolvedValueOnce(recoveredResult)
    // the backend's creation reads the clock once before the execution start does
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100)
      .mockReturnValue(1_100)

    // #when the execute phase runs
    let result: Awaited<ReturnType<typeof runExecute>>
    try {
      result = await runExecute(
        createBootstrap(1_000),
        createRouting(),
        createCacheRestore(),
        createSessionPrep(),
        createMetrics(),
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then the overflowed session is archived and the fresh attempt receives bounded recovery state
    expect(mocks.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: 'overflowed-session', archived: true}),
    )
    expect(mocks.searchSessions).toHaveBeenCalledWith(
      'pr:42',
      expect.anything(),
      '/workspace',
      {limit: 5, excludeSessionIds: ['overflowed-session']},
      mocks.logger,
    )
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledTimes(2)

    const secondPrompt = mocks.executeOpenCodeV2.mock.calls[1]?.[0]
    const secondConfig = mocks.executeOpenCodeV2.mock.calls[1]?.[2]
    expect(secondPrompt?.sessionContext?.priorWorkContext).toEqual(recoveryContext)
    expect(secondPrompt?.currentThreadSessionId).toBeNull()
    expect(secondPrompt?.isContinuation).toBe(false)
    expect(secondConfig?.continueSessionId).toBeUndefined()
    expect(secondConfig?.timeoutMs).toBe(900)
    expect(result).toMatchObject({
      success: true,
      sessionId: 'recovered-session',
      commentsPosted: 1,
      overflowRecovery: {recovered: true, archivedSessionId: 'overflowed-session', archiveSucceeded: true},
    })
  })

  it('still recovers from an overflow when the timeout is 0, and keeps the recovery attempt unbounded', async () => {
    // #given the `timeout` input is 0 (no Action deadline) and the first execution overflows
    const recoveredResult = createAgentResult({
      success: true,
      exitCode: 0,
      error: null,
      sessionId: 'recovered-session',
      commentsPosted: 1,
      llmError: null,
    })
    mocks.executeOpenCodeV2.mockResolvedValueOnce(createAgentResult()).mockResolvedValueOnce(recoveredResult)
    // the backend's creation reads the clock once before the execution start does
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(5_000)
      .mockReturnValue(5_000)

    // #when the execute phase runs, with time having passed since it started
    let result: Awaited<ReturnType<typeof runExecute>>
    try {
      result = await runExecute(
        createBootstrap(0),
        createRouting(),
        createCacheRestore(),
        createSessionPrep(),
        createMetrics(),
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then recovery ran, and its execution config still means "no deadline" (0), not a finite remainder
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledTimes(2)
    expect(mocks.executeOpenCodeV2.mock.calls[1]?.[2]?.timeoutMs).toBe(0)
    expect(result).toMatchObject({
      success: true,
      sessionId: 'recovered-session',
      overflowRecovery: {recovered: true, archivedSessionId: 'overflowed-session', archiveSucceeded: true},
    })
  })

  it('archives the second overflow and does not start a third attempt', async () => {
    // #given both the original and fresh sessions overflow without delivering a response
    const secondOverflowResult = createAgentResult({sessionId: 'recovery-overflowed-session'})
    mocks.executeOpenCodeV2.mockResolvedValueOnce(createAgentResult()).mockResolvedValueOnce(secondOverflowResult)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValue(1_100)

    // #when the execute phase runs
    let result: Awaited<ReturnType<typeof runExecute>>
    try {
      result = await runExecute(
        createBootstrap(1_000),
        createRouting(),
        createCacheRestore(),
        createSessionPrep(),
        createMetrics(),
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then recovery is bounded to exactly one restart and both failed sessions are archived
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledTimes(2)
    expect(mocks.updateSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({sessionId: 'overflowed-session', archived: true}),
    )
    expect(mocks.updateSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({sessionId: 'recovery-overflowed-session', archived: true}),
    )
    expect(result).toMatchObject({
      success: false,
      sessionId: 'recovery-overflowed-session',
      overflowRecovery: {recovered: false, archivedSessionId: 'overflowed-session', archiveSucceeded: true},
    })
  })

  it('records a failed first archive and warns while continuing recovery', async () => {
    // #given the first archive fails but the fresh attempt succeeds
    const recoveredResult = createAgentResult({
      success: true,
      exitCode: 0,
      error: null,
      sessionId: 'recovered-session',
      llmError: null,
    })
    mocks.updateSession
      .mockResolvedValueOnce({success: false, error: {kind: 'server'}})
      .mockResolvedValueOnce({success: true, data: undefined})
    mocks.executeOpenCodeV2.mockResolvedValueOnce(createAgentResult()).mockResolvedValueOnce(recoveredResult)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValue(1_100)

    // #when the execute phase runs
    let result: Awaited<ReturnType<typeof runExecute>>
    try {
      result = await runExecute(
        createBootstrap(1_000),
        createRouting(),
        createCacheRestore(),
        createSessionPrep(),
        createMetrics(),
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then the failed archive is visible in metadata and the run still attempts recovery
    expect(mocks.logger.warning).toHaveBeenCalledWith(
      'Overflowed session archive failed; next run may re-continue it',
      {sessionId: 'overflowed-session'},
    )
    expect(result.overflowRecovery).toMatchObject({
      recovered: true,
      archivedSessionId: 'overflowed-session',
      archiveSucceeded: false,
    })
  })

  it('deletes a stale file-convention response before the fresh attempt', async () => {
    // #given the first attempt overflows after writing a response artifact
    const responseFilePath = '/tmp/fro-bot-response.md'
    const recoveredResult = createAgentResult({
      success: true,
      exitCode: 0,
      error: null,
      sessionId: 'recovered-session',
      llmError: null,
    })
    mocks.executeOpenCodeV2.mockResolvedValueOnce(createAgentResult()).mockResolvedValueOnce(recoveredResult)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValue(1_100)

    // #when the execute phase runs in file-convention delivery mode
    let result: Awaited<ReturnType<typeof runExecute>>
    try {
      result = await runExecute(
        createBootstrap(1_000, {delivery: 'file-convention', responseFilePath}),
        createRouting(),
        createCacheRestore(),
        createSessionPrep(),
        createMetrics(),
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then the stale artifact is removed before the recovery execution starts
    expect(mocks.removeResponseFile).toHaveBeenCalledWith(responseFilePath, {force: true})
    const removeCallOrder = mocks.removeResponseFile.mock.invocationCallOrder[0]
    const recoveryCallOrder = mocks.executeOpenCodeV2.mock.invocationCallOrder[1]
    expect(removeCallOrder).toBeLessThan(recoveryCallOrder ?? Number.POSITIVE_INFINITY)
    expect(result.sessionId).toBe('recovered-session')
  })

  it('continues recovery with empty prior-work context when the recovery search fails', async () => {
    // #given recovery prior-work search throws after the overflowed session is archived
    const searchError = new Error('session search unavailable')
    const recoveredResult = createAgentResult({
      success: true,
      exitCode: 0,
      error: null,
      sessionId: 'recovered-session',
      llmError: null,
    })
    mocks.searchSessions.mockRejectedValue(searchError)
    mocks.executeOpenCodeV2.mockResolvedValueOnce(createAgentResult()).mockResolvedValueOnce(recoveredResult)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValue(1_100)

    // #when the execute phase runs
    let result: Awaited<ReturnType<typeof runExecute>>
    try {
      result = await runExecute(
        createBootstrap(1_000),
        createRouting(),
        createCacheRestore(),
        createSessionPrep(),
        createMetrics(),
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then the fresh attempt still runs with no prior-work excerpts
    const recoveryPrompt = mocks.executeOpenCodeV2.mock.calls[1]?.[0]
    expect(recoveryPrompt?.sessionContext?.priorWorkContext).toEqual([])
    expect(mocks.logger.warning).toHaveBeenCalledWith(
      'Recovery prior-work search failed; proceeding with empty context',
      {error: searchError},
    )
    expect(result.sessionId).toBe('recovered-session')
  })

  it('keeps the original overflow failure when the shared deadline is exhausted', async () => {
    // #given the first attempt overflows and all remaining execution budget is consumed
    const firstResult = createAgentResult()
    mocks.executeOpenCodeV2.mockResolvedValueOnce(firstResult)
    // the backend's creation reads the clock once before the execution start does
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValue(2_000)

    // #when the execute phase runs with no remaining budget
    let result: Awaited<ReturnType<typeof runExecute>>
    try {
      result = await runExecute(
        createBootstrap(1_000),
        createRouting(),
        createCacheRestore(),
        createSessionPrep(),
        createMetrics(),
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then the first failure is returned and no fresh execution starts
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledOnce()
    expect(mocks.updateSession).toHaveBeenCalledOnce()
    expect(result).toMatchObject({success: false, sessionId: 'overflowed-session'})
    expect(result.overflowRecovery).toBeUndefined()
  })

  it('does not restart an overflow attempt when a response file is already present', async () => {
    // #given the overflowed attempt has no inferred artifacts but a response file is present
    const deliveredOverflowResult = createAgentResult({commentsPosted: 0})
    const recoveredResult = createAgentResult({
      success: true,
      exitCode: 0,
      error: null,
      sessionId: 'recovered-session',
      llmError: null,
    })
    mocks.executeOpenCodeV2.mockResolvedValueOnce(deliveredOverflowResult).mockResolvedValueOnce(recoveredResult)
    mocks.readResponseFile.mockResolvedValue('A valid response body')
    mocks.parseResponseFile.mockReturnValue({success: true, data: {body: 'A valid response body'}})

    // #when the execute phase runs
    const result = await runExecute(
      createBootstrap(1_000, {delivery: 'file-convention', responseFilePath: '/tmp/fro-bot-response.md'}),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
    )

    // #then no second delivery path is opened
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledOnce()
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.searchSessions).not.toHaveBeenCalled()
    expect(mocks.readResponseFile).toHaveBeenCalledOnce()
    expect(result.commentsPosted).toBe(0)
  })

  it('recovers when a response file exists but is not a valid deliverable', async () => {
    // #given the overflowed attempt left an empty response file
    const overflowResult = createAgentResult({commentsPosted: 0})
    const recoveredResult = createAgentResult({
      success: true,
      exitCode: 0,
      error: null,
      sessionId: 'recovered-session',
      llmError: null,
    })
    mocks.executeOpenCodeV2.mockResolvedValueOnce(overflowResult).mockResolvedValueOnce(recoveredResult)
    mocks.readResponseFile.mockResolvedValue('')
    mocks.parseResponseFile.mockReturnValue({
      success: false,
      error: {reason: 'empty', message: 'Response file is empty'},
    })

    // #when the execute phase runs
    const result = await runExecute(
      createBootstrap(1_000, {delivery: 'file-convention', responseFilePath: '/tmp/fro-bot-response.md'}),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
    )

    // #then recovery replaces the invalid artifact
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledTimes(2)
    expect(mocks.updateSession).toHaveBeenCalledOnce()
    expect(result.overflowRecovery?.recovered).toBe(true)
  })

  it('does not recover when response-file status is unknown', async () => {
    // #given response-file inspection fails with an error other than missing-file
    const overflowResult = createAgentResult({commentsPosted: 0})
    const recoveredResult = createAgentResult({
      success: true,
      exitCode: 0,
      error: null,
      sessionId: 'recovered-session',
      llmError: null,
    })
    mocks.executeOpenCodeV2.mockResolvedValueOnce(overflowResult).mockResolvedValueOnce(recoveredResult)
    mocks.readResponseFile.mockRejectedValue(Object.assign(new Error('permission denied'), {code: 'EACCES'}))

    // #when the execute phase runs
    const result = await runExecute(
      createBootstrap(1_000, {delivery: 'file-convention', responseFilePath: '/tmp/fro-bot-response.md'}),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
    )

    // #then unknown delivery status conservatively suppresses recovery
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledOnce()
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.searchSessions).not.toHaveBeenCalled()
    expect(result.overflowRecovery).toBeUndefined()
  })

  it('does not recover a credential-provisioned overflow without a response file', async () => {
    // #given the overflowed attempt has no inferred artifacts and no response file
    const overflowResult = createAgentResult({commentsPosted: 0})
    const recoveredResult = createAgentResult({
      success: true,
      exitCode: 0,
      error: null,
      sessionId: 'recovered-session',
      llmError: null,
    })
    mocks.executeOpenCodeV2.mockResolvedValueOnce(overflowResult).mockResolvedValueOnce(recoveredResult)
    mocks.resolveResponseDelivery.mockReturnValue({delivery: 'file-convention', credential: 'provision'})

    // #when the execute phase runs
    const result = await runExecute(
      createBootstrap(1_000, {delivery: 'file-convention', responseFilePath: '/tmp/fro-bot-response.md'}),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
    )

    // #then credential provisioning prevents a fresh recovery attempt
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledOnce()
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.searchSessions).not.toHaveBeenCalled()
    expect(mocks.resolveResponseDelivery).toHaveBeenCalledOnce()
    expect(result.commentsPosted).toBe(0)
  })

  it('does not recover non-context-overflow terminal errors', async () => {
    // #given the first attempt returns an unrelated terminal LLM error
    const nonOverflowResult = createAgentResult({
      llmError: {type: 'quota_exceeded', message: 'quota exceeded', retryable: true},
    })
    mocks.executeOpenCodeV2.mockResolvedValueOnce(nonOverflowResult)

    // #when the execute phase runs
    const result = await runExecute(
      createBootstrap(1_000),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
    )

    // #then existing terminal behavior remains a single execution attempt
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledOnce()
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.searchSessions).not.toHaveBeenCalled()
    expect(result.llmError?.type).toBe('quota_exceeded')
  })

  it('records the suggested action of an LLM error into the run metrics', async () => {
    // #given the attempt fails with a classified error that carries a suggested action
    mocks.executeOpenCodeV2.mockResolvedValueOnce(
      createAgentResult({
        llmError: {
          type: 'model_not_found',
          message: 'Model not found: a/b.',
          retryable: false,
          suggestedAction: 'Fix the model id',
        },
        classificationPath: 'fallback',
      }),
    )
    const metrics = createMetrics()

    // #when the execute phase runs
    await runExecute(createBootstrap(1_000), createRouting(), createCacheRestore(), createSessionPrep(), metrics)

    // #then the metric carries the action alongside the message
    expect(metrics.recordError).toHaveBeenCalledWith(
      'model_not_found',
      'Model not found: a/b.',
      false,
      'fallback',
      'Fix the model id',
    )
  })

  it('leaves a successful first attempt unchanged', async () => {
    // #given the first attempt completes successfully
    const successfulResult = createAgentResult({
      success: true,
      exitCode: 0,
      error: null,
      llmError: null,
      sessionId: 'successful-session',
    })
    mocks.executeOpenCodeV2.mockResolvedValueOnce(successfulResult)

    // #when the execute phase runs
    const result = await runExecute(
      createBootstrap(1_000),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
    )

    // #then the recovery path remains untouched
    expect(mocks.executeOpenCodeV2).toHaveBeenCalledOnce()
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.searchSessions).not.toHaveBeenCalled()
    expect(result).toMatchObject({success: true, sessionId: 'successful-session', llmError: null})
    expect(result.overflowRecovery).toBeUndefined()
  })
})

describe('computeDrainDeadlineMs', () => {
  it('reserves 30 seconds for teardown by default', () => {
    // #given the invocation's total timeout and how long execution already took
    // #when the remaining drain budget is computed with the default reserve
    const deadlineMs = computeDrainDeadlineMs(120_000, 10_000)

    // #then the reserve is subtracted alongside the elapsed execution time
    expect(DEFAULT_DRAIN_TEARDOWN_RESERVE_MS).toBe(30_000)
    expect(deadlineMs).toBe(120_000 - 30_000 - 10_000)
  })

  it('never returns a negative budget', () => {
    // #given execution and the reserve already exceed the total timeout
    // #when the remaining drain budget is computed
    const deadlineMs = computeDrainDeadlineMs(1_000, 900)

    // #then the budget floors at zero rather than going negative
    expect(deadlineMs).toBe(0)
  })

  it('sets no deadline when the total timeout is 0, whatever execution or the reserve already spent', () => {
    // #given the `timeout` input is 0, which means no Action-internal deadline
    // #when the remaining drain budget is computed, with and without a reserve override
    const withDefaultReserve = computeDrainDeadlineMs(0, 5_000)
    const withOverriddenReserve = computeDrainDeadlineMs(0, 0, 10_000)

    // #then drain has no deadline, the same convention `createExecutionDeadline().remainingMs()` uses
    expect(withDefaultReserve).toBe(Number.POSITIVE_INFINITY)
    expect(withOverriddenReserve).toBe(Number.POSITIVE_INFINITY)
  })

  it('accepts an overridden teardown reserve', () => {
    // #given a caller-supplied reserve, distinct from the default
    // #when the remaining drain budget is computed
    const deadlineMs = computeDrainDeadlineMs(100_000, 5_000, 10_000)

    // #then the override is used instead of the default 30 seconds
    expect(deadlineMs).toBe(100_000 - 10_000 - 5_000)
  })
})

function createEligibleInputs(overrides: {readonly isFork?: boolean} = {}): {
  bootstrap: BootstrapPhaseResult
  routing: RoutingPhaseResult
} {
  const bootstrap: BootstrapPhaseResult = {
    ...createBootstrap(1_000, {delivery: 'file-convention', responseFilePath: '/tmp/fro-bot-response.md'}),
    trustedHeadSha: 'a'.repeat(40),
  }
  const baseRouting = createRouting()
  const routing: RoutingPhaseResult = {
    ...baseRouting,
    triggerResult: {
      ...baseRouting.triggerResult,
      context: {
        ...baseRouting.triggerResult.context,
        eventType: 'issue_comment',
        eventName: 'issue_comment',
        author: {login: 'maintainer', association: 'COLLABORATOR', isBot: false},
      },
    },
    agentContext: {
      ...baseRouting.agentContext,
      eventName: 'issue_comment',
      issueType: 'pr',
      hydratedContext: {
        type: 'pull_request',
        headBranch: 'feature/brokered-fix',
        isFork: overrides.isFork ?? false,
      } as RoutingPhaseResult['agentContext']['hydratedContext'],
    },
  }
  return {bootstrap, routing}
}

async function runAndGetPromptOptions(
  inputs: ReturnType<typeof createEligibleInputs>,
  plan?: Parameters<typeof runExecute>[5],
) {
  mocks.executeOpenCodeV2.mockResolvedValueOnce(
    createAgentResult({success: true, exitCode: 0, error: null, llmError: null, sessionId: 'session-1'}),
  )
  await runExecute(inputs.bootstrap, inputs.routing, createCacheRestore(), createSessionPrep(), createMetrics(), plan)
  return mocks.executeOpenCodeV2.mock.calls[0]?.[0]
}

describe('runExecute brokered push prompt flag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.executeOpenCodeV2.mockReset()
    mocks.resolveResponseDelivery.mockReturnValue({delivery: 'file-convention', credential: 'withhold'})
    mocks.resolveOutputMode.mockReturnValue('branch-pr')
    mocks.getInput.mockReturnValue('branch-pr')
    mocks.searchSessions.mockResolvedValue({success: true, data: []})
  })

  it('tells the prompt builder brokered push will run for an eligible same-repo PR mention', async () => {
    // #given / #when
    const promptOptions = await runAndGetPromptOptions(createEligibleInputs())

    // #then
    expect(promptOptions?.brokeredPushActive).toBe(true)
  })

  it('does not set the flag for a fork PR', async () => {
    // #given / #when
    const promptOptions = await runAndGetPromptOptions(createEligibleInputs({isFork: true}))

    // #then
    expect(promptOptions?.brokeredPushActive).toBe(false)
  })

  it('does not set the flag when the run is not file-convention delivery', async () => {
    // #given an otherwise-eligible mention under model-gh delivery
    const inputs = createEligibleInputs()
    const bootstrap = {...inputs.bootstrap, delivery: 'model-gh' as const, responseFilePath: null}

    // #when
    const promptOptions = await runAndGetPromptOptions({...inputs, bootstrap})

    // #then
    expect(promptOptions?.brokeredPushActive).toBe(false)
  })

  it('uses the threaded plan instead of recomputing it', async () => {
    // #given an eligible mention but a plan resolved once upstream as ineligible
    const promptOptions = await runAndGetPromptOptions(createEligibleInputs(), {
      eligible: false,
      reason: 'decided upstream',
    })

    // #then the prompt follows the single upstream decision
    expect(promptOptions?.brokeredPushActive).toBe(false)
  })
})
