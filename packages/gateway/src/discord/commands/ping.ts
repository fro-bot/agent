import type {ChatInputCommandInteraction} from 'discord.js'

import {Effect} from 'effect'

import {CONSOLE_GATEWAY_LOGGER} from '../client.js'
import {replyInteraction} from '../io.js'

/**
 * Handler for the `/fro-bot ping` subcommand.
 * Responds with an ephemeral "pong" reply.
 */
export function executePing(interaction: ChatInputCommandInteraction): Effect.Effect<void, Error> {
  return replyInteraction(interaction, {content: 'pong', ephemeral: true}, CONSOLE_GATEWAY_LOGGER).pipe(Effect.asVoid)
}
