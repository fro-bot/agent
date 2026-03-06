import type {OpenCodeServerHandle} from '../../features/agent/index.js'
import type {ReactionContext} from '../../features/agent/types.js'
import type {AttachmentResult} from '../../features/attachments/index.js'
import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import * as path from 'node:path'
import * as core from '@actions/core'
import {completeAcknowledgment} from '../../features/agent/index.js'
import {cleanupTempFiles} from '../../features/attachments/index.js'
import {buildCacheKeyComponents, saveCache} from '../../services/cache/index.js'
import {DEFAULT_PRUNING_CONFIG, pruneSessions} from '../../services/session/index.js'
import {getGitHubRunId, getGitHubWorkspace, getOpenCodeAuthPath, getOpenCodeStoragePath} from '../../shared/env.js'
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
    })

    if (cacheSaved) {
      core.saveState(STATE_KEYS.CACHE_SAVED, 'true')
    }
  } catch (cleanupError) {
    bootstrapLogger.warning('Cleanup failed (non-fatal)', {
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    })
  } finally {
    if (serverHandle != null) {
      try {
        serverHandle.shutdown()
      } catch (shutdownError) {
        bootstrapLogger.warning('Server shutdown failed (non-fatal)', {
          error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
        })
      }
    }
  }
}
