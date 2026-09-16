import type {ErrorInfo, OwnershipLedger} from '@fro-bot/runtime'
import type {createOpencode} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
/**
 * Settlement vocabulary from Step 1 of this restructure — see that module's doc comment for the
 * governing invariant ("selecting an error never proves quiescence, and observing quiescence
 * never erases an error"). This step establishes the cause inside the branch that decides to
 * return, instead of the caller inferring it from a post-hoc clock read.
 */
import type {AttemptObservation, FailureObservation} from './attempt-outcome.js'
import type {ExecutionDeadline} from './retry.js'
import type {ActivityTracker} from './streaming.js'
import {DEFAULT_TIMEOUT_MS} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'
import {classifyRetryStatusError, getObservedFailure, mergeActivityError} from './streaming.js'

const POLL_INTERVAL_MS = 500
const POLL_REQUEST_TIMEOUT_MS = 5_000
const EVENT_PROCESSOR_SHUTDOWN_TIMEOUT_MS = 2_000
const ERROR_GRACE_CYCLES = 3
export const INITIAL_ACTIVITY_TIMEOUT_MS = 90_000

/**
 * Public return shape, unchanged from before this step. `pollForSessionCompletion` stays a thin
 * adapter over `pollForSessionCompletionObservation` (below) so `retry.ts` and existing tests
 * compile and behave exactly as before — the settlement cause is available to callers that ask
 * for it via `pollForSessionCompletionObservation`, without forcing every existing caller to
 * consume it yet.
 */
interface PollResult {
  readonly completed: boolean
  readonly error: string | null
}

/**
 * Single snapshot point for whatever failure evidence the SSE processor has already recorded on
 * `activityTracker` at the exact moment a producer below is deciding to return -- never read by a
 * delayed continuation after that producer has already settled. Every observation constructor
 * that can legitimately carry failure evidence funnels through this so there is exactly one place
 * that knows how to read the tracker, matching `startV2SessionWait`'s completion branch in
 * retry.ts (the pre-existing correct reference implementation this mirrors).
 */
function snapshotObservedFailure(
  activityTracker: ActivityTracker | undefined,
): ReturnType<typeof getObservedFailure> | null {
  return activityTracker == null ? null : getObservedFailure(activityTracker)
}

/**
 * `activityTracker` is a required parameter, not optional: a completion observation snapshots
 * whatever failure evidence is already recorded on the tracker at this exact decision point, so a
 * producer cannot compile a `completion-observed` observation while silently discarding pending
 * failure evidence (the bug pattern this closes off -- see attempt-outcome.ts's module doc for the
 * governing invariant). The settlement still reports `completion-observed` even when a failure is
 * snapshotted here: the cause is what stopped observation, the failure is what
 * `reduceAttemptOutcome` reports -- see that function's precedence rules.
 */
/**
 * Shared by every observation constructor below that can legitimately carry pending failure
 * evidence: reads whatever `snapshotObservedFailure` finds at this exact decision point and
 * shapes it into the single-element (or empty) `failures` array each settlement returns.
 */
function snapshotFailures(activityTracker: ActivityTracker | undefined): FailureObservation[] {
  const observedFailure = snapshotObservedFailure(activityTracker)
  return observedFailure == null
    ? []
    : [
        {
          source: 'session',
          message: observedFailure.error.message,
          llmError: observedFailure.error,
          classificationPath: observedFailure.classificationPath,
        },
      ]
}

function completionObservation(activityTracker: ActivityTracker | undefined): AttemptObservation {
  return {settlement: {kind: 'completion-observed'}, failures: snapshotFailures(activityTracker)}
}

function providerFailureObservation(error: ErrorInfo): AttemptObservation {
  const failure: FailureObservation = {source: 'provider', message: error.message, llmError: error}
  return {settlement: {kind: 'failure-observed'}, failures: [failure]}
}

/**
 * Captures classified failure evidence (llmError + classificationPath) at construction time, via
 * `snapshotObservedFailure` above. `activityTracker` is required (not optional) for the same
 * reason as `completionObservation`: a producer that forgets to pass it does not compile.
 */
function sessionFailureObservation(message: string, activityTracker: ActivityTracker | undefined): AttemptObservation {
  const observedFailure = snapshotObservedFailure(activityTracker)
  const failure: FailureObservation = {
    source: 'session',
    message,
    llmError: observedFailure?.error ?? null,
    classificationPath: observedFailure?.classificationPath,
  }
  return {settlement: {kind: 'failure-observed'}, failures: [failure]}
}

/**
 * `deadline`/`cancelled`/`watchdog` settlements can never be misreported as success --
 * `reduceAttemptOutcome`'s success gate requires `settlement.kind === 'completion-observed'` --
 * but success was never the hazard here. Without a snapshot, a pending session failure sitting on
 * the tracker (e.g. still inside `ERROR_GRACE_CYCLES`) was silently discarded when one of these
 * fired first, and `reduceAttemptOutcome` fell through to `settlementFallback`'s generic
 * diagnostic instead -- the exact "expiry replaced the known error with a generic timeout" defect
 * this restructure exists to close. `activityTracker` is required (not optional) for the same
 * reason as `completionObservation`/`sessionFailureObservation` above: a call site that forgets
 * to pass it does not compile. The settlement cause is unchanged by this -- these three still
 * report `deadline`/`cancelled`/`watchdog` respectively; only the evidence attached to that cause
 * changes. Call sites that explicitly check `terminalProviderError` before reaching one of these
 * are deciding the settlement cause itself (provider-failure-observed vs. deadline/cancelled) and
 * are preserved as-is; `snapshotFailures` independently applies the same provider-over-session
 * precedence for whatever evidence remains once that decision has already gone the other way.
 */
function deadlineObservation(activityTracker: ActivityTracker | undefined): AttemptObservation {
  return {settlement: {kind: 'deadline'}, failures: snapshotFailures(activityTracker)}
}

function cancelledObservation(activityTracker: ActivityTracker | undefined): AttemptObservation {
  return {settlement: {kind: 'cancelled', reason: 'Aborted'}, failures: snapshotFailures(activityTracker)}
}

function watchdogObservation(message: string, activityTracker: ActivityTracker | undefined): AttemptObservation {
  return {settlement: {kind: 'watchdog', message}, failures: snapshotFailures(activityTracker)}
}

/**
 * Adapter preserving the pre-existing `{completed, error}` shape for callers that have not been
 * rewired to consume `AttemptObservation` yet (`retry.ts`'s `pollResult.completed`/`.error`, and
 * characterization tests asserting exact `{completed, error}` equality). Diagnostic text is
 * unchanged from what each branch returned before this step.
 */
function toPollResult(observation: AttemptObservation): PollResult {
  if (observation.settlement.kind === 'completion-observed') return {completed: true, error: null}

  const failure = observation.failures[0]
  if (failure != null) return {completed: false, error: failure.message}

  if (observation.settlement.kind === 'watchdog') return {completed: false, error: observation.settlement.message}

  // 'deadline' and 'cancelled' both preserve the original undifferentiated 'Aborted' diagnostic
  // text at this adapter boundary — the differentiation is in `observation.settlement.kind`.
  return {completed: false, error: 'Aborted'}
}

/**
 * `true` when a supplied ledger still has owned work outstanding — the gate every
 * terminal completion path in this module (and in `retry.ts`) consults before
 * reporting `completed: true`. Absent ledger means single-session behavior:
 * never blocks (backward-compatible no-op), matching `isOwnedSession` in
 * `streaming.ts`.
 */
export function ledgerBlocksCompletion(ledger?: OwnershipLedger): boolean {
  return ledger !== undefined && ledger.isDrainComplete() === false
}

function getStringProperty(value: unknown, property: string): string | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'string' ? descriptor.value : null
}

function getNumberProperty(value: unknown, property: string): number | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'number' ? descriptor.value : null
}

function getObjectProperty(value: unknown, property: string): unknown {
  if (value == null || typeof value !== 'object') return null
  return Object.getOwnPropertyDescriptor(value, property)?.value ?? null
}

export async function waitForAbortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve()

  return new Promise(resolve => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const finish = (): void => {
      if (timeout != null) clearTimeout(timeout)
      if (signal != null && onAbort != null) signal.removeEventListener('abort', onAbort)
      resolve()
    }

    timeout = setTimeout(finish, delayMs)
    if (signal != null) {
      onAbort = finish
      signal.addEventListener('abort', onAbort, {once: true})
    }
  })
}

async function withRequestTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const abortPromise =
      signal == null
        ? null
        : new Promise<T>((_, reject) => {
            onAbort = () => reject(new Error(`${label} aborted`))
            signal.addEventListener('abort', onAbort, {once: true})
          })
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
      ...(abortPromise == null ? [] : [abortPromise]),
    ])
  } finally {
    if (timeout != null) clearTimeout(timeout)
    if (signal != null && onAbort != null) signal.removeEventListener('abort', onAbort)
  }
}

async function runPollRequest<T>(
  operation: () => Promise<T>,
  label: string,
  signal: AbortSignal,
  deadline?: ExecutionDeadline,
): Promise<T> {
  const request = async () =>
    withRequestTimeout(
      operation(),
      Math.min(POLL_REQUEST_TIMEOUT_MS, deadline?.remainingMs() ?? POLL_REQUEST_TIMEOUT_MS),
      label,
      signal,
    )
  return deadline == null ? request() : deadline.run(request, label)
}

async function detectMessageActivity(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  activityTracker: ActivityTracker | undefined,
  logger: Logger,
  signal: AbortSignal,
  deadline?: ExecutionDeadline,
): Promise<AttemptObservation | null> {
  if (activityTracker?.baselineMessageIds == null) return null

  if (typeof client.session.messages !== 'function') {
    logger.debug('session.messages() unavailable; skipping message activity poll', {sessionId})
    return null
  }

  const messagesResponse = await runPollRequest(
    async () => client.session.messages({path: {id: sessionId}, query: {directory}, signal}),
    'session.messages()',
    signal,
    deadline,
  )
  const messages = Array.isArray(messagesResponse.data) ? messagesResponse.data : []
  let latestAssistantMessageInfo: unknown = null
  for (const message of messages) {
    const info = getObjectProperty(message, 'info')
    const id = getStringProperty(info, 'id')
    if (id == null || activityTracker.baselineMessageIds.has(id)) continue

    const role = getStringProperty(info, 'role')
    if (role !== 'assistant') continue

    latestAssistantMessageInfo = info
  }

  if (latestAssistantMessageInfo == null) return null

  activityTracker.firstMeaningfulEventReceived = true
  const latestAssistantMessageId = getStringProperty(latestAssistantMessageInfo, 'id')
  const completedAt = getNumberProperty(getObjectProperty(latestAssistantMessageInfo, 'time'), 'completed')

  if (latestAssistantMessageId == null || completedAt == null) {
    activityTracker.completedAssistantMessageId = undefined
    return null
  }

  // Confirm the same completed assistant remains the latest across two consecutive polls
  // before reporting completion — guards against the race where one agent loop step has
  // completed but the next step has not yet produced its in-progress assistant message.
  if (activityTracker.completedAssistantMessageId !== latestAssistantMessageId) {
    activityTracker.completedAssistantMessageId = latestAssistantMessageId
    logger.debug('Completed assistant message observed; waiting for confirmation poll', {
      sessionId,
      messageId: latestAssistantMessageId,
    })
    return null
  }

  activityTracker.currentTurnTerminalSignalReceived = true
  logger.debug('Session completion detected via stable completed assistant message', {
    sessionId,
    messageId: latestAssistantMessageId,
  })

  return completionObservation(activityTracker)
}

/**
 * Core implementation: each branch establishes its own settlement cause at the point it decides
 * to return, per the invariant in `attempt-outcome.ts`. `pollForSessionCompletion` (below) is a
 * thin `{completed, error}` adapter over this for callers not yet rewired to consume the cause.
 */
export async function pollForSessionCompletionObservation(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  signal: AbortSignal,
  logger: Logger,
  maxPollTimeMs: number = DEFAULT_TIMEOUT_MS,
  activityTracker?: ActivityTracker,
  deadline?: ExecutionDeadline,
  ownershipLedger?: OwnershipLedger,
): Promise<AttemptObservation> {
  const pollStart = Date.now()
  let errorGraceCycles = 0
  let firstSessionError: string | null = null

  while (!signal.aborted) {
    const terminalProviderError = activityTracker?.terminalProviderError
    if (terminalProviderError != null) {
      // Preserved producer policy: an already-accepted provider error wins here even if the
      // deadline has since expired (checked next) — this is a legitimate provider-terminal result
      // winning at the boundary, not a deadline conclusion. See attempt-outcome.ts module doc.
      return providerFailureObservation(terminalProviderError)
    }
    if (deadline?.isExpired() === true) return deadlineObservation(activityTracker)
    try {
      const delay = async () => {
        await waitForAbortableDelay(POLL_INTERVAL_MS, signal)
      }
      if (deadline == null) await delay()
      else await deadline.run(delay, 'poll interval')
    } catch {
      // waitForAbortableDelay() itself never rejects; deadline.run() rejects here exclusively via
      // deadline exhaustion. A terminal error already accepted still wins per the preserved policy.
      const terminalError = activityTracker?.terminalProviderError
      if (terminalError != null) return providerFailureObservation(terminalError)
      return deadlineObservation(activityTracker)
    }
    if (signal.aborted) {
      // `signal` may be a combined AbortSignal.any([..., deadline.signal]) (see retry.ts), so an
      // abort here can be deadline-caused as well as externally cancelled — ask the deadline
      // itself rather than assuming cancellation.
      const terminalError = activityTracker?.terminalProviderError
      if (terminalError != null) return providerFailureObservation(terminalError)
      if (deadline?.isExpired() === true) return deadlineObservation(activityTracker)
      return cancelledObservation(activityTracker)
    }

    const observedSessionError = activityTracker?.sessionError
    if (firstSessionError == null && observedSessionError != null) {
      firstSessionError = observedSessionError
    }
    const terminalError = activityTracker?.terminalProviderError
    if (terminalError != null) return providerFailureObservation(terminalError)
    const sessionError = firstSessionError

    if (sessionError == null) {
      errorGraceCycles = 0
    } else {
      errorGraceCycles++
      if (errorGraceCycles >= ERROR_GRACE_CYCLES) {
        logger.error('Session error persisted through grace period', {
          sessionId,
          error: sessionError,
          graceCycles: errorGraceCycles,
        })
        return sessionFailureObservation(`Session error: ${sessionError}`, activityTracker)
      }
      continue
    }

    if (activityTracker?.sessionIdle === true && activityTracker.currentTurnTerminalSignalReceived) {
      if (ledgerBlocksCompletion(ownershipLedger)) {
        logger.debug('Session idle detected via event stream but owned work outstanding — deferring completion', {
          sessionId,
          outstanding: ownershipLedger?.outstanding(),
        })
      } else if (deadline?.isExpired() === true) {
        // Checked at the completion decision itself, not re-derived later: a completion first
        // observed after the deadline is rejected, matching the deadline check every other branch
        // performs at its own return point.
        return deadlineObservation(activityTracker)
      } else {
        logger.debug('Session idle detected via event stream', {sessionId})
        return completionObservation(activityTracker)
      }
    }

    const elapsed = Date.now() - pollStart
    if (deadline == null && maxPollTimeMs > 0 && elapsed >= maxPollTimeMs) {
      logger.warning('Poll timeout reached', {elapsedMs: elapsed, maxPollTimeMs})
      return watchdogObservation(`Poll timeout after ${elapsed}ms`, activityTracker)
    }

    try {
      const messageResult = await detectMessageActivity(
        client,
        sessionId,
        directory,
        activityTracker,
        logger,
        signal,
        deadline,
      )
      if (messageResult != null) {
        if (ledgerBlocksCompletion(ownershipLedger)) {
          logger.debug(
            'Stable completed-assistant message observed but owned work outstanding — deferring completion',
            {sessionId, outstanding: ownershipLedger?.outstanding()},
          )
        } else if (deadline?.isExpired() === true) {
          // The completed-assistant message itself may have been produced (and its two-poll
          // stability confirmed, via the async session.messages() requests above) after the
          // deadline expired -- admission is checked here, at the decision, not inferred later.
          return deadlineObservation(activityTracker)
        } else {
          return messageResult
        }
      }

      const statusResponse = await runPollRequest(
        async () => client.session.status({query: {directory}, signal}),
        'session.status()',
        signal,
        deadline,
      )
      const statuses = statusResponse.data ?? {}
      const sessionStatus = statuses[sessionId]

      if (sessionStatus == null) {
        logger.debug('Session status not found in poll response', {sessionId})
      } else if (sessionStatus.type === 'idle') {
        if (activityTracker != null && activityTracker.currentTurnTerminalSignalReceived !== true) {
          logger.debug('Session idle detected before terminal signal; continuing watchdog', {sessionId})
        } else if (ledgerBlocksCompletion(ownershipLedger)) {
          logger.debug('Session idle detected via polling but owned work outstanding — deferring completion', {
            sessionId,
            outstanding: ownershipLedger?.outstanding(),
          })
        } else if (deadline?.isExpired() === true) {
          // The idle status itself was fetched via an async session.status() request (above) that
          // may have crossed the deadline -- checked here, at admission, not re-derived later.
          return deadlineObservation(activityTracker)
        } else {
          logger.debug('Session idle detected via polling', {sessionId})
          return completionObservation(activityTracker)
        }
      } else if (sessionStatus.type === 'retry') {
        // Poll-only terminal provider signals fail fast instead of waiting out the full timeout.
        const terminalError = classifyRetryStatusError(sessionStatus)
        if (terminalError != null) {
          if (deadline?.isExpired() === true && activityTracker?.terminalProviderError == null)
            return deadlineObservation(activityTracker)
          logger.error('Session status retry classified as terminal provider error via poll', {
            sessionId,
            type: sessionStatus.type,
          })
          if (activityTracker != null) {
            mergeActivityError(null, terminalError, activityTracker)
          }
          return providerFailureObservation(activityTracker?.terminalProviderError ?? terminalError)
        }
        logger.debug('Session status', {sessionId, type: sessionStatus.type})
      } else {
        logger.debug('Session status', {sessionId, type: sessionStatus.type})
      }

      if (activityTracker != null && !activityTracker.firstMeaningfulEventReceived) {
        const activityElapsed = Date.now() - pollStart
        if (activityElapsed >= INITIAL_ACTIVITY_TIMEOUT_MS) {
          logger.error('No agent activity detected — server may have crashed during prompt processing', {
            elapsedMs: activityElapsed,
            sessionId,
          })
          return watchdogObservation(
            `No agent activity detected after ${activityElapsed}ms — server may have crashed during prompt processing`,
            activityTracker,
          )
        }
      }
    } catch (pollError) {
      logger.debug('Poll request failed', {error: toErrorMessage(pollError)})
    }
  }

  // Loop exited because `signal` was already aborted at the top-of-loop check — same
  // deadline-vs-cancellation distinction as the mid-loop abort check above.
  const terminalError = activityTracker?.terminalProviderError
  if (terminalError != null) return providerFailureObservation(terminalError)
  if (deadline?.isExpired() === true) return deadlineObservation(activityTracker)
  return cancelledObservation(activityTracker)
}

export async function pollForSessionCompletion(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  signal: AbortSignal,
  logger: Logger,
  maxPollTimeMs: number = DEFAULT_TIMEOUT_MS,
  activityTracker?: ActivityTracker,
  deadline?: ExecutionDeadline,
  ownershipLedger?: OwnershipLedger,
): Promise<PollResult> {
  const observation = await pollForSessionCompletionObservation(
    client,
    sessionId,
    directory,
    signal,
    logger,
    maxPollTimeMs,
    activityTracker,
    deadline,
    ownershipLedger,
  )
  return toPollResult(observation)
}

export async function waitForEventProcessorShutdown(
  eventProcessor: Promise<void>,
  timeoutMs: number = EVENT_PROCESSOR_SHUTDOWN_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) return
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const abortPromise =
    signal == null
      ? null
      : new Promise<void>(resolve => {
          onAbort = () => resolve()
          signal.addEventListener('abort', onAbort, {once: true})
        })
  try {
    await Promise.race([
      eventProcessor,
      new Promise<void>(resolve => {
        timeoutId = setTimeout(resolve, timeoutMs)
      }),
      ...(abortPromise == null ? [] : [abortPromise]),
    ])
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId)
    if (signal != null && onAbort != null) signal.removeEventListener('abort', onAbort)
  }
}
