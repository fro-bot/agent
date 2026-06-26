/**
 * Server-owned run index: authoritative `runId → {repo, surface}` resolution.
 *
 * Two-tier design:
 *   1. Bounded in-memory accelerator (cap + TTL) — populated at run creation.
 *   2. Canonical fallback via durable run-state scan — reuses the recovery.ts
 *      scan pattern (listBindings → per-repo run-state read) so a live run is
 *      never lost to eviction.
 *
 * Accelerator sizing: DEFAULT_CAP=500 entries / DEFAULT_TTL_MS=30 min.
 * Sized for a single-operator deployment where concurrent active runs are
 * well below 500 and 30 min covers the typical run lifetime.
 *
 * P0 correctness guarantee: eviction from the accelerator NEVER causes `undefined`
 * for a run whose run-state still exists in durable storage AND whose channel
 * binding still exists. The accelerator is an optimization; the canonical fallback
 * is the correctness guarantee.
 *
 * Binding-removal staleness is ACCEPTABLE by design: the canonical fallback
 * resolves a run only while its channel binding still exists. Once a channel is
 * unbound, its runs are intentionally NOT operator-observable — the binding is
 * the authorization anchor. No binding means no repo-access path, so an unbound
 * run has no authz path anyway. The P0 invariant is therefore: evicted-but-live
 * AND still-bound always resolves.
 *
 * Resolution contract: `lookup(runId)` returns `{repo, surface}` for any run with
 * durable run-state and a live binding, or `undefined` otherwise. A caller that
 * receives `undefined` maps it to a generic not-found/not-authorized response —
 * this index is NOT a run-existence oracle.
 *
 * Fallback note: the per-repo scan mirrors the recovery.ts scan pattern
 * (listBindings → per-repo run-state read). Both use the shared
 * getRunPrefix/parseRunState from @fro-bot/runtime, which bounds drift risk.
 * If the run-state key/scan format changes in @fro-bot/runtime, both paths
 * are updated together.
 */

import type {CoordinationConfig, RunState, Surface} from '@fro-bot/runtime'

import type {BindingsStore} from '../bindings/store.js'
import type {GatewayLogger} from '../discord/client.js'
import {getRunPrefix, parseRunState} from '@fro-bot/runtime'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Resolved run location returned by `lookup`. */
export interface RunLocation {
  /** `owner/repo` string (entity_ref from run-state). */
  readonly repo: string
  readonly surface: Surface
}

/** Entry written into the accelerator at run creation. */
export interface RunIndexEntry {
  readonly repo: string
  readonly surface: Surface
  readonly startedAt: string
}

export interface RunIndex {
  /**
   * Register a run in the bounded in-memory accelerator.
   *
   * Called by `run.ts` immediately after run-state is created. Evicts the
   * oldest entry when the cap is reached.
   */
  register: (runId: string, entry: RunIndexEntry) => void

  /**
   * Resolve a `runId` to its `{repo, surface}`.
   *
   * 1. Accelerator hit → return immediately.
   * 2. Miss → canonical fallback: scan all bound repos via durable run-state.
   *    Cache the result back into the accelerator.
   * 3. Return `undefined` only when no run-state exists anywhere (or the
   *    fallback scan times out — treated as not-found, not an error).
   *
   * getOperatorToken re-auth contract (deferred to 4b): a 4b route calls
   * get() to confirm the session is valid, then getOperatorToken(). A valid
   * session with undefined token means re-auth is needed (distinct from
   * no-session). The typed re-auth result shape is designed with the 4b consumer.
   */
  lookup: (runId: string) => Promise<RunLocation | undefined>

  /**
   * Return all run-states for a single repo, bounded to the newest
   * MAX_RUNS_PER_REPO entries when the store adapter supports metadata listing.
   *
   * Does NOT touch the accelerator or negative cache — this is a read scan,
   * not a runId resolution. A failing key is skipped (not fatal).
   */
  listRunsForRepo: (repo: string) => Promise<readonly RunState[]>
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Default accelerator cap (entries). Sized for single-operator deployment. */
const DEFAULT_CAP = 500

/** Default accelerator TTL (30 minutes). Covers typical run lifetime. */
const DEFAULT_TTL_MS = 30 * 60 * 1000

/**
 * Timeout for the canonical fallback scan (listBindings + per-repo reads).
 * A slow/hanging S3 would stall lookup() and block the SSE subscribe route.
 * On timeout → treat as "not resolved via fallback" and return undefined
 * (fail-safe: a route getting undefined denies; better than hanging).
 */
const RUN_INDEX_FALLBACK_TIMEOUT_MS = 8_000

/**
 * Negative cache TTL: a runId that resolved to "not found" via fallback is
 * remembered for this duration so repeated misses don't re-scan within the window.
 */
const NEGATIVE_CACHE_TTL_MS = 60_000

/**
 * Negative cache cap: bounded to prevent unbounded growth from unknown runId floods.
 * Oldest entry is evicted when the cap is reached (same pattern as the accelerator).
 */
const NEGATIVE_CACHE_CAP = 200

/**
 * Per-repo read cap for listRunsForRepo when the store adapter provides listWithMetadata.
 * Bounds the number of getObject calls per repo to the newest K objects by LastModified.
 * Large enough to comfortably hold the global newest-100 across the per-repo set.
 */
const MAX_RUNS_PER_REPO = 200

export interface RunIndexDeps {
  readonly bindingsStore: BindingsStore
  readonly coordinationConfig: CoordinationConfig
  readonly identity: string
  readonly logger: GatewayLogger
  /** Wall-clock provider — injectable for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Max accelerator entries before oldest is evicted. Defaults to 500. */
  readonly cap?: number
  /** Accelerator TTL in milliseconds. Defaults to 30 minutes. */
  readonly ttlMs?: number
  /**
   * Injectable run-state reader for the canonical fallback.
   *
   * Receives an `owner/repo` slug and returns all run-states for that repo.
   * Defaults to the production path (uses the coordination config's store adapter
   * to list + read run-state objects). Injected in tests to avoid real S3 calls.
   *
   * Errors thrown by this function are caught per-repo and logged; the scan
   * continues to the next repo.
   */
  readonly findRunsForRepo?: (repo: string) => Promise<readonly RunState[]>
  /**
   * Fallback scan timeout in milliseconds. Defaults to RUN_INDEX_FALLBACK_TIMEOUT_MS (8s).
   * Injectable for tests.
   */
  readonly fallbackTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Internal accelerator entry
// ---------------------------------------------------------------------------

interface AcceleratorEntry {
  readonly repo: string
  readonly surface: Surface
  readonly startedAt: string
  readonly expiresAt: number
}

// ---------------------------------------------------------------------------
// Internal negative cache entry
// ---------------------------------------------------------------------------

interface NegativeCacheEntry {
  readonly expiresAt: number
}

// ---------------------------------------------------------------------------
// Production fallback: scan a single repo for all run-states
// ---------------------------------------------------------------------------

/**
 * Read all run-states for a given repo from durable storage.
 *
 * Mirrors the list+getObject pattern from `recovery.ts` but returns ALL
 * run-states (not just stale EXECUTING ones) so recently-created runs in any
 * phase are resolvable.
 *
 * Called only on an accelerator miss; the result is re-cached so this cost is
 * paid at most once per runId per gateway lifetime.
 */
async function readRunsForRepo(
  coordinationConfig: CoordinationConfig,
  identity: string,
  repo: string,
  logger: GatewayLogger,
): Promise<readonly RunState[]> {
  const prefixResult = getRunPrefix(coordinationConfig, identity, repo)
  if (prefixResult.success === false) {
    logger.warn({repo, err: prefixResult.error.message}, 'run-index: getRunPrefix failed — skipping repo')
    return []
  }

  const listed = await coordinationConfig.storeAdapter.list(prefixResult.data)
  if (listed.success === false) {
    logger.warn({repo, err: listed.error.message}, 'run-index: list failed — skipping repo')
    return []
  }

  if (coordinationConfig.storeAdapter.getObject == null) {
    logger.warn({repo}, 'run-index: store adapter does not support getObject — skipping repo')
    return []
  }

  const getObject = coordinationConfig.storeAdapter.getObject.bind(coordinationConfig.storeAdapter)
  const runs: RunState[] = []

  for (const key of listed.data) {
    const fetched = await getObject(key)
    if (fetched.success === false) {
      logger.debug({repo, key, err: fetched.error.message}, 'run-index: getObject failed — skipping key')
      continue
    }
    const parsed = parseRunState(fetched.data.data)
    if (parsed.success === false) {
      logger.debug({repo, key, err: parsed.error.message}, 'run-index: parseRunState failed — skipping key')
      continue
    }
    runs.push(parsed.data)
  }

  return runs
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRunIndex(deps: RunIndexDeps): RunIndex {
  const {bindingsStore, coordinationConfig, identity, logger} = deps
  const cap = deps.cap ?? DEFAULT_CAP
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const now = deps.now ?? (() => Date.now())
  const fallbackTimeoutMs = deps.fallbackTimeoutMs ?? RUN_INDEX_FALLBACK_TIMEOUT_MS

  // Insertion-ordered map: oldest entry is first (Map preserves insertion order).
  const accelerator = new Map<string, AcceleratorEntry>()

  // Negative cache: runIds confirmed "not found" via fallback, bounded by cap + TTL.
  // Prevents repeated full scans for unknown runIds (S3 amplification mitigation).
  // Security: still returns undefined — no oracle leak; just avoids redundant scans.
  const negativeCache = new Map<string, NegativeCacheEntry>()

  // Inflight fallback dedup: if a scan for a given runId is already in flight,
  // concurrent lookups for the same runId await the same promise (mirrors denylist.ts pattern).
  const inflightFallbacks = new Map<string, Promise<RunLocation | undefined>>()

  // ---------------------------------------------------------------------------
  // register
  // ---------------------------------------------------------------------------

  function register(runId: string, entry: RunIndexEntry): void {
    // Evict oldest when at cap (before inserting so we never exceed cap).
    if (accelerator.size >= cap) {
      const oldestKey = accelerator.keys().next().value
      if (oldestKey !== undefined) {
        accelerator.delete(oldestKey)
      }
    }

    // Re-inserting an existing key moves it to the end (newest). Delete first
    // so the insertion order reflects the latest registration.
    accelerator.delete(runId)
    accelerator.set(runId, {
      repo: entry.repo,
      surface: entry.surface,
      startedAt: entry.startedAt,
      expiresAt: now() + ttlMs,
    })

    // A newly registered runId is known-good — remove from negative cache if present.
    negativeCache.delete(runId)
  }

  // ---------------------------------------------------------------------------
  // Negative cache helpers
  // ---------------------------------------------------------------------------

  function isNegativelyCached(runId: string): boolean {
    const entry = negativeCache.get(runId)
    if (entry === undefined) return false
    if (now() >= entry.expiresAt) {
      // Expired — evict and treat as not cached.
      negativeCache.delete(runId)
      return false
    }
    return true
  }

  function addToNegativeCache(runId: string): void {
    // Evict oldest when at cap.
    if (negativeCache.size >= NEGATIVE_CACHE_CAP) {
      const oldestKey = negativeCache.keys().next().value
      if (oldestKey !== undefined) {
        negativeCache.delete(oldestKey)
      }
    }
    negativeCache.delete(runId)
    negativeCache.set(runId, {expiresAt: now() + NEGATIVE_CACHE_TTL_MS})
  }

  // ---------------------------------------------------------------------------
  // Canonical fallback (with timeout + negative cache + inflight dedup)
  // ---------------------------------------------------------------------------

  async function doFallbackScan(runId: string): Promise<RunLocation | undefined> {
    // Enumerate all bound repos.
    // listBindings is contractually Result-returning (never throws), but we wrap
    // defensively so any unexpected rejection fails safe to undefined rather than
    // propagating to the caller (belt-and-suspenders: every other fallback path
    // already returns undefined on error).
    let bindingsResult: Awaited<ReturnType<typeof bindingsStore.listBindings>>
    try {
      bindingsResult = await bindingsStore.listBindings()
    } catch (error: unknown) {
      logger.warn(
        {err: error instanceof Error ? error.message : String(error)},
        'run-index: listBindings threw unexpectedly — cannot resolve via fallback',
      )
      return undefined
    }
    if (bindingsResult.success === false) {
      logger.warn({err: bindingsResult.error.message}, 'run-index: listBindings failed — cannot resolve via fallback')
      return undefined
    }

    const bindings = bindingsResult.data
    if (bindings.length === 0) {
      return undefined
    }

    // Resolve the per-repo scanner (injected in tests; production path uses store adapter).
    const findRunsForRepo =
      deps.findRunsForRepo ?? (async (repo: string) => readRunsForRepo(coordinationConfig, identity, repo, logger))

    // Scan each repo for the matching runId.
    for (const binding of bindings) {
      const repo = `${binding.owner}/${binding.repo}`
      let runs: readonly RunState[]
      try {
        runs = await findRunsForRepo(repo)
      } catch (error: unknown) {
        logger.warn(
          {repo, err: error instanceof Error ? error.message : String(error)},
          'run-index: findRunsForRepo threw — skipping repo',
        )
        continue
      }

      const match = runs.find(r => r.run_id === runId)
      if (match !== undefined) {
        // Strip the '#runNumber' fragment from entity_ref before storing in RunLocation.
        // entity_ref is 'owner/repo#N'; RunLocation.repo must be 'owner/repo' only.
        // Pre-existing bug (CORR-001): without this strip, the '#N' fragment leaks
        // into the accelerator cache's repo field and any downstream consumer of lookup().
        const entityRefRepo = match.entity_ref.split('#')[0] ?? match.entity_ref
        const location: RunLocation = {repo: entityRefRepo, surface: match.surface}
        // Re-cache into the accelerator so subsequent lookups are fast.
        register(runId, {repo: location.repo, surface: location.surface, startedAt: match.started_at})
        return location
      }
    }

    // Not found in any bound repo — add to negative cache to avoid re-scanning.
    addToNegativeCache(runId)
    logger.debug({runId}, 'run-index: fallback scan complete — runId not found in any bound repo')
    return undefined
  }

  async function fallbackLookup(runId: string): Promise<RunLocation | undefined> {
    // Negative cache hit: skip the scan entirely.
    if (isNegativelyCached(runId)) {
      return undefined
    }

    // Inflight dedup: if a scan for this runId is already in flight, await it.
    const existing = inflightFallbacks.get(runId)
    if (existing !== undefined) {
      return existing
    }

    // Start a new scan, bounded by the fallback timeout.
    // On timeout → return undefined (fail-safe: deny is better than hanging).
    const scanPromise = Promise.race([
      doFallbackScan(runId),
      new Promise<undefined>(resolve => {
        setTimeout(() => {
          resolve(undefined)
        }, fallbackTimeoutMs)
      }),
    ]).finally(() => {
      inflightFallbacks.delete(runId)
    })

    inflightFallbacks.set(runId, scanPromise)
    return scanPromise
  }

  // ---------------------------------------------------------------------------
  // lookup
  // ---------------------------------------------------------------------------

  async function lookup(runId: string): Promise<RunLocation | undefined> {
    // Check the accelerator first.
    const cached = accelerator.get(runId)
    if (cached !== undefined) {
      // Check TTL.
      if (now() < cached.expiresAt) {
        // Accelerator hit — return immediately.
        return {repo: cached.repo, surface: cached.surface}
      }
      // Expired — evict and fall through to canonical fallback.
      accelerator.delete(runId)
    }

    // Accelerator miss or expired → canonical fallback.
    return fallbackLookup(runId)
  }

  // ---------------------------------------------------------------------------
  // listRunsForRepo
  // ---------------------------------------------------------------------------

  async function fetchRunsForKeys(
    keys: readonly string[],
    getObject: NonNullable<typeof coordinationConfig.storeAdapter.getObject>,
  ): Promise<RunState[]> {
    const runs: RunState[] = []
    for (const key of keys) {
      const fetched = await getObject(key)
      if (fetched.success === false) {
        logger.debug({key, err: fetched.error.message}, 'run-index: getObject failed in listRunsForRepo — skipping key')
        continue
      }
      const parsed = parseRunState(fetched.data.data)
      if (parsed.success === false) {
        logger.debug(
          {key, err: parsed.error.message},
          'run-index: parseRunState failed in listRunsForRepo — skipping key',
        )
        continue
      }
      runs.push(parsed.data)
    }
    return runs
  }

  async function listRunsForRepo(repo: string): Promise<readonly RunState[]> {
    // Injectable override takes precedence (used in tests; production uses the store adapter).
    if (deps.findRunsForRepo !== undefined) {
      return deps.findRunsForRepo(repo)
    }

    const prefixResult = getRunPrefix(coordinationConfig, identity, repo)
    if (prefixResult.success === false) {
      logger.warn(
        {repo, err: prefixResult.error.message},
        'run-index: getRunPrefix failed in listRunsForRepo — returning empty',
      )
      return []
    }

    const prefix = prefixResult.data

    if (coordinationConfig.storeAdapter.getObject == null) {
      logger.warn({repo}, 'run-index: store adapter does not support getObject in listRunsForRepo — returning empty')
      return []
    }

    const getObject = coordinationConfig.storeAdapter.getObject.bind(coordinationConfig.storeAdapter)

    // When the adapter provides listWithMetadata, sort by lastModified desc and cap to newest K.
    if (coordinationConfig.storeAdapter.listWithMetadata !== undefined) {
      const listed = await coordinationConfig.storeAdapter.listWithMetadata(prefix)
      if (listed.success === false) {
        logger.warn(
          {repo, err: listed.error.message},
          'run-index: listWithMetadata failed in listRunsForRepo — returning empty',
        )
        return []
      }

      // Sort newest-first, take the cap.
      const sorted = listed.data.slice().sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
      const capped = sorted.slice(0, MAX_RUNS_PER_REPO)
      return fetchRunsForKeys(
        capped.map(e => e.key),
        getObject,
      )
    }

    // Fallback: unbounded list() path (adapters without listWithMetadata).
    const listed = await coordinationConfig.storeAdapter.list(prefix)
    if (listed.success === false) {
      logger.warn({repo, err: listed.error.message}, 'run-index: list failed in listRunsForRepo — returning empty')
      return []
    }

    return fetchRunsForKeys(listed.data, getObject)
  }

  return {register, lookup, listRunsForRepo}
}
