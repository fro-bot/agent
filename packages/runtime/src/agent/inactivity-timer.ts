/**
 * Resettable inactivity abort-timer.
 *
 * A dependency-free closure-based primitive: arms a timeout that aborts its own
 * `signal` if not reset/paused before the window elapses. Callers compose
 * `signal` with any other abort sources (e.g. `AbortSignal.any([outer, timer.signal])`)
 * and can distinguish "this timer fired" from other abort sources by checking
 * `timer.signal.aborted` directly — the signal identity is stable for the life
 * of the instance.
 *
 * Policy (counters, logging, pause/resume triggers) stays with the caller;
 * this module owns only the timer mechanics.
 */

export interface InactivityTimer {
  /** Aborts when the configured window elapses without a `reset()` call. Stable for the instance's life. */
  readonly signal: AbortSignal
  /** Clears any pending timeout and re-arms a fresh window. No-op when inert. */
  readonly reset: () => void
  /** Clears the pending timeout without aborting — the timer goes dormant until `reset()` or `resume()`. */
  readonly pause: () => void
  /** Re-arms a fresh window after a `pause()`. Equivalent to `reset()`. No-op when inert. */
  readonly resume: () => void
  /** Clears any pending timeout and marks the instance inert. Never aborts. Safe to call multiple times. */
  readonly dispose: () => void
}

/**
 * Create an inactivity timer.
 *
 * `timeoutMs <= 0` produces an inert instance: `signal` never aborts and all
 * methods are no-ops. This mirrors the `inactivityTimeoutMs > 0` arming guard
 * used by callers that treat "no timeout configured" as "feature disabled".
 */
export function createInactivityTimer(options: {readonly timeoutMs: number}): InactivityTimer {
  const {timeoutMs} = options

  if (timeoutMs <= 0) {
    // Inert instance: a controller whose signal never aborts, and no-op methods.
    const inertController = new AbortController()
    return {
      signal: inertController.signal,
      reset: () => {},
      pause: () => {},
      resume: () => {},
      dispose: () => {},
    }
  }

  const controller = new AbortController()
  let handle: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function clear(): void {
    if (handle !== null) {
      clearTimeout(handle)
      handle = null
    }
  }

  function arm(): void {
    if (disposed || controller.signal.aborted) return
    clear()
    handle = setTimeout(() => {
      handle = null
      controller.abort()
    }, timeoutMs)
  }

  arm()

  return {
    signal: controller.signal,
    reset: arm,
    pause: clear,
    resume: arm,
    dispose: () => {
      clear()
      disposed = true
    },
  }
}
