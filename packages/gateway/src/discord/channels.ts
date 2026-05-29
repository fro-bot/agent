/**
 * Discord channel management utilities.
 *
 * Provides `createChannelWithCollisionSuffix` which ALWAYS creates a new channel.
 * If the desired name is taken, it tries suffixes (name-2, name-3, ..., name-{maxSuffix})
 * until a free slot is found. This prevents binding a new repo to an unrelated
 * existing channel.
 */

import type {Result} from '@fro-bot/runtime'
import type {Guild, TextChannel} from 'discord.js'

import {err, ok} from '@fro-bot/runtime'
import {ChannelType} from 'discord.js'

export type ChannelError =
  | {readonly kind: 'collision-exhausted'; readonly name: string; readonly maxSuffix: number}
  | {readonly kind: 'create-failed'; readonly message: string}
  | {readonly kind: 'permission-denied'; readonly message: string}

export interface FindOrCreateChannelOptions {
  readonly maxSuffix?: number
}

/**
 * Always creates a new text channel — never returns an existing one.
 *
 * Tries the exact name first, then `name-2`, `name-3`, ..., `name-{maxSuffix}`.
 * Any candidate whose name is already taken is skipped. The first free slot is
 * created and returned. This prevents accidentally binding a new repo to an
 * unrelated pre-existing channel.
 *
 * Returns `{kind: 'collision-exhausted'}` if every candidate is already taken.
 *
 * @param guild - The Discord guild to create the channel in.
 * @param name - The desired channel name (must already be normalized/validated).
 * @param options - Optional config; `maxSuffix` defaults to 10.
 */
export async function createChannelWithCollisionSuffix(
  guild: Guild,
  name: string,
  options: FindOrCreateChannelOptions = {},
): Promise<Result<TextChannel, ChannelError>> {
  const {maxSuffix = 10} = options

  // Iterate candidates: exact name, then name-2, name-3, ..., name-{maxSuffix}.
  // NEVER return an existing channel — always create a fresh one.
  const candidates = [name, ...Array.from({length: maxSuffix - 1}, (_, i) => `${name}-${i + 2}`)]

  for (const candidate of candidates) {
    // Re-read the cache each iteration — concurrent setups may have created channels
    // we didn't see at function entry. A frozen snapshot would cause two concurrent
    // invocations to both think a candidate is free, both call create(), and the loser
    // would silently advance to the next suffix, binding to the wrong channel.
    const existing = guild.channels.cache.find(
      c => c.name.toLowerCase() === candidate.toLowerCase() && c.type === ChannelType.GuildText,
    )
    if (existing !== undefined) {
      // This name is already taken — skip to next suffix.
      continue
    }

    const createResult = await tryCreate(guild, candidate)
    if (createResult.kind === 'ok') {
      return ok(createResult.channel)
    } else if (createResult.kind === 'permission-denied') {
      return err({kind: 'permission-denied', message: createResult.message})
    } else if (createResult.kind === 'create-failed') {
      // Non-transient failure (429, 5xx, network) — surface immediately, don't burn suffixes.
      return err({kind: 'create-failed', message: createResult.message})
    }
    // kind === 'name-taken' — Discord rejected the name as duplicate; try next suffix.
  }

  return err({kind: 'collision-exhausted', name, maxSuffix})
}

type TryCreateResult =
  | {readonly kind: 'ok'; readonly channel: TextChannel}
  | {readonly kind: 'permission-denied'; readonly message: string}
  | {readonly kind: 'name-taken'}
  | {readonly kind: 'create-failed'; readonly message: string}

/**
 * Attempt to create a channel with the given name.
 *
 * Returns a discriminated result:
 * - `ok` — channel created successfully
 * - `permission-denied` — bot lacks Manage Channels (Discord 50013 / 403)
 * - `name-taken` — Discord rejected the name as duplicate (Discord 50035)
 * - `create-failed` — other failure (429, 5xx, network); caller should NOT retry with next suffix
 */
async function tryCreate(guild: Guild, name: string): Promise<TryCreateResult> {
  try {
    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
    })
    return {kind: 'ok', channel: created}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    // Check numeric error code first (more reliable than regex on message text).
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined

    if (code === 50013 || /missing.?permissions|403/i.test(message)) {
      return {kind: 'permission-denied', message}
    }

    if (code === 50035) {
      // "Invalid Form Body" — Discord rejects duplicate channel name.
      return {kind: 'name-taken'}
    }

    // All other errors (429 rate-limit, 5xx, network) — surface immediately.
    return {kind: 'create-failed', message}
  }
}
