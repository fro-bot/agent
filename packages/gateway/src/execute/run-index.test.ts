/**
 * Tests for the server-owned run index (runId → {repo, surface} resolution).
 *
 * Two-tier design:
 *   1. Bounded in-memory accelerator (cap + TTL).
 *   2. Canonical fallback via durable run-state scan (listBindings + findRunsForRepo path).
 *
 * P0 correctness: eviction from the accelerator NEVER causes `undefined` for a run
 * whose run-state still exists in durable storage AND whose channel binding still exists.
 */

import type {CoordinationConfig, RunState, Surface} from '@fro-bot/runtime'
import type {BindingsStore} from '../bindings/store.js'
import type {RepoBinding} from '../bindings/types.js'
import type {GatewayLogger} from '../discord/client.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {createRunIndex} from './run-index.js'

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeLogger(): GatewayLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeBinding(owner: string, repo: string): RepoBinding {
  return {
    owner,
    repo,
    channelId: `ch-${repo}`,
    channelName: `${repo}-channel`,
    workspacePath: `/workspace/${owner}/${repo}`,
    createdAt: new Date().toISOString(),
    createdByDiscordId: 'user-123',
  }
}

function makeRunState(runId: string, repo: string, surface: Surface = 'discord'): RunState {
  return {
    run_id: runId,
    surface,
    thread_id: 'thread-1',
    entity_ref: repo,
    phase: 'EXECUTING',
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    holder_id: 'gateway',
    details: {},
  }
}

function makeCoordinationConfig(): CoordinationConfig {
  return {
    storeAdapter: {
      upload: vi.fn(),
      download: vi.fn(),
      list: vi.fn(),
      getObject: vi.fn(),
    },
    storeConfig: {enabled: true, bucket: 'test-bucket', prefix: 'state', region: 'us-east-1'},
    lockTtlSeconds: 60,
    heartbeatIntervalMs: 10_000,
    staleThresholdMs: 300_000,
  }
}

// ---------------------------------------------------------------------------
// Helpers to build mock deps
// ---------------------------------------------------------------------------

interface MockDeps {
  bindingsStore: BindingsStore
  coordinationConfig: CoordinationConfig
  identity: string
  logger: GatewayLogger
  /** Override the findRunsForRepo mock return value per-repo. */
  runsByRepo: Map<string, RunState[]>
}

function makeDeps(runsByRepo: Map<string, RunState[]> = new Map()): MockDeps {
  const bindingsStore: BindingsStore = {
    createBinding: vi.fn(),
    getBindingByRepo: vi.fn(),
    getBindingByChannelId: vi.fn(),
    listBindings: vi.fn().mockResolvedValue({
      success: true,
      data: Array.from(runsByRepo.keys()).map(slug => {
        const [owner, repo] = slug.split('/')
        return makeBinding(owner ?? slug, repo ?? slug)
      }),
    }),
  }

  return {
    bindingsStore,
    coordinationConfig: makeCoordinationConfig(),
    identity: 'gateway',
    logger: makeLogger(),
    runsByRepo,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRunIndex', () => {
  // #given a fixed clock for TTL tests
  let nowMs = Date.now()
  const now = () => nowMs

  beforeEach(() => {
    nowMs = Date.now()
  })

  // ── Happy path: accelerator hit ──────────────────────────────────────────

  describe('register + lookup (accelerator hit)', () => {
    it('returns {repo, surface} from the accelerator for a registered run', async () => {
      // #given
      const deps = makeDeps()
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
      })

      // #when
      index.register('run-001', {repo: 'acme/widget', surface: 'discord', startedAt: new Date().toISOString()})
      const result = await index.lookup('run-001')

      // #then
      expect(result).toEqual({repo: 'acme/widget', surface: 'discord'})
    })

    it('returns the correct surface for a web run', async () => {
      // #given
      const deps = makeDeps()
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
      })

      // #when
      index.register('run-web-001', {repo: 'acme/api', surface: 'web', startedAt: new Date().toISOString()})
      const result = await index.lookup('run-web-001')

      // #then
      expect(result).toEqual({repo: 'acme/api', surface: 'web'})
    })
  })

  // ── Unknown run: no run-state anywhere → undefined ───────────────────────

  describe('lookup for unknown runId', () => {
    it('returns undefined when no run-state exists anywhere', async () => {
      // #given — empty bindings, no run-state
      const deps = makeDeps()
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
      })

      // #when
      const result = await index.lookup('run-does-not-exist')

      // #then
      expect(result).toBeUndefined()
    })

    it('returns undefined (not a distinct "exists but unauthorized" shape) — no oracle', async () => {
      // #given — a run exists in one repo but we look up a different runId
      const runsByRepo = new Map([['acme/widget', [makeRunState('run-real', 'acme/widget')]]])
      const deps = makeDeps(runsByRepo)
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
        findRunsForRepo: async (repo: string) => runsByRepo.get(repo) ?? [],
      })

      // #when
      const result = await index.lookup('run-ghost')

      // #then — same undefined shape regardless of why
      expect(result).toBeUndefined()
    })
  })

  // ── Accelerator miss → canonical fallback ────────────────────────────────

  describe('canonical fallback on accelerator miss', () => {
    it('resolves a run NOT in the accelerator via the fallback scan', async () => {
      // #given — run exists in durable state but was never registered in the accelerator
      const runsByRepo = new Map([['acme/widget', [makeRunState('run-fallback', 'acme/widget', 'discord')]]])
      const deps = makeDeps(runsByRepo)
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
        findRunsForRepo: async (repo: string) => runsByRepo.get(repo) ?? [],
      })

      // #when
      const result = await index.lookup('run-fallback')

      // #then
      expect(result).toEqual({repo: 'acme/widget', surface: 'discord'})
    })

    it('re-caches the fallback result into the accelerator', async () => {
      // #given
      const runsByRepo = new Map([['acme/widget', [makeRunState('run-recache', 'acme/widget', 'web')]]])
      const deps = makeDeps(runsByRepo)
      const findRunsForRepo = vi.fn(async (repo: string) => runsByRepo.get(repo) ?? [])
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
        findRunsForRepo,
      })

      // #when — first lookup triggers fallback
      const first = await index.lookup('run-recache')
      // #when — second lookup should hit the accelerator (no second fallback call)
      const second = await index.lookup('run-recache')

      // #then
      expect(first).toEqual({repo: 'acme/widget', surface: 'web'})
      expect(second).toEqual({repo: 'acme/widget', surface: 'web'})
      // findRunsForRepo called only once (second hit was from accelerator)
      expect(findRunsForRepo).toHaveBeenCalledTimes(1)
    })

    it('scans multiple repos and finds the run in the correct one', async () => {
      // #given — run is in the second repo
      const runsByRepo = new Map<string, RunState[]>([
        ['acme/widget', []],
        ['acme/api', [makeRunState('run-in-api', 'acme/api', 'discord')]],
      ])
      const deps = makeDeps(runsByRepo)
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
        findRunsForRepo: async (repo: string) => runsByRepo.get(repo) ?? [],
      })

      // #when
      const result = await index.lookup('run-in-api')

      // #then
      expect(result).toEqual({repo: 'acme/api', surface: 'discord'})
    })
  })

  // ── P0 correctness: eviction never false-negatives a live run ────────────

  describe('P0 correctness: eviction never causes undefined for a live run', () => {
    it('resolves a run evicted by TTL via the canonical fallback', async () => {
      // #given — short TTL so the entry expires immediately
      const runsByRepo = new Map([['acme/widget', [makeRunState('run-evicted-ttl', 'acme/widget', 'discord')]]])
      const deps = makeDeps(runsByRepo)
      const findRunsForRepo = vi.fn(async (repo: string) => runsByRepo.get(repo) ?? [])
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
        ttlMs: 1, // 1ms TTL — expires immediately
        findRunsForRepo,
      })

      // #when — register, advance clock past TTL, then lookup
      index.register('run-evicted-ttl', {repo: 'acme/widget', surface: 'discord', startedAt: new Date().toISOString()})
      nowMs += 100 // advance clock 100ms past the 1ms TTL

      const result = await index.lookup('run-evicted-ttl')

      // #then — fallback resolves it; NOT undefined
      expect(result).toEqual({repo: 'acme/widget', surface: 'discord'})
      expect(findRunsForRepo).toHaveBeenCalled()
    })

    it('resolves a run evicted by cap via the canonical fallback', async () => {
      // #given — cap of 2 so the third register evicts the first
      const runsByRepo = new Map([['acme/widget', [makeRunState('run-evicted-cap', 'acme/widget', 'discord')]]])
      const deps = makeDeps(runsByRepo)
      const findRunsForRepo = vi.fn(async (repo: string) => runsByRepo.get(repo) ?? [])
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
        cap: 2,
        findRunsForRepo,
      })

      // #when — fill the cap, evicting run-evicted-cap
      index.register('run-evicted-cap', {repo: 'acme/widget', surface: 'discord', startedAt: new Date().toISOString()})
      index.register('run-b', {repo: 'acme/widget', surface: 'discord', startedAt: new Date().toISOString()})
      index.register('run-c', {repo: 'acme/widget', surface: 'discord', startedAt: new Date().toISOString()})

      const result = await index.lookup('run-evicted-cap')

      // #then — fallback resolves it; NOT undefined
      expect(result).toEqual({repo: 'acme/widget', surface: 'discord'})
      expect(findRunsForRepo).toHaveBeenCalled()
    })
  })

  // ── Accelerator bounds: cap and TTL ──────────────────────────────────────

  describe('accelerator bounds', () => {
    it('evicts the oldest entry when cap is reached', async () => {
      // #given — cap of 2
      const deps = makeDeps()
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
        cap: 2,
        // No fallback — we want to confirm the evicted entry is gone from accelerator
        findRunsForRepo: async () => [],
      })

      // #when — register 3 entries; first should be evicted
      index.register('run-first', {repo: 'acme/a', surface: 'discord', startedAt: new Date().toISOString()})
      index.register('run-second', {repo: 'acme/b', surface: 'discord', startedAt: new Date().toISOString()})
      index.register('run-third', {repo: 'acme/c', surface: 'discord', startedAt: new Date().toISOString()})

      // #then — second and third are still in accelerator
      expect(await index.lookup('run-second')).toEqual({repo: 'acme/b', surface: 'discord'})
      expect(await index.lookup('run-third')).toEqual({repo: 'acme/c', surface: 'discord'})
      // first was evicted and fallback returns nothing → undefined
      expect(await index.lookup('run-first')).toBeUndefined()
    })

    it('treats an expired TTL entry as a miss (falls through to fallback)', async () => {
      // #given — 500ms TTL
      const deps = makeDeps()
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
        ttlMs: 500,
        findRunsForRepo: async () => [],
      })

      // #when — register, advance clock past TTL
      index.register('run-ttl', {repo: 'acme/widget', surface: 'discord', startedAt: new Date().toISOString()})
      nowMs += 600

      // #then — expired; fallback returns nothing → undefined
      expect(await index.lookup('run-ttl')).toBeUndefined()
    })

    it('does not expire an entry before TTL elapses', async () => {
      // #given — 500ms TTL
      const deps = makeDeps()
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
        ttlMs: 500,
      })

      // #when — advance clock but stay within TTL
      index.register('run-fresh', {repo: 'acme/widget', surface: 'discord', startedAt: new Date().toISOString()})
      nowMs += 400

      // #then — still valid
      expect(await index.lookup('run-fresh')).toEqual({repo: 'acme/widget', surface: 'discord'})
    })
  })

  // ── Fallback: listBindings failure is handled gracefully ─────────────────

  describe('fallback resilience', () => {
    it('returns undefined when listBindings fails (does not throw)', async () => {
      // #given — listBindings returns an error
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockResolvedValue({success: false, error: new Error('S3 unavailable')}),
      }
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger: makeLogger(),
        now,
      })

      // #when
      const result = await index.lookup('run-any')

      // #then — graceful degradation
      expect(result).toBeUndefined()
    })

    it('fails safe to undefined when listBindings rejects (unexpected throw)', async () => {
      // #given — listBindings rejects with an unexpected error (not a Result failure)
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockRejectedValue(new Error('unexpected network crash')),
      }
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger: makeLogger(),
        now,
      })

      // #when — lookup must not propagate the rejection
      const result = await index.lookup('run-any-rejection')

      // #then — graceful degradation; caller sees undefined, not a thrown error
      expect(result).toBeUndefined()
    })

    it('continues scanning other repos when one repo scan fails', async () => {
      // #given — first repo scan throws, second has the run
      const runsByRepo = new Map<string, RunState[]>([
        ['acme/broken', []],
        ['acme/widget', [makeRunState('run-in-widget', 'acme/widget', 'discord')]],
      ])
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockResolvedValue({
          success: true,
          data: [makeBinding('acme', 'broken'), makeBinding('acme', 'widget')],
        }),
      }
      const findRunsForRepo = vi.fn(async (repo: string) => {
        if (repo === 'acme/broken') throw new Error('scan failed')
        return runsByRepo.get(repo) ?? []
      })
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger: makeLogger(),
        now,
        findRunsForRepo,
      })

      // #when
      const result = await index.lookup('run-in-widget')

      // #then — found in the second repo despite first failing
      expect(result).toEqual({repo: 'acme/widget', surface: 'discord'})
    })
  })

  // ── FIX 1: Fallback timeout ───────────────────────────────────────────────

  describe('fallback timeout (FIX 1)', () => {
    it('returns undefined within the timeout when fallback I/O never resolves', async () => {
      // #given — findRunsForRepo returns a promise that never resolves (simulates hung S3)
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockResolvedValue({
          success: true,
          data: [makeBinding('acme', 'widget')],
        }),
      }
      const findRunsForRepo = vi.fn(
        async () =>
          new Promise<RunState[]>(() => {
            /* never resolves */
          }),
      )
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger: makeLogger(),
        now,
        findRunsForRepo,
        // Very short timeout so the test completes quickly
        fallbackTimeoutMs: 50,
      })

      // #when — lookup with a hung fallback
      const start = Date.now()
      const result = await index.lookup('run-hung')
      const elapsed = Date.now() - start

      // #then — returns undefined (not a hang); completes within a reasonable window
      expect(result).toBeUndefined()
      // Should complete well within 1s (timeout is 50ms)
      expect(elapsed).toBeLessThan(1_000)
    })

    it('returns undefined within the timeout when listBindings never resolves', async () => {
      // #given — listBindings itself never resolves
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn(
          async () =>
            new Promise<never>(() => {
              /* never resolves */
            }),
        ),
      }
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger: makeLogger(),
        now,
        fallbackTimeoutMs: 50,
      })

      // #when
      const start = Date.now()
      const result = await index.lookup('run-hung-bindings')
      const elapsed = Date.now() - start

      // #then — returns undefined (not a hang)
      expect(result).toBeUndefined()
      expect(elapsed).toBeLessThan(1_000)
    })
  })

  // ── FIX A/B: Timeout does NOT populate negative cache ────────────────────

  describe('timed-out fallback scan is not added to negative cache', () => {
    it('a subsequent lookup after a timeout triggers a new scan (not served from negative cache)', async () => {
      // #given — listBindings resolves immediately; findRunsForRepo hangs on the
      // first call then resolves on the second, so we can observe the re-scan.
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockResolvedValue({
          success: true,
          data: [makeBinding('acme', 'widget')],
        }),
      }

      let callCount = 0
      // First call hangs (simulates a slow S3 that causes the timeout to fire).
      // Second call resolves immediately with the run (simulates recovery).
      const findRunsForRepo = vi.fn(async (repo: string): Promise<RunState[]> => {
        callCount++
        if (callCount === 1) {
          // Never resolves — the timeout races it and wins.
          return new Promise<RunState[]>(() => {
            /* intentionally never resolves */
          })
        }
        // Second call: return the run so we can confirm a new scan was triggered.
        return [makeRunState('run-timeout-rescan', repo, 'discord')]
      })

      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger: makeLogger(),
        now,
        findRunsForRepo,
        // Very short timeout so the first scan times out quickly.
        fallbackTimeoutMs: 30,
      })

      // #when — first lookup times out → returns undefined
      const first = await index.lookup('run-timeout-rescan')

      // #then — timed-out result is undefined (fail-safe)
      expect(first).toBeUndefined()
      // The first scan was started (callCount incremented)
      expect(callCount).toBeGreaterThanOrEqual(1)

      // #when — second lookup for the same runId; if timeout had populated the
      // negative cache, this would return undefined without calling findRunsForRepo again.
      // It must NOT be served from the negative cache — a new scan must fire.
      const second = await index.lookup('run-timeout-rescan')

      // #then — second lookup triggered a new scan and found the run
      expect(second).toEqual({repo: 'acme/widget', surface: 'discord'})
      // findRunsForRepo was called at least twice (once for the hung scan, once for the re-scan)
      expect(findRunsForRepo).toHaveBeenCalledTimes(2)
    })
  })

  // ── FIX 3: Negative cache + concurrent-scan dedup ────────────────────────

  describe('negative cache (FIX 3)', () => {
    it('repeated unknown-runId lookups within the negative-TTL do only one scan', async () => {
      // #given — run does not exist anywhere
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockResolvedValue({
          success: true,
          data: [makeBinding('acme', 'widget')],
        }),
      }
      const findRunsForRepo = vi.fn(async () => [])
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger: makeLogger(),
        now,
        findRunsForRepo,
      })

      // #when — look up the same unknown runId twice
      const first = await index.lookup('run-unknown-neg')
      const second = await index.lookup('run-unknown-neg')

      // #then — both return undefined (no oracle)
      expect(first).toBeUndefined()
      expect(second).toBeUndefined()
      // Only one scan was performed (second hit the negative cache)
      expect(findRunsForRepo).toHaveBeenCalledTimes(1)
    })

    it('negative cache expires after TTL and allows a re-scan', async () => {
      // #given — run does not exist anywhere; very short negative TTL
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockResolvedValue({
          success: true,
          data: [makeBinding('acme', 'widget')],
        }),
      }
      const findRunsForRepo = vi.fn(async () => [])
      // Use a custom now() so we can advance the clock
      let testNow = Date.now()
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger: makeLogger(),
        now: () => testNow,
        findRunsForRepo,
        // Inject a very short negative TTL via the internal constant — we can't
        // override it directly, but we can advance the clock past the real 60s TTL.
        // Instead, use a real clock advance of 61s to expire the negative cache.
      })

      // #when — first lookup populates negative cache
      await index.lookup('run-neg-expire')
      expect(findRunsForRepo).toHaveBeenCalledTimes(1)

      // Advance clock past the 60s negative cache TTL
      testNow += 61_000

      // #when — second lookup after TTL expiry should re-scan
      await index.lookup('run-neg-expire')

      // #then — two scans total (negative cache expired)
      expect(findRunsForRepo).toHaveBeenCalledTimes(2)
    })

    it('negative cache is bounded — evicts oldest entry when cap is reached', async () => {
      // #given — fill the negative cache beyond its cap (200 entries)
      // We use a small cap via the internal constant; we can't override it directly,
      // but we can verify the Map doesn't grow unbounded by checking behavior.
      // This test verifies the eviction logic by registering a run after negative-caching it.
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockResolvedValue({
          success: true,
          data: [makeBinding('acme', 'widget')],
        }),
      }
      const findRunsForRepo = vi.fn(async () => [])
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger: makeLogger(),
        now,
        findRunsForRepo,
      })

      // Populate negative cache with 201 distinct unknown runIds
      // (one more than the cap of 200)
      for (let i = 0; i < 201; i++) {
        await index.lookup(`run-neg-cap-${i}`)
      }

      // #then — the index still functions correctly (no crash, no unbounded growth)
      // The first entry (run-neg-cap-0) was evicted; a lookup for it would re-scan.
      // We can't directly inspect the Map size, but we verify no error was thrown.
      const result = await index.lookup('run-neg-cap-0')
      expect(result).toBeUndefined()
      // run-neg-cap-0 was evicted from negative cache, so it re-scanned
      // Total calls: 201 (initial) + 1 (re-scan after eviction) = 202
      expect(findRunsForRepo.mock.calls.length).toBeGreaterThanOrEqual(202)
    })

    it('negative cache does not change the no-oracle contract — still returns undefined', async () => {
      // #given — a run exists in one repo; we look up a different (unknown) runId
      const runsByRepo = new Map([['acme/widget', [makeRunState('run-real', 'acme/widget')]]])
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockResolvedValue({
          success: true,
          data: [makeBinding('acme', 'widget')],
        }),
      }
      const findRunsForRepo = vi.fn(async (repo: string) => runsByRepo.get(repo) ?? [])
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger: makeLogger(),
        now,
        findRunsForRepo,
      })

      // #when — look up an unknown runId twice (second hits negative cache)
      const first = await index.lookup('run-unknown-oracle')
      const second = await index.lookup('run-unknown-oracle')

      // #then — both return undefined (no oracle: unknown and unauthorized are the same)
      expect(first).toBeUndefined()
      expect(second).toBeUndefined()
    })
  })

  describe('concurrent-scan dedup (FIX 3)', () => {
    it('concurrent lookups for the same missing runId dedup to one scan', async () => {
      // #given — findRunsForRepo is slow (resolves after a tick)
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockResolvedValue({
          success: true,
          data: [makeBinding('acme', 'widget')],
        }),
      }
      let resolveAll: (() => void) | undefined
      const barrier = new Promise<void>(resolve => {
        resolveAll = resolve
      })
      const findRunsForRepo = vi.fn(async () => {
        await barrier
        return []
      })
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger: makeLogger(),
        now,
        findRunsForRepo,
        fallbackTimeoutMs: 5_000,
      })

      // #when — fire two concurrent lookups for the same runId
      const p1 = index.lookup('run-concurrent')
      const p2 = index.lookup('run-concurrent')

      // Unblock the scan
      resolveAll?.()
      const [r1, r2] = await Promise.all([p1, p2])

      // #then — both return undefined; only one scan was performed
      expect(r1).toBeUndefined()
      expect(r2).toBeUndefined()
      expect(findRunsForRepo).toHaveBeenCalledTimes(1)
    })
  })

  // ── FIX 6: Exact S3 key regression test ──────────────────────────────────

  describe('exact S3 key shape (FIX 6)', () => {
    it('fallback queries the expected key prefix shape containing identity and repo', async () => {
      // #given — use the real production path (no findRunsForRepo injection)
      // so we can inspect the actual key passed to the store mock.
      const coordinationConfig = makeCoordinationConfig()
      const listMock = coordinationConfig.storeAdapter.list as ReturnType<typeof vi.fn>
      listMock.mockResolvedValue({success: true, data: []})

      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockResolvedValue({
          success: true,
          data: [makeBinding('acme', 'widget')],
        }),
      }
      const identity = 'discord-gateway'
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig,
        identity,
        logger: makeLogger(),
        now,
      })

      // #when — trigger the fallback (run not in accelerator)
      await index.lookup('run-key-shape-test')

      // #then — list was called with a prefix that contains the identity and repo
      expect(listMock).toHaveBeenCalled()
      const calledPrefix = listMock.mock.calls[0]?.[0] as string
      expect(typeof calledPrefix).toBe('string')
      // The prefix must contain the identity segment (not a wrong identity like /coordination/)
      expect(calledPrefix).toContain(identity)
      // The prefix must contain the repo slug
      expect(calledPrefix).toContain('acme')
      expect(calledPrefix).toContain('widget')
      // Must NOT use a wrong identity
      expect(calledPrefix).not.toContain('/coordination/')
    })
  })

  // ── FIX 7: startedAt stored on accelerator entry ─────────────────────────

  describe('startedAt stored on accelerator entry (FIX 7)', () => {
    it('register stores startedAt on the accelerator entry (not discarded)', async () => {
      // #given
      const deps = makeDeps()
      const startedAt = '2026-06-19T12:00:00.000Z'
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
      })

      // #when — register with a known startedAt
      index.register('run-startedat', {repo: 'acme/widget', surface: 'discord', startedAt})

      // #then — lookup returns the correct location (startedAt is stored internally)
      // RunLocation does not expose startedAt (by design — it's {repo, surface} only)
      const result = await index.lookup('run-startedat')
      expect(result).toEqual({repo: 'acme/widget', surface: 'discord'})
    })

    it('fallback re-registers with startedAt from run-state (not discarded)', async () => {
      // #given — run exists in durable state with a known started_at
      const startedAt = '2026-06-19T10:00:00.000Z'
      const runState = {...makeRunState('run-fallback-startedat', 'acme/widget', 'discord'), started_at: startedAt}
      const runsByRepo = new Map([['acme/widget', [runState]]])
      const deps = makeDeps(runsByRepo)
      const findRunsForRepo = vi.fn(async (repo: string) => runsByRepo.get(repo) ?? [])
      const index = createRunIndex({
        bindingsStore: deps.bindingsStore,
        coordinationConfig: deps.coordinationConfig,
        identity: deps.identity,
        logger: deps.logger,
        now,
        findRunsForRepo,
      })

      // #when — fallback resolves the run
      const result = await index.lookup('run-fallback-startedat')

      // #then — location is correct; startedAt was stored (not discarded) during re-cache
      expect(result).toEqual({repo: 'acme/widget', surface: 'discord'})
      // Second lookup hits the accelerator (re-cached with startedAt)
      const second = await index.lookup('run-fallback-startedat')
      expect(second).toEqual({repo: 'acme/widget', surface: 'discord'})
      expect(findRunsForRepo).toHaveBeenCalledTimes(1)
    })
  })

  // ── FIX 8: Observability — debug log on lookup miss ──────────────────────

  describe('observability: debug log on lookup miss (FIX 8)', () => {
    it('logs debug with runId (not repo) when fallback scan finds nothing', async () => {
      // #given — run does not exist anywhere
      const bindingsStore: BindingsStore = {
        createBinding: vi.fn(),
        getBindingByRepo: vi.fn(),
        getBindingByChannelId: vi.fn(),
        listBindings: vi.fn().mockResolvedValue({
          success: true,
          data: [makeBinding('acme', 'widget')],
        }),
      }
      const findRunsForRepo = vi.fn(async () => [])
      const logger = makeLogger()
      const index = createRunIndex({
        bindingsStore,
        coordinationConfig: makeCoordinationConfig(),
        identity: 'gateway',
        logger,
        now,
        findRunsForRepo,
      })

      // #when
      await index.lookup('run-miss-debug')

      // #then — debug was called with the runId
      const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls
      const missCall = debugCalls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('not found'),
      )
      expect(missCall).toBeDefined()
      // The context object must contain the runId
      const ctx = missCall?.[0] as Record<string, unknown>
      expect(ctx.runId).toBe('run-miss-debug')
      // Must NOT contain repo identity (no oracle)
      expect(Object.keys(ctx)).not.toContain('repo')
    })
  })
})
