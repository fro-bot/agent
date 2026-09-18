import type {
  ObjectStoreConfig,
  OutputModeMigrationState,
  OutputModeRequestState,
  OwnershipLedger,
} from '@fro-bot/runtime'
import type {OpenCodeServerHandle} from '../features/agent/index.js'
import type {ReactionContext} from '../features/agent/types.js'
import type {AttachmentResult} from '../features/attachments/index.js'
import type {TriggerContext} from '../features/triggers/types.js'
import type {DeduplicationEntity} from '../services/cache/dedup.js'
import type {Octokit} from '../services/github/types.js'
import type {InvocationVerificationFacts} from './outcome.js'
import * as core from '@actions/core'
import {applyTerminalReaction} from '../features/agent/index.js'
import {createMetricsCollector, writeInvocationOutcomeSummary} from '../features/observability/index.js'
import {getGitHubRunAttempt} from '../shared/env.js'
import {createLogger} from '../shared/logger.js'
import {setActionOutputs, setInvocationOutcomeOutput} from './config/outputs.js'
import {STATE_KEYS} from './config/state-keys.js'
import {assessInvocationOutcome, isVerificationIncomplete} from './outcome.js'
import {runAcknowledge} from './phases/acknowledge.js'
import {runAcquireLock, type LeaseController} from './phases/acquire-lock.js'
import {runBootstrap} from './phases/bootstrap.js'
import {runCacheRestore} from './phases/cache-restore.js'
import {runCleanup} from './phases/cleanup.js'
import {runDedup, saveDedupMarker} from './phases/dedup.js'
import {computeDrainDeadlineMs, resolveRequestedOutputModeState, runDrain, runExecute} from './phases/execute.js'
import {runFinalizeWithResult} from './phases/finalize.js'
import {runReviewReconciliation} from './phases/review-reconciliation.js'
import {runRouting} from './phases/routing.js'
import {runSessionPrep} from './phases/session-prep.js'

export async function run(): Promise<number> {
  const startTime = Date.now()
  const bootstrapLogger = createLogger({phase: 'bootstrap'})
  const metrics = createMetricsCollector()
  metrics.start()

  let reactionCtx: ReactionContext | null = null
  let exitCode = 0
  let githubClient: Octokit | null = null
  let attachmentResult: AttachmentResult | null = null
  let detectedOpencodeVersion: string | null = null
  let serverHandle: OpenCodeServerHandle | null = null
  let repo = ''
  let runId = ''
  let sessionRetention: number | null = null
  let lockEtag: string | null = null
  // Renews the coordination lock's lease across execution, drain, and persistence (plan
  // Unit 12) -- null whenever this run holds no lock (S3 disabled, acquisition failed, or
  // another surface already holds it). Held here, not inside acquire-lock.ts, because it
  // must outlive the acquire-lock phase call and reach runCleanup in the finally block
  // below, exactly like lockEtag already does.
  let leaseRenewal: LeaseController | null = null
  // Hoisted out of the try block (like lockEtag above) because runCleanup runs from the
  // outer finally block, where a `const` declared inside try is out of scope. Populated
  // right after runExecute returns; stays undefined only when execution never ran
  // (SKIP_AGENT_EXECUTION=true) or the try block failed before reaching that point --
  // both cases runCleanup treats as an empty, persistence-safe ledger.
  let ownershipLedger: OwnershipLedger | undefined
  let requestedOutputModeState: OutputModeRequestState = 'omitted'
  let finalizationStarted = false
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
  let triggerContext: TriggerContext | null = null
  let dedupEntity: DeduplicationEntity | null = null

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

  core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
  // Not the boolean 'false' -- CACHE_SAVED is a CacheSaveStateValue (see
  // src/shared/cache-save-result.ts). 'not-persisted' is what "nothing has saved yet"
  // is called now, and it is also what post.ts falls back to for an absent/unrecognized
  // value, so this initial value and that fallback agree by construction.
  core.saveState(STATE_KEYS.CACHE_SAVED, 'not-persisted')

  try {
    bootstrapLogger.info('Starting Fro Bot Agent')

    requestedOutputModeState = resolveRequestedOutputModeState()
    const bootstrap = await runBootstrap(bootstrapLogger)
    if (bootstrap == null) {
      setUnavailableActionOutputs(Date.now() - startTime)
      return 1
    }
    detectedOpencodeVersion = bootstrap.opencodeResult.version
    storeConfig = bootstrap.inputs.storeConfig
    sessionRetention = bootstrap.inputs.sessionRetention

    const routing = await runRouting(bootstrap, startTime)
    if (routing == null) {
      setUnavailableActionOutputs(Date.now() - startTime)
      return 0
    }
    githubClient = routing.githubClient
    triggerContext = routing.triggerResult.context

    repo = `${routing.triggerResult.context.repo.owner}/${routing.triggerResult.context.repo.repo}`
    runId = routing.agentContext.runId
    const dedup = await runDedup(bootstrap.inputs.dedupWindow, routing.triggerResult.context, repo, startTime)
    if (!dedup.shouldProceed) {
      setUnavailableActionOutputs(Date.now() - startTime)
      return 0
    }
    dedupEntity = dedup.entity

    const lockResult = await runAcquireLock({
      storeConfig,
      repo,
      runId,
      runAttempt: getGitHubRunAttempt(),
    })
    switch (lockResult.outcome) {
      case 'acquired':
        lockEtag = lockResult.lockEtag
        leaseRenewal = lockResult.renewal
        break
      case 'held-by-other':
        bootstrapLogger.info('Skipping run — coordination lock held by another surface', {
          heldBy: lockResult.holder?.holder_id ?? null,
          surface: lockResult.holder?.surface ?? null,
        })
        setUnavailableActionOutputs(Date.now() - startTime)
        return 0
      case 's3-disabled':
      case 'error':
        // S3 disabled: lock is opt-in, proceed without coordination.
        // Error: lock acquisition failed (network, permissions, etc.) — log and proceed
        // to preserve single-surface behavior. The 15-minute TTL of any leaked lock from
        // a prior crash recovers via stale-takeover on the next acquisition attempt.
        if (lockResult.outcome === 'error') {
          bootstrapLogger.warning('Coordination lock acquisition failed; proceeding without lock', {
            error: lockResult.error.message,
          })
        }
        break
    }

    reactionCtx = await runAcknowledge(routing, bootstrap.logger)

    const cacheRestore = await runCacheRestore(bootstrap, metrics)
    if (cacheRestore == null) {
      setUnavailableActionOutputs(Date.now() - startTime)
      return 1
    }
    serverHandle = cacheRestore.serverHandle

    const sessionPrep = await runSessionPrep(bootstrap, routing, cacheRestore, metrics)
    attachmentResult = sessionPrep.attachmentResult

    const execution = await runExecute(bootstrap, routing, cacheRestore, sessionPrep, metrics, startTime)
    ownershipLedger = execution.ownershipLedger
    // Sticky, invocation-scoped facts -- feed the invocation-outcome assessment
    // (src/harness/outcome.ts), never `execution.success` itself.
    observationGap = execution.observationGap === true

    // Drain: owned background work settles before anything below this point
    // publishes, persists, or releases (Unit 10). `execution.ownershipLedger` is
    // populated whenever execution actually ran (Unit 11); it is only absent when
    // `SKIP_AGENT_EXECUTION=true` skipped execution entirely, in which case this
    // call is a no-op exactly like before.
    const drainLogger = createLogger({phase: 'drain'})
    const drainResult = await runDrain({
      ledger: execution.ownershipLedger,
      client: cacheRestore.serverHandle.client,
      parentSessionId: execution.sessionId,
      deadlineMs: computeDrainDeadlineMs(bootstrap.inputs.timeoutMs, execution.executionDurationMs),
      logger: drainLogger,
    })
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
    ownershipUnresolved = drainResult.unknownCount > 0 || execution.recoveryBoundaryUnresolved === true

    // PROVISIONAL assessment: gates publication decisions (review reconciliation's
    // automatic APPROVE, finalize's brokered push and formal-review downgrade) before
    // anything publishes. Only execution and drain facts are known at this point --
    // teardown (server quiescence, lease continuity) has not run yet, so this never
    // consults the full three-way outcome, only whether verification is ALREADY known
    // incomplete. See src/harness/outcome.ts's module doc for why this and the FINAL
    // assessment below are the same pure function called at two points.
    const provisionalVerification: InvocationVerificationFacts = {
      observationGap,
      ownershipUnresolved,
      quiescenceConfirmed: true,
      continuityUnverified: false,
    }
    const provisionallyIncomplete = isVerificationIncomplete(provisionalVerification)

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
        invocationVerified: provisionallyIncomplete === false,
        runStartMs: startTime,
        isFileConventionDelivery: bootstrap.delivery === 'file-convention',
      },
      reconciliationLogger,
    )

    metrics.end()
    finalizationStarted = true
    const finalization = await runFinalizeWithResult(
      bootstrap,
      routing,
      cacheRestore,
      execution,
      metrics,
      startTime,
      bootstrap.logger,
      {verificationIncomplete: provisionallyIncomplete},
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
    const errorMessage = error instanceof Error ? error.message : String(error)

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
    const cleanupResult = await runCleanup({
      bootstrapLogger,
      reactionCtx,
      githubClient,
      attachmentResult,
      serverHandle,
      sessionRetention,
      detectedOpencodeVersion,
      storeConfig,
      metrics,
      agentIdentity: 'github',
      repo,
      runId,
      lockEtag,
      ownershipLedger,
      leaseRenewal,
    })

    // FINAL assessment: the same pure function as the provisional call above, now with the
    // teardown facts `runCleanup` just returned. `deliverySucceeded` is derived from
    // `exitCode` (0 at this point means finalize's own delivery-success decision, which
    // already folds in execution facts -- including its existing allowance of exit 0 for a
    // recoverable LLM error whose response was still delivered) -- never re-derived from
    // `execution.success` directly, which is never cleared or second-guessed here.
    const finalVerification: InvocationVerificationFacts = {
      observationGap,
      ownershipUnresolved,
      quiescenceConfirmed: cleanupResult.quiescenceConfirmed,
      continuityUnverified: cleanupResult.continuityUnverified,
    }
    const assessment = assessInvocationOutcome({deliverySucceeded: exitCode === 0, verification: finalVerification})

    // Exit code contract: 1 for incomplete, same as failed -- no third numeric code. The
    // structured `invocation-outcome` output and job-summary row are what distinguish "the
    // harness contract was unmet" from "the agent was wrong". A `finish(1, ...)` (or
    // exitCode already non-zero) path is left exactly as finalize decided it.
    if (assessment.outcome === 'incomplete' && exitCode === 0) {
      exitCode = 1
    }

    // Dedup marker: never written on an incomplete invocation, and only after cleanup has
    // had its say -- moved here (was: right after finalize, before cleanup ran) per the
    // same reasoning that moved the terminal reaction below.
    if (assessment.outcome === 'succeeded' && dedupEntity != null && triggerContext != null) {
      await saveDedupMarker(triggerContext, dedupEntity, repo)
    }

    // Terminal reaction: a distinct three-way projection (succeeded/incomplete/failed), not
    // the boolean success/failure `completeAcknowledgment` used to receive -- moved here,
    // strictly after cleanup, because passing a boolean derived from `exitCode` before
    // teardown's own facts were known could select the success reaction for an invocation
    // this assessment now calls incomplete.
    if (reactionCtx != null && githubClient != null) {
      await applyTerminalReaction(githubClient, reactionCtx, assessment.outcome, bootstrapLogger)
    }

    setInvocationOutcomeOutput(assessment.outcome)
    await writeInvocationOutcomeSummary(assessment.outcome, assessment.incompleteReasons, bootstrapLogger)
  }

  return exitCode
}
