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
 * Bounded: the store is capped at MAX_ENTRIES. When the cap is reached, the oldest
 * entry is evicted before inserting the new one (same pattern as run-index.ts).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Retention window for idempotency entries: 10 minutes. */
export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000

/** Maximum number of idempotency entries before oldest is evicted. */
export const IDEMPOTENCY_MAX_ENTRIES = 10_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IdempotencyEntry {
  readonly runId: string
  readonly expiresAt: number
}

export interface IdempotencyGuard {
  /**
   * Check whether a namespaced key has a live entry.
   *
   * Returns the prior runId if the key is live (duplicate within window),
   * or undefined if the key is new or expired (proceed with launch).
   */
  readonly check: (githubUserId: number, clientKey: string) => string | undefined

  /**
   * Record a runId for a namespaced key.
   *
   * Call AFTER generating the runId and BEFORE firing launchWork so the
   * idempotency entry is visible to concurrent duplicate requests.
   */
  readonly record: (githubUserId: number, clientKey: string, runId: string) => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface IdempotencyGuardDeps {
  /** Injectable clock for TTL checks. Defaults to Date.now. */
  readonly now?: () => number
  /** Maximum entries before oldest is evicted. Defaults to IDEMPOTENCY_MAX_ENTRIES. */
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
    return entry.runId
  }

  function record(githubUserId: number, clientKey: string, runId: string): void {
    const key = makeKey(githubUserId, clientKey)

    // Evict oldest when at cap (before inserting so we never exceed cap).
    if (store.size >= maxEntries) {
      const oldestKey = store.keys().next().value
      if (oldestKey !== undefined) {
        store.delete(oldestKey)
      }
    }

    // Re-inserting an existing key moves it to the end (newest). Delete first
    // so the insertion order reflects the latest registration.
    store.delete(key)
    store.set(key, {runId, expiresAt: now() + ttlMs})
  }

  return {check, record}
}
