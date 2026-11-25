/**
 * Whether this run has been cancelled by a signal.
 *
 * A cancelled run must not start another irreversible write (a comment, a review, an approval, a reaction, a label, a branch
 * or a push): the runner is about to kill the process, and a write that lands after the cancel is one the operator asked to
 * stop. The sandbox lifecycle's signal handler (`harness/phases/sandbox-lifecycle.ts`, the only handler of an isolated run) sets the flag synchronously, before anything else
 * runs. Every writer asks at the point of submission, after its last await and right before the request goes out, because
 * a read that was already in flight when the signal arrived may finish after it.
 *
 * The flag is process-wide and one-way: a cancelled process only ever ends. It lives here, in the lowest layer, so the
 * writers in `features/` and `services/` can ask without importing the harness.
 */

let cancelled = false

/**
 * Work that must run at once when the signal arrives, not when its owner next looks at the flag: giving back something the run
 * holds that would otherwise outlive it (a review-receipt reservation, while a read the run is waiting on may never answer).
 * Registered while the run holds the thing, unregistered when it no longer does. That handler starts every registered cleanup
 * in the handler and waits for them beside the teardown and the export.
 */
const cleanups = new Set<() => Promise<unknown>>()

/** Called by the sandbox lifecycle's signal handler, synchronously, on the first SIGINT or SIGTERM. */
export function markRunCancelled(): void {
  cancelled = true
}

export function isRunCancelled(): boolean {
  return cancelled
}

/** Tests only: a real run never un-cancels. */
export function resetRunCancellation(): void {
  cancelled = false
  cleanups.clear()
}

/** Registers a cleanup. Returns the function that unregisters it. Call it only while the run is not cancelled. */
export function registerCancellationCleanup(cleanup: () => Promise<unknown>): () => void {
  cleanups.add(cleanup)
  return () => {
    cleanups.delete(cleanup)
  }
}

/** Starts every registered cleanup, once, and returns what is running. Never rejects. Called by the sandbox lifecycle's signal handler only. */
export function startCancellationCleanups(): Promise<void>[] {
  const started = [...cleanups].map(async cleanup => {
    try {
      await cleanup()
    } catch {
      // A cleanup is best-effort: the run is ending either way.
    }
  })
  cleanups.clear()
  return started
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
  throw createRunCancelledError(`The run was cancelled, so ${what} was not sent`)
}

/** The named error a cancelled run stops with, for a caller that decides cancellation from state of its own (`run.ts`). */
export function createRunCancelledError(message: string): Error {
  const error = new Error(message)
  error.name = RUN_CANCELLED_ERROR_NAME
  return error
}
