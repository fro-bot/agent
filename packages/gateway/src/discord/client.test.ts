import type {EventEmitter} from 'node:events'

import {GatewayIntentBits} from 'discord.js'
import {describe, expect, it, vi} from 'vitest'

import {createDiscordClient, DEFAULT_INTENTS} from './client.js'

// discord.js Client constructor makes no network calls — safe to instantiate in tests.

describe('createDiscordClient', () => {
  it('returns a Client with allowedMentions locked to users-only', () => {
    // #given a token
    const token = 'Bot test-token'

    // #when the client is created
    const client = createDiscordClient(token)

    // #then allowedMentions prevents @everyone / @here
    expect(client.options.allowedMentions).toEqual({parse: ['users'], repliedUser: false})
  })

  it('default intents include MessageContent (required to read mention text)', () => {
    // #given
    const token = 'Bot test-token'

    // #when
    const client = createDiscordClient(token)

    // #then
    const intents = client.options.intents
    // discord.js stores intents as a BitField; check via DEFAULT_INTENTS constant
    expect(DEFAULT_INTENTS).toContain(GatewayIntentBits.MessageContent)
    expect(intents).toBeDefined()
  })

  it('optional intent override merges with defaults (dedup via Set)', () => {
    // #given a custom intent list including one not in defaults
    const token = 'Bot test-token'
    const customIntents = [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds] // Guilds is already default

    // #when
    const client = createDiscordClient(token, {intents: customIntents})

    // #then the BitField is the union of defaults + extras (no duplicates)
    const expected = [...new Set<GatewayIntentBits>([...DEFAULT_INTENTS, ...customIntents])]
    const expectedBitfield = new (
      client.options.intents as unknown as {constructor: new (bits: GatewayIntentBits[]) => {bitfield: number}}
    ).constructor(expected).bitfield
    expect((client.options.intents as unknown as {bitfield: number}).bitfield).toBe(expectedBitfield)
  })

  it('wires shard events to logger when logger is provided', () => {
    // #given a mock logger
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const token = 'Bot test-token'

    // #when
    const client = createDiscordClient(token, {logger})

    // #then shard events emit log calls
    const emitter = client as unknown as EventEmitter
    emitter.emit('shardReady', 0)
    expect(logger.info).toHaveBeenCalledWith({shardId: 0}, 'discord shard ready')

    emitter.emit('shardReconnecting', 0)
    expect(logger.info).toHaveBeenCalledWith({shardId: 0}, 'discord shard reconnecting')
  })
})
