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
import type {ExecutionConfig, PromptOptions} from '../../features/agent/types.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {Logger} from '../../shared/logger.js'
import type {OutputMode, ResolvedOutputMode, TokenUsage} from '../../shared/types.js'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestorePhaseResult} from './cache-restore.js'
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
import {createLogger} from '../../shared/logger.js'
import {STATE_KEYS} from '../config/state-keys.js'
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
   * The ownership ledger backing this phase's active session (the recovery
   * session's ledger once overflow recovery has run, otherwise the original
   * session's). Absent only when execution was skipped entirely
   * (`SKIP_AGENT_EXECUTION=true`). Threaded to `runDrain` by the caller
   * (plan Unit 11).
   */
  readonly ownershipLedger?: OwnershipLedger
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
  readonly cacheRestore: CacheRestorePhaseResult
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
    cacheRestore,
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
  await runDrain({
    ledger: overflowedLedger,
    client: cacheRestore.serverHandle.client,
    parentSessionId: overflowedSessionId,
    deadlineMs: 0,
    logger: execLogger,
  })

  const archiveSucceeded = await archiveSession(cacheRestore.serverHandle.server.url, overflowedSessionId, execLogger)
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
    recoveryPriorWorkContext = await searchSessions(
      recoverySearchQuery,
      cacheRestore.serverHandle.client,
      sessionPrep.normalizedWorkspace,
      {limit: 5, excludeSessionIds: [overflowedSessionId]},
      execLogger,
    )
  } catch (error) {
    execLogger.warning('Recovery prior-work search failed; proceeding with empty context', {error})
  }
  for (const session of recoveryPriorWorkContext) {
    metrics.addSessionUsed(session.sessionId)
  }

  const remainingMs = bootstrap.inputs.timeoutMs - (Date.now() - executionStartTime)
  if (remainingMs <= 0) return overflowedResult

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
  const recoveryStartTime = Date.now()
  const recoveryExecResult = await executeOpenCode(
    recoveryPromptOptions,
    execLogger,
    recoveryExecutionConfig,
    cacheRestore.serverHandle,
    recoveryLedger,
  )
  const recoverySessionId = await resolveSessionId(recoveryExecResult.sessionId, recoveryStartTime)

  if (recoveryExecResult.llmError?.type === 'context_overflow' && recoverySessionId != null) {
    const recoveryArchiveSucceeded = await archiveSession(
      cacheRestore.serverHandle.server.url,
      recoverySessionId,
      execLogger,
    )
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
  startTime: number,
): Promise<ExecutePhaseResult> {
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
      omoProviders: bootstrap.inputs.omoProviders,
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
      const latestSession = await findLatestSession(
        cacheRestore.serverHandle.client,
        sessionPrep.normalizedWorkspace,
        afterTimestamp,
        sessionLogger,
      )
      if (latestSession == null) return null

      sessionLogger.debug('Identified session from execution', {sessionId: latestSession.session.id})
      return latestSession.session.id
    }

    // One ledger per invocation, not per attempt: constructed once here and threaded
    // through to every LLM retry attempt inside `executeOpenCode` (plan Unit 11, Part 1
    // and Part 2). Overflow recovery below replaces it with a fresh one rather than
    // reusing this one across the session boundary.
    const ledger = createOwnershipLedger()
    const execResult = await executeOpenCode(
      promptOptions,
      execLogger,
      executionConfig,
      cacheRestore.serverHandle,
      ledger,
    )

    const sessionId = await resolveSessionId(execResult.sessionId, executionStartTime)

    result = {
      ...execResult,
      sessionId,
      resolvedOutputMode,
      outputModeMigration,
      ownershipLedger: ledger,
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
        cacheRestore,
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

  if (result.sessionId != null) {
    const sessionLogger = createLogger({phase: 'session'})
    await writeSessionSummary(
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
      cacheRestore.serverHandle.client,
      sessionLogger,
    )
    sessionLogger.debug('Wrote session summary', {sessionId: result.sessionId})
  }

  return {...result, executionDurationMs: Date.now() - executionStartTime}
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
  /** Remaining budget for drain, already excluding the teardown reserve. */
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
const DRAIN_ABORT_TIMEOUT_MS = 5_000

const NO_DRAIN_OUTCOME: DrainOutcome = {expired: false, cancelledCount: 0, settledCount: 0, unknownCount: 0}

/**
 * Remaining drain budget: the invocation's total timeout, minus what
 * execution already spent, minus the teardown reserve. The 30-second reserve
 * is measured from real teardown runs (5.1s and 14.7s observed, S3 session
 * sync dominating at up to 10.2s) and is deliberately overridable -- it
 * predates drain existing and is provisional until re-measured from the
 * drain tail (see plan "Deferred to Separate Tasks").
 */
export function computeDrainDeadlineMs(
  totalTimeoutMs: number,
  executionDurationMs: number,
  teardownReserveMs: number = DEFAULT_DRAIN_TEARDOWN_RESERVE_MS,
): number {
  return Math.max(0, totalTimeoutMs - teardownReserveMs - executionDurationMs)
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
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
  await reconcileLedgerOnce(reconcileOptions)

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
        // A fresh signal: the execution deadline that just expired must not also
        // cancel the cancellation request itself.
        await client.session.abort({path: {id: entry.sessionId}, signal: AbortSignal.timeout(DRAIN_ABORT_TIMEOUT_MS)})
      } catch (error) {
        logger.warning('Failed to abort owned session during drain-deadline cancellation', {
          sessionId: entry.sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }),
  )

  // A cancellation request is not proof the child stopped -- only a positive
  // liveness check confirms it. Run one more reconciliation pass so a session
  // that already went idle is settled (confirmed) rather than left unknown.
  await reconcileLedgerOnce(reconcileOptions)

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

  const adapter = createSdkLedgerReconcileAdapter(client)
  const reconcileOptions: ReconcileLedgerOptions = {ledger, adapter, parentSessionId, logger}

  // Unconditional first pass, regardless of the ledger's current outstanding
  // count: reconciliation is the only way this ledger can learn about a
  // dispatch whose event was never observed -- a dropped event with no
  // detected discontinuity has nothing else to trigger a re-check (plan's
  // central hazard, Unit 3).
  await reconcileLedgerOnce(reconcileOptions)

  if (ledger.isDrainComplete()) return {...NO_DRAIN_OUTCOME, unknownCount: ledger.unknown()}

  if (deadlineMs > 0) {
    const reconciler = createLedgerReconciler({...reconcileOptions, intervalMs: reconcileIntervalMs})
    const deadlineAt = Date.now() + deadlineMs
    try {
      while (ledger.isDrainComplete() === false && Date.now() < deadlineAt) {
        await sleep(Math.max(0, Math.min(pollIntervalMs, deadlineAt - Date.now())))
      }
    } finally {
      reconciler.dispose()
    }
  }

  if (ledger.isDrainComplete()) return {...NO_DRAIN_OUTCOME, unknownCount: ledger.unknown()}

  return cancelOutstanding({ledger, client, logger, reconcileOptions})
}
