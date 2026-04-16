import type {ObjectStoreConfig} from '../services/object-store/index.js'
import type {Logger} from '../shared/logger.js'
import * as core from '@actions/core'
import {uploadLogArtifact} from '../services/artifact/index.js'
import {buildCacheKeyComponents, saveCache} from '../services/cache/index.js'
import {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} from '../services/object-store/index.js'
import {
  getGitHubRepository,
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

function readOptionalState(key: string): string | undefined {
  const value = core.getState(key)
  return value.length > 0 ? value : undefined
}

function reconstructStoreConfigFromState(): ObjectStoreConfig | undefined {
  const enabled = readOptionalState(STATE_KEYS.S3_ENABLED)
  const bucket = readOptionalState(STATE_KEYS.S3_BUCKET)
  const region = readOptionalState(STATE_KEYS.S3_REGION)
  const prefix = readOptionalState(STATE_KEYS.S3_PREFIX)

  if (enabled == null || bucket == null || region == null || prefix == null) {
    return undefined
  }

  const endpoint = readOptionalState(STATE_KEYS.S3_ENDPOINT)
  const expectedBucketOwner = readOptionalState(STATE_KEYS.S3_EXPECTED_BUCKET_OWNER)
  const allowInsecureEndpoint = readOptionalState(STATE_KEYS.S3_ALLOW_INSECURE_ENDPOINT)
  const sseEncryption = readOptionalState(STATE_KEYS.S3_SSE_ENCRYPTION)
  const sseKmsKeyId = readOptionalState(STATE_KEYS.S3_SSE_KMS_KEY_ID)

  return {
    enabled: enabled === 'true',
    bucket,
    region,
    prefix,
    endpoint,
    expectedBucketOwner,
    allowInsecureEndpoint: allowInsecureEndpoint === 'true',
    sseEncryption: sseEncryption === 'aws:kms' || sseEncryption === 'AES256' ? sseEncryption : undefined,
    sseKmsKeyId,
  }
}

export async function runPost(options: PostOptions = {}): Promise<void> {
  const logger = options.logger ?? createLogger({phase: 'post'})

  const shouldSaveCache = core.getState(STATE_KEYS.SHOULD_SAVE_CACHE)
  const cacheSaved = core.getState(STATE_KEYS.CACHE_SAVED)
  const sessionId = core.getState(STATE_KEYS.SESSION_ID) || null
  const opencodeVersion = core.getState(STATE_KEYS.OPENCODE_VERSION) || null
  const storeConfig = reconstructStoreConfigFromState()

  logger.debug('Post-action state', {
    shouldSaveCache,
    cacheSaved,
    sessionId,
    opencodeVersion,
    hasStoreConfig: storeConfig != null,
  })

  if (shouldSaveCache !== 'true') {
    logger.info('Skipping post-action: event was not processed', {shouldSaveCache})
    return
  }

  if (cacheSaved === 'true') {
    logger.info('Skipping post-action: cache already saved by main action', {cacheSaved})
  } else {
    const runId = String(getGitHubRunId())
    try {
      const components = buildCacheKeyComponents()
      const cacheSaveOptions = {
        components,
        runId: getGitHubRunId(),
        logger,
        storagePath: getOpenCodeStoragePath(),
        authPath: getOpenCodeAuthPath(),
        opencodeVersion,
        ...(storeConfig == null ? {} : {storeConfig}),
      }

      const saved = await saveCache(cacheSaveOptions)

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

    if (storeConfig?.enabled === true) {
      try {
        const objectStoreLogger = createLogger({phase: 'post-object-store'})
        const adapter = createS3Adapter(storeConfig, objectStoreLogger)
        const repo = getGitHubRepository()
        const runAttempt = getGitHubRunAttempt()
        await syncMetadataToStore(
          adapter,
          storeConfig,
          'github',
          repo,
          runId,
          {
            runId,
            timestamp: new Date().toISOString(),
            cleanupSkipped: true,
            runAttempt,
          },
          objectStoreLogger,
        )
        await syncArtifactsToStore(adapter, storeConfig, 'github', repo, runId, getOpenCodeLogPath(), objectStoreLogger)
      } catch (error) {
        logger.warning('Post-action object store sync failed (non-fatal)', {
          error: toErrorMessage(error),
        })
      }
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
