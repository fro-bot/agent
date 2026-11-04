/**
 * Discord transport for the cancellation notice injected into `cancelRun`
 * (`execute/cancel.ts`) via `CancelRunDeps.postCancelNotice`.
 *
 * `createCancelNoticeDispatcher` returns a `(threadId, runId, actor) => Promise<void>`
 * callback that resolves the run's thread and posts the cancellation
 * message naming the actor. Always fail-soft: never throws, and every failure mode is logged,
 * not propagated — the cancellation outcome never depends on this succeeding.
 */

import type {Client} from 'discord.js'
import type {CancelActorContext} from '../execute/cancel.js'
import type {GatewayLogger} from './client.js'
import {toErrorMessage} from '@fro-bot/runtime'
import {sendMessage} from './io.js'

/**
 * Cancellation notice text for a run's origin thread, naming who cancelled it: a user mention for a Discord actor,
 * the GitHub login for a web operator. `sendMessage` always sends `allowedMentions: {parse: []}`, so the mention
 * renders without notifying anyone.
 */
export function formatCancelNotice(actor: CancelActorContext): string {
  return actor.kind === 'discord-user'
    ? `Run cancelled by <@${actor.discordUserId}>.`
    : `Run cancelled by operator ${actor.login}.`
}

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
): (threadId: string, runId: string, actor: CancelActorContext) => Promise<void> {
  return async (threadId: string, runId: string, actor: CancelActorContext): Promise<void> => {
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
      const sendResult = await sendMessage(channel, {content: formatCancelNotice(actor)}, logger)
      if (sendResult.success === false) {
        logger.warn({runId, threadId, err: sendResult.error.message}, 'cancelRun: cancellation notice send failed')
      }
    } catch (error: unknown) {
      // sendMessage/io.ts never throws, but channels.fetch can — belt-and-suspenders.
      logger.warn({runId, threadId, err: toErrorMessage(error)}, 'cancelRun: cancellation notice threw — continuing')
    }
  }
}
