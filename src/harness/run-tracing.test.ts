import type {OpenCodeV2ServerHandle, OwnershipLedger} from '@fro-bot/runtime'
import type {Logger} from '../shared/logger.js'
import type {BootstrapPhaseResult} from './phases/bootstrap.js'
import type {CacheRestorePhaseResult} from './phases/cache-restore.js'
import type {RoutingPhaseResult} from './phases/routing.js'
import type {SandboxLifecycle} from './phases/sandbox-lifecycle.js'
import type {TraceRelayProcess, TraceRelayStopResult} from './phases/trace-relay-process.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {serializeLoggerCalls} from '../shared/test-helpers.js'
import {run, TRACE_RELAY_STOP_WAIT_MS} from './run.js'

const ENDPOINT_HOST_CANARY = 'collector-canary.example.com'
const CREDENTIAL_CANARY = 'Basic cnVuLXRyYWNpbmctY2FuYXJ5LTAwMDc6c2VjcmV0'

const TRACE_RELAY = {
  url: `https://${ENDPOINT_HOST_CANARY}/api/public/otel/v1/traces`,
  headers: [{name: 'Authorization', value: CREDENTIAL_CANARY}],
}

const EXPOSURE_WARNING =
  'Tracing is on without isolate-agent: the agent can read the collector credential and the content of every span'

// Every logger `run.ts` and the phases create, so a test can read what the whole run logged.
const loggers = vi.hoisted(() => ({all: [] as unknown[]}))

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
  createLogger: vi.fn(() => {
    const logger = {info: vi.fn(), debug: vi.fn(), warning: vi.fn(), error: vi.fn()}
    loggers.all.push(logger)
    return logger
  }),
}))

vi.mock('./config/outputs.js', () => ({
  setActionOutputs: vi.fn(),
  setInvocationOutcomeOutput: vi.fn(),
}))

vi.mock('./config/state-keys.js', () => ({
  STATE_KEYS: {
    SHOULD_SAVE_CACHE: 'should-save-cache',
    CACHE_SAVED: 'cache-saved',
    ISOLATED_RUN: 'isolated-run',
    SANDBOX_STATE: 'sandbox-state',
    LOG_SNAPSHOT_DIR: 'log-snapshot-dir',
  },
}))

vi.mock('./phases/log-snapshot.js', () => ({
  snapshotLogDirectory: vi.fn(async () => '/runner-temp/fro-bot-logs-test'),
}))

vi.mock('./phases/acknowledge.js', () => ({runAcknowledge: vi.fn()}))
vi.mock('./phases/bootstrap.js', () => ({runBootstrap: vi.fn()}))
vi.mock('./phases/cache-restore.js', () => ({runCacheRestore: vi.fn()}))
vi.mock('./phases/repo-skills.js', () => ({
  runRepoSkills: vi.fn(async () => null),
  removeRepoSkillsStaging: vi.fn(async () => undefined),
}))
vi.mock('./phases/gh-config.js', () => ({releaseRunGhConfig: vi.fn(async () => undefined)}))
vi.mock('./phases/cleanup.js', () => ({
  runCleanup: vi.fn().mockResolvedValue({quiescenceConfirmed: true, continuityUnverified: false}),
}))
vi.mock('./phases/coordination-decline.js', () => ({runCoordinationDecline: vi.fn().mockResolvedValue(undefined)}))
vi.mock('./phases/coordination-clear.js', () => ({runBlockedLabelClear: vi.fn().mockResolvedValue(undefined)}))
vi.mock('./phases/dedup.js', () => ({runDedup: vi.fn(), saveDedupMarker: vi.fn()}))
vi.mock('./phases/acquire-lock.js', () => ({runAcquireLock: vi.fn()}))

vi.mock('@fro-bot/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {...original, acquireLock: vi.fn(), createS3Adapter: vi.fn(() => ({}))}
})

vi.mock('./phases/execute.js', () => ({
  computeDrainDeadlineMs: vi.fn(() => 60_000),
  runExecute: vi.fn(),
  resolveRequestedOutputModeState: vi.fn(() => 'omitted'),
}))
vi.mock('./phases/finalize.js', () => ({
  runFinalize: vi.fn(),
  runFinalizeWithResult: vi.fn().mockResolvedValue({exitCode: 0, deliveryKind: 'none'}),
}))
vi.mock('./phases/release-v2.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./phases/release-v2.js')>()),
  runReleaseV2: vi.fn(),
}))
vi.mock('./phases/review-reconciliation.js', () => ({runReviewReconciliation: vi.fn().mockResolvedValue(undefined)}))
vi.mock('../services/github/review-delivery-receipt.js', () => ({
  createReviewDeliveryReceiptOperations: vi.fn(() => ({reserve: vi.fn(), recordDelivered: vi.fn(), release: vi.fn()})),
}))
vi.mock('./phases/routing.js', () => ({runRouting: vi.fn()}))
vi.mock('./phases/session-prep.js', () => ({runSessionPrep: vi.fn()}))

// The real supervisor stays available (one test starts it against a launcher that cannot work); every other test replaces it.
vi.mock('./phases/trace-relay-process.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./phases/trace-relay-process.js')>()),
  startTraceRelayProcess: vi.fn(),
}))

function createBootstrap(sandbox?: SandboxLifecycle): BootstrapPhaseResult {
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
      timeoutMs: 1000,
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
      isolateAgent: sandbox !== undefined,
      agentStateHome: null,
    },
    logger: {info: vi.fn(), debug: vi.fn(), warning: vi.fn(), error: vi.fn()},
    opencodeResult: {path: 'opencode', version: '2.2.5'},
    delivery: 'model-gh',
    credential: 'provision',
    responseFilePath: null,
    responseFilePathCandidates: null,
    trustedHeadSha: '',
    sandboxTools: null,
    ...(sandbox === undefined ? {} : {sandbox}),
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

type ExitOutcome = 'already-exited' | 'forced' | 'graceful' | 'unconfirmed'

function serverHandle(exitOutcome: ExitOutcome = 'graceful'): OpenCodeV2ServerHandle {
  return {
    url: 'http://127.0.0.1:1',
    shutdown: vi.fn(async () => ({
      interrupts: {stopped: [], notRunning: [], unconfirmed: []},
      exit: {outcome: exitOutcome, code: 0, signal: null},
    })),
  } as unknown as OpenCodeV2ServerHandle
}

function fakeRelay(options: {crashed?: boolean; stop?: () => Promise<TraceRelayStopResult>} = {}) {
  const stop = vi.fn(
    options.stop ??
      (async (): Promise<TraceRelayStopResult> => ({
        outcome: 'stopped',
        counts: {delivered: 3, retry: 1, dropped: 0},
      })),
  )
  const relay: TraceRelayProcess = {pid: 4242, port: 5151, crashed: () => options.crashed ?? false, stop}
  return {relay, stop}
}

function deferredStop() {
  let resolve!: () => void
  const promise = new Promise<TraceRelayStopResult>(settle => {
    resolve = () => settle({outcome: 'stopped', counts: {delivered: 1, retry: 0, dropped: 0}})
  })
  return {promise, resolve}
}

function fakeSandbox() {
  const registerSignalStop = vi.fn<SandboxLifecycle['registerSignalStop']>()
  const release = vi.fn(async () => ({stop: 'stopped', restore: 'restored'}))
  const startKeyProxy = vi.fn()
  const sandbox = {
    prepare: vi.fn(),
    launch: vi.fn(),
    release,
    startKeyProxy,
    registerSignalStop,
  } as unknown as SandboxLifecycle
  return {sandbox, registerSignalStop, release, startKeyProxy}
}

async function arrange(
  options: {
    readonly executeError?: Error
    readonly releaseResult?: Record<string, unknown>
    readonly handle?: OpenCodeV2ServerHandle
    readonly sandbox?: SandboxLifecycle
    readonly routingSkipped?: boolean
    readonly cacheRestoreFails?: boolean
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

  vi.mocked(runBootstrap).mockResolvedValue(createBootstrap(options.sandbox))
  vi.mocked(runRouting).mockResolvedValue(
    options.routingSkipped === true
      ? ({skipped: true, skipReason: 'unsupported', skipMessage: 'x'} as unknown as RoutingPhaseResult)
      : createRouting(),
  )
  vi.mocked(runDedup).mockResolvedValue({shouldProceed: true, entity: {entityType: 'pr', entityNumber: 42}})
  vi.mocked(runAcquireLock).mockResolvedValue({outcome: 's3-disabled'})
  vi.mocked(runAcknowledge).mockResolvedValue({
    repo: 'owner/repo',
    commentId: 99,
    issueNumber: 42,
    issueType: 'pr',
    botLogin: 'fro-bot',
  })
  const handle = options.handle ?? serverHandle()
  const cacheRestore: CacheRestorePhaseResult = {
    cacheResult: {hit: false, key: 'k', restoredPath: null, corrupted: false, source: null},
    cacheStatus: 'miss',
    serverHandle: handle,
  }
  vi.mocked(runCacheRestore).mockResolvedValue(options.cacheRestoreFails === true ? null : cacheRestore)
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
  const ledger = {outstanding: () => 0, unknown: () => 0} as unknown as OwnershipLedger
  if (options.executeError === undefined) {
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
      ownershipLedger: ledger,
    })
  } else {
    vi.mocked(runExecute).mockRejectedValue(options.executeError)
  }
  vi.mocked(runReviewReconciliation).mockResolvedValue({reconciled: false, reason: 'not-applicable'})
  vi.mocked(runFinalizeWithResult).mockResolvedValue({exitCode: 0, deliveryKind: 'none'})
  vi.mocked(runCleanup).mockResolvedValue({quiescenceConfirmed: true, continuityUnverified: false})
  vi.mocked(runReleaseV2).mockResolvedValue({...QUIET_RELEASE, ...options.releaseResult})
  return {handle}
}

function everyLogged(level: 'error' | 'info' | 'warning'): unknown[][] {
  return (loggers.all as Logger[]).flatMap(logger => vi.mocked(logger[level]).mock.calls)
}

function allLoggedText(): string {
  return (loggers.all as Logger[]).map(logger => serializeLoggerCalls(logger)).join('\n')
}

/** The values the run wrote for the save-cache state: the initial `false`, then `true` when the server vouched for the session. */
const saveCacheStates = (core: typeof import('@actions/core')): unknown[] =>
  vi
    .mocked(core.saveState)
    .mock.calls.filter(call => call[0] === 'should-save-cache')
    .map((call): unknown => call[1])

const orderOf = (mock: {mock: {invocationCallOrder: number[]}}): number =>
  mock.mock.invocationCallOrder[0] ?? Number.NaN

/** The calls the run made, in the order it made them, for the mocks that mark its sequence. */
async function sequence(sandboxRelease: {mock: {invocationCallOrder: number[]}}): Promise<string[]> {
  const {runReleaseV2} = await import('./phases/release-v2.js')
  const {runFinalizeWithResult} = await import('./phases/finalize.js')
  const {runCleanup} = await import('./phases/cleanup.js')
  const marks: [string, {mock: {invocationCallOrder: number[]}}][] = [
    ['server-release', vi.mocked(runReleaseV2)],
    ['sandbox-release', sandboxRelease],
    ['finalize', vi.mocked(runFinalizeWithResult)],
    ['cleanup', vi.mocked(runCleanup)],
  ]
  return marks
    .map(([name, mock]) => [name, mock.mock.invocationCallOrder[0] ?? Number.NaN] as const)
    .toSorted((a, b) => a[1] - b[1])
    .map(([name]) => name)
}

describe('run with tracing', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    loggers.all.length = 0
    const core = await import('@actions/core')
    vi.mocked(core.getInput).mockImplementation(() => '')
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    const actual = await vi.importActual<typeof import('./phases/trace-relay-process.js')>(
      './phases/trace-relay-process.js',
    )
    vi.mocked(startTraceRelayProcess).mockImplementation(actual.startTraceRelayProcess)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('has the relay ready before the server spawn, and stops it after the server has exited', async () => {
    // #given a traced run whose relay starts
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    await arrange()
    const {relay, stop} = fakeRelay()
    vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})

    // #when
    const exitCode = await run({traceRelay: TRACE_RELAY})

    // #then the relay started before the server could, and stopped after the server's release, before cleanup
    expect(exitCode).toBe(0)
    expect(vi.mocked(startTraceRelayProcess)).toHaveBeenCalledTimes(1)
    expect(orderOf(vi.mocked(startTraceRelayProcess))).toBeLessThan(orderOf(vi.mocked(runCacheRestore)))
    expect(stop).toHaveBeenCalledTimes(1)
    expect(orderOf(stop)).toBeGreaterThan(orderOf(vi.mocked(runReleaseV2)))
    expect(orderOf(stop)).toBeLessThan(orderOf(vi.mocked(runCleanup)))
    expect(stop).toHaveBeenCalledWith({serverKilled: false})
  })

  it('hands the supervisor the validated config and a trace-relay logger, and nothing else about the run', async () => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    await arrange()
    vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

    await run({traceRelay: TRACE_RELAY})

    const call = vi.mocked(startTraceRelayProcess).mock.calls[0]?.[0]
    expect(call?.config).toEqual(TRACE_RELAY)
    expect(Object.keys(call ?? {}).sort()).toEqual(['config', 'logger'])
  })

  it('starts no relay process when tracing is off', async () => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    const {sandbox, registerSignalStop} = fakeSandbox()
    await arrange({sandbox})

    const exitCode = await run()

    expect(exitCode).toBe(0)
    expect(vi.mocked(startTraceRelayProcess)).not.toHaveBeenCalled()
    expect(registerSignalStop).not.toHaveBeenCalled()
    const messages = [...everyLogged('warning'), ...everyLogged('info')].map(call => String(call[0]))
    expect(messages.filter(message => /trace|tracing/i.test(message))).toEqual([])
  })

  it('leaves no timer behind and awaits nothing extra when no relay config is passed', async () => {
    // #given fake timers, so a timer the relay path started and did not clear would be counted
    vi.useFakeTimers()
    try {
      const {sandbox, registerSignalStop} = fakeSandbox()
      await arrange({sandbox})

      // #when an untraced run finishes without the clock moving
      const exitCode = await run()

      // #then it finished on microtasks alone and no timer or signal stop exists
      expect(exitCode).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(registerSignalStop).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts no relay for a run that is skipped before the server start', async () => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    await arrange({routingSkipped: true})

    await run({traceRelay: TRACE_RELAY})

    expect(vi.mocked(startTraceRelayProcess)).not.toHaveBeenCalled()
  })

  it('carries on when the relay fails to start: the server starts, nothing is declined, and the real supervisor warns once', async () => {
    // #given the real supervisor and a launcher that cannot work: its default entry is not next to this source file
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    const {runExecute} = await import('./phases/execute.js')
    const core = await import('@actions/core')
    await arrange()

    // #when the run is traced
    const exitCode = await run({traceRelay: TRACE_RELAY})

    // #then the run went on exactly as an untraced one: server start, execution, cleanup with no decline
    expect(exitCode).toBe(0)
    expect(vi.mocked(runCacheRestore)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runExecute)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({skipSessionPersistence: false})
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).not.toHaveProperty('persistenceDeclineReason')
    expect(saveCacheStates(core)).toEqual(['false', 'true'])
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled()

    // #and one fixed warning says why, with no endpoint, host or header in any line of the run
    const warnings = everyLogged('warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.[0]).toBe('The trace relay did not start; this run is not traced')
    for (const canary of [ENDPOINT_HOST_CANARY, CREDENTIAL_CANARY, 'Authorization']) {
      expect(allLoggedText()).not.toContain(canary)
    }
  })

  it('does not log the exposure warning when the relay failed to start, because no credential was handed out', async () => {
    await arrange()

    await run({traceRelay: TRACE_RELAY})

    expect(everyLogged('warning').map(call => call[0])).not.toContain(EXPOSURE_WARNING)
  })

  it('leaves the result and the persistence decision alone when the relay exits mid-run', async () => {
    // #given a relay that reports itself crashed from the start, and stops with an incomplete count
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    const core = await import('@actions/core')
    await arrange()
    const {relay, stop} = fakeRelay({
      crashed: true,
      stop: async () => ({outcome: 'already-exited', counts: 'incomplete'}),
    })
    vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})

    // #when
    const exitCode = await run({traceRelay: TRACE_RELAY})

    // #then it ends as an untraced run would
    expect(exitCode).toBe(0)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({skipSessionPersistence: false})
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).not.toHaveProperty('persistenceDeclineReason')
    expect(saveCacheStates(core)).toEqual(['false', 'true'])
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled()
  })

  it('still stops the relay, after the server release, when a phase throws after it started', async () => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    const {runReleaseV2} = await import('./phases/release-v2.js')
    await arrange({executeError: new Error('boom')})
    const {relay, stop} = fakeRelay()
    vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})

    const exitCode = await run({traceRelay: TRACE_RELAY})

    expect(exitCode).toBe(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(orderOf(stop)).toBeGreaterThan(orderOf(vi.mocked(runReleaseV2)))
  })

  it('stops the relay when the server never started', async () => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    await arrange({cacheRestoreFails: true})
    const {relay, stop} = fakeRelay()
    vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})

    const exitCode = await run({traceRelay: TRACE_RELAY})

    expect(exitCode).toBe(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith({serverKilled: false})
  })

  it.each([
    ['the server had to be killed', serverHandle('forced'), {}],
    ['the server exit could not be confirmed', serverHandle('unconfirmed'), {}],
    ['the release reports the server exit unconfirmed', serverHandle(), {serverExitUnconfirmed: true}],
  ])('tells the supervisor the count may be short when %s', async (_name, handle, releaseResult) => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    await arrange({handle, releaseResult})
    const {relay, stop} = fakeRelay()
    vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})

    await run({traceRelay: TRACE_RELAY})

    expect(stop).toHaveBeenCalledWith({serverKilled: true})
  })

  it('does not let a relay stop that rejects change the run', async () => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    const core = await import('@actions/core')
    await arrange()
    const {relay, stop} = fakeRelay({
      stop: async () => {
        throw new Error('relay stop exploded')
      },
    })
    vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})

    const exitCode = await run({traceRelay: TRACE_RELAY})

    expect(exitCode).toBe(0)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled()
  })

  describe('a relay that is slow to stop', () => {
    async function untracedBaseline(executeError?: Error) {
      const {runCleanup} = await import('./phases/cleanup.js')
      const {sandbox, release} = fakeSandbox()
      await arrange({sandbox, ...(executeError === undefined ? {} : {executeError})})
      const exitCode = await run()
      const cleanup = vi.mocked(runCleanup).mock.calls[0]?.[0]
      return {
        exitCode,
        order: await sequence(release),
        skip: cleanup?.skipSessionPersistence,
        reason: cleanup?.persistenceDeclineReason,
      }
    }

    it.each([
      ['on the normal path', undefined],
      ['when a phase throws', new Error('boom')],
    ])('does not hold the sandbox release, the result or the persistence decision %s', async (_name, executeError) => {
      // #given what an untraced isolated run does
      const baseline = await untracedBaseline(executeError)
      vi.clearAllMocks()
      loggers.all.length = 0

      // #and the same run with a relay whose stop never returns
      vi.useFakeTimers()
      try {
        const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
        const {runCleanup} = await import('./phases/cleanup.js')
        const {sandbox, release} = fakeSandbox()
        await arrange({sandbox, ...(executeError === undefined ? {} : {executeError})})
        const {relay, stop} = fakeRelay({stop: async () => new Promise<never>(() => undefined)})
        vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})

        // #when the run goes on
        let finished: number | undefined
        const running = run({traceRelay: TRACE_RELAY}).then(code => {
          finished = code
        })
        await vi.advanceTimersByTimeAsync(10)

        // #then the sandbox was released although the stop is still pending, and the run is still waiting only for it
        expect(stop).toHaveBeenCalledTimes(1)
        expect(release).toHaveBeenCalledTimes(1)
        expect(finished).toBeUndefined()

        // #when the bound passes the run ends, and nothing about it differs from the untraced run
        await vi.advanceTimersByTimeAsync(TRACE_RELAY_STOP_WAIT_MS + 100)
        await running
        const cleanup = vi.mocked(runCleanup).mock.calls[0]?.[0]
        expect(finished).toBe(baseline.exitCode)
        expect(await sequence(release)).toEqual(baseline.order)
        expect(cleanup?.skipSessionPersistence).toBe(baseline.skip)
        expect(cleanup?.persistenceDeclineReason).toBe(baseline.reason)
      } finally {
        vi.useRealTimers()
      }
    })

    it('waits for a stop that finishes, so its log line lands before the run ends', async () => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      await arrange()
      const finishedStop = deferredStop()
      const {relay, stop} = fakeRelay({stop: async () => finishedStop.promise})
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})
      let finished = false
      const running = run({traceRelay: TRACE_RELAY}).then(code => {
        finished = true
        return code
      })

      await vi.waitFor(() => expect(stop).toHaveBeenCalled())
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(finished).toBe(false)
      finishedStop.resolve()

      expect(await running).toBe(0)
    })
  })

  describe('isolation', () => {
    it('registers one extra stop with the sandbox lifecycle, which stops the relay on a signal, and leaves the key proxy slot alone', async () => {
      // #given an isolated, traced run
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const {sandbox, registerSignalStop, startKeyProxy} = fakeSandbox()
      await arrange({sandbox})
      const {relay, stop} = fakeRelay()
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})

      // #when the run reaches the point after the relay started
      await run({traceRelay: TRACE_RELAY})

      // #then exactly one stop was registered, and calling it (what the signal teardown does) stops the relay as killed
      expect(registerSignalStop).toHaveBeenCalledTimes(1)
      expect(startKeyProxy).not.toHaveBeenCalled()
      stop.mockClear()
      await registerSignalStop.mock.calls[0]?.[0]()
      expect(stop).toHaveBeenCalledWith({serverKilled: true})
    })

    it('registers nothing for a relay that did not start', async () => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const {sandbox, registerSignalStop} = fakeSandbox()
      await arrange({sandbox})
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: false, error: {kind: 'spawn-failed'}})

      await run({traceRelay: TRACE_RELAY})

      expect(registerSignalStop).not.toHaveBeenCalled()
    })

    it('registers no extra stop for a run that is not isolated, which relies on stdin closing when the Action exits', async () => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      await arrange()
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

      await expect(run({traceRelay: TRACE_RELAY})).resolves.toBe(0)
    })

    it('does not warn about exposure when isolation was requested, whether or not the lifecycle object reached this point', async () => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const core = await import('@actions/core')
      vi.mocked(core.getInput).mockImplementation(name => (name === 'isolate-agent' ? 'true' : ''))
      await arrange()
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

      await run({traceRelay: TRACE_RELAY})

      expect(everyLogged('warning').map(call => call[0])).not.toContain(EXPOSURE_WARNING)
    })

    it('logs the exposure warning once for a non-isolated traced run, and not for an isolated one', async () => {
      // #given a non-isolated traced run
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const {runCacheRestore} = await import('./phases/cache-restore.js')
      await arrange()
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

      // #when
      await run({traceRelay: TRACE_RELAY})

      // #then the warning is logged once, before the server starts
      const exposure = (loggers.all as Logger[]).flatMap(logger =>
        vi
          .mocked(logger.warning)
          .mock.calls.map((call, index) => ({call, order: vi.mocked(logger.warning).mock.invocationCallOrder[index]})),
      )
      const hits = exposure.filter(entry => entry.call[0] === EXPOSURE_WARNING)
      expect(hits).toHaveLength(1)
      expect(hits[0]?.order).toBeLessThan(orderOf(vi.mocked(runCacheRestore)))

      // #given an isolated traced run
      vi.clearAllMocks()
      loggers.all.length = 0
      const {sandbox} = fakeSandbox()
      await arrange({sandbox})
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

      // #when
      await run({traceRelay: TRACE_RELAY})

      // #then there is none
      expect(everyLogged('warning').map(call => call[0])).not.toContain(EXPOSURE_WARNING)
    })
  })

  it('names neither the endpoint nor a header value in any line the run logs, relay up or down', async () => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    await arrange()
    vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

    await run({traceRelay: TRACE_RELAY})

    for (const canary of [ENDPOINT_HOST_CANARY, CREDENTIAL_CANARY, 'Authorization']) {
      expect(allLoggedText()).not.toContain(canary)
    }
  })
})
