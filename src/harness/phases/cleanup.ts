import type {ObjectStoreConfig, OwnershipLedger} from '@fro-bot/runtime'
import type {OpenCodeServerHandle} from '../../features/agent/index.js'
import type {ReactionContext} from '../../features/agent/types.js'
import type {AttachmentResult} from '../../features/attachments/index.js'
import type {MetricsCollector} from '../../features/observability/metrics.js'
import type {Octokit} from '../../services/github/types.js'
import type {CacheSaveResult} from '../../shared/cache-save-result.js'
import type {Logger} from '../../shared/logger.js'
import type {AgentIdentity} from '../../shared/types.js'
import type {LeaseController} from './acquire-lock.js'
import * as path from 'node:path'
import * as core from '@actions/core'
import {
  createS3Adapter,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCK_TTL_SECONDS,
  DEFAULT_PENDING_STALE_THRESHOLD_MS,
  DEFAULT_PRUNING_CONFIG,
  DEFAULT_STALE_THRESHOLD_MS,
  pruneSessions,
  releaseLock,
  syncArtifactsToStore,
  syncMetadataToStore,
} from '@fro-bot/runtime'
import {completeAcknowledgment} from '../../features/agent/index.js'
import {cleanupTempFiles} from '../../features/attachments/index.js'
import {writeCacheSaveResultSummary} from '../../features/observability/job-summary.js'
import {uploadLogArtifact} from '../../services/artifact/index.js'
import {buildCacheKeyComponents, saveCache} from '../../services/cache/index.js'
import {toCacheSaveStateValue} from '../../shared/cache-save-result.js'
import {
  getGitHubRunAttempt,
  getGitHubRunId,
  getGitHubWorkspace,
  getOpenCodeAuthPath,
  getOpenCodeLogPath,
  getOpenCodeStoragePath,
  isOpenCodePromptArtifactEnabled,
} from '../../shared/env.js'
import {createLogger} from '../../shared/logger.js'
import {normalizeWorkspacePath} from '../../shared/paths.js'
import {setCacheSaveResultOutput} from '../config/outputs.js'
import {STATE_KEYS} from '../config/state-keys.js'

export interface CleanupPhaseOptions {
  readonly bootstrapLogger: Logger
  readonly reactionCtx: ReactionContext | null
  readonly githubClient: Octokit | null
  readonly agentSuccess: boolean
  readonly attachmentResult: AttachmentResult | null
  readonly serverHandle: OpenCodeServerHandle | null
  readonly sessionRetention: number | null
  readonly detectedOpencodeVersion: string | null
  readonly storeConfig: ObjectStoreConfig
  readonly metrics: MetricsCollector
  readonly agentIdentity: AgentIdentity
  readonly repo: string
  readonly runId: string
  /**
   * Coordination lock ETag from `runAcquireLock`. When non-null, cleanup releases the lock
   * after all S3 sync and cache save operations complete so the next surface waits for a
   * coherent state. Null when the Action ran without a lock (S3 disabled or no lock acquired).
   * Superseded by `leaseRenewal.currentEtag()` once renewal has ticked at least once
   * successfully -- releasing with this stale value after a successful renewal would fail
   * the conditional delete's precondition, since renewal changes the lock record's ETag.
   */
  readonly lockEtag: string | null
  /**
   * The ownership ledger backing this invocation's execution (`ExecutePhaseResult.ownershipLedger`).
   * Absent or `undefined` is treated the same as an empty ledger -- persistence-safe by
   * definition, matching every run today that never dispatches background work.
   */
  readonly ownershipLedger?: OwnershipLedger
  /**
   * The lease renewal controller from `runAcquireLock`'s `acquired` outcome. `null`/`undefined`
   * when this run holds no lock (S3 disabled, acquisition failed, or held-by-other already
   * short-circuited the run) -- persistence must proceed normally in that case, not fail for
   * want of a lease it never held (see origin: R22a).
   */
  readonly leaseRenewal?: LeaseController | null
}

export async function runCleanup(options: CleanupPhaseOptions): Promise<void> {
  const {
    bootstrapLogger,
    reactionCtx,
    githubClient,
    agentSuccess,
    attachmentResult,
    serverHandle,
    sessionRetention,
    detectedOpencodeVersion,
    storeConfig,
    metrics,
    agentIdentity,
    repo,
    runId,
    lockEtag,
    ownershipLedger,
    leaseRenewal,
  } = options

  try {
    if (attachmentResult != null) {
      const attachmentCleanupLogger = createLogger({phase: 'attachment-cleanup'})
      await cleanupTempFiles(attachmentResult.tempFiles, attachmentCleanupLogger)
    }

    if (reactionCtx != null && githubClient != null) {
      const cleanupLogger = createLogger({phase: 'cleanup'})
      await completeAcknowledgment(githubClient, reactionCtx, agentSuccess, cleanupLogger)
    }

    const pruneLogger = createLogger({phase: 'prune'})
    const finalWorkspace = getGitHubWorkspace()
    if (serverHandle != null) {
      const normalizedFinalWorkspace = normalizeWorkspacePath(finalWorkspace)
      const pruningConfig = {
        ...DEFAULT_PRUNING_CONFIG,
        maxSessions: sessionRetention == null ? DEFAULT_PRUNING_CONFIG.maxSessions : sessionRetention,
      }
      const pruneResult = await pruneSessions(serverHandle.client, normalizedFinalWorkspace, pruningConfig, pruneLogger)
      if (pruneResult.prunedCount > 0) {
        pruneLogger.info('Pruned old sessions', {
          pruned: pruneResult.prunedCount,
          remaining: pruneResult.remainingCount,
        })
      }
    }

    // Shut down the OpenCode server BEFORE saving the cache.
    // Shutdown does NOT itself trigger a SQLite WAL checkpoint: merging the write-ahead
    // log into the main database file is still checkpointDatabase's job, called inside
    // saveCache below. What shutdown() now does is send the child's kill signal and then
    // wait (bounded, best-effort, via a port-liveness poll -- the SDK exposes no pid or
    // exit event to await directly) for the child to actually go away before returning,
    // so the checkpoint that follows is not racing a writer that is still alive but idle
    // (verified: a checkpoint can report success and then have the write-ahead log grow
    // again moments later from a write that was already in flight). A `quiesced: false`
    // result means that wait timed out without confirming the child exited -- the run
    // still proceeds, but the checkpoint right after should not be read as a guarantee.
    //
    // `quiescenceConfirmed` gates the cache save below (plan Unit 12): a server handle
    // that never confirmed it stopped writing is an unconfirmed writer, same as an
    // unknown ownership-ledger entry -- persistence must decline rather than risk a
    // checkpoint racing a still-live writer. No server handle at all (e.g.
    // SKIP_AGENT_EXECUTION=true) has no writer to be unconfirmed about, so it stays true.
    let quiescenceConfirmed = true
    if (serverHandle != null) {
      try {
        const shutdownResult = await serverHandle.shutdown()
        quiescenceConfirmed = shutdownResult.quiesced
        if (!shutdownResult.quiesced) {
          bootstrapLogger.warning(
            'OpenCode server did not confirm shutdown within the quiescence window; the checkpoint that follows may race a still-live writer',
          )
        }
      } catch (shutdownError) {
        quiescenceConfirmed = false
        bootstrapLogger.warning('Server shutdown failed (non-fatal)', {
          error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
        })
      }
    }

    if (storeConfig.enabled === true && repo !== '' && runId !== '') {
      const objectStoreLogger = createLogger({phase: 'object-store-artifacts'})
      try {
        const adapter = createS3Adapter(storeConfig, objectStoreLogger)
        const logPath = getOpenCodeLogPath()
        const artifactResult = await syncArtifactsToStore(
          adapter,
          storeConfig,
          agentIdentity,
          repo,
          runId,
          logPath,
          objectStoreLogger,
        )
        const snapshot = metrics.getMetrics()
        const sessionIds = [...new Set([...snapshot.sessionsUsed, ...snapshot.sessionsCreated])]
        const metadata = {
          runId,
          timestamp: new Date().toISOString(),
          tokenUsage: snapshot.tokenUsage,
          timing: {
            startTime: snapshot.startTime,
            endTime: snapshot.endTime,
            duration: snapshot.duration,
          },
          cacheStatus: snapshot.cacheStatus,
          cacheSource: snapshot.cacheSource,
          sessionIds,
          sessionsUsed: snapshot.sessionsUsed,
          sessionsCreated: snapshot.sessionsCreated,
          prsCreated: snapshot.prsCreated,
          commitsCreated: snapshot.commitsCreated,
          commentsPosted: snapshot.commentsPosted,
          model: snapshot.model,
          cost: snapshot.cost,
          errors: snapshot.errors,
          artifactUpload: artifactResult,
        }
        const metadataResult = await syncMetadataToStore(
          adapter,
          storeConfig,
          agentIdentity,
          repo,
          runId,
          metadata,
          objectStoreLogger,
        )
        if (metadataResult.success) {
          // Marks that the rich payload above landed, so post.ts's retry branch (if it
          // ever runs) knows not to overwrite it with a thin cleanupSkipped placeholder.
          core.saveState(STATE_KEYS.CLEANUP_METADATA_WRITTEN, 'true')
        }
      } catch (error) {
        objectStoreLogger.warning('Object store artifact or metadata sync failed (non-fatal)', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const cacheComponents = buildCacheKeyComponents()

    const cacheLogger = createLogger({phase: 'cache-save'})
    const finalProjectIdPath = path.join(finalWorkspace, '.git', 'opencode')

    // Persistence safety gate (plan Unit 12): decline the save entirely -- neither backend
    // is attempted -- rather than risk checkpointing or uploading state written by (or
    // guarded by) something this run can no longer vouch for. Checked in this order because
    // each is a distinct, independently-sufficient reason to decline, and only the first
    // one found is reported -- a reader needs one clear cause, not a combined list of
    // conditions that may not all still be true by the time they read it:
    //   1. Unresolved ownership: a background subagent this run owns might still be
    //      writing (unknown entries are not distinguishable from live writers -- see
    //      OwnershipLedger.isPersistenceSafe).
    //   2. Unconfirmed quiescence: the OpenCode server itself might still be writing.
    //   3. A failed lease renewal: this run can no longer be certain no other surface
    //      (Discord gateway, or a retried Action run) has taken over the coordination lock
    //      and is writing the same session state concurrently. Only checked when a lock was
    //      actually held -- a lock-free run (S3 disabled, or acquisition failed/held-by-
    //      other already short-circuited) never held a lease to lose, so it must persist
    //      normally (see origin: R22a).
    const ownershipSafe = ownershipLedger === undefined || ownershipLedger.isPersistenceSafe()
    const leaseFailed = leaseRenewal != null && leaseRenewal.hasFailed()
    const declineReason =
      ownershipSafe === false
        ? 'background subagent work this run owns is still unresolved (the ownership ledger has entries that are outstanding or unknown), so persisting could race a live writer'
        : quiescenceConfirmed === false
          ? 'the OpenCode server did not confirm it had stopped writing before this point, so the checkpoint could not be trusted to see a quiet database'
          : leaseFailed
            ? 'the coordination lease could not be renewed, so this run can no longer be certain another surface has not taken over and is writing the same session state'
            : null

    let cacheSaveResult: CacheSaveResult
    if (declineReason == null) {
      cacheSaveResult = await saveCache({
        components: cacheComponents,
        runId: getGitHubRunId(),
        logger: cacheLogger,
        storagePath: getOpenCodeStoragePath(),
        authPath: getOpenCodeAuthPath(),
        projectIdPath: finalProjectIdPath,
        opencodeVersion: detectedOpencodeVersion,
        storeConfig,
      })
    } else {
      cacheLogger.warning('Declining cache save: persistence safety could not be confirmed', {reason: declineReason})
      cacheSaveResult = {cachePersisted: false, storePersisted: false, outcome: 'ownership-declined'}
    }

    // Written on every path a result exists, not just success: a boolean-only-on-success
    // write left store-only persistence unrecorded, so the post hook saw an unset
    // CACHE_SAVED and repeated the entire save even though state was already durable.
    const cacheSaveStateValue = toCacheSaveStateValue(cacheSaveResult)
    core.saveState(STATE_KEYS.CACHE_SAVED, cacheSaveStateValue)

    // Set from cleanup, not finalize.ts: the save has not happened yet when finalize
    // writes its outputs. A throw here (e.g. no GITHUB_OUTPUT file) must not skip the
    // summary write or artifact upload below.
    try {
      setCacheSaveResultOutput(cacheSaveStateValue)
    } catch (outputError) {
      cacheLogger.warning('Failed to set cache-save-result output (non-fatal)', {
        error: outputError instanceof Error ? outputError.message : String(outputError),
      })
    }

    // A repository owner sees this without reading logs. Written here, not in
    // finalize.ts's writeJobSummary: the main summary table is already flushed by the
    // time this outcome is known. `declineReason` (undefined on every other outcome) is
    // what makes a declined persistence a visible, explained outcome rather than a silent
    // skip indistinguishable from a routine 'checkpoint-declined' or 'skipped-empty' row.
    await writeCacheSaveResultSummary(cacheSaveResult, 'main', cacheLogger, declineReason ?? undefined)

    if (isOpenCodePromptArtifactEnabled()) {
      const artifactLogger = createLogger({phase: 'artifact-upload'})
      const artifactUploaded = await uploadLogArtifact({
        logPath: getOpenCodeLogPath(),
        runId: getGitHubRunId(),
        runAttempt: getGitHubRunAttempt(),
        logger: artifactLogger,
      })
      if (artifactUploaded) {
        core.saveState(STATE_KEYS.ARTIFACT_UPLOADED, 'true')
      }
    }
  } catch (cleanupError) {
    bootstrapLogger.warning('Cleanup failed (non-fatal)', {
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    })
  } finally {
    // Stop lease renewal BEFORE releasing the lock -- renewal must keep ticking through
    // execution, drain, and the persistence step above (plan Unit 12), so this is the
    // first point after persistence where it is safe to stop it. `stop()` awaits any
    // in-flight tick so `currentEtag()` reflects the most recently confirmed renewal
    // (not the original acquisition ETag, which the release below would otherwise use
    // and fail its conditional delete's precondition against).
    let effectiveLockEtag = lockEtag
    if (leaseRenewal != null) {
      await leaseRenewal.stop()
      effectiveLockEtag = leaseRenewal.currentEtag()
    }

    // Always release the coordination lock — even if cleanup steps above failed —
    // so the next surface (Action or Discord gateway) can proceed without waiting
    // for the 15-minute TTL to expire.
    if (effectiveLockEtag != null && storeConfig.enabled === true) {
      const releaseLogger = createLogger({phase: 'lock-release'})
      try {
        const adapter = createS3Adapter(storeConfig, releaseLogger)
        const releaseResult = await releaseLock(
          {
            storeAdapter: adapter,
            storeConfig,
            lockTtlSeconds: DEFAULT_LOCK_TTL_SECONDS,
            heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
            staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
            pendingStaleThresholdMs: DEFAULT_PENDING_STALE_THRESHOLD_MS,
          },
          repo,
          effectiveLockEtag,
          releaseLogger,
        )
        if (releaseResult.success === false) {
          releaseLogger.warning('Lock release failed (non-fatal)', {
            error: releaseResult.error.message,
            repo,
          })
        } else {
          releaseLogger.debug('Lock released', {repo})
        }
      } catch (releaseError) {
        releaseLogger.warning('Lock release threw (non-fatal)', {
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          repo,
        })
      }
    }
  }
}
