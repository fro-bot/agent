import type {createOpencode, Event} from '@opencode-ai/sdk'
import type {Logger} from '../shared/logger.js'
import type {TokenUsage} from '../shared/types.js'
import type {AttemptResult} from './prompt-sender.js'
import type {ErrorInfo} from './types.js'

export interface ActivityTracker {
  firstMeaningfulEventReceived: boolean
  sessionIdle: boolean
  sessionError: string | null
}

export interface EventStreamResult {
  readonly tokens: TokenUsage | null
  readonly model: string | null
  readonly cost: number | null
  readonly prsCreated: string[]
  readonly commitsCreated: string[]
  readonly commentsPosted: number
  readonly llmError: ErrorInfo | null
}

export interface PromptAttemptDependencies {
  readonly pollForSessionCompletion: (
    client: Awaited<ReturnType<typeof createOpencode>>['client'],
    sessionId: string,
    directory: string,
    signal: AbortSignal,
    logger: Logger,
    timeoutMs: number,
    activityTracker: ActivityTracker,
  ) => Promise<{readonly completed: boolean; readonly error: string | null}>
  readonly processEventStream: (
    stream: AsyncIterable<Event>,
    sessionId: string,
    signal: AbortSignal,
    logger: Logger,
    activityTracker: ActivityTracker,
  ) => Promise<EventStreamResult>
  readonly waitForEventProcessorShutdown: (eventProcessor: Promise<void>, timeoutMs?: number) => Promise<void>
}

export const MAX_LLM_RETRIES = 4
export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const

export async function runPromptAttempt(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  timeoutMs: number,
  logger: Logger,
  dependencies: PromptAttemptDependencies,
): Promise<AttemptResult> {
  const eventAbortController = new AbortController()
  const activityTracker: ActivityTracker = {
    firstMeaningfulEventReceived: false,
    sessionIdle: false,
    sessionError: null,
  }

  const events = await client.event.subscribe()

  let eventStreamResult: EventStreamResult = {
    tokens: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
  }

  const eventProcessor = dependencies
    .processEventStream(
      events.stream as AsyncIterable<Event>,
      sessionId,
      eventAbortController.signal,
      logger,
      activityTracker,
    )
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
    await dependencies.waitForEventProcessorShutdown(eventProcessor)
  }

  try {
    const pollResult = await dependencies.pollForSessionCompletion(
      client,
      sessionId,
      directory,
      eventAbortController.signal,
      logger,
      timeoutMs,
      activityTracker,
    )

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
    await dependencies.waitForEventProcessorShutdown(eventProcessor)
  }
}
