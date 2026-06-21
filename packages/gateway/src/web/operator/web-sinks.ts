/**
 * Minimal web StatusSink and ReplySink implementations for the launch route.
 *
 * These are best-effort/no-op transport UX implementations. They do NOT drive
 * observation — the engine's transitionRun → runObserver.observe lifecycle hook
 * feeds the SSE observation path. The operator observes via the run-stream route.
 *
 * The web surface has no Discord thread, no typing indicator, and no reaction
 * emoji. All methods are no-ops or return the minimal required values.
 *
 * The web ReplySink is wired to the run-observation manager: append() pushes
 * live deltas and flush() pushes the final answer frame. Subscribers on the
 * SSE run-stream route receive output frames as the agent produces them.
 */

import type {MessageContentOptions} from '../../discord/io.js'
import type {TransitionResult} from '../../discord/status-message.js'
import type {ReplySink, ReplySinkTarget, StatusSink} from '../../execute/launch-types.js'

// ---------------------------------------------------------------------------
// Web StatusSink — no-op transport UX
// ---------------------------------------------------------------------------

/**
 * Create a minimal web StatusSink.
 *
 * All methods are no-ops or return the minimal required values. The web surface
 * has no typing indicator, no status message, and no reaction emoji.
 *
 * resolveToAnswer and resolveToFailure return 'delegated' so the engine
 * falls through to the reply sink's flush and delivery methods — which are
 * also no-ops for the web surface. The operator observes via SSE.
 */
export function createWebStatusSink(): StatusSink {
  return {
    noteActivity: (_summary: string): void => {
      // No-op: web surface has no status message to update.
    },

    setBusy: (_busy: boolean): void => {
      // No-op: web surface has no typing indicator.
    },

    resolveToAnswer: async (_text: string): Promise<TransitionResult> => {
      // Delegate: no status message to edit in-place; engine flushes via replySink.
      return {transition: 'delegated'}
    },

    resolveToFailure: async (_note: string): Promise<TransitionResult> => {
      // Delegate: no status message to edit in-place; engine sends via replySink.
      return {transition: 'delegated'}
    },

    dispose: async (): Promise<void> => {
      // No-op: no timers to clear.
    },

    setReaction: (_state): void => {
      // No-op: web surface has no reaction emoji.
    },
  }
}

// ---------------------------------------------------------------------------
// Web ReplySink — no-op transport UX
// ---------------------------------------------------------------------------

/**
 * Create a minimal web ReplySink wired to the run-observation manager.
 *
 * append(text) buffers the text AND pushes a live delta to the manager via
 * deps.observeOutput(text) so subscribers see output as it arrives.
 *
 * flush() pushes the final answer frame deps.observeOutput(buffer, {final:true})
 * before returning undefined. This fires even when the buffer is empty (the
 * empty-final backstop — guarantees every run produces a terminal output frame).
 *
 * buffered() returns the accumulated text so the engine can pass it to
 * statusSink.resolveToAnswer — even though the web status sink ignores it.
 *
 * hasVisibleOutput() returns false so the engine does not suppress the
 * "no output" placeholder path (which is also a no-op for web).
 *
 * The deps.observeOutput callback is already run-scoped by the caller (the
 * caller binds runId); the sink receives a narrow callback, not the full manager.
 */
export function createWebReplySink(deps: {
  readonly runId: string
  readonly observeOutput: (text: string, opts?: {final?: boolean; droppedCount?: number}) => void
}): ReplySink {
  let buffer = ''
  let visibleOutputSent = false
  let pendingCount = 0

  return {
    append: (text: string): void => {
      buffer += text
      try {
        deps.observeOutput(text)
      } catch {
        // Fail-soft: a manager error must never break the run's streaming loop.
      }
    },

    flush: async (): Promise<unknown> => {
      try {
        deps.observeOutput(buffer, {final: true})
      } catch {
        // Fail-soft: a manager error must never break the run's streaming loop.
      }
      return undefined
    },

    buffered: (): string => buffer,

    hasVisibleOutput: (): boolean => visibleOutputSent || pendingCount > 0,

    markVisibleOutputSent: (): void => {
      visibleOutputSent = true
    },

    markVisibleOutputPending: (): ((delivered: boolean) => void) => {
      pendingCount += 1
      let settled = false
      return (delivered: boolean): void => {
        if (settled === true) return
        settled = true
        pendingCount -= 1
        if (delivered === true) {
          visibleOutputSent = true
        }
      }
    },

    send: async (_target: ReplySinkTarget, _options: MessageContentOptions): Promise<unknown> => {
      // No-op: web surface does not deliver acks inline.
      return undefined
    },
  }
}
