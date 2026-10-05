import type {CoordinationConfig, LockRecord} from '@fro-bot/runtime'
import type {SessionStatusClient} from './repo-quiescence.js'

import {err, ok} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
/* eslint-disable perfectionist/sort-imports -- ./test-helpers.js must import before any real module
   it mocks, to register vi.mock() side effects before those modules are evaluated */
import {
  buildMockRunState,
  makeBinding,
  makeDefaultConcurrency,
  makeDefaultQueue,
  makeDeps,
  makeMessage,
  mockRunOpenCodeCore,
  mockRuntime,
  setupHappyPath,
} from './test-helpers.js'
import * as runCoreModule from './run-core.js'
import {createRepoQuiescenceChecker} from './repo-quiescence.js'
/* eslint-enable perfectionist/sort-imports */

// ---------------------------------------------------------------------------
// Composed: a quarantined run's lock decays past its TTL; a NEW acquisition for the same repo goes through the
// REAL acquireLock (in-memory store with real ETag semantics) and the REAL workspace checker. Only the
// session-status client is faked. Busy/retry children must keep the old lock in place and the new run unexecuted.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-24T18:00:00.000Z')
const LEASE_TTL_MS = 900_000

function jsonResponse() {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'content-type'
          ? 'application/json'
          : name.toLowerCase() === 'content-length'
            ? '10'
            : null,
    },
  }
}

function createInMemoryLockConfig() {
  const objects = new Map<string, {data: string; etag: string}>()
  let version = 0
  const config: CoordinationConfig = {
    storeAdapter: {
      upload: vi.fn(async () => ok(undefined)),
      download: vi.fn(async () => ok(undefined)),
      list: vi.fn(async () => ok([])),
      getObject: vi.fn(async (key: string) => {
        const found = objects.get(key)
        return found === undefined ? err(new Error('NoSuchKey')) : ok({...found})
      }),
      conditionalPut: vi.fn(async (key: string, data: string, options: {ifNoneMatch?: string; ifMatch?: string}) => {
        const found = objects.get(key)
        if (options.ifNoneMatch === '*' && found !== undefined) return err(new Error('precondition failed'))
        if (options.ifMatch !== undefined && options.ifMatch !== found?.etag) {
          return err(new Error('precondition failed'))
        }
        version += 1
        const etag = `etag-${version}`
        objects.set(key, {data, etag})
        return ok({etag})
      }),
    },
    storeConfig: {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
  const lock = (): LockRecord | null => {
    const key = [...objects.keys()].find(candidate => candidate.includes('/locks/'))
    return key === undefined ? null : (JSON.parse(objects.get(key)?.data ?? 'null') as LockRecord)
  }
  return {config, lock}
}

function checkerWith(statuses: Record<string, unknown>) {
  const client: SessionStatusClient = {
    session: {status: vi.fn(async () => ({data: statuses, response: jsonResponse()}))},
  }
  return createRepoQuiescenceChecker({
    workspaceOpencodeUrl: 'http://workspace:9200',
    workspaceOpencodeToken: 'secret-bearer-token',
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    createClient: () => client,
  })
}

async function quarantineThenExpire() {
  const {runMention, QUARANTINE_HOLD_WINDOW_MS} = await import('./run.js')
  const actual = await vi.importActual<typeof import('@fro-bot/runtime')>('@fro-bot/runtime')
  const stopFn = vi.fn().mockResolvedValue({
    success: true,
    data: {runEtag: 'run-etag', lockEtag: 'lock-etag', runState: buildMockRunState()},
  })
  setupHappyPath({stop: stopFn})
  mockRuntime.acquireLock.mockImplementation(actual.acquireLock)
  mockRunOpenCodeCore.mockRejectedValueOnce(
    new runCoreModule.RunCoreError('session-error', 'Session error: LLM quota exceeded', true),
  )
  const store = createInMemoryLockConfig()

  // First run: acquires the lock, quarantines, holds, then stops renewing after the hold window.
  await runMention(makeMessage(), makeBinding(), makeDeps({coordinationConfig: store.config}))
  await vi.advanceTimersByTimeAsync(QUARANTINE_HOLD_WINDOW_MS + 1_000)
  const firstHolder = store.lock()

  // Lease TTL then elapses with nobody renewing.
  await vi.advanceTimersByTimeAsync(LEASE_TTL_MS)

  return {runMention, store, stopFn, firstHolder}
}

describe('quarantined lock decay → new acquisition (composed)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['a busy child', {ses_root: {type: 'idle'}, ses_child: {type: 'busy'}}],
    ['a retrying child', {ses_root: {type: 'idle'}, ses_child: {type: 'retry', attempt: 2, message: 'x', next: 1}}],
  ])('%s keeps the expired lock in place and the new run never executes', async (_label, statuses) => {
    // #given — quarantined run held its window, heartbeat stopped, lock was not released, TTL has passed
    const {runMention, store, stopFn, firstHolder} = await quarantineThenExpire()
    expect(stopFn).toHaveBeenCalledOnce()
    expect(mockRuntime.releaseLock).not.toHaveBeenCalled()
    expect(firstHolder).not.toBeNull()
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const deps = makeDeps({
      coordinationConfig: store.config,
      checkRepoQuiescence: checkerWith(statuses),
      concurrency: makeDefaultConcurrency(),
      queue: makeDefaultQueue(),
      logger,
    })

    // #when — a NEW run for the same repo tries to acquire
    await runMention(makeMessage(), makeBinding(), deps)

    // #then — old lock untouched, new run did not execute, blocked/expired-holder path taken
    expect(store.lock()).toEqual(firstHolder)
    expect(mockRunOpenCodeCore).toHaveBeenCalledOnce()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({outcome: 'expired-holder'}),
      'run: expired lease not corroborated — not taking over',
    )
  })

  it('control: a clear workspace lets the same new acquisition replace the expired lock', async () => {
    // #given
    const {runMention, store, firstHolder} = await quarantineThenExpire()
    const deps = makeDeps({
      coordinationConfig: store.config,
      checkRepoQuiescence: checkerWith({ses_root: {type: 'idle'}}),
      concurrency: makeDefaultConcurrency(),
      queue: makeDefaultQueue(),
    })

    // #when
    await runMention(makeMessage(), makeBinding(), deps)

    // #then — proves the composed harness really exercises takeover, so the blocked cases above are not vacuous
    expect(mockRunOpenCodeCore).toHaveBeenCalledTimes(2)
    expect(firstHolder).not.toBeNull()
  })
})
