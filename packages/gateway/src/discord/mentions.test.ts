import type {Result} from '@fro-bot/runtime'
import type {Guild, GuildMember, Message, TextChannel} from 'discord.js'
import type {BindingsStore} from '../bindings/store.js'
import type {ReadyzResponse, WorkspaceError} from '../workspace-api/types.js'
import type {MentionDeps} from './mentions.js'

import {err, ok} from '@fro-bot/runtime'
import {PermissionsBitField} from 'discord.js'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

// ---------------------------------------------------------------------------
// Mock execute/run so mentions.test.ts does not need a full coordination stack
// ---------------------------------------------------------------------------

vi.mock('../execute/run.js', () => ({
  runMention: vi.fn().mockResolvedValue(undefined),
}))

const BOT_USER_ID = 'bot-user-123'
const CHANNEL_ID = 'ch-abc'
const TRIGGER_ROLE_ID = 'role-xyz'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeGuildMember(overrides: {hasRole?: boolean; hasManageChannels?: boolean} = {}): GuildMember {
  const {hasRole = false, hasManageChannels = false} = overrides
  const permissions = new PermissionsBitField(hasManageChannels ? PermissionsBitField.Flags.ManageChannels : 0n)
  return {
    roles: {
      cache: {
        has: (roleId: string) => hasRole && roleId === TRIGGER_ROLE_ID,
      },
    },
    permissions,
  } as unknown as GuildMember
}

function makeGuild(member: GuildMember | null | 'throw'): Guild {
  return {
    members: {
      fetch: async (_userId: string): Promise<GuildMember> => {
        if (member === 'throw') throw new Error('fetch failed')
        if (member === null) throw new Error('unknown member')
        return member
      },
    },
  } as unknown as Guild
}

function makeReplyFn(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(undefined)
}

function makeMessage(
  overrides: Partial<{
    isThread: boolean
    mentionsBot: boolean
    guildMember: GuildMember | null | 'throw'
    guild: Guild | null
    replyFn: ReturnType<typeof vi.fn>
    startThreadFn: ReturnType<typeof vi.fn>
    content: string
  }> = {},
): Message {
  const {
    isThread = false,
    mentionsBot = true,
    guild: guildOverride,
    guildMember = makeGuildMember({hasManageChannels: true}),
    replyFn = makeReplyFn(),
    startThreadFn = vi.fn().mockResolvedValue({id: 'thread-1', send: vi.fn().mockResolvedValue(undefined)}),
    content = 'please do the thing',
  } = overrides

  const guild = guildOverride === undefined ? makeGuild(guildMember) : guildOverride

  return {
    channel: {
      id: CHANNEL_ID,
      isThread: () => isThread,
    } as unknown as TextChannel,
    mentions: {
      has: (id: string) => mentionsBot && id === BOT_USER_ID,
    },
    author: {id: 'user-111', bot: false},
    guild,
    startThread: startThreadFn,
    reply: replyFn,
    content,
  } as unknown as Message
}

function makeBindingsStore(result: 'found' | 'not-found' | 'error'): BindingsStore {
  const getBindingByChannelId = vi.fn(async (_channelId: string) => {
    if (result === 'found') {
      return {
        success: true as const,
        data: {
          owner: 'acme',
          repo: 'widget',
          channelId: CHANNEL_ID,
          channelName: 'widget-dev',
          workspacePath: '/repo',
          createdAt: '2026-01-01T00:00:00Z',
          createdByDiscordId: 'user-1',
        },
      }
    }
    if (result === 'not-found') {
      return {success: true as const, data: null}
    }
    // error
    return {success: false as const, error: new Error('store connection error')}
  })
  return {getBindingByChannelId} as unknown as BindingsStore
}

function makeRunMentionDeps(): MentionDeps['run'] {
  return {
    coordinationConfig: {} as MentionDeps['run']['coordinationConfig'],
    identity: 'discord-gateway',
    concurrency: {
      tryAcquire: vi.fn().mockReturnValue('ok'),
      release: vi.fn(),
      activeCount: vi.fn().mockReturnValue(0),
      max: 3,
    },
    attachUrl: 'http://workspace:9200',
    attachToken: 'secret-token',
    runTimeoutMs: 600_000,
    botUserId: 'bot-user-id',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    approvalRegistry: {
      register: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      pending: vi.fn().mockReturnValue([]),
      handleButtonDecision: vi.fn().mockResolvedValue('ok'),
      applySettlement: vi.fn(),
      attachMessage: vi.fn(),
      markMessagePostFailed: vi.fn(),
      disposeRun: vi.fn(),
      confirmReply: vi.fn(),
      disposeAll: vi.fn(),
    },
    approvalMode: 'approval-required' as const,
  }
}

function makeNoopLogger(): MentionDeps['logger'] {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeReadyzFn(
  result: 'ready' | 'not-ready' | 'error' | 'throws',
  opencodeStatus: 'starting' | 'down' | 'unknown' = 'starting',
): () => Promise<Result<ReadyzResponse, WorkspaceError>> {
  return vi.fn(async () => {
    if (result === 'throws') throw new Error('readyz threw unexpectedly')
    if (result === 'ready') return ok({ready: true, opencode: 'ready'} satisfies ReadyzResponse)
    if (result === 'not-ready') return ok({ready: false, opencode: opencodeStatus} satisfies ReadyzResponse)
    // error
    return err({kind: 'network-error'} satisfies WorkspaceError)
  })
}

function makeDeps(overrides: Partial<MentionDeps> = {}): MentionDeps {
  return {
    bindingsStore: overrides.bindingsStore ?? makeBindingsStore('found'),
    triggerRoleId: overrides.triggerRoleId === undefined ? null : overrides.triggerRoleId,
    run: overrides.run ?? makeRunMentionDeps(),
    logger: overrides.logger ?? makeNoopLogger(),
    readyz: overrides.readyz ?? makeReadyzFn('ready'),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleMention', () => {
  let runMentionMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const runModule = await import('../execute/run.js')
    runMentionMock = vi.mocked(runModule.runMention)
    runMentionMock.mockReset()
    runMentionMock.mockResolvedValue(undefined)
  })

  // ── Early guards ────────────────────────────────────────────────────────────

  describe('early guards', () => {
    it('skips (no-op) when message is already in a thread', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const replyFn0 = makeReplyFn()
      const message = makeMessage({isThread: true, replyFn: replyFn0})
      const deps = makeDeps()

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — no reply, no runMention
      expect(replyFn0).not.toHaveBeenCalled()
      expect(runMentionMock).not.toHaveBeenCalled()
    })

    it('skips (no-op) when bot is not actually mentioned (reply-chain only)', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const replyFn1 = makeReplyFn()
      const message = makeMessage({mentionsBot: false, replyFn: replyFn1})
      const deps = makeDeps()

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then
      expect(replyFn1).not.toHaveBeenCalled()
      expect(runMentionMock).not.toHaveBeenCalled()
    })
  })

  // ── Authorization gate ──────────────────────────────────────────────────────

  describe('authorization gate', () => {
    it('denies with "not authorized" reply when member lacks triggerRoleId', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasRole: false, hasManageChannels: true})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const deps = makeDeps({triggerRoleId: TRIGGER_ROLE_ID})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then
      expect(replyFn).toHaveBeenCalledOnce()
      const reply0 = replyFn.mock.calls[0]?.[0] as {content?: string; allowedMentions?: unknown} | undefined
      expect(reply0?.content).toContain('not authorized')
      expect(reply0?.allowedMentions).toEqual({parse: []})
      expect(runMentionMock).not.toHaveBeenCalled()
    })

    it('allows when member has the triggerRoleId', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasRole: true})
      const message = makeMessage({guildMember: member})
      const deps = makeDeps({triggerRoleId: TRIGGER_ROLE_ID})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — runMention was called (not blocked)
      expect(runMentionMock).toHaveBeenCalledOnce()
    })

    it('denies with "not authorized" reply when triggerRoleId is null and member lacks ManageChannels', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: false})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const deps = makeDeps({triggerRoleId: null})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then
      expect(replyFn).toHaveBeenCalledOnce()
      const reply1 = replyFn.mock.calls[0]?.[0] as {content?: string; allowedMentions?: unknown} | undefined
      expect(reply1?.content).toContain('not authorized')
      expect(reply1?.allowedMentions).toEqual({parse: []})
      expect(runMentionMock).not.toHaveBeenCalled()
    })

    it('allows when triggerRoleId is null and member has ManageChannels', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const message = makeMessage({guildMember: member})
      const deps = makeDeps({triggerRoleId: null})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — runMention called
      expect(runMentionMock).toHaveBeenCalledOnce()
    })

    it('fails closed (denies) when guild.members.fetch throws', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: 'throw', replyFn})
      const deps = makeDeps({triggerRoleId: null})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — fail-closed: deny, no execution
      expect(replyFn).toHaveBeenCalledOnce()
      const reply2 = replyFn.mock.calls[0]?.[0] as {content?: string; allowedMentions?: unknown} | undefined
      expect(reply2?.content).toContain('not authorized')
      expect(reply2?.allowedMentions).toEqual({parse: []})
      expect(runMentionMock).not.toHaveBeenCalled()
    })

    it('skips (no-op) when guild is null (DM context)', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const replyFn = makeReplyFn()
      const message = makeMessage({guild: null, replyFn})
      const deps = makeDeps()

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — no reply, no execution (silently skipped — DM with no guild)
      expect(replyFn).not.toHaveBeenCalled()
      expect(runMentionMock).not.toHaveBeenCalled()
    })
  })

  // ── Binding lookup ──────────────────────────────────────────────────────────

  describe('binding lookup', () => {
    it('replies with "not bound" when no binding exists for the channel', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const deps = makeDeps({bindingsStore: makeBindingsStore('not-found'), triggerRoleId: null})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then
      expect(replyFn).toHaveBeenCalledOnce()
      const reply3 = replyFn.mock.calls[0]?.[0] as {content?: string; allowedMentions?: unknown} | undefined
      expect(reply3?.content).toContain('not bound')
      expect(reply3?.allowedMentions).toEqual({parse: []})
      expect(runMentionMock).not.toHaveBeenCalled()
    })

    it('replies with "try again" when binding store returns an error', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const deps = makeDeps({bindingsStore: makeBindingsStore('error'), triggerRoleId: null})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — coarse message, no internal detail
      expect(replyFn).toHaveBeenCalledOnce()
      const call = replyFn.mock.calls[0]?.[0] as {content?: string; allowedMentions?: unknown} | undefined
      expect(call?.allowedMentions).toEqual({parse: []})
      // Must not leak the internal error message
      expect(call?.content).not.toContain('store connection error')
      expect(runMentionMock).not.toHaveBeenCalled()
    })
  })

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe('authorized happy path', () => {
    it('calls runMention with the correct binding after auth + binding succeed', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const message = makeMessage({guildMember: member})
      const runDeps = makeRunMentionDeps()
      const deps = makeDeps({triggerRoleId: null, run: runDeps})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — runMention called with the right binding
      expect(runMentionMock).toHaveBeenCalledOnce()
      const [calledMessage, calledBinding, calledDeps] = runMentionMock.mock.calls[0] as [Message, unknown, unknown]
      const binding = calledBinding as {owner: string; repo: string}
      expect(calledMessage).toBe(message)
      expect(binding.owner).toBe('acme')
      expect(binding.repo).toBe('widget')
      expect(calledDeps).toBe(runDeps)
    })

    it('does not expose binding lookup result to binding store errors (no runMention call)', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const message = makeMessage({guildMember: member})
      const deps = makeDeps({bindingsStore: makeBindingsStore('error')})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then
      expect(runMentionMock).not.toHaveBeenCalled()
    })
  })

  // ── Readiness gate ──────────────────────────────────────────────────────────

  describe('readiness gate (after binding lookup, before runMention)', () => {
    it('happy path: readiness=ready → runMention IS invoked', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const message = makeMessage({guildMember: member})
      const deps = makeDeps({readyz: makeReadyzFn('ready')})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — workspace is ready, runMention proceeds
      expect(runMentionMock).toHaveBeenCalledOnce()
    })

    it('readiness=not-ready → runMention NOT invoked, coarse reply sent', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const deps = makeDeps({readyz: makeReadyzFn('not-ready', 'starting')})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — workspace not ready: no runMention, coarse reply
      expect(runMentionMock).not.toHaveBeenCalled()
      expect(replyFn).toHaveBeenCalledOnce()
      const call = replyFn.mock.calls[0]?.[0] as {content?: string; allowedMentions?: unknown} | undefined
      expect(call?.content).toContain('not reachable')
      expect(call?.allowedMentions).toEqual({parse: []})
    })

    it('readiness=error (transport error) → fail-closed: coarse reply, runMention NOT invoked', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const deps = makeDeps({readyz: makeReadyzFn('error')})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — transport error treated as not-ready (fail-closed)
      expect(runMentionMock).not.toHaveBeenCalled()
      expect(replyFn).toHaveBeenCalledOnce()
      const call = replyFn.mock.calls[0]?.[0] as {content?: string; allowedMentions?: unknown} | undefined
      expect(call?.content).toContain('not reachable')
      expect(call?.allowedMentions).toEqual({parse: []})
    })

    it('readiness check throws/times out → fail-closed: coarse reply, runMention NOT invoked', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const deps = makeDeps({readyz: makeReadyzFn('throws')})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — thrown exception treated as not-ready (fail-closed)
      expect(runMentionMock).not.toHaveBeenCalled()
      expect(replyFn).toHaveBeenCalledOnce()
      const call = replyFn.mock.calls[0]?.[0] as {content?: string; allowedMentions?: unknown} | undefined
      expect(call?.content).toContain('not reachable')
      expect(call?.allowedMentions).toEqual({parse: []})
    })

    it('ordering: missing binding short-circuits BEFORE readiness check (readyz never called)', async () => {
      // #given — no binding for this channel
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const readyzFn = makeReadyzFn('ready')
      const deps = makeDeps({
        bindingsStore: makeBindingsStore('not-found'),
        readyz: readyzFn,
      })

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — binding lookup short-circuits before readiness check
      expect(readyzFn).not.toHaveBeenCalled()
      expect(runMentionMock).not.toHaveBeenCalled()
    })

    it('not-ready reply uses allowedMentions: {parse: []}', async () => {
      // #given
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const deps = makeDeps({readyz: makeReadyzFn('not-ready', 'down')})

      // #when
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))

      // #then — invariant: all replies use allowedMentions: {parse: []}
      expect(replyFn).toHaveBeenCalledOnce()
      const call = replyFn.mock.calls[0]?.[0] as {allowedMentions?: unknown} | undefined
      expect(call?.allowedMentions).toEqual({parse: []})
    })
  })

  // ── allowedMentions invariant ───────────────────────────────────────────────

  describe('allowedMentions: {parse: []} invariant', () => {
    const expectSafeReply = (replyFn: ReturnType<typeof vi.fn>) => {
      for (const call of replyFn.mock.calls) {
        const arg = call[0] as {allowedMentions?: unknown}
        expect(arg.allowedMentions).toEqual({parse: []})
      }
    }

    it('unauthorized reply uses allowedMentions: {parse: []}', async () => {
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: false})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const deps = makeDeps({triggerRoleId: null})
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))
      expectSafeReply(replyFn)
    })

    it('not-bound reply uses allowedMentions: {parse: []}', async () => {
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const deps = makeDeps({bindingsStore: makeBindingsStore('not-found')})
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))
      expectSafeReply(replyFn)
    })

    it('store-error reply uses allowedMentions: {parse: []}', async () => {
      const {handleMention} = await import('./mentions.js')
      const member = makeGuildMember({hasManageChannels: true})
      const replyFn = makeReplyFn()
      const message = makeMessage({guildMember: member, replyFn})
      const deps = makeDeps({bindingsStore: makeBindingsStore('error')})
      await Effect.runPromise(handleMention(message, BOT_USER_ID, deps))
      expectSafeReply(replyFn)
    })
  })
})
