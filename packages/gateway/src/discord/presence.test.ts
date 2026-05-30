/**
 * Tests for postPresenceEmbed.
 *
 * All Discord API calls are mocked — no real network or Discord connections.
 * Uses vitest with BDD-style comments (#given, #when, #then).
 */

import type {Result} from '@fro-bot/runtime'
import type {Client, TextBasedChannel} from 'discord.js'

import type {PresenceEmbed} from './presence.js'
import {describe, expect, it, vi} from 'vitest'
import {postPresenceEmbed} from './presence.js'

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

function expectOk<T, E>(r: Result<T, E>): T {
  if (r.success === false) throw new Error(`expected ok, got err: ${JSON.stringify(r.error)}`)
  return r.data
}

function expectErr<T, E>(r: Result<T, E>): E {
  if (r.success === true) throw new Error('expected err, got ok')
  return r.error
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMBED: PresenceEmbed = {
  title: 'Test Presence',
  description: 'Bot is online.',
  color: 0x57f287,
}

const CHANNEL_ID = 'ch-announce-001'

/** Build a mock discord.js Client whose channels.fetch returns the given value. */
function makeClient(fetchResult: unknown): Client {
  return {
    channels: {
      fetch: vi.fn().mockResolvedValue(fetchResult),
    },
  } as unknown as Client
}

/** Build a mock text-based channel with a controllable send. */
function makeTextChannel(sendImpl?: () => Promise<void>) {
  const send = vi.fn().mockImplementation(sendImpl ?? (async () => Promise.resolve(undefined)))
  const channel = {
    isTextBased: vi.fn().mockReturnValue(true),
    send,
  } as unknown as TextBasedChannel
  return {channel, send}
}

/** Build a mock non-text channel. */
function makeVoiceChannel() {
  return {
    isTextBased: vi.fn().mockReturnValue(false),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('postPresenceEmbed', () => {
  describe('happy path', () => {
    it('calls send with the embed and mandatory allowedMentions:{parse:[]}', async () => {
      // #given — a valid text channel that accepts sends
      const {channel, send} = makeTextChannel()
      const client = makeClient(channel)

      // #when
      const result = await postPresenceEmbed(client, CHANNEL_ID, EMBED)

      // #then — success
      expect(result.success).toBe(true)
      expect(send).toHaveBeenCalledExactlyOnceWith({
        embeds: [EMBED],
        allowedMentions: {parse: []},
      })

      // Integration: assert the EXACT object passed to send
    })

    it('resolves ok(undefined) — no meaningful value in the success case', async () => {
      // #given
      const {channel} = makeTextChannel()
      const client = makeClient(channel)

      // #when
      const result = await postPresenceEmbed(client, CHANNEL_ID, EMBED)

      // #then
      expect(result.success).toBe(true)
      expect(expectOk(result)).toBeUndefined()
    })
  })

  describe('channel-not-found', () => {
    it('returns channel-not-found when channels.fetch resolves null', async () => {
      // #given — fetch returns null (channel deleted / bot lacks access)
      const client = makeClient(null)

      // #when
      const result = await postPresenceEmbed(client, CHANNEL_ID, EMBED)

      // #then — typed error, no throw
      expect(result.success).toBe(false)
      expect(expectErr(result)).toEqual({kind: 'channel-not-found'})
    })

    it('returns channel-not-found when channels.fetch resolves undefined', async () => {
      // #given
      const client = makeClient(undefined)

      // #when
      const result = await postPresenceEmbed(client, CHANNEL_ID, EMBED)

      // #then
      expect(result.success).toBe(false)
      expect(expectErr(result)).toEqual({kind: 'channel-not-found'})
    })
  })

  describe('not-text-channel', () => {
    it('returns not-text-channel when isTextBased() is false', async () => {
      // #given — voice/stage channel
      const client = makeClient(makeVoiceChannel())

      // #when
      const result = await postPresenceEmbed(client, CHANNEL_ID, EMBED)

      // #then — typed error, no throw
      expect(result.success).toBe(false)
      expect(expectErr(result)).toEqual({kind: 'not-text-channel'})
    })
  })

  describe('send-failed', () => {
    it('returns send-failed with message when send rejects — does not throw', async () => {
      // #given — channel is fine but send blows up
      const {channel} = makeTextChannel(async () => Promise.reject(new Error('Missing Permissions')))
      const client = makeClient(channel)

      // #when
      const result = await postPresenceEmbed(client, CHANNEL_ID, EMBED)

      // #then — typed error, no throw, message forwarded
      expect(result.success).toBe(false)
      const error = expectErr(result)
      expect(error.kind).toBe('send-failed')
      if (error.kind !== 'send-failed') throw new Error('unreachable')
      expect(error.message).toBe('Missing Permissions')
    })

    it('returns send-failed with stringified non-Error rejection', async () => {
      // #given
      // eslint-disable-next-line prefer-promise-reject-errors -- deliberately rejecting with a non-Error to exercise the String(error) fallback path
      const {channel} = makeTextChannel(async () => Promise.reject('rate limited'))
      const client = makeClient(channel)

      // #when
      const result = await postPresenceEmbed(client, CHANNEL_ID, EMBED)

      // #then
      expect(result.success).toBe(false)
      const error = expectErr(result)
      expect(error.kind).toBe('send-failed')
      if (error.kind !== 'send-failed') throw new Error('unreachable')
      expect(error.message).toBe('rate limited')
    })
  })

  describe('allowedMentions invariant', () => {
    it('always passes allowedMentions:{parse:[]} even when embed has user-mention-like text', async () => {
      // #given — embed description could look like a mention
      const {channel, send} = makeTextChannel()
      const client = makeClient(channel)
      const hostileEmbed: PresenceEmbed = {
        description: '@everyone @here <@123456> look at this',
        color: 0xff0000,
      }

      // #when
      await postPresenceEmbed(client, CHANNEL_ID, hostileEmbed)

      // #then — send was called with the strict allowedMentions regardless
      const callArg = send.mock.calls[0]?.[0] as {allowedMentions: {parse: string[]}}
      expect(callArg.allowedMentions).toEqual({parse: []})
    })
  })

  describe('timeout', () => {
    it('returns send-failed with "discord post timed out" when fetch never resolves', async () => {
      // #given — a fetch that never resolves (simulates hung Discord API)
      const neverResolving = new Promise<never>(() => {
        /* intentionally never resolves */
      })
      const client = {
        channels: {
          fetch: vi.fn().mockReturnValue(neverResolving),
        },
      } as unknown as Client

      // #when — use a tiny timeoutMs so the test is fast
      const result = await postPresenceEmbed(client, CHANNEL_ID, EMBED, 10)

      // #then — returns err with send-failed, does not hang
      expect(result.success).toBe(false)
      const error = expectErr(result)
      expect(error.kind).toBe('send-failed')
      if (error.kind !== 'send-failed') throw new Error('unreachable')
      expect(error.message).toBe('discord post timed out')
    })

    it('happy path still resolves ok when Discord responds before timeout', async () => {
      // #given — a fast-resolving text channel
      const {channel, send} = makeTextChannel()
      const client = makeClient(channel)

      // #when — generous timeout, Discord resolves instantly
      const result = await postPresenceEmbed(client, CHANNEL_ID, EMBED, 5_000)

      // #then — success, send called exactly once
      expect(result.success).toBe(true)
      expect(send).toHaveBeenCalledExactlyOnceWith({
        embeds: [EMBED],
        allowedMentions: {parse: []},
      })
    })
  })
})
