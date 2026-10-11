/**
 * In-memory fixed-window rate limiter, shared by the announce webhook and the
 * operator HTTP surface. Limits requests per key (a user id, a fixed producer
 * key, or a derived abuse-accounting key) to a configurable count per window
 * (default 60 per minute).
 *
 * - Expiry is lazy and per key: an elapsed window is renewed the next time the
 *   key is touched. There is no sweep, so hits and renewals are O(1) in the
 *   number of tracked keys.
 * - The map is bounded to MAX_KEYS. A new key at capacity is always admitted by
 *   evicting the oldest key first; that admission is amortized, not strictly
 *   O(1) (`Map.keys().next()` skips deleted slots not yet compacted, about 9 us
 *   at 10,000 keys under sustained churn).
 * - Eviction order is FIFO by window start, not LRU: hits do not promote a key;
 *   a window renewal deletes and re-sets it so it moves to the tail.
 * - Best-effort under cardinality pressure: evicting an active key resets its
 *   bucket. Bound the key space upstream (e.g. derived /64 accounting keys)
 *   rather than relying on this as a hard quota against an adversary who
 *   controls key cardinality.
 */

/** Default: 60 requests per minute. */
const DEFAULT_LIMIT = 60
/** Default window: 60 seconds. */
const DEFAULT_WINDOW_MS = 60_000
/** Maximum number of distinct source keys tracked at once. */
const MAX_KEYS = 10_000

export interface RateLimiter {
  /** Returns true if the request for the given key is within the limit. */
  readonly allow: (key: string) => boolean
}

export interface RateLimiterOptions {
  /** Maximum requests per window (default: 60). */
  readonly limit?: number
  /** Window duration in milliseconds (default: 60_000). */
  readonly windowMs?: number
  /** Injectable clock for testing (default: Date.now). */
  readonly clock?: () => number
}

interface WindowEntry {
  readonly windowStart: number
  count: number
}

/**
 * Create a fixed-window rate limiter.
 *
 * @param opts - Optional overrides for limit, windowMs, and clock.
 */
export function createRateLimiter(opts?: RateLimiterOptions): RateLimiter {
  const limit = opts?.limit ?? DEFAULT_LIMIT
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS
  const clock = opts?.clock ?? Date.now

  const store = new Map<string, WindowEntry>()

  function allow(key: string): boolean {
    const nowMs = clock()
    const entry = store.get(key)

    if (entry === undefined) {
      // New key. At capacity, make room by evicting the oldest key (the first
      // in Map iteration order) rather than refusing the newcomer.
      if (store.size >= MAX_KEYS) {
        const oldest = store.keys().next()
        if (oldest.done !== true) {
          store.delete(oldest.value)
        }
      }
      store.set(key, {windowStart: nowMs, count: 1})
      return true
    }

    // Same window: enforce the count. Hits do not change the key's position.
    if (nowMs - entry.windowStart < windowMs) {
      if (entry.count >= limit) {
        return false
      }
      entry.count += 1
      return true
    }

    // Window has expired — renew. `Map.set` on an existing key does NOT move it
    // to the tail, so delete first to make the renewed key the youngest.
    store.delete(key)
    store.set(key, {windowStart: nowMs, count: 1})
    return true
  }

  return {allow}
}
