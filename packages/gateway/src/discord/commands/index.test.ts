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
})
