import type {BootstrapPhaseResult} from './phases/bootstrap.js'
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

vi.mock('../features/agent/index.js', () => ({}))

vi.mock('../features/observability/index.js', () => ({
  createMetricsCollector: vi.fn(() => ({
    start: vi.fn(),
    end: vi.fn(),
    recordError: vi.fn(),
  })),
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
  runCleanup: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./phases/dedup.js', () => ({
  runDedup: vi.fn(),
  saveDedupMarker: vi.fn(),
}))

vi.mock('./phases/acquire-lock.js', () => ({
  runAcquireLock: vi.fn(),
}))

vi.mock('./phases/execute.js', () => ({
  runExecute: vi.fn(),
  resolveRequestedOutputModeState: vi.fn(() => 'omitted'),
}))

vi.mock('./phases/finalize.js', () => ({
  runFinalize: vi.fn(),
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
    },
    logger: createLogger({phase: 'test'}),
    opencodeResult: {path: 'opencode', version: '1.0.0', didSetup: false},
    delivery: 'model-gh',
    responseFilePath: null,
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
      cacheStatus: 'miss',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      duration: expect.any(Number),
    })
  })

  it('emits the unavailable output contract when routing skips before execution', async () => {
    // #given bootstrap succeeds but routing intentionally declines the event
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {runRouting} = await import('./phases/routing.js')

    vi.mocked(runBootstrap).mockResolvedValue(createBootstrap())
    vi.mocked(runRouting).mockResolvedValue(null)

    // #when the run reaches the pre-execute routing skip
    const exitCode = await run()

    // #then the skip remains successful and publishes the stable empty contract
    expect(exitCode).toBe(0)
    expectUnavailableOutputs()
  })

  it('emits the unavailable output contract when dedup suppresses execution', async () => {
    // #given routing succeeds but the dedup sentinel suppresses this run
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {runRouting} = await import('./phases/routing.js')
    const {runDedup} = await import('./phases/dedup.js')
    const {runAcquireLock} = await import('./phases/acquire-lock.js')

    vi.mocked(runBootstrap).mockResolvedValue(createBootstrap())
    vi.mocked(runRouting).mockResolvedValue(createRouting())
    vi.mocked(runDedup).mockResolvedValue({shouldProceed: false, entity: null})

    // #when the run reaches the dedup skip
    const exitCode = await run()

    // #then the run exits successfully, publishes outputs, and does not acquire a lock
    expect(exitCode).toBe(0)
    expectUnavailableOutputs()
    expect(runAcquireLock).not.toHaveBeenCalled()
  })

  it('emits the unavailable output contract when the coordination lock is held', async () => {
    // #given routing and dedup succeed but another surface holds the coordination lock
    const {runBootstrap} = await import('./phases/bootstrap.js')
    const {runRouting} = await import('./phases/routing.js')
    const {runDedup} = await import('./phases/dedup.js')
    const {runAcquireLock} = await import('./phases/acquire-lock.js')

    vi.mocked(runBootstrap).mockResolvedValue(createBootstrap())
    vi.mocked(runRouting).mockResolvedValue(createRouting())
    vi.mocked(runDedup).mockResolvedValue({shouldProceed: true, entity: null})
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
  })
})
