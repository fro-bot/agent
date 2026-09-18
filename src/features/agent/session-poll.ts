import type {ClassificationPath, ErrorInfo, OwnershipLedger} from '@fro-bot/runtime'
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
import {
  classifyContextOverflowError,
  classifyProviderAuthError,
  classifyQuotaError,
  createAgentError,
  createErrorInfo,
  createLLMFetchError,
  createRetryableApiError,
  isLlmFetchError,
} from '@fro-bot/runtime'
import {DEFAULT_TIMEOUT_MS} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'
import {
  classifyRetryStatusError,
  clearRootRevalidationRequirement,
  getObservedFailure,
  hasFreshIdleCandidate,
  invalidateRootFreshness,
  mergeActivityError,
  normalizeSessionError,
  resolvePendingRootUserMessage,
} from './streaming.js'

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
export interface PollResult {
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
 * Precedence-ordered failure pick for the adapter, mirroring `selectWinningFailure` in
 * attempt-outcome.ts (provider beats session beats anything else). The constructors in this file
 * only ever snapshot a single failure, so in practice this degrades to `failures[0]` for real
 * call sites -- the explicit ordering exists so a `completion-observed` settlement carrying a
 * failure (a request in flight when the failure landed) is judged by the same rule a
 * `failure-observed` settlement would be, not by array position.
 */
function selectAdapterFailure(failures: readonly FailureObservation[]): FailureObservation | null {
  const providerFailure = failures.find(failure => failure.source === 'provider')
  if (providerFailure != null) return providerFailure

  const sessionFailure = failures.find(failure => failure.source === 'session')
  if (sessionFailure != null) return sessionFailure

  return failures[0] ?? null
}

/**
 * Adapter preserving the pre-existing `{completed, error}` shape for callers that have not been
 * rewired to consume `AttemptObservation` yet (`retry.ts`'s `pollResult.completed`/`.error`, and
 * characterization tests asserting exact `{completed, error}` equality). Diagnostic text is
 * unchanged from what each branch returned before this step.
 *
 * The failure snapshot is considered before the settlement cause: a `completion-observed`
 * settlement whose snapshot carries a failure (evidence recorded while a request was still in
 * flight) is not a legacy success -- it projects the same way a `failure-observed` settlement
 * would, via `selectAdapterFailure`'s provider-over-session precedence. The settlement itself is
 * untouched; only this legacy projection changes.
 */
export function toPollResult(observation: AttemptObservation): PollResult {
  const failure = selectAdapterFailure(observation.failures)
  if (failure != null) return {completed: false, error: failure.message}

  if (observation.settlement.kind === 'completion-observed') return {completed: true, error: null}

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

function getBooleanProperty(value: unknown, property: string): boolean | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'boolean' ? descriptor.value : null
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

/**
 * Classifies an assistant message's own `error` field through the same bounded provider/generic
 * precedence the SSE `session.error` branch uses (`streaming.ts`'s `mergeActivityError` callers) --
 * an assistant carrying an error is failure evidence, never a clean completion candidate, and must
 * not be dropped into a generic timeout. Deliberately self-contained rather than reusing that
 * branch inline: the SSE branch also owns `continue`-based deadline handling scoped to its own
 * event loop, which does not translate to this poll-driven call site. A shared extraction of just
 * the classification precedence (not the loop control) is a reasonable follow-up.
 */
function classifyAssistantMessageError(
  messageError: unknown,
  model: string | null,
): {readonly error: ErrorInfo; readonly classificationPath: ClassificationPath} {
  const errorData = getObjectProperty(messageError, 'data')
  const status =
    getNumberProperty(messageError, 'status') ??
    getNumberProperty(messageError, 'statusCode') ??
    getNumberProperty(errorData, 'status') ??
    getNumberProperty(errorData, 'statusCode')
  const code = getStringProperty(messageError, 'code') ?? getStringProperty(errorData, 'code')
  const name = getStringProperty(messageError, 'name') ?? getStringProperty(errorData, 'name')

  const terminalError =
    classifyProviderAuthError({kind: 'session-error', name}) ??
    classifyContextOverflowError({kind: 'session-error', name}) ??
    classifyQuotaError({kind: 'session-error', status: status ?? undefined, code: code ?? undefined})
  if (terminalError != null) return {error: terminalError, classificationPath: 'structured'}

  const errorStr = normalizeSessionError(messageError)
  if (isLlmFetchError(errorStr))
    return {error: createLLMFetchError(errorStr, model ?? undefined), classificationPath: 'fallback'}
  if (status === 429) return {error: createErrorInfo('rate_limit', errorStr, true), classificationPath: 'name'}

  const isRetryable = getBooleanProperty(messageError, 'isRetryable') ?? getBooleanProperty(errorData, 'isRetryable')
  if (isRetryable === true)
    return {error: createRetryableApiError(errorStr, model ?? undefined), classificationPath: 'structured'}
  if (isRetryable === false) return {error: createAgentError(errorStr), classificationPath: 'structured'}

  return {
    error: createAgentError(errorStr),
    classificationPath: name != null || status != null || code != null ? 'name' : 'unclassified',
  }
}

/** A qualified, not-yet-admitted completion candidate -- see `detectMessageActivity`'s doc comment. */
interface MessageCompletionCandidate {
  readonly messageId: string
  /**
   * The root-freshness revision this candidate was validated against, captured at the moment it
   * qualified (not at request start) -- null when no tracker is present. The caller must re-check
   * this against the CURRENT revision at final admission: the candidate and the later
   * `session.status()` response are two separate observations, each capable of racing renewed
   * root activity independently, so each needs its own generation checked.
   */
  readonly revision: number | null
}

/**
 * Locates the latest new (post-baseline) assistant message and validates it against the
 * qualified-tuple predicate: new relative to the attempt baseline; answers the latest known root
 * user message with no newer unanswered one (the pending-parent barrier); `time.completed`
 * present; `finish` present and not `tool-calls`/`unknown`; no non-provider-executed tool call left
 * pending/running (a continuation the upstream prompt loop would still run another iteration for);
 * and no renewed root activity since the request was issued (revision check). Confirms the same
 * qualified candidate remains latest across two consecutive polls before returning it.
 *
 * Returns a CANDIDATE, not a settlement, and never mutates `currentTurnTerminalSignalReceived` --
 * the caller (`pollForSessionCompletionObservation`) still validates it against live `session.status()`
 * and the ownership ledger before admitting a completion, exactly like every other completion path
 * in that function. An assistant carrying its own `error` field is failure evidence and is returned
 * as an `AttemptObservation` failure settlement directly (never eligible to become a candidate, and
 * never silently dropped into a generic timeout).
 */
async function detectMessageActivity(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  activityTracker: ActivityTracker | undefined,
  logger: Logger,
  signal: AbortSignal,
  deadline?: ExecutionDeadline,
): Promise<MessageCompletionCandidate | AttemptObservation | null> {
  if (activityTracker?.baselineMessageIds == null) return null

  if (typeof client.session.messages !== 'function') {
    logger.debug('session.messages() unavailable; skipping message activity poll', {sessionId})
    return null
  }

  const rootFreshness = activityTracker.rootFreshness
  // Captured before the request: renewed root activity observed while this request was in
  // flight must invalidate whatever the response describes, not just what happens afterward.
  const requestRevision = rootFreshness?.revision

  const messagesResponse = await runPollRequest(
    async () => client.session.messages({path: {id: sessionId}, query: {directory}, signal}),
    'session.messages()',
    signal,
    deadline,
  )
  const messages = Array.isArray(messagesResponse.data) ? messagesResponse.data : []
  let latestAssistantMessage: unknown = null
  let latestAssistantMessageInfo: unknown = null
  for (const message of messages) {
    const info = getObjectProperty(message, 'info')
    const id = getStringProperty(info, 'id')
    if (id == null || activityTracker.baselineMessageIds.has(id)) continue

    const role = getStringProperty(info, 'role')
    if (role !== 'assistant') continue

    latestAssistantMessage = message
    latestAssistantMessageInfo = info
  }

  if (latestAssistantMessageInfo == null) return null

  activityTracker.firstMeaningfulEventReceived = true
  const latestAssistantMessageId = getStringProperty(latestAssistantMessageInfo, 'id')
  if (latestAssistantMessageId == null) {
    activityTracker.completedAssistantMessageId = undefined
    return null
  }

  // An assistant carrying an error is failure evidence, never a clean candidate -- classified
  // through the same bounded precedence as SSE `session.error`, so it settles as a failure
  // instead of silently falling through to a generic timeout.
  const messageError = getObjectProperty(latestAssistantMessageInfo, 'error')
  if (messageError != null) {
    activityTracker.completedAssistantMessageId = undefined
    const model = getStringProperty(latestAssistantMessageInfo, 'modelID')
    const classified = classifyAssistantMessageError(messageError, model)
    logger.error('Completed assistant message carries an error — classified as failure evidence', {
      sessionId,
      messageId: latestAssistantMessageId,
      type: classified.error.type,
    })
    const existing = getObservedFailure(activityTracker)?.error ?? null
    const merged = mergeActivityError(
      existing,
      classified.error,
      activityTracker,
      classified.error.message,
      classified.classificationPath,
    )
    const failure: FailureObservation = {
      source: 'session',
      message: merged.message,
      llmError: merged,
      classificationPath: activityTracker.classificationPath,
    }
    return {settlement: {kind: 'failure-observed'}, failures: [failure]}
  }

  const completedAt = getNumberProperty(getObjectProperty(latestAssistantMessageInfo, 'time'), 'completed')
  if (completedAt == null) {
    activityTracker.completedAssistantMessageId = undefined
    return null
  }

  // `time.completed` alone is not a success certificate (upstream assigns it during processor
  // cleanup including failed/intermediate processing) -- `finish` must also be present and not
  // one of the two values the prompt loop itself treats as "needs another iteration"
  // (`tool-calls`) or as not-yet-meaningful (`unknown`).
  const finish = getStringProperty(latestAssistantMessageInfo, 'finish')
  if (finish == null || finish === 'tool-calls' || finish === 'unknown') {
    activityTracker.completedAssistantMessageId = undefined
    return null
  }

  // Answers the latest root user message, with no newer unanswered one: `latestRootUserMessageId`
  // is only positively known once a new root user turn has been observed (e.g. an injected
  // background-task-completion turn) -- null in the common single-turn case, where this check
  // degrades to a no-op and the pending-parent barrier below is the operative guard.
  const parentId = getStringProperty(latestAssistantMessageInfo, 'parentID')
  if (rootFreshness != null) {
    if (rootFreshness.latestRootUserMessageId != null && parentId !== rootFreshness.latestRootUserMessageId) {
      activityTracker.completedAssistantMessageId = undefined
      return null
    }
    if (rootFreshness.pendingParentMessageId != null) {
      // The barrier normally only clears via `resolvePendingRootUserMessage()` on the streaming
      // path -- but that path is exactly what's unavailable when SSE has dropped. When the poll
      // path itself observes the confirming reply (this candidate's parentID matches the pending
      // id), resolve the barrier here too, via the same shared resolver, instead of leaving it
      // dependent on a channel that may be dead.
      if (parentId != null && parentId === rootFreshness.pendingParentMessageId) {
        resolvePendingRootUserMessage(rootFreshness, parentId)
      } else {
        activityTracker.completedAssistantMessageId = undefined
        return null
      }
    }
  }

  // Upstream (packages/opencode/src/session/prompt.ts) does not filter tool parts on status at
  // all: ANY tool part -- pending, running, or completed -- requires another prompt-loop
  // iteration unless it is provider-executed (the model never needs the result back) or an
  // orphaned interrupted tool (cleanup() marks abandoned tool_use blocks 'error' with
  // metadata.interrupted === true after retries/aborts; those are not pending work). A
  // *completed*, non-provider-executed tool part still blocks completion -- the model has not
  // yet received the result and will produce another turn. `providerExecuted` is read from
  // `part.metadata`; the orphan condition reads `part.state.status` and
  // `part.state.metadata.interrupted` -- two different metadata locations. The orphan check is
  // the permissive branch, so it uses the strictest reading: a missing/malformed `state` or
  // `metadata`, or `interrupted` present but not strictly `true`, must not qualify as an orphan.
  const parts = getObjectProperty(latestAssistantMessage, 'parts')
  if (Array.isArray(parts)) {
    const hasBlockingTool = parts.some((part: unknown) => {
      if (getStringProperty(part, 'type') !== 'tool') return false
      const providerExecuted = getBooleanProperty(getObjectProperty(part, 'metadata'), 'providerExecuted')
      if (providerExecuted === true) return false
      const state = getObjectProperty(part, 'state')
      const status = getStringProperty(state, 'status')
      const interrupted = getBooleanProperty(getObjectProperty(state, 'metadata'), 'interrupted')
      const isOrphanedInterruptedTool = status === 'error' && interrupted === true
      return !isOrphanedInterruptedTool
    })
    if (hasBlockingTool) {
      activityTracker.completedAssistantMessageId = undefined
      return null
    }
  }

  // Renewed root activity observed while this request was in flight invalidates the response.
  if (rootFreshness != null && rootFreshness.revision !== requestRevision) {
    activityTracker.completedAssistantMessageId = undefined
    return null
  }

  // Confirm the same qualified candidate remains the latest across two consecutive polls
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

  logger.debug('Qualified completed assistant message observed — awaiting status corroboration', {
    sessionId,
    messageId: latestAssistantMessageId,
  })

  return {messageId: latestAssistantMessageId, revision: rootFreshness?.revision ?? null}
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

    // A root-freshness tracker (when present) is authoritative over the raw sticky flags: those
    // flags never reset once set, so "idle happened sometime earlier" must not be accepted on its
    // own. `hasFreshIdleCandidate` requires idle evidence for the CURRENT generation with no
    // unresolved newer parent turn. Trackers built without one (tests/fixtures constructing
    // `ActivityTracker` literals directly) keep the prior sticky-flag behavior exactly.
    const rootFreshness = activityTracker?.rootFreshness
    const hasIdleEvidence =
      rootFreshness == null
        ? activityTracker?.sessionIdle === true && activityTracker.currentTurnTerminalSignalReceived === true
        : hasFreshIdleCandidate(rootFreshness)
    if (hasIdleEvidence) {
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
      const messageCandidate = await detectMessageActivity(
        client,
        sessionId,
        directory,
        activityTracker,
        logger,
        signal,
        deadline,
      )
      // An assistant carrying its own error settles as a failure observation immediately, exactly
      // like every other failure observation in this loop -- it never waits behind the completion
      // admission gates (ledger/status/deadline) below, which exist to protect a *completion*
      // decision, not a failure one.
      if (messageCandidate != null && 'settlement' in messageCandidate) {
        return messageCandidate
      }

      // Captured before issuing the request: a status response that started before renewed root
      // activity cannot authorize completion after it, even though the response itself reports
      // idle -- the root may have moved on while the request was in flight. Shared by both the
      // message-fallback candidate (below) and the plain REST-idle path, so this request is issued
      // exactly once per iteration regardless of which completion evidence is under evaluation.
      const statusRequestRevision = activityTracker?.rootFreshness?.revision
      const statusResponse = await runPollRequest(
        async () => client.session.status({query: {directory}, signal}),
        'session.status()',
        signal,
        deadline,
      )
      const statuses = statusResponse.data ?? {}
      const sessionStatus = statuses[sessionId]
      const rootFreshnessForStatus = activityTracker?.rootFreshness
      // Deliberate defense-in-depth, not redundant with `detectMessageActivity`'s own barrier
      // check (session-poll.ts:453-466 area, above): that inner check only runs for the
      // message-fallback candidate path, and now resolves the barrier itself when it observes the
      // matching reply. This outer `pendingParentMessageId` check is what actually guards the
      // *plain* REST-status-idle path a few lines below (`sessionStatus.type === 'idle'` with no
      // message candidate at all) -- that branch never calls `detectMessageActivity` and has no
      // other barrier gate of its own. Removing this would let a pending parent turn's status-only
      // idle admit completion with nothing left to block it.
      const staleAgainstRenewedActivity =
        rootFreshnessForStatus != null &&
        (rootFreshnessForStatus.revision !== statusRequestRevision ||
          rootFreshnessForStatus.pendingParentMessageId != null)
      // This response reflects the same generation it was requested against -- a REST corroboration
      // of the current state, regardless of what that state turns out to be. That's the missing
      // half of the revision-bump guard in `invalidateRootFreshness`: clear the requirement here so
      // idle evidence for this generation can be trusted again. If the status itself turns out to
      // be busy/retry below, `invalidateRootFreshness` re-raises the requirement for the new bump it
      // causes -- so this only stays cleared when the corroboration actually found quiescence.
      if (rootFreshnessForStatus != null && rootFreshnessForStatus.revision === statusRequestRevision) {
        clearRootRevalidationRequirement(rootFreshnessForStatus)
      }
      // The candidate's own revision was captured inside `detectMessageActivity()` at the moment it
      // qualified -- a separate, earlier observation than `statusRequestRevision` above. Renewed
      // root activity landing between that qualification and this admission point (including
      // during the gap before `statusRequestRevision` was even captured) must invalidate the
      // candidate independently of whatever the status response itself reports.
      const candidateStaleAgainstRenewedActivity =
        messageCandidate != null &&
        rootFreshnessForStatus != null &&
        messageCandidate.revision !== rootFreshnessForStatus.revision
      // Upstream removes idle sessions from the status map entirely, so a successful omission is
      // consistent with (but on its own does not prove) inactivity -- it may corroborate a
      // message-fallback candidate that has already independently confirmed the submission's own
      // baseline and two-poll stability, but is not itself treated as idle evidence below.
      const statusCorroboratesInactivity = sessionStatus == null || sessionStatus.type === 'idle'

      if (
        messageCandidate != null &&
        statusCorroboratesInactivity &&
        !staleAgainstRenewedActivity &&
        !candidateStaleAgainstRenewedActivity
      ) {
        if (ledgerBlocksCompletion(ownershipLedger)) {
          logger.debug(
            'Qualified completed-assistant message observed but owned work outstanding — deferring completion',
            {sessionId, outstanding: ownershipLedger?.outstanding()},
          )
        } else if (deadline?.isExpired() === true) {
          // The completed-assistant message itself may have been produced (and its two-poll
          // stability confirmed, via the async session.messages() requests above) after the
          // deadline expired -- admission is checked here, at the decision, not inferred later.
          return deadlineObservation(activityTracker)
        } else {
          if (activityTracker != null) activityTracker.currentTurnTerminalSignalReceived = true
          logger.debug('Session completion detected via qualified completed assistant message', {
            sessionId,
            messageId: messageCandidate.messageId,
          })
          return completionObservation(activityTracker)
        }
      }

      if (sessionStatus == null) {
        // Idle sessions are removed from upstream's status map entirely (served from a map that
        // only carries non-idle entries) -- so a successful omission is consistent with inactivity
        // for a known accepted root, but on its own it cannot prove this submission ran at all
        // (e.g. a session id that was never accepted). Not treated as idle evidence by itself here;
        // it corroborates other completion evidence (see the message-fallback path above).
        logger.debug('Session status not found in poll response', {sessionId})
      } else if (sessionStatus.type === 'idle') {
        if (activityTracker != null && activityTracker.currentTurnTerminalSignalReceived !== true) {
          logger.debug('Session idle detected before terminal signal; continuing watchdog', {sessionId})
        } else if (staleAgainstRenewedActivity) {
          logger.debug(
            'Session idle observed via polling but invalidated by renewed root activity since the request was issued',
            {sessionId},
          )
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
        // Renewed root activity regardless of whether it also classifies as terminal below --
        // invalidate any prior completion evidence even when classification returns null.
        if (activityTracker?.rootFreshness != null) invalidateRootFreshness(activityTracker.rootFreshness)
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
        // Covers 'busy' (and any other non-idle/non-retry status): renewed root activity that
        // invalidates prior completion evidence even though it carries no classifiable failure.
        if (sessionStatus.type === 'busy' && activityTracker?.rootFreshness != null) {
          invalidateRootFreshness(activityTracker.rootFreshness)
        }
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
