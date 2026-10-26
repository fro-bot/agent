/**
 * The set of runs this process is still running, from the moment a run's ACKNOWLEDGED write commits to the true end of
 * the run: after its last terminal write, or, for a quarantined run, after the deferred heartbeat stop that ends its
 * hold window. The stranded-run sweep consults it before it terminalizes a stale-looking record.
 *
 * The abort registry is not enough: it only covers EXECUTING (registered once the stream starts), and a run is also
 * live while it prepares the checkout (ACKNOWLEDGED) and while a quarantined run holds the repo. In-memory only: a
 * restarted process owns nothing, and startup recovery handles what the old one left behind.
 */

const liveRunIds = new Set<string>()

/** Marks `runId` live. Called once its ACKNOWLEDGED write has committed. */
export function markRunLive(runId: string): void {
  liveRunIds.add(runId)
}

/** Marks `runId` ended. A no-op for an id that is not live. */
export function markRunEnded(runId: string): void {
  liveRunIds.delete(runId)
}

/** Whether this process is still running `runId`. */
export function isRunLive(runId: string): boolean {
  return liveRunIds.has(runId)
}
