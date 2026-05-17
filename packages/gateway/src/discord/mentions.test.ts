import type {Message, TextChannel, ThreadChannel} from 'discord.js'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'

const BOT_USER_ID = 'bot-user-123'

function makeMessage(
  overrides: Partial<{
    isThread: boolean
    mentionsBot: boolean
    sendFn: ReturnType<typeof vi.fn>
    startThreadFn: ReturnType<typeof vi.fn>
    reactFn: ReturnType<typeof vi.fn>
    replyFn: ReturnType<typeof vi.fn>
  }>,
): Message {
  const {
    isThread = false,
    mentionsBot = true,
    sendFn = vi.fn().mockResolvedValue(undefined),
    startThreadFn,
    reactFn = vi.fn().mockResolvedValue(undefined),
    replyFn = vi.fn().mockResolvedValue(undefined),
  } = overrides

  const startThread = startThreadFn ?? vi.fn().mockResolvedValue({send: sendFn} as unknown as ThreadChannel)

  return {
    channel: {
      isThread: () => isThread,
    } as unknown as TextChannel,
    mentions: {
      has: (id: string) => mentionsBot && id === BOT_USER_ID,
    },
    startThread,
    react: reactFn,
    reply: replyFn,
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

  it('still attempts fallback reply when both startThread and react fail, then fails with the original error', async () => {
    // #given startThread rejects AND react also rejects (e.g. global rate limit)
    const {handleMention} = await import('./mentions.js')
    const startThreadError = new Error('startThread rate limit')
    const startThreadFn = vi.fn().mockRejectedValue(startThreadError)
    const reactFn = vi.fn().mockRejectedValue(new Error('react also rate limited'))
    const replyFn = vi.fn().mockResolvedValue(undefined)
    const message = makeMessage({startThreadFn, reactFn, replyFn})

    // #when
    const result = await Effect.runPromise(Effect.either(handleMention(message, BOT_USER_ID)))

    // #then — Effect still fails with the ORIGINAL startThread error
    expect(result._tag).toBe('Left')
    expect((result as {_tag: 'Left'; left: unknown}).left).toBeInstanceOf(Error)
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toContain('startThread rate limit')
    // #and — react was attempted (and failed)
    expect(reactFn).toHaveBeenCalledWith('❌')
    // #and — fallback reply was still attempted despite react failing
    expect(replyFn).toHaveBeenCalledOnce()
  })

  it('preserves the original startThread error when fallback reply also fails', async () => {
    // #given startThread rejects, react succeeds, reply rejects
    const {handleMention} = await import('./mentions.js')
    const startThreadError = new Error('startThread permission denied')
    const startThreadFn = vi.fn().mockRejectedValue(startThreadError)
    const reactFn = vi.fn().mockResolvedValue(undefined)
    const replyFn = vi.fn().mockRejectedValue(new Error('reply also failed'))
    const message = makeMessage({startThreadFn, reactFn, replyFn})

    // #when
    const result = await Effect.runPromise(Effect.either(handleMention(message, BOT_USER_ID)))

    // #then — Effect fails with the original startThread error, not the reply error
    expect(result._tag).toBe('Left')
    expect((result as {_tag: 'Left'; left: unknown}).left).toBeInstanceOf(Error)
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toContain('startThread permission denied')
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).not.toContain('reply also failed')
  })

  it('reacts ❌ and sends fallback reply when startThread fails, then fails with the original error', async () => {
    // #given
    const {handleMention} = await import('./mentions.js')
    const threadError = new Error('Missing Permissions')
    const startThreadFn = vi.fn().mockRejectedValue(threadError)
    const reactFn = vi.fn().mockResolvedValue(undefined)
    const replyFn = vi.fn().mockResolvedValue(undefined)
    const message = makeMessage({isThread: false, mentionsBot: true, startThreadFn, reactFn, replyFn})

    // #when
    const result = await Effect.runPromise(Effect.either(handleMention(message, BOT_USER_ID)))

    // #then — react was called with ❌
    expect(reactFn).toHaveBeenCalledWith('❌')

    // #and — fallback reply was sent with the expected content
    expect(replyFn).toHaveBeenCalledWith({
      content: 'Could not start a session here — please try again or check channel permissions.',
    })

    // #and — the Effect still fails with the original startThread error
    expect(result._tag).toBe('Left')
    expect((result as {_tag: 'Left'; left: unknown}).left).toBe(threadError)
  })
})
