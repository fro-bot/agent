/**
 * In-memory fixed-window rate limiter for the POST /v1/announce webhook.
 *
 * Limits requests per source key (typically client IP) to a configurable
 * number of requests per time window. Defaults to 60 requests per minute.
 *
 * Uses fixed-window counting (not sliding window). Opportunistic eviction
 * of expired windows on each call.
 */

/** Default: 60 requests per minute. */
const DEFAULT_LIMIT = 60
/** Default window: 60 seconds. */
const DEFAULT_WINDOW_MS = 60_000

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
