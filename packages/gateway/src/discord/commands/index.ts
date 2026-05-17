import type {ChatInputCommandInteraction, SlashCommandBuilder} from 'discord.js'
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
 *
 * When the command name is not in the registry, the interaction is
 * acknowledged with an ephemeral reply BEFORE the Effect fails. Discord
 * gives interaction tokens a 3-second response window; without an ack the
 * user sees "This interaction failed" even though our handler logged the
 * error correctly. Common cause: a stale global command that was removed
 * from the registry but still exists in Discord, or an interaction from
 * another bot in the same guild reaching this dispatcher.
 *
 * If the ack itself fails (e.g. token already expired) we swallow that
 * inner error so the outer caller still sees the original "unknown
 * command" failure, not a misleading reply-failed message.
 */
export function dispatchCommand(
  interaction: ChatInputCommandInteraction,
  registry: SlashCommand[],
): Effect.Effect<void, Error> {
  const commandName = interaction.commandName
  const command = registry.find(c => c.data.name === commandName)

  if (command === undefined) {
    return Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () =>
          interaction.reply({
            content: `Unknown command: \`${commandName}\``,
            ephemeral: true,
          }),
        catch: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.tapError(err =>
          Effect.sync(() => {
            // TODO(future): plumb a logger Effect.Service through dispatchCommand so
            // we can stop using bare console.warn here. The unknown-command ack path
            // is the only place in the gateway that does this; eliminating it
            // completes the structured-logging story.
            // Log the ack failure but don't propagate it — the unknown-command error
            // is the meaningful signal for the caller. We can't pass a logger Effect.Service
            // through dispatchCommand without changing its signature, so use console.warn
            // directly here. This is the only place in dispatchCommand that does so.

            console.warn(
              JSON.stringify({level: 'warn', msg: 'ack failed for unknown command', commandName, err: String(err)}),
            )
          }),
        ),
        Effect.catchAll(() => Effect.void),
      )
      return yield* Effect.fail(new Error(`Unknown command: ${commandName}`))
    })
  }

  return command.execute(interaction)
}

/**
 * Register slash commands via Discord REST API.
 *
 * `token` must be passed explicitly. The client's `.token` field is null
 * until `client.login()` resolves, and slash-command registration runs
 * BEFORE login in the gateway boot sequence — passing the token as a plain
 * parameter avoids coupling this module to a stale third-party-private
 * field on the Client object.
 *
 * - Guild-scoped when `guildId` is provided (instant propagation, good for dev).
 * - Global when `guildId` is null (up to 1h propagation, for production).
 */
export async function registerSlashCommands(
  token: string,
  applicationId: string,
  guildId: string | null,
  registry: SlashCommand[],
): Promise<void> {
  const rest = new REST().setToken(token)
  const body = registry.map(cmd => cmd.data.toJSON())

  if (guildId === null) {
    await rest.put(Routes.applicationCommands(applicationId), {body})
  } else {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {body})
  }
}
