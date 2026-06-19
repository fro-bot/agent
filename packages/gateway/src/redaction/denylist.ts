/**
 * Denylist cache for the gateway redaction gate.
 *
 * Wraps `readRepoDenylist` with a TTL-based in-memory cache, inflight-refresh
 * deduplication, and a bounded grace window for last-known-good serving.
 *
 * ## Fail-closed posture
 *
 * - Cold start (never successfully loaded) → deny all.
 * - Refresh failure within grace window → serve last-known-good; emit hard alarm.
 * - Grace window expired without successful refresh → evict last-known-good → deny all.
 * - Missing deny key (null/null or undefined/undefined) → denied.
 *
 * ## Grace-window enforcement
 *
 * Grace expiry is checked on EVERY read (isRepoDenied / getDenylistState), not only
 * inside doRefresh. This prevents last-known-good from being served past
 * `lastGoodAt + graceMs` even with sparse callers and a failed refresh cadence.
 *
 * ## Inflight deduplication
 *
 * Only one refresh is in flight at a time. Concurrent getDenylistState() calls
 * during a refresh all await the same promise.
 */

import type {RunStatusRepoKey} from '../operator-contract/index.js'
import type {MetadataReader, RepoDenylist} from './metadata-reader.js'

import {readRepoDenylist} from './metadata-reader.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The repo identity keys used for denylist matching.
 *
 * FIX 10: Re-exported as a type alias of RunStatusRepoKey from the operator contract barrel
 * so the two types cannot drift. Surface-gate and denylist both use the same canonical type.
 * Import from the contract barrel (operator-contract/index.js) as the single authority.
 */
export type RepoKey = RunStatusRepoKey

export interface DenylistLogger {
  readonly debug: (context: Record<string, unknown>, message: string) => void
  readonly info: (context: Record<string, unknown>, message: string) => void
  readonly warn: (context: Record<string, unknown>, message: string) => void
  readonly error: (context: Record<string, unknown>, message: string) => void
}

export interface DenylistCacheOptions {
  readonly reader: MetadataReader
  readonly ttlMs: number
  readonly graceMs: number
  readonly now: () => number
  readonly logger: DenylistLogger
}

export interface DenylistCache {
  /**
   * Trigger a refresh if the TTL has expired, then return the current state.
   * Awaiting this is the standard way to ensure the cache is warm.
   */
  readonly getDenylistState: () => Promise<void>
  /**
   * Synchronous predicate: returns true if the repo is denied.
   *
   * Fail-closed: returns true when:
   * - No successful load has ever completed (cold start).
   * - The last-known-good has expired past the grace window.
   * - The repoKey has no usable deny key (databaseId == null AND nodeId == null/undefined/'').
   * - The databaseId or nodeId matches a redacted entry.
   */
  readonly isRepoDenied: (repoKey: RepoKey) => boolean
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a denylist cache backed by the given MetadataReader.
 *
 * @param options - Cache configuration.
 * @returns A DenylistCache instance.
 */
export function createDenylistCache(options: DenylistCacheOptions): DenylistCache {
  const {reader, ttlMs, graceMs, now, logger} = options

  // State
  let lastGoodDenylist: RepoDenylist | null = null
  let lastGoodAt: number | null = null
  let lastAttemptAt: number | null = null
  let inflightRefresh: Promise<void> | null = null

  // ---------------------------------------------------------------------------
  // Grace-window eviction (checked on every read)
  // ---------------------------------------------------------------------------

  /**
   * Evict last-known-good if the grace window has expired without a successful refresh.
   * Called on every read path so the boundary is enforced by elapsed time, not refresh cadence.
   */
  function evictIfGraceExpired(): void {
    if (lastGoodDenylist === null || lastGoodAt === null) {
      // Nothing to evict — already in deny-all state.
      return
    }

    const nowMs = now()
    if (nowMs > lastGoodAt + graceMs) {
      // Grace window expired — evict last-known-good → deny all.
      logger.error(
        {lastGoodAt, graceMs, nowMs},
        'denylist: grace window expired without successful refresh — evicting last-known-good, denying all',
      )
      lastGoodDenylist = null
      lastGoodAt = null
    }
  }

  // ---------------------------------------------------------------------------
  // Refresh logic
  // ---------------------------------------------------------------------------

  function needsRefresh(): boolean {
    if (lastAttemptAt === null) {
      // Never attempted — needs refresh.
      return true
    }
    return now() > lastAttemptAt + ttlMs
  }

  async function doRefresh(): Promise<void> {
    lastAttemptAt = now()

    const result = await readRepoDenylist(reader)

    if (result.success === true) {
      lastGoodDenylist = result.data
      lastGoodAt = now()
      logger.info({}, 'denylist: refresh succeeded')
    } else {
      // Refresh failed — check grace window.
      const nowMs = now()
      const withinGrace = lastGoodDenylist !== null && lastGoodAt !== null && nowMs <= lastGoodAt + graceMs

      if (withinGrace) {
        logger.error(
          {error: result.error.message, lastGoodAt: lastGoodAt ?? undefined},
          'denylist: refresh failed — serving last-known-good within grace window',
        )
      } else {
        // Past grace or no prior good load — deny all.
        logger.error(
          {error: result.error.message},
          'denylist: refresh failed — no valid last-known-good (cold start or grace expired), denying all',
        )
        lastGoodDenylist = null
        lastGoodAt = null
      }
    }
  }

  // ---------------------------------------------------------------------------
  // getDenylistState
  // ---------------------------------------------------------------------------

  async function getDenylistState(): Promise<void> {
    // Check grace expiry on every call (independent of refresh scheduling).
    evictIfGraceExpired()

    if (needsRefresh() === false) {
      return
    }

    // Inflight deduplication: only one refresh at a time.
    if (inflightRefresh !== null) {
      await inflightRefresh
      return
    }

    inflightRefresh = doRefresh().finally(() => {
      inflightRefresh = null
    })

    await inflightRefresh
  }

  // ---------------------------------------------------------------------------
  // isRepoDenied
  // ---------------------------------------------------------------------------

  function isRepoDenied(repoKey: RepoKey): boolean {
    // Check grace expiry on every read (FIX 2: independent of refresh cadence).
    evictIfGraceExpired()

    // Missing key → denied (fail closed).
    // FIX 6: treat databaseId == null (null or undefined) AND nodeId == null/undefined/'' as missing.
    const hasDatabaseId = repoKey.databaseId != null
    const hasNodeId = repoKey.nodeId != null && repoKey.nodeId !== ''

    if (hasDatabaseId === false && hasNodeId === false) {
      return true
    }

    // No successful load → deny all (cold start or grace expired).
    if (lastGoodDenylist === null) {
      return true
    }

    const {redactedDatabaseIds, redactedNodeIds} = lastGoodDenylist

    // Check databaseId match.
    if (hasDatabaseId && redactedDatabaseIds.has(repoKey.databaseId)) {
      return true
    }

    // Check nodeId match.
    if (hasNodeId && redactedNodeIds.has(repoKey.nodeId)) {
      return true
    }

    return false
  }

  return {getDenylistState, isRepoDenied}
}
