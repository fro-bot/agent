import type {ObjectStoreOperationError} from '../object-store/types.js'
import type {Result} from '../shared/types.js'
import type {ConfirmationSource, TakeoverAuditContext} from './lock-audit.js'
import type {
  ConfirmExpiredHolder,
  CoordinationConfig,
  LockAcquisitionOptions,
  LockAcquisitionResult,
  LockLogger,
  LockRecord,
  RepoQuiescence,
  Surface,
} from './types.js'

import {buildObjectStoreKey} from '../object-store/key-builder.js'
import {err, ok} from '../shared/types.js'
import {resolveConditionalDelete, resolveConditionalPut, resolveGetObject} from './adapter-guards.js'
import {collectHolderEvidence, confirmWithDeadline, decisionForBlocked, emitTakeoverAudit} from './lock-audit.js'

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
    (candidate.surface === 'github' || candidate.surface === 'discord' || candidate.surface === 'web') &&
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
  logger: LockLogger,
  options: LockAcquisitionOptions = {},
): Promise<Result<LockAcquisitionResult, Error>> {
  const key = getLockKey(config, repo)
  if (key.success === false) {
    return err(key.error)
  }

  const conditionalPut = resolveConditionalPut(config)
  if (conditionalPut.success === false) {
    return err(conditionalPut.error)
  }

  const getObject = resolveGetObject(config)
  if (getObject.success === false) {
    return err(getObject.error)
  }

  logger.debug('Attempting lock acquisition', {key: key.data, repo, runId, surface})
  const created = createLockRecord(repo, holderId, surface, runId, config.lockTtlSeconds, new Date().toISOString())
  const acquired = await conditionalPut.data(key.data, JSON.stringify(created), {ifNoneMatch: '*'})
  if (acquired.success === true) {
    if (typeof acquired.data.etag !== 'string' || acquired.data.etag.length === 0) {
      return err(new Error('Lock acquisition succeeded without a usable ETag'))
    }
    return ok({acquired: true, outcome: 'acquired', etag: acquired.data.etag, holder: null})
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

  const observedAt = new Date()
  if (isStale(holder.data, observedAt) === false) {
    return ok({acquired: false, outcome: 'active-holder', etag: null, holder: holder.data})
  }

  // Expired lease: a clock fact, not proof the holder stopped writing. Replace it only with corroboration
  // (or when the holder's surface is explicitly reclaimable); the ETag observed here is the only one ever used.
  const observedEtag = existing.data.etag
  const auditContext: TakeoverAuditContext = {
    operation: 'acquire',
    correlationId: crypto.randomUUID(),
    repo,
    holder: holder.data,
    evidence: await collectHolderEvidence(config, repo, holder.data),
    now: observedAt,
    replacement: {holderId, runId, surface},
  }
  emitTakeoverAudit(logger, 'lock-takeover-attempt', auditContext, 'pending', null, null)

  let source: ConfirmationSource
  let quiescence: RepoQuiescence | null = null
  if (options.reclaimableWithoutConfirmation?.(holder.data) === true) {
    source = 'holder-surface-reclaimable'
  } else if (options.confirmExpiredHolder === undefined) {
    source = 'no-corroborator'
    quiescence = {kind: 'unknown', source: 'unavailable', directory: null, reason: 'no-corroborator'}
  } else {
    quiescence = await confirmWithDeadline(options.confirmExpiredHolder, repo, holder.data)
    source = quiescence.source
  }

  if (quiescence !== null && quiescence.kind !== 'clear') {
    emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, decisionForBlocked(quiescence), source, quiescence)
    return ok({
      acquired: false,
      outcome: 'expired-holder',
      etag: null,
      holder: holder.data,
      confirmation: quiescence,
    })
  }

  // Stamped after confirmation so the new lease's TTL does not include the confirmation wait.
  const replacement = createLockRecord(repo, holderId, surface, runId, config.lockTtlSeconds, new Date().toISOString())
  const takeover = await conditionalPut.data(key.data, JSON.stringify(replacement), {ifMatch: observedEtag})
  if (takeover.success === false) {
    if (isPreconditionFailed(takeover.error) === true) {
      emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, 'cas-conflict', source, quiescence)
      return ok({acquired: false, outcome: 'conflict', etag: null, holder: null})
    }

    emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, 'store-error', source, quiescence)
    return err(takeover.error)
  }

  if (typeof takeover.data.etag !== 'string' || takeover.data.etag.length === 0) {
    emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, 'store-error', source, quiescence)
    return err(new Error('Lock acquisition succeeded without a usable ETag'))
  }
  emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, 'taken-over', source, quiescence)
  return ok({acquired: true, outcome: 'acquired', etag: takeover.data.etag, holder: null})
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
 * - `released`          — lease expired and the workspace was confirmed clear; lock deleted.
 * - `live-holder`       — lease not expired; no delete.
 * - `no-lock`           — no lock record exists for the repo; nothing to release.
 * - `conflict`          — the lock object changed between read and delete (IfMatch precondition
 *                         failure); the new holder's lock was NOT deleted.
 * - `workspace-busy`    — OpenCode reports activity in the repo directory; no delete.
 * - `workspace-unknown` — activity could not be determined (or no corroborator was supplied); no delete.
 * - `error`             — malformed/unreadable lock record; fail-closed, no delete.
 */
export type ForceReleaseStaleLockOutcome =
  'released' | 'live-holder' | 'no-lock' | 'conflict' | 'workspace-busy' | 'workspace-unknown' | 'error'

export interface ForceReleaseStaleLockResult {
  readonly outcome: ForceReleaseStaleLockOutcome
  /** The `holder_id` from the lock record, if one was read. */
  readonly holderId: string | null
  /** The `run_id` from the lock record, if one was read. */
  readonly runId: string | null
  /** Age of the lock in milliseconds at the time of the check, if a lock record was read. */
  readonly lockAgeMs: number | null
  /** Age of the old holder's last RunState heartbeat. Diagnostic only; null when RunState was unavailable. */
  readonly heartbeatAgeMs: number | null
}

export interface ForceReleaseStaleLockOptions {
  readonly confirmExpiredHolder?: ConfirmExpiredHolder
}

/** Reads the current lock record and its ETag. `ok(null)` means the lock does not exist. */
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
 * Corroborated operator release of an expired per-repo coordination lock.
 *
 * Deletes the lock only when the lease has expired AND `confirmExpiredHolder` reports the repo
 * workspace `clear`. The old holder's RunState is read for the audit trail only. The delete is
 * `If-Match` on the ETag observed BEFORE confirmation, so a renewal or replacement during the
 * confirmation wait yields `conflict` and the newer record survives.
 *
 * The outer `Result` is `err` only for unexpected infrastructure failures; every semantic
 * outcome is `ok(result)` with an `outcome` discriminant.
 */
export async function forceReleaseStaleLock(
  config: CoordinationConfig,
  repo: string,
  logger: LockLogger,
  options: ForceReleaseStaleLockOptions = {},
): Promise<Result<ForceReleaseStaleLockResult, Error>> {
  const now = new Date()

  const lockRead = await readLockRecord(config, repo)
  if (lockRead.success === false) {
    logger.debug('forceReleaseStaleLock: failed to read lock record', {error: lockRead.error.message, repo})
    return ok({
      outcome: 'error',
      holderId: null,
      runId: null,
      lockAgeMs: null,
      heartbeatAgeMs: null,
    })
  }

  if (lockRead.data === null) {
    logger.debug('forceReleaseStaleLock: no lock record found', {repo})
    return ok({
      outcome: 'no-lock',
      holderId: null,
      runId: null,
      lockAgeMs: null,
      heartbeatAgeMs: null,
    })
  }

  const {record: lockRecord, etag: lockEtag} = lockRead.data
  const lockAgeMs = now.getTime() - new Date(lockRecord.acquired_at).getTime()
  const base = {holderId: lockRecord.holder_id, runId: lockRecord.run_id, lockAgeMs}

  if (isStale(lockRecord, now) === false) {
    logger.debug('forceReleaseStaleLock: lock lease is still active', {...base, repo})
    return ok({outcome: 'live-holder', ...base, heartbeatAgeMs: null})
  }

  const evidence = await collectHolderEvidence(config, repo, lockRecord)
  const heartbeatAgeMs = evidence.kind === 'known' ? now.getTime() - new Date(evidence.lastHeartbeat).getTime() : null
  const auditContext: TakeoverAuditContext = {
    operation: 'operator-release',
    correlationId: crypto.randomUUID(),
    repo,
    holder: lockRecord,
    evidence,
    now,
    replacement: null,
  }
  emitTakeoverAudit(logger, 'lock-takeover-attempt', auditContext, 'pending', null, null)

  let source: ConfirmationSource = 'no-corroborator'
  let quiescence: RepoQuiescence = {kind: 'unknown', source: 'unavailable', directory: null, reason: 'no-corroborator'}
  if (options.confirmExpiredHolder !== undefined) {
    quiescence = await confirmWithDeadline(options.confirmExpiredHolder, repo, lockRecord)
    source = quiescence.source
  }

  if (quiescence.kind !== 'clear') {
    emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, decisionForBlocked(quiescence), source, quiescence)
    return ok({
      outcome: quiescence.kind === 'busy' ? 'workspace-busy' : 'workspace-unknown',
      ...base,
      heartbeatAgeMs,
    })
  }

  const conditionalDelete = resolveConditionalDelete(config)
  if (conditionalDelete.success === false) {
    emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, 'store-error', source, quiescence)
    return err(conditionalDelete.error)
  }

  const lockKey = getLockKey(config, repo)
  if (lockKey.success === false) {
    emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, 'store-error', source, quiescence)
    return err(lockKey.error)
  }

  const deleted = await conditionalDelete.data(lockKey.data, {ifMatch: lockEtag})
  if (deleted.success === false) {
    if (isPreconditionFailed(deleted.error) === true) {
      emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, 'cas-conflict', source, quiescence)
      return ok({outcome: 'conflict', ...base, heartbeatAgeMs})
    }
    if (isNotFound(deleted.error) === true) {
      emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, 'lock-vanished', source, quiescence)
      logger.debug('forceReleaseStaleLock: lock object vanished between read and delete', {
        repo,
        runId: lockRecord.run_id,
      })
      return ok({outcome: 'no-lock', ...base, heartbeatAgeMs})
    }
    emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, 'store-error', source, quiescence)
    return err(deleted.error)
  }

  emitTakeoverAudit(logger, 'lock-takeover-outcome', auditContext, 'taken-over', source, quiescence)
  return ok({outcome: 'released', ...base, heartbeatAgeMs})
}
