import type {GatewayConfig} from './config.js'
import type {GatewayLogger} from './discord/client.js'

import {GatewayIntentBits} from 'discord.js'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'

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

const {makeDiscordClientFromConfig, makeGatewayProgram} = await import('./program.js')
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

/** Minimal GatewayConfig for tests — fills required fields. */
function makeFakeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
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
    githubAppId: 'test-app-id',
    githubAppPrivateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
    gatewayGitHubAppInstallUrl: 'https://github.com/apps/fro-bot/installations/new',
    workspaceAgentUrl: 'http://workspace:9100',
    workspaceOpencodeUrl: 'http://workspace:9101',
    workspaceOpencodeToken: 'test-opencode-token',
    triggerRoleId: null,
    maxConcurrentRuns: 3,
    webhookSecret: 'test-webhook-secret',
    presenceChannelId: 'test-presence-channel-id',
    httpPort: 3000,
    ...overrides,
  }
}

/** Minimal fake Discord client for program tests. */
function makeFakeClient() {
  return {
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    user: null,
    login: vi.fn().mockResolvedValue('token'),
  }
}

/** Fake server handle returned by startAnnounceServer stub. */
function makeFakeServerHandle() {
  return {close: vi.fn()}
}

describe('makeGatewayProgram', () => {
  it('calls setupReadinessFlag before login', async () => {
    // #given
    const fakeConfig = makeFakeConfig()
    const fakeClient = makeFakeClient()
    const fakeServerHandle = makeFakeServerHandle()

    const setupReadinessFlagSpy = vi.fn()
    const loginSpy = vi.fn().mockResolvedValue(undefined)
    const startAnnounceServerSpy = vi.fn().mockReturnValue(fakeServerHandle)

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: setupReadinessFlagSpy,
      login: loginSpy,
      startAnnounceServer: startAnnounceServerSpy,
    }

    // #when — run the program with the real Effect runtime.
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

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

  it('calls startAnnounceServer with client, logger, and isShuttingDown', async () => {
    // #given
    const fakeConfig = makeFakeConfig()
    const fakeClient = makeFakeClient()
    const fakeServerHandle = makeFakeServerHandle()

    const startAnnounceServerSpy = vi.fn().mockReturnValue(fakeServerHandle)

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: startAnnounceServerSpy,
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — factory was called once
    expect(startAnnounceServerSpy).toHaveBeenCalledOnce()

    // #and — serverDeps includes the discord client
    const [serverDeps, serverConfig] = startAnnounceServerSpy.mock.calls[0] as [
      import('./http/server.js').AnnounceServerDeps,
      import('./http/server.js').AnnounceServerConfig,
    ]
    expect(serverDeps.client).toBe(fakeClient)
    expect(typeof serverDeps.isShuttingDown).toBe('function')

    // #and — serverConfig is wired from GatewayConfig
    expect(serverConfig.webhookSecret).toBe('test-webhook-secret')
    expect(serverConfig.presenceChannelId).toBe('test-presence-channel-id')
    expect(serverConfig.httpPort).toBe(3000)
  })

  it('startAnnounceServer is called before login (server starts before gateway accepts traffic)', async () => {
    // #given
    const fakeConfig = makeFakeConfig()
    const fakeClient = makeFakeClient()
    const fakeServerHandle = makeFakeServerHandle()

    const startAnnounceServerSpy = vi.fn().mockReturnValue(fakeServerHandle)
    const loginSpy = vi.fn().mockResolvedValue(undefined)

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: loginSpy,
      startAnnounceServer: startAnnounceServerSpy,
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — server started before login
    const serverOrder = startAnnounceServerSpy.mock.invocationCallOrder[0]
    const loginOrder = loginSpy.mock.invocationCallOrder[0]
    if (serverOrder === undefined || loginOrder === undefined) {
      throw new Error('invocationCallOrder missing')
    }
    expect(serverOrder).toBeLessThan(loginOrder)
  })
})
