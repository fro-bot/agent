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
import type {InvocationOutcome, InvocationVerificationFacts} from './outcome.js'
import type {SandboxLifecycle} from './phases/sandbox-lifecycle.js'
import process from 'node:process'
import * as core from '@actions/core'
import {applyTerminalReaction} from '../features/agent/index.js'
import {createMetricsCollector, writeInvocationOutcomeSummary} from '../features/observability/index.js'
import {resolveReviewedHeadSha} from '../features/reviews/reviewed-head.js'
import {createReviewDeliveryReceiptOperations} from '../services/github/review-delivery-receipt.js'
import {getGitHubRunAttempt, getInvocationIdentity, getOpenCodeLogPath} from '../shared/env.js'
import {toErrorMessage} from '../shared/errors.js'
import {createLogger} from '../shared/logger.js'
import {setActionOutputs, setInvocationOutcomeOutput} from './config/outputs.js'
import {STATE_KEYS} from './config/state-keys.js'
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
import {snapshotLogDirectory} from './phases/log-snapshot.js'
import {mergeObservedTurn, recordObservedTurn} from './phases/observed-turn-v2.js'
import {releaseOptionsFromExecution, runReleaseV2} from './phases/release-v2.js'
import {removeRepoSkillsStaging, runRepoSkills} from './phases/repo-skills.js'
import {runReviewReconciliation} from './phases/review-reconciliation.js'
import {runRouting} from './phases/routing.js'
import {runSessionPrep} from './phases/session-prep.js'

const KEY_PROXY_CRASHED_DECLINE_REASON =
  'the isolate-agent key proxy exited unexpectedly, so the run is incomplete and no session state is saved'

export async function run(): Promise<number> {
  const startTime = Date.now()
  const bootstrapLogger = createLogger({phase: 'bootstrap'})
  const metrics = createMetricsCollector()
  metrics.start()

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
  // Set once the normal path has released the sandbox and recorded its outcome, so the `finally` does not repeat it.
  let sandboxSettled = false
  // True once an isolated run's sandbox was not confirmed stopped and restored: everything the sandbox could write is
  // then untrusted, so cleanup and the post hook read and publish none of it.
  let sandboxOutputUntrusted = false
  // The lifecycle itself records the `unsafe` state for the post hook on every release that is not a confirmed restore.
  const markSandboxUntrusted = (): void => {
    sandboxOutputUntrusted = true
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
    // Owned from here on: every exit path below releases it, including a V2 start that fails or throws.
    sandboxLifecycle = bootstrap.sandbox ?? null
    storeConfig = bootstrap.inputs.storeConfig
    sessionRetention = bootstrap.inputs.sessionRetention
    responseMode = bootstrap.inputs.responseMode

    const routing = await runRouting(bootstrap, startTime)
    if ('skipped' in routing) {
      deliveryOutcome = 'skipped'
      skipDetail = {reason: routing.skipReason, message: routing.skipMessage}
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
      jobIdentity: getInvocationIdentity(),
    })
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

    reactionCtx = await runAcknowledge(routing, bootstrap.logger)

    // After routing so a skipped event never pays for a trust lookup or a git fetch (fro-bot/agent#2129). Null unless
    // `repo-skills` is on, the run is V2 and the trust predicate admitted it.
    const repoSkills = await runRepoSkills(bootstrap, routing)
    repoSkillsStagingRoot = repoSkills?.stagingRoot ?? null

    const cacheRestore = await runCacheRestore(bootstrap, metrics, repoSkills)
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

    const sessionPrep = await runSessionPrep(bootstrap, routing, cacheRestore, metrics)
    attachmentResult = sessionPrep.attachmentResult

    // The pre-run brokered-push decision, made once. It only gates the prompt bullet telling the agent the Action
    // pushes its changes; finalize keeps its own, deliberately wider, decision so a failure to push stays loud.
    const brokeredPushPlan = resolveBrokeredPushPlan(bootstrap, routing)

    let execution = await runExecute(bootstrap, routing, cacheRestore, sessionPrep, metrics, brokeredPushPlan)
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
    const release = await runReleaseV2(
      releaseOptionsFromExecution(execution, {
        serverHandle: cacheRestore.serverHandle,
        runStartedAt: startTime,
        deadlineMs: computeDrainDeadlineMs(bootstrap.inputs.timeoutMs, execution.executionDurationMs),
        sessionRetention,
        logger: drainLogger,
      }),
    )
    serverReleasedV2 = true
    const drainResult = release.drain
    serverExitUnconfirmed = release.serverExitUnconfirmed === true
    // The server is shut down. Before anything below reads what the sandbox wrote (the response file, the checkout,
    // the database), kill and verify every process of the sandbox user and take its files back. An unconfirmed stop or an
    // unsafe restore fails the run here: no response is read, nothing is pushed, nothing is checkpointed or saved.
    if (sandboxLifecycle !== null) {
      const sandboxOutcome = await sandboxLifecycle.release()
      sandboxSettled = true
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
      {knownExecutionVeto, reviewDeliveryReceiptOps},
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
        const release = await runReleaseV2({
          serverHandle: serverHandleV2,
          executionSucceeded: false,
          rootSessionId: null,
          ledger: ownershipLedger,
          runStartedAt: startTime,
          deadlineMs: 0,
          sessionRetention,
          logger: createLogger({phase: 'drain'}),
          liveObservation,
        })
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
    // Any path that left the try block before the normal release (an exception, a failed phase) still owns a live
    // sandbox. Stop and restore it before cleanup checkpoints or saves anything.
    if (sandboxLifecycle !== null && !sandboxSettled) {
      try {
        const sandboxOutcome = await sandboxLifecycle.release()
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
    const cleanupResult = await runCleanup({
      bootstrapLogger,
      reactionCtx,
      githubClient,
      attachmentResult,
      ...(serverHandleV2 === null ? {} : {serverHandleV2}),
      storeConfig,
      metrics,
      agentIdentity: 'github',
      repo,
      runId,
      lockEtag,
      ownershipLedger,
      leaseRenewal,
      skipSessionPersistence,
      sandboxOutputUntrusted,
      isolatedRun: sandboxLifecycle !== null,
      logSnapshotPath,
      ...(persistenceDeclineReason === undefined ? {} : {persistenceDeclineReason}),
    }).finally(async () => {
      // runCleanup shuts the V2 server down; only then is the staging root, which the server reads, safe to remove.
      await removeRepoSkillsStaging(repoSkillsStagingRoot)
    })

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
    await writeInvocationOutcomeSummary(finalOutcome, finalIncompleteReasons, bootstrapLogger, skipDetail ?? undefined)

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
  }

  return exitCode
}
