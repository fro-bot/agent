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

/** Default timeout for Discord API calls (ms). */
const DEFAULT_DISCORD_TIMEOUT_MS = 10_000

/**
 * Resolve `channelId` via the discord.js `client`, then post `embed` to it.
 *
 * The entire fetch+send sequence is bounded by `timeoutMs` (default 10 s).
 * If the Discord API does not respond within the budget the function returns
 * `err({kind: 'send-failed', message: 'discord post timed out'})` so the
 * caller's reservation is always released.
 *
 * Returns:
 * - `ok(undefined)` on success
 * - `err({kind: 'channel-not-found'})` if the channel cannot be resolved
 * - `err({kind: 'not-text-channel'})` if the channel does not support `.send`
 * - `err({kind: 'send-failed', message})` if the Discord API rejects the send or times out
 */
export async function postPresenceEmbed(
  client: Client,
  channelId: string,
  embed: PresenceEmbed,
  timeoutMs: number = DEFAULT_DISCORD_TIMEOUT_MS,
): Promise<Result<void, PresenceError>> {
  // Race the entire Discord operation against a timeout so that a hung API
  // call never leaks a replay reservation. We use Promise.race with a
  // setTimeout-backed rejection rather than AbortSignal because discord.js
  // channels.fetch does not accept an AbortSignal cleanly.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  const discordOp = async (): Promise<Result<void, PresenceError>> => {
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
    if (channel.isTextBased() === false || 'send' in channel === false) {
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

  const timeoutOp = new Promise<Result<void, PresenceError>>(resolve => {
    timeoutHandle = setTimeout(() => {
      resolve(err({kind: 'send-failed', message: 'discord post timed out'}))
    }, timeoutMs)
  })

  // Attach a no-op catch to discordOp so that if the timeout wins first and
  // the discord promise later rejects, the rejection does not become unhandled.
  const result = await Promise.race([
    discordOp().catch(
      () => err({kind: 'send-failed', message: 'discord post timed out'}) as Result<void, PresenceError>,
    ),
    timeoutOp,
  ])
  clearTimeout(timeoutHandle)
  return result
}
