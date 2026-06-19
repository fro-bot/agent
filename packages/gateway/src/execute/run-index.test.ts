/**
 * Tests for the server-owned run index (runId → {repo, surface} resolution).
 *
 * Two-tier design:
 *   1. Bounded in-memory accelerator (cap + TTL).
 *   2. Canonical fallback via durable run-state scan (listBindings + findStaleRuns path).
 *
 * P0 correctness: eviction from the accelerator NEVER causes `undefined` for a run
 * whose run-state still exists in durable storage.
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
  /** Override the findStaleRuns mock return value per-repo. */
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
})
