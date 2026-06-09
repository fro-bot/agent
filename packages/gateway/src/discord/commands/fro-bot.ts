/**
 * `/fro-bot` parent slash command factory.
 *
 * Owns the SlashCommandBuilder with all subcommands and dispatches to the
 * appropriate subcommand handler based on `interaction.options.getSubcommand()`.
 *
 * Subcommands:
 * - `ping` — smoke-test; responds with ephemeral "pong"
 * - `add-project` — bind a GitHub repo to a Discord channel
 * - `clear-queue` — drop pending queued tasks for the invoking channel
 */

import type {ChatInputCommandInteraction} from 'discord.js'
import type {ChannelQueue} from '../../execute/queue.js'
import type {RunTask} from '../../execute/run.js'
import type {AddProjectDeps} from './add-project.js'
import type {SlashCommand} from './index.js'

import {SlashCommandBuilder} from 'discord.js'
import {Effect} from 'effect'

import {executeAddProject} from './add-project.js'
import {executePing} from './ping.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dependencies for the `/fro-bot` parent command.
 *
 * Extends `AddProjectDeps` with the per-channel queue so the `clear-queue`
 * subcommand can drop pending tasks for the invoking channel.
 */
export interface FroBotDeps extends AddProjectDeps {
  /** Per-channel FIFO queue — the same instance used by the run path. */
  readonly queue: ChannelQueue<RunTask>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the `/fro-bot` parent command with injected dependencies.
 *
 * The `deps` parameter is captured in the execute closure and passed directly
 * to `executeAddProject` and `executeClearQueue`. No module-global state is used.
 */
export function createFroBotCommand(deps: FroBotDeps): SlashCommand {
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
    )
    .addSubcommand(sub =>
      sub
        .setName('clear-queue')
        .setDescription('Drop pending queued tasks for this channel (in-flight run unaffected)'),
    ) as SlashCommandBuilder

  const execute = (interaction: ChatInputCommandInteraction): Effect.Effect<void, Error> => {
    const subcommand = interaction.options.getSubcommand(true)

    if (subcommand === 'ping') {
      return executePing(interaction)
    }

    if (subcommand === 'add-project') {
      return executeAddProject(interaction, deps)
    }

    if (subcommand === 'clear-queue') {
      return executeClearQueue(interaction, deps.queue)
    }

    return Effect.fail(new Error(`Unknown subcommand: ${subcommand}`))
  }

  return {data, execute}
}

// ---------------------------------------------------------------------------
// clear-queue handler
// ---------------------------------------------------------------------------

/**
 * Handler for the `/fro-bot clear-queue` subcommand.
 *
 * Drops all pending queued tasks for the invoking channel and replies
 * ephemerally with the count dropped. The in-flight run (if any) is
 * unaffected — it holds the concurrency slot, not the queue.
 */
function executeClearQueue(
  interaction: ChatInputCommandInteraction,
  queue: ChannelQueue<RunTask>,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      const channelId = interaction.channelId
      const dropped = queue.clear(channelId)
      await interaction.reply({
        content: `Cleared ${dropped} queued task(s). The running task will finish.`,
        ephemeral: true,
      })
    },
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })
}
