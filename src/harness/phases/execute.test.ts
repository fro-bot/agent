import type {SessionSearchResult} from '@fro-bot/runtime'
import type {AgentResult} from '../../features/agent/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import type {SessionPrepPhaseResult} from './session-prep.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {executeOpenCode} from '../../features/agent/index.js'
import {runExecute} from './execute.js'

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

vi.mock('@fro-bot/runtime', () => ({
  archiveSession: mocks.archiveSession,
  findLatestSession: mocks.findLatestSession,
  parseResponseFile: mocks.parseResponseFile,
  resolveResponseDelivery: mocks.resolveResponseDelivery,
  searchSessions: mocks.searchSessions,
  writeSessionSummary: mocks.writeSessionSummary,
}))

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
    },
    logger: mocks.logger,
    opencodeResult: {path: 'opencode', version: '1.0.0', didSetup: false},
    delivery: overrides.delivery ?? 'model-gh',
    responseFilePath: overrides.responseFilePath ?? null,
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
      shutdown: vi.fn(),
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
