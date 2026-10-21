import type {Result} from '../shared/types.js'
import type {LeaseLoopOptions, LeaseLoopStopError, LeaseRenew, LeaseTickContext} from './lease-loop.js'
import type {LockRecord} from './types.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {err, ok} from '../shared/types.js'
import {createLeaseLoop} from './lease-loop.js'

const INTERVAL_MS = 30_000
const TICK_TIMEOUT_MS = 10_000
const STOP_BUDGET_MS = 5_000
// Typed `unknown` so rejecting with it is allowed: the loop must cope with rejections that are not Errors.
const NON_ERROR: unknown = 'not an error'
const CONTEXT = {repo: 'owner/repo', holderId: 'holder-1'}

const RECORD: LockRecord = {
  repo: 'owner/repo',
  holder_id: 'holder-1',
  surface: 'github',
  acquired_at: '2026-04-24T18:15:00.000Z',
  ttl_seconds: 900,
  run_id: 'run-1',
}

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

type Renewal = Promise<Result<{readonly etag: string}, Error>>

function createLogger() {
  return {debug: vi.fn(), info: vi.fn(), warning: vi.fn()}
}

/** Builds a loop whose default tick renews once. `script` decides each renewal's outcome by its 1-based call number. */
function setup(
  options: {
    readonly script?: (n: number, signal: AbortSignal | undefined) => Renewal
    readonly overrides?: Partial<LeaseLoopOptions<string>>
  } = {},
) {
  const logger = createLogger()
  let calls = 0
  const renew = vi.fn<LeaseRenew>(async (_record, _etag, signal) => {
    calls += 1
    return options.script === undefined ? ok({etag: `etag-${calls}`}) : options.script(calls, signal)
  })
  const loop = createLeaseLoop<string>({
    renew,
    initialEtag: 'etag-0',
    intervalMs: INTERVAL_MS,
    tickTimeoutMs: TICK_TIMEOUT_MS,
    stopBudgetMs: STOP_BUDGET_MS,
    unref: false,
    abortOnDeadline: false,
    tick: async ctx => {
      await ctx.renewLock(RECORD)
    },
    logger,
    logContext: CONTEXT,
    ...options.overrides,
  })
  return {loop, renew, logger}
}

/** Collects process-level unhandled rejections for the duration of one test. */
function trackUnhandledRejections() {
  const seen: unknown[] = []
  const listener = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on('unhandledRejection', listener)
  return {
    seen,
    // Unhandled rejections surface on a real event-loop turn, which fake timers would hide.
    settle: async () => {
      vi.useRealTimers()
      await new Promise(resolve => setTimeout(resolve, 5))
      process.off('unhandledRejection', listener)
    },
  }
}

function throwingLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(() => {
      throw new Error('log sink down')
    }),
  }
}

/** Records every `setTimeout` handle in creation order, so a test can look at one timer's ref state. */
function trackTimeoutHandles() {
  const handles: {hasRef: () => boolean}[] = []
  const realSetTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args)
    handles.push(handle)
    return handle
  })
  return handles
}

function stopFailure<T>(result: Result<T, LeaseLoopStopError>): LeaseLoopStopError {
  if (result.success) throw new Error('expected stop() to fail')
  return result.error
}

describe('createLeaseLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T18:15:00.000Z'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('scheduling', () => {
    it('ticks every interval and renews against the freshest confirmed ETag', async () => {
      // #given
      const {loop, renew} = setup()

      // #when
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)

      // #then
      expect(loop.isRunning).toBe(true)
      expect(renew.mock.calls.map(call => call[1])).toEqual(['etag-0', 'etag-1'])
      expect(loop.currentEtag()).toBe('etag-2')
    })

    it('starts no tick while one is in flight', async () => {
      // #given a renewal that stays open across several intervals, under a long tick timeout
      const open = deferred<Result<{readonly etag: string}, Error>>()
      const {loop, renew} = setup({
        script: async n => (n === 1 ? open.promise : ok({etag: `etag-${n}`})),
        overrides: {tickTimeoutMs: 1_000_000},
      })
      loop.start()

      // #when three intervals pass
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)

      // #then the overlapping intervals started nothing
      expect(renew).toHaveBeenCalledTimes(1)

      // #when the renewal lands, the next interval ticks again
      open.resolve(ok({etag: 'etag-open'}))
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(renew).toHaveBeenCalledTimes(2)
      expect(renew.mock.calls[1]?.[1]).toBe('etag-open')
    })

    it('clears the in-flight slot when the tick times out, so the next interval ticks', async () => {
      // #given the first renewal never settles
      const {loop, renew} = setup({script: async n => (n === 1 ? hang() : ok({etag: `etag-${n}`}))})
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)

      // #then the second tick ran against the original ETag
      expect(renew).toHaveBeenCalledTimes(2)
      expect(renew.mock.calls[1]?.[1]).toBe('etag-0')
      expect(loop.currentEtag()).toBe('etag-2')
    })

    it('reports isRunning only between start and stop', async () => {
      // #given
      const {loop} = setup()

      // #then
      expect(loop.isRunning).toBe(false)
      loop.start()
      expect(loop.isRunning).toBe(true)
      await loop.stop()
      expect(loop.isRunning).toBe(false)
    })
  })

  describe('renewLock', () => {
    it('records the new ETag before it resolves and returns renewed', async () => {
      // #given a body that reads the ETag right after renewing
      const seen: {result?: string; etag?: string} = {}
      const {loop} = setup({
        overrides: {
          tick: async ctx => {
            seen.result = await ctx.renewLock(RECORD)
            seen.etag = loop.currentEtag()
          },
        },
      })

      // #when
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(seen).toEqual({result: 'renewed', etag: 'etag-1'})
    })

    it('returns skipped without renewing when stop has begun before the I/O', async () => {
      // #given a body parked before its renewal
      const gate = deferred<undefined>()
      const seen: {result?: string; stopping?: boolean} = {}
      const {loop, renew} = setup({
        overrides: {
          tick: async ctx => {
            await gate.promise
            seen.stopping = ctx.isStopping()
            seen.result = await ctx.renewLock(RECORD)
          },
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when stop begins and then the body proceeds
      const stopped = loop.stop()
      gate.resolve(undefined)
      await stopped

      // #then
      expect(seen).toEqual({result: 'skipped', stopping: true})
      expect(renew).not.toHaveBeenCalled()
      expect(loop.currentEtag()).toBe('etag-0')
    })

    it('returns skipped without renewing once the attempt has timed out', async () => {
      // #given a body parked past its tick timeout
      const gate = deferred<undefined>()
      const seen: {result?: string; current?: boolean} = {}
      const {loop, renew} = setup({
        overrides: {
          tick: async ctx => {
            await gate.promise
            seen.current = ctx.isCurrent()
            seen.result = await ctx.renewLock(RECORD)
          },
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS)

      // #when the abandoned body proceeds
      gate.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)

      // #then
      expect(seen).toEqual({result: 'skipped', current: false})
      expect(renew).not.toHaveBeenCalled()
    })

    it('throws on an err result, so the body never reaches its later I/O, and logs it once', async () => {
      // #given a body with I/O after the renewal
      const after = vi.fn()
      const {loop, logger} = setup({
        script: async () => err(new Error('renewal rejected')),
        overrides: {
          tick: async ctx => {
            await ctx.renewLock(RECORD)
            after()
          },
        },
      })

      // #when
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(after).not.toHaveBeenCalled()
      expect(loop.hasFailed()).toBe(true)
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal failed', {
        ...CONTEXT,
        error: 'renewal rejected',
      })
    })

    it.each([
      ['an Error', new Error('socket hang up'), 'socket hang up'],
      ['a non-Error', 'plain string', 'plain string'],
    ])('throws when the renewal rejects with %s, and logs it as a throw', async (_label, rejection, message) => {
      // #given
      const after = vi.fn()
      const {loop, logger} = setup({
        script: async () => Promise.reject(rejection),
        overrides: {
          tick: async ctx => {
            await ctx.renewLock(RECORD)
            after()
          },
        },
      })

      // #when
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(after).not.toHaveBeenCalled()
      expect(loop.hasFailed()).toBe(true)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {...CONTEXT, error: message})
    })

    it('does not apply a success that arrives after the attempt timed out, and tells the body to drop it', async () => {
      // #given a renewal that outlives the tick timeout; the body gates a follow-up write on isCurrent
      const late = deferred<Result<{readonly etag: string}, Error>>()
      const write = vi.fn()
      const seen: {result?: string} = {}
      const {loop} = setup({
        script: async () => late.promise,
        overrides: {
          tick: async ctx => {
            seen.result = await ctx.renewLock(RECORD)
            if (seen.result === 'renewed' && ctx.isCurrent()) write()
          },
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS)

      // #when the abandoned renewal succeeds
      late.resolve(ok({etag: 'etag-late'}))
      await vi.advanceTimersByTimeAsync(0)

      // #then nothing was applied
      expect(seen.result).toBe('skipped')
      expect(write).not.toHaveBeenCalled()
      expect(loop.currentEtag()).toBe('etag-0')
      expect(loop.hasFailed()).toBe(true)
    })
  })

  describe('failure state', () => {
    it('sets hasFailed on a failed renewal, clears it on a later confirmed one, and leaves the latch set', async () => {
      // #given only the first renewal fails
      const {loop} = setup({script: async n => (n === 1 ? err(new Error('first failed')) : ok({etag: `etag-${n}`}))})
      loop.start()

      // #when the first tick runs
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
      expect(loop.currentEtag()).toBe('etag-0')

      // #when the next tick confirms a renewal
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(loop.hasFailed()).toBe(false)
      expect(loop.continuityUnverified()).toBe(true)
      expect(loop.currentEtag()).toBe('etag-2')
    })

    it('stop returns the last tick failure when no confirmed renewal followed it', async () => {
      // #given
      const {loop} = setup({script: async () => err(new Error('lock renewal failed'))})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const failure = stopFailure(await loop.stop())

      // #then
      expect(failure.message).toBe('lock renewal failed')
      expect(failure.tickPending).toBe(false)
      expect(failure.lockEtag).toBe('etag-0')
    })

    it('a skipped tick changes neither hasFailed nor the stored error', async () => {
      // #given tick 1 fails; tick 2 is parked before its I/O when stop begins
      const gate = deferred<undefined>()
      let ticks = 0
      const {loop, renew} = setup({
        script: async () => err(new Error('first tick failed')),
        overrides: {
          tick: async ctx => {
            ticks += 1
            if (ticks === 2) await gate.promise
            await ctx.renewLock(RECORD)
          },
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)

      // #when stop begins, then tick 2 skips its renewal
      const stopped = loop.stop()
      gate.resolve(undefined)
      const failure = stopFailure(await stopped)

      // #then tick 1's failure is still what is reported
      expect(renew).toHaveBeenCalledTimes(1)
      expect(failure.message).toBe('first tick failed')
      expect(loop.hasFailed()).toBe(true)
    })

    it('a body that finishes without renewing changes nothing', async () => {
      // #given tick 1 fails; tick 2's body returns without calling renewLock
      let ticks = 0
      const {loop} = setup({
        script: async () => err(new Error('first tick failed')),
        overrides: {
          tick: async ctx => {
            ticks += 1
            if (ticks === 1) await ctx.renewLock(RECORD)
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)

      // #then
      expect(ticks).toBe(2)
      expect(loop.hasFailed()).toBe(true)
    })

    it('a body failure after a confirmed renewal sets hasFailed and is reported at stop, without latching', async () => {
      // #given the renewal confirms and the follow-up write then fails
      const {loop, logger} = setup({
        overrides: {
          tick: async ctx => {
            await ctx.renewLock(RECORD)
            throw new Error('run state write failed')
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const failure = stopFailure(await loop.stop())

      // #then the error carries the renewed ETag, and continuity was never in doubt
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(false)
      expect(failure.message).toBe('run state write failed')
      expect(failure.lockEtag).toBe('etag-1')
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease tick failed after renewal', {
        ...CONTEXT,
        error: 'run state write failed',
      })
    })

    it('a body failure before the renewal latches continuity', async () => {
      // #given
      const {loop, logger} = setup({
        overrides: {
          tick: async () => {
            throw new Error('read failed')
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {
        ...CONTEXT,
        error: 'read failed',
      })
    })

    it('a later confirmed renewal clears a post-renewal failure', async () => {
      // #given only the first tick's follow-up fails
      let ticks = 0
      const {loop} = setup({
        overrides: {
          tick: async ctx => {
            ticks += 1
            await ctx.renewLock(RECORD)
            if (ticks === 1) throw new Error('write failed')
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(loop.hasFailed()).toBe(true)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then
      expect(loop.hasFailed()).toBe(false)
      expect(loop.continuityUnverified()).toBe(false)
    })
  })

  describe('tick timeout and late results', () => {
    it('fails the attempt exactly at the tick timeout, latches, and logs the Action message', async () => {
      // #given the first renewal never settles
      const {loop, logger} = setup({script: async () => hang()})
      loop.start()

      // #when 1 ms short of the timeout
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS - 1)

      // #then still in flight
      expect(loop.hasFailed()).toBe(false)
      expect(logger.warning).not.toHaveBeenCalled()

      // #when the timeout elapses
      await vi.advanceTimersByTimeAsync(1)

      // #then
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {
        ...CONTEXT,
        error: 'Lease renewal exceeded 10000ms',
      })
    })

    it('a timeout after a confirmed renewal fails the attempt but does not latch', async () => {
      // #given the renewal confirms and the rest of the body hangs
      const {loop, logger} = setup({
        overrides: {
          tick: async ctx => {
            await ctx.renewLock(RECORD)
            await hang()
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS)

      // #then the renewed ETag stands
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(false)
      expect(loop.currentEtag()).toBe('etag-1')
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease tick failed after renewal', {
        ...CONTEXT,
        error: 'Lease tick exceeded 10000ms',
      })
    })

    it('ignores everything a timed-out attempt does afterwards', async () => {
      // #given a body that throws after its attempt timed out
      const gate = deferred<undefined>()
      const {loop, logger} = setup({
        overrides: {
          tick: async () => {
            await gate.promise
            throw new Error('late body failure')
          },
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS)
      expect(logger.warning).toHaveBeenCalledTimes(1)

      // #when
      gate.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)

      // #then neither the log nor the stored error changed
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(stopFailure(await loop.stop()).message).toBe('Lease renewal exceeded 10000ms')
    })

    it('applies a success that lands after stop returned but before the tick timeout', async () => {
      // #given stop gave up on a pending renewal
      const late = deferred<Result<{readonly etag: string}, Error>>()
      const {loop, logger} = setup({script: async () => late.promise})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS)
      expect(stopFailure(await stopped).tickPending).toBe(true)
      expect(loop.currentEtag()).toBe('etag-0')

      // #when the renewal succeeds at +6 s, inside its 10 s timeout
      await vi.advanceTimersByTimeAsync(1_000)
      late.resolve(ok({etag: 'etag-late'}))
      await vi.advanceTimersByTimeAsync(0)

      // #then stop did not supersede it
      expect(loop.currentEtag()).toBe('etag-late')
      expect(loop.hasFailed()).toBe(false)
      expect(loop.continuityUnverified()).toBe(true)
      await vi.advanceTimersByTimeAsync(TICK_TIMEOUT_MS)
      expect(logger.warning).not.toHaveBeenCalled()
    })

    it('a tick abandoned at stop still times out afterwards and marks the lease failed', async () => {
      // #given stop returned with a hung renewal in flight
      const {loop, logger} = setup({script: async () => hang()})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS)
      await stopped
      expect(loop.hasFailed()).toBe(false)

      // #when its own timeout elapses
      await vi.advanceTimersByTimeAsync(TICK_TIMEOUT_MS - STOP_BUDGET_MS)

      // #then
      expect(loop.hasFailed()).toBe(true)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {
        ...CONTEXT,
        error: 'Lease renewal exceeded 10000ms',
      })
    })
  })

  describe('stop', () => {
    it('returns the lock ETag and no final value at once when nothing is in flight', async () => {
      // #given a loop with no finalize
      const {loop} = setup()
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const result = await loop.stop()

      // #then
      expect(result).toEqual(ok({lockEtag: 'etag-1', final: undefined}))
    })

    it('waits for the in-flight tick, applies its result, then runs finalize', async () => {
      // #given a renewal that lands 1 s into stop
      const events: string[] = []
      const slow = deferred<Result<{readonly etag: string}, Error>>()
      const {loop} = setup({
        script: async () => slow.promise,
        overrides: {
          finalize: async () => {
            events.push(`finalize with ${loop.currentEtag()}`)
            return 'snapshot'
          },
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(1_000)
      events.push('renewal lands')
      slow.resolve(ok({etag: 'etag-slow'}))
      const result = await stopped

      // #then
      expect(events).toEqual(['renewal lands', 'finalize with etag-slow'])
      expect(result).toEqual(ok({lockEtag: 'etag-slow', final: 'snapshot'}))
    })

    it('shares one budget between the pending tick and finalize', async () => {
      // #given a tick that settles 2 s into stop, and a finalize that never does
      const slow = deferred<Result<{readonly etag: string}, Error>>()
      const {loop} = setup({
        script: async () => slow.promise,
        overrides: {finalize: async () => hang<string>()},
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const startedAt = Date.now()

      // #when
      let resolvedAt = 0
      const stopped = loop.stop().then(result => {
        resolvedAt = Date.now()
        return result
      })
      await vi.advanceTimersByTimeAsync(2_000)
      slow.resolve(ok({etag: 'etag-slow'}))
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS - 2_000)
      const failure = stopFailure(await stopped)

      // #then stop resolved 5 s after it began, not 7 s, with the slow renewal's ETag
      expect(resolvedAt - startedAt).toBe(STOP_BUDGET_MS)
      expect(failure.message).toBe('Lease finalize did not settle within 5000ms of stop')
      expect(failure).toMatchObject({lockEtag: 'etag-slow', tickPending: false})
      expect(vi.getTimerCount()).toBe(0)
    })

    it('gives up on a tick still pending when the budget runs out: tickPending, no finalize, continuity latched', async () => {
      // #given
      const finalize = vi.fn(async () => 'snapshot')
      const {loop} = setup({script: async () => hang(), overrides: {finalize}})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      let resolvedAt = 0
      const stopped = loop.stop().then(result => {
        resolvedAt = Date.now()
        return result
      })
      const startedAt = Date.now()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS)
      const failure = stopFailure(await stopped)

      // #then
      expect(resolvedAt - startedAt).toBe(STOP_BUDGET_MS)
      expect(failure.message).toBe('Lease tick did not settle within 5000ms of stop')
      expect(failure).toMatchObject({lockEtag: 'etag-0', tickPending: true})
      expect(finalize).not.toHaveBeenCalled()
      expect(loop.continuityUnverified()).toBe(true)
      expect(loop.hasFailed()).toBe(false)
    })

    it('returns whatever finalize resolves with, even a value that looks like a timeout marker', async () => {
      // #given
      const {loop} = setup({overrides: {finalize: async () => 'elapsed'}})

      // #when
      const result = await loop.stop()

      // #then
      expect(result).toEqual(ok({lockEtag: 'etag-0', final: 'elapsed'}))
    })

    it('skips finalize after a failed tick and returns that tick error', async () => {
      // #given
      const finalize = vi.fn(async () => 'snapshot')
      const {loop} = setup({script: async () => err(new Error('lock renewal failed')), overrides: {finalize}})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const failure = stopFailure(await loop.stop())

      // #then
      expect(failure.message).toBe('lock renewal failed')
      expect(finalize).not.toHaveBeenCalled()
    })

    it('returns a finalize failure as an error carrying the freshest ETag', async () => {
      // #given
      const {loop} = setup({
        overrides: {
          finalize: async () => {
            throw new Error('snapshot unavailable')
          },
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const failure = stopFailure(await loop.stop())

      // #then
      expect(failure.message).toBe('snapshot unavailable')
      expect(failure).toMatchObject({lockEtag: 'etag-1', tickPending: false})
    })

    it.each([
      ['the renewal rejects', {script: async () => Promise.reject(new Error('socket hang up'))}, 'socket hang up'],
      [
        'the body throws',
        {
          overrides: {
            tick: async () => {
              throw new Error('body exploded')
            },
          },
        },
        'body exploded',
      ],
      [
        'finalize rejects',
        {overrides: {finalize: async () => Promise.reject(new Error('finalize rejected'))}},
        'finalize rejected',
      ],
      [
        'finalize throws synchronously',
        {
          overrides: {
            finalize: () => {
              throw new Error('finalize threw')
            },
          },
        },
        'finalize threw',
      ],
      ['finalize throws a non-Error', {overrides: {finalize: async () => Promise.reject(NON_ERROR)}}, 'not an error'],
    ])('never rejects: when %s, stop resolves to an error', async (_label, config, message) => {
      // #given
      const {loop} = setup(config)
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when / #then
      const failure = stopFailure(await loop.stop())
      expect(failure.message).toBe(message)
    })

    it('ignores start after stop: a stopped loop is final, and it logs at debug', async () => {
      // #given
      const {loop, renew, logger} = setup()
      await loop.stop()

      // #when
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4)

      // #then
      expect(loop.isRunning).toBe(false)
      expect(renew).not.toHaveBeenCalled()
      expect(logger.debug).toHaveBeenCalledWith('Ignoring start of a stopped lease loop', CONTEXT)
    })

    it('never ticks again after stop', async () => {
      // #given
      const {loop, renew} = setup()
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await loop.stop()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4)

      // #then
      expect(renew).toHaveBeenCalledTimes(1)
    })

    it('sets stopping before anything else', async () => {
      // #given a body that records isStopping when its renewal is in flight
      const open = deferred<Result<{readonly etag: string}, Error>>()
      let stoppingSeen: boolean | undefined
      const {loop} = setup({
        script: async () => open.promise,
        overrides: {
          tick: async ctx => {
            await ctx.renewLock(RECORD)
            stoppingSeen = ctx.isStopping()
          },
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const stopped = loop.stop()
      open.resolve(ok({etag: 'etag-open'}))
      await stopped

      // #then
      expect(stoppingSeen).toBe(true)
    })
  })

  describe('ETag freshness', () => {
    it('every failure carries the freshest confirmed lock ETag', async () => {
      // #given two good renewals, then a failing body after a third
      let ticks = 0
      const {loop} = setup({
        overrides: {
          tick: async ctx => {
            ticks += 1
            await ctx.renewLock(RECORD)
            if (ticks === 3) throw new Error('write failed')
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
      const failure = stopFailure(await loop.stop())

      // #then
      expect(failure.lockEtag).toBe('etag-3')
    })
  })

  describe('abort', () => {
    it('creates and passes no signal when abortOnDeadline is off', async () => {
      // #given
      const finalizeSignals: unknown[] = []
      const bodySignals: unknown[] = []
      const {loop, renew} = setup({
        overrides: {
          tick: async ctx => {
            bodySignals.push(ctx.signal)
            await ctx.renewLock(RECORD)
          },
          finalize: async signal => {
            finalizeSignals.push(signal)
            return 'snapshot'
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await loop.stop()

      // #then renew was called with exactly (record, etag)
      expect(bodySignals).toEqual([undefined])
      expect(finalizeSignals).toEqual([undefined])
      expect(renew.mock.calls[0]).toHaveLength(2)
    })

    it('passes the attempt signal to the body and to renew, and does not abort when stop begins', async () => {
      // #given a renewal held open so stop begins mid-tick
      const open = deferred<Result<{readonly etag: string}, Error>>()
      const signals: (AbortSignal | undefined)[] = []
      const {loop, renew} = setup({
        script: async (_n, signal) => {
          signals.push(signal)
          return open.promise
        },
        overrides: {
          abortOnDeadline: true,
          tick: async ctx => {
            signals.push(ctx.signal)
            await ctx.renewLock(RECORD)
          },
        },
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when stop begins
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(1_000)

      // #then the body and renew share one live signal
      expect(signals[0]).toBeDefined()
      expect(signals[1]).toBe(signals[0])
      expect(renew.mock.calls[0]?.[2]).toBe(signals[0])
      expect(signals[0]?.aborted).toBe(false)
      open.resolve(ok({etag: 'etag-open'}))
      await stopped
      expect(signals[0]?.aborted).toBe(false)
    })

    it('aborts the attempt signal at the tick timeout', async () => {
      // #given
      const signals: (AbortSignal | undefined)[] = []
      const {loop} = setup({
        script: async (_n, signal) => {
          signals.push(signal)
          return hang()
        },
        overrides: {abortOnDeadline: true},
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS - 1)
      expect(signals[0]?.aborted).toBe(false)

      // #when
      await vi.advanceTimersByTimeAsync(1)

      // #then
      expect(signals[0]?.aborted).toBe(true)
    })

    it('aborts the in-flight attempt when the stop budget runs out, not before', async () => {
      // #given a hung renewal under a tick timeout longer than the budget
      const signals: (AbortSignal | undefined)[] = []
      const {loop} = setup({
        script: async (_n, signal) => {
          signals.push(signal)
          return hang()
        },
        overrides: {abortOnDeadline: true, tickTimeoutMs: 60_000},
      })
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS - 1)
      expect(signals[0]?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await stopped

      // #then
      expect(signals[0]?.aborted).toBe(true)
    })

    it('gives finalize its own signal and aborts it when the budget runs out, not before', async () => {
      // #given a finalize that never settles
      const finalizeSignals: (AbortSignal | undefined)[] = []
      const {loop} = setup({
        overrides: {
          abortOnDeadline: true,
          finalize: async signal => {
            finalizeSignals.push(signal)
            return hang()
          },
        },
      })

      // #when
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS - 1)
      expect(finalizeSignals[0]).toBeDefined()
      expect(finalizeSignals[0]?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await stopped

      // #then
      expect(finalizeSignals[0]?.aborted).toBe(true)
    })
  })

  describe('settle', () => {
    it('waits for the in-flight attempt without stopping the loop', async () => {
      // #given a renewal that lands 2 s into the tick
      const slow = deferred<Result<{readonly etag: string}, Error>>()
      const {loop, renew} = setup({script: async n => (n === 1 ? slow.promise : ok({etag: `etag-${n}`}))})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      let settled = false
      const waiting = loop.settle().then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(1_999)
      expect(settled).toBe(false)
      slow.resolve(ok({etag: 'etag-slow'}))
      await waiting

      // #then the loop keeps ticking on its schedule
      expect(loop.currentEtag()).toBe('etag-slow')
      await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1_999)
      expect(renew).toHaveBeenCalledTimes(2)
      expect(loop.isRunning).toBe(true)
    })

    it('resolves at the tick timeout when the attempt hangs', async () => {
      // #given
      const {loop} = setup({script: async () => hang()})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      let settled = false
      const waiting = loop.settle().then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(TICK_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await waiting

      // #then the outcome is recorded
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
    })

    it('resolves at once when nothing is in flight', async () => {
      // #given
      const {loop} = setup()

      // #when / #then
      await expect(loop.settle()).resolves.toBeUndefined()
    })
  })

  describe('timers', () => {
    it('leaves no timer behind once a tick settles, once stop returns, or after any stop outcome', async () => {
      // #given
      const {loop} = setup({overrides: {finalize: async () => 'snapshot'}})
      expect(vi.getTimerCount()).toBe(0)
      loop.start()
      expect(vi.getTimerCount()).toBe(1)

      // #when a tick runs and settles
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then only the interval remains (the tick timeout was cleared)
      expect(vi.getTimerCount()).toBe(1)

      // #when stopped
      await loop.stop()

      // #then nothing remains (the interval and the stop budget were cleared)
      expect(vi.getTimerCount()).toBe(0)
    })

    it.each([
      ['a failed tick', {script: async () => err(new Error('failed'))}],
      ['a finalize failure', {overrides: {finalize: async () => Promise.reject(new Error('failed'))}}],
      ['a finalize that runs out of budget', {overrides: {finalize: async () => hang<string>()}}],
    ])('leaves no timer behind after stop returns on %s', async (_label, config) => {
      // #given
      const {loop} = setup(config)
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS)
      await stopped

      // #then
      expect(vi.getTimerCount()).toBe(0)
    })

    it('leaves only the tick timeout behind when stop gives up on a pending tick, and clears it when it fires', async () => {
      // #given
      const {loop} = setup({script: async () => hang()})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS)
      await stopped

      // #then the abandoned tick's own timeout is the only timer left, and it runs out
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(TICK_TIMEOUT_MS)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('leaves no tick timeout behind after settle', async () => {
      // #given
      const slow = deferred<Result<{readonly etag: string}, Error>>()
      const {loop} = setup({script: async () => slow.promise})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(vi.getTimerCount()).toBe(2)

      // #when
      const waiting = loop.settle()
      slow.resolve(ok({etag: 'etag-slow'}))
      await waiting

      // #then only the interval remains
      expect(vi.getTimerCount()).toBe(1)
    })

    it.each([
      [true, 3],
      [false, 0],
    ])('with unref=%s, unrefs %s of the interval, tick timeout and budget timers', async (unref, expectedUnrefs) => {
      // #given every timer the loop creates is tracked
      const unrefs: ReturnType<typeof vi.fn>[] = []
      const created: unknown[] = []
      const realSetTimeout = globalThis.setTimeout
      const realSetInterval = globalThis.setInterval
      const track = (handle: {unref: () => unknown}): void => {
        created.push(handle)
        const spy = vi.fn(() => handle)
        const original = handle.unref.bind(handle)
        handle.unref = () => {
          spy()
          return original()
        }
        unrefs.push(spy)
      }
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args: Parameters<typeof setTimeout>) => {
        const handle = realSetTimeout(...args)
        track(handle)
        return handle
      })
      vi.spyOn(globalThis, 'setInterval').mockImplementation((...args: Parameters<typeof setInterval>) => {
        const handle = realSetInterval(...args)
        track(handle)
        return handle
      })
      const {loop} = setup({overrides: {unref, finalize: async () => 'snapshot'}})

      // #when an interval, a tick timeout and a stop budget all get created
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await loop.stop()

      // #then
      expect(created).toHaveLength(3)
      expect(unrefs.filter(spy => spy.mock.calls.length > 0)).toHaveLength(expectedUnrefs)
    })
  })

  describe('stop logging', () => {
    it('logs nothing when the budget runs out on a pending tick', async () => {
      // #given a hung renewal
      const {loop, logger} = setup({script: async () => hang()})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when stop gives up on it
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS)
      await stopped

      // #then the surface's log output is exactly what its own code wrote
      expect(logger.debug).not.toHaveBeenCalled()
      expect(logger.info).not.toHaveBeenCalled()
      expect(logger.warning).not.toHaveBeenCalled()
    })

    it('logs nothing when the budget runs out on finalize', async () => {
      // #given
      const {loop, logger} = setup({overrides: {finalize: async () => hang<string>()}})

      // #when
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS)
      await stopped

      // #then
      expect(logger.debug).not.toHaveBeenCalled()
    })
  })

  describe('a throwing logger', () => {
    it('does not wedge the loop when a failed renewal cannot be logged', async () => {
      // #given the first renewal is rejected and the logger throws on every warning
      const tracker = trackUnhandledRejections()
      const {loop, renew} = setup({
        script: async n => (n === 1 ? err(new Error('renewal rejected')) : ok({etag: `etag-${n}`})),
        overrides: {logger: throwingLogger()},
      })
      loop.start()

      // #when the failing tick runs, then the next interval arrives
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      await loop.settle()
      expect(loop.hasFailed()).toBe(true)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #then a new tick ran and confirmed a renewal
      expect(renew).toHaveBeenCalledTimes(2)
      expect(loop.hasFailed()).toBe(false)
      expect(loop.currentEtag()).toBe('etag-2')
      await tracker.settle()
      expect(tracker.seen).toEqual([])
    })

    it('does not wedge the loop when a body failure cannot be logged', async () => {
      // #given the body throws on its first tick and the logger throws on every warning
      const tracker = trackUnhandledRejections()
      let ticks = 0
      const {loop, renew} = setup({
        overrides: {
          logger: throwingLogger(),
          tick: async ctx => {
            ticks += 1
            if (ticks === 1) throw new Error('read failed')
            await ctx.renewLock(RECORD)
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)

      // #then the second tick ran
      expect(renew).toHaveBeenCalledTimes(1)
      expect(loop.hasFailed()).toBe(false)
      expect(loop.continuityUnverified()).toBe(true)
      await tracker.settle()
      expect(tracker.seen).toEqual([])
    })

    it('does not wedge the loop, or throw out of the timer, when a tick timeout cannot be logged', async () => {
      // #given the first renewal hangs and the logger throws on every warning
      const tracker = trackUnhandledRejections()
      const {loop, renew} = setup({
        script: async n => (n === 1 ? hang() : ok({etag: `etag-${n}`})),
        overrides: {logger: throwingLogger()},
      })
      loop.start()

      // #when the timeout fires (an exception escaping the timer callback would reject this advance)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS)

      // #then the attempt was concluded despite the logger: settle resolves and the slot is free
      await loop.settle()
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(renew).toHaveBeenCalledTimes(2)
      expect(loop.currentEtag()).toBe('etag-2')
      await tracker.settle()
      expect(tracker.seen).toEqual([])
    })
  })

  describe('a body that settles in the same timer advance as its timeout', () => {
    it('concludes normally when the body settles first, and the timeout is a no-op', async () => {
      // #given a renewal released by a timer created before the tick starts, so at the timeout's instant it fires first
      const release = deferred<Result<{readonly etag: string}, Error>>()
      setTimeout(() => {
        release.resolve(ok({etag: 'etag-same-turn'}))
      }, INTERVAL_MS + TICK_TIMEOUT_MS)
      const {loop, logger} = setup({script: async () => release.promise})
      loop.start()

      // #when one advance covers both the release and the timeout
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS)

      // #then the body concluded the attempt: no failure, no warning, no latch, ETag applied
      expect(loop.currentEtag()).toBe('etag-same-turn')
      expect(loop.hasFailed()).toBe(false)
      expect(loop.continuityUnverified()).toBe(false)
      expect(logger.warning).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)
    })

    it('times out when the timeout fires first, and the result that follows in the same advance is dropped', async () => {
      // #given a renewal released by a timer created after the tick starts, so at the timeout's instant it fires second
      const release = deferred<Result<{readonly etag: string}, Error>>()
      const {loop, logger, renew} = setup({
        script: async () => {
          setTimeout(() => {
            release.resolve(ok({etag: 'etag-same-turn'}))
          }, TICK_TIMEOUT_MS)
          return release.promise
        },
      })
      loop.start()

      // #when one advance covers both
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS)

      // #then the timeout won
      expect(renew).toHaveBeenCalledTimes(1)
      expect(loop.currentEtag()).toBe('etag-0')
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
      expect(logger.warning).toHaveBeenCalledTimes(1)
    })
  })

  describe('a body that catches a renewal failure', () => {
    /** Renews, swallows the failure, and returns normally: the loop must still see that the renewal failed. */
    const swallowing = async (ctx: LeaseTickContext): Promise<void> => {
      try {
        await ctx.renewLock(RECORD)
      } catch {
        // Swallowed on purpose.
      }
    }

    it('still fails the tick when the swallowed renewal returned err', async () => {
      // #given
      const finalize = vi.fn(async () => 'snapshot')
      const {loop, logger} = setup({
        script: async () => err(new Error('renewal rejected')),
        overrides: {tick: swallowing, finalize},
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const failure = stopFailure(await loop.stop())

      // #then
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
      expect(failure.message).toBe('renewal rejected')
      expect(finalize).not.toHaveBeenCalled()
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal failed', {
        ...CONTEXT,
        error: 'renewal rejected',
      })
    })

    it.each([
      ['an Error', new Error('socket hang up'), 'socket hang up'],
      ['a non-Error', NON_ERROR, 'not an error'],
    ])('still fails the tick when the swallowed renewal rejected with %s', async (_label, rejection, message) => {
      // #given
      const finalize = vi.fn(async () => 'snapshot')
      const {loop, logger} = setup({
        script: async () => Promise.reject(rejection),
        overrides: {tick: swallowing, finalize},
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const failure = stopFailure(await loop.stop())

      // #then
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(true)
      expect(failure.message).toBe(message)
      expect(finalize).not.toHaveBeenCalled()
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {...CONTEXT, error: message})
    })

    it('comes out healthy when a retry in the same tick confirms a renewal, and the latch stays unset', async () => {
      // #given the first renewal fails and the body retries once
      const finalize = vi.fn(async () => 'snapshot')
      const {loop, logger, renew} = setup({
        script: async n => (n === 1 ? err(new Error('renewal rejected')) : ok({etag: `etag-${n}`})),
        overrides: {
          finalize,
          tick: async ctx => {
            await swallowing(ctx)
            await ctx.renewLock(RECORD)
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const result = await loop.stop()

      // #then the attempt ended with a confirmed renewal: nothing is failed, nothing is logged, and finalize ran
      expect(renew).toHaveBeenCalledTimes(2)
      expect(loop.hasFailed()).toBe(false)
      expect(loop.continuityUnverified()).toBe(false)
      expect(loop.currentEtag()).toBe('etag-2')
      expect(logger.warning).not.toHaveBeenCalled()
      expect(finalize).toHaveBeenCalledTimes(1)
      expect(result).toEqual(ok({lockEtag: 'etag-2', final: 'snapshot'}))
    })

    it('records nothing for a superseded attempt that swallows its own late failure', async () => {
      // #given a renewal that outlives the tick timeout, then fails
      const late = deferred<Result<{readonly etag: string}, Error>>()
      const {loop, logger} = setup({script: async () => late.promise, overrides: {tick: swallowing}})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + TICK_TIMEOUT_MS)
      expect(logger.warning).toHaveBeenCalledTimes(1)

      // #when the abandoned renewal fails and the body swallows it
      late.resolve(err(new Error('late rejection')))
      await vi.advanceTimersByTimeAsync(0)

      // #then only the timeout's failure stands
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(stopFailure(await loop.stop()).message).toBe('Lease renewal exceeded 10000ms')
    })
  })

  describe('a body that catches a renewal failure after a confirmed renewal', () => {
    const swallowing = async (ctx: LeaseTickContext): Promise<void> => {
      try {
        await ctx.renewLock(RECORD)
      } catch {
        // Swallowed on purpose.
      }
    }

    it('ends the tick failed when the last renewal returned err, without latching continuity', async () => {
      // #given the first renewal confirms and the second returns err
      const finalize = vi.fn(async () => 'snapshot')
      const {loop, logger} = setup({
        script: async n => (n === 1 ? ok({etag: 'etag-1'}) : err(new Error('second rejected'))),
        overrides: {
          finalize,
          tick: async ctx => {
            await ctx.renewLock(RECORD)
            await swallowing(ctx)
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const failure = stopFailure(await loop.stop())

      // #then a renewal already confirmed this tick, so coverage is not in doubt
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(false)
      expect(loop.currentEtag()).toBe('etag-1')
      expect(failure.message).toBe('second rejected')
      expect(finalize).not.toHaveBeenCalled()
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal failed', {
        ...CONTEXT,
        error: 'second rejected',
      })
    })

    it('ends the tick failed when the last renewal threw, without latching continuity', async () => {
      // #given the first renewal confirms and the second rejects
      const finalize = vi.fn(async () => 'snapshot')
      const {loop, logger} = setup({
        script: async n => (n === 1 ? ok({etag: 'etag-1'}) : Promise.reject(new Error('second threw'))),
        overrides: {
          finalize,
          tick: async ctx => {
            await ctx.renewLock(RECORD)
            await swallowing(ctx)
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const failure = stopFailure(await loop.stop())

      // #then
      expect(loop.hasFailed()).toBe(true)
      expect(loop.continuityUnverified()).toBe(false)
      expect(failure.message).toBe('second threw')
      expect(finalize).not.toHaveBeenCalled()
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {
        ...CONTEXT,
        error: 'second threw',
      })
    })

    it('comes out healthy when a third renewal confirms after the caught failure', async () => {
      // #given success, caught failure, success
      const finalize = vi.fn(async () => 'snapshot')
      const {loop, logger} = setup({
        script: async n => (n === 2 ? err(new Error('middle rejected')) : ok({etag: `etag-${n}`})),
        overrides: {
          finalize,
          tick: async ctx => {
            await ctx.renewLock(RECORD)
            await swallowing(ctx)
            await ctx.renewLock(RECORD)
          },
        },
      })
      loop.start()

      // #when
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const result = await loop.stop()

      // #then
      expect(loop.hasFailed()).toBe(false)
      expect(loop.continuityUnverified()).toBe(false)
      expect(logger.warning).not.toHaveBeenCalled()
      expect(result).toEqual(ok({lockEtag: 'etag-3', final: 'snapshot'}))
    })
  })

  describe('an attempt abandoned at stop', () => {
    it('unrefs its tick timer when stop gives up on it, and the timer still records the timeout', async () => {
      // #given a hung renewal on a loop that does not unref its own timers (the gateway)
      const handles = trackTimeoutHandles()
      const {loop, logger} = setup({script: async () => hang(), overrides: {unref: false}})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      const tickTimer = handles[0]
      expect(tickTimer?.hasRef()).toBe(true)

      // #when stop gives up on it
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(STOP_BUDGET_MS)
      await stopped

      // #then it no longer holds the process open...
      expect(tickTimer?.hasRef()).toBe(false)
      expect(logger.warning).not.toHaveBeenCalled()

      // #when the process lives long enough
      await vi.advanceTimersByTimeAsync(TICK_TIMEOUT_MS - STOP_BUDGET_MS)

      // #then ...but it still fires and records the failure
      expect(loop.hasFailed()).toBe(true)
      expect(logger.warning).toHaveBeenCalledWith('Coordination lease renewal threw', {
        ...CONTEXT,
        error: 'Lease renewal exceeded 10000ms',
      })
    })

    it('leaves the tick timer of an attempt that stop waited for alone', async () => {
      // #given a renewal that settles inside the budget
      const handles = trackTimeoutHandles()
      const slow = deferred<Result<{readonly etag: string}, Error>>()
      const {loop} = setup({script: async () => slow.promise, overrides: {unref: false}})
      loop.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      // #when
      const stopped = loop.stop()
      await vi.advanceTimersByTimeAsync(1_000)
      slow.resolve(ok({etag: 'etag-slow'}))
      await stopped

      // #then nothing was abandoned, and the settled attempt's timer is gone
      expect(handles[0]?.hasRef()).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
