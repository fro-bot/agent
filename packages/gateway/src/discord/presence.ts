/**
 * Presence embed posting for Gateway-announce webhook (RFC-TBD).
 *
 * Resolves a Discord channel by ID and posts a rich embed to it.
 * All failure modes return typed errors — this function NEVER throws and
 * NEVER logs embed/message content.
 *
 * Security note: `allowedMentions: {parse: []}` is MANDATORY on every send
 * call so payload-derived embed text can never trigger an @everyone/role ping,
 * even if the client-global allowedMentions is more permissive.
 */

import type {Result} from '@fro-bot/runtime'
import type {Client} from 'discord.js'

import {err, ok} from '@fro-bot/runtime'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal embed shape accepted by postPresenceEmbed. */
export interface PresenceEmbed {
  readonly title?: string
  readonly description: string
  readonly color?: number
}

/** Discriminated error union for postPresenceEmbed. */
export type PresenceError =
  | {readonly kind: 'channel-not-found'}
  | {readonly kind: 'not-text-channel'}
  | {readonly kind: 'send-failed'; readonly message: string}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve `channelId` via the discord.js `client`, then post `embed` to it.
 *
 * Returns:
 * - `ok(undefined)` on success
 * - `err({kind: 'channel-not-found'})` if the channel cannot be resolved
 * - `err({kind: 'not-text-channel'})` if the channel does not support `.send`
 * - `err({kind: 'send-failed', message})` if the Discord API rejects the send
 */
export async function postPresenceEmbed(
  client: Client,
  channelId: string,
  embed: PresenceEmbed,
): Promise<Result<void, PresenceError>> {
  // #given — resolve the channel
  let channel: Awaited<ReturnType<typeof client.channels.fetch>>
  try {
    channel = await client.channels.fetch(channelId)
  } catch (fetchError) {
    const message = fetchError instanceof Error ? fetchError.message : String(fetchError)
    return err({kind: 'send-failed', message})
  }

  if (channel === null || channel === undefined) {
    return err({kind: 'channel-not-found'})
  }

  // #given — guard that the channel is text-sendable
  if (!channel.isTextBased() || !('send' in channel)) {
    return err({kind: 'not-text-channel'})
  }

  // #when — post the embed
  try {
    await channel.send({
      embeds: [embed],
      // MANDATORY: empty parse list prevents payload-derived text from
      // triggering @everyone / role pings regardless of client-global settings.
      allowedMentions: {parse: []},
    })
  } catch (sendError) {
    const message = sendError instanceof Error ? sendError.message : String(sendError)
    return err({kind: 'send-failed', message})
  }

  // #then — success
  return ok(undefined as void)
}
