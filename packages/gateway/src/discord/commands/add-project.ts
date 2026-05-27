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

import type {ChatInputCommandInteraction, PermissionsBitField} from 'discord.js'
import type {BindingsStore} from '../../bindings/store.js'
import type {AppClient} from '../../github/app-client.js'
import type {WorkspaceClient} from '../../workspace-api/client.js'

import {PermissionFlagsBits} from 'discord.js'
import {Effect} from 'effect'

import {AppNotInstalledError} from '../../github/app-client.js'
import {createChannelWithCollisionSuffix} from '../channels.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AddProjectPhase = 'PRE_FLIGHT' | 'CLONING' | 'CREATING_CHANNEL' | 'WRITING_BINDING' | 'READY' | 'FAILED'

export interface AddProjectDeps {
  readonly bindingsStore: BindingsStore
  readonly appClient: AppClient
  readonly workspaceClient: WorkspaceClient
  readonly installUrl: string
  readonly logger: {
    readonly info: (msg: string, meta?: Record<string, unknown>) => void
    readonly warn: (msg: string, meta?: Record<string, unknown>) => void
    readonly error: (msg: string, meta?: Record<string, unknown>) => void
  }
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

// ---------------------------------------------------------------------------
// Interaction window guard (14-minute limit)
// ---------------------------------------------------------------------------

const INTERACTION_WINDOW_MS = 14 * 60 * 1000

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
  return Effect.tryPromise({
    try: async () => runAddProject(interaction, deps),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })
}

async function runAddProject(interaction: ChatInputCommandInteraction, deps: AddProjectDeps): Promise<void> {
  const {bindingsStore, appClient, workspaceClient, installUrl, logger} = deps
  const correlationId = interaction.id
  const startTime = Date.now()

  // ---------------------------------------------------------------------------
  // Rate limit check (before deferReply — fast path)
  // ---------------------------------------------------------------------------
  const userId = interaction.user.id
  const rateCheck = checkRateLimit(userId)
  if (!rateCheck.allowed) {
    const retryAfterSec = Math.ceil(rateCheck.retryAfterMs / 1000)
    await interaction.reply({
      content: `You're doing that too fast. Try again in ${retryAfterSec} seconds.`,
      ephemeral: true,
    })
    return
  }

  // ---------------------------------------------------------------------------
  // PRE_FLIGHT
  // ---------------------------------------------------------------------------
  let phase: AddProjectPhase = 'PRE_FLIGHT'
  logger.info('add-project phase', {correlationId, phase, outcome: 'start'})

  // Defer reply (ephemeral — setup thread is operationally sensitive)
  await interaction.deferReply({ephemeral: true})

  const guild = interaction.guild
  if (guild === null) {
    await interaction.editReply({content: 'This command can only be used in a server.'})
    return
  }

  // Check bot permissions
  if (!botHasRequiredPermissions(interaction.appPermissions)) {
    logger.warn('add-project: missing bot permissions', {correlationId, phase})
    await interaction.editReply({
      content: `fro-bot needs **Manage Channels** and **Send Messages** permissions. Re-invite the bot at: ${installUrl}`,
    })
    return
  }

  // Parse and validate URL
  const rawUrl = interaction.options.getString('url', true)
  const parsed = parseGitHubUrl(rawUrl)
  if (parsed === null) {
    await interaction.editReply({
      content: 'Invalid GitHub URL. Expected format: `https://github.com/owner/repo`',
    })
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
      await interaction.editReply({
        content: "Couldn't derive a channel name from the repo name. Please specify `channel:<name>` explicitly.",
      })
      return
    }
    channelName = derived
  } else {
    const validationError = validateChannelName(rawChannelName)
    if (validationError !== null) {
      await interaction.editReply({content: validationError})
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
    await interaction.editReply({content: 'Internal error checking existing bindings. Please try again.'})
    return
  }
  if (existingResult.data !== null) {
    await interaction.editReply({
      content: `\`${owner}/${repo}\` is already bound to #${existingResult.data.channelName}. Bindings cannot be moved in v1. To rebind, manually delete the S3 key \`bindings/${owner}/${repo}/repo.json\` and retry.`,
    })
    return
  }

  // App auth
  const authResult = await appClient.authForRepo(owner, repo)
  if (authResult.success === false) {
    if (authResult.error instanceof AppNotInstalledError) {
      await interaction.editReply({
        content: `The fro-bot GitHub App is not installed on \`${owner}/${repo}\`. Install it at: ${authResult.error.installUrl}`,
      })
    } else {
      await interaction.editReply({
        content: `GitHub App authentication failed: ${authResult.error.message}`,
      })
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
  logger.info('add-project phase', {correlationId, phase, outcome: 'success', durationMs: Date.now() - startTime})

  // ---------------------------------------------------------------------------
  // CLONING
  // ---------------------------------------------------------------------------
  phase = 'CLONING'
  logger.info('add-project phase', {correlationId, phase, owner, repo, channelName, outcome: 'start'})

  // Interaction window guard
  if (Date.now() - startTime > INTERACTION_WINDOW_MS) {
    logger.warn('add-project: interaction window exhausted', {correlationId, phase, owner, repo})
    await interaction.editReply({
      content:
        'The operation took too long and the interaction window expired. Clone may have started — check workspace. Retry the command.',
    })
    return
  }

  const cloneResult = await workspaceClient.clone({owner, repo, token})
  if (cloneResult.success === false) {
    const errorKind = cloneResult.error.kind
    logger.warn('add-project: clone failed', {correlationId, phase, owner, repo, errorKind, outcome: 'error'})

    if (errorKind === 'clone-error') {
      const code = cloneResult.error.code
      if (code === 'enospc' || code === 'disk-full') {
        await interaction.editReply({
          content:
            'The workspace volume is out of space. Free disk by removing unused repos under `/workspace/repos` and retry.',
        })
      } else if (code === 'repo-exists') {
        await interaction.editReply({
          content: `The repo \`${owner}/${repo}\` already exists in the workspace. Remove it with \`rm -rf /workspace/repos/${owner}/${repo}\` and retry.`,
        })
      } else {
        await interaction.editReply({
          content: `Clone failed (${code}). Check workspace-agent logs for details.`,
        })
      }
    } else if (errorKind === 'timeout') {
      await interaction.editReply({content: 'Clone timed out (5 minutes). The repo may be very large. Retry.'})
    } else if (errorKind === 'response-mismatch') {
      logger.error('add-project: response-mismatch from workspace agent', {correlationId, phase, owner, repo})
      await interaction.editReply({
        content: 'Internal error: workspace agent returned unexpected response. Contact operator.',
      })
    } else {
      await interaction.editReply({content: `Clone failed (${errorKind}). Check workspace-agent connectivity.`})
    }
    return
  }

  const workspacePath = cloneResult.data.path
  logger.info('add-project phase', {
    correlationId,
    phase,
    owner,
    repo,
    workspacePath,
    outcome: 'success',
    durationMs: Date.now() - startTime,
  })

  // ---------------------------------------------------------------------------
  // CREATING_CHANNEL
  // ---------------------------------------------------------------------------
  phase = 'CREATING_CHANNEL'
  logger.info('add-project phase', {correlationId, phase, owner, repo, channelName, outcome: 'start'})

  // Defensive permission re-check
  if (!botHasRequiredPermissions(interaction.appPermissions)) {
    logger.warn('add-project: permissions revoked between pre-flight and channel creation', {correlationId, phase})
    await interaction.editReply({
      content: `fro-bot lost **Manage Channels** permission. Clone is preserved at \`${workspacePath}\`. Re-grant permissions and retry.`,
    })
    return
  }

  // Interaction window guard
  if (Date.now() - startTime > INTERACTION_WINDOW_MS) {
    logger.warn('add-project: interaction window exhausted', {correlationId, phase, owner, repo})
    await interaction.editReply({
      content: `Interaction window expired. Clone preserved at \`${workspacePath}\`. Retry the command.`,
    })
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
      await interaction.editReply({
        content: `Couldn't find an available channel name after 10 attempts. Specify \`channel:<name>\` explicitly.`,
      })
    } else if (errorKind === 'permission-denied') {
      await interaction.editReply({
        content: `fro-bot lacks permission to create channels. Re-invite at: ${installUrl}`,
      })
    } else {
      await interaction.editReply({
        content: `Failed to create channel: ${channelResult.error.message}`,
      })
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
      await interaction.editReply({
        content: `\`${owner}/${repo}\` was bound by a concurrent request. Channel #${channel.name} was created by this request — manual cleanup may be needed.`,
      })
    } else if ('code' in error && error.code === 'BINDING_PARTIAL_WRITE_ERROR') {
      // TypeScript narrows error to PartialWriteError via the discriminant above
      await interaction.editReply({
        content: `Partial write error: primary binding written but index failed. Manual S3 cleanup required:\n- Primary: \`${error.primaryKey}\`\n- Index: \`${error.indexKey}\``,
      })
    } else {
      await interaction.editReply({
        content: `Failed to write binding. Channel #${channel.name} was created. Retry the command — pre-flight will detect the existing channel.`,
      })
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

  await interaction.editReply({
    content: `✅ Ready — try @fro-bot in #${channel.name}`,
  })

  // Post welcome message in the new channel
  try {
    await channel.send({
      embeds: [
        {
          title: `Bound to ${owner}/${repo}`,
          description: [
            `This channel is bound to ${owner}/${repo}.`,
            '',
            "Once the interaction loop (Unit 6) ships, you'll be able to @-mention me here to ask questions or have me act on the repo.",
            '',
            'Until then, this channel is reserved for future use.',
          ].join('\n'),
          color: 0x57f287, // success-green
        },
      ],
    })
  } catch (welcomeError) {
    logger.warn('add-project: welcome message post failed', {
      correlationId,
      phase,
      owner,
      repo,
      channelName: channel.name,
      err: welcomeError instanceof Error ? welcomeError.message : String(welcomeError),
    })
    await interaction.editReply({
      content: `✅ Channel #${channel.name} created and bound to \`${owner}/${repo}\`, but couldn't post the welcome message — verify fro-bot has **Send Messages** in #${channel.name}.`,
    })
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
