import type {CoordinationConfig, Result, RunState} from '@fro-bot/runtime'

import {err, HEARTBEAT_STOP_GRACE_MS, ok} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {transitionRetryingStaleEtag} from './stale-etag-transition.js'

const IDENTITY = 'discord-gateway'
const REPO = 'acme/widget'
const RUN_ID = 'run-1'
const RUN_KEY = `fro-bot-state/${IDENTITY}/${REPO}/runs/${RUN_ID}.json`

function createLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: RUN_ID,
    surface: 'discord',
    thread_id: 'thread-1',
    entity_ref: `${REPO}#1`,
    phase: 'EXECUTING',
    started_at: '2026-04-24T18:00:00.000Z',
    last_heartbeat: '2026-04-24T18:00:00.000Z',
    holder_id: 'gateway-1',
    details: {},
    ...overrides,
  }
}

type GetObject = (key: string) => Promise<Result<{data: string; etag: string}, Error>>

function configWith(getObject?: GetObject): CoordinationConfig {
  return {
    storeAdapter: {
      upload: vi.fn(),
      download: vi.fn(),
      list: vi.fn(),
      ...(getObject === undefined ? {} : {getObject}),
    },
    storeConfig: {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
}

function storedAs(state: RunState, etag: string): GetObject {
  return vi.fn(async () => ok({data: JSON.stringify(state), etag}))
}

const PRECONDITION = () => err(new Error('412 precondition failed'))

describe('transitionRetryingStaleEtag', () => {
  it('returns the first attempt without reading the store when it succeeds', async () => {
    // #given
    const getObject = storedAs(runState(), 'etag-fresh')
    const attempt = vi.fn(async (_etag: string) => ok({etag: 'etag-done'}))

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(getObject),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
    })

    // #then
    expect(result).toEqual(ok({etag: 'etag-done'}))
    expect(attempt).toHaveBeenCalledExactlyOnceWith('etag-stale')
    expect(getObject).not.toHaveBeenCalled()
  })

  it('re-reads once on failure and retries once with the fresh ETag when the stored record is this run and non-terminal', async () => {
    // #given the first attempt loses the conditional write; the stored record is still EXECUTING under a newer ETag
    const getObject = storedAs(runState({phase: 'EXECUTING'}), 'etag-fresh')
    const attempt = vi.fn<(etag: string) => Promise<Result<{etag: string}, Error>>>(async etag =>
      etag === 'etag-fresh' ? ok({etag: 'etag-done'}) : PRECONDITION(),
    )
    const logger = createLogger()

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(getObject),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger,
      attempt,
    })

    // #then
    expect(result).toEqual(ok({etag: 'etag-done'}))
    expect(getObject).toHaveBeenCalledExactlyOnceWith(RUN_KEY, {signal: expect.any(AbortSignal) as AbortSignal})
    expect(attempt.mock.calls.map(call => call[0])).toEqual(['etag-stale', 'etag-fresh'])
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({runId: RUN_ID}), expect.stringContaining('retry'))
  })

  it.each(['PENDING', 'ACKNOWLEDGED', 'EXECUTING'] as const)(
    'retries when the stored phase is the non-terminal %s',
    async phase => {
      // #given
      const attempt = vi.fn<(etag: string) => Promise<Result<{etag: string}, Error>>>(async etag =>
        etag === 'etag-fresh' ? ok({etag: 'etag-done'}) : PRECONDITION(),
      )

      // #when
      const result = await transitionRetryingStaleEtag({
        config: configWith(storedAs(runState({phase}), 'etag-fresh')),
        identity: IDENTITY,
        repo: REPO,
        runId: RUN_ID,
        etag: 'etag-stale',
        logger: createLogger(),
        attempt,
      })

      // #then
      expect(result.success).toBe(true)
      expect(attempt).toHaveBeenCalledTimes(2)
    },
  )

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'] as const)(
    'does not retry when the stored record is already terminal (%s)',
    async phase => {
      // #given a concurrent writer already terminalized the run
      const attempt = vi.fn(async (_etag: string) => PRECONDITION())
      const logger = createLogger()

      // #when
      const result = await transitionRetryingStaleEtag({
        config: configWith(storedAs(runState({phase}), 'etag-fresh')),
        identity: IDENTITY,
        repo: REPO,
        runId: RUN_ID,
        etag: 'etag-stale',
        logger,
        attempt,
      })

      // #then the original failure is returned and no second write is attempted
      expect(result.success).toBe(false)
      expect(result.success === false ? result.error.message : '').toBe('412 precondition failed')
      expect(attempt).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({phase}), expect.stringContaining('skipping'))
    },
  )

  it('does not retry when the stored record belongs to another run', async () => {
    // #given
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(storedAs(runState({run_id: 'run-other'}), 'etag-fresh')),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
    })

    // #then
    expect(result.success).toBe(false)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('returns the original failure when the re-read fails', async () => {
    // #given
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())
    const getObject: GetObject = vi.fn(async () => err(new Error('S3 down')))

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(getObject),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
    })

    // #then
    expect(result.success === false ? result.error.message : '').toBe('412 precondition failed')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('returns the original failure when the store cannot be read at all', async () => {
    // #given an adapter without getObject
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
    })

    // #then
    expect(result.success === false ? result.error.message : '').toBe('412 precondition failed')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the adapter has no getObject', configWith(), 'no getObject'],
    ['the read returns an error', configWith(vi.fn(async () => err(new Error('S3 down')))), 'S3 down'],
    [
      'the read throws',
      configWith(
        vi.fn(async () => {
          throw new Error('socket hang up')
        }),
      ),
      'socket hang up',
    ],
  ])('logs at debug why the retry is disabled when %s, and never throws', async (_label, config, expected) => {
    // #given
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())
    const logger = createLogger()

    // #when
    const result = await transitionRetryingStaleEtag({
      config,
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger,
      attempt,
    })

    // #then the original failure is returned, and the skipped retry is visible in the logs
    expect(result.success === false ? result.error.message : '').toBe('412 precondition failed')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({runId: RUN_ID, reason: expect.stringContaining(expected) as unknown}),
      expect.stringContaining('retry disabled'),
    )
  })

  describe('a stored-run read that never settles', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns the original failure after the budget, without a retry, and leaves no timer behind', async () => {
      // #given a store read that never settles after the first write failed
      const attempt = vi.fn(async (_etag: string) => PRECONDITION())
      const getObject: GetObject = vi.fn(async () => new Promise<never>(() => {}))
      const logger = createLogger()

      // #when
      let settled = false
      const pending = transitionRetryingStaleEtag({
        config: configWith(getObject),
        identity: IDENTITY,
        repo: REPO,
        runId: RUN_ID,
        etag: 'etag-stale',
        logger,
        attempt,
      }).then(result => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS - 1)
      const settledBeforeBudget = settled
      await vi.advanceTimersByTimeAsync(1)
      const result = await pending

      // #then the helper gave up exactly at the budget and returned the original failure
      expect(settledBeforeBudget).toBe(false)
      expect(result.success === false ? result.error.message : '').toBe('412 precondition failed')
      expect(attempt).toHaveBeenCalledTimes(1)
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({runId: RUN_ID, reason: expect.stringContaining('did not settle') as unknown}),
        expect.stringContaining('retry disabled'),
      )
      expect(vi.getTimerCount()).toBe(0)
    })

    it('cancels the recovery read when the budget runs out, rather than abandoning it', async () => {
      // #given a store read that never settles after the first write failed
      const getObject = vi.fn<(key: string, options?: {signal?: AbortSignal}) => Promise<never>>(
        async () => new Promise<never>(() => {}),
      )

      // #when
      const pending = transitionRetryingStaleEtag({
        config: configWith(getObject),
        identity: IDENTITY,
        repo: REPO,
        runId: RUN_ID,
        etag: 'etag-stale',
        logger: createLogger(),
        attempt: vi.fn(async (_etag: string) => PRECONDITION()),
      })
      await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS - 1)
      const signal = getObject.mock.calls[0]?.[1]?.signal
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await pending

      // #then
      expect(signal?.aborted).toBe(true)
    })

    it('clears the budget timer when the read settles in time', async () => {
      // #given
      const attempt = vi.fn<(etag: string) => Promise<Result<{etag: string}, Error>>>(async etag =>
        etag === 'etag-fresh' ? ok({etag: 'etag-done'}) : PRECONDITION(),
      )

      // #when
      const result = await transitionRetryingStaleEtag({
        config: configWith(storedAs(runState(), 'etag-fresh')),
        identity: IDENTITY,
        repo: REPO,
        runId: RUN_ID,
        etag: 'etag-stale',
        logger: createLogger(),
        attempt,
      })

      // #then
      expect(result.success).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('returns the failure of the single retry without a third attempt', async () => {
    // #given the retry loses the conditional write too
    const attempt = vi.fn(async (etag: string) => err(new Error(`failed with ${etag}`)))

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(storedAs(runState(), 'etag-fresh')),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
    })

    // #then
    expect(result.success === false ? result.error.message : '').toBe('failed with etag-fresh')
    expect(attempt).toHaveBeenCalledTimes(2)
  })
})

function options(overrides: Partial<Parameters<typeof transitionRetryingStaleEtag<{etag: string}>>[0]> = {}) {
  return {
    config: configWith(storedAs(runState(), 'etag-fresh')),
    identity: IDENTITY,
    repo: REPO,
    runId: RUN_ID,
    etag: 'etag-stale',
    logger: createLogger(),
    attempt: vi.fn(async (_etag: string) => ok({etag: 'etag-done'})),
    ...overrides,
  }
}

describe('transitionRetryingStaleEtag — more attempts, a delay, a per-attempt bound', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('succeeds on the third write when the first two fail, waiting 500 ms then 1 s between writes', async () => {
    // #given two failed writes, then a success
    let calls = 0
    const attempt = vi.fn(async (_etag: string) => {
      calls += 1
      return calls < 3 ? PRECONDITION() : ok({etag: 'etag-done'})
    })
    const getObject = storedAs(runState(), 'etag-fresh')

    // #when
    const pending = transitionRetryingStaleEtag(
      options({config: configWith(getObject), attempt, attempts: 3, delaysMs: [500, 1_000]}),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(attempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(attempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(attempt).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending

    // #then the retries used the stored ETag, and the stored record was re-read before each one
    expect(result).toEqual(ok({etag: 'etag-done'}))
    expect(attempt.mock.calls.map(call => call[0])).toEqual(['etag-stale', 'etag-fresh', 'etag-fresh'])
    expect(getObject).toHaveBeenCalledTimes(2)
  })

  it('returns the last failure after every attempt failed, without a further write', async () => {
    // #given
    const attempt = vi.fn(async (etag: string) => err(new Error(`failed with ${etag}`)))

    // #when
    const pending = transitionRetryingStaleEtag(options({attempt, attempts: 3, delaysMs: [500, 1_000]}))
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await pending

    // #then
    expect(result.success === false ? result.error.message : '').toBe('failed with etag-fresh')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('stops retrying and overwrites nothing when the stored record became terminal between attempts', async () => {
    // #given the first retry loses, and the record is COMPLETED when it is read for the second
    const reads = [runState({phase: 'EXECUTING'}), runState({phase: 'COMPLETED'})]
    const getObject = vi.fn(async () => ok({data: JSON.stringify(reads.shift() ?? runState()), etag: 'etag-fresh'}))
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())
    const logger = createLogger()

    // #when
    const pending = transitionRetryingStaleEtag(
      options({config: configWith(getObject), attempt, attempts: 3, delaysMs: [500, 1_000], logger}),
    )
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await pending

    // #then it wrote twice (the original and one retry), then left the terminal record alone
    expect(result.success).toBe(false)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({phase: 'COMPLETED'}),
      expect.stringContaining('skipping retry'),
    )
  })

  it('never retries over a record that belongs to another run', async () => {
    // #given
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())

    // #when
    const pending = transitionRetryingStaleEtag(
      options({
        config: configWith(storedAs(runState({run_id: 'run-other'}), 'etag-other')),
        attempt,
        attempts: 3,
        delaysMs: [500, 1_000],
      }),
    )
    await vi.advanceTimersByTimeAsync(5_000)
    await pending

    // #then
    expect(attempt).toHaveBeenCalledExactlyOnceWith('etag-stale')
  })

  it('bounds a stalled write, retries after it, and keeps the whole retry within its budget', async () => {
    // #given a first write that never settles, then writes that succeed
    const stalled = new Promise<never>(() => {})
    let calls = 0
    const attempt = vi.fn(async (_etag: string) => {
      calls += 1
      return calls === 1 ? stalled : ok({etag: 'etag-done'})
    })

    // #when the per-attempt bound passes
    const pending = transitionRetryingStaleEtag(
      options({attempt, attempts: 3, delaysMs: [500, 1_000], attemptTimeoutMs: 5_000}),
    )
    await vi.advanceTimersByTimeAsync(4_999)
    expect(attempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1 + 500)
    const result = await pending

    // #then the stall was abandoned at its bound and the next write went out with the stored ETag
    expect(result).toEqual(ok({etag: 'etag-done'}))
    expect(attempt.mock.calls.map(call => call[0])).toEqual(['etag-stale', 'etag-fresh'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends within attempts x bound plus delays when every write stalls', async () => {
    // #given
    const attempt = vi.fn(async (_etag: string) => new Promise<never>(() => {}))
    let settled = false

    // #when
    const pending = transitionRetryingStaleEtag(
      options({attempt, attempts: 3, delaysMs: [500, 1_000], attemptTimeoutMs: 5_000}),
    ).then(result => {
      settled = true
      return result
    })
    // 3 bounded writes + 1.5 s of delays + 2 store reads (instant here)
    await vi.advanceTimersByTimeAsync(3 * 5_000 + 1_500 - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending

    // #then
    expect(settled).toBe(true)
    expect(result.success).toBe(false)
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not surface a late rejection of an abandoned write as unhandled', async () => {
    // #given a write that rejects only after its bound passed
    let rejectLate: (error: Error) => void = () => {}
    const late = new Promise<never>((_resolve, reject) => {
      rejectLate = reject
    })
    let calls = 0
    const attempt = vi.fn(async (_etag: string) => {
      calls += 1
      return calls === 1 ? late : ok({etag: 'etag-done'})
    })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    // #when
    const pending = transitionRetryingStaleEtag(options({attempt, attempts: 2, attemptTimeoutMs: 1_000}))
    await vi.advanceTimersByTimeAsync(1_000)
    await pending
    rejectLate(new Error('late'))
    await vi.advanceTimersByTimeAsync(10)

    // #then
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it("keeps today's default: one re-read and one retry with no delay, no bound", async () => {
    // #given
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())

    // #when
    const result = await transitionRetryingStaleEtag(options({attempt}))

    // #then
    expect(result.success).toBe(false)
    expect(attempt.mock.calls.map(call => call[0])).toEqual(['etag-stale', 'etag-fresh'])
  })
})

describe('transitionRetryingStaleEtag — a write that committed after its bound', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const adoptTerminal = (stored: {readonly state: RunState; readonly etag: string}) => ({
    etag: stored.etag,
    state: stored.state,
  })

  it('adopts the stored terminal record of this run as the outcome, with its own phase, and writes nothing over it', async () => {
    // #given the first write stalls past its bound and commits meanwhile, as a different terminal phase
    const stored = runState({phase: 'CANCELLED', details: {marker: 'authoritative'}})
    const attempt = vi.fn(async (_etag: string) => new Promise<never>(() => {}))
    const logger = createLogger()

    // #when
    const pending = transitionRetryingStaleEtag({
      config: configWith(storedAs(stored, 'etag-committed')),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger,
      attempt,
      attempts: 3,
      delaysMs: [500, 1_000],
      attemptTimeoutMs: 5_000,
      adoptTerminal,
    })
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await pending

    // #then the stored record is the outcome, and the stalled write was the only one
    expect(result).toEqual(ok({etag: 'etag-committed', state: stored}))
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({runId: RUN_ID, phase: 'CANCELLED'}),
      expect.stringContaining('already terminal'),
    )
  })

  it('still fails when the terminal record belongs to another run, even with adoption available', async () => {
    // #given
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(storedAs(runState({run_id: 'someone-else', phase: 'FAILED'}), 'etag-other')),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
      adoptTerminal,
    })

    // #then
    expect(result.success).toBe(false)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('keeps retrying, and does not adopt, while the stored record is this run and still live', async () => {
    // #given
    const attempt = vi
      .fn<(etag: string) => Promise<Result<{etag: string}, Error>>>()
      .mockResolvedValueOnce(PRECONDITION())
      .mockResolvedValueOnce(ok({etag: 'etag-done'}))

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(storedAs(runState({phase: 'EXECUTING'}), 'etag-fresh')),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
      adoptTerminal: stored => ({etag: stored.etag}),
    })

    // #then
    expect(result).toEqual(ok({etag: 'etag-done'}))
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('without an adoption callback, a terminal record still returns the failure (the default is unchanged)', async () => {
    // #given
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(storedAs(runState({phase: 'COMPLETED'}), 'etag-done')),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
    })

    // #then
    expect(result.success).toBe(false)
  })
})

const adoptFinalTerminal = (stored: {readonly state: RunState; readonly etag: string}) => ({
  etag: stored.etag,
  state: stored.state,
})
const FINAL_LIVE = runState({phase: 'EXECUTING'})

/** A store that answers each read in turn, then repeats the last answer. */
function finalReads(...answers: readonly (Result<{data: string; etag: string}, Error> | 'stall')[]) {
  let index = 0
  return vi.fn(async (_key: string) => {
    const answer = answers[Math.min(index, answers.length - 1)]
    index += 1
    return answer === 'stall' || answer === undefined ? new Promise<never>(() => {}) : answer
  })
}
const finalStored = (state: RunState, etag: string) => ok({data: JSON.stringify(state), etag})

describe('transitionRetryingStaleEtag — the final attempt commits after its bound', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-reads once after the last attempt stalls, and adopts the terminal record it committed', async () => {
    // #given the retry's write stalls past its bound and commits meanwhile; the earlier read still showed a live run
    const terminal = runState({phase: 'COMPLETED', details: {marker: 'committed'}})
    const getObject = finalReads(finalStored(FINAL_LIVE, 'etag-live'), finalStored(terminal, 'etag-committed'))
    const attempt = vi.fn(async (etag: string) =>
      etag === 'etag-stale' ? PRECONDITION() : new Promise<never>(() => {}),
    )
    const logger = createLogger()

    // #when
    const pending = transitionRetryingStaleEtag({
      config: configWith(getObject),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger,
      attempt,
      attemptTimeoutMs: 5_000,
      adoptTerminal: adoptFinalTerminal,
    })
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending

    // #then the stored record is the outcome, and the stalled write was not repeated
    expect(result).toEqual(ok({etag: 'etag-committed', state: terminal}))
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(getObject).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({phase: 'COMPLETED'}),
      expect.stringContaining('already terminal'),
    )
  })

  it('returns the original failure when the final re-read finds the run still live', async () => {
    // #given
    const getObject = finalReads(finalStored(FINAL_LIVE, 'etag-live'))
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(getObject),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
      adoptTerminal: adoptFinalTerminal,
    })

    // #then both attempts failed, a final read happened, and nothing was adopted
    expect(result.success).toBe(false)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(getObject).toHaveBeenCalledTimes(2)
  })

  it("returns the original failure when the final re-read finds another run's record", async () => {
    // #given
    const getObject = finalReads(
      finalStored(FINAL_LIVE, 'etag-live'),
      finalStored(runState({run_id: 'someone-else', phase: 'FAILED'}), 'etag-x'),
    )
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(getObject),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
      adoptTerminal: adoptFinalTerminal,
    })

    // #then
    expect(result.success).toBe(false)
  })

  it('bounds a final re-read that stalls: the failure comes back within the extra read budget', async () => {
    // #given the mid-loop read answers, and the final read never does
    const getObject = finalReads(finalStored(FINAL_LIVE, 'etag-live'), 'stall')
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())
    let settled = false

    // #when
    const pending = transitionRetryingStaleEtag({
      config: configWith(getObject),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
      adoptTerminal: adoptFinalTerminal,
    }).then(result => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_GRACE_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending

    // #then
    expect(result.success).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('makes no final re-read without an adoption callback: the default is unchanged', async () => {
    // #given
    const getObject = finalReads(finalStored(FINAL_LIVE, 'etag-live'))
    const attempt = vi.fn(async (_etag: string) => PRECONDITION())

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(getObject),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
    })

    // #then only the read before the retry happened
    expect(result.success).toBe(false)
    expect(getObject).toHaveBeenCalledTimes(1)
  })

  it('makes no final re-read when the last attempt succeeds', async () => {
    // #given
    const getObject = finalReads(finalStored(FINAL_LIVE, 'etag-live'))
    const attempt = vi
      .fn<(etag: string) => Promise<Result<{etag: string}, Error>>>()
      .mockResolvedValueOnce(PRECONDITION())
      .mockResolvedValueOnce(ok({etag: 'etag-done'}))

    // #when
    const result = await transitionRetryingStaleEtag({
      config: configWith(getObject),
      identity: IDENTITY,
      repo: REPO,
      runId: RUN_ID,
      etag: 'etag-stale',
      logger: createLogger(),
      attempt,
      adoptTerminal: stored => ({etag: stored.etag}),
    })

    // #then
    expect(result).toEqual(ok({etag: 'etag-done'}))
    expect(getObject).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// A write the helper abandoned at its bound can still commit after the helper has returned a failure.
// ---------------------------------------------------------------------------

interface Written {
  readonly etag: string
  readonly state: RunState
}

/** A write that stays pending until the test settles it. */
function deferredWrite() {
  let settle: (result: Result<Written, Error>) => void = () => {}
  const promise = new Promise<Result<Written, Error>>(resolve => {
    settle = resolve
  })
  return {promise, settle}
}

const COMMITTED: Written = {etag: 'etag-late', state: runState({phase: 'COMPLETED', details: {marker: 'late'}})}

function lateCommitOptions(overrides: {
  readonly attempt: (etag: string) => Promise<Result<Written, Error>>
  readonly onLateCommit?: (written: Written) => void
  readonly getObject?: GetObject
  readonly attempts?: number
  readonly adopt?: boolean
}) {
  return {
    config: configWith(overrides.getObject ?? storedAs(runState({phase: 'EXECUTING'}), 'etag-live')),
    identity: IDENTITY,
    repo: REPO,
    runId: RUN_ID,
    etag: 'etag-stale',
    logger: createLogger(),
    attempt: overrides.attempt,
    attempts: overrides.attempts ?? 1,
    attemptTimeoutMs: 5_000,
    ...(overrides.adopt === true
      ? {
          adoptTerminal: (stored: {state: RunState; etag: string}): Written => ({
            etag: stored.etag,
            state: stored.state,
          }),
        }
      : {}),
    ...(overrides.onLateCommit === undefined ? {} : {onLateCommit: overrides.onLateCommit}),
  }
}

describe('transitionRetryingStaleEtag — a write that commits after the helper gave up', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the late commit once, with the written record, after the helper already returned a failure', async () => {
    // #given the only attempt times out, and the final re-read still shows a live run
    const write = deferredWrite()
    const onLateCommit = vi.fn()
    const options = lateCommitOptions({attempt: async () => write.promise, onLateCommit, adopt: true})

    // #when the helper gives up, and only then does the abandoned write resolve
    const pending = transitionRetryingStaleEtag(options)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending
    expect(result.success).toBe(false)
    expect(onLateCommit).not.toHaveBeenCalled()
    write.settle(ok(COMMITTED))
    await vi.advanceTimersByTimeAsync(0)

    // #then
    expect(onLateCommit).toHaveBeenCalledExactlyOnceWith(COMMITTED)
    expect(options.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({runId: RUN_ID}),
      expect.stringContaining('committed late'),
    )
  })

  it('reports at most one late commit even when several abandoned writes commit', async () => {
    // #given two attempts that both time out
    const first = deferredWrite()
    const second = deferredWrite()
    const writes = [first, second]
    const onLateCommit = vi.fn()
    const options = lateCommitOptions({
      attempt: async () => (writes.shift() ?? second).promise,
      onLateCommit,
      attempts: 2,
      adopt: true,
    })

    // #when
    const pending = transitionRetryingStaleEtag(options)
    await vi.advanceTimersByTimeAsync(30_000)
    await pending
    first.settle(ok(COMMITTED))
    second.settle(ok({etag: 'etag-late-2', state: COMMITTED.state}))
    await vi.advanceTimersByTimeAsync(0)

    // #then
    expect(onLateCommit).toHaveBeenCalledTimes(1)
  })

  it('does not report a late commit after the helper already returned success', async () => {
    // #given the first attempt times out, the retry succeeds
    const first = deferredWrite()
    const onLateCommit = vi.fn()
    let calls = 0
    const options = lateCommitOptions({
      attempt: async () => {
        calls += 1
        return calls === 1 ? first.promise : ok({etag: 'etag-done', state: runState({phase: 'COMPLETED'})})
      },
      onLateCommit,
      attempts: 2,
    })

    // #when
    const pending = transitionRetryingStaleEtag(options)
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await pending
    first.settle(ok(COMMITTED))
    await vi.advanceTimersByTimeAsync(0)

    // #then
    expect(result.success).toBe(true)
    expect(onLateCommit).not.toHaveBeenCalled()
  })

  it('does not report a late commit after the helper adopted a terminal record', async () => {
    // #given the only attempt times out, and the final re-read finds the run terminal
    const write = deferredWrite()
    const onLateCommit = vi.fn()
    const options = lateCommitOptions({
      attempt: async () => write.promise,
      onLateCommit,
      getObject: storedAs(runState({phase: 'FAILED'}), 'etag-terminal'),
      adopt: true,
    })

    // #when
    const pending = transitionRetryingStaleEtag(options)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending
    write.settle(ok(COMMITTED))
    await vi.advanceTimersByTimeAsync(0)

    // #then
    expect(result.success).toBe(true)
    expect(onLateCommit).not.toHaveBeenCalled()
  })

  it('does not report a late failure', async () => {
    // #given
    const write = deferredWrite()
    const onLateCommit = vi.fn()
    const options = lateCommitOptions({attempt: async () => write.promise, onLateCommit, adopt: true})

    // #when
    const pending = transitionRetryingStaleEtag(options)
    await vi.advanceTimersByTimeAsync(20_000)
    await pending
    write.settle(err(new Error('412 precondition failed')))
    await vi.advanceTimersByTimeAsync(0)

    // #then
    expect(onLateCommit).not.toHaveBeenCalled()
  })

  it('contains a throwing callback and logs it at debug', async () => {
    // #given
    const write = deferredWrite()
    const options = lateCommitOptions({
      attempt: async () => write.promise,
      onLateCommit: () => {
        throw new Error('observer exploded')
      },
      adopt: true,
    })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    // #when
    const pending = transitionRetryingStaleEtag(options)
    await vi.advanceTimersByTimeAsync(20_000)
    await pending
    write.settle(ok(COMMITTED))
    await vi.advanceTimersByTimeAsync(0)
    process.off('unhandledRejection', unhandled)

    // #then
    expect(unhandled).not.toHaveBeenCalled()
    expect(options.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({err: 'observer exploded'}),
      expect.stringContaining('late'),
    )
  })

  it('without a callback, a late commit changes nothing', async () => {
    // #given
    const write = deferredWrite()
    const options = lateCommitOptions({attempt: async () => write.promise, adopt: true})

    // #when
    const pending = transitionRetryingStaleEtag(options)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending
    write.settle(ok(COMMITTED))
    await vi.advanceTimersByTimeAsync(0)

    // #then
    expect(result.success).toBe(false)
  })

  it('returns success, not a failure, when the abandoned write commits before the helper returns', async () => {
    // #given the attempt times out and the final re-read stalls; the abandoned write commits during that read
    const write = deferredWrite()
    const onLateCommit = vi.fn()
    const options = lateCommitOptions({
      attempt: async () => write.promise,
      onLateCommit,
      getObject: vi.fn(async () => new Promise<never>(() => {})),
      adopt: true,
    })

    // #when
    const pending = transitionRetryingStaleEtag(options)
    await vi.advanceTimersByTimeAsync(6_000)
    write.settle(ok(COMMITTED))
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending

    // #then the helper reports the write it now knows about, and the callback is not needed
    expect(result).toEqual(ok(COMMITTED))
    expect(onLateCommit).not.toHaveBeenCalled()
  })
})
