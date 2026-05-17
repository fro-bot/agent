import type {ChatInputCommandInteraction} from 'discord.js'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'

import pingCommand from './ping.js'

describe('ping command', () => {
  it('calls interaction.reply with content "pong" and ephemeral: true', async () => {
    // #given a mock interaction
    const reply = vi.fn().mockResolvedValue(undefined)
    const interaction = {reply} as unknown as ChatInputCommandInteraction

    // #when the command is executed
    await Effect.runPromise(pingCommand.execute(interaction))

    // #then reply was called with the correct args
    expect(reply).toHaveBeenCalledExactlyOnceWith({content: 'pong', ephemeral: true})
  })

  it('returns Effect.fail when reply throws', async () => {
    // #given a failing interaction
    const reply = vi.fn().mockRejectedValue(new Error('Discord API error'))
    const interaction = {reply} as unknown as ChatInputCommandInteraction

    // #when
    const result = await Effect.runPromise(Effect.either(pingCommand.execute(interaction)))

    // #then
    expect(result._tag).toBe('Left')
    expect((result as {_tag: 'Left'; left: unknown}).left).toBeInstanceOf(Error)
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toBe('Discord API error')
  })

  it('has command name "fro-bot" with subcommand "ping"', () => {
    // #given / #when
    const json = pingCommand.data.toJSON()

    // #then
    expect(json.name).toBe('fro-bot')
    expect(json.options).toBeDefined()
    const sub = json.options?.find((o: {name: string}) => o.name === 'ping')
    expect(sub).toBeDefined()
  })
})
