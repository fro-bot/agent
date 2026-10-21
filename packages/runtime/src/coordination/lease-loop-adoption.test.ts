import type {Result} from '../shared/types.js'
import type {LeaseLoopOptions, LeaseLoopStopError, LeaseRenew, LeaseTickContext} from './lease-loop.js'
import type {LockRecord} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {createLeaseLoop} from './lease-loop.js'

const INTERVAL_MS = 30_000
const TICK_TIMEOUT_MS = 10_000
const STOP_BUDGET_MS = 5_000
const CONTEXT = {repo: 'owner/repo', holderId: 'holder-1'}

const RECORD: LockRecord = {
  repo: 'owner/repo',
  holder_id: 'holder-1',
  surface: 'github',
  acquired_at: '2026-04-24T18:15:00.000Z',
  ttl_seconds: 900,
  run_id: 'run-1',
}

type Renewal = Promise<Result<{readonly etag: string}, Error>>
type Adopted = {readonly etag: string} | null

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return {promise, resolve}
}

const hang = async <T>(): Promise<T> => new Promise<T>(() => {})

function stopFailure<T>(result: Result<T, LeaseLoopStopError>): LeaseLoopStopError {
  if (result.success) throw new Error('expected stop() to fail')
  return result.error
}

/**
 * A loop whose renewals follow `script` (by 1-based call number) and whose adoption read is `adopt`. The default tick
 * renews once and lets a failure propagate.
 */
function setup(
  options: {
    readonly script?: (n: number, signal: AbortSignal | undefined) => Renewal
    readonly adopt?: (signal: AbortSignal | undefined) => Promise<Adopted>
    readonly overrides?: Partial<LeaseLoopOptions<string>>
  } = {},
) {
  const logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn()}
  let calls = 0
  const renew = vi.fn<LeaseRenew>(async (_record, _etag, signal) => {
    calls += 1
    return options.script === undefined ? ok({etag: `etag-${calls}`}) : options.script(calls, signal)
  })
  const adopt = vi.fn<(signal?: AbortSignal) => Promise<Adopted>>(async signal =>
    options.adopt === undefined ? null : options.adopt(signal),
  )
  const loop = createLeaseLoop<string>({
    renew,
    initialEtag: 'etag-0',
    intervalMs: INTERVAL_MS,
    tickTimeoutMs: TICK_TIMEOUT_MS,
    stopBudgetMs: STOP_BUDGET_MS,
    unref: false,
    abortOnDeadline: true,
    tick: async ctx => {
      await ctx.renewLock(RECORD)
    },
    adopt,
    logger,
    logContext: CONTEXT,
    ...options.overrides,
  })
  return {loop, renew, adopt, logger}
}

/** A tick that timed out before its renewal confirmed: the commit may have happened. */
async function droppedCommittedRenewal(adopt: (signal: AbortSignal | undefined) => Promise<Adopted>) {
  const logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn()}
  const loop = createLeaseLoop<string>({
    renew: async () => hang(),
    initialEtag: 'etag-0',
    intervalMs: INTERVAL_MS,
    tickTimeoutMs: TICK_TIMEOUT_MS,
    stopBudgetMs: STOP_BUDGET_MS,
    unref: false,
    abortOnDeadline: true,
    tick: async ctx => {
      await ctx.renewLock(RECORD)
    },
    adopt: vi.fn(async (signal?: AbortSignal) => adopt(signal)),
    logger,
    logContext: CONTEXT,
  })
  loop.start()
  await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS)
  return {loop, logger}
}

describe('lease loop adoption', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('after a renewal fails inside a tick', () => {
    it('adopts the stored ETag when the record is ours and differs: no failure, latch kept, info logged', async () => {
      // #given the renewal committed server-side but came back as an error
      const {loop, adopt, logger} = setup({
        script: async () => err(new Error('412 precondition failed')),
        adopt: async () => ({etag: 'etag-committed'}),
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(adopt).toHaveBeenCalledTimes(1)
      expect(loop.currentEtag()).toBe('etag-committed')
      expect(loop.hasFailed()).toBe(false)
      expect(loop.continuityUnverified()).toBe(true)
      expect(logger.warning).not.toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledTimes(1)
      expect(logger.info).toHaveBeenCalledWith('Coordination lease ETag adopted after a renewal outcome was lost', {
        ...CONTEXT,
        etag: 'etag-committed',
      })
    })

    it('hands the adoption read the attempt signal, and none when abortOnDeadline is off', async () => {
      // #given
      const signals: (AbortSignal | undefined)[] = []
      const on = setup({
        script: async () => err(new Error('412')),
        adopt: async signal => {
          signals.push(signal)
          return null
        },
      })
      const off = setup({
        script: async () => err(new Error('412')),
        adopt: async signal => {
          signals.push(signal)
          return null
        },
        overrides: {abortOnDeadline: false},
      })
      on.loop.start()
      off.loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(signals[0]).toBeInstanceOf(AbortSignal)
      expect(signals[1]).toBeUndefined()
    })

    it('adopts after a thrown renewal too', async () => {
      // #given
      const {loop} = setup({
        script: async () => Promise.reject(new Error('socket hang up')),
        adopt: async () => ({etag: 'etag-committed'}),
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(loop.currentEtag()).toBe('etag-committed')
      expect(loop.hasFailed()).toBe(false)
    })

    it('changes nothing when the stored record is ours but the ETag is the one we hold (not committed)', async () => {
      // #given
      const {loop, logger} = setup({
        script: async () => err(new Error('503')),
        adopt: async () => ({etag: 'etag-0'}),
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then the failure stands
      expect(loop.currentEtag()).toBe('etag-0')
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal failed', {...CONTEXT, error: '503'})
      expect(logger.info).not.toHaveBeenCalled()
    })

    it('changes nothing when the record is not ours (adopt reports null), e.g. a 412 against a successor', async () => {
      // #given
      const {loop, logger} = setup({script: async () => err(new Error('412')), adopt: async () => null})
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(loop.currentEtag()).toBe('etag-0')
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
      expect(logger.warning).toHaveBeenCalledTimes(1)
    })

    it('changes nothing when the read fails, and sets the latch', async () => {
      // #given
      const {loop, logger} = setup({
        script: async () => err(new Error('412')),
        adopt: async () => Promise.reject(new Error('read failed')),
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then the original failure is what is reported
      expect(loop.currentEtag()).toBe('etag-0')
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal failed', {...CONTEXT, error: '412'})
    })

    it('is bounded by the tick timeout when the read hangs: no adoption, the read is aborted, settle returns', async () => {
      // #given a read that never settles
      const signals: (AbortSignal | undefined)[] = []
      const {loop, logger} = setup({
        script: async () => err(new Error('412')),
        adopt: async signal => {
          signals.push(signal)
          return hang<Adopted>()
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(signals[0]?.aborted).toBe(false)

      // #when settle waits and the tick timeout elapses
      const settled = loop.settle()
      await vi.advanceTimersByTimeAsync(TICK_TIMEOUT_MS)
      await settled

      // #then
      expect(signals[0]?.aborted).toBe(true)
      expect(loop.currentEtag()).toBe('etag-0')
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {
        ...CONTEXT,
        error: 'Lease renewal exceeded 10000ms',
      })
    })

    it('does not apply an adoption that resolves after its tick timed out', async () => {
      // #given
      const read = deferred<Adopted>()
      const {loop} = setup({script: async () => err(new Error('412')), adopt: async () => read.promise})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS)

      // #when the abandoned read finally resolves with an ETag that is ours
      read.resolve({etag: 'etag-late'})
      await vi.advanceTimersByTimeAsync(0)

      // #then
      expect(loop.currentEtag()).toBe('etag-0')
      expect(loop.hasFailed()).toBe(true)
    })

    it('does not read when stop began before the renewal failed; the stop path reads instead', async () => {
      // #given a renewal in flight when stop begins, which then fails
      const renewal = deferred<Result<{readonly etag: string}, Error>>()
      const {loop, adopt} = setup({
        script: async () => renewal.promise,
        adopt: async () => ({etag: 'etag-committed'}),
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const stopped = loop.stop()
      renewal.resolve(err(new Error('412')))
      const failure = stopFailure(await stopped)

      // #then exactly one read ran (the stop path's) and its ETag is what stop reports
      expect(adopt).toHaveBeenCalledTimes(1)
      expect(failure.lockEtag).toBe('etag-committed')
    })

    it('applies an adoption that lands inside the stop budget when stop began during the read', async () => {
      // #given the in-tick read is in flight when stop begins
      const read = deferred<Adopted>()
      const {loop} = setup({script: async () => err(new Error('412')), adopt: async () => read.promise})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when stop begins, and the read lands 1 s later
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(1_000)
      read.resolve({etag: 'etag-committed'})
      const result = await stopped

      // #then the tick ended adopted, so stop has nothing to report as failed
      expect(result.success).toBe(true)
      expect(result.success ? result.data.lockEtag : '').toBe('etag-committed')
    })

    it('gives no adoption once the stop budget runs out during the read, and aborts the read then', async () => {
      // #given a read that never settles, under a tick timeout longer than the budget
      const signals: (AbortSignal | undefined)[] = []
      const {loop} = setup({
        script: async () => err(new Error('412')),
        adopt: async signal => {
          signals.push(signal)
          return hang<Adopted>()
        },
        overrides: {tickTimeoutMs: 60_000},
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS - 1)
      expect(signals[0]?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const failure = stopFailure(await stopped)

      // #then
      expect(signals[0]?.aborted).toBe(true)
      expect(failure.tickPending).toBe(true)
      expect(failure.lockEtag).toBe('etag-0')
    })

    it('counts a swallowed renewal failure the same way: adopted, latch kept', async () => {
      // #given a body that catches the failure and returns
      const {loop, logger} = setup({
        script: async () => err(new Error('412')),
        adopt: async () => ({etag: 'etag-committed'}),
        overrides: {
          tick: async (ctx: LeaseTickContext) => {
            try {
              await ctx.renewLock(RECORD)
            } catch {
              // Swallowed on purpose.
            }
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(loop.currentEtag()).toBe('etag-committed')
      expect(loop.hasFailed()).toBe(false)
      expect(loop.continuityUnverified()).toBe(true)
      expect(logger.warning).not.toHaveBeenCalled()
    })

    it('still fails the tick when the body throws something else after an adopted failure', async () => {
      // #given
      const {loop} = setup({
        script: async () => err(new Error('412')),
        adopt: async () => ({etag: 'etag-committed'}),
        overrides: {
          tick: async (ctx: LeaseTickContext) => {
            try {
              await ctx.renewLock(RECORD)
            } catch {
              throw new Error('run state write failed')
            }
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then the adopted ETag stands, but the tick did fail
      expect(loop.currentEtag()).toBe('etag-committed')
      expect(loop.hasFailed()).toBe(true)
    })

    it('never reads when no adopt function was given', async () => {
      // #given
      const {loop, logger} = setup({script: async () => err(new Error('412')), overrides: {adopt: undefined}})
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(loop.hasFailed()).toBe(true)
      expect(logger.info).not.toHaveBeenCalled()
    })
  })

  describe('a renewal dropped by the tick timeout that committed server-side', () => {
    it('recovers: the next renewal 412s, adoption takes the stored ETag, and the tick after renews', async () => {
      // #given S3 committed renewal 1 (ETag etag-committed) but the call outlived the tick timeout; later calls check
      // the ETag they are given the way If-Match does
      const committed = 'etag-committed'
      const renewAgainst: string[] = []
      const logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn()}
      let calls = 0
      const renew = vi.fn<LeaseRenew>(async (_record, etag) => {
        calls += 1
        renewAgainst.push(etag)
        if (calls === 1) return hang()
        return etag === committed ? ok({etag: `etag-after-${calls}`}) : err(new Error('412 precondition failed'))
      })
      const recovering = createLeaseLoop<string>({
        renew,
        initialEtag: 'etag-0',
        intervalMs: INTERVAL_MS,
        tickTimeoutMs: TICK_TIMEOUT_MS,
        stopBudgetMs: STOP_BUDGET_MS,
        unref: false,
        abortOnDeadline: true,
        tick: async ctx => {
          await ctx.renewLock(RECORD)
        },
        adopt: async () => ({etag: committed}),
        logger,
        logContext: CONTEXT,
      })
      recovering.start()

      // #when tick 1 times out, tick 2 hits the dead ETag, tick 3 runs
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)

      // #then
      expect(renewAgainst).toEqual(['etag-0', 'etag-0', committed])
      expect(recovering.hasFailed()).toBe(false)
      expect(recovering.currentEtag()).toBe('etag-after-3')
      expect(recovering.continuityUnverified()).toBe(true)
    })

    it('converges after a late commit following an adoption: the next tick 412s and adopts again', async () => {
      // #given tick 1 adopts E1; a straggler then commits E2 behind our back, so tick 2 412s against E1
      const stored = {etag: 'E1'}
      let calls = 0
      const {loop} = setup({
        script: async n => {
          calls = n
          return err(new Error('412'))
        },
        adopt: async () => ({etag: stored.etag}),
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(loop.currentEtag()).toBe('E1')
      stored.etag = 'E2'

      // #when the next tick fails and adopts again
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(calls).toBe(2)
      expect(loop.currentEtag()).toBe('E2')
      expect(loop.hasFailed()).toBe(false)
    })
  })

  describe('on the stop path', () => {
    it('reads once after a dropped committed renewal and reports the adopted ETag on the error', async () => {
      // #given the renewal committed but timed out
      const reads: (AbortSignal | undefined)[] = []
      const {loop} = await droppedCommittedRenewal(async signal => {
        reads.push(signal)
        return {etag: 'etag-committed'}
      })

      // #when
      const failure = stopFailure(await loop.stop())

      // #then stop still reports the failed tick, but release can use the stored ETag
      expect(reads).toHaveLength(1)
      expect(reads[0]).toBeInstanceOf(AbortSignal)
      expect(failure.message).toBe('Lease renewal exceeded 10000ms')
      expect(failure.lockEtag).toBe('etag-committed')
      expect(failure.tickPending).toBe(false)
      expect(loop.currentEtag()).toBe('etag-committed')
    })

    it.each([
      ['the read fails', async () => Promise.reject(new Error('read failed'))],
      ['the record is not ours', async () => null],
      ['the stored ETag is the one held', async () => ({etag: 'etag-0'})],
    ])('leaves the ETag alone when %s', async (_label, adopt) => {
      // #given
      const {loop} = await droppedCommittedRenewal(adopt)

      // #when
      const failure = stopFailure(await loop.stop())

      // #then
      expect(failure.lockEtag).toBe('etag-0')
      expect(failure.message).toBe('Lease renewal exceeded 10000ms')
    })

    it('resolves within the budget when the read never settles, aborting it then', async () => {
      // #given
      const signals: (AbortSignal | undefined)[] = []
      const {loop} = await droppedCommittedRenewal(async signal => {
        signals.push(signal)
        return hang<Adopted>()
      })
      const startedAt = Date.now()

      // #when
      let resolvedAt = 0
      const stopped = loop.stop().then(result => {
        resolvedAt = Date.now()
        return result
      })
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS - 1)
      expect(signals[0]?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const failure = stopFailure(await stopped)

      // #then
      expect(resolvedAt - startedAt).toBe(STOP_BUDGET_MS)
      expect(signals[0]?.aborted).toBe(true)
      expect(failure.lockEtag).toBe('etag-0')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('does not read when the lock ETag is certain: no failure, or a failure after a confirmed renewal', async () => {
      // #given one loop that never failed, and one whose RunState-style write failed after a confirmed renewal
      const healthy = setup()
      healthy.loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await healthy.loop.stop()
      const writeFailed = setup({
        overrides: {
          tick: async ctx => {
            await ctx.renewLock(RECORD)
            throw new Error('write failed')
          },
        },
      })
      writeFailed.loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const failure = stopFailure(await writeFailed.loop.stop())

      // #then
      expect(healthy.adopt).not.toHaveBeenCalled()
      expect(writeFailed.adopt).not.toHaveBeenCalled()
      expect(failure.lockEtag).toBe('etag-1')
    })

    it('does not read after a confirmed renewal has settled an earlier doubt', async () => {
      // #given tick 1's renewal failed (the ETag was in doubt), tick 2 confirmed one, and tick 3 failed after its own
      let ticks = 0
      const {loop, adopt} = setup({
        script: async n => (n === 1 ? err(new Error('503')) : ok({etag: `etag-${n}`})),
        overrides: {
          tick: async ctx => {
            ticks += 1
            try {
              await ctx.renewLock(RECORD)
            } catch {
              return
            }
            if (ticks === 3) throw new Error('write failed')
          },
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
      adopt.mockClear()

      // #when
      const failure = stopFailure(await loop.stop())

      // #then the lock ETag is the confirmed one, so there is nothing to look for
      expect(adopt).not.toHaveBeenCalled()
      expect(failure.lockEtag).toBe('etag-3')
    })

    it('does not read when the tick failed before any renewal was sent', async () => {
      // #given
      const {loop, adopt} = setup({
        overrides: {
          tick: async () => {
            throw new Error('read failed')
          },
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const failure = stopFailure(await loop.stop())

      // #then
      expect(adopt).not.toHaveBeenCalled()
      expect(failure.lockEtag).toBe('etag-0')
    })

    it('has no budget left to read when a tick is still pending at the budget, and says so with tickPending', async () => {
      // #given a renewal that hangs through the whole budget
      const {loop, adopt} = setup({script: async () => hang(), overrides: {tickTimeoutMs: 60_000}})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS)
      const failure = stopFailure(await stopped)

      // #then
      expect(adopt).not.toHaveBeenCalled()
      expect(failure.tickPending).toBe(true)
    })

    it('reads with whatever budget a failing pending tick left', async () => {
      // #given a renewal that fails 2 s into stop
      const renewal = deferred<Result<{readonly etag: string}, Error>>()
      const {loop, adopt} = setup({
        script: async () => renewal.promise,
        adopt: async () => ({etag: 'etag-committed'}),
        overrides: {tickTimeoutMs: 60_000},
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(2_000)

      // #when
      renewal.resolve(err(new Error('412')))
      const failure = stopFailure(await stopped)

      // #then the in-tick read was skipped (stop had begun), and the stop path read once in the remaining 3 s
      expect(adopt).toHaveBeenCalledTimes(1)
      expect(failure.lockEtag).toBe('etag-committed')
    })

    it('never rejects, even when the read throws synchronously', async () => {
      // #given
      const {loop} = await droppedCommittedRenewal(() => {
        throw new Error('sync throw')
      })

      // #when / #then
      expect(stopFailure(await loop.stop()).lockEtag).toBe('etag-0')
    })
  })
})
