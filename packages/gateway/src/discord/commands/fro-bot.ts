/**
 * `/fro-bot` parent slash command factory.
 *
 * Owns the SlashCommandBuilder with all subcommands and dispatches to the
 * appropriate subcommand handler based on `interaction.options.getSubcommand()`.
 *
 * Subcommands:
 * - `ping` — smoke-test; responds with ephemeral "pong"
 * - `add-project` — bind a GitHub repo to a Discord channel
 */

import type {ChatInputCommandInteraction} from 'discord.js'
import type {AddProjectDeps} from './add-project.js'
import type {SlashCommand} from './index.js'

import {SlashCommandBuilder} from 'discord.js'
import {Effect} from 'effect'

import {executeAddProject} from './add-project.js'
import {executePing} from './ping.js'

/**
 * Create the `/fro-bot` parent command with injected dependencies.
 *
 * The `deps` parameter is captured in the execute closure and passed directly
 * to `executeAddProject`. No module-global state is used.
 */
export function createFroBotCommand(deps: AddProjectDeps): SlashCommand {
  const data = new SlashCommandBuilder()
    .setName('fro-bot')
    .setDescription('fro-bot commands')
    .addSubcommand(sub => sub.setName('ping').setDescription('Check if fro-bot is alive'))
    .addSubcommand(sub =>
      sub
        .setName('add-project')
        .setDescription('Bind a GitHub repo to a Discord channel')
        .addStringOption(opt =>
          opt.setName('url').setDescription('GitHub repo URL (https://github.com/owner/repo)').setRequired(true),
        )
        .addStringOption(opt =>
          opt
            .setName('channel')
            .setDescription('Optional Discord channel name (auto-derived from repo if omitted)')
            .setRequired(false),
        ),
    ) as SlashCommandBuilder

  const execute = (interaction: ChatInputCommandInteraction): Effect.Effect<void, Error> => {
    const subcommand = interaction.options.getSubcommand(true)

    if (subcommand === 'ping') {
      return executePing(interaction)
    }

    if (subcommand === 'add-project') {
      return executeAddProject(interaction, deps)
    }

    return Effect.fail(new Error(`Unknown subcommand: ${subcommand}`))
  }

  return {data, execute}
}
