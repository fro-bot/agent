import type {createOpencode} from '@opencode-ai/sdk'
import type {Logger} from '../../shared/logger.js'
import type {ExecutionDeadline} from './retry.js'
import type {ActivityTracker} from './streaming.js'
import {DEFAULT_TIMEOUT_MS} from '../../shared/constants.js'
import {toErrorMessage} from '../../shared/errors.js'
import {classifyRetryStatusQuota} from './streaming.js'

const POLL_INTERVAL_MS = 500
const POLL_REQUEST_TIMEOUT_MS = 5_000
const EVENT_PROCESSOR_SHUTDOWN_TIMEOUT_MS = 2_000
const ERROR_GRACE_CYCLES = 3
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
): Promise<PollResult | null> {
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
  deadline?: ExecutionDeadline,
): Promise<PollResult> {
  const pollStart = Date.now()
  let errorGraceCycles = 0
  let firstSessionError: string | null = null

  while (!signal.aborted) {
    if (deadline?.isExpired() === true) return {completed: false, error: 'Aborted'}
    try {
      const delay = async () => {
        await waitForAbortableDelay(POLL_INTERVAL_MS, signal)
      }
      if (deadline == null) await delay()
      else await deadline.run(delay, 'poll interval')
    } catch {
      return {completed: false, error: 'Aborted'}
    }
    if (signal.aborted) return {completed: false, error: 'Aborted'}

    const observedSessionError = activityTracker?.sessionError
    if (firstSessionError == null && observedSessionError != null) {
      firstSessionError = observedSessionError
    }
    const sessionError = activityTracker?.quotaExceeded?.message ?? firstSessionError

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
        return {completed: false, error: `Session error: ${sessionError}`}
      }
      continue
    }

    if (activityTracker?.sessionIdle === true && activityTracker.currentTurnTerminalSignalReceived) {
      logger.debug('Session idle detected via event stream', {sessionId})
      return {completed: true, error: null}
    }

    const elapsed = Date.now() - pollStart
    if (deadline == null && maxPollTimeMs > 0 && elapsed >= maxPollTimeMs) {
      logger.warning('Poll timeout reached', {elapsedMs: elapsed, maxPollTimeMs})
      return {completed: false, error: `Poll timeout after ${elapsed}ms`}
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
      if (messageResult != null) return messageResult

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
        } else {
          logger.debug('Session idle detected via polling', {sessionId})
          return {completed: true, error: null}
        }
      } else if (sessionStatus.type === 'retry') {
        // Poll-only quota fails fast instead of waiting out the full timeout.
        const quotaError = classifyRetryStatusQuota(sessionStatus)
        if (quotaError != null) {
          logger.error('Session status retry classified as quota exceeded via poll', {
            sessionId,
            type: sessionStatus.type,
          })
          if (activityTracker != null) {
            activityTracker.quotaExceeded = quotaError
            activityTracker.sessionError = quotaError.message
            activityTracker.currentTurnTerminalSignalReceived = true
          }
          return {completed: false, error: quotaError.message}
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
