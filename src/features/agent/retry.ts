import type {OwnershipLedger} from '@fro-bot/runtime'
import type {createOpencode, Event} from '@opencode-ai/sdk'
import type {createOpencodeClient} from '@opencode-ai/sdk/v2'
import type {Logger} from '../../shared/logger.js'
import type {AttemptObservation, FailureObservation, TurnEvidence} from './attempt-outcome.js'
import type {AttemptResult} from './prompt-sender.js'
import type {ActivityTracker, EventStreamResult, PermissionAskedResponder} from './streaming.js'
import {toErrorMessage} from '../../shared/errors.js'
import {reduceAttemptOutcome} from './attempt-outcome.js'
import {
  ledgerBlocksCompletion,
  pollForSessionCompletionObservation,
  waitForAbortableDelay,
  waitForEventProcessorShutdown,
} from './session-poll.js'
import {detectArtifactsFromMessageParts, getObservedFailure, processEventStream} from './streaming.js'

export type PromptStartResult = AttemptResult | null
export type PromptStarter = () => Promise<PromptStartResult>

export function createDeadlineExceededError(label: string): Error {
  const error = new Error(`${label} exceeded the execution deadline`)
  error.name = 'DeadlineExceededError'
  return error
}

export interface ExecutionDeadline {
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly isExpired: () => boolean
  readonly isTimedOut: () => boolean
  readonly remainingMs: () => number
  readonly run: <T>(operation: () => Promise<T>, label: string) => Promise<T>
  readonly dispose: () => void
}

export function createExecutionDeadline(timeoutMs: number, logger: Logger): ExecutionDeadline {
  const controller = new AbortController()
  const deadlineAt = timeoutMs > 0 ? Date.now() + timeoutMs : null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  const latchTimeout = (): void => {
    if (timedOut) return
    timedOut = true
    logger.warning('Execution timeout reached', {timeoutMs})
    controller.abort()
  }

  const isExpired = (): boolean => {
    if (timedOut) return true
    if (deadlineAt != null && Date.now() >= deadlineAt) {
      latchTimeout()
      return true
    }
    return false
  }

  const remainingMs = (): number => {
    if (deadlineAt == null) return Number.POSITIVE_INFINITY
    const remaining = Math.max(0, deadlineAt - Date.now())
    if (remaining === 0) latchTimeout()
    return remaining
  }

  // Races the operation against the deadline with an explicitly tagged outcome, and preserves
  // whichever actually won -- never reinterprets the winner by rereading the clock afterwards.
  // `isExpired()`/`isTimedOut()` remain valid only for admission (before starting work) and for
  // completion-admission decisions made by callers; they are never consulted here to explain a
  // race that has already settled. See createExecutionDeadline's docs for the invariant this
  // upholds: selecting an error never proves quiescence, and observing quiescence never erases
  // an error.
  type RunRaceResult<T> =
    | {readonly source: 'operation'; readonly success: true; readonly value: T}
    | {readonly source: 'operation'; readonly success: false; readonly error: unknown}
    | {readonly source: 'deadline'}

  const run = async <T>(operation: () => Promise<T>, label: string): Promise<T> => {
    // Admission decision: valid to consult the clock here, before any work has started.
    if (isExpired()) throw createDeadlineExceededError(label)
    if (deadlineAt == null) return operation()

    let onAbort: (() => void) | null = null
    const deadlineOutcome = new Promise<RunRaceResult<T>>(resolve => {
      onAbort = (): void => resolve({source: 'deadline'})
      controller.signal.addEventListener('abort', onAbort, {once: true})
    })

    const operationOutcome: Promise<RunRaceResult<T>> = Promise.resolve()
      .then(operation)
      .then(
        (value): RunRaceResult<T> => ({source: 'operation', success: true, value}),
        (error: unknown): RunRaceResult<T> => ({source: 'operation', success: false, error}),
      )

    try {
      // Whichever settles first genuinely won -- no post-race clock recheck, no rewriting the
      // operation's own outcome based on state that changed after the race was already decided.
      const winner = await Promise.race([operationOutcome, deadlineOutcome])
      if (winner.source === 'deadline') throw createDeadlineExceededError(label)
      if (winner.success) return winner.value
      throw winner.error
    } finally {
      if (onAbort != null) controller.signal.removeEventListener('abort', onAbort)
    }
  }

  if (deadlineAt != null) timeoutId = setTimeout(latchTimeout, timeoutMs)

  return {
    timeoutMs,
    signal: controller.signal,
    isExpired,
    isTimedOut: () => timedOut,
    remainingMs,
    run,
    dispose: () => {
      if (timeoutId != null) clearTimeout(timeoutId)
    },
  }
}

function getMessageID(value: unknown): string | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, 'id')
  return typeof descriptor?.value === 'string' ? descriptor.value : null
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

const BASELINE_MESSAGES_TIMEOUT_MS = 5_000

function appendUniqueStrings(existing: readonly string[], additions: readonly string[]): string[] {
  return [...existing, ...additions.filter(value => !existing.includes(value))]
}

async function withTimeout<T>(
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

async function listSessionMessageIds(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  logger: Logger,
  deadline?: ExecutionDeadline,
): Promise<ReadonlySet<string> | null> {
  if (typeof client.session.messages !== 'function') return null

  try {
    const request = async () =>
      withTimeout(
        client.session.messages({path: {id: sessionId}, query: {directory}, signal: deadline?.signal}),
        Math.min(BASELINE_MESSAGES_TIMEOUT_MS, deadline?.remainingMs() ?? BASELINE_MESSAGES_TIMEOUT_MS),
        'baseline session.messages()',
        deadline?.signal,
      )
    const response = deadline == null ? await request() : await deadline.run(request, 'baseline session.messages()')
    const messages = Array.isArray(response.data) ? response.data : []
    return new Set(messages.flatMap(message => getMessageID(getObjectProperty(message, 'info')) ?? []))
  } catch (error) {
    logger.debug('Unable to read baseline session messages; disabling message activity fallback', {
      sessionId,
      error: toErrorMessage(error),
    })
    return null
  }
}

async function readCompletedAssistantMessageParts(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  baselineMessageIds: ReadonlySet<string> | undefined,
  logger: Logger,
  deadline?: ExecutionDeadline,
): Promise<readonly unknown[] | null> {
  if (baselineMessageIds == null || typeof client.session.messages !== 'function') return null

  try {
    const request = async () =>
      withTimeout(
        client.session.messages({path: {id: sessionId}, query: {directory}, signal: deadline?.signal}),
        Math.min(BASELINE_MESSAGES_TIMEOUT_MS, deadline?.remainingMs() ?? BASELINE_MESSAGES_TIMEOUT_MS),
        'completed assistant session.messages()',
        deadline?.signal,
      )
    const response =
      deadline == null ? await request() : await deadline.run(request, 'completed assistant session.messages()')
    const messages = Array.isArray(response.data) ? response.data : []
    let latestCompletedAssistantMessage: unknown = null
    let latestCreatedAt = Number.NEGATIVE_INFINITY

    for (const message of messages) {
      const info = getObjectProperty(message, 'info')
      const id = getStringProperty(info, 'id')
      if (id == null || baselineMessageIds.has(id)) continue
      if (getStringProperty(info, 'role') !== 'assistant') continue

      const time = getObjectProperty(info, 'time')
      if (getNumberProperty(time, 'completed') == null) continue

      const createdAt = getNumberProperty(time, 'created') ?? 0
      if (latestCompletedAssistantMessage == null || createdAt >= latestCreatedAt) {
        latestCompletedAssistantMessage = message
        latestCreatedAt = createdAt
      }
    }

    if (latestCompletedAssistantMessage != null) {
      const parts = getObjectProperty(latestCompletedAssistantMessage, 'parts')
      if (Array.isArray(parts)) return Array.from(parts, (part: unknown): unknown => part)
    }
    return null
  } catch (error) {
    logger.debug('Unable to read completed assistant message parts', {sessionId, error: toErrorMessage(error)})
    return null
  }
}

export function mergeArtifactResults(
  eventStreamResult: EventStreamResult,
  fallback: Pick<EventStreamResult, 'prsCreated' | 'commitsCreated' | 'commentsPostedUrls' | 'commentsPosted'>,
): EventStreamResult {
  const commentsPostedUrls = appendUniqueStrings(
    eventStreamResult.commentsPostedUrls ?? [],
    fallback.commentsPostedUrls ?? [],
  )

  return {
    ...eventStreamResult,
    prsCreated: appendUniqueStrings(eventStreamResult.prsCreated, fallback.prsCreated),
    commitsCreated: appendUniqueStrings(eventStreamResult.commitsCreated, fallback.commitsCreated),
    commentsPostedUrls,
    commentsPosted:
      commentsPostedUrls.length > 0
        ? commentsPostedUrls.length
        : Math.max(eventStreamResult.commentsPosted, fallback.commentsPosted),
  }
}

export const MAX_LLM_RETRIES = 4
export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const

// `shouldRetryFromOutcome` now lives in attempt-outcome.ts, beside `reduceAttemptOutcome` which
// needs it internally -- see that module for the definition. Re-exported here because
// prompt-sender.ts already depends on retry.ts at runtime for `runPromptAttempt`, and that
// existing value edge is the direction to extend, not a fresh one back into attempt-outcome.ts
// (see docs/solutions/best-practices/extract-shared-helpers-toward-the-value-dependency-2026-08-08.md).
export {shouldRetryFromOutcome} from './attempt-outcome.js'

/**
 * Create a v2 client attached to an existing OpenCode server URL.
 * Returns null if the import fails (older SDK) or no URL is provided.
 * Does NOT start a new server — only attaches to the existing one.
 */
async function tryCreateV2Client(
  serverUrl: string | null | undefined,
): Promise<ReturnType<typeof createOpencodeClient> | null> {
  if (serverUrl == null) return null
  try {
    const {createOpencodeClient: create} = await import('@opencode-ai/sdk/v2')
    return create({baseUrl: serverUrl})
  } catch {
    return null
  }
}

/**
 * Calls v2.session.wait() on an existing server; non-blocking, runs alongside
 * pollForSessionCompletionObservation(). SDK unavailability, wait API errors, and missing terminal
 * evidence are all a `fallback-to-poll` tag, never an execution failure in their own right — only
 * the poll watchdog's own observation (or a provider failure this function itself confirms) may
 * report a settlement cause. Distinguished from `AttemptObservation` by the absence of a
 * `settlement` key (see the `'settlement' in outcome` check at the call site).
 */
type V2WaitObservation = {readonly kind: 'fallback-to-poll'} | AttemptObservation

async function startV2SessionWait(
  serverUrl: string | null | undefined,
  sessionId: string,
  activityTracker: ActivityTracker,
  logger: Logger,
  signal: AbortSignal,
  deadline?: ExecutionDeadline,
  ownershipLedger?: OwnershipLedger,
): Promise<V2WaitObservation> {
  const v2Client =
    deadline == null
      ? await tryCreateV2Client(serverUrl)
      : await deadline.run(async () => tryCreateV2Client(serverUrl), 'v2 client creation')
  if (v2Client == null) return {kind: 'fallback-to-poll'}

  try {
    const response =
      deadline == null
        ? await v2Client.v2.session.wait({sessionID: sessionId}, {signal})
        : await deadline.run(async () => v2Client.v2.session.wait({sessionID: sessionId}, {signal}), 'v2 session wait')
    if (response.error != null) {
      logger.debug('v2.session.wait() returned error, relying on poll watchdog', {
        sessionId,
        error: String(response.error),
      })
      return {kind: 'fallback-to-poll'}
    }
    // Only accept wait() as completion once the terminal signal is observed; poll briefly to
    // absorb the async gap between wait() resolving and the event processor catching up.
    const TERMINAL_GRACE_MS = 500
    const TERMINAL_POLL_INTERVAL_MS = 10
    const terminalDeadline = Date.now() + TERMINAL_GRACE_MS
    while (
      activityTracker.currentTurnTerminalSignalReceived !== true &&
      Date.now() < terminalDeadline &&
      signal.aborted !== true
    ) {
      const delay = async () => {
        await waitForAbortableDelay(TERMINAL_POLL_INTERVAL_MS, signal)
      }
      if (deadline == null) await delay()
      else await deadline.run(delay, 'v2 terminal grace wait')
    }
    if (activityTracker.currentTurnTerminalSignalReceived !== true) {
      logger.debug('v2.session.wait() resolved without terminal signal — deferring to poll watchdog', {sessionId})
      return {kind: 'fallback-to-poll'}
    }
    // Terminal provider errors must never be reported as wait() success: a failure observation
    // dominates regardless of the terminal signal wait() itself observed.
    if (activityTracker.terminalProviderError != null) {
      logger.debug('v2.session.wait() resolved after terminal provider error — reporting failure, not success', {
        sessionId,
      })
      const terminalError = activityTracker.terminalProviderError
      const failure: FailureObservation = {source: 'provider', message: terminalError.message, llmError: terminalError}
      return {settlement: {kind: 'failure-observed'}, failures: [failure]}
    }
    if (ledgerBlocksCompletion(ownershipLedger)) {
      logger.debug(
        'v2.session.wait() resolved with terminal signal but owned work outstanding — deferring to poll watchdog',
        {
          sessionId,
          outstanding: ownershipLedger?.outstanding(),
        },
      )
      return {kind: 'fallback-to-poll'}
    }
    logger.debug('v2.session.wait() resolved with terminal signal — session is done', {sessionId})
    // Completion is evidence about stopping, not a waiver of an already-observed error: a generic
    // (non-terminal) session failure recorded on the tracker rides along in this observation's
    // snapshot rather than being silently dropped by a bare completion report.
    const observedFailure = getObservedFailure(activityTracker)
    const failures: FailureObservation[] =
      observedFailure == null
        ? []
        : [
            {
              source: 'session',
              message: observedFailure.error.message,
              llmError: observedFailure.error,
              classificationPath: observedFailure.classificationPath,
            },
          ]
    return {settlement: {kind: 'completion-observed'}, failures}
  } catch (error) {
    logger.debug('v2.session.wait() threw, relying on poll watchdog', {sessionId, error: toErrorMessage(error)})
    return {kind: 'fallback-to-poll'}
  }
}

export async function runPromptAttempt(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  timeoutMs: number,
  logger: Logger,
  eventStream?: AsyncIterable<Event>,
  serverUrl?: string | null,
  startPrompt?: PromptStarter,
  deadline?: ExecutionDeadline,
  attemptAbortController?: AbortController,
  onPermissionAsked?: PermissionAskedResponder,
  ownershipLedger?: OwnershipLedger,
): Promise<AttemptResult> {
  const attemptController = attemptAbortController ?? new AbortController()
  const eventAbortController = new AbortController()
  const waitAbortController = new AbortController()
  const eventSignal =
    deadline == null ? eventAbortController.signal : AbortSignal.any([eventAbortController.signal, deadline.signal])
  const waitSignal =
    deadline == null ? waitAbortController.signal : AbortSignal.any([waitAbortController.signal, deadline.signal])
  const activityTracker: ActivityTracker = {
    firstMeaningfulEventReceived: false,
    currentTurnTerminalSignalReceived: false,
    currentTurnArmed: startPrompt == null,
    baselineMessageIds: undefined,
    sessionIdle: false,
    sessionError: null,
  }

  const subscriptionSignal =
    deadline == null ? attemptController.signal : AbortSignal.any([attemptController.signal, deadline.signal])
  const subscribe = async () => client.event.subscribe({signal: subscriptionSignal})
  const events =
    eventStream ??
    (deadline == null ? (await subscribe()).stream : (await deadline.run(subscribe, 'event subscription')).stream)

  let eventStreamResult: EventStreamResult = {
    tokens: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
  }

  const eventProcessor = processEventStream(
    events,
    sessionId,
    eventSignal,
    logger,
    activityTracker,
    deadline,
    onPermissionAsked,
    ownershipLedger,
  )
    .then(result => {
      eventStreamResult = result
    })
    .catch(error => {
      if (error instanceof Error && error.name !== 'AbortError') {
        logger.debug('Event stream error', {error: error.message})
      }
    })

  let eventProcessorShutdown: Promise<void> | null = null
  const stopEventProcessor = async (): Promise<void> => {
    if (eventProcessorShutdown != null) return eventProcessorShutdown
    attemptController.abort()
    waitAbortController.abort()
    eventAbortController.abort()
    eventProcessorShutdown = waitForEventProcessorShutdown(eventProcessor)
    return eventProcessorShutdown
  }

  const collectEventResults = async () => {
    await stopEventProcessor()
  }

  // Set only when the ledger defers a *failed* promptStartResult past the early exit below, as a
  // `FailureObservation` snapshot rather than a whole `AttemptResult` -- it participates in the
  // single post-race reduction (below) as the lowest-precedence input, exactly like any other
  // preserved submission failure. A successful promptStartResult never populates this -- the
  // ledger gate exists precisely so a successful turn does not end the run while owned work is
  // live, and that behavior must stay untouched.
  let preservedSubmissionFailure: FailureObservation | null = null

  try {
    // Ensure the lazy SDK SSE stream begins connecting before prompt submission. Without this,
    // event.subscribe().stream is only consumed after promptAsync returns, so early current-turn
    // events can be missed while the agent is already working.
    await Promise.resolve()
    if (startPrompt != null) {
      activityTracker.baselineMessageIds =
        (await listSessionMessageIds(client, sessionId, directory, logger, deadline)) ?? undefined
      activityTracker.currentTurnArmed = true
      const promptStartResult =
        deadline == null ? await startPrompt() : await deadline.run(startPrompt, 'prompt submission')
      if (promptStartResult != null) {
        if (ledgerBlocksCompletion(ownershipLedger)) {
          // Owned work is still outstanding: decline to resolve through this early exit and fall
          // through to the watchdog below instead — the event processor stays running (no
          // stopEventProcessor() call here) and the same gated poll/wait race decides completion.
          // A failed promptStartResult must not be discarded here: save it so the eventual
          // AttemptResult still reports the failure instead of a watchdog-observed false success.
          if (promptStartResult.success === false) {
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
          await collectEventResults()
          // A submission failure only ever reaches here as `promptStartResult.success === false`
          // in production (see sendPromptToSession's createSubmissionFailure); a success passes
          // through unchanged since there is nothing to reduce. For a failure, route it through
          // the single reducer instead of gating on activity: `TurnEvidence.accepted` describes
          // whether the turn was accepted, not whether captured failure evidence is worth
          // considering -- a provider or session failure already recorded on the tracker (e.g. an
          // auth/quota/context-overflow `session.error`) must still outrank the submission failure
          // per `reduceAttemptOutcome`'s precedence rules even when no activity was ever observed.
          if (promptStartResult.success === false) {
            const failures: FailureObservation[] = []
            if (activityTracker.terminalProviderError == null) {
              const observedFailure = getObservedFailure(activityTracker)
              if (observedFailure != null) {
                failures.push({
                  source: 'session',
                  message: observedFailure.error.message,
                  llmError: observedFailure.error,
                  classificationPath: observedFailure.classificationPath,
                })
              }
            } else {
              failures.push({
                source: 'provider',
                message: activityTracker.terminalProviderError.message,
                llmError: activityTracker.terminalProviderError,
              })
            }
            failures.push({
              source: 'submission',
              message: promptStartResult.error ?? 'Prompt submission failed',
              llmError: promptStartResult.llmError,
            })
            const turnEvidence: TurnEvidence = {accepted: activityTracker.firstMeaningfulEventReceived === true}
            const reduced = reduceAttemptOutcome({settlement: {kind: 'failure-observed'}, failures}, null, turnEvidence)
            // Base on the SSE-observed `eventStreamResult` only once the turn was actually accepted
            // -- that is where any real tokens/cost/artifacts accumulated. Otherwise nothing ever
            // reached the remote, so `promptStartResult`'s own (synthetic) `eventStreamResult` is
            // the accurate one, and it also already carries the submission failure's own
            // `classificationPath` -- discarding it here would silently drop that field even when
            // the submission failure is still what won.
            let mergedEventStreamResult = turnEvidence.accepted
              ? eventStreamResult
              : promptStartResult.eventStreamResult
            if (reduced.llmError != null && mergedEventStreamResult.llmError?.type !== reduced.llmError.type) {
              mergedEventStreamResult = {
                ...mergedEventStreamResult,
                llmError: reduced.llmError,
                classificationPath: reduced.classificationPath ?? mergedEventStreamResult.classificationPath,
              }
            }
            return {
              success: reduced.success,
              error: reduced.error,
              llmError: reduced.llmError,
              outcome: reduced.outcome,
              shouldRetry: reduced.shouldRetry,
              settlement: reduced.settlement,
              eventStreamResult: mergedEventStreamResult,
            }
          }
          return promptStartResult
        }
      }
    }

    // Watchdog: enforces no-activity timeout and fallback completion detection; runs in parallel.
    const pollObservationPromise = pollForSessionCompletionObservation(
      client,
      sessionId,
      directory,
      eventSignal,
      logger,
      timeoutMs,
      activityTracker,
      deadline,
      ownershipLedger,
    )

    // Authoritative completion signal when available; falls back to the poller otherwise.
    const waitObservationPromise = startV2SessionWait(
      serverUrl,
      sessionId,
      activityTracker,
      logger,
      waitSignal,
      deadline,
      ownershipLedger,
    )

    // Race: an authoritative wait() observation wins outright; a `fallback-to-poll` tag defers to
    // the poll observation instead. Whichever settles first is retained unchanged below -- no
    // post-race clock recheck ever second-guesses it. This is the one race in this function whose
    // winner decides the settlement cause; `collectEventResults()`'s bounded cleanup (next) can
    // enrich artifacts and usage afterward, but it can never reopen this decision.
    const winningObservation: AttemptObservation = await Promise.race([
      waitObservationPromise.then(async outcome => ('settlement' in outcome ? outcome : pollObservationPromise)),
      pollObservationPromise,
    ])

    await collectEventResults()

    // Single reduction point: every settlement cause (completion, failure, deadline, cancelled,
    // watchdog) and every failure source (provider, session, preserved submission) funnels through
    // here exactly once. `accepted` is read after cleanup deliberately -- it is evidence about
    // whether the remote turn ever started, used only to classify a submission failure as
    // `submit_failed` vs `turn_failed_*`, not part of the settled cause/error selection the
    // invariant above protects.
    const turnEvidence: TurnEvidence = {accepted: activityTracker.firstMeaningfulEventReceived === true}
    const reduced = reduceAttemptOutcome(winningObservation, preservedSubmissionFailure, turnEvidence)

    // Carry the winning failure's classified error into the authoritative event-stream result when
    // the SSE-observed one (if any) disagrees -- generalizes the old provider-only merge to any
    // winning failure source, since the reducer may now select a session- or submission-sourced
    // failure just as legitimately as a provider one.
    let mergedEventStreamResult = eventStreamResult
    if (reduced.llmError != null && eventStreamResult.llmError?.type !== reduced.llmError.type) {
      mergedEventStreamResult = {...eventStreamResult, llmError: reduced.llmError}
    }

    if (!reduced.success) {
      return {
        success: false,
        error: reduced.error,
        llmError: reduced.llmError,
        outcome: reduced.outcome,
        shouldRetry: reduced.shouldRetry,
        settlement: reduced.settlement,
        eventStreamResult: mergedEventStreamResult,
      }
    }

    // Post-idle artifact reconciliation: one-shot read of the completed assistant message.
    const fallbackMessageParts = await readCompletedAssistantMessageParts(
      client,
      sessionId,
      directory,
      activityTracker.baselineMessageIds,
      logger,
      deadline,
    )

    if (fallbackMessageParts != null) {
      const fallback = detectArtifactsFromMessageParts(fallbackMessageParts, logger)
      const merged = mergeArtifactResults(mergedEventStreamResult, fallback)
      return {
        success: true,
        error: null,
        llmError: null,
        outcome: reduced.outcome,
        shouldRetry: reduced.shouldRetry,
        settlement: reduced.settlement,
        eventStreamResult: merged,
      }
    }

    return {
      success: true,
      error: null,
      llmError: null,
      outcome: reduced.outcome,
      shouldRetry: reduced.shouldRetry,
      settlement: reduced.settlement,
      eventStreamResult: mergedEventStreamResult,
    }
  } finally {
    await stopEventProcessor()
  }
}
