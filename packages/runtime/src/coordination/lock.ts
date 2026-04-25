import type {Result} from '../shared/types.js'
import type {CoordinationConfig, LockAcquisitionResult, LockRecord, Surface} from './types.js'

import {buildObjectStoreKey} from '../object-store/key-builder.js'
import {err, ok} from '../shared/types.js'
import {requireConditionalDelete, requireConditionalPut, requireGetObject} from './adapter-guards.js'

const COORDINATION_IDENTITY = 'coordination'

function getLockKey(config: CoordinationConfig, repo: string): Result<string, Error> {
  const key = buildObjectStoreKey(config.storeConfig, COORDINATION_IDENTITY, repo, 'locks', 'repo.json')
  if (key.success === false) {
    return err(key.error)
  }

  return ok(key.data)
}

function isPreconditionFailed(error: Error): boolean {
  return /pre-?condition/.test(error.message.toLowerCase())
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

function resolveConditionalPut(
  config: CoordinationConfig,
): Result<NonNullable<CoordinationConfig['storeAdapter']['conditionalPut']>, Error> {
  try {
    return ok(requireConditionalPut(config))
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

function resolveGetObject(
  config: CoordinationConfig,
): Result<NonNullable<CoordinationConfig['storeAdapter']['getObject']>, Error> {
  try {
    return ok(requireGetObject(config))
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

  logger.debug('Releasing lock', {key: key.data, repo})
  return requireConditionalDelete(config)(key.data, {ifMatch: etag})
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

  const nextRecord: LockRecord = {...lockRecord, acquired_at: new Date().toISOString()}
  logger.debug('Renewing lock lease', {key: key.data, repo})
  return requireConditionalPut(config)(key.data, JSON.stringify(nextRecord), {ifMatch: etag})
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

  logger.debug('Force releasing lock', {key: key.data, repo})
  return requireConditionalDelete(config)(key.data, {ifMatch: etag})
}
