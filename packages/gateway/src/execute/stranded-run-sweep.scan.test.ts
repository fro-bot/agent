import type {CoordinationConfig} from '@fro-bot/runtime'
import type {BindingsStore} from '../bindings/store.js'
import type {GatewayLogger} from '../discord/client.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createStrandedRunPass, createStrandedRunSweep, STRANDED_RUN_SWEEP_PASS_BOUND_MS} from './stranded-run-sweep.js'

// ---------------------------------------------------------------------------
// The sweep over the REAL recoverStaleRuns and findStaleRuns, against a fake store. A slow scan of one repo must not
// starve the repos after it, and a store call that ignores its signal must not wedge the sweep.
// ---------------------------------------------------------------------------

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeBindings(repos: readonly string[]): BindingsStore {
  return {
    createBinding: vi.fn(),
    getBindingByRepo: vi.fn(),
    getBindingByChannelId: vi.fn(),
    listBindings: vi.fn().mockResolvedValue({
      success: true,
      data: repos.map(repo => ({owner: 'acme', repo})),
    }),
  }
}

function makeConfig(adapter: Record<string, unknown>): CoordinationConfig {
  return {
    storeAdapter: {upload: vi.fn(), download: vi.fn(), ...adapter},
    storeConfig: {enabled: true, bucket: 'test', region: 'us-east-1', prefix: 'state'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  } as unknown as CoordinationConfig
}

function makePass(config: CoordinationConfig, repos: readonly string[], logger: GatewayLogger) {
  return createStrandedRunPass({
    recoverDeps: {
      coordinationConfig: config,
      identity: 'gw',
      bindingsStore: makeBindings(repos),
      checkRepoQuiescence: vi.fn(),
      resolveThread: vi.fn().mockResolvedValue(null),
      logger,
    },
    isOwned: () => false,
    observeTerminal: vi.fn(),
  })
}

describe('the stranded-run sweep over a slow store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts mid-scan at the bound, without waiting for the slow scan to finish, and never starts the next repo', async () => {
    // #given the first repo has many records and every read takes until it is aborted (it honours its signal)
    const listed: string[] = []
    const reads: string[] = []
    const config = makeConfig({
      list: vi.fn(async (prefix: string) => {
        listed.push(prefix)
        return {success: true, data: [`${prefix}runs/a.json`, `${prefix}runs/b.json`, `${prefix}runs/c.json`]}
      }),
      getObject: vi.fn(
        async (key: string, options?: {signal?: AbortSignal}) =>
          new Promise(resolve => {
            reads.push(key)
            options?.signal?.addEventListener('abort', () => {
              resolve({success: false, error: new Error('aborted')})
            })
          }),
      ),
    })
    const logger = makeLogger()
    // a long interval, so the tick right after the bound does not start a second pass inside this assertion
    const sweep = createStrandedRunSweep({
      pass: makePass(config, ['first', 'second'], logger),
      logger,
      intervalMs: 100_000,
    })
    sweep.start()

    // #when the pass has been scanning for the whole bound
    await vi.advanceTimersByTimeAsync(100_000)
    expect(reads).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(STRANDED_RUN_SWEEP_PASS_BOUND_MS)

    // #then the abort cut the first read short: it did not read the other two records, and never listed the next repo
    expect(reads).toHaveLength(1)
    expect(listed).toHaveLength(1)
    sweep.stop()
  })

  it('stays alive when a store call ignores its signal: the next tick starts a new pass', async () => {
    // #given a store whose list never answers and ignores any signal
    const list = vi.fn(async () => new Promise<never>(() => {}))
    const config = makeConfig({list, getObject: vi.fn()})
    const logger = makeLogger()
    const sweep = createStrandedRunSweep({pass: makePass(config, ['first'], logger), logger})
    sweep.start()

    // #when the first pass is abandoned at its bound
    await vi.advanceTimersByTimeAsync(60_000 + STRANDED_RUN_SWEEP_PASS_BOUND_MS)
    await vi.advanceTimersByTimeAsync(60_000)

    // #then a second pass began
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2)
    sweep.stop()
  })
})
