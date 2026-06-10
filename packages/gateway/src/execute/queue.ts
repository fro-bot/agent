/**
 * In-memory per-channel FIFO task queue for the gateway mention loop.
 *
 * Holds pending tasks keyed by Discord channel ID. When a channel already has
 * an in-flight run, arriving tasks are enqueued here and drained serially as
 * each run completes (atomic handoff — see run.ts).
 *
 * In-memory state is intentional — gateway restart resets it.
 * Each operation is synchronous and atomic under Node's single-threaded event loop.
 */

/** Default maximum pending tasks per channel before new arrivals are rejected. */
export const DEFAULT_MAX_QUEUE_DEPTH = 5

/**
 * A per-channel FIFO queue holding pending tasks of type `T`.
 *
 * Channels are fully isolated: operations on one `channelId` never affect another.
 */
export interface ChannelQueue<T> {
  /**
   * Append a task to the tail of the channel's queue (FIFO).
   *
   * - `'queued'` — task accepted; caller should send a "queued" acknowledgement.
   * - `'full'`   — channel is at `maxDepth`; task rejected (newest dropped);
   *                caller should send a "queue is full" reply.
   */
  readonly enqueue: (channelId: string, task: T) => 'queued' | 'full'
  /**
   * Number of pending (not yet started) tasks for the channel.
   * Returns `0` for unknown channels.
   */
  readonly pendingCount: (channelId: string) => number
  /**
   * Atomic FIFO pop — removes and returns the oldest pending task for the channel.
   *
   * Returns `undefined` when the channel has no pending tasks.
   * Never returns the same task twice. Removing the last task leaves no stale
   * empty array that would misreport `pendingCount`.
   *
   * This is the handoff primitive: the run path calls it while the channel slot
   * is still held to start the next task without a free-slot gap.
   */
  readonly takeNext: (channelId: string) => T | undefined
  /**
   * Drop ALL pending tasks for the channel and return the count dropped.
   * Returns `0` for unknown or already-empty channels.
   * Does not affect the in-flight run (which holds the concurrency slot, not the queue).
   */
  readonly clear: (channelId: string) => number
}

/**
 * Create a new `ChannelQueue` with the given per-channel depth cap.
 *
 * @param maxDepth - Maximum number of pending tasks per channel before `enqueue`
 *   returns `'full'`. Defaults to `DEFAULT_MAX_QUEUE_DEPTH`.
 */
export function createChannelQueue<T>(maxDepth: number = DEFAULT_MAX_QUEUE_DEPTH): ChannelQueue<T> {
  const queues = new Map<string, T[]>()

  return {
    enqueue: (channelId: string, task: T): 'queued' | 'full' => {
      const existing = queues.get(channelId)
      if (existing === undefined) {
        if (maxDepth <= 0) return 'full'
        queues.set(channelId, [task])
      } else {
        if (existing.length >= maxDepth) return 'full'
        existing.push(task)
      }
      return 'queued'
    },

    pendingCount: (channelId: string): number => {
      return queues.get(channelId)?.length ?? 0
    },

    takeNext: (channelId: string): T | undefined => {
      const existing = queues.get(channelId)
      if (existing === undefined || existing.length === 0) return undefined
      const task = existing.shift()
      // Clean up the entry when the array is drained so pendingCount stays accurate
      // and we don't accumulate stale empty arrays.
      if (existing.length === 0) {
        queues.delete(channelId)
      }
      return task
    },

    clear: (channelId: string): number => {
      const existing = queues.get(channelId)
      if (existing === undefined) return 0
      const count = existing.length
      queues.delete(channelId)
      return count
    },
  }
}
