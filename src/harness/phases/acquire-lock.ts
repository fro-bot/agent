import type {
  CoordinationConfig,
  LockRecord,
  LockScope,
  ObjectStoreConfig,
  ReleaseIfHolderOutcome,
} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {Result} from '../../shared/types.js'
import {randomUUID} from 'node:crypto'
import * as core from '@actions/core'
import {
  acquireLock,
  createLeaseLoop,
  createS3Adapter,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCK_TTL_SECONDS,
  DEFAULT_PENDING_STALE_THRESHOLD_MS,
  DEFAULT_STALE_THRESHOLD_MS,
  HEARTBEAT_STOP_GRACE_MS,
  isValidHolderJob,
  releaseLock,
  releaseLockIfHolder,
  renewLease,
} from '@fro-bot/runtime'
import {createLogger} from '../../shared/logger.js'
import {STATE_KEYS} from '../config/state-keys.js'

/**
 * The Action's lock object (`.../locks/action.json`), distinct from the gateway's `repo.json`.
 * Action runs exclude each other because they share one S3 session object (`sessions/opencode.db`,
 * uploaded unconditionally, last writer wins). The Action and the gateway share no disk or session
 * database, so they do not exclude each other. Cleanup's release must use this same scope.
 */
export const ACTION_LOCK_SCOPE = 'action' as const satisfies LockScope

/**
 * Controls periodic renewal of the coordination lock lease acquired by `runAcquireLock`.
 *
 * The lock's TTL (`DEFAULT_LOCK_TTL_SECONDS`, 15 minutes) was sized for the median Action
 * run and has no renewal in itself -- but drain (plan Unit 10) can extend a run's
 * protected interval well past that, and execution plus a slow cache checkpoint/upload add
 * more on top. Without renewal, a long-running invocation's lease can expire mid-run,
 * letting another Action run take the lock while this run is still writing the shared
 * session object.
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
   * lease loop's tick and `acquire-lock.test.ts`'s "hasFailed() reflects the
   * most recent tick, not history" case): a conditional write succeeding against the
   * current ETag is fresh evidence the lock is still held, so there is nothing left
   * for a stale failure to warn about. A failed renewal still fails closed in the
   * moment -- a caller about to persist state right after a failed tick must treat
   * this the same as an unconfirmed writer -- but that protection does not survive
   * a subsequent confirmed success.
   *
   * This reflects present renewal health only. For whether uninterrupted coverage was
   * ever in doubt during this invocation, see `continuityUnverified()` below -- the two
   * answer different questions and a caller that needs the latched one must not
   * substitute this for it.
   */
  readonly hasFailed: () => boolean
  /**
   * Latches to `true` the first time this invocation cannot vouch for uninterrupted lock
   * coverage, and never clears -- unlike `hasFailed()`, a later successful renewal does
   * NOT reset it. Two things can set it:
   *   1. A renewal tick fails or throws. A successful renewal IS meaningful evidence, not
   *      a mere heartbeat -- it is a conditional write against the previously confirmed
   *      ETag (`packages/runtime/src/coordination/lock.ts`'s `renewLease`), so an
   *      intervening takeover would make it fail its condition. But what a failed tick
   *      proves is only that THAT tick could not confirm coverage -- not that the lock was
   *      lost, and not that another writer took over. Hence "continuity was not verified",
   *      not "lease lost".
   *   2. `stop()` returns with a renewal tick still unresolved (see `stop()` below) -- an
   *      unresolved tick is itself a gap in coverage, not a pass.
   * A later successful renewal after either case still advances `currentEtag()` (see
   * below) -- that part must keep working, since release needs the freshest ETag -- but it
   * does not erase the fact that coverage was, at some point, unverified for this
   * invocation.
   *
   * Optional (not `hasFailed`'s peer in strictness) only so existing hand-built
   * `LeaseController` test doubles elsewhere in the codebase, which predate this accessor and
   * are out of this change's scope, keep compiling without modification. The real controller
   * returned by `createLeaseController` below always implements it.
   */
  readonly continuityUnverified?: () => boolean
  /**
   * Waits for any renewal tick that is currently in flight to settle -- WITHOUT stopping the
   * timer, unlike `stop()`. A caller that is about to make a persistence decision based on
   * `continuityUnverified()`/`hasFailed()` right now, but must keep renewal running through
   * the save that follows, calls this first so that reading is authoritative for the tick that
   * was in flight at decision time -- otherwise a tick that resolves unverified moments after
   * the gate already read clean would leave the save proceeding uncovered (see `cleanup.ts`'s
   * persistence safety gate). Bounded by the in-flight tick's own `RENEWAL_TIMEOUT_MS` (the
   * tick's promise always settles, never rejects, once that timeout elapses) -- no extra grace
   * period of its own. A no-op when nothing is in flight.
   *
   * Optional for the same reason `continuityUnverified` is optional: existing hand-built
   * `LeaseController` test doubles that predate this accessor keep compiling without it. The
   * real controller returned by `createLeaseController` below always implements it.
   */
  readonly settle?: () => Promise<void>
  /**
   * The most recently confirmed lock ETag (the initial acquisition ETag if no renewal has
   * succeeded yet). A caller releasing the lock after renewal has run must use this, not
   * the original acquisition ETag -- the lock record's ETag changes on every successful
   * renewal, and releasing with a stale one fails the conditional delete's precondition.
   */
  readonly currentEtag: () => string
  /**
   * Stop the renewal timer and wait, up to `HEARTBEAT_STOP_GRACE_MS`, for any in-flight tick to
   * settle, so `hasFailed()` and `currentEtag()` reflect the final state before the caller acts
   * on them. A renewal that is still in flight past the grace period is left to finish on its
   * own (bounded by `RENEWAL_TIMEOUT_MS`) and `stop()` returns anyway -- cleanup's budget takes
   * priority over an up-to-the-tick `currentEtag()`. In that case `currentEtag()` may be stale,
   * which makes the caller's conditional release fail safely rather than block. An unresolved
   * tick at this point also latches `continuityUnverified()` -- returning without knowing
   * whether that tick succeeded or failed is itself coverage uncertainty, not a pass. Idempotent.
   */
  readonly stop: () => Promise<void>
}

/**
 * Bounds a single lease renewal call -- a remote conditional write with no timeout of its
 * own. Well under `DEFAULT_HEARTBEAT_INTERVAL_MS` (30s) so a stalled call settles (as a
 * failure) before the next tick is due, instead of silently skipping ticks forever: the lease loop
 * refuses to overlap ticks while one is in flight.
 */
const RENEWAL_TIMEOUT_MS = 10_000

/** Rejects with `message` if `promise` has not settled within `timeoutMs`; the underlying work is left to finish. */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

/**
 * The Action's view over the shared runtime lease loop. The loop owns scheduling, the per-renewal timeout, the overlap
 * guard, the stop budget and the failure state; this supplies the Action's renewal (`renewLease` on its own lock scope)
 * and the record it rewrites on every tick.
 */
function createLeaseController(
  config: CoordinationConfig,
  repo: string,
  holderId: string,
  holderJob: string | undefined,
  acquisitionToken: string,
  runId: string,
  initialEtag: string,
  logger: Logger,
): LeaseController {
  const loop = createLeaseLoop({
    // `renewLease` is called through the `@fro-bot/runtime` import, so the package-boundary test seam still applies.
    renew: async (record, etag) => renewLease(config, repo, record, etag, logger, ACTION_LOCK_SCOPE),
    initialEtag,
    intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    tickTimeoutMs: RENEWAL_TIMEOUT_MS,
    stopBudgetMs: HEARTBEAT_STOP_GRACE_MS,
    // Never let these timers hold the Action's process open on their own -- the run always reaches runCleanup's
    // finally block, which calls stop() regardless of outcome, but unref is a defensive backstop against a future
    // early-exit path that forgets to.
    unref: true,
    abortOnDeadline: false,
    tick: async ctx => {
      const lockRecord: LockRecord = {
        repo,
        holder_id: holderId,
        surface: 'github',
        acquired_at: new Date().toISOString(),
        ttl_seconds: config.lockTtlSeconds,
        run_id: runId,
        // Every renewal rewrites the whole record, so the job and token must be carried or the first tick would erase them.
        ...(holderJob === undefined ? {} : {holder_job: holderJob}),
        acquisition_token: acquisitionToken,
      }
      await ctx.renewLock(lockRecord)
    },
    logger,
    logContext: {repo, holderId},
  })
  loop.start()

  return {
    hasFailed: loop.hasFailed,
    continuityUnverified: loop.continuityUnverified,
    currentEtag: loop.currentEtag,
    settle: loop.settle,
    stop: async (): Promise<void> => {
      // The loop reports why it stopped (a failed last tick, a tick still pending); the Action's cleanup reads
      // `hasFailed()`/`continuityUnverified()`/`currentEtag()` instead, so the result is not needed here.
      await loop.stop()
    },
  }
}

/**
 * Builds the Action's coordination holder id, `action:{runId}:{attempt}`. The job identity deliberately stays out of
 * it: older agent versions recognize an Action lease only by this exact shape (`ACTION_HOLDER_ID_PATTERN`) and would
 * treat any other `holder_id` as an unreclaimable foreign lock. The job travels in `LockRecord.holder_job`.
 */
function buildActionHolderId(runId: string, runAttempt: number): string {
  return `action:${runId}:${runAttempt}`
}

const ACTION_HOLDER_ID_PATTERN = /^action:(\d+):(\d+)$/

/** True only for ids produced by `buildActionHolderId`. */
function isActionHolderId(holderId: string): boolean {
  return ACTION_HOLDER_ID_PATTERN.test(holderId)
}

/**
 * Splits an Action holder id, or `null` for anything that is not a well-formed `action:{numeric runId}:{attempt >= 1}`
 * id. The holder id comes from S3, so callers must not trust other shapes.
 */
function parseActionHolderId(holderId: string): {readonly runId: string; readonly attempt: number} | null {
  const match = ACTION_HOLDER_ID_PATTERN.exec(holderId)
  if (match == null) return null
  const [, runId, attemptText] = match
  const attempt = Number(attemptText)
  if (runId == null || Number.isSafeInteger(attempt) === false || attempt < 1) return null
  return {runId, attempt}
}

/** Extracts the workflow run id from an Action holder id; `null` for any other shape. */
export function parseActionHolderRunId(holderId: string): string | null {
  return ACTION_HOLDER_ID_PATTERN.exec(holderId)?.[1] ?? null
}

/**
 * How long a lease must go unrenewed before a later attempt of the same job may displace it: 3 renewal ticks. A live
 * holder renews every `DEFAULT_HEARTBEAT_INTERVAL_MS`, so it never reaches this; a dead runner does after ~90s.
 */
export const SAME_RUN_TAKEOVER_MIN_UNRENEWED_MS = 3 * DEFAULT_HEARTBEAT_INTERVAL_MS

interface ActionSelf {
  readonly runId: string
  readonly runAttempt: number
  /** `undefined` when this invocation has no usable job identity. */
  readonly holderJob: string | undefined
}

/**
 * True for a GitHub-surface Action holder that is a strictly earlier attempt of this run AND this job, and has gone
 * unrenewed for `SAME_RUN_TAKEOVER_MIN_UNRENEWED_MS`. GitHub starts a re-run only after the previous attempt
 * finished, but a re-run can also start while an orphaned process of that attempt is still winding down, and sibling
 * jobs of one run run concurrently -- hence the `holder_job` match and the staleness gate. A record without
 * `holder_job` (legacy writer) or with an unreadable timestamp is never eligible: that lease is reclaimed on expiry
 * like any other.
 */
function isStaleEarlierAttemptOfJob(holder: LockRecord, self: ActionSelf, observedAt: Date): boolean {
  if (holder.surface !== 'github' || self.holderJob === undefined) return false
  const parsed = parseActionHolderId(holder.holder_id)
  if (parsed == null || parsed.runId !== self.runId || parsed.attempt >= self.runAttempt) return false
  if (holder.holder_job !== self.holderJob) return false
  // `acquired_at` is rewritten on every renewal (the lease loop's tick, `renewLease`), so it is the last renewal time.
  const lastRenewedMs = new Date(holder.acquired_at).getTime()
  if (Number.isFinite(lastRenewedMs) === false) return false
  return observedAt.getTime() - lastRenewedMs >= SAME_RUN_TAKEOVER_MIN_UNRENEWED_MS
}

function createActionCoordinationConfig(storeConfig: ObjectStoreConfig, logger: Logger): CoordinationConfig {
  return {
    storeAdapter: createS3Adapter(storeConfig, logger),
    storeConfig,
    lockTtlSeconds: DEFAULT_LOCK_TTL_SECONDS,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
    pendingStaleThresholdMs: DEFAULT_PENDING_STALE_THRESHOLD_MS,
  }
}

export interface ReleaseActionLockOptions {
  readonly storeConfig: ObjectStoreConfig
  readonly repo: string
  readonly holderId: string
  /** The `holder_job` recorded at acquisition, or `undefined` if none was. */
  readonly holderJob?: string
  /** The `acquisition_token` recorded at acquisition; when given, the lock must carry the same one. */
  readonly acquisitionToken?: string
  /** Aborts the release's requests; no delete starts after it aborts. */
  readonly signal?: AbortSignal
  readonly logger: Logger
}

/**
 * Deletes the Action lock only while it is still held by `holderId`, `holderJob` and `acquisitionToken`. Used by the
 * post hook to free a lock whose main step died before cleanup's release; never touches a successor's lock.
 */
export async function releaseActionLockIfHeld(
  options: ReleaseActionLockOptions,
): Promise<Result<ReleaseIfHolderOutcome, Error>> {
  const {storeConfig, repo, holderId, holderJob, acquisitionToken, signal, logger} = options
  return releaseLockIfHolder(
    createActionCoordinationConfig(storeConfig, logger),
    repo,
    holderId,
    logger,
    ACTION_LOCK_SCOPE,
    {
      holderJob,
      acquisitionToken,
      signal,
    },
  )
}

/** Bounds a lock release's remote calls so a stalled store cannot hang the step that issued it. */
export const LOCK_RELEASE_TIMEOUT_MS = 10_000

/**
 * Runs `work` with an `AbortSignal` that fires when `timeoutMs` elapses, and rejects with `message` at that point.
 * Unlike a bare `withTimeout`, the abort stops the in-flight requests, so a stalled socket cannot keep the process
 * alive and a late read cannot go on to start a write.
 */
export async function runWithDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController()
  try {
    return await withTimeout(work(controller.signal), timeoutMs, message)
  } catch (error) {
    controller.abort(error)
    throw error
  }
}

/**
 * Frees a lock this call just acquired; a failure only means the lease runs out on its own. Bounded by
 * `LOCK_RELEASE_TIMEOUT_MS`; never throws.
 */
async function releaseBestEffort(
  config: CoordinationConfig,
  repo: string,
  etag: string,
  logger: Logger,
): Promise<void> {
  try {
    const released = await runWithDeadline(
      async signal => releaseLock(config, repo, etag, logger, ACTION_LOCK_SCOPE, signal),
      LOCK_RELEASE_TIMEOUT_MS,
      `Lock release exceeded ${LOCK_RELEASE_TIMEOUT_MS}ms`,
    )
    if (released.success === false) {
      logger.warning('Releasing the lock after a failed holder record failed', {error: released.error.message, repo})
    }
  } catch (error) {
    logger.warning('Releasing the lock after a failed holder record threw', {
      error: error instanceof Error ? error.message : String(error),
      repo,
    })
  }
}

/**
 * Result of attempting to acquire the per-repo Action coordination lock.
 *
 * Discriminated union so callers exhaustively handle each outcome:
 * - `acquired`: lock held by this Action; cleanup must release using `lockEtag` (or, once
 *   `renewal` has ticked, `renewal.currentEtag()`) and must stop `renewal` before releasing.
 * - `held-by-other`: another Action holds the lock, an expired non-Action lease was not corroborated, or a takeover
 *   lost a race; skip cleanly. `reason` carries the lock outcome so the caller can explain the decline.
 * - `s3-disabled`: object store is not configured; coordination is opt-in, so proceed without a lock
 * - `error`: lock acquisition failed for an unexpected reason (store, config, network); S3 is configured here, so the
 *   caller fails closed rather than running unlocked
 */
export type AcquireLockResult =
  | {readonly outcome: 'acquired'; readonly lockEtag: string; readonly renewal: LeaseController}
  | {
      readonly outcome: 'held-by-other'
      readonly holder: LockRecord | null
      readonly reason: 'active-holder' | 'expired-holder' | 'conflict'
    }
  | {readonly outcome: 's3-disabled'}
  | {readonly outcome: 'error'; readonly error: Error}

export interface AcquireLockPhaseOptions {
  readonly storeConfig: ObjectStoreConfig
  readonly repo: string
  readonly runId: string
  readonly runAttempt: number
  /** `getInvocationIdentity()`: names this job (and matrix leg), stored as `holder_job`. `null`/omitted writes none. */
  readonly jobIdentity?: string | null
  readonly logger?: Logger
}

/**
 * Acquires the per-repo Action coordination lock so two Action runs cannot execute concurrently
 * against the same repository's shared S3 session object. The gateway holds a separate lock
 * (`repo.json`) and does not exclude, or get excluded by, the Action.
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
 * - No `RunState` record — the lock alone provides Action-vs-Action mutual exclusion;
 *   GitHub already tracks workflow run state, so duplicating it in S3 is unnecessary.
 *   `LeaseController` renews only the lock record (`renewLease`), never a `RunState` --
 *   it does not reuse `packages/runtime/src/coordination/heartbeat.ts`'s
 *   `createHeartbeatController`, which reads and writes a `RunState` object this design
 *   deliberately does not create.
 */
export async function runAcquireLock(options: AcquireLockPhaseOptions): Promise<AcquireLockResult> {
  const {storeConfig, repo, runId, runAttempt} = options
  const jobIdentity = options.jobIdentity ?? null
  // An identity outside the stored charset is dropped (legacy record) rather than written and later rejected.
  const holderJob = jobIdentity != null && isValidHolderJob(jobIdentity) ? jobIdentity : undefined
  // Minted per acquisition so a late releaser can tell this lease from a successor's that shares every holder field.
  const acquisitionToken = randomUUID()
  const logger = options.logger ?? createLogger({phase: 'acquire-lock'})

  if (storeConfig.enabled === false) {
    logger.debug('coordination-disabled', {reason: 's3-not-configured'})
    return {outcome: 's3-disabled'}
  }

  const holderId = buildActionHolderId(runId, runAttempt)
  let config: CoordinationConfig
  let result: Awaited<ReturnType<typeof acquireLock>>
  try {
    config = createActionCoordinationConfig(storeConfig, logger)
    // A killed runner's expired lease must not wedge the repo: reclaim expired Action leases (surface + Action holder
    // id) without corroboration. A lease held by an earlier attempt of this run and job that stopped renewing is
    // reclaimed before expiry. Anything else on this key is skipped.
    result = await acquireLock(config, repo, holderId, 'github', runId, logger, {
      scope: ACTION_LOCK_SCOPE,
      ...(holderJob === undefined ? {} : {holderJob}),
      acquisitionToken,
      reclaimableWithoutConfirmation: holder => holder.surface === 'github' && isActionHolderId(holder.holder_id),
      reclaimableBeforeExpiry: (holder, observedAt) =>
        isStaleEarlierAttemptOfJob(holder, {runId, runAttempt, holderJob}, observedAt),
    })
  } catch (error_) {
    // A thrown adapter/acquire error must reach run.ts's fail-closed `error` path, not escape as a generic crash.
    const error = error_ instanceof Error ? error_ : new Error(String(error_))
    logger.warning('Lock acquisition threw', {error: error.message, repo, holderId})
    return {outcome: 'error', error}
  }

  if (result.success === false) {
    logger.warning('Lock acquisition failed', {error: result.error.message, repo, holderId})
    return {outcome: 'error', error: result.error}
  }

  if (result.data.acquired === true) {
    const {etag} = result.data
    logger.info('Lock acquired', {repo, holderId, etag})
    try {
      // Lets the post hook free the lock if this process dies before cleanup releases it. The holder id is written
      // last: it is the "record is set" flag the post hook keys on, so a partial write never leaves it without the
      // token (or job) the release must match.
      core.saveState(STATE_KEYS.LOCK_ACQUISITION_TOKEN, acquisitionToken)
      if (holderJob !== undefined) core.saveState(STATE_KEYS.LOCK_HOLDER_JOB, holderJob)
      core.saveState(STATE_KEYS.LOCK_HOLDER_ID, holderId)
    } catch (error_) {
      // Without the record a killed run would keep the lock until expiry, so release it and fail closed.
      const cause = error_ instanceof Error ? error_.message : String(error_)
      const error = new Error(`Acquired the Action coordination lock but could not record its holder: ${cause}`)
      logger.warning('Recording the lock holder failed; releasing the lock', {error: cause, repo, holderId})
      await releaseBestEffort(config, repo, etag, logger)
      return {outcome: 'error', error}
    }
    const renewal = createLeaseController(config, repo, holderId, holderJob, acquisitionToken, runId, etag, logger)
    return {outcome: 'acquired', lockEtag: etag, renewal}
  }

  const heldBy = {
    repo,
    holderId,
    heldBy: result.data.holder?.holder_id ?? null,
    surface: result.data.holder?.surface ?? null,
  }
  switch (result.data.outcome) {
    case 'expired-holder':
      logger.info('Expired coordination lease held by a non-Action holder; settlement unconfirmed; skipped', heldBy)
      break
    case 'conflict':
      logger.info('Coordination lease changed during takeover; skipped', heldBy)
      break
    case 'active-holder':
      logger.info('lock-held-by-other-surface', {...heldBy, reason: 'coordination lease held'})
      break
  }
  return {outcome: 'held-by-other', holder: result.data.holder, reason: result.data.outcome}
}
