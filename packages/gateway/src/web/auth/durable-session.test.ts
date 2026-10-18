/**
 * Tests for the durable session store over the shared ETag/CAS object-store fake.
 *
 * Covers create, get, durable-first revoke, rotation, hook semantics, the startup load policy,
 * push replay, the not-ready state, and that no emitted log or audit record carries an ID, hash, login or token.
 *
 * Uses BDD comments (#given, #when, #then).
 */

import type {AuditLogger} from '../audit.js'
import type {OperatorAllowlist} from './allowlist.js'
import type {SessionRecordStatus} from './session-persistence.js'
import type {DurableSessionStore, SessionRevokedContext} from './session.js'
import type {TestObjectStore} from './test-object-store.js'

import {Buffer} from 'node:buffer'
import {describe, expect, it, vi} from 'vitest'
import {createOperatorPushSubscriptionStore} from '../operator-push/subscription-store.js'
import {
  buildSessionKey,
  createSessionPersistence,
  deriveSessionRecordKey,
  hashSessionId,
  signSessionRecord,
} from './session-persistence.js'
import {createDurableSessionStore, DURABLE_SESSION_TTL_MS} from './session.js'
import {createPreconditionFailedError, createTestObjectStore} from './test-object-store.js'

const NOW = 1_800_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000
const TTL_MS = DURABLE_SESSION_TTL_MS
const OPERATOR_ID = 4242
const OTHER_ID = 777
const LOGIN = 'operator-login-xyz'
const MAC_KEY = deriveSessionRecordKey(Buffer.from('csrf-secret-for-tests-0123456789ab', 'utf8'))
const SESSIONS_PREFIX = 'operator-web/sessions/'

interface Clock {
  now: number
}

interface Harness {
  readonly session: DurableSessionStore
  readonly store: TestObjectStore
  readonly clock: Clock
  readonly hook: ReturnType<typeof vi.fn<(githubUserId: number, context?: SessionRevokedContext) => void>>
  readonly logs: {readonly level: string; readonly context: Record<string, unknown>; readonly message: string}[]
  readonly audits: {readonly level: string; readonly context: Record<string, unknown>; readonly message: string}[]
}

interface HarnessOptions {
  readonly store?: TestObjectStore
  readonly clock?: Clock
  readonly hook?: (githubUserId: number, context?: SessionRevokedContext) => void
  readonly allowed?: readonly number[]
  readonly maxEntries?: number
  readonly casMaxAttempts?: number
  readonly scanTimeoutMs?: number
  readonly scanConcurrency?: number
}

function createHarness(options: HarnessOptions = {}): Harness {
  const store = options.store ?? createTestObjectStore()
  const clock = options.clock ?? {now: NOW}
  const hook = vi.fn<(githubUserId: number, context?: SessionRevokedContext) => void>(options.hook)
  const logs: Harness['logs'] = []
  const audits: Harness['audits'] = []
  const record =
    (sink: Harness['logs'], level: string) =>
    (context: Record<string, unknown>, message: string): void => {
      sink.push({level, context, message})
    }
  const allowed = new Set(options.allowed ?? [OPERATOR_ID])
  const allowlist: OperatorAllowlist = {isAuthorized: id => allowed.has(id), size: allowed.size}
  const logger = {
    debug: record(logs, 'debug'),
    info: record(logs, 'info'),
    warn: record(logs, 'warn'),
    error: record(logs, 'error'),
  }
  const auditLogger: AuditLogger = {info: record(audits, 'info'), warn: record(audits, 'warn')}
  const persistence = createSessionPersistence({
    adapter: store.adapter,
    logger,
    clock: () => clock.now,
    macKey: MAC_KEY,
    absoluteTtlMs: TTL_MS,
    ...(options.casMaxAttempts === undefined ? {} : {casMaxAttempts: options.casMaxAttempts}),
    ...(options.scanTimeoutMs === undefined ? {} : {scanTimeoutMs: options.scanTimeoutMs}),
    ...(options.scanConcurrency === undefined ? {} : {scanConcurrency: options.scanConcurrency}),
  })
  const session = createDurableSessionStore({
    persistence,
    clock: () => clock.now,
    logger,
    auditLogger,
    allowlist,
    onSessionRevoked: hook,
    ...(options.maxEntries === undefined ? {} : {maxEntries: options.maxEntries}),
  })
  return {session, store, clock, hook, logs, audits}
}

async function createReadyHarness(options: HarnessOptions = {}): Promise<Harness> {
  const harness = createHarness(options)
  const loaded = await harness.session.load()
  if (loaded.success === false) {
    throw new Error('expected the fixture load to succeed')
  }
  return harness
}

async function createSession(harness: Harness, githubUserId = OPERATOR_ID): Promise<string> {
  const created = await harness.session.create({githubUserId, login: LOGIN})
  if (created.outcome !== 'ok') {
    throw new Error(`expected create to succeed, got ${created.outcome}`)
  }
  return created.sessionId
}

function plantRecord(
  harness: Harness,
  sessionId: string,
  fields: {
    readonly issuedAt?: number
    readonly status?: SessionRecordStatus
    readonly githubUserId?: number
    readonly revokedAt?: number
    readonly macKey?: Uint8Array
  } = {},
): void {
  const keyHash = hashSessionId(sessionId)
  const record = signSessionRecord(fields.macKey ?? MAC_KEY, keyHash, {
    githubUserId: fields.githubUserId ?? OPERATOR_ID,
    login: LOGIN,
    issuedAt: fields.issuedAt ?? NOW,
    status: fields.status ?? 'active',
    ...(fields.revokedAt === undefined ? {} : {revokedAt: fields.revokedAt}),
  })
  harness.store.seed(buildSessionKey(keyHash), JSON.stringify(record))
}

function persistFailedAudits(harness: Harness): Harness['audits'] {
  return harness.audits.filter(audit => audit.context.kind === 'auth.revocation.persist_failed')
}

function storedStatus(harness: Harness, sessionId: string): string | undefined {
  const stored = harness.store.objects.get(buildSessionKey(hashSessionId(sessionId)))
  if (stored === undefined) return undefined
  return (JSON.parse(stored.data) as {status?: string}).status
}

async function settle(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0)
  })
}

describe('create and get', () => {
  it('writes a signed record under a hashed key with no token or raw ID, and get returns the identity', async () => {
    // #given a ready store
    const harness = await createReadyHarness()

    // #when a session is created
    const sessionId = await createSession(harness)

    // #then the stored record is keyed by the hash, validly signed, and carries no credential or raw ID
    const keyHash = hashSessionId(sessionId)
    const stored = harness.store.objects.get(buildSessionKey(keyHash))
    expect(stored).toBeDefined()
    const body = JSON.parse(stored?.data ?? '{}') as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['githubUserId', 'issuedAt', 'login', 'mac', 'status'])
    expect(body).toEqual(
      signSessionRecord(MAC_KEY, keyHash, {githubUserId: OPERATOR_ID, login: LOGIN, issuedAt: NOW, status: 'active'}),
    )
    expect(stored?.data).not.toContain(sessionId)
    expect([...harness.store.objects.keys()].some(key => key.includes(sessionId))).toBe(false)
    expect(harness.session.get(sessionId)).toEqual({githubUserId: OPERATOR_ID, login: LOGIN, issuedAt: NOW})
  })

  it('mints a different session ID for every login, including the same user', async () => {
    // #given a ready store
    const harness = await createReadyHarness()

    // #when the same user logs in twice
    const first = await createSession(harness)
    const second = await createSession(harness)

    // #then the IDs differ and are 256-bit base64url values
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[\w-]{43}$/)
    expect(second).toMatch(/^[\w-]{43}$/)
  })

  it('is valid at 7 days minus 1 ms and invalid at 7 days plus 1 ms, with no extension from activity', async () => {
    // #given a session created at NOW
    const harness = await createReadyHarness()
    const sessionId = await createSession(harness)

    // #when it is read on day 3 and after six days of silence
    harness.clock.now = NOW + 3 * DAY_MS
    const dayThree = harness.session.get(sessionId)
    harness.clock.now = NOW + 6 * DAY_MS
    const daySix = harness.session.get(sessionId)
    harness.clock.now = NOW + TTL_MS - 1
    const justInside = harness.session.get(sessionId)
    harness.clock.now = NOW + TTL_MS + 1
    const justOutside = harness.session.get(sessionId)

    // #then the lifetime is fixed from login
    expect(dayThree).toBeDefined()
    expect(daySix).toBeDefined()
    expect(justInside).toBeDefined()
    expect(justOutside).toBeUndefined()
  })

  it('makes no adapter call for an unknown ID', async () => {
    // #given a ready store
    const harness = await createReadyHarness()
    harness.store.resetCalls()

    // #when an unknown ID is read
    const found = harness.session.get('x'.repeat(43))

    // #then it is a map miss with no I/O
    expect(found).toBeUndefined()
    expect(harness.store.calls).toHaveLength(0)
  })
})

describe('cap and readiness', () => {
  it('returns cap and writes nothing when every entry is live', async () => {
    // #given a store at its cap with live sessions
    const harness = await createReadyHarness({maxEntries: 2})
    await createSession(harness)
    await createSession(harness)
    harness.store.resetCalls()

    // #when another login arrives
    const created = await harness.session.create({githubUserId: OPERATOR_ID, login: LOGIN})

    // #then it is refused without a write
    expect(created.outcome).toBe('cap')
    expect(harness.store.callCount('conditionalPut')).toBe(0)
    expect(harness.session.size()).toBe(2)
  })

  it('reclaims expired entries before refusing', async () => {
    // #given a store at its cap whose entries have expired
    const harness = await createReadyHarness({maxEntries: 2})
    await createSession(harness)
    await createSession(harness)
    harness.clock.now = NOW + TTL_MS + 1

    // #when another login arrives
    const created = await harness.session.create({githubUserId: OPERATOR_ID, login: LOGIN})

    // #then the dead entries are reclaimed and the login succeeds
    expect(created.outcome).toBe('ok')
    expect(harness.session.size()).toBe(1)
  })

  it('reclaims revoked entries before refusing', async () => {
    // #given a store at its cap with one revoked entry
    const harness = await createReadyHarness({maxEntries: 2})
    const first = await createSession(harness)
    await createSession(harness)
    await harness.session.revoke(first)

    // #when another login arrives
    const created = await harness.session.create({githubUserId: OPERATOR_ID, login: LOGIN})

    // #then the revoked slot is reused
    expect(created.outcome).toBe('ok')
  })

  it('counts in-flight creates against the cap', async () => {
    // #given one free slot and two simultaneous logins
    const harness = await createReadyHarness({maxEntries: 2})
    await createSession(harness)
    harness.store.setLatency('conditionalPut', 5)

    // #when both create at once
    const results = await Promise.all([
      harness.session.create({githubUserId: OPERATOR_ID, login: LOGIN}),
      harness.session.create({githubUserId: OPERATOR_ID, login: LOGIN}),
    ])

    // #then exactly one wins the slot
    expect(results.map(result => result.outcome).sort()).toEqual(['cap', 'ok'])
    expect(harness.session.size()).toBe(2)
  })

  it('returns write_failed for a failed durable create, with no map entry and no hook', async () => {
    // #given a durable write that fails
    const harness = await createReadyHarness()
    harness.store.failNext('conditionalPut')

    // #when a login arrives
    const created = await harness.session.create({githubUserId: OPERATOR_ID, login: LOGIN})

    // #then nothing exists in memory or in the store
    expect(created.outcome).toBe('write_failed')
    expect(harness.session.size()).toBe(0)
    expect([...harness.store.objects.keys()].filter(key => key.startsWith(SESSIONS_PREFIX))).toEqual([])
    expect(harness.hook).not.toHaveBeenCalled()
  })

  it('returns not_ready before load and writes nothing', async () => {
    // #given a store that has not loaded
    const harness = createHarness()

    // #when a login arrives
    const created = await harness.session.create({githubUserId: OPERATOR_ID, login: LOGIN})

    // #then it is refused without I/O
    expect(harness.session.isReady()).toBe(false)
    expect(created.outcome).toBe('not_ready')
    expect(harness.store.calls).toHaveLength(0)
  })
})

describe('revoke', () => {
  it('writes durably first, then revokes in memory and fires the hook once with the user ID', async () => {
    // #given a live session and an observer inside the durable write
    const harness = await createReadyHarness()
    const sessionId = await createSession(harness)
    const observed: {validDuringWrite?: boolean; hookCallsDuringWrite?: number} = {}
    harness.store.onBefore('conditionalPut', () => {
      observed.validDuringWrite = harness.session.get(sessionId) !== undefined
      observed.hookCallsDuringWrite = harness.hook.mock.calls.length
    })

    // #when it is revoked
    const result = await harness.session.revoke(sessionId)

    // #then the session was still valid and the hook silent during the write, and both flip after it
    expect(result).toEqual({outcome: 'ok'})
    expect(observed).toEqual({validDuringWrite: true, hookCallsDuringWrite: 0})
    expect(storedStatus(harness, sessionId)).toBe('revoked')
    expect(harness.session.get(sessionId)).toBeUndefined()
    expect(harness.hook).toHaveBeenCalledTimes(1)
    expect(harness.hook).toHaveBeenCalledWith(OPERATOR_ID)
  })

  it('lets an explicit logout win after a rotation: persists revoked, fires the hook once, then stays quiet', async () => {
    // #given a session that a same-user re-login has already rotated
    const harness = await createReadyHarness()
    const sessionId = await createSession(harness)
    await harness.session.revoke(sessionId, {rotate: true})
    const key = buildSessionKey(hashSessionId(sessionId))
    expect(JSON.parse(harness.store.objects.get(key)?.data ?? '{}')).toMatchObject({status: 'rotated'})
    expect(harness.hook).not.toHaveBeenCalled()
    harness.clock.now = NOW + 1000

    // #when the overlapping logout arrives, and then a second logout
    const logout = await harness.session.revoke(sessionId)
    const repeat = await harness.session.revoke(sessionId)

    // #then revoked is persisted with a fresh revokedAt and the hook fired exactly once
    expect(logout).toEqual({outcome: 'ok'})
    expect(repeat).toEqual({outcome: 'ok'})
    expect(JSON.parse(harness.store.objects.get(key)?.data ?? '{}')).toMatchObject({
      status: 'revoked',
      revokedAt: NOW + 1000,
    })
    expect(harness.hook.mock.calls).toEqual([[OPERATOR_ID]])
  })

  it('persists revoked and fires once when a rotation and a logout overlap, whichever commits first', async () => {
    // #given a session and slow object-store calls so the two revokes interleave
    const harness = await createReadyHarness()
    const sessionId = await createSession(harness)
    harness.store.setLatency('getObject', 5)

    // #when a rotation and a logout run together
    const [rotation, logout] = await Promise.all([
      harness.session.revoke(sessionId, {rotate: true}),
      harness.session.revoke(sessionId),
    ])

    // #then both succeed, the stored status is revoked, and the hook fired once
    expect(rotation).toEqual({outcome: 'ok'})
    expect(logout).toEqual({outcome: 'ok'})
    const stored: unknown = JSON.parse(
      harness.store.objects.get(buildSessionKey(hashSessionId(sessionId)))?.data ?? '{}',
    )
    expect(stored).toMatchObject({status: 'revoked'})
    expect(harness.hook).toHaveBeenCalledTimes(1)
    expect(harness.session.get(sessionId)).toBeUndefined()
  })

  it('does not let a rotation that lands after a logout downgrade it', async () => {
    // #given a revoked session
    const harness = await createReadyHarness()
    const sessionId = await createSession(harness)
    await harness.session.revoke(sessionId)
    const key = buildSessionKey(hashSessionId(sessionId))
    const before = harness.store.objects.get(key)?.data
    harness.store.resetCalls()

    // #when a rotation arrives for it
    const rotation = await harness.session.revoke(sessionId, {rotate: true})

    // #then nothing is written and the record is still revoked
    expect(rotation).toEqual({outcome: 'ok'})
    expect(harness.store.callCount('conditionalPut')).toBe(0)
    expect(harness.store.objects.get(key)?.data).toBe(before)
    expect(harness.hook).toHaveBeenCalledTimes(1)
  })

  it('keeps the session valid and fires nothing when the durable write fails', async () => {
    // #given a store whose every revoke write loses its race
    const harness = await createReadyHarness({casMaxAttempts: 3})
    const sessionId = await createSession(harness)
    harness.store.failNext('conditionalPut', {error: createPreconditionFailedError(), times: 10})

    // #when the session is revoked
    const result = await harness.session.revoke(sessionId)

    // #then the failure is reported, the session stays valid, and persist_failed carries the retry count
    expect(result).toEqual({outcome: 'persist_failed'})
    expect(harness.session.get(sessionId)).toBeDefined()
    expect(storedStatus(harness, sessionId)).toBe('active')
    expect(harness.hook).not.toHaveBeenCalled()
    expect(persistFailedAudits(harness)).toHaveLength(1)
    expect(persistFailedAudits(harness)[0]).toMatchObject({
      level: 'warn',
      message: 'audit: auth.revocation.persist_failed',
      context: {kind: 'auth.revocation.persist_failed', retries: 2, errorClass: 'precondition_failed'},
    })
  })

  it('reports persist_failed with zero retries for a store outage, and a retry then succeeds', async () => {
    // #given a store outage on the first revoke only
    const harness = await createReadyHarness()
    const sessionId = await createSession(harness)
    harness.store.failNext('conditionalPut')

    // #when the operator retries logout
    const first = await harness.session.revoke(sessionId)
    const second = await harness.session.revoke(sessionId)

    // #then the first fails with errorClass http_503 and the retry succeeds with one hook
    expect(first).toEqual({outcome: 'persist_failed'})
    expect(persistFailedAudits(harness)[0]?.context).toMatchObject({retries: 0, errorClass: 'http_503'})
    expect(second).toEqual({outcome: 'ok'})
    expect(harness.hook).toHaveBeenCalledTimes(1)
  })

  it('fires no second hook for a repeat revoke, sequential or concurrent', async () => {
    // #given a live session
    const harness = await createReadyHarness()
    const sessionId = await createSession(harness)

    // #when it is revoked twice at once and then again
    const concurrent = await Promise.all([harness.session.revoke(sessionId), harness.session.revoke(sessionId)])
    const repeat = await harness.session.revoke(sessionId)

    // #then every call succeeds and the hook fired once
    expect(concurrent).toEqual([{outcome: 'ok'}, {outcome: 'ok'}])
    expect(repeat).toEqual({outcome: 'ok'})
    expect(harness.hook).toHaveBeenCalledTimes(1)
  })

  it('revokes an ID that is not in memory by hash without a hook, and tolerates a 404', async () => {
    // #given a stale ID whose record exists, and an ID with no record
    const harness = await createReadyHarness()
    const staleId = 's'.repeat(43)
    plantRecord(harness, staleId)
    harness.store.resetCalls()

    // #when each is revoked
    const stale = await harness.session.revoke(staleId)
    const missing = await harness.session.revoke('m'.repeat(43))

    // #then the stale record is revoked by hash, the 404 counts as done, and no hook fires
    expect(stale).toEqual({outcome: 'ok'})
    expect(missing).toEqual({outcome: 'ok'})
    expect(storedStatus(harness, staleId)).toBe('revoked')
    expect(harness.store.calls.map(call => call.key)).toContain(buildSessionKey(hashSessionId(staleId)))
    expect(harness.hook).not.toHaveBeenCalled()
  })

  it('rotates the old session: writes the rotated status and fires no hook', async () => {
    // #given a live session
    const harness = await createReadyHarness()
    const sessionId = await createSession(harness)

    // #when it is rotated
    const result = await harness.session.revoke(sessionId, {rotate: true})

    // #then it is rejected afterwards, stored as rotated, and the hook stayed silent
    expect(result).toEqual({outcome: 'ok'})
    expect(harness.session.get(sessionId)).toBeUndefined()
    expect(storedStatus(harness, sessionId)).toBe('rotated')
    expect(harness.hook).not.toHaveBeenCalled()
  })

  it('keeps a rotation failure from disturbing the old session', async () => {
    // #given a rotation write that fails
    const harness = await createReadyHarness()
    const sessionId = await createSession(harness)
    harness.store.failNext('conditionalPut')

    // #when it is rotated
    const result = await harness.session.revoke(sessionId, {rotate: true})

    // #then the old session stays valid and no hook fires
    expect(result).toEqual({outcome: 'persist_failed'})
    expect(harness.session.get(sessionId)).toBeDefined()
    expect(harness.hook).not.toHaveBeenCalled()
  })

  it('does not undo a successful revoke when the hook throws', async () => {
    // #given a hook that throws
    const hook = vi.fn<(githubUserId: number) => void>(() => {
      throw new Error('push relay down')
    })
    const harness = await createReadyHarness({hook})
    const sessionId = await createSession(harness)

    // #when the session is revoked
    const result = await harness.session.revoke(sessionId)

    // #then the revoke stands, in memory and in the store, and the failure is logged without detail
    expect(result).toEqual({outcome: 'ok'})
    expect(harness.session.get(sessionId)).toBeUndefined()
    expect(storedStatus(harness, sessionId)).toBe('revoked')
    expect(harness.logs.some(log => log.level === 'warn' && log.context.errorClass === 'hook_threw')).toBe(true)
  })
})

describe('scavenge and sweep', () => {
  it('drops expired and revoked entries, never calls the adapter and fires no hook', async () => {
    // #given an expired, a revoked and a live entry
    const harness = await createReadyHarness()
    const expired = await createSession(harness)
    harness.clock.now = NOW + 5 * DAY_MS
    const revoked = await createSession(harness)
    const live = await createSession(harness)
    await harness.session.revoke(revoked)
    harness.hook.mockClear()
    harness.clock.now = NOW + TTL_MS + 1
    harness.store.resetCalls()

    // #when the map is scavenged
    const removed = harness.session.scavenge()

    // #then dead entries go, the adapter is untouched and TTL expiry fires nothing
    expect(removed).toBe(2)
    expect(harness.session.size()).toBe(1)
    expect(harness.session.get(live)).toBeDefined()
    expect(harness.session.get(expired)).toBeUndefined()
    expect(harness.store.calls).toHaveLength(0)
    expect(harness.hook).not.toHaveBeenCalled()
  })

  it('delegates the bucket sweep, deleting expired records and keeping live ones', async () => {
    // #given an expired record and a live one in the store
    const harness = await createReadyHarness()
    plantRecord(harness, 'old'.repeat(15), {issuedAt: NOW - TTL_MS - 1})
    const live = await createSession(harness)

    // #when the sweep runs
    const swept = await harness.session.sweep()

    // #then only the expired record is deleted
    expect(swept.success && swept.data).toMatchObject({deleted: 1, kept: 1})
    expect(storedStatus(harness, live)).toBe('active')
  })

  it('reports a sweep failure without throwing', async () => {
    // #given a failing list
    const harness = await createReadyHarness()
    harness.store.failNext('list')

    // #when the sweep runs
    const swept = await harness.session.sweep()

    // #then the failure is returned and logged by class
    expect(swept.success).toBe(false)
    expect(harness.logs.some(log => log.level === 'warn' && log.message === 'session sweep failed')).toBe(true)
  })
})

describe('load policy', () => {
  it('drops expired, revoked, non-allowlisted, MAC-failing and future-dated records and revokes non-allowlisted ones', async () => {
    // #given one live record and one of each droppable kind
    const harness = createHarness()
    plantRecord(harness, 'live-session'.padEnd(43, 'a'))
    plantRecord(harness, 'expired-session'.padEnd(43, 'a'), {issuedAt: NOW - TTL_MS - 1})
    plantRecord(harness, 'revoked-session'.padEnd(43, 'a'), {status: 'revoked'})
    plantRecord(harness, 'stranger-session'.padEnd(43, 'a'), {githubUserId: OTHER_ID})
    plantRecord(harness, 'badmac-session'.padEnd(43, 'a'), {macKey: deriveSessionRecordKey(Buffer.alloc(32, 3))})
    plantRecord(harness, 'future-session'.padEnd(43, 'a'), {issuedAt: NOW + DAY_MS})

    // #when the store loads
    const loaded = await harness.session.load()

    // #then only the live record is restored and the counts reflect each drop
    expect(loaded.success && loaded.data).toMatchObject({
      loaded: 1,
      expired: 1,
      revoked: 1,
      notAllowlisted: 1,
      unsigned: 1,
      futureDated: 1,
      overCap: 0,
      readFailed: 0,
      revokeFailed: 0,
    })
    expect(harness.session.isReady()).toBe(true)
    expect(harness.session.size()).toBe(1)
    expect(harness.session.get('live-session'.padEnd(43, 'a'))).toBeDefined()
    expect(harness.session.get('stranger-session'.padEnd(43, 'a'))).toBeUndefined()
    expect(storedStatus(harness, 'stranger-session'.padEnd(43, 'a'))).toBe('revoked')
    expect(storedStatus(harness, 'revoked-session'.padEnd(43, 'a'))).toBe('revoked')
  })

  it('keeps the newest sessions over the cap and durably revokes the rest', async () => {
    // #given four live records and a cap of two
    const harness = createHarness({maxEntries: 2})
    const ids = ['oldest', 'older', 'newer', 'newest'].map(name => name.padEnd(43, 'a'))
    ids.forEach((id, index) => {
      plantRecord(harness, id, {issuedAt: NOW - (ids.length - index) * 1000})
    })

    // #when the store loads
    const loaded = await harness.session.load()

    // #then the newest two are live and the others are revoked in the store
    expect(loaded.success && loaded.data).toMatchObject({loaded: 2, overCap: 2})
    expect(harness.session.get(ids[3] ?? '')).toBeDefined()
    expect(harness.session.get(ids[2] ?? '')).toBeDefined()
    expect(harness.session.get(ids[1] ?? '')).toBeUndefined()
    expect(harness.session.get(ids[0] ?? '')).toBeUndefined()
    expect(storedStatus(harness, ids[0] ?? '')).toBe('revoked')
    expect(storedStatus(harness, ids[1] ?? '')).toBe('revoked')
    expect(storedStatus(harness, ids[3] ?? '')).toBe('active')
    expect(harness.hook).not.toHaveBeenCalled()
  })

  it('counts a failed durable revoke at load and still drops the record from memory', async () => {
    // #given a non-allowlisted record whose revoke write fails
    const harness = createHarness()
    const stranger = 'stranger'.padEnd(43, 'a')
    plantRecord(harness, stranger, {githubUserId: OTHER_ID})
    harness.store.failNext('conditionalPut', {match: key => key.startsWith(SESSIONS_PREFIX)})

    // #when the store loads
    const loaded = await harness.session.load()

    // #then the load succeeds, the record is not live, and the failure is counted
    expect(loaded.success && loaded.data).toMatchObject({notAllowlisted: 1, revokeFailed: 1, loaded: 0})
    expect(harness.session.get(stranger)).toBeUndefined()
    expect(storedStatus(harness, stranger)).toBe('active')
  })

  it('rejects a record planted at an attacker-chosen ID with the operator ID and no valid MAC', async () => {
    // #given a well-shaped record at a chosen ID with a forged MAC
    const harness = createHarness()
    const attackerId = 'attacker'.padEnd(43, 'a')
    harness.store.seed(
      buildSessionKey(hashSessionId(attackerId)),
      JSON.stringify({githubUserId: OPERATOR_ID, login: LOGIN, issuedAt: NOW, status: 'active', mac: 'forged'}),
    )

    // #when the store loads
    const loaded = await harness.session.load()

    // #then it is rejected and the ID is not accepted
    expect(loaded.success && loaded.data).toMatchObject({loaded: 0, unsigned: 1})
    expect(harness.session.get(attackerId)).toBeUndefined()
  })

  it('emits a ready restore audit with counts only, and an info log', async () => {
    // #given a store holding one live record
    const harness = createHarness()
    plantRecord(harness, 'live'.padEnd(43, 'a'))

    // #when it loads
    await harness.session.load()

    // #then the audit carries the counts and no identifying field
    expect(harness.audits).toHaveLength(1)
    expect(harness.audits[0]).toMatchObject({
      level: 'info',
      context: {kind: 'auth.session.restore', outcome: 'ready', counts: {loaded: 1}},
    })
    expect(Object.keys(harness.audits[0]?.context ?? {}).sort()).toEqual(['correlationId', 'counts', 'kind', 'outcome'])
  })
})

describe('load failures', () => {
  const cases = [
    {
      name: 'a self-test failure',
      phase: 'self_test',
      arrange: (harness: Harness) => {
        harness.store.failNext('conditionalPut', {match: key => key.startsWith('operator-web/_self-test/')})
      },
    },
    {
      name: 'a list failure',
      phase: 'load',
      arrange: (harness: Harness) => {
        harness.store.failNext('list', {match: prefix => prefix === SESSIONS_PREFIX})
      },
    },
    {
      name: 'a load timeout',
      phase: 'load',
      arrange: (harness: Harness) => {
        for (let index = 0; index < 20; index++) {
          plantRecord(harness, `slow${index}`.padEnd(43, 'a'))
        }
        harness.store.setLatency('getObject', 30)
      },
      options: {scanTimeoutMs: 40, scanConcurrency: 2},
    },
  ] as const

  it.each(cases)('$name leaves the store not ready', async testCase => {
    // #given a store holding a live record and the failure
    const harness = createHarness('options' in testCase ? testCase.options : {})
    const liveId = 'live'.padEnd(43, 'a')
    plantRecord(harness, liveId)
    testCase.arrange(harness)

    // #when the store loads
    const loaded = await harness.session.load()

    // #then the load fails with the phase, nothing is restored, create refuses, and the error is logged and audited
    expect(loaded.success).toBe(false)
    expect(loaded.success === false && loaded.error.phase).toBe(testCase.phase)
    expect(harness.session.isReady()).toBe(false)
    expect(harness.session.get(liveId)).toBeUndefined()
    expect((await harness.session.create({githubUserId: OPERATOR_ID, login: LOGIN})).outcome).toBe('not_ready')
    expect(harness.logs.some(log => log.level === 'error')).toBe(true)
    expect(harness.audits).toHaveLength(1)
    expect(harness.audits[0]).toMatchObject({
      level: 'warn',
      context: {kind: 'auth.session.restore', outcome: 'failed', phase: testCase.phase},
    })
  })

  it('leaves no restored entry behind when a later phase fails', async () => {
    // #given a store whose list fails after a successful self-test
    const harness = createHarness()
    plantRecord(harness, 'live'.padEnd(43, 'a'))
    harness.store.failNext('list', {match: prefix => prefix === SESSIONS_PREFIX})

    // #when it loads
    await harness.session.load()

    // #then the map stays empty
    expect(harness.session.size()).toBe(0)
  })
})

describe('restart integration', () => {
  it('restores a live session after a restart and keeps a revoked one rejected', async () => {
    // #given store A with one live and one revoked session
    const store = createTestObjectStore()
    const clock = {now: NOW}
    const a = await createReadyHarness({store, clock})
    const liveId = await createSession(a)
    const revokedId = await createSession(a)
    await a.session.revoke(revokedId)

    // #when a fresh store B loads from the same fake
    const b = createHarness({store, clock})
    const loaded = await b.session.load()

    // #then the live ID is accepted and the revoked ID stays rejected
    expect(loaded.success && loaded.data).toMatchObject({loaded: 1, revoked: 1})
    expect(b.session.get(liveId)).toEqual({githubUserId: OPERATOR_ID, login: LOGIN, issuedAt: NOW})
    expect(b.session.get(revokedId)).toBeUndefined()
  })

  it('fires the same hook for a restored session as for one created before the restart', async () => {
    // #given a restored session and one hook shared with the pre-restart store
    const store = createTestObjectStore()
    const hook = vi.fn<(githubUserId: number) => void>()
    const a = await createReadyHarness({store, hook})
    const liveId = await createSession(a)
    const b = await createReadyHarness({store, hook})

    // #when the restored session is revoked
    const result = await b.session.revoke(liveId)

    // #then the hook fires once with the user ID
    expect(result).toEqual({outcome: 'ok'})
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledWith(OPERATOR_ID)
    expect(b.session.get(liveId)).toBeUndefined()
  })

  it('does not resurrect a session whose revoke was durable after a restart', async () => {
    // #given a session revoked before the restart
    const store = createTestObjectStore()
    const a = await createReadyHarness({store})
    const id = await createSession(a)
    await a.session.revoke(id)

    // #when two further restarts load the store
    const b = await createReadyHarness({store})
    const c = await createReadyHarness({store})

    // #then it never returns
    expect(b.session.get(id)).toBeUndefined()
    expect(c.session.get(id)).toBeUndefined()
  })
})

describe('push replay', () => {
  it('re-runs a failed deactivation at the next load and deactivates the subscription', async () => {
    // #given an operator with an active push subscription, and a deactivation that fails when logout fires it
    const store = createTestObjectStore()
    const pushStore = createOperatorPushSubscriptionStore({
      adapter: store.adapter,
      logger: {debug: () => {}, warn: () => {}},
      clock: () => NOW,
    })
    const deactivations: boolean[] = []
    const hook = (githubUserId: number): void => {
      pushStore
        .deactivateForOperator({operatorId: String(githubUserId)})
        .then(result => deactivations.push(result.success))
        .catch(() => deactivations.push(false))
    }
    const a = await createReadyHarness({store, hook})
    const sessionId = await createSession(a)
    await pushStore.subscribe({
      operatorId: String(OPERATOR_ID),
      endpoint: 'https://push.example.test/endpoint-1',
      p256dh: 'p256dh',
      auth: 'auth',
      keyVersion: 'v1',
    })
    store.failNext('conditionalPut', {match: key => key.startsWith('operator-push/')})

    // #when logout fires the failing deactivation, and the gateway restarts
    await a.session.revoke(sessionId)
    await settle()
    const activeAfterLogout = await pushStore.getActiveRecordsForOperator({operatorId: String(OPERATOR_ID)})
    const b = createHarness({store, hook})
    await b.session.load()
    await settle()
    const activeAfterRestart = await pushStore.getActiveRecordsForOperator({operatorId: String(OPERATOR_ID)})

    // #then the first deactivation failed, and the load replayed it
    expect(deactivations).toEqual([false, true])
    expect(activeAfterLogout.success && activeAfterLogout.data).toHaveLength(1)
    expect(activeAfterRestart.success && activeAfterRestart.data).toHaveLength(0)
  })

  it('replays a late-session logout after issuedAt plus 7 days but not after revokedAt plus 7 days', async () => {
    // #given a session logged out on day 6, whose deactivation (the hook) ran once and is assumed to have failed
    const store = createTestObjectStore()
    const clock = {now: NOW}
    const a = await createReadyHarness({store, clock})
    const sessionId = await createSession(a)
    clock.now = NOW + 6 * DAY_MS
    await a.session.revoke(sessionId)
    expect(a.hook).toHaveBeenCalledTimes(1)

    // #when the gateway restarts after the session's own 7 days, but within 7 days of the logout
    clock.now = NOW + 7 * DAY_MS + 1000
    const within = createHarness({store, clock})
    const loadedWithin = await within.session.load()

    // #then the deactivation is replayed even though the login lifetime has ended
    expect(loadedWithin.success && loadedWithin.data.replayedUsers).toBe(1)
    expect(within.hook.mock.calls).toEqual([[OPERATOR_ID, {replayFenceMs: NOW + 7 * DAY_MS + 1000}]])
    expect(within.session.get(sessionId)).toBeUndefined()

    // #when the gateway restarts after revokedAt plus 7 days
    clock.now = NOW + 6 * DAY_MS + TTL_MS + 1000
    const after = createHarness({store, clock})
    const loadedAfter = await after.session.load()

    // #then the record is expired and nothing is replayed
    expect(loadedAfter.success && loadedAfter.data.replayedUsers).toBe(0)
    expect(after.hook).not.toHaveBeenCalled()
  })

  it('stops replay at issuedAt plus 2 x TTL even when revokedAt claims a time a year ahead', async () => {
    // #given a revoked record whose revokedAt came from a clock that stepped a year forward
    const store = createTestObjectStore()
    const clock = {now: NOW}
    const seed = createHarness({store, clock})
    plantRecord(seed, 'skewed'.padEnd(43, 'a'), {status: 'revoked', revokedAt: NOW + 365 * DAY_MS})

    // #when the gateway restarts just inside, and then at, issuedAt plus 2 x TTL
    clock.now = NOW + 2 * TTL_MS - 1
    const inside = createHarness({store, clock})
    const loadedInside = await inside.session.load()
    clock.now = NOW + 2 * TTL_MS
    const at = createHarness({store, clock})
    const loadedAt = await at.session.load()

    // #then the deactivation is replayed inside the bound and not at it
    expect(loadedInside.success && loadedInside.data.replayedUsers).toBe(1)
    expect(loadedAt.success && loadedAt.data.replayedUsers).toBe(0)
    expect(at.hook).not.toHaveBeenCalled()
  })

  it('does not deactivate a subscription refreshed while a startup replay was stalled', async () => {
    // #given an operator with two subscriptions whose logout deactivation failed, leaving both active
    const store = createTestObjectStore()
    const clock = {now: NOW}
    const pushStore = createOperatorPushSubscriptionStore({
      adapter: store.adapter,
      logger: {debug: () => {}, warn: () => {}},
      clock: () => clock.now,
    })
    // the production hook: live revokes pass no fence, a replay passes the fence it was given
    const hook = (githubUserId: number, context?: SessionRevokedContext): void => {
      pushStore
        .deactivateForOperator({
          operatorId: String(githubUserId),
          ...(context === undefined ? {} : {updatedBefore: context.replayFenceMs}),
        })
        .catch(() => undefined)
    }
    const subscribe = async (endpoint: string) =>
      pushStore.subscribe({operatorId: String(OPERATOR_ID), endpoint, p256dh: 'p256dh', auth: 'auth', keyVersion: 'v1'})
    const refreshed = 'https://push.example.test/endpoint-refreshed'
    const stale = 'https://push.example.test/endpoint-stale'
    const a = await createReadyHarness({store, clock, hook})
    const sessionId = await createSession(a)
    await subscribe(refreshed)
    await subscribe(stale)
    store.failNext('conditionalPut', {match: key => key.startsWith('operator-push/')})
    await a.session.revoke(sessionId)
    await settle()

    // #when the gateway restarts and the replay stalls before its first read of the refreshed record
    clock.now = NOW + 60_000
    const refreshedKey = [...store.objects.entries()].find(([key, value]) => {
      return key.startsWith('operator-push/subscriptions/') && value.data.includes('endpoint-refreshed')
    })?.[0]
    let releaseReplay!: () => void
    const stalled = new Promise<void>(resolve => {
      releaseReplay = resolve
    })
    store.onBefore('getObject', async key => {
      if (key === refreshedKey) {
        store.onBefore('getObject', undefined)
        await stalled
      }
    })
    const b = createHarness({store, clock, hook})
    await b.session.load()
    await settle()

    // #and the operator signs in again and resubscribes that device while the replay is stalled
    clock.now = NOW + 61_000
    await subscribe(refreshed)
    releaseReplay()
    await settle()
    await new Promise<void>(resolve => setTimeout(resolve, 20))

    // #then the replay deactivated the old record and left the refreshed one active
    const active = await pushStore.getActiveRecordsForOperator({operatorId: String(OPERATOR_ID)})
    expect(active.success && active.data.map(record => record.endpoint)).toEqual([refreshed])
  })

  it('stamps revokedAt on a rotation and still skips it at replay', async () => {
    // #given a session rotated late in its life
    const store = createTestObjectStore()
    const clock = {now: NOW}
    const a = await createReadyHarness({store, clock})
    const sessionId = await createSession(a)
    clock.now = NOW + 6 * DAY_MS
    await a.session.revoke(sessionId, {rotate: true})

    // #when the gateway restarts past the session's own expiry
    clock.now = NOW + 7 * DAY_MS + 1000
    const b = createHarness({store, clock})
    const loaded = await b.session.load()

    // #then the rotated record is kept for the window but never replayed
    expect(loaded.success && loaded.data.replayedUsers).toBe(0)
    expect(b.hook).not.toHaveBeenCalled()
  })

  it('skips rotated records', async () => {
    // #given a rotated record for a user with no live session
    const harness = createHarness()
    plantRecord(harness, 'rotated'.padEnd(43, 'a'), {status: 'rotated'})

    // #when the store loads
    const loaded = await harness.session.load()

    // #then no deactivation is replayed
    expect(loaded.success && loaded.data.replayedUsers).toBe(0)
    expect(harness.hook).not.toHaveBeenCalled()
  })

  it('skips a user who has a live restored session', async () => {
    // #given a revoked record and a live record for the same user, and a revoked record for another user
    const harness = createHarness({allowed: [OPERATOR_ID, OTHER_ID]})
    plantRecord(harness, 'revoked'.padEnd(43, 'a'), {status: 'revoked'})
    plantRecord(harness, 'live'.padEnd(43, 'a'))
    plantRecord(harness, 'other'.padEnd(43, 'a'), {status: 'revoked', githubUserId: OTHER_ID})

    // #when the store loads
    await harness.session.load()

    // #then only the user without a live session is replayed
    expect(harness.hook.mock.calls).toEqual([[OTHER_ID, {replayFenceMs: NOW}]])
  })

  it('runs once per user when several revoked records exist', async () => {
    // #given three revoked records for one user and one for another
    const harness = createHarness({allowed: [OPERATOR_ID, OTHER_ID]})
    for (const name of ['r1', 'r2', 'r3']) {
      plantRecord(harness, name.padEnd(43, 'a'), {status: 'revoked'})
    }
    plantRecord(harness, 'r4'.padEnd(43, 'a'), {status: 'revoked', githubUserId: OTHER_ID})

    // #when the store loads
    const loaded = await harness.session.load()

    // #then each user is replayed exactly once
    expect(loaded.success && loaded.data.replayedUsers).toBe(2)
    expect(harness.hook).toHaveBeenCalledTimes(2)
    expect(harness.hook.mock.calls.map(call => call[0]).sort((a, b) => a - b)).toEqual([OTHER_ID, OPERATOR_ID])
  })

  it('skips an expired revoked record and replays a non-allowlisted record it just revoked', async () => {
    // #given an expired revoked record, and an active record for a user who left the allowlist
    const harness = createHarness()
    plantRecord(harness, 'expired'.padEnd(43, 'a'), {status: 'revoked', issuedAt: NOW - TTL_MS - 1})
    plantRecord(harness, 'stranger'.padEnd(43, 'a'), {githubUserId: OTHER_ID})

    // #when the store loads
    await harness.session.load()

    // #then only the user whose record was revoked at load is replayed
    expect(harness.hook.mock.calls).toEqual([[OTHER_ID, {replayFenceMs: NOW}]])
  })

  it('does not replay a user whose load-time revoke could not be written', async () => {
    // #given a non-allowlisted record whose revoke write fails
    const harness = createHarness()
    plantRecord(harness, 'stranger'.padEnd(43, 'a'), {githubUserId: OTHER_ID})
    harness.store.failNext('conditionalPut', {match: key => key.startsWith(SESSIONS_PREFIX)})

    // #when the store loads
    await harness.session.load()

    // #then nothing is replayed for a record that is still active in the store
    expect(harness.hook).not.toHaveBeenCalled()
  })
})

describe('log and audit hygiene', () => {
  it('never emits a session ID, key hash, login or token pattern', async () => {
    // #given a full lifecycle that includes failures and a load failure
    const store = createTestObjectStore()
    const a = await createReadyHarness({store, casMaxAttempts: 2})
    const ids = [await createSession(a), await createSession(a), await createSession(a)]
    plantRecord(a, 'attacker'.padEnd(43, 'a'), {macKey: deriveSessionRecordKey(Buffer.alloc(32, 5))})
    store.failNext('conditionalPut', {error: createPreconditionFailedError(), times: 5})
    await a.session.revoke(ids[0] ?? '')
    await a.session.revoke(ids[1] ?? '', {rotate: true})
    await a.session.sweep()
    store.failNext('list', {match: prefix => prefix === SESSIONS_PREFIX})
    const failed = createHarness({store})
    await failed.session.load()
    const b = createHarness({store})
    await b.session.load()

    // #when every emitted log context, message and audit record is serialized
    const emitted = JSON.stringify([a, failed, b].flatMap(harness => [...harness.logs, ...harness.audits]))

    // #then no 43-character base64url ID, 64-character hex hash, login or token pattern appears
    expect(ids.every(id => /^[\w-]{43}$/.test(id))).toBe(true)
    expect(emitted).not.toMatch(/[\w-]{43}/)
    expect(emitted).not.toMatch(/[0-9a-f]{64}/)
    expect(emitted).not.toContain(LOGIN)
    expect(emitted).not.toMatch(/gh[pousr]_|github_pat_|Bearer /i)
    expect(emitted).not.toContain('operator-web')
    for (const id of ids) {
      expect(emitted).not.toContain(id)
      expect(emitted).not.toContain(hashSessionId(id))
    }
    expect(a.logs.length + a.audits.length).toBeGreaterThan(0)
  })
})
