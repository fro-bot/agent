/**
 * Tests for the `/fro-bot add-project` subcommand handler.
 *
 * Uses vitest with BDD-style comments (#given, #when, #then).
 * All Discord API calls are mocked — no real network or Discord connections.
 */

import type {ChatInputCommandInteraction, Guild, TextChannel} from 'discord.js'
import type {BindingsStore} from '../../bindings/store.js'
import type {AppClient} from '../../github/app-client.js'
import type {WorkspaceClient} from '../../workspace-api/client.js'
import type {AddProjectDeps} from './add-project.js'

import {err, ok} from '@fro-bot/runtime'
import {Effect} from 'effect'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {AppNotInstalledError} from '../../github/app-client.js'
import {executeAddProject} from './add-project.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): AddProjectDeps['logger'] {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

/** Extract the content string from the last editReply call. */
function lastEditReplyContent(editReply: ReturnType<typeof vi.fn>): string {
  const calls = editReply.mock.calls as [{content?: string}][]
  return calls.at(-1)?.[0]?.content ?? ''
}

/** Extract the content string from the last reply call. */
function lastReplyContent(reply: ReturnType<typeof vi.fn>): string {
  const calls = reply.mock.calls as [{content?: string}][]
  return calls.at(-1)?.[0]?.content ?? ''
}

/** Collect all editReply content strings across every call. */
function allEditReplies(editReply: ReturnType<typeof vi.fn>): string[] {
  return (editReply.mock.calls as [{content?: string}][]).map(c => c[0]?.content ?? '')
}

interface MockChannel {
  readonly channel: TextChannel
  readonly send: ReturnType<typeof vi.fn>
}

function makeTextChannel(name = 'my-repo', id = 'ch-123'): MockChannel {
  const send = vi.fn().mockResolvedValue(undefined)
  const channel = {name, id, send} as unknown as TextChannel
  return {channel, send}
}

function makeGuild(
  _botUserId = 'bot-user-id',
  hasPermissions = true,
  channels: TextChannel[] = [],
  createChannelResult?: TextChannel | Error,
): Guild {
  const permissions = {
    has: vi.fn().mockReturnValue(hasPermissions),
  }
  const member = {permissions}
  const members = {
    fetch: vi.fn().mockResolvedValue(member),
  }

  const channelCache = {
    find: (pred: (ch: TextChannel) => boolean) => channels.find(pred),
  }
  const create =
    createChannelResult instanceof Error
      ? vi.fn().mockRejectedValue(createChannelResult)
      : vi.fn().mockResolvedValue(createChannelResult ?? makeTextChannel().channel)

  return {
    members,
    channels: {cache: channelCache, create},
  } as unknown as Guild
}

interface MockInteraction {
  readonly interaction: ChatInputCommandInteraction
  readonly editReply: ReturnType<typeof vi.fn>
  readonly deferReply: ReturnType<typeof vi.fn>
  readonly reply: ReturnType<typeof vi.fn>
}

function makeInteraction(overrides: {
  url?: string
  channel?: string | null
  guild?: Guild | null
  userId?: string
  appPermissions?: {has: ReturnType<typeof vi.fn>} | null
}): MockInteraction {
  const {
    url = 'https://github.com/testowner/testrepo',
    channel = null,
    guild = makeGuild(),
    userId = 'user-123',
    appPermissions = {has: vi.fn().mockReturnValue(true)},
  } = overrides

  const deferReply = vi.fn().mockResolvedValue(undefined)
  const editReply = vi.fn().mockResolvedValue(undefined)
  const reply = vi.fn().mockResolvedValue(undefined)

  const getString = vi.fn().mockImplementation((name: string, required?: boolean) => {
    if (name === 'url') return url
    if (name === 'channel') return channel
    return required === true ? '' : null
  })

  const interaction = {
    id: 'interaction-id',
    user: {id: userId},
    guild,
    appPermissions,
    client: {user: {id: 'bot-user-id'}},
    options: {getString, getSubcommand: vi.fn().mockReturnValue('add-project')},
    deferReply,
    editReply,
    reply,
  } as unknown as ChatInputCommandInteraction

  return {interaction, editReply, deferReply, reply}
}

function makeBindingsStore(overrides?: {
  getBindingByRepo?: ReturnType<typeof vi.fn>
  createBinding?: ReturnType<typeof vi.fn>
}): BindingsStore {
  return {
    getBindingByRepo: overrides?.getBindingByRepo ?? vi.fn().mockResolvedValue(ok(null)),
    getBindingByChannelId: vi.fn().mockResolvedValue(ok(null)),
    listBindings: vi.fn().mockResolvedValue(ok([])),
    createBinding:
      overrides?.createBinding ?? vi.fn().mockResolvedValue(ok({primaryEtag: 'etag1', indexEtag: 'etag2'})),
  } as unknown as BindingsStore
}

function makeAppClient(overrides?: {authForRepo?: ReturnType<typeof vi.fn>}): AppClient {
  return {
    authForRepo:
      overrides?.authForRepo ?? vi.fn().mockResolvedValue(ok({octokit: {}, installationId: 1, token: 'ghs_testtoken'})),
    invalidateCache: vi.fn(),
  } as unknown as AppClient
}

function makeWorkspaceClient(overrides?: {clone?: ReturnType<typeof vi.fn>}): WorkspaceClient {
  return {
    clone:
      overrides?.clone ??
      vi.fn().mockResolvedValue(ok({ok: true, path: '/workspace/repos/testowner/testrepo', commit: 'abc123'})),
  } as unknown as WorkspaceClient
}

function makeDeps(overrides?: Partial<AddProjectDeps>): AddProjectDeps {
  return {
    bindingsStore: makeBindingsStore(),
    appClient: makeAppClient(),
    workspaceClient: makeWorkspaceClient(),
    installUrl: 'https://github.com/apps/fro-bot/installations/new',
    logger: makeLogger(),
    ...overrides,
  }
}

async function run(interaction: ChatInputCommandInteraction, deps: AddProjectDeps): Promise<void> {
  await Effect.runPromise(executeAddProject(interaction, deps))
}

// ---------------------------------------------------------------------------
// Reset rate limit state between tests
// ---------------------------------------------------------------------------

// The rate limiter is module-level state. We reset it by using unique user IDs per test.
let userIdCounter = 0
function uniqueUserId(): string {
  return `user-${++userIdCounter}`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeAddProject', () => {
  describe('happy path', () => {
    it('completes all phases and posts welcome message', async () => {
      // #given
      const userId = uniqueUserId()
      const {channel, send} = makeTextChannel('testrepo')
      const guild = makeGuild('bot-user-id', true, [], channel)
      const {interaction, editReply} = makeInteraction({guild, userId})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then — editReply called with success message
      expect(lastEditReplyContent(editReply)).toContain('Ready')
      // Welcome message posted in channel
      expect(send).toHaveBeenCalledOnce()
    })

    it('canonicalizes Owner/Repo to lowercase before binding', async () => {
      // #given
      const userId = uniqueUserId()
      const {channel} = makeTextChannel('testrepo')
      const guild = makeGuild('bot-user-id', true, [], channel)
      const {interaction} = makeInteraction({
        url: 'https://github.com/TestOwner/TestRepo',
        guild,
        userId,
      })
      const createBinding = vi.fn().mockResolvedValue(ok({primaryEtag: 'e1', indexEtag: 'e2'}))
      const deps = makeDeps({bindingsStore: makeBindingsStore({createBinding})})

      // #when
      await run(interaction, deps)

      // #then — binding written with lowercase owner/repo
      const calls = createBinding.mock.calls as [{owner: string; repo: string}][]
      expect(calls[0]?.[0]?.owner).toBe('testowner')
      expect(calls[0]?.[0]?.repo).toBe('testrepo')
    })
  })

  describe('PRE_FLIGHT: rate limiting', () => {
    it('rejects after 5 invocations within 60 seconds', async () => {
      // #given — same user ID for all 6 calls
      const userId = uniqueUserId()
      const guild = makeGuild('bot-user-id', true, [], makeTextChannel().channel)
      const deps = makeDeps()

      // #when — 5 allowed calls
      for (let i = 0; i < 5; i++) {
        const {interaction} = makeInteraction({guild, userId})
        await run(interaction, deps)
      }

      // 6th call should be rate-limited
      const {interaction: blockedInteraction, reply, deferReply} = makeInteraction({guild, userId})
      await run(blockedInteraction, deps)

      // #then — 6th call gets rate-limit reply (not deferReply)
      expect(lastReplyContent(reply)).toContain('too fast')
      expect(deferReply).not.toHaveBeenCalled()
    })
  })

  describe('PRE_FLIGHT: missing bot permissions', () => {
    it('aborts with install URL when bot lacks MANAGE_CHANNELS', async () => {
      // #given — appPermissions.has returns false (no permissions)
      const userId = uniqueUserId()
      const appPermissions = {has: vi.fn().mockReturnValue(false)}
      const {interaction, editReply} = makeInteraction({userId, appPermissions})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('https://github.com/apps/fro-bot/installations/new')
    })

    it('aborts gracefully when appPermissions is null (DM interaction)', async () => {
      // #given — null appPermissions simulates a DM context
      const userId = uniqueUserId()
      const {interaction, editReply} = makeInteraction({userId, appPermissions: null})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then — aborts with install URL (treated as missing permissions)
      expect(lastEditReplyContent(editReply)).toContain('https://github.com/apps/fro-bot/installations/new')
    })

    it('aborts when bot has ManageChannels but not SendMessages', async () => {
      // #given — has() returns true for ManageChannels, false for SendMessages
      const userId = uniqueUserId()
      const {PermissionFlagsBits} = await import('discord.js')
      const appPermissions = {
        has: vi.fn().mockImplementation((flag: bigint) => flag === PermissionFlagsBits.ManageChannels),
      }
      const {interaction, editReply} = makeInteraction({userId, appPermissions})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then — aborts with permission error message
      expect(lastEditReplyContent(editReply)).toContain('fro-bot needs')
    })
  })

  describe('PRE_FLIGHT: invalid URL', () => {
    it('rejects non-GitHub URLs', async () => {
      // #given
      const userId = uniqueUserId()
      const {interaction, editReply} = makeInteraction({url: 'https://gitlab.com/owner/repo', userId})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('Invalid GitHub URL')
    })

    it('rejects bare owner/repo strings', async () => {
      // #given
      const userId = uniqueUserId()
      const {interaction, editReply} = makeInteraction({url: 'owner/repo', userId})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('Invalid GitHub URL')
    })
  })

  describe('PRE_FLIGHT: hostile channel name', () => {
    it('rejects channel names with zero-width characters', async () => {
      // #given
      const userId = uniqueUserId()
      const {interaction, editReply} = makeInteraction({channel: 'my\u200Brepo', userId})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('disallowed characters')
    })

    it('rejects channel names with RTL override characters', async () => {
      // #given
      const userId = uniqueUserId()
      const {interaction, editReply} = makeInteraction({channel: 'my\u202Erepo', userId})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('disallowed characters')
    })
  })

  describe('PRE_FLIGHT: already-bound repo', () => {
    it('aborts with existing channel name when repo is already bound', async () => {
      // #given
      const userId = uniqueUserId()
      const existingBinding = {
        owner: 'testowner',
        repo: 'testrepo',
        channelId: 'ch-existing',
        channelName: 'existing-channel',
        workspacePath: '/workspace/repos/testowner/testrepo',
        createdAt: '2026-01-01T00:00:00.000Z',
        createdByDiscordId: 'user-old',
      }
      const getBindingByRepo = vi.fn().mockResolvedValue(ok(existingBinding))
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({bindingsStore: makeBindingsStore({getBindingByRepo})})

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('existing-channel')
    })
  })

  describe('PRE_FLIGHT: AppNotInstalledError', () => {
    it('aborts with install URL when GitHub App is not installed', async () => {
      // #given
      const userId = uniqueUserId()
      const authForRepo = vi
        .fn()
        .mockResolvedValue(
          err(new AppNotInstalledError('testowner', 'testrepo', 'https://github.com/apps/fro-bot/installations/new')),
        )
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({appClient: makeAppClient({authForRepo})})

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('not installed')
    })
  })

  describe('CLONING: workspace-agent errors', () => {
    const cloneErrorCases: {code: string; expectedFragment: string}[] = [
      {code: 'clone-failed', expectedFragment: 'clone-failed'},
      {code: 'disk-full', expectedFragment: 'out of space'},
      {code: 'enospc', expectedFragment: 'out of space'},
      {code: 'head-resolution-failed', expectedFragment: 'head-resolution-failed'},
      {code: 'clone-timeout', expectedFragment: 'clone-timeout'},
    ]

    for (const {code, expectedFragment} of cloneErrorCases) {
      it(`handles clone-error code: ${code}`, async () => {
        // #given
        const userId = uniqueUserId()
        const clone = vi.fn().mockResolvedValue(err({kind: 'clone-error', code}))
        const {interaction, editReply} = makeInteraction({userId})
        const deps = makeDeps({workspaceClient: makeWorkspaceClient({clone})})

        // #when
        await run(interaction, deps)

        // #then
        expect(lastEditReplyContent(editReply)).toContain(expectedFragment)
      })
    }

    it('handles timeout from workspace client', async () => {
      // #given
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(err({kind: 'timeout'}))
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({workspaceClient: makeWorkspaceClient({clone})})

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('timed out')
    })

    it('handles response-mismatch with internal error message', async () => {
      // #given
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(err({kind: 'response-mismatch'}))
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({workspaceClient: makeWorkspaceClient({clone})})

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('Internal error')
    })
  })

  describe('CREATING_CHANNEL: permission revoked between PRE_FLIGHT and CREATING_CHANNEL', () => {
    it('aborts gracefully when permissions revoked after pre-flight', async () => {
      // #given — appPermissions.has returns true for first two calls (PRE_FLIGHT), false thereafter
      const userId = uniqueUserId()
      const appPermissions = {
        has: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false),
      }
      const channelCache = {
        filter: () => ({find: () => undefined, some: () => false}),
      }
      const create = vi.fn().mockResolvedValue(makeTextChannel().channel)
      const guild = {
        members: {fetch: vi.fn().mockResolvedValue({permissions: {has: vi.fn().mockReturnValue(true)}})},
        channels: {cache: channelCache, create},
      } as unknown as Guild
      const {interaction, editReply} = makeInteraction({guild, userId, appPermissions})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then — editReply was called (not a crash)
      expect(editReply).toHaveBeenCalled()
    })
  })

  describe('CREATING_CHANNEL: collision-exhausted', () => {
    it('aborts with explicit channel name suggestion when all suffixes taken', async () => {
      // #given — exact name is free but create fails; all suffix candidates exist
      const userId = uniqueUserId()
      const suffixChannels: TextChannel[] = []
      for (let i = 2; i <= 10; i++) {
        suffixChannels.push(makeTextChannel(`testrepo-${i}`).channel)
      }
      const channelCache = {
        find: (pred: (ch: TextChannel) => boolean) => suffixChannels.find(pred),
      }
      // First create (testrepo) rejected by Discord as duplicate (50035); all suffix candidates exist so they're skipped
      const nameTakenError = Object.assign(new Error('Invalid Form Body'), {code: 50035})
      const create = vi.fn().mockRejectedValue(nameTakenError)
      const guild = {
        members: {fetch: vi.fn().mockResolvedValue({permissions: {has: vi.fn().mockReturnValue(true)}})},
        channels: {cache: channelCache, create},
      } as unknown as Guild
      const {interaction, editReply} = makeInteraction({guild, userId})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('Specify')
    })
  })

  describe('WRITING_BINDING: PartialWriteError', () => {
    it('reports partial write error with recovery instructions', async () => {
      // #given
      const userId = uniqueUserId()
      const {channel} = makeTextChannel('testrepo')
      const guild = makeGuild('bot-user-id', true, [], channel)
      const partialWriteError = Object.assign(new Error('Partial write'), {
        code: 'BINDING_PARTIAL_WRITE_ERROR',
        primaryKey: 'bindings/testowner/testrepo/repo.json',
        indexKey: 'bindings/by-channel/ch-123.json',
      })
      const createBinding = vi.fn().mockResolvedValue(err(partialWriteError))
      const {interaction, editReply} = makeInteraction({guild, userId})
      const deps = makeDeps({bindingsStore: makeBindingsStore({createBinding})})

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('Partial write')
    })
  })

  describe('WRITING_BINDING: StoreError', () => {
    it('reports store error with retry instructions', async () => {
      // #given
      const userId = uniqueUserId()
      const {channel} = makeTextChannel('testrepo')
      const guild = makeGuild('bot-user-id', true, [], channel)
      const storeError = new Error('S3 connection refused')
      const createBinding = vi.fn().mockResolvedValue(err(storeError))
      const {interaction, editReply} = makeInteraction({guild, userId})
      const deps = makeDeps({bindingsStore: makeBindingsStore({createBinding})})

      // #when
      await run(interaction, deps)

      // #then
      expect(lastEditReplyContent(editReply)).toContain('Failed to write binding')
    })
  })

  describe('READY: welcome message post fails', () => {
    it('preserves channel and binding but reports send failure', async () => {
      // #given
      const userId = uniqueUserId()
      const {channel, send} = makeTextChannel('testrepo')
      send.mockRejectedValue(new Error('Missing Permissions'))
      const guild = makeGuild('bot-user-id', true, [], channel)
      const {interaction, editReply} = makeInteraction({guild, userId})
      const createBinding = vi.fn().mockResolvedValue(ok({primaryEtag: 'e1', indexEtag: 'e2'}))
      const deps = makeDeps({bindingsStore: makeBindingsStore({createBinding})})

      // #when
      await run(interaction, deps)

      // #then — binding was still created (createBinding was called)
      expect(createBinding).toHaveBeenCalled()
      // editReply mentions the channel was created but welcome failed
      expect(lastEditReplyContent(editReply)).toContain('verify')
    })
  })

  describe('PRE_FLIGHT: rate-limit eviction', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('evicts expired entries when a new user calls checkRateLimit', async () => {
      // #given — stale user hit the limit 2 minutes ago (window is 60s)
      const staleUserId = uniqueUserId()
      const newUserId = uniqueUserId()
      const guild = makeGuild('bot-user-id', true, [], makeTextChannel().channel)
      const deps = makeDeps()

      // Exhaust rate limit for stale user at t=0
      for (let i = 0; i < 5; i++) {
        const {interaction} = makeInteraction({guild, userId: staleUserId})
        await run(interaction, deps)
      }

      // Advance time by 2 minutes — stale user's window has expired
      vi.advanceTimersByTime(120_000)

      // #when — new user triggers checkRateLimit (which sweeps expired entries)
      const {interaction, editReply} = makeInteraction({guild, userId: newUserId})
      await run(interaction, deps)

      // #then — new user is allowed (not rate-limited)
      expect(lastEditReplyContent(editReply)).toContain('Ready')

      // Stale user can now invoke again (window reset by eviction + re-entry on next call)
      const {interaction: staleInteraction, editReply: staleEditReply} = makeInteraction({guild, userId: staleUserId})
      await run(staleInteraction, deps)
      expect(lastEditReplyContent(staleEditReply)).toContain('Ready')
    })
  })

  // -------------------------------------------------------------------------
  // Invoking-user authorization gate
  // -------------------------------------------------------------------------

  describe('PRE_FLIGHT: user authorization', () => {
    it('rejects user without guild-level ManageChannels and does not proceed to clone', async () => {
      // #given — members.fetch resolves to a member whose guild-level permissions lack ManageChannels
      const userId = uniqueUserId()
      const clone = vi.fn()
      const unauthorizedMember = {permissions: {has: vi.fn().mockReturnValue(false)}}
      const guild = makeGuild('bot-user-id', true, [])
      ;(guild.members as unknown as {fetch: ReturnType<typeof vi.fn>}).fetch = vi
        .fn()
        .mockResolvedValue(unauthorizedMember)
      const {interaction, editReply} = makeInteraction({userId, guild})
      const deps = makeDeps({workspaceClient: makeWorkspaceClient({clone})})

      // #when
      await run(interaction, deps)

      // #then — rejected with permission message; clone never invoked
      expect(lastEditReplyContent(editReply)).toContain('Manage Channels')
      expect(clone).not.toHaveBeenCalled()
    })

    it('denies a user whose ManageChannels comes only from a channel overwrite, not guild-level', async () => {
      // #given — guild-level permissions.has returns false (no base guild ManageChannels),
      // even though a channel-scoped overwrite might grant it in a real Discord server.
      const userId = uniqueUserId()
      const clone = vi.fn()
      const channelOverwriteOnlyMember = {permissions: {has: vi.fn().mockReturnValue(false)}}
      const guild = makeGuild('bot-user-id', true, [])
      ;(guild.members as unknown as {fetch: ReturnType<typeof vi.fn>}).fetch = vi
        .fn()
        .mockResolvedValue(channelOverwriteOnlyMember)
      const {interaction, editReply} = makeInteraction({userId, guild})
      const deps = makeDeps({workspaceClient: makeWorkspaceClient({clone})})

      // #when
      await run(interaction, deps)

      // #then — rejected; channel-scoped overwrite does NOT bypass the guild-level gate
      expect(lastEditReplyContent(editReply)).toContain('Manage Channels')
      expect(clone).not.toHaveBeenCalled()
    })

    it('allows user WITH guild-level ManageChannels to proceed past the authorization gate', async () => {
      // #given — members.fetch resolves to a member with guild-level ManageChannels
      const userId = uniqueUserId()
      const {PermissionFlagsBits} = await import('discord.js')
      const authorizedMember = {
        permissions: {has: vi.fn().mockImplementation((flag: bigint) => flag === PermissionFlagsBits.ManageChannels)},
      }
      const {channel} = makeTextChannel('testrepo')
      const guild = makeGuild('bot-user-id', true, [], channel)
      ;(guild.members as unknown as {fetch: ReturnType<typeof vi.fn>}).fetch = vi
        .fn()
        .mockResolvedValue(authorizedMember)
      const {interaction, editReply} = makeInteraction({userId, guild})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then — proceeds through all phases and reaches READY
      expect(lastEditReplyContent(editReply)).toContain('Ready')
    })

    it('fail-closed: members.fetch rejection denies access and does not throw', async () => {
      // #given — members.fetch rejects (e.g. network error, member not in guild)
      const userId = uniqueUserId()
      const clone = vi.fn()
      const guild = makeGuild('bot-user-id', true, [])
      ;(guild.members as unknown as {fetch: ReturnType<typeof vi.fn>}).fetch = vi
        .fn()
        .mockRejectedValue(new Error('Unknown Member'))
      const {interaction, editReply} = makeInteraction({userId, guild})
      const deps = makeDeps({workspaceClient: makeWorkspaceClient({clone})})

      // #when — must resolve without throwing
      await run(interaction, deps)

      // #then — fail-closed: denied, clone never invoked
      expect(lastEditReplyContent(editReply)).toContain('Manage Channels')
      expect(clone).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // repo-exists never emits deletion instructions
  // -------------------------------------------------------------------------

  describe('CLONING: repo-exists safe messaging', () => {
    it('repo-exists + binding found → redirects to bound channel, no rm -rf', async () => {
      // #given — clone fails with repo-exists; bindings store returns existing binding
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(err({kind: 'clone-error', code: 'repo-exists'}))
      const existingBinding = {
        owner: 'testowner',
        repo: 'testrepo',
        channelId: 'ch-bound-456',
        channelName: 'testrepo',
        workspacePath: '/workspace/repos/testowner/testrepo',
        createdAt: '2026-01-01T00:00:00.000Z',
        createdByDiscordId: 'user-original',
      }
      // getBindingByRepo is called twice: once in PRE_FLIGHT (returns null), once in repo-exists handler (returns binding)
      const getBindingByRepo = vi.fn().mockResolvedValueOnce(ok(null)).mockResolvedValue(ok(existingBinding))
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({
        workspaceClient: makeWorkspaceClient({clone}),
        bindingsStore: makeBindingsStore({getBindingByRepo}),
      })

      // #when
      await run(interaction, deps)

      // #then — redirects to existing channel with exact mention token; NEVER instructs deletion
      const reply = lastEditReplyContent(editReply)
      expect(reply).toContain('<#ch-bound-456>')
      for (const content of allEditReplies(editReply)) {
        expect(content).not.toContain('rm -rf')
      }
    })

    it('repo-exists + no binding found → "currently being added" message, no rm -rf', async () => {
      // #given — clone fails with repo-exists; binding store returns null (clone in progress)
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(err({kind: 'clone-error', code: 'repo-exists'}))
      // Both PRE_FLIGHT and repo-exists handler see no binding
      const getBindingByRepo = vi.fn().mockResolvedValue(ok(null))
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({
        workspaceClient: makeWorkspaceClient({clone}),
        bindingsStore: makeBindingsStore({getBindingByRepo}),
      })

      // #when
      await run(interaction, deps)

      // #then — "currently being added" safe message; NEVER instructs deletion
      const reply = lastEditReplyContent(editReply)
      expect(reply).toContain('currently being added')
      for (const content of allEditReplies(editReply)) {
        expect(content).not.toContain('rm -rf')
      }
    })

    it('repo-exists + binding store errors → falls back to "currently being added", no rm -rf', async () => {
      // #given — clone fails with repo-exists; binding store returns error
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(err({kind: 'clone-error', code: 'repo-exists'}))
      const storeError = new Error('S3 timeout')
      // PRE_FLIGHT call succeeds with null; second call (repo-exists handler) errors
      const getBindingByRepo = vi.fn().mockResolvedValueOnce(ok(null)).mockResolvedValue(err(storeError))
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({
        workspaceClient: makeWorkspaceClient({clone}),
        bindingsStore: makeBindingsStore({getBindingByRepo}),
      })

      // #when
      await run(interaction, deps)

      // #then — safe fallback; NEVER instructs deletion
      const reply = lastEditReplyContent(editReply)
      expect(reply).toContain('currently being added')
      for (const content of allEditReplies(editReply)) {
        expect(content).not.toContain('rm -rf')
      }
    })

    it('repo-exists + getBindingByRepo REJECTS → falls back to "please wait", no rm -rf', async () => {
      // #given — clone fails with repo-exists; getBindingByRepo throws (network-level rejection)
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(err({kind: 'clone-error', code: 'repo-exists'}))
      // PRE_FLIGHT call succeeds with null; second call rejects entirely
      const getBindingByRepo = vi.fn().mockResolvedValueOnce(ok(null)).mockRejectedValue(new Error('connection reset'))
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({
        workspaceClient: makeWorkspaceClient({clone}),
        bindingsStore: makeBindingsStore({getBindingByRepo}),
      })

      // #when — must resolve without throwing even though getBindingByRepo rejects
      await expect(run(interaction, deps)).resolves.toBeUndefined()

      // #then — safe fallback sent; NEVER instructs deletion
      const reply = lastEditReplyContent(editReply)
      expect(reply).toContain('currently being added')
      for (const content of allEditReplies(editReply)) {
        expect(content).not.toContain('rm -rf')
      }
    })
  })

  describe('canonicalization', () => {
    it('owner/Repo and owner/repo produce the same binding key', async () => {
      // #given
      const userId1 = uniqueUserId()
      const userId2 = uniqueUserId()
      const createBinding1 = vi.fn().mockResolvedValue(ok({primaryEtag: 'e1', indexEtag: 'e2'}))
      const createBinding2 = vi.fn().mockResolvedValue(ok({primaryEtag: 'e1', indexEtag: 'e2'}))

      const guild1 = makeGuild('bot-user-id', true, [], makeTextChannel('testrepo').channel)
      const guild2 = makeGuild('bot-user-id', true, [], makeTextChannel('testrepo').channel)

      const {interaction: interaction1} = makeInteraction({
        url: 'https://github.com/TestOwner/TestRepo',
        guild: guild1,
        userId: userId1,
      })
      const {interaction: interaction2} = makeInteraction({
        url: 'https://github.com/testowner/testrepo',
        guild: guild2,
        userId: userId2,
      })

      const deps1 = makeDeps({bindingsStore: makeBindingsStore({createBinding: createBinding1})})
      const deps2 = makeDeps({bindingsStore: makeBindingsStore({createBinding: createBinding2})})

      // #when
      await run(interaction1, deps1)
      await run(interaction2, deps2)

      // #then — both calls use the same lowercase owner/repo
      const calls1 = createBinding1.mock.calls as [{owner: string; repo: string}][]
      const calls2 = createBinding2.mock.calls as [{owner: string; repo: string}][]
      expect(calls1[0]?.[0]?.owner).toBe('testowner')
      expect(calls1[0]?.[0]?.repo).toBe('testrepo')
      expect(calls2[0]?.[0]?.owner).toBe('testowner')
      expect(calls2[0]?.[0]?.repo).toBe('testrepo')
    })
  })
})
