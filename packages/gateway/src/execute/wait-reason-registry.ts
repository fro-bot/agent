/**
 * Why each draining run has not been admitted by the completion gate yet: the latest declined-attempt code per run.
 *
 * In-process only. The operator status layers it over a `running` run (never written to the object store), so a
 * restarted gateway forgets it, which is correct: a restarted process owns no draining run. `run-core` records a code
 * on each declined attempt and clears it on admission and when its loop exits, whatever the exit.
 */

const reasons = new Map<string, string>()
const listeners = new Set<(runId: string) => void>()

function notify(runId: string): void {
  for (const listener of listeners) {
    try {
      listener(runId)
    } catch {
      // A listener is a best-effort refresh; it must never fail the run.
    }
  }
}

/** Records the latest declined-attempt code for `runId`. Listeners hear about a change, never a repeat. */
export function setWaitReason(runId: string, code: string): void {
  if (reasons.get(runId) === code) return
  reasons.set(runId, code)
  notify(runId)
}

/** Forgets the run's code. Listeners hear about it only if there was one. */
export function clearWaitReason(runId: string): void {
  if (reasons.delete(runId)) notify(runId)
}

/** The latest declined-attempt code for `runId`, if the run is draining and has been declined. */
export function getWaitReason(runId: string): string | undefined {
  return reasons.get(runId)
}

/** Subscribes to changes; returns the unsubscribe. */
export function onWaitReasonChange(listener: (runId: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
