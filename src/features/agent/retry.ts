import type {createOpencode, Event} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {AttemptResult} from './prompt-sender.js'
import type {ActivityTracker, EventStreamResult} from './streaming.js'
import {toErrorMessage} from '../../shared/errors.js'
import {pollForSessionCompletion, waitForEventProcessorShutdown} from './session-poll.js'
import {processEventStream} from './streaming.js'

export const MAX_LLM_RETRIES = 4
export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const

interface WaitParams {
  readonly sessionID: string
  readonly directory: string
}

interface WaitOptions {
  readonly signal: AbortSignal
}

interface WaitResponse {
  readonly error?: unknown
}

/**
 * Start `client.v2.session.wait()` if available (SDK 1.14.39+).
 * Returns a promise that resolves to true when the session is idle, false if
 * unavailable or errored. On success marks the activityTracker so the concurrent
 * poller exits on its next tick.
 *
 * This is intentionally non-blocking — callers start it in parallel with
 * pollForSessionCompletion() so the watchdog timeout is never suppressed.
 */
async function startV2SessionWait(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  activityTracker: ActivityTracker,
  logger: Logger,
  signal: AbortSignal,
): Promise<boolean> {
  // Duck-type: v2.session.wait may not exist on older SDK versions
  const clientUnknown = client as unknown as Record<string, unknown>
  const v2 = clientUnknown.v2
  if (v2 == null || typeof v2 !== 'object') return false
  const session = (v2 as Record<string, unknown>).session
  if (session == null || typeof session !== 'object') return false
  const waitFn = (session as Record<string, unknown>).wait
  if (typeof waitFn !== 'function') return false

  try {
    const response = await (waitFn as (params: WaitParams, options: WaitOptions) => Promise<WaitResponse>).call(
      session,
      {sessionID: sessionId, directory},
      {signal},
    )
    if (response.error != null) {
      logger.debug('v2.session.wait() returned error, relying on poll watchdog', {
        sessionId,
        error: String(response.error),
      })
      return false
    }
    logger.debug('v2.session.wait() resolved — session is idle', {sessionId})
    activityTracker.sessionIdle = true
    activityTracker.firstMeaningfulEventReceived = true
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
): Promise<AttemptResult> {
  const eventAbortController = new AbortController()
  const waitAbortController = new AbortController()
  const activityTracker: ActivityTracker = {
    firstMeaningfulEventReceived: false,
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
      client,
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
