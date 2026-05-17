import type {ChatInputCommandInteraction} from 'discord.js'
import type {SlashCommand} from './index.js'

import {SlashCommandBuilder} from 'discord.js'
import {Effect} from 'effect'

/**
 * `/fro-bot ping` — smoke-test command.
 * Responds with an ephemeral "pong" reply.
 */
const pingCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('fro-bot')
    .setDescription('fro-bot commands')
    .addSubcommand(sub => sub.setName('ping').setDescription('Check if fro-bot is alive')) as SlashCommandBuilder,

  execute: (interaction: ChatInputCommandInteraction): Effect.Effect<void, Error> =>
    Effect.tryPromise({
      try: async () => interaction.reply({content: 'pong', ephemeral: true}),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(Effect.asVoid),
}

export default pingCommand
