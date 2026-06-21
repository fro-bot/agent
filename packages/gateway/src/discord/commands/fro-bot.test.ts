/**
 * Tests for the `/fro-bot` parent command factory.
 *
 * Covers:
 * - Subcommand registration (ping, add-project, clear-queue all present on the builder)
 * - Dispatch routing for each subcommand
 * - `/fro-bot clear-queue` handler: calls queue.clear(channelId), replies ephemerally with count
 * - Zero-pending edge case
 * - clear-queue does not touch the in-flight run (only queue.clear is called)
 * - Authorization gate: only authorized users may clear the queue
 */

import type {CoordinationConfig, ForceReleaseStaleLockResult} from '@fro-bot/runtime'
import type {ChatInputCommandInteraction, Guild} from 'discord.js'
import type {ChannelQueue} from '../../execute/queue.js'
import type {RunTask} from '../../execute/run.js'
import type {FroBotDeps} from './fro-bot.js'

import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'

import {createFroBotCommand} from './fro-bot.js'
import {dispatchCommand, getCommandRegistry} from './index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueue(clearReturnValue = 0): ChannelQueue<RunTask> {
  return {
    enqueue: vi.fn().mockReturnValue('queued'),
    pendingCount: vi.fn().mockReturnValue(0),
    takeNext: vi.fn().mockReturnValue(undefined),
    clear: vi.fn().mockReturnValue(clearReturnValue),
  }
}

/**
 * Build a mock Guild where members.fetch() resolves to a member with the given
 * role set and ManageChannels permission.
 */
function makeGuild(opts: {hasRole?: boolean; hasManageChannels?: boolean} = {}): Guild {
  const {hasRole = true, hasManageChannels = true} = opts
  const member = {
    roles: {
      cache: {
        has: vi.fn().mockReturnValue(hasRole),
      },
    },
    permissions: {
      has: vi.fn().mockReturnValue(hasManageChannels),
    },
  }
  return {
    members: {
      fetch: vi.fn().mockResolvedValue(member),
    },
  } as unknown as Guild
}

function makeDeps(overrides?: Partial<FroBotDeps>): FroBotDeps {
  const defaultForceRelease: FroBotDeps['forceReleaseStaleLock'] = vi
    .fn()
    .mockReturnValue(
      Effect.succeed({outcome: 'no-lock', holderId: null, runId: null, lockAgeMs: null, heartbeatAgeMs: null}),
    )
  return {
    bindingsStore: {
      createBinding: vi.fn(),
      getBindingByRepo: vi.fn(),
      getBindingByChannelId: vi.fn(),
      listBindings: vi.fn(),
    },
    appClient: {
      authForRepo: vi.fn(),
      getRepoIdentity: vi.fn(),
      invalidateCache: vi.fn(),
    },
    workspaceClient: {
      clone: vi.fn(),
      readyz: vi.fn().mockResolvedValue({success: true, data: {ready: true, opencode: 'ready'}}),
    },
    installUrl: 'https://github.com/apps/fro-bot-agent/installations/new',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    queue: makeQueue(),
    triggerRoleId: null,
    gatewayLogger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    coordinationConfig: {
      storeAdapter: {} as CoordinationConfig['storeAdapter'],
      storeConfig: {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'test'},
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      staleThresholdMs: 60_000,
      pendingStaleThresholdMs: 30 * 60_000,
    },
    identity: 'discord-gateway',
    forceReleaseStaleLock: defaultForceRelease,
    ...overrides,
  }
}

function makeInteraction(
  subcommand: string,
  channelId = 'ch-test-123',
  guild: Guild | null = makeGuild(),
  userId = 'user-authorized-123',
): {
  interaction: ChatInputCommandInteraction
  reply: ReturnType<typeof vi.fn>
  deferReply: ReturnType<typeof vi.fn>
  editReply: ReturnType<typeof vi.fn>
} {
  const reply = vi.fn().mockResolvedValue(undefined)
  const deferReply = vi.fn().mockResolvedValue(undefined)
  const editReply = vi.fn().mockResolvedValue(undefined)
  const interaction = {
    commandName: 'fro-bot',
    channelId,
    guild,
    user: {id: userId},
    reply,
    deferReply,
    editReply,
    options: {
      getSubcommand: vi.fn().mockReturnValue(subcommand),
    },
  } as unknown as ChatInputCommandInteraction
  return {interaction, reply, deferReply, editReply}
}

// ---------------------------------------------------------------------------
// Subcommand registration
// ---------------------------------------------------------------------------

describe('createFroBotCommand — builder registration', () => {
  it('registers ping, add-project, and clear-queue subcommands on the builder', () => {
    // #given
    const cmd = createFroBotCommand(makeDeps())

    // #when — inspect the builder's JSON representation
    const json = cmd.data.toJSON()

    // #then — all three subcommands are present
    const subNames = (json.options ?? []).map((o: {name: string}) => o.name)
    expect(subNames).toContain('ping')
    expect(subNames).toContain('add-project')
    expect(subNames).toContain('clear-queue')
  })
})

// ---------------------------------------------------------------------------
// Dispatch routing
// ---------------------------------------------------------------------------

describe('createFroBotCommand — dispatch', () => {
  it('routes clear-queue to the handler (does not fall through to unknown)', async () => {
    // #given
    const queue = makeQueue(3)
    const deps = makeDeps({queue})
    const cmd = createFroBotCommand(deps)
    const {interaction} = makeInteraction('clear-queue', 'ch-abc')

    // #when
    const result = await Effect.runPromise(Effect.either(cmd.execute(interaction)))

    // #then — Effect succeeds (not an unknown-subcommand failure)
    expect(result._tag).toBe('Right')
  })

  it('routes ping to executePing (existing behavior preserved)', async () => {
    // #given
    const cmd = createFroBotCommand(makeDeps())
    const {interaction, reply} = makeInteraction('ping')

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — reply was called with pong; helper always injects allowedMentions: {parse: []}
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'pong', ephemeral: true, allowedMentions: {parse: []}}),
    )
  })

  it('returns Effect.fail for an unknown subcommand', async () => {
    // #given
    const cmd = createFroBotCommand(makeDeps())
    const {interaction} = makeInteraction('nonexistent-sub')

    // #when
    const result = await Effect.runPromise(Effect.either(cmd.execute(interaction)))

    // #then
    expect(result._tag).toBe('Left')
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toContain('nonexistent-sub')
  })
})

// ---------------------------------------------------------------------------
// /fro-bot clear-queue handler
// ---------------------------------------------------------------------------

describe('/fro-bot clear-queue', () => {
  it('happy path: calls queue.clear with the interaction channelId and editReplies ephemerally with count', async () => {
    // #given — 3 pending tasks in the queue
    const queue = makeQueue(3)
    const deps = makeDeps({queue})
    const cmd = createFroBotCommand(deps)
    const channelId = 'ch-pending-123'
    const {interaction, deferReply, editReply} = makeInteraction('clear-queue', channelId)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — deferReply was called first (ephemeral)
    expect(deferReply).toHaveBeenCalledExactlyOnceWith({ephemeral: true})

    // #and — queue.clear was called with the channel ID
    expect(queue.clear).toHaveBeenCalledExactlyOnceWith(channelId)

    // #and — editReply mentions the count (no ephemeral flag needed — deferred reply inherits it)
    expect(editReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringContaining('3') as unknown as string,
      }),
    )
  })

  it('zero pending: clear returns 0 → editReply still sent with count 0', async () => {
    // #given — empty queue
    const queue = makeQueue(0)
    const deps = makeDeps({queue})
    const cmd = createFroBotCommand(deps)
    const {interaction, deferReply, editReply} = makeInteraction('clear-queue', 'ch-empty')

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — deferReply called
    expect(deferReply).toHaveBeenCalledExactlyOnceWith({ephemeral: true})

    // #and — queue.clear was still called
    expect(queue.clear).toHaveBeenCalledExactlyOnceWith('ch-empty')

    // #and — editReply mentions 0
    expect(editReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringContaining('0') as unknown as string,
      }),
    )
  })

  it('clear-queue does not call enqueue/takeNext/pendingCount (only pending tasks dropped, not in-flight)', async () => {
    // #given
    const queue = makeQueue(2)
    const deps = makeDeps({queue})
    const cmd = createFroBotCommand(deps)
    const {interaction} = makeInteraction('clear-queue', 'ch-r3')

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — only clear was called; no other queue methods touched
    expect(queue.clear).toHaveBeenCalledOnce()
    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(queue.takeNext).not.toHaveBeenCalled()
    expect(queue.pendingCount).not.toHaveBeenCalled()
  })

  it('reply content includes the task(s) wording and running task note', async () => {
    // #given — 1 pending task
    const queue = makeQueue(1)
    const deps = makeDeps({queue})
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('clear-queue', 'ch-wording')

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — editReply content matches expected format
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string}
    expect(replyArg.content).toMatch(/Cleared 1 queued task/)
    expect(replyArg.content).toMatch(/running task will finish/)
  })

  it('queue.clear was called with interaction.channelId exactly', async () => {
    // #given
    const queue = makeQueue(2)
    const deps = makeDeps({queue})
    const cmd = createFroBotCommand(deps)
    const channelId = 'ch-exact-id-check'
    const {interaction} = makeInteraction('clear-queue', channelId)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — clear called with the exact channelId from the interaction
    expect(queue.clear).toHaveBeenCalledExactlyOnceWith(channelId)
  })

  it('deferReply is called on the happy path (before auth and queue.clear)', async () => {
    // #given — authorized user; verify deferReply is called as part of the happy path
    // The code structure guarantees deferReply fires before userIsAuthorized (which awaits
    // guild.members.fetch). This test proves deferReply is wired in at all.
    const queue = makeQueue(2)
    const guild = makeGuild({hasRole: true})
    const deps = makeDeps({queue, triggerRoleId: 'role-123'})
    const cmd = createFroBotCommand(deps)
    const {interaction, deferReply, editReply} = makeInteraction('clear-queue', 'ch-defer-check', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — deferReply was called (ephemeral)
    expect(deferReply).toHaveBeenCalledExactlyOnceWith({ephemeral: true})
    // #and — editReply was used for the outcome (not reply)
    expect(editReply).toHaveBeenCalledOnce()
    // #and — queue.clear was called (auth passed)
    expect(queue.clear).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// /fro-bot clear-queue — authorization gate (F2)
// ---------------------------------------------------------------------------

describe('/fro-bot clear-queue — authorization gate', () => {
  it('authorized user (has trigger role) → queue.clear called + count editReply', async () => {
    // #given — user has the trigger role
    const queue = makeQueue(3)
    const guild = makeGuild({hasRole: true})
    const deps = makeDeps({queue, triggerRoleId: 'role-trigger-123'})
    const cmd = createFroBotCommand(deps)
    const {interaction, deferReply, editReply} = makeInteraction('clear-queue', 'ch-auth', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — deferReply called first
    expect(deferReply).toHaveBeenCalledExactlyOnceWith({ephemeral: true})
    // #and — queue.clear was called
    expect(queue.clear).toHaveBeenCalledOnce()
    // #and — editReply mentions the count
    expect(editReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringContaining('3') as unknown as string,
      }),
    )
  })

  it('unauthorized user (no role, no ManageChannels) → queue.clear NOT called + permission-denied editReply', async () => {
    // #given — user has neither the trigger role nor ManageChannels
    const queue = makeQueue(2)
    const guild = makeGuild({hasRole: false, hasManageChannels: false})
    const deps = makeDeps({queue, triggerRoleId: 'role-trigger-123'})
    const cmd = createFroBotCommand(deps)
    const {interaction, deferReply, editReply} = makeInteraction('clear-queue', 'ch-unauth', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — deferReply called (interaction acked before auth)
    expect(deferReply).toHaveBeenCalledExactlyOnceWith({ephemeral: true})
    // #and — queue.clear NOT called
    expect(queue.clear).not.toHaveBeenCalled()
    // #and — ephemeral permission-denied editReply
    expect(editReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringMatching(/permission|not authorized/i) as unknown as string,
      }),
    )
  })

  it('null guild → queue.clear NOT called + server-only reply (synchronous guard, no defer)', async () => {
    // #given — interaction has no guild (DM context)
    // The null-guild guard fires before deferReply because it is synchronous.
    const queue = makeQueue(1)
    const deps = makeDeps({queue})
    const cmd = createFroBotCommand(deps)
    const {interaction, reply, deferReply} = makeInteraction('clear-queue', 'ch-dm', null)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — queue.clear NOT called
    expect(queue.clear).not.toHaveBeenCalled()
    // #and — plain reply (not deferred) with server-only message
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringMatching(/server/i) as unknown as string,
      }),
    )
    // #and — deferReply NOT called (guard fires before defer)
    expect(deferReply).not.toHaveBeenCalled()
  })

  it('authorized user with ManageChannels (no trigger role configured) → queue.clear called', async () => {
    // #given — no trigger role configured; user has ManageChannels
    const queue = makeQueue(1)
    const guild = makeGuild({hasRole: false, hasManageChannels: true})
    const deps = makeDeps({queue, triggerRoleId: null})
    const cmd = createFroBotCommand(deps)
    const {interaction} = makeInteraction('clear-queue', 'ch-manage', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — queue.clear was called (ManageChannels fallback authorized)
    expect(queue.clear).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// /fro-bot clear-queue — infra-failure path (pipeline catchAll)
// ---------------------------------------------------------------------------

describe('/fro-bot clear-queue — infra-failure path', () => {
  it('queue.clear throws → editReply called with internal-error copy AND Effect ends in failure', async () => {
    // #given — queue.clear throws an unexpected infra error
    const infraError = new Error('queue storage unavailable')
    const queue: ChannelQueue<RunTask> = {
      enqueue: vi.fn().mockReturnValue('queued'),
      pendingCount: vi.fn().mockReturnValue(0),
      takeNext: vi.fn().mockReturnValue(undefined),
      clear: vi.fn().mockImplementation(() => {
        throw infraError
      }),
    }
    const deps = makeDeps({queue})
    const cmd = createFroBotCommand(deps)
    const {interaction, deferReply, editReply} = makeInteraction('clear-queue', 'ch-infra-fail')

    // #when — run via Effect.either so we can assert on both the reply AND the failure
    const result = await Effect.runPromise(Effect.either(cmd.execute(interaction)))

    // #then — deferReply was called (pipeline deferred before work)
    expect(deferReply).toHaveBeenCalledExactlyOnceWith({ephemeral: true})

    // #and — the deferred reply was edited (not left hanging at "thinking…")
    expect(editReply).toHaveBeenCalledOnce()
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string; allowedMentions?: unknown}
    expect(replyArg.content).toMatch(/internal error|please try again/i)
    expect(replyArg.allowedMentions).toEqual({parse: []})

    // #and — the error still propagates (dispatchCommand-level logger sees it)
    expect(result._tag).toBe('Left')
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toBe('queue storage unavailable')
  })
})

// ---------------------------------------------------------------------------
// /fro-bot force-release-lock — tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers for force-release-lock tests
// ---------------------------------------------------------------------------

type ForceReleaseFn = FroBotDeps['forceReleaseStaleLock']

function makeForceReleaseStaleLockMock(result: ForceReleaseStaleLockResult): ForceReleaseFn {
  return vi.fn().mockReturnValue(Effect.succeed(result))
}

function makeCoordinationConfig(): CoordinationConfig {
  return {
    storeAdapter: {} as CoordinationConfig['storeAdapter'],
    storeConfig: {enabled: true, bucket: 'test-bucket', region: 'us-east-1', prefix: 'test'},
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 30_000,
    staleThresholdMs: 60_000,
    pendingStaleThresholdMs: 30 * 60_000,
  }
}

function makeFrlDeps(overrides?: Partial<FroBotDeps>): FroBotDeps {
  const defaultForceRelease = makeForceReleaseStaleLockMock({
    outcome: 'released',
    holderId: 'holder-abc',
    runId: 'run-xyz',
    lockAgeMs: 120_000,
    heartbeatAgeMs: 90_000,
  })
  return makeDeps({
    coordinationConfig: makeCoordinationConfig(),
    forceReleaseStaleLock: defaultForceRelease,
    ...overrides,
  })
}

/**
 * Build a mock Guild where members.fetch() resolves to a member with the given
 * role set and ManageChannels permission — for force-release-lock tests.
 */
function makeFrlGuild(opts: {hasRole?: boolean; hasManageChannels?: boolean} = {}): Guild {
  return makeGuild(opts)
}

function makeBindingsStore(binding: {owner: string; repo: string} | null = {owner: 'acme', repo: 'widget'}) {
  return {
    createBinding: vi.fn(),
    getBindingByRepo: vi.fn(),
    getBindingByChannelId: vi.fn().mockResolvedValue(
      binding === null
        ? {success: true, data: null}
        : {
            success: true,
            data: {
              owner: binding.owner,
              repo: binding.repo,
              channelId: 'ch-test-123',
              surface: 'discord',
              createdAt: new Date().toISOString(),
            },
          },
    ),
    listBindings: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// /fro-bot force-release-lock — builder registration
// ---------------------------------------------------------------------------

describe('createFroBotCommand — builder registration (force-release-lock)', () => {
  it('registers force-release-lock subcommand on the builder', () => {
    // #given
    const cmd = createFroBotCommand(makeFrlDeps())

    // #when
    const json = cmd.data.toJSON()

    // #then
    const subNames = (json.options ?? []).map((o: {name: string}) => o.name)
    expect(subNames).toContain('force-release-lock')
  })
})

// ---------------------------------------------------------------------------
// /fro-bot force-release-lock — null guild guard
// ---------------------------------------------------------------------------

describe('/fro-bot force-release-lock — null guild guard', () => {
  it('null guild → plain ephemeral reply, no defer, no forceReleaseStaleLock call', async () => {
    // #given — interaction has no guild (DM context)
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'released',
      holderId: null,
      runId: null,
      lockAgeMs: null,
      heartbeatAgeMs: null,
    })
    const deps = makeFrlDeps({forceReleaseStaleLock})
    const cmd = createFroBotCommand(deps)
    const {interaction, reply, deferReply} = makeInteraction('force-release-lock', 'ch-dm', null)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — plain reply (not deferred) with server-only message
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringMatching(/server/i) as unknown as string,
      }),
    )
    // #and — deferReply NOT called
    expect(deferReply).not.toHaveBeenCalled()
    // #and — forceReleaseStaleLock NOT called
    expect(forceReleaseStaleLock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// /fro-bot force-release-lock — authorization gate (raised bar: ManageChannels only)
// ---------------------------------------------------------------------------

describe('/fro-bot force-release-lock — authorization gate', () => {
  it('manageChannels user → deferReply called first, then forceReleaseStaleLock called with gateway identity', async () => {
    // #given — user has ManageChannels
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'released',
      holderId: 'holder-abc',
      runId: 'run-xyz',
      lockAgeMs: 120_000,
      heartbeatAgeMs: 90_000,
    })
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore, identity: 'discord-gateway'})
    const cmd = createFroBotCommand(deps)
    const {interaction, deferReply, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — deferReply called first (ephemeral)
    expect(deferReply).toHaveBeenCalledExactlyOnceWith({ephemeral: true})
    // #and — forceReleaseStaleLock was called with the gateway identity as the 3rd argument
    expect(forceReleaseStaleLock).toHaveBeenCalledOnce()
    const callArgs = (forceReleaseStaleLock as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[]
    expect(callArgs[2]).toBe('discord-gateway')
    // #and — editReply was called with released confirmation
    expect(editReply).toHaveBeenCalledOnce()
  })

  it('trigger-role-only user (has role, NO ManageChannels) → DENIED, forceReleaseStaleLock NOT called', async () => {
    // #given — user has trigger role but NOT ManageChannels (the raised bar test)
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'released',
      holderId: null,
      runId: null,
      lockAgeMs: null,
      heartbeatAgeMs: null,
    })
    const guild = makeFrlGuild({hasRole: true, hasManageChannels: false})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({
      forceReleaseStaleLock,
      bindingsStore,
      triggerRoleId: 'role-trigger-123',
    })
    const cmd = createFroBotCommand(deps)
    const {interaction, deferReply, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — deferReply was called (interaction acked before auth)
    expect(deferReply).toHaveBeenCalledExactlyOnceWith({ephemeral: true})
    // #and — forceReleaseStaleLock NOT called (denied)
    expect(forceReleaseStaleLock).not.toHaveBeenCalled()
    // #and — ephemeral permission-denied editReply
    expect(editReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringMatching(/permission|not authorized/i) as unknown as string,
      }),
    )
  })

  it('unauthorized user (neither role nor ManageChannels) → denied, forceReleaseStaleLock NOT called', async () => {
    // #given — user has neither trigger role nor ManageChannels
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'released',
      holderId: null,
      runId: null,
      lockAgeMs: null,
      heartbeatAgeMs: null,
    })
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: false})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({
      forceReleaseStaleLock,
      bindingsStore,
      triggerRoleId: 'role-trigger-123',
    })
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — forceReleaseStaleLock NOT called
    expect(forceReleaseStaleLock).not.toHaveBeenCalled()
    // #and — denied reply
    expect(editReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringMatching(/permission|not authorized/i) as unknown as string,
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// /fro-bot force-release-lock — no binding edge case
// ---------------------------------------------------------------------------

describe('/fro-bot force-release-lock — no binding', () => {
  it('no binding for channel → ephemeral "no repo bound", forceReleaseStaleLock NOT called', async () => {
    // #given — channel has no binding
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'released',
      holderId: null,
      runId: null,
      lockAgeMs: null,
      heartbeatAgeMs: null,
    })
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = makeBindingsStore(null)
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore})
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('force-release-lock', 'ch-unbound', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — forceReleaseStaleLock NOT called
    expect(forceReleaseStaleLock).not.toHaveBeenCalled()
    // #and — editReply mentions no binding
    expect(editReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringMatching(/no repo|not bound|no project/i) as unknown as string,
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// /fro-bot force-release-lock — outcome → reply mapping
// ---------------------------------------------------------------------------

describe('/fro-bot force-release-lock — allowedMentions guard', () => {
  it('all outcome editReply calls include allowedMentions: {parse: []} (mention-safety guard)', async () => {
    // #given — released outcome (holder ID in content — must not be parsed as a mention)
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'released',
      holderId: 'holder-abc',
      runId: 'run-xyz',
      lockAgeMs: 120_000,
      heartbeatAgeMs: 90_000,
    })
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore})
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — editReply was called with allowedMentions: {parse: []} (injected by io.ts helper)
    expect(editReply).toHaveBeenCalledOnce()
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string; allowedMentions?: unknown}
    expect(replyArg.allowedMentions).toEqual({parse: []})
  })
})

describe('/fro-bot force-release-lock — outcome mapping', () => {
  it('released → ephemeral confirmation with holder info', async () => {
    // #given — forceReleaseStaleLock returns released
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'released',
      holderId: 'holder-abc',
      runId: 'run-xyz',
      lockAgeMs: 120_000,
      heartbeatAgeMs: 90_000,
    })
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore})
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — editReply confirms release with holder info
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string}
    expect(replyArg.content).toMatch(/released/i)
    expect(replyArg.content).toContain('holder-abc')
  })

  it('live-holder → ephemeral refusal with holder id and run age', async () => {
    // #given — forceReleaseStaleLock returns live-holder
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'live-holder',
      holderId: 'holder-live',
      runId: 'run-live',
      lockAgeMs: 30_000,
      heartbeatAgeMs: 5_000,
    })
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore})
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — editReply mentions live holder
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string}
    expect(replyArg.content).toMatch(/active|live|held/i)
    expect(replyArg.content).toContain('holder-live')
  })

  it('no-lock → ephemeral "nothing to release"', async () => {
    // #given — forceReleaseStaleLock returns no-lock
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'no-lock',
      holderId: null,
      runId: null,
      lockAgeMs: null,
      heartbeatAgeMs: null,
    })
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore})
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — editReply says nothing to release
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string}
    expect(replyArg.content).toMatch(/no lock|nothing to release|not locked/i)
  })

  it('conflict → ephemeral "lock changed, try again"', async () => {
    // #given — forceReleaseStaleLock returns conflict
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'conflict',
      holderId: 'holder-abc',
      runId: 'run-xyz',
      lockAgeMs: 120_000,
      heartbeatAgeMs: 90_000,
    })
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore})
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — editReply mentions conflict / try again
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string}
    expect(replyArg.content).toMatch(/changed|conflict|try again/i)
  })

  it('error outcome → ephemeral internal-error reply', async () => {
    // #given — forceReleaseStaleLock returns error
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'error',
      holderId: null,
      runId: null,
      lockAgeMs: null,
      heartbeatAgeMs: null,
    })
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore})
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — editReply mentions internal error
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string}
    expect(replyArg.content).toMatch(/error|failed|internal/i)
  })
})

// ---------------------------------------------------------------------------
// /fro-bot force-release-lock — missing branch coverage (P2-f)
// ---------------------------------------------------------------------------

describe('/fro-bot force-release-lock — binding store error', () => {
  it('binding store returns err → internal-error ephemeral reply, forceReleaseStaleLock NOT called', async () => {
    // #given — getBindingByChannelId returns an err result (store failure)
    const forceReleaseStaleLock = vi.fn()
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = {
      createBinding: vi.fn(),
      getBindingByRepo: vi.fn(),
      getBindingByChannelId: vi.fn().mockResolvedValue({success: false, error: new Error('DynamoDB timeout')}),
      listBindings: vi.fn(),
    }
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore})
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — forceReleaseStaleLock NOT called
    expect(forceReleaseStaleLock).not.toHaveBeenCalled()
    // #and — internal-error ephemeral reply
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string}
    expect(replyArg.content).toMatch(/something went wrong|internal error|try again/i)
  })
})

describe('/fro-bot force-release-lock — forceReleaseStaleLock returns outcome error', () => {
  it('forceReleaseStaleLock returns outcome error → internal-error ephemeral reply', async () => {
    // #given — forceReleaseStaleLock returns ok({outcome: 'error', ...})
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'error',
      holderId: null,
      runId: null,
      lockAgeMs: null,
      heartbeatAgeMs: null,
    })
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore})
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — internal-error ephemeral reply
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string}
    expect(replyArg.content).toMatch(/error|failed|internal/i)
  })
})

// ---------------------------------------------------------------------------
// /fro-bot force-release-lock — integration: dispatch path
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// /fro-bot force-release-lock — infra-failure path (outer Effect.fail)
// ---------------------------------------------------------------------------

describe('/fro-bot force-release-lock — infra-failure path', () => {
  it('forceReleaseStaleLock Effect.fail → editReply called with internal-error copy AND Effect ends in failure', async () => {
    // #given — forceReleaseStaleLock produces an outer Effect failure (missing adapter
    // capability, key-build error, etc.) — distinct from the handled outcome:'error' path.
    const infraError = new Error('adapter capability missing')
    const forceReleaseStaleLock: FroBotDeps['forceReleaseStaleLock'] = vi.fn().mockReturnValue(Effect.fail(infraError))
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore})
    const cmd = createFroBotCommand(deps)
    const {interaction, editReply} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when — run via Effect.either so we can assert on both the reply AND the failure
    const result = await Effect.runPromise(Effect.either(cmd.execute(interaction)))

    // #then — the deferred reply was edited (not left hanging at "thinking…")
    expect(editReply).toHaveBeenCalledOnce()
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string; allowedMentions?: unknown}
    expect(replyArg.content).toMatch(/internal error|please try again/i)
    expect(replyArg.allowedMentions).toEqual({parse: []})

    // #and — the error still propagates (dispatchCommand-level logger sees it)
    expect(result._tag).toBe('Left')
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toBe('adapter capability missing')
  })
})

// ---------------------------------------------------------------------------
// /fro-bot clear-queue — dispatch integration
// ---------------------------------------------------------------------------

describe('/fro-bot clear-queue — dispatch integration', () => {
  it('dispatches clear-queue through getCommandRegistry + dispatchCommand', async () => {
    // #given — real registry + dispatch path; authorized user with ManageChannels
    const queue = makeQueue(0)
    const guild = makeGuild({hasRole: false, hasManageChannels: true})
    const deps = makeDeps({queue})
    const registry = getCommandRegistry(deps)
    const {interaction} = makeInteraction('clear-queue', 'ch-dispatch-test', guild)

    // #when — dispatch through the real registry
    const result = await Effect.runPromise(Effect.either(dispatchCommand(interaction, registry)))

    // #then — dispatch resolves (not an unknown-command failure)
    expect(result._tag).toBe('Right')
    // #and — queue.clear was called (command ran end-to-end)
    expect(queue.clear).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// /fro-bot force-release-lock — dispatch integration
// ---------------------------------------------------------------------------

describe('/fro-bot force-release-lock — dispatch integration', () => {
  it('dispatches force-release-lock through getCommandRegistry + dispatchCommand', async () => {
    // #given — real registry + dispatch path
    const forceReleaseStaleLock = makeForceReleaseStaleLockMock({
      outcome: 'no-lock',
      holderId: null,
      runId: null,
      lockAgeMs: null,
      heartbeatAgeMs: null,
    })
    const guild = makeFrlGuild({hasRole: false, hasManageChannels: true})
    const bindingsStore = makeBindingsStore()
    const deps = makeFrlDeps({forceReleaseStaleLock, bindingsStore})
    const registry = getCommandRegistry(deps)
    const {interaction} = makeInteraction('force-release-lock', 'ch-test-123', guild)

    // #when — dispatch through the real registry
    const result = await Effect.runPromise(Effect.either(dispatchCommand(interaction, registry)))

    // #then — dispatch resolves (not an unknown-command failure)
    expect(result._tag).toBe('Right')
  })
})
