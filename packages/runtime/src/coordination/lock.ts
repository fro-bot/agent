import type {ObjectStoreOperationError} from '../object-store/types.js'
import type {Result} from '../shared/types.js'
import type {CoordinationConfig, LockAcquisitionResult, LockRecord, RunState, Surface} from './types.js'

import {buildObjectStoreKey} from '../object-store/key-builder.js'
import {err, ok} from '../shared/types.js'
import {resolveConditionalDelete, resolveConditionalPut, resolveGetObject} from './adapter-guards.js'
import {getRunKey, parseRunState} from './run-state.js'

/** The identity segment used for all lock keys. Exported so consumers (e.g. recovery.ts) can import it instead of maintaining a local copy. */
export const COORDINATION_IDENTITY = 'coordination'

/** Build the S3 key for a repo's coordination lock. Exported so consumers share the single source of truth for the lock key shape. */
export function getLockKey(config: CoordinationConfig, repo: string): Result<string, Error> {
  const key = buildObjectStoreKey(config.storeConfig, COORDINATION_IDENTITY, repo, 'locks', 'repo.json')
  if (key.success === false) {
    return err(key.error)
  }

  return ok(key.data)
}

function isPreconditionFailed(error: Error): boolean {
  return /pre-?condition/.test(error.message.toLowerCase())
}

function isNotFound(error: Error): boolean {
  // Check structured S3 error fields first (ObjectStoreOperationError shape).
  // These are set by the s3-adapter when it wraps AWS SDK errors and are more
  // reliable than message-substring matching.
  //
  // Precedence rules:
  //   1. httpStatusCode present → authoritative: 404 = not-found; anything else = not not-found.
  //   2. errorCode/errorName present → authoritative: 'NoSuchKey' = not-found; anything else = not not-found.
  //   3. No structured fields → fall back to message regex (plain-Error adapters).
  //
  // This prevents a transient error (e.g. 503) whose message happens to contain
  // "not found" from being misclassified as a genuine absence.
  const e = error as Partial<ObjectStoreOperationError>
  if (e.httpStatusCode !== undefined) return e.httpStatusCode === 404
  if (e.errorCode !== undefined) return e.errorCode === 'NoSuchKey'
  if (e.errorName !== undefined) return e.errorName === 'NoSuchKey'
  // Fallback: plain-message match for adapters that don't set structured fields.
  return /nosuchkey|not found|does not exist/i.test(error.message)
}

function isStale(lockRecord: LockRecord, now: Date): boolean {
  const acquiredAt = new Date(lockRecord.acquired_at).getTime()
  return acquiredAt + lockRecord.ttl_seconds * 1000 <= now.getTime()
}

function hasValidLockRecordShape(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value == null) {
    return false
  }

  const candidate = value as Partial<LockRecord>
  return (
    typeof candidate.repo === 'string' &&
    typeof candidate.holder_id === 'string' &&
    (candidate.surface === 'github' || candidate.surface === 'discord') &&
    typeof candidate.acquired_at === 'string' &&
    typeof candidate.ttl_seconds === 'number' &&
    Number.isFinite(candidate.ttl_seconds) &&
    typeof candidate.run_id === 'string'
  )
}

function parseLockRecord(data: string): Result<LockRecord, Error> {
  try {
    const parsed: unknown = JSON.parse(data)
    if (hasValidLockRecordShape(parsed) === false) {
      return err(new Error('Invalid lock record payload'))
    }

    return ok(parsed)
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

function createLockRecord(
  repo: string,
  holderId: string,
  surface: Surface,
  runId: string,
  ttlSeconds: number,
  now: string,
): LockRecord {
  return {
    repo,
    holder_id: holderId,
    surface,
    acquired_at: now,
    ttl_seconds: ttlSeconds,
    run_id: runId,
  }
}

export async function acquireLock(
  config: CoordinationConfig,
  repo: string,
  holderId: string,
  surface: Surface,
  runId: string,
  logger: {debug: (message: string, context?: Record<string, unknown>) => void},
): Promise<Result<LockAcquisitionResult, Error>> {
  const key = getLockKey(config, repo)
  if (key.success === false) {
    return err(key.error)
  }

  const now = new Date().toISOString()
  const lockRecord = createLockRecord(repo, holderId, surface, runId, config.lockTtlSeconds, now)
  const conditionalPut = resolveConditionalPut(config)
  if (conditionalPut.success === false) {
    return err(conditionalPut.error)
  }

  const getObject = resolveGetObject(config)
  if (getObject.success === false) {
    return err(getObject.error)
  }

  logger.debug('Attempting lock acquisition', {key: key.data, repo, runId, surface})
  const acquired = await conditionalPut.data(key.data, JSON.stringify(lockRecord), {ifNoneMatch: '*'})
  if (acquired.success === true) {
    if (typeof acquired.data.etag !== 'string' || acquired.data.etag.length === 0) {
      return err(new Error('Lock acquisition succeeded without a usable ETag'))
    }
    return ok({acquired: true, etag: acquired.data.etag, holder: null})
  }

  if (isPreconditionFailed(acquired.error) === false) {
    return err(acquired.error)
  }

  const existing = await getObject.data(key.data)
  if (existing.success === false) {
    return err(existing.error)
  }

  const holder = parseLockRecord(existing.data.data)
  if (holder.success === false) {
    return err(holder.error)
  }

  if (isStale(holder.data, new Date(now)) === false) {
    return ok({acquired: false, etag: null, holder: holder.data})
  }

  const takeover = await conditionalPut.data(key.data, JSON.stringify(lockRecord), {ifMatch: existing.data.etag})
  if (takeover.success === false) {
    if (isPreconditionFailed(takeover.error) === true) {
      return ok({acquired: false, etag: null, holder: null})
    }

    return err(takeover.error)
  }

  if (typeof takeover.data.etag !== 'string' || takeover.data.etag.length === 0) {
    return err(new Error('Lock acquisition succeeded without a usable ETag'))
  }
  return ok({acquired: true, etag: takeover.data.etag, holder: null})
}

export async function releaseLock(
  config: CoordinationConfig,
  repo: string,
  etag: string,
  logger: {debug: (message: string, context?: Record<string, unknown>) => void},
): Promise<Result<void, Error>> {
  const key = getLockKey(config, repo)
  if (key.success === false) {
    return err(key.error)
  }

  const conditionalDelete = resolveConditionalDelete(config)
  if (conditionalDelete.success === false) {
    return err(conditionalDelete.error)
  }

  logger.debug('Releasing lock', {key: key.data, repo})
  return conditionalDelete.data(key.data, {ifMatch: etag})
}

export async function renewLease(
  config: CoordinationConfig,
  repo: string,
  lockRecord: LockRecord,
  etag: string,
  logger: {debug: (message: string, context?: Record<string, unknown>) => void},
): Promise<Result<{etag: string}, Error>> {
  const key = getLockKey(config, repo)
  if (key.success === false) {
    return err(key.error)
  }

  const conditionalPut = resolveConditionalPut(config)
  if (conditionalPut.success === false) {
    return err(conditionalPut.error)
  }

  const nextRecord: LockRecord = {...lockRecord, acquired_at: new Date().toISOString()}
  logger.debug('Renewing lock lease', {key: key.data, repo})
  return conditionalPut.data(key.data, JSON.stringify(nextRecord), {ifMatch: etag})
}

export async function forceReleaseLock(
  config: CoordinationConfig,
  repo: string,
  etag: string,
  logger: {debug: (message: string, context?: Record<string, unknown>) => void},
): Promise<Result<void, Error>> {
  const key = getLockKey(config, repo)
  if (key.success === false) {
    return err(key.error)
  }

  const conditionalDelete = resolveConditionalDelete(config)
  if (conditionalDelete.success === false) {
    return err(conditionalDelete.error)
  }

  logger.debug('Force releasing lock', {key: key.data, repo})
  return conditionalDelete.data(key.data, {ifMatch: etag})
}

// ─── forceReleaseStaleLock ────────────────────────────────────────────────────

/**
 * Typed outcome of a `forceReleaseStaleLock` call.
 *
 * - `released`    — lock was proven dead (lease expired + run-state stale/absent) and deleted.
 * - `live-holder` — lock is held by a live run (lease fresh OR heartbeat fresh); no delete.
 * - `no-lock`     — no lock record exists for the repo; nothing to release.
 * - `conflict`    — both signals said dead but the lock object changed between read and delete
 *                   (IfMatch precondition failure); the new holder's lock was NOT deleted.
 * - `error`       — malformed/partial lock or run-state record; fail-closed, no delete.
 */
export type ForceReleaseStaleLockOutcome = 'released' | 'live-holder' | 'no-lock' | 'conflict' | 'error'

export interface ForceReleaseStaleLockResult {
  readonly outcome: ForceReleaseStaleLockOutcome
  /** The `holder_id` from the lock record, if one was read. */
  readonly holderId: string | null
  /** The `run_id` from the lock record, if one was read. */
  readonly runId: string | null
  /** Age of the lock in milliseconds at the time of the check, if a lock record was read. */
  readonly lockAgeMs: number | null
  /** Age of the last heartbeat in milliseconds at the time of the check, if run-state was read. */
  readonly heartbeatAgeMs: number | null
}

/**
 * Internal helper: reads the current lock record and its S3 etag.
 *
 * Returns:
 * - `ok({record, etag})` — lock exists and is valid.
 * - `ok(null)`           — lock object does not exist (NoSuchKey / not-found).
 * - `err(error)`         — unexpected read or parse error (fail-closed).
 */
async function readLockRecord(
  config: CoordinationConfig,
  repo: string,
): Promise<Result<{readonly record: LockRecord; readonly etag: string} | null, Error>> {
  const key = getLockKey(config, repo)
  if (key.success === false) {
    return err(key.error)
  }

  const getObject = resolveGetObject(config)
  if (getObject.success === false) {
    return err(getObject.error)
  }

  const fetched = await getObject.data(key.data)
  if (fetched.success === false) {
    if (isNotFound(fetched.error) === true) {
      return ok(null)
    }
    return err(fetched.error)
  }

  const parsed = parseLockRecord(fetched.data.data)
  if (parsed.success === false) {
    return err(parsed.error)
  }

  return ok({record: parsed.data, etag: fetched.data.etag})
}

/**
 * Internal helper: reads the run-state record for a given `run_id`.
 *
 * Uses the run-owner `identity` (e.g. the gateway identity `'discord-gateway'`) as the identity
 * segment — distinct from the lock key's `COORDINATION_IDENTITY`. Run-state records are written
 * under the gateway identity; the lock key lives under `COORDINATION_IDENTITY`. These are two
 * separate key families and must not be conflated.
 *
 * Returns:
 * - `ok(runState)` — run-state exists and is valid.
 * - `ok(null)`     — run-state object does not exist (NoSuchKey / not-found → genuinely absent → dead).
 * - `err(error)`   — transient/unknown read failure OR parse error on a present record (fail-closed).
 */
async function readRunStateByRunId(
  config: CoordinationConfig,
  repo: string,
  identity: string,
  runId: string,
): Promise<Result<RunState | null, Error>> {
  const key = getRunKey(config, identity, repo, runId)
  if (key.success === false) {
    return err(key.error)
  }

  const getObject = resolveGetObject(config)
  if (getObject.success === false) {
    return err(getObject.error)
  }

  const fetched = await getObject.data(key.data)
  if (fetched.success === false) {
    if (isNotFound(fetched.error) === true) {
      // Genuinely absent (NoSuchKey / not-found) → treat as dead, OK to proceed.
      return ok(null)
    }
    // Transient or unknown read failure (network, 503, etc.) → fail-closed.
    // Do NOT treat as absent: a live run's lock must not be deleted on a transient error.
    return err(fetched.error)
  }

  const parsed = parseRunState(fetched.data.data)
  if (parsed.success === false) {
    // Present but malformed → fail-closed
    return err(parsed.error)
  }

  return ok(parsed.data)
}

/**
 * Dead-run-verified force-release of a per-repo coordination lock.
 *
 * Releases the lock ONLY when BOTH signals confirm the owning run is dead:
 *   1. Lock lease expired (`acquired_at + ttl_seconds ≤ now`).
 *   2. Run-state heartbeat is stale (`last_heartbeat + staleThresholdMs ≤ now`) OR absent.
 *
 * An `IfMatch: etag` conditional delete guards the read→delete race: if the lock object
 * changed between read and delete (re-acquire/renewal), the delete fails and the outcome
 * is `conflict` — the new holder's lock is never deleted.
 *
 * `identity` is the run-owner identity (e.g. `'discord-gateway'`) used to build the
 * run-state key. This is distinct from the lock key's `COORDINATION_IDENTITY` — run-state
 * records are written under the gateway identity, not the coordination identity.
 *
 * Returns a `Result<ForceReleaseStaleLockResult, Error>`. The outer `Result` is `err` only
 * for unexpected infrastructure failures (key-build errors, missing adapter capabilities).
 * All semantic outcomes (`released`, `live-holder`, `no-lock`, `conflict`, `error`) are
 * returned as `ok(result)` with the appropriate `outcome` discriminant.
 */
export async function forceReleaseStaleLock(
  config: CoordinationConfig,
  repo: string,
  identity: string,
  logger: {debug: (message: string, context?: Record<string, unknown>) => void},
): Promise<Result<ForceReleaseStaleLockResult, Error>> {
  const now = new Date()

  // Step 1: Read the current lock record + etag.
  const lockRead = await readLockRecord(config, repo)
  if (lockRead.success === false) {
    logger.debug('forceReleaseStaleLock: failed to read lock record', {error: lockRead.error.message, repo})
    return ok({outcome: 'error', holderId: null, runId: null, lockAgeMs: null, heartbeatAgeMs: null})
  }

  if (lockRead.data === null) {
    logger.debug('forceReleaseStaleLock: no lock record found', {repo})
    return ok({outcome: 'no-lock', holderId: null, runId: null, lockAgeMs: null, heartbeatAgeMs: null})
  }

  const {record: lockRecord, etag: lockEtag} = lockRead.data
  const lockAgeMs = now.getTime() - new Date(lockRecord.acquired_at).getTime()

  // Step 2 — Signal 1 (lease): check if the lock lease has expired.
  if (isStale(lockRecord, now) === false) {
    logger.debug('forceReleaseStaleLock: lock lease is still active', {
      holderId: lockRecord.holder_id,
      lockAgeMs,
      repo,
      runId: lockRecord.run_id,
    })
    return ok({
      outcome: 'live-holder',
      holderId: lockRecord.holder_id,
      runId: lockRecord.run_id,
      lockAgeMs,
      heartbeatAgeMs: null,
    })
  }

  // Step 3 — Signal 2 (heartbeat): read the run-state for the lock's run_id.
  // Use the run-owner identity (gateway identity), NOT COORDINATION_IDENTITY — run-state
  // records are written under the gateway identity, not the coordination identity.
  const runStateRead = await readRunStateByRunId(config, repo, identity, lockRecord.run_id)
  if (runStateRead.success === false) {
    // Malformed run-state record → fail-closed, no delete.
    logger.debug('forceReleaseStaleLock: malformed run-state record', {
      error: runStateRead.error.message,
      repo,
      runId: lockRecord.run_id,
    })
    return ok({
      outcome: 'error',
      holderId: lockRecord.holder_id,
      runId: lockRecord.run_id,
      lockAgeMs,
      heartbeatAgeMs: null,
    })
  }

  const runState = runStateRead.data
  let heartbeatAgeMs: number | null = null

  if (runState !== null) {
    heartbeatAgeMs = now.getTime() - new Date(runState.last_heartbeat).getTime()
    const heartbeatThreshold = config.staleThresholdMs

    if (heartbeatAgeMs < heartbeatThreshold) {
      // Run is alive — heartbeat is fresh. Refuse to delete.
      logger.debug('forceReleaseStaleLock: run-state heartbeat is fresh, refusing to release', {
        heartbeatAgeMs,
        holderId: lockRecord.holder_id,
        repo,
        runId: lockRecord.run_id,
      })
      return ok({
        outcome: 'live-holder',
        holderId: lockRecord.holder_id,
        runId: lockRecord.run_id,
        lockAgeMs,
        heartbeatAgeMs,
      })
    }
  }

  // Both signals say dead: lease expired AND (run-state absent OR heartbeat stale).
  // Step 4: Perform the IfMatch conditional delete.
  const conditionalDelete = resolveConditionalDelete(config)
  if (conditionalDelete.success === false) {
    return err(conditionalDelete.error)
  }

  const lockKey = getLockKey(config, repo)
  if (lockKey.success === false) {
    return err(lockKey.error)
  }

  logger.debug('forceReleaseStaleLock: both signals dead, attempting conditional delete', {
    heartbeatAgeMs,
    holderId: lockRecord.holder_id,
    lockAgeMs,
    repo,
    runId: lockRecord.run_id,
  })

  const deleted = await conditionalDelete.data(lockKey.data, {ifMatch: lockEtag})
  if (deleted.success === false) {
    if (isPreconditionFailed(deleted.error) === true) {
      // Lock object changed between read and delete — new holder's lock is safe.
      logger.debug('forceReleaseStaleLock: IfMatch precondition failed (lock re-acquired between read and delete)', {
        repo,
        runId: lockRecord.run_id,
      })
      return ok({
        outcome: 'conflict',
        holderId: lockRecord.holder_id,
        runId: lockRecord.run_id,
        lockAgeMs,
        heartbeatAgeMs,
      })
    }
    if (isNotFound(deleted.error) === true) {
      // Lock object vanished between read and delete — nothing to release.
      logger.debug('forceReleaseStaleLock: lock object not found during delete (vanished between read and delete)', {
        repo,
        runId: lockRecord.run_id,
      })
      return ok({
        outcome: 'no-lock',
        holderId: lockRecord.holder_id,
        runId: lockRecord.run_id,
        lockAgeMs,
        heartbeatAgeMs,
      })
    }
    return err(deleted.error)
  }

  logger.debug('forceReleaseStaleLock: lock released', {
    heartbeatAgeMs,
    holderId: lockRecord.holder_id,
    lockAgeMs,
    repo,
    runId: lockRecord.run_id,
  })
  return ok({
    outcome: 'released',
    holderId: lockRecord.holder_id,
    runId: lockRecord.run_id,
    lockAgeMs,
    heartbeatAgeMs,
  })
}
