import type {ActionOpenCodeV2Client, OwnershipLedger} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {AttemptObservation, FailureObservation, TurnEvidence} from './attempt-outcome.js'
import type {AttemptResultV2} from './live-observation-v2.js'
import type {AttemptResult} from './prompt-sender.js'
import type {ExecutionDeadline} from './retry.js'
import type {FormAskedResponderV2, PermissionAskedResponderV2} from './streaming-v2.js'
import type {EventStreamResult} from './streaming.js'
import {toErrorMessage} from '../../shared/errors.js'
import {reduceAttemptOutcome} from './attempt-outcome.js'
import {createOwnedWorkReconcilerV2} from './reconcile-v2.js'
import {awaitStreamConnected, createDeadlineExceededError, createStreamNotConnectedResult} from './retry.js'
import {
  observeRootTerminal,
  pollForSessionCompletionObservationV2,
  snapshotFailuresV2,
  type PollOptionsV2,
} from './session-poll-v2.js'
import {ledgerBlocksCompletion, waitForAbortableDelay, waitForEventProcessorShutdown} from './session-poll.js'
import {createActivityTrackerV2, processEventStreamV2} from './streaming-v2.js'

/**
 * One prompt attempt on OpenCode V2: the sibling of `runPromptAttempt` in `retry.ts`. The retry policy itself
 * (`MAX_LLM_RETRIES`, `RETRY_DELAYS_MS`, the deadline, the continuation prompt) is shared with V1 and lives there.
 *
 * Order, which is what keeps a late connection from losing events: the stream is subscribed by the caller, the event
 * processor starts, and the prompt is sent only after the stream's first `server.connected` frame was read. A stream
 * that never connects fails the attempt with nothing sent (`submit_failed`, retryable `llm_fetch_error`), so the retry
 * loop resends the original prompt and each attempt subscribes a fresh stream.
 *
 * Completion is raced between two producers, as on V1:
 * - the session-wait route (`POST /api/experimental/session/:id/wait`, `packages/server/src/handlers/session.ts:438` →
 *   `Session.wait` → `execution.awaitIdle`, `packages/core/src/session/run-coordinator.ts:166`), the V2 analogue of
 *   V1's `v2.session.wait`. It answers 204 once no execution of the session is active, which is also what a prompt
 *   that is not admitted yet looks like (probe P1), and it says nothing about how an execution ended. So it is a hint:
 *   it counts only once the event loop recorded the root's result for the current turn, and otherwise defers to the
 *   poll watchdog.
 * - the poll watchdog (`session-poll-v2.ts`), which reads the same result from the tracker and enforces the
 *   no-activity bound.
 *
 * Release is not decided here. Root idle is not terminal on V2 (a background child's notice starts a second turn), so
 * a successful attempt with a ledger does not stop its event processor: it hands the observation over
 * (`live-observation-v2.ts`) and the release stops it once the directory is confirmed quiet. Until then the same
 * processor keeps rejecting permission asks, cancelling forms and recording the root's turns, including the one a
 * notice starts. Every other result stops it here, as before.
 */

const TERMINAL_GRACE_MS = 500
const TERMINAL_POLL_INTERVAL_MS = 10
const BEFORE_ADMISSION_RETRY_MS = 250

export type PromptStartResultV2 = (AttemptResult & {readonly sendUncertain?: boolean}) | null
export type PromptStarterV2 = () => Promise<PromptStartResultV2>

type V2WaitObservation = {readonly kind: 'fallback-to-poll'} | AttemptObservation

export interface RunPromptAttemptV2Options {
  readonly client: ActionOpenCodeV2Client
  readonly sessionId: string
  readonly eventStream: AsyncIterable<unknown>
  readonly startPrompt: PromptStarterV2
  readonly logger: Logger
  readonly deadline?: ExecutionDeadline
  readonly attemptAbortController?: AbortController
  readonly onPermissionAsked?: PermissionAskedResponderV2
  readonly onFormAsked?: FormAskedResponderV2
  readonly onFatal?: (cause: 'session_moved') => void
  readonly ownershipLedger?: OwnershipLedger
  /**
   * The caller can keep the subscription open past this call. A successful attempt then leaves its processor running and
   * returns it as `liveObservation`; the caller must not abort `attemptAbortController` for such a result.
   */
  readonly keepObserving?: boolean
  /** The location the run's shells run in. With a ledger it turns on REST reconciliation of children and shells. */
  readonly directory?: string
  /** Test seam: poll cadence and the no-activity bound. */
  readonly poll?: Pick<PollOptionsV2, 'initialActivityTimeoutMs' | 'pollIntervalMs' | 'restEveryTicks'>
  /** Test seam: cadence of the live reconcile tick. */
  readonly reconcileIntervalMs?: number
}

async function startSessionWaitV2(options: {
  readonly client: ActionOpenCodeV2Client
  readonly sessionId: string
  readonly tracker: ReturnType<typeof createActivityTrackerV2>
  readonly logger: Logger
  readonly signal: AbortSignal
  readonly deadline?: ExecutionDeadline
  readonly ownershipLedger?: OwnershipLedger
}): Promise<V2WaitObservation> {
  const {client, sessionId, tracker, logger, signal, deadline, ownershipLedger} = options
  const delay = async (ms: number): Promise<void> => {
    if (deadline === undefined) await waitForAbortableDelay(ms, signal)
    else await deadline.run(async () => waitForAbortableDelay(ms, signal), 'v2 session wait delay')
  }

  try {
    while (!signal.aborted) {
      const response =
        deadline === undefined
          ? await client.waitSession({sessionId, signal})
          : await deadline.run(async () => client.waitSession({sessionId, signal}), 'v2 session wait')
      if (!response.success) {
        logger.debug('v2 session wait returned an error, relying on the poll watchdog', {
          sessionId,
          error: response.error.kind,
        })
        return {kind: 'fallback-to-poll'}
      }

      // Absorb the gap between the route answering and the event loop catching up. The result must be for the
      // CURRENT turn: a new `execution.started` clears it, so a stale result from an earlier turn cannot pass.
      const graceEnd = Date.now() + TERMINAL_GRACE_MS
      while (tracker.rootTerminal === null && Date.now() < graceEnd && !signal.aborted) {
        await delay(TERMINAL_POLL_INTERVAL_MS)
      }

      if (tracker.rootTerminal !== null) {
        const decided = observeRootTerminal(tracker, logger, ownershipLedger)
        if (decided === null) {
          logger.debug('v2 session wait resolved with a root result but owned work outstanding; deferring to poll', {
            sessionId,
            outstanding: ownershipLedger?.outstanding(),
          })
          return {kind: 'fallback-to-poll'}
        }
        return decided
      }

      if (tracker.rootExecutionStarted) {
        // The root ran and is idle, yet no result arrived: the stream may have missed it. The poll path reads it.
        tracker.idleHintWithoutTerminal = true
        logger.debug('v2 session wait resolved without a root result; deferring to the poll watchdog', {sessionId})
        return {kind: 'fallback-to-poll'}
      }

      // Answered before the prompt was admitted (probe P1): ask again once admission had time to happen.
      await delay(BEFORE_ADMISSION_RETRY_MS)
    }
  } catch (error) {
    logger.debug('v2 session wait threw, relying on the poll watchdog', {sessionId, error: toErrorMessage(error)})
  }
  return {kind: 'fallback-to-poll'}
}

export async function runPromptAttemptV2(options: RunPromptAttemptV2Options): Promise<AttemptResultV2> {
  const {client, sessionId, logger, deadline, ownershipLedger, startPrompt} = options
  const attemptController = options.attemptAbortController ?? new AbortController()
  const eventAbortController = new AbortController()
  const waitAbortController = new AbortController()
  const pollAbortController = new AbortController()
  const eventSignal =
    deadline === undefined
      ? eventAbortController.signal
      : AbortSignal.any([eventAbortController.signal, deadline.signal])
  const pollSignal =
    deadline === undefined ? pollAbortController.signal : AbortSignal.any([pollAbortController.signal, deadline.signal])
  const waitSignal =
    deadline === undefined ? waitAbortController.signal : AbortSignal.any([waitAbortController.signal, deadline.signal])
  const subscriptionSignal =
    deadline === undefined ? attemptController.signal : AbortSignal.any([attemptController.signal, deadline.signal])

  const tracker = createActivityTrackerV2()
  let eventStreamResult: EventStreamResult = {
    tokens: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
  }

  // The net under the stream's notices: a settlement the stream missed must not hold the attempt until its deadline.
  // The tick runs for the whole attempt and the root going idle triggers one pass at once, because that is the moment
  // the ledger is what stands between the run and its result.
  const reconciler =
    ownershipLedger === undefined || options.directory === undefined
      ? null
      : createOwnedWorkReconcilerV2({
          client,
          ledger: ownershipLedger,
          directory: options.directory,
          parentSessionId: sessionId,
          logger,
          ...(options.reconcileIntervalMs === undefined ? {} : {intervalMs: options.reconcileIntervalMs}),
        })

  const snapshotRef: {read: (() => EventStreamResult) | null} = {read: null}
  let markStreamConnected: () => void = () => {}
  const streamConnected = new Promise<void>(resolve => {
    markStreamConnected = resolve
  })

  const eventProcessor = processEventStreamV2({
    stream: options.eventStream,
    sessionId,
    signal: eventSignal,
    logger,
    tracker,
    ...(ownershipLedger === undefined ? {} : {ownershipLedger}),
    ...(options.onPermissionAsked === undefined ? {} : {onPermissionAsked: options.onPermissionAsked}),
    ...(options.onFormAsked === undefined ? {} : {onFormAsked: options.onFormAsked}),
    ...(options.onFatal === undefined ? {} : {onFatal: options.onFatal}),
    exposeSnapshot: snapshot => {
      snapshotRef.read = snapshot
    },
    onStreamConnected: markStreamConnected,
    onRootTerminal: terminal => {
      // eslint-disable-next-line no-void
      if (terminal.kind === 'succeeded') void reconciler?.reconcileNow()
    },
  })
    .then(result => {
      eventStreamResult = result
    })
    .catch((error: unknown) => {
      if (error instanceof Error && error.name !== 'AbortError')
        logger.debug('Event stream error', {error: error.message})
    })

  let eventProcessorShutdown: Promise<void> | null = null
  const stopEventProcessor = async (): Promise<void> => {
    if (eventProcessorShutdown !== null) return eventProcessorShutdown
    attemptController.abort()
    waitAbortController.abort()
    pollAbortController.abort()
    eventAbortController.abort()
    eventProcessorShutdown = waitForEventProcessorShutdown(eventProcessor)
    return eventProcessorShutdown
  }

  // Set when the processor is handed over: the finally block then leaves it running.
  let kept = false
  let sendUncertain = false

  // A failed prompt submission deferred past the early exit below, as a snapshot that joins the single reduction.
  let preservedSubmissionFailure: FailureObservation | null = null

  try {
    const connect = await awaitStreamConnected({
      connected: streamConnected,
      streamEnded: eventProcessor,
      signal: subscriptionSignal,
      deadline,
    })
    if (connect !== 'connected') {
      if (connect === 'deadline') throw createDeadlineExceededError('event stream connection')
      return createStreamNotConnectedResult(connect, logger, sessionId, eventStreamResult.discontinuity)
    }

    const promptStartResult =
      deadline === undefined ? await startPrompt() : await deadline.run(startPrompt, 'prompt submission')
    // Sticky for the rest of the attempt: a prompt that may be running must neither be resent nor trusted to leave the
    // session in a state this run can vouch for, whichever failure the reduction below selects.
    if (promptStartResult?.sendUncertain === true) sendUncertain = true
    if (promptStartResult !== null) {
      if (ledgerBlocksCompletion(ownershipLedger)) {
        if (!promptStartResult.success) {
          preservedSubmissionFailure = {
            source: 'submission',
            message: promptStartResult.error ?? 'Prompt submission failed',
            llmError: promptStartResult.llmError,
          }
        }
        logger.debug('Prompt start result observed but owned work outstanding — deferring completion', {
          sessionId,
          outstanding: ownershipLedger?.outstanding(),
        })
      } else {
        await stopEventProcessor()
        if (!promptStartResult.success) {
          const failures: FailureObservation[] = [
            ...snapshotFailuresV2(tracker),
            {
              source: 'submission',
              message: promptStartResult.error ?? 'Prompt submission failed',
              llmError: promptStartResult.llmError,
            },
          ]
          const turnEvidence: TurnEvidence = {accepted: tracker.firstMeaningfulEventReceived}
          const reduced = reduceAttemptOutcome({settlement: {kind: 'failure-observed'}, failures}, null, turnEvidence)
          // Only an accepted turn has real artifacts; otherwise the synthetic result already carries the failure.
          let merged = turnEvidence.accepted ? eventStreamResult : promptStartResult.eventStreamResult
          if (reduced.llmError !== null && merged.llmError?.type !== reduced.llmError.type) {
            merged = {
              ...merged,
              llmError: reduced.llmError,
              classificationPath: reduced.classificationPath ?? merged.classificationPath,
            }
          }
          return {
            success: reduced.success,
            error: reduced.error,
            llmError: reduced.llmError,
            outcome: reduced.outcome,
            shouldRetry: reduced.shouldRetry,
            settlement: reduced.settlement,
            eventStreamResult: merged,
            ...(sendUncertain ? {sendUncertain} : {}),
          }
        }
        return promptStartResult
      }
    }

    const pollObservation = pollForSessionCompletionObservationV2({
      client,
      sessionId,
      signal: pollSignal,
      logger,
      tracker,
      ...(deadline === undefined ? {} : {deadline}),
      ...(ownershipLedger === undefined ? {} : {ownershipLedger}),
      ...options.poll,
    })
    const waitObservation = startSessionWaitV2({
      client,
      sessionId,
      tracker,
      logger,
      signal: waitSignal,
      ...(deadline === undefined ? {} : {deadline}),
      ...(ownershipLedger === undefined ? {} : {ownershipLedger}),
    })

    // An authoritative wait observation wins outright; a `fallback-to-poll` tag defers to the poll observation. Whichever
    // settles first is kept as is: no post-race clock recheck second-guesses it.
    const winning: AttemptObservation = await Promise.race([
      waitObservation.then(async outcome => ('settlement' in outcome ? outcome : pollObservation)),
      pollObservation,
    ])

    const turnEvidence: TurnEvidence = {accepted: tracker.firstMeaningfulEventReceived}
    const reduced = reduceAttemptOutcome(winning, preservedSubmissionFailure, turnEvidence)

    if (reduced.success && options.keepObserving === true && snapshotRef.read !== null) {
      // The wait and poll producers have decided; only the event processor stays. See the module doc.
      waitAbortController.abort()
      pollAbortController.abort()
      const snapshot = snapshotRef.read
      kept = true
      return {
        success: reduced.success,
        error: reduced.error,
        llmError: reduced.llmError,
        outcome: reduced.outcome,
        shouldRetry: reduced.shouldRetry,
        settlement: reduced.settlement,
        eventStreamResult: snapshot(),
        liveObservation: {
          tracker,
          snapshot,
          stop: async () => {
            await stopEventProcessor()
            return snapshot()
          },
        },
      }
    }

    await stopEventProcessor()
    let merged = eventStreamResult
    if (reduced.llmError !== null && eventStreamResult.llmError?.type !== reduced.llmError.type) {
      merged = {...eventStreamResult, llmError: reduced.llmError}
    }
    return {
      success: reduced.success,
      error: reduced.error,
      llmError: reduced.llmError,
      outcome: reduced.outcome,
      shouldRetry: reduced.shouldRetry,
      settlement: reduced.settlement,
      eventStreamResult: merged,
      ...(sendUncertain ? {sendUncertain} : {}),
    }
  } finally {
    reconciler?.dispose()
    if (!kept) await stopEventProcessor()
  }
}
