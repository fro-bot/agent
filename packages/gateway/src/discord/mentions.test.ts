import type {Message, TextChannel, ThreadChannel} from 'discord.js'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'

const BOT_USER_ID = 'bot-user-123'

function makeMessage(
  overrides: Partial<{isThread: boolean; mentionsBot: boolean; sendFn: ReturnType<typeof vi.fn>}>,
): Message {
  const {isThread = false, mentionsBot = true, sendFn = vi.fn().mockResolvedValue(undefined)} = overrides

  const startThread = vi.fn().mockResolvedValue({send: sendFn} as unknown as ThreadChannel)

  return {
    channel: {
      isThread: () => isThread,
    } as unknown as TextChannel,
    mentions: {
      has: (id: string) => mentionsBot && id === BOT_USER_ID,
    },
    startThread,
    _startThread: startThread, // expose for assertions
  } as unknown as Message
}

describe('handleMention', () => {
  it('creates a thread and replies "pong" when bot is mentioned in a non-thread channel', async () => {
    // #given
    const {handleMention} = await import('./mentions.js')
    const sendFn = vi.fn().mockResolvedValue(undefined)
    const message = makeMessage({isThread: false, mentionsBot: true, sendFn})

    // #when
    await Effect.runPromise(handleMention(message, BOT_USER_ID))

    // #then
    expect((message as unknown as {_startThread: ReturnType<typeof vi.fn>})._startThread).toHaveBeenCalledWith({
      name: 'fro-bot session',
    })
    expect(sendFn).toHaveBeenCalledWith('pong')
  })

  it('skips when message is already in a thread', async () => {
    // #given
    const {handleMention} = await import('./mentions.js')
    const message = makeMessage({isThread: true, mentionsBot: true})

    // #when
    await Effect.runPromise(handleMention(message, BOT_USER_ID))

    // #then — no thread created
    expect((message as unknown as {_startThread: ReturnType<typeof vi.fn>})._startThread).not.toHaveBeenCalled()
  })

  it('skips when bot is not actually mentioned (reply-chain only)', async () => {
    // #given
    const {handleMention} = await import('./mentions.js')
    const message = makeMessage({isThread: false, mentionsBot: false})

    // #when
    await Effect.runPromise(handleMention(message, BOT_USER_ID))

    // #then — no thread created
    expect((message as unknown as {_startThread: ReturnType<typeof vi.fn>})._startThread).not.toHaveBeenCalled()
  })
})
