import type {CoordinationConfig, Result, RunState} from '@fro-bot/runtime'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'

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
    expect(getObject).toHaveBeenCalledExactlyOnceWith(RUN_KEY)
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
