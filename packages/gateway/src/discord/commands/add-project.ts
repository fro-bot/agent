/**
 * `/fro-bot add-project` subcommand handler.
 *
 * Orchestrates the 5-phase flow:
 *   PRE_FLIGHT → CLONING → CREATING_CHANNEL → WRITING_BINDING → READY
 *
 * Security invariants:
 * - IAT (installation access token) is NEVER logged.
 * - Channel name is validated against hostile-character patterns before use.
 * - Owner/repo are canonicalized to lowercase before any lookup or write.
 */

import type {ChatInputCommandInteraction, Guild, PermissionsBitField} from 'discord.js'
import type {BindingsStore} from '../../bindings/store.js'
import type {AppClient} from '../../github/app-client.js'
import type {WorkspaceClient} from '../../workspace-api/client.js'
import type {GatewayLogger} from '../client.js'
import type {AuthDecision, GuildCommandCtx, GuildCommandDeps, PreDeferCtx, PreDeferSignal} from './guild-command.js'

import {PermissionFlagsBits} from 'discord.js'
import {Effect} from 'effect'

import {AppNotInstalledError} from '../../github/app-client.js'
import {workspaceRepoPath} from '../../workspace-api/client.js'
import {createChannelWithCollisionSuffix} from '../channels.js'
import {editInteractionAsync, replyInteractionAsync, sendMessage} from '../io.js'
import {makeGuildCommand} from './guild-command.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AddProjectPhase = 'PRE_FLIGHT' | 'CLONING' | 'CREATING_CHANNEL' | 'WRITING_BINDING' | 'READY' | 'FAILED'

export interface AddProjectDeps extends GuildCommandDeps {
  readonly bindingsStore: BindingsStore
  readonly appClient: AppClient
  readonly workspaceClient: WorkspaceClient
  readonly installUrl: string
  readonly logger: {
    readonly info: (msg: string, meta?: Record<string, unknown>) => void
    readonly warn: (msg: string, meta?: Record<string, unknown>) => void
    readonly error: (msg: string, meta?: Record<string, unknown>) => void
  }
  /**
   * Optional. Defaults to `() => false` when absent so callers that don't inject it
   * are unaffected. When present, returning `true` causes the command to bail early
   * with a user-friendly restart message instead of starting work that will be hard-killed.
   */
  readonly isShuttingDown?: () => boolean
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per-user, v1)
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 5

interface RateLimitEntry {
  readonly count: number
  readonly windowStart: number
}

const rateLimitMap = new Map<string, RateLimitEntry>()

function checkRateLimit(userId: string): {allowed: boolean; retryAfterMs: number} {
  const now = Date.now()
  const entry = rateLimitMap.get(userId)

  // Opportunistic eviction: sweep expired entries on every check (O(N), N is small).
  for (const [uid, e] of rateLimitMap) {
    if (now - e.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(uid)
    }
  }

  if (entry === undefined || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(userId, {count: 1, windowStart: now})
    return {allowed: true, retryAfterMs: 0}
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)
    return {allowed: false, retryAfterMs}
  }

  rateLimitMap.set(userId, {count: entry.count + 1, windowStart: entry.windowStart})
  return {allowed: true, retryAfterMs: 0}
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/

// TODO(future): tighten slug validation. GitHub's actual rules:
// - owner: 1-39 chars, alphanumeric + hyphen, no leading/trailing/consecutive hyphens
// - repo: 1-100 chars, alphanumeric + hyphen + underscore + period, similar rules
// Current regex accepts any non-slash sequence; relies on GitHub App auth to reject invalid
// slugs, which surfaces as "App not installed" — a misleading error for typos.
function parseGitHubUrl(url: string): {owner: string; repo: string} | null {
  const match = GITHUB_URL_RE.exec(url)
  if (match === null) return null
  const [, ownerRaw, repoRaw] = match
  if (ownerRaw === undefined || repoRaw === undefined) return null
  return {owner: ownerRaw, repo: repoRaw}
}

// ---------------------------------------------------------------------------
// Channel name validation and derivation
// ---------------------------------------------------------------------------

// Hostile characters: zero-width, RTL overrides, bidi
const HOSTILE_CHAR_RE = /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/

// Valid Discord channel name: lowercase letters, digits, hyphens; 1-100 chars; starts with letter/digit
const VALID_CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/

function validateChannelName(name: string): string | null {
  if (HOSTILE_CHAR_RE.test(name)) {
    return 'Channel name contains disallowed characters (zero-width or bidirectional override characters are not permitted).'
  }
  if (!VALID_CHANNEL_NAME_RE.test(name)) {
    return 'Channel name must be 1-100 characters, lowercase letters/digits/hyphens only, and start with a letter or digit.'
  }
  return null
}

function deriveChannelName(repo: string): string | null {
  // Strip scope (@scoped/package → package)
  let name = repo.replace(/^@[^/]+\//, '')
  // Lowercase
  name = name.toLowerCase()
  // Replace dots, underscores, spaces with hyphens
  name = name.replaceAll(/[._\s]+/g, '-')
  // Collapse multiple hyphens
  name = name.replaceAll(/-{2,}/g, '-')
  // Trim leading/trailing hyphens
  name = name.replaceAll(/^-+|-+$/g, '')
  // Truncate to 100 chars
  name = name.slice(0, 100)
  if (name.length === 0) return null
  return name
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

function botHasRequiredPermissions(appPermissions: PermissionsBitField | null): boolean {
  if (appPermissions === null) return false // DM interaction
  return appPermissions.has(PermissionFlagsBits.ManageChannels) && appPermissions.has(PermissionFlagsBits.SendMessages)
}

// Invoking-user authorization gate: prevents privilege amplification where a member coerces
// the bot's broader ManageChannels permission to create channels they could not create themselves.
// Uses guild-level base permissions (no channel overwrites) to prevent a user with a
// channel-scoped ManageChannels overwrite from bypassing the gate.
async function userIsAuthorized(guild: Guild, userId: string, logger: AddProjectDeps['logger']): Promise<boolean> {
  try {
    // guild.members.fetch() is a REST call — works without the privileged GuildMembers intent.
    // Do NOT use guild.members.cache.get() — returns undefined without the intent.
    const member = await guild.members.fetch(userId)
    // member.permissions is the guild-level base permission set (no channel overwrites).
    return member.permissions.has(PermissionFlagsBits.ManageChannels)
  } catch (error) {
    // Fail closed: if we cannot resolve the member's guild permissions, deny.
    logger.warn('add-project: member permission resolution failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

// ---------------------------------------------------------------------------
// Interaction window guard (14-minute limit)
// ---------------------------------------------------------------------------

const INTERACTION_WINDOW_MS = 14 * 60 * 1000

// ---------------------------------------------------------------------------
// Pipeline spec builder
// ---------------------------------------------------------------------------

/**
 * Build the `makeGuildCommand` spec for `/fro-bot add-project`.
 *
 * Entry sequence (pipeline-owned):
 *   preDefer (rate-limit check) → guild-null guard (pipeline) → deferReply → authorize → work
 *
 * The phase orchestration body (clone/channel/binding phases) is the work function.
 */
export function buildAddProjectSpec(deps: AddProjectDeps): {
  readonly preDefer: (ctx: PreDeferCtx) => Effect.Effect<PreDeferSignal, never>
  readonly authorize: (ctx: GuildCommandCtx) => Effect.Effect<AuthDecision, never>
  readonly work: (ctx: GuildCommandCtx) => Effect.Effect<void, Error>
} {
  const preDefer = (ctx: PreDeferCtx): Effect.Effect<PreDeferSignal, never> => {
    const userId = ctx.interaction.user.id
    const rateCheck = checkRateLimit(userId)
    if (rateCheck.allowed === true) {
      return Effect.succeed({proceed: true as const})
    }
    const retryAfterSec = Math.ceil(rateCheck.retryAfterMs / 1000)
    return Effect.promise(async () => {
      await replyInteractionAsync(
        ctx.interaction,
        {
          content: `You're doing that too fast. Try again in ${retryAfterSec} seconds.`,
          ephemeral: true,
        },
        ctx.log,
      )
      return {proceed: false as const}
    })
  }

  const authorize = (ctx: GuildCommandCtx): Effect.Effect<AuthDecision, never> => {
    return Effect.promise(async () => {
      // Shutdown gate — must precede any auth REST calls (guild.members.fetch).
      // Refusing here avoids a misleading permission-denial if the fetch fails
      // during draining shutdown. The user sees a restart message, not a denial.
      const shuttingDownCheck = deps.isShuttingDown ?? (() => false)
      if (shuttingDownCheck() === true) {
        return {
          authorized: false as const,
          copy: 'fro-bot is restarting. Please try `/fro-bot add-project` again in a moment.',
        }
      }

      // Bot-permission gate: ManageChannels + SendMessages required.
      if (botHasRequiredPermissions(ctx.interaction.appPermissions) === false) {
        ctx.log.warn({channelId: ctx.interaction.channelId}, 'add-project: missing bot permissions')
        return {
          authorized: false as const,
          copy: `fro-bot needs **Manage Channels** and **Send Messages** permissions. Re-invite the bot at: ${deps.installUrl}`,
        }
      }

      // User authorization gate: invoking user must hold guild-level ManageChannels.
      // setDefaultMemberPermissions is NOT used — it would gate the entire /fro-bot parent
      // command (including /ping). This is a scoped runtime check per subcommand.
      const authorized = await userIsAuthorized(ctx.guild, ctx.interaction.user.id, deps.logger)
      if (authorized === false) {
        ctx.log.warn({channelId: ctx.interaction.channelId}, 'add-project: unauthorized user')
        return {
          authorized: false as const,
          copy: 'You need the **Manage Channels** permission to use this command.',
        }
      }

      return {authorized: true as const}
    })
  }

  const work = (ctx: GuildCommandCtx): Effect.Effect<void, Error> => {
    return Effect.tryPromise({
      try: async () => runAddProjectPhases(ctx.interaction, ctx.guild, ctx.log, deps),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })
  }

  return {preDefer, authorize, work}
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/**
 * Execute the `/fro-bot add-project` command.
 *
 * @param interaction - The Discord slash command interaction.
 * @param deps - Injected dependencies (bindings store, app client, workspace client, logger).
 */
export function executeAddProject(
  interaction: ChatInputCommandInteraction,
  deps: AddProjectDeps,
): Effect.Effect<void, Error> {
  const {preDefer, authorize, work} = buildAddProjectSpec(deps)
  const executor = makeGuildCommand(
    {name: 'add-project', preDefer, authorize, work, serverOnlyCopy: 'This command can only be used in a server.'},
    deps,
  )
  return executor(interaction)
}

async function runAddProjectPhases(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  log: GatewayLogger,
  deps: AddProjectDeps,
): Promise<void> {
  const {bindingsStore, appClient, workspaceClient, installUrl, logger} = deps
  const correlationId = interaction.id
  const startTime = Date.now()

  // ---------------------------------------------------------------------------
  // PRE_FLIGHT
  // ---------------------------------------------------------------------------
  let phase: AddProjectPhase = 'PRE_FLIGHT'
  logger.info('add-project phase', {correlationId, phase, outcome: 'start'})

  // Parse and validate URL
  const rawUrl = interaction.options.getString('url', true)
  const parsed = parseGitHubUrl(rawUrl)
  if (parsed === null) {
    await editInteractionAsync(
      interaction,
      {content: 'Invalid GitHub URL. Expected format: `https://github.com/owner/repo`'},
      log,
    )
    return
  }

  // Canonicalize to lowercase (security requirement)
  const owner = parsed.owner.toLowerCase()
  const repo = parsed.repo.toLowerCase()

  // Resolve channel name
  const rawChannelName = interaction.options.getString('channel')
  let channelName: string

  if (rawChannelName === null) {
    const derived = deriveChannelName(repo)
    if (derived === null) {
      await editInteractionAsync(
        interaction,
        {content: "Couldn't derive a channel name from the repo name. Please specify `channel:<name>` explicitly."},
        log,
      )
      return
    }
    channelName = derived
  } else {
    const validationError = validateChannelName(rawChannelName)
    if (validationError !== null) {
      await editInteractionAsync(interaction, {content: validationError}, log)
      return
    }
    channelName = rawChannelName
  }

  // Check if already bound
  const existingResult = await bindingsStore.getBindingByRepo(owner, repo)
  if (existingResult.success === false) {
    logger.error('add-project: store error during pre-flight lookup', {
      correlationId,
      phase,
      errorKind: existingResult.error.message,
    })
    await editInteractionAsync(
      interaction,
      {content: 'Internal error checking existing bindings. Please try again.'},
      log,
    )
    return
  }
  if (existingResult.data !== null) {
    await editInteractionAsync(
      interaction,
      {
        content: [
          `\`${owner}/${repo}\` is already set up in <#${existingResult.data.channelId}>.`,
          `If the workspace was recently recreated and the checkout is missing, @mention fro-bot in <#${existingResult.data.channelId}> — it will repair the missing checkout automatically.`,
        ].join(' '),
      },
      log,
    )
    return
  }

  // App auth
  const authResult = await appClient.authForRepo(owner, repo)
  if (authResult.success === false) {
    if (authResult.error instanceof AppNotInstalledError) {
      await editInteractionAsync(
        interaction,
        {
          content: `The fro-bot GitHub App is not installed on \`${owner}/${repo}\`. Install it at: ${authResult.error.installUrl}`,
        },
        log,
      )
    } else {
      // Do NOT surface authResult.error.message — it may contain tokens or internal details.
      await editInteractionAsync(
        interaction,
        {
          content: `GitHub App authentication failed. Check that the fro-bot GitHub App is installed on \`${owner}/${repo}\` and retry.`,
        },
        log,
      )
    }
    logger.warn('add-project: app auth failed', {
      correlationId,
      phase,
      errorKind: authResult.error.constructor.name,
      durationMs: Date.now() - startTime,
      outcome: 'error',
    })
    return
  }

  const {token} = authResult.data

  // Capture the repo's immutable numeric id and node_id for the redaction deny-key gate.
  // Folds into the existing auth flow — getRepoIdentity reuses the cached installation id,
  // so this is not a new auth round-trip.
  // Failure is non-fatal: the binding is written without deny keys (fails closed at the gate later).
  let databaseId: number | undefined
  let nodeId: string | undefined
  const identityResult = await appClient.getRepoIdentity(owner, repo)
  if (identityResult.success === false) {
    logger.warn('add-project: repo identity capture failed; binding will lack deny keys', {
      correlationId,
      phase,
      owner,
      repo,
    })
  } else {
    databaseId = identityResult.data.databaseId
    nodeId = identityResult.data.nodeId
  }

  logger.info('add-project phase', {correlationId, phase, outcome: 'success', durationMs: Date.now() - startTime})

  // ---------------------------------------------------------------------------
  // CLONING
  // ---------------------------------------------------------------------------
  phase = 'CLONING'
  logger.info('add-project phase', {correlationId, phase, owner, repo, channelName, outcome: 'start'})

  // Interaction window guard
  if (Date.now() - startTime > INTERACTION_WINDOW_MS) {
    logger.warn('add-project: interaction window exhausted', {correlationId, phase, owner, repo})
    await editInteractionAsync(
      interaction,
      {
        content:
          'The operation took too long and the interaction window expired. Clone may have started — check workspace. Retry the command.',
      },
      log,
    )
    return
  }

  const cloneResult = await workspaceClient.clone({owner, repo, token})
  // Intentionally uninitialized: TypeScript's definite-assignment analysis enforces that
  // every path below either assigns workspacePath (fresh clone success, or repo-exists resume)
  // or returns. A sentinel default would defeat that compile-time guard — if a future edit
  // drops a return in an error branch, tsc errors here instead of passing an empty path to
  // channel creation. Do not initialize.
  let workspacePath: string
  if (cloneResult.success === false) {
    const errorKind = cloneResult.error.kind
    logger.warn('add-project: clone failed', {correlationId, phase, owner, repo, errorKind, outcome: 'error'})

    if (errorKind === 'clone-error') {
      const code = cloneResult.error.code
      if (code === 'enospc' || code === 'disk-full') {
        await editInteractionAsync(
          interaction,
          {
            content:
              'The workspace volume is out of space. Free disk by removing unused repos under `/workspace/repos` and retry.',
          },
          log,
        )
        return
      } else if (code === 'repo-exists') {
        // repo-exists means the workspace-agent completed the clone atomically (temp dir renamed
        // to destPath). Decide: redirect (already bound), resume (clone exists, no binding), or
        // error (store unavailable — do NOT resume; orphan risk).
        //
        // Never emit deletion instructions — we must never instruct the user to rm -rf.
        let existing: Awaited<ReturnType<typeof bindingsStore.getBindingByRepo>>
        try {
          existing = await bindingsStore.getBindingByRepo(owner, repo)
        } catch {
          await editInteractionAsync(
            interaction,
            {content: 'Internal error checking existing bindings. Please retry in a moment.'},
            log,
          )
          return
        }
        if (existing.success === false) {
          await editInteractionAsync(
            interaction,
            {content: 'Internal error checking existing bindings. Please retry in a moment.'},
            log,
          )
          return
        }
        if (existing.data !== null) {
          // Genuinely already bound — redirect to the bound channel. Nothing to resume.
          // Include the same recovery guidance as the PRE_FLIGHT already-bound path:
          // if the workspace was recreated, the user can repair the missing checkout
          // by @mentioning fro-bot in the bound channel.
          await editInteractionAsync(
            interaction,
            {
              content: [
                `\`${owner}/${repo}\` is already set up in <#${existing.data.channelId}>.`,
                `If the workspace was recently recreated and the checkout is missing, @mention fro-bot in <#${existing.data.channelId}> — it will repair the missing checkout automatically.`,
              ].join(' '),
            },
            log,
          )
          return
        }
        // Clone exists but no binding — a prior run failed after CLONING. Resume from CREATING_CHANNEL.
        // Concurrency: a racing invocation also resuming will have its createBinding rejected with
        // BINDING_EXISTS_ERROR (atomic IfNoneMatch write), handled below (~line ~500). The losing run
        // may leave an orphan channel — accepted v1 fallout (see docs/solutions orchestration-patterns).
        workspacePath = workspaceRepoPath(owner, repo)
        logger.info('add-project phase', {phase: 'CLONING', outcome: 'resumed', owner, repo, correlationId})
        // fall through — do NOT return
      } else {
        // Do NOT surface the internal code — it may confuse users and leaks implementation details.
        const cloneFailResult = await editInteractionAsync(
          interaction,
          {content: `Clone failed. Check workspace-agent logs for details and retry.`},
          log,
        )
        if (cloneFailResult.success === false) {
          log.error({err: cloneFailResult.error.message}, 'add-project: failed to deliver final status to user')
        }
        return
      }
    } else if (errorKind === 'timeout') {
      const timeoutResult = await editInteractionAsync(
        interaction,
        {content: 'Clone timed out (5 minutes). The repo may be very large. Retry.'},
        log,
      )
      if (timeoutResult.success === false) {
        log.error({err: timeoutResult.error.message}, 'add-project: failed to deliver final status to user')
      }
      return
    } else if (errorKind === 'response-mismatch') {
      logger.error('add-project: response-mismatch from workspace agent', {correlationId, phase, owner, repo})
      await editInteractionAsync(
        interaction,
        {content: 'Internal error: workspace agent returned unexpected response. Contact operator.'},
        log,
      )
      return
    } else {
      // Do NOT surface the internal errorKind — it leaks implementation details.
      await editInteractionAsync(
        interaction,
        {content: `Clone failed. Check workspace-agent connectivity and retry.`},
        log,
      )
      return
    }
  } else {
    workspacePath = cloneResult.data.path
    logger.info('add-project phase', {
      correlationId,
      phase,
      owner,
      repo,
      workspacePath,
      outcome: 'success',
      durationMs: Date.now() - startTime,
    })
  }

  // ---------------------------------------------------------------------------
  // CREATING_CHANNEL
  // ---------------------------------------------------------------------------
  phase = 'CREATING_CHANNEL'
  logger.info('add-project phase', {correlationId, phase, owner, repo, channelName, outcome: 'start'})

  // Defensive permission re-check
  if (botHasRequiredPermissions(interaction.appPermissions) === false) {
    logger.warn('add-project: permissions revoked between pre-flight and channel creation', {
      correlationId,
      phase,
      workspacePath,
    })
    await editInteractionAsync(
      interaction,
      {
        content: `fro-bot lost **Manage Channels** permission. The clone is preserved — re-grant permissions and retry the command.`,
      },
      log,
    )
    return
  }

  // Interaction window guard
  if (Date.now() - startTime > INTERACTION_WINDOW_MS) {
    logger.warn('add-project: interaction window exhausted', {correlationId, phase, owner, repo, workspacePath})
    await editInteractionAsync(
      interaction,
      {content: `Interaction window expired. The clone is preserved — retry the command.`},
      log,
    )
    return
  }

  const channelResult = await createChannelWithCollisionSuffix(guild, channelName, {maxSuffix: 10})
  if (channelResult.success === false) {
    const errorKind = channelResult.error.kind
    logger.warn('add-project: channel creation failed', {
      correlationId,
      phase,
      owner,
      repo,
      channelName,
      errorKind,
      outcome: 'error',
    })

    if (errorKind === 'collision-exhausted') {
      await editInteractionAsync(
        interaction,
        {
          content: `Couldn't find an available channel name after 10 attempts. Specify \`channel:<name>\` explicitly.`,
        },
        log,
      )
    } else if (errorKind === 'permission-denied') {
      await editInteractionAsync(
        interaction,
        {content: `fro-bot lacks permission to create channels. Re-invite at: ${installUrl}`},
        log,
      )
    } else {
      // Do NOT surface channelResult.error.message — it may contain internal Discord API details.
      await editInteractionAsync(
        interaction,
        {content: `Failed to create channel. Check fro-bot's permissions and retry.`},
        log,
      )
    }
    return
  }

  const channel = channelResult.data
  logger.info('add-project phase', {
    correlationId,
    phase,
    owner,
    repo,
    channelName: channel.name,
    channelId: channel.id,
    outcome: 'success',
    durationMs: Date.now() - startTime,
  })

  // ---------------------------------------------------------------------------
  // WRITING_BINDING
  // ---------------------------------------------------------------------------
  phase = 'WRITING_BINDING'
  logger.info('add-project phase', {correlationId, phase, owner, repo, channelName: channel.name, outcome: 'start'})

  const binding = {
    owner,
    repo,
    channelId: channel.id,
    channelName: channel.name,
    workspacePath,
    createdAt: new Date().toISOString(),
    createdByDiscordId: interaction.user.id,
    // Deny keys for the redaction gate — captured at ingest, absent on failure (fails closed later).
    ...(databaseId === undefined ? {} : {databaseId}),
    ...(nodeId === undefined ? {} : {nodeId}),
  }

  const bindingResult = await bindingsStore.createBinding(binding)
  if (bindingResult.success === false) {
    const error = bindingResult.error
    logger.error('add-project: binding write failed', {
      correlationId,
      phase,
      owner,
      repo,
      errorKind: error.message,
      outcome: 'error',
    })

    if ('code' in error && error.code === 'BINDING_EXISTS_ERROR') {
      // Concurrent setup raced past PRE_FLIGHT
      await editInteractionAsync(
        interaction,
        {
          content: `\`${owner}/${repo}\` was bound by a concurrent request. Channel #${channel.name} was created by this request — manual cleanup may be needed.`,
        },
        log,
      )
    } else if ('code' in error && error.code === 'BINDING_PARTIAL_WRITE_ERROR') {
      // TypeScript narrows error to PartialWriteError via the discriminant above.
      // Log the S3 keys for operator recovery; do NOT surface them in the Discord reply.
      logger.error('add-project: partial write — operator action required', {
        correlationId,
        phase,
        owner,
        repo,
        primaryKey: 'primaryKey' in error ? error.primaryKey : undefined,
        indexKey: 'indexKey' in error ? error.indexKey : undefined,
      })
      await editInteractionAsync(
        interaction,
        {
          content: `Partial write error: the binding was partially saved. Please contact the operator to complete the setup for \`${owner}/${repo}\`.`,
        },
        log,
      )
    } else {
      await editInteractionAsync(
        interaction,
        {
          content: `Failed to write binding. Channel #${channel.name} was created. Retry the command — pre-flight will detect the existing channel.`,
        },
        log,
      )
    }
    return
  }

  logger.info('add-project phase', {
    correlationId,
    phase,
    owner,
    repo,
    outcome: 'success',
    durationMs: Date.now() - startTime,
  })

  // ---------------------------------------------------------------------------
  // READY
  // ---------------------------------------------------------------------------
  phase = 'READY'
  logger.info('add-project phase', {correlationId, phase, owner, repo, channelName: channel.name, outcome: 'start'})

  const readyResult = await editInteractionAsync(
    interaction,
    {content: `✅ Ready — try @fro-bot in #${channel.name}`},
    log,
  )
  if (readyResult.success === false) {
    // Token expiry after a long clone is the realistic failure mode here.
    // Escalate to ERROR so operators can see the user never got the success confirmation.
    log.error({err: readyResult.error.message}, 'add-project: failed to deliver final status to user')
  }

  // Post welcome message in the new channel.
  // channel.send is a Message/Thread surface send — use sendMessage from io.ts.
  const welcomeResult = await sendMessage(
    channel,
    {
      embeds: [
        {
          title: `Bound to ${owner}/${repo}`,
          description: [
            `This channel is bound to ${owner}/${repo}.`,
            '',
            '@-mention fro-bot in this channel to ask questions or have it act on the repo.',
          ].join('\n'),
          color: 0x57f287, // success-green
        },
      ],
    },
    log,
  )

  if (welcomeResult.success === false) {
    logger.warn('add-project: welcome message post failed', {
      correlationId,
      phase,
      owner,
      repo,
      channelName: channel.name,
      err: welcomeResult.error.message,
    })
    await editInteractionAsync(
      interaction,
      {
        content: `✅ Channel #${channel.name} created and bound to \`${owner}/${repo}\`, but couldn't post the welcome message — verify fro-bot has **Send Messages** in #${channel.name}.`,
      },
      log,
    )
    return
  }

  logger.info('add-project phase', {
    correlationId,
    phase,
    owner,
    repo,
    channelName: channel.name,
    outcome: 'success',
    durationMs: Date.now() - startTime,
  })
}
