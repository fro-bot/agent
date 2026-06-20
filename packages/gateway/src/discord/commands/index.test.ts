import type {CoordinationConfig} from '@fro-bot/runtime'
import type {ChatInputCommandInteraction} from 'discord.js'
import type {FroBotDeps} from './fro-bot.js'

import {Routes} from 'discord.js'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {dispatchCommand, getCommandRegistry, registerSlashCommands, type SlashCommand} from './index.js'

// ---------------------------------------------------------------------------
// Minimal mock deps for getCommandRegistry
// ---------------------------------------------------------------------------

function makeMockDeps(): FroBotDeps {
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
    queue: {
      enqueue: vi.fn().mockReturnValue('queued'),
      pendingCount: vi.fn().mockReturnValue(0),
      takeNext: vi.fn().mockReturnValue(undefined),
      clear: vi.fn().mockReturnValue(0),
    },
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
    },
    identity: 'discord-gateway',
    forceReleaseStaleLock: vi.fn().mockResolvedValue({
      success: true,
      data: {outcome: 'no-lock', holderId: null, runId: null, lockAgeMs: null, heartbeatAgeMs: null},
    }),
  }
}

const restPutMock = vi.fn().mockResolvedValue(undefined)
const restSetTokenMock = vi.fn().mockReturnThis()

// MockREST is a plain constructor function so `new REST()` works inside the production code.
// It must be declared at module scope to satisfy unicorn/consistent-function-scoping.
function MockREST(this: {setToken: typeof restSetTokenMock; put: typeof restPutMock}) {
  this.setToken = restSetTokenMock
  this.put = restPutMock
}

// vi.mock is hoisted by Vitest to the top of the module at runtime, so the
// factory runs before any imports. ESLint sees this as "after imports" but
// that's fine — the import-x/first rule applies to static imports, not vi.mock.
vi.mock('discord.js', async importOriginal => {
  const actual = await importOriginal<typeof import('discord.js')>()
  return {
    ...actual,
    REST: MockREST,
    Routes: {
      applicationCommands: vi.fn((appId: string) => `GLOBAL:${appId}`),
      applicationGuildCommands: vi.fn((appId: string, guildId: string) => `GUILD:${appId}:${guildId}`),
    },
  }
})

beforeEach(() => {
  restPutMock.mockClear()
  restSetTokenMock.mockClear()
  ;(Routes.applicationCommands as ReturnType<typeof vi.fn>).mockClear()
  ;(Routes.applicationGuildCommands as ReturnType<typeof vi.fn>).mockClear()
})

describe('getCommandRegistry', () => {
  it('includes the fro-bot command', () => {
    // #given / #when
    const registry = getCommandRegistry(makeMockDeps())

    // #then
    const cmd = registry.find(c => c.data.name === 'fro-bot')
    expect(cmd).toBeDefined()
  })
})

describe('dispatchCommand', () => {
  it('routes to the matching command and runs it', async () => {
    // #given a registry with a mock command
    const execute = vi.fn().mockReturnValue(Effect.void)
    const registry = [
      {
        data: {name: 'test-cmd'} as unknown as import('discord.js').SlashCommandBuilder,
        execute,
      },
    ]
    const interaction = {commandName: 'test-cmd'} as unknown as ChatInputCommandInteraction

    // #when
    await Effect.runPromise(dispatchCommand(interaction, registry))

    // #then
    expect(execute).toHaveBeenCalledExactlyOnceWith(interaction)
  })

  it('returns Effect.fail on unknown command name with clear error message AND replies ephemerally', async () => {
    // #given a registry that does not contain the requested command
    const reply = vi.fn().mockResolvedValue(undefined)
    const registry = getCommandRegistry(makeMockDeps())
    const interaction = {commandName: 'nonexistent', reply} as unknown as ChatInputCommandInteraction

    // #when
    const result = await Effect.runPromise(Effect.either(dispatchCommand(interaction, registry)))

    // #then — the Effect still fails with a clear error
    expect(result._tag).toBe('Left')
    expect((result as {_tag: 'Left'; left: unknown}).left).toBeInstanceOf(Error)
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toContain('nonexistent')
    // #and — Discord receives an ephemeral acknowledgement within the 3-second window
    // so the user sees an actual response instead of "This interaction failed"
    // The helper always injects allowedMentions: {parse: []}
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringContaining('nonexistent') as unknown as string,
        ephemeral: true,
        allowedMentions: {parse: []},
      }),
    )
  })

  it('still fails with the original error when the ephemeral ack itself fails', async () => {
    // #given a reply() that rejects (e.g. interaction token already expired)
    const reply = vi.fn().mockRejectedValue(new Error('Interaction has already been acknowledged'))
    const registry = getCommandRegistry(makeMockDeps())
    const interaction = {commandName: 'nonexistent', reply} as unknown as ChatInputCommandInteraction

    // #when
    const result = await Effect.runPromise(Effect.either(dispatchCommand(interaction, registry)))

    // #then — the original "unknown command" error wins, not "ack-failed"
    expect(result._tag).toBe('Left')
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toContain('nonexistent')
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).not.toContain('ack-failed')
    expect(reply).toHaveBeenCalledOnce()
  })

  it('dispatches the real ping command successfully', async () => {
    // #given
    const reply = vi.fn().mockResolvedValue(undefined)
    const interaction = {
      commandName: 'fro-bot',
      reply,
      options: {getSubcommand: vi.fn().mockReturnValue('ping')},
    } as unknown as ChatInputCommandInteraction
    const registry = getCommandRegistry(makeMockDeps())

    // #when
    await Effect.runPromise(dispatchCommand(interaction, registry))

    // #then — helper always injects allowedMentions: {parse: []}
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'pong', ephemeral: true, allowedMentions: {parse: []}}),
    )
  })

  it('logs a console.warn when the ephemeral ack fails for an unknown command', async () => {
    // #given a reply() that rejects so the ack-failure branch fires.
    // replyInteraction catches the error and returns err(Error) in the Result.
    // dispatchCommand checks the Result and logs via console.warn.
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const reply = vi.fn().mockRejectedValue(new Error('Token expired'))
      const registry = getCommandRegistry(makeMockDeps())
      const interaction = {commandName: 'nonexistent', reply} as unknown as ChatInputCommandInteraction

      // #when
      const result = await Effect.runPromise(Effect.either(dispatchCommand(interaction, registry)))

      // #then — Effect still fails with unknown-command (existing behavior preserved)
      expect(result._tag).toBe('Left')

      // #and — console.warn captured the ack failure with the JSON payload shape.
      // Note: replyInteraction also logs via DISPATCH_LOGGER (which calls console.warn),
      // so there may be 2 console.warn calls. The dispatchCommand-level log is the one
      // with msg: 'ack failed for unknown command'.
      const warnCalls = consoleSpy.mock.calls as [string][]
      const dispatchWarnCall = warnCalls.find(([arg]) => {
        try {
          const parsed = JSON.parse(arg) as Record<string, unknown>
          return parsed.msg === 'ack failed for unknown command'
        } catch {
          return false
        }
      })
      expect(dispatchWarnCall).toBeDefined()
      const parsed = JSON.parse((dispatchWarnCall as [string])[0]) as Record<string, unknown>
      expect(parsed.level).toBe('warn')
      expect(parsed.msg).toBe('ack failed for unknown command')
      expect(parsed.commandName).toBe('nonexistent')
      expect(String(parsed.err)).toContain('Token expired')
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('dispatches /fro-bot add-project to executeAddProject with injected deps', async () => {
    // #given — registry built with mock deps; guild is null to exercise the guild-null guard path.
    // add-project uses the pipeline, which guards BEFORE defer.
    // So guild-null → immediate ephemeral reply (interaction.reply), deferReply NOT called.
    const deps = makeMockDeps()
    const registry = getCommandRegistry(deps)

    const deferReply = vi.fn().mockResolvedValue(undefined)
    const editReply = vi.fn().mockResolvedValue(undefined)
    const reply = vi.fn().mockResolvedValue(undefined)

    const interaction = {
      commandName: 'fro-bot',
      id: 'test-interaction-id',
      user: {id: 'user-dispatch-test'},
      guild: null,
      client: {user: {id: 'bot-user-id'}},
      options: {
        getSubcommand: vi.fn().mockReturnValue('add-project'),
        getString: vi.fn().mockReturnValue('https://github.com/owner/repo'),
      },
      deferReply,
      editReply,
      reply,
    } as unknown as ChatInputCommandInteraction

    // #when — dispatch routes to add-project; guild-null guard fires pre-defer
    await Effect.runPromise(dispatchCommand(interaction, registry))

    // #then — immediate ephemeral reply (not deferred) with server-only message
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({content: expect.stringContaining('server') as unknown as string}),
    )
    // #and — deferReply NOT called (guard fires before defer)
    expect(deferReply).not.toHaveBeenCalled()
  })
})

describe('registerSlashCommands', () => {
  it('uses Routes.applicationCommands for global registration when guildId is null', async () => {
    // #given
    const token = 'test-token'
    const applicationId = 'app-123'
    const registry: SlashCommand[] = [
      {
        data: {name: 'cmd', toJSON: () => ({name: 'cmd'})} as unknown as import('discord.js').SlashCommandBuilder,
        execute: () => Effect.void,
      },
    ]

    // #when
    await registerSlashCommands(token, applicationId, null, registry)

    // #then
    expect(Routes.applicationCommands).toHaveBeenCalledWith(applicationId) // eslint-disable-line @typescript-eslint/unbound-method
    expect(Routes.applicationGuildCommands).not.toHaveBeenCalled() // eslint-disable-line @typescript-eslint/unbound-method
    expect(restPutMock).toHaveBeenCalledWith('GLOBAL:app-123', {body: [{name: 'cmd'}]})
  })

  it('uses Routes.applicationGuildCommands for guild-scoped registration when guildId is provided', async () => {
    // #given
    const token = 'test-token'
    const applicationId = 'app-123'
    const guildId = 'guild-456'
    const registry: SlashCommand[] = [
      {
        data: {name: 'cmd', toJSON: () => ({name: 'cmd'})} as unknown as import('discord.js').SlashCommandBuilder,
        execute: () => Effect.void,
      },
    ]

    // #when
    await registerSlashCommands(token, applicationId, guildId, registry)

    // #then
    expect(Routes.applicationGuildCommands).toHaveBeenCalledWith(applicationId, guildId) // eslint-disable-line @typescript-eslint/unbound-method
    expect(Routes.applicationCommands).not.toHaveBeenCalled() // eslint-disable-line @typescript-eslint/unbound-method
    expect(restPutMock).toHaveBeenCalledWith('GUILD:app-123:guild-456', {body: [{name: 'cmd'}]})
  })
})
