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
import type {GatewayLogger} from '../client.js'
import type {AddProjectDeps} from './add-project.js'
import type {SlashCommand} from './index.js'

import {SlashCommandBuilder} from 'discord.js'
import {Effect} from 'effect'

import {userIsAuthorized} from '../mentions.js'
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
  /**
   * Discord role ID that confers trigger authorization.
   * Mirrors the same field in `MentionDeps` — used by `clear-queue` to apply
   * the same auth gate as the mention path (trigger role OR guild ManageChannels).
   * `null` → fall back to guild-level ManageChannels.
   */
  readonly triggerRoleId: string | null
  /** Gateway-scoped logger (context-first) for auth-gate resolution errors. */
  readonly gatewayLogger: GatewayLogger
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
      return executeClearQueue(interaction, deps)
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
 * Authorization-gated: only users who pass the same authority check as the
 * mention path (trigger role OR guild-level ManageChannels) may clear the queue.
 * Fail closed: null guild or auth resolution failure → deny.
 *
 * Drops all pending queued tasks for the invoking channel and replies
 * ephemerally with the count dropped. The in-flight run (if any) is
 * unaffected — it holds the concurrency slot, not the queue.
 */
function executeClearQueue(interaction: ChatInputCommandInteraction, deps: FroBotDeps): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      // Fail closed: command must be used inside a server (guild).
      const guild = interaction.guild
      if (guild === null) {
        await interaction.reply({
          content: 'This command must be used in a server.',
          ephemeral: true,
        })
        return
      }

      const authorized = await userIsAuthorized(guild, interaction.user.id, deps.triggerRoleId, deps.gatewayLogger)
      if (authorized === false) {
        await interaction.reply({
          content: 'You do not have permission to clear the queue.',
          ephemeral: true,
        })
        return
      }

      const channelId = interaction.channelId
      const dropped = deps.queue.clear(channelId)
      await interaction.reply({
        content: `Cleared ${dropped} queued task(s). The running task will finish.`,
        ephemeral: true,
      })
    },
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })
}
