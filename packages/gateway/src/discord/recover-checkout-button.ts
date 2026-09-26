/**
 * Recover-entry button — the one-click Recover button attached to a refusal reply (R3/R7).
 *
 * Pure builders — ZERO side effects, no Discord client, no network. Mirrors `approvals.ts`'s own
 * custom_id codec pattern (namespaced prefix, a 100-char guard).
 *
 * The custom_id identifies ONLY the channel it was posted in — not the owner/repo. Every bound
 * channel maps to exactly one repo binding (the same 1:1 model `discord/mentions.ts` already
 * relies on to resolve a binding from a channel ID), so a channel ID alone is sufficient for Unit
 * 8's click handler to look up the binding — the same way `/fro-bot recover-checkout` itself
 * would. This also sidesteps a real length risk: GitHub repo names can run up to 100 characters,
 * and `prefix + owner(39 max) + repo(100 max) + channelId` would blow well past Discord's 100-char
 * custom_id limit on realistic inputs — a channel-only payload stays small regardless.
 *
 * The custom_id carries NO authority. Unit 8's click handler (`program.ts`) is responsible for
 * re-running the SAME guild-level `ManageChannels` check the `/fro-bot recover-checkout` slash
 * command itself requires, both at click time and again at the 60-second confirmation (R7) — a
 * parsed custom_id is never treated as proof the clicker is authorized.
 */

import {ActionRowBuilder, ButtonBuilder, ButtonStyle} from 'discord.js'

export const RECOVER_ENTRY_PREFIX = 'fb-recover-entry:'

const CUSTOM_ID_MAX = 100

/** The channel identified by a recover-entry button — never an authority claim. */
export interface RecoverEntryData {
  readonly channelId: string
}

/**
 * Builds the custom_id for a recover-entry button.
 *
 * Throws if the encoded id would exceed Discord's 100-char custom_id limit — a defensive guard,
 * never expected to trip for a real Discord channel-ID snowflake.
 */
export function buildRecoverEntryCustomId(data: RecoverEntryData): string {
  const id = `${RECOVER_ENTRY_PREFIX}${data.channelId}`
  if (id.length > CUSTOM_ID_MAX) {
    throw new Error(`Recover-entry custom_id exceeds Discord's 100-char limit (got ${id.length})`)
  }
  return id
}

/**
 * Parses a Discord custom_id back into `RecoverEntryData`.
 *
 * Returns `null` for any non-recover-entry custom_id (safe to call from a generic interaction
 * handler) or a malformed payload (an empty channel ID) — never throws.
 */
export function parseRecoverEntryCustomId(customId: string): RecoverEntryData | null {
  if (typeof customId !== 'string' || !customId.startsWith(RECOVER_ENTRY_PREFIX)) return null

  const channelId = customId.slice(RECOVER_ENTRY_PREFIX.length)
  if (channelId.length === 0) return null

  return {channelId}
}

/**
 * Builds the action row carrying the single Recover button for a refusal reply.
 *
 * Attached ONLY on the Discord transport (`run.ts` gates this on `request.surface === 'discord'`)
 * — a web-launched run has no button surface, and persists `checkoutPreparation` alone.
 */
export function buildRecoverEntryButton(data: RecoverEntryData): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(buildRecoverEntryCustomId(data))
    .setLabel('Recover checkout')
    .setStyle(ButtonStyle.Danger)

  return new ActionRowBuilder<ButtonBuilder>().addComponents(button)
}
