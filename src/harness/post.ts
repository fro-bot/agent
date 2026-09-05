import type {ObjectStoreConfig} from '@fro-bot/runtime'
import type {Logger} from '../shared/logger.js'
import * as path from 'node:path'
import * as core from '@actions/core'
import {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} from '@fro-bot/runtime'
import {writeCacheSaveResultSummary} from '../features/observability/job-summary.js'
import {uploadLogArtifact} from '../services/artifact/index.js'
import {buildCacheKeyComponents, saveCache} from '../services/cache/index.js'
import {parseCacheSaveStateValue, toCacheSaveStateValue} from '../shared/cache-save-result.js'
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
    // store-only: the object store already persisted the same state independently of the
    //   cache write. The skip here is justified by durability already achieved through
    //   that other backend, NOT by an inference that retrying the cache write would fail
    //   again -- that futility argument is exactly the inference this plan's Key Technical
    //   Decisions reject (see cache-save-result.ts's CacheSaveOutcome doc on cache-rejected).
    //   Repeating the save here would only repeat the store upload, adding no durability.
    // skipped: SKIP_CACHE=true or no cacheable content -- a deliberate no-op; retrying
    //   would just repeat the same no-op.
    logger.info('Skipping post-action: cache already saved by main action', {cacheSaved})
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

      // The post hook cannot set the `cache-save-result` output for this retry: GitHub
      // Actions outputs are step-scoped, and `runs.post:` steps execute after every other
      // step in the job has already completed (GitHub Actions docs, "metadata syntax for
      // GitHub Actions" — runs.post; core.setOutput itself, @actions/core/lib/core.js:158,
      // just appends a key/value line to whatever GITHUB_OUTPUT file is current for this
      // process at call time). Even if the write itself succeeded, no downstream step
      // could exist to read it, because any such step would have had to run before this
      // one. The job summary is the only surface available here, so the retry's actual
      // result -- which may be a red state the main step's own summary never saw, since
      // that result did not exist yet when finalize.ts wrote it -- is written there instead.
      await writeCacheSaveResultSummary(toCacheSaveStateValue(saveResult), logger)

      // "No cache content to save" is reserved for skipped-empty — the one outcome that
      // actually means it. Every other outcome gets its own line naming the outcome, so a
      // checkpoint decline (retryable, the existing #1519 guarantee) is distinguishable
      // in the log from a rejected/errored cache write, rather than both being reported as
      // the same misleadingly specific "no content" claim.
      if (saveResult.cachePersisted) {
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
