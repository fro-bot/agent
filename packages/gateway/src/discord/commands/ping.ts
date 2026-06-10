import type {ChatInputCommandInteraction} from 'discord.js'
import type {GatewayLogger} from '../client.js'

import {Effect} from 'effect'

import {replyInteraction} from '../io.js'

// ---------------------------------------------------------------------------
// Minimal no-op logger for ping — ping has no injected logger dep.
// The helper requires a GatewayLogger; ping failures are best-effort.
// ---------------------------------------------------------------------------

const PING_LOGGER: GatewayLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/**
 * Handler for the `/fro-bot ping` subcommand.
 * Responds with an ephemeral "pong" reply.
 */
export function executePing(interaction: ChatInputCommandInteraction): Effect.Effect<void, Error> {
  return replyInteraction(interaction, {content: 'pong', ephemeral: true}, PING_LOGGER).pipe(Effect.asVoid)
}
