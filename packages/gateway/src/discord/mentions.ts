/**
 * Discord mention router — handles `@fro-bot` mentions in guild channels.
 *
 * Responsibility boundary:
 * - Early guards: skip if message is in a thread, or if bot is not actually mentioned.
 * - Trigger authorization gate: resolve the invoking member via REST and check the
 *   configured trigger role (or guild-level ManageChannels as fallback).
 * - Binding lookup: resolve the repo binding for the source channel.
 * - Hand off to `runMention` in `execute/run.ts` for the full execution lifecycle.
 *
 * Security invariants (MUST NOT be weakened):
 * - Authorization gate uses `guild.members.fetch()` (REST) not `members.cache.get()`
 *   (which returns undefined without the GuildMembers privileged intent — documented
 *   false-negative trap). Fail CLOSED: any fetch/permission error → deny.
 * - Unauthorized → terminal "not authorized" reply, no further work.
 * - Every Discord send routes through `safeReply` which enforces
 *   `allowedMentions: { parse: [] }`.
 * - No internal detail (error messages, IDs, paths) is ever posted to Discord.
 */

import type {Result} from '@fro-bot/runtime'
import type {Guild, Message} from 'discord.js'

import type {BindingsStore} from '../bindings/store.js'
import type {RunMentionDeps} from '../execute/run.js'
import type {ReadyzResponse, WorkspaceError} from '../workspace-api/types.js'
import type {GatewayLogger} from './client.js'
import {PermissionFlagsBits} from 'discord.js'
import {Effect} from 'effect'

import {runMention} from '../execute/run.js'

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface MentionDeps {
  /** Bindings store for channel → repo resolution. */
  readonly bindingsStore: BindingsStore
  /**
   * Discord role ID that confers trigger authorization.
   *
   * - If set: invoking member must have this role.
   * - If `null`: invoking member must have guild-level `ManageChannels`.
   */
  readonly triggerRoleId: string | null
  /** Run-lifecycle deps forwarded verbatim to `runMention`. */
  readonly run: RunMentionDeps
  readonly logger: GatewayLogger
  /**
   * Workspace readiness check. Called after binding lookup, before runMention.
   * Injected so tests can stub it without a live workspace.
   *
   * Fail-closed: any error result or thrown exception → treat as not-ready.
   */
  readonly readyz: () => Promise<Result<ReadyzResponse, WorkspaceError>>
}

// ---------------------------------------------------------------------------
// Internal Discord send helper — ALL replies route through here.
// ---------------------------------------------------------------------------

async function safeReply(message: Message, content: string): Promise<void> {
  await message.reply({content, allowedMentions: {parse: []}})
}

// ---------------------------------------------------------------------------
// Authorization gate
// ---------------------------------------------------------------------------

/**
 * Resolve whether the invoking user is authorized to trigger an execution.
 *
 * Uses `guild.members.fetch()` (REST call) — NOT `members.cache.get()` — to
 * guarantee correct resolution regardless of intent configuration.
 * Fails CLOSED: any resolution error returns `false`.
 *
 * Exported so program.ts can reuse the same auth gate for button interactions.
 */
export async function userIsAuthorized(
  guild: Guild,
  userId: string,
  triggerRoleId: string | null,
  logger: GatewayLogger,
): Promise<boolean> {
  try {
    // REST call — works without the privileged GuildMembers intent.
    // Do NOT use guild.members.cache.get() — returns undefined without the intent.
    const member = await guild.members.fetch(userId)

    if (triggerRoleId !== null) {
      return member.roles.cache.has(triggerRoleId)
    }

    // Fallback: guild-level ManageChannels (no channel overwrites — mirrors add-project.ts).
    return member.permissions.has(PermissionFlagsBits.ManageChannels)
  } catch (error) {
    // Fail closed: if we cannot resolve member permissions, deny.
    logger.warn(
      {err: error instanceof Error ? error.message : String(error)},
      'mention: member permission resolution failed — denying',
    )
    return false
  }
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

/**
 * Handle a direct `@fro-bot` mention in a guild channel.
 *
 * Returns an `Effect` so the caller (program.ts) can handle failures uniformly.
 * Internal errors are logged; coarse user-visible messages are posted to Discord.
 */
export function handleMention(message: Message, botUserId: string, deps: MentionDeps): Effect.Effect<void, Error> {
  const {bindingsStore, triggerRoleId, run: runDeps, logger, readyz} = deps

  // ── Guard 1: Skip if already in a thread ────────────────────────────────
  if (message.channel.isThread()) {
    return Effect.void
  }

  // ── Guard 2: Skip if bot is not actually mentioned (reply-chain only) ────
  if (message.mentions.has(botUserId) === false) {
    return Effect.void
  }

  return Effect.tryPromise({
    try: async () => {
      // ── Step 2: Trigger authorization gate ──────────────────────────────
      // Guild is always present for guild channel messages; narrowing is defensive.
      const guild = message.guild
      if (guild === null) {
        logger.warn({}, 'mention: guild is null — skipping (DM or uncached guild)')
        return
      }

      const authorized = await userIsAuthorized(guild, message.author.id, triggerRoleId, logger)
      if (authorized === false) {
        logger.info({userId: message.author.id}, 'mention: unauthorized user')
        await safeReply(message, 'You are not authorized to run tasks here.')
        return
      }

      // ── Step 3: Binding lookup ───────────────────────────────────────────
      const bindingResult = await bindingsStore.getBindingByChannelId(message.channel.id)

      if (bindingResult.success === false) {
        // Store error — fail safely without leaking internal details.
        logger.error({channelId: message.channel.id, err: bindingResult.error.message}, 'mention: binding store error')
        await safeReply(message, 'Something went wrong looking up this channel. Please try again.')
        return
      }

      if (bindingResult.data === null) {
        // No binding — channel not connected to a repo.
        await safeReply(message, 'This channel is not bound to a repository. Use `/fro-bot add-project` first.')
        return
      }

      const binding = bindingResult.data
      logger.info({channelId: message.channel.id, repo: `${binding.owner}/${binding.repo}`}, 'mention: binding found')

      // ── Step 4: Workspace readiness gate ────────────────────────────────
      // Fail-closed: any error result or thrown exception → treat as not-ready.
      // This prevents creating a thread, acquiring a lock, or creating run-state
      // for a workspace that is not yet serving OpenCode.
      let workspaceReady = false
      try {
        const readyzResult = await readyz()
        workspaceReady = readyzResult.success === true && readyzResult.data.ready === true
      } catch {
        // Thrown exception (e.g. timeout) → fail closed
        workspaceReady = false
      }

      if (workspaceReady === false) {
        logger.warn(
          {channelId: message.channel.id, repo: `${binding.owner}/${binding.repo}`},
          'mention: workspace not ready — aborting',
        )
        await safeReply(message, 'The workspace is not reachable right now. Please try again later.')
        return
      }

      // ── Steps 5–11: Execution lifecycle (concurrency + lock + run-state) ─
      await runMention(message, binding, runDeps)
    },
    catch: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  })
}
