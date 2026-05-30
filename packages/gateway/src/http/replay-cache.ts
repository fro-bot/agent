/**
 * In-memory replay cache for the POST /v1/announce webhook.
 *
 * Stores seen HMAC signature hex values with an expiry timestamp so that
 * exact replays within the REPLAY_WINDOW_MS + buffer period are rejected.
 *
 * Signatures can be in one of three states:
 *   - absent: never seen
 *   - reserved: in-flight (a request is currently processing this sig)
 *   - recorded: committed after a successful Discord post (with expiry)
 *
 * The reserve→commit/release pattern prevents concurrent duplicate Discord
 * posts: two simultaneous requests with the same sig will both pass HMAC
 * check, but only one wins the synchronous reserve() call.
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

/** Sentinel expiry used for reserved (in-flight) entries. */
const RESERVED = Symbol('reserved')

type Entry = number | typeof RESERVED

export interface ReplayCache {
  /** Returns true if the signature has been seen (recorded) and has not expired. */
  readonly check: (sig: string) => boolean
  /**
   * Atomically reserve a signature for the duration of a request.
   * Returns true if the reservation succeeded (sig was absent).
   * Returns false if sig is already reserved OR already recorded.
   */
  readonly reserve: (sig: string) => boolean
  /**
   * Promote a reserved signature to recorded with expiry = now + window + buffer.
   * Call after a successful Discord post.
   */
  readonly commit: (sig: string, nowMs?: number) => void
  /**
   * Remove a reserved signature so a legitimate retry is not blocked.
   * Call on every post-reserve early-return (400/5xx paths).
   * Safe no-op if sig is not reserved.
   */
  readonly release: (sig: string) => void
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
  // Map from signature hex → expiry timestamp (ms) OR RESERVED sentinel
  const store = new Map<string, Entry>()

  function evictExpired(nowMs: number): void {
    for (const [sig, entry] of store) {
      if (entry === RESERVED) {
        // Reserved entries get a safety TTL: we cannot compute exact start time,
        // so we rely on the fact that reservations are short-lived (< 60 s).
        // The eviction on every call naturally cleans them up if the process
        // doesn't crash — the safety TTL is belt-and-suspenders only.
        // Since we don't store reservation time, we skip eviction of reserved
        // entries here; release() handles normal cleanup. A stuck reservation
        // will be cleaned up once its RESERVATION_SAFETY_TTL_MS passes, but
        // to implement that we'd need to store the reservation timestamp.
        // For simplicity: reserved entries are NOT evicted by time (they live
        // until release() or commit()) — this is safe because:
        //   1. release() is always called on error paths
        //   2. commit() is always called on success
        //   3. in the crash scenario the process restarts and the in-memory
        //      map is gone anyway
        continue
      }
      if (entry < nowMs) {
        store.delete(sig)
      }
    }
  }

  function check(sig: string): boolean {
    const nowMs = clock()
    evictExpired(nowMs)
    const entry = store.get(sig)
    if (entry === undefined || entry === RESERVED) {
      return false
    }
    return entry >= nowMs
  }

  function reserve(sig: string): boolean {
    const nowMs = clock()
    evictExpired(nowMs)
    const entry = store.get(sig)
    if (entry !== undefined) {
      // Already reserved or already recorded — reject
      return false
    }
    store.set(sig, RESERVED)
    return true
  }

  function commit(sig: string, nowMs?: number): void {
    const now = nowMs ?? clock()
    store.set(sig, now + REPLAY_WINDOW_MS + EVICTION_BUFFER_MS)
  }

  function release(sig: string): void {
    const entry = store.get(sig)
    if (entry === RESERVED) {
      store.delete(sig)
    }
    // No-op if not reserved (already released, committed, or absent)
  }

  function record(sig: string, nowMs?: number): void {
    const now = nowMs ?? clock()
    evictExpired(now)
    store.set(sig, now + REPLAY_WINDOW_MS + EVICTION_BUFFER_MS)
  }

  return {check, reserve, commit, release, record}
}
