/**
 * `/fro-bot dispatch` subcommand.
 *
 * This command only asks GitHub Actions to accept a workflow dispatch. It does
 * not enter the gateway queue, acquire a local execution slot, or create local
 * run state.
 */

import type {ChatInputCommandInteraction} from 'discord.js'
import type {DispatchOutcome} from '../../github/dispatch.js'
import type {FroBotDeps} from './fro-bot.js'
import type {AuthDecision, GuildCommandCtx} from './guild-command.js'

import {Effect} from 'effect'

import {resolveRepoAccess} from '../../web/operator/route-helpers.js'
import {editInteraction} from '../io.js'
import {userIsAuthorized} from '../mentions.js'
import {INTERNAL_ERROR_COPY, makeGuildCommand} from './guild-command.js'

function invalidTaskCopy(): string {
  return 'Provide a non-empty task with `/fro-bot dispatch task:<task>`.'
}

function repoSlug(owner: string, repo: string): string {
  return `${owner}/${repo}`
}

// One refusal for denied, unbound and policy-unavailable repos: the copy must not reveal which, nor whether a
// denylist exists. Mirrors the operator launch route's uniform 404.
const REPO_ACCESS_REFUSAL_COPY = 'This repository is not available for dispatch.'

function acceptedCopy(owner: string, repo: string, runUrl: string | undefined): string {
  if (runUrl === undefined) {
    return `✅ GitHub accepted the dispatch for \`${repoSlug(owner, repo)}\`, but the run link is unavailable. Check GitHub Actions for the run.`
  }
  return `✅ GitHub accepted the dispatch for \`${repoSlug(owner, repo)}\`. Track the run here: ${runUrl}`
}

function outcomeCopy(outcome: DispatchOutcome): string {
  switch (outcome.outcome) {
    case 'accepted':
      return acceptedCopy(outcome.owner, outcome.repo, outcome.runUrl)
    case 'invalid-task':
      return invalidTaskCopy()
    case 'app-not-installed':
      return `The fro-bot GitHub App is not installed on \`${repoSlug(outcome.owner, outcome.repo)}\`. Install it at: ${outcome.installUrl}`
    case 'missing-actions-permission':
      return `The GitHub App needs **Actions: write** for \`${repoSlug(outcome.owner, outcome.repo)}\`. Update the installation at: ${outcome.installUrl}`
    case 'missing-permissions':
      return `The GitHub App is missing permissions (${outcome.missingPermissions.join(', ')}) for \`${repoSlug(outcome.owner, outcome.repo)}\`. Update the installation at: ${outcome.installUrl}`
    case 'repo-not-found':
      return `GitHub could not find repository \`${repoSlug(outcome.owner, outcome.repo)}\`.`
    case 'workflow-not-found':
      return `GitHub could not dispatch the fixed workflow for \`${repoSlug(outcome.owner, outcome.repo)}\`. The repository or workflow may no longer be available.`
    case 'dispatch-rejected':
      return `GitHub rejected the workflow dispatch for \`${repoSlug(outcome.owner, outcome.repo)}\`. Please try again.`
    case 'github-unavailable':
      return 'GitHub is temporarily unavailable. Please try again.'
    default: {
      const exhaustiveCheck: never = outcome
      return exhaustiveCheck
    }
  }
}

export function buildDispatchSpec(deps: FroBotDeps): {
  readonly authorize: (ctx: GuildCommandCtx) => Effect.Effect<AuthDecision, never>
  readonly work: (ctx: GuildCommandCtx) => Effect.Effect<void, Error>
} {
  const authorize = (ctx: GuildCommandCtx): Effect.Effect<AuthDecision, never> =>
    Effect.promise(async () => {
      const authorized = await userIsAuthorized(ctx.guild, ctx.interaction.user.id, deps.triggerRoleId, ctx.log)
      if (authorized === true) return {authorized: true as const}
      return {authorized: false as const, copy: 'You are not authorized to dispatch tasks here.'}
    })

  const work = (ctx: GuildCommandCtx): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const task = ctx.interaction.options.getString('task', true)
      if (task.trim().length === 0) {
        yield* editInteraction(ctx.interaction, {content: invalidTaskCopy()}, ctx.log)
        return
      }

      const channelId = ctx.interaction.channelId
      const bindingResult = yield* Effect.tryPromise({
        try: async () => deps.bindingsStore.getBindingByChannelId(channelId),
        catch: error => (error instanceof Error ? error : new Error(String(error))),
      })

      if (bindingResult.success === false) {
        ctx.log.error({channelId, err: bindingResult.error.message}, 'dispatch: binding lookup failed')
        yield* editInteraction(ctx.interaction, {content: INTERNAL_ERROR_COPY}, ctx.log)
        return
      }

      const channelBinding = bindingResult.data
      if (channelBinding === null) {
        yield* editInteraction(
          ctx.interaction,
          {content: 'This channel is not bound to a repository. Use `/fro-bot add-project` first.'},
          ctx.log,
        )
        return
      }

      // Same predicate as the operator web routes: bound AND not denylisted, fail-closed. It re-reads the binding by
      // repo, so the dispatch below targets the stored binding, never the channel row's spelling.
      const access = yield* Effect.promise(async () =>
        resolveRepoAccess(channelBinding.owner, channelBinding.repo, {
          bindingsLookup: deps.bindingsStore,
          denylistCache: deps.denylistCache,
        }),
      )
      if (access.kind !== 'allowed') {
        ctx.log.warn(
          {channelId, gate: access.kind === 'denied' ? 'repo-denied' : 'repo-unavailable'},
          'dispatch: denied — repo access',
        )
        yield* editInteraction(ctx.interaction, {content: REPO_ACCESS_REFUSAL_COPY}, ctx.log)
        return
      }

      const {owner, repo} = access.binding
      const outcome = yield* Effect.tryPromise({
        try: async () => deps.dispatchWorkflow(owner, repo, task),
        catch: error => (error instanceof Error ? error : new Error(String(error))),
      })
      yield* editInteraction(ctx.interaction, {content: outcomeCopy(outcome)}, ctx.log)
    })

  return {authorize, work}
}

export function executeDispatch(
  interaction: ChatInputCommandInteraction,
  deps: FroBotDeps,
): Effect.Effect<void, Error> {
  const {authorize, work} = buildDispatchSpec(deps)
  return makeGuildCommand(
    {
      name: 'dispatch',
      authorize,
      work,
      serverOnlyCopy: 'This command can only be used in a server.',
    },
    deps,
  )(interaction)
}
