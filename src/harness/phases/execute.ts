import type {
  ClassificationPath,
  ErrorInfo,
  EventType,
  OutputModeMigrationState,
  OutputModeRequestState,
  OwnershipLedger,
  SessionSearchResult,
} from '@fro-bot/runtime'
import type {LiveObservationV2} from '../../features/agent/live-observation-v2.js'
import type {ExecutionConfig, PromptOptions} from '../../features/agent/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {Logger} from '../../shared/logger.js'
import type {OutputMode, ResolvedOutputMode, TokenUsage} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {BrokeredPushPlan} from './brokered-push-plan.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import type {SessionPrepPhaseResult} from './session-prep.js'
import * as fs from 'node:fs/promises'
import process from 'node:process'
import * as core from '@actions/core'
import {createOwnershipLedger, resolveResponseDelivery} from '@fro-bot/runtime'
import {resolveOutputMode} from '../../features/agent/index.js'
import {inspectResponseFile, resolveResponseSurface} from '../../features/agent/response-file.js'
import {createLogger} from '../../shared/logger.js'
import {STATE_KEYS} from '../config/state-keys.js'
import {resolveBrokeredPushPlan} from './brokered-push-plan.js'
import {createExecutionBackendV2, type ExecutionBackend} from './execute-v2.js'
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

interface ContextOverflowRecoveryOptions {
  readonly bootstrap: BootstrapPhaseResult
  readonly routing: RoutingPhaseResult
  /** The backend `runExecute` built; the recovery restart runs on the same server. */
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
  const recoveryExecResult = await backend.execute(
    recoveryPromptOptions,
    execLogger,
    recoveryExecutionConfig,
    recoveryLedger,
  )
  const recoverySessionId = recoveryExecResult.sessionId

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
    // Monotonic like the gap above: no replacement can clear the original run's uncertainty. (The guard in `runExecute`
    // keeps an uncertain run from being replaced at all; this keeps the flag if that ever changes.)
    ...(overflowedResult.sendUncertain === true || recoveryExecResult.sendUncertain === true
      ? {sendUncertain: true}
      : {}),
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
  cacheRestore: CacheRestorePhaseResult,
  sessionPrep: SessionPrepPhaseResult,
  metrics: MetricsCollector,
  // Resolved once per invocation (run.ts) and shared with finalize; defaults to resolving here for callers
  // that do not thread it. Either way the prompt and the broker read the same decision.
  brokeredPushPlan: BrokeredPushPlan = resolveBrokeredPushPlan(bootstrap, routing),
): Promise<ExecutePhaseResult> {
  const backend = createExecutionBackendV2(cacheRestore)
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
    brokeredPushActive: brokeredPushPlan.eligible,
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

    // One ledger per invocation, not per attempt: constructed once here and threaded
    // through to every LLM retry attempt inside `executeOpenCodeV2` (plan Unit 11, Part 1
    // and Part 2). Overflow recovery below replaces it with a fresh one rather than
    // reusing this one across the session boundary.
    const ledger = createOwnershipLedger()
    const execResult = await backend.execute(promptOptions, execLogger, executionConfig, ledger)

    const sessionId = execResult.sessionId

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
    // An uncertain send (the prompt POST failed after it may have reached the server) may already have run: replaying it
    // would repeat whatever it did, so it is never archived or restarted, whatever else it reports.
    if (
      result.llmError?.type === 'context_overflow' &&
      result.sendUncertain !== true &&
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

  return {
    ...result,
    executionDurationMs: Date.now() - executionStartTime,
  }
}

/**
 * What draining owned background work left behind. `release-v2.ts` produces it for the V2 release, and `run.ts` reads
 * it to decide whether the run is complete: drain finishes before anything publishes, persists, or releases.
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

/** Reserve of the invocation's total timeout set aside for teardown after drain returns. */
export const DEFAULT_DRAIN_TEARDOWN_RESERVE_MS = 30_000

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
