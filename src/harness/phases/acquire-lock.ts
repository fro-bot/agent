import type {LockRecord, ObjectStoreConfig} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import {acquireLock, createS3Adapter, DEFAULT_LOCK_TTL_SECONDS, DEFAULT_STALE_THRESHOLD_MS} from '@fro-bot/runtime'
import {createLogger} from '../../shared/logger.js'

/**
 * Result of attempting to acquire the per-repo coordination lock.
 *
 * Discriminated union so callers exhaustively handle each outcome:
 * - `acquired`: lock held by this Action; cleanup must release using `lockEtag`
 * - `held-by-other`: another surface (Discord gateway or another Action run) holds the lock; skip cleanly
 * - `s3-disabled`: object store is not configured; coordination is opt-in, so proceed without a lock
 * - `error`: lock acquisition failed for an unexpected reason; caller decides whether to fail or proceed
 */
export type AcquireLockResult =
  | {readonly outcome: 'acquired'; readonly lockEtag: string}
  | {readonly outcome: 'held-by-other'; readonly holder: LockRecord | null}
  | {readonly outcome: 's3-disabled'}
  | {readonly outcome: 'error'; readonly error: Error}

export interface AcquireLockPhaseOptions {
  readonly storeConfig: ObjectStoreConfig
  readonly repo: string
  readonly runId: string
  readonly runAttempt: number
  readonly logger?: Logger
}

/**
 * Acquires the per-repo coordination lock so the Action and the Discord gateway
 * cannot execute concurrently against the same repository.
 *
 * Decisions captured in `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md` (Unit 3):
 * - No `validateProviderSemantics` self-test on Action invocations — the gateway runs validation
 *   at startup as the long-lived process; the Action assumes provider semantics are valid.
 * - No heartbeat in v1 — the 15-min TTL covers the median ~2-min Action run; rare long runs
 *   recover through stale takeover by the next Action or gateway run.
 * - No `RunState` record — the lock alone provides cross-surface mutual exclusion;
 *   GitHub already tracks workflow run state, so duplicating it in S3 is unnecessary.
 */
export async function runAcquireLock(options: AcquireLockPhaseOptions): Promise<AcquireLockResult> {
  const {storeConfig, repo, runId, runAttempt} = options
  const logger = options.logger ?? createLogger({phase: 'acquire-lock'})

  if (storeConfig.enabled === false) {
    logger.debug('coordination-disabled', {reason: 's3-not-configured'})
    return {outcome: 's3-disabled'}
  }

  const adapter = createS3Adapter(storeConfig, logger)
  const holderId = `action:${runId}:${runAttempt}`
  const result = await acquireLock(
    {
      storeAdapter: adapter,
      storeConfig,
      lockTtlSeconds: DEFAULT_LOCK_TTL_SECONDS,
      heartbeatIntervalMs: 0,
      staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
    },
    repo,
    holderId,
    'github',
    runId,
    logger,
  )

  if (result.success === false) {
    logger.warning('Lock acquisition failed', {error: result.error.message, repo, holderId})
    return {outcome: 'error', error: result.error}
  }

  if (result.data.acquired === true) {
    if (result.data.etag === null) {
      const error = new Error('Lock acquired but adapter returned no ETag')
      logger.warning(error.message, {repo, holderId})
      return {outcome: 'error', error}
    }
    logger.info('Lock acquired', {repo, holderId, etag: result.data.etag})
    return {outcome: 'acquired', lockEtag: result.data.etag}
  }

  logger.info('lock-held-by-other-surface', {
    repo,
    holderId,
    heldBy: result.data.holder?.holder_id ?? null,
    surface: result.data.holder?.surface ?? null,
  })
  return {outcome: 'held-by-other', holder: result.data.holder}
}
