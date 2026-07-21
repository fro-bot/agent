import type {createOpencode, Event} from '@opencode-ai/sdk'
import type {createOpencodeClient} from '@opencode-ai/sdk/v2'
import type {Logger} from '../../shared/logger.js'
import type {AttemptResult} from './prompt-sender.js'
import type {ActivityTracker, EventStreamResult} from './streaming.js'
import {toErrorMessage} from '../../shared/errors.js'
import {pollForSessionCompletion, waitForAbortableDelay, waitForEventProcessorShutdown} from './session-poll.js'
import {detectArtifactsFromMessageParts, processEventStream} from './streaming.js'

export type PromptStartResult = AttemptResult | null
export type PromptStarter = () => Promise<PromptStartResult>

export class DeadlineExceededError extends Error {
  constructor(label: string) {
    super(`${label} exceeded the execution deadline`)
    this.name = 'DeadlineExceededError'
  }
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

  const run = async <T>(operation: () => Promise<T>, label: string): Promise<T> => {
    if (isExpired()) throw new DeadlineExceededError(label)
    if (deadlineAt == null) return operation()

    let onAbort: (() => void) | null = null
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = (): void => reject(new DeadlineExceededError(label))
      controller.signal.addEventListener('abort', onAbort, {once: true})
    })

    const operationPromise = Promise.resolve().then(operation)
    try {
      const result = await Promise.race([operationPromise, abortPromise])
      if (isExpired()) throw new DeadlineExceededError(label)
      return result
    } catch (error) {
      if (timedOut) throw new DeadlineExceededError(label)
      throw error
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

/** Calls v2.session.wait() on an existing server; non-blocking, runs alongside pollForSessionCompletion(). */
type V2WaitOutcome = 'fallback-to-poll' | 'quota-failed' | 'succeeded'

async function startV2SessionWait(
  serverUrl: string | null | undefined,
  sessionId: string,
  activityTracker: ActivityTracker,
  logger: Logger,
  signal: AbortSignal,
  deadline?: ExecutionDeadline,
): Promise<V2WaitOutcome> {
  const v2Client =
    deadline == null
      ? await tryCreateV2Client(serverUrl)
      : await deadline.run(async () => tryCreateV2Client(serverUrl), 'v2 client creation')
  if (v2Client == null) return 'fallback-to-poll'

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
      return 'fallback-to-poll'
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
      return 'fallback-to-poll'
    }
    // Quota is terminal but must never be reported as wait() success.
    if (activityTracker.quotaExceeded != null) {
      logger.debug('v2.session.wait() resolved after quota exceeded — reporting quota failure, not success', {
        sessionId,
      })
      return 'quota-failed'
    }
    logger.debug('v2.session.wait() resolved with terminal signal — session is done', {sessionId})
    return 'succeeded'
  } catch (error) {
    logger.debug('v2.session.wait() threw, relying on poll watchdog', {sessionId, error: toErrorMessage(error)})
    return 'fallback-to-poll'
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

  const eventProcessor = processEventStream(events, sessionId, eventSignal, logger, activityTracker)
    .then(result => {
      eventStreamResult = result
    })
    .catch(error => {
      if (error instanceof Error && error.name !== 'AbortError') {
        logger.debug('Event stream error', {error: error.message})
      }
    })

  const collectEventResults = async () => {
    attemptController.abort()
    waitAbortController.abort()
    await waitForEventProcessorShutdown(eventProcessor)
    eventAbortController.abort()
  }

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
        await collectEventResults()
        return promptStartResult
      }
    }

    // Watchdog: enforces no-activity timeout and fallback completion detection; runs in parallel.
    const pollPromise = pollForSessionCompletion(
      client,
      sessionId,
      directory,
      eventSignal,
      logger,
      timeoutMs,
      activityTracker,
      deadline,
    )

    // Authoritative completion signal when available; falls back to the poller otherwise.
    const waitPromise = startV2SessionWait(serverUrl, sessionId, activityTracker, logger, waitSignal, deadline)

    // Race: wait() succeeds → success; wait() quota-failed → failure (never success on quota);
    // wait() falls back → use poll result.
    const pollResult = await Promise.race([
      waitPromise.then(
        (outcome): Promise<{completed: boolean; error: string | null}> | {completed: boolean; error: string | null} => {
          if (outcome === 'succeeded') {
            return {completed: true, error: null}
          }
          if (outcome === 'quota-failed') {
            return {completed: false, error: activityTracker.quotaExceeded?.message ?? 'Quota exceeded'}
          }
          // wait() unavailable or failed — fall through to poll result
          return pollPromise
        },
      ),
      pollPromise,
    ])

    if (deadline?.isTimedOut() === true) throw new DeadlineExceededError('prompt attempt')

    await collectEventResults()

    // Merge poll-observed quota (SSE may never have emitted one) into the authoritative result.
    if (activityTracker.quotaExceeded != null && eventStreamResult.llmError?.type !== 'quota_exceeded') {
      eventStreamResult = {...eventStreamResult, llmError: activityTracker.quotaExceeded}
    }

    if (!pollResult.completed) {
      const pollError = pollResult.error ?? 'Session did not reach idle state'
      logger.error('Session completion polling failed', {error: pollError, sessionId})
      return {
        success: false,
        error: pollError,
        llmError: eventStreamResult.llmError,
        shouldRetry: eventStreamResult.llmError?.retryable === true,
        eventStreamResult,
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

    if (deadline?.isTimedOut() === true) throw new DeadlineExceededError('artifact reconciliation')

    if (fallbackMessageParts != null) {
      const fallback = detectArtifactsFromMessageParts(fallbackMessageParts, logger)
      const merged = mergeArtifactResults(eventStreamResult, fallback)
      return {
        success: true,
        error: null,
        llmError: null,
        shouldRetry: false,
        eventStreamResult: merged,
      }
    }

    return {
      success: true,
      error: null,
      llmError: null,
      shouldRetry: false,
      eventStreamResult,
    }
  } finally {
    attemptController.abort()
    waitAbortController.abort()
    await waitForEventProcessorShutdown(eventProcessor)
    eventAbortController.abort()
  }
}
