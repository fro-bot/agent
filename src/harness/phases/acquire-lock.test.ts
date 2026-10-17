import type {LockAcquisitionResult, LockRecord, ObjectStoreConfig} from '@fro-bot/runtime'
import * as core from '@actions/core'
import {DEFAULT_HEARTBEAT_INTERVAL_MS} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {err, ok} from '../../shared/types.js'
import {STATE_KEYS} from '../config/state-keys.js'
import {
  parseActionHolderRunId,
  releaseActionLockIfHeld,
  runAcquireLock,
  SAME_RUN_TAKEOVER_MIN_UNRENEWED_MS,
} from './acquire-lock.js'

const acquireLockMock = vi.hoisted(() => vi.fn())
const createS3AdapterMock = vi.hoisted(() => vi.fn(() => ({})))
const renewLeaseMock = vi.hoisted(() => vi.fn())
const releaseLockIfHolderMock = vi.hoisted(() => vi.fn())
const releaseLockMock = vi.hoisted(() => vi.fn())

vi.mock('@actions/core', () => ({saveState: vi.fn()}))

vi.mock('@fro-bot/runtime', async () => {
  const actual = await vi.importActual<typeof import('@fro-bot/runtime')>('@fro-bot/runtime')
  return {
    ...actual,
    acquireLock: acquireLockMock,
    createS3Adapter: createS3AdapterMock,
    renewLease: renewLeaseMock,
    releaseLockIfHolder: releaseLockIfHolderMock,
    releaseLock: releaseLockMock,
  }
})

function createStoreConfig(overrides?: Partial<ObjectStoreConfig>): ObjectStoreConfig {
  return {
    enabled: true,
    bucket: 'test-bucket',
    region: 'us-east-1',
    prefix: 'fro-bot-state',
    ...overrides,
  }
}

function createLockRecord(overrides?: Partial<LockRecord>): LockRecord {
  return {
    repo: 'fro-bot/agent',
    holder_id: 'gateway:instance-1:run-99',
    surface: 'discord',
    acquired_at: '2026-04-25T12:00:00.000Z',
    ttl_seconds: 900,
    run_id: 'run-99',
    ...overrides,
  }
}

function lockOk(data: LockAcquisitionResult): {readonly success: true; readonly data: LockAcquisitionResult} {
  return {success: true, data}
}

function lockErr(error: Error): {readonly success: false; readonly error: Error} {
  return {success: false, error}
}

describe('runAcquireLock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    renewLeaseMock.mockResolvedValue(ok({etag: '"etag-renewed"'}))
  })

  it('returns s3-disabled when storeConfig.enabled is false', async () => {
    // #given storeConfig with object store disabled
    const storeConfig = createStoreConfig({enabled: false})

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '1234',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then phase short-circuits without calling acquireLock
    expect(result).toEqual({outcome: 's3-disabled'})
    expect(acquireLockMock).not.toHaveBeenCalled()
    expect(createS3AdapterMock).not.toHaveBeenCalled()
  })

  it('returns acquired with etag on happy-path lock acquisition', async () => {
    // #given object store enabled and acquireLock returns success
    const storeConfig = createStoreConfig()
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, outcome: 'acquired', etag: '"etag-abc"', holder: null}))

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 2,
      logger: createMockLogger(),
    })

    // #then phase returns acquired with the etag and a running lease-renewal controller
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')
    expect(result.lockEtag).toBe('"etag-abc"')
    expect(typeof result.renewal.hasFailed).toBe('function')
    expect(typeof result.renewal.currentEtag).toBe('function')
    expect(typeof result.renewal.stop).toBe('function')
    expect(result.renewal.hasFailed()).toBe(false)
    expect(result.renewal.currentEtag()).toBe('"etag-abc"')
    await result.renewal.stop()
    expect(acquireLockMock).toHaveBeenCalledTimes(1)
    expect(createS3AdapterMock).toHaveBeenCalledTimes(1)
  })

  it('passes holderId in action:{runId}:{runAttempt} format to acquireLock', async () => {
    // #given object store enabled and acquireLock returns success
    const storeConfig = createStoreConfig()
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, outcome: 'acquired', etag: '"etag"', holder: null}))

    // #when running acquire-lock phase
    await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '99999',
      runAttempt: 3,
      logger: createMockLogger(),
    })

    // #then holderId encodes both runId and runAttempt; surface is github
    expect(acquireLockMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storeConfig,
        lockTtlSeconds: 900,
      }),
      'fro-bot/agent',
      'action:99999:3',
      'github',
      '99999',
      expect.any(Object),
      /* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing */
      {
        scope: 'action',
        reclaimableWithoutConfirmation: expect.any(Function),
        reclaimableBeforeExpiry: expect.any(Function),
      },
      /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    )
  })

  it('only treats github-surface holders as reclaimable without corroboration', async () => {
    // #given
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, outcome: 'acquired', etag: '"etag"', holder: null}))
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '1',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome === 'acquired') await result.renewal.stop()

    // #when
    const options = acquireLockMock.mock.calls[0]?.[6] as {
      reclaimableWithoutConfirmation: (holder: LockRecord) => boolean
      confirmExpiredHolder?: unknown
    }

    // #then — Action leases reclaimable; every gateway surface is not; no corroborator supplied
    const actionHolder = {surface: 'github', holder_id: 'action:1234:1'} as const
    expect(options.reclaimableWithoutConfirmation(createLockRecord(actionHolder))).toBe(true)
    expect(
      options.reclaimableWithoutConfirmation(createLockRecord({...actionHolder, holder_id: 'action:1234:1:build'})),
    ).toBe(true)
    expect(options.reclaimableWithoutConfirmation(createLockRecord({...actionHolder, surface: 'discord'}))).toBe(false)
    expect(options.reclaimableWithoutConfirmation(createLockRecord({...actionHolder, surface: 'web'}))).toBe(false)
    expect(options.confirmExpiredHolder).toBeUndefined()
  })

  it.each([
    'gateway:instance-1:run-99',
    'action:1234',
    'action:1234:x',
    'action::1',
    'action:abc:1',
    'action:1:2:bad id',
    'action:1:2:',
    'action:1:2:a:b',
    'discord-gateway',
  ])('does not treat a github-surface holder with non-Action id %j as reclaimable', async holderId => {
    // #given
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, outcome: 'acquired', etag: '"etag"', holder: null}))
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '1',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome === 'acquired') await result.renewal.stop()
    const options = acquireLockMock.mock.calls[0]?.[6] as {
      reclaimableWithoutConfirmation: (holder: LockRecord) => boolean
    }

    // #when
    const reclaimable = options.reclaimableWithoutConfirmation(
      createLockRecord({surface: 'github', holder_id: holderId}),
    )

    // #then
    expect(reclaimable).toBe(false)
  })

  it('skips an expired github-surface lease with a non-Action holder id as held-by-other, not reclaimed', async () => {
    // #given — acquireLock applies the predicate and, since it rejects, reports expired-holder
    const holder = createLockRecord({surface: 'github', holder_id: 'gateway:instance-1:run-99'})
    acquireLockMock.mockResolvedValue(
      lockOk({
        acquired: false,
        outcome: 'expired-holder',
        etag: null,
        holder,
        confirmation: {kind: 'unknown', source: 'unavailable', directory: null, reason: 'no-corroborator'},
      }),
    )

    // #when
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    const options = acquireLockMock.mock.calls[0]?.[6] as {
      reclaimableWithoutConfirmation: (holder: LockRecord) => boolean
    }

    // #then
    expect(options.reclaimableWithoutConfirmation(holder)).toBe(false)
    expect(result).toEqual({outcome: 'held-by-other', holder, reason: 'expired-holder'})
  })

  it('skips an expired github-surface lease with holder action:abc:1 as held-by-other, not reclaimed', async () => {
    // #given a non-numeric run id in an otherwise Action-shaped holder id; acquireLock reports it uncorroborated
    const holder = createLockRecord({surface: 'github', holder_id: 'action:abc:1'})
    acquireLockMock.mockResolvedValue(
      lockOk({
        acquired: false,
        outcome: 'expired-holder',
        etag: null,
        holder,
        confirmation: {kind: 'unknown', source: 'unavailable', directory: null, reason: 'no-corroborator'},
      }),
    )

    // #when
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    const options = acquireLockMock.mock.calls[0]?.[6] as {
      reclaimableWithoutConfirmation: (holder: LockRecord) => boolean
    }

    // #then the predicate refuses it and the run is skipped
    expect(options.reclaimableWithoutConfirmation(holder)).toBe(false)
    expect(result).toEqual({outcome: 'held-by-other', holder, reason: 'expired-holder'})
  })

  it('returns error when acquireLock rejects instead of returning a Result', async () => {
    // #given the lock primitive throws (e.g. a network failure outside the Result channel)
    const thrown = new Error('socket hang up')
    acquireLockMock.mockRejectedValue(thrown)

    // #when
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then it is reported as an error outcome, not an unhandled rejection
    expect(result).toEqual({outcome: 'error', error: thrown})
  })

  it('returns error when createS3Adapter throws', async () => {
    // #given adapter construction fails (e.g. invalid S3 configuration)
    createS3AdapterMock.mockImplementationOnce(() => {
      throw new Error('bad endpoint')
    })

    // #when
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then
    expect(result.outcome).toBe('error')
    expect(result.outcome === 'error' ? result.error.message : '').toBe('bad endpoint')
    expect(acquireLockMock).not.toHaveBeenCalled()
  })

  it('skips an expired gateway-held lease as held-by-other with a distinct unconfirmed log', async () => {
    // #given acquireLock reports an expired gateway lease it could not corroborate
    const holder = createLockRecord({surface: 'discord'})
    acquireLockMock.mockResolvedValue(
      lockOk({
        acquired: false,
        outcome: 'expired-holder',
        etag: null,
        holder,
        confirmation: {kind: 'unknown', source: 'unavailable', directory: null, reason: 'no-corroborator'},
      }),
    )
    const logger = createMockLogger()

    // #when
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger,
    })

    // #then
    expect(result).toEqual({outcome: 'held-by-other', holder, reason: 'expired-holder'})
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('settlement unconfirmed; skipped'),
      expect.objectContaining({surface: 'discord'}),
    )
  })

  it('logs an active lease as a coordination lease held', async () => {
    // #given
    const holder = createLockRecord({surface: 'discord'})
    acquireLockMock.mockResolvedValue(lockOk({acquired: false, outcome: 'active-holder', etag: null, holder}))
    const logger = createMockLogger()

    // #when
    await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger,
    })

    // #then
    expect(logger.info).toHaveBeenCalledWith(
      'lock-held-by-other-surface',
      expect.objectContaining({reason: 'coordination lease held'}),
    )
  })

  it('returns held-by-other when another surface holds the lock', async () => {
    // #given another surface (Discord gateway) currently holds the lock
    const storeConfig = createStoreConfig()
    const holder = createLockRecord({
      holder_id: 'gateway:instance-1:run-99',
      surface: 'discord',
    })
    acquireLockMock.mockResolvedValue(lockOk({acquired: false, outcome: 'active-holder', etag: null, holder}))

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then phase reports held-by-other with holder details
    expect(result).toEqual({outcome: 'held-by-other', holder, reason: 'active-holder'})
  })

  it('returns held-by-other when another Action run holds the lock', async () => {
    // #given another Action run (same surface) holds the lock
    const storeConfig = createStoreConfig()
    const holder = createLockRecord({
      holder_id: 'action:1234:1',
      surface: 'github',
    })
    acquireLockMock.mockResolvedValue(lockOk({acquired: false, outcome: 'active-holder', etag: null, holder}))

    // #when running acquire-lock phase from a different Action run
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 2,
      logger: createMockLogger(),
    })

    // #then same skip path applies — no special handling for same-surface contention
    expect(result).toEqual({outcome: 'held-by-other', holder, reason: 'active-holder'})
  })

  it('returns held-by-other with null holder when stale-takeover race lost', async () => {
    // #given the lock was stale but another caller won the takeover write
    const storeConfig = createStoreConfig()
    acquireLockMock.mockResolvedValue(lockOk({acquired: false, outcome: 'conflict', etag: null, holder: null}))

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then phase reports held-by-other with no holder context
    expect(result).toEqual({outcome: 'held-by-other', holder: null, reason: 'conflict'})
  })

  it('returns error when acquireLock fails (S3 unavailable)', async () => {
    // #given S3 is unavailable
    const storeConfig = createStoreConfig()
    const networkError = new Error('connection refused')
    acquireLockMock.mockResolvedValue(lockErr(networkError))

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then phase reports error with the underlying cause; the caller fails closed (S3 is configured)
    expect(result).toEqual({outcome: 'error', error: networkError})
  })

  it('returns error when acquireLock returns err (e.g. adapter returned no usable ETag)', async () => {
    // #given acquireLock itself returns err — the impossible state {acquired:true, etag:null}
    //        is now prevented at the source; the harness maps any err Result to outcome:'error'
    const storeConfig = createStoreConfig()
    acquireLockMock.mockResolvedValue(lockErr(new Error('Lock acquisition succeeded without a usable ETag')))

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5678',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then phase reports error — releasing without an etag would be unsafe
    expect(result.outcome).toBe('error')
    const errorMessage = result.outcome === 'error' ? result.error.message : ''
    expect(errorMessage).toContain('usable ETag')
  })
})

describe('runAcquireLock lease renewal (plan Unit 12)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    renewLeaseMock.mockResolvedValue(ok({etag: '"etag-renewed"'}))
    acquireLockMock.mockResolvedValue(
      lockOk({acquired: true, outcome: 'acquired', etag: '"etag-initial"', holder: null}),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renews the lease periodically and advances currentEtag on a successful tick', async () => {
    // #given a lock acquired successfully
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '1111',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when the renewal interval fires
    await vi.advanceTimersByTimeAsync(30_000)

    // #then a renewal tick ran and the confirmed ETag advanced
    expect(renewLeaseMock).toHaveBeenCalledTimes(1)
    expect(result.renewal.hasFailed()).toBe(false)
    expect(result.renewal.currentEtag()).toBe('"etag-renewed"')

    await result.renewal.stop()
  })

  it('renews on the Action lock key, not the gateway repo key', async () => {
    // #given a lock acquired successfully
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '1111',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when the renewal interval fires
    await vi.advanceTimersByTimeAsync(30_000)

    // #then renewLease receives the Action scope as its trailing argument
    expect(renewLeaseMock.mock.calls[0]?.[5]).toBe('action')

    await result.renewal.stop()
  })

  it('a failed lease renewal fails closed: hasFailed() becomes true without stopping the timer', async () => {
    // #given a lock acquired successfully, but the object store rejects renewal (e.g.
    // another surface already took over the lock record)
    renewLeaseMock.mockResolvedValueOnce(err(new Error('precondition failed')))
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '2222',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when the renewal interval fires and the tick fails
    await vi.advanceTimersByTimeAsync(30_000)

    // #then hasFailed() reports the failure WITHOUT the caller stopping the timer --
    // renewal must keep running through persistence, so a caller checks this by peeking,
    // not by stopping first
    expect(result.renewal.hasFailed()).toBe(true)
    // #and the last confirmed ETag is unchanged -- the failed tick never advanced it
    expect(result.renewal.currentEtag()).toBe('"etag-initial"')

    // #when a later tick succeeds
    renewLeaseMock.mockResolvedValueOnce(ok({etag: '"etag-recovered"'}))
    await vi.advanceTimersByTimeAsync(30_000)

    // #then hasFailed() reflects the most recent tick, not history
    expect(result.renewal.hasFailed()).toBe(false)
    expect(result.renewal.currentEtag()).toBe('"etag-recovered"')

    await result.renewal.stop()
  })

  it('latches continuityUnverified() on a renewal failure and does not clear it on a later success', async () => {
    // #given a lock acquired successfully, but the first renewal tick fails
    renewLeaseMock.mockResolvedValueOnce(err(new Error('precondition failed')))
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '6666',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when the renewal interval fires and the tick fails
    await vi.advanceTimersByTimeAsync(30_000)

    // #then the latched accessor records the uncertainty
    expect(result.renewal.continuityUnverified?.()).toBe(true)

    // #when a later tick succeeds
    renewLeaseMock.mockResolvedValueOnce(ok({etag: '"etag-recovered"'}))
    await vi.advanceTimersByTimeAsync(30_000)

    // #then hasFailed() (present-tick health) goes back to false, exactly as before ...
    expect(result.renewal.hasFailed()).toBe(false)
    // #then ... but continuityUnverified() stays latched -- the earlier gap in coverage is a
    // fact about this invocation, not erased by a later confirmed renewal
    expect(result.renewal.continuityUnverified?.()).toBe(true)
    // #and the later success still advances the stored etag -- release needs the freshest one
    expect(result.renewal.currentEtag()).toBe('"etag-recovered"')

    await result.renewal.stop()
  })

  it('has no uncertainty at all when every renewal tick has succeeded', async () => {
    // #given a lock acquired successfully and every renewal tick succeeding
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '7777',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when a renewal tick fires and succeeds
    await vi.advanceTimersByTimeAsync(30_000)

    // #then neither present-tick health nor the latched accessor report any problem
    expect(result.renewal.hasFailed()).toBe(false)
    expect(result.renewal.continuityUnverified?.()).toBe(false)

    await result.renewal.stop()
  })

  it('a run that never acquired a lock has no renewal controller and therefore no uncertainty (fail-open)', async () => {
    // #given the object store is disabled -- coordination is opt-in
    const storeConfig = createStoreConfig({enabled: false})

    // #when running acquire-lock phase
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '8888',
      runAttempt: 1,
      logger: createMockLogger(),
    })

    // #then the phase short-circuits before any lease controller exists -- there is nothing to
    // ask about renewal health or coverage uncertainty, and this must not be misread as either
    expect(result).toEqual({outcome: 's3-disabled'})
    expect('renewal' in result).toBe(false)
  })

  it('stop() clears the timer so no further renewal ticks occur', async () => {
    // #given a lock acquired successfully
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '3333',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when stopped before any tick fires
    await result.renewal.stop()
    await vi.advanceTimersByTimeAsync(60_000)

    // #then no renewal call was ever made
    expect(renewLeaseMock).not.toHaveBeenCalled()
  })

  it('stop() returns within its grace period when a renewal is hung', async () => {
    // #given a renewal call that never settles (e.g. a stalled network request)
    renewLeaseMock.mockReturnValue(new Promise(() => {}))
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '4444',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when the renewal interval fires, starting the hung tick
    await vi.advanceTimersByTimeAsync(30_000)
    expect(renewLeaseMock).toHaveBeenCalledTimes(1)

    // #and stop() is called while that tick is still in flight
    const stopPromise = result.renewal.stop()

    // #then stop() settles at its own grace period (5s) -- well before the renewal's own
    // 10s timeout would otherwise bound it -- so cleanup never blocks on a stalled call
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(stopPromise).resolves.toBeUndefined()

    // #then returning with that tick still unresolved is itself uncertainty, not a pass --
    // stop() cannot say whether the hung tick eventually would have succeeded or failed
    expect(result.renewal.continuityUnverified?.()).toBe(true)
  })

  it('a renewal that exceeds its own timeout marks the controller failed', async () => {
    // #given a renewal call that never settles
    renewLeaseMock.mockReturnValue(new Promise(() => {}))
    const storeConfig = createStoreConfig()
    const result = await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '5555',
      runAttempt: 1,
      logger: createMockLogger(),
    })
    if (result.outcome !== 'acquired') throw new Error('expected acquired outcome')

    // #when the renewal interval fires
    await vi.advanceTimersByTimeAsync(30_000)

    // #then hasFailed() is still false -- the renewal's own timeout has not elapsed yet
    expect(result.renewal.hasFailed()).toBe(false)

    // #when the renewal's own timeout (10s) elapses without the call settling
    await vi.advanceTimersByTimeAsync(10_000)

    // #then the timed-out renewal is treated as a failure, same as a rejected/failed tick --
    // this is exactly the case where a caller about to persist state must decline
    expect(result.renewal.hasFailed()).toBe(true)

    await vi.advanceTimersByTimeAsync(5_000)
  })
})

describe('parseActionHolderRunId', () => {
  it.each([
    ['action:1234:1', '1234'],
    ['action:1234:12', '1234'],
    ['action:abc:1', null],
    ['action:1234', null],
    ['gateway:instance-1:run-99', null],
    ['action:1:2:build', '1'],
    ['action:1234:3:build-m1a2b3c4d', '1234'],
    ['action:1:2:3', '1'],
    ['action:1:2:bad id', null],
    ['action:1:2:', null],
    ['action:1:2:a:b', null],
  ])('maps %j to %j', (holderId, expected) => {
    // #given a holder id read from S3 (untrusted)
    // #when parsed
    // #then only well-formed Action ids with a numeric run id yield a run id
    expect(parseActionHolderRunId(holderId)).toBe(expected)
  })
})

type TakeoverPredicate = (holder: LockRecord, observedAt: Date) => boolean

async function predicateFor(runId: string, runAttempt: number, jobIdentity: string | null): Promise<TakeoverPredicate> {
  const result = await runAcquireLock({
    storeConfig: createStoreConfig(),
    repo: 'fro-bot/agent',
    runId,
    runAttempt,
    jobIdentity,
    logger: createMockLogger(),
  })
  if (result.outcome === 'acquired') await result.renewal.stop()
  const options = acquireLockMock.mock.calls[0]?.[6] as {reclaimableBeforeExpiry: TakeoverPredicate}
  return options.reclaimableBeforeExpiry
}

describe('runAcquireLock same-run takeover predicate', () => {
  const now = new Date('2026-04-25T12:10:00.000Z')
  const unrenewedFor = (ms: number) => new Date(now.getTime() - ms).toISOString()

  beforeEach(() => {
    vi.clearAllMocks()
    renewLeaseMock.mockResolvedValue(ok({etag: '"etag-renewed"'}))
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, outcome: 'acquired', etag: '"etag"', holder: null}))
  })

  it('pins the staleness threshold to three heartbeat intervals', () => {
    // #given the heartbeat interval the lease timer actually uses
    // #then the takeover threshold derives from it instead of a hard-coded number
    expect(SAME_RUN_TAKEOVER_MIN_UNRENEWED_MS).toBe(3 * DEFAULT_HEARTBEAT_INTERVAL_MS)
  })

  it.each([
    ['a stale earlier attempt of the same run and job', 'action:1234:1:build', 'github', 120_000, true],
    ['the immediately preceding attempt, stale', 'action:1234:2:build', 'github', 120_000, true],
    ['a matrix leg when this invocation is the plain job', 'action:1234:1:build-m1a2b3c4d', 'github', 120_000, false],
    ['exactly at the staleness boundary', 'action:1234:1:build', 'github', SAME_RUN_TAKEOVER_MIN_UNRENEWED_MS, true],
    [
      '1ms inside the staleness boundary',
      'action:1234:1:build',
      'github',
      SAME_RUN_TAKEOVER_MIN_UNRENEWED_MS - 1,
      false,
    ],
    ['an earlier attempt renewed recently', 'action:1234:1:build', 'github', 30_000, false],
    ['a lease stamped in the future', 'action:1234:1:build', 'github', -60_000, false],
    ['a legacy 3-segment holder', 'action:1234:1', 'github', 120_000, false],
    ['a sibling job in the same run', 'action:1234:1:test', 'github', 120_000, false],
    ['another matrix leg of the same job', 'action:1234:1:build-m99999999', 'github', 120_000, false],
    ['the same attempt', 'action:1234:3:build', 'github', 120_000, false],
    ['a later attempt', 'action:1234:4:build', 'github', 120_000, false],
    ['a different run', 'action:9999:1:build', 'github', 120_000, false],
    ['an unparseable holder', 'action:1234:abc:build', 'github', 120_000, false],
    ['a holder with an unsafe identity', 'action:1234:1:bu ild', 'github', 120_000, false],
    ['a zero attempt', 'action:1234:0:build', 'github', 120_000, false],
    ['a gateway holder id', 'gateway:instance-1:run-99', 'github', 120_000, false],
    ['an Action-shaped id on a non-github surface', 'action:1234:1:build', 'discord', 120_000, false],
  ] as const)('%s → %s', async (_label, holderId, surface, unrenewedMs, expected) => {
    // #given the current invocation is attempt 3 of run 1234, job "build"
    const reclaimable = await predicateFor('1234', 3, 'build')

    // #when the predicate sees the existing holder
    const result = reclaimable(
      createLockRecord({holder_id: holderId, surface, acquired_at: unrenewedFor(unrenewedMs)}),
      now,
    )

    // #then only a stale, strictly earlier attempt of the same run and job on the github surface is reclaimable
    expect(result).toBe(expected)
  })

  it('takes over a stale earlier attempt of the same matrix leg', async () => {
    // #given this invocation is the "build-m1a2b3c4d" matrix leg
    const reclaimable = await predicateFor('1234', 3, 'build-m1a2b3c4d')

    // #when it sees the same leg's earlier attempt, unrenewed for two minutes
    const result = reclaimable(
      createLockRecord({
        holder_id: 'action:1234:1:build-m1a2b3c4d',
        surface: 'github',
        acquired_at: unrenewedFor(120_000),
      }),
      now,
    )

    // #then
    expect(result).toBe(true)
  })

  it('does not take over when the last-renewed timestamp is unreadable', async () => {
    // #given a holder whose timestamp cannot be parsed
    const reclaimable = await predicateFor('1234', 3, 'build')

    // #when
    const result = reclaimable(
      createLockRecord({holder_id: 'action:1234:1:build', surface: 'github', acquired_at: 'not-a-date'}),
      now,
    )

    // #then it falls back to normal expiry
    expect(result).toBe(false)
  })

  it('never takes over early when this invocation has no job identity', async () => {
    // #given a legacy-form invocation
    const reclaimable = await predicateFor('1234', 3, null)

    // #when it sees an otherwise eligible holder
    const result = reclaimable(
      createLockRecord({holder_id: 'action:1234:1:build', surface: 'github', acquired_at: unrenewedFor(120_000)}),
      now,
    )

    // #then
    expect(result).toBe(false)
  })
})

describe('runAcquireLock holder id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    renewLeaseMock.mockResolvedValue(ok({etag: '"etag-renewed"'}))
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, outcome: 'acquired', etag: '"etag"', holder: null}))
  })

  it.each([
    ['a job identity', 'build', 'action:99999:3:build'],
    ['a matrix-leg identity', 'build-m1a2b3c4d', 'action:99999:3:build-m1a2b3c4d'],
    ['no identity', null, 'action:99999:3'],
    ['an identity with unsafe characters', 'a:b c', 'action:99999:3'],
  ])('is job-qualified with %s', async (_label, jobIdentity, expected) => {
    // #when
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '99999',
      runAttempt: 3,
      jobIdentity,
      logger: createMockLogger(),
    })
    if (result.outcome === 'acquired') await result.renewal.stop()

    // #then the same id is used for the lock and for the post-hook record
    expect(acquireLockMock.mock.calls[0]?.[2]).toBe(expected)
    expect(core.saveState).toHaveBeenCalledWith(STATE_KEYS.LOCK_HOLDER_ID, expected)
  })
})

describe('runAcquireLock holder state handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    renewLeaseMock.mockResolvedValue(ok({etag: '"etag-renewed"'}))
  })

  it('records the holder id for the post hook once the lock is acquired', async () => {
    // #given
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, outcome: 'acquired', etag: '"etag"', holder: null}))

    // #when
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '1234',
      runAttempt: 2,
      logger: createMockLogger(),
    })
    if (result.outcome === 'acquired') await result.renewal.stop()

    // #then
    expect(core.saveState).toHaveBeenCalledWith(STATE_KEYS.LOCK_HOLDER_ID, 'action:1234:2')
  })

  it('releases the lock and fails closed when recording the holder id throws', async () => {
    // #given the lock was acquired but the state write fails
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, outcome: 'acquired', etag: '"etag-new"', holder: null}))
    releaseLockMock.mockResolvedValue(ok(undefined))
    vi.mocked(core.saveState).mockImplementationOnce(() => {
      throw new Error('state file unwritable')
    })

    // #when
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '1234',
      runAttempt: 2,
      logger: createMockLogger(),
    })

    // #then the run does not proceed holding an unrecorded lock, and the fresh etag is released on the Action scope
    expect(result).toEqual({outcome: 'error', error: new Error('state file unwritable')})
    expect(releaseLockMock).toHaveBeenCalledWith(
      expect.objectContaining({lockTtlSeconds: 900}),
      'fro-bot/agent',
      '"etag-new"',
      expect.anything(),
      'action',
    )
  })

  it('still fails closed when the best-effort release also fails', async () => {
    // #given
    acquireLockMock.mockResolvedValue(lockOk({acquired: true, outcome: 'acquired', etag: '"etag-new"', holder: null}))
    releaseLockMock.mockRejectedValue(new Error('network down'))
    vi.mocked(core.saveState).mockImplementationOnce(() => {
      throw new Error('state file unwritable')
    })

    // #when
    const result = await runAcquireLock({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      runId: '1234',
      runAttempt: 2,
      logger: createMockLogger(),
    })

    // #then the original failure is reported, not the release failure
    expect(result).toEqual({outcome: 'error', error: new Error('state file unwritable')})
  })

  it.each([
    [
      'held by another',
      lockOk({acquired: false, outcome: 'active-holder', etag: null, holder: createLockRecord()}),
      createStoreConfig(),
    ],
    ['an acquisition error', lockErr(new Error('boom')), createStoreConfig()],
    ['S3 disabled', lockErr(new Error('unused')), createStoreConfig({enabled: false})],
  ])('records nothing when %s', async (_label, acquireResult, storeConfig) => {
    // #given
    acquireLockMock.mockResolvedValue(acquireResult)

    // #when
    await runAcquireLock({
      storeConfig,
      repo: 'fro-bot/agent',
      runId: '1234',
      runAttempt: 2,
      logger: createMockLogger(),
    })

    // #then
    expect(core.saveState).not.toHaveBeenCalled()
  })
})

describe('releaseActionLockIfHeld', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('releases on the Action scope by holder id', async () => {
    // #given
    releaseLockIfHolderMock.mockResolvedValue(ok('released'))

    // #when
    const result = await releaseActionLockIfHeld({
      storeConfig: createStoreConfig(),
      repo: 'fro-bot/agent',
      holderId: 'action:1234:1',
      logger: createMockLogger(),
    })

    // #then
    expect(result).toEqual(ok('released'))
    expect(releaseLockIfHolderMock).toHaveBeenCalledWith(
      expect.objectContaining({lockTtlSeconds: 900}),
      'fro-bot/agent',
      'action:1234:1',
      expect.any(Object),
      'action',
    )
  })
})
