import type {ObjectStoreAdapter, Result} from '@fro-bot/runtime'
import type {SessionPersistenceError, SessionRecordStatus} from './session-persistence.js'
import type {TestObjectStoreMethod, TestObjectStoreOptions} from './test-object-store.js'

import {Buffer} from 'node:buffer'
import {createObjectStoreOperationError, err, ok} from '@fro-bot/runtime'
import {describe, expect, it} from 'vitest'
import {
  buildSessionKey,
  createSessionPersistence,
  deriveSessionRecordKey,
  hashSessionId,
  SESSION_KEY_PREFIX,
  SESSION_RECORD_MAC_LABEL,
  signSessionRecord,
} from './session-persistence.js'
import {createPreconditionFailedError, createTestObjectStore} from './test-object-store.js'

const NOW = 1_800_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000
const TTL_MS = 7 * DAY_MS
const SKEW_MS = 5 * 60 * 1000
const CSRF_SECRET = Buffer.alloc(32, 7)
const MAC_KEY = deriveSessionRecordKey(CSRF_SECRET)
const OPERATOR_ID = 4242
const RAW_SESSION_ID = 'raw-session-id-should-never-be-logged'

interface LogEntry {
  readonly level: string
  readonly context: Record<string, unknown>
  readonly message: string
}

interface Harness {
  readonly store: ReturnType<typeof createTestObjectStore>
  readonly persistence: ReturnType<typeof createSessionPersistence>
  readonly logs: LogEntry[]
  readonly setNow: (value: number) => void
}

interface HarnessOptions {
  readonly store?: TestObjectStoreOptions
  readonly adapter?: (base: ObjectStoreAdapter) => ObjectStoreAdapter
  readonly macKey?: Uint8Array
  readonly operationTimeoutMs?: number
  readonly scanConcurrency?: number
  readonly scanTimeoutMs?: number
  readonly scanMaxKeys?: number
  readonly casMaxAttempts?: number
}

function createHarness(options: HarnessOptions = {}): Harness {
  const store = createTestObjectStore(options.store)
  const logs: LogEntry[] = []
  let now = NOW
  const record =
    (level: string) =>
    (context: Record<string, unknown>, message: string): void => {
      logs.push({level, context, message})
    }
  const persistence = createSessionPersistence({
    adapter: options.adapter === undefined ? store.adapter : options.adapter(store.adapter),
    logger: {debug: record('debug'), info: record('info'), warn: record('warn')},
    clock: () => now,
    macKey: options.macKey ?? MAC_KEY,
    absoluteTtlMs: TTL_MS,
    ...(options.operationTimeoutMs === undefined ? {} : {operationTimeoutMs: options.operationTimeoutMs}),
    ...(options.scanConcurrency === undefined ? {} : {scanConcurrency: options.scanConcurrency}),
    ...(options.scanTimeoutMs === undefined ? {} : {scanTimeoutMs: options.scanTimeoutMs}),
    ...(options.scanMaxKeys === undefined ? {} : {scanMaxKeys: options.scanMaxKeys}),
    ...(options.casMaxAttempts === undefined ? {} : {casMaxAttempts: options.casMaxAttempts}),
  })
  return {
    store,
    persistence,
    logs,
    setNow: value => {
      now = value
    },
  }
}

function plant(
  harness: Harness,
  keyHash: string,
  fields: {readonly issuedAt: number; readonly status?: SessionRecordStatus; readonly githubUserId?: number},
  macKey: Uint8Array = MAC_KEY,
): string {
  const record = signSessionRecord(macKey, keyHash, {
    githubUserId: fields.githubUserId ?? OPERATOR_ID,
    login: 'operator',
    issuedAt: fields.issuedAt,
    status: fields.status ?? 'active',
  })
  return harness.store.seed(buildSessionKey(keyHash), JSON.stringify(record))
}

function plantedHash(label: string): string {
  return hashSessionId(`planted-${label}`)
}

function errorOf(result: Result<unknown, SessionPersistenceError>): SessionPersistenceError {
  if (result.success) {
    throw new Error('expected a failure result')
  }
  return result.error
}

describe('key builder and MAC key derivation', () => {
  it('builds a hex hash key under the prefix that never contains the raw session ID', () => {
    // #given a raw session ID
    // #when the key is built
    const keyHash = hashSessionId(RAW_SESSION_ID)
    const key = buildSessionKey(keyHash)

    // #then it is a 64-character hex hash under the prefix, without the raw ID
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(key).toBe(`${SESSION_KEY_PREFIX}/${keyHash}.json`)
    expect(key.startsWith('operator-web/sessions/')).toBe(true)
    expect(key).not.toContain(RAW_SESSION_ID)
  })

  it('derives a MAC key that differs from the secret and from a key under another label', () => {
    // #given CSRF secret bytes
    // #when keys are derived under the record label and a different label
    const derived = deriveSessionRecordKey(CSRF_SECRET)
    const other = deriveSessionRecordKey(CSRF_SECRET, 'fro-bot/some-other-label/v1')

    // #then the record key is stable, is not the secret, and differs per label
    expect(SESSION_RECORD_MAC_LABEL).toBe('fro-bot/operator-session-record/v1')
    expect(derived.equals(deriveSessionRecordKey(CSRF_SECRET))).toBe(true)
    expect(derived.equals(CSRF_SECRET)).toBe(false)
    expect(derived.equals(other)).toBe(false)
    expect(derived).toHaveLength(32)
  })
})

describe('create', () => {
  it('writes one signed record and reports a conflict for a second create of the same ID', async () => {
    // #given a store with no records
    const {store, persistence} = createHarness()
    const input = {sessionId: RAW_SESSION_ID, githubUserId: OPERATOR_ID, login: 'operator', issuedAt: NOW}

    // #when the same session is created twice
    const first = await persistence.create(input)
    const second = await persistence.create(input)

    // #then the first writes once and the second conflicts without overwriting
    expect(first.success).toBe(true)
    expect(errorOf(second).kind).toBe('conflict')
    expect(store.callCount('conditionalPut')).toBe(2)
    expect(store.objects.size).toBe(1)
    const [key] = [...store.objects.keys()]
    expect(key).toBe(buildSessionKey(hashSessionId(RAW_SESSION_ID)))
    const stored = JSON.parse(store.objects.get(key ?? '')?.data ?? '{}') as Record<string, unknown>
    expect(Object.keys(stored).sort()).toEqual(['githubUserId', 'issuedAt', 'login', 'mac', 'status'])
    expect(stored.status).toBe('active')
  })

  it('reports a store error with a coarse class when the write fails', async () => {
    // #given a write that fails with an error whose message names the session
    const {store, persistence} = createHarness()
    store.failNext('conditionalPut', {error: new Error(`boom ${RAW_SESSION_ID}`)})

    // #when create runs
    const result = await persistence.create({
      sessionId: RAW_SESSION_ID,
      githubUserId: OPERATOR_ID,
      login: 'operator',
      issuedAt: NOW,
    })

    // #then the typed error carries the class and drops the adapter message
    const error = errorOf(result)
    expect(error.kind).toBe('store_error')
    expect(error.message).not.toContain(RAW_SESSION_ID)
    expect(error.message).not.toContain('boom')
  })
})

describe('revoke', () => {
  it('re-signs the record as revoked or rotated and load verifies both', async () => {
    // #given two active sessions
    const {persistence} = createHarness()
    for (const id of ['a', 'b']) {
      await persistence.create({sessionId: id, githubUserId: OPERATOR_ID, login: 'operator', issuedAt: NOW})
    }

    // #when one is revoked and one is rotated
    const revoked = await persistence.revoke(hashSessionId('a'), 'revoked')
    const rotated = await persistence.revoke(hashSessionId('b'), 'rotated')
    const loaded = await persistence.load()

    // #then both writes succeed and load returns the verified statuses
    expect(revoked).toEqual(ok('written'))
    expect(rotated).toEqual(ok('written'))
    expect(loaded.success && loaded.data.counts.macFailed).toBe(0)
    const statuses = new Map((loaded.success ? loaded.data.sessions : []).map(s => [s.keyHash, s.status]))
    expect(statuses.get(hashSessionId('a'))).toBe('revoked')
    expect(statuses.get(hashSessionId('b'))).toBe('rotated')
  })

  it('writes nothing for an already-revoked record and succeeds', async () => {
    // #given a revoked record
    const harness = createHarness()
    plant(harness, plantedHash('r'), {issuedAt: NOW, status: 'revoked'})
    harness.store.resetCalls()

    // #when it is revoked again
    const result = await harness.persistence.revoke(plantedHash('r'), 'revoked')

    // #then it succeeds as already done with no write
    expect(result).toEqual(ok('already'))
    expect(harness.store.callCount('conditionalPut')).toBe(0)
  })

  it('treats a missing record as done', async () => {
    // #given no record for the hash
    const {persistence} = createHarness()

    // #when revoke runs
    const result = await persistence.revoke(hashSessionId('missing'), 'revoked')

    // #then it reports absent
    expect(result).toEqual(ok('absent'))
  })

  it('treats a record that disappears between read and write as done', async () => {
    // #given an active record that is deleted after the revoke reads it
    const harness = createHarness()
    plant(harness, plantedHash('gone'), {issuedAt: NOW})
    harness.store.onBefore('conditionalPut', key => {
      harness.store.remove(key)
    })

    // #when revoke writes against the vanished key
    const result = await harness.persistence.revoke(plantedHash('gone'), 'revoked')

    // #then the 404 counts as done
    expect(result).toEqual(ok('absent'))
  })

  it('does not rewrite an unsigned record', async () => {
    // #given a well-shaped record with a bad MAC
    const harness = createHarness()
    harness.store.seed(
      buildSessionKey(plantedHash('bad')),
      JSON.stringify({githubUserId: OPERATOR_ID, login: 'operator', issuedAt: NOW, status: 'active', mac: 'nope'}),
    )
    harness.store.resetCalls()

    // #when it is revoked
    const result = await harness.persistence.revoke(plantedHash('bad'), 'revoked')

    // #then nothing is written, because load drops it anyway
    expect(result).toEqual(ok('invalid'))
    expect(harness.store.callCount('conditionalPut')).toBe(0)
  })

  it('re-reads after a 412 and succeeds on retry', async () => {
    // #given an active record and one lost race
    const harness = createHarness()
    plant(harness, plantedHash('race'), {issuedAt: NOW})
    harness.store.failNext('conditionalPut', {error: createPreconditionFailedError()})

    // #when revoke runs
    const result = await harness.persistence.revoke(plantedHash('race'), 'revoked')

    // #then it re-read and wrote on the second attempt
    expect(result).toEqual(ok('written'))
    expect(harness.store.callCount('getObject')).toBe(2)
  })

  it('reports already when a concurrent revoke wins the race', async () => {
    // #given a concurrent writer that revokes the record between this revoke's read and write
    const harness = createHarness()
    plant(harness, plantedHash('dup'), {issuedAt: NOW})
    harness.store.onBefore('conditionalPut', key => {
      harness.store.onBefore('conditionalPut', undefined)
      plant(harness, plantedHash('dup'), {issuedAt: NOW, status: 'revoked'})
      expect(key).toBe(buildSessionKey(plantedHash('dup')))
    })

    // #when revoke runs
    const result = await harness.persistence.revoke(plantedHash('dup'), 'revoked')

    // #then the retry sees the revoked record and writes nothing more
    expect(result).toEqual(ok('already'))
  })

  it('reports failure once the retry budget is spent', async () => {
    // #given a record whose every write loses its race
    const harness = createHarness({casMaxAttempts: 3})
    plant(harness, plantedHash('hot'), {issuedAt: NOW})
    harness.store.failNext('conditionalPut', {error: createPreconditionFailedError(), times: 10})

    // #when revoke runs
    const result = await harness.persistence.revoke(plantedHash('hot'), 'revoked')

    // #then it fails with cas_exhausted after the bounded attempts and the record stays active
    expect(errorOf(result).kind).toBe('cas_exhausted')
    expect(errorOf(result).retries).toBe(2)
    expect(harness.store.callCount('conditionalPut')).toBe(3)
    const stored = JSON.parse(harness.store.objects.get(buildSessionKey(plantedHash('hot')))?.data ?? '{}') as {
      status?: string
    }
    expect(stored.status).toBe('active')
  })

  it('reports a timeout when the adapter hangs', async () => {
    // #given a getObject slower than the per-call timeout
    const harness = createHarness({operationTimeoutMs: 20})
    plant(harness, plantedHash('slow'), {issuedAt: NOW})
    harness.store.setLatency('getObject', 200)

    // #when revoke runs
    const result = await harness.persistence.revoke(plantedHash('slow'), 'revoked')

    // #then it fails with a timeout rather than hanging
    expect(errorOf(result).kind).toBe('timeout')
  })
})

describe('load', () => {
  it('rejects a well-shaped record at an attacker-chosen ID that carries no valid MAC', async () => {
    // #given a record naming the operator at a key the attacker chose, with a forged MAC
    const harness = createHarness()
    harness.store.seed(
      buildSessionKey(hashSessionId('attacker-chosen-id')),
      JSON.stringify({githubUserId: OPERATOR_ID, login: 'operator', issuedAt: NOW, status: 'active', mac: 'forged'}),
    )

    // #when the store loads
    const loaded = await harness.persistence.load()

    // #then the record is rejected and counted
    expect(loaded.success && loaded.data.sessions).toEqual([])
    expect(loaded.success && loaded.data.counts.macFailed).toBe(1)
  })

  it('rejects a valid record copied to a different key', async () => {
    // #given a record signed for one key, copied to another
    const harness = createHarness()
    const source = signSessionRecord(MAC_KEY, plantedHash('source'), {
      githubUserId: OPERATOR_ID,
      login: 'operator',
      issuedAt: NOW,
      status: 'active',
    })
    harness.store.seed(buildSessionKey(plantedHash('copy')), JSON.stringify(source))

    // #when the store loads
    const loaded = await harness.persistence.load()

    // #then the key hash in the MAC does not match
    expect(loaded.success && loaded.data.sessions).toEqual([])
    expect(loaded.success && loaded.data.counts.macFailed).toBe(1)
  })

  it('rejects a record signed under a different CSRF secret', async () => {
    // #given records signed under the old secret and a store built on a rotated secret
    const old = createHarness()
    await old.persistence.create({sessionId: 'x', githubUserId: OPERATOR_ID, login: 'operator', issuedAt: NOW})
    const rotated = createHarness({macKey: deriveSessionRecordKey(Buffer.alloc(32, 9))})
    for (const [key, value] of old.store.objects) {
      rotated.store.seed(key, value.data)
    }

    // #when the rotated store loads
    const loaded = await rotated.persistence.load()

    // #then every record fails the MAC
    expect(loaded.success && loaded.data.sessions).toEqual([])
    expect(loaded.success && loaded.data.counts.macFailed).toBe(1)
  })

  it('rejects future-dated and too-old records and accepts one inside the skew allowance', async () => {
    // #given signed records at several issue times
    const harness = createHarness()
    plant(harness, plantedHash('future'), {issuedAt: NOW + SKEW_MS + 1})
    plant(harness, plantedHash('skew'), {issuedAt: NOW + SKEW_MS})
    plant(harness, plantedHash('old'), {issuedAt: NOW - TTL_MS})
    plant(harness, plantedHash('fresh'), {issuedAt: NOW - TTL_MS + 1})

    // #when the store loads
    const loaded = await harness.persistence.load()

    // #then future and expired records are counted and dropped
    expect(loaded.success).toBe(true)
    if (loaded.success === false) return
    expect(loaded.data.counts).toMatchObject({listed: 4, loaded: 2, futureDated: 1, tooOld: 1, macFailed: 0})
    expect(loaded.data.sessions.map(s => s.keyHash).sort()).toEqual([plantedHash('fresh'), plantedHash('skew')].sort())
  })

  it('classifies by MAC before trusting the claimed issue time', async () => {
    // #given an unsigned record that claims to be both future-dated and expired
    const harness = createHarness()
    harness.store.seed(
      buildSessionKey(plantedHash('claims')),
      JSON.stringify({githubUserId: OPERATOR_ID, login: 'operator', issuedAt: NOW * 2, status: 'active', mac: 'x'}),
    )

    // #when the store loads
    const loaded = await harness.persistence.load()

    // #then it counts as a MAC failure only
    expect(loaded.success && loaded.data.counts).toMatchObject({macFailed: 1, futureDated: 0, tooOld: 0})
  })

  it('skips malformed and mistyped records and unrecognized keys without throwing', async () => {
    // #given assorted bad objects under the prefix
    const harness = createHarness()
    const goodMac = signSessionRecord(MAC_KEY, plantedHash('typed'), {
      githubUserId: OPERATOR_ID,
      login: 'operator',
      issuedAt: NOW,
      status: 'active',
    })
    harness.store.seed(buildSessionKey(plantedHash('json')), '{not json')
    harness.store.seed(buildSessionKey(plantedHash('array')), '[]')
    harness.store.seed(buildSessionKey(plantedHash('null')), 'null')
    harness.store.seed(
      buildSessionKey(plantedHash('typed')),
      JSON.stringify({...goodMac, githubUserId: String(OPERATOR_ID)}),
    )
    harness.store.seed(buildSessionKey(plantedHash('status')), JSON.stringify({...goodMac, status: 'superseded'}))
    harness.store.seed(buildSessionKey(plantedHash('float')), JSON.stringify({...goodMac, githubUserId: 1.5}))
    harness.store.seed(`${SESSION_KEY_PREFIX}/not-a-hash.json`, '{}')
    harness.store.seed(`${SESSION_KEY_PREFIX}/${plantedHash('ext')}.txt`, '{}')

    // #when the store loads
    const loaded = await harness.persistence.load()

    // #then each is skipped and counted
    expect(loaded.success).toBe(true)
    if (loaded.success === false) return
    expect(loaded.data.sessions).toEqual([])
    expect(loaded.data.counts).toMatchObject({listed: 8, malformed: 8, loaded: 0})
  })

  it('never exceeds the read concurrency bound', async () => {
    // #given forty signed records and slow reads
    const harness = createHarness({scanConcurrency: 4})
    for (let index = 0; index < 40; index++) {
      plant(harness, plantedHash(`c${index}`), {issuedAt: NOW})
    }
    harness.store.setLatency('getObject', 5)

    // #when the store loads
    const loaded = await harness.persistence.load()

    // #then all load and reads overlap but never beyond the bound
    expect(loaded.success && loaded.data.counts.loaded).toBe(40)
    expect(harness.store.peakInFlight('getObject')).toBeGreaterThan(1)
    expect(harness.store.peakInFlight('getObject')).toBeLessThanOrEqual(4)
  })

  it('reports a list failure as a failure, not an empty store', async () => {
    // #given a list that fails
    const harness = createHarness()
    plant(harness, plantedHash('exists'), {issuedAt: NOW})
    harness.store.failNext('list')

    // #when the store loads
    const loaded = await harness.persistence.load()

    // #then the failure is distinct from an empty result
    expect(errorOf(loaded).kind).toBe('store_error')
    expect(errorOf(loaded).errorClass).toBe('http_503')
  })

  it('reports the overall timeout as a failure', async () => {
    // #given many slow reads and a short overall deadline
    const harness = createHarness({scanConcurrency: 2, scanTimeoutMs: 40})
    for (let index = 0; index < 20; index++) {
      plant(harness, plantedHash(`t${index}`), {issuedAt: NOW})
    }
    harness.store.setLatency('getObject', 30)

    // #when the store loads
    const loaded = await harness.persistence.load()

    // #then it fails with a timeout and stops taking new reads
    expect(errorOf(loaded).kind).toBe('timeout')
    await new Promise<void>(resolve => {
      setTimeout(resolve, 100)
    })
    expect(harness.store.callCount('getObject')).toBeLessThan(20)
  })

  it('counts failed record reads and loads the rest', async () => {
    // #given three records and one failing read
    const harness = createHarness({scanConcurrency: 1})
    for (const label of ['a', 'b', 'c']) {
      plant(harness, plantedHash(label), {issuedAt: NOW})
    }
    harness.store.failNext('getObject', {match: key => key.includes(plantedHash('b'))})

    // #when the store loads
    const loaded = await harness.persistence.load()

    // #then the failed read is counted and skipped
    expect(loaded.success).toBe(true)
    if (loaded.success === false) return
    expect(loaded.data.counts).toMatchObject({listed: 3, loaded: 2, readFailed: 1})
  })

  it('counts a record removed between list and read as absent', async () => {
    // #given a record deleted after the list
    const harness = createHarness()
    plant(harness, plantedHash('vanish'), {issuedAt: NOW})
    harness.store.onBefore('getObject', key => {
      harness.store.remove(key)
    })

    // #when the store loads
    const loaded = await harness.persistence.load()

    // #then it counts as absent, not as a failure
    expect(loaded.success && loaded.data.counts).toMatchObject({absent: 1, readFailed: 0, loaded: 0})
  })

  it('counts the keys beyond the scan bound as truncated', async () => {
    // #given more records than the scan bound
    const harness = createHarness({scanMaxKeys: 3})
    for (let index = 0; index < 5; index++) {
      plant(harness, plantedHash(`m${index}`), {issuedAt: NOW})
    }

    // #when the store loads
    const loaded = await harness.persistence.load()

    // #then the excess is counted and not read
    expect(loaded.success && loaded.data.counts).toMatchObject({listed: 5, loaded: 3, truncated: 2})
    expect(harness.store.callCount('getObject')).toBe(3)
  })
})

describe('sweep', () => {
  it('deletes expired records and keeps revoked records inside the TTL', async () => {
    // #given an expired active record, an expired MAC-failing record, a fresh revoked record and a fresh active one
    const harness = createHarness()
    plant(harness, plantedHash('expired'), {issuedAt: NOW - TTL_MS - 1})
    plant(
      harness,
      plantedHash('expired-bad-mac'),
      {issuedAt: NOW - TTL_MS - 1},
      deriveSessionRecordKey(Buffer.alloc(32, 1)),
    )
    plant(harness, plantedHash('revoked'), {issuedAt: NOW - DAY_MS, status: 'revoked'})
    plant(harness, plantedHash('active'), {issuedAt: NOW})

    // #when the sweep runs
    const swept = await harness.persistence.sweep()

    // #then the expired and the unsigned records are deleted
    expect(swept.success).toBe(true)
    if (swept.success === false) return
    expect(swept.data).toMatchObject({listed: 4, deleted: 2, kept: 2, raced: 0, deleteFailed: 0})
    expect([...harness.store.objects.keys()].sort()).toEqual(
      [buildSessionKey(plantedHash('revoked')), buildSessionKey(plantedHash('active'))].sort(),
    )
  })

  it('deletes malformed records and leaves unrecognized key names alone', async () => {
    // #given unreadable and mistyped objects, plus an unrecognized key name
    const harness = createHarness()
    harness.store.seed(buildSessionKey(plantedHash('junk')), 'junk')
    harness.store.seed(buildSessionKey(plantedHash('array')), '[]')
    harness.store.seed(`${SESSION_KEY_PREFIX}/not-a-hash.json`, '{}')

    // #when the sweep runs
    const swept = await harness.persistence.sweep()

    // #then both malformed records are deleted, and the odd key is left alone
    expect(swept.success && swept.data).toMatchObject({malformed: 2, unrecognized: 1, deleted: 2, kept: 0})
    expect([...harness.store.objects.keys()]).toEqual([`${SESSION_KEY_PREFIX}/not-a-hash.json`])
    expect(harness.store.callCount('conditionalDelete')).toBe(2)
  })

  it('deletes unsigned records whatever their claimed age', async () => {
    // #given a fresh unsigned record, one claiming a far-future issue time, and a signed fresh record
    const harness = createHarness()
    const otherKey = deriveSessionRecordKey(Buffer.alloc(32, 1))
    plant(harness, plantedHash('fresh-bad'), {issuedAt: NOW}, otherKey)
    plant(harness, plantedHash('future-bad'), {issuedAt: NOW * 2}, otherKey)
    plant(harness, plantedHash('good'), {issuedAt: NOW})

    // #when the sweep runs
    const swept = await harness.persistence.sweep()

    // #then the unsigned records go, since their claimed age cannot be trusted, and the signed one stays
    expect(swept.success && swept.data).toMatchObject({unsigned: 2, deleted: 2, kept: 1})
    expect([...harness.store.objects.keys()]).toEqual([buildSessionKey(plantedHash('good'))])
  })

  it('does not delete a malformed record that was rewritten after the sweep read it', async () => {
    // #given a malformed record that a writer replaces with a valid one after the read
    const harness = createHarness()
    harness.store.seed(buildSessionKey(plantedHash('swap')), 'junk')
    harness.store.onBefore('conditionalDelete', () => {
      harness.store.onBefore('conditionalDelete', undefined)
      plant(harness, plantedHash('swap'), {issuedAt: NOW})
    })

    // #when the sweep runs
    const swept = await harness.persistence.sweep()

    // #then the stale etag loses the race and the valid record survives
    expect(swept.success && swept.data).toMatchObject({malformed: 1, deleted: 0, raced: 1})
    expect(harness.store.objects.has(buildSessionKey(plantedHash('swap')))).toBe(true)
  })

  it('loses a race to a concurrent write without error', async () => {
    // #given an expired record that is rewritten after the sweep reads it
    const harness = createHarness()
    plant(harness, plantedHash('raced'), {issuedAt: NOW - TTL_MS - 1})
    harness.store.onBefore('conditionalDelete', key => {
      harness.store.seed(key, harness.store.objects.get(key)?.data ?? '')
    })

    // #when the sweep runs
    const swept = await harness.persistence.sweep()

    // #then the delete is counted as raced, the record survives and nothing fails
    expect(swept.success && swept.data).toMatchObject({deleted: 0, raced: 1, deleteFailed: 0})
    expect(harness.store.objects.size).toBe(1)
  })

  it('counts a failing delete and keeps going', async () => {
    // #given two expired records and one failing delete
    const harness = createHarness({scanConcurrency: 1})
    plant(harness, plantedHash('e1'), {issuedAt: NOW - TTL_MS - 1})
    plant(harness, plantedHash('e2'), {issuedAt: NOW - TTL_MS - 1})
    harness.store.failNext('conditionalDelete')

    // #when the sweep runs
    const swept = await harness.persistence.sweep()

    // #then one delete fails and the other succeeds
    expect(swept.success && swept.data).toMatchObject({deleted: 1, deleteFailed: 1})
  })

  it('reports a list failure as a failure', async () => {
    // #given a failing list
    const harness = createHarness()
    harness.store.failNext('list')

    // #when the sweep runs
    const swept = await harness.persistence.sweep()

    // #then it is an error, not an empty sweep
    expect(errorOf(swept).kind).toBe('store_error')
  })
})

describe('adapter narrowing', () => {
  const methods: readonly TestObjectStoreMethod[] = ['list', 'getObject', 'conditionalPut', 'conditionalDelete']

  it.each(methods)('returns a typed error from every operation when %s is missing', async method => {
    // #given an adapter without the method
    const {persistence} = createHarness({store: {omit: [method]}})

    // #when each operation runs
    const results = await Promise.all([
      persistence.create({sessionId: 's', githubUserId: OPERATOR_ID, login: 'operator', issuedAt: NOW}),
      persistence.revoke(hashSessionId('s'), 'revoked'),
      persistence.load(),
      persistence.sweep(),
      persistence.selfTest(),
    ])

    // #then each returns the typed error naming the method
    for (const result of results) {
      const error = errorOf(result)
      expect(error.kind).toBe('unsupported_adapter')
      expect(error.code).toBe('OPERATOR_SESSION_PERSISTENCE_ERROR')
      expect(error.message).toContain(method)
    }
  })
})

describe('selfTest', () => {
  it('passes on a CAS-capable store and leaves no key behind', async () => {
    // #given a CAS-capable store with an existing session record
    const harness = createHarness()
    plant(harness, plantedHash('keep'), {issuedAt: NOW})

    // #when the self-test runs
    const result = await harness.persistence.selfTest()

    // #then it passes and only the session record remains
    expect(result.success).toBe(true)
    expect([...harness.store.objects.keys()]).toEqual([buildSessionKey(plantedHash('keep'))])
  })

  it('works under a sibling prefix that load and sweep never see', async () => {
    // #given a failure injected after the test key is written, so cleanup must remove it
    const harness = createHarness()
    harness.store.failNext('conditionalDelete')

    // #when the self-test fails mid-way and cleans up, then load runs
    const result = await harness.persistence.selfTest()
    const loaded = await harness.persistence.load()

    // #then the test key lived outside the session prefix and was cleaned up best-effort
    expect(result.success).toBe(false)
    expect(harness.store.calls.some(call => call.key.startsWith('operator-web/_self-test/'))).toBe(true)
    expect(
      harness.store.calls.some(call => call.key.startsWith(`${SESSION_KEY_PREFIX}/`) && call.method !== 'list'),
    ).toBe(false)
    expect(loaded.success && loaded.data.counts.listed).toBe(0)
    expect(harness.store.objects.size).toBe(0)
  })

  it('fails when a put succeeds but list returns nothing', async () => {
    // #given an adapter whose list always returns an empty result, like a denied ListBucket
    const harness = createHarness({adapter: base => ({...base, list: async () => ok([])})})

    // #when the self-test runs
    const result = await harness.persistence.selfTest()

    // #then it fails with a ListBucket message
    const error = errorOf(result)
    expect(error.kind).toBe('self_test_failed')
    expect(error.message).toContain('ListBucket')
    expect(harness.store.objects.size).toBe(0)
  })

  it('fails when a second create does not conflict', async () => {
    // #given a last-write-wins adapter that ignores preconditions
    const harness = createHarness({
      adapter: base => ({
        ...base,
        conditionalPut: async (key, data) => {
          const stored = harness.store.seed(key, data)
          return ok({etag: stored})
        },
      }),
    })

    // #when the self-test runs
    const result = await harness.persistence.selfTest()

    // #then it reports the missing compare-and-swap
    const error = errorOf(result)
    expect(error.kind).toBe('self_test_failed')
    expect(error.message).toContain('compare-and-swap')
  })

  it('fails when the second create errors for a reason other than a conflict', async () => {
    // #given a second create that fails with an outage
    const harness = createHarness()
    let puts = 0
    harness.store.onBefore('conditionalPut', () => {
      puts += 1
      if (puts === 3) {
        harness.store.failNext('conditionalPut')
      }
    })

    // #when the self-test runs
    const result = await harness.persistence.selfTest()

    // #then the third write (the duplicate create) fails the self-test with its error class
    const error = errorOf(result)
    expect(error.kind).toBe('self_test_failed')
    expect(error.message).toContain('http_503')
    expect(harness.store.objects.size).toBe(0)
  })

  it('fails when conditionalDelete is missing', async () => {
    // #given an adapter without conditionalDelete
    const {persistence} = createHarness({store: {omit: ['conditionalDelete']}})

    // #when the self-test runs
    const result = await persistence.selfTest()

    // #then it fails with the typed adapter error
    expect(errorOf(result).kind).toBe('unsupported_adapter')
  })

  it('reports a denied list as an error with its class', async () => {
    // #given a list that fails with AccessDenied
    const harness = createHarness({
      adapter: base => ({
        ...base,
        list: async () =>
          err(createObjectStoreOperationError('denied', {errorCode: 'AccessDenied', httpStatusCode: 403})),
      }),
    })

    // #when the self-test runs
    const result = await harness.persistence.selfTest()

    // #then the class is http_403 and the key is cleaned up
    expect(errorOf(result).errorClass).toBe('http_403')
    expect(harness.store.objects.size).toBe(0)
  })
})

describe('integration', () => {
  it('create, load, revoke, load shows the revoked status and no resurrection', async () => {
    // #given a created session
    const harness = createHarness()
    await harness.persistence.create({
      sessionId: RAW_SESSION_ID,
      githubUserId: OPERATOR_ID,
      login: 'operator',
      issuedAt: NOW,
    })
    const keyHash = hashSessionId(RAW_SESSION_ID)

    // #when it loads active, is revoked, and loads again
    const first = await harness.persistence.load()
    const revoked = await harness.persistence.revoke(keyHash, 'revoked')
    const second = await harness.persistence.load()
    const again = await harness.persistence.revoke(keyHash, 'revoked')
    const third = await harness.persistence.load()

    // #then the status moves to revoked and stays there
    expect(first.success && first.data.sessions).toEqual([
      {keyHash, githubUserId: OPERATOR_ID, login: 'operator', issuedAt: NOW, status: 'active'},
    ])
    expect(revoked).toEqual(ok('written'))
    expect(second.success && second.data.sessions.map(s => s.status)).toEqual(['revoked'])
    expect(again).toEqual(ok('already'))
    expect(third.success && third.data.sessions.map(s => s.status)).toEqual(['revoked'])
  })

  it('keeps every session ID, hash and key out of logs and error messages', async () => {
    // #given a full lifecycle with failures that echo the session in their messages
    const harness = createHarness()
    const keyHash = hashSessionId(RAW_SESSION_ID)
    const failures: Result<unknown, SessionPersistenceError>[] = []
    await harness.persistence.create({
      sessionId: RAW_SESSION_ID,
      githubUserId: OPERATOR_ID,
      login: 'operator',
      issuedAt: NOW,
    })
    plant(harness, plantedHash('old'), {issuedAt: NOW - TTL_MS - 1})
    harness.store.failNext('getObject', {error: new Error(`boom ${RAW_SESSION_ID} ${keyHash}`)})
    failures.push(await harness.persistence.revoke(keyHash, 'revoked'))
    await harness.persistence.load()
    await harness.persistence.sweep()
    await harness.persistence.selfTest()
    harness.store.failNext('list', {error: new Error(`boom ${buildSessionKey(keyHash)}`)})
    failures.push(await harness.persistence.sweep())

    // #when everything emitted is serialized
    const emitted = JSON.stringify({logs: harness.logs, failures: failures.map(f => errorOf(f).message)})

    // #then no ID, hash, key or adapter message appears
    expect(emitted).not.toContain(RAW_SESSION_ID)
    expect(emitted).not.toContain(keyHash)
    expect(emitted).not.toContain(plantedHash('old'))
    expect(emitted).not.toContain('operator-web')
    expect(emitted).not.toContain('boom')
    expect(harness.logs.length).toBeGreaterThan(0)
  })
})
