/**
 * `/fro-bot checkout-backup list` and `delete <id>`.
 *
 * Deliberately does NOT acquire the gateway repo lock or a maintenance run record: `deleteBackup`
 * only removes an already-quarantined generation directory under `.workspace-agent/quarantine/`,
 * which no in-progress run or preparation ever touches (a run only reads/writes the live checkout
 * and the protected bare fetch store). The workspace's own per-repo mutex ("One per-repo operation
 * mutex in the workspace shared by clone, update, recover, and backup delete" - Key Technical
 * Decisions) is the real exclusion boundary for a delete racing a concurrent recover/update on that
 * same quarantine directory; a gateway-side lock here would add latency and a maintenance-run
 * record without closing any race the workspace mutex doesn't already close.
 */

import type {ButtonInteraction, ChatInputCommandInteraction} from 'discord.js'
import type {BackupEntry} from '../../workspace-api/types.js'
import type {FroBotDeps} from './fro-bot.js'
import type {AuthDecision, GuildCommandCtx} from './guild-command.js'

import {ActionRowBuilder, ButtonBuilder, ButtonStyle} from 'discord.js'
import {Effect} from 'effect'
import {formatBranchForReply} from '../../execute/provenance.js'
import {editInteractionAsync} from '../io.js'
import {hasManageChannels} from '../manage-channels-check.js'
import {createNonceRegistry, type NonceBinding} from '../recover-confirm-nonce.js'
import {INTERNAL_ERROR_COPY, makeGuildCommand} from './guild-command.js'
import {NOT_ACTIVE_REPLY} from './recover-checkout.js'

export type CheckoutBackupDeps = FroBotDeps

const DELETE_CONFIRM_PREFIX = 'fb-backup-delete-confirm:'
const DELETE_CANCEL_PREFIX = 'fb-backup-delete-cancel:'

interface DeletePayload {
  readonly owner: string
  readonly repo: string
  readonly id: string
}

const deleteNonceRegistry = createNonceRegistry<DeletePayload>()

/** Test-only escape hatch, mirrors `recover-checkout.ts`'s own. */
export function getBackupDeleteNonceRegistryForTesting(): typeof deleteNonceRegistry {
  return deleteNonceRegistry
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/** Plan's exact list-row text: `<id> · <date> · <size> · from branch <branch> at <short-sha>`. */
function formatListRow(entry: BackupEntry): string {
  const branch = entry.originalBranch === undefined ? 'unknown' : formatBranchForReply(entry.originalBranch)
  const sha = entry.originalHeadSha === undefined ? 'unknown' : entry.originalHeadSha.slice(0, 7)
  const size = entry.sizeComplete ? formatBytes(entry.sizeBytes) : `at least ${formatBytes(entry.sizeBytes)}`
  return `\`${entry.id}\` · ${entry.createdAt} · ${size} · from branch \`${branch}\` at \`${sha}\``
}

function parseDeleteConfirmCustomId(customId: string): {action: 'confirm' | 'cancel'; nonce: string} | null {
  if (customId.startsWith(DELETE_CONFIRM_PREFIX)) {
    const nonce = customId.slice(DELETE_CONFIRM_PREFIX.length)
    return nonce.length === 0 ? null : {action: 'confirm', nonce}
  }
  if (customId.startsWith(DELETE_CANCEL_PREFIX)) {
    const nonce = customId.slice(DELETE_CANCEL_PREFIX.length)
    return nonce.length === 0 ? null : {action: 'cancel', nonce}
  }
  return null
}

function buildDeleteConfirmRow(nonce: string): ActionRowBuilder<ButtonBuilder> {
  const confirm = new ButtonBuilder()
    .setCustomId(`${DELETE_CONFIRM_PREFIX}${nonce}`)
    .setLabel('Delete')
    .setStyle(ButtonStyle.Danger)
  const cancel = new ButtonBuilder()
    .setCustomId(`${DELETE_CANCEL_PREFIX}${nonce}`)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary)
  return new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)
}

async function resolveBindingOrReply(
  interaction: import('../io.js').RepliableInteractionTarget,
  channelId: string,
  deps: CheckoutBackupDeps,
  log: import('../client.js').GatewayLogger,
): Promise<{owner: string; repo: string} | null> {
  const bindingResult = await deps.bindingsStore.getBindingByChannelId(channelId)
  if (bindingResult.success === false) {
    log.error({channelId, err: bindingResult.error.message}, 'checkout-backup: binding lookup failed')
    await editInteractionAsync(interaction, {content: INTERNAL_ERROR_COPY}, log)
    return null
  }
  if (bindingResult.data === null) {
    await editInteractionAsync(
      interaction,
      {content: 'This channel is not bound to a repository. Use `/fro-bot add-project` first.'},
      log,
    )
    return null
  }
  return bindingResult.data
}

async function runList(
  interaction: import('../io.js').RepliableInteractionTarget,
  channelId: string,
  deps: CheckoutBackupDeps,
  log: import('../client.js').GatewayLogger,
): Promise<void> {
  const binding = await resolveBindingOrReply(interaction, channelId, deps, log)
  if (binding === null) return
  const repoSlug = `${binding.owner}/${binding.repo}`

  const result = await deps.workspaceClient.listBackups(binding.owner, binding.repo)
  if (result.success === false || result.data.kind === 'failed') {
    await editInteractionAsync(interaction, {content: INTERNAL_ERROR_COPY}, log)
    return
  }
  if (result.data.backups.length === 0) {
    await editInteractionAsync(interaction, {content: `No preserved checkouts for \`${repoSlug}\`.`}, log)
    return
  }
  const rows = result.data.backups.map(formatListRow).join('\n')
  await editInteractionAsync(interaction, {content: rows}, log)
}

async function runDeleteRequest(
  interaction: import('../io.js').RepliableInteractionTarget,
  channelId: string,
  guildId: string,
  userId: string,
  id: string,
  deps: CheckoutBackupDeps,
  log: import('../client.js').GatewayLogger,
): Promise<void> {
  const binding = await resolveBindingOrReply(interaction, channelId, deps, log)
  if (binding === null) return

  const listResult = await deps.workspaceClient.listBackups(binding.owner, binding.repo)
  if (listResult.success === false || listResult.data.kind === 'failed') {
    await editInteractionAsync(interaction, {content: INTERNAL_ERROR_COPY}, log)
    return
  }
  const entry = listResult.data.backups.find(b => b.id === id)
  if (entry === undefined) {
    await editInteractionAsync(
      interaction,
      {content: `No backup \`${id}\` found for \`${binding.owner}/${binding.repo}\`.`},
      log,
    )
    return
  }

  const size = entry.sizeComplete ? formatBytes(entry.sizeBytes) : `at least ${formatBytes(entry.sizeBytes)}`
  const content = `Delete backup \`${id}\` from ${entry.createdAt}, ${size}? This can't be undone.`
  const firstEdit = await editInteractionAsync(
    interaction,
    {content, components: [buildDeleteConfirmRow('pending')]},
    log,
  )
  if (firstEdit.success === false) return
  const message = firstEdit.data as {id: string}
  const nonceBinding: NonceBinding = {userId, guildId, channelId, messageId: message.id}
  const nonce = deleteNonceRegistry.create(nonceBinding, {owner: binding.owner, repo: binding.repo, id}, () => {
    editInteractionAsync(
      interaction,
      {content: `This confirmation expired. Run \`/fro-bot checkout-backup delete ${id}\` again.`, components: []},
      log,
    ).catch((error: unknown) => log.warn({err: String(error)}, 'checkout-backup: expiry edit failed'))
  })
  await editInteractionAsync(interaction, {content, components: [buildDeleteConfirmRow(nonce)]}, log)
}

export async function handleBackupDeleteConfirmOrCancelClick(
  interaction: ButtonInteraction,
  deps: CheckoutBackupDeps,
): Promise<void> {
  const log = deps.gatewayLogger
  const parsed = parseDeleteConfirmCustomId(interaction.customId)
  if (parsed === null) return

  try {
    await interaction.deferUpdate()
    const guildId = interaction.guildId
    if (guildId === null) {
      await editInteractionAsync(interaction, {content: NOT_ACTIVE_REPLY, components: []}, log)
      return
    }
    const binding: NonceBinding = {
      userId: interaction.user.id,
      guildId,
      channelId: interaction.channelId,
      messageId: interaction.message.id,
    }
    const payload = deleteNonceRegistry.claim(parsed.nonce, binding)
    if (payload === null) {
      await editInteractionAsync(interaction, {content: NOT_ACTIVE_REPLY, components: []}, log)
      return
    }

    if (parsed.action === 'cancel') {
      await editInteractionAsync(
        interaction,
        {content: `Cancelled. Backup \`${payload.id}\` was not deleted.`, components: []},
        log,
      )
      return
    }

    const guild = interaction.guild
    const authorized = guild !== null && (await hasManageChannels(guild, interaction.user.id, log))
    if (authorized === false) {
      await editInteractionAsync(
        interaction,
        {content: 'You no longer have permission to confirm this. Run the delete command again.', components: []},
        log,
      )
      return
    }

    const deleteResult = await deps.workspaceClient.deleteBackup(payload.owner, payload.repo, payload.id)
    if (deleteResult.success === false) {
      await editInteractionAsync(interaction, {content: INTERNAL_ERROR_COPY, components: []}, log)
      return
    }
    const content =
      deleteResult.data.kind === 'ok'
        ? `Deleted backup \`${payload.id}\`.`
        : deleteResult.data.kind === 'failed'
          ? INTERNAL_ERROR_COPY
          : deleteResult.data.reason === 'not-found'
            ? `Backup \`${payload.id}\` no longer exists.`
            : deleteResult.data.reason === 'invalid-id'
              ? `\`${payload.id}\` isn't a valid backup id.`
              : deleteResult.data.reason === 'maintenance-hold'
                ? 'This repository is on hold while the workspace recovers from an interrupted operation. Try again after it restarts.'
                : 'A recovery is already in progress for this repository. Try again once it finishes.'
    await editInteractionAsync(interaction, {content, components: []}, log)
  } catch (error: unknown) {
    log.error({err: String(error)}, 'checkout-backup: delete confirm/cancel handler threw')
    await editInteractionAsync(interaction, {content: INTERNAL_ERROR_COPY, components: []}, log).catch(() => {})
  }
}

/** `/fro-bot checkout-backup list|delete` — fresh ManageChannels, same raised bar as recover-checkout. */
export function createCheckoutBackupCommand(
  deps: CheckoutBackupDeps,
): (interaction: ChatInputCommandInteraction) => Effect.Effect<void, Error> {
  return makeGuildCommand(
    {
      name: 'checkout-backup',
      authorize: (ctx: GuildCommandCtx): Effect.Effect<AuthDecision, never> =>
        Effect.promise(async () => {
          const authorized = await hasManageChannels(ctx.guild, ctx.interaction.user.id, ctx.log)
          return authorized
            ? {authorized: true as const}
            : {
                authorized: false as const,
                copy: 'You do not have permission to manage backups (ManageChannels required).',
              }
        }),
      work: (ctx: GuildCommandCtx): Effect.Effect<void, Error> =>
        Effect.tryPromise({
          try: async () => {
            const subcommand = ctx.interaction.options.getSubcommand(true)
            if (subcommand === 'list') {
              await runList(ctx.interaction, ctx.interaction.channelId, deps, ctx.log)
              return
            }
            const id = ctx.interaction.options.getString('id', true)
            await runDeleteRequest(
              ctx.interaction,
              ctx.interaction.channelId,
              ctx.guild.id,
              ctx.interaction.user.id,
              id,
              deps,
              ctx.log,
            )
          },
          catch: error => (error instanceof Error ? error : new Error(String(error))),
        }),
    },
    deps,
  )
}
