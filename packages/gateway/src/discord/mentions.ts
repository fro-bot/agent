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
  }).pipe(
    Effect.catchAll(threadError =>
      Effect.gen(function* () {
        console.warn(
          JSON.stringify({level: 'warn', msg: 'handleMention: startThread failed', err: String(threadError)}),
        )
        yield* Effect.tryPromise({
          try: async () => message.react('❌'),
          catch: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.tapError(err =>
            Effect.sync(() => {
              console.warn(JSON.stringify({level: 'warn', msg: 'handleMention: react failed', err: String(err)}))
            }),
          ),
          Effect.catchAll(() => Effect.void),
        )
        yield* Effect.tryPromise({
          try: async () =>
            message.reply({content: 'Could not start a session here — please try again or check channel permissions.'}),
          catch: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.tapError(err =>
            Effect.sync(() => {
              console.warn(
                JSON.stringify({level: 'warn', msg: 'handleMention: fallback reply failed', err: String(err)}),
              )
            }),
          ),
          // Defense-in-depth: the inner Effect.catchAll branches above already
          // swallow react and reply rejections, so this outer catchAll should
          // never fire. Kept defensively in case a future refactor changes the
          // inner shape — it ensures the fallback chain can never re-fail the
          // outer Effect with a non-original error.
          Effect.catchAll(() => Effect.void),
        )
        return yield* Effect.fail(threadError)
      }),
    ),
  )
}
