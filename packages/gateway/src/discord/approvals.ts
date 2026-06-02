/**
 * Discord approval UI primitives for gateway tool-approval.
 *
 * Pure builders — ZERO side effects, no Discord client, no network.
 * Imports only discord.js builders and the coordinator types.
 */

import type {PermissionReply, PermissionRequest, SettlementReason} from '../approvals/coordinator.js'

import {ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder} from 'discord.js'

// ---------------------------------------------------------------------------
// custom_id prefixes (namespaced to avoid collisions with other interactions)
// ---------------------------------------------------------------------------

export const APPROVE_PREFIX = 'fb-approve:'
export const DENY_PREFIX = 'fb-deny:'

const CUSTOM_ID_MAX = 100

// ---------------------------------------------------------------------------
// custom_id codec
// ---------------------------------------------------------------------------

/**
 * Build a Discord custom_id for an approval button.
 *
 * Throws if `prefix + requestID` would exceed the 100-char Discord limit.
 * requestIDs are `per_…` (~30 chars) so this is a guard, not a normal path.
 */
export function buildApprovalCustomId(action: 'approve' | 'deny', requestID: string): string {
  const prefix = action === 'approve' ? APPROVE_PREFIX : DENY_PREFIX
  const id = `${prefix}${requestID}`
  if (id.length > CUSTOM_ID_MAX) {
    throw new Error(`Approval custom_id exceeds Discord's 100-char limit (got ${id.length}): requestID is too long`)
  }
  return id
}

/**
 * Parse a Discord custom_id back into an approval action + requestID.
 *
 * Returns `null` for any non-approval custom_id — safe to call from a generic
 * interaction handler. Never throws.
 */
export function parseApprovalCustomId(customId: string): {action: 'approve' | 'deny'; requestID: string} | null {
  if (typeof customId !== 'string' || !customId) return null

  if (customId.startsWith(APPROVE_PREFIX)) {
    const requestID = customId.slice(APPROVE_PREFIX.length)
    if (!requestID) return null
    return {action: 'approve', requestID}
  }

  if (customId.startsWith(DENY_PREFIX)) {
    const requestID = customId.slice(DENY_PREFIX.length)
    if (!requestID) return null
    return {action: 'deny', requestID}
  }

  return null
}

// ---------------------------------------------------------------------------
// Embed builders
// ---------------------------------------------------------------------------

/**
 * Build the pending-approval embed shown when a tool permission is requested.
 *
 * Redaction-safe: never renders raw patterns, tool inputs, or the requestID.
 * The requestID lives only in the button custom_ids.
 */
export function buildApprovalEmbed(request: PermissionRequest): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🔐 Tool approval required')
    .setColor(0xffa500) // amber — pending
    .addFields(
      {name: 'Gate category', value: request.permission, inline: true},
      {name: 'Action', value: request.title, inline: false},
    )
    .setFooter({text: 'If not approved in time, this request will be automatically denied (fail-closed).'})
    .setTimestamp()
}

/**
 * Build an action row with Approve + Deny buttons for a pending request.
 */
export function buildApprovalButtons(requestID: string): ActionRowBuilder<ButtonBuilder> {
  const approveBtn = new ButtonBuilder()
    .setCustomId(buildApprovalCustomId('approve', requestID))
    .setLabel('Approve')
    .setStyle(ButtonStyle.Success)

  const denyBtn = new ButtonBuilder()
    .setCustomId(buildApprovalCustomId('deny', requestID))
    .setLabel('Deny')
    .setStyle(ButtonStyle.Danger)

  return new ActionRowBuilder<ButtonBuilder>().addComponents(approveBtn, denyBtn)
}

/**
 * Build a resolved-state embed after a request has been settled.
 *
 * Covers all `SettlementReason` variants with appropriate human text.
 * Renders `<@id>` mention only when `decidedBy` is present (human decisions);
 * deadline / cascade / disposed have no human decider.
 */
export function buildSettledEmbed(
  request: PermissionRequest,
  decision: PermissionReply,
  opts: {decidedBy?: string; reason: SettlementReason},
): EmbedBuilder {
  const {decidedBy, reason} = opts
  const mention = decidedBy !== undefined && decidedBy.length > 0 ? `<@${decidedBy}>` : null

  let title: string
  let color: number

  if (reason === 'deadline') {
    title = '⏱️ Approval timed out — denied'
    color = 0x99aab5 // grey
  } else if (reason === 'cascade') {
    title = '⛔ Denied (related request rejected)'
    color = 0xed4245 // red
  } else if (reason === 'disposed') {
    title = '⚠️ Cancelled (shutdown)'
    color = 0x99aab5 // grey
  } else if (decision === 'reject') {
    title = mention === null ? '⛔ Denied' : `⛔ Denied by ${mention}`
    color = 0xed4245 // red
  } else {
    // 'once' or 'always' — approved
    title = mention === null ? '✅ Approved' : `✅ Approved by ${mention}`
    color = 0x57f287 // green
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      {name: 'Gate category', value: request.permission, inline: true},
      {name: 'Action', value: request.title, inline: false},
    )
    .setTimestamp()
}
