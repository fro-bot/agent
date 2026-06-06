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
import {__resetShuttingDownForTests} from '../../shutdown.js'
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
    readyz: vi.fn().mockResolvedValue(ok({ready: true, opencode: 'ready'})),
  } as unknown as WorkspaceClient
}

function makeDeps(overrides?: Partial<AddProjectDeps>): AddProjectDeps {
  return {
    bindingsStore: makeBindingsStore(),
    appClient: makeAppClient(),
    workspaceClient: makeWorkspaceClient(),
    installUrl: 'https://github.com/apps/fro-bot-agent/installations/new',
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
      expect(lastEditReplyContent(editReply)).toContain('https://github.com/apps/fro-bot-agent/installations/new')
    })

    it('aborts gracefully when appPermissions is null (DM interaction)', async () => {
      // #given — null appPermissions simulates a DM context
      const userId = uniqueUserId()
      const {interaction, editReply} = makeInteraction({userId, appPermissions: null})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then — aborts with install URL (treated as missing permissions)
      expect(lastEditReplyContent(editReply)).toContain('https://github.com/apps/fro-bot-agent/installations/new')
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

      // #then — reply mentions the bound channel by Discord mention token
      const reply = lastEditReplyContent(editReply)
      expect(reply).toContain('<#ch-existing>')
      // #and — reply does NOT instruct the user to delete S3 keys
      expect(reply).not.toContain('S3')
      expect(reply).not.toContain('delete')
      expect(reply).not.toContain('bindings/')
    })

    it('already-bound reply tells user to mention Fro Bot in the bound channel to repair a missing checkout', async () => {
      // #given — repo is already bound; user may be hitting this after workspace volume was recreated
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

      // #then — reply points to the bound channel with exact Discord mention token
      const reply = lastEditReplyContent(editReply)
      expect(reply).toContain('<#ch-existing>')
      // #and — reply explains the missing/recreated checkout context
      expect(reply.toLowerCase()).toMatch(/recreated|missing|checkout/)
      // #and — reply names Fro Bot as the repair mechanism (exact @mention fro-bot token)
      expect(reply).toContain('@mention fro-bot')
      // #and — reply says repair happens automatically (not manual steps)
      expect(reply.toLowerCase()).toContain('automatically')
    })

    it('already-bound reply does not contain S3 deletion guidance', async () => {
      // #given — repo is already bound
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

      // #then — no S3 deletion instructions in any reply
      for (const content of allEditReplies(editReply)) {
        expect(content).not.toContain('S3 key')
        expect(content).not.toContain('manually delete')
        expect(content).not.toContain('bindings/')
      }
    })

    it('binding store failure during pre-flight still fails closed and does not attempt clone or recovery', async () => {
      // #given — binding store returns an error result (not null, not a binding)
      const userId = uniqueUserId()
      const storeError = new Error('S3 timeout')
      const getBindingByRepo = vi.fn().mockResolvedValue(err(storeError))
      const clone = vi.fn()
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({
        bindingsStore: makeBindingsStore({getBindingByRepo}),
        workspaceClient: makeWorkspaceClient({clone}),
      })

      // #when
      await run(interaction, deps)

      // #then — fails closed with internal error message
      expect(lastEditReplyContent(editReply)).toContain('Internal error checking existing bindings')
      // #and — clone was never called (no recovery attempted)
      expect(clone).not.toHaveBeenCalled()
    })
  })

  describe('PRE_FLIGHT: AppNotInstalledError', () => {
    it('aborts with install URL when GitHub App is not installed', async () => {
      // #given
      const userId = uniqueUserId()
      const authForRepo = vi
        .fn()
        .mockResolvedValue(
          err(
            new AppNotInstalledError(
              'testowner',
              'testrepo',
              'https://github.com/apps/fro-bot-agent/installations/new',
            ),
          ),
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
    // Internal clone error codes must NOT leak verbatim into Discord replies.
    // Each case asserts: (a) the reply is non-empty, (b) the raw internal code
    // does NOT appear verbatim, and (c) the reply is a coarse user-facing message.
    const cloneErrorCases: {code: string; mustNotContain: string[]; mustContain: string}[] = [
      {
        code: 'clone-failed',
        mustNotContain: ['clone-failed'],
        mustContain: 'Clone failed',
      },
      {
        code: 'disk-full',
        mustNotContain: ['disk-full'],
        mustContain: 'out of space',
      },
      {
        code: 'enospc',
        mustNotContain: ['enospc'],
        mustContain: 'out of space',
      },
      {
        code: 'head-resolution-failed',
        mustNotContain: ['head-resolution-failed'],
        mustContain: 'Clone failed',
      },
      {
        code: 'clone-timeout',
        mustNotContain: ['clone-timeout'],
        mustContain: 'Clone failed',
      },
    ]

    for (const {code, mustNotContain, mustContain} of cloneErrorCases) {
      it(`clone-error code '${code}' produces a coarse reply without leaking the internal code`, async () => {
        // #given
        const userId = uniqueUserId()
        const clone = vi.fn().mockResolvedValue(err({kind: 'clone-error', code}))
        const {interaction, editReply} = makeInteraction({userId})
        const deps = makeDeps({workspaceClient: makeWorkspaceClient({clone})})

        // #when
        await run(interaction, deps)

        // #then — reply is non-empty
        const reply = lastEditReplyContent(editReply)
        expect(reply.length).toBeGreaterThan(0)

        // #and — internal code does NOT appear verbatim in the Discord reply
        for (const forbidden of mustNotContain) {
          expect(reply).not.toContain(forbidden)
        }

        // #and — reply contains the expected coarse user-facing fragment
        expect(reply).toContain(mustContain)
      })
    }

    it('handles timeout from workspace client with coarse reply (no internal kind leaked)', async () => {
      // #given
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(err({kind: 'timeout'}))
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({workspaceClient: makeWorkspaceClient({clone})})

      // #when
      await run(interaction, deps)

      // #then — coarse reply; internal kind 'timeout' must not appear verbatim
      const reply = lastEditReplyContent(editReply)
      expect(reply).toContain('timed out')
      expect(reply).not.toContain("kind: 'timeout'")
    })

    it('handles response-mismatch with coarse internal error message (no raw error detail)', async () => {
      // #given
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(err({kind: 'response-mismatch'}))
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({workspaceClient: makeWorkspaceClient({clone})})

      // #when
      await run(interaction, deps)

      // #then — coarse reply; no raw error detail
      const reply = lastEditReplyContent(editReply)
      expect(reply).toContain('Internal error')
      expect(reply).not.toContain('response-mismatch')
    })

    it('generic auth failure during clone does not leak raw error.message to Discord', async () => {
      // #given — authForRepo returns a generic error (not AppNotInstalledError)
      const userId = uniqueUserId()
      const internalAuthDetail = 'JWT signature verification failed: secret-key-abc'
      const authForRepo = vi.fn().mockResolvedValue(err(new Error(internalAuthDetail)))
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({appClient: makeAppClient({authForRepo})})

      // #when
      await run(interaction, deps)

      // #then — raw error.message must NOT appear in the Discord reply
      const reply = lastEditReplyContent(editReply)
      expect(reply.length).toBeGreaterThan(0)
      expect(reply).not.toContain(internalAuthDetail)
      expect(reply).not.toContain('JWT')
      expect(reply).not.toContain('secret-key-abc')
    })

    it('channel creation failure does not leak raw Discord error.message to Discord reply', async () => {
      // #given — channel creation throws a generic error (not a known Discord code)
      const userId = uniqueUserId()
      const internalChannelDetail = 'Internal Discord API error: shard-42 overloaded'
      const channelError = new Error(internalChannelDetail)
      const guild = makeGuild('bot-user-id', true, [], channelError)
      const {interaction, editReply} = makeInteraction({guild, userId})
      const deps = makeDeps()

      // #when
      await run(interaction, deps)

      // #then — raw error.message must NOT appear in the Discord reply
      const reply = lastEditReplyContent(editReply)
      expect(reply.length).toBeGreaterThan(0)
      expect(reply).not.toContain(internalChannelDetail)
      expect(reply).not.toContain('shard-42')
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

    it('permission-revoked reply does not expose absolute workspace filesystem paths', async () => {
      // #given — appPermissions.has returns true for first two calls (PRE_FLIGHT), false thereafter
      // This simulates permissions being revoked after clone completes but before channel creation.
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

      // #then — no absolute filesystem paths in the Discord reply
      for (const content of allEditReplies(editReply)) {
        expect(content).not.toContain('/workspace/repos')
      }
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
    it('reports partial write error with coarse user-facing message (no S3 keys leaked)', async () => {
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

      // #then — user-facing reply mentions partial write but does NOT expose S3 keys or paths
      const reply = lastEditReplyContent(editReply)
      expect(reply).toContain('Partial write')
      // S3 internal keys must NOT appear in the Discord reply
      expect(reply).not.toContain('bindings/testowner')
      expect(reply).not.toContain('bindings/by-channel')
      expect(reply).not.toContain('primaryKey')
      expect(reply).not.toContain('indexKey')
      expect(reply).not.toContain('S3')
    })

    it('partial write error reply does not expose absolute workspace filesystem paths', async () => {
      // #given — partial write error after a fresh clone (workspacePath is set)
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

      // #then — no absolute filesystem paths in any reply
      for (const content of allEditReplies(editReply)) {
        expect(content).not.toContain('/workspace/repos')
      }
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

    it('repo-exists + binding found → reply includes missing checkout / repair / automatic recovery guidance', async () => {
      // #given — clone fails with repo-exists; bindings store returns existing binding
      // This path is hit when workspace was recreated and user tries add-project again.
      // The reply must tell the user how to repair the missing checkout automatically.
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
      const getBindingByRepo = vi.fn().mockResolvedValueOnce(ok(null)).mockResolvedValue(ok(existingBinding))
      const {interaction, editReply} = makeInteraction({userId})
      const deps = makeDeps({
        workspaceClient: makeWorkspaceClient({clone}),
        bindingsStore: makeBindingsStore({getBindingByRepo}),
      })

      // #when
      await run(interaction, deps)

      // #then — reply points to the bound channel with exact Discord mention token
      const reply = lastEditReplyContent(editReply)
      expect(reply).toContain('<#ch-bound-456>')
      // #and — reply explains the missing/recreated checkout context
      expect(reply.toLowerCase()).toMatch(/recreated|missing|checkout/)
      // #and — reply names Fro Bot as the repair mechanism (exact @mention fro-bot token)
      expect(reply).toContain('@mention fro-bot')
      // #and — reply says repair happens automatically (not manual steps)
      expect(reply.toLowerCase()).toContain('automatically')
      // #and — no S3 deletion instructions
      expect(reply).not.toContain('rm -rf')
      expect(reply).not.toContain('S3')
    })

    it('repo-exists + NO binding → RESUMES: proceeds to channel creation and binding write', async () => {
      // #given — clone fails with repo-exists; bindings store returns null (no binding yet)
      // This is the post-clone partial-failure recovery path.
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(err({kind: 'clone-error', code: 'repo-exists'}))
      // PRE_FLIGHT returns null; repo-exists handler also returns null (no binding written yet)
      const getBindingByRepo = vi.fn().mockResolvedValue(ok(null))
      const createBinding = vi.fn().mockResolvedValue(ok({primaryEtag: 'e1', indexEtag: 'e2'}))
      const {channel, send} = makeTextChannel('owner-repo')
      const guild = makeGuild('bot-user-id', true, [], channel)
      const {interaction, editReply} = makeInteraction({
        url: 'https://github.com/owner/repo',
        guild,
        userId,
      })
      const deps = makeDeps({
        workspaceClient: makeWorkspaceClient({clone}),
        bindingsStore: makeBindingsStore({getBindingByRepo, createBinding}),
      })

      // #when
      await run(interaction, deps)

      // #then — channel was created (guild.channels.create was called)
      const guildCreate = (guild.channels as unknown as {create: ReturnType<typeof vi.fn>}).create
      expect(guildCreate).toHaveBeenCalled()
      // #and — binding was written with the canonical workspace path
      const bindingCall = (createBinding.mock.calls as [{workspacePath: string; owner: string; repo: string}][])[0]
      expect(bindingCall?.[0]?.workspacePath).toBe('/workspace/repos/owner/repo')
      expect(bindingCall?.[0]?.owner).toBe('owner')
      expect(bindingCall?.[0]?.repo).toBe('repo')
      // #and — READY reply reached
      expect(lastEditReplyContent(editReply)).toContain('Ready')
      // #and — welcome message sent
      expect(send).toHaveBeenCalled()
      // #and — clone was only called once (not re-run)
      expect(clone).toHaveBeenCalledOnce()
      // #and — no rm -rf in any reply
      for (const content of allEditReplies(editReply)) {
        expect(content).not.toContain('rm -rf')
      }
    })

    it('repo-exists + binding store ERRORS (success=false) → internal-error reply, channel NOT created', async () => {
      // #given — clone fails with repo-exists; second binding lookup returns an error result (store error)
      // Store errors must NOT resume — resuming on a store outage risks orphan channels.
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(err({kind: 'clone-error', code: 'repo-exists'}))
      const storeError = new Error('S3 timeout')
      // PRE_FLIGHT returns null (ok); repo-exists handler returns err (store failure Result)
      const getBindingByRepo = vi.fn().mockResolvedValueOnce(ok(null)).mockResolvedValue(err(storeError))
      const createBinding = vi.fn().mockResolvedValue(ok({primaryEtag: 'e1', indexEtag: 'e2'}))
      const {channel} = makeTextChannel('owner-repo')
      const guild = makeGuild('bot-user-id', true, [], channel)
      const {interaction, editReply} = makeInteraction({
        url: 'https://github.com/owner/repo',
        guild,
        userId,
      })
      const deps = makeDeps({
        workspaceClient: makeWorkspaceClient({clone}),
        bindingsStore: makeBindingsStore({getBindingByRepo, createBinding}),
      })

      // #when
      await run(interaction, deps)

      // #then — internal-error reply (not a resume)
      expect(lastEditReplyContent(editReply)).toContain('Internal error checking existing bindings')
      // #and — channel was NOT created (no resume on store error)
      const guildCreate = (guild.channels as unknown as {create: ReturnType<typeof vi.fn>}).create
      expect(guildCreate).not.toHaveBeenCalled()
      // #and — createBinding was NOT called
      expect(createBinding).not.toHaveBeenCalled()
      // #and — no rm -rf in any reply
      for (const content of allEditReplies(editReply)) {
        expect(content).not.toContain('rm -rf')
      }
    })

    it('repo-exists + getBindingByRepo REJECTS → internal-error reply, channel NOT created', async () => {
      // #given — clone fails with repo-exists; getBindingByRepo throws (network-level rejection)
      // A store rejection must NOT resume — we cannot confirm binding absence, so resuming risks orphan channels.
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(err({kind: 'clone-error', code: 'repo-exists'}))
      // PRE_FLIGHT returns null; repo-exists handler rejects entirely
      const getBindingByRepo = vi.fn().mockResolvedValueOnce(ok(null)).mockRejectedValue(new Error('connection reset'))
      const createBinding = vi.fn().mockResolvedValue(ok({primaryEtag: 'e1', indexEtag: 'e2'}))
      const {channel} = makeTextChannel('owner-repo')
      const guild = makeGuild('bot-user-id', true, [], channel)
      const {interaction, editReply} = makeInteraction({
        url: 'https://github.com/owner/repo',
        guild,
        userId,
      })
      const deps = makeDeps({
        workspaceClient: makeWorkspaceClient({clone}),
        bindingsStore: makeBindingsStore({getBindingByRepo, createBinding}),
      })

      // #when — must resolve without throwing even though getBindingByRepo rejects
      await expect(run(interaction, deps)).resolves.toBeUndefined()

      // #then — internal-error reply (not a resume)
      expect(lastEditReplyContent(editReply)).toContain('Internal error checking existing bindings')
      // #and — channel was NOT created (no resume on store rejection)
      const guildCreate = (guild.channels as unknown as {create: ReturnType<typeof vi.fn>}).create
      expect(guildCreate).not.toHaveBeenCalled()
      // #and — createBinding was NOT called
      expect(createBinding).not.toHaveBeenCalled()
      // #and — no rm -rf in any reply
      for (const content of allEditReplies(editReply)) {
        expect(content).not.toContain('rm -rf')
      }
    })

    it('full retry-after-partial-failure: first invocation binding write fails, second invocation resumes successfully', async () => {
      // #given — first invocation: clone succeeds, binding write fails
      const userId1 = uniqueUserId()
      const {channel: channel1, send: send1} = makeTextChannel('owner-repo')
      const guild1 = makeGuild('bot-user-id', true, [], channel1)
      const {interaction: interaction1, editReply: editReply1} = makeInteraction({
        url: 'https://github.com/owner/repo',
        guild: guild1,
        userId: userId1,
      })

      const cloneFresh = vi
        .fn()
        .mockResolvedValue(ok({ok: true, path: '/workspace/repos/owner/repo', commit: 'abc123'}))
      const bindingStoreError = new Error('S3 write failed')
      const createBindingFail = vi.fn().mockResolvedValue(err(bindingStoreError))
      const getBindingEmpty = vi.fn().mockResolvedValue(ok(null))

      const deps1 = makeDeps({
        workspaceClient: makeWorkspaceClient({clone: cloneFresh}),
        bindingsStore: makeBindingsStore({getBindingByRepo: getBindingEmpty, createBinding: createBindingFail}),
      })

      // #when — first invocation runs: clone succeeds but binding write fails
      await run(interaction1, deps1)

      // #then — first invocation fails with a binding error message
      expect(lastEditReplyContent(editReply1)).toContain('Failed to write binding')

      // #given — second invocation: workspace agent returns repo-exists (clone done), no binding in store
      const userId2 = uniqueUserId()
      const {channel: channel2, send: send2} = makeTextChannel('owner-repo')
      const guild2 = makeGuild('bot-user-id', true, [], channel2)
      const {interaction: interaction2, editReply: editReply2} = makeInteraction({
        url: 'https://github.com/owner/repo',
        guild: guild2,
        userId: userId2,
      })

      const cloneRepoExists = vi.fn().mockResolvedValue(err({kind: 'clone-error', code: 'repo-exists'}))
      const createBindingOk = vi.fn().mockResolvedValue(ok({primaryEtag: 'e1', indexEtag: 'e2'}))
      const getBindingStillEmpty = vi.fn().mockResolvedValue(ok(null))

      const deps2 = makeDeps({
        workspaceClient: makeWorkspaceClient({clone: cloneRepoExists}),
        bindingsStore: makeBindingsStore({getBindingByRepo: getBindingStillEmpty, createBinding: createBindingOk}),
      })

      // #when — second invocation runs: resumes from CREATING_CHANNEL
      await run(interaction2, deps2)

      // #then — second invocation reaches READY
      expect(lastEditReplyContent(editReply2)).toContain('Ready')
      // #and — binding was written with canonical path
      const calls = (createBindingOk.mock.calls as [{workspacePath: string}][])[0]
      expect(calls?.[0]?.workspacePath).toBe('/workspace/repos/owner/repo')
      // #and — welcome message sent in second invocation
      expect(send2).toHaveBeenCalled()
      // #and — clone NOT re-run in second invocation (repo-exists path, not fresh clone)
      expect(cloneRepoExists).toHaveBeenCalledOnce()
      // send1 was never reached (binding failed in first invocation) — intentionally unused
      expect(send1).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Concurrent resume race coverage (FIX 2)
  // -------------------------------------------------------------------------

  describe('CLONING: concurrent resume — BINDING_EXISTS_ERROR loser path', () => {
    it('second concurrent resume hits BINDING_EXISTS_ERROR → bounded error reply, no throw, no re-clone', async () => {
      // #given — both invocations see repo-exists + no binding (clone done, no binding yet)
      // First createBinding succeeds; second gets BINDING_EXISTS_ERROR (atomic IfNoneMatch write)
      const userId1 = uniqueUserId()
      const userId2 = uniqueUserId()

      const clone = vi.fn().mockResolvedValue(err({kind: 'clone-error', code: 'repo-exists'}))
      const getBindingByRepo = vi.fn().mockResolvedValue(ok(null))

      const bindingExistsError = Object.assign(new Error('binding already exists'), {code: 'BINDING_EXISTS_ERROR'})
      let createBindingCallCount = 0
      const createBinding = vi.fn().mockImplementation(async () => {
        createBindingCallCount++
        if (createBindingCallCount === 1) return ok({primaryEtag: 'e1', indexEtag: 'e2'})
        return err(bindingExistsError)
      })

      const {channel: channel1} = makeTextChannel('owner-repo')
      const guild1 = makeGuild('bot-user-id', true, [], channel1)
      const {interaction: interaction1, editReply: editReply1} = makeInteraction({
        url: 'https://github.com/owner/repo',
        guild: guild1,
        userId: userId1,
      })

      const {channel: channel2} = makeTextChannel('owner-repo')
      const guild2 = makeGuild('bot-user-id', true, [], channel2)
      const {interaction: interaction2, editReply: editReply2} = makeInteraction({
        url: 'https://github.com/owner/repo',
        guild: guild2,
        userId: userId2,
      })

      const deps1 = makeDeps({
        workspaceClient: makeWorkspaceClient({clone}),
        bindingsStore: makeBindingsStore({getBindingByRepo, createBinding}),
      })
      const deps2 = makeDeps({
        workspaceClient: makeWorkspaceClient({clone}),
        bindingsStore: makeBindingsStore({getBindingByRepo, createBinding}),
      })

      // #when — first invocation wins the binding race
      await expect(run(interaction1, deps1)).resolves.toBeUndefined()

      // #when — second invocation loses: createBinding returns BINDING_EXISTS_ERROR
      await expect(run(interaction2, deps2)).resolves.toBeUndefined()

      // #then — winner reaches READY
      expect(lastEditReplyContent(editReply1)).toContain('Ready')

      // #then — loser gets the concurrent-bound message (not a throw, not a re-clone)
      const loserReply = lastEditReplyContent(editReply2)
      expect(loserReply).toContain('bound by a concurrent request')
      expect(loserReply).toContain('manual cleanup may be needed')

      // #and — clone was called twice (two independent resume invocations), not re-run internally
      expect(clone).toHaveBeenCalledTimes(2)

      // #and — createBinding was called twice (both invocations attempted the write)
      expect(createBinding).toHaveBeenCalledTimes(2)
    })
  })

  describe('shutdown gate (Part 2)', () => {
    afterEach(() => {
      __resetShuttingDownForTests()
    })

    it('isShuttingDown returns true → replies "fro-bot is restarting" and does NOT call clone', async () => {
      // #given — bot is draining shutdown
      const userId = uniqueUserId()
      const clone = vi.fn()
      const {interaction, editReply} = makeInteraction({
        url: 'https://github.com/owner/repo',
        userId,
      })
      const deps = makeDeps({
        workspaceClient: makeWorkspaceClient({clone}),
        isShuttingDown: () => true,
      })

      // #when
      await run(interaction, deps)

      // #then — user gets restart message
      expect(lastEditReplyContent(editReply)).toContain('fro-bot is restarting')
      // #and — clone was never called (no new work started)
      expect(clone).not.toHaveBeenCalled()
    })

    it('isShuttingDown absent (default) → proceeds normally', async () => {
      // #given — no isShuttingDown dep injected (optional field left absent)
      const userId = uniqueUserId()
      const clone = vi.fn().mockResolvedValue(ok({ok: true, path: '/workspace/repos/owner/repo', commit: 'abc123'}))
      const {interaction} = makeInteraction({
        url: 'https://github.com/owner/repo',
        userId,
      })
      // makeDeps without isShuttingDown — the dep is optional; absence defaults to () => false
      const deps = makeDeps({workspaceClient: makeWorkspaceClient({clone})})

      // #when
      await run(interaction, deps)

      // #then — clone was called (command proceeded normally)
      expect(clone).toHaveBeenCalled()
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
