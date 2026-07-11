import type {ObjectStoreConfig} from '@fro-bot/runtime'
import type {OpenCodeServerHandle} from '../features/agent/index.js'
import type {ReactionContext} from '../features/agent/types.js'
import type {AttachmentResult} from '../features/attachments/index.js'
import type {Octokit} from '../services/github/types.js'
import * as core from '@actions/core'
import {createMetricsCollector} from '../features/observability/index.js'
import {getGitHubRunAttempt} from '../shared/env.js'
import {createLogger} from '../shared/logger.js'
import {setActionOutputs} from './config/outputs.js'
import {STATE_KEYS} from './config/state-keys.js'
import {runAcknowledge} from './phases/acknowledge.js'
import {runAcquireLock} from './phases/acquire-lock.js'
import {runBootstrap} from './phases/bootstrap.js'
import {runCacheRestore} from './phases/cache-restore.js'
import {runCleanup} from './phases/cleanup.js'
import {runDedup, saveDedupMarker} from './phases/dedup.js'
import {runExecute} from './phases/execute.js'
import {runFinalize} from './phases/finalize.js'
import {runReviewReconciliation} from './phases/review-reconciliation.js'
import {runRouting} from './phases/routing.js'
import {runSessionPrep} from './phases/session-prep.js'

export async function run(): Promise<number> {
  const startTime = Date.now()
  const bootstrapLogger = createLogger({phase: 'bootstrap'})
  const metrics = createMetricsCollector()
  metrics.start()

  let reactionCtx: ReactionContext | null = null
  let agentSuccess = false
  let exitCode = 0
  let githubClient: Octokit | null = null
  let attachmentResult: AttachmentResult | null = null
  let detectedOpencodeVersion: string | null = null
  let serverHandle: OpenCodeServerHandle | null = null
  let repo = ''
  let runId = ''
  let lockEtag: string | null = null
  let storeConfig: ObjectStoreConfig = {
    enabled: false,
    bucket: '',
    region: '',
    prefix: '',
  }

  core.saveState(STATE_KEYS.SHOULD_SAVE_CACHE, 'false')
  core.saveState(STATE_KEYS.CACHE_SAVED, 'false')

  try {
    bootstrapLogger.info('Starting Fro Bot Agent')

    const bootstrap = await runBootstrap(bootstrapLogger)
    if (bootstrap == null) {
      setActionOutputs({
        sessionId: null,
        resolvedOutputMode: null,
        cacheStatus: 'miss',
        duration: Date.now() - startTime,
      })
      return 1
    }
    detectedOpencodeVersion = bootstrap.opencodeResult.version
    storeConfig = bootstrap.inputs.storeConfig

    const routing = await runRouting(bootstrap, startTime)
    if (routing == null) return 0
    githubClient = routing.githubClient

    repo = `${routing.triggerResult.context.repo.owner}/${routing.triggerResult.context.repo.repo}`
    runId = routing.agentContext.runId
    const dedup = await runDedup(bootstrap.inputs.dedupWindow, routing.triggerResult.context, repo, startTime)
    if (!dedup.shouldProceed) return 0

    const lockResult = await runAcquireLock({
      storeConfig,
      repo,
      runId,
      runAttempt: getGitHubRunAttempt(),
    })
    switch (lockResult.outcome) {
      case 'acquired':
        lockEtag = lockResult.lockEtag
        break
      case 'held-by-other':
        bootstrapLogger.info('Skipping run — coordination lock held by another surface', {
          heldBy: lockResult.holder?.holder_id ?? null,
          surface: lockResult.holder?.surface ?? null,
        })
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
    if (cacheRestore == null) return 1
    serverHandle = cacheRestore.serverHandle

    const sessionPrep = await runSessionPrep(bootstrap, routing, cacheRestore, metrics)
    attachmentResult = sessionPrep.attachmentResult

    const execution = await runExecute(bootstrap, routing, cacheRestore, sessionPrep, metrics, startTime)
    agentSuccess = execution.success

    // Review reconciliation: after the agent session, check if a formal APPROVE
    // is needed to satisfy branch protection when the agent delivered a PASS
    // verdict as a comment instead of a review event. Fail-safe — never throws.
    const reconciliationLogger = createLogger({phase: 'review-reconciliation'})
    const triggerContext = routing.triggerResult.context
    const isPullRequestReviewTrigger = triggerContext.eventType === 'pull_request'
    const prNumber =
      triggerContext.target != null && triggerContext.target.kind === 'pr' ? triggerContext.target.number : null
    await runReviewReconciliation(
      {
        octokit: routing.githubClient,
        botLogin: routing.botLogin,
        owner: triggerContext.repo.owner,
        repo: triggerContext.repo.repo,
        prNumber,
        isPullRequestReviewTrigger,
        responseModeIsGithub: bootstrap.inputs.responseMode === 'github',
        agentSucceeded: agentSuccess,
        runStartMs: startTime,
        isFileConventionDelivery: bootstrap.delivery === 'file-convention',
      },
      reconciliationLogger,
    )

    metrics.end()
    exitCode = await runFinalize(bootstrap, routing, cacheRestore, execution, metrics, startTime, bootstrap.logger)

    // Dedup marker is saved only after a confirmed successful outcome (which,
    // for file-convention runs, means finalize's delivery assertion passed —
    // exitCode === 0). Saving it earlier (before finalize) risked a failed
    // post followed by a retry being dedup-skipped and exiting 0 with no post.
    if (exitCode === 0 && agentSuccess && dedup.entity != null) {
      await saveDedupMarker(routing.triggerResult.context, dedup.entity, repo)
    }
  } catch (error) {
    exitCode = 1
    const duration = Date.now() - startTime
    const errorName = error instanceof Error ? error.name : 'UnknownError'
    const errorMessage = error instanceof Error ? error.message : String(error)

    metrics.recordError(errorName, errorMessage, false)
    metrics.end()

    setActionOutputs({
      sessionId: null,
      resolvedOutputMode: null,
      cacheStatus: 'miss',
      duration,
    })

    if (error instanceof Error) {
      bootstrapLogger.error('Agent failed', {error: error.message})
      core.setFailed(error.message)
    } else {
      bootstrapLogger.error('Agent failed with unknown error')
      core.setFailed('An unknown error occurred')
    }
  } finally {
    // agentSuccess reflects execution.success only — it says nothing about
    // whether finalize actually delivered the response. A non-zero exitCode
    // means finalize failed to deliver (or the run otherwise failed), so the
    // success reaction must not fire for that case.
    const deliverySucceeded = agentSuccess && exitCode === 0
    await runCleanup({
      bootstrapLogger,
      reactionCtx,
      githubClient,
      agentSuccess: deliverySucceeded,
      attachmentResult,
      serverHandle,
      detectedOpencodeVersion,
      storeConfig,
      metrics,
      agentIdentity: 'github',
      repo,
      runId,
      lockEtag,
    })
  }

  return exitCode
}
