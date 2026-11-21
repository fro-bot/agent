import type {OpenCodeV2ServerHandle, OwnershipLedger, TracingInputs} from '@fro-bot/runtime'
import type {Logger} from '../shared/logger.js'
import type {BootstrapPhaseResult} from './phases/bootstrap.js'
import type {CacheRestorePhaseResult} from './phases/cache-restore.js'
import type {RoutingPhaseResult} from './phases/routing.js'
import type {SandboxLifecycle} from './phases/sandbox-lifecycle.js'
import type {TraceRelayProcess, TraceRelayStopResult} from './phases/trace-relay-process.js'
import {ACTION_TRACING_OFF} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {serializeLoggerCalls} from '../shared/test-helpers.js'
import {run, TRACE_RELAY_STOP_WAIT_MS} from './run.js'

const ENDPOINT_HOST_CANARY = 'collector-canary.example.com'
const CREDENTIAL_CANARY = 'Basic cnVuLXRyYWNpbmctY2FuYXJ5LTAwMDc6c2VjcmV0'

const TRACE_RELAY = {
  url: `https://${ENDPOINT_HOST_CANARY}/api/public/otel/v1/traces`,
  headers: [{name: 'Authorization', value: CREDENTIAL_CANARY}],
}

// What the parsed `trace-endpoint` and `trace-headers` inputs hold for a traced run (the parser has its own tests).
const TRACED_INPUTS: TracingInputs = {enabled: true, ...TRACE_RELAY}

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

vi.mock('./phases/trace-relay-bundle.js', () => ({
  TRACE_RELAY_BUNDLE_FILE: 'trace-relay.js',
  checkTraceRelayBundle: vi.fn(async () => true),
}))

// The real supervisor stays available (one test starts it against a launcher that cannot work); every other test replaces it.
vi.mock('./phases/trace-relay-process.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./phases/trace-relay-process.js')>()),
  startTraceRelayProcess: vi.fn(),
}))

function createBootstrap(sandbox?: SandboxLifecycle, tracing: TracingInputs = TRACED_INPUTS): BootstrapPhaseResult {
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
      tracing,
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

function serverHandle(
  exitOutcome: ExitOutcome = 'graceful',
  info: {readonly code: number | null; readonly signal: NodeJS.Signals | null} = {code: 0, signal: null},
): OpenCodeV2ServerHandle {
  return {
    url: 'http://127.0.0.1:1',
    shutdown: vi.fn(async () => ({
      interrupts: {stopped: [], notRunning: [], unconfirmed: []},
      exit: {outcome: exitOutcome, ...info},
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
    /** The parsed tracing inputs. A run traces by default in this file; `untraced` is the run with the inputs empty. */
    readonly tracing?: TracingInputs
    readonly untraced?: boolean
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

  vi.mocked(runBootstrap).mockResolvedValue(
    createBootstrap(options.sandbox, options.untraced === true ? {enabled: false} : (options.tracing ?? TRACED_INPUTS)),
  )
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

/** The tracing host the run handed the server start (the fourth argument of the cache-restore phase). */
async function hostGiven(): Promise<unknown> {
  const {runCacheRestore} = await import('./phases/cache-restore.js')
  expect(vi.mocked(runCacheRestore)).toHaveBeenCalledTimes(1)
  return vi.mocked(runCacheRestore).mock.calls[0]?.[3]
}

/** What the server start would be told right now: a source is read at this moment, as the spawn reads it. */
async function hostAtSpawn(): Promise<unknown> {
  const given = await hostGiven()
  return typeof given === 'function' ? (given as () => unknown)() : given
}

describe('run with tracing', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    loggers.all.length = 0
    const core = await import('@actions/core')
    vi.mocked(core.getInput).mockImplementation(() => '')
    const {checkTraceRelayBundle} = await import('./phases/trace-relay-bundle.js')
    vi.mocked(checkTraceRelayBundle).mockResolvedValue(true)
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    const actual = await vi.importActual<typeof import('./phases/trace-relay-process.js')>(
      './phases/trace-relay-process.js',
    )
    vi.mocked(startTraceRelayProcess).mockImplementation(actual.startTraceRelayProcess)
    // The facts the run identity is read from outside the routed context: the job and the attempt of this runner.
    vi.stubEnv('GITHUB_JOB', 'review')
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '3')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
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
    const exitCode = await run()

    // #then the relay started before the server could, and stopped after the server's release, before cleanup
    expect(exitCode).toBe(0)
    expect(vi.mocked(startTraceRelayProcess)).toHaveBeenCalledTimes(1)
    expect(orderOf(vi.mocked(startTraceRelayProcess))).toBeLessThan(orderOf(vi.mocked(runCacheRestore)))
    expect(stop).toHaveBeenCalledTimes(1)
    expect(orderOf(stop)).toBeGreaterThan(orderOf(vi.mocked(runReleaseV2)))
    expect(orderOf(stop)).toBeLessThan(orderOf(vi.mocked(runCleanup)))
    expect(stop).toHaveBeenCalledWith({serverKilled: false})
  })

  describe('the host the plugin is told about', () => {
    const ON = {
      host: 'action',
      tracing: 'on',
      relayPort: 5151,
      identity: {repository: 'owner/repo', runId: '123', attempt: '3', job: 'review', trigger: 'pull_request'},
    } as const

    it('is on, with the relay port and the identity of the routed run, once the relay is up', async () => {
      // #given a relay that starts
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      await arrange()
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

      // #when
      await run()

      // #then the server start was handed the declaration, not the credential
      expect(await hostAtSpawn()).toEqual(ON)
    })

    it('reads each identity field from where it is authoritative, never from the process environment or the payload', async () => {
      // #given a routed run whose repository, run id and event differ from what the process environment says
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const {runRouting} = await import('./phases/routing.js')
      await arrange()
      const routed = createRouting()
      vi.mocked(runRouting).mockResolvedValue({
        ...routed,
        triggerResult: {
          ...routed.triggerResult,
          context: {
            ...(routed.triggerResult as {context: object}).context,
            repo: {owner: 'routed', repo: 'thing'},
            eventName: 'issue_comment',
            raw: {repository: {full_name: 'payload/ignored'}},
          },
        },
        agentContext: {...routed.agentContext, runId: '555'},
      } as RoutingPhaseResult)
      vi.stubEnv('GITHUB_REPOSITORY', 'env/ignored')
      vi.stubEnv('GITHUB_RUN_ID', '1')
      vi.stubEnv('GITHUB_EVENT_NAME', 'schedule')
      vi.stubEnv('GITHUB_RUN_ATTEMPT', '4')
      vi.stubEnv('GITHUB_JOB', 'remediate')
      vi.stubEnv('INPUT_MATRIX-CONTEXT', '')
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

      // #when
      await run()

      // #then repository, run id and trigger are the routed ones; the attempt and the job are this runner's own
      expect(await hostAtSpawn()).toEqual({
        ...ON,
        identity: {repository: 'routed/thing', runId: '555', attempt: '4', job: 'remediate', trigger: 'issue_comment'},
      })
    })

    it('is off, and starts no relay, when the inputs leave tracing off', async () => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      await arrange({untraced: true})

      await run()

      expect(await hostAtSpawn()).toEqual(ACTION_TRACING_OFF)
      expect(vi.mocked(startTraceRelayProcess)).not.toHaveBeenCalled()
    })

    it('is off at the spawn, with no second warning from the run, when the relay dies after it was ready and before the server starts', async () => {
      // #given a relay that reports ready, then crashes while cache restore, repair and server preparation are awaited
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const {runCacheRestore} = await import('./phases/cache-restore.js')
      await arrange()
      let crashed = false
      const stop = vi.fn(async (): Promise<TraceRelayStopResult> => ({outcome: 'already-exited', counts: 'incomplete'}))
      const relay: TraceRelayProcess = {pid: 4242, port: 5151, crashed: () => crashed, stop}
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})
      const phase = vi.mocked(runCacheRestore).getMockImplementation()
      const seen: unknown[] = []
      vi.mocked(runCacheRestore).mockImplementation(async (...args) => {
        // the host as the phase received it while the relay is still up, then the relay dies in the window
        seen.push(typeof args[3] === 'function' ? (args[3] as () => unknown)() : args[3])
        crashed = true
        return phase === undefined ? null : phase(...args)
      })

      // #when
      const exitCode = await run()

      // #then a reading while the relay was up is on, the reading at the spawn is off, and the run went on
      expect(seen[0]).toEqual(ON)
      expect(await hostAtSpawn()).toEqual(ACTION_TRACING_OFF)
      expect(exitCode).toBe(0)
      // and the run added no warning of its own about it: the exposure warning (the relay was up when it was given out) is the
      // only tracing warning the run logs, and the supervisor's crash warning is the one signal of the crash
      const tracingWarnings = everyLogged('warning').map(call => String(call[0]))
      expect(tracingWarnings.filter(message => /trac/i.test(message))).toEqual([EXPOSURE_WARNING])
    })

    it('is off when the relay fails to start, with the supervisor having warned once', async () => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      await arrange()
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: false, error: {kind: 'ready-timeout'}})

      const exitCode = await run()

      expect(exitCode).toBe(0)
      expect(await hostAtSpawn()).toEqual(ACTION_TRACING_OFF)
    })

    it('is off when the relay bundle fails its check, and no relay is spawned', async () => {
      // #given the real supervisor and a bundle that is not fit to run
      const {checkTraceRelayBundle} = await import('./phases/trace-relay-bundle.js')
      vi.mocked(checkTraceRelayBundle).mockResolvedValue(false)
      await arrange()

      // #when
      await run()

      // #then
      expect(await hostAtSpawn()).toEqual(ACTION_TRACING_OFF)
    })

    it('is off, with one fixed warning and no relay, when the run identity is incomplete', async () => {
      // #given a runner with no job
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      vi.stubEnv('GITHUB_JOB', '')
      await arrange()

      // #when
      const exitCode = await run()

      // #then the run goes on untraced: no relay, the plugin told off, and one warning that quotes nothing
      expect(exitCode).toBe(0)
      expect(vi.mocked(startTraceRelayProcess)).not.toHaveBeenCalled()
      expect(await hostAtSpawn()).toEqual(ACTION_TRACING_OFF)
      const warnings = everyLogged('warning').map(call => String(call[0]))
      expect(warnings.filter(message => /run identity/i.test(message))).toEqual([
        'Tracing is off: the run identity (repository, run, attempt, job and trigger) is incomplete',
      ])
    })

    it('carries neither a header value nor the collector host in what the server start is given', async () => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      await arrange()
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

      await run()

      const given = JSON.stringify(await hostAtSpawn())
      expect(given).not.toContain(CREDENTIAL_CANARY)
      expect(given).not.toContain(ENDPOINT_HOST_CANARY)
    })
  })

  it('hands the supervisor the validated config and a trace-relay logger, and nothing else about the run', async () => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    await arrange()
    vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

    await run()

    const call = vi.mocked(startTraceRelayProcess).mock.calls[0]?.[0]
    expect(call?.config).toEqual(TRACE_RELAY)
    expect(Object.keys(call ?? {}).sort()).toEqual(['bundleCheck', 'config', 'logger', 'signal'])
  })

  it.each([
    ['without isolation', undefined, false],
    ['with isolation', 'sandbox', true],
  ] as const)(
    'hands the supervisor the bundle check, for the mode of the run (%s)',
    async (_name, withSandbox, isolated) => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const {checkTraceRelayBundle} = await import('./phases/trace-relay-bundle.js')
      const core = await import('@actions/core')
      if (isolated) vi.mocked(core.getInput).mockImplementation(name => (name === 'isolate-agent' ? 'true' : ''))
      await arrange(withSandbox === undefined ? {} : {sandbox: fakeSandbox().sandbox})
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

      await run()

      // the check is not run by the run itself: the supervisor asks it, once the config is accepted
      expect(vi.mocked(checkTraceRelayBundle)).not.toHaveBeenCalled()
      const bundleCheck = vi.mocked(startTraceRelayProcess).mock.calls[0]?.[0].bundleCheck
      expect(await bundleCheck?.()).toBe(true)
      expect(vi.mocked(checkTraceRelayBundle)).toHaveBeenCalledWith({isolated})
    },
  )

  it('runs on untraced and without a relay when the bundle check fails, with one fixed warning and no spawn', async () => {
    // #given the real supervisor, and a bundle that is not fit to run
    const {checkTraceRelayBundle} = await import('./phases/trace-relay-bundle.js')
    const {runCacheRestore} = await import('./phases/cache-restore.js')
    const {runExecute} = await import('./phases/execute.js')
    const {runCleanup} = await import('./phases/cleanup.js')
    const core = await import('@actions/core')
    vi.mocked(checkTraceRelayBundle).mockResolvedValue(false)
    const {sandbox, registerSignalStop} = fakeSandbox()
    await arrange({sandbox})

    // #when an isolated run asks for tracing
    const exitCode = await run()

    // #then it went on exactly as an untraced run: the server started and nothing was declined (the launch's stop was
    // registered before the start and has nothing left to stop)
    expect(exitCode).toBe(0)
    expect(registerSignalStop).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runCacheRestore)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runExecute)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runCleanup).mock.calls[0]?.[0]).toMatchObject({skipSessionPersistence: false})
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled()
    const warnings = everyLogged('warning').filter(call => /trace/i.test(String(call[0])))
    expect(warnings).toEqual([['The trace relay did not start; this run is not traced', {reason: 'bundle-invalid'}]])
    for (const canary of [ENDPOINT_HOST_CANARY, CREDENTIAL_CANARY, 'Authorization']) {
      expect(allLoggedText()).not.toContain(canary)
    }
  })

  it('never checks the relay bundle when tracing is off, in an isolated run or not', async () => {
    const {checkTraceRelayBundle} = await import('./phases/trace-relay-bundle.js')
    const {sandbox} = fakeSandbox()
    await arrange({sandbox, untraced: true})

    await run()

    expect(vi.mocked(checkTraceRelayBundle)).not.toHaveBeenCalled()
  })

  it('starts no relay process when tracing is off', async () => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    const {sandbox, registerSignalStop} = fakeSandbox()
    await arrange({sandbox, untraced: true})

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
      await arrange({sandbox, untraced: true})

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

    await run()

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
    const exitCode = await run()

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

    await run()

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
    const exitCode = await run()

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

    const exitCode = await run()

    expect(exitCode).toBe(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(orderOf(stop)).toBeGreaterThan(orderOf(vi.mocked(runReleaseV2)))
  })

  it('stops the relay when the server never started', async () => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    await arrange({cacheRestoreFails: true})
    const {relay, stop} = fakeRelay()
    vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})

    const exitCode = await run()

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

    await run()

    expect(stop).toHaveBeenCalledWith({serverKilled: true})
  })

  it.each([
    [
      'the server had already exited on a signal',
      serverHandle('already-exited', {code: null, signal: 'SIGKILL'}),
      true,
    ],
    ['the server stopped gracefully on a signal', serverHandle('graceful', {code: null, signal: 'SIGTERM'}), true],
    [
      'the server had already exited with a non-zero code',
      serverHandle('already-exited', {code: 1, signal: null}),
      true,
    ],
    ['the server stopped gracefully with a non-zero code', serverHandle('graceful', {code: 137, signal: null}), true],
    ['the server had already exited cleanly', serverHandle('already-exited', {code: 0, signal: null}), false],
    ['the server stopped gracefully and cleanly', serverHandle('graceful', {code: 0, signal: null}), false],
  ])(
    'tells the supervisor the count may be short, or not, from how the server exited (%s)',
    async (_name, handle, killed) => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      await arrange({handle})
      const {relay, stop} = fakeRelay()
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: relay})

      await run()

      expect(stop).toHaveBeenCalledWith({serverKilled: killed})
    },
  )

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

    const exitCode = await run()

    expect(exitCode).toBe(0)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled()
  })

  describe('a relay that is slow to stop', () => {
    async function untracedBaseline(executeError?: Error) {
      const {runCleanup} = await import('./phases/cleanup.js')
      const {sandbox, release} = fakeSandbox()
      await arrange({sandbox, untraced: true, ...(executeError === undefined ? {} : {executeError})})
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
        const running = run().then(code => {
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
      const running = run().then(code => {
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
      await run()

      // #then exactly one stop was registered, and calling it (what the signal teardown does) stops the relay as killed
      expect(registerSignalStop).toHaveBeenCalledTimes(1)
      expect(startKeyProxy).not.toHaveBeenCalled()
      stop.mockClear()
      await registerSignalStop.mock.calls[0]?.[0]()
      expect(stop).toHaveBeenCalledWith({serverKilled: true})
    })

    it('registers the stop before the start begins, so a signal during the start is owned, even for a relay that then fails', async () => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const {sandbox, registerSignalStop} = fakeSandbox()
      await arrange({sandbox})
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: false, error: {kind: 'spawn-failed'}})

      await run()

      expect(registerSignalStop).toHaveBeenCalledTimes(1)
      expect(orderOf(registerSignalStop)).toBeLessThan(orderOf(vi.mocked(startTraceRelayProcess)))
    })

    it('hands the start the launch signal, and the registered stop aborts it while the start is still pending', async () => {
      // #given a start that is still waiting for its child
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const {sandbox, registerSignalStop} = fakeSandbox()
      await arrange({sandbox})
      let finishStart!: (result: Awaited<ReturnType<typeof startTraceRelayProcess>>) => void
      vi.mocked(startTraceRelayProcess).mockImplementation(
        async () =>
          new Promise(resolve => {
            finishStart = resolve
          }),
      )
      const running = run()
      await vi.waitFor(() => expect(vi.mocked(startTraceRelayProcess)).toHaveBeenCalledTimes(1))
      const signal = vi.mocked(startTraceRelayProcess).mock.calls[0]?.[0].signal
      expect(signal?.aborted).toBe(false)

      // #when the signal teardown calls the registered stop
      const stopping = registerSignalStop.mock.calls[0]?.[0]()
      await vi.waitFor(() => expect(signal?.aborted).toBe(true))

      // #then the start was told to give up, and the teardown's stop waits for it to settle
      let settled = false
      stopping?.then(
        () => {
          settled = true
        },
        () => undefined,
      )
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      finishStart({success: false, error: {kind: 'cancelled'}})
      await stopping
      await running
    })

    it('stops a relay that became ready just as the signal teardown ran, as one whose count is incomplete', async () => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const {sandbox, registerSignalStop} = fakeSandbox()
      await arrange({sandbox})
      const {relay, stop} = fakeRelay()
      let finishStart!: (result: Awaited<ReturnType<typeof startTraceRelayProcess>>) => void
      vi.mocked(startTraceRelayProcess).mockImplementation(
        async () =>
          new Promise(resolve => {
            finishStart = resolve
          }),
      )
      const running = run()
      await vi.waitFor(() => expect(vi.mocked(startTraceRelayProcess)).toHaveBeenCalledTimes(1))

      const stopping = registerSignalStop.mock.calls[0]?.[0]()
      finishStart({success: true, data: relay})
      await stopping
      await running

      expect(stop).toHaveBeenCalledWith({serverKilled: true})
    })

    it('registers no extra stop for a run that is not isolated, which relies on stdin closing when the Action exits', async () => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      await arrange()
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

      await expect(run()).resolves.toBe(0)
    })

    it('does not warn about exposure when isolation was requested, whether or not the lifecycle object reached this point', async () => {
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const core = await import('@actions/core')
      vi.mocked(core.getInput).mockImplementation(name => (name === 'isolate-agent' ? 'true' : ''))
      await arrange()
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

      await run()

      expect(everyLogged('warning').map(call => call[0])).not.toContain(EXPOSURE_WARNING)
    })

    it('logs the exposure warning once for a non-isolated traced run, and not for an isolated one', async () => {
      // #given a non-isolated traced run
      const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
      const {runCacheRestore} = await import('./phases/cache-restore.js')
      await arrange()
      vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

      // #when
      await run()

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
      await run()

      // #then there is none
      expect(everyLogged('warning').map(call => call[0])).not.toContain(EXPOSURE_WARNING)
    })
  })

  it('names neither the endpoint nor a header value in any line the run logs, relay up or down', async () => {
    const {startTraceRelayProcess} = await import('./phases/trace-relay-process.js')
    await arrange()
    vi.mocked(startTraceRelayProcess).mockResolvedValue({success: true, data: fakeRelay().relay})

    await run()

    for (const canary of [ENDPOINT_HOST_CANARY, CREDENTIAL_CANARY, 'Authorization']) {
      expect(allLoggedText()).not.toContain(canary)
    }
  })
})
