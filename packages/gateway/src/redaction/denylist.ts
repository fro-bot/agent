/**
 * Denylist cache + isRepoDenied predicate for the gateway redaction gate.
 *
 * ## Design: sync predicate + async lazy refresh
 *
 * `isRepoDenied` is called on the hot path (every operator surface-time check)
 * and must be a pure synchronous in-memory lookup — no I/O, no await.
 *
 * Refresh is async and lazy: `getDenylistState()` is the async entry point that
 * callers invoke before a batch of checks (or at startup) to guarantee freshness.
 * It triggers a refresh when the TTL has elapsed, waits for the in-flight refresh
 * to complete (deduplicating concurrent callers), then returns. After it resolves,
 * `isRepoDenied` reads the updated in-memory state synchronously.
 *
 * ## Cache / grace semantics (P0-DoS fix)
 *
 * State: `lastGoodDenylist`, `lastGoodAt`, `lastAttemptAt`.
 *
 * - **Cold start** (lastGoodDenylist === null, never loaded): unavailable →
 *   `isRepoDenied` returns **true for everything** (deny all). No last-known-good.
 * - **Successful load/refresh**: update `lastGoodDenylist` + `lastGoodAt`; serve
 *   from it.
 * - **Refresh failure with a prior good load**: keep serving `lastGoodDenylist`
 *   for a bounded grace window (`graceMs`) measured from `lastGoodAt`; emit a
 *   **hard alarm** (`logger.error`) on each failed refresh during grace. After
 *   `lastGoodAt + graceMs` elapses without a successful refresh → deny all.
 * - **NEVER** serve an unfiltered/allow-all path. "Unavailable" always means
 *   deny-all, never allow-all.
 *
 * ## isRepoDenied semantics
 *
 * Returns `true` (denied) if:
 * - `repoKey.databaseId ∈ redactedDatabaseIds`, OR
 * - `repoKey.nodeId ∈ redactedNodeIds`, OR
 * - both `databaseId` and `nodeId` are null/undefined (fail closed on missing key), OR
 * - no denylist has been successfully loaded (cold start / post-grace deny-all).
 *
 * Returns `false` (allowed) only when a denylist is loaded and neither key matches.
 *
 * Security invariants:
 * - No I/O on the hot path (`isRepoDenied`).
 * - Unavailability always means deny-all, never allow-all.
 * - Hard alarms on every failed refresh during the grace window.
 * - Cold start denies all — there is no last-known-good to fall back to.
 */

import type {MetadataReader, RepoDenylist} from './metadata-reader.js'

import {readRepoDenylist} from './metadata-reader.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The repo identity keys used for denylist matching.
 *
 * Both fields are optional at the call site (a binding may not have been
 * backfilled yet). A record with neither a usable databaseId nor nodeId is
 * denied (fail closed).
 */
export interface RepoKey {
  readonly databaseId: number | null
  readonly nodeId: string | null
}

/**
 * Logger interface for the denylist cache.
 *
 * Matches the GatewayLogger shape used elsewhere in the gateway.
 */
export interface DenylistLogger {
  readonly debug: (context: Record<string, unknown>, message: string) => void
  readonly info: (context: Record<string, unknown>, message: string) => void
  readonly warn: (context: Record<string, unknown>, message: string) => void
  readonly error: (context: Record<string, unknown>, message: string) => void
}

/**
 * Dependencies for `createDenylistCache`.
 */
export interface DenylistCacheDeps {
  /** Injectable metadata reader (tests inject a fake; production injects the App-client reader). */
  readonly reader: MetadataReader
  /** TTL in milliseconds before a refresh is attempted. Default: 5 minutes. */
  readonly ttlMs: number
  /**
   * Grace window in milliseconds from `lastGoodAt` during which the last-known-good
   * denylist is served on refresh failure. After this window, deny-all kicks in.
   * Default: a small multiple of ttlMs (e.g. 3×).
   */
  readonly graceMs: number
  /** Injectable clock — returns the current time in milliseconds. Default: Date.now. */
  readonly now: () => number
  /** Logger for hard alarms on refresh failure. */
  readonly logger: DenylistLogger
}

/**
 * The denylist cache handle returned by `createDenylistCache`.
 */
export interface DenylistCache {
  /**
   * Async entry point: ensures the denylist is loaded (or refreshed if the TTL
   * has elapsed). Deduplicates concurrent callers — only one in-flight refresh
   * runs at a time.
   *
   * Call this before a batch of `isRepoDenied` checks to guarantee freshness.
   * After it resolves, `isRepoDenied` is a pure synchronous lookup.
   */
  readonly getDenylistState: () => Promise<void>

  /**
   * Pure synchronous predicate. Returns `true` (denied) if the repo is in the
   * denylist, if the key is missing (null/null), or if no denylist has been
   * successfully loaded (cold start / post-grace deny-all).
   *
   * No I/O. Reads the in-memory state set by the last `getDenylistState()` call.
   */
  readonly isRepoDenied: (repoKey: RepoKey) => boolean
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a denylist cache with TTL + bounded-grace-on-failure semantics.
 *
 * @param deps - Injectable dependencies (reader, ttlMs, graceMs, now, logger).
 * @returns A `DenylistCache` handle with `getDenylistState()` + `isRepoDenied()`.
 */
export function createDenylistCache(deps: DenylistCacheDeps): DenylistCache {
  const {reader, ttlMs, graceMs, now, logger} = deps

  // ---------------------------------------------------------------------------
  // Mutable cache state (closure — no classes)
  // ---------------------------------------------------------------------------

  /** The last successfully-loaded denylist. null = never loaded. */
  let lastGoodDenylist: RepoDenylist | null = null

  /** Timestamp (ms) of the last successful load. null = never loaded. */
  let lastGoodAt: number | null = null

  /** Timestamp (ms) of the last refresh attempt (success or failure). */
  let lastAttemptAt: number | null = null

  /**
   * In-flight refresh promise. Deduplicates concurrent `getDenylistState()` calls:
   * if a refresh is already running, new callers await the same promise.
   */
  let inflightRefresh: Promise<void> | null = null

  // ---------------------------------------------------------------------------
  // Internal: perform a single refresh attempt
  // ---------------------------------------------------------------------------

  async function doRefresh(): Promise<void> {
    const attemptAt = now()
    lastAttemptAt = attemptAt

    const result = await readRepoDenylist(reader)

    if (result.success === true) {
      // Successful load — update last-known-good
      lastGoodDenylist = result.data
      lastGoodAt = attemptAt
      logger.debug({}, 'denylist-cache: refresh succeeded')
      return
    }

    // Refresh failed — determine whether we are in the grace window
    const currentTime = now()
    const inGrace = lastGoodAt !== null && currentTime < lastGoodAt + graceMs

    if (inGrace) {
      // Hard alarm: serving stale last-known-good during grace window.
      // lastGoodAt is non-null here (inGrace guarantees it).
      const graceRemainingMs = lastGoodAt === null ? 0 : lastGoodAt + graceMs - currentTime
      logger.error(
        {errorName: result.error.name, graceRemainingMs},
        'denylist-cache: refresh failed — serving last-known-good within grace window (HARD ALARM)',
      )
    } else {
      // Grace window expired (or never had a good load) — deny-all will apply
      logger.error(
        {
          errorName: result.error.name,
          hadPriorGoodLoad: lastGoodDenylist !== null,
        },
        'denylist-cache: refresh failed — grace window expired or cold start, deny-all in effect (HARD ALARM)',
      )

      // Evict the stale last-known-good so deny-all kicks in
      if (lastGoodDenylist !== null) {
        lastGoodDenylist = null
        lastGoodAt = null
      }
    }
  }

  // ---------------------------------------------------------------------------
  // getDenylistState — async entry point
  // ---------------------------------------------------------------------------

  async function getDenylistState(): Promise<void> {
    const currentTime = now()

    // Determine whether a refresh is needed
    const needsRefresh =
      lastAttemptAt === null || // never attempted
      currentTime >= (lastAttemptAt ?? 0) + ttlMs // TTL elapsed since last attempt

    if (needsRefresh === false) {
      // Within TTL — no refresh needed
      return
    }

    // Deduplicate concurrent callers: if a refresh is already in flight, await it
    if (inflightRefresh !== null) {
      await inflightRefresh
      return
    }

    // Start a new refresh
    inflightRefresh = doRefresh().finally(() => {
      inflightRefresh = null
    })

    await inflightRefresh
  }

  // ---------------------------------------------------------------------------
  // isRepoDenied — pure synchronous predicate
  // ---------------------------------------------------------------------------

  function isRepoDenied(repoKey: RepoKey): boolean {
    // Fail closed on missing key — no usable deny key means deny
    if (repoKey.databaseId === null && repoKey.nodeId === null) {
      return true
    }

    // No denylist loaded (cold start or post-grace eviction) — deny all
    if (lastGoodDenylist === null) {
      return true
    }

    // Pure in-memory set lookup — no I/O.
    // TypeScript narrows databaseId/nodeId to non-null inside these branches.
    if (repoKey.databaseId !== null && lastGoodDenylist.redactedDatabaseIds.has(repoKey.databaseId)) {
      return true
    }

    if (repoKey.nodeId !== null && lastGoodDenylist.redactedNodeIds.has(repoKey.nodeId)) {
      return true
    }

    return false
  }

  // ---------------------------------------------------------------------------
  // Return the cache handle
  // ---------------------------------------------------------------------------

  return {getDenylistState, isRepoDenied}
}
