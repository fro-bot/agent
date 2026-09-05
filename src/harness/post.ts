import type {ObjectStoreConfig} from '@fro-bot/runtime'
import type {Logger} from '../shared/logger.js'
import * as path from 'node:path'
import * as core from '@actions/core'
import {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} from '@fro-bot/runtime'
import {writeCacheSaveResultSummary} from '../features/observability/job-summary.js'
import {uploadLogArtifact} from '../services/artifact/index.js'
import {buildCacheKeyComponents, saveCache} from '../services/cache/index.js'
import {parseCacheSaveStateValue} from '../shared/cache-save-result.js'
import {
  getGitHubRepository,
  getGitHubRunAttempt,
  getGitHubRunId,
  getGitHubWorkspace,
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
  const prefix = readOptionalState(STATE_KEYS.S3_PREFIX)

  // Region is intentionally not part of the required guard. Non-AWS providers
  // (Cloudflare R2, MinIO, Backblaze B2) may run with an empty region value,
  // and core.getState returns '' → undefined for readOptionalState. Requiring
  // region here would silently disable post-action S3 sync for those providers.
  if (enabled == null || bucket == null || prefix == null) {
    return undefined
  }

  const region = readOptionalState(STATE_KEYS.S3_REGION) ?? ''
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
  // parseCacheSaveStateValue treats an absent key (main step crashed before cleanup ran)
  // or an unrecognized value (e.g. 'true' from an older action version, or corrupted
  // state) as 'not-persisted' -- fail toward retrying the save, never toward skipping it,
  // since this post hook is the last chance to persist state for the run.
  const cacheSaved = parseCacheSaveStateValue(core.getState(STATE_KEYS.CACHE_SAVED))
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

  if (cacheSaved === 'durable' || cacheSaved === 'store-only' || cacheSaved === 'skipped') {
    // durable: the cache write itself already persisted -- nothing left to do.
    // store-only: the database is durable in the object store independently of the cache
    //   write -- only opencode.db travels through the store (DB_TRANSPORTABLE_BASENAMES),
    //   not .git/opencode or the rest of the storage dir the Actions cache carries; those
    //   Actions-cache-only files are simply rebuilt on the next run. The skip here is
    //   justified by that database durability, NOT by an inference that retrying the cache
    //   write would fail again -- that futility argument is exactly the inference this
    //   plan's Key Technical Decisions reject (see cache-save-result.ts's CacheSaveOutcome
    //   doc on cache-rejected). Repeating the save here would only repeat the store upload,
    //   adding no durability.
    // skipped: SKIP_CACHE=true -- a deliberate no-op; retrying would just repeat it.
    const skipReason =
      cacheSaved === 'durable'
        ? 'cache saved by main action'
        : cacheSaved === 'store-only'
          ? 'state persisted to the object store by main action'
          : 'main action skipped the save'
    logger.info(`Skipping post-action: ${skipReason}`, {cacheSaved})
  } else {
    const runId = String(getGitHubRunId())
    try {
      // No shutdown()/quiescence wait happens here, unlike cleanup.ts. There is no
      // OpenCodeServerHandle in this process at all -- runPost is the Action's separate
      // `post:` step, invoked by the runner as a fresh process well after the main step
      // (and everything it spawned, including the OpenCode child cleanup.ts shut down)
      // has already exited. A process boundary is a strictly stronger guarantee than the
      // port-liveness poll cleanup.ts relies on: there is no live writer left to race
      // against a checkpoint here, only the possibility that the main step's own shutdown
      // sequence never got far enough to attempt one (e.g. it crashed first). That is what
      // this retry exists to cover, and it needs no quiescence step of its own to do it.
      const components = buildCacheKeyComponents()
      // GITHUB_WORKSPACE is a runner-level environment variable set for the whole job,
      // not something that requires STATE handoff from the main step — it is available
      // here exactly the way getOpenCodeStoragePath/getOpenCodeAuthPath already are.
      // Deriving it the same way cleanup.ts does (cleanup.ts:179) keeps the two save call
      // sites symmetric: a save that only lands here still archives .git/opencode.
      const projectIdPath = path.join(getGitHubWorkspace(), '.git', 'opencode')
      const cacheSaveOptions = {
        components,
        runId: getGitHubRunId(),
        logger,
        storagePath: getOpenCodeStoragePath(),
        authPath: getOpenCodeAuthPath(),
        projectIdPath,
        opencodeVersion,
        ...(storeConfig == null ? {} : {storeConfig}),
      }

      const saveResult = await saveCache(cacheSaveOptions)

      // The post hook cannot set `cache-save-result`: GitHub Actions `runs.post:` steps run
      // after every other step in the job, so no downstream step could ever read it even if
      // the write succeeded. The job summary is the only surface available here.
      await writeCacheSaveResultSummary(saveResult, 'post-retry', logger)

      // "No cache content to save" is reserved for skipped-empty. Every other outcome gets
      // its own line naming it, so a checkpoint decline is distinguishable from a
      // rejected/errored cache write.
      if (saveResult.cachePersisted === true) {
        logger.info('Post-action cache saved', {sessionId})
      } else if (saveResult.outcome === 'skipped-empty') {
        logger.info('Post-action: no cache content to save', {sessionId})
      } else {
        logger.info(`Post-action cache save did not persist (${saveResult.outcome})`, {
          sessionId,
          storePersisted: saveResult.storePersisted,
        })
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
