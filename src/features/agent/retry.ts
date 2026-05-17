import type {createOpencode, Event} from '@opencode-ai/sdk'
import type {createOpencodeClient} from '@opencode-ai/sdk/v2'
import type {Logger} from '../../shared/logger.js'
import type {AttemptResult} from './prompt-sender.js'
import type {ActivityTracker, EventStreamResult} from './streaming.js'
import {sleep} from '../../shared/async.js'
import {toErrorMessage} from '../../shared/errors.js'
import {pollForSessionCompletion, waitForEventProcessorShutdown} from './session-poll.js'
import {processEventStream, renderFallbackMessageParts} from './streaming.js'

export type PromptStartResult = AttemptResult | null
export type PromptStarter = () => Promise<PromptStartResult>

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
const FALLBACK_MESSAGES_STABILITY_WAIT_MS = 1_500
const FALLBACK_MESSAGES_POLL_INTERVAL_MS = 250

function appendUniqueStrings(existing: readonly string[], additions: readonly string[]): string[] {
  return [...existing, ...additions.filter(value => !existing.includes(value))]
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout != null) clearTimeout(timeout)
  }
}

async function listSessionMessageIds(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  logger: Logger,
): Promise<ReadonlySet<string> | null> {
  if (typeof client.session.messages !== 'function') return null

  try {
    const response = await withTimeout(
      client.session.messages({path: {id: sessionId}, query: {directory}}),
      BASELINE_MESSAGES_TIMEOUT_MS,
      'baseline session.messages()',
    )
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
  maxWaitMs: number,
): Promise<readonly unknown[] | null> {
  if (baselineMessageIds == null || typeof client.session.messages !== 'function') return null

  const startedAt = Date.now()
  while (true) {
    try {
      const response = await withTimeout(
        client.session.messages({path: {id: sessionId}, query: {directory}}),
        BASELINE_MESSAGES_TIMEOUT_MS,
        'completed assistant session.messages()',
      )
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
    } catch (error) {
      logger.debug('Unable to read completed assistant message parts', {sessionId, error: toErrorMessage(error)})
      return null
    }

    if (Date.now() - startedAt >= maxWaitMs) return null
    await sleep(FALLBACK_MESSAGES_POLL_INTERVAL_MS)
  }
}

export function mergeEventStreamAndFallbackResults(
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

/**
 * Call v2.session.wait() on an existing server via a v2 client.
 * Returns true when wait() resolves and a terminal signal for the current turn has been observed,
 * false if unavailable, errored, or the terminal signal was not received within the grace window.
 *
 * This is intentionally non-blocking — callers start it in parallel with
 * pollForSessionCompletion() so the watchdog timeout is never suppressed.
 */
async function startV2SessionWait(
  serverUrl: string | null | undefined,
  sessionId: string,
  directory: string,
  activityTracker: ActivityTracker,
  logger: Logger,
  signal: AbortSignal,
): Promise<boolean> {
  const v2Client = await tryCreateV2Client(serverUrl)
  if (v2Client == null) return false

  try {
    const response = await v2Client.v2.session.wait({sessionID: sessionId, directory}, {signal})
    if (response.error != null) {
      logger.debug('v2.session.wait() returned error, relying on poll watchdog', {
        sessionId,
        error: String(response.error),
      })
      return false
    }
    // Guard: only accept wait() as the completion signal if a terminal signal for the current
    // turn has been received (session.idle event or completed assistant message). wait() can
    // resolve before the event processor has processed the terminal event (async scheduling gap),
    // so we poll briefly (up to 500ms in 10ms ticks) to give the event processor time to catch up.
    // Crucially, firstMeaningfulEventReceived (LLM stream start) is NOT sufficient — the session
    // must have actually finished, not just started. Fall back to poll watchdog otherwise.
    const TERMINAL_GRACE_MS = 500
    const TERMINAL_POLL_INTERVAL_MS = 10
    const deadline = Date.now() + TERMINAL_GRACE_MS
    while (
      activityTracker.currentTurnTerminalSignalReceived !== true &&
      Date.now() < deadline &&
      signal.aborted !== true
    ) {
      await new Promise(resolve => setTimeout(resolve, TERMINAL_POLL_INTERVAL_MS))
    }
    if (activityTracker.currentTurnTerminalSignalReceived !== true) {
      logger.debug('v2.session.wait() resolved without terminal signal — deferring to poll watchdog', {sessionId})
      return false
    }
    logger.debug('v2.session.wait() resolved with terminal signal — session is done', {sessionId})
    return true
  } catch (error) {
    logger.debug('v2.session.wait() threw, relying on poll watchdog', {sessionId, error: toErrorMessage(error)})
    return false
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
): Promise<AttemptResult> {
  const eventAbortController = new AbortController()
  const waitAbortController = new AbortController()
  const activityTracker: ActivityTracker = {
    firstMeaningfulEventReceived: false,
    currentTurnTerminalSignalReceived: false,
    currentTurnArmed: startPrompt == null,
    baselineMessageIds: undefined,
    textOutputEmitted: false,
    toolOutputEmitted: false,
    sessionIdle: false,
    sessionError: null,
  }

  const events = eventStream ?? (await client.event.subscribe()).stream

  let eventStreamResult: EventStreamResult = {
    tokens: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
  }

  const eventProcessor = processEventStream(events, sessionId, eventAbortController.signal, logger, activityTracker)
    .then(result => {
      eventStreamResult = result
    })
    .catch(error => {
      if (error instanceof Error && error.name !== 'AbortError') {
        logger.debug('Event stream error', {error: error.message})
      }
    })

  const collectEventResults = async () => {
    eventAbortController.abort()
    waitAbortController.abort()
    await waitForEventProcessorShutdown(eventProcessor)
  }

  try {
    // Ensure the lazy SDK SSE stream begins connecting before prompt submission. Without this,
    // event.subscribe().stream is only consumed after promptAsync returns, so early current-turn
    // events can be missed while the agent is already working.
    await Promise.resolve()
    if (startPrompt != null) {
      activityTracker.baselineMessageIds =
        (await listSessionMessageIds(client, sessionId, directory, logger)) ?? undefined
      activityTracker.currentTurnArmed = true
      const promptStartResult = await startPrompt()
      if (promptStartResult != null) {
        await collectEventResults()
        return promptStartResult
      }
    }

    // Start the polling watchdog immediately — it enforces the no-activity timeout and
    // serves as fallback completion detection via session.idle events and session.status().
    // This must always run in parallel; never awaited before starting.
    const pollPromise = pollForSessionCompletion(
      client,
      sessionId,
      directory,
      eventAbortController.signal,
      logger,
      timeoutMs,
      activityTracker,
    )

    // Concurrently start v2.session.wait() if available (SDK 1.14.39+).
    // It is the authoritative completion signal — blocks until the agent loop is idle.
    // On success it marks activityTracker idle so the poller exits on its next tick.
    // On error/rejection it resolves false and we rely solely on the poller.
    const waitPromise = startV2SessionWait(
      serverUrl,
      sessionId,
      directory,
      activityTracker,
      logger,
      waitAbortController.signal,
    )

    // Race: whichever settles first wins.
    // - wait() wins → marks activityTracker idle → return success immediately.
    // - wait() fails (false) → await pollPromise for the authoritative result.
    // - poll wins before wait() → use poll result; wait() is still pending but ignored.
    const pollResult = await Promise.race([
      waitPromise.then(
        (
          waitSucceeded,
        ): Promise<{completed: boolean; error: string | null}> | {completed: boolean; error: string | null} => {
          if (waitSucceeded) {
            return {completed: true, error: null}
          }
          // wait() unavailable or failed — fall through to poll result
          return pollPromise
        },
      ),
      pollPromise,
    ])

    await collectEventResults()

    if (!pollResult.completed) {
      const pollError = pollResult.error ?? 'Session did not reach idle state'
      logger.error('Session completion polling failed', {error: pollError, sessionId})
      return {
        success: false,
        error: pollError,
        llmError: eventStreamResult.llmError,
        shouldRetry: eventStreamResult.llmError != null,
        eventStreamResult,
      }
    }

    // Render any visible output the live stream missed by reading the completed assistant
    // message and rendering its parts. Text and tool rendering are gated independently so the
    // common case (live text streamed, no tool events seen) still renders tool execution lines.
    // Wait the stability window only when either signal is still missing; if both were emitted
    // live, do one immediate read just to merge missed artifacts.
    const liveStreamComplete = activityTracker.textOutputEmitted === true && activityTracker.toolOutputEmitted === true
    const fallbackMessageMaxWaitMs = liveStreamComplete ? 0 : FALLBACK_MESSAGES_STABILITY_WAIT_MS
    const fallbackMessageParts =
      activityTracker.fallbackMessageParts ??
      (await readCompletedAssistantMessageParts(
        client,
        sessionId,
        directory,
        activityTracker.baselineMessageIds,
        logger,
        fallbackMessageMaxWaitMs,
      ))

    if (fallbackMessageParts != null) {
      const fallback = renderFallbackMessageParts(fallbackMessageParts, logger, {
        renderText: activityTracker.textOutputEmitted !== true,
        renderTools: activityTracker.toolOutputEmitted !== true,
      })
      const merged = mergeEventStreamAndFallbackResults(eventStreamResult, fallback)
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
    eventAbortController.abort()
    waitAbortController.abort()
    await waitForEventProcessorShutdown(eventProcessor)
  }
}
