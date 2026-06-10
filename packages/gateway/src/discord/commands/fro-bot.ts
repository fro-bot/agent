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
 * - `force-release-lock` — dead-run-verified force-release of a stuck per-repo lock
 */

import type {CoordinationConfig, ForceReleaseStaleLockResult} from '@fro-bot/runtime'
import type {ChatInputCommandInteraction} from 'discord.js'
import type {ChannelQueue} from '../../execute/queue.js'
import type {RunTask} from '../../execute/run.js'
import type {CoordinationLogger} from '../../runtime-effect.js'
import type {GatewayLogger} from '../client.js'
import type {AddProjectDeps} from './add-project.js'
import type {SlashCommand} from './index.js'

import {PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
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
 * subcommand can drop pending tasks for the invoking channel, and with
 * coordination deps so the `force-release-lock` subcommand can call the
 * dead-run-verified force-release primitive.
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
  /**
   * Pre-built coordination config for the `force-release-lock` subcommand.
   * Assembled by `makeCoordinationConfig(s3Adapter, config)` in program.ts.
   */
  readonly coordinationConfig: CoordinationConfig
  /**
   * Run-state owner identity (the gateway identity, e.g. `'discord-gateway'`).
   * Passed to `forceReleaseStaleLock` so it reads run-state under the correct
   * identity segment — distinct from the lock key's `COORDINATION_IDENTITY`.
   */
  readonly identity: string
  /**
   * Dead-run-verified force-release primitive (injected for testability).
   * In production this is `forceReleaseStaleLockEffect` from `runtime-effect.ts`.
   * Tests inject a mock returning `Effect.succeed(result)` to avoid real S3 calls.
   */
  readonly forceReleaseStaleLock: (
    config: CoordinationConfig,
    repo: string,
    identity: string,
    logger: CoordinationLogger,
  ) => Effect.Effect<ForceReleaseStaleLockResult, Error>
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
    )
    .addSubcommand(sub =>
      sub
        .setName('force-release-lock')
        .setDescription(
          'Force-release a stuck per-repo coordination lock (dead-run-verified; requires ManageChannels)',
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

    if (subcommand === 'clear-queue') {
      return executeClearQueue(interaction, deps)
    }

    if (subcommand === 'force-release-lock') {
      return executeForceReleaseLock(interaction, deps)
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
      // Guard is synchronous (no await before it) so a plain reply is safe here
      // — we haven't consumed the 3 s interaction window yet.
      const guild = interaction.guild
      if (guild === null) {
        await interaction.reply({
          content: 'This command must be used in a server.',
          ephemeral: true,
        })
        return
      }

      // Defer immediately — userIsAuthorized calls guild.members.fetch() (REST) which
      // can exceed Discord's 3 s interaction-token window under latency. Deferring here
      // acks the interaction before any await, matching the add-project pattern.
      await interaction.deferReply({ephemeral: true})

      const authorized = await userIsAuthorized(guild, interaction.user.id, deps.triggerRoleId, deps.gatewayLogger)
      if (authorized === false) {
        await interaction.editReply({
          content: 'You do not have permission to clear the queue.',
        })
        return
      }

      const channelId = interaction.channelId
      const dropped = deps.queue.clear(channelId)
      await interaction.editReply({
        content: `Cleared ${dropped} queued task(s). The running task will finish.`,
      })
    },
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })
}

// ---------------------------------------------------------------------------
// force-release-lock handler
// ---------------------------------------------------------------------------

/**
 * Handler for the `/fro-bot force-release-lock` subcommand.
 *
 * **Raised authorization bar:** requires guild-level `ManageChannels` — NOT
 * the configured trigger role. Lock deletion is a destructive cross-run action
 * (can reopen concurrent execution and can target another user's run), so the
 * trigger-role-only gate is insufficient. Authorization is checked via a direct
 * `guild.members.fetch()` + `permissions.has(ManageChannels)` call (fail-closed),
 * chosen to require ManageChannels specifically and deny trigger-role-only users
 * — without depending on `userIsAuthorized`'s fallback logic.
 *
 * Flow: synchronous null-guild guard → deferReply → ManageChannels auth →
 * binding lookup → forceReleaseStaleLock → editReply with typed outcome.
 *
 * All replies are ephemeral. `allowedMentions: {parse: []}` is applied where
 * user-controlled content (holder IDs) appears in the reply.
 */
function executeForceReleaseLock(
  interaction: ChatInputCommandInteraction,
  deps: FroBotDeps,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    // Fail closed: command must be used inside a server (guild).
    // Guard is synchronous (no await before it) so a plain reply is safe here
    // — we haven't consumed the 3 s interaction window yet.
    const guild = interaction.guild
    if (guild === null) {
      yield* Effect.tryPromise({
        try: async () =>
          interaction.reply({
            content: 'This command must be used in a server.',
            ephemeral: true,
          }),
        catch: error => (error instanceof Error ? error : new Error(String(error))),
      })
      return
    }

    // Defer immediately — guild.members.fetch() (REST) inside the auth check
    // can exceed Discord's 3 s interaction-token window under latency.
    yield* Effect.tryPromise({
      try: async () => interaction.deferReply({ephemeral: true}),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })

    // Raised auth bar: ManageChannels required, NOT the trigger role.
    // Direct guild.members.fetch() + permissions.has(ManageChannels) check (fail-closed).
    // A trigger-role-only user is denied even when a trigger role is configured
    // — the correct behavior for this destructive command.
    const member = yield* Effect.tryPromise({
      try: async () =>
        guild.members.fetch(interaction.user.id).catch((error: unknown) => {
          deps.gatewayLogger.warn(
            {
              channelId: interaction.channelId,
              err: error instanceof Error ? error.message : String(error),
            },
            'force-release-lock: member permission resolution failed — denying',
          )
          return null
        }),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })
    if (member === null || member.permissions.has(PermissionFlagsBits.ManageChannels) === false) {
      yield* Effect.tryPromise({
        try: async () =>
          interaction.editReply({
            content: 'You do not have permission to force-release a lock (ManageChannels required).',
          }),
        catch: error => (error instanceof Error ? error : new Error(String(error))),
      })
      return
    }

    // Resolve the repo binding for this channel.
    const channelId = interaction.channelId
    const bindingResult = yield* Effect.tryPromise({
      try: async () => deps.bindingsStore.getBindingByChannelId(channelId),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })
    if (bindingResult.success === false) {
      deps.gatewayLogger.error({channelId, err: bindingResult.error.message}, 'force-release-lock: binding store error')
      yield* Effect.tryPromise({
        try: async () =>
          interaction.editReply({
            content: 'Something went wrong looking up this channel. Please try again.',
          }),
        catch: error => (error instanceof Error ? error : new Error(String(error))),
      })
      return
    }

    if (bindingResult.data === null) {
      yield* Effect.tryPromise({
        try: async () =>
          interaction.editReply({
            content: 'No repo is bound to this channel. Use `/fro-bot add-project` first.',
          }),
        catch: error => (error instanceof Error ? error : new Error(String(error))),
      })
      return
    }

    const {owner, repo} = bindingResult.data
    const repoSlug = `${owner}/${repo}`

    // Narrow logger adapter — runtime coordination functions take a narrow
    // {debug} logger; adapt the gateway logger inline (same pattern as run.ts).
    const coordLogger: CoordinationLogger = {
      debug: (msg: string, ctx?: Record<string, unknown>) => deps.gatewayLogger.debug(ctx ?? {}, msg),
    }

    // Call the dead-run-verified force-release Effect.
    // Pass deps.identity (the gateway identity) so run-state is read under the correct key.
    const releaseResult = yield* deps.forceReleaseStaleLock(
      deps.coordinationConfig,
      repoSlug,
      deps.identity,
      coordLogger,
    )

    const {outcome, holderId, lockAgeMs, heartbeatAgeMs} = releaseResult

    // Map typed outcome → ephemeral reply.
    // allowedMentions: {parse: []} prevents Discord from pinging holder IDs.
    switch (outcome) {
      case 'released': {
        const ageSeconds = lockAgeMs === null ? null : Math.round(lockAgeMs / 1000)
        const holderInfo = holderId === null ? '' : ` Cleared holder: \`${holderId}\`.`
        const ageInfo = ageSeconds === null ? '' : ` Lock age: ${ageSeconds}s.`
        yield* Effect.tryPromise({
          try: async () =>
            interaction.editReply({
              content: `✅ Lock released for \`${repoSlug}\`.${holderInfo}${ageInfo}`,
              allowedMentions: {parse: []},
            }),
          catch: error => (error instanceof Error ? error : new Error(String(error))),
        })
        break
      }

      case 'live-holder': {
        const ageSeconds = lockAgeMs === null ? null : Math.round(lockAgeMs / 1000)
        const heartbeatSeconds = heartbeatAgeMs === null ? null : Math.round(heartbeatAgeMs / 1000)
        const holderInfo = holderId === null ? '' : ` Held by: \`${holderId}\`.`
        const ageInfo = ageSeconds === null ? '' : ` Lock age: ${ageSeconds}s.`
        const heartbeatInfo = heartbeatSeconds === null ? '' : ` Last heartbeat: ${heartbeatSeconds}s ago.`
        yield* Effect.tryPromise({
          try: async () =>
            interaction.editReply({
              content: `🔒 Lock for \`${repoSlug}\` is held by an active run — not released.${holderInfo}${ageInfo}${heartbeatInfo}`,
              allowedMentions: {parse: []},
            }),
          catch: error => (error instanceof Error ? error : new Error(String(error))),
        })
        break
      }

      case 'no-lock': {
        yield* Effect.tryPromise({
          try: async () =>
            interaction.editReply({
              content: `ℹ️ No lock found for \`${repoSlug}\` — nothing to release.`,
              allowedMentions: {parse: []},
            }),
          catch: error => (error instanceof Error ? error : new Error(String(error))),
        })
        break
      }

      case 'conflict': {
        yield* Effect.tryPromise({
          try: async () =>
            interaction.editReply({
              content: `⚠️ The lock for \`${repoSlug}\` changed just now (re-acquired between read and delete). Try again.`,
              allowedMentions: {parse: []},
            }),
          catch: error => (error instanceof Error ? error : new Error(String(error))),
        })
        break
      }

      case 'error': {
        yield* Effect.tryPromise({
          try: async () =>
            interaction.editReply({
              content: `❌ An error occurred while checking the lock for \`${repoSlug}\`. Please try again.`,
              allowedMentions: {parse: []},
            }),
          catch: error => (error instanceof Error ? error : new Error(String(error))),
        })
        break
      }

      default: {
        // Exhaustiveness guard — TypeScript will catch unhandled outcomes at compile time.
        const exhaustiveCheck: never = outcome
        deps.gatewayLogger.error({outcome: exhaustiveCheck, repo: repoSlug}, 'force-release-lock: unhandled outcome')
        yield* Effect.tryPromise({
          try: async () =>
            interaction.editReply({
              content: 'An internal error occurred. Please try again.',
            }),
          catch: error => (error instanceof Error ? error : new Error(String(error))),
        })
      }
    }
  })
}
