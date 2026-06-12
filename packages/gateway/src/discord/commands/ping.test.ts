import type {ChatInputCommandInteraction} from 'discord.js'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'

import {executePing} from './ping.js'

describe('executePing', () => {
  it('calls interaction.reply with content "pong", ephemeral: true, and allowedMentions: {parse: []}', async () => {
    // #given a mock interaction
    const reply = vi.fn().mockResolvedValue(undefined)
    const interaction = {reply} as unknown as ChatInputCommandInteraction

    // #when the command is executed
    await Effect.runPromise(executePing(interaction))

    // #then reply was called with the correct args (helper always injects allowedMentions)
    expect(reply).toHaveBeenCalledExactlyOnceWith({
      content: 'pong',
      ephemeral: true,
      allowedMentions: {parse: []},
    })
  })

  it('does NOT propagate Effect failure when reply throws — helper catches and returns err Result', async () => {
    // #given a failing interaction
    // replyInteraction catches Discord API errors and returns err(Error) inside the Result.
    // The Effect itself never fails — errors are best-effort.
    const reply = vi.fn().mockRejectedValue(new Error('Discord API error'))
    const interaction = {reply} as unknown as ChatInputCommandInteraction

    // #when
    const result = await Effect.runPromise(Effect.either(executePing(interaction)))

    // #then — Effect succeeds (helper is fail-soft; error is in the Result, not the Effect)
    expect(result._tag).toBe('Right')
  })

  it('reply is called exactly once even when it throws', async () => {
    // #given
    const reply = vi.fn().mockRejectedValue(new Error('Discord API error'))
    const interaction = {reply} as unknown as ChatInputCommandInteraction

    // #when
    await Effect.runPromise(executePing(interaction))

    // #then
    expect(reply).toHaveBeenCalledOnce()
  })
})
