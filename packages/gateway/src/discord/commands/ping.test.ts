import type {ChatInputCommandInteraction} from 'discord.js'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'

import {executePing} from './ping.js'

describe('executePing', () => {
  it('calls interaction.reply with content "pong" and ephemeral: true', async () => {
    // #given a mock interaction
    const reply = vi.fn().mockResolvedValue(undefined)
    const interaction = {reply} as unknown as ChatInputCommandInteraction

    // #when the command is executed
    await Effect.runPromise(executePing(interaction))

    // #then reply was called with the correct args
    expect(reply).toHaveBeenCalledExactlyOnceWith({content: 'pong', ephemeral: true})
  })

  it('returns Effect.fail when reply throws', async () => {
    // #given a failing interaction
    const reply = vi.fn().mockRejectedValue(new Error('Discord API error'))
    const interaction = {reply} as unknown as ChatInputCommandInteraction

    // #when
    const result = await Effect.runPromise(Effect.either(executePing(interaction)))

    // #then
    expect(result._tag).toBe('Left')
    expect((result as {_tag: 'Left'; left: unknown}).left).toBeInstanceOf(Error)
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toBe('Discord API error')
  })
})
