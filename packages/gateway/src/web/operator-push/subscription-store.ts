/**
 * Durable subscription-record lifecycle store for the Gateway operator push
 * surface.
 *
 * Each browser push subscription is persisted as one object keyed by an
 * opaque hash of its endpoint URL — never the endpoint itself:
 *
 *   operator-push/subscriptions/by-endpoint/{sha256(endpoint)}.json
 *
 * `endpoint`, `p256dh`, and `auth` are write-only secret fields: they are
 * persisted in the record body but are NEVER returned by any non-mutating
 * surface (list, export, audit, metrics). The single structural boundary
 * enforcing this is {@link toSubscriptionMetadata} — it is the only
 * sanctioned way to turn a full record into operator-facing data. The full
 * record (secrets included) is exposed exclusively via
 * {@link OperatorPushSubscriptionStore.getActiveRecordsForOperator}, which
 * exists solely for the relay/dispatch path.
 *
 * Privacy-delete model: separate tombstone key space.
 *
 * A privacy delete does NOT rewrite the subscription object in place — that
 * would leave the secrets on disk and can be undone by any process that
 * restores an older version of that same key. Instead, `deleteForOperator`
 * writes a secret-free marker at a DIFFERENT key:
 *
 *   operator-push/tombstones/{sha256(endpoint)}.json
 *   → {endpointHash, operatorId, deletedAt}
 *
 * and then physically removes the subscription object. Every active-read
 * path (`listAllRecords`, `getActiveRecordsForOperator`,
 * `listMetadataForOperator`, `verifyStillOwned`) consults the tombstone
 * prefix and excludes any endpointHash with a live tombstone — regardless
 * of what the subscription object at that endpointHash currently contains.
 * This means restoring the subscription object alone (e.g. a targeted
 * key-level backup restore of just that object) cannot resurrect a deleted
 * record: the tombstone lives at a separate key and keeps excluding it.
 *
 * Boundary this does NOT protect against: a full-bucket restore that
 * rewinds the ENTIRE object store — tombstones included — to a snapshot
 * taken before the delete. That is a disaster-recovery rewind of all
 * state, not a targeted resurrection of one record, and is out of scope
 * for an application-level tombstone. No object-store-backed design can
 * defend against its own storage being time-traveled wholesale; that is
 * a backup-retention/operational concern, not a store-API concern.
 *
 * A privacy delete is not a permanent ban: `subscribe` clears the
 * tombstone for its endpointHash after a successful record write, so an
 * authenticated operator can legitimately re-subscribe the same endpoint
 * later. Only an authenticated `subscribe` call clears a tombstone — a
 * passive object restore never calls `subscribe`, so the resurrection
 * protection holds for anything short of a full-bucket rewind.
 *
 * Ownership transfer is a single atomic CAS write: when a different
 * operator subscribes with an endpoint that is already bound to someone
 * else, the same `conditionalPut` call (guarded by `ifMatch` on the
 * current etag) reassigns `operatorId`, sets `active: true`, and bumps
 * `ownershipGeneration` — there is no window where two operators can both
 * see themselves as the current owner of one endpoint.
 *
 * Dispatch-vs-transfer linearizability: `getActiveRecordsForOperator`
 * returns a point-in-time snapshot. Because a transfer can land between
 * that read and the moment a notification is actually sent, the dispatch
 * path MUST call {@link OperatorPushSubscriptionStore.verifyStillOwned}
 * immediately before sending, passing back the `ownershipGeneration` it
 * read. If the generation has moved on (or the record is no longer active,
 * no longer owned by the same operator, or has since been tombstoned), the
 * dispatch is skipped — a stale pre-transfer (or pre-delete) read can
 * never deliver operator A's notification to operator B, nor to a deleted
 * subscription.
 */

import type {ObjectStoreAdapter, ObjectStoreOperationError, Result} from '@fro-bot/runtime'

import {createHash, randomUUID} from 'node:crypto'
import {err, ok} from '@fro-bot/runtime'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Coarse, closed set of reasons a subscription record became inactive. No free-form text. */
export type SubscriptionInactiveReason = 'unsubscribed' | 'transferred' | 'dead' | 'key_revoked' | 'session-revoked'

/**
 * Full subscription record, including the write-only secret fields.
 *
 * Never return this shape from a listing/export surface — use
 * {@link toSubscriptionMetadata} to derive the safe projection.
 */
export interface SubscriptionRecord {
  /** sha256 hex digest of the push endpoint URL — the record's key discriminant. */
  readonly endpointHash: string
  /** Secret: the push endpoint URL. Write-only outside the dispatch path. */
  readonly endpoint: string
  /** Secret: the P-256 DH public key from the browser subscription. Write-only outside the dispatch path. */
  readonly p256dh: string
  /** Secret: the auth secret from the browser subscription. Write-only outside the dispatch path. */
  readonly auth: string
  /** Current owning operator. */
  readonly operatorId: string
  /** Whether this record is in the active dispatch set. */
  readonly active: boolean
  /** VAPID key version this subscription was created/refreshed under. */
  readonly keyVersion: string
  /** Monotonic counter bumped on every ownership transfer. Starts at 1. */
  readonly ownershipGeneration: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly deactivatedAt?: number
  readonly inactiveReason?: SubscriptionInactiveReason
}

/**
 * Secret-free tombstone marker for a privacy-deleted endpoint. Lives at a
 * separate key from the subscription object it corresponds to — see the
 * module docstring for why that separation matters.
 */
export interface TombstoneRecord {
  readonly endpointHash: string
  readonly operatorId: string
  readonly deletedAt: number
}

/**
 * Safe metadata projection — the ONLY shape returned by list/export/audit
 * surfaces. Structurally excludes `endpoint`, `p256dh`, and `auth`.
 */
export interface SubscriptionMetadata {
  readonly endpointHash: string
  readonly operatorId: string
  readonly active: boolean
  readonly keyVersion: string
  readonly ownershipGeneration: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly deactivatedAt?: number
  readonly inactiveReason?: SubscriptionInactiveReason
}

/**
 * The single sanctioned way to derive operator-facing metadata from a full
 * record. Never spreads the full record — lists the safe fields explicitly
 * so a future secret field added to `SubscriptionRecord` does not leak here
 * by accident.
 */
export function toSubscriptionMetadata(record: SubscriptionRecord): SubscriptionMetadata {
  const base: SubscriptionMetadata = {
    endpointHash: record.endpointHash,
    operatorId: record.operatorId,
    active: record.active,
    keyVersion: record.keyVersion,
    ownershipGeneration: record.ownershipGeneration,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  if (record.deactivatedAt !== undefined) {
    return {
      ...base,
      deactivatedAt: record.deactivatedAt,
      ...(record.inactiveReason === undefined ? {} : {inactiveReason: record.inactiveReason}),
    }
  }
  if (record.inactiveReason !== undefined) {
    return {...base, inactiveReason: record.inactiveReason}
  }
  return base
}

export interface SubscribeInput {
  readonly operatorId: string
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
  readonly keyVersion: string
}

export interface StoreLogger {
  readonly debug: (context: Record<string, unknown>, message: string) => void
  readonly warn: (context: Record<string, unknown>, message: string) => void
}

export interface OperatorPushSubscriptionStoreDeps {
  readonly adapter: ObjectStoreAdapter
  readonly keyPrefix?: string
  readonly logger: StoreLogger
  readonly clock?: () => number
  /** Retention window for pruning inactive subscription records. Default 30 days. */
  readonly inactiveRetentionMs?: number
  /**
   * Retention window for pruning tombstones. Default 90 days.
   *
   * MUST exceed the longest object-store backup retention window in use —
   * pruning a tombstone before every backup that predates the delete has
   * expired would reopen the restore-resurrection gap the tombstone exists
   * to close. When in doubt, keep this larger than the backup window, not
   * smaller.
   */
  readonly tombstoneRetentionMs?: number
}

export interface StoreError extends Error {
  readonly code: 'OPERATOR_PUSH_STORE_ERROR'
}

export function createStoreError(message: string): StoreError {
  return Object.assign(new Error(message), {code: 'OPERATOR_PUSH_STORE_ERROR' as const})
}

export interface SelfTestCasFailure extends Error {
  readonly code: 'OPERATOR_PUSH_SELF_TEST_CAS_FAILURE'
}

export function createSelfTestCasFailure(message: string): SelfTestCasFailure {
  return Object.assign(new Error(message), {code: 'OPERATOR_PUSH_SELF_TEST_CAS_FAILURE' as const})
}

/** Combined prune outcome: subscription records removed vs. tombstones removed. */
export interface PruneResult {
  readonly records: number
  readonly tombstones: number
}

export interface OperatorPushSubscriptionStore {
  subscribe: (input: SubscribeInput) => Promise<Result<SubscriptionMetadata, StoreError>>
  unsubscribe: (args: {readonly operatorId: string; readonly endpoint: string}) => Promise<Result<void, StoreError>>
  /**
   * Marks every active record owned by `operatorId` inactive (session-revoke).
   * `skipped` counts records whose CAS retry loop was exhausted by concurrent
   * writers — those records were NOT updated and remain in their prior state.
   */
  deactivateForOperator: (args: {
    readonly operatorId: string
  }) => Promise<Result<{readonly updated: number; readonly skipped: number}, StoreError>>
  /**
   * Privacy delete: tombstones then physically removes every record owned by
   * `operatorId`. `skipped` counts records whose physical removal could not
   * be completed (e.g. a concurrent transfer) — for those, the tombstone
   * still excludes them from reads, but their secrets may remain on disk
   * until a later `pruneInactive` or transfer removes the stale object.
   */
  deleteForOperator: (args: {
    readonly operatorId: string
  }) => Promise<Result<{readonly deleted: number; readonly skipped: number}, StoreError>>
  listMetadataForOperator: (args: {
    readonly operatorId: string
  }) => Promise<Result<readonly SubscriptionMetadata[], StoreError>>
  /** Full records WITH secrets. Dispatch-path ONLY — never surface this to listing/export/audit. */
  getActiveRecordsForOperator: (args: {
    readonly operatorId: string
  }) => Promise<Result<readonly SubscriptionRecord[], StoreError>>
  markDead: (args: {readonly operatorId: string; readonly endpoint: string}) => Promise<Result<void, StoreError>>
  /** Prunes inactive subscription records and expired tombstones past their respective retention windows. */
  pruneInactive: (args?: {
    readonly recordsOlderThanMs?: number
    readonly tombstonesOlderThanMs?: number
  }) => Promise<Result<PruneResult, StoreError>>
  /**
   * Re-validates ownership immediately before a dispatch send. Returns true
   * only if the record is still active, still owned by `operatorId`, still
   * at `ownershipGeneration`, and has no tombstone. Dispatch MUST call this
   * right before sending so a stale pre-transfer or pre-delete read cannot
   * deliver to the wrong owner or to a deleted subscription.
   */
  verifyStillOwned: (args: {
    readonly endpointHash: string
    readonly operatorId: string
    readonly ownershipGeneration: number
  }) => Promise<Result<boolean, StoreError>>
  /**
   * Startup self-test: proves the configured adapter has real
   * compare-and-swap semantics by racing two contended writes against a
   * throwaway key. Returns a failure Result when the adapter lacks CAS
   * capability or the write does not conflict (last-write-wins) — callers
   * must fail the push surface closed in that case.
   */
  selfTestCas: () => Promise<Result<void, StoreError | SelfTestCasFailure>>
}

const DEFAULT_KEY_PREFIX = 'operator-push/subscriptions/by-endpoint'
const DEFAULT_TOMBSTONE_PREFIX = 'operator-push/tombstones'
// A sibling of the subscription and tombstone prefixes — never swept by
// listAllKeys(`${keyPrefix}/`) or the tombstone listing, so leftover
// self-test keys are never scanned, getObject'd, or warned about.
const SELF_TEST_PREFIX = 'operator-push/_self-test'
const DEFAULT_INACTIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hashEndpoint(endpoint: string): string {
  return createHash('sha256').update(endpoint, 'utf8').digest('hex')
}

// Structured-error-first classification, mirroring the pattern in
// packages/runtime/src/coordination/lock.ts: check the S3-adapter's
// structured ObjectStoreOperationError fields (httpStatusCode / errorCode /
// errorName) before falling back to message-substring matching, which is
// only reliable for plain-Error adapters (e.g. the test fakes).
function isPreconditionFailed(error: Error): boolean {
  const e = error as Partial<ObjectStoreOperationError>
  if (e.httpStatusCode !== undefined) return e.httpStatusCode === 412
  const code = e.errorCode ?? e.errorName
  if (code !== undefined) return code === 'PreconditionFailed'
  return /pre-?condition/i.test(error.message)
}

function isNotFound(error: Error): boolean {
  const e = error as Partial<ObjectStoreOperationError>
  if (e.httpStatusCode !== undefined) return e.httpStatusCode === 404
  const code = e.errorCode ?? e.errorName
  if (code !== undefined) return code === 'NoSuchKey' || code === 'NotFound'
  return /not.?found|no.?such.?key|does.?not.?exist|404/i.test(error.message)
}

function hasValidSubscriptionRecordShape(value: unknown): value is SubscriptionRecord {
  if (typeof value !== 'object' || value == null) {
    return false
  }
  const c = value as Partial<SubscriptionRecord>
  return (
    typeof c.endpointHash === 'string' &&
    typeof c.endpoint === 'string' &&
    typeof c.p256dh === 'string' &&
    typeof c.auth === 'string' &&
    typeof c.operatorId === 'string' &&
    typeof c.active === 'boolean' &&
    typeof c.keyVersion === 'string' &&
    typeof c.ownershipGeneration === 'number' &&
    typeof c.createdAt === 'number' &&
    typeof c.updatedAt === 'number'
  )
}

function parseSubscriptionRecord(data: string): Result<SubscriptionRecord, StoreError> {
  try {
    const parsed: unknown = JSON.parse(data)
    if (hasValidSubscriptionRecordShape(parsed) === false) {
      return err(createStoreError('Invalid subscription record payload'))
    }
    return ok(parsed)
  } catch (error) {
    return err(createStoreError(error instanceof Error ? error.message : String(error)))
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOperatorPushSubscriptionStore(
  deps: OperatorPushSubscriptionStoreDeps,
): OperatorPushSubscriptionStore {
  const {adapter, logger} = deps
  const keyPrefix = deps.keyPrefix ?? DEFAULT_KEY_PREFIX
  const tombstonePrefix = DEFAULT_TOMBSTONE_PREFIX
  const clock = deps.clock ?? Date.now
  const inactiveRetentionMs = deps.inactiveRetentionMs ?? DEFAULT_INACTIVE_RETENTION_MS
  const tombstoneRetentionMs = deps.tombstoneRetentionMs ?? DEFAULT_TOMBSTONE_RETENTION_MS

  function buildKey(endpointHash: string): string {
    return `${keyPrefix}/${endpointHash}.json`
  }

  function buildTombstoneKey(endpointHash: string): string {
    return `${tombstonePrefix}/${endpointHash}.json`
  }

  /** Derives the endpointHash from a tombstone key name — avoids a getObject per tombstone. */
  function endpointHashFromTombstoneKey(key: string): string | null {
    const prefix = `${tombstonePrefix}/`
    if (key.startsWith(prefix) === false || key.endsWith('.json') === false) {
      return null
    }
    return key.slice(prefix.length, key.length - '.json'.length)
  }

  function requireCasCapable(): Result<
    {
      readonly conditionalPut: NonNullable<ObjectStoreAdapter['conditionalPut']>
      readonly conditionalDelete: NonNullable<ObjectStoreAdapter['conditionalDelete']>
      readonly getObject: NonNullable<ObjectStoreAdapter['getObject']>
    },
    StoreError
  > {
    if (adapter.conditionalPut == null) {
      return err(createStoreError('Object store adapter does not support conditionalPut'))
    }
    if (adapter.conditionalDelete == null) {
      return err(createStoreError('Object store adapter does not support conditionalDelete'))
    }
    if (adapter.getObject == null) {
      return err(createStoreError('Object store adapter does not support getObject'))
    }
    return ok({
      conditionalPut: adapter.conditionalPut,
      conditionalDelete: adapter.conditionalDelete,
      getObject: adapter.getObject,
    })
  }

  async function readRecord(
    endpointHash: string,
  ): Promise<Result<{readonly record: SubscriptionRecord; readonly etag: string} | null, StoreError>> {
    const cas = requireCasCapable()
    if (cas.success === false) {
      return err(cas.error)
    }

    const fetched = await cas.data.getObject(buildKey(endpointHash))
    if (fetched.success === false) {
      if (isNotFound(fetched.error)) {
        return ok(null)
      }
      return err(createStoreError(fetched.error.message))
    }

    const parsed = parseSubscriptionRecord(fetched.data.data)
    if (parsed.success === false) {
      return err(parsed.error)
    }

    return ok({record: parsed.data, etag: fetched.data.etag})
  }

  /** List all endpoint-hash keys currently under the subscription-object prefix. */
  async function listAllKeys(): Promise<Result<readonly string[], StoreError>> {
    const listed = await adapter.list(`${keyPrefix}/`)
    if (listed.success === false) {
      return err(createStoreError(listed.error.message))
    }
    return ok(listed.data)
  }

  /** Set of endpointHashes with a live tombstone. Derived from key names — no getObject per tombstone. */
  async function listTombstonedHashes(): Promise<Result<ReadonlySet<string>, StoreError>> {
    const listed = await adapter.list(`${tombstonePrefix}/`)
    if (listed.success === false) {
      return err(createStoreError(listed.error.message))
    }
    const hashes = new Set<string>()
    for (const key of listed.data) {
      const hash = endpointHashFromTombstoneKey(key)
      if (hash !== null) {
        hashes.add(hash)
      }
    }
    return ok(hashes)
  }

  async function hasTombstone(endpointHash: string): Promise<Result<boolean, StoreError>> {
    const cas = requireCasCapable()
    if (cas.success === false) {
      return err(cas.error)
    }
    const fetched = await cas.data.getObject(buildTombstoneKey(endpointHash))
    if (fetched.success === false) {
      if (isNotFound(fetched.error)) {
        return ok(false)
      }
      return err(createStoreError(fetched.error.message))
    }
    return ok(true)
  }

  async function listAllRecords(): Promise<Result<readonly SubscriptionRecord[], StoreError>> {
    const cas = requireCasCapable()
    if (cas.success === false) {
      return err(cas.error)
    }

    const [keys, tombstones] = await Promise.all([listAllKeys(), listTombstonedHashes()])
    if (keys.success === false) {
      return err(keys.error)
    }
    if (tombstones.success === false) {
      return err(tombstones.error)
    }

    const records: SubscriptionRecord[] = []
    for (const key of keys.data) {
      const fetched = await cas.data.getObject(key)
      if (fetched.success === false) {
        if (isNotFound(fetched.error)) {
          continue
        }
        return err(createStoreError(fetched.error.message))
      }
      const parsed = parseSubscriptionRecord(fetched.data.data)
      if (parsed.success === false) {
        // Corrupted record — skip; one bad record must not kill the whole scan.
        logger.warn({key}, 'operator push subscription store: skipping corrupted record')
        continue
      }
      // A live tombstone always excludes its endpointHash, regardless of what
      // the subscription object currently contains (see module docstring).
      if (tombstones.data.has(parsed.data.endpointHash)) {
        continue
      }
      records.push(parsed.data)
    }
    return ok(records)
  }

  // -------------------------------------------------------------------------
  // subscribe
  // -------------------------------------------------------------------------

  async function subscribe(input: SubscribeInput): Promise<Result<SubscriptionMetadata, StoreError>> {
    const cas = requireCasCapable()
    if (cas.success === false) {
      return err(cas.error)
    }

    const endpointHash = hashEndpoint(input.endpoint)
    const key = buildKey(endpointHash)
    const now = clock()

    // Retry loop bounds the CAS race on concurrent writers targeting the same endpoint.
    const maxAttempts = 5
    let written: SubscriptionRecord | null = null
    for (let attempt = 0; attempt < maxAttempts && written === null; attempt++) {
      const existing = await readRecord(endpointHash)
      if (existing.success === false) {
        return err(existing.error)
      }

      if (existing.data === null) {
        // Create-if-absent: first subscription for this endpoint (or the
        // object was physically removed by a prior privacy delete).
        const record: SubscriptionRecord = {
          endpointHash,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          operatorId: input.operatorId,
          active: true,
          keyVersion: input.keyVersion,
          ownershipGeneration: 1,
          createdAt: now,
          updatedAt: now,
        }
        const write = await cas.data.conditionalPut(key, JSON.stringify(record), {ifNoneMatch: '*'})
        if (write.success === false) {
          if (isPreconditionFailed(write.error)) {
            continue // Someone else created it concurrently — retry and reconcile below.
          }
          return err(createStoreError(write.error.message))
        }
        written = record
        break
      }

      const {record: current, etag} = existing.data
      const sameOwner = current.operatorId === input.operatorId

      const nextRecord: SubscriptionRecord = sameOwner
        ? {
            // Same operator re-subscribing the same endpoint: refresh keys, no ownership change.
            ...current,
            p256dh: input.p256dh,
            auth: input.auth,
            keyVersion: input.keyVersion,
            active: true,
            updatedAt: now,
            deactivatedAt: undefined,
            inactiveReason: undefined,
          }
        : {
            // Different operator: atomic ownership transfer in the same CAS write —
            // reassign owner, reactivate, bump generation, in one call.
            ...current,
            operatorId: input.operatorId,
            p256dh: input.p256dh,
            auth: input.auth,
            keyVersion: input.keyVersion,
            active: true,
            ownershipGeneration: current.ownershipGeneration + 1,
            updatedAt: now,
            deactivatedAt: undefined,
            inactiveReason: undefined,
          }

      // JSON.stringify drops `undefined` fields, so explicit resets above serialize cleanly.
      const write = await cas.data.conditionalPut(key, JSON.stringify(nextRecord), {ifMatch: etag})
      if (write.success === false) {
        if (isPreconditionFailed(write.error)) {
          continue // Lost the race — reread and retry.
        }
        return err(createStoreError(write.error.message))
      }
      written = nextRecord
    }

    if (written === null) {
      return err(createStoreError('subscribe: exceeded max CAS retry attempts'))
    }

    // Clear any tombstone for this endpointHash AFTER the record write succeeds.
    // Only a real authenticated subscribe reaches this line — a passive object
    // restore never calls subscribe, so this cannot reopen the resurrection
    // gap the tombstone exists to close. Best-effort: a crash here leaves the
    // record written but the tombstone still in place, which fails toward
    // NOT dispatching (safe) rather than toward resurrecting a deleted record.
    const tombstoneRead = await cas.data.getObject(buildTombstoneKey(endpointHash))
    if (tombstoneRead.success === true) {
      const cleared = await cas.data.conditionalDelete(buildTombstoneKey(endpointHash), {
        ifMatch: tombstoneRead.data.etag,
      })
      if (
        cleared.success === false &&
        isPreconditionFailed(cleared.error) === false &&
        isNotFound(cleared.error) === false
      ) {
        logger.warn(
          {endpointHash, error: cleared.error.message},
          'operator push subscription store: failed to clear tombstone after subscribe',
        )
      }
    }

    return ok(toSubscriptionMetadata(written))
  }

  // -------------------------------------------------------------------------
  // unsubscribe
  // -------------------------------------------------------------------------

  async function unsubscribe(args: {
    readonly operatorId: string
    readonly endpoint: string
  }): Promise<Result<void, StoreError>> {
    const cas = requireCasCapable()
    if (cas.success === false) {
      return err(cas.error)
    }

    const endpointHash = hashEndpoint(args.endpoint)
    const maxAttempts = 5
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const existing = await readRecord(endpointHash)
      if (existing.success === false) {
        return err(existing.error)
      }
      if (existing.data === null) {
        // Idempotent: unsubscribing an unknown endpoint is a no-op success.
        return ok(undefined)
      }

      const {record: current, etag} = existing.data
      if (current.operatorId !== args.operatorId) {
        // Fail closed — a different operator cannot unsubscribe someone else's record.
        return err(createStoreError('unsubscribe: endpoint is not owned by this operator'))
      }

      const now = clock()
      const nextRecord: SubscriptionRecord = {
        ...current,
        active: false,
        updatedAt: now,
        deactivatedAt: now,
        inactiveReason: 'unsubscribed',
      }
      const write = await cas.data.conditionalPut(buildKey(endpointHash), JSON.stringify(nextRecord), {
        ifMatch: etag,
      })
      if (write.success === false) {
        if (isPreconditionFailed(write.error)) {
          continue
        }
        return err(createStoreError(write.error.message))
      }
      return ok(undefined)
    }
    return err(createStoreError('unsubscribe: exceeded max CAS retry attempts'))
  }

  // -------------------------------------------------------------------------
  // deactivateForOperator (session-revoke — unchanged, no tombstones)
  // -------------------------------------------------------------------------

  async function deactivateForOperator(args: {
    readonly operatorId: string
  }): Promise<Result<{readonly updated: number; readonly skipped: number}, StoreError>> {
    const cas = requireCasCapable()
    if (cas.success === false) {
      return err(cas.error)
    }

    const keys = await listAllKeys()
    if (keys.success === false) {
      return err(keys.error)
    }

    let updated = 0
    let skipped = 0
    for (const key of keys.data) {
      const maxAttempts = 5
      let settled = false
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const fetched = await cas.data.getObject(key)
        if (fetched.success === false) {
          if (isNotFound(fetched.error)) {
            settled = true
            break
          }
          return err(createStoreError(fetched.error.message))
        }
        const parsed = parseSubscriptionRecord(fetched.data.data)
        if (parsed.success === false) {
          settled = true
          break // corrupted — skip
        }

        const record = parsed.data
        if (record.operatorId !== args.operatorId || record.active === false) {
          settled = true
          break
        }

        const now = clock()
        const nextRecord: SubscriptionRecord = {
          ...record,
          active: false,
          updatedAt: now,
          deactivatedAt: now,
          inactiveReason: 'session-revoked',
        }
        const write = await cas.data.conditionalPut(key, JSON.stringify(nextRecord), {ifMatch: fetched.data.etag})
        if (write.success === false) {
          if (isPreconditionFailed(write.error)) continue // retry
          return err(createStoreError(write.error.message))
        }
        updated += 1
        settled = true
        break
      }
      if (settled === false) {
        skipped += 1
        logger.warn(
          {key, operatorId: args.operatorId},
          'operator push subscription store: deactivateForOperator CAS retry exhausted for key — record not updated',
        )
      }
    }
    return ok({updated, skipped})
  }

  // -------------------------------------------------------------------------
  // deleteForOperator (privacy delete — tombstone-first, then physical removal)
  // -------------------------------------------------------------------------

  /**
   * Privacy delete for one operator's records.
   *
   * Ordering (tombstone-first, then physical removal, with a compensating
   * tombstone rollback on a lost race) is deliberate:
   *
   *   1. Read the record + its etag (already owner-checked here).
   *   2. Write the tombstone (ifNoneMatch:'*', idempotent on conflict).
   *      A crash between steps 1-2 and step 3 leaves the record physically
   *      present but the tombstone already excludes it from every active-read
   *      path — the failure mode fails SAFE toward privacy, never toward
   *      "looks deleted but isn't".
   *   3. Physically delete the subscription object with `ifMatch` bound to
   *      the etag read in step 1. If this delete loses the CAS race
   *      (PreconditionFailed) — meaning the record was mutated since the
   *      read, most plausibly transferred to a different operator by a
   *      concurrent `subscribe` — the delete is NOT retried and the record
   *      is NOT counted as deleted. The secrets remain on disk (a
   *      `pruneInactive` pass or a future transfer will eventually clear
   *      the stale object), and this is logged as a warning so partial
   *      physical removal is observable.
   *   4. Because the tombstone from step 2 would otherwise permanently
   *      exclude an endpoint that might now legitimately belong to someone
   *      else, a lost race additionally triggers a best-effort rollback:
   *      re-read the current record, and if it is no longer owned by
   *      `args.operatorId`, delete the tombstone so the new owner's
   *      subscription is not shadowed. If the tombstone rollback itself
   *      fails, that failure is logged and swallowed — the tombstone stays,
   *      which fails toward excluding a record rather than exposing one
   *      that might still be this operator's.
   */
  async function deleteForOperator(args: {
    readonly operatorId: string
  }): Promise<Result<{readonly deleted: number; readonly skipped: number}, StoreError>> {
    const cas = requireCasCapable()
    if (cas.success === false) {
      return err(cas.error)
    }

    const keys = await listAllKeys()
    if (keys.success === false) {
      return err(keys.error)
    }

    let deleted = 0
    let skipped = 0
    for (const key of keys.data) {
      const fetched = await cas.data.getObject(key)
      if (fetched.success === false) {
        if (isNotFound(fetched.error)) continue
        return err(createStoreError(fetched.error.message))
      }
      const parsed = parseSubscriptionRecord(fetched.data.data)
      if (parsed.success === false) continue // corrupted — skip

      const record = parsed.data
      if (record.operatorId !== args.operatorId) continue

      const now = clock()
      const tombstoneKey = buildTombstoneKey(record.endpointHash)
      const tombstone: TombstoneRecord = {
        endpointHash: record.endpointHash,
        operatorId: args.operatorId,
        deletedAt: now,
      }

      // Step 2 — tombstone FIRST (see function docstring for the full ordering rationale).
      const tombstoneWrite = await cas.data.conditionalPut(tombstoneKey, JSON.stringify(tombstone), {
        ifNoneMatch: '*',
      })
      if (tombstoneWrite.success === false && isPreconditionFailed(tombstoneWrite.error) === false) {
        return err(createStoreError(tombstoneWrite.error.message))
      }
      // A precondition failure here means a tombstone already exists for this
      // endpointHash — treat as idempotent success and continue to the
      // physical delete below.

      // Step 3 — physically remove the subscription object, bound to the
      // etag read above, so a concurrent mutation (e.g. an ownership
      // transfer) loses the delete rather than silently clobbering it.
      const objectDelete = await cas.data.conditionalDelete(key, {ifMatch: fetched.data.etag})
      if (objectDelete.success === true || isNotFound(objectDelete.error)) {
        // Physical removal succeeded, or the object was already gone —
        // either way the secrets are off disk. Count as deleted.
        deleted += 1
        continue
      }

      if (isPreconditionFailed(objectDelete.error) === false) {
        return err(createStoreError(objectDelete.error.message))
      }

      // Lost the CAS race — the record changed since the read (most
      // plausibly a concurrent transfer). Do NOT count this as deleted: the
      // secrets are still on disk under whatever the current object holds.
      skipped += 1
      logger.warn(
        {key, operatorId: args.operatorId},
        'operator push subscription store: deleteForOperator lost the physical-delete CAS race — secrets remain on disk pending a later prune or transfer',
      )

      // Step 4 — rollback the tombstone if the record no longer belongs to
      // this operator, so we don't shadow a legitimately transferred record.
      const reread = await cas.data.getObject(key)
      if (reread.success === true) {
        const reparsed = parseSubscriptionRecord(reread.data.data)
        if (reparsed.success === true && reparsed.data.operatorId !== args.operatorId) {
          // Re-fetch the tombstone's current etag rather than trusting the
          // step-2 write result — a concurrent prune could have raced it too.
          const currentTombstone = await cas.data.getObject(tombstoneKey)
          if (currentTombstone.success === true) {
            const tombstoneRollback = await cas.data.conditionalDelete(tombstoneKey, {
              ifMatch: currentTombstone.data.etag,
            })
            if (tombstoneRollback.success === false && isNotFound(tombstoneRollback.error) === false) {
              logger.warn(
                {key, tombstoneKey, error: tombstoneRollback.error.message},
                'operator push subscription store: failed to roll back tombstone after a lost delete race against a transferred record',
              )
            }
          }
        }
      }
    }
    return ok({deleted, skipped})
  }

  // -------------------------------------------------------------------------
  // listMetadataForOperator / getActiveRecordsForOperator
  // -------------------------------------------------------------------------

  async function listMetadataForOperator(args: {
    readonly operatorId: string
  }): Promise<Result<readonly SubscriptionMetadata[], StoreError>> {
    const all = await listAllRecords()
    if (all.success === false) {
      return err(all.error)
    }
    return ok(all.data.filter(r => r.operatorId === args.operatorId).map(toSubscriptionMetadata))
  }

  async function getActiveRecordsForOperator(args: {
    readonly operatorId: string
  }): Promise<Result<readonly SubscriptionRecord[], StoreError>> {
    const all = await listAllRecords()
    if (all.success === false) {
      return err(all.error)
    }
    return ok(all.data.filter(r => r.operatorId === args.operatorId && r.active === true))
  }

  // -------------------------------------------------------------------------
  // markDead
  // -------------------------------------------------------------------------

  async function markDead(args: {
    readonly operatorId: string
    readonly endpoint: string
  }): Promise<Result<void, StoreError>> {
    const cas = requireCasCapable()
    if (cas.success === false) {
      return err(cas.error)
    }

    const endpointHash = hashEndpoint(args.endpoint)
    const maxAttempts = 5
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const existing = await readRecord(endpointHash)
      if (existing.success === false) {
        return err(existing.error)
      }
      if (existing.data === null) {
        return ok(undefined) // Already gone — nothing to mark.
      }

      const {record: current, etag} = existing.data
      if (current.operatorId !== args.operatorId) {
        // Fail closed — a different operator cannot deactivate someone else's record.
        return err(createStoreError('markDead: endpoint is not owned by this operator'))
      }
      if (current.active === false) {
        return ok(undefined) // Already inactive — no-op.
      }

      const now = clock()
      const nextRecord: SubscriptionRecord = {
        ...current,
        active: false,
        updatedAt: now,
        deactivatedAt: now,
        inactiveReason: 'dead',
      }
      const write = await cas.data.conditionalPut(buildKey(endpointHash), JSON.stringify(nextRecord), {
        ifMatch: etag,
      })
      if (write.success === false) {
        if (isPreconditionFailed(write.error)) {
          continue
        }
        return err(createStoreError(write.error.message))
      }
      return ok(undefined)
    }
    return err(createStoreError('markDead: exceeded max CAS retry attempts'))
  }

  // -------------------------------------------------------------------------
  // pruneInactive
  // -------------------------------------------------------------------------

  async function pruneInactive(args?: {
    readonly recordsOlderThanMs?: number
    readonly tombstonesOlderThanMs?: number
  }): Promise<Result<PruneResult, StoreError>> {
    const cas = requireCasCapable()
    if (cas.success === false) {
      return err(cas.error)
    }

    const recordsThreshold = args?.recordsOlderThanMs ?? inactiveRetentionMs
    const tombstonesThreshold = args?.tombstonesOlderThanMs ?? tombstoneRetentionMs
    const now = clock()

    // --- prune inactive subscription records ---
    const keys = await listAllKeys()
    if (keys.success === false) {
      return err(keys.error)
    }

    let prunedRecords = 0
    for (const key of keys.data) {
      const fetched = await cas.data.getObject(key)
      if (fetched.success === false) {
        if (isNotFound(fetched.error)) continue
        return err(createStoreError(fetched.error.message))
      }
      const parsed = parseSubscriptionRecord(fetched.data.data)
      if (parsed.success === false) continue

      const record = parsed.data
      // Only ever remove already-inactive records — never resurrects anything.
      if (record.active === true) continue
      const deactivatedAt = record.deactivatedAt ?? record.updatedAt
      if (now - deactivatedAt < recordsThreshold) continue

      const deleted = await cas.data.conditionalDelete(key, {ifMatch: fetched.data.etag})
      if (deleted.success === false) {
        if (isPreconditionFailed(deleted.error) || isNotFound(deleted.error)) {
          continue // Changed/removed concurrently — skip, not an error.
        }
        return err(createStoreError(deleted.error.message))
      }
      prunedRecords += 1
    }

    // --- prune expired tombstones ---
    // MUST NOT run before tombstonesThreshold has elapsed since deletion —
    // removing a tombstone too early re-exposes the window in which an
    // older backup restore of the (already-removed) subscription object
    // could resurrect it with no tombstone left to exclude it.
    const tombstoneKeys = await adapter.list(`${tombstonePrefix}/`)
    if (tombstoneKeys.success === false) {
      return err(createStoreError(tombstoneKeys.error.message))
    }

    let prunedTombstones = 0
    for (const key of tombstoneKeys.data) {
      const fetched = await cas.data.getObject(key)
      if (fetched.success === false) {
        if (isNotFound(fetched.error)) continue
        return err(createStoreError(fetched.error.message))
      }
      let tombstone: TombstoneRecord
      try {
        const parsed: unknown = JSON.parse(fetched.data.data)
        if (
          typeof parsed !== 'object' ||
          parsed == null ||
          typeof (parsed as Partial<TombstoneRecord>).deletedAt !== 'number'
        ) {
          continue
        }
        tombstone = parsed as TombstoneRecord
      } catch {
        continue
      }

      if (now - tombstone.deletedAt < tombstonesThreshold) continue

      const deleted = await cas.data.conditionalDelete(key, {ifMatch: fetched.data.etag})
      if (deleted.success === false) {
        if (isPreconditionFailed(deleted.error) || isNotFound(deleted.error)) {
          continue
        }
        return err(createStoreError(deleted.error.message))
      }
      prunedTombstones += 1
    }

    return ok({records: prunedRecords, tombstones: prunedTombstones})
  }

  // -------------------------------------------------------------------------
  // verifyStillOwned
  // -------------------------------------------------------------------------

  async function verifyStillOwned(args: {
    readonly endpointHash: string
    readonly operatorId: string
    readonly ownershipGeneration: number
  }): Promise<Result<boolean, StoreError>> {
    const tombstoned = await hasTombstone(args.endpointHash)
    if (tombstoned.success === false) {
      return err(tombstoned.error)
    }
    if (tombstoned.data) {
      return ok(false)
    }

    const existing = await readRecord(args.endpointHash)
    if (existing.success === false) {
      return err(existing.error)
    }
    if (existing.data === null) {
      return ok(false)
    }
    const {record} = existing.data
    return ok(
      record.active === true &&
        record.operatorId === args.operatorId &&
        record.ownershipGeneration === args.ownershipGeneration,
    )
  }

  // -------------------------------------------------------------------------
  // selfTestCas
  // -------------------------------------------------------------------------

  async function selfTestCas(): Promise<Result<void, StoreError | SelfTestCasFailure>> {
    if (adapter.conditionalPut == null || adapter.conditionalDelete == null || adapter.getObject == null) {
      return err(
        createSelfTestCasFailure(
          'Object store adapter does not support conditionalPut/conditionalDelete/getObject — cannot verify CAS',
        ),
      )
    }

    const testKey = `${SELF_TEST_PREFIX}/${randomUUID()}.json`

    try {
      // Race two ifNoneMatch creates against the same key. A real CAS backend
      // must let exactly one succeed and fail the other with a precondition
      // conflict; a last-write-wins backend lets both "succeed".
      const [first, second] = await Promise.all([
        adapter.conditionalPut(testKey, JSON.stringify({attempt: 1}), {ifNoneMatch: '*'}),
        adapter.conditionalPut(testKey, JSON.stringify({attempt: 2}), {ifNoneMatch: '*'}),
      ])

      const successes = [first, second].filter(r => r.success === true)
      const failures = [first, second].filter(r => r.success === false)

      if (successes.length !== 1 || failures.length !== 1) {
        return err(
          createSelfTestCasFailure(
            `Object store failed the contended-write self-test: expected exactly one winner and one conflict, got ${successes.length} winner(s) and ${failures.length} conflict(s) — the store does not provide real compare-and-swap`,
          ),
        )
      }

      const failure = failures[0]
      if (failure !== undefined && failure.success === false && isPreconditionFailed(failure.error) === false) {
        return err(
          createSelfTestCasFailure(
            `Object store contended-write self-test failed for an unexpected reason (not a precondition conflict): ${failure.error.message}`,
          ),
        )
      }

      return ok(undefined)
    } finally {
      // Best-effort cleanup — read current etag then delete; ignore failures
      // (a leftover self-test key does not affect the active dispatch set).
      const cleanupRead = await adapter.getObject(testKey)
      if (cleanupRead.success === true) {
        try {
          await adapter.conditionalDelete(testKey, {ifMatch: cleanupRead.data.etag})
        } catch (error) {
          logger.debug({error, testKey}, 'operator push subscription store: self-test cleanup delete threw')
        }
      }
    }
  }

  return {
    subscribe,
    unsubscribe,
    deactivateForOperator,
    deleteForOperator,
    listMetadataForOperator,
    getActiveRecordsForOperator,
    markDead,
    pruneInactive,
    verifyStillOwned,
    selfTestCas,
  }
}
