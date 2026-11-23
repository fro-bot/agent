import type {
  ObjectStoreConfig,
  OpenCodeV2ServerHandle,
  OutputModeMigrationState,
  OutputModeRequestState,
  OwnershipLedger,
  ResponseMode,
} from '@fro-bot/runtime'
import type {ReactionContext} from '../features/agent/types.js'
import type {AttachmentResult} from '../features/attachments/index.js'
import type {InvocationSkipDetail} from '../features/observability/index.js'
import type {TriggerContext} from '../features/triggers/types.js'
import type {DeduplicationEntity} from '../services/cache/dedup.js'
import type {Octokit} from '../services/github/types.js'
import type {CacheSaveOutcome} from '../shared/cache-save-result.js'
import type {LifecycleSpan, LifecycleTracer, SpanResult} from '../shared/lifecycle-tracer.js'
import type {Logger} from '../shared/logger.js'
import type {SecretRegistry} from '../shared/secret-registry.js'
import type {TracingInputs} from '../shared/types.js'
import type {InvocationOutcome, InvocationVerificationFacts} from './outcome.js'
import type {SandboxLifecycle, SandboxReleaseResult} from './phases/sandbox-lifecycle.js'
import process from 'node:process'
import * as core from '@actions/core'
import {buildLogicalKey} from '@fro-bot/runtime'
import {applyTerminalReaction} from '../features/agent/index.js'
import {createMetricsCollector, writeInvocationOutcomeSummary} from '../features/observability/index.js'
import {resolveReviewedHeadSha} from '../features/reviews/reviewed-head.js'
import {createReviewDeliveryReceiptOperations} from '../services/github/review-delivery-receipt.js'
import {
  buildActionTracingHost,
  buildTraceSessionId,
  buildTracingRunIdentity,
  buildTracingRunLink,
  liveActionTracingHost,
  readLifecycleRunIdentity,
  relayRequestFromInputs,
  type ActionTracingSource,
} from '../services/setup/tracing.js'
import {getGitHubRunAttempt, getInvocationIdentity, getOpenCodeLogPath} from '../shared/env.js'
import {toErrorMessage} from '../shared/errors.js'
import {createLifecycleTracer, createRegistryScrubber, freeText, withSpan} from '../shared/lifecycle-tracer.js'
import {createLogger} from '../shared/logger.js'
import {createSecretRegistry} from '../shared/secret-registry.js'
import {isIsolationRequested} from './config/inputs.js'
import {setActionOutputs, setInvocationOutcomeOutput} from './config/outputs.js'
import {STATE_KEYS} from './config/state-keys.js'
import {readTraceInputs} from './config/trace-inputs.js'
import {assessInvocationOutcome} from './outcome.js'
import {runAcknowledge} from './phases/acknowledge.js'
import {runAcquireLock, type LeaseController} from './phases/acquire-lock.js'
import {runBootstrap} from './phases/bootstrap.js'
import {resolveBrokeredPushPlan} from './phases/brokered-push-plan.js'
import {runCacheRestore} from './phases/cache-restore.js'
import {runCleanup} from './phases/cleanup.js'
import {runBlockedLabelClear} from './phases/coordination-clear.js'
import {runCoordinationDecline} from './phases/coordination-decline.js'
import {runDedup, saveDedupMarker} from './phases/dedup.js'
import {
  computeDrainDeadlineMs,
  resolveRequestedOutputModeState,
  runExecute,
  type ExecutePhaseResult,
} from './phases/execute.js'
import {runFinalizeWithResult} from './phases/finalize.js'
import {releaseRunGhConfig} from './phases/gh-config.js'
import {snapshotLogDirectory} from './phases/log-snapshot.js'
import {mergeObservedTurn, recordObservedTurn} from './phases/observed-turn-v2.js'
import {releaseOptionsFromExecution, runReleaseV2} from './phases/release-v2.js'
import {removeRepoSkillsStaging, runRepoSkills} from './phases/repo-skills.js'
import {runReviewReconciliation} from './phases/review-reconciliation.js'
import {runRouting} from './phases/routing.js'
import {runSessionPrep} from './phases/session-prep.js'
import {checkTraceRelayBundle} from './phases/trace-relay-bundle.js'
import {createTraceRelayLaunch, startTraceRelayProcess, type TraceRelayProcess} from './phases/trace-relay-process.js'
import {createSignalOwner, type SignalOwner} from './signal-owner.js'

const KEY_PROXY_CRASHED_DECLINE_REASON =
  'the isolate-agent key proxy exited unexpectedly, so the run is incomplete and no session state is saved'

/** Longest the run waits, at its very end, for the relay's stop to finish. The supervisor's own worst case is about 4.5 s. */
export const TRACE_RELAY_STOP_WAIT_MS = 6000

const TRACE_IDENTITY_WARNING =
  'Tracing is off: the run identity (repository, run, attempt, job and trigger) is incomplete'

const TRACE_EXPOSURE_WARNING =
  'Tracing is on without isolate-agent: the agent can read the collector credential and the content of every span'

/** What the run's trace needs from the run's body: the tracer and registry in, the facts the root span ends with out. */
interface RunTrace {
  readonly tracer: LifecycleTracer
  readonly registry: SecretRegistry
  /** The trace inputs `run` read first of everything, handed to bootstrap so it never reads them again. */
  readonly traceInputs: TracingInputs
  readonly signalOwner: SignalOwner
  /** Set by the body as it learns them; the root span ends with whatever is set when the body returns or throws. */
  readonly outcome: {
    rootResult: SpanResult
    cacheSaveOutcome: CacheSaveOutcome | null
    exitCode: number | null
  }
}

export async function run(): Promise<number> {
  const startTime = Date.now()
  const bootstrapLogger = createLogger({phase: 'bootstrap'})

  // First of everything, before bootstrap and before any input is validated: the secret registry (every mask site below goes
  // through it, so the lifecycle tracer's scrubber knows what GitHub was told to mask and what only the Action knows), then
  // the trace inputs, read, masked and removed from the environment, then the tracer. Bootstrap receives the inputs' result
  // and never reads them again. A run whose trace inputs are missing or refused is untraced from the start.
  const registry = createSecretRegistry(value => core.setSecret(value))
  registry.addSecretEnv(process.env)
  const traceInputs = readTraceInputs(
    {getInput: name => core.getInput(name)},
    {
      warning: message => core.warning(message),
      notice: message => core.notice(message),
      info: message => core.info(message),
      mask: value => registry.mask(value),
    },
  )
  const tracer = createLifecycleTracer({
    inputs: traceInputs,
    logger: bootstrapLogger,
    registry,
    identity: readLifecycleRunIdentity(process.env, getInvocationIdentity()),
  })
  // The identity record: the one thing the post step needs to join this trace, saved once and before routing. Ids only; no
  // input, credential or span content ever goes into Action state.
  if (tracer.ids !== null) core.saveState(STATE_KEYS.LIFECYCLE_TRACE, JSON.stringify(tracer.ids))
  const refName = process.env.GITHUB_REF_NAME?.trim() ?? ''
  if (refName !== '') tracer.root.setAttribute('fro_bot.ref', freeText(refName, 'ref'))

  // The one SIGINT/SIGTERM handler of the run, installed here (no await since the tracer was created, so no signal can arrive
  // unseen) for every run, isolated or not. It takes the exec adapter's signal ownership; the sandbox lifecycle registers its
  // teardown with it.
  const signalOwner = createSignalOwner({
    logger: bootstrapLogger,
    onCancel: signal => tracer.cancel(signal === 'SIGINT' ? 'sigint' : 'sigterm'),
    flush: async flushOptions => tracer.flush(flushOptions),
  })

  const trace: RunTrace = {
    tracer,
    registry,
    traceInputs,
    signalOwner,
    outcome: {rootResult: {outcome: 'failed', reason: 'exception'}, cacheSaveOutcome: null, exitCode: null},
  }
  try {
    return await runWithTrace(trace, startTime, bootstrapLogger)
  } finally {
    // The trace's last word, after everything else, so a throw from cleanup or from the final writes still sends what was
    // reached and changes neither the error nor the exit code. The root carries the run's final outcome, the cache save
    // result and the exit code the run returns. A flush never rejects.
    if (trace.outcome.exitCode !== null) tracer.root.setAttribute('fro_bot.exit_code', trace.outcome.exitCode)
    tracer.root.setAttribute('fro_bot.cache.save_result', trace.outcome.cacheSaveOutcome ?? 'not-run')
    tracer.root.end(trace.outcome.rootResult)
    // Normal completion and a signal share this one export (the tracer's flush is idempotent), and `main.ts` ends the process
    // only after `run()` returns, so it never exits before the export has settled or hit its bound.
    await tracer.flush()
    // A signal that is still being handled (its teardown running beside the finished run) ends the process itself, with the
    // signal's own exit. Wait for that rather than let `main.ts` exit first with the run's code.
    await signalOwner.drain()
    signalOwner.dispose()
  }
}

async function runWithTrace(trace: RunTrace, startTime: number, bootstrapLogger: Logger): Promise<number> {
  const {tracer, registry, traceInputs, signalOwner} = trace
  /** A phase of the run: a span from the moment the phase starts to the moment it returns or throws. */
  const phase = async <T>(
    name: string,
    work: (span: LifecycleSpan) => Promise<T>,
    classify?: (value: T) => SpanResult,
  ): Promise<T> => withSpan(tracer.startSpan(name), work, classify)
  /**
   * The one session id of the conversation, computed once right after routing (a skipped event included) and never again:
   * the lifecycle tracer's `langfuse.session.id`, the post step's, and the launcher's `sessionId` (so the turn spans) all take
   * this value. Undefined until routing has named the conversation, and for good when no scrub-safe id exists; neither trace
   * then sends a session.
   */
  let traceSessionId: string | undefined
  const bindTraceSession = (context: TriggerContext | undefined): void => {
    if (!tracer.enabled || context === undefined) return
    try {
      const logicalKey = buildLogicalKey(context, getInvocationIdentity())
      if (logicalKey == null) return
      tracer.root.setAttribute('fro_bot.logical_key', logicalKey.key)
      const sessionId = buildTraceSessionId(
        context.repo.owner,
        context.repo.repo,
        logicalKey.key,
        createRegistryScrubber(registry),
      )
      if (sessionId === undefined) return
      traceSessionId = sessionId
      tracer.setSessionId(sessionId)
      // For the post step's span. Saved here, once: routing is the first point the conversation is known.
      core.saveState(STATE_KEYS.LIFECYCLE_SESSION, sessionId)
    } catch {
      // Tracing never changes a run.
    }
  }

  const metrics = createMetricsCollector()
  metrics.start()

  // From the raw input, read before bootstrap: a bootstrap that fails (the runner preflight, the persisted-credential check,
  // an unparseable value) returns before any lifecycle exists, and cleanup must still treat the run as isolated.
  const isolationRequested = isIsolationRequested(core.getInput('isolate-agent'))

  let reactionCtx: ReactionContext | null = null
  let exitCode = 0
  let githubClient: Octokit | null = null
  let attachmentResult: AttachmentResult | null = null
  let serverHandleV2: OpenCodeV2ServerHandle | null = null
  // Set once the V2 server has been released (drained or stopped, then shut down). A run that left the try block without
  // reaching that point is released in the `finally` before cleanup.
  let serverReleasedV2 = false
  // The `isolate-agent` lifecycle, or null. Hoisted so the `finally` block stops and restores the sandbox on every path
  // that left the try block before the normal release did.
  let sandboxLifecycle: SandboxLifecycle | null = null
  // The trace relay, or null: tracing off, or a relay that did not start (which the supervisor has already warned about).
  // Hoisted for the same reason as the server handle: the `finally` block stops it on every path. Its death is never read
  // here, so it can neither abort the run nor feed the persistence decision.
  let traceRelay: TraceRelayProcess | null = null
  let traceRelayStopped: Promise<void> | undefined
  // Set once the normal path has released the sandbox and recorded its outcome, so the `finally` does not repeat it.
  let sandboxSettled = false
  // True once an isolated run's sandbox was not confirmed stopped and restored: everything the sandbox could write is
  // then untrusted, so cleanup and the post hook read and publish none of it.
  let sandboxOutputUntrusted = false
  // The lifecycle itself records the `unsafe` state for the post hook on every release that is not a confirmed restore.
  const markSandboxUntrusted = (): void => {
    sandboxOutputUntrusted = true
  }
  // True once a sandbox release left files the sandbox user may still own (`unsafe`, or a release that threw). Narrower than
  // `sandboxOutputUntrusted`: a sandbox that never started (`not-needed`) handed nothing over, so the `gh` config directory
  // is still the runner's own and is removed.
  let sandboxRestoreUnsafe = false
  const recordSandboxRelease = (outcome: SandboxReleaseResult): void => {
    if (outcome.restore === 'unsafe') sandboxRestoreUnsafe = true
  }
  // The runner-owned copy of the OpenCode logs this invocation took at its own confirmed sandbox take-back, or null. The
  // shared log directory is re-handed to every later isolated step's sandbox, so an isolated run publishes only this.
  let logSnapshotPath: string | null = null
  // Called only after a release that reported `restored`. A sandbox that never started reports `not-needed` instead: it ran
  // nothing, so there is nothing of this invocation's to copy and no snapshot exists.
  const snapshotSandboxLogs = async (): Promise<void> => {
    const runnerTemp = process.env.RUNNER_TEMP?.trim() ?? ''
    const runnerUid = process.getuid?.()
    if (runnerTemp === '' || runnerUid === undefined) {
      bootstrapLogger.warning(
        'Not snapshotting the OpenCode logs: no RUNNER_TEMP or runner uid, so no logs are published',
      )
      return
    }
    logSnapshotPath = await snapshotLogDirectory({
      source: getOpenCodeLogPath(),
      tempRoot: runnerTemp,
      runnerUid,
      logger: bootstrapLogger,
    })
    if (logSnapshotPath !== null) core.saveState(STATE_KEYS.LOG_SNAPSHOT_DIR, logSnapshotPath)
  }
  // The run-scoped repo skills staging root under RUNNER_TEMP, or null. Hoisted so the `finally` block removes it once the
  // server has stopped, whichever path the run took (fro-bot/agent#2129).
  let repoSkillsStagingRoot: string | null = null
  let repo = ''
  let runId = ''
  let sessionRetention: number | null = null
  let lockEtag: string | null = null
  // Renews the Action coordination lock's lease across execution, drain, and persistence (plan
  // Unit 12) -- null whenever this run holds no lock (S3 disabled, or another Action run
  // already holds it). Held here, not inside acquire-lock.ts, because it
  // must outlive the acquire-lock phase call and reach runCleanup in the finally block
  // below, exactly like lockEtag already does.
  let leaseRenewal: LeaseController | null = null
  // True when S3 coordination is configured but the Action lock was not acquired (contended, or the
  // fail-closed lock error). Such a run must not persist session state (see CleanupPhaseOptions).
  let skipSessionPersistence = false
  // Why persistence is skipped, when it is not the lock. Shown in the cleanup warning in place of the lock message.
  let persistenceDeclineReason: string | undefined
  // Positive evidence that this invocation restored the cache and started the V2 server. Until then the OpenCode data on
  // the runner is whatever it already held (a persistent runner keeps its own), not this run's history, so no phase
  // before this point may persist it: the cleanup save and the post hook's retry both key off this.
  let sessionStateVouched = false
  // Hoisted out of the try block (like lockEtag above) because runCleanup runs from the
  // outer finally block, where a `const` declared inside try is out of scope. Populated
  // right after runExecute returns; stays undefined only when execution never ran
  // (SKIP_AGENT_EXECUTION=true) or the try block failed before reaching that point --
  // both cases runCleanup treats as an empty, persistence-safe ledger.
  let ownershipLedger: OwnershipLedger | undefined
  // Hoisted like the ledger so the release in the `finally` block can still stop the observation if a phase
  // between execution and the release threw. It comes from `runExecute`'s result.
  let liveObservation: ExecutePhaseResult['liveObservation']
  let requestedOutputModeState: OutputModeRequestState = 'omitted'
  let finalizationStarted = false
  // Hoisted for cleanup, which runs from the `finally` block; stays false until bootstrap resolves inputs.
  let skipCache = false
  let storeConfig: ObjectStoreConfig = {
    enabled: false,
    bucket: '',
    region: '',
    prefix: '',
  }

  // --- Invocation-outcome state (src/harness/outcome.ts), hoisted for the same reason as
  // the fields above: the FINAL assessment happens in the outer `finally` block, after
  // `runCleanup` returns its teardown safety evidence, so everything it needs must be
  // reachable there. Defaults are the "nothing happened yet" case -- every early-return
  // skip path (bootstrap/routing/dedup/lock declines) leaves these at their defaults, which
  // assess as verification-complete (no execution ran, nothing to be unverified about) and
  // let `deliverySucceeded` (from `exitCode`) alone decide succeeded vs. failed, matching
  // those paths' pre-existing exit codes exactly.
  let observationGap = false
  let ownershipUnresolved = false
  // V2: the server's exit was not confirmed after a release that otherwise looked clean. Raised before publication.
  let serverExitUnconfirmed = false
  // V2: a prompt POST failed after it may have been sent, and was not resent.
  let promptSendUncertain = false
  let triggerContext: TriggerContext | null = null
  let dedupEntity: DeduplicationEntity | null = null
  // Hoisted for the post-cleanup blocked-label clear in the `finally` block; null until bootstrap resolves inputs.
  let responseMode: ResponseMode | null = null
  // Tracks failure/skip explicitly, set at each early-return site below, rather than
  // inferring delivery from `exitCode === 0` in the `finally` block. `return 1`/`return 0`
  // inside the `try` block already fixes this invocation's returned number before `finally`
  // runs -- mutating `exitCode` there cannot change what was already returned (JS evaluates
  // a `return` expression before running `finally`) -- so `finally` must read a fact set
  // BEFORE each return, not `exitCode` itself, to know whether that return was a genuine
  // failure, an intentional skip, or (the 'pending' default) a normal in-progress run.
  // 'failed': bootstrap, cache-restore, or Action lock acquisition (S3 configured, lock error)
  // could not even start (`return 1`). 'skipped':
  // routing found no matching trigger, dedup suppressed a repeat, or the coordination lock
  // was contended (`return 0`, but nothing was attempted -- not the same as delivered).
  let deliveryOutcome: 'pending' | 'failed' | 'skipped' = 'pending'
  // Why routing declined the event; stays null for the dedup and lock-contention skips, which have no routing reason.
  let skipDetail: InvocationSkipDetail | null = null
  // The same fact for the lifecycle trace, which also covers the dedup and lock skips: a stable code, never free text.
  let traceSkipReason: string | null = null

  const createUnavailableOutputModeMigration = (): OutputModeMigrationState => ({
    requested: requestedOutputModeState,
    resolved: null,
  })

  const setUnavailableActionOutputs = (duration: number): void => {
    setActionOutputs({
      sessionId: null,
      resolvedOutputMode: null,
      outputModeMigration: createUnavailableOutputModeMigration(),
      deliveryKind: 'none',
      cacheStatus: 'miss',
      duration,
    })
  }

  /**
   * True when the server may not have run its plugin's cleanup to the end: it was killed, or its exit was never confirmed.
   * The plugin's last batch could then be missing from the relay's counts.
   */
  const serverWasKilled = async (): Promise<boolean> => {
    if (serverExitUnconfirmed) return true
    if (serverHandleV2 === null) return false
    try {
      // Memoized by the handle: after a release this is the result of the shutdown that already happened.
      const {exit} = await serverHandleV2.shutdown()
      // Forced or unconfirmed, or any exit on a signal or with a non-zero code, even one the handle reads as already-exited or
      // graceful: the plugin may not have flushed its last batch. The code and signal ride on the same shutdown result.
      return (
        exit.outcome === 'forced' ||
        exit.outcome === 'unconfirmed' ||
        exit.signal !== null ||
        (exit.code !== null && exit.code !== 0)
      )
    } catch {
      return true
    }
  }

  /**
   * Begins stopping the trace relay, once, after the server has exited; the supervisor logs what it counted. It does not wait:
   * the stop can take its grace plus its kill confirmation, and neither the sandbox release nor the persistence decision may
   * wait for a relay. Called on the normal path and again from the `finally` block, which guarantees no orphan. Synchronous,
   * so a run with no relay has no new await anywhere. Nothing it learns reaches the run's result or exit code.
   */
  const startTraceRelayStop = (): void => {
    const relay = traceRelay
    if (relay === null || traceRelayStopped !== undefined) return
    traceRelayStopped = (async () => {
      try {
        await relay.stop({serverKilled: await serverWasKilled()})
      } catch {
        // Fail-soft: a relay that cannot be stopped cleanly has already been logged by its supervisor.
      }
    })()
  }

  /** Waits, bounded, for a started relay stop, so its log line and its process confirmation land before the run ends. */
  const settleTraceRelayStop = async (): Promise<void> => {
    const stopping = traceRelayStopped
    if (stopping === undefined) return
    let bound: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      stopping,
      new Promise<void>(resolve => {
        bound = setTimeout(resolve, TRACE_RELAY_STOP_WAIT_MS)
      }),
    ])
    clearTimeout(bound)
  }

  core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
  // Not the boolean 'false' -- CACHE_SAVED is a CacheSaveStateValue (see
  // src/shared/cache-save-result.ts). 'not-persisted' is what "nothing has saved yet"
  // is called now, and it is also what post.ts falls back to for an absent/unrecognized
  // value, so this initial value and that fallback agree by construction.
  core.saveState(STATE_KEYS.CACHE_SAVED, 'not-persisted')

  try {
    bootstrapLogger.info('Starting Fro Bot Agent')

    requestedOutputModeState = resolveRequestedOutputModeState()
    const bootstrap = await phase(
      'bootstrap',
      async span => runBootstrap(bootstrapLogger, {registry, tracing: traceInputs, traceSpan: span, signalOwner}),
      started => (started == null ? {outcome: 'failed', reason: 'bootstrap-failed'} : {outcome: 'succeeded'}),
    )
    if (bootstrap == null) {
      deliveryOutcome = 'failed'
      setUnavailableActionOutputs(Date.now() - startTime)
      return 1
    }
    // Owned from here on: every exit path below releases it, including a V2 start that fails or throws.
    sandboxLifecycle = bootstrap.sandbox ?? null
    storeConfig = bootstrap.inputs.storeConfig
    skipCache = bootstrap.inputs.skipCache
    sessionRetention = bootstrap.inputs.sessionRetention
    responseMode = bootstrap.inputs.responseMode

    const routing = await phase(
      'routing',
      async () => runRouting(bootstrap, startTime),
      routed =>
        'skipped' in routed
          ? {outcome: 'skipped', reason: routed.skipReason}
          : {outcome: 'succeeded', reason: 'routed'},
    )
    bindTraceSession('skipped' in routing ? routing.context : routing.triggerResult.context)
    if ('skipped' in routing) {
      deliveryOutcome = 'skipped'
      skipDetail = {reason: routing.skipReason, message: routing.skipMessage}
      traceSkipReason = routing.skipReason
      setUnavailableActionOutputs(Date.now() - startTime)
      return 0
    }
    githubClient = routing.githubClient
    triggerContext = routing.triggerResult.context

    repo = `${routing.triggerResult.context.repo.owner}/${routing.triggerResult.context.repo.repo}`
    runId = routing.agentContext.runId
    // Built once per invocation and threaded to every review-submission seam (review
    // reconciliation below, and finalize -> response-post -> submitReviewWithHeadGuard) so
    // all of them reserve against the identical receipt identity. See
    // services/github/review-delivery-receipt.ts for the fail-closed guarantee this backs.
    const reviewDeliveryReceiptOps = createReviewDeliveryReceiptOperations(
      storeConfig,
      createLogger({phase: 'review-delivery-receipt'}),
    )
    const runAttempt = getGitHubRunAttempt()
    const dedup = await phase(
      'dedup',
      async span => {
        const checked = await runDedup(bootstrap.inputs.dedupWindow, routing.triggerResult.context, repo, startTime)
        span.addEvent('dedup.result', {'fro_bot.result': checked.shouldProceed ? 'proceed' : 'duplicate'})
        return checked
      },
      checked =>
        checked.shouldProceed ? {outcome: 'succeeded', reason: 'proceed'} : {outcome: 'skipped', reason: 'duplicate'},
    )
    if (!dedup.shouldProceed) {
      deliveryOutcome = 'skipped'
      traceSkipReason = 'duplicate'
      setUnavailableActionOutputs(Date.now() - startTime)
      return 0
    }
    dedupEntity = dedup.entity

    const lockResult = await phase(
      'coordination lock',
      async span => {
        const acquired = await runAcquireLock({
          storeConfig,
          repo,
          runId,
          runAttempt: getGitHubRunAttempt(),
          jobIdentity: getInvocationIdentity(),
        })
        span.addEvent('lock.result', {'fro_bot.result': acquired.outcome})
        if (acquired.outcome === 'error') span.recordException(acquired.error)
        return acquired
      },
      acquired => {
        switch (acquired.outcome) {
          case 'held-by-other':
            return {outcome: 'skipped', reason: acquired.outcome}
          case 'error':
            return {outcome: 'failed', reason: acquired.outcome}
          case 'acquired':
          case 's3-disabled':
            return {outcome: 'succeeded', reason: acquired.outcome}
        }
      },
    )
    switch (lockResult.outcome) {
      case 'acquired':
        lockEtag = lockResult.lockEtag
        leaseRenewal = lockResult.renewal
        break
      case 'held-by-other':
        bootstrapLogger.info('Skipping run — Action coordination lock held, or expired non-Action lease unconfirmed', {
          heldBy: lockResult.holder?.holder_id ?? null,
          surface: lockResult.holder?.surface ?? null,
        })
        deliveryOutcome = 'skipped'
        traceSkipReason = 'held-by-other'
        setUnavailableActionOutputs(Date.now() - startTime)
        // Nothing below this decline may write session state: cleanup declines its save and the post hook skips.
        skipSessionPersistence = true
        core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
        // Visibility only (summary, warning, label): never a comment or reaction. Best-effort, never throws.
        await runCoordinationDecline({
          githubClient: routing.githubClient,
          triggerContext: routing.triggerResult.context,
          holder: lockResult.holder,
          reason: lockResult.reason,
          responseMode: bootstrap.inputs.responseMode,
          logger: bootstrapLogger,
        })
        return 0
      case 'error': {
        // S3 coordination is configured (the disabled case is its own outcome), so running unlocked
        // could race another Action run's save of the shared session object. Fail closed.
        deliveryOutcome = 'failed'
        setUnavailableActionOutputs(Date.now() - startTime)
        skipSessionPersistence = true
        core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
        core.setFailed(`Action coordination lock unavailable; refusing to run without it: ${lockResult.error.message}`)
        return 1
      }
      case 's3-disabled':
        // Coordination is opt-in: no object store configured, proceed without a lock.
        break
    }

    reactionCtx = await phase('acknowledge', async () => runAcknowledge(routing, bootstrap.logger))

    // After routing so a skipped event never pays for a trust lookup or a git fetch (fro-bot/agent#2129). Null unless
    // `repo-skills` is on, the run is V2 and the trust predicate admitted it.
    const repoSkills = await phase(
      'repo skills',
      async () => runRepoSkills(bootstrap, routing),
      staged => (staged === null ? {outcome: 'skipped', reason: 'not-used'} : {outcome: 'succeeded', reason: 'staged'}),
    )
    repoSkillsStagingRoot = repoSkills?.stagingRoot ?? null

    // Tracing: the operator's `trace-endpoint` and `trace-headers` (already parsed, masked and removed from the environment by
    // bootstrap) decide whether a relay starts. The relay is up before the server can start, so the plugin's exporter has
    // somewhere to post from its first batch, and what the plugin is told is decided here, once: on only with a relay that is
    // running and a complete run identity, off for everything else. A relay that does not start has been warned about by its
    // supervisor and the run goes on untraced.
    let tracingHost: ActionTracingSource = buildActionTracingHost(null, null)
    const relayRequest = relayRequestFromInputs(bootstrap.inputs.tracing)
    await phase(
      'trace relay start',
      async (): Promise<SpanResult> => {
        if (relayRequest === null) return {outcome: 'skipped', reason: 'tracing-off'}
        // Each field from where it is authoritative: the routed context for the repository, run and trigger (never the payload
        // or `github.context`), the Action's own environment for the attempt (`GITHUB_RUN_ATTEMPT` is not admitted to the agent,
        // so it travels in the launcher document) and the invocation identity for the job (the lock's `holder_job`).
        const identity = buildTracingRunIdentity({
          repository: repo,
          runId,
          attempt: runAttempt,
          job: getInvocationIdentity(),
          trigger: routing.triggerResult.context.eventName,
        })
        if (identity.success) {
          // The signal teardown owns the launch from before the spawn: a cancellation while the child is still starting aborts the
          // start and reaps it, one that arrives when it is ready stops it, inside the teardown's own budget. Registering installs
          // the lifecycle's signal handlers, which at this point (before the server, the key proxy and the account) nothing else
          // has. The server is being killed on a signal, so a relay stopped that way cannot have a complete count.
          const launch = createTraceRelayLaunch(startTraceRelayProcess)
          sandboxLifecycle?.registerSignalStop(async () => launch.stop())
          const started = await launch.start({
            config: relayRequest,
            logger: createLogger({phase: 'trace-relay'}),
            // The relay bundle is optional, so only a run that traces looks at it (the supervisor asks, before it spawns).
            bundleCheck: async () => checkTraceRelayBundle({isolated: isolationRequested}),
          })
          if (started.success) {
            traceRelay = started.data
            tracingHost = liveActionTracingHost(
              started.data,
              identity.data,
              buildTracingRunLink(tracer.ids, traceSessionId),
            )
            if (sandboxLifecycle === null && !isolationRequested) bootstrapLogger.warning(TRACE_EXPOSURE_WARNING)
            return {outcome: 'succeeded', reason: 'started'}
          }
          return {outcome: 'failed', reason: 'relay-start-failed'}
        }
        bootstrapLogger.warning(TRACE_IDENTITY_WARNING)
        return {outcome: 'skipped', reason: 'identity-incomplete'}
      },
      result => result,
    )

    const cacheRestore = await phase(
      'cache restore',
      async span => runCacheRestore(bootstrap, metrics, repoSkills, tracingHost, {span, registry}),
      restored =>
        restored == null
          ? {outcome: 'failed', reason: 'server-start-failed'}
          : {outcome: 'succeeded', reason: restored.cacheStatus},
    )
    if (cacheRestore == null) {
      deliveryOutcome = 'failed'
      setUnavailableActionOutputs(Date.now() - startTime)
      // A start that fails (credentials, gates, the V1 import wait) must not write session state: the database may
      // be mid-import or half-gated, and the post hook would otherwise save whatever is on disk.
      skipSessionPersistence = true
      persistenceDeclineReason = 'the OpenCode V2 server did not complete its start, so no session state is saved'
      core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
      return 1
    }
    serverHandleV2 = cacheRestore.serverHandle
    sandboxLifecycle = cacheRestore.sandbox ?? sandboxLifecycle
    sessionStateVouched = true
    // Armed here and nowhere earlier: the post hook retries a save only for a run that got this far.
    core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'true')

    const sessionPrep = await phase('session prep', async () =>
      runSessionPrep(bootstrap, routing, cacheRestore, metrics),
    )
    attachmentResult = sessionPrep.attachmentResult

    // The pre-run brokered-push decision, made once. It only gates the prompt bullet telling the agent the Action
    // pushes its changes; finalize keeps its own, deliberately wider, decision so a failure to push stays loud.
    const brokeredPushPlan = resolveBrokeredPushPlan(bootstrap, routing)

    let execution = await phase(
      'execution',
      async span => {
        const executed = await runExecute(bootstrap, routing, cacheRestore, sessionPrep, metrics, brokeredPushPlan)
        // The agent's own failure text, as the error where it happened: scrubbed and capped at export, never the prompt or output.
        if (!executed.success && executed.error != null) span.recordException(new Error(executed.error))
        return executed
      },
      executed =>
        executed.success
          ? {outcome: 'succeeded'}
          : {
              outcome: 'failed',
              reason: /execution deadline/i.test(executed.error ?? '') ? 'timeout' : 'agent-failed',
            },
    )
    ownershipLedger = execution.ownershipLedger
    liveObservation = execution.liveObservation
    // Sticky, invocation-scoped facts -- feed the invocation-outcome assessment
    // (src/harness/outcome.ts), never `execution.success` itself.
    observationGap = execution.observationGap === true

    // Release: owned background work settles before anything below this point publishes, persists, or releases
    // (Unit 10). The server is released by its directory, not by the ledger (probe P2: root idle is not terminal):
    // drain a succeeded run, stop anything else, confirm the directory quiet, then shut the server down. A run that
    // cannot be confirmed quiet must not be saved, whatever the ledger says.
    const drainLogger = createLogger({phase: 'drain'})
    const release = await phase(
      'release',
      async () =>
        runReleaseV2(
          releaseOptionsFromExecution(execution, {
            serverHandle: cacheRestore.serverHandle,
            runStartedAt: startTime,
            deadlineMs: computeDrainDeadlineMs(bootstrap.inputs.timeoutMs, execution.executionDurationMs),
            sessionRetention,
            logger: drainLogger,
          }),
        ),
      released =>
        released.drain.expired
          ? {outcome: 'incomplete', reason: 'drain-expired'}
          : {outcome: 'succeeded', reason: 'drained'},
    )
    serverReleasedV2 = true
    const drainResult = release.drain
    serverExitUnconfirmed = release.serverExitUnconfirmed === true
    // The server has exited, so whatever its plugin was going to send is sent: the relay can go. Not awaited: the sandbox is
    // released below without waiting for it.
    startTraceRelayStop()
    // The server is shut down. Before anything below reads what the sandbox wrote (the response file, the checkout,
    // the database), kill and verify every process of the sandbox user and take its files back. An unconfirmed stop or an
    // unsafe restore fails the run here: no response is read, nothing is pushed, nothing is checkpointed or saved.
    if (sandboxLifecycle !== null) {
      const takeBack = sandboxLifecycle
      const takeBackSpan = tracer.startSpan('isolation take-back')
      const sandboxOutcome = await withSpan(
        takeBackSpan,
        async () => takeBack.release(),
        released => {
          // The run throws on both of these right below, so the error is recorded here, on the span where it happened.
          if (released.restore !== 'restored') {
            takeBackSpan.recordException(
              new Error(
                `isolate-agent: the sandbox was not confirmed stopped and restored: ${released.reason ?? 'unknown reason'}`,
              ),
            )
            return {outcome: 'failed', reason: 'not-restored'}
          }
          if (released.proxy === 'crashed') {
            takeBackSpan.recordException(new Error('isolate-agent: the key proxy exited unexpectedly during the run'))
            return {outcome: 'failed', reason: 'proxy-crashed'}
          }
          return {outcome: 'succeeded', reason: 'restored'}
        },
      )
      sandboxSettled = true
      recordSandboxRelease(sandboxOutcome)
      if (sandboxOutcome.restore !== 'restored') {
        markSandboxUntrusted()
        skipSessionPersistence = true
        persistenceDeclineReason = `the isolate-agent sandbox was not confirmed stopped and restored (${sandboxOutcome.reason ?? 'unknown reason'}), so no session state is saved`
        core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
        throw new Error(
          `isolate-agent: the sandbox was not confirmed stopped and restored: ${sandboxOutcome.reason ?? 'unknown reason'}`,
        )
      }
      await snapshotSandboxLogs()
      if (sandboxOutcome.proxy === 'crashed') {
        // The key proxy exited before the teardown asked it to: model requests after that point failed, so the run is
        // incomplete whatever the session says. Nothing is published or saved.
        skipSessionPersistence = true
        persistenceDeclineReason = KEY_PROXY_CRASHED_DECLINE_REASON
        core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
        throw new Error('isolate-agent: the key proxy exited unexpectedly during the run')
      }
    }
    if (execution.sendUncertain === true) {
      // The prompt may have run without this run seeing it. The stop path above already confirmed the directory quiet,
      // but the session's content may include work this run cannot account for, so nothing is saved or endorsed.
      promptSendUncertain = true
      skipSessionPersistence = true
      persistenceDeclineReason ??= 'the prompt acknowledgment was lost, so what the session holds cannot be vouched for'
      core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
    }
    if (release.observed !== undefined) {
      // The root's turns after the attempt returned (a notice starting a second one) are part of the run: the last
      // one decides whether it succeeded, and what it did joins the artifacts and usage.
      const merged = mergeObservedTurn(execution, release.observed)
      recordObservedTurn(execution, merged, metrics)
      execution = merged
      observationGap = execution.observationGap === true
    }
    if (release.persistenceDeclineReason !== undefined) {
      skipSessionPersistence = true
      persistenceDeclineReason = release.persistenceDeclineReason
      core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
    }
    if (drainResult.expired) {
      drainLogger.warning('Drain deadline reached before owned work settled; run reports incomplete', {
        cancelledCount: drainResult.cancelledCount,
        settledCount: drainResult.settledCount,
        unknownCount: drainResult.unknownCount,
      })
    }
    // Carries forward the overflow-recovery boundary's own unresolved ownership facts too
    // (see ExecutePhaseResult.recoveryBoundaryUnresolved) -- the top-level drain above only
    // ever observes the recovery session's own ledger, never the overflowed session's.
    //
    // A drain that expired is incomplete whether or not the stop after it confirmed the directory quiet: the response
    // was produced while owned work was still running, so it may describe work that was then cut off.
    ownershipUnresolved =
      drainResult.unknownCount > 0 || execution.recoveryBoundaryUnresolved === true || drainResult.expired

    // `true` when this invocation already knows, before publication, that its own execution
    // was not fully observed -- computed from exactly the two facts above, both genuinely
    // known at this point: `observationGap` (the event stream that watched execution closed
    // without an intentional shutdown or terminal signal) and `ownershipUnresolved` (drain
    // ended with unsettled or unconfirmed background-dispatch ownership, including an
    // unresolved context-overflow recovery boundary). Deliberately excludes the two teardown
    // facts `InvocationVerificationFacts` also tracks -- server quiescence and coordination-
    // lease continuity: those are not knowable until `runCleanup` returns, which happens
    // after publication, so folding them in here would gate an irreversible write against a
    // snapshot that hardcodes them as clean (the mistake af0b155d0 made and baa96477d
    // removed). A known defect can veto an endorsement without the absence of that defect
    // certifying the invocation -- this flag is the veto, never a certificate, and it never
    // feeds `assessInvocationOutcome` or the final `InvocationVerificationFacts` below.
    const knownExecutionVeto = observationGap || ownershipUnresolved || serverExitUnconfirmed || promptSendUncertain

    // Review reconciliation: after the agent session, check if a formal APPROVE
    // is needed to satisfy branch protection when the agent delivered a PASS
    // verdict as a comment instead of a review event. Fail-safe — never throws.
    const reconciliationLogger = createLogger({phase: 'review-reconciliation'})
    const reconciliationTriggerContext = routing.triggerResult.context
    const isPullRequestReviewTrigger = reconciliationTriggerContext.eventType === 'pull_request'
    const prNumber =
      reconciliationTriggerContext.target != null && reconciliationTriggerContext.target.kind === 'pr'
        ? reconciliationTriggerContext.target.number
        : null
    await phase('review reconciliation', async span => {
      span.addEvent('gate.decision', {
        'fro_bot.gate': 'execution-veto',
        'fro_bot.result': knownExecutionVeto ? 'vetoed' : 'clear',
      })
      await runReviewReconciliation(
        {
          octokit: routing.githubClient,
          botLogin: routing.botLogin,
          owner: reconciliationTriggerContext.repo.owner,
          repo: reconciliationTriggerContext.repo.repo,
          prNumber,
          isPullRequestReviewTrigger,
          responseModeIsGithub: bootstrap.inputs.responseMode === 'github',
          agentSucceeded: execution.success,
          reviewedHeadSha: resolveReviewedHeadSha(routing.agentContext, reconciliationTriggerContext),
          runStartMs: startTime,
          isFileConventionDelivery: bootstrap.delivery === 'file-convention',
          knownExecutionVeto,
          receipt: {ops: reviewDeliveryReceiptOps, runId, runAttempt},
        },
        reconciliationLogger,
      )
    })

    metrics.end()
    finalizationStarted = true
    const finalization = await phase(
      'finalize',
      async span =>
        runFinalizeWithResult(bootstrap, routing, cacheRestore, execution, metrics, startTime, bootstrap.logger, {
          knownExecutionVeto,
          reviewDeliveryReceiptOps,
          traceSpan: span,
        }),
      finalized => (finalized.exitCode === 0 ? {outcome: 'succeeded'} : {outcome: 'failed', reason: 'delivery-failed'}),
    )
    exitCode = finalization.exitCode

    // Dedup marker and the terminal reaction both moved out of this try block -- they now
    // happen in the `finally` block below, strictly after `runCleanup` returns and the
    // FINAL invocation outcome is known. Saving the dedup marker here (before teardown had
    // reported its own safety facts) risked marking an invocation deduplicated when its
    // state was never actually verified.
  } catch (error) {
    exitCode = 1
    const duration = Date.now() - startTime
    const errorName = error instanceof Error ? error.name : 'UnknownError'
    const errorMessage = toErrorMessage(error)

    metrics.recordError(errorName, errorMessage, false)
    metrics.end()

    if (finalizationStarted === false) {
      setUnavailableActionOutputs(duration)
    }

    if (error instanceof Error) {
      bootstrapLogger.error('Agent failed', {error: error.message})
      core.setFailed(error.message)
    } else {
      bootstrapLogger.error('Agent failed with unknown error')
      core.setFailed('An unknown error occurred')
    }
  } finally {
    // A V2 run that never reached its release (a phase threw first) still has a server, and maybe a shell or a child the
    // server's shutdown would kill or strand mid-write. Stop what the directory shows and confirm it quiet before cleanup
    // saves anything.
    if (serverHandleV2 !== null && !serverReleasedV2) {
      try {
        const unreleasedServer = serverHandleV2
        const release = await phase(
          'release',
          async () =>
            runReleaseV2({
              serverHandle: unreleasedServer,
              executionSucceeded: false,
              rootSessionId: null,
              ledger: ownershipLedger,
              runStartedAt: startTime,
              deadlineMs: 0,
              sessionRetention,
              logger: createLogger({phase: 'drain'}),
              liveObservation,
            }),
          released => ({outcome: 'failed', reason: released.drain.expired ? 'drain-expired' : 'run-aborted'}),
        )
        if (release.persistenceDeclineReason !== undefined) {
          skipSessionPersistence = true
          persistenceDeclineReason = release.persistenceDeclineReason
          core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
        }
      } catch (releaseError) {
        skipSessionPersistence = true
        persistenceDeclineReason = `the OpenCode V2 server could not be released (${toErrorMessage(releaseError)}), so no session state is saved`
        core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
      }
    }
    // The relay outlives nothing: a path that left the try block before the normal stop (an exception, a server that never
    // started) begins stopping it here, after the server release above, without holding what follows.
    startTraceRelayStop()
    // Any path that left the try block before the normal release (an exception, a failed phase) still owns a live
    // sandbox. Stop and restore it before cleanup checkpoints or saves anything.
    if (sandboxLifecycle !== null && !sandboxSettled) {
      try {
        const unsettledSandbox = sandboxLifecycle
        const sandboxOutcome = await phase(
          'isolation take-back',
          async () => unsettledSandbox.release(),
          released =>
            released.restore === 'restored'
              ? {outcome: 'succeeded', reason: 'restored'}
              : {outcome: 'failed', reason: 'not-restored'},
        )
        recordSandboxRelease(sandboxOutcome)
        if (sandboxOutcome.restore === 'restored') {
          await snapshotSandboxLogs()
          if (sandboxOutcome.proxy === 'crashed') {
            skipSessionPersistence = true
            persistenceDeclineReason ??= KEY_PROXY_CRASHED_DECLINE_REASON
            core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
          }
        } else {
          markSandboxUntrusted()
          skipSessionPersistence = true
          persistenceDeclineReason ??= `the isolate-agent sandbox was not confirmed stopped and restored (${sandboxOutcome.reason ?? 'unknown reason'}), so no session state is saved`
          core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
        }
      } catch (sandboxError) {
        markSandboxUntrusted()
        sandboxRestoreUnsafe = true
        skipSessionPersistence = true
        persistenceDeclineReason ??= `the isolate-agent sandbox could not be released (${toErrorMessage(sandboxError)}), so no session state is saved`
        core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
      }
    }
    if (!sessionStateVouched && !skipSessionPersistence) {
      skipSessionPersistence = true
      persistenceDeclineReason =
        "the run ended before the OpenCode V2 server started, so the OpenCode data on this runner is not this run's session state and is not saved"
    }
    const cleanupSpan = tracer.startSpan('cleanup')
    const cleanupResult = await runCleanup({
      traceSpan: cleanupSpan,
      bootstrapLogger,
      reactionCtx,
      githubClient,
      attachmentResult,
      ...(serverHandleV2 === null ? {} : {serverHandleV2}),
      storeConfig,
      skipCache,
      metrics,
      agentIdentity: 'github',
      repo,
      runId,
      lockEtag,
      ownershipLedger,
      leaseRenewal,
      skipSessionPersistence,
      sandboxOutputUntrusted,
      isolatedRun: isolationRequested || sandboxLifecycle !== null,
      logSnapshotPath,
      ...(persistenceDeclineReason === undefined ? {} : {persistenceDeclineReason}),
    })
      .finally(async () => {
        // runCleanup shuts the V2 server down; only then is the staging root, which the server reads, safe to remove.
        await removeRepoSkillsStaging(repoSkillsStagingRoot)
        // The same holds for the `gh` config directory: the server and the sandbox read it, and what runs after this point
        // uses the Action's Octokit client, never `gh`. Setup recorded the directory when it created it, so this covers a
        // bootstrap that threw after setup too.
        await releaseRunGhConfig({sandboxTrusted: !sandboxRestoreUnsafe, logger: bootstrapLogger})
        // Last, and only for a run that traced: the relay's stop has had the whole cleanup to finish.
        if (traceRelayStopped !== undefined) await settleTraceRelayStop()
      })
      .then(
        result => {
          trace.outcome.cacheSaveOutcome = result.cacheSaveOutcome ?? null
          cleanupSpan.end(
            result.quiescenceConfirmed && !result.continuityUnverified
              ? {outcome: 'succeeded'}
              : {
                  outcome: 'incomplete',
                  reason: result.quiescenceConfirmed ? 'lease-continuity-unverified' : 'server-quiescence-unconfirmed',
                },
          )
          return result
        },
        (error: unknown) => {
          cleanupSpan.recordException(error)
          cleanupSpan.end({outcome: 'failed', reason: 'exception'})
          throw error
        },
      )

    // FINAL assessment: the single call to this pure function, made only now that
    // `runCleanup` has returned the real teardown facts. `deliverySucceeded` is derived from
    // `deliveryOutcome`/`exitCode`, never from `execution.success` directly, which is never
    // cleared or second-guessed here. `knownExecutionVeto` above is a separate, earlier gate
    // on irreversible publication and is never folded into this assessment or its inputs.
    //
    // A 'skipped' run (routing/dedup/lock-contention early return) bypasses this assessment
    // entirely rather than feeding it a synthesized `deliverySucceeded` -- it attempted no
    // delivery and has no execution/drain/teardown facts to assess, so forcing it through
    // `assessInvocationOutcome` would either mislabel it 'succeeded' (this action.yaml value
    // means delivery succeeded, which did not happen) or, if mapped to 'incomplete', flip
    // its exit code from 0 to 1 below and turn every routine skip into a failed job.
    let finalOutcome: InvocationOutcome
    let finalIncompleteReasons: readonly string[] = []

    if (deliveryOutcome === 'skipped') {
      finalOutcome = 'skipped'
    } else {
      const finalVerification: InvocationVerificationFacts = {
        observationGap,
        ownershipUnresolved,
        quiescenceConfirmed: cleanupResult.quiescenceConfirmed && !serverExitUnconfirmed,
        continuityUnverified: cleanupResult.continuityUnverified,
      }
      // 'failed' (bootstrap/cache-restore could not start) forces deliverySucceeded false
      // regardless of `exitCode`'s value -- the early `return 1` that already produced this
      // invocation's actual exit code left `exitCode` itself untouched (see `deliveryOutcome`'s
      // doc above), so it cannot be trusted here for that path. Every other (non-early-return)
      // path keeps reading `exitCode === 0`, unchanged from before.
      const deliverySucceeded = deliveryOutcome === 'failed' ? false : exitCode === 0
      const assessment = assessInvocationOutcome({deliverySucceeded, verification: finalVerification})
      finalOutcome = assessment.outcome
      finalIncompleteReasons = assessment.incompleteReasons

      // Exit code contract: 1 for incomplete, same as failed -- no third numeric code. The
      // structured `invocation-outcome` output and job-summary row are what distinguish "the
      // harness contract was unmet" from "the agent was wrong". A `finish(1, ...)` (or
      // exitCode already non-zero) path is left exactly as finalize decided it.
      if (finalOutcome === 'incomplete' && exitCode === 0) {
        exitCode = 1
      }
    }

    // The code this run returns: an early `return` fixed its own before the `finally` blocks ran and left `exitCode` alone, so
    // it is read from the fact each early return set.
    trace.outcome.exitCode = deliveryOutcome === 'failed' ? 1 : deliveryOutcome === 'skipped' ? 0 : exitCode
    trace.outcome.rootResult =
      finalOutcome === 'skipped'
        ? {outcome: 'skipped', reason: traceSkipReason ?? 'skipped'}
        : finalIncompleteReasons.length > 0
          ? {outcome: finalOutcome, reason: finalIncompleteReasons.join(',')}
          : {outcome: finalOutcome}

    // The final writes (the dedup marker, the terminal reaction, outputs, the job summary, the blocked-label clear) run after
    // cleanup, so they are their own span after it rather than part of finalize.
    await phase('report', async () => {
      // Dedup marker, written only after cleanup has had its say -- moved here (was: right
      // after finalize, before cleanup ran) per the same reasoning that moved the terminal
      // reaction below. A lock-contention skip reaches this point with both `dedupEntity` and
      // `triggerContext` already populated (set before the lock is even acquired), so the
      // outcome check is what stops a contended run, which delivered nothing, from marking
      // itself deduplicated anyway.
      //
      // No exception for an incomplete invocation that already delivered a review: that used
      // to be a deliberate carve-out here (writing the marker anyway, to discourage a rerun
      // that could not recognize the earlier review and would submit a second one). It is
      // removed now that `services/github/review-delivery-receipt.ts` independently protects
      // every irreversible review submission with its own at-most-once reservation -- keeping
      // this carve-out would only obscure that receipt as the actual authority, while this
      // ordinary marker returns to its ordinary purpose: recording routine completion, not
      // standing in for review idempotency.
      const deduplicatable = finalOutcome === 'succeeded'
      if (deduplicatable && dedupEntity != null && triggerContext != null) {
        await saveDedupMarker(triggerContext, dedupEntity, repo)
      }

      // Terminal reaction: a distinct three-way projection (succeeded/incomplete/failed), not
      // the boolean success/failure `completeAcknowledgment` used to receive -- moved here,
      // strictly after cleanup, because passing a boolean derived from `exitCode` before
      // teardown's own facts were known could select the success reaction for an invocation
      // this assessment now calls incomplete. `reactionCtx` is structurally always null on a
      // 'skipped' run (acknowledgment happens after every skip's early return), so the
      // `finalOutcome !== 'skipped'` guard here is belt-and-suspenders, not load-bearing --
      // added because `applyTerminalReaction` is not typed to accept a fourth outcome value.
      if (reactionCtx != null && githubClient != null && finalOutcome !== 'skipped') {
        await applyTerminalReaction(githubClient, reactionCtx, finalOutcome, bootstrapLogger)
      }

      setInvocationOutcomeOutput(finalOutcome)
      await writeInvocationOutcomeSummary(
        finalOutcome,
        finalIncompleteReasons,
        bootstrapLogger,
        skipDetail ?? undefined,
      )

      // A succeeded run clears the `agent: blocked` label a PRIOR run's coordination decline left on this item.
      // Last, after every output/summary is written: best-effort, deadline-bounded, never throws. The phase itself
      // no-ops for any other outcome (including this run's own declined/errored lock), response-mode none, and
      // non-issue/PR targets.
      if (githubClient != null && triggerContext != null && responseMode != null) {
        await runBlockedLabelClear({
          githubClient,
          triggerContext,
          outcome: finalOutcome,
          responseMode,
          logger: bootstrapLogger,
        })
      }
    })
  }

  return exitCode
}
