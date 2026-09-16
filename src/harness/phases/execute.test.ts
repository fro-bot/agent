import type {SessionClient, SessionSearchResult} from '@fro-bot/runtime'
import type {AgentResult} from '../../features/agent/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {Logger} from '../../shared/logger.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import type {SessionPrepPhaseResult} from './session-prep.js'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {executeOpenCode} from '../../features/agent/index.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {computeDrainDeadlineMs, DEFAULT_DRAIN_TEARDOWN_RESERVE_MS, runDrain, runExecute} from './execute.js'

const mocks = vi.hoisted(() => ({
  archiveSession: vi.fn(),
  parseResponseFile: vi.fn(),
  readResponseFile: vi.fn(),
  executeOpenCode: vi.fn(),
  findLatestSession: vi.fn(),
  removeResponseFile: vi.fn(),
  resolveResponseDelivery: vi.fn(() => ({delivery: 'file-convention', credential: 'withhold'})),
  resolveOutputMode: vi.fn(),
  saveState: vi.fn(),
  getInput: vi.fn(),
  setOutput: vi.fn(),
  warning: vi.fn(),
  searchSessions: vi.fn(),
  writeSessionSummary: vi.fn(),
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
    archiveSession: mocks.archiveSession,
    findLatestSession: mocks.findLatestSession,
    parseResponseFile: mocks.parseResponseFile,
    resolveResponseDelivery: mocks.resolveResponseDelivery,
    searchSessions: mocks.searchSessions,
    writeSessionSummary: mocks.writeSessionSummary,
  }
})

vi.mock('../../features/agent/index.js', () => ({
  executeOpenCode: mocks.executeOpenCode,
  resolveOutputMode: mocks.resolveOutputMode,
}))

vi.mock('../../shared/logger.js', () => ({createLogger: vi.fn(() => mocks.logger)}))

const disabledProviders = {
  claude: 'no',
  copilot: 'no',
  gemini: 'no',
  openai: 'no',
  opencodeZen: 'no',
  zaiCodingPlan: 'no',
  kimiForCoding: 'no',
} as const

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
      enableOmo: false,
      enableOmoSlim: false,
      opencodeVersion: '1.0.0',
      skipCache: false,
      omoVersion: '1.0.0',
      systematicVersion: '1.0.0',
      omoProviders: disabledProviders,
      omoSlimPreset: 'openai',
      opencodeConfig: null,
      systematicConfig: null,
      dedupWindow: 0,
      responseMode: 'github',
      reviewSkipLabel: null,
      brokeredPushExtraPaths: [],
    },
    logger: mocks.logger,
    opencodeResult: {path: 'opencode', version: '1.0.0', didSetup: false},
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
      client: {} as CacheRestorePhaseResult['serverHandle']['client'],
      server: {url: 'http://127.0.0.1:4096', close: vi.fn()},
      shutdown: vi.fn().mockResolvedValue({quiesced: true}),
    },
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
    vi.mocked(executeOpenCode).mockReset()
    mocks.readResponseFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mocks.parseResponseFile.mockReset()
    mocks.resolveResponseDelivery.mockReturnValue({delivery: 'file-convention', credential: 'withhold'})
    mocks.resolveOutputMode.mockReturnValue('branch-pr')
    mocks.getInput.mockReturnValue('branch-pr')
    mocks.archiveSession.mockResolvedValue(true)
    mocks.removeResponseFile.mockResolvedValue(undefined)
    mocks.searchSessions.mockResolvedValue([])
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
    const result = await runExecute(bootstrap, routing, createCacheRestore(), createSessionPrep(), createMetrics(), 0)

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
      const result = await runExecute(bootstrap, routing, createCacheRestore(), createSessionPrep(), createMetrics(), 0)

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
    mocks.searchSessions.mockResolvedValue(recoveryContext)
    vi.mocked(executeOpenCode).mockResolvedValueOnce(firstResult).mockResolvedValueOnce(recoveredResult)
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
        0,
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then the overflowed session is archived and the fresh attempt receives bounded recovery state
    expect(mocks.archiveSession).toHaveBeenCalledWith('http://127.0.0.1:4096', 'overflowed-session', mocks.logger)
    expect(mocks.searchSessions).toHaveBeenCalledWith(
      'pr:42',
      expect.anything(),
      '/workspace',
      {limit: 5, excludeSessionIds: ['overflowed-session']},
      mocks.logger,
    )
    expect(vi.mocked(executeOpenCode)).toHaveBeenCalledTimes(2)

    const secondPrompt = vi.mocked(executeOpenCode).mock.calls[1]?.[0]
    const secondConfig = vi.mocked(executeOpenCode).mock.calls[1]?.[2]
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

  it('archives the second overflow and does not start a third attempt', async () => {
    // #given both the original and fresh sessions overflow without delivering a response
    const secondOverflowResult = createAgentResult({sessionId: 'recovery-overflowed-session'})
    vi.mocked(executeOpenCode).mockResolvedValueOnce(createAgentResult()).mockResolvedValueOnce(secondOverflowResult)
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
        0,
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then recovery is bounded to exactly one restart and both failed sessions are archived
    expect(vi.mocked(executeOpenCode)).toHaveBeenCalledTimes(2)
    expect(mocks.archiveSession).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4096', 'overflowed-session', mocks.logger)
    expect(mocks.archiveSession).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4096',
      'recovery-overflowed-session',
      mocks.logger,
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
    mocks.archiveSession.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    vi.mocked(executeOpenCode).mockResolvedValueOnce(createAgentResult()).mockResolvedValueOnce(recoveredResult)
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
        0,
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
    vi.mocked(executeOpenCode).mockResolvedValueOnce(createAgentResult()).mockResolvedValueOnce(recoveredResult)
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
        0,
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then the stale artifact is removed before the recovery execution starts
    expect(mocks.removeResponseFile).toHaveBeenCalledWith(responseFilePath, {force: true})
    const removeCallOrder = mocks.removeResponseFile.mock.invocationCallOrder[0]
    const recoveryCallOrder = vi.mocked(executeOpenCode).mock.invocationCallOrder[1]
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
    vi.mocked(executeOpenCode).mockResolvedValueOnce(createAgentResult()).mockResolvedValueOnce(recoveredResult)
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
        0,
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then the fresh attempt still runs with no prior-work excerpts
    const recoveryPrompt = vi.mocked(executeOpenCode).mock.calls[1]?.[0]
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
    vi.mocked(executeOpenCode).mockResolvedValueOnce(firstResult)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_000).mockReturnValue(2_000)

    // #when the execute phase runs with no remaining budget
    let result: Awaited<ReturnType<typeof runExecute>>
    try {
      result = await runExecute(
        createBootstrap(1_000),
        createRouting(),
        createCacheRestore(),
        createSessionPrep(),
        createMetrics(),
        0,
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then the first failure is returned and no fresh execution starts
    expect(vi.mocked(executeOpenCode)).toHaveBeenCalledOnce()
    expect(mocks.archiveSession).toHaveBeenCalledOnce()
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
    vi.mocked(executeOpenCode).mockResolvedValueOnce(deliveredOverflowResult).mockResolvedValueOnce(recoveredResult)
    mocks.readResponseFile.mockResolvedValue('A valid response body')
    mocks.parseResponseFile.mockReturnValue({success: true, data: {body: 'A valid response body'}})

    // #when the execute phase runs
    const result = await runExecute(
      createBootstrap(1_000, {delivery: 'file-convention', responseFilePath: '/tmp/fro-bot-response.md'}),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
      0,
    )

    // #then no second delivery path is opened
    expect(vi.mocked(executeOpenCode)).toHaveBeenCalledOnce()
    expect(mocks.archiveSession).not.toHaveBeenCalled()
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
    vi.mocked(executeOpenCode).mockResolvedValueOnce(overflowResult).mockResolvedValueOnce(recoveredResult)
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
      0,
    )

    // #then recovery replaces the invalid artifact
    expect(vi.mocked(executeOpenCode)).toHaveBeenCalledTimes(2)
    expect(mocks.archiveSession).toHaveBeenCalledOnce()
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
    vi.mocked(executeOpenCode).mockResolvedValueOnce(overflowResult).mockResolvedValueOnce(recoveredResult)
    mocks.readResponseFile.mockRejectedValue(Object.assign(new Error('permission denied'), {code: 'EACCES'}))

    // #when the execute phase runs
    const result = await runExecute(
      createBootstrap(1_000, {delivery: 'file-convention', responseFilePath: '/tmp/fro-bot-response.md'}),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
      0,
    )

    // #then unknown delivery status conservatively suppresses recovery
    expect(vi.mocked(executeOpenCode)).toHaveBeenCalledOnce()
    expect(mocks.archiveSession).not.toHaveBeenCalled()
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
    vi.mocked(executeOpenCode).mockResolvedValueOnce(overflowResult).mockResolvedValueOnce(recoveredResult)
    mocks.resolveResponseDelivery.mockReturnValue({delivery: 'file-convention', credential: 'provision'})

    // #when the execute phase runs
    const result = await runExecute(
      createBootstrap(1_000, {delivery: 'file-convention', responseFilePath: '/tmp/fro-bot-response.md'}),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
      0,
    )

    // #then credential provisioning prevents a fresh recovery attempt
    expect(vi.mocked(executeOpenCode)).toHaveBeenCalledOnce()
    expect(mocks.archiveSession).not.toHaveBeenCalled()
    expect(mocks.searchSessions).not.toHaveBeenCalled()
    expect(mocks.resolveResponseDelivery).toHaveBeenCalledOnce()
    expect(result.commentsPosted).toBe(0)
  })

  it('does not recover non-context-overflow terminal errors', async () => {
    // #given the first attempt returns an unrelated terminal LLM error
    const nonOverflowResult = createAgentResult({
      llmError: {type: 'quota_exceeded', message: 'quota exceeded', retryable: true},
    })
    vi.mocked(executeOpenCode).mockResolvedValueOnce(nonOverflowResult)

    // #when the execute phase runs
    const result = await runExecute(
      createBootstrap(1_000),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
      0,
    )

    // #then existing terminal behavior remains a single execution attempt
    expect(vi.mocked(executeOpenCode)).toHaveBeenCalledOnce()
    expect(mocks.archiveSession).not.toHaveBeenCalled()
    expect(mocks.searchSessions).not.toHaveBeenCalled()
    expect(result.llmError?.type).toBe('quota_exceeded')
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
    vi.mocked(executeOpenCode).mockResolvedValueOnce(successfulResult)

    // #when the execute phase runs
    const result = await runExecute(
      createBootstrap(1_000),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
      0,
    )

    // #then the recovery path remains untouched
    expect(vi.mocked(executeOpenCode)).toHaveBeenCalledOnce()
    expect(mocks.archiveSession).not.toHaveBeenCalled()
    expect(mocks.searchSessions).not.toHaveBeenCalled()
    expect(result).toMatchObject({success: true, sessionId: 'successful-session', llmError: null})
    expect(result.overflowRecovery).toBeUndefined()
  })
})

/** A client whose one adopted child always reports live -- forces drain past reconciliation into cancellation. */
function createStuckSessionClient(callOrder: string[]): SessionClient {
  return createFakeSessionClient({
    children: async () => ({data: [{id: 'ses_child'}]}),
    status: async () => ({data: {ses_child: {}}}),
    abort: async (args: {path: {id: string}; signal: AbortSignal}) => {
      callOrder.push(`abort:${args.path.id}`)
      return {data: {}}
    },
  })
}

describe('runExecute overflow recovery — ownership ledger (Unit 11)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(executeOpenCode).mockReset()
    mocks.readResponseFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    mocks.resolveResponseDelivery.mockReturnValue({delivery: 'file-convention', credential: 'withhold'})
    mocks.resolveOutputMode.mockReturnValue('branch-pr')
    mocks.getInput.mockReturnValue('branch-pr')
    mocks.searchSessions.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('cancels outstanding work on the overflowed session before archiving it', async () => {
    // #given the overflowed session's execution adopted a background dispatch that is still
    // outstanding, and a client that never confirms it stopped
    const callOrder: string[] = []
    const cacheRestore = createCacheRestore()
    const client = createStuckSessionClient(callOrder)
    const restoreWithClient: CacheRestorePhaseResult = {
      ...cacheRestore,
      serverHandle: {...cacheRestore.serverHandle, client},
    }
    mocks.archiveSession.mockImplementation(async (_url: string, sessionId: string) => {
      callOrder.push(`archive:${sessionId}`)
      return true
    })
    vi.mocked(executeOpenCode).mockImplementationOnce(async (_prompt, _logger, _config, _handle, ledger) => {
      ledger?.adopt('ses_child', 'background task')
      return createAgentResult()
    })
    vi.mocked(executeOpenCode).mockResolvedValueOnce(
      createAgentResult({success: true, exitCode: 0, error: null, sessionId: 'recovered-session', llmError: null}),
    )
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValue(1_100)

    // #when the execute phase runs and overflow recovery kicks in
    try {
      await runExecute(
        createBootstrap(1_000),
        createRouting(),
        restoreWithClient,
        createSessionPrep(),
        createMetrics(),
        0,
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then the outstanding entry was cancelled BEFORE the overflowed session was archived
    expect(callOrder).toEqual(['abort:ses_child', 'archive:overflowed-session'])
  })

  it('starts the recovery session with a fresh ledger rather than inheriting the exhausted one', async () => {
    // #given the overflowed session's ledger has outstanding work at the moment recovery begins
    const callOrder: string[] = []
    const cacheRestore = createCacheRestore()
    const client = createStuckSessionClient(callOrder)
    const restoreWithClient: CacheRestorePhaseResult = {
      ...cacheRestore,
      serverHandle: {...cacheRestore.serverHandle, client},
    }
    mocks.archiveSession.mockResolvedValue(true)
    vi.mocked(executeOpenCode).mockImplementationOnce(async (_prompt, _logger, _config, _handle, ledger) => {
      ledger?.adopt('ses_child', 'background task')
      return createAgentResult()
    })
    vi.mocked(executeOpenCode).mockResolvedValueOnce(
      createAgentResult({success: true, exitCode: 0, error: null, sessionId: 'recovered-session', llmError: null}),
    )
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValue(1_100)

    // #when the execute phase runs and overflow recovery starts a fresh session
    try {
      await runExecute(
        createBootstrap(1_000),
        createRouting(),
        restoreWithClient,
        createSessionPrep(),
        createMetrics(),
        0,
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then the recovery call received a DIFFERENT ledger object with nothing outstanding --
    // caps reset rather than carrying over the overflowed session's exhausted budget
    const firstLedger = vi.mocked(executeOpenCode).mock.calls[0]?.[4]
    const recoveryLedger = vi.mocked(executeOpenCode).mock.calls[1]?.[4]
    expect(recoveryLedger).toBeDefined()
    expect(recoveryLedger).not.toBe(firstLedger)
    expect(recoveryLedger?.outstanding()).toBe(0)
  })

  it('marks the entry unknown, blocking persistence, when cancellation cannot be confirmed during recovery', async () => {
    // #given the overflowed session's outstanding entry is cancelled but the client never
    // confirms it actually stopped (still reports live on every subsequent check)
    const callOrder: string[] = []
    const cacheRestore = createCacheRestore()
    const client = createStuckSessionClient(callOrder)
    const restoreWithClient: CacheRestorePhaseResult = {
      ...cacheRestore,
      serverHandle: {...cacheRestore.serverHandle, client},
    }
    mocks.archiveSession.mockResolvedValue(true)
    let overflowedLedgerRef: import('@fro-bot/runtime').OwnershipLedger | undefined
    vi.mocked(executeOpenCode).mockImplementationOnce(async (_prompt, _logger, _config, _handle, ledger) => {
      ledger?.adopt('ses_child', 'background task')
      overflowedLedgerRef = ledger
      return createAgentResult()
    })
    vi.mocked(executeOpenCode).mockResolvedValueOnce(
      createAgentResult({success: true, exitCode: 0, error: null, sessionId: 'recovered-session', llmError: null}),
    )
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValue(1_100)

    // #when the execute phase runs and archives the overflowed session
    try {
      await runExecute(
        createBootstrap(1_000),
        createRouting(),
        restoreWithClient,
        createSessionPrep(),
        createMetrics(),
        0,
      )
    } finally {
      nowSpy.mockRestore()
    }

    // #then a cancellation request was made, but it is never treated as confirmed on the
    // strength of the abort call alone -- the entry lands in unknown, and persistence
    // safety (isPersistenceSafe) reflects that honestly rather than reporting drained
    expect(callOrder).toContain('abort:ses_child')
    expect(overflowedLedgerRef?.snapshot()).toContainEqual({
      sessionId: 'ses_child',
      label: 'background task',
      state: 'unknown',
    })
    expect(overflowedLedgerRef?.isPersistenceSafe()).toBe(false)
  })

  it('leaves the overflowed session with no outstanding work by the time the recovery session begins (integration)', async () => {
    // #given the same stuck-work setup as the cancellation tests above
    const callOrder: string[] = []
    const cacheRestore = createCacheRestore()
    const client = createStuckSessionClient(callOrder)
    const restoreWithClient: CacheRestorePhaseResult = {
      ...cacheRestore,
      serverHandle: {...cacheRestore.serverHandle, client},
    }
    mocks.archiveSession.mockResolvedValue(true)
    let overflowedLedgerRef: import('@fro-bot/runtime').OwnershipLedger | undefined
    vi.mocked(executeOpenCode).mockImplementationOnce(async (_prompt, _logger, _config, _handle, ledger) => {
      ledger?.adopt('ses_child', 'background task')
      overflowedLedgerRef = ledger
      return createAgentResult()
    })
    vi.mocked(executeOpenCode).mockImplementationOnce(async () => {
      // #then by the time the SECOND (recovery) call starts, the overflowed session's
      // ledger has nothing left outstanding -- no two sessions hold outstanding work
      // on this workspace at the same time
      expect(overflowedLedgerRef?.outstanding()).toBe(0)
      return createAgentResult({
        success: true,
        exitCode: 0,
        error: null,
        sessionId: 'recovered-session',
        llmError: null,
      })
    })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValue(1_100)

    // #when the execute phase runs
    try {
      await runExecute(
        createBootstrap(1_000),
        createRouting(),
        restoreWithClient,
        createSessionPrep(),
        createMetrics(),
        0,
      )
    } finally {
      nowSpy.mockRestore()
    }

    expect(vi.mocked(executeOpenCode)).toHaveBeenCalledTimes(2)
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

  it('accepts an overridden teardown reserve', () => {
    // #given a caller-supplied reserve, distinct from the default
    // #when the remaining drain budget is computed
    const deadlineMs = computeDrainDeadlineMs(100_000, 5_000, 10_000)

    // #then the override is used instead of the default 30 seconds
    expect(deadlineMs).toBe(100_000 - 10_000 - 5_000)
  })
})

function createFakeSessionClient(overrides: {
  children?: () => Promise<{data?: unknown; error?: unknown}>
  status?: () => Promise<{data?: unknown; error?: unknown}>
  abort?: (args: {path: {id: string}; signal: AbortSignal}) => Promise<{data?: unknown; error?: unknown}>
}): SessionClient {
  return {
    session: {
      children: overrides.children ?? (async () => ({data: []})),
      status: overrides.status ?? (async () => ({data: {}})),
      abort: overrides.abort ?? (async () => ({data: {}})),
    },
  } as unknown as SessionClient
}

describe('runDrain', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('is a complete no-op when no ledger is supplied', async () => {
    // #given a run with no ownership ledger at all -- today's production shape
    const children = vi.fn(async () => ({data: []}))
    const client = createFakeSessionClient({children})

    // #when drain runs without a ledger
    const outcome = await runDrain({
      ledger: undefined,
      client,
      parentSessionId: 'ses_root',
      deadlineMs: 60_000,
      logger,
    })

    // #then nothing is reconciled or cancelled -- single-session runs are unchanged
    expect(children).not.toHaveBeenCalled()
    expect(outcome).toEqual({expired: false, cancelledCount: 0, settledCount: 0, unknownCount: 0})
  })

  it('completes immediately when nothing is outstanding, without delaying finalize', async () => {
    // #given a ledger with nothing tracked at all -- reconciliation has nothing to
    // settle, so it must never call upstream just to check
    const ledger = createOwnershipLedger()
    const children = vi.fn(async () => ({data: []}))
    const status = vi.fn(async () => ({data: {}}))
    const client = createFakeSessionClient({children, status})

    // #when drain runs
    const outcome = await runDrain({
      ledger,
      client,
      parentSessionId: 'ses_root',
      deadlineMs: 60_000,
      logger,
    })

    // #then the empty-ledger short circuit means reconciliation never calls upstream at
    // all -- there is nothing tracked for `children`/`liveSessionIds` to confirm against,
    // so drain completes without the round trip and without delaying finalize
    expect(children).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
    expect(outcome.expired).toBe(false)
    expect(outcome.unknownCount).toBe(0)
  })

  it('settles outstanding work discovered before finalize, via periodic reconciliation', async () => {
    // #given a ledger with one adopted entry that is still live on the first pass
    vi.useFakeTimers()
    try {
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      const status = vi.fn<() => Promise<{data: Record<string, unknown>}>>()
      status.mockResolvedValueOnce({data: {ses_child: {}}}).mockResolvedValue({data: {}})
      const client = createFakeSessionClient({
        children: async () => ({data: [{id: 'ses_child'}]}),
        status,
      })

      // #when drain runs and the periodic reconciler fires
      const outcomePromise = runDrain({
        ledger,
        client,
        parentSessionId: 'ses_root',
        deadlineMs: 5_000,
        logger,
        reconcileIntervalMs: 20,
        pollIntervalMs: 5,
      })
      await vi.advanceTimersByTimeAsync(200)
      const outcome = await outcomePromise

      // #then the entry settles once the child is no longer live, and finalize can proceed
      expect(outcome.expired).toBe(false)
      expect(outcome.unknownCount).toBe(0)
      expect(ledger.snapshot()).toContainEqual({sessionId: 'ses_child', label: 'background task', state: 'settled'})
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a tracked entry whose completion event never arrived, via periodic reconciliation when no discontinuity was ever detected', async () => {
    // #given a ledger entry the event stream never confirmed complete -- an earlier pass
    // already downgraded it to unknown -- and no discontinuity ever fired to trigger a
    // recheck. Only the interval-driven periodic pass can still confirm it settled.
    // Reconciliation cannot adopt an untracked session; this entry is tracked from the start.
    vi.useFakeTimers()
    try {
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      ledger.markUnknown('ses_child')
      const status = vi.fn<() => Promise<{data: Record<string, unknown>}>>()
      status.mockResolvedValueOnce({data: {ses_child: {}}}).mockResolvedValue({data: {}})
      const client = createFakeSessionClient({
        children: async () => ({data: [{id: 'ses_child'}]}),
        status,
      })

      // #when drain runs and the periodic reconciler fires
      const outcomePromise = runDrain({
        ledger,
        client,
        parentSessionId: 'ses_root',
        deadlineMs: 5_000,
        logger,
        reconcileIntervalMs: 20,
        pollIntervalMs: 5,
      })
      await vi.advanceTimersByTimeAsync(200)
      const outcome = await outcomePromise

      // #then the already-tracked entry, confirmed a child and no longer live, settles once
      // a later pass observes it -- the dropped settlement is recovered, not a dropped dispatch
      expect(outcome.expired).toBe(false)
      expect(ledger.snapshot()).toContainEqual({sessionId: 'ses_child', label: 'background task', state: 'settled'})
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not adopt an untracked live child -- drain completes without it (documented gap)', async () => {
    // #given a live child session upstream reports under this parent, but the ledger
    // never learned of it at all -- e.g. its dispatch event was dropped before ever
    // reaching the ledger. There is no tracked entry for it, tracked or otherwise.
    const ledger = createOwnershipLedger()
    const children = vi.fn(async () => ({data: [{id: 'ses_untracked'}]}))
    const status = vi.fn(async () => ({data: {ses_untracked: {}}}))
    const client = createFakeSessionClient({children, status})

    // #when drain runs
    const outcome = await runDrain({
      ledger,
      client,
      parentSessionId: 'ses_root',
      deadlineMs: 60_000,
      logger,
    })

    // #then the ledger has nothing tracked, so reconciliation's empty-ledger short circuit
    // means `children`/`status` are never even called -- the untracked live child is never
    // adopted, never appears in the ledger, and drain completes without waiting on it. This
    // is the documented, bounded gap: a future change that reintroduces adoption would need
    // to call upstream even for an empty ledger, and this assertion would catch it.
    expect(children).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
    expect(outcome.expired).toBe(false)
    expect(ledger.snapshot()).toHaveLength(0)
  })

  it('cancels outstanding work with a fresh signal when the deadline expires, and reports incomplete', async () => {
    // #given an entry that never settles, and a client whose abort call succeeds and is
    // then confirmed by a positive post-cancellation liveness check
    vi.useFakeTimers()
    try {
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      let abortSignalAtCallTime: AbortSignal | null = null
      let liveAfterAbort = false
      const abort = vi.fn(async (args: {path: {id: string}; signal: AbortSignal}) => {
        abortSignalAtCallTime = args.signal
        liveAfterAbort = false
        return {data: {}}
      })
      const status = vi.fn(async () => ({data: liveAfterAbort ? {ses_child: {}} : {}}))
      liveAfterAbort = true
      const client = createFakeSessionClient({
        children: async () => ({data: [{id: 'ses_child'}]}),
        status,
        abort,
      })

      // #when drain runs past its deadline
      const outcomePromise = runDrain({
        ledger,
        client,
        parentSessionId: 'ses_root',
        deadlineMs: 30,
        logger,
        reconcileIntervalMs: 10_000,
        pollIntervalMs: 5,
      })
      await vi.advanceTimersByTimeAsync(200)
      const outcome = await outcomePromise

      // #then cancellation was requested with a signal that is not already aborted --
      // distinct from any expired execution-deadline signal -- and confirmed settled
      expect(abort).toHaveBeenCalledWith({path: {id: 'ses_child'}, signal: expect.any(AbortSignal) as AbortSignal})
      expect(abortSignalAtCallTime).not.toBeNull()
      expect((abortSignalAtCallTime as unknown as AbortSignal).aborted).toBe(false)
      expect(outcome).toMatchObject({expired: true, cancelledCount: 1, settledCount: 1, unknownCount: 0})
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves an entry unknown when the deadline expires and cancellation cannot be confirmed', async () => {
    // #given an entry that never settles, and a post-cancellation liveness check that still
    // (or again) reports it live -- cancellation was requested but nothing confirms the
    // child actually stopped
    vi.useFakeTimers()
    try {
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      const client = createFakeSessionClient({
        children: async () => ({data: [{id: 'ses_child'}]}),
        status: async () => ({data: {ses_child: {}}}),
      })

      // #when drain runs past its deadline
      const outcomePromise = runDrain({
        ledger,
        client,
        parentSessionId: 'ses_root',
        deadlineMs: 30,
        logger,
        reconcileIntervalMs: 10_000,
        pollIntervalMs: 5,
      })
      await vi.advanceTimersByTimeAsync(200)
      const outcome = await outcomePromise

      // #then the entry is downgraded to unknown, not falsely reported settled
      expect(outcome).toMatchObject({expired: true, cancelledCount: 1, settledCount: 0, unknownCount: 1})
      expect(ledger.snapshot()).toContainEqual({sessionId: 'ses_child', label: 'background task', state: 'unknown'})
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an already-unknown entry at deadline expiry, not only outstanding ones', async () => {
    // #given an entry already downgraded to unknown (e.g. a prior failed reconciliation
    // pass) BEFORE the deadline fires — exactly the entry most likely still live.
    vi.useFakeTimers()
    try {
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      ledger.markUnknown('ses_child')
      const abort = vi.fn(async () => ({data: {}}))
      const client = createFakeSessionClient({
        children: async () => ({data: [{id: 'ses_child'}]}),
        status: async () => ({data: {ses_child: {}}}),
        abort,
      })

      // #when drain runs past its deadline
      const outcomePromise = runDrain({
        ledger,
        client,
        parentSessionId: 'ses_root',
        deadlineMs: 30,
        logger,
        reconcileIntervalMs: 10_000,
        pollIntervalMs: 5,
      })
      await vi.advanceTimersByTimeAsync(200)
      const outcome = await outcomePromise

      // #then the unknown entry was cancelled, not skipped because it was never
      // `outstanding`
      expect(abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: 'ses_child'}}))
      expect(outcome.cancelledCount).toBe(1)
      expect(ledger.snapshot().find(entry => entry.sessionId === 'ses_child')?.state).toBe('unknown')
    } finally {
      vi.useRealTimers()
    }
  })

  it('includes a still-live tracked entry in the cancel set, reconfirmed by the final reconciliation pass', async () => {
    // #given a known outstanding entry that stays a live child of this parent through
    // every reconciliation pass, including the final pass `cancelOutstanding` runs
    // immediately before building the cancel set -- not just the earlier passes made
    // during the wait loop. Reconciliation cannot adopt a new, previously-untracked
    // child; only this already-tracked entry is ever at stake.
    vi.useFakeTimers()
    try {
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_known', 'background task')
      const abort = vi.fn(async () => ({data: {}}))
      const children = vi.fn(async () => ({data: [{id: 'ses_known'}]}))
      const client = createFakeSessionClient({
        children,
        status: async () => ({data: {ses_known: {}}}),
        abort,
      })

      // #when drain runs past its deadline; the periodic reconciler's interval is
      // longer than the deadline so it never fires -- only the unconditional first
      // pass and the cancel-path's final pass ever call `children()`.
      const outcomePromise = runDrain({
        ledger,
        client,
        parentSessionId: 'ses_root',
        deadlineMs: 30,
        logger,
        reconcileIntervalMs: 10_000,
        pollIntervalMs: 5,
      })
      await vi.advanceTimersByTimeAsync(200)
      const outcome = await outcomePromise

      // #then the final reconciliation pass ran (a second `children()` call beyond the
      // unconditional first pass), re-confirming the entry is still this parent's live
      // child before the cancel set is built -- so it is cancelled, not silently skipped
      // because an earlier snapshot was taken before that pass ran.
      expect(children.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: 'ses_known'}}))
      expect(outcome.cancelledCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks outstanding entries unknown, rather than claiming drain, when no client is available', async () => {
    // #given a ledger with outstanding work but nothing to reconcile against
    const ledger = createOwnershipLedger()
    ledger.adopt('ses_child', 'background task')

    // #when drain runs with a null client
    const outcome = await runDrain({
      ledger,
      client: null,
      parentSessionId: null,
      deadlineMs: 60_000,
      logger,
    })

    // #then the entry is honestly unknown, not silently reported as drained
    expect(outcome).toEqual({expired: true, cancelledCount: 0, settledCount: 0, unknownCount: 1})
  })

  it('does not rewrite a terminal outcome already decided by execution, even when drain expires', async () => {
    // #given a run that already finished successfully before drain starts
    mocks.getInput.mockReturnValue('branch-pr')
    mocks.resolveOutputMode.mockReturnValue('branch-pr')
    mocks.resolveResponseDelivery.mockReturnValue({delivery: 'file-convention', credential: 'withhold'})
    mocks.readResponseFile.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}))
    vi.mocked(executeOpenCode).mockResolvedValueOnce(
      createAgentResult({success: true, exitCode: 0, error: null, llmError: null, sessionId: 'decided-session'}),
    )
    const execution = await runExecute(
      createBootstrap(1_000),
      createRouting(),
      createCacheRestore(),
      createSessionPrep(),
      createMetrics(),
      0,
    )
    expect(execution.success).toBe(true)
    expect(execution.exitCode).toBe(0)

    // #when a long-running drain against unrelated outstanding work expires
    vi.useFakeTimers()
    let outcome: Awaited<ReturnType<typeof runDrain>>
    try {
      const ledger = createOwnershipLedger()
      ledger.adopt('ses_child', 'background task')
      const client = createFakeSessionClient({
        children: async () => ({data: [{id: 'ses_child'}]}),
        status: async () => ({data: {ses_child: {}}}),
      })
      const outcomePromise = runDrain({
        ledger,
        client,
        parentSessionId: execution.sessionId,
        deadlineMs: 30,
        logger,
        reconcileIntervalMs: 10_000,
        pollIntervalMs: 5,
      })
      await vi.advanceTimersByTimeAsync(200)
      outcome = await outcomePromise
    } finally {
      vi.useRealTimers()
    }

    // #then drain's own incomplete outcome never touches the execution result -- the two
    // are separate values, and the decided success/exitCode survive unchanged
    expect(outcome.expired).toBe(true)
    expect(execution.success).toBe(true)
    expect(execution.exitCode).toBe(0)
    expect(execution.sessionId).toBe('decided-session')
  })
})
