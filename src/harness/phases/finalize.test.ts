import type {ResponsePostResult} from '../../features/agent/response-post.js'
import type {AgentContext} from '../../features/agent/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {TriggerResultProcess} from '../../features/triggers/types.js'
import type {CommentTarget, Octokit} from '../../services/github/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {ExecutePhaseResult} from './execute.js'
import type {RoutingPhaseResult} from './routing.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'

const mocks = vi.hoisted(() => ({
  setFailed: vi.fn(),
  runResponsePost: vi.fn(),
  postComment: vi.fn(),
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

vi.mock('../../features/comments/index.js', async () => {
  const actual: object = await vi.importActual('../../features/comments/index.js')
  return {...actual, postComment: mocks.postComment}
})

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
    triggerResult: {context: {eventType: 'issues'}} as TriggerResultProcess,
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

describe('runFinalize quota_exceeded llmError handling', () => {
  const ATTACKER_MESSAGE = 'attacker-controlled message with secret-token-xyz'
  const ATTACKER_DETAILS = 'attacker-controlled details'
  const RESET_TIME = new Date('2024-06-01T00:00:00Z')

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.postComment.mockResolvedValue({commentId: 1, created: true, updated: false, url: 'https://example.com/1'})
  })

  function createQuotaExecution(overrides: Partial<ExecutePhaseResult> = {}): ExecutePhaseResult {
    return createExecution({
      success: false,
      exitCode: 1,
      llmError: {
        type: 'quota_exceeded',
        message: ATTACKER_MESSAGE,
        details: ATTACKER_DETAILS,
        retryable: false,
        resetTime: RESET_TIME,
      },
      ...overrides,
    })
  }

  function assertNoSentinelLeak(text: string): void {
    expect(text).not.toContain(ATTACKER_MESSAGE)
    expect(text).not.toContain(ATTACKER_DETAILS)
    expect(text).not.toContain('secret-token-xyz')
  }

  it('posts a rebuilt quota_exceeded comment to the exact issue target for model-gh delivery', async () => {
    // #given model-gh delivery, an issue target, and a quota_exceeded llmError
    const bootstrap = createBootstrap({delivery: 'model-gh', responseFilePath: null})
    const routing = createRouting()
    const execution = createQuotaExecution()
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

    // #then it posts exactly once to the exact resolved issue target, never touches runResponsePost, and fails closed
    expect(mocks.runResponsePost).not.toHaveBeenCalled()
    expect(mocks.postComment).toHaveBeenCalledTimes(1)
    const [, target, options] = mocks.postComment.mock.calls[0] as [unknown, CommentTarget, {body: string}]
    expect(target).toEqual({type: 'issue', number: 1, owner: 'owner', repo: 'repo'})
    expect(exitCode).toBe(1)
    expect(mocks.setFailed).toHaveBeenCalledTimes(1)

    // #then the posted body and setFailed text are canonical quota guidance, never the attacker-controlled sentinel
    const [failedMessage] = mocks.setFailed.mock.calls[0] as [string]
    assertNoSentinelLeak(options.body)
    assertNoSentinelLeak(failedMessage)
    expect(options.body).toContain('Provider quota exceeded')
    expect(options.body).toContain(RESET_TIME.toISOString())
    expect(failedMessage).toContain('provider quota exceeded')
  })

  it('posts a rebuilt quota_exceeded comment to the exact PR target for file-convention delivery, never calling runResponsePost', async () => {
    // #given file-convention delivery, a PR target, and a quota_exceeded llmError
    const bootstrap = createBootstrap({delivery: 'file-convention', responseFilePath: '/tmp/fro-bot-response.md'})
    const routing = createRouting({
      agentContext: {
        eventName: 'pull_request',
        repo: 'owner/repo',
        ref: 'refs/heads/main',
        runId: '123',
        issueNumber: 42,
        issueType: 'pr',
      } as AgentContext,
    })
    const execution = createQuotaExecution()
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

    // #then quota handling takes priority over file-convention delivery, posting once to the exact PR target
    expect(mocks.runResponsePost).not.toHaveBeenCalled()
    expect(mocks.postComment).toHaveBeenCalledTimes(1)
    const [, target] = mocks.postComment.mock.calls[0] as [unknown, CommentTarget]
    expect(target).toEqual({type: 'pr', number: 42, owner: 'owner', repo: 'repo'})
    expect(exitCode).toBe(1)
    expect(mocks.setFailed).toHaveBeenCalledTimes(1)
  })

  it('posts a rebuilt quota_exceeded comment to the exact discussion target for model-gh delivery', async () => {
    // #given model-gh delivery, a discussion_comment event, and a quota_exceeded llmError
    const bootstrap = createBootstrap({delivery: 'model-gh', responseFilePath: null})
    const routing = createRouting({
      triggerResult: {context: {eventType: 'discussion_comment'}} as TriggerResultProcess,
    })
    const execution = createQuotaExecution()
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

    // #then it posts exactly once to the exact discussion target and fails closed
    expect(mocks.postComment).toHaveBeenCalledTimes(1)
    const [, target] = mocks.postComment.mock.calls[0] as [unknown, CommentTarget]
    expect(target).toEqual({type: 'discussion', number: 1, owner: 'owner', repo: 'repo'})
    expect(exitCode).toBe(1)
    expect(mocks.setFailed).toHaveBeenCalledTimes(1)
  })

  it('makes zero postComment calls and fails closed when no comment target is resolvable', async () => {
    // #given no resolvable issue/PR/discussion number
    const bootstrap = createBootstrap({delivery: 'model-gh', responseFilePath: null})
    const routing = createRouting({
      agentContext: {
        eventName: 'issues',
        repo: 'owner/repo',
        ref: 'refs/heads/main',
        runId: '123',
        issueNumber: 0,
        issueType: 'issue',
      } as AgentContext,
    })
    const execution = createQuotaExecution()
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

    // #then no post is attempted, but the run still fails closed
    expect(mocks.postComment).not.toHaveBeenCalled()
    expect(exitCode).toBe(1)
    expect(mocks.setFailed).toHaveBeenCalledTimes(1)
  })

  it('makes zero postComment calls and fails closed when delivery is none, even with a valid target', async () => {
    // #given delivery: 'none' with an otherwise-resolvable issue target
    const bootstrap = createBootstrap({delivery: 'none', responseFilePath: null})
    const routing = createRouting()
    const execution = createQuotaExecution()
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

    // #then the 'none' delivery gate suppresses the post, but the run still fails closed
    expect(mocks.postComment).not.toHaveBeenCalled()
    expect(exitCode).toBe(1)
    expect(mocks.setFailed).toHaveBeenCalledTimes(1)
  })

  it('makes zero postComment calls and fails closed when a response was already posted', async () => {
    // #given a valid target and delivery, but execution.commentsPosted > 0
    const bootstrap = createBootstrap({delivery: 'model-gh', responseFilePath: null})
    const routing = createRouting()
    const execution = createQuotaExecution({commentsPosted: 1})
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

    // #then the already-posted guard suppresses a second post, but the run still fails closed
    expect(mocks.postComment).not.toHaveBeenCalled()
    expect(exitCode).toBe(1)
    expect(mocks.setFailed).toHaveBeenCalledTimes(1)
  })

  it('attempts exactly one postComment call and still fails closed with setFailed when the writer fails', async () => {
    // #given postComment resolving to null (writer failure)
    mocks.postComment.mockResolvedValue(null)
    const bootstrap = createBootstrap({delivery: 'model-gh', responseFilePath: null})
    const routing = createRouting()
    const execution = createQuotaExecution()
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

    // #then it attempted exactly one post, still fails closed, and setFailed carries the fixed guidance only
    expect(mocks.postComment).toHaveBeenCalledTimes(1)
    expect(exitCode).toBe(1)
    expect(mocks.setFailed).toHaveBeenCalledTimes(1)
    const [failedMessage] = mocks.setFailed.mock.calls[0] as [string]
    assertNoSentinelLeak(failedMessage)
  })

  it('does not divert non-quota_exceeded llmErrors from the ordinary error-comment path', async () => {
    // #given a rate_limit llmError (ordinary path, not quota_exceeded)
    const bootstrap = createBootstrap({delivery: 'none', responseFilePath: null})
    const routing = createRouting()
    const execution = createExecution({
      success: false,
      exitCode: 1,
      llmError: {
        type: 'rate_limit',
        message: 'Rate limit hit',
        retryable: true,
      },
    })
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

    // #then the ordinary recoverable-LLM-error path is preserved: returns 0, no setFailed
    expect(exitCode).toBe(0)
    expect(mocks.setFailed).not.toHaveBeenCalled()
  })
})
