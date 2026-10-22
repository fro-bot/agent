import type {
  CoordinationConfig,
  LockRecord,
  ObjectStoreAdapter,
  ObjectStoreConfig,
  ReleaseIfHolderOutcome,
  Result,
  RunState,
} from '@fro-bot/runtime'

import {
  createHeartbeatController,
  err,
  HEARTBEAT_STOP_GRACE_MS,
  ok,
  releaseLock,
  releaseLockIfHolder,
} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {releaseLockOrByOwnership} from './lock-release.js'

const REPO = 'owner/repo'
const RUN_ID = 'run-1'
const HOLDER = 'gateway-1'
const TOKEN = 'token-0001-abcd'
const INTERVAL = 30_000
const TICK_TIMEOUT = 10_000

function createLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

// ---------------------------------------------------------------------------
// The decision table, with the release calls faked
// ---------------------------------------------------------------------------

describe('releaseLockOrByOwnership', () => {
  const stale = () => err(new Error('PreconditionFailed'))

  function run(options: {
    readonly byEtag?: Result<void, Error>
    readonly byOwnership?: Result<ReleaseIfHolderOutcome, Error>
    readonly acquisitionToken?: string | undefined
  }) {
    const logger = createLogger()
    const releaseByEtag = vi.fn(async () => options.byEtag ?? ok(undefined))
    const releaseIfHolder = vi.fn(async (_token: string) => options.byOwnership ?? ok('released' as const))
    const result = releaseLockOrByOwnership({
      releaseByEtag,
      releaseIfHolder,
      acquisitionToken: 'acquisitionToken' in options ? options.acquisitionToken : TOKEN,
      logger,
      context: {repo: REPO, runId: RUN_ID},
      label: 'run',
    })
    return {result, logger, releaseByEtag, releaseIfHolder}
  }

  it('does nothing more when the ETag release succeeds', async () => {
    // #given / #when
    const {result, releaseIfHolder, logger} = run({byEtag: ok(undefined)})

    // #then
    expect(await result).toEqual(ok(undefined))
    expect(releaseIfHolder).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('hands the acquisition token to the ownership release when the ETag is stale', async () => {
    // #given / #when
    const {result, releaseIfHolder} = run({byEtag: stale()})

    // #then
    expect(await result).toEqual(ok(undefined))
    expect(releaseIfHolder).toHaveBeenCalledExactlyOnceWith(TOKEN)
  })

  it('does not fall back for a failure that is not a stale ETag, and returns that failure', async () => {
    // #given
    const failure = new Error('503 slow down')
    const {result, releaseIfHolder, logger} = run({byEtag: err(failure)})

    // #then
    expect(await result).toEqual(err(failure))
    expect(releaseIfHolder).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('does not fall back without a token: the stale-ETag failure comes back unchanged', async () => {
    // #given a caller from an older path, or a helper that never minted one
    const {result, releaseIfHolder, logger} = run({byEtag: stale(), acquisitionToken: undefined})

    // #then
    expect(await result).toEqual(stale())
    expect(releaseIfHolder).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it.each([
    ['released', 'info', 'run: lock released by ownership after a stale ETag'],
    ['no-lock', 'debug', 'run: lock already gone when releasing by ownership'],
    ['not-holder', 'info', 'run: lock now belongs to another acquisition — left in place'],
    ['conflict', 'info', 'run: lock replaced while releasing by ownership — left in place'],
  ] as const)('reports %s at %s and treats it as released', async (outcome, level, message) => {
    // #given
    const {result, logger} = run({byEtag: stale(), byOwnership: ok(outcome)})

    // #then the caller sees success, nothing is logged above info, and the outcome is named
    expect(await result).toEqual(ok(undefined))
    expect(logger[level]).toHaveBeenCalledWith({repo: REPO, runId: RUN_ID, outcome}, message)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('returns the ownership release failure when that fails too, leaving the warning to the caller', async () => {
    // #given
    const failure = new Error('503 slow down')
    const {result, logger} = run({byEtag: stale(), byOwnership: err(failure)})

    // #then
    expect(await result).toEqual(err(failure))
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// End to end: the real heartbeat, the real lock code, an in-memory store with S3's ETag semantics
// ---------------------------------------------------------------------------

const LOCK_KEY = 'fro-bot-state/coordination/owner/repo/locks/repo.json'
const RUN_KEY = 'fro-bot-state/coordination/owner/repo/runs/run-1.json'

type PutResult = Result<{etag: string}, Error>

const hang = async <T>(): Promise<T> => new Promise<T>(() => {})

function lockRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    repo: REPO,
    holder_id: HOLDER,
    surface: 'discord',
    acquired_at: '2026-04-24T18:15:00.000Z',
    ttl_seconds: 900,
    run_id: RUN_ID,
    acquisition_token: TOKEN,
    ...overrides,
  }
}

function runState(): RunState {
  return {
    run_id: RUN_ID,
    surface: 'discord',
    thread_id: 'thread-1',
    entity_ref: 'owner/repo#1',
    phase: 'EXECUTING',
    started_at: '2026-04-24T18:00:00.000Z',
    last_heartbeat: '2026-04-24T18:00:00.000Z',
    holder_id: HOLDER,
    details: {},
  }
}

/** Replaces a lock write; `real` performs the compare-and-swap at once. `n` counts lock writes. */
type PutHook = (real: () => PutResult, n: number) => Promise<PutResult>

function createStore(putHook?: PutHook) {
  const objects = new Map<string, {data: string; etag: string}>()
  let version = 0
  let lockWrites = 0
  const set = (key: string, data: string): string => {
    version += 1
    const etag = `etag-${version}`
    objects.set(key, {data, etag})
    return etag
  }
  set(LOCK_KEY, JSON.stringify(lockRecord()))
  set(RUN_KEY, JSON.stringify(runState()))

  const adapter: Required<ObjectStoreAdapter> = {
    upload: vi.fn(async () => ok(undefined)),
    download: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    listWithMetadata: vi.fn(async () => ok([])),
    conditionalDelete: vi.fn<NonNullable<ObjectStoreAdapter['conditionalDelete']>>(async (key, options) => {
      if (objects.get(key)?.etag !== options.ifMatch) return err(new Error('PreconditionFailed'))
      objects.delete(key)
      return ok(undefined)
    }),
    getObject: vi.fn<NonNullable<ObjectStoreAdapter['getObject']>>(async key => {
      const found = objects.get(key)
      return found === undefined ? err(new Error('NoSuchKey')) : ok({...found})
    }),
    conditionalPut: vi.fn<NonNullable<ObjectStoreAdapter['conditionalPut']>>(async (key, data, options) => {
      if (key === LOCK_KEY) lockWrites += 1
      const real = (): PutResult => {
        if (options.ifMatch !== undefined && objects.get(key)?.etag !== options.ifMatch) {
          return err(new Error('PreconditionFailed'))
        }
        return ok({etag: set(key, data)})
      }
      return key === LOCK_KEY && putHook !== undefined ? putHook(real, lockWrites) : real()
    }),
  }
  const storeConfig: ObjectStoreConfig = {enabled: true, bucket: 'b', region: 'us-east-1', prefix: 'fro-bot-state'}
  const config: CoordinationConfig = {
    storeAdapter: adapter,
    storeConfig,
    lockTtlSeconds: 900,
    heartbeatIntervalMs: INTERVAL,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
  return {
    config,
    lock: () => objects.get(LOCK_KEY) ?? null,
    lockRecord: () => {
      const found = objects.get(LOCK_KEY)
      return found === undefined ? null : (JSON.parse(found.data) as LockRecord)
    },
    replaceLock: (record: LockRecord) => set(LOCK_KEY, JSON.stringify(record)),
    deleteLock: () => objects.delete(LOCK_KEY),
  }
}

function startHeartbeat(store: ReturnType<typeof createStore>) {
  const runtimeLogger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn()}
  const heartbeat = createHeartbeatController(
    store.config,
    'coordination',
    REPO,
    RUN_ID,
    store.lock()?.etag ?? '',
    'etag-2',
    runtimeLogger,
    TOKEN,
  )
  heartbeat.start()
  return heartbeat
}

/** The release the gateway issues after a failed `stop()`: by the ETag it reports, falling back to ownership. */
async function releaseAfterStop(store: ReturnType<typeof createStore>, etag: string) {
  const logger = createLogger()
  const coordLogger = {debug: vi.fn()}
  const result = await releaseLockOrByOwnership({
    releaseByEtag: async () => releaseLock(store.config, REPO, etag, coordLogger),
    releaseIfHolder: async token =>
      releaseLockIfHolder(store.config, REPO, HOLDER, coordLogger, 'repo', {acquisitionToken: token, runId: RUN_ID}),
    acquisitionToken: TOKEN,
    logger,
    context: {repo: REPO, runId: RUN_ID},
    label: 'run',
  })
  return {result, logger}
}

describe('releasing by ownership after a heartbeat stop, against the real lock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('(a) deletes our record when a renewal commits after the stop-path read and the ETag release 412s', async () => {
    // #given a renewal that is held back, times out, and only commits once stop has already read the lock
    let commit: () => PutResult = () => err(new Error('not started'))
    const store = createStore(async real => {
      commit = real
      return hang()
    })
    const heartbeat = startHeartbeat(store)
    await vi.advanceTimersByTimeAsync(INTERVAL + TICK_TIMEOUT)
    const stopped = await heartbeat.stop()
    expect(stopped.success).toBe(false)
    const reported = stopped.success ? '' : stopped.error.lockEtag
    expect(reported).toBe(store.lock()?.etag)
    commit()
    expect(store.lock()?.etag).not.toBe(reported)

    // #when the gateway releases with the ETag stop reported
    const {result, logger} = await releaseAfterStop(store, reported)

    // #then the stale ETag lost, the ownership fallback saw our record and deleted it, and nothing warned
    expect(result).toEqual(ok(undefined))
    expect(store.lock()).toBeNull()
    expect(logger.info).toHaveBeenCalledWith(
      {repo: REPO, runId: RUN_ID, outcome: 'released'},
      'run: lock released by ownership after a stale ETag',
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('(b) releases an in-doubt renewal that committed while the tick was still pending at stop', async () => {
    // #given a renewal in flight when stop begins, which commits while stop waits out its budget
    let commit: () => PutResult = () => err(new Error('not started'))
    const store = createStore(async real => {
      commit = real
      return hang()
    })
    const heartbeat = startHeartbeat(store)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const stopping = heartbeat.stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS - 1)
    commit()
    await vi.advanceTimersByTimeAsync(1)
    const stopped = await stopping

    // #then stop could not know: it is pending with the ETag it held
    expect(stopped.success).toBe(false)
    if (stopped.success) throw new Error('expected a failed stop')
    expect(stopped.error.tickPending).toBe(true)
    expect(stopped.error.lockEtag).not.toBe(store.lock()?.etag)

    // #when
    const {result, logger} = await releaseAfterStop(store, stopped.error.lockEtag)

    // #then
    expect(result).toEqual(ok(undefined))
    expect(store.lock()).toBeNull()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('(c) deletes nothing when a successor took the lock over', async () => {
    // #given a failed stop, then a successor acquires with its own token
    const store = createStore(async () => hang())
    const heartbeat = startHeartbeat(store)
    await vi.advanceTimersByTimeAsync(INTERVAL + TICK_TIMEOUT)
    const stopped = await heartbeat.stop()
    const reported = stopped.success ? '' : stopped.error.lockEtag
    store.replaceLock(lockRecord({run_id: 'run-2', acquisition_token: 'successor-token-9'}))
    const successor = store.lock()

    // #when
    const {result, logger} = await releaseAfterStop(store, reported)

    // #then the record is the successor's, byte for byte
    expect(result).toEqual(ok(undefined))
    expect(store.lock()).toEqual(successor)
    expect(logger.info).toHaveBeenCalledWith(
      {repo: REPO, runId: RUN_ID, outcome: 'not-holder'},
      'run: lock now belongs to another acquisition — left in place',
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('(c) deletes nothing when the successor reuses our holder id and run but not our token', async () => {
    // #given the gateway's holder id repeats across runs, so only the token tells the acquisitions apart
    const store = createStore(async () => hang())
    const heartbeat = startHeartbeat(store)
    await vi.advanceTimersByTimeAsync(INTERVAL + TICK_TIMEOUT)
    const stopped = await heartbeat.stop()
    store.replaceLock(lockRecord({acquisition_token: 'successor-token-9'}))
    const successor = store.lock()

    // #when
    await releaseAfterStop(store, stopped.success ? '' : stopped.error.lockEtag)

    // #then
    expect(store.lock()).toEqual(successor)
  })

  it('(d) is a quiet no-op when the record is already gone', async () => {
    // #given
    const store = createStore(async () => hang())
    const heartbeat = startHeartbeat(store)
    await vi.advanceTimersByTimeAsync(INTERVAL + TICK_TIMEOUT)
    const stopped = await heartbeat.stop()
    store.deleteLock()

    // #when
    const {result, logger} = await releaseAfterStop(store, stopped.success ? '' : stopped.error.lockEtag)

    // #then
    expect(result).toEqual(ok(undefined))
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(
      {repo: REPO, runId: RUN_ID, outcome: 'no-lock'},
      'run: lock already gone when releasing by ownership',
    )
  })

  it('adopt, then a successor takes the lock: our next renewal and our ETag release both 412 and nothing is deleted', async () => {
    // #given the first renewal commits server-side and answers with an error, so the tick adopts the stored ETag
    const store = createStore(async (real, n) => {
      if (n !== 1) return real()
      real()
      return err(new Error('response lost'))
    })
    const heartbeat = startHeartbeat(store)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const adopted = store.lock()?.etag
    // ...and a successor then compare-and-swaps over the adopted record
    store.replaceLock(lockRecord({acquisition_token: 'successor-token-9', run_id: 'run-2'}))
    const successor = store.lock()

    // #when the next tick renews against the adopted ETag, and stop and the release follow
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const stopped = await heartbeat.stop()
    const {result, logger} = await releaseAfterStop(store, adopted ?? '')

    // #then the renewal 412d, adoption refused the successor's record, and the successor's record is untouched
    expect(stopped.success).toBe(false)
    expect(stopped.success ? '' : stopped.error.lockEtag).toBe(adopted)
    expect(result).toEqual(ok(undefined))
    expect(store.lock()).toEqual(successor)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
