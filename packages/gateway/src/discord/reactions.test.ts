/**
 * Unit tests for the Discord run-state reaction helper.
 *
 * Emoji map under test:
 *   working          → ⏳
 *   succeeded        → ✅
 *   failed           → ❌
 *   awaiting-approval → ⏸️
 *
 * All public methods resolve to void and NEVER reject, even when the Discord
 * API throws. This is the primary containment invariant.
 *
 * NBC-3: setRunReaction no longer calls removeAll() (which requires ManageMessages).
 * Instead it removes only the bot's own prior reactions via users.remove(botUserId).
 */

import type {Message} from 'discord.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {REACTION_EMOJIS, setRunReaction} from './reactions.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Build a mock MessageReaction for a given emoji.
 * `me` controls whether the bot has already reacted with this emoji.
 */
function makeReaction(emoji: string, me: boolean, removeRejects = false) {
  const removeFn = removeRejects
    ? vi.fn().mockRejectedValue(new Error('users.remove API error'))
    : vi.fn().mockResolvedValue(undefined)
  return {
    emoji: {name: emoji},
    me,
    users: {remove: removeFn},
  }
}

/**
 * Build a mock Message with a reactions.cache that contains the given reactions.
 * `reactRejects` controls whether message.react() throws.
 */
function makeMessage(
  opts: {
    reactRejects?: boolean
    /** Reactions the bot has already placed (me=true). */
    botReactions?: string[]
    /** Reactions placed by others (me=false). */
    otherReactions?: string[]
  } = {},
): Message & {
  react: ReturnType<typeof vi.fn>
  reactions: {
    cache: {find: ReturnType<typeof vi.fn>}
    _reactions: ReturnType<typeof makeReaction>[]
  }
  client: {user: {id: string}}
} {
  const {reactRejects = false, botReactions = [], otherReactions = []} = opts

  const reactFn = reactRejects ? vi.fn().mockRejectedValue(new Error('react API error')) : vi.fn().mockResolvedValue({})

  // Build the reactions list
  const allReactions = [
    ...botReactions.map(e => makeReaction(e, true)),
    ...otherReactions.map(e => makeReaction(e, false)),
  ]

  // cache.find mimics Discord.js Collection.find
  const findFn = vi.fn((predicate: (r: ReturnType<typeof makeReaction>) => boolean) => allReactions.find(predicate))

  return {
    react: reactFn,
    reactions: {
      cache: {find: findFn},
      _reactions: allReactions,
    },
    client: {user: {id: 'bot-user-id'}},
  } as unknown as Message & {
    react: ReturnType<typeof vi.fn>
    reactions: {
      cache: {find: ReturnType<typeof vi.fn>}
      _reactions: ReturnType<typeof makeReaction>[]
    }
    client: {user: {id: string}}
  }
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// REACTION_EMOJIS map
// ---------------------------------------------------------------------------

describe('REACTION_EMOJIS', () => {
  it('exports the expected emoji for each state', () => {
    expect(REACTION_EMOJIS.working).toBe('⏳')
    expect(REACTION_EMOJIS.succeeded).toBe('✅')
    expect(REACTION_EMOJIS.failed).toBe('❌')
    expect(REACTION_EMOJIS['awaiting-approval']).toBe('⏸️')
  })
})

// ---------------------------------------------------------------------------
// setRunReaction — happy paths (NBC-3: per-emoji users.remove, not removeAll)
// ---------------------------------------------------------------------------

describe('setRunReaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('run start: sets the working reaction (⏳) on the message', async () => {
    // #given — no prior bot reactions
    const message = makeMessage()
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'working', logger)

    // #then — new reaction added
    expect(message.react).toHaveBeenCalledExactlyOnceWith('⏳')
  })

  it('terminal success: adds succeeded (✅)', async () => {
    // #given
    const message = makeMessage()
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'succeeded', logger)

    // #then
    expect(message.react).toHaveBeenCalledExactlyOnceWith('✅')
  })

  it('terminal failure: sets failed (❌) on the message', async () => {
    // #given
    const message = makeMessage()
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'failed', logger)

    // #then
    expect(message.react).toHaveBeenCalledExactlyOnceWith('❌')
  })

  it('approval-wait: sets awaiting-approval (⏸️) on the message', async () => {
    // #given
    const message = makeMessage()
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'awaiting-approval', logger)

    // #then
    expect(message.react).toHaveBeenCalledExactlyOnceWith('⏸️')
  })

  it('removes the bot own prior reaction before adding the new one (replace, not accumulate)', async () => {
    // #given — bot previously reacted with ⏳
    const message = makeMessage({botReactions: ['⏳']})
    const logger = makeLogger()

    // #when — transition to succeeded
    await setRunReaction(message, 'succeeded', logger)

    // #then — the prior ⏳ reaction's users.remove was called with the bot user ID
    const priorReaction = message.reactions._reactions.find(r => r.emoji.name === '⏳')
    expect(priorReaction).toBeDefined()
    expect(priorReaction?.users.remove).toHaveBeenCalledExactlyOnceWith('bot-user-id')

    // #and — the new ✅ reaction was added
    expect(message.react).toHaveBeenCalledExactlyOnceWith('✅')
  })

  it('does NOT call users.remove for reactions the bot has not placed (me=false)', async () => {
    // #given — another user reacted with ⏳, bot has not
    const message = makeMessage({otherReactions: ['⏳']})
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'succeeded', logger)

    // #then — the other user's reaction is untouched
    const otherReaction = message.reactions._reactions.find(r => r.emoji.name === '⏳')
    expect(otherReaction?.users.remove).not.toHaveBeenCalled()

    // #and — new reaction added
    expect(message.react).toHaveBeenCalledExactlyOnceWith('✅')
  })

  it('prior state reaction is cleared before the new one is added (two sequential transitions)', async () => {
    // #given — simulate two sequential state transitions
    // First transition: no prior reactions → add ⏳
    const message = makeMessage()
    const logger = makeLogger()

    // #when — first transition: working
    await setRunReaction(message, 'working', logger)
    // #when — second transition: succeeded
    await setRunReaction(message, 'succeeded', logger)

    // #then — react called twice: ⏳ then ✅
    expect(message.react).toHaveBeenCalledTimes(2)
    expect((message.react as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('⏳')
    expect((message.react as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toBe('✅')
  })

  it('approval-wait → succeeded: awaiting replaced by succeeded on completion', async () => {
    // #given — bot previously reacted with ⏸️
    const message = makeMessage({botReactions: ['⏸️']})
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'succeeded', logger)

    // #then — prior ⏸️ removed, ✅ added
    const priorReaction = message.reactions._reactions.find(r => r.emoji.name === '⏸️')
    expect(priorReaction?.users.remove).toHaveBeenCalledExactlyOnceWith('bot-user-id')
    expect(message.react).toHaveBeenCalledExactlyOnceWith('✅')
  })

  it('approval-wait → failed: awaiting replaced by failed on completion', async () => {
    // #given — bot previously reacted with ⏸️
    const message = makeMessage({botReactions: ['⏸️']})
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'failed', logger)

    // #then — prior ⏸️ removed, ❌ added
    const priorReaction = message.reactions._reactions.find(r => r.emoji.name === '⏸️')
    expect(priorReaction?.users.remove).toHaveBeenCalledExactlyOnceWith('bot-user-id')
    expect(message.react).toHaveBeenCalledExactlyOnceWith('❌')
  })
})

// ---------------------------------------------------------------------------
// Containment: Discord API failures MUST NOT reject the helper
// ---------------------------------------------------------------------------

describe('setRunReaction — containment (API failures)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('react() rejects → helper resolves to void (does NOT reject)', async () => {
    // #given — react() throws
    const message = makeMessage({reactRejects: true})
    const logger = makeLogger()

    // #when / #then — must not throw
    await expect(setRunReaction(message, 'working', logger)).resolves.toBeUndefined()
  })

  it('react() rejects → failure is logged as warn, not silently swallowed', async () => {
    // #given
    const message = makeMessage({reactRejects: true})
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'working', logger)

    // #then — warn was called with the error
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('users.remove() rejects → helper resolves to void (does NOT reject)', async () => {
    // #given — bot has a prior reaction; users.remove throws
    const message = makeMessage({botReactions: ['⏳']})
    // Override the remove fn to reject
    const priorReaction = message.reactions._reactions.find(r => r.emoji.name === '⏳')
    if (priorReaction !== undefined) {
      priorReaction.users.remove = vi.fn().mockRejectedValue(new Error('users.remove API error'))
    }
    const logger = makeLogger()

    // #when / #then — must not throw
    await expect(setRunReaction(message, 'succeeded', logger)).resolves.toBeUndefined()
  })

  it('users.remove() rejects → failure is logged as warn', async () => {
    // #given — bot has a prior reaction; users.remove throws
    const message = makeMessage({botReactions: ['⏳']})
    const priorReaction = message.reactions._reactions.find(r => r.emoji.name === '⏳')
    if (priorReaction !== undefined) {
      priorReaction.users.remove = vi.fn().mockRejectedValue(new Error('users.remove API error'))
    }
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'succeeded', logger)

    // #then — warn was called (for the remove failure)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('both users.remove() and react() reject → helper still resolves to void', async () => {
    // #given — both fail
    const message = makeMessage({botReactions: ['⏳'], reactRejects: true})
    const priorReaction = message.reactions._reactions.find(r => r.emoji.name === '⏳')
    if (priorReaction !== undefined) {
      priorReaction.users.remove = vi.fn().mockRejectedValue(new Error('users.remove API error'))
    }
    const logger = makeLogger()

    // #when / #then
    await expect(setRunReaction(message, 'failed', logger)).resolves.toBeUndefined()
  })
})
