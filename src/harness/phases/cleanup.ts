import type {OpenCodeServerHandle} from '../../features/agent/index.js'
import type {ReactionContext} from '../../features/agent/types.js'
import type {AttachmentResult} from '../../features/attachments/index.js'
import type {MetricsCollector} from '../../features/observability/metrics.js'
import type {Octokit} from '../../services/github/types.js'
import type {ObjectStoreConfig} from '../../services/object-store/index.js'
import type {Logger} from '../../shared/logger.js'
import type {AgentIdentity} from '../../shared/types.js'
import * as path from 'node:path'
import * as core from '@actions/core'
import {completeAcknowledgment} from '../../features/agent/index.js'
import {cleanupTempFiles} from '../../features/attachments/index.js'
import {uploadLogArtifact} from '../../services/artifact/index.js'
import {buildCacheKeyComponents, saveCache} from '../../services/cache/index.js'
import {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} from '../../services/object-store/index.js'
import {DEFAULT_PRUNING_CONFIG, pruneSessions} from '../../services/session/index.js'
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
  readonly detectedOpencodeVersion: string | null
  readonly storeConfig: ObjectStoreConfig
  readonly metrics: MetricsCollector
  readonly agentIdentity: AgentIdentity
  readonly repo: string
  readonly runId: string
}

export async function runCleanup(options: CleanupPhaseOptions): Promise<void> {
  const {
    bootstrapLogger,
    reactionCtx,
    githubClient,
    agentSuccess,
    attachmentResult,
    serverHandle,
    detectedOpencodeVersion,
    storeConfig,
    metrics,
    agentIdentity,
    repo,
    runId,
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
      const pruneResult = await pruneSessions(
        serverHandle.client,
        normalizedFinalWorkspace,
        DEFAULT_PRUNING_CONFIG,
        pruneLogger,
      )
      if (pruneResult.prunedCount > 0) {
        pruneLogger.info('Pruned old sessions', {
          pruned: pruneResult.prunedCount,
          remaining: pruneResult.remainingCount,
        })
      }
    }

    // Shut down the OpenCode server BEFORE saving the cache.
    // A clean shutdown triggers a SQLite WAL checkpoint, merging all
    // session data written during this run into the main database file.
    // Without this, sessions in the WAL are lost when only the .db file
    // is restored from cache on the next run.
    if (serverHandle != null) {
      try {
        serverHandle.shutdown()
      } catch (shutdownError) {
        bootstrapLogger.warning('Server shutdown failed (non-fatal)', {
          error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
        })
      }
    }

    if (storeConfig.enabled === true) {
      try {
        const objectStoreLogger = createLogger({phase: 'object-store-artifacts'})
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
        bootstrapLogger.warning('Object store artifact or metadata sync failed (non-fatal)', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const cacheComponents = buildCacheKeyComponents()

    const cacheLogger = createLogger({phase: 'cache-save'})
    const finalProjectIdPath = path.join(finalWorkspace, '.git', 'opencode')
    const cacheSaved = await saveCache({
      components: cacheComponents,
      runId: getGitHubRunId(),
      logger: cacheLogger,
      storagePath: getOpenCodeStoragePath(),
      authPath: getOpenCodeAuthPath(),
      projectIdPath: finalProjectIdPath,
      opencodeVersion: detectedOpencodeVersion,
      storeConfig,
    })

    if (cacheSaved) {
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
  }
}
