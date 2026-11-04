/**
 * `/fro-bot cancel` — request cancellation of the executing run for this channel or run thread.
 *
 * Authorization is `userIsAuthorized` (the approval gate: the trigger role when one is configured, otherwise guild
 * ManageChannels). The target is resolved server-side by `resolveCancelTarget`; the actual cancellation is the shared
 * `cancelRun` engine, so abort, terminal transitions, approval settlement and cleanup stay where they already live.
 * The public notice in the run thread comes from the engine's notice sink, not from this reply.
 *
 * Replies are ephemeral. For an executing run the engine only REQUESTS cancellation; the run settles asynchronously,
 * so the reply says "requested".
 */

import type {CancelOutcome} from '../../execute/cancel.js'
import type {CancelRefusal} from './cancel-target.js'
import type {FroBotDeps} from './fro-bot.js'
import type {GuildCommandCtx} from './guild-command.js'
import {toErrorMessage} from '@fro-bot/runtime'
import {Effect} from 'effect'
import {cancelRun} from '../../execute/cancel.js'
import {editInteraction} from '../io.js'
import {userIsAuthorized} from '../mentions.js'
import {resolveCancelTarget} from './cancel-target.js'
import {makeGuildCommand} from './guild-command.js'

const REFUSAL_COPY: Readonly<Record<CancelRefusal, string>> = {
  'unbound-channel': 'No repo is bound to this channel. Use `/fro-bot cancel` in a bound channel or in a run thread.',
  'not-a-run-thread':
    'This thread is not a run thread I can find. Use `/fro-bot cancel` inside the thread of the run you want to stop.',
  'other-channel': 'That run belongs to a different channel. Cancel it from there.',
  'run-finished': 'This run has already finished. Nothing to cancel.',
  'no-executing-run':
    'No run is executing here. Queued runs are not cancelled by this command; use `/fro-bot clear-queue`.',
  ambiguous:
    'More than one run looks active in this channel. Use `/fro-bot cancel` inside the thread of the run you want to stop.',
  'lookup-failed': 'Something went wrong looking up the run. Please try again.',
}

const CANCEL_ERROR_COPY = 'Something went wrong requesting the cancel. Please try again.'

function outcomeCopy(outcome: CancelOutcome): string {
  switch (outcome.outcome) {
    case 'cancelled':
      return outcome.wasQueued
        ? 'Cancelled the run before it started.'
        : 'Cancel requested. The run will stop shortly and the thread will show when it has.'
    case 'already-terminal':
      return `That run has already finished (${outcome.phase.toLowerCase()}). Nothing to cancel.`
    case 'quarantined':
      return 'That run has already failed and is being held while its work is confirmed stopped. Nothing to cancel.'
    case 'not-found':
      return 'I could not find that run any more. It may have just finished.'
    case 'retry':
      return 'That run was just starting. Try `/fro-bot cancel` again in a moment.'
  }
}

/** Build the `cancel` subcommand executor. */
export function createCancelCommand(deps: FroBotDeps): ReturnType<typeof makeGuildCommand> {
  return makeGuildCommand(
    {
      name: 'cancel',
      // Same gate as approvals and clear-queue. It is the trigger role when one is configured, otherwise guild
      // ManageChannels (the role does not widen to ManageChannels). Fail-closed on any resolution error.
      authorize: ctx =>
        Effect.promise(async () => ({
          authorized: await userIsAuthorized(ctx.guild, ctx.interaction.user.id, deps.triggerRoleId, ctx.log),
        })),
      denialCopy: 'You do not have permission to cancel runs.',
      work: ctx =>
        Effect.gen(function* () {
          const reply = (content: string) => editInteraction(ctx.interaction, {content}, ctx.log)
          const channelId = ctx.interaction.channelId

          const scope = yield* Effect.promise(async () => resolveScope(ctx))
          if (scope === undefined) {
            yield* reply(REFUSAL_COPY['lookup-failed'])
            return
          }

          const target = yield* Effect.promise(async () =>
            resolveCancelTarget({channelId, parentId: scope.parentId}, deps),
          )
          if (target.kind === 'refused') {
            ctx.log.info({channelId, reason: target.reason}, 'cancel: refused')
            yield* reply(REFUSAL_COPY[target.reason])
            return
          }

          const userId = ctx.interaction.user.id
          const outcome = yield* Effect.tryPromise({
            try: async () =>
              cancelRun(
                {runId: target.runId, actor: {kind: 'discord-user', discordUserId: userId}, logger: ctx.log},
                deps.cancelRunDeps,
              ),
            catch: error => (error instanceof Error ? error : new Error(String(error))),
          }).pipe(
            Effect.catchAll(error => {
              ctx.log.error({channelId, runId: target.runId, err: toErrorMessage(error)}, 'cancel: cancelRun threw')
              return Effect.succeed(null)
            }),
          )

          if (outcome === null) {
            yield* reply(CANCEL_ERROR_COPY)
            return
          }
          ctx.log.info({channelId, runId: target.runId, userId, outcome: outcome.outcome}, 'cancel: handled')
          yield* reply(outcomeCopy(outcome))
        }),
    },
    deps,
  )
}

/**
 * Whether the command ran in a thread, and that thread's parent channel id. `undefined` when the channel cannot be
 * determined: a thread read as a plain channel would be refused as unbound, so it is never guessed.
 */
async function resolveScope(ctx: GuildCommandCtx): Promise<{readonly parentId: string | null} | undefined> {
  try {
    const channel = ctx.interaction.channel ?? (await ctx.interaction.client.channels.fetch(ctx.interaction.channelId))
    if (channel === null) return undefined
    if (channel.isThread() === false) return {parentId: null}
    return channel.parentId === null ? undefined : {parentId: channel.parentId}
  } catch (error: unknown) {
    ctx.log.warn({channelId: ctx.interaction.channelId, err: toErrorMessage(error)}, 'cancel: channel lookup failed')
    return undefined
  }
}
