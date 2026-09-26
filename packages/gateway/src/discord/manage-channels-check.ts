/**
 * Fresh guild-level `ManageChannels` check, shared by every destructive Discord entry point that
 * needs the raised auth bar (trigger role does NOT qualify): `/fro-bot force-release-lock`,
 * `/fro-bot recover-checkout`, the Recover-entry button, and `/fro-bot checkout-backup delete`.
 *
 * "Fresh" means a live `guild.members.fetch()` on every call — never a cached decision from an
 * earlier check in the same flow (R7 requires re-checking at confirmation, not just at entry).
 * Fail-closed: any fetch error denies.
 */

import type {Guild} from 'discord.js'
import type {GatewayLogger} from './client.js'

import {PermissionFlagsBits} from 'discord.js'

export async function hasManageChannels(guild: Guild, userId: string, log: GatewayLogger): Promise<boolean> {
  const member = await guild.members.fetch(userId).catch((error: unknown) => {
    log.warn(
      {err: error instanceof Error ? error.message : String(error)},
      'manage-channels-check: member permission resolution failed - denying',
    )
    return null
  })
  return member !== null && member.permissions.has(PermissionFlagsBits.ManageChannels)
}
