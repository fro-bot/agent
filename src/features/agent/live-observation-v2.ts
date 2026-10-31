import type {OwnershipLedger} from '@fro-bot/runtime'
import type {ActivityTrackerV2} from './streaming-v2.js'
import type {EventStreamResult} from './streaming.js'
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
 * Keyed by the run's ownership ledger: the ledger is what the release already receives, and what ties the observation
 * to the run that started it. A run with no ledger never hands over.
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

const live = new WeakMap<OwnershipLedger, LiveObservationV2>()

export function registerLiveObservationV2(ledger: OwnershipLedger, observation: LiveObservationV2): void {
  live.set(ledger, observation)
}

/** The observation handed over for this ledger, removed so it is stopped once. */
export function takeLiveObservationV2(ledger: OwnershipLedger | undefined): LiveObservationV2 | undefined {
  if (ledger === undefined) return undefined
  const observation = live.get(ledger)
  live.delete(ledger)
  return observation
}

/** The observation handed over for this ledger, left in place. */
export function peekLiveObservationV2(ledger: OwnershipLedger | undefined): LiveObservationV2 | undefined {
  return ledger === undefined ? undefined : live.get(ledger)
}
