import type {ChatInputCommandInteraction} from 'discord.js'

import {Effect} from 'effect'

/**
 * Handler for the `/fro-bot ping` subcommand.
 * Responds with an ephemeral "pong" reply.
 */
export function executePing(interaction: ChatInputCommandInteraction): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => interaction.reply({content: 'pong', ephemeral: true}),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.asVoid)
}
