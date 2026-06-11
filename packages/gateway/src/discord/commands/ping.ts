import type {ChatInputCommandInteraction} from 'discord.js'

import {Effect} from 'effect'

import {CONSOLE_GATEWAY_LOGGER, withLogContext} from '../client.js'
import {replyInteraction} from '../io.js'

const pingLogger = withLogContext(CONSOLE_GATEWAY_LOGGER, {command: 'ping'})

/**
 * Handler for the `/fro-bot ping` subcommand.
 * Responds with an ephemeral "pong" reply.
 *
 * Return type is `Effect<void, never>` because `replyInteraction` never fails
 * the Effect channel — Discord API errors are caught and returned as a Result
 * inside the Effect. `Effect.asVoid` discards the Result, leaving `never` in
 * the error channel.
 */
export function executePing(interaction: ChatInputCommandInteraction): Effect.Effect<void, never> {
  return replyInteraction(interaction, {content: 'pong', ephemeral: true}, pingLogger).pipe(Effect.asVoid)
}
