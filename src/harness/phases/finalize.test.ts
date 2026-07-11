import type {ResponsePostResult} from '../../features/agent/response-post.js'
import type {AgentContext} from '../../features/agent/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {TriggerResultProcess} from '../../features/triggers/types.js'
import type {Octokit} from '../../services/github/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {ExecutePhaseResult} from './execute.js'
import type {RoutingPhaseResult} from './routing.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'

const mocks = vi.hoisted(() => ({
  setFailed: vi.fn(),
  runResponsePost: vi.fn(),
}))

vi.mock('@actions/core', () => ({
  setFailed: mocks.setFailed,
  setOutput: vi.fn(),
  warning: vi.fn(),
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    addList: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../features/agent/response-post.js', () => ({
  runResponsePost: mocks.runResponsePost,
}))

vi.mock('../../shared/logger.js', () => ({
  createLogger: () => ({debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}),
}))

const {runFinalize} = await import('./finalize.js')

function createBootstrap(overrides: Partial<BootstrapPhaseResult> = {}): BootstrapPhaseResult {
  return {
    inputs: {agent: null} as BootstrapPhaseResult['inputs'],
    logger: createMockLogger(),
    opencodeResult: {didSetup: false, version: '1.0.0'} as BootstrapPhaseResult['opencodeResult'],
    delivery: 'file-convention',
    responseFilePath: '/tmp/fro-bot-response.md',
    ...overrides,
  }
}

function createRouting(overrides: Partial<RoutingPhaseResult> = {}): RoutingPhaseResult {
  return {
    githubClient: {} as Octokit,
    triggerResult: {} as TriggerResultProcess,
    agentContext: {
      eventName: 'issues',
      repo: 'owner/repo',
      ref: 'refs/heads/main',
      runId: '123',
      issueNumber: 1,
      issueType: 'issue',
    } as AgentContext,
    botLogin: 'fro-bot[bot]',
    ...overrides,
  }
}

function createExecution(overrides: Partial<ExecutePhaseResult> = {}): ExecutePhaseResult {
  return {
    success: true,
    exitCode: 0,
    sessionId: 'session-1',
    error: null,
    tokenUsage: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
    resolvedOutputMode: 'branch-pr',
    ...overrides,
  }
}

const cacheRestore: CacheRestorePhaseResult = {cacheStatus: 'miss'} as CacheRestorePhaseResult

function createMetrics(): MetricsCollector {
  return {
    incrementComments: vi.fn(),
    getMetrics: vi.fn().mockReturnValue({
      cacheStatus: 'miss',
      duration: null,
      sessionsUsed: [],
      sessionsCreated: [],
      tokenUsage: null,
      model: null,
      cost: null,
      prsCreated: [],
      commitsCreated: [],
      commentsPosted: 0,
      errors: [],
    }),
  } as unknown as MetricsCollector
}

describe('runFinalize file-convention delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delivers the response file and returns 0 when runResponsePost succeeds', async () => {
    // #given file-convention delivery with a resolved response file path
    const bootstrap = createBootstrap()
    const routing = createRouting()
    const execution = createExecution()
    const metrics = createMetrics()
    const result: ResponsePostResult = {delivered: true, kind: 'comment'}
    mocks.runResponsePost.mockResolvedValue(result)

    // #when runFinalize runs
    const exitCode = await runFinalize(
      bootstrap,
      routing,
      cacheRestore,
      execution,
      metrics,
      Date.now(),
      createMockLogger(),
    )

    // #then the run succeeds and the response file path was passed through
    expect(exitCode).toBe(0)
    expect(mocks.runResponsePost).toHaveBeenCalledWith(
      expect.objectContaining({responseFilePath: bootstrap.responseFilePath}),
      expect.anything(),
    )
    expect(mocks.setFailed).not.toHaveBeenCalled()
  })

  it('fails the run when runResponsePost reports delivered: false', async () => {
    // #given file-convention delivery whose post attempt fails
    const bootstrap = createBootstrap()
    const routing = createRouting()
    const execution = createExecution()
    const metrics = createMetrics()
    const result: ResponsePostResult = {delivered: false, reason: 'file-read-failed', detail: 'ENOENT'}
    mocks.runResponsePost.mockResolvedValue(result)

    // #when runFinalize runs
    const exitCode = await runFinalize(
      bootstrap,
      routing,
      cacheRestore,
      execution,
      metrics,
      Date.now(),
      createMockLogger(),
    )

    // #then the run is failed closed, naming the response file
    expect(exitCode).not.toBe(0)
    expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining(bootstrap.responseFilePath as string))
  })

  it('fails the run when no response file path was resolved at bootstrap', async () => {
    // #given file-convention delivery with a missing response file path
    const bootstrap = createBootstrap({responseFilePath: null})
    const routing = createRouting()
    const execution = createExecution()
    const metrics = createMetrics()

    // #when runFinalize runs
    const exitCode = await runFinalize(
      bootstrap,
      routing,
      cacheRestore,
      execution,
      metrics,
      Date.now(),
      createMockLogger(),
    )

    // #then the run fails without attempting delivery
    expect(exitCode).not.toBe(0)
    expect(mocks.setFailed).toHaveBeenCalled()
    expect(mocks.runResponsePost).not.toHaveBeenCalled()
  })

  it('fails the run even when execution.success is true but delivery fails', async () => {
    // #given a model run that reported success but wrote a bad response file
    const bootstrap = createBootstrap()
    const routing = createRouting()
    const execution = createExecution({success: true})
    const metrics = createMetrics()
    const result: ResponsePostResult = {delivered: false, reason: 'parse-failed', detail: 'malformed response'}
    mocks.runResponsePost.mockResolvedValue(result)

    // #when runFinalize runs
    const exitCode = await runFinalize(
      bootstrap,
      routing,
      cacheRestore,
      execution,
      metrics,
      Date.now(),
      createMockLogger(),
    )

    // #then the success early-return is bypassed and the run still fails
    expect(exitCode).not.toBe(0)
    expect(mocks.setFailed).toHaveBeenCalled()
  })
})

describe('runFinalize non-file-convention delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not call runResponsePost and succeeds on execution.success for model-gh delivery', async () => {
    // #given model-gh delivery with a successful execution
    const bootstrap = createBootstrap({delivery: 'model-gh', responseFilePath: null})
    const routing = createRouting()
    const execution = createExecution({success: true})
    const metrics = createMetrics()

    // #when runFinalize runs
    const exitCode = await runFinalize(
      bootstrap,
      routing,
      cacheRestore,
      execution,
      metrics,
      Date.now(),
      createMockLogger(),
    )

    // #then the run succeeds without touching the response-post path
    expect(exitCode).toBe(0)
    expect(mocks.runResponsePost).not.toHaveBeenCalled()
    expect(mocks.setFailed).not.toHaveBeenCalled()
  })

  it('does not call runResponsePost for none delivery, preserving existing failure behavior', async () => {
    // #given none delivery with a failed execution and no recoverable llm error
    const bootstrap = createBootstrap({delivery: 'none', responseFilePath: null})
    const routing = createRouting()
    const execution = createExecution({success: false, exitCode: 7, llmError: null})
    const metrics = createMetrics()

    // #when runFinalize runs
    const exitCode = await runFinalize(
      bootstrap,
      routing,
      cacheRestore,
      execution,
      metrics,
      Date.now(),
      createMockLogger(),
    )

    // #then existing failure behavior is preserved and response-post is untouched
    expect(exitCode).toBe(7)
    expect(mocks.runResponsePost).not.toHaveBeenCalled()
    expect(mocks.setFailed).toHaveBeenCalledWith(expect.stringContaining('7'))
  })
})
