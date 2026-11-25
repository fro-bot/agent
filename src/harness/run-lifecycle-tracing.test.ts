import type {OpenCodeV2ServerHandle, OwnershipLedger} from '@fro-bot/runtime'
import type {OtlpSink, SinkRequest, TlsSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import type {TriggerContext} from '../features/triggers/types.js'
import type {BootstrapPhaseResult} from './phases/bootstrap.js'
import type {CacheRestorePhaseResult, CacheRestoreTrace} from './phases/cache-restore.js'
import type {RoutingPhaseResult, RoutingPhaseSkip} from './phases/routing.js'
import type {SandboxLifecycle} from './phases/sandbox-lifecycle.js'
import {createHash} from 'node:crypto'
import {ACTION_TRACING_OFF, buildTracingLauncherValue, TRACING_IDENTITY_FIELD_MAX_CHARS} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {opensslAvailable, startOtlpSink, startTlsSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {resolveActionTracing} from '../services/setup/tracing.js'
import {markRunCancelled, resetRunCancellation} from '../shared/cancellation.js'
import {createMockLogger} from '../shared/test-helpers.js'
import {run} from './run.js'

/**
 * `run()` with the lifecycle tracer on, against a real OTLP receiver. Every phase is mocked, as in `run-tracing.test.ts`;
 * what is real is the trace-input reader (through `core.getInput`), the secret registry, the tracer and its exporter, and
 * (for one row) the real input parser inside `runBootstrap`.
 */

const loggers = vi.hoisted(() => ({all: [] as unknown[]}))
const inputs = vi.hoisted(() => ({values: new Map<string, string>(), state: new Map<string, string>()}))

vi.mock('@actions/core', () => ({
  getInput: vi.fn((name: string) => inputs.values.get(name) ?? ''),
  getState: vi.fn((key: string) => inputs.state.get(key) ?? ''),
  // What the main step saves is what the post step reads, so a handoff row sees only the state a real main step leaves.
  saveState: vi.fn((key: string, value: string) => {
    inputs.state.set(key, value)
  }),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  warning: vi.fn(),
  notice: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('../features/agent/index.js', () => ({applyTerminalReaction: vi.fn()}))
vi.mock('../features/observability/index.js', () => ({
  createMetricsCollector: vi.fn(() => ({start: vi.fn(), end: vi.fn(), recordError: vi.fn()})),
  writeInvocationOutcomeSummary: vi.fn(),
}))
vi.mock('../shared/logger.js', () => ({
  createLogger: vi.fn(() => {
    const logger = {info: vi.fn(), debug: vi.fn(), warning: vi.fn(), error: vi.fn()}
    loggers.all.push(logger)
    return logger
  }),
}))
vi.mock('./config/outputs.js', () => ({setActionOutputs: vi.fn(), setInvocationOutcomeOutput: vi.fn()}))
vi.mock('./phases/log-snapshot.js', () => ({snapshotLogDirectory: vi.fn(async () => '/runner-temp/logs')}))
vi.mock('./phases/acknowledge.js', () => ({runAcknowledge: vi.fn()}))
vi.mock('./phases/bootstrap.js', () => ({runBootstrap: vi.fn()}))
vi.mock('./phases/cache-restore.js', () => ({runCacheRestore: vi.fn()}))
vi.mock('./phases/repo-skills.js', () => ({
  runRepoSkills: vi.fn(async () => null),
  removeRepoSkillsStaging: vi.fn(async () => undefined),
}))
vi.mock('./phases/gh-config.js', () => ({releaseRunGhConfig: vi.fn(async () => undefined)}))
vi.mock('./phases/cleanup.js', () => ({runCleanup: vi.fn()}))
vi.mock('./phases/coordination-decline.js', () => ({runCoordinationDecline: vi.fn().mockResolvedValue(undefined)}))
vi.mock('./phases/coordination-clear.js', () => ({runBlockedLabelClear: vi.fn().mockResolvedValue(undefined)}))
vi.mock('./phases/dedup.js', () => ({runDedup: vi.fn(), saveDedupMarker: vi.fn()}))
vi.mock('./phases/acquire-lock.js', () => ({runAcquireLock: vi.fn()}))
vi.mock('./phases/execute.js', () => ({
  computeDrainDeadlineMs: vi.fn(() => 60_000),
  runExecute: vi.fn(),
  resolveRequestedOutputModeState: vi.fn(() => 'omitted'),
}))
vi.mock('./phases/finalize.js', () => ({runFinalize: vi.fn(), runFinalizeWithResult: vi.fn()}))
vi.mock('./phases/release-v2.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./phases/release-v2.js')>()),
  runReleaseV2: vi.fn(),
}))
vi.mock('./phases/review-reconciliation.js', () => ({runReviewReconciliation: vi.fn()}))
vi.mock('../services/github/review-delivery-receipt.js', () => ({
  createReviewDeliveryReceiptOperations: vi.fn(() => ({reserve: vi.fn(), recordDelivered: vi.fn(), release: vi.fn()})),
}))
vi.mock('./phases/routing.js', () => ({runRouting: vi.fn()}))
// The real launch unless a row says a relay is live: the supervisor needs the relay bundle and a child process.
vi.mock('./phases/trace-relay-process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./phases/trace-relay-process.js')>()
  return {...actual, createTraceRelayLaunch: vi.fn(actual.createTraceRelayLaunch)}
})
vi.mock('./phases/session-prep.js', () => ({runSessionPrep: vi.fn()}))

let target: OtlpSink
const sinks: OtlpSink[] = []

const MAIN_SECRET = 'mid-run-server-password-0xCAFE'
const RELAY_CREDENTIAL = 'Basic cmVsYXktY2FuYXJ5OnJlbGF5LXNlY3JldA=='

interface RunPlan {
  /** `forward-trace-inputs`: the fixture takes the trace inputs `run` hands bootstrap, as the real bootstrap does. */
  readonly bootstrap?: 'null' | 'real-parser' | 'forward-trace-inputs'
  readonly routing?: 'skip'
  readonly repo?: {readonly owner: string; readonly repo: string}
  readonly dedup?: 'duplicate'
  readonly lock?: 'held-by-other' | 'error'
  readonly cacheRestore?: 'null'
  readonly execute?: 'timeout' | 'throw-with-secret' | 'throws-in-session-prep'
  readonly sandboxRestore?: 'unsafe'
  readonly cleanup?: 'throws'
  readonly cacheSaveOutcome?: 'persisted'
  readonly traced?: boolean
  /** A trace relay that starts and stays up: the run's launcher host is then on, with the run's link. */
  readonly relay?: 'live'
  /** A dispatched run, whose logical key ends in the job's identity: a long job id makes the session id past 200 characters. */
  readonly dispatch?: true
}

function triggerContext(repo: {owner: string; repo: string}, dispatch = false): TriggerContext {
  return {
    eventType: dispatch ? 'workflow_dispatch' : 'issue_comment',
    eventName: dispatch ? 'workflow_dispatch' : 'issue_comment',
    repo,
    ref: 'refs/heads/main',
    sha: 'sha',
    runId: 77,
    actor: 'actor',
    action: 'created',
    author: {login: 'author', association: 'MEMBER', isBot: false},
    target: {kind: 'issue', number: 42, title: 't', body: null, locked: false},
    commentBody: '@fro-bot hi',
    commentId: 9,
    hasMention: true,
    command: null,
    isBotReviewRequested: false,
    raw: {},
  } as unknown as TriggerContext
}

function createBootstrap(
  sandbox?: SandboxLifecycle,
  tracing?: BootstrapPhaseResult['inputs']['tracing'],
): BootstrapPhaseResult {
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
      tracing: tracing ?? {enabled: false},
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

function createRouting(repo: {owner: string; repo: string}, dispatch = false): RoutingPhaseResult {
  return {
    githubClient: {} as RoutingPhaseResult['githubClient'],
    triggerResult: {shouldProcess: true, context: triggerContext(repo, dispatch)},
    agentContext: {
      eventName: 'issue_comment',
      repo: `${repo.owner}/${repo.repo}`,
      ref: 'refs/heads/main',
      actor: 'actor',
      runId: '77',
      issueNumber: 42,
      issueTitle: 't',
      issueType: 'issue',
      commentBody: null,
      commentAuthor: null,
      commentId: null,
      defaultBranch: 'main',
      diffContext: null,
      hydratedContext: null,
      authorAssociation: 'MEMBER',
      isRequestedReviewer: false,
    },
    botLogin: 'fro-bot',
  }
}

function serverHandle(): OpenCodeV2ServerHandle {
  return {
    url: 'http://127.0.0.1:1',
    shutdown: vi.fn(async () => ({
      interrupts: {stopped: [], notRunning: [], unconfirmed: []},
      exit: {outcome: 'graceful', code: 0, signal: null},
    })),
  } as unknown as OpenCodeV2ServerHandle
}

function fakeSandbox(restore: 'restored' | 'unsafe'): SandboxLifecycle {
  return {
    prepare: vi.fn(),
    launch: vi.fn(),
    release: vi.fn(async () => ({stop: 'stopped', restore, reason: restore === 'unsafe' ? 'files left' : undefined})),
    startKeyProxy: vi.fn(),
    registerSignalStop: vi.fn(),
  } as unknown as SandboxLifecycle
}

const DEFAULT_REPO = {owner: 'fro-bot', repo: 'agent'}

/** Mocks every phase for `plan`. */
async function arrange(plan: RunPlan): Promise<void> {
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
  const repo = plan.repo ?? DEFAULT_REPO
  const sandbox = plan.sandboxRestore === undefined ? undefined : fakeSandbox(plan.sandboxRestore)

  if (plan.bootstrap === 'null') vi.mocked(runBootstrap).mockResolvedValue(null)
  else if (plan.bootstrap === 'real-parser') {
    const actual = await vi.importActual<typeof import('./phases/bootstrap.js')>('./phases/bootstrap.js')
    vi.mocked(runBootstrap).mockImplementation(actual.runBootstrap)
  } else if (plan.bootstrap === 'forward-trace-inputs') {
    vi.mocked(runBootstrap).mockImplementation(async (_logger, options) => createBootstrap(sandbox, options?.tracing))
  } else {
    vi.mocked(runBootstrap).mockResolvedValue(
      createBootstrap(
        sandbox,
        plan.relay === 'live'
          ? {enabled: true, url: target.url, headers: [{name: 'Authorization', value: RELAY_CREDENTIAL}]}
          : undefined,
      ),
    )
  }
  const {createTraceRelayLaunch} = await import('./phases/trace-relay-process.js')
  const actualLaunch = await vi.importActual<typeof import('./phases/trace-relay-process.js')>(
    './phases/trace-relay-process.js',
  )
  if (plan.relay === 'live') {
    vi.mocked(createTraceRelayLaunch).mockReturnValue({
      start: async () => ({
        success: true,
        data: {
          pid: 1,
          port: 43_210,
          crashed: () => false,
          stop: async () => ({outcome: 'stopped', counts: 'incomplete'}),
        },
      }),
      stop: async () => undefined,
    } as unknown as ReturnType<typeof createTraceRelayLaunch>)
  } else vi.mocked(createTraceRelayLaunch).mockImplementation(actualLaunch.createTraceRelayLaunch)

  if (plan.routing === 'skip') {
    const skipped: RoutingPhaseSkip = {
      skipped: true,
      skipReason: 'no_mention',
      skipMessage: 'nothing to do',
      context: triggerContext(repo),
    }
    vi.mocked(runRouting).mockResolvedValue(skipped)
  } else vi.mocked(runRouting).mockResolvedValue(createRouting(repo, plan.dispatch === true))

  vi.mocked(runDedup).mockResolvedValue(
    plan.dedup === 'duplicate'
      ? {shouldProceed: false, entity: {entityType: 'issue', entityNumber: 42}}
      : {shouldProceed: true, entity: {entityType: 'issue', entityNumber: 42}},
  )
  if (plan.lock === 'held-by-other') {
    vi.mocked(runAcquireLock).mockResolvedValue({
      outcome: 'held-by-other',
      holder: null,
      reason: 'held',
    } as unknown as Awaited<ReturnType<typeof runAcquireLock>>)
  } else if (plan.lock === 'error') {
    vi.mocked(runAcquireLock).mockResolvedValue({
      outcome: 'error',
      error: new Error('lock store unreachable'),
    } as unknown as Awaited<ReturnType<typeof runAcquireLock>>)
  } else vi.mocked(runAcquireLock).mockResolvedValue({outcome: 's3-disabled'})
  vi.mocked(runAcknowledge).mockResolvedValue({
    repo: `${repo.owner}/${repo.repo}`,
    commentId: 9,
    issueNumber: 42,
    issueType: 'issue',
    botLogin: 'fro-bot',
  })

  const cacheRestore: CacheRestorePhaseResult = {
    cacheResult: {hit: false, key: 'k', restoredPath: null, corrupted: false, source: null},
    cacheStatus: 'miss',
    serverHandle: serverHandle(),
  }
  vi.mocked(runCacheRestore).mockImplementation(
    async (_bootstrap, _metrics, _skills, _tracing, trace?: CacheRestoreTrace) => {
      // What the real phase does mid-start: the server password is minted and masked through the run's registry.
      trace?.registry.mask(MAIN_SECRET)
      const server = trace?.span.startChild('server start')
      if (plan.cacheRestore === 'null') {
        server?.end({outcome: 'failed', reason: 'spawn-failed'})
        return null
      }
      server?.end({outcome: 'succeeded'})
      return cacheRestore
    },
  )
  if (plan.execute === 'throws-in-session-prep') vi.mocked(runSessionPrep).mockRejectedValue(new Error('prep exploded'))
  else {
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
  }
  const ledger = {outstanding: () => 0, unknown: () => 0} as unknown as OwnershipLedger
  const executed = {
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
    resolvedOutputMode: 'working-dir' as const,
    outputModeMigration: {requested: 'omitted' as const, resolved: 'working-dir' as const},
    observationGap: false,
    recoveryBoundaryUnresolved: false,
    executionDurationMs: 10,
    ownershipLedger: ledger,
  }
  if (plan.execute === 'throw-with-secret') {
    vi.mocked(runExecute).mockRejectedValue(new Error(`server rejected the password ${MAIN_SECRET}`))
  } else if (plan.execute === 'timeout') {
    vi.mocked(runExecute).mockResolvedValue({
      ...executed,
      success: false,
      exitCode: 1,
      error: 'OpenCode prompt exceeded the execution deadline',
    })
  } else vi.mocked(runExecute).mockResolvedValue(executed)
  vi.mocked(runReviewReconciliation).mockResolvedValue({reconciled: false, reason: 'not-applicable'})
  vi.mocked(runFinalizeWithResult).mockResolvedValue({
    exitCode: plan.execute === 'timeout' ? 1 : 0,
    deliveryKind: 'none',
  })
  if (plan.cleanup === 'throws') vi.mocked(runCleanup).mockRejectedValue(new Error('cleanup boom'))
  else {
    vi.mocked(runCleanup).mockResolvedValue({
      quiescenceConfirmed: true,
      continuityUnverified: false,
      ...(plan.cacheSaveOutcome === undefined ? {} : {cacheSaveOutcome: plan.cacheSaveOutcome}),
    })
  }
  vi.mocked(runReleaseV2).mockResolvedValue({
    drain: {expired: false, cancelledCount: 0, settledCount: 0, unknownCount: 0},
    persistenceDeclineReason: undefined,
  })
}

// ---- reading what the receiver got ------------------------------------------------------------------------------------

interface Decoded {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly startTimeUnixNano: string
  readonly attributes: {key: string; value: Record<string, unknown>}[]
  readonly status?: {code?: number}
  readonly events?: {name: string; attributes?: {key: string; value: Record<string, unknown>}[]}[]
}

const spansOf = (request: SinkRequest): Decoded[] =>
  (request.body as {resourceSpans: {scopeSpans: {spans: Decoded[]}[]}[]}).resourceSpans.flatMap(resource =>
    resource.scopeSpans.flatMap(scope => scope.spans),
  )
const allSpans = (target: OtlpSink): Decoded[] => target.accepted().flatMap(spansOf)
const attr = (span: Decoded, key: string): unknown => {
  const value = span.attributes.find(item => item.key === key)?.value
  return value === undefined ? undefined : (value.stringValue ?? value.intValue ?? value.boolValue)
}
const rootOf = (spans: readonly Decoded[]): Decoded => {
  const found = spans.find(span => span.name === 'action.main')
  if (found === undefined) throw new Error('no root span')
  return found
}
/** The names of the spans directly under the root, in the order they started. */
const phaseNames = (spans: readonly Decoded[]): string[] => {
  const root = rootOf(spans)
  return spans
    .filter(span => span.parentSpanId === root.spanId)
    .toSorted((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1))
    .map(span => span.name)
}
const byName = (spans: readonly Decoded[], name: string): Decoded => {
  const found = spans.find(span => span.name === name)
  if (found === undefined) throw new Error(`no span named ${name}`)
  return found
}

async function execute(plan: RunPlan = {}): Promise<{exitCode: number; spans: Decoded[]}> {
  await arrange(plan)
  const exitCode = await run()
  return {exitCode, spans: allSpans(target)}
}

const anyNumber: unknown = expect.any(Number)
const anyString: unknown = expect.any(String)

const FULL_RUN = [
  'bootstrap',
  'routing',
  'dedup',
  'coordination lock',
  'acknowledge',
  'repo skills',
  'trace relay start',
  'cache restore',
  'session prep',
  'execution',
  'release',
  'review reconciliation',
  'finalize',
  'cleanup',
  'report',
]

describe('run with lifecycle tracing', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    loggers.all.length = 0
    inputs.values.clear()
    inputs.state.clear()
    target = await startOtlpSink()
    sinks.push(target)
    inputs.values.set('trace-endpoint', target.url)
    vi.stubEnv('GITHUB_REPOSITORY', 'fro-bot/agent')
    vi.stubEnv('GITHUB_RUN_ID', '77')
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '1')
    vi.stubEnv('GITHUB_EVENT_NAME', 'issue_comment')
    vi.stubEnv('GITHUB_JOB', 'triage')
    vi.stubEnv('GITHUB_REF_NAME', 'main')
  })

  afterEach(async () => {
    resetRunCancellation()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await Promise.all(sinks.splice(0).map(async sink => sink.stop()))
  })

  describe('a full run', () => {
    it('produces the phase spans in order under one root, with the outcome, the save result and the exit code on the root', async () => {
      // #given
      // #when
      const {exitCode, spans} = await execute({cacheSaveOutcome: 'persisted'})

      // #then
      expect(exitCode).toBe(0)
      expect(phaseNames(spans)).toEqual(FULL_RUN)
      expect(new Set(spans.map(span => span.traceId)).size).toBe(1)
      const root = rootOf(spans)
      expect(attr(root, 'fro_bot.outcome')).toBe('succeeded')
      expect(attr(root, 'fro_bot.cache.save_result')).toBe('persisted')
      expect(attr(root, 'fro_bot.exit_code')).toBe(0)
      expect(attr(byName(spans, 'cache restore'), 'fro_bot.reason')).toBe('miss')
      // The server start, which the real phase opens under the cache restore span, is its child.
      expect(byName(spans, 'server start').parentSpanId).toBe(byName(spans, 'cache restore').spanId)
    })

    it('records the final writes as a report span after cleanup, not under finalize', async () => {
      // #given / #when
      const {spans} = await execute()

      // #then
      const names = phaseNames(spans)
      expect(names.indexOf('report')).toBeGreaterThan(names.indexOf('cleanup'))
      expect(names.indexOf('cleanup')).toBeGreaterThan(names.indexOf('finalize'))
      expect(spans.filter(span => span.parentSpanId === byName(spans, 'finalize').spanId)).toEqual([])
    })

    it('records the dedup result, the lock result and the execution gate as events on their phases', async () => {
      // #given / #when
      const {spans} = await execute()

      // #then
      const eventAttr = (span: Decoded, name: string, key: string): unknown =>
        span.events?.find(event => event.name === name)?.attributes?.find(item => item.key === key)?.value.stringValue
      const eventResult = (span: Decoded, name: string): unknown => eventAttr(span, name, 'fro_bot.result')
      expect(eventResult(byName(spans, 'dedup'), 'dedup.result')).toBe('proceed')
      expect(eventResult(byName(spans, 'coordination lock'), 'lock.result')).toBe('s3-disabled')
      expect(eventResult(byName(spans, 'review reconciliation'), 'gate.decision')).toBe('clear')
      expect(eventAttr(byName(spans, 'review reconciliation'), 'gate.decision', 'fro_bot.gate')).toBe('execution-veto')
      // #and the bare names are not used: the collector's keep-list is one global list, so a key a span carries must be ours
      for (const span of spans) {
        for (const event of span.events ?? []) {
          const keys = (event.attributes ?? []).map(item => item.key)
          expect(keys).not.toContain('gate')
          expect(keys).not.toContain('result')
        }
      }
    })
  })

  describe('the early-exit matrix', () => {
    const upTo = (last: string): string[] => FULL_RUN.slice(0, FULL_RUN.indexOf(last) + 1)

    it('bootstrap returns null: bootstrap, cleanup, report; exit 1', async () => {
      const {exitCode, spans} = await execute({bootstrap: 'null'})
      expect(exitCode).toBe(1)
      expect(phaseNames(spans)).toEqual(['bootstrap', 'cleanup', 'report'])
      expect(attr(byName(spans, 'bootstrap'), 'fro_bot.outcome')).toBe('failed')
      expect(attr(rootOf(spans), 'fro_bot.outcome')).toBe('failed')
      expect(attr(rootOf(spans), 'fro_bot.exit_code')).toBe(1)
    })

    it('a routing skip: bootstrap, routing, cleanup, report; exit 0, outcome skipped with the reason on routing and the root', async () => {
      const {exitCode, spans} = await execute({routing: 'skip'})
      expect(exitCode).toBe(0)
      expect(phaseNames(spans)).toEqual(['bootstrap', 'routing', 'cleanup', 'report'])
      for (const span of [byName(spans, 'routing'), rootOf(spans)]) {
        expect(attr(span, 'fro_bot.outcome')).toBe('skipped')
        expect(attr(span, 'fro_bot.reason')).toBe('no_mention')
      }
      expect(byName(spans, 'routing').status?.code ?? 0).toBe(0)
    })

    it('a dedup skip: through dedup, cleanup, report; exit 0', async () => {
      const {exitCode, spans} = await execute({dedup: 'duplicate'})
      expect(exitCode).toBe(0)
      expect(phaseNames(spans)).toEqual([...upTo('dedup'), 'cleanup', 'report'])
      expect(attr(rootOf(spans), 'fro_bot.reason')).toBe('duplicate')
    })

    it('a held lock: through the lock, cleanup, report; exit 0', async () => {
      const {exitCode, spans} = await execute({lock: 'held-by-other'})
      expect(exitCode).toBe(0)
      expect(phaseNames(spans)).toEqual([...upTo('coordination lock'), 'cleanup', 'report'])
      expect(attr(byName(spans, 'coordination lock'), 'fro_bot.reason')).toBe('held-by-other')
    })

    it('a lock error: through the lock, cleanup, report; exit 1, with the error on the lock span', async () => {
      const {exitCode, spans} = await execute({lock: 'error'})
      expect(exitCode).toBe(1)
      expect(phaseNames(spans)).toEqual([...upTo('coordination lock'), 'cleanup', 'report'])
      const lock = byName(spans, 'coordination lock')
      expect(lock.status?.code).toBe(2)
      expect(lock.events?.some(event => event.name === 'exception')).toBe(true)
    })

    it('a cache restore that returns null: through cache restore with its failed server start, cleanup, report; exit 1', async () => {
      const {exitCode, spans} = await execute({cacheRestore: 'null'})
      expect(exitCode).toBe(1)
      expect(phaseNames(spans)).toEqual([...upTo('cache restore'), 'cleanup', 'report'])
      expect(attr(byName(spans, 'cache restore'), 'fro_bot.outcome')).toBe('failed')
      expect(attr(byName(spans, 'server start'), 'fro_bot.outcome')).toBe('failed')
    })

    it('an execution timeout: execution failed with reason timeout, the later phases reached, cleanup, report; exit 1', async () => {
      const {exitCode, spans} = await execute({execute: 'timeout'})
      expect(exitCode).toBe(1)
      expect(phaseNames(spans)).toEqual(FULL_RUN)
      const execution = byName(spans, 'execution')
      expect(attr(execution, 'fro_bot.outcome')).toBe('failed')
      expect(attr(execution, 'fro_bot.reason')).toBe('timeout')
      expect(attr(rootOf(spans), 'fro_bot.exit_code')).toBe(1)
    })

    it('a sandbox that was not restored: through the failed take-back, cleanup, report; exit 1', async () => {
      const {exitCode, spans} = await execute({sandboxRestore: 'unsafe'})
      expect(exitCode).toBe(1)
      expect(phaseNames(spans)).toEqual([...upTo('release'), 'isolation take-back', 'cleanup', 'report'])
      const takeBack = byName(spans, 'isolation take-back')
      expect(attr(takeBack, 'fro_bot.outcome')).toBe('failed')
      expect(attr(takeBack, 'fro_bot.reason')).toBe('not-restored')
      expect(takeBack.events?.some(event => event.name === 'exception')).toBe(true)
    })

    it('an uncaught throw: the reached spans, the exception on its span, cleanup and report; exit 1', async () => {
      const {exitCode, spans} = await execute({execute: 'throws-in-session-prep'})
      expect(exitCode).toBe(1)
      expect(phaseNames(spans)).toEqual([...upTo('cache restore'), 'session prep', 'release', 'cleanup', 'report'])
      const prep = byName(spans, 'session prep')
      expect(prep.status?.code).toBe(2)
      expect(prep.events?.some(event => event.name === 'exception')).toBe(true)
    })

    it('valid trace inputs with a missing required input give a traced bootstrap failure, through the real input parser', async () => {
      // #given the real parser, valid trace inputs and no github-token
      // #when
      const {exitCode, spans} = await execute({bootstrap: 'real-parser'})

      // #then
      const core = await import('@actions/core')
      expect(exitCode).toBe(1)
      expect(phaseNames(spans)).toEqual(['bootstrap', 'cleanup', 'report'])
      expect(attr(byName(spans, 'bootstrap'), 'fro_bot.outcome')).toBe('failed')
      // The endpoint was masked by the reader, through the registry, before the parser ran.
      expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith(target.url)
      expect(vi.mocked(core.setFailed)).toHaveBeenCalledWith(expect.stringContaining('Invalid inputs'))
    })

    it('an untraced run: missing trace inputs send nothing and save no identity record', async () => {
      // #given no trace-endpoint
      inputs.values.clear()

      // #when
      const {exitCode} = await execute()

      // #then
      const core = await import('@actions/core')
      expect(exitCode).toBe(0)
      expect(target.received()).toBe(0)
      expect(vi.mocked(core.saveState).mock.calls.map(call => call[0])).not.toContain('lifecycleTrace')
    })
  })

  describe.skipIf(!opensslAvailable())('an Authorization header with no credential, against an https collector', () => {
    // A valid https endpoint, so the input rules do not refuse it for the endpoint; the TLS sink counts every connection the
    // run opens to it, a refused handshake included, so "nothing sent" is a count of zero connections, not an absent body.
    let tls: TlsSink

    beforeEach(async () => {
      tls = await startTlsSink()
      inputs.values.set('trace-endpoint', tls.url)
    })

    afterEach(async () => {
      await tls.stop()
    })

    /** The trace inputs reach bootstrap as `run` hands them, and the relay would start if tracing were on. */
    const PLAN = {bootstrap: 'forward-trace-inputs', relay: 'live'} as const

    /** The host the server start was given, which is what decides the traced plugin config and the launcher document. */
    const launcherOf = async (): Promise<{host: ReturnType<typeof resolveActionTracing>; document: unknown}> => {
      const {runCacheRestore} = await import('./phases/cache-restore.js')
      const source = vi.mocked(runCacheRestore).mock.calls[0]?.[3]
      if (source === undefined) throw new Error('the server start was never reached')
      const host = resolveActionTracing(source)
      return {host, document: JSON.parse(buildTracingLauncherValue(host))}
    }
    const traceWarnings = async (): Promise<unknown[][]> => {
      const core = await import('@actions/core')
      return vi.mocked(core.warning).mock.calls.filter(call => String(call[0]).includes('trace-headers'))
    }

    it('starts no relay and gives OpenCode the tracing-off launcher, and nothing reaches the collector', async () => {
      // #given a secret that was unset, so trace-headers is only `Authorization: Bearer`
      inputs.values.set('trace-headers', 'Authorization: Bearer')

      // #when
      const {exitCode} = await execute(PLAN)

      // #then the relay is never launched (the fixture would have started one if tracing were on)
      const {createTraceRelayLaunch} = await import('./phases/trace-relay-process.js')
      expect(exitCode).toBe(0)
      expect(createTraceRelayLaunch).not.toHaveBeenCalled()
      // #and the server start gets the exact off document, so the plugin is not placed last for tracing
      const {host, document} = await launcherOf()
      expect(host).toBe(ACTION_TRACING_OFF)
      expect(document).toEqual(JSON.parse(buildTracingLauncherValue(ACTION_TRACING_OFF)))
      // #and no lifecycle export and no identity record, so no connection to the collector at all
      expect(tls.connections()).toBe(0)
      expect(target.received()).toBe(0)
      const core = await import('@actions/core')
      expect(vi.mocked(core.saveState).mock.calls.map(call => call[0])).not.toContain('lifecycleTrace')
      // #and one warning, with no value in it
      expect(await traceWarnings()).toEqual([
        ['trace-headers has an Authorization header with no credential (is the secret set?), so tracing is off'],
      ])
    })

    it('is on for the same endpoint with a credential: the relay is launched, the host is on, and the run exports', async () => {
      // #given the same endpoint and a real token (the control: without the rejection, the run looks like this)
      inputs.values.set('trace-headers', 'Authorization: Bearer abc')

      // #when
      await execute(PLAN)

      // #then
      const {createTraceRelayLaunch} = await import('./phases/trace-relay-process.js')
      expect(createTraceRelayLaunch).toHaveBeenCalledTimes(1)
      expect((await launcherOf()).host).toMatchObject({host: 'action', tracing: 'on'})
      expect(tls.connections()).toBeGreaterThan(0)
      expect(await traceWarnings()).toEqual([])
    })

    it('hands the post step only the state main saved, and the post step sends nothing and warns no second time', async () => {
      // #given a main step that ran with the unset secret
      inputs.values.set('trace-headers', 'Authorization: Bearer')
      await execute(PLAN)

      // #when the post step starts from what main saved (the state map is filled by main's own saveState calls)
      const {startPostTrace} = await import('./post-trace.js')
      const postLogger = createMockLogger()
      const post = startPostTrace({logger: postLogger, env: {}})
      await post.finish({outcome: 'succeeded'})

      // #then main saved no trace identity, so post is off, connects to nothing, and says nothing more
      expect(inputs.state.has('lifecycleTrace')).toBe(false)
      expect(post.enabled).toBe(false)
      expect(tls.connections()).toBe(0)
      expect(target.received()).toBe(0)
      expect(await traceWarnings()).toEqual([
        ['trace-headers has an Authorization header with no credential (is the secret set?), so tracing is off'],
      ])
      expect(vi.mocked(postLogger.warning)).not.toHaveBeenCalled()
    })
  })

  describe('the session', () => {
    const sessionOf = (spans: readonly Decoded[]): unknown => attr(rootOf(spans), 'langfuse.session.id')

    it('a routing skip carries the session; a bootstrap failure carries the run identity and no session', async () => {
      // #given / #when
      const skipped = await execute({routing: 'skip'})
      const failedTarget = await startOtlpSink()
      sinks.push(failedTarget)
      inputs.values.set('trace-endpoint', failedTarget.url)
      await arrange({bootstrap: 'null'})
      await run()
      const failed = allSpans(failedTarget)

      // #then
      expect(sessionOf(skipped.spans)).toBe('fro-bot/agent:issue-42')
      for (const span of skipped.spans) expect(attr(span, 'langfuse.session.id')).toBe('fro-bot/agent:issue-42')
      expect(sessionOf(failed)).toBeUndefined()
      expect(attr(rootOf(failed), 'fro_bot.repository')).toBe('fro-bot/agent')
      expect(attr(rootOf(failed), 'fro_bot.run.id')).toBe('77')
      expect(attr(rootOf(failed), 'fro_bot.job')).toBe('triage')
    })

    it('two repositories each run twice on issue 42: each repository’s runs share a session, and the sessions differ', async () => {
      // #given four runs, two per repository
      const sessions = new Map<string, Set<unknown>>()
      for (const repo of [
        {owner: 'fro-bot', repo: 'agent'},
        {owner: 'fro-bot', repo: 'other'},
        {owner: 'fro-bot', repo: 'agent'},
        {owner: 'fro-bot', repo: 'other'},
      ]) {
        const before = target.accepted().length
        await arrange({repo})
        await run()
        const spans = target.accepted().slice(before).flatMap(spansOf)
        const seen = sessions.get(repo.repo) ?? new Set<unknown>()
        seen.add(sessionOf(spans))
        for (const span of spans) seen.add(attr(span, 'langfuse.session.id'))
        sessions.set(repo.repo, seen)
      }

      // #then
      expect([...(sessions.get('agent') ?? [])]).toEqual(['fro-bot/agent:issue-42'])
      expect([...(sessions.get('other') ?? [])]).toEqual(['fro-bot/other:issue-42'])
    })
  })

  describe('the launcher’s link to the lifecycle trace', () => {
    /** The host the server start was given, as the plugin would read it from the launcher document. */
    const launcherOf = async (): Promise<{host: ReturnType<typeof resolveActionTracing>; document: unknown}> => {
      const {runCacheRestore} = await import('./phases/cache-restore.js')
      const source = vi.mocked(runCacheRestore).mock.calls[0]?.[3]
      if (source === undefined) throw new Error('the server start was never reached')
      const host = resolveActionTracing(source)
      return {host, document: JSON.parse(buildTracingLauncherValue(host))}
    }
    const sessionsOf = (spans: readonly Decoded[]): Set<unknown> =>
      new Set(spans.map(span => attr(span, 'langfuse.session.id')))

    it('carries the run’s session id, invocation id and root span context, and the lifecycle spans carry the same session', async () => {
      // #given a run with a live relay
      const {spans} = await execute({relay: 'live'})

      // #when the launcher document the server start was given is read
      const {document} = await launcherOf()

      // #then it names the lifecycle root (trace id and root span id), the invocation id and the one session
      const root = rootOf(spans)
      expect(document).toMatchObject({
        host: 'action',
        tracing: 'on',
        rootSpan: {traceId: root.traceId, spanId: root.spanId},
        sessionId: 'fro-bot/agent:issue-42',
        invocationId: attr(root, 'fro_bot.invocation.id'),
      })
      // #and every lifecycle span exported that very session
      expect(sessionsOf(spans)).toEqual(new Set(['fro-bot/agent:issue-42']))
    })

    it('saves the same value for the post step as the launcher and the lifecycle spans carry', async () => {
      // #given / #when
      const {spans} = await execute({relay: 'live'})
      const {document} = await launcherOf()
      const core = await import('@actions/core')
      const saved = vi
        .mocked(core.saveState)
        .mock.calls.filter(call => call[0] === 'lifecycleSession')
        .map((call): unknown => call[1])

      // #then
      expect(saved).toEqual(['fro-bot/agent:issue-42'])
      expect((document as {sessionId: string}).sessionId).toBe(saved[0])
      expect(attr(rootOf(spans), 'langfuse.session.id')).toBe(saved[0])
    })

    it('sends no session id from a run that fails before routing: no launcher, no session on any span, none in state', async () => {
      // #given a run whose bootstrap fails
      const {createTraceRelayLaunch} = await import('./phases/trace-relay-process.js')
      const {spans} = await execute({bootstrap: 'null', relay: 'live'})
      const core = await import('@actions/core')

      // #then the relay was never started, so no document was built; no span or state holds a session
      expect(createTraceRelayLaunch).not.toHaveBeenCalled()
      expect(sessionsOf(spans)).toEqual(new Set([undefined]))
      expect(vi.mocked(core.saveState).mock.calls.filter(call => call[0] === 'lifecycleSession')).toEqual([])
    })

    it('sends no session on either side, keeping the root span link, when no scrub-safe id exists', async () => {
      // #given secret-named variables that hold the candidate and its hash, so the scrubber knows each as a secret
      const candidate = 'fro-bot/agent:issue-42'
      const hashed = `sha256:${createHash('sha256').update(candidate, 'utf8').digest('hex').slice(0, 32)}`
      vi.stubEnv('FRO_TEST_ONE_SECRET', candidate)
      vi.stubEnv('FRO_TEST_TWO_SECRET', hashed)

      // #when
      const {spans} = await execute({relay: 'live'})
      const {document} = await launcherOf()
      const core = await import('@actions/core')

      // #then neither side holds a session; the link to the root and the invocation id stay
      expect(document).not.toHaveProperty('sessionId')
      expect(document).toMatchObject({rootSpan: {traceId: rootOf(spans).traceId}})
      expect(sessionsOf(spans)).toEqual(new Set([undefined]))
      expect(vi.mocked(core.saveState).mock.calls.filter(call => call[0] === 'lifecycleSession')).toEqual([])
    })

    it('bounds a session id past 200 characters the same way on the launcher and on the lifecycle spans', async () => {
      // #given a dispatched run whose job id is long enough to push `<owner>/<repo>:dispatch-<run>-<job>` past 200 characters
      const job = 'j'.repeat(TRACING_IDENTITY_FIELD_MAX_CHARS - 10)
      vi.stubEnv('GITHUB_JOB', job)
      const candidate = `fro-bot/agent:dispatch-77-${job}`
      expect(candidate.length).toBeGreaterThan(TRACING_IDENTITY_FIELD_MAX_CHARS)

      // #when
      const {spans} = await execute({relay: 'live', dispatch: true})
      const {document} = await launcherOf()

      // #then both carry the one hashed form
      const session = (document as {sessionId: string}).sessionId
      expect(session).toBe(`sha256:${createHash('sha256').update(candidate, 'utf8').digest('hex').slice(0, 32)}`)
      expect(sessionsOf(spans)).toEqual(new Set([session]))
    })

    it('hashes a session id the scrubber would redact, the same on both sides', async () => {
      // #given a repository named like a secret
      const repo = {owner: 'acme', repo: 'password-manager'}

      // #when
      const {spans} = await execute({relay: 'live', repo})
      const {document} = await launcherOf()

      // #then
      const session = (document as {sessionId: string}).sessionId
      expect(session).toMatch(/^sha256:[0-9a-f]{32}$/)
      expect(sessionsOf(spans)).toEqual(new Set([session]))
    })

    it('puts none of the trace input values in the launcher document or the saved state', async () => {
      // #given a relay request that holds a collector credential (the relay alone gets it)

      // #when
      await execute({relay: 'live'})
      const {document} = await launcherOf()
      const core = await import('@actions/core')

      // #then
      const everything = JSON.stringify([document, vi.mocked(core.saveState).mock.calls])
      for (const canary of [
        target.url,
        new URL(target.url).host,
        RELAY_CREDENTIAL,
        'cmVsYXktY2FuYXJ5OnJlbGF5LXNlY3JldA==',
      ]) {
        expect(everything).not.toContain(canary)
      }
    })

    it('adds nothing to the launcher of an untraced run', async () => {
      // #given no trace inputs
      inputs.values.clear()

      // #when
      await execute({relay: 'live'})
      const {runCacheRestore} = await import('./phases/cache-restore.js')
      const source = vi.mocked(runCacheRestore).mock.calls[0]?.[3]

      // #then a host with no link fields
      expect(source === undefined ? undefined : resolveActionTracing(source)).not.toHaveProperty('sessionId')
    })
  })

  describe('the root’s outcome and the final report writes', () => {
    it('ends the root failed, with exit code 1, when a final write throws, and lets the error go on', async () => {
      // #given a run that succeeds all the way to its last writes, one of which (the outputs) throws
      await arrange({cacheSaveOutcome: 'persisted'})
      const {setInvocationOutcomeOutput} = await import('./config/outputs.js')
      vi.mocked(setInvocationOutcomeOutput).mockImplementationOnce(() => {
        throw new Error('outputs file is gone')
      })

      // #when
      await expect(run()).rejects.toThrow('outputs file is gone')

      // #then the root does not say succeeded for a run that is about to fail: failed, with the exit code the process ends with
      const root = rootOf(allSpans(target))
      expect(attr(root, 'fro_bot.outcome')).toBe('failed')
      expect(attr(root, 'fro_bot.reason')).toBe('report-failed')
      expect(attr(root, 'fro_bot.exit_code')).toBe(1)
      expect(byName(allSpans(target), 'report').status?.code).toBe(2)
    })

    it('still ends the root with the run’s own outcome and exit code when the final writes succeed', async () => {
      // #given / #when
      const {exitCode, spans} = await execute({cacheSaveOutcome: 'persisted'})

      // #then
      expect(exitCode).toBe(0)
      expect(attr(rootOf(spans), 'fro_bot.outcome')).toBe('succeeded')
      expect(attr(rootOf(spans), 'fro_bot.exit_code')).toBe(0)
    })
  })

  describe('signals', () => {
    it('installs no signal handler of its own, traced or not: a run without isolation ends on a signal as it always did', async () => {
      // #given the handlers the process has before the run, and a bootstrap that looks at them
      const before = {int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM')}
      const during: {int: number; term: number}[] = []
      await arrange({})
      const {runBootstrap} = await import('./phases/bootstrap.js')
      vi.mocked(runBootstrap).mockImplementation(async () => {
        during.push({int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM')})
        return createBootstrap()
      })

      // #when the traced run completes
      await run()

      // #then no handler was added at any point, and none is left
      expect(during).toEqual([before])
      expect({int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM')}).toEqual(before)
    })

    it('hands bootstrap the trace hook the sandbox’s handler uses: it ends the open spans as cancelled and starts the one export', async () => {
      // #given a bootstrap that keeps the hook, and a phase that is open when the sandbox's handler calls it
      await arrange({})
      const {runBootstrap} = await import('./phases/bootstrap.js')
      let hook: {
        onSignal: (signal: 'SIGINT' | 'SIGTERM') => void
        flush: (options: {boundMs: number}) => Promise<unknown>
      }
      vi.mocked(runBootstrap).mockImplementation(async (_logger, options) => {
        if (options?.signalTrace === undefined) throw new Error('no signal trace handed to bootstrap')
        hook = options.signalTrace
        return createBootstrap()
      })
      const {runRouting} = await import('./phases/routing.js')
      const routing = vi.mocked(runRouting).getMockImplementation()
      vi.mocked(runRouting).mockImplementation(async (...args) => {
        hook.onSignal('SIGTERM')
        await hook.flush({boundMs: 2_000})
        return routing?.(...args) ?? Promise.reject(new Error('no routing'))
      })

      // #when
      await run()

      // #then the root and the phase that was open end cancelled, with the signal as the reason, in the one export
      expect(target.accepted()).toHaveLength(1)
      const spans = allSpans(target)
      expect(attr(rootOf(spans), 'fro_bot.outcome')).toBe('cancelled')
      expect(attr(rootOf(spans), 'fro_bot.reason')).toBe('sigterm')
      expect(attr(byName(spans, 'routing'), 'fro_bot.outcome')).toBe('cancelled')
    })
  })

  describe('a cancelled run admits no new work', () => {
    // The signal reaches an isolated run's sandbox handler inside a phase; the handler's first act is to mark the run cancelled
    // (`markRunCancelled`, synchronously), which is what these rows do. A run without isolation has no such handler and ends on
    // the signal at once, so it never reaches a refused phase (`signal-cancel.test.ts` runs that with real signals).
    type Phase =
      'bootstrap' | 'routing' | 'dedup' | 'lock' | 'acknowledge' | 'cache restore' | 'session prep' | 'execute'

    async function phaseMocks() {
      return {
        bootstrap: (await import('./phases/bootstrap.js')).runBootstrap,
        routing: (await import('./phases/routing.js')).runRouting,
        dedup: (await import('./phases/dedup.js')).runDedup,
        lock: (await import('./phases/acquire-lock.js')).runAcquireLock,
        acknowledge: (await import('./phases/acknowledge.js')).runAcknowledge,
        'cache restore': (await import('./phases/cache-restore.js')).runCacheRestore,
        'session prep': (await import('./phases/session-prep.js')).runSessionPrep,
        execute: (await import('./phases/execute.js')).runExecute,
      } as const
    }

    /** Makes `phase` raise SIGINT while it runs, then return what it returned before. */
    async function cancelDuring(phase: Phase): Promise<void> {
      const mocks = await phaseMocks()
      const target = vi.mocked(mocks[phase] as unknown as (...args: unknown[]) => Promise<unknown>)
      const original = target.getMockImplementation()
      target.mockImplementation(async (...args: unknown[]) => {
        markRunCancelled()
        return original?.(...args)
      })
    }

    it.each([
      ['bootstrap', 'routing'],
      ['routing', 'dedup'],
      ['dedup', 'lock'],
      ['lock', 'acknowledge'],
      ['acknowledge', 'cache restore'],
      ['cache restore', 'session prep'],
      ['session prep', 'execute'],
    ] as const)('starts nothing after a signal during %s: not even %s', async (during, next) => {
      // #given a run that is cancelled inside one of its phases
      await arrange({})
      await cancelDuring(during)

      // #when
      const exitCode = await run()

      // #then the next phase never ran, nor anything after it that sends or spawns
      const mocks = await phaseMocks()
      expect(vi.mocked(mocks[next] as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
      const {runExecute} = await import('./phases/execute.js')
      const {runFinalizeWithResult} = await import('./phases/finalize.js')
      const {runReviewReconciliation} = await import('./phases/review-reconciliation.js')
      expect(runExecute).not.toHaveBeenCalled()
      expect(runFinalizeWithResult).not.toHaveBeenCalled()
      expect(runReviewReconciliation).not.toHaveBeenCalled()
      // #and what the run owned was still let go: cleanup ran
      const {runCleanup} = await import('./phases/cleanup.js')
      expect(runCleanup).toHaveBeenCalledTimes(1)
      expect(exitCode).toBe(1)
      // #and no phase that never started has a span
      const names = allSpans(target).map(span => span.name)
      expect(names).not.toContain('execution')
      expect(names).not.toContain('finalize')
      expect(names).not.toContain('review reconciliation')
    })

    it('releases the server it already started and still runs cleanup, after a signal during session prep', async () => {
      // #given
      await arrange({})
      await cancelDuring('session prep')

      // #when
      await run()

      // #then the server the run started is released (a teardown phase is not refused) and cleanup runs
      const {runReleaseV2} = await import('./phases/release-v2.js')
      expect(runReleaseV2).toHaveBeenCalledTimes(1)
      const {runCleanup} = await import('./phases/cleanup.js')
      expect(runCleanup).toHaveBeenCalledTimes(1)
    })
  })

  describe('secrets and state', () => {
    it('redacts the server password minted mid-run from a later exception message, and masked it with GitHub too', async () => {
      // #given a start that mints a secret after the tracer exists, and a later throw that carries it
      // #when
      const {exitCode, spans} = await execute({execute: 'throw-with-secret'})

      // #then
      const core = await import('@actions/core')
      expect(exitCode).toBe(1)
      expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith(MAIN_SECRET)
      const text = target.requests.map(request => request.text).join('\n')
      expect(text).not.toContain(MAIN_SECRET)
      const exception = byName(spans, 'execution').events?.find(event => event.name === 'exception')
      expect(exception?.attributes?.find(item => item.key === 'exception.message')?.value.stringValue).toContain(
        '[REDACTED]',
      )
    })

    it('saves one identity record to Action state, with the three ids and nothing from any input', async () => {
      // #given a distinctive set of inputs
      inputs.values.set('github-token', 'ghp_stateCanary1234567890')
      inputs.values.set('auth-json', '{"anthropic":{"type":"api","key":"sk-state-canary-0987654321"}}')

      // #when
      const {spans} = await execute()

      // #then
      const core = await import('@actions/core')
      const records = vi.mocked(core.saveState).mock.calls.filter(call => call[0] === 'lifecycleTrace')
      expect(records).toHaveLength(1)
      const record = JSON.parse(String(records[0]?.[1])) as Record<string, string>
      expect(Object.keys(record).toSorted()).toEqual(['invocationId', 'rootSpanId', 'traceId'])
      expect(record.traceId).toBe(rootOf(spans).traceId)
      expect(record.rootSpanId).toBe(rootOf(spans).spanId)
      const saved = JSON.stringify(vi.mocked(core.saveState).mock.calls)
      for (const canary of [target.url, 'ghp_stateCanary1234567890', 'sk-state-canary-0987654321']) {
        expect(saved).not.toContain(canary)
      }
    })

    it('loses only the post step’s link, never the run, when the identity record cannot be saved', async () => {
      // #given Action state that refuses exactly the identity record
      const core = await import('@actions/core')
      vi.mocked(core.saveState).mockImplementation((name: string) => {
        if (name === 'lifecycleTrace') throw new Error('state file is read-only')
      })

      // #when
      const {exitCode, spans} = await execute().finally(() => {
        vi.mocked(core.saveState).mockReset()
      })

      // #then the run went all the way through, its trace was exported, and nothing was failed or logged as a failure
      expect(exitCode).toBe(0)
      expect(phaseNames(spans)).toEqual(FULL_RUN)
      expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled()
    })

    it('saves the session id for the post step once routing has named the conversation, and not before', async () => {
      // #given a run that routes, and one that fails in bootstrap
      const core = await import('@actions/core')
      const sessionRecords = (): unknown[] =>
        vi
          .mocked(core.saveState)
          .mock.calls.filter(call => call[0] === 'lifecycleSession')
          .map((call): unknown => call[1])

      // #when
      await execute({})
      const routed = sessionRecords()
      vi.mocked(core.saveState).mockClear()
      await execute({bootstrap: 'null'})
      const failed = sessionRecords()

      // #then
      expect(routed).toEqual(['fro-bot/agent:issue-42'])
      expect(failed).toEqual([])
    })

    it('flushes the reached spans when cleanup throws, and keeps the original error', async () => {
      // #given a cleanup that rejects
      // #when
      await arrange({cleanup: 'throws'})
      const outcome = await run().then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : 'other'),
      )

      // #then
      expect(outcome).toBe('cleanup boom')
      const spans = allSpans(target)
      expect(phaseNames(spans)).toEqual([...FULL_RUN.slice(0, FULL_RUN.indexOf('cleanup') + 1)])
      expect(byName(spans, 'cleanup').status?.code).toBe(2)
      expect(attr(rootOf(spans), 'fro_bot.outcome')).toBe('failed')
    })
  })

  describe('the root’s Langfuse summary', () => {
    const summaryKeys = [
      'langfuse.observation.input',
      'langfuse.observation.output',
      'langfuse.observation.level',
      'langfuse.observation.status_message',
    ]
    const parsed = (span: Decoded, key: string): unknown => JSON.parse(String(attr(span, key)))

    it('says what the run is and how it ended, on the root alone', async () => {
      // #given a full run of an issue comment on main
      // #when
      const {spans} = await execute({cacheSaveOutcome: 'persisted'})

      // #then
      const root = rootOf(spans)
      expect(parsed(root, 'langfuse.observation.input')).toEqual({
        trigger: 'issue_comment',
        event: 'issue_comment.created',
        repository: 'fro-bot/agent',
        ref: 'main',
        isolateAgent: false,
      })
      expect(parsed(root, 'langfuse.observation.output')).toEqual({
        outcome: 'succeeded',
        durationMs: anyNumber,
        phases: FULL_RUN.map(name => ({name, outcome: anyString, ms: anyNumber})),
      })
      expect(attr(root, 'langfuse.observation.level')).toBe('DEFAULT')
      // a run that went well has no reason to give
      expect(attr(root, 'langfuse.observation.status_message')).toBeUndefined()
      for (const span of spans.filter(item => item !== root))
        for (const key of summaryKeys) expect(attr(span, key)).toBeUndefined()
    })

    it('records that the run asked for isolation', async () => {
      // #given
      inputs.values.set('isolate-agent', 'true')

      // #when
      const {spans} = await execute({})

      // #then
      expect(parsed(rootOf(spans), 'langfuse.observation.input')).toMatchObject({isolateAgent: true})
    })

    it('keeps the input and the skip reason for a run that routing skipped', async () => {
      // #given / #when
      const {spans} = await execute({routing: 'skip'})

      // #then the event is known even though the run stopped there
      const root = rootOf(spans)
      expect(parsed(root, 'langfuse.observation.input')).toMatchObject({event: 'issue_comment.created'})
      expect(attr(root, 'langfuse.observation.level')).toBe('WARNING')
      expect(attr(root, 'langfuse.observation.status_message')).toBe('no_mention')
      expect(parsed(root, 'langfuse.observation.output')).toMatchObject({outcome: 'skipped', reason: 'no_mention'})
    })

    it('marks a failed run as an error', async () => {
      // #given / #when
      const {spans} = await execute({bootstrap: 'null'})

      // #then
      const root = rootOf(spans)
      expect(attr(root, 'langfuse.observation.level')).toBe('ERROR')
      expect(parsed(root, 'langfuse.observation.output')).toMatchObject({
        outcome: 'failed',
        phases: [{name: 'bootstrap', outcome: 'failed'}, {name: 'cleanup'}, {name: 'report'}],
      })
    })

    it('says cancelled, as a warning, for a run a signal ended', async () => {
      // #given a signal that arrives while routing is open
      await arrange({})
      const {runBootstrap} = await import('./phases/bootstrap.js')
      let hook: {
        onSignal: (signal: 'SIGINT' | 'SIGTERM') => void
        flush: (options: {boundMs: number}) => Promise<unknown>
      }
      vi.mocked(runBootstrap).mockImplementation(async (_logger, options) => {
        if (options?.signalTrace === undefined) throw new Error('no signal trace handed to bootstrap')
        hook = options.signalTrace
        return createBootstrap()
      })
      const {runRouting} = await import('./phases/routing.js')
      const routing = vi.mocked(runRouting).getMockImplementation()
      vi.mocked(runRouting).mockImplementation(async (...args) => {
        hook.onSignal('SIGINT')
        await hook.flush({boundMs: 2_000})
        return routing?.(...args) ?? Promise.reject(new Error('no routing'))
      })

      // #when
      await run()

      // #then
      const root = rootOf(allSpans(target))
      expect(attr(root, 'langfuse.observation.level')).toBe('WARNING')
      expect(attr(root, 'langfuse.observation.status_message')).toBe('sigint')
      expect(parsed(root, 'langfuse.observation.output')).toMatchObject({
        outcome: 'cancelled',
        reason: 'sigint',
        phases: [
          {name: 'bootstrap', outcome: 'succeeded'},
          {name: 'routing', outcome: 'cancelled'},
        ],
      })
    })
  })
})
