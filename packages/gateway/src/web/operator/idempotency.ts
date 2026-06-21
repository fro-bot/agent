/**
 * Per-operator bounded in-memory idempotency guard for the launch route.
 *
 * Keys are namespaced per operator: `${githubUserId}:${clientKey}` so operator A
 * cannot replay operator B's key to suppress B's launch (cross-operator poisoning).
 *
 * Omitting the client key means no idempotency guard is applied — the launch always
 * proceeds. This is the correct behavior for callers that do not supply a key.
 *
 * Retention window: entries expire after IDEMPOTENCY_TTL_MS. A duplicate within
 * the window echoes the prior runId without starting a new launch.
 *
 * Bounded: the store is capped at MAX_ENTRIES. When the cap is reached, expired
 * entries are evicted first; only if still at capacity is the oldest live entry
 * evicted (same pattern as run-index.ts). Updating an existing key never triggers
 * capacity eviction of a different live key.
 *
 * Two-phase lifecycle (reserve → committed):
 *
 *   1. `reserve(githubUserId, clientKey, runId)` — records a *reserved* entry.
 *      A concurrent duplicate arriving during the reservation window is treated as
 *      in-flight/duplicate (check() returns the reserved runId) — it does NOT launch
 *      twice. Reserved entries carry the same TTL as committed entries so an abandoned
 *      reservation self-clears.
 *
 *   2. `commit(githubUserId, clientKey)` — promotes the reserved entry to *committed*
 *      and refreshes expiresAt to the full TTL from now. No-op if the key is gone.
 *
 *   3. `rollback(githubUserId, clientKey)` — removes the reservation entry. No-op if
 *      the key is gone. Guarantees that a rejected launch does not echo a dead runId.
 *
 * The `record` method is kept for backward compatibility with existing callers that
 * do not need the two-phase lifecycle. It behaves identically to `reserve` followed
 * immediately by `commit` (i.e. it writes a committed entry directly).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Retention window for idempotency entries: 10 minutes. */
export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000

/** Maximum number of idempotency entries before eviction. */
export const IDEMPOTENCY_MAX_ENTRIES = 10_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IdempotencyStatus = 'reserved' | 'committed'

interface IdempotencyEntry {
  readonly runId: string
  readonly expiresAt: number
  readonly status: IdempotencyStatus
}

export interface IdempotencyGuard {
  /**
   * Check whether a namespaced key has a live entry (reserved OR committed).
   *
   * Returns the prior runId if the key is live (duplicate within window),
   * or undefined if the key is new or expired (proceed with launch).
   *
   * A reserved entry (in-flight, not yet committed) echoes the reserved runId
   * so a concurrent duplicate does NOT launch twice.
   */
  readonly check: (githubUserId: number, clientKey: string) => string | undefined

  /**
   * Record a runId for a namespaced key (committed immediately).
   *
   * Kept for backward compatibility. Equivalent to `reserve` followed by `commit`.
   * Prefer the two-phase `reserve`/`commit`/`rollback` lifecycle for new callers.
   *
   * If the key already exists (update-in-place), the entry is updated without
   * triggering capacity eviction of a different live key.
   */
  readonly record: (githubUserId: number, clientKey: string, runId: string) => void

  /**
   * Reserve a runId for a namespaced key (two-phase lifecycle, phase 1).
   *
   * Records a *reserved* entry. A concurrent duplicate arriving during the
   * reservation window sees the reserved runId via `check()` and does NOT launch
   * twice. Reserved entries carry the same TTL as committed entries so an
   * abandoned reservation self-clears.
   *
   * Call BEFORE `launchWork` so the key is visible to concurrent duplicates
   * during the admission window.
   */
  readonly reserve: (githubUserId: number, clientKey: string, runId: string) => void

  /**
   * Commit a reserved entry (two-phase lifecycle, phase 2 — success path).
   *
   * Promotes the reserved entry to *committed* and refreshes expiresAt to the
   * full TTL from now. No-op if the key is gone (e.g. already rolled back or
   * expired).
   *
   * Call AFTER `launchWork` returns `{accepted: true}`.
   */
  readonly commit: (githubUserId: number, clientKey: string) => void

  /**
   * Roll back a reserved entry (two-phase lifecycle, phase 2 — failure path).
   *
   * Removes the reservation entry so a subsequent same-key request is NOT
   * treated as a duplicate and does NOT echo a dead runId. No-op if the key
   * is gone.
   *
   * Call when `launchWork` returns `{accepted: false}` or throws, and in any
   * `finally` block that may exit without committing — so a reserved-but-never-
   * resolved key cannot stick and block the operator's own key.
   */
  readonly rollback: (githubUserId: number, clientKey: string) => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface IdempotencyGuardDeps {
  /** Injectable clock for TTL checks. Defaults to Date.now. */
  readonly now?: () => number
  /** Maximum entries before eviction. Defaults to IDEMPOTENCY_MAX_ENTRIES. */
  readonly maxEntries?: number
  /** Entry TTL in milliseconds. Defaults to IDEMPOTENCY_TTL_MS. */
  readonly ttlMs?: number
}

/**
 * Create a per-operator bounded in-memory idempotency guard.
 *
 * The guard is keyed on `${githubUserId}:${clientKey}` so operator A cannot
 * suppress operator B's launch with the same client key.
 */
function makeKey(githubUserId: number, clientKey: string): string {
  return `${githubUserId}:${clientKey}`
}

export function createIdempotencyGuard(deps?: IdempotencyGuardDeps): IdempotencyGuard {
  const now = deps?.now ?? (() => Date.now())
  const maxEntries = deps?.maxEntries ?? IDEMPOTENCY_MAX_ENTRIES
  const ttlMs = deps?.ttlMs ?? IDEMPOTENCY_TTL_MS

  // Insertion-ordered map: oldest entry is first (Map preserves insertion order).
  const store = new Map<string, IdempotencyEntry>()

  function check(githubUserId: number, clientKey: string): string | undefined {
    const key = makeKey(githubUserId, clientKey)
    const entry = store.get(key)
    if (entry === undefined) return undefined
    if (now() >= entry.expiresAt) {
      // Expired — evict and treat as new.
      store.delete(key)
      return undefined
    }
    // Return runId for both reserved and committed live entries.
    return entry.runId
  }

  /**
   * Internal write helper: upsert an entry with the given status.
   * Handles capacity eviction for new keys.
   */
  function writeEntry(key: string, runId: string, status: IdempotencyStatus): void {
    // If the key already exists, update in place without triggering capacity eviction.
    // Delete first so the insertion order reflects the latest registration.
    if (store.has(key)) {
      store.delete(key)
      store.set(key, {runId, expiresAt: now() + ttlMs, status})
      return
    }

    // New key — evict expired entries first before checking capacity.
    if (store.size >= maxEntries) {
      const nowMs = now()
      for (const [k, entry] of store) {
        if (nowMs >= entry.expiresAt) {
          store.delete(k)
          // Stop after evicting one expired entry — enough to make room.
          break
        }
      }
    }

    // If still at capacity after expired eviction, evict the oldest live entry.
    if (store.size >= maxEntries) {
      const oldestKey = store.keys().next().value
      if (oldestKey !== undefined) {
        store.delete(oldestKey)
      }
    }

    store.set(key, {runId, expiresAt: now() + ttlMs, status})
  }

  function record(githubUserId: number, clientKey: string, runId: string): void {
    writeEntry(makeKey(githubUserId, clientKey), runId, 'committed')
  }

  function reserve(githubUserId: number, clientKey: string, runId: string): void {
    writeEntry(makeKey(githubUserId, clientKey), runId, 'reserved')
  }

  function commit(githubUserId: number, clientKey: string): void {
    const key = makeKey(githubUserId, clientKey)
    const entry = store.get(key)
    if (entry === undefined) {
      // No-op: key is gone (already rolled back or expired).
      return
    }
    // Promote to committed and refresh expiresAt to the full TTL from now.
    store.delete(key)
    store.set(key, {runId: entry.runId, expiresAt: now() + ttlMs, status: 'committed'})
  }

  function rollback(githubUserId: number, clientKey: string): void {
    const key = makeKey(githubUserId, clientKey)
    // No-op if the key is gone (idempotent).
    store.delete(key)
  }

  return {check, record, reserve, commit, rollback}
}
