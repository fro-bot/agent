/**
 * In-memory replay cache for the POST /v1/announce webhook.
 *
 * Stores seen HMAC signature hex values with an expiry timestamp so that
 * exact replays within the REPLAY_WINDOW_MS + buffer period are rejected.
 *
 * NOTE: This is a single-process, in-memory implementation. It does NOT
 * coordinate across multiple gateway instances. Multi-replica deployments
 * MUST either run a single gateway replica or replace this with a shared
 * store (Redis, etc.). v1 constraint: gateway runs as a single replica.
 */

import {REPLAY_WINDOW_MS} from './hmac.js'

// Extra buffer beyond the replay window so a valid-but-edge-case request
// that arrives just before the window boundary is still safely covered.
const EVICTION_BUFFER_MS = 60_000

export interface ReplayCache {
  /** Returns true if the signature has been seen and its entry has not expired. */
  readonly check: (sig: string) => boolean
  /** Records a signature as seen, expiring after REPLAY_WINDOW_MS + buffer. */
  readonly record: (sig: string, nowMs?: number) => void
}

/**
 * Create a replay cache with optional injectable clock for testing.
 *
 * @param opts - Optional configuration.
 * @param opts.clock - Injectable clock function (default: Date.now). Use in
 *   tests to advance time without real delays.
 */
export function createReplayCache(opts?: {readonly clock?: () => number}): ReplayCache {
  const clock = opts?.clock ?? Date.now
  // Map from signature hex → expiry timestamp (ms)
  const store = new Map<string, number>()

  function evictExpired(nowMs: number): void {
    for (const [sig, expiresAt] of store) {
      if (expiresAt < nowMs) {
        store.delete(sig)
      }
    }
  }

  function check(sig: string): boolean {
    const nowMs = clock()
    evictExpired(nowMs)
    const expiresAt = store.get(sig)
    if (expiresAt === undefined) {
      return false
    }
    return expiresAt >= nowMs
  }

  function record(sig: string, nowMs?: number): void {
    const now = nowMs ?? clock()
    evictExpired(now)
    store.set(sig, now + REPLAY_WINDOW_MS + EVICTION_BUFFER_MS)
  }

  return {check, record}
}
