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

import type {ChatInputCommandInteraction, Guild} from 'discord.js'
import type {ChannelQueue} from '../../execute/queue.js'
import type {RunTask} from '../../execute/run.js'
import type {FroBotDeps} from './fro-bot.js'

import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'

import {createFroBotCommand} from './fro-bot.js'

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
  return {
    bindingsStore: {
      createBinding: vi.fn(),
      getBindingByRepo: vi.fn(),
      getBindingByChannelId: vi.fn(),
      listBindings: vi.fn(),
    },
    appClient: {
      authForRepo: vi.fn(),
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
} {
  const reply = vi.fn().mockResolvedValue(undefined)
  const interaction = {
    commandName: 'fro-bot',
    channelId,
    guild,
    user: {id: userId},
    reply,
    options: {
      getSubcommand: vi.fn().mockReturnValue(subcommand),
    },
  } as unknown as ChatInputCommandInteraction
  return {interaction, reply}
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

    // #then — reply was called with pong
    expect(reply).toHaveBeenCalledWith({content: 'pong', ephemeral: true})
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
  it('happy path: calls queue.clear with the interaction channelId and replies ephemerally with count', async () => {
    // #given — 3 pending tasks in the queue
    const queue = makeQueue(3)
    const deps = makeDeps({queue})
    const cmd = createFroBotCommand(deps)
    const channelId = 'ch-pending-123'
    const {interaction, reply} = makeInteraction('clear-queue', channelId)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — queue.clear was called with the channel ID
    expect(queue.clear).toHaveBeenCalledExactlyOnceWith(channelId)

    // #and — reply was ephemeral and mentions the count
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining('3') as unknown as string,
      }),
    )
  })

  it('zero pending: clear returns 0 → reply still sent with count 0', async () => {
    // #given — empty queue
    const queue = makeQueue(0)
    const deps = makeDeps({queue})
    const cmd = createFroBotCommand(deps)
    const {interaction, reply} = makeInteraction('clear-queue', 'ch-empty')

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — queue.clear was still called
    expect(queue.clear).toHaveBeenCalledExactlyOnceWith('ch-empty')

    // #and — reply mentions 0
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ephemeral: true,
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
    const {interaction, reply} = makeInteraction('clear-queue', 'ch-wording')

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — reply content matches expected format
    const replyArg = reply.mock.calls[0]?.[0] as {content: string; ephemeral: boolean}
    expect(replyArg.content).toMatch(/Cleared 1 queued task/)
    expect(replyArg.content).toMatch(/running task will finish/)
    expect(replyArg.ephemeral).toBe(true)
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
})

// ---------------------------------------------------------------------------
// /fro-bot clear-queue — authorization gate (F2)
// ---------------------------------------------------------------------------

describe('/fro-bot clear-queue — authorization gate', () => {
  it('authorized user (has trigger role) → queue.clear called + count reply', async () => {
    // #given — user has the trigger role
    const queue = makeQueue(3)
    const guild = makeGuild({hasRole: true})
    const deps = makeDeps({queue, triggerRoleId: 'role-trigger-123'})
    const cmd = createFroBotCommand(deps)
    const {interaction, reply} = makeInteraction('clear-queue', 'ch-auth', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — queue.clear was called
    expect(queue.clear).toHaveBeenCalledOnce()
    // #and — reply mentions the count
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining('3') as unknown as string,
      }),
    )
  })

  it('unauthorized user (no role, no ManageChannels) → queue.clear NOT called + permission-denied reply', async () => {
    // #given — user has neither the trigger role nor ManageChannels
    const queue = makeQueue(2)
    const guild = makeGuild({hasRole: false, hasManageChannels: false})
    const deps = makeDeps({queue, triggerRoleId: 'role-trigger-123'})
    const cmd = createFroBotCommand(deps)
    const {interaction, reply} = makeInteraction('clear-queue', 'ch-unauth', guild)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — queue.clear NOT called
    expect(queue.clear).not.toHaveBeenCalled()
    // #and — ephemeral permission-denied reply
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringMatching(/permission|not authorized/i) as unknown as string,
      }),
    )
  })

  it('null guild → queue.clear NOT called + server-only reply', async () => {
    // #given — interaction has no guild (DM context)
    const queue = makeQueue(1)
    const deps = makeDeps({queue})
    const cmd = createFroBotCommand(deps)
    const {interaction, reply} = makeInteraction('clear-queue', 'ch-dm', null)

    // #when
    await Effect.runPromise(cmd.execute(interaction))

    // #then — queue.clear NOT called
    expect(queue.clear).not.toHaveBeenCalled()
    // #and — ephemeral server-only reply
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringMatching(/server/i) as unknown as string,
      }),
    )
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
