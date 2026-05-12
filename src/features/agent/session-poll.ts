import type {createOpencode} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {ActivityTracker} from './streaming.js'
import {sleep} from '../../shared/async.js'
import {DEFAULT_TIMEOUT_MS} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'

type SessionStatus =
  | {readonly type: 'idle'}
  | {readonly type: 'retry'; readonly attempt: number; readonly message: string; readonly next: number}
  | {readonly type: 'busy'}

const POLL_INTERVAL_MS = 500
const POLL_REQUEST_TIMEOUT_MS = 5_000
const EVENT_PROCESSOR_SHUTDOWN_TIMEOUT_MS = 2_000
const ERROR_GRACE_CYCLES = 3
const COMPLETED_ASSISTANT_MESSAGE_STABILITY_MS = 1_000
export const INITIAL_ACTIVITY_TIMEOUT_MS = 90_000

interface PollResult {
  readonly completed: boolean
  readonly error: string | null
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

async function withRequestTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

async function detectMessageActivity(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  activityTracker: ActivityTracker | undefined,
  logger: Logger,
): Promise<PollResult | null> {
  if (activityTracker?.baselineMessageIds == null) return null

  if (typeof client.session.messages !== 'function') {
    logger.debug('session.messages() unavailable; skipping message activity poll', {sessionId})
    return null
  }

  const messagesResponse = await withRequestTimeout(
    client.session.messages({path: {id: sessionId}, query: {directory}}),
    POLL_REQUEST_TIMEOUT_MS,
    'session.messages()',
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
    activityTracker.completedAssistantMessageObservedAt = undefined
    return null
  }

  const now = Date.now()
  if (activityTracker.completedAssistantMessageId !== latestAssistantMessageId) {
    activityTracker.completedAssistantMessageId = latestAssistantMessageId
    activityTracker.completedAssistantMessageObservedAt = now
    logger.debug('Completed assistant message observed; waiting for stability before completion', {
      sessionId,
      messageId: latestAssistantMessageId,
    })
    return null
  }

  const observedAt = activityTracker.completedAssistantMessageObservedAt ?? now
  const stableForMs = now - observedAt
  if (stableForMs < COMPLETED_ASSISTANT_MESSAGE_STABILITY_MS) {
    logger.debug('Completed assistant message not stable yet; continuing watchdog', {
      sessionId,
      messageId: latestAssistantMessageId,
      stableForMs,
    })
    return null
  }

  activityTracker.currentTurnTerminalSignalReceived = true
  logger.debug('Session completion detected via stable completed assistant message', {
    sessionId,
    messageId: latestAssistantMessageId,
    stableForMs,
  })

  // Store the message parts only after the completed assistant message has passed
  // the stability window so retry.ts renders/merges the final persisted parts.
  const latestMessage = messages.find((m: unknown) => {
    const info = getObjectProperty(m, 'info')
    return getStringProperty(info, 'id') === latestAssistantMessageId
  })
  if (latestMessage != null) {
    const parts = getObjectProperty(latestMessage, 'parts')
    if (Array.isArray(parts)) {
      activityTracker.fallbackMessageParts = parts
    }
  }

  return {completed: true, error: null}
}

export async function pollForSessionCompletion(
  client: Awaited<ReturnType<typeof createOpencode>>['client'],
  sessionId: string,
  directory: string,
  signal: AbortSignal,
  logger: Logger,
  maxPollTimeMs: number = DEFAULT_TIMEOUT_MS,
  activityTracker?: ActivityTracker,
): Promise<PollResult> {
  const pollStart = Date.now()
  let errorGraceCycles = 0

  while (!signal.aborted) {
    await sleep(POLL_INTERVAL_MS)
    if (signal.aborted) return {completed: false, error: 'Aborted'}

    if (activityTracker?.sessionError == null) {
      errorGraceCycles = 0
    } else {
      errorGraceCycles++
      if (errorGraceCycles >= ERROR_GRACE_CYCLES) {
        logger.error('Session error persisted through grace period', {
          sessionId,
          error: activityTracker.sessionError,
          graceCycles: errorGraceCycles,
        })
        return {completed: false, error: `Session error: ${activityTracker.sessionError}`}
      }
      continue
    }

    if (activityTracker?.sessionIdle === true && activityTracker.currentTurnTerminalSignalReceived) {
      logger.debug('Session idle detected via event stream', {sessionId})
      return {completed: true, error: null}
    }

    const elapsed = Date.now() - pollStart
    if (maxPollTimeMs > 0 && elapsed >= maxPollTimeMs) {
      logger.warning('Poll timeout reached', {elapsedMs: elapsed, maxPollTimeMs})
      return {completed: false, error: `Poll timeout after ${elapsed}ms`}
    }

    try {
      const messageResult = await detectMessageActivity(client, sessionId, directory, activityTracker, logger)
      if (messageResult != null) return messageResult

      const statusResponse = await withRequestTimeout(
        client.session.status({query: {directory}}),
        POLL_REQUEST_TIMEOUT_MS,
        'session.status()',
      )
      const statuses = statusResponse.data ?? {}
      const sessionStatus = statuses[sessionId] as SessionStatus | undefined

      if (sessionStatus == null) {
        logger.debug('Session status not found in poll response', {sessionId})
      } else if (sessionStatus.type === 'idle') {
        if (activityTracker != null && activityTracker.currentTurnTerminalSignalReceived !== true) {
          logger.debug('Session idle detected before terminal signal; continuing watchdog', {sessionId})
        } else {
          logger.debug('Session idle detected via polling', {sessionId})
          return {completed: true, error: null}
        }
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
          return {
            completed: false,
            error: `No agent activity detected after ${activityElapsed}ms — server may have crashed during prompt processing`,
          }
        }
      }
    } catch (pollError) {
      logger.debug('Poll request failed', {error: toErrorMessage(pollError)})
    }
  }

  return {completed: false, error: 'Aborted'}
}

export async function waitForEventProcessorShutdown(
  eventProcessor: Promise<void>,
  timeoutMs: number = EVENT_PROCESSOR_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  await Promise.race([
    eventProcessor,
    new Promise<void>(resolve => {
      setTimeout(resolve, timeoutMs)
    }),
  ])
}
