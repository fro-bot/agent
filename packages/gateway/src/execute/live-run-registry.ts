/**
 * The set of runs this process is still running, from the moment a run's ACKNOWLEDGED write commits to the true end of
 * the run: after its last terminal write, or, for a quarantined run, after the deferred heartbeat stop that ends its
 * hold window. The stranded-run sweep consults it before it terminalizes a stale-looking record.
 *
 * The abort registry is not enough: it only covers EXECUTING (registered once the stream starts), and a run is also
 * live while it prepares the checkout (ACKNOWLEDGED) and while a quarantined run holds the repo. In-memory only: a
 * restarted process owns nothing, and startup recovery handles what the old one left behind.
 */

const liveRunRepos = new Map<string, string>()

/**
 * Live runs that quarantined: their termination barrier could not confirm the owned sessions stopped, so the repo lock
 * and channel slot are held (and the quarantine watch keeps interrupting) until the hold window ends. A subset of
 * the live set; cleared with it. In-memory only, and set even when the quarantine's own FAILED write never landed, so
 * it is the one signal that a still-EXECUTING record belongs to a run that must not be cancelled.
 */
const quarantinedRunIds = new Set<string>()

/** A run this process is still running, with the repo (`owner/repo`) its record lives under. */
export interface LiveRun {
  readonly runId: string
  readonly repo: string
}

/** Marks `runId` live under `repo`. Called once its ACKNOWLEDGED write has committed. */
export function markRunLive(runId: string, repo: string): void {
  liveRunRepos.set(runId, repo)
}

/** Marks `runId` ended. A no-op for an id that is not live. */
export function markRunEnded(runId: string): void {
  liveRunRepos.delete(runId)
  quarantinedRunIds.delete(runId)
}

/** Marks `runId` quarantined. Called when the run's quarantine path begins; ended by `markRunEnded`. */
export function markRunQuarantined(runId: string): void {
  quarantinedRunIds.add(runId)
}

/** Whether `runId` is in its quarantine hold in this process. */
export function isRunQuarantined(runId: string): boolean {
  return quarantinedRunIds.has(runId)
}

/** Whether this process is still running `runId`. */
export function isRunLive(runId: string): boolean {
  return liveRunRepos.has(runId)
}

/**
 * Every run this process still runs, past the queue: a queued (PENDING) run is never here, since a run is marked live
 * only once its ACKNOWLEDGED write commits. Unlike a run-index scan this is neither capped nor dependent on storage,
 * so it is the authority for "which runs can be cancelled right now".
 */
export function listLiveRuns(): readonly LiveRun[] {
  return [...liveRunRepos].map(([runId, repo]) => ({runId, repo}))
}
