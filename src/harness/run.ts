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
import type {InvocationOutcome, InvocationVerificationFacts} from './outcome.js'
import * as core from '@actions/core'
import {applyTerminalReaction} from '../features/agent/index.js'
import {createMetricsCollector, writeInvocationOutcomeSummary} from '../features/observability/index.js'
import {getGitHubRunAttempt} from '../shared/env.js'
import {createLogger} from '../shared/logger.js'
import {setActionOutputs, setInvocationOutcomeOutput} from './config/outputs.js'
import {STATE_KEYS} from './config/state-keys.js'
import {assessInvocationOutcome} from './outcome.js'
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
  let irreversiblyDelivered = false
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
  // Tracks failure/skip explicitly, set at each early-return site below, rather than
  // inferring delivery from `exitCode === 0` in the `finally` block. `return 1`/`return 0`
  // inside the `try` block already fixes this invocation's returned number before `finally`
  // runs -- mutating `exitCode` there cannot change what was already returned (JS evaluates
  // a `return` expression before running `finally`) -- so `finally` must read a fact set
  // BEFORE each return, not `exitCode` itself, to know whether that return was a genuine
  // failure, an intentional skip, or (the 'pending' default) a normal in-progress run.
  // 'failed': bootstrap or cache-restore could not even start (`return 1`). 'skipped':
  // routing found no matching trigger, dedup suppressed a repeat, or the coordination lock
  // was contended (`return 0`, but nothing was attempted -- not the same as delivered).
  let deliveryOutcome: 'pending' | 'failed' | 'skipped' = 'pending'

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
      deliveryOutcome = 'failed'
      setUnavailableActionOutputs(Date.now() - startTime)
      return 1
    }
    detectedOpencodeVersion = bootstrap.opencodeResult.version
    storeConfig = bootstrap.inputs.storeConfig
    sessionRetention = bootstrap.inputs.sessionRetention

    const routing = await runRouting(bootstrap, startTime)
    if (routing == null) {
      deliveryOutcome = 'skipped'
      setUnavailableActionOutputs(Date.now() - startTime)
      return 0
    }
    githubClient = routing.githubClient
    triggerContext = routing.triggerResult.context

    repo = `${routing.triggerResult.context.repo.owner}/${routing.triggerResult.context.repo.repo}`
    runId = routing.agentContext.runId
    const dedup = await runDedup(bootstrap.inputs.dedupWindow, routing.triggerResult.context, repo, startTime)
    if (!dedup.shouldProceed) {
      deliveryOutcome = 'skipped'
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
        deliveryOutcome = 'skipped'
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
      deliveryOutcome = 'failed'
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
    )
    exitCode = finalization.exitCode
    // A review is the one delivery this harness cannot take back: there is no marker-based
    // find-and-update path for reviews the way there is for comments, so a second run that
    // reaches the same point submits a second review rather than recognizing the first.
    irreversiblyDelivered = finalization.deliveryKind === 'review'

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
    // `deliveryOutcome`/`exitCode`, never from `execution.success` directly, which is never
    // cleared or second-guessed here.
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
        quiescenceConfirmed: cleanupResult.quiescenceConfirmed,
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

    // Dedup marker, written only after cleanup has had its say -- moved here (was: right
    // after finalize, before cleanup ran) per the same reasoning that moved the terminal
    // reaction below. A lock-contention skip reaches this point with both `dedupEntity` and
    // `triggerContext` already populated (set before the lock is even acquired), so the
    // outcome check is what stops a contended run, which delivered nothing, from marking
    // itself deduplicated anyway.
    //
    // An incomplete invocation that already delivered a REVIEW is the deliberate exception.
    // Withholding the marker there invites the rerun that the non-zero exit already signals,
    // and a rerun cannot recognize the review this run submitted -- so it submits a second
    // one. Between a missed retry and a duplicated review, the duplicate is worse and
    // irreversible. The marker records that delivery happened; it is not a claim the
    // invocation completed, which `invocation-outcome` and the job summary still report
    // honestly.
    const deduplicatable = finalOutcome === 'succeeded' || (finalOutcome === 'incomplete' && irreversiblyDelivered)
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
    await writeInvocationOutcomeSummary(finalOutcome, finalIncompleteReasons, bootstrapLogger)
  }

  return exitCode
}
