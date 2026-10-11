/**
 * In-memory fixed-window rate limiter, shared by the announce webhook and the
 * operator HTTP surface.
 *
 * Limits requests per key (an authenticated user id, a fixed producer key, or a
 * derived abuse-accounting key) to a configurable number of requests per time
 * window. Defaults to 60 requests per minute.
 *
 * Uses fixed-window counting (not sliding window). Expiry is lazy and per key:
 * a key whose window has elapsed is renewed the next time it is touched. There
 * is no sweep — `allow()` is O(1) regardless of how many keys are tracked.
 *
 * Hard cap: the store is bounded to MAX_KEYS entries. A NEW key arriving at
 * capacity is always admitted: the oldest key (by insertion / window-renewal
 * order) is evicted first. A new client is therefore never refused because of
 * unrelated traffic.
 *
 * Ordering is FIFO by window start, not LRU: ordinary hits within a window do
 * not promote a key; only a window renewal (delete-then-set, since `Map.set`
 * on an existing key keeps its position) moves it to the tail.
 *
 * Best-effort under cardinality pressure: evicting a key discards its counter,
 * so an ACTIVE bucket evicted at capacity starts over at count 1 on its next
 * request. Under a flood of distinct keys the limiter degrades to "recent
 * keys are limited" rather than failing closed for newcomers. Callers must not
 * rely on it as a hard quota against an adversary that controls key
 * cardinality — bound the key space upstream (e.g. derived /64 accounting
 * keys) instead.
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
