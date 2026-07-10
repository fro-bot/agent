/**
 * Bounded, closure-based dedupe cache for operator push dispatch.
 *
 * Keyed by `${runOrApprovalId}:${kind}` — a second dispatch for the same
 * run/approval and notification kind within `windowMs` is suppressed. This
 * exists to keep a flaky upstream retry loop (or a duplicate SSE-driven
 * trigger) from spamming an operator's device with the same notification.
 *
 * Bounded memory: every `shouldSend` call sweeps expired entries before
 * recording a new one, so the map never grows unbounded across a long
 * process lifetime even without an external timer.
 *
 * In-memory, best-effort only: this guards against in-process retry storms,
 * not a cross-restart dedupe guarantee — a process restart clears the
 * window entirely. Acceptable for now; a duplicate notification after a
 * restart is a minor UX annoyance, not a correctness issue.
 */

export interface DedupeCacheDeps {
  readonly windowMs?: number
  readonly clock?: () => number
}

export interface DedupeCache {
  /**
   * Returns `true` (and records the key) if this key has NOT been seen
   * within the dedupe window; returns `false` (and does NOT reset the
   * window) if it has.
   */
  shouldSend: (key: string) => boolean
}

/** Default dedupe window: 5 minutes, matching GATEWAY_OPERATOR_PUSH_DEDUPE_WINDOW_MS default. */
const DEFAULT_DEDUPE_WINDOW_MS = 300_000

export function createDedupeCache(deps: DedupeCacheDeps = {}): DedupeCache {
  const windowMs = deps.windowMs ?? DEFAULT_DEDUPE_WINDOW_MS
  const clock = deps.clock ?? Date.now
  const seenAt = new Map<string, number>()

  function sweepExpired(now: number): void {
    for (const [key, timestamp] of seenAt) {
      if (now - timestamp >= windowMs) {
        seenAt.delete(key)
      }
    }
  }

  function shouldSend(key: string): boolean {
    const now = clock()
    sweepExpired(now)

    const lastSent = seenAt.get(key)
    if (lastSent !== undefined && now - lastSent < windowMs) {
      return false
    }

    seenAt.set(key, now)
    return true
  }

  return {shouldSend}
}
