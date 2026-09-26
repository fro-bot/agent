/**
 * `/fro-bot recover-checkout` and the Recover-entry button click share this module's flow: acquire
 * the repo lock, create a heartbeating maintenance run, preview the recovery, and show it
 * ephemerally with Preserve-and-replace / Cancel buttons that expire after 60 seconds. See the
 * plan's Unit 8 and R7-R10.
 */

import type {ButtonInteraction} from 'discord.js'
import type {GatewayLogger} from '../client.js'
import type {MaintenanceRunHandle} from '../maintenance-run.js'
import type {FroBotDeps} from './fro-bot.js'
import type {AuthDecision, GuildCommandCtx} from './guild-command.js'
import {ActionRowBuilder, ButtonBuilder, ButtonStyle} from 'discord.js'
import {Effect} from 'effect'
import {formatBranchForReply} from '../../execute/provenance.js'
import {editInteractionAsync} from '../io.js'
import {acquireMaintenanceRun} from '../maintenance-run.js'
import {hasManageChannels} from '../manage-channels-check.js'
import {createNonceRegistry, type NonceBinding} from '../recover-confirm-nonce.js'
import {INTERNAL_ERROR_COPY, makeGuildCommand} from './guild-command.js'

export type RecoverCheckoutDeps = FroBotDeps

const CONFIRM_PREFIX = 'fb-recover-confirm:'
const CANCEL_PREFIX = 'fb-recover-cancel:'

export const NOT_ACTIVE_REPLY = 'This request is no longer active. Run `/fro-bot recover-checkout` again.'

interface RecoverNoncePayload {
  readonly owner: string
  readonly repo: string
  readonly fingerprint: string
  readonly handle: MaintenanceRunHandle
}

const nonceRegistry = createNonceRegistry<RecoverNoncePayload>()

/** Test-only escape hatch so specs can inspect pending-nonce count without a real 60s wait. */
export function getRecoverNonceRegistryForTesting(): typeof nonceRegistry {
  return nonceRegistry
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

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function formatRetention(usage: {
  readonly generationCount: number
  readonly hasUnknownSize: boolean
  readonly totalBytes: number
  readonly maxGenerations: number
  readonly maxBytes: number
}): string {
  const sizeNote = usage.hasUnknownSize ? '+' : ''
  return `retention: ${usage.generationCount}/${usage.maxGenerations} generations, ${formatBytes(usage.totalBytes)}${sizeNote}/${formatBytes(usage.maxBytes)}`
}

function formatSize(estimatedSizeBytes: number, entryCount: number, sizeMeasurementComplete: boolean): string {
  const prefix = sizeMeasurementComplete ? '~' : 'at least '
  return `${prefix}${formatBytes(estimatedSizeBytes)} across ${entryCount} files`
}

/**
 * Renders a `previewRecovery` result for the ephemeral preview message.
 * `showConfirm` is `true` only for `ok` and `recoverable-update` — every other kind is
 * informational and cannot proceed (nothing safe to fingerprint, or nothing to recover).
 */
function renderPreview(
  repoSlug: string,
  result: import('../../workspace-api/types.js').PreviewRecoveryResult,
): {readonly content: string; readonly showConfirm: boolean; readonly fingerprint: string | undefined} {
  if (result.kind === 'no-checkout') {
    return {
      content: `There is no checkout at \`${repoSlug}\` yet. The next run will clone one automatically - nothing to recover.`,
      showConfirm: false,
      fingerprint: undefined,
    }
  }
  if (result.kind === 'refused' && result.reason === 'checkout-substituted') {
    return {
      content: `The checkout at \`${repoSlug}\` doesn't match this repository. An operator needs to look at it directly.`,
      showConfirm: false,
      fingerprint: undefined,
    }
  }
  if (result.kind === 'refused' && result.reason === 'maintenance-hold') {
    return {
      content: `An earlier operation on this checkout may still be running, so the workspace has put this repository on hold. Restarting the workspace clears the hold; try again after that.`,
      showConfirm: false,
      fingerprint: undefined,
    }
  }
  if (result.kind === 'refused' && result.reason === 'journal-in-progress') {
    return {
      content: `An update or recovery is already in progress for \`${repoSlug}\` (phase: \`${result.phase}\`). Try again once it finishes.`,
      showConfirm: false,
      fingerprint: undefined,
    }
  }
  if (result.kind === 'failed' && result.reason === 'inspection-failed') {
    return {
      content: `I couldn't inspect the checkout at \`${repoSlug}\` right now. Try again shortly.`,
      showConfirm: false,
      fingerprint: undefined,
    }
  }
  if (result.kind === 'failed' && result.reason === 'termination-unconfirmed') {
    return {
      content: `A previous operation on this checkout couldn't be confirmed to have stopped. This repository is on hold until the workspace restarts.`,
      showConfirm: false,
      fingerprint: undefined,
    }
  }
  if (result.kind === 'recoverable-update') {
    const u = result.update
    const sizeText = formatSize(u.estimatedSizeBytes, u.entryCount, u.sizeMeasurementComplete)
    return {
      content: `An interrupted update for \`${repoSlug}\` (phase: \`${u.phase}\`) can be recovered: it was moving from \`${shortSha(u.fromSha)}\` to \`${shortSha(u.toSha)}\`, started ${u.startedAt}, ${sizeText}. Confirm to preserve this checkout and install a fresh one.`,
      showConfirm: true,
      fingerprint: u.fingerprint,
    }
  }
  // result.kind === 'ok'
  const p = result.preview
  const sizeText = formatSize(p.estimatedSizeBytes, p.entryCount, p.sizeMeasurementComplete)
  const retentionText = formatRetention(p.retention)
  if (p.inspectionSafe === false) {
    return {
      content: `Preview for \`${repoSlug}\`: the checkout couldn't be safely inspected, ${sizeText}, ${retentionText}. Confirm to preserve this checkout and install a fresh one.`,
      showConfirm: true,
      fingerprint: p.fingerprint,
    }
  }
  const shaText = p.headSha === undefined ? 'no commits yet' : `at \`${shortSha(p.headSha)}\``
  const branchText = p.branch === undefined ? '(detached)' : `on \`${formatBranchForReply(p.branch)}\``
  const dirtyText = `dirty (staged ${p.dirty.staged}, unstaged ${p.dirty.unstaged}, untracked ${p.dirty.untracked}, conflicted ${p.dirty.conflicted})`
  const opText = p.operationInProgress === 'none' ? '' : `, ${p.operationInProgress} in progress`
  return {
    content: `Preview for \`${repoSlug}\`: ${shaText} ${branchText}, ${dirtyText}${opText}, ${sizeText}, ${retentionText}. Confirm to preserve this checkout and install a fresh one.`,
    showConfirm: true,
    fingerprint: p.fingerprint,
  }
}

/** Renders an `executeRecovery` result as the final one-line ephemeral status. */
function renderOutcome(repoSlug: string, result: import('../../workspace-api/types.js').ExecuteRecoveryResult): string {
  if (result.kind === 'ok') {
    return `Recovered \`${repoSlug}\`. New checkout at \`${shortSha(result.sha)}\` on \`${formatBranchForReply(result.branch)}\`. The previous checkout was preserved as backup \`${result.recoveryId}\` - list it with \`/fro-bot checkout-backup list\`.`
  }
  if (result.kind === 'no-checkout') {
    return `There's no checkout at \`${repoSlug}\` to recover anymore.`
  }
  if (result.kind === 'refused') {
    switch (result.reason) {
      case 'maintenance-hold':
        return `This repository is now on hold. Try again after the workspace restarts.`
      case 'journal-in-progress':
        return `Another update or recovery started for \`${repoSlug}\` (phase: \`${result.phase}\`). Try again once it finishes.`
      case 'checkout-changed':
        return `The checkout changed since the preview was shown. Run \`/fro-bot recover-checkout\` again to see the current state.`
      case 'quota-exceeded':
        return `Recovery is at its retention limit (${result.usage.maxGenerations} generations or ${formatBytes(result.usage.maxBytes)}) for \`${repoSlug}\`. Delete an old backup with \`/fro-bot checkout-backup delete <id>\` first.`
      case 'insufficient-disk-space':
        return `There isn't enough free disk space to recover \`${repoSlug}\` right now.`
    }
  }
  // result.kind === 'failed'
  switch (result.reason) {
    case 'inspection-failed':
      return `I couldn't check the checkout at \`${repoSlug}\` before recovering it. Nothing changed - try again shortly.`
    case 'fetch-failed':
      return `I couldn't reach the repository's remote to build the fresh checkout for \`${repoSlug}\`. Try again shortly.`
    case 'build-failed':
      return `Building the fresh checkout for \`${repoSlug}\` failed. The original checkout is untouched - try again shortly.`
    case 'quarantine-failed':
      return `Preserving the original checkout for \`${repoSlug}\` didn't finish. The workspace tries to finish it when it next restarts; until then this repository can't run.`
    case 'install-failed':
      return `The original checkout for \`${repoSlug}\` was preserved, but installing the fresh one didn't finish. The workspace tries to finish it when it next restarts; until then this repository can't run.`
    case 'verification-failed':
      return `The fresh checkout for \`${repoSlug}\` didn't verify correctly after installing. This repository needs an operator to look at it.`
    case 'termination-unconfirmed':
      return `A step of this recovery couldn't be confirmed to have stopped. This repository is on hold until the workspace restarts.`
  }
}

function buildConfirmCancelRow(nonce: string): ActionRowBuilder<ButtonBuilder> {
  const confirm = new ButtonBuilder()
    .setCustomId(`${CONFIRM_PREFIX}${nonce}`)
    .setLabel('Preserve and replace')
    .setStyle(ButtonStyle.Danger)
  const cancel = new ButtonBuilder()
    .setCustomId(`${CANCEL_PREFIX}${nonce}`)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary)
  return new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)
}

/** Parses a confirm/cancel button's custom_id. Returns `null` for any unrelated custom_id. */
function parseRecoverConfirmCustomId(customId: string): {action: 'confirm' | 'cancel'; nonce: string} | null {
  if (customId.startsWith(CONFIRM_PREFIX)) {
    const nonce = customId.slice(CONFIRM_PREFIX.length)
    return nonce.length === 0 ? null : {action: 'confirm', nonce}
  }
  if (customId.startsWith(CANCEL_PREFIX)) {
    const nonce = customId.slice(CANCEL_PREFIX.length)
    return nonce.length === 0 ? null : {action: 'cancel', nonce}
  }
  return null
}

export {parseRecoverConfirmCustomId}

/**
 * The shared flow for `/fro-bot recover-checkout` and the Recover-entry button. The caller has
 * ALREADY deferred the interaction ephemeral and performed the fresh `ManageChannels` check — this
 * function owns binding resolution through posting the (optionally confirmable) preview.
 */
async function runRecoverCheckoutFlow(params: {
  readonly interaction: import('../io.js').RepliableInteractionTarget
  readonly channelId: string
  readonly guildId: string
  readonly userId: string
  readonly log: GatewayLogger
  readonly deps: RecoverCheckoutDeps
}): Promise<void> {
  const {interaction, channelId, guildId, userId, log, deps} = params

  const bindingResult = await deps.bindingsStore.getBindingByChannelId(channelId)
  if (bindingResult.success === false) {
    log.error({channelId, err: bindingResult.error.message}, 'recover-checkout: binding lookup failed')
    await editInteractionAsync(interaction, {content: INTERNAL_ERROR_COPY}, log)
    return
  }
  if (bindingResult.data === null) {
    await editInteractionAsync(
      interaction,
      {content: 'This channel is not bound to a repository. Use `/fro-bot add-project` first.'},
      log,
    )
    return
  }
  const {owner, repo} = bindingResult.data
  const repoSlug = `${owner}/${repo}`

  const guardResult = await Effect.runPromise(
    acquireMaintenanceRun({
      coordinationConfig: deps.coordinationConfig,
      identity: deps.identity,
      repo: repoSlug,
      kind: 'recover-checkout',
      logger: deps.gatewayLogger,
    }),
  )
  if (guardResult.outcome === 'lock-held') {
    const holder = guardResult.holderId === null ? 'another operation' : `holder \`${guardResult.holderId}\``
    await editInteractionAsync(
      interaction,
      {content: `\`${repoSlug}\` is busy right now (${holder}). Try again once it finishes.`},
      log,
    )
    return
  }
  if (guardResult.outcome === 'error') {
    log.error({repoSlug, err: guardResult.message}, 'recover-checkout: failed to acquire the repo lock')
    await editInteractionAsync(interaction, {content: INTERNAL_ERROR_COPY}, log)
    return
  }
  const {handle} = guardResult

  const previewResult = await deps.workspaceClient.previewRecovery({owner, repo})
  if (previewResult.success === false) {
    log.error({repoSlug, err: previewResult.error.kind}, 'recover-checkout: preview transport error')
    await Effect.runPromise(handle.release('FAILED', {kind: 'recover-checkout', outcome: 'preview-transport-error'}))
    await editInteractionAsync(interaction, {content: INTERNAL_ERROR_COPY}, log)
    return
  }

  const rendered = renderPreview(repoSlug, previewResult.data)
  if (rendered.showConfirm === false || rendered.fingerprint === undefined) {
    await Effect.runPromise(handle.release('COMPLETED', {kind: 'recover-checkout', outcome: 'preview-only'}))
    await editInteractionAsync(interaction, {content: rendered.content}, log)
    return
  }

  const firstEdit = await editInteractionAsync(
    interaction,
    {content: rendered.content, components: [buildConfirmCancelRow('pending')]},
    log,
  )
  if (firstEdit.success === false) {
    await Effect.runPromise(handle.release('FAILED', {kind: 'recover-checkout', outcome: 'post-preview-failed'}))
    return
  }
  // Result.data is discord.js's Message returned by interaction.editReply() — narrowed here
  // rather than widening editInteractionAsync's own return type for every other caller.
  const message = firstEdit.data as {id: string}
  const binding: NonceBinding = {userId, guildId, channelId, messageId: message.id}
  const nonce = nonceRegistry.create(binding, {owner, repo, fingerprint: rendered.fingerprint, handle}, payload => {
    // Expiry: release the lock, change nothing, edit the preview to the expired-status line.
    Effect.runPromise(payload.handle.release('COMPLETED', {kind: 'recover-checkout', outcome: 'expired'})).catch(
      (error: unknown) => log.warn({repoSlug, err: String(error)}, 'recover-checkout: release-on-expiry failed'),
    )
    editInteractionAsync(interaction, {content: NOT_ACTIVE_REPLY, components: []}, log).catch((error: unknown) =>
      log.warn({repoSlug, err: String(error)}, 'recover-checkout: expiry edit failed'),
    )
  })
  // Re-post with the REAL nonce now that message.id (needed for the binding) is known.
  await editInteractionAsync(interaction, {content: rendered.content, components: [buildConfirmCancelRow(nonce)]}, log)
}

/** `/fro-bot recover-checkout` — fresh ManageChannels, no trigger-role fallback (destructive command). */
export function createRecoverCheckoutCommand(
  deps: RecoverCheckoutDeps,
): (interaction: import('discord.js').ChatInputCommandInteraction) => Effect.Effect<void, Error> {
  return makeGuildCommand(
    {
      name: 'recover-checkout',
      authorize: (ctx: GuildCommandCtx): Effect.Effect<AuthDecision, never> =>
        Effect.promise(async () => {
          const authorized = await hasManageChannels(ctx.guild, ctx.interaction.user.id, ctx.log)
          return authorized
            ? {authorized: true as const}
            : {
                authorized: false as const,
                copy: 'You do not have permission to recover this checkout (ManageChannels required).',
              }
        }),
      work: (ctx: GuildCommandCtx): Effect.Effect<void, Error> =>
        Effect.tryPromise({
          try: async () =>
            runRecoverCheckoutFlow({
              interaction: ctx.interaction,
              channelId: ctx.interaction.channelId,
              guildId: ctx.guild.id,
              userId: ctx.interaction.user.id,
              log: ctx.log,
              deps,
            }),
          catch: error => (error instanceof Error ? error : new Error(String(error))),
        }),
    },
    deps,
  )
}

// `handleRecoverEntryButtonClick` lives in `../recover-checkout-button.ts`, NOT here: it hand-
// rolls `interaction.deferReply()` (this is the FIRST response to a fresh button click, not a
// slash-command interaction routed through `makeGuildCommand`), and `guild-command.test.ts`'s
// structural test forbids any hand-rolled `deferReply` inside `discord/commands/*.ts` —
// `guild-command.ts` is the only permitted site in that directory. `runRecoverCheckoutFlow` is
// exported below so that file can reuse this module's shared post-defer logic without duplicating
// it.
export {runRecoverCheckoutFlow}

/**
 * Confirm or Cancel button click. `interaction.deferUpdate()` (not `deferReply`) acknowledges
 * without creating a new reply, so the subsequent `editReply` edits the SAME ephemeral preview
 * message in place — exactly the "edit to a one-line status, remove its buttons" contract.
 */
export async function handleRecoverConfirmOrCancelClick(
  interaction: ButtonInteraction,
  deps: RecoverCheckoutDeps,
): Promise<void> {
  const log = deps.gatewayLogger
  const parsed = parseRecoverConfirmCustomId(interaction.customId)
  if (parsed === null) return // not our button

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
    const payload = nonceRegistry.claim(parsed.nonce, binding)
    if (payload === null) {
      await editInteractionAsync(interaction, {content: NOT_ACTIVE_REPLY, components: []}, log)
      return
    }
    const repoSlug = `${payload.owner}/${payload.repo}`

    if (parsed.action === 'cancel') {
      await Effect.runPromise(payload.handle.release('COMPLETED', {kind: 'recover-checkout', outcome: 'cancelled'}))
      await editInteractionAsync(
        interaction,
        {content: `Cancelled. \`${repoSlug}\` was not changed.`, components: []},
        log,
      )
      return
    }

    // Confirm: re-authorize + re-validate the binding before spending the fingerprint.
    const guild = interaction.guild
    const authorized = guild !== null && (await hasManageChannels(guild, interaction.user.id, log))
    if (authorized === false) {
      await Effect.runPromise(
        payload.handle.release('FAILED', {kind: 'recover-checkout', outcome: 'unauthorized-at-confirm'}),
      )
      await editInteractionAsync(
        interaction,
        {
          content: 'You no longer have permission to confirm this. Run `/fro-bot recover-checkout` again.',
          components: [],
        },
        log,
      )
      return
    }
    const currentBinding = await deps.bindingsStore.getBindingByChannelId(interaction.channelId)
    const stillBound =
      currentBinding.success === true &&
      currentBinding.data !== null &&
      currentBinding.data.owner === payload.owner &&
      currentBinding.data.repo === payload.repo
    if (stillBound === false) {
      await Effect.runPromise(payload.handle.release('FAILED', {kind: 'recover-checkout', outcome: 'binding-changed'}))
      await editInteractionAsync(
        interaction,
        {
          content: 'The repository bound to this channel changed. Run `/fro-bot recover-checkout` again.',
          components: [],
        },
        log,
      )
      return
    }

    const authResult = await deps.appClient.authForRepo(payload.owner, payload.repo)
    if (authResult.success === false) {
      log.error({repoSlug, err: authResult.error.constructor.name}, 'recover-checkout: token mint failed at confirm')
      await Effect.runPromise(payload.handle.release('FAILED', {kind: 'recover-checkout', outcome: 'auth-failed'}))
      await editInteractionAsync(interaction, {content: INTERNAL_ERROR_COPY, components: []}, log)
      return
    }

    const recoverResult = await deps.workspaceClient.recover({
      owner: payload.owner,
      repo: payload.repo,
      token: authResult.data.token,
      fingerprint: payload.fingerprint,
    })
    if (recoverResult.success === false) {
      log.error({repoSlug, err: recoverResult.error.kind}, 'recover-checkout: recover transport error')
      await Effect.runPromise(payload.handle.release('FAILED', {kind: 'recover-checkout', outcome: 'transport-error'}))
      await editInteractionAsync(interaction, {content: INTERNAL_ERROR_COPY, components: []}, log)
      return
    }
    const finalPhase = recoverResult.data.kind === 'ok' ? ('COMPLETED' as const) : ('FAILED' as const)
    await Effect.runPromise(
      payload.handle.release(finalPhase, {kind: 'recover-checkout', outcome: recoverResult.data.kind}),
    )
    await editInteractionAsync(interaction, {content: renderOutcome(repoSlug, recoverResult.data), components: []}, log)
  } catch (error: unknown) {
    log.error({err: String(error)}, 'recover-checkout: confirm/cancel handler threw')
    await editInteractionAsync(interaction, {content: INTERNAL_ERROR_COPY, components: []}, log).catch(() => {})
  }
}
