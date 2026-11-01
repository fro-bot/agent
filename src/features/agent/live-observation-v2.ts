import type {AttemptResult} from './prompt-sender.js'
import type {ActivityTrackerV2} from './streaming-v2.js'
import type {EventStreamResult} from './streaming.js'
import type {AgentResult} from './types.js'
import type {RunUsageV2} from './usage-v2.js'

/**
 * The event observation of a V2 run that outlives the prompt attempt.
 *
 * A successful attempt used to stop its event processor at once. That is too early on V2: root idle is not terminal
 * (probe P2), and a child that settles through REST just before its notice can start a second root turn that nothing
 * would see, so its permission asks would go unanswered, its forms uncancelled and its failure unrecorded. So a
 * successful attempt hands its processor over instead, and the release (`release-v2.ts`) stops it only once the
 * directory is confirmed quiet, just before the server is shut down.
 *
 * The handover is explicit: the observation travels as a field of the results that already flow from the attempt to
 * the release (`AttemptResultV2`, `AgentResult` of the V2 loop, `ExecutePhaseResult.liveObservation`, then
 * `runReleaseV2`'s options). Nothing is held in a module-level table, so two runs in one process share nothing.
 */
export interface LiveObservationV2 {
  /** The tracker the processor keeps updating: the root's latest turn, and any failure it recorded. */
  readonly tracker: ActivityTrackerV2
  /** What the stream gathered so far, without stopping it. */
  readonly snapshot: () => EventStreamResult
  /** Stop observing and return everything the stream gathered over its whole life. Idempotent. */
  readonly stop: () => Promise<EventStreamResult>
  /** Re-reads the run's usage once the last turn is over. Set by the execution loop, which knows the baseline. */
  refreshUsage?: () => Promise<RunUsageV2>
}

/** A V2 attempt's result. Only a successful attempt of a run that can keep observing carries an observation. */
export type AttemptResultV2 = AttemptResult & {
  readonly liveObservation?: LiveObservationV2
  /**
   * The prompt POST failed AFTER it may have reached the server (the connection broke before an answer): the prompt may be
   * admitted and running. It is never resent, and the run's state cannot be trusted to match what this run did.
   */
  readonly sendUncertain?: boolean
}

/** The V2 loop's result: V1's `AgentResult`, plus the observation a successful run keeps for the release. */
export type AgentResultV2 = AgentResult & {
  readonly liveObservation?: LiveObservationV2
  /** An attempt's prompt POST failed after it may have been sent; see `AttemptResultV2.sendUncertain`. */
  readonly sendUncertain?: boolean
}
