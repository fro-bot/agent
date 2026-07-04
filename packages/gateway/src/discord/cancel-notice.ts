/**
 * Discord transport for the cancellation notice injected into `cancelRun`
 * (`execute/cancel.ts`) via `CancelRunDeps.postCancelNotice`.
 *
 * `createCancelNoticeDispatcher` returns a `(threadId, runId) => Promise<void>`
 * callback that resolves the run's thread and posts a fixed cancellation
 * message. Always fail-soft: never throws, and every failure mode is logged,
 * not propagated — the cancellation outcome never depends on this succeeding.
 */

import type {Client} from 'discord.js'
import type {GatewayLogger} from './client.js'
import {sendMessage} from './io.js'

/** Fixed cancellation notice text posted to a run's origin thread. */
export const CANCELLED_NOTICE_TEXT = 'Run cancelled by operator.'

/**
 * Build the Discord cancellation-notice callback for `CancelRunDeps.postCancelNotice`.
 *
 * Skips (logs) when `threadId` is empty, when the channel cannot be resolved,
 * or when the resolved channel is not text-sendable. Logs (does not throw) on
 * a `sendMessage` failure or any thrown error from `channels.fetch`.
 */
export function createCancelNoticeDispatcher(
  client: Pick<Client, 'channels'>,
  logger: GatewayLogger,
): (threadId: string, runId: string) => Promise<void> {
  return async (threadId: string, runId: string): Promise<void> => {
    if (threadId === '') {
      logger.info({runId}, 'cancelRun: no thread_id on run-state — skipping cancellation notice')
      return
    }
    try {
      const channel = await client.channels.fetch(threadId)
      if (channel === null || channel === undefined) {
        logger.warn({runId, threadId}, 'cancelRun: thread channel not found — skipping cancellation notice')
        return
      }
      if (channel.isTextBased() === false || 'send' in channel === false) {
        logger.warn(
          {runId, threadId},
          'cancelRun: resolved channel is not text-sendable — skipping cancellation notice',
        )
        return
      }
      const sendResult = await sendMessage(channel, {content: CANCELLED_NOTICE_TEXT}, logger)
      if (sendResult.success === false) {
        logger.warn({runId, threadId, err: sendResult.error.message}, 'cancelRun: cancellation notice send failed')
      }
    } catch (error: unknown) {
      // sendMessage/io.ts never throws, but channels.fetch can — belt-and-suspenders.
      logger.warn(
        {runId, threadId, err: error instanceof Error ? error.message : String(error)},
        'cancelRun: cancellation notice threw — continuing',
      )
    }
  }
}
