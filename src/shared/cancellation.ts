/**
 * Whether this run has been cancelled by a signal.
 *
 * A cancelled run must not start another irreversible write (a comment, a review, an approval, a reaction, a label, a branch
 * or a push): the runner is about to kill the process, and a write that lands after the cancel is one the operator asked to
 * stop. The signal owner (`harness/signal-owner.ts`) sets the flag synchronously, in the signal handler, before anything else
 * runs. Every writer asks at the point of submission, after its last await and right before the request goes out, because
 * a read that was already in flight when the signal arrived may finish after it.
 *
 * The flag is process-wide and one-way: a cancelled process only ever ends. It lives here, in the lowest layer, so the
 * writers in `features/` and `services/` can ask without importing the harness.
 */

let cancelled = false

/** Called by the signal owner, synchronously, on the first SIGINT or SIGTERM. */
export function markRunCancelled(): void {
  cancelled = true
}

export function isRunCancelled(): boolean {
  return cancelled
}

/** Tests only: a real run never un-cancels. */
export function resetRunCancellation(): void {
  cancelled = false
}

/** The error a writer stops with. Named, so a caller that cares can tell it from a failed request. */
export const RUN_CANCELLED_ERROR_NAME = 'RunCancelledError'

/**
 * Throws when the run is cancelled. Call it inside the writer's own `try`, right before the request: the writer's existing
 * failure handling (a logged warning and a null or failed result, or a fail-safe catch) then does exactly what it does for a
 * request that failed, and nothing is sent. `what` names the write, in fixed text.
 */
export function assertRunNotCancelled(what: string): void {
  if (!cancelled) return
  const error = new Error(`The run was cancelled, so ${what} was not sent`)
  error.name = RUN_CANCELLED_ERROR_NAME
  throw error
}
