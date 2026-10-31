/**
 * The run summary of an OpenCode V2 run, held until the run is released.
 *
 * V1 writes the summary into the session as a message with no reply. On V2 the same write (`POST /api/session/:id/synthetic`
 * with `resume: false`) leaves the message as a QUEUED inbox item of the root: it starts no turn, but it is never
 * delivered either, so the item stays queued for the life of the session. The release rule reads exactly that
 * (`GET /api/session/:id/inbox`, "no queued inbox item": a queued item is a turn the server will start by itself), and
 * would wait on the Action's own summary for ever.
 *
 * So the execute phase only records the summary here, keyed by the server handle, and the release writes it as its last
 * step before the shutdown, after the final reading of the directory. The next run still finds it in the session.
 */

interface DeferredSummary {
  readonly sessionId: string
  readonly text: string
}

const pending = new WeakMap<object, DeferredSummary>()

/** Record the summary for `owner` (the server handle). A later summary replaces an earlier one: one per run. */
export function deferSummaryV2(owner: object, sessionId: string, text: string): void {
  pending.set(owner, {sessionId, text})
}

/** The recorded summary, removed so it is written once. */
export function takeDeferredSummaryV2(owner: object): DeferredSummary | undefined {
  const summary = pending.get(owner)
  pending.delete(owner)
  return summary
}
