/**
 * Discord approval UI primitives for gateway tool-approval.
 *
 * Pure builders — ZERO side effects, no Discord client, no network.
 * Imports only discord.js builders and the coordinator types.
 */

import type {PermissionReply, PermissionRequest, SettlementReason} from '../approvals/coordinator.js'

import {ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder} from 'discord.js'

import {isRequestDetailTruncated} from '../approvals/approval-detail.js'
import {escapeText} from './questions.js'

// ---------------------------------------------------------------------------
// custom_id prefixes (namespaced to avoid collisions with other interactions)
// ---------------------------------------------------------------------------

export const APPROVE_PREFIX = 'fb-approve:'
export const DENY_PREFIX = 'fb-deny:'

const CUSTOM_ID_MAX = 100

/** Discord's cap on an embed field value; the builder throws past it, which would leave the card unposted. */
const FIELD_VALUE_MAX = 1024

function clampFieldValue(value: string): string {
  return value.length <= FIELD_VALUE_MAX ? value : `${value.slice(0, FIELD_VALUE_MAX - 1)}…`
}

/**
 * Shown on a card whose request the operator cannot see in full; the card then offers Deny only. The dashboard can't
 * decide a Discord run's approvals (it keys decisions by run id, Discord by thread), so rejecting is the only way out.
 */
const TOO_LONG_NOTE = 'Too long to show here, so it can only be rejected.'

/**
 * `true` when the card cannot show the whole request: its Action would be clamped, or the command or path behind it
 * was cut by length. Such a card offers Deny only, so nothing can be approved that the operator never saw.
 */
export function approvalCardRejectOnly(request: PermissionRequest): boolean {
  return request.title.length > FIELD_VALUE_MAX || isRequestDetailTruncated(request)
}

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
  const embed = new EmbedBuilder().setTitle('🔐 Tool approval required')
  if (approvalCardRejectOnly(request)) embed.setDescription(TOO_LONG_NOTE)
  return embed
    .setColor(0xffa500) // amber — pending
    .addFields(
      {name: 'Gate category', value: request.permission, inline: true},
      {name: 'Action', value: clampFieldValue(request.title), inline: false},
    )
    .setFooter({text: 'If not approved in time, this request will be automatically denied (fail-closed).'})
    .setTimestamp()
}

/**
 * Build an action row with Approve + Deny buttons for a pending request. `rejectOnly` drops Approve: the operator
 * cannot see the whole request, so Deny is the only decision offered.
 */
export function buildApprovalButtons(requestID: string, rejectOnly = false): ActionRowBuilder<ButtonBuilder> {
  const denyBtn = new ButtonBuilder()
    .setCustomId(buildApprovalCustomId('deny', requestID))
    .setLabel('Deny')
    .setStyle(ButtonStyle.Danger)
  if (rejectOnly) return new ActionRowBuilder<ButtonBuilder>().addComponents(denyBtn)

  const approveBtn = new ButtonBuilder()
    .setCustomId(buildApprovalCustomId('approve', requestID))
    .setLabel('Approve')
    .setStyle(ButtonStyle.Success)

  return new ActionRowBuilder<ButtonBuilder>().addComponents(approveBtn, denyBtn)
}

/**
 * Who settled an approval, by origin. A Discord user can be mentioned; a web operator is only a
 * GitHub login, which Discord cannot resolve, so it is shown as plain text.
 */
export type SettledDecider =
  {readonly kind: 'discord-user'; readonly userId: string} | {readonly kind: 'web'; readonly login: string}

/** Longest login shown on a card; GitHub logins are far shorter, so this only bounds a malformed one. */
const WEB_LOGIN_MAX = 64

function deciderLabel(decidedBy: SettledDecider | undefined): string | null {
  if (decidedBy === undefined) return null
  if (decidedBy.kind === 'discord-user') return decidedBy.userId.length > 0 ? `<@${decidedBy.userId}>` : null
  const login = decidedBy.login.trim().slice(0, WEB_LOGIN_MAX)
  return login.length === 0 ? null : `${escapeText(login)} (dashboard)`
}

/**
 * Build a resolved-state embed after a request has been settled.
 *
 * Covers all `SettlementReason` variants with appropriate human text.
 * Renders a `<@id>` mention for a Discord decider and escaped plain text for a dashboard decider;
 * deadline / cascade / disposed have no human decider.
 */
export function buildSettledEmbed(
  request: PermissionRequest,
  decision: PermissionReply,
  opts: {decidedBy?: SettledDecider; reason: SettlementReason},
): EmbedBuilder {
  const {decidedBy, reason} = opts
  const mention = deciderLabel(decidedBy)

  let title: string
  let color: number
  // Discord renders mentions in a description but never in an embed title, so a human decider goes here.
  let decider: string | null = null

  if (reason === 'superseded') {
    title = '🔄 This approval request was superseded by a newer request.'
    color = 0x99aab5 // grey — neutral, no approve/deny coloring
  } else if (reason === 'deadline') {
    title = '⏱️ Approval timed out — denied'
    color = 0x99aab5 // grey
  } else if (reason === 'cascade') {
    title = '⛔ Denied (related request rejected)'
    color = 0xed4245 // red
  } else if (reason === 'disposed') {
    title = '⚠️ Cancelled (shutdown)'
    color = 0x99aab5 // grey
  } else if (decision === 'reject') {
    title = '⛔ Denied'
    decider = mention === null ? null : `Denied by ${mention}`
    color = 0xed4245 // red
  } else {
    // 'once' or 'always' — approved
    title = '✅ Approved'
    decider = mention === null ? null : `Approved by ${mention}`
    color = 0x57f287 // green
  }

  const embed = new EmbedBuilder().setTitle(title)
  // The decider line is the only description content, so it cannot approach the 4096 limit.
  if (decider !== null) embed.setDescription(decider)
  return embed
    .setColor(color)
    .addFields(
      {name: 'Gate category', value: request.permission, inline: true},
      {name: 'Action', value: clampFieldValue(request.title), inline: false},
    )
    .setTimestamp()
}
