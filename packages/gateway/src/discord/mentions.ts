import type {Message} from 'discord.js'

import {Effect} from 'effect'

/**
 * Handle a direct `@fro-bot` mention in a guild channel.
 *
 * Behaviour:
 * - If the message is already inside a thread → skip (log and return).
 * - If the bot user is not actually mentioned (e.g. reply-chain only) → skip.
 * - Otherwise: create a thread on the message and reply "pong" inside it.
 *
 * Thread naming is intentionally minimal for v1 ("fro-bot session").
 * Proper session-aware naming arrives in Unit 6.
 */
export function handleMention(message: Message, botUserId: string): Effect.Effect<void, Error> {
  // Skip if already in a thread
  if (message.channel.isThread()) {
    return Effect.void
  }

  // Skip if bot is not actually mentioned (e.g. reply-chain only)
  if (!message.mentions.has(botUserId)) {
    return Effect.void
  }

  return Effect.tryPromise({
    try: async () => {
      const thread = await message.startThread({name: 'fro-bot session'})
      await thread.send('pong')
    },
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })
}
