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
const EVENT_PROCESSOR_SHUTDOWN_TIMEOUT_MS = 2_000
const ERROR_GRACE_CYCLES = 3
export const INITIAL_ACTIVITY_TIMEOUT_MS = 90_000

interface PollResult {
  readonly completed: boolean
  readonly error: string | null
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

    if (activityTracker?.sessionIdle === true) {
      logger.debug('Session idle detected via event stream', {sessionId})
      return {completed: true, error: null}
    }

    const elapsed = Date.now() - pollStart
    if (maxPollTimeMs > 0 && elapsed >= maxPollTimeMs) {
      logger.warning('Poll timeout reached', {elapsedMs: elapsed, maxPollTimeMs})
      return {completed: false, error: `Poll timeout after ${elapsed}ms`}
    }

    try {
      const statusResponse = await client.session.status({query: {directory}})
      const statuses = statusResponse.data ?? {}
      const sessionStatus = statuses[sessionId] as SessionStatus | undefined

      if (sessionStatus == null) {
        logger.debug('Session status not found in poll response', {sessionId})
      } else if (sessionStatus.type === 'idle') {
        logger.debug('Session idle detected via polling', {sessionId})
        return {completed: true, error: null}
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
