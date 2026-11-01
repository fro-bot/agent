import type {ErrorInfo, OwnershipLedger, RemoteOpenCodeV2Client} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {AttemptObservation, FailureObservation} from './attempt-outcome.js'
import type {ExecutionDeadline} from './retry.js'
import type {ActivityTrackerV2} from './streaming-v2.js'
import {createAgentError} from '@fro-bot/runtime'
import {toErrorMessage} from '../../shared/errors.js'
import {ledgerBlocksCompletion, waitForAbortableDelay} from './session-poll.js'
import {getObservedFailureV2} from './streaming-v2.js'

/**
 * Completion watchdog for a run on OpenCode V2: the sibling of `session-poll.ts`.
 *
 * V1 had to infer completion from a mix of idle events, session status and message polling, so its poller is large. V2
 * says it directly: the root's turn ends with `execution.succeeded`, `.failed` or `.interrupted`. This poller therefore
 * does three small things:
 * 1. turns the root result the event loop recorded on the tracker into an attempt observation (`observeRootTerminal`);
 * 2. enforces the same initial-activity watchdog as V1;
 * 3. when the event stream cannot be trusted (lost, replaced, or the wait route said idle with no result), reads the
 *    persisted state instead: `GET /api/session/active` and `GET /api/session/:id` (`outcome`, the persisted result of
 *    the last execution that ended). That evidence is accepted only after the root was seen running and then seen not
 *    running twice, because a continued session carries the previous run's outcome.
 */

const POLL_INTERVAL_MS = 500
const REST_POLL_EVERY_TICKS = 4
const REST_REQUEST_TIMEOUT_MS = 5_000
const INACTIVE_READS_REQUIRED = 2
export const INITIAL_ACTIVITY_TIMEOUT_MS_V2 = 90_000

/** Failure evidence on the tracker at the moment a producer decides, provider first. Never read after the fact. */
export function snapshotFailuresV2(tracker: ActivityTrackerV2): FailureObservation[] {
  const observed = getObservedFailureV2(tracker)
  if (observed === null) return []
  return [
    {
      source: observed.terminal ? 'provider' : 'session',
      message: observed.error.message,
      llmError: observed.error,
      classificationPath: observed.classificationPath,
    },
  ]
}

function interruptedFailure(reason: string): FailureObservation {
  const error: ErrorInfo = createAgentError(`The OpenCode root session was interrupted (${reason})`)
  return {source: 'session', message: error.message, llmError: error, classificationPath: 'structured'}
}

/**
 * The observation for the root result the event loop recorded, or `null` when there is none yet or completion must
 * wait (owned work outstanding). A terminal provider failure wins even before a root result exists.
 */
export function observeRootTerminal(
  tracker: ActivityTrackerV2,
  logger: Logger,
  ownershipLedger?: OwnershipLedger,
): AttemptObservation | null {
  if (tracker.terminalProviderError !== undefined) {
    return {settlement: {kind: 'failure-observed'}, failures: snapshotFailuresV2(tracker)}
  }
  const terminal = tracker.rootTerminal
  if (terminal === null) return null

  switch (terminal.kind) {
    case 'failed':
      return {settlement: {kind: 'failure-observed'}, failures: snapshotFailuresV2(tracker)}
    case 'interrupted':
      return {
        settlement: {kind: 'cancelled', reason: `interrupted:${terminal.reason}`},
        failures: [...snapshotFailuresV2(tracker), interruptedFailure(terminal.reason)],
      }
    case 'succeeded': {
      // A completion notice queued for the root owes it a second turn (probe P2). Only a stream that lost events may
      // be missing the delivery that clears it; the directory drain after the attempt is the net for that case.
      if ((tracker.queuedNoticeInboxIds.size > 0 || tracker.turnOwed) && !tracker.streamBlind) {
        logger.debug('Root turn succeeded but a notice-triggered turn is owed; deferring completion', {
          queued: tracker.queuedNoticeInboxIds.size,
          turnOwed: tracker.turnOwed,
        })
        return null
      }
      if (ledgerBlocksCompletion(ownershipLedger)) {
        logger.debug('Root turn succeeded but owned work is outstanding; deferring completion', {
          outstanding: ownershipLedger?.outstanding(),
        })
        return null
      }
      return {settlement: {kind: 'completion-observed'}, failures: snapshotFailuresV2(tracker)}
    }
  }
}

export interface PollOptionsV2 {
  readonly client: RemoteOpenCodeV2Client
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly logger: Logger
  readonly tracker: ActivityTrackerV2
  readonly deadline?: ExecutionDeadline
  readonly ownershipLedger?: OwnershipLedger
  readonly pollIntervalMs?: number
  readonly restEveryTicks?: number
  readonly initialActivityTimeoutMs?: number
}

function terminalObservationOnAbort(options: PollOptionsV2): AttemptObservation {
  const {tracker, deadline} = options
  // A terminal provider failure already accepted wins at the boundary: it is a result, not a deadline conclusion.
  if (tracker.terminalProviderError !== undefined) {
    return {settlement: {kind: 'failure-observed'}, failures: snapshotFailuresV2(tracker)}
  }
  if (deadline?.isExpired() === true) return {settlement: {kind: 'deadline'}, failures: snapshotFailuresV2(tracker)}
  return {settlement: {kind: 'cancelled', reason: 'Aborted'}, failures: snapshotFailuresV2(tracker)}
}

export async function pollForSessionCompletionObservationV2(options: PollOptionsV2): Promise<AttemptObservation> {
  const {client, sessionId, signal, logger, tracker, deadline, ownershipLedger} = options
  const intervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const restEvery = options.restEveryTicks ?? REST_POLL_EVERY_TICKS
  const initialActivityTimeoutMs = options.initialActivityTimeoutMs ?? INITIAL_ACTIVITY_TIMEOUT_MS_V2
  const pollStart = Date.now()
  let ticks = 0
  let restSawRootActive = false
  let inactiveReads = 0
  let seenRevision = tracker.rootRevision

  while (!signal.aborted) {
    const decided = observeRootTerminal(tracker, logger, ownershipLedger)
    if (decided !== null) {
      // A result already accepted wins unless the deadline expired first for a non-failure.
      if (deadline?.isExpired() === true && decided.settlement.kind === 'completion-observed') {
        return {settlement: {kind: 'deadline'}, failures: decided.failures}
      }
      return decided
    }
    if (deadline?.isExpired() === true) return terminalObservationOnAbort(options)

    try {
      if (deadline === undefined) await waitForAbortableDelay(intervalMs, signal)
      else await deadline.run(async () => waitForAbortableDelay(intervalMs, signal), 'poll interval')
    } catch {
      // `deadline.run` rejects here only through deadline exhaustion.
      return terminalObservationOnAbort(options)
    }
    if (signal.aborted) return terminalObservationOnAbort(options)
    ticks += 1

    // The root restarted (or a notice changed what its result means) since the last tick: the confirmation that it had
    // stopped belongs to the earlier turn.
    if (tracker.rootRevision !== seenRevision) {
      seenRevision = tracker.rootRevision
      inactiveReads = 0
    }

    const restTrusted = tracker.streamBlind || tracker.idleHintWithoutTerminal
    if (restTrusted && ticks % restEvery === 0 && tracker.rootTerminal === null) {
      // Taken before any read: a read that returns under a newer revision describes a turn that is no longer the
      // current one, and must change nothing.
      const readRevision = tracker.rootRevision
      const stale = (): boolean => tracker.rootRevision !== readRevision
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REST_REQUEST_TIMEOUT_MS)])
        const active = await client.session.active({signal: requestSignal})
        if (stale()) {
          inactiveReads = 0
          logger.debug('Discarding a stale active-session read: the root changed while it was pending', {sessionId})
        } else if (Object.keys(active).includes(sessionId)) {
          restSawRootActive = true
          inactiveReads = 0
        } else if (restSawRootActive || tracker.rootExecutionStarted) {
          inactiveReads += 1
          if (inactiveReads >= INACTIVE_READS_REQUIRED) {
            const info = await client.getSession({sessionId, signal: requestSignal})
            if (stale() || (!tracker.streamBlind && (tracker.turnOwed || tracker.queuedNoticeInboxIds.size > 0))) {
              // The persisted outcome is the last ended turn's: with a newer turn running, or one owed, it is not this
              // run's result.
              inactiveReads = 0
              logger.debug('Discarding a persisted outcome read: a newer turn is running or owed', {sessionId})
            } else if (info.success && info.data.outcome !== null) {
              logger.warning('Root turn result read from the persisted session state; the event stream missed it', {
                sessionId,
                outcome: info.data.outcome,
              })
              if (info.data.outcome === 'succeeded') tracker.rootTerminal = {kind: 'succeeded'}
              else if (info.data.outcome === 'interrupted') tracker.rootTerminal = {kind: 'interrupted', reason: 'user'}
              else {
                tracker.genericError ??= createAgentError('The OpenCode session execution failed')
                tracker.classificationPath ??= 'structured'
                tracker.rootTerminal = {kind: 'failed'}
              }
            }
          }
        }
      } catch (error) {
        logger.debug('Poll request failed', {error: toErrorMessage(error)})
      }
    }

    if (!tracker.firstMeaningfulEventReceived && !restSawRootActive) {
      const elapsed = Date.now() - pollStart
      if (elapsed >= initialActivityTimeoutMs) {
        logger.error('No agent activity detected — server may have crashed during prompt processing', {
          elapsedMs: elapsed,
          sessionId,
        })
        return {
          settlement: {
            kind: 'watchdog',
            message: `No agent activity detected after ${elapsed}ms — server may have crashed during prompt processing`,
          },
          failures: snapshotFailuresV2(tracker),
        }
      }
    }
  }

  return terminalObservationOnAbort(options)
}
