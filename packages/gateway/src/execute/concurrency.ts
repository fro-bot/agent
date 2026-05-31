/**
 * In-memory global concurrency registry for gateway mention runs.
 *
 * Tracks two concurrent dimensions:
 * 1. Global cap — bounds total active runs across all repos/channels.
 * 2. Per-channel in-flight guard — prevents two concurrent runs originating
 *    from the same source channel.
 *
 * In-memory state is intentional — gateway restart resets it.
 * Recovery sweeps handle runs left in EXECUTING at crash time.
 */

/** Default maximum simultaneous active runs across all channels. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 3

export interface ConcurrencyRegistry {
  /**
   * Attempt to acquire a global slot and the per-channel in-flight slot.
   *
   * - `'ok'`   — both slots acquired; caller MUST call `release(channelId)` in a finally block.
   * - `'cap'`  — global cap reached; NO slot acquired; do not call `release`.
   * - `'busy'` — channel already has an active run; NO slot acquired; do not call `release`.
   */
  readonly tryAcquire: (channelId: string) => 'ok' | 'cap' | 'busy'
  /**
   * Release the global slot and the per-channel slot for `channelId`.
   *
   * Idempotent: safe to call even if the channel was not in the active set
   * (e.g. called in a finally block where the run never actually started).
   */
  readonly release: (channelId: string) => void
  /** Current number of globally active runs (informational). */
  readonly activeCount: () => number
  /** Configured maximum concurrent runs. */
  readonly max: number
}

export function createConcurrencyRegistry(max: number = DEFAULT_MAX_CONCURRENT_RUNS): ConcurrencyRegistry {
  let active = 0
  const activeChannels = new Set<string>()

  return {
    tryAcquire: (channelId: string): 'ok' | 'cap' | 'busy' => {
      if (active >= max) return 'cap'
      if (activeChannels.has(channelId) === true) return 'busy'
      active++
      activeChannels.add(channelId)
      return 'ok'
    },
    release: (channelId: string): void => {
      if (activeChannels.has(channelId) === true) {
        activeChannels.delete(channelId)
        if (active > 0) active--
      }
    },
    activeCount: (): number => active,
    max,
  }
}
