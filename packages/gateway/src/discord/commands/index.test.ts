import type {ChatInputCommandInteraction} from 'discord.js'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'

import {dispatchCommand, getCommandRegistry} from './index.js'

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

  it('returns Effect.fail on unknown command name with clear error message', async () => {
    // #given an empty registry
    const registry = getCommandRegistry()
    const interaction = {commandName: 'nonexistent'} as unknown as ChatInputCommandInteraction

    // #when
    const result = await Effect.runPromise(Effect.either(dispatchCommand(interaction, registry)))

    // #then
    expect(result._tag).toBe('Left')
    expect((result as {_tag: 'Left'; left: unknown}).left).toBeInstanceOf(Error)
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toContain('nonexistent')
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
})
