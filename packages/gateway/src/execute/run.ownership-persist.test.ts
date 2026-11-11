import type {CoordinationConfig, RunState} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
  buildMockRunState,
  makeBinding,
  makeDeps,
  makeMessage,
  mockRunOpenCodeCoreV2,
  setupHappyPath,
} from './test-helpers.js'

// ---------------------------------------------------------------------------
// fro-bot/agent#2049 — run ownership writes must not race each other.
//
// A single shell call fires the ownership hook 2-3 times within ~30 ms. `patchRunDetails` reads the ETag fresh and then
// writes conditionally, so overlapping calls make the later PUT lose with a 412. The gateway therefore (a) skips a
// write whose payload equals the last one written and (b) keeps at most one write in flight per run, re-snapshotting
// the latest ownership when it finishes. These tests drive the real `patchRunDetails` against a store that, like S3,
// takes time per call and enforces If-Match.
// ---------------------------------------------------------------------------

interface OwnershipInfo {
  readonly rootSessionId: string
  readonly ownedSessionIds: readonly string[]
}
type OnOwnershipChange = (info: OwnershipInfo) => void

/** A store with per-call latency and If-Match enforcement; records every PUT attempt and its outcome. */
function makeLatencyStore(
  options: {
    readonly latencyMs?: number
    readonly onPutCommitted?: () => void
    /** Serve the first GET with an ETag that is already out of date, as if another writer committed in between. */
    readonly staleFirstGet?: boolean
  } = {},
) {
  const latencyMs = options.latencyMs ?? 8
  let stored: {state: RunState; etag: string} = {state: buildMockRunState({phase: 'EXECUTING'}), etag: 'etag-0'}
  let counter = 0
  let staleGetPending = options.staleFirstGet === true
  const puts: {readonly ownedSessionIds: unknown; readonly outcome: 'committed' | 'rejected'}[] = []
  const sleep = async () =>
    new Promise<void>(resolve => {
      setTimeout(resolve, latencyMs)
    })
  const config = {
    storeAdapter: {
      upload: vi.fn(),
      download: vi.fn(),
      list: vi.fn(),
      getObject: vi.fn(async () => {
        const snapshot = {data: JSON.stringify(stored.state), etag: staleGetPending ? 'stale-etag' : stored.etag}
        staleGetPending = false
        await sleep()
        return {success: true as const, data: snapshot}
      }),
      conditionalPut: vi.fn(async (_key: string, data: string, opts: {readonly ifMatch?: string}) => {
        await sleep()
        const next = JSON.parse(data) as RunState
        if (opts.ifMatch !== undefined && opts.ifMatch !== stored.etag) {
          puts.push({ownedSessionIds: next.details.ownedSessionIds, outcome: 'rejected'})
          return {success: false as const, error: new Error('etag mismatch (412)')}
        }
        counter += 1
        stored = {state: next, etag: `etag-${counter}`}
        puts.push({ownedSessionIds: next.details.ownedSessionIds, outcome: 'committed'})
        options.onPutCommitted?.()
        return {success: true as const, data: {etag: stored.etag}}
      }),
    },
    storeConfig: {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'fro-bot-state'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  } as unknown as CoordinationConfig
  return {config, puts: () => puts, storedOwned: () => stored.state.details.ownedSessionIds}
}

function makeLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/** Starts a run whose core stays open, hands back the ownership hook and a way to let the run finish. */
async function startRun(deps: ReturnType<typeof makeDeps>) {
  const {runMention} = await import('./run.js')
  let hook: OnOwnershipChange | undefined
  let release: (() => void) | undefined
  mockRunOpenCodeCoreV2.mockImplementation(async params => {
    hook = (params as {onOwnershipChange?: OnOwnershipChange}).onOwnershipChange
    await new Promise<void>(resolve => {
      release = resolve
    })
  })
  const runPromise = runMention(makeMessage(), makeBinding(), deps)
  await vi.waitFor(() => {
    expect(hook).toBeDefined()
  })
  const fire: OnOwnershipChange = info => {
    hook?.(info)
  }
  return {
    fire,
    finish: async () => {
      release?.()
      await runPromise
    },
  }
}

describe('run ownership persistence (#2049)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupHappyPath()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a burst of distinct ownership changes leaves the latest snapshot stored with no 412 warning', async () => {
    // #given — a store slow enough that unserialized writes would interleave (GET, GET, GET, PUT, PUT, PUT)
    const store = makeLatencyStore()
    const logger = makeLogger()
    const run = await startRun(makeDeps({coordinationConfig: store.config, logger}))

    // #when — three changes inside one tick
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['s1']})
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['s1', 's2']})
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['s2']})
    await delay(150)

    // #then — last writer wins, nothing was rejected, nothing was logged
    expect(store.storedOwned()).toEqual(['s2'])
    expect(store.puts().filter(put => put.outcome === 'rejected')).toEqual([])
    expect(logger.warn).not.toHaveBeenCalled()
    await run.finish()
  })

  it('never unions snapshots: a settled session disappears from the stored ownership', async () => {
    // #given
    const store = makeLatencyStore()
    const run = await startRun(makeDeps({coordinationConfig: store.config}))

    // #when — s1 is adopted, then settles while s2 stays owned
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['s1', 's2']})
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['s2']})
    await delay(100)

    // #then
    expect(store.storedOwned()).toEqual(['s2'])
    await run.finish()
  })

  it('identical payloads produce a single PUT, including ones fired while that write is in flight', async () => {
    // #given — the shell shape from the issue: the same empty snapshot three times in ~30 ms
    const store = makeLatencyStore()
    const logger = makeLogger()
    const run = await startRun(makeDeps({coordinationConfig: store.config, logger}))

    // #when
    run.fire({rootSessionId: 'root-1', ownedSessionIds: []})
    run.fire({rootSessionId: 'root-1', ownedSessionIds: []})
    await delay(30)
    run.fire({rootSessionId: 'root-1', ownedSessionIds: []})
    await delay(100)

    // #then
    expect(store.puts()).toHaveLength(1)
    expect(logger.warn).not.toHaveBeenCalled()
    await run.finish()
  })

  it('treats the same session set in a different order as the same payload', async () => {
    // #given
    const store = makeLatencyStore()
    const run = await startRun(makeDeps({coordinationConfig: store.config}))

    // #when
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['a', 'b']})
    await delay(60)
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['b', 'a']})
    await delay(60)

    // #then
    expect(store.puts()).toHaveLength(1)
    await run.finish()
  })

  it('writes again when a change returns to an earlier payload (dedupe compares only the last write)', async () => {
    // #given
    const store = makeLatencyStore()
    const run = await startRun(makeDeps({coordinationConfig: store.config}))

    // #when — A, B, A
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['a']})
    await delay(60)
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['b']})
    await delay(60)
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['a']})
    await delay(60)

    // #then
    expect(store.puts()).toHaveLength(3)
    expect(store.storedOwned()).toEqual(['a'])
    await run.finish()
  })

  it('a failed write does not poison dedupe: the next identical change writes again', async () => {
    // #given — the first PUT is rejected by an out-of-band writer (ETag bumped between GET and PUT)
    const store = makeLatencyStore({staleFirstGet: true})
    const logger = makeLogger()
    const run = await startRun(makeDeps({coordinationConfig: store.config, logger}))

    // #when
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['s1']})
    await delay(60)
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['s1']})
    await delay(60)

    // #then — one rejected attempt (warned), then the identical payload was retried and committed
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(store.puts().map(put => put.outcome)).toEqual(['rejected', 'committed'])
    expect(store.storedOwned()).toEqual(['s1'])
    await run.finish()
  })

  it('the run does not stop its heartbeat until an in-flight ownership write has landed', async () => {
    // #given — ownership changes right as the core resolves; the write is still in flight at that moment
    const events: string[] = []
    const store = makeLatencyStore({
      latencyMs: 15,
      onPutCommitted: () => {
        events.push('ownership-put')
      },
    })
    const stopFn = vi.fn(async () => {
      events.push('heartbeat-stop')
      return {
        success: true as const,
        data: {runEtag: 'run-etag', lockEtag: 'lock-etag', runState: buildMockRunState()},
      }
    })
    setupHappyPath({stop: stopFn})
    const run = await startRun(makeDeps({coordinationConfig: store.config}))

    // #when
    run.fire({rootSessionId: 'root-1', ownedSessionIds: ['s1']})
    run.fire({rootSessionId: 'root-1', ownedSessionIds: []})
    await run.finish()

    // #then — terminal handling (which starts with heartbeat.stop) waited for the queue to drain, latest snapshot last
    expect(events).toEqual(['ownership-put', 'ownership-put', 'heartbeat-stop'])
    expect(store.storedOwned()).toEqual([])
  })
})
