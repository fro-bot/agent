import type {ChatInputCommandInteraction, Client, SlashCommandBuilder} from 'discord.js'
import {REST, Routes} from 'discord.js'
import {Effect} from 'effect'

import pingCommand from './ping.js'

export interface SlashCommand {
  readonly data: SlashCommandBuilder
  readonly execute: (interaction: ChatInputCommandInteraction) => Effect.Effect<void, Error>
}

/**
 * Returns the full registry of registered slash commands.
 */
export function getCommandRegistry(): SlashCommand[] {
  return [pingCommand]
}

/**
 * Find the matching command in the registry and run it.
 * Returns Effect.fail if no command matches.
 */
export function dispatchCommand(
  interaction: ChatInputCommandInteraction,
  registry: SlashCommand[],
): Effect.Effect<void, Error> {
  const commandName = interaction.commandName
  const command = registry.find(c => c.data.name === commandName)

  if (command === undefined) {
    return Effect.fail(new Error(`Unknown command: ${commandName}`))
  }

  return command.execute(interaction)
}

/**
 * Register slash commands via Discord REST API.
 * - Guild-scoped when `guildId` is provided (instant propagation, good for dev).
 * - Global when `guildId` is null (up to 1h propagation, for production).
 */
export async function registerSlashCommands(
  client: Client,
  applicationId: string,
  guildId: string | null,
  registry: SlashCommand[],
): Promise<void> {
  const token = (client as unknown as {_pendingToken?: string; token?: string | null})._pendingToken ?? client.token

  if (token === null || token === undefined) {
    throw new Error('Discord client has no token — call createDiscordClient with a token before registering commands')
  }

  const rest = new REST().setToken(token)
  const body = registry.map(cmd => cmd.data.toJSON())

  if (guildId === null) {
    await rest.put(Routes.applicationCommands(applicationId), {body})
  } else {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {body})
  }
}
