/**
 * In-memory fixed-window rate limiter for the POST /v1/announce webhook.
 *
 * Limits requests per source key (typically client IP) to a configurable
 * number of requests per time window. Defaults to 60 requests per minute.
 *
 * Uses fixed-window counting (not sliding window). Opportunistic eviction
 * of expired windows on each call.
 *
 * Hard cap: the store is bounded to MAX_KEYS entries. When the cap is reached,
 * expired keys are evicted first; if still over, the incoming key is treated as
 * rate-limited rather than growing the map unboundedly (memory-sink defence).
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

  function evictExpired(nowMs: number): void {
    for (const [key, entry] of store) {
      if (nowMs - entry.windowStart >= windowMs) {
        store.delete(key)
      }
    }
  }

  function allow(key: string): boolean {
    const nowMs = clock()
    evictExpired(nowMs)

    const entry = store.get(key)
    if (entry === undefined) {
      // New key — check cap before inserting
      if (store.size >= MAX_KEYS) {
        // Map is at capacity after eviction; treat as rate-limited rather
        // than growing unboundedly. Legitimate traffic from this IP will
        // succeed once expired windows clear on a subsequent call.
        return false
      }
      store.set(key, {windowStart: nowMs, count: 1})
      return true
    }

    // Same window
    if (nowMs - entry.windowStart < windowMs) {
      if (entry.count >= limit) {
        return false
      }
      entry.count += 1
      return true
    }

    // Window has expired — reset
    store.set(key, {windowStart: nowMs, count: 1})
    return true
  }

  return {allow}
}
