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
 */

import type {Message} from 'discord.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {REACTION_EMOJIS, setRunReaction} from './reactions.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeMessage(opts: {reactRejects?: boolean; removeAllRejects?: boolean} = {}): Message & {
  react: ReturnType<typeof vi.fn>
  reactions: {removeAll: ReturnType<typeof vi.fn>}
} {
  const reactFn =
    opts.reactRejects === true ? vi.fn().mockRejectedValue(new Error('react API error')) : vi.fn().mockResolvedValue({})
  const removeAllFn =
    opts.removeAllRejects === true
      ? vi.fn().mockRejectedValue(new Error('removeAll API error'))
      : vi.fn().mockResolvedValue({})
  return {
    react: reactFn,
    reactions: {removeAll: removeAllFn},
  } as unknown as Message & {
    react: ReturnType<typeof vi.fn>
    reactions: {removeAll: ReturnType<typeof vi.fn>}
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
// setRunReaction — happy paths
// ---------------------------------------------------------------------------

describe('setRunReaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('run start: sets the working reaction (⏳) on the message', async () => {
    // #given
    const message = makeMessage()
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'working', logger)

    // #then — prior reactions cleared, then working emoji added
    expect(message.reactions.removeAll).toHaveBeenCalledOnce()
    expect(message.react).toHaveBeenCalledExactlyOnceWith('⏳')
  })

  it('terminal success: replaces working with succeeded (✅)', async () => {
    // #given
    const message = makeMessage()
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'succeeded', logger)

    // #then — prior reactions cleared, then succeeded emoji added
    expect(message.reactions.removeAll).toHaveBeenCalledOnce()
    expect(message.react).toHaveBeenCalledExactlyOnceWith('✅')
  })

  it('terminal failure: sets failed (❌) on the message', async () => {
    // #given
    const message = makeMessage()
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'failed', logger)

    // #then — prior reactions cleared, then failed emoji added
    expect(message.reactions.removeAll).toHaveBeenCalledOnce()
    expect(message.react).toHaveBeenCalledExactlyOnceWith('❌')
  })

  it('approval-wait: sets awaiting-approval (⏸️) on the message', async () => {
    // #given
    const message = makeMessage()
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'awaiting-approval', logger)

    // #then — prior reactions cleared, then awaiting emoji added
    expect(message.reactions.removeAll).toHaveBeenCalledOnce()
    expect(message.react).toHaveBeenCalledExactlyOnceWith('⏸️')
  })

  it('prior state reaction is cleared before the new one is added (replace, not accumulate)', async () => {
    // #given — simulate two sequential state transitions
    const message = makeMessage()
    const logger = makeLogger()

    // #when — first transition: working
    await setRunReaction(message, 'working', logger)
    // #when — second transition: succeeded
    await setRunReaction(message, 'succeeded', logger)

    // #then — removeAll called twice (once per transition)
    expect(message.reactions.removeAll).toHaveBeenCalledTimes(2)
    // #and — react called twice: ⏳ then ✅
    expect(message.react).toHaveBeenCalledTimes(2)
    expect((message.react as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('⏳')
    expect((message.react as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toBe('✅')
  })

  it('approval-wait → succeeded: awaiting replaced by succeeded on completion', async () => {
    // #given
    const message = makeMessage()
    const logger = makeLogger()

    // #when — approval-wait then success
    await setRunReaction(message, 'awaiting-approval', logger)
    await setRunReaction(message, 'succeeded', logger)

    // #then — two transitions, final emoji is ✅
    expect(message.react).toHaveBeenCalledTimes(2)
    const calls = (message.react as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0]?.[0]).toBe('⏸️')
    expect(calls[1]?.[0]).toBe('✅')
  })

  it('approval-wait → failed: awaiting replaced by failed on completion', async () => {
    // #given
    const message = makeMessage()
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'awaiting-approval', logger)
    await setRunReaction(message, 'failed', logger)

    // #then
    const calls = (message.react as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0]?.[0]).toBe('⏸️')
    expect(calls[1]?.[0]).toBe('❌')
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

  it('removeAll() rejects → helper resolves to void (does NOT reject)', async () => {
    // #given — removeAll() throws
    const message = makeMessage({removeAllRejects: true})
    const logger = makeLogger()

    // #when / #then — must not throw
    await expect(setRunReaction(message, 'succeeded', logger)).resolves.toBeUndefined()
  })

  it('removeAll() rejects → failure is logged as warn', async () => {
    // #given
    const message = makeMessage({removeAllRejects: true})
    const logger = makeLogger()

    // #when
    await setRunReaction(message, 'succeeded', logger)

    // #then
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('both removeAll() and react() reject → helper still resolves to void', async () => {
    // #given — both fail
    const message = makeMessage({reactRejects: true, removeAllRejects: true})
    const logger = makeLogger()

    // #when / #then
    await expect(setRunReaction(message, 'failed', logger)).resolves.toBeUndefined()
  })
})
