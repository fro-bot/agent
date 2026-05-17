import type {ChatInputCommandInteraction} from 'discord.js'
import {Routes} from 'discord.js'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {dispatchCommand, getCommandRegistry, registerSlashCommands, type SlashCommand} from './index.js'

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
  it('includes the ping command', () => {
    // #given / #when
    const registry = getCommandRegistry()

    // #then
    const ping = registry.find(c => c.data.name === 'fro-bot')
    expect(ping).toBeDefined()
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
    const registry = getCommandRegistry()
    const interaction = {commandName: 'nonexistent', reply} as unknown as ChatInputCommandInteraction

    // #when
    const result = await Effect.runPromise(Effect.either(dispatchCommand(interaction, registry)))

    // #then — the Effect still fails with a clear error
    expect(result._tag).toBe('Left')
    expect((result as {_tag: 'Left'; left: unknown}).left).toBeInstanceOf(Error)
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toContain('nonexistent')
    // #and — Discord receives an ephemeral acknowledgement within the 3-second window
    // so the user sees an actual response instead of "This interaction failed"
    const contentMatcher: unknown = expect.stringContaining('nonexistent')
    expect(reply).toHaveBeenCalledExactlyOnceWith({content: contentMatcher, ephemeral: true})
  })

  it('still fails with the original error when the ephemeral ack itself fails', async () => {
    // #given a reply() that rejects (e.g. interaction token already expired)
    const reply = vi.fn().mockRejectedValue(new Error('Interaction has already been acknowledged'))
    const registry = getCommandRegistry()
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
    } as unknown as ChatInputCommandInteraction
    const registry = getCommandRegistry()

    // #when
    await Effect.runPromise(dispatchCommand(interaction, registry))

    // #then
    expect(reply).toHaveBeenCalledWith({content: 'pong', ephemeral: true})
  })

  it('logs a console.warn when the ephemeral ack fails for an unknown command', async () => {
    // #given a reply() that rejects so the ack-failure branch fires
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const reply = vi.fn().mockRejectedValue(new Error('Token expired'))
      const registry = getCommandRegistry()
      const interaction = {commandName: 'nonexistent', reply} as unknown as ChatInputCommandInteraction

      // #when
      const result = await Effect.runPromise(Effect.either(dispatchCommand(interaction, registry)))

      // #then — Effect still fails with unknown-command (existing behavior preserved)
      expect(result._tag).toBe('Left')

      // #and — console.warn captured the ack failure with the JSON payload shape
      expect(consoleSpy).toHaveBeenCalledOnce()
      const arg = consoleSpy.mock.calls[0]?.[0] as string
      const parsed = JSON.parse(arg) as Record<string, unknown>
      expect(parsed.level).toBe('warn')
      expect(parsed.msg).toBe('ack failed for unknown command')
      expect(parsed.commandName).toBe('nonexistent')
      expect(String(parsed.err)).toContain('Token expired')
    } finally {
      consoleSpy.mockRestore()
    }
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
