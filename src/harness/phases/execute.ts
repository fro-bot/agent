import type {
  ClassificationPath,
  ErrorInfo,
  EventType,
  OutputModeMigrationState,
  OutputModeRequestState,
  OwnershipLedger,
  ReconcileLedgerOptions,
  SessionClient,
  SessionSearchResult,
} from '@fro-bot/runtime'
import type {LiveObservationV2} from '../../features/agent/live-observation-v2.js'
import type {ExecutionConfig, PromptOptions} from '../../features/agent/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {Logger} from '../../shared/logger.js'
import type {OutputMode, ResolvedOutputMode, TokenUsage} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult, CacheRestoreV2PhaseResult} from './cache-restore.js'
import type {DeferredSummaryV2, ExecutionBackend} from './execution-backend.js'
import type {RoutingPhaseResult} from './routing.js'
import type {SessionPrepPhaseResult} from './session-prep.js'
import * as fs from 'node:fs/promises'
import process from 'node:process'
import * as core from '@actions/core'
import {
  archiveSession,
  createLedgerReconciler,
  createOwnershipLedger,
  createSdkLedgerReconcileAdapter,
  findLatestSession,
  reconcileLedgerOnce,
  resolveResponseDelivery,
  searchSessions,
  writeSessionSummary,
} from '@fro-bot/runtime'
import {executeOpenCode, resolveOutputMode} from '../../features/agent/index.js'
import {inspectResponseFile, resolveResponseSurface} from '../../features/agent/response-file.js'
import {sleep} from '../../shared/async.js'
import {getGitHubWorkspace} from '../../shared/env.js'
import {toErrorMessage} from '../../shared/errors.js'
import {createLogger} from '../../shared/logger.js'
import {STATE_KEYS} from '../config/state-keys.js'
import {isCacheRestoreV2} from './cache-restore-kind.js'
import {createExecutionBackendV2} from './execute-v2.js'
import {buildSessionSearchQuery} from './session-prep.js'

export interface ExecutePhaseResult {
  readonly success: boolean
  readonly exitCode: number
  readonly sessionId: string | null
  readonly error: string | null
  readonly tokenUsage: TokenUsage | null
  readonly model: string | null
  readonly cost: number | null
  readonly prsCreated: readonly string[]
  readonly commitsCreated: readonly string[]
  readonly commentsPosted: number
  readonly llmError: ErrorInfo | null
  readonly classificationPath?: ClassificationPath
  readonly resolvedOutputMode: ResolvedOutputMode | null
  readonly outputModeMigration: OutputModeMigrationState
  readonly overflowRecovery?: {
    readonly recovered: boolean
    readonly archivedSessionId: string
    readonly archiveSucceeded: boolean
  }
  /**
   * V2 only. The event observation a successful run keeps open for the release to stop (see `live-observation-v2.ts`).
   * After an overflow recovery this is the replacement run's; the overflowed run's is stopped at the restart.
   */
  readonly liveObservation?: LiveObservationV2
  /**
   * V2 only. The prompt POST failed after it may have reached the server (see `AttemptResultV2.sendUncertain`): it was not
   * resent, the run failed, and what the session holds cannot be vouched for. `run.ts` declines the save and vetoes
   * publication for it.
   */
  readonly sendUncertain?: boolean
  /** V2 only. The run summary held back for the release to write (see `DeferredSummaryV2`). */
  readonly deferredSummary?: DeferredSummaryV2
  /**
   * The ownership ledger backing this phase's active session (the recovery
   * session's ledger once overflow recovery has run, otherwise the original
   * session's). Absent only when execution was skipped entirely
   * (`SKIP_AGENT_EXECUTION=true`). Threaded to `runDrain` by the caller
   * (plan Unit 11).
   */
  readonly ownershipLedger?: OwnershipLedger
  /**
   * `true` when any event stream observing this phase's execution -- including a
   * context-overflow recovery restart -- recorded an unexpected discontinuity
   * (`AgentResult.observationGap`). Sticky across the recovery boundary: a fresh recovery
   * ledger starts a clean dispatch budget, but it must not erase an observation gap the
   * overflowed session already recorded for this same invocation (see
   * `recoverFromContextOverflow` below). Feeds `InvocationVerificationFacts.observationGap`
   * in `src/harness/outcome.ts`.
   */
  readonly observationGap: boolean
  /**
   * `true` when the OVERFLOWED session's own drain (run internally by
   * `recoverFromContextOverflow` before archiving it) still had unresolved (outstanding or
   * unknown) ownership-ledger entries. The recovery session gets a fresh ledger with a
   * clean dispatch budget (see `recoveryLedger` below) -- that reset is about dispatch
   * accounting, not a claim that the session it replaces left nothing unresolved. This
   * field is how that fact survives the ledger boundary and reaches
   * `InvocationVerificationFacts.ownershipUnresolved` in `src/harness/outcome.ts`, since the
   * top-level drain in `run.ts` only ever observes `ownershipLedger` (the recovery
   * session's), never the overflowed session's. `false` on every non-recovery result.
   */
  readonly recoveryBoundaryUnresolved: boolean
  /**
   * Wall-clock time spent inside this phase (including a context-overflow
   * recovery restart), in milliseconds. `runDrain`'s caller subtracts this
   * from the invocation's total timeout to compute the remaining drain
   * budget -- "one deadline covers execution and drain" (plan Unit 10).
   */
  readonly executionDurationMs: number
}

export function resolveRequestedOutputModeState(): OutputModeRequestState {
  const rawOutputMode = core.getInput('output-mode').trim().toLowerCase()

  if (rawOutputMode.length === 0) {
    return 'omitted'
  }

  if (rawOutputMode === 'auto') {
    return 'auto'
  }

  // Inputs are validated before this phase, so any non-empty non-auto value is
  // one of the explicit modes.
  return 'explicit'
}

function resolveOutputModeMigration(
  eventType: EventType,
  configuredMode: OutputMode,
  requested: OutputModeRequestState,
): OutputModeMigrationState {
  const resolved = resolveOutputMode(eventType, configuredMode)

  return {
    requested,
    resolved,
  }
}

/**
 * The one generation selector of the execute phase. V1 is the exact set of calls `runExecute` always made; V2 is the
 * sibling in `execute-v2.ts`. Nothing else in this phase branches on the generation.
 */
function selectExecutionBackend(cacheRestore: CacheRestorePhaseResult | CacheRestoreV2PhaseResult): ExecutionBackend {
  if (isCacheRestoreV2(cacheRestore)) return createExecutionBackendV2(cacheRestore)

  const {serverHandle} = cacheRestore
  return {
    execute: async (promptOptions, logger, config, ledger) =>
      executeOpenCode(promptOptions, logger, config, serverHandle, ledger),
    drainOverflowed: async (ledger, sessionId, logger) =>
      runDrain({
        ledger,
        client: serverHandle.client,
        parentSessionId: sessionId,
        directory: getGitHubWorkspace(),
        deadlineMs: 0,
        logger,
      }),
    archive: async (sessionId, logger) => archiveSession(serverHandle.server.url, sessionId, logger),
    searchPriorWork: async (query, workspace, excludeSessionIds, logger) =>
      searchSessions(query, serverHandle.client, workspace, {limit: 5, excludeSessionIds}, logger),
    findLatestSessionId: async (afterTimestamp, workspace, logger) => {
      const latestSession = await findLatestSession(serverHandle.client, workspace, afterTimestamp, logger)
      return latestSession == null ? null : latestSession.session.id
    },
    writeSummary: async (sessionId, summary, logger) => {
      await writeSessionSummary(sessionId, summary, serverHandle.client, logger)
      return undefined
    },
  }
}

interface ContextOverflowRecoveryOptions {
  readonly bootstrap: BootstrapPhaseResult
  readonly routing: RoutingPhaseResult
  /** The generation selected once in `runExecute`; the recovery restart runs on the same one. */
  readonly backend: ExecutionBackend
  readonly sessionPrep: SessionPrepPhaseResult
  readonly metrics: MetricsCollector
  readonly execLogger: Logger
  readonly executionStartTime: number
  readonly promptOptions: PromptOptions
  readonly executionConfig: ExecutionConfig
  readonly overflowedResult: ExecutePhaseResult
  readonly overflowedSessionId: string
  /** The ledger backing the overflowed session's own execution -- cancelled and settled before it is archived. */
  readonly overflowedLedger: OwnershipLedger
  readonly resolveSessionId: (candidateSessionId: string | null, afterTimestamp: number) => Promise<string | null>
}

async function recoverFromContextOverflow(options: ContextOverflowRecoveryOptions): Promise<ExecutePhaseResult> {
  const {
    bootstrap,
    routing,
    backend,
    sessionPrep,
    metrics,
    execLogger,
    executionStartTime,
    promptOptions,
    executionConfig,
    overflowedResult,
    overflowedSessionId,
    overflowedLedger,
    resolveSessionId,
  } = options

  // Cancel and settle work the overflowed session still owns BEFORE archiving it:
  // archival re-runs under a new session id while the overflowed session's own
  // subagents keep running, so without this both sets of writers would touch the
  // same workspace and git index concurrently. Reuses `runDrain`'s confirm-or-unknown
  // cancellation rather than a second implementation; `deadlineMs: 0` skips straight
  // from the unconditional first reconciliation pass to cancellation for anything
  // reconciliation did not already resolve.
  const overflowedDrainOutcome = await backend.drainOverflowed(overflowedLedger, overflowedSessionId, execLogger)
  // Carried forward on the recovery result below (recoveryBoundaryUnresolved) -- the fresh
  // ledger recovery constructs next resets dispatch accounting only, not this fact.
  const recoveryBoundaryUnresolved = overflowedDrainOutcome.unknownCount > 0

  // A stop that could not be confirmed leaves a writer in the directory the replacement session would share. Do not
  // archive the old session (the next run could not tell it from a finished one) and do not start another: hand the
  // overflowed result back as it is, incomplete, so the run goes through its normal stop and persistence-decline path.
  if (overflowedDrainOutcome.restartSafe === false) {
    execLogger.error('Overflowed session left work running that could not be stopped; skipping the recovery restart', {
      sessionId: overflowedSessionId,
      unknownCount: overflowedDrainOutcome.unknownCount,
    })
    return {...overflowedResult, recoveryBoundaryUnresolved: true}
  }

  const archiveSucceeded = await backend.archive(overflowedSessionId, execLogger)
  if (archiveSucceeded === false) {
    execLogger.warning('Overflowed session archive failed; next run may re-continue it', {
      sessionId: overflowedSessionId,
    })
  }

  const recoverySearchQuery = buildSessionSearchQuery(
    sessionPrep.logicalKey,
    routing.agentContext.issueTitle,
    routing.agentContext.repo,
  )
  let recoveryPriorWorkContext: readonly SessionSearchResult[] = []
  try {
    recoveryPriorWorkContext = await backend.searchPriorWork(
      recoverySearchQuery,
      sessionPrep.normalizedWorkspace,
      [overflowedSessionId],
      execLogger,
    )
  } catch (error) {
    execLogger.warning('Recovery prior-work search failed; proceeding with empty context', {error})
  }
  for (const session of recoveryPriorWorkContext) {
    metrics.addSessionUsed(session.sessionId)
  }

  // A timeout of 0 means no Action deadline, so there is no remainder to run out and the recovery attempt gets
  // the same "no deadline" setting.
  const hasDeadline = bootstrap.inputs.timeoutMs > 0
  const remainingMs = hasDeadline ? bootstrap.inputs.timeoutMs - (Date.now() - executionStartTime) : 0
  if (hasDeadline && remainingMs <= 0)
    return {
      ...overflowedResult,
      recoveryBoundaryUnresolved: overflowedResult.recoveryBoundaryUnresolved || recoveryBoundaryUnresolved,
    }

  const recoveryPromptOptions: PromptOptions = {
    ...promptOptions,
    sessionContext: {
      recentSessions: sessionPrep.recentSessions,
      priorWorkContext: recoveryPriorWorkContext,
    },
    currentThreadSessionId: null,
    isContinuation: false,
  }
  const recoveryExecutionConfig: ExecutionConfig = {
    ...executionConfig,
    continueSessionId: undefined,
    timeoutMs: remainingMs,
  }
  if (bootstrap.delivery === 'file-convention' && bootstrap.responseFilePath != null) {
    try {
      await fs.rm(bootstrap.responseFilePath, {force: true})
    } catch (error) {
      execLogger.warning('Failed to clear stale response file before overflow recovery', {
        responseFilePath: bootstrap.responseFilePath,
        error,
      })
    }
  }
  // Fresh ledger for the recovery session: recovery does not inherit any outstanding,
  // unknown, or settled entries from the session it replaces -- its dispatch budget
  // starts clean rather than carrying over an exhausted one.
  const recoveryLedger = createOwnershipLedger()
  // The overflowed run's event observation (if it kept one) ends here, now that the replacement is certain to start: the
  // replacement's own observation is the one the result carries to the release. An early return above keeps the
  // overflowed run's in its result instead, for the release to stop.
  await overflowedResult.liveObservation?.stop()
  const recoveryStartTime = Date.now()
  const recoveryExecResult = await backend.execute(
    recoveryPromptOptions,
    execLogger,
    recoveryExecutionConfig,
    recoveryLedger,
  )
  const recoverySessionId = await resolveSessionId(recoveryExecResult.sessionId, recoveryStartTime)

  if (recoveryExecResult.llmError?.type === 'context_overflow' && recoverySessionId != null) {
    const recoveryArchiveSucceeded = await backend.archive(recoverySessionId, execLogger)
    if (recoveryArchiveSucceeded === false) {
      execLogger.warning('Overflowed recovery session archive failed; next run may re-continue it', {
        sessionId: recoverySessionId,
      })
    }
  }

  return {
    ...recoveryExecResult,
    sessionId: recoverySessionId,
    resolvedOutputMode: overflowedResult.resolvedOutputMode,
    outputModeMigration: overflowedResult.outputModeMigration,
    ownershipLedger: recoveryLedger,
    // The overflowed session's own observation gap and unresolved ownership facts must not
    // be erased by this boundary -- see this field's doc comment and recoveryBoundaryUnresolved's.
    observationGap: overflowedResult.observationGap || recoveryExecResult.observationGap,
    recoveryBoundaryUnresolved,
    overflowRecovery: {
      recovered: recoveryExecResult.success,
      archivedSessionId: overflowedSessionId,
      archiveSucceeded,
    },
    // Overwritten by the caller (`runExecute`) once the whole phase -- including
    // this restart -- has finished; a placeholder here keeps the type satisfied.
    executionDurationMs: 0,
  }
}

export async function runExecute(
  bootstrap: BootstrapPhaseResult,
  routing: RoutingPhaseResult,
  cacheRestore: CacheRestorePhaseResult | CacheRestoreV2PhaseResult,
  sessionPrep: SessionPrepPhaseResult,
  metrics: MetricsCollector,
  startTime: number,
): Promise<ExecutePhaseResult> {
  const backend = selectExecutionBackend(cacheRestore)
  const outputModeMigration = resolveOutputModeMigration(
    routing.triggerResult.context.eventType,
    bootstrap.inputs.outputMode,
    resolveRequestedOutputModeState(),
  )
  const resolvedOutputMode = outputModeMigration.resolved

  const promptOptions: PromptOptions = {
    context: routing.agentContext,
    customPrompt: bootstrap.inputs.prompt,
    cacheStatus: cacheRestore.cacheStatus,
    sessionContext: {
      recentSessions: sessionPrep.recentSessions,
      priorWorkContext: sessionPrep.priorWorkContext,
    },
    logicalKey: sessionPrep.logicalKey ?? null,
    isContinuation: sessionPrep.isContinuation,
    currentThreadSessionId: sessionPrep.continueSessionId ?? null,
    triggerContext: routing.triggerResult.context,
    resolvedOutputMode,
    fileParts: sessionPrep.attachmentResult?.fileParts,
    responseMode: bootstrap.inputs.responseMode,
    responseDelivery: bootstrap.delivery,
    responseFilePath: bootstrap.responseFilePath,
    responseSurface: resolveResponseSurface(routing.agentContext, routing.triggerResult.context),
  }

  const skipExecution = process.env.SKIP_AGENT_EXECUTION === 'true'
  const executionStartTime = Date.now()

  let result: ExecutePhaseResult
  if (skipExecution) {
    bootstrap.logger.info('Skipping agent execution (SKIP_AGENT_EXECUTION=true)')
    result = {
      success: true,
      exitCode: 0,
      sessionId: null,
      error: null,
      tokenUsage: null,
      model: null,
      cost: null,
      prsCreated: [],
      commitsCreated: [],
      commentsPosted: 0,
      llmError: null,
      resolvedOutputMode,
      outputModeMigration,
      observationGap: false,
      recoveryBoundaryUnresolved: false,
      executionDurationMs: 0,
    }
  } else {
    const execLogger = createLogger({phase: 'execution'})
    execLogger.info('Starting OpenCode execution', {
      logicalKey: sessionPrep.logicalKey?.key ?? null,
      continueSessionId: sessionPrep.continueSessionId,
    })

    const executionConfig: ExecutionConfig = {
      agent: bootstrap.inputs.agent,
      model: bootstrap.inputs.model,
      timeoutMs: bootstrap.inputs.timeoutMs,
      continueSessionId: sessionPrep.continueSessionId ?? undefined,
      sessionTitle: sessionPrep.sessionTitle ?? undefined,
      credentialProvisioned:
        resolveResponseDelivery(routing.triggerResult.context.eventName, bootstrap.inputs.responseMode).credential ===
        'provision',
    }

    const resolveSessionId = async (
      candidateSessionId: string | null,
      afterTimestamp: number,
    ): Promise<string | null> => {
      if (candidateSessionId != null) return candidateSessionId

      const sessionLogger = createLogger({phase: 'session'})
      const latestSessionId = await backend.findLatestSessionId(
        afterTimestamp,
        sessionPrep.normalizedWorkspace,
        sessionLogger,
      )
      if (latestSessionId == null) return null

      sessionLogger.debug('Identified session from execution', {sessionId: latestSessionId})
      return latestSessionId
    }

    // One ledger per invocation, not per attempt: constructed once here and threaded
    // through to every LLM retry attempt inside `executeOpenCode` (plan Unit 11, Part 1
    // and Part 2). Overflow recovery below replaces it with a fresh one rather than
    // reusing this one across the session boundary.
    const ledger = createOwnershipLedger()
    const execResult = await backend.execute(promptOptions, execLogger, executionConfig, ledger)

    const sessionId = await resolveSessionId(execResult.sessionId, executionStartTime)

    result = {
      ...execResult,
      sessionId,
      resolvedOutputMode,
      outputModeMigration,
      ownershipLedger: ledger,
      recoveryBoundaryUnresolved: false,
      // Overwritten by the final return below once the whole phase has finished.
      executionDurationMs: 0,
    }

    const credentialProvisioned = executionConfig.credentialProvisioned === true
    const responseFileStatus = await inspectResponseFile(
      bootstrap.responseFilePath,
      promptOptions.responseSurface,
      execLogger,
    )
    // Provisioned credentials can hide completed external writes; only a non-provisioned run without a valid response may be replayed.
    if (
      result.llmError?.type === 'context_overflow' &&
      credentialProvisioned === false &&
      responseFileStatus === 'absent' &&
      sessionId != null
    ) {
      result = await recoverFromContextOverflow({
        bootstrap,
        routing,
        backend,
        sessionPrep,
        metrics,
        execLogger,
        executionStartTime,
        promptOptions,
        executionConfig,
        overflowedResult: result,
        overflowedSessionId: sessionId,
        overflowedLedger: ledger,
        resolveSessionId,
      })
    }

    execLogger.info('Completed OpenCode execution', {
      success: result.success,
      sessionId: result.sessionId,
      logicalKey: sessionPrep.logicalKey?.key ?? null,
    })
  }

  if (result.sessionId != null) {
    core.saveState(STATE_KEYS.SESSION_ID, result.sessionId)
    metrics.addSessionCreated(result.sessionId)
  }
  if (result.tokenUsage != null) {
    metrics.setTokenUsage(result.tokenUsage, result.model, result.cost)
  }
  if (result.llmError != null) {
    metrics.recordError(
      result.llmError.type,
      result.llmError.message,
      result.llmError.retryable,
      result.classificationPath,
      result.llmError.suggestedAction,
    )
  }
  for (const pr of result.prsCreated) {
    metrics.addPRCreated(pr)
  }
  for (const commit of result.commitsCreated) {
    metrics.addCommitCreated(commit)
  }
  for (let i = 0; i < result.commentsPosted; i++) {
    metrics.incrementComments()
  }

  let deferredSummary: DeferredSummaryV2 | undefined
  if (result.sessionId != null) {
    const sessionLogger = createLogger({phase: 'session'})
    deferredSummary = await backend.writeSummary(
      result.sessionId,
      {
        eventType: routing.agentContext.eventName,
        repo: routing.agentContext.repo,
        ref: routing.agentContext.ref,
        runId: Number(routing.agentContext.runId),
        cacheStatus: cacheRestore.cacheStatus,
        sessionIds: [result.sessionId],
        logicalKey: sessionPrep.logicalKey?.key,
        createdPRs: [...result.prsCreated],
        createdCommits: [...result.commitsCreated],
        duration: Math.round((Date.now() - startTime) / 1000),
        tokenUsage: result.tokenUsage,
      },
      sessionLogger,
    )
    sessionLogger.debug('Wrote session summary', {sessionId: result.sessionId})
  }

  return {
    ...result,
    ...(deferredSummary === undefined ? {} : {deferredSummary}),
    executionDurationMs: Date.now() - executionStartTime,
  }
}

/**
 * Drain: owned background work settles before the caller proceeds to
 * finalize, publish, persist, or release anything (plan Unit 10). Placed
 * ahead of finalize rather than inside cleanup, because a drain inside
 * cleanup would publish a response describing work that is still changing
 * underneath it.
 *
 * No-op (zero calls, immediate return) when `ledger` is not supplied --
 * matching the established no-ledger-means-single-session convention from
 * Units 4, 8, and 9. This is no longer a hypothetical: `src/harness/run.ts`
 * threads `execution.ownershipLedger` (populated by `runExecute` below
 * whenever execution actually ran) into this call, so a real run's
 * background dispatches are adopted and drained here. The `ledger`
 * parameter now goes unpopulated only when `SKIP_AGENT_EXECUTION=true`
 * skipped execution entirely -- in which case this call remains the same
 * no-op it always was.
 */
export interface DrainOutcome {
  /** `true` once the deadline was reached before the ledger fully drained. */
  readonly expired: boolean
  /** Entries a cancellation request was issued for (only non-zero when `expired`). */
  readonly cancelledCount: number
  /** Entries a post-cancellation reconciliation pass positively confirmed had stopped. */
  readonly settledCount: number
  /** `ledger.unknown()` at return -- entries neither settled nor confirmed cancelled. */
  readonly unknownCount: number
}

export interface RunDrainOptions {
  /** Absent means single-session: this call is a complete no-op. */
  readonly ledger?: OwnershipLedger
  readonly client: SessionClient | null
  readonly parentSessionId: string | null
  /** Directory the session runs in (`getGitHubWorkspace()`, as in `executeOpenCode`); reconciliation is scoped to it. */
  readonly directory: string
  /** Remaining budget for drain, already excluding the teardown reserve. `Number.POSITIVE_INFINITY` means no deadline. */
  readonly deadlineMs: number
  readonly logger: Logger
  /** Interval between periodic reconciliation passes. Defaults to `createLedgerReconciler`'s own default. */
  readonly reconcileIntervalMs?: number
  /** How often the wait loop re-checks `ledger.isDrainComplete()`. */
  readonly pollIntervalMs?: number
}

/** Reserve of the invocation's total timeout set aside for teardown after drain returns. */
export const DEFAULT_DRAIN_TEARDOWN_RESERVE_MS = 30_000
const DEFAULT_DRAIN_POLL_INTERVAL_MS = 250
/** Bound on each upstream call the drain makes: a reconcile pass or a child abort. */
const DRAIN_CALL_TIMEOUT_MS = 5_000

/**
 * With no drain deadline, how many consecutive reconcile passes may observe no tracked session running before
 * drain stops waiting. Work a pass observes running (a tracked session that is a live direct child of the parent)
 * is waited for without a time cap, whatever its ledger state. Unreachable work cannot be waited on: a dead server
 * fails every pass, and an entry that is not a direct child of the parent is never seen as a live child. Only
 * meaningful when the deadline is infinite; a finite deadline always waits for it.
 */
export const UNOBSERVABLE_PASSES_BEFORE_DRAIN_EXIT = 3

const NO_DRAIN_OUTCOME: DrainOutcome = {expired: false, cancelledCount: 0, settledCount: 0, unknownCount: 0}

/**
 * Remaining drain budget: the invocation's total timeout, minus what
 * execution already spent, minus the teardown reserve. The 30-second reserve
 * is measured from real teardown runs (5.1s and 14.7s observed, S3 session
 * sync dominating at up to 10.2s) and is deliberately overridable -- it
 * predates drain existing and is provisional until re-measured from the
 * drain tail (see plan "Deferred to Separate Tasks").
 *
 * A total timeout of 0 means the Action sets no deadline, so drain has none
 * either: the budget is `Number.POSITIVE_INFINITY` (the convention
 * `createExecutionDeadline().remainingMs()` uses) and the wait loop polls at
 * its normal cadence until the owned work settles. Only the workflow's
 * `timeout-minutes` or GitHub's own limit can stop it.
 */
export function computeDrainDeadlineMs(
  totalTimeoutMs: number,
  executionDurationMs: number,
  teardownReserveMs: number = DEFAULT_DRAIN_TEARDOWN_RESERVE_MS,
): number {
  if (totalTimeoutMs <= 0) return Number.POSITIVE_INFINITY
  return Math.max(0, totalTimeoutMs - teardownReserveMs - executionDurationMs)
}

type BoundedCall<T> = {readonly timedOut: false; readonly value: T} | {readonly timedOut: true}

/**
 * Runs one upstream call under `DRAIN_CALL_TIMEOUT_MS`. The race bounds this await; the signal handed to `call`
 * is aborted at the bound so a client that honors it stops the request. A call that ignores the signal is
 * abandoned, not awaited further, and its late result is the caller's to ignore.
 */
async function boundedCall<T>(call: (signal: AbortSignal) => Promise<T>): Promise<BoundedCall<T>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{readonly timedOut: true}>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({timedOut: true})
    }, DRAIN_CALL_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      (async () => call(controller.signal))().then((value): BoundedCall<T> => ({timedOut: false, value})),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * One reconcile pass under `DRAIN_CALL_TIMEOUT_MS`. A pass that does not finish in time fails like any other
 * failed pass: outstanding entries become `unknown`. Once the bound has passed, the abandoned pass can no longer
 * change the ledger, so a late answer cannot overturn the decision the drain already made. `isClosed` marks a
 * drain that has already decided (its wait loop ended): from then on the pass is inert whenever it answers.
 *
 * Resolves `true` only when the pass finished and saw a tracked session running (a live direct child of the
 * parent). A pass that failed or timed out observed nothing, so it resolves `false`.
 */
async function reconcileBounded(
  options: ReconcileLedgerOptions,
  isClosed: () => boolean = () => false,
): Promise<boolean> {
  const {ledger, logger} = options
  let abandoned = false
  const inert = (): boolean => abandoned || isClosed()
  const guardedLedger: OwnershipLedger = {
    ...ledger,
    settle: sessionId => {
      if (!inert()) ledger.settle(sessionId)
    },
    markUnknown: sessionId => {
      if (!inert()) ledger.markUnknown(sessionId)
    },
  }

  const result = await boundedCall(async signal => reconcileLedgerOnce({...options, ledger: guardedLedger, signal}))
  if (result.timedOut === false) {
    return result.value.success && result.value.data.liveTrackedSessionIds.size > 0
  }

  abandoned = true
  if (isClosed()) return false
  const outstanding = ledger.snapshot().filter(entry => entry.state === 'outstanding')
  for (const entry of outstanding) ledger.markUnknown(entry.sessionId)
  logger.warning('Ledger reconciliation timed out; marking outstanding entries unknown rather than settling them', {
    source: 'reconcileBounded',
    parentSessionId: options.parentSessionId,
    unknownCount: outstanding.length,
    timeoutMs: DRAIN_CALL_TIMEOUT_MS,
  })
  return false
}

async function cancelOutstanding(options: {
  readonly ledger: OwnershipLedger
  readonly client: SessionClient
  readonly logger: Logger
  readonly reconcileOptions: ReconcileLedgerOptions
}): Promise<DrainOutcome> {
  const {ledger, client, logger, reconcileOptions} = options

  // Final reconciliation pass BEFORE building the cancel set, so the set
  // reflects liveness as of now rather than a stale earlier snapshot: an entry
  // that settled in the meantime is not needlessly aborted, and one still live
  // is still cancelled. Reconciliation only ever settles or downgrades entries
  // the ledger already tracks -- it cannot discover an untracked child, since
  // nothing upstream distinguishes a background child session from a foreground
  // one.
  await reconcileBounded(reconcileOptions)

  // Cancel everything not confirmed settled -- outstanding AND unknown. An
  // `unknown` entry (a dropped event, or every reconciliation attempt so far
  // failing) is exactly the one most likely still live; it needs the explicit
  // abort at least as much as an `outstanding` one does.
  const unsettledEntries = ledger.snapshot().filter(entry => entry.state !== 'settled')

  logger.warning('Drain deadline reached — cancelling unsettled owned work; run reports incomplete', {
    unsettled: unsettledEntries.length,
  })

  await Promise.allSettled(
    unsettledEntries.map(async entry => {
      if (typeof client.session.abort !== 'function') return
      try {
        // A fresh signal per call: the execution deadline that just expired must not also cancel the
        // cancellation request itself, and a hung call must neither stall the drain nor outlive its bound.
        const result = await boundedCall(async signal => client.session.abort({path: {id: entry.sessionId}, signal}))
        // The SDK resolves a failed request with the failure in `error` instead of throwing.
        const envelopeError = result.timedOut
          ? undefined
          : (result.value as {readonly error?: unknown} | undefined)?.error
        if (result.timedOut || envelopeError != null) {
          logger.warning('Failed to abort owned session during drain-deadline cancellation', {
            sessionId: entry.sessionId,
            error: result.timedOut ? `abort timed out after ${DRAIN_CALL_TIMEOUT_MS}ms` : toErrorMessage(envelopeError),
          })
        }
      } catch (error) {
        logger.warning('Failed to abort owned session during drain-deadline cancellation', {
          sessionId: entry.sessionId,
          error: toErrorMessage(error),
        })
      }
    }),
  )

  // A cancellation request is not proof the child stopped -- only a positive
  // liveness check confirms it. Run one more reconciliation pass so a session
  // that already went idle is settled (confirmed) rather than left unknown.
  await reconcileBounded(reconcileOptions)

  const settledCount = unsettledEntries.filter(cancelled => {
    const current = ledger.snapshot().find(candidate => candidate.sessionId === cancelled.sessionId)
    return current?.state === 'settled'
  }).length

  // Anything reconciliation still could not positively confirm as settled falls
  // through to unknown: the cancellation was requested but nothing here
  // confirms the child actually stopped (see docs/solutions/logic-errors/
  // submission-failure-does-not-prove-the-work-never-started-2026-08-08.md).
  for (const entry of ledger.snapshot()) {
    if (entry.state !== 'settled') ledger.markUnknown(entry.sessionId)
  }

  return {
    expired: true,
    cancelledCount: unsettledEntries.length,
    settledCount,
    unknownCount: ledger.unknown(),
  }
}

export async function runDrain(options: RunDrainOptions): Promise<DrainOutcome> {
  const {
    ledger,
    client,
    parentSessionId,
    directory,
    deadlineMs,
    logger,
    reconcileIntervalMs,
    pollIntervalMs = DEFAULT_DRAIN_POLL_INTERVAL_MS,
  } = options

  if (ledger === undefined) return NO_DRAIN_OUTCOME

  if (client === null || parentSessionId === null) {
    // Nothing outstanding can be verified without a client and a session to
    // reconcile against -- honest state is unknown, never a claimed drain.
    const outstandingEntries = ledger.snapshot().filter(entry => entry.state === 'outstanding')
    for (const entry of outstandingEntries) ledger.markUnknown(entry.sessionId)
    if (outstandingEntries.length > 0) {
      logger.warning('Drain could not reconcile owned work: no session client available', {
        outstanding: outstandingEntries.length,
      })
    }
    return {
      expired: outstandingEntries.length > 0,
      cancelledCount: 0,
      settledCount: 0,
      unknownCount: ledger.unknown(),
    }
  }

  const adapter = createSdkLedgerReconcileAdapter(client, directory)
  const reconcileOptions: ReconcileLedgerOptions = {ledger, adapter, parentSessionId, logger}

  // Unconditional first pass, regardless of the ledger's current outstanding
  // count: reconciliation is the only way this ledger can learn that a
  // TRACKED entry's completion/settlement event was dropped -- a stream that
  // stays silent about an already-adopted entry has nothing else to trigger a
  // re-check (plan's central hazard, Unit 3). This does NOT cover a dispatch
  // whose adoption event itself was never observed: reconciliation settles
  // what the ledger already tracks, it never adopts an untracked session (see
  // `packages/runtime/src/agent/ledger-reconcile.ts`'s module doc for why that
  // was tried and removed -- reconciliation's two inputs, `children()` and
  // `liveSessionIds()`, cannot tell an ordinary foreground subagent from a
  // background dispatch once the adoption event itself is lost). A
  // discriminant does exist on the persisted tool part, which nothing here
  // reads today -- see that module doc for the verified shape and for what a
  // reader of it would additionally have to get right.
  let consecutiveUnobservablePasses = 0
  let waitEnded = false
  // One bounded, guarded pass. A pass that did not observe any tracked session running (it failed, timed out, or
  // saw no tracked entry as a live direct child) while work is still unsettled extends the streak; a pass that saw
  // one running resets it, whatever state the ledger holds for it: a transient failure leaves a running child
  // `unknown`, and the ledger never moves it back. Passes after the wait loop has ended count for nothing and,
  // being inert, change nothing.
  const reconcilePass = async (): Promise<void> => {
    const observedRunning = await reconcileBounded(reconcileOptions, () => waitEnded)
    if (waitEnded) return
    const workRemains = ledger.snapshot().some(entry => entry.state !== 'settled')
    consecutiveUnobservablePasses = workRemains && observedRunning === false ? consecutiveUnobservablePasses + 1 : 0
  }
  const hasDeadline = Number.isFinite(deadlineMs)
  const unobservable = (): boolean =>
    hasDeadline === false && consecutiveUnobservablePasses >= UNOBSERVABLE_PASSES_BEFORE_DRAIN_EXIT

  await reconcilePass()

  if (ledger.isDrainComplete()) return {...NO_DRAIN_OUTCOME, unknownCount: ledger.unknown()}

  if (deadlineMs > 0) {
    // Each periodic tick is a bounded, guarded pass like every other drain pass. Once the wait loop has ended the
    // drain has decided, so a pass still in flight can no longer change the ledger.
    const reconciler = createLedgerReconciler({
      ...reconcileOptions,
      intervalMs: reconcileIntervalMs,
      runPass: reconcilePass,
    })
    const deadlineAt = Date.now() + deadlineMs
    try {
      while (ledger.isDrainComplete() === false && Date.now() < deadlineAt && unobservable() === false) {
        await sleep(Math.max(0, Math.min(pollIntervalMs, deadlineAt - Date.now())))
      }
    } finally {
      reconciler.dispose()
      waitEnded = true
    }
  }

  if (ledger.isDrainComplete()) return {...NO_DRAIN_OUTCOME, unknownCount: ledger.unknown()}

  return cancelOutstanding({ledger, client, logger, reconcileOptions})
}
