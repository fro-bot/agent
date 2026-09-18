import type {CoordinationConfig, LockRecord, ObjectStoreConfig} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import {
  acquireLock,
  createS3Adapter,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCK_TTL_SECONDS,
  DEFAULT_PENDING_STALE_THRESHOLD_MS,
  DEFAULT_STALE_THRESHOLD_MS,
  renewLease,
} from '@fro-bot/runtime'
import {createLogger} from '../../shared/logger.js'

/**
 * Controls periodic renewal of the coordination lock lease acquired by `runAcquireLock`.
 *
 * The lock's TTL (`DEFAULT_LOCK_TTL_SECONDS`, 15 minutes) was sized for the median Action
 * run and has no renewal in itself -- but drain (plan Unit 10) can extend a run's
 * protected interval well past that, and execution plus a slow cache checkpoint/upload add
 * more on top. Without renewal, a long-running invocation's lease can expire mid-run,
 * letting another surface (the Discord gateway, or a retried Action run) take the lock
 * while this run is still writing.
 *
 * `hasFailed()` lets a caller check renewal health WITHOUT stopping the timer -- this
 * matters because the lease must keep renewing THROUGH the persistence step itself (the
 * checkpoint and cache/object-store upload), so a caller cannot stop-then-decide without
 * also ending renewal before persistence is what needs it protected.
 */
export interface LeaseController {
  /**
   * `true` when the MOST RECENT renewal tick failed -- not latched across the whole
   * lease lifetime. A later successful renewal resets this back to `false` (see the
   * `tick()` implementation and `acquire-lock.test.ts`'s "hasFailed() reflects the
   * most recent tick, not history" case): a conditional write succeeding against the
   * current ETag is fresh evidence the lock is still held, so there is nothing left
   * for a stale failure to warn about. A failed renewal still fails closed in the
   * moment -- a caller about to persist state right after a failed tick must treat
   * this the same as an unconfirmed writer -- but that protection does not survive
   * a subsequent confirmed success.
   */
  readonly hasFailed: () => boolean
  /**
   * The most recently confirmed lock ETag (the initial acquisition ETag if no renewal has
   * succeeded yet). A caller releasing the lock after renewal has run must use this, not
   * the original acquisition ETag -- the lock record's ETag changes on every successful
   * renewal, and releasing with a stale one fails the conditional delete's precondition.
   */
  readonly currentEtag: () => string
  /**
   * Stop the renewal timer and wait, up to `STOP_GRACE_PERIOD_MS`, for any in-flight tick to
   * settle, so `hasFailed()` and `currentEtag()` reflect the final state before the caller acts
   * on them. A renewal that is still in flight past the grace period is left to finish on its
   * own (bounded by `RENEWAL_TIMEOUT_MS`) and `stop()` returns anyway -- cleanup's budget takes
   * priority over an up-to-the-tick `currentEtag()`. In that case `currentEtag()` may be stale,
   * which makes the caller's conditional release fail safely rather than block. Idempotent.
   */
  readonly stop: () => Promise<void>
}

/**
 * Bounds a single lease renewal call -- a remote conditional write with no timeout of its
 * own. Well under `DEFAULT_HEARTBEAT_INTERVAL_MS` (30s) so a stalled call settles (as a
 * failure) before the next tick is due, instead of silently skipping ticks forever: `tick()`
 * refuses to overlap while `inFlight` is unsettled.
 */
const RENEWAL_TIMEOUT_MS = 10_000

/**
 * How long `stop()` waits for an in-flight renewal before giving up and returning anyway.
 * Short relative to cleanup's overall budget -- it exists to let a normal (sub-second) tick
 * settle so `currentEtag()` is fresh, not to guarantee freshness unconditionally.
 */
const STOP_GRACE_PERIOD_MS = 5_000

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const handle = setTimeout(resolve, ms)
    handle.unref?.()
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(message)), timeoutMs)
    handle.unref?.()
    promise.then(
      value => {
        clearTimeout(handle)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(handle)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function createLeaseController(
  config: CoordinationConfig,
  repo: string,
  holderId: string,
  runId: string,
  initialEtag: string,
  logger: Logger,
): LeaseController {
  let currentEtag = initialEtag
  let failed = false
  let inFlight: Promise<void> | null = null

  const tick = (): void => {
    if (inFlight != null) return

    const lockRecord: LockRecord = {
      repo,
      holder_id: holderId,
      surface: 'github',
      acquired_at: new Date().toISOString(),
      ttl_seconds: config.lockTtlSeconds,
      run_id: runId,
    }

    inFlight = withTimeout(
      renewLease(config, repo, lockRecord, currentEtag, logger),
      RENEWAL_TIMEOUT_MS,
      `Lease renewal exceeded ${RENEWAL_TIMEOUT_MS}ms`,
    )
      .then(renewed => {
        if (renewed.success === false) {
          failed = true
          logger.warning('Coordination lease renewal failed', {repo, holderId, error: renewed.error.message})
          return
        }
        failed = false
        currentEtag = renewed.data.etag
      })
      .catch((error: unknown) => {
        failed = true
        logger.warning('Coordination lease renewal threw', {
          repo,
          holderId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        inFlight = null
      })
  }

  const intervalHandle = setInterval(tick, DEFAULT_HEARTBEAT_INTERVAL_MS)
  // Never let this timer hold the Action's process open on its own -- the run always
  // reaches runCleanup's finally block, which calls stop() regardless of outcome, but
  // unref is a defensive backstop against a future early-exit path that forgets to.
  intervalHandle.unref()

  return {
    hasFailed: () => failed,
    currentEtag: () => currentEtag,
    stop: async (): Promise<void> => {
      clearInterval(intervalHandle)
      if (inFlight == null) return
      // A tick still in flight past the grace period is left to finish on its own (bounded by
      // RENEWAL_TIMEOUT_MS); stop() does not wait for it further.
      await Promise.race([inFlight, delay(STOP_GRACE_PERIOD_MS)])
    },
  }
}

/**
 * Result of attempting to acquire the per-repo coordination lock.
 *
 * Discriminated union so callers exhaustively handle each outcome:
 * - `acquired`: lock held by this Action; cleanup must release using `lockEtag` (or, once
 *   `renewal` has ticked, `renewal.currentEtag()`) and must stop `renewal` before releasing.
 * - `held-by-other`: another surface (Discord gateway or another Action run) holds the lock; skip cleanly
 * - `s3-disabled`: object store is not configured; coordination is opt-in, so proceed without a lock
 * - `error`: lock acquisition failed for an unexpected reason; caller decides whether to fail or proceed
 */
export type AcquireLockResult =
  | {readonly outcome: 'acquired'; readonly lockEtag: string; readonly renewal: LeaseController}
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
 * Design decisions (see `docs/plans/2026-04-18-001-feat-fro-bot-gateway-discord-v1-plan.md`
 * and `docs/plans/2026-09-14-001-feat-background-subagent-ownership-plan.md` Unit 12):
 * - No `validateProviderSemantics` self-test on Action invocations — the gateway runs validation
 *   at startup as the long-lived process; the Action assumes provider semantics are valid.
 * - A lease renewal timer now runs for the duration of `acquired` outcomes (see
 *   `LeaseController`) — the original v1 no-heartbeat design relied on the 15-min TTL
 *   alone, sized for the median ~2-min Action run; drain (Unit 10) can push a run's
 *   protected interval well past that, so the lease must now renew across execution,
 *   drain, and persistence rather than relying on the TTL outliving the run.
 * - No `RunState` record — the lock alone provides cross-surface mutual exclusion;
 *   GitHub already tracks workflow run state, so duplicating it in S3 is unnecessary.
 *   `LeaseController` renews only the lock record (`renewLease`), never a `RunState` --
 *   it does not reuse `packages/runtime/src/coordination/heartbeat.ts`'s
 *   `createHeartbeatController`, which reads and writes a `RunState` object this design
 *   deliberately does not create.
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
  const config: CoordinationConfig = {
    storeAdapter: adapter,
    storeConfig,
    lockTtlSeconds: DEFAULT_LOCK_TTL_SECONDS,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
    pendingStaleThresholdMs: DEFAULT_PENDING_STALE_THRESHOLD_MS,
  }
  const result = await acquireLock(config, repo, holderId, 'github', runId, logger)

  if (result.success === false) {
    logger.warning('Lock acquisition failed', {error: result.error.message, repo, holderId})
    return {outcome: 'error', error: result.error}
  }

  if (result.data.acquired === true) {
    logger.info('Lock acquired', {repo, holderId, etag: result.data.etag})
    const renewal = createLeaseController(config, repo, holderId, runId, result.data.etag, logger)
    return {outcome: 'acquired', lockEtag: result.data.etag, renewal}
  }

  logger.info('lock-held-by-other-surface', {
    repo,
    holderId,
    heldBy: result.data.holder?.holder_id ?? null,
    surface: result.data.holder?.surface ?? null,
  })
  return {outcome: 'held-by-other', holder: result.data.holder}
}
