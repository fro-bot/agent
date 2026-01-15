/**
 * Post-action hook for reliable cache persistence (RFC-017).
 *
 * This runs as a separate process via GitHub Actions `runs.post` field.
 * It executes even if the main action times out, fails, or is cancelled.
 *
 * Key behaviors:
 * - Read state from main action via core.getState()
 * - Skip if event was not processed (shouldSaveCache=false)
 * - Skip if main already saved cache (cacheSaved=true)
 * - NEVER call core.setFailed() - best-effort only
 */
import type {Logger} from './lib/logger.js'
import * as core from '@actions/core'
import {saveCache} from './lib/cache.js'
import {createLogger} from './lib/logger.js'
import {STATE_KEYS} from './lib/state-keys.js'
import {
  getGitHubRefName,
  getGitHubRepository,
  getGitHubRunId,
  getOpenCodeAuthPath,
  getOpenCodeStoragePath,
  getRunnerOS,
} from './utils/env.js'

export interface PostOptions {
  logger?: Logger
}

export async function runPost(options: PostOptions = {}): Promise<void> {
  const logger = options.logger ?? createLogger({phase: 'post'})

  const shouldSaveCache = core.getState(STATE_KEYS.SHOULD_SAVE_CACHE)
  const cacheSaved = core.getState(STATE_KEYS.CACHE_SAVED)
  const sessionId = core.getState(STATE_KEYS.SESSION_ID) || null

  logger.debug('Post-action state', {shouldSaveCache, cacheSaved, sessionId})

  if (shouldSaveCache !== 'true') {
    logger.info('Skipping post-action: event was not processed', {shouldSaveCache})
    return
  }

  if (cacheSaved === 'true') {
    logger.info('Skipping post-action: cache already saved by main action', {cacheSaved})
    return
  }

  try {
    const components = {
      agentIdentity: 'github' as const,
      repo: getGitHubRepository(),
      ref: getGitHubRefName(),
      os: getRunnerOS(),
    }

    const saved = await saveCache({
      components,
      runId: getGitHubRunId(),
      logger,
      storagePath: getOpenCodeStoragePath(),
      authPath: getOpenCodeAuthPath(),
    })

    if (saved) {
      logger.info('Post-action cache saved', {sessionId})
    } else {
      logger.info('Post-action: no cache content to save', {sessionId})
    }
  } catch (error) {
    logger.warning('Post-action cache save failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

await runPost()
