import type {GatewayConfig} from './config.js'
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

// Stub registerSlashCommands so makeGatewayProgram doesn't hit the network.
vi.mock('./discord/commands/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./discord/commands/index.js')>()
  return {
    ...actual,
    registerSlashCommands: vi.fn().mockResolvedValue(undefined),
  }
})

const {makeDiscordClientFromConfig, makeGatewayProgram} = await import('./main.js')
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

// ---------------------------------------------------------------------------
// makeGatewayProgram — startup ordering (Todo 018)
// ---------------------------------------------------------------------------

describe('makeGatewayProgram', () => {
  it('calls setupReadinessFlag before login', async () => {
    // #given
    const fakeConfig: GatewayConfig = {
      discordToken: 'test-token',
      discordApplicationId: 'test-app-id',
      discordGuildId: null,
      identity: 'test-gateway',
      logLevel: 'info',
      privilegedIntents: [],
      objectStore: {
        enabled: true,
        bucket: 'test-bucket',
        region: 'us-east-1',
        prefix: 'test-prefix',
      },
    }

    // Minimal fake client — just needs to satisfy the Client shape enough for
    // setupReadinessFlag (on/once) and the event wiring in makeGatewayProgram.
    const fakeClient = {
      on: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      user: null,
      login: vi.fn().mockResolvedValue('token'),
    }

    const setupReadinessFlagSpy = vi.fn()
    const loginSpy = vi.fn().mockResolvedValue(undefined)

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: setupReadinessFlagSpy,
      login: loginSpy,
    }

    // #when — run the program with the real Effect runtime (not the mocked runPromise).
    // vi.importActual bypasses the module mock so we get the real runPromise.
    const {Effect: ActualEffect} = await vi.importActual<typeof import('effect')>('effect')
    await ActualEffect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — setupReadinessFlag must have been called before login
    expect(setupReadinessFlagSpy).toHaveBeenCalledTimes(1)
    expect(loginSpy).toHaveBeenCalledTimes(1)

    const setupOrder = setupReadinessFlagSpy.mock.invocationCallOrder[0]
    const loginOrder = loginSpy.mock.invocationCallOrder[0]
    expect(setupOrder).toBeDefined()
    expect(loginOrder).toBeDefined()
    if (setupOrder === undefined || loginOrder === undefined) {
      throw new Error('invocationCallOrder missing — toBeDefined() should have caught this')
    }
    expect(setupOrder).toBeLessThan(loginOrder)
  })
})
