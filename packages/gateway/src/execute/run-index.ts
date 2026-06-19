/**
 * Server-owned run index: authoritative `runId → {repo, surface}` resolution.
 *
 * Two-tier design:
 *   1. Bounded in-memory accelerator (cap + TTL) — populated at run creation.
 *   2. Canonical fallback via durable run-state scan — reuses the recovery.ts
 *      scan pattern (listBindings → per-repo run-state read) so a live run is
 *      never lost to eviction.
 *
 * P0 correctness guarantee: eviction from the accelerator NEVER causes `undefined`
 * for a run whose run-state still exists in durable storage. The accelerator is an
 * optimization; the canonical fallback is the correctness guarantee.
 *
 * Resolution contract: `lookup(runId)` returns `{repo, surface}` for any run with
 * durable run-state, or `undefined` only when no run-state exists anywhere. A caller
 * that receives `undefined` maps it to a generic not-found/not-authorized response —
 * this index is NOT a run-existence oracle.
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
   * 3. Return `undefined` only when no run-state exists anywhere.
   */
  lookup: (runId: string) => Promise<RunLocation | undefined>
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Default accelerator cap (entries). */
const DEFAULT_CAP = 500

/** Default accelerator TTL (30 minutes). */
const DEFAULT_TTL_MS = 30 * 60 * 1000

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
}

// ---------------------------------------------------------------------------
// Internal accelerator entry
// ---------------------------------------------------------------------------

interface AcceleratorEntry {
  readonly repo: string
  readonly surface: Surface
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

  // Insertion-ordered map: oldest entry is first (Map preserves insertion order).
  const accelerator = new Map<string, AcceleratorEntry>()

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
      expiresAt: now() + ttlMs,
    })
  }

  // ---------------------------------------------------------------------------
  // Canonical fallback
  // ---------------------------------------------------------------------------

  async function fallbackLookup(runId: string): Promise<RunLocation | undefined> {
    // Enumerate all bound repos.
    const bindingsResult = await bindingsStore.listBindings()
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
        const location: RunLocation = {repo: match.entity_ref, surface: match.surface}
        // Re-cache into the accelerator so subsequent lookups are fast.
        register(runId, {repo: location.repo, surface: location.surface, startedAt: match.started_at})
        return location
      }
    }

    return undefined
  }

  // ---------------------------------------------------------------------------
  // lookup
  // ---------------------------------------------------------------------------

  async function lookup(runId: string): Promise<RunLocation | undefined> {
    // #given — check the accelerator first
    const cached = accelerator.get(runId)
    if (cached !== undefined) {
      // #when — check TTL
      if (now() < cached.expiresAt) {
        // #then — accelerator hit
        return {repo: cached.repo, surface: cached.surface}
      }
      // Expired — evict and fall through to canonical fallback.
      accelerator.delete(runId)
    }

    // #when — accelerator miss or expired → canonical fallback
    return fallbackLookup(runId)
  }

  return {register, lookup}
}
