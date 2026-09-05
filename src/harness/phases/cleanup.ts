import type {ObjectStoreConfig} from '@fro-bot/runtime'
import type {OpenCodeServerHandle} from '../../features/agent/index.js'
import type {ReactionContext} from '../../features/agent/types.js'
import type {AttachmentResult} from '../../features/attachments/index.js'
import type {MetricsCollector} from '../../features/observability/metrics.js'
import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import type {AgentIdentity} from '../../shared/types.js'
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
import {uploadLogArtifact} from '../../services/artifact/index.js'
import {buildCacheKeyComponents, saveCache} from '../../services/cache/index.js'
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
   */
  readonly lockEtag: string | null
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
    if (serverHandle != null) {
      try {
        const shutdownResult = await serverHandle.shutdown()
        if (!shutdownResult.quiesced) {
          bootstrapLogger.warning(
            'OpenCode server did not confirm shutdown within the quiescence window; the checkpoint that follows may race a still-live writer',
          )
        }
      } catch (shutdownError) {
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
        await syncMetadataToStore(adapter, storeConfig, agentIdentity, repo, runId, metadata, objectStoreLogger)
      } catch (error) {
        objectStoreLogger.warning('Object store artifact or metadata sync failed (non-fatal)', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const cacheComponents = buildCacheKeyComponents()

    const cacheLogger = createLogger({phase: 'cache-save'})
    const finalProjectIdPath = path.join(finalWorkspace, '.git', 'opencode')
    const cacheSaveResult = await saveCache({
      components: cacheComponents,
      runId: getGitHubRunId(),
      logger: cacheLogger,
      storagePath: getOpenCodeStoragePath(),
      authPath: getOpenCodeAuthPath(),
      projectIdPath: finalProjectIdPath,
      opencodeVersion: detectedOpencodeVersion,
      storeConfig,
    })

    // Minimal adaptation to the structured result (Unit 1 of the cache-save-result-contract
    // plan): reads .cachePersisted where this used to read the bare boolean. CACHE_SAVED
    // stays a boolean here and does not yet distinguish store-only persistence or a
    // deliberate skip — that widening to an enum, and the retry-gating logic it enables,
    // is Unit 2's job.
    if (cacheSaveResult.cachePersisted) {
      core.saveState(STATE_KEYS.CACHE_SAVED, 'true')
    }

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
    // Always release the coordination lock — even if cleanup steps above failed —
    // so the next surface (Action or Discord gateway) can proceed without waiting
    // for the 15-minute TTL to expire.
    if (lockEtag != null && storeConfig.enabled === true) {
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
          lockEtag,
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
