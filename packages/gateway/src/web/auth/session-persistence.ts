/**
 * Durable, signed session records for the operator web surface.
 *
 * Each session is one object keyed by a hash of its session ID — never the ID itself:
 *
 *   operator-web/sessions/{sha256(sessionId) hex}.json
 *
 * The record holds `githubUserId`, `login`, `issuedAt`, a status (`active`, `revoked`, `rotated`) and an
 * HMAC. It holds no OAuth token, no raw session ID and no last-access time. The MAC covers a fixed-order
 * canonical body plus the record's own key hash, so a record copied to another key fails verification. Its
 * key is HKDF output from the CSRF secret under a distinct info label, so the CSRF signing key never signs
 * a record. Rotating the CSRF secret therefore fails the MAC of every stored record at the next load.
 *
 * This module owns every session object-store call: create-if-absent, CAS revoke, bounded load, bounded
 * sweep and the startup self-test. It never logs a session ID, a key hash or a raw key — only counts and
 * coarse error classes. Adapter error messages are dropped for the same reason.
 *
 * The MAC does not stop rollback of a revoked record to an earlier signed copy. Bucket write access stays a
 * trust root, limited to sessions that already existed.
 */

import type {ObjectStoreAdapter, ObjectStoreOperationError, Result} from '@fro-bot/runtime'

import {Buffer} from 'node:buffer'
import {createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual} from 'node:crypto'
import {err, ok} from '@fro-bot/runtime'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Raw adapter key prefix for session records. Sits at the bucket root, outside the Action's state prefix. */
export const SESSION_KEY_PREFIX = 'operator-web/sessions'

// A sibling of the session prefix: load and sweep never list it, so leftover self-test keys are never scanned.
const SELF_TEST_PREFIX = 'operator-web/_self-test'

/** HKDF info label for the record MAC key. Distinct from every CSRF label so the keys never coincide. */
export const SESSION_RECORD_MAC_LABEL = 'fro-bot/operator-session-record/v1'

const KEY_HASH_PATTERN = /^[0-9a-f]{64}$/
const MAX_LOGIN_LENGTH = 255
const DEFAULT_FUTURE_SKEW_MS = 5 * 60 * 1000
const DEFAULT_OPERATION_TIMEOUT_MS = 5000
const DEFAULT_CAS_MAX_ATTEMPTS = 5
const DEFAULT_SCAN_CONCURRENCY = 16
const DEFAULT_SCAN_TIMEOUT_MS = 30_000
const DEFAULT_SCAN_MAX_KEYS = 20_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `revoked` is logout or revoke. `rotated` is a same-user re-login that deliberately fires no hook. */
export type SessionRecordStatus = 'active' | 'revoked' | 'rotated'

export interface SessionRecord {
  readonly githubUserId: number
  readonly login: string
  readonly issuedAt: number
  readonly status: SessionRecordStatus
  readonly mac: string
}

/** A record that passed shape, MAC, future-date and age checks. `keyHash` is the hash from its object key. */
export interface LoadedSession {
  readonly keyHash: string
  readonly githubUserId: number
  readonly login: string
  readonly issuedAt: number
  readonly status: SessionRecordStatus
}

export type SessionPersistenceErrorKind =
  'unsupported_adapter' | 'store_error' | 'conflict' | 'cas_exhausted' | 'timeout' | 'self_test_failed'

export interface SessionPersistenceError extends Error {
  readonly code: 'OPERATOR_SESSION_PERSISTENCE_ERROR'
  readonly kind: SessionPersistenceErrorKind
  /** Coarse adapter error class (for example `http_503` or `AccessDenied`). Never an adapter message. */
  readonly errorClass: string
  /** Retries made after the first attempt before the operation gave up. Zero for single-shot operations. */
  readonly retries: number
}

export function createSessionPersistenceError(
  kind: SessionPersistenceErrorKind,
  message: string,
  errorClass = 'none',
  retries = 0,
): SessionPersistenceError {
  return Object.assign(new Error(message), {
    code: 'OPERATOR_SESSION_PERSISTENCE_ERROR' as const,
    kind,
    errorClass,
    retries,
  })
}

export interface SessionPersistenceLogger {
  readonly debug: (context: Record<string, unknown>, message: string) => void
  readonly info: (context: Record<string, unknown>, message: string) => void
  readonly warn: (context: Record<string, unknown>, message: string) => void
}

export interface SessionPersistenceDeps {
  readonly adapter: ObjectStoreAdapter
  readonly logger: SessionPersistenceLogger
  readonly clock: () => number
  /** HKDF output from {@link deriveSessionRecordKey}. */
  readonly macKey: Uint8Array
  /** Fixed session lifetime from `issuedAt`. */
  readonly absoluteTtlMs: number
  /** How far `issuedAt` may sit ahead of the clock before a record is rejected. Default 5 minutes. */
  readonly futureSkewMs?: number
  /** Timeout for each adapter call. Default 5 seconds. */
  readonly operationTimeoutMs?: number
  /** Attempts for the revoke read-modify-write loop. Default 5. */
  readonly casMaxAttempts?: number
  /** Simultaneous record reads during load and sweep. Default 16. */
  readonly scanConcurrency?: number
  /** Overall deadline for one load or sweep. Default 30 seconds. */
  readonly scanTimeoutMs?: number
  /** Most records one load or sweep reads. The excess is counted as `truncated`. Default 20,000. */
  readonly scanMaxKeys?: number
}

export interface CreateSessionRecordInput {
  readonly sessionId: string
  readonly githubUserId: number
  readonly login: string
  readonly issuedAt: number
}

/**
 * - `written`: the record was re-signed with the new status.
 * - `already`: the record was no longer active, so nothing was written.
 * - `absent`: no record exists (404). The session is already gone.
 * - `invalid`: the record is unreadable or fails its MAC. Load drops it anyway, so nothing was written.
 */
export type RevokeOutcome = 'written' | 'already' | 'absent' | 'invalid'

export interface LoadCounts {
  readonly listed: number
  readonly loaded: number
  readonly malformed: number
  readonly macFailed: number
  readonly futureDated: number
  readonly tooOld: number
  readonly readFailed: number
  readonly absent: number
  readonly truncated: number
}

export interface LoadOutcome {
  readonly sessions: readonly LoadedSession[]
  readonly counts: LoadCounts
}

export interface SweepCounts {
  readonly listed: number
  /** Records removed: past the TTL, unsigned (failed the MAC) or malformed. */
  readonly deleted: number
  /** Deletes that lost to a concurrent write or removal (412 or 404). */
  readonly raced: number
  readonly deleteFailed: number
  readonly kept: number
  /** Records found past the TTL. */
  readonly expired: number
  /** Records found with a failing MAC, whatever their claimed age. */
  readonly unsigned: number
  /** Records found that are not shaped like a record. */
  readonly malformed: number
  /** Keys under the prefix whose name is not a key hash. They are left alone. */
  readonly unrecognized: number
  readonly readFailed: number
  readonly absent: number
  readonly truncated: number
}

export interface SessionPersistence {
  /** Create-if-absent. A second create for the same session ID fails with kind `conflict`. */
  readonly create: (input: CreateSessionRecordInput) => Promise<Result<void, SessionPersistenceError>>
  /** CAS status change by key hash. 404 is done; 412 re-reads, up to the attempt bound. */
  readonly revoke: (
    keyHash: string,
    status: Exclude<SessionRecordStatus, 'active'>,
  ) => Promise<Result<RevokeOutcome, SessionPersistenceError>>
  /** Lists and verifies every record. A list failure or timeout is an error, never an empty result. */
  readonly load: () => Promise<Result<LoadOutcome, SessionPersistenceError>>
  /** Deletes records past the TTL, plus every record that fails its MAC or is malformed, whatever its age. */
  readonly sweep: () => Promise<Result<SweepCounts, SessionPersistenceError>>
  /** Proves the adapter has real CAS and a working list. Run at startup before load. */
  readonly selfTest: () => Promise<Result<void, SessionPersistenceError>>
}

// ---------------------------------------------------------------------------
// Keys and MAC
// ---------------------------------------------------------------------------

/** sha256 hex of the session ID. The only form of the ID that reaches the object store. */
export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex')
}

/** The one place a session object key is built. */
export function buildSessionKey(keyHash: string): string {
  return `${SESSION_KEY_PREFIX}/${keyHash}.json`
}

function keyHashFromKey(key: string): string | null {
  const prefix = `${SESSION_KEY_PREFIX}/`
  if (key.startsWith(prefix) === false || key.endsWith('.json') === false) {
    return null
  }
  const candidate = key.slice(prefix.length, key.length - '.json'.length)
  return KEY_HASH_PATTERN.test(candidate) ? candidate : null
}

/** HKDF-SHA256 over the decoded CSRF secret. A different label yields an unrelated key. */
export function deriveSessionRecordKey(csrfSecretBytes: Uint8Array, label: string = SESSION_RECORD_MAC_LABEL): Buffer {
  return Buffer.from(hkdfSync('sha256', csrfSecretBytes, Buffer.alloc(0), label, 32))
}

type RecordFields = Omit<SessionRecord, 'mac'>

function computeMac(macKey: Uint8Array, keyHash: string, fields: RecordFields): string {
  // A JSON array keeps field boundaries unambiguous whatever `login` contains.
  const body = JSON.stringify([
    SESSION_RECORD_MAC_LABEL,
    keyHash,
    fields.githubUserId,
    fields.login,
    fields.issuedAt,
    fields.status,
  ])
  return createHmac('sha256', macKey).update(body).digest('base64url')
}

/** Signs a record for `keyHash`. Exported so tests can plant records. */
export function signSessionRecord(macKey: Uint8Array, keyHash: string, fields: RecordFields): SessionRecord {
  return {...fields, mac: computeMac(macKey, keyHash, fields)}
}

function verifySessionRecord(macKey: Uint8Array, keyHash: string, record: SessionRecord): boolean {
  const expected = Buffer.from(computeMac(macKey, keyHash, record), 'utf8')
  const provided = Buffer.from(record.mac, 'utf8')
  return expected.length === provided.length && timingSafeEqual(expected, provided)
}

function isRecordStatus(value: unknown): value is SessionRecordStatus {
  return value === 'active' || value === 'revoked' || value === 'rotated'
}

/** Parses a stored body into a record, or null when it is not shaped like one. Never throws. */
function parseSessionRecord(data: string): SessionRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const candidate = parsed as Partial<Record<keyof SessionRecord, unknown>>
  const {githubUserId, login, issuedAt, status, mac} = candidate
  if (
    typeof githubUserId !== 'number' ||
    Number.isSafeInteger(githubUserId) === false ||
    githubUserId <= 0 ||
    typeof login !== 'string' ||
    login.length === 0 ||
    login.length > MAX_LOGIN_LENGTH ||
    typeof issuedAt !== 'number' ||
    Number.isSafeInteger(issuedAt) === false ||
    issuedAt < 0 ||
    isRecordStatus(status) === false ||
    typeof mac !== 'string' ||
    mac.length === 0
  ) {
    return null
  }
  return {githubUserId, login, issuedAt, status, mac}
}

// ---------------------------------------------------------------------------
// Adapter plumbing
// ---------------------------------------------------------------------------

interface AdapterFailure {
  readonly reason: 'not_found' | 'precondition_failed' | 'timeout' | 'other'
  readonly errorClass: string
}

// Structured-error-first classification, as in the push store and the coordination lock: check the S3
// adapter's ObjectStoreOperationError fields before falling back to message matching for plain-Error adapters.
function classifyFailure(error: unknown): AdapterFailure {
  if (error instanceof Error === false) {
    return {reason: 'other', errorClass: 'non_error'}
  }
  const structured = error as Partial<ObjectStoreOperationError>
  const code = structured.errorCode ?? structured.errorName
  let precondition: boolean
  let missing: boolean
  if (structured.httpStatusCode === undefined) {
    if (code === undefined) {
      precondition = /pre-?condition/i.test(error.message)
      missing = /not.?found|no.?such.?key|does.?not.?exist|404/i.test(error.message)
    } else {
      precondition = code === 'PreconditionFailed'
      missing = code === 'NoSuchKey' || code === 'NotFound'
    }
  } else {
    precondition = structured.httpStatusCode === 412
    missing = structured.httpStatusCode === 404
  }
  if (precondition) {
    return {reason: 'precondition_failed', errorClass: 'precondition_failed'}
  }
  if (missing) {
    return {reason: 'not_found', errorClass: 'not_found'}
  }
  if (structured.httpStatusCode !== undefined) {
    return {reason: 'other', errorClass: `http_${structured.httpStatusCode}`}
  }
  return {reason: 'other', errorClass: code ?? error.name}
}

async function invoke<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, AdapterFailure>> {
  try {
    const result = await operation()
    return result.success ? ok(result.data) : err(classifyFailure(result.error))
  } catch (error) {
    return err(classifyFailure(error))
  }
}

/** Runs one adapter call under a timeout. Never throws; a throw becomes a failure. */
async function timedCall<T>(
  operation: () => Promise<Result<T, Error>>,
  timeoutMs: number,
): Promise<Result<T, AdapterFailure>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Result<never, AdapterFailure>>(resolve => {
    timer = setTimeout(() => {
      resolve(err({reason: 'timeout', errorClass: 'timeout'}))
    }, timeoutMs)
  })
  try {
    return await Promise.race([invoke(operation), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function failureToError(operation: string, failure: AdapterFailure, retries = 0): SessionPersistenceError {
  return createSessionPersistenceError(
    failure.reason === 'timeout' ? 'timeout' : 'store_error',
    `session ${operation} failed: ${failure.errorClass}`,
    failure.errorClass,
    retries,
  )
}

interface SessionObjectOps {
  readonly list: ObjectStoreAdapter['list']
  readonly getObject: NonNullable<ObjectStoreAdapter['getObject']>
  readonly conditionalPut: NonNullable<ObjectStoreAdapter['conditionalPut']>
  readonly conditionalDelete: NonNullable<ObjectStoreAdapter['conditionalDelete']>
}

/** Narrows the optional adapter methods (and `list`) into a typed error before any operation runs. */
function narrowAdapter(adapter: ObjectStoreAdapter): Result<SessionObjectOps, SessionPersistenceError> {
  const {list, getObject, conditionalPut, conditionalDelete} = adapter
  const missing = (method: string): Result<SessionObjectOps, SessionPersistenceError> =>
    err(createSessionPersistenceError('unsupported_adapter', `object store adapter does not support ${method}`))
  if (typeof list !== 'function') return missing('list')
  if (getObject == null) return missing('getObject')
  if (conditionalPut == null) return missing('conditionalPut')
  if (conditionalDelete == null) return missing('conditionalDelete')
  return ok({list, getObject, conditionalPut, conditionalDelete})
}

type ReadOutcome =
  | {readonly kind: 'absent'}
  | {readonly kind: 'failed'}
  | {readonly kind: 'malformed'; readonly etag: string}
  | {readonly kind: 'record'; readonly record: SessionRecord; readonly etag: string; readonly macValid: boolean}

interface ScanEntry {
  readonly keyHash: string
  readonly outcome: ReadOutcome
}

interface ScanOutput {
  readonly entries: readonly ScanEntry[]
  readonly listed: number
  /** Keys under the prefix whose name is not a key hash. Counted as malformed by load. */
  readonly unrecognized: number
  readonly truncated: number
}

interface DeadlineState {
  cancelled: boolean
}

/** Runs `worker` over `items` with at most `limit` in flight. Lanes stop taking items once cancelled. */
async function runBounded<T>(
  items: readonly string[],
  limit: number,
  state: DeadlineState,
  worker: (item: string) => Promise<T>,
): Promise<T[]> {
  const results: T[] = []
  let next = 0
  const lane = async (): Promise<void> => {
    while (state.cancelled === false) {
      const item = items[next]
      next += 1
      if (item === undefined) {
        return
      }
      results.push(await worker(item))
    }
  }
  await Promise.all(Array.from({length: Math.max(1, Math.min(limit, items.length))}, lane))
  return results
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionPersistence(deps: SessionPersistenceDeps): SessionPersistence {
  const {adapter, logger, clock, macKey, absoluteTtlMs} = deps
  const futureSkewMs = deps.futureSkewMs ?? DEFAULT_FUTURE_SKEW_MS
  const operationTimeoutMs = deps.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  const casMaxAttempts = deps.casMaxAttempts ?? DEFAULT_CAS_MAX_ATTEMPTS
  const scanConcurrency = deps.scanConcurrency ?? DEFAULT_SCAN_CONCURRENCY
  const scanTimeoutMs = deps.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
  const scanMaxKeys = deps.scanMaxKeys ?? DEFAULT_SCAN_MAX_KEYS

  function isExpired(issuedAt: number): boolean {
    return clock() >= issuedAt + absoluteTtlMs
  }

  function isFutureDated(issuedAt: number): boolean {
    return issuedAt > clock() + futureSkewMs
  }

  async function readEntry(ops: SessionObjectOps, keyHash: string): Promise<ScanEntry> {
    const fetched = await timedCall(async () => ops.getObject(buildSessionKey(keyHash)), operationTimeoutMs)
    if (fetched.success === false) {
      return {keyHash, outcome: fetched.error.reason === 'not_found' ? {kind: 'absent'} : {kind: 'failed'}}
    }
    const record = parseSessionRecord(fetched.data.data)
    if (record === null) {
      return {keyHash, outcome: {kind: 'malformed', etag: fetched.data.etag}}
    }
    return {
      keyHash,
      outcome: {
        kind: 'record',
        record,
        etag: fetched.data.etag,
        macValid: verifySessionRecord(macKey, keyHash, record),
      },
    }
  }

  async function scan(
    ops: SessionObjectOps,
    state: DeadlineState,
  ): Promise<Result<ScanOutput, SessionPersistenceError>> {
    const listed = await timedCall(async () => ops.list(`${SESSION_KEY_PREFIX}/`), operationTimeoutMs)
    if (listed.success === false) {
      return err(failureToError('list', listed.error))
    }
    const keyHashes: string[] = []
    let unrecognized = 0
    for (const key of listed.data) {
      const keyHash = keyHashFromKey(key)
      if (keyHash === null) {
        unrecognized += 1
      } else {
        keyHashes.push(keyHash)
      }
    }
    const truncated = Math.max(0, keyHashes.length - scanMaxKeys)
    const entries = await runBounded(keyHashes.slice(0, scanMaxKeys), scanConcurrency, state, async keyHash =>
      readEntry(ops, keyHash),
    )
    return ok({entries, listed: listed.data.length, unrecognized, truncated})
  }

  /** Runs `work` under the overall deadline. On expiry the lanes stop and the call fails with kind `timeout`. */
  async function withDeadline<T>(
    operation: string,
    work: (state: DeadlineState) => Promise<Result<T, SessionPersistenceError>>,
  ): Promise<Result<T, SessionPersistenceError>> {
    const state: DeadlineState = {cancelled: false}
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<Result<never, SessionPersistenceError>>(resolve => {
      timer = setTimeout(() => {
        state.cancelled = true
        resolve(err(createSessionPersistenceError('timeout', `session ${operation} exceeded its deadline`, 'timeout')))
      }, scanTimeoutMs)
    })
    try {
      return await Promise.race([work(state), deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async function create(input: CreateSessionRecordInput): Promise<Result<void, SessionPersistenceError>> {
    const ops = narrowAdapter(adapter)
    if (ops.success === false) {
      return err(ops.error)
    }
    const keyHash = hashSessionId(input.sessionId)
    const record = signSessionRecord(macKey, keyHash, {
      githubUserId: input.githubUserId,
      login: input.login,
      issuedAt: input.issuedAt,
      status: 'active',
    })
    const written = await timedCall(
      async () => ops.data.conditionalPut(buildSessionKey(keyHash), JSON.stringify(record), {ifNoneMatch: '*'}),
      operationTimeoutMs,
    )
    if (written.success === false) {
      if (written.error.reason === 'precondition_failed') {
        return err(createSessionPersistenceError('conflict', 'session create conflicted with an existing record'))
      }
      return err(failureToError('create', written.error))
    }
    return ok(undefined)
  }

  // -------------------------------------------------------------------------
  // revoke
  // -------------------------------------------------------------------------

  async function revoke(
    keyHash: string,
    status: Exclude<SessionRecordStatus, 'active'>,
  ): Promise<Result<RevokeOutcome, SessionPersistenceError>> {
    const ops = narrowAdapter(adapter)
    if (ops.success === false) {
      return err(ops.error)
    }
    const key = buildSessionKey(keyHash)
    for (let attempt = 0; attempt < casMaxAttempts; attempt++) {
      const fetched = await timedCall(async () => ops.data.getObject(key), operationTimeoutMs)
      if (fetched.success === false) {
        if (fetched.error.reason === 'not_found') {
          return ok('absent')
        }
        return err(failureToError('revoke', fetched.error, attempt))
      }
      const current = parseSessionRecord(fetched.data.data)
      // Load drops an unreadable or unsigned record, so there is nothing left to revoke.
      if (current === null || verifySessionRecord(macKey, keyHash, current) === false) {
        return ok('invalid')
      }
      if (current.status !== 'active') {
        return ok('already')
      }
      const next = signSessionRecord(macKey, keyHash, {
        githubUserId: current.githubUserId,
        login: current.login,
        issuedAt: current.issuedAt,
        status,
      })
      const written = await timedCall(
        async () => ops.data.conditionalPut(key, JSON.stringify(next), {ifMatch: fetched.data.etag}),
        operationTimeoutMs,
      )
      if (written.success) {
        return ok('written')
      }
      if (written.error.reason === 'not_found') {
        return ok('absent')
      }
      if (written.error.reason !== 'precondition_failed') {
        return err(failureToError('revoke', written.error, attempt))
      }
      // Lost a race: re-read, and a concurrent revoke then reports `already`.
    }
    return err(
      createSessionPersistenceError(
        'cas_exhausted',
        'session revoke exhausted its CAS attempts',
        'precondition_failed',
        casMaxAttempts - 1,
      ),
    )
  }

  // -------------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------------

  async function load(): Promise<Result<LoadOutcome, SessionPersistenceError>> {
    const ops = narrowAdapter(adapter)
    if (ops.success === false) {
      return err(ops.error)
    }
    const scanned = await withDeadline('load', async state => scan(ops.data, state))
    if (scanned.success === false) {
      return err(scanned.error)
    }

    const sessions: LoadedSession[] = []
    let malformed = scanned.data.unrecognized
    let macFailed = 0
    let futureDated = 0
    let tooOld = 0
    let readFailed = 0
    let absent = 0
    for (const {keyHash, outcome} of scanned.data.entries) {
      if (outcome.kind === 'absent') {
        absent += 1
      } else if (outcome.kind === 'failed') {
        readFailed += 1
      } else if (outcome.kind === 'malformed') {
        malformed += 1
      } else if (outcome.macValid === false) {
        // The MAC is checked before any claim in the record is trusted, even to classify it.
        macFailed += 1
      } else if (isFutureDated(outcome.record.issuedAt)) {
        futureDated += 1
      } else if (isExpired(outcome.record.issuedAt)) {
        tooOld += 1
      } else {
        const {githubUserId, login, issuedAt, status} = outcome.record
        sessions.push({keyHash, githubUserId, login, issuedAt, status})
      }
    }

    const counts: LoadCounts = {
      listed: scanned.data.listed,
      loaded: sessions.length,
      malformed,
      macFailed,
      futureDated,
      tooOld,
      readFailed,
      absent,
      truncated: scanned.data.truncated,
    }
    logger.info({...counts}, 'operator session load scanned stored records')
    return ok({sessions, counts})
  }

  // -------------------------------------------------------------------------
  // sweep
  // -------------------------------------------------------------------------

  async function sweep(): Promise<Result<SweepCounts, SessionPersistenceError>> {
    const ops = narrowAdapter(adapter)
    if (ops.success === false) {
      return err(ops.error)
    }
    const swept = await withDeadline('sweep', async state => {
      const scanned = await scan(ops.data, state)
      if (scanned.success === false) {
        return err(scanned.error)
      }

      let kept = 0
      let expiredFound = 0
      let unsigned = 0
      let malformed = 0
      let readFailed = 0
      let absent = 0
      const doomed = new Map<string, string>()
      for (const {keyHash, outcome} of scanned.data.entries) {
        if (outcome.kind === 'absent') {
          absent += 1
        } else if (outcome.kind === 'failed') {
          readFailed += 1
        } else if (outcome.kind === 'malformed') {
          malformed += 1
          doomed.set(keyHash, outcome.etag)
        } else if (outcome.macValid === false) {
          // A failing MAC means the claimed `issuedAt` cannot be trusted, so the age rule cannot apply.
          // Load rejects the record anyway, so removing it loses nothing.
          unsigned += 1
          doomed.set(keyHash, outcome.etag)
        } else if (isExpired(outcome.record.issuedAt)) {
          expiredFound += 1
          doomed.set(keyHash, outcome.etag)
        } else {
          kept += 1
        }
      }

      let deleted = 0
      let raced = 0
      let deleteFailed = 0
      await runBounded([...doomed.keys()], scanConcurrency, state, async keyHash => {
        const etag = doomed.get(keyHash)
        if (etag === undefined) {
          return
        }
        const removed = await timedCall(
          async () => ops.data.conditionalDelete(buildSessionKey(keyHash), {ifMatch: etag}),
          operationTimeoutMs,
        )
        if (removed.success) {
          deleted += 1
        } else if (removed.error.reason === 'precondition_failed' || removed.error.reason === 'not_found') {
          raced += 1
        } else {
          deleteFailed += 1
        }
      })
      if (state.cancelled) {
        return err(createSessionPersistenceError('timeout', 'session sweep exceeded its deadline', 'timeout'))
      }
      const counts: SweepCounts = {
        listed: scanned.data.listed,
        deleted,
        raced,
        deleteFailed,
        kept,
        expired: expiredFound,
        unsigned,
        malformed,
        unrecognized: scanned.data.unrecognized,
        readFailed,
        absent,
        truncated: scanned.data.truncated,
      }
      return ok(counts)
    })
    if (swept.success) {
      logger.info({...swept.data}, 'operator session sweep finished')
    }
    return swept
  }

  // -------------------------------------------------------------------------
  // selfTest
  // -------------------------------------------------------------------------

  async function selfTest(): Promise<Result<void, SessionPersistenceError>> {
    const ops = narrowAdapter(adapter)
    if (ops.success === false) {
      return err(ops.error)
    }
    const prefix = `${SELF_TEST_PREFIX}/`
    const testKey = `${prefix}${randomUUID()}.json`
    const failed = (message: string): Result<void, SessionPersistenceError> =>
      err(createSessionPersistenceError('self_test_failed', message))
    let removed = false

    try {
      const created = await timedCall(
        async () => ops.data.conditionalPut(testKey, JSON.stringify({step: 'create'}), {ifNoneMatch: '*'}),
        operationTimeoutMs,
      )
      if (created.success === false) {
        return err(failureToError('self-test create', created.error))
      }

      const listed = await timedCall(async () => ops.data.list(prefix), operationTimeoutMs)
      if (listed.success === false) {
        return err(failureToError('self-test list', listed.error))
      }
      if (listed.data.includes(testKey) === false) {
        // S3 reports a denied ListBucket as an empty result, which would look like an empty store.
        return failed('self-test key missing from list: the identity may lack ListBucket on operator-web/')
      }

      const read = await timedCall(async () => ops.data.getObject(testKey), operationTimeoutMs)
      if (read.success === false) {
        return err(failureToError('self-test get', read.error))
      }
      if (read.data.data !== JSON.stringify({step: 'create'})) {
        return failed('self-test read-back did not match the written body')
      }

      const updated = await timedCall(
        async () => ops.data.conditionalPut(testKey, JSON.stringify({step: 'update'}), {ifMatch: read.data.etag}),
        operationTimeoutMs,
      )
      if (updated.success === false) {
        return err(failureToError('self-test update', updated.error))
      }

      const duplicate = await timedCall(
        async () => ops.data.conditionalPut(testKey, JSON.stringify({step: 'duplicate'}), {ifNoneMatch: '*'}),
        operationTimeoutMs,
      )
      if (duplicate.success) {
        return failed('self-test second create did not conflict: the store does not provide compare-and-swap')
      }
      if (duplicate.error.reason !== 'precondition_failed') {
        return failed(
          `self-test second create failed for a reason other than a conflict: ${duplicate.error.errorClass}`,
        )
      }

      const deleted = await timedCall(
        async () => ops.data.conditionalDelete(testKey, {ifMatch: updated.data.etag}),
        operationTimeoutMs,
      )
      if (deleted.success === false) {
        return err(failureToError('self-test delete', deleted.error))
      }
      removed = true
      return ok(undefined)
    } finally {
      if (removed === false) {
        await cleanupSelfTestKey(ops.data, testKey)
      }
    }
  }

  // Best-effort: a leftover self-test key sits outside the session prefix, so it is never scanned.
  async function cleanupSelfTestKey(ops: SessionObjectOps, testKey: string): Promise<void> {
    const fetched = await timedCall(async () => ops.getObject(testKey), operationTimeoutMs)
    if (fetched.success === false) {
      return
    }
    const deleted = await timedCall(
      async () => ops.conditionalDelete(testKey, {ifMatch: fetched.data.etag}),
      operationTimeoutMs,
    )
    if (deleted.success === false) {
      logger.debug({errorClass: deleted.error.errorClass}, 'operator session self-test cleanup failed')
    }
  }

  return {create, revoke, load, sweep, selfTest}
}
