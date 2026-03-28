import type {Logger} from '../shared/logger.js'
import * as core from '@actions/core'
import {uploadLogArtifact} from '../services/artifact/index.js'
import {buildCacheKeyComponents, saveCache} from '../services/cache/index.js'
import {
  getGitHubRunAttempt,
  getGitHubRunId,
  getOpenCodeAuthPath,
  getOpenCodeLogPath,
  getOpenCodeStoragePath,
  isOpenCodePromptArtifactEnabled,
} from '../shared/env.js'
import {toErrorMessage} from '../shared/errors.js'
import {createLogger} from '../shared/logger.js'
import {STATE_KEYS} from './config/state-keys.js'

export interface PostOptions {
  logger?: Logger
}

export async function runPost(options: PostOptions = {}): Promise<void> {
  const logger = options.logger ?? createLogger({phase: 'post'})

  const shouldSaveCache = core.getState(STATE_KEYS.SHOULD_SAVE_CACHE)
  const cacheSaved = core.getState(STATE_KEYS.CACHE_SAVED)
  const sessionId = core.getState(STATE_KEYS.SESSION_ID) || null
  const opencodeVersion = core.getState(STATE_KEYS.OPENCODE_VERSION) || null

  logger.debug('Post-action state', {shouldSaveCache, cacheSaved, sessionId, opencodeVersion})

  if (shouldSaveCache !== 'true') {
    logger.info('Skipping post-action: event was not processed', {shouldSaveCache})
    return
  }

  if (cacheSaved === 'true') {
    logger.info('Skipping post-action: cache already saved by main action', {cacheSaved})
  } else {
    try {
      const components = buildCacheKeyComponents()

      const saved = await saveCache({
        components,
        runId: getGitHubRunId(),
        logger,
        storagePath: getOpenCodeStoragePath(),
        authPath: getOpenCodeAuthPath(),
        opencodeVersion,
      })

      if (saved) {
        logger.info('Post-action cache saved', {sessionId})
      } else {
        logger.info('Post-action: no cache content to save', {sessionId})
      }
    } catch (error) {
      logger.warning('Post-action cache save failed (non-fatal)', {
        error: toErrorMessage(error),
      })
    }
  }

  if (isOpenCodePromptArtifactEnabled()) {
    const artifactUploaded = core.getState(STATE_KEYS.ARTIFACT_UPLOADED)
    if (artifactUploaded !== 'true') {
      try {
        const artifactLogger = createLogger({phase: 'post-artifact-upload'})
        await uploadLogArtifact({
          logPath: getOpenCodeLogPath(),
          runId: getGitHubRunId(),
          runAttempt: getGitHubRunAttempt(),
          logger: artifactLogger,
        })
      } catch (error) {
        logger.warning('Post-action artifact upload failed (non-fatal)', {
          error: toErrorMessage(error),
        })
      }
    }
  }
}
