import type {GatewayLogger} from './discord/client.js'

import {GatewayIntentBits} from 'discord.js'
import {describe, expect, it, vi} from 'vitest'

// Prevent the top-level Effect.runPromise(program) in main.ts from executing
// when the module is imported. The program tries to load config from env vars
// and call process.exit(1) on failure — both are unwanted in tests.
vi.mock('effect', async importOriginal => {
  const actual = await importOriginal<typeof import('effect')>()
  return {
    ...actual,
    Effect: {
      ...actual.Effect,
      runPromise: vi.fn().mockResolvedValue(undefined),
    },
  }
})

// Spy on createDiscordClient so we can assert the intents wiring without
// touching the network or requiring a real Discord token.
vi.mock('./discord/client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./discord/client.js')>()
  return {
    ...actual,
    createDiscordClient: vi.fn(actual.createDiscordClient),
  }
})

const {makeDiscordClientFromConfig} = await import('./main.js')
const {createDiscordClient} = await import('./discord/client.js')
const createDiscordClientSpy = vi.mocked(createDiscordClient)

const stubLogger: GatewayLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

describe('makeDiscordClientFromConfig', () => {
  it('passes empty privilegedIntents to createDiscordClient (common case after posture flip)', () => {
    // #given a config with no privileged intents opted in
    const config = {privilegedIntents: [] as readonly GatewayIntentBits[]}

    // #when
    makeDiscordClientFromConfig(config, stubLogger)

    // #then createDiscordClient receives intents: [] — not the bare {logger} form
    expect(createDiscordClientSpy).toHaveBeenCalledWith({intents: [], logger: stubLogger})
  })

  it('passes [MessageContent] to createDiscordClient when opted in', () => {
    // #given
    const config = {privilegedIntents: [GatewayIntentBits.MessageContent] as const}

    // #when
    makeDiscordClientFromConfig(config, stubLogger)

    // #then
    expect(createDiscordClientSpy).toHaveBeenCalledWith({
      intents: [GatewayIntentBits.MessageContent],
      logger: stubLogger,
    })
  })

  it('passes [MessageContent, GuildMembers] to createDiscordClient when both are opted in', () => {
    // #given
    const config = {
      privilegedIntents: [GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] as const,
    }

    // #when
    makeDiscordClientFromConfig(config, stubLogger)

    // #then
    expect(createDiscordClientSpy).toHaveBeenCalledWith({
      intents: [GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
      logger: stubLogger,
    })
  })
})
