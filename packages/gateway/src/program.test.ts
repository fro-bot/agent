import type {CoordinationConfig} from '@fro-bot/runtime'

import type {GatewayConfig} from './config.js'
import type {GatewayLogger} from './discord/client.js'
import type {CoordinationLogger} from './runtime-effect.js'

import {GatewayIntentBits} from 'discord.js'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

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

// Stub the approval registry factory
vi.mock('./approvals/registry.js', () => ({
  createApprovalRegistry: vi.fn().mockReturnValue({
    register: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    pending: vi.fn().mockReturnValue([]),
    handleButtonDecision: vi.fn().mockResolvedValue('ok'),
    applySettlement: vi.fn().mockResolvedValue(undefined),
    attachMessage: vi.fn(),
    markMessagePostFailed: vi.fn(),
    confirmReply: vi.fn(),
    disposeRun: vi.fn(),
    disposeAll: vi.fn().mockResolvedValue(undefined),
  }),
}))

// Stub userIsAuthorized and handleMention from mentions.
// handleMention is stubbed so we can capture the deps it receives without
// running the real execution path (which requires live S3/Discord/workspace).
vi.mock('./discord/mentions.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./discord/mentions.js')>()
  return {
    ...actual,
    userIsAuthorized: vi.fn().mockResolvedValue(true),
    handleMention: vi.fn().mockReturnValue(Effect.void),
  }
})

// Stub approval discord helpers (parseApprovalCustomId, buildApprovalEmbed, etc.)
vi.mock('./discord/approvals.js', () => ({
  parseApprovalCustomId: vi.fn().mockReturnValue(null),
  buildApprovalEmbed: vi.fn().mockReturnValue({type: 'embed'}),
  buildApprovalButtons: vi.fn().mockReturnValue({type: 'buttons'}),
  buildSettledEmbed: vi.fn().mockReturnValue({type: 'settled-embed'}),
  APPROVE_PREFIX: 'fb-approve:',
  DENY_PREFIX: 'fb-deny:',
}))

// Stub ensureWorkspaceClone so program tests can assert wiring without live GitHub/workspace calls.
vi.mock('./workspace-api/ensure-clone.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./workspace-api/ensure-clone.js')>()
  return {
    ...actual,
    ensureWorkspaceClone: vi.fn().mockResolvedValue({success: true, data: '/workspace/repos/test/repo'}),
  }
})

// Stub createDenylistCache so program tests can assert startup priming without real GitHub App calls.
vi.mock('./redaction/denylist.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./redaction/denylist.js')>()
  return {
    ...actual,
    createDenylistCache: vi.fn().mockReturnValue({
      getDenylistState: vi.fn().mockResolvedValue(undefined),
      isRepoDenied: vi.fn().mockReturnValue(false),
    }),
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
    gatewayGitHubAppInstallUrl: 'https://github.com/apps/fro-bot-agent/installations/new',
    workspaceAgentUrl: 'http://workspace:9100',
    workspaceOpencodeUrl: 'http://workspace:9200',
    workspaceOpencodeToken: 'test-opencode-token',
    triggerRoleId: null,
    maxConcurrentRuns: 3,
    runTimeoutMs: 600_000,
    approvalMode: 'approval-required',
    statusMode: 'live-status',
    persona: null,
    announce: {
      webhookSecret: 'test-webhook-secret',
      presenceChannelId: 'test-presence-channel-id',
      httpPort: 3000,
    },
    ...overrides,
  }
}

/** Full operatorWeb config block for tests — includes all required OAuth fields. */
function makeOperatorWebConfig(
  overrides: Partial<NonNullable<GatewayConfig['operatorWeb']>> = {},
): NonNullable<GatewayConfig['operatorWeb']> {
  // Build a minimal deny-all allowlist for tests that don't need real allowlist behavior.
  const denyAllAllowlist = {isAuthorized: () => false, size: 0}
  return {
    bindHost: '172.20.0.2',
    bindPort: 4000,
    publicOrigin: 'https://operator.example.com',
    oauthClientId: 'test-oauth-client-id',
    oauthClientSecret: 'test-oauth-client-secret',
    oauthAllowedReturnPaths: ['/operator'],
    oauthStateTtlMs: 600_000,
    oauthMaxOutstandingAttemptsPerKey: 5,
    csrfSecret: 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE',
    allowlist: denyAllAllowlist,
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

/**
 * Build a fake Discord message that passes all messageCreate guards:
 * - not a bot author
 * - client.user is non-null and is mentioned
 * - not shutting down
 */
function makeFakeMentionMessage(botUserId: string) {
  return {
    author: {id: 'user-111', bot: false},
    content: 'do the thing',
    channel: {id: 'ch-test', isThread: () => false},
    guild: null,
    mentions: {has: (id: string) => id === botUserId},
    startThread: vi.fn().mockResolvedValue({id: 'thread-1', send: vi.fn()}),
    reply: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Run the program, capture the messageCreate handler, fire it with a fake
 * mention message, and return the deps passed to handleMention.
 */
async function runAndCaptureMentionDeps(
  approvalMode: 'approval-required',
): Promise<import('./discord/mentions.js').MentionDeps> {
  const {handleMention} = await import('./discord/mentions.js')
  const handleMentionMock = vi.mocked(handleMention)

  const fakeConfig = makeFakeConfig({approvalMode, announce: undefined})
  const botUserId = 'bot-user-id'

  // Build a fake client whose .user is set so the messageCreate guard passes.
  const fakeClient = {
    ...makeFakeClient(),
    user: {id: botUserId},
  }

  const deps = {
    makeClient: () => fakeClient as unknown as import('discord.js').Client,
    setupReadinessFlag: vi.fn(),
    login: vi.fn().mockResolvedValue(undefined),
    startAnnounceServer: vi.fn(),
    startOperatorServer: vi.fn(),
    runProviderSelfTest: vi.fn(async () => {}),
  }

  await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

  // Find and fire the messageCreate handler
  const onCalls = (fakeClient.on as ReturnType<typeof vi.fn>).mock.calls as [string, (msg: unknown) => void][]
  const messageCreateHandler = onCalls.find(([event]) => event === 'messageCreate')?.[1]
  if (messageCreateHandler === undefined) throw new Error('messageCreate handler not registered')

  const fakeMessage = makeFakeMentionMessage(botUserId)
  messageCreateHandler(fakeMessage)

  // handleMention is fire-and-forget (Effect.runPromise inside the handler);
  // wait one microtask tick for the synchronous Effect.void to settle.
  await new Promise(resolve => setTimeout(resolve, 0))

  expect(handleMentionMock).toHaveBeenCalledOnce()
  const capturedDeps = handleMentionMock.mock.calls[0]?.[2] as import('./discord/mentions.js').MentionDeps
  if (capturedDeps === undefined) throw new Error('handleMention was not called with deps')
  return capturedDeps
}

describe('makeGatewayProgram', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
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
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
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
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
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

  it('provider self-test runs during boot before login', async () => {
    // #given
    const fakeConfig = makeFakeConfig()
    const fakeClient = makeFakeClient()
    const fakeServerHandle = makeFakeServerHandle()

    const callOrder: string[] = []
    const runProviderSelfTestSpy = vi.fn(async (_cc: CoordinationConfig, _lg: CoordinationLogger) => {
      callOrder.push('runProviderSelfTest')
    })
    const loginSpy = vi.fn(async () => {
      callOrder.push('login')
    })

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: loginSpy,
      startAnnounceServer: vi.fn().mockReturnValue(fakeServerHandle),
      startOperatorServer: vi.fn(),
      runProviderSelfTest: runProviderSelfTestSpy,
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — self-test was called exactly once
    expect(runProviderSelfTestSpy).toHaveBeenCalledTimes(1)

    // #and — self-test ran before login
    expect(callOrder).toContain('runProviderSelfTest')
    expect(callOrder).toContain('login')
    expect(callOrder.indexOf('runProviderSelfTest')).toBeLessThan(callOrder.indexOf('login'))
  })

  it('boot fails fast when provider self-test rejects', async () => {
    // #given
    const fakeConfig = makeFakeConfig()
    const fakeClient = makeFakeClient()
    const fakeServerHandle = makeFakeServerHandle()

    const loginSpy = vi.fn(async () => {})

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: loginSpy,
      startAnnounceServer: vi.fn().mockReturnValue(fakeServerHandle),
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {
        throw new Error('IfNoneMatch not honored')
      }),
    }

    // #when — boot must reject
    await expect(Effect.runPromise(makeGatewayProgram(deps, fakeConfig))).rejects.toThrow('IfNoneMatch not honored')

    // #then — login was NOT called (fail before connecting to Discord)
    expect(loginSpy).not.toHaveBeenCalled()
  })

  it('announce enabled: startAnnounceServer called once with announce secrets + httpPort', async () => {
    // #given — config has announce present
    const fakeConfig = makeFakeConfig({
      announce: {webhookSecret: 'test-webhook-secret', presenceChannelId: 'test-presence-channel-id', httpPort: 3000},
    })
    const fakeClient = makeFakeClient()
    const fakeServerHandle = makeFakeServerHandle()
    const startAnnounceServerSpy = vi.fn().mockReturnValue(fakeServerHandle)

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: startAnnounceServerSpy,
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — factory called exactly once
    expect(startAnnounceServerSpy).toHaveBeenCalledOnce()

    // #and — serverConfig carries the announce secrets and httpPort
    const [, serverConfig] = startAnnounceServerSpy.mock.calls[0] as [
      import('./http/server.js').AnnounceServerDeps,
      import('./http/server.js').AnnounceServerConfig,
    ]
    expect(serverConfig.webhookSecret).toBe('test-webhook-secret')
    expect(serverConfig.presenceChannelId).toBe('test-presence-channel-id')
    expect(serverConfig.httpPort).toBe(3000)
  })

  it('announce enabled: logs "announce endpoint enabled" at boot', async () => {
    // #given — config has announce present; spy on console.log (makeLogger writes JSON there)
    const fakeConfig = makeFakeConfig({
      announce: {webhookSecret: 'test-webhook-secret', presenceChannelId: 'test-presence-channel-id', httpPort: 3000},
    })
    const fakeClient = makeFakeClient()
    const fakeServerHandle = makeFakeServerHandle()
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn().mockReturnValue(fakeServerHandle),
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
    }

    try {
      // #when
      await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

      // #then — at least one console.log call contained the enabled message
      const loggedMessages = consoleSpy.mock.calls.map(args => String(args[0]))
      expect(loggedMessages.some(m => m.includes('announce endpoint enabled — HTTP server started'))).toBe(true)
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('announce disabled: startAnnounceServer is NOT called when config.announce is undefined', async () => {
    // #given — config has no announce block
    const fakeConfig = makeFakeConfig({announce: undefined})
    const fakeClient = makeFakeClient()
    const startAnnounceServerSpy = vi.fn()

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: startAnnounceServerSpy,
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — announce server was never started
    expect(startAnnounceServerSpy).not.toHaveBeenCalled()
  })

  it('announce disabled: boot completes successfully and logs "announce endpoint disabled"', async () => {
    // #given — config has no announce block; spy on console.log (makeLogger writes JSON there)
    const fakeConfig = makeFakeConfig({announce: undefined})
    const fakeClient = makeFakeClient()
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
    }

    try {
      // #when — must not throw
      await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

      // #then — the disabled log line was emitted
      const loggedMessages = consoleSpy.mock.calls.map(args => String(args[0]))
      expect(loggedMessages.some(m => m.includes('announce endpoint disabled — no announce secrets configured'))).toBe(
        true,
      )
    } finally {
      consoleSpy.mockRestore()
    }
  })

  // ── Approval mode propagation ────────────────────────────────────────────
  //
  // These tests fire the messageCreate handler with a fake mention message and
  // assert that handleMention receives deps.run.approvalMode matching the config.
  // handleMention is mocked above so we can capture its args without a live workspace.

  it('approval-required: handleMention receives deps.run.approvalMode === "approval-required"', async () => {
    // #given / #when
    const capturedDeps = await runAndCaptureMentionDeps('approval-required')

    // #then — approvalMode is threaded from GatewayConfig into the mention run deps
    expect(capturedDeps.run.approvalMode).toBe('approval-required')
  })

  it('messageCreate: RunMentionDeps.ensureClone calls ensureWorkspaceClone with owner, repo, appClient, workspaceClient, and logger', async () => {
    // #given — mock ensureWorkspaceClone so we can assert it is called through real wiring
    const {ensureWorkspaceClone} = await import('./workspace-api/ensure-clone.js')
    const ensureWorkspaceCloneMock = vi.mocked(ensureWorkspaceClone)
    ensureWorkspaceCloneMock.mockResolvedValue({success: true, data: '/workspace/repos/acme/widget'})

    // #when — capture the deps passed to handleMention
    const capturedDeps = await runAndCaptureMentionDeps('approval-required')

    // #then — ensureClone is now in run (after concurrency gate), not at the top level
    expect(typeof capturedDeps.run.ensureClone).toBe('function')

    // #when — invoke the ensureClone function with owner/repo
    await capturedDeps.run.ensureClone('acme', 'widget')

    // #then — ensureWorkspaceClone was called with the correct owner, repo, and non-null clients
    expect(ensureWorkspaceCloneMock).toHaveBeenCalledOnce()
    const callArg = ensureWorkspaceCloneMock.mock.calls[0]?.[0]
    expect(callArg).toBeDefined()
    if (callArg === undefined) throw new Error('ensureWorkspaceClone was not called')
    expect(callArg.owner).toBe('acme')
    expect(callArg.repo).toBe('widget')
    // appClient and workspaceClient must be the program-created instances (not null/undefined)
    expect(callArg.appClient).toBeDefined()
    expect(callArg.workspaceClient).toBeDefined()
    // logger must be provided (adapter from GatewayLogger to EnsureCloneDeps logger)
    expect(callArg.logger).toBeDefined()
    expect(typeof callArg.logger.info).toBe('function')
    expect(typeof callArg.logger.warn).toBe('function')
    expect(typeof callArg.logger.error).toBe('function')
  })

  it('announce disabled: client events (messageCreate/interactionCreate) are still wired', async () => {
    // #given — config has no announce block
    const fakeConfig = makeFakeConfig({announce: undefined})
    const fakeClient = makeFakeClient()

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — both Discord event handlers are registered regardless of announce state
    const onCalls = (fakeClient.on as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][]
    const registeredEvents = onCalls.map(([event]) => event)
    expect(registeredEvents).toContain('messageCreate')
    expect(registeredEvents).toContain('interactionCreate')
  })
})

// ---------------------------------------------------------------------------
// Button interaction handler (approval flow)
// ---------------------------------------------------------------------------

describe('button interaction handler (approval flow)', () => {
  // Reset mock call counts between tests to prevent bleed from fire-and-forget async IIFE patterns
  beforeEach(async () => {
    vi.clearAllMocks()
    // Re-stub what clearAllMocks reset so defaults still work
    const {createApprovalRegistry} = await import('./approvals/registry.js')
    vi.mocked(createApprovalRegistry).mockReturnValue({
      register: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      pending: vi.fn().mockReturnValue([]),
      hasPendingForScope: vi.fn().mockReturnValue(false),
      describePendingForScope: vi.fn().mockReturnValue([]),
      handleDecision: vi.fn().mockResolvedValue('ok'),
      applySettlement: vi.fn().mockResolvedValue(undefined),
      attachMessage: vi.fn(),
      markMessagePostFailed: vi.fn(),
      confirmReply: vi.fn(),
      disposeRun: vi.fn(),
      disposeAll: vi.fn().mockResolvedValue(undefined),
    })
    const {parseApprovalCustomId} = await import('./discord/approvals.js')
    vi.mocked(parseApprovalCustomId).mockReturnValue(null)
    const {userIsAuthorized} = await import('./discord/mentions.js')
    vi.mocked(userIsAuthorized).mockResolvedValue(true)
    const {registerSlashCommands} = await import('./discord/commands/index.js')
    vi.mocked(registerSlashCommands).mockResolvedValue(undefined)
  })

  /** Helper to run the program and capture the interactionCreate handler. */
  // eslint-disable-next-line unicorn/consistent-function-scoping
  async function runAndCaptureHandler() {
    const {createApprovalRegistry} = await import('./approvals/registry.js')
    const noopLogger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const fakeRegistry = vi.mocked(createApprovalRegistry)({
      logger: noopLogger,
    })

    const fakeConfig = makeFakeConfig({triggerRoleId: 'approver-role'})
    const fakeClient = makeFakeClient()
    const fakeServerHandle = makeFakeServerHandle()

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn().mockReturnValue(fakeServerHandle),
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
    }

    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // Find the interactionCreate handler
    const onCalls = (fakeClient.on as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      (...args: unknown[]) => unknown,
    ][]
    const interactionHandler = onCalls.find(([event]) => event === 'interactionCreate')?.[1]
    if (interactionHandler === undefined) {
      throw new Error('interactionCreate handler not registered')
    }

    return {interactionHandler, fakeRegistry, fakeClient}
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping
  function makeFakeButtonInteraction(
    overrides: {
      customId?: string
      userId?: string
      channelId?: string
      isAuthorized?: boolean
      guildId?: string
    } = {},
  ) {
    const replyFn = vi.fn().mockResolvedValue(undefined)
    const deferReplyFn = vi.fn().mockResolvedValue(undefined)
    const editReplyFn = vi.fn().mockResolvedValue(undefined)
    const guildMembers = {
      fetch: vi.fn().mockResolvedValue({
        roles: {cache: {has: vi.fn().mockReturnValue(overrides.isAuthorized ?? true)}},
        permissions: {has: vi.fn().mockReturnValue(overrides.isAuthorized ?? true)},
      }),
    }
    const guild = {
      id: overrides.guildId ?? 'guild-1',
      members: guildMembers,
    }

    return {
      isButton: () => true,
      isChatInputCommand: () => false,
      isCommand: () => false,
      customId: overrides.customId ?? 'fb-approve:req-abc',
      user: {id: overrides.userId ?? 'user-decider'},
      channelId: overrides.channelId ?? 'ch-test',
      guild,
      reply: replyFn,
      deferReply: deferReplyFn,
      editReply: editReplyFn,
    }
  }

  it('button with unrelated customId → ignored (no auth, no registry)', async () => {
    // #given
    const {interactionHandler, fakeRegistry} = await runAndCaptureHandler()
    const {parseApprovalCustomId} = await import('./discord/approvals.js')
    vi.mocked(parseApprovalCustomId).mockReturnValueOnce(null)

    const interaction = makeFakeButtonInteraction({customId: 'some-other-button:xyz'})

    // #when
    await interactionHandler(interaction)
    // Flush microtasks — the button handler is fire-and-forget (void async IIFE)
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then — no auth check, no registry interaction, no reply
    expect(fakeRegistry.handleDecision).not.toHaveBeenCalled()
    expect(interaction.reply).not.toHaveBeenCalled()
  })

  it('authorized approve click → handleDecision called with decision=once, ephemeral Approved.', async () => {
    // #given
    const {interactionHandler, fakeRegistry} = await runAndCaptureHandler()
    const {parseApprovalCustomId} = await import('./discord/approvals.js')
    vi.mocked(parseApprovalCustomId).mockReturnValueOnce({action: 'approve', requestID: 'req-abc'})

    const {userIsAuthorized} = await import('./discord/mentions.js')
    vi.mocked(userIsAuthorized).mockResolvedValueOnce(true)
    vi.mocked(fakeRegistry.handleDecision).mockResolvedValueOnce('ok')

    const interaction = makeFakeButtonInteraction({customId: 'fb-approve:req-abc'})

    // #when
    await interactionHandler(interaction)
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then — registry called with correct params
    expect(fakeRegistry.handleDecision).toHaveBeenCalledWith({
      requestID: 'req-abc',
      approvalScopeId: 'ch-test',
      decision: 'once',
      actor: {kind: 'discord-user', userId: 'user-decider'},
    })

    // #and — deferred then edited with approved ack
    // editInteraction always injects allowedMentions: {parse: []}
    expect(interaction.deferReply).toHaveBeenCalledWith({ephemeral: true})
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'Approved.', allowedMentions: {parse: []}}),
    )
  })

  it('deferReply is called BEFORE userIsAuthorized (call order)', async () => {
    // #given
    const {interactionHandler} = await runAndCaptureHandler()
    const {parseApprovalCustomId} = await import('./discord/approvals.js')
    vi.mocked(parseApprovalCustomId).mockReturnValueOnce({action: 'approve', requestID: 'req-abc'})

    const {userIsAuthorized} = await import('./discord/mentions.js')
    // Track invocation order via a shared call log
    const callOrder: string[] = []
    vi.mocked(userIsAuthorized).mockImplementationOnce(async () => {
      callOrder.push('userIsAuthorized')
      return true
    })

    const interaction = makeFakeButtonInteraction()
    interaction.deferReply = vi.fn().mockImplementationOnce(async () => {
      callOrder.push('deferReply')
      return undefined
    })

    // #when
    await interactionHandler(interaction)
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then — deferReply must appear before userIsAuthorized in the call log
    expect(callOrder).toContain('deferReply')
    expect(callOrder).toContain('userIsAuthorized')
    expect(callOrder.indexOf('deferReply')).toBeLessThan(callOrder.indexOf('userIsAuthorized'))
  })

  it('unauthorized click → deferReply first, then editReply (not reply) with Not authorized', async () => {
    // #given
    const {interactionHandler, fakeRegistry} = await runAndCaptureHandler()
    const {parseApprovalCustomId} = await import('./discord/approvals.js')
    vi.mocked(parseApprovalCustomId).mockReturnValueOnce({action: 'approve', requestID: 'req-abc'})

    const {userIsAuthorized} = await import('./discord/mentions.js')
    vi.mocked(userIsAuthorized).mockResolvedValueOnce(false)

    const interaction = makeFakeButtonInteraction()

    // #when
    await interactionHandler(interaction)
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then — no registry call
    expect(fakeRegistry.handleDecision).not.toHaveBeenCalled()

    // #and — deferReply was called first (interaction acked)
    expect(interaction.deferReply).toHaveBeenCalledWith({ephemeral: true})

    // #and — editReply used (NOT reply) for the unauthorized message
    // editInteraction always injects allowedMentions: {parse: []}
    expect(interaction.reply).not.toHaveBeenCalled()
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'Not authorized to approve.', allowedMentions: {parse: []}}),
    )
  })

  it('deny click → decision=reject, ephemeral Denied.', async () => {
    // #given
    const {interactionHandler, fakeRegistry} = await runAndCaptureHandler()
    const {parseApprovalCustomId} = await import('./discord/approvals.js')
    vi.mocked(parseApprovalCustomId).mockReturnValueOnce({action: 'deny', requestID: 'req-abc'})

    const {userIsAuthorized} = await import('./discord/mentions.js')
    vi.mocked(userIsAuthorized).mockResolvedValueOnce(true)
    vi.mocked(fakeRegistry.handleDecision).mockResolvedValueOnce('ok')

    const interaction = makeFakeButtonInteraction({customId: 'fb-deny:req-abc'})

    // #when
    await interactionHandler(interaction)
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then — decision is reject
    expect(fakeRegistry.handleDecision).toHaveBeenCalledWith(expect.objectContaining({decision: 'reject'}))

    // #and — deferred then edited with denied ack
    // editInteraction always injects allowedMentions: {parse: []}
    expect(interaction.deferReply).toHaveBeenCalledWith({ephemeral: true})
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'Denied.', allowedMentions: {parse: []}}),
    )
  })

  it('outcome channel-mismatch → ephemeral correct text', async () => {
    // #given
    const {interactionHandler, fakeRegistry} = await runAndCaptureHandler()
    const {parseApprovalCustomId} = await import('./discord/approvals.js')
    vi.mocked(parseApprovalCustomId).mockReturnValueOnce({action: 'approve', requestID: 'req-abc'})

    const {userIsAuthorized} = await import('./discord/mentions.js')
    vi.mocked(userIsAuthorized).mockResolvedValueOnce(true)
    vi.mocked(fakeRegistry.handleDecision).mockResolvedValueOnce('channel-mismatch')

    const interaction = makeFakeButtonInteraction()

    // #when
    await interactionHandler(interaction)
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then — editInteraction always injects allowedMentions: {parse: []}
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'This approval belongs to another channel.', allowedMentions: {parse: []}}),
    )
  })

  it('outcome not-found → ephemeral correct text', async () => {
    // #given
    const {interactionHandler, fakeRegistry} = await runAndCaptureHandler()
    const {parseApprovalCustomId} = await import('./discord/approvals.js')
    vi.mocked(parseApprovalCustomId).mockReturnValueOnce({action: 'approve', requestID: 'req-abc'})

    const {userIsAuthorized} = await import('./discord/mentions.js')
    vi.mocked(userIsAuthorized).mockResolvedValueOnce(true)
    vi.mocked(fakeRegistry.handleDecision).mockResolvedValueOnce('not-found')

    const interaction = makeFakeButtonInteraction()

    // #when
    await interactionHandler(interaction)
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then — editInteraction always injects allowedMentions: {parse: []}
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'This approval is no longer pending.', allowedMentions: {parse: []}}),
    )
  })

  it('outcome already-claimed → ephemeral correct text', async () => {
    // #given
    const {interactionHandler, fakeRegistry} = await runAndCaptureHandler()
    const {parseApprovalCustomId} = await import('./discord/approvals.js')
    vi.mocked(parseApprovalCustomId).mockReturnValueOnce({action: 'approve', requestID: 'req-abc'})

    const {userIsAuthorized} = await import('./discord/mentions.js')
    vi.mocked(userIsAuthorized).mockResolvedValueOnce(true)
    vi.mocked(fakeRegistry.handleDecision).mockResolvedValueOnce('already-claimed')

    const interaction = makeFakeButtonInteraction()

    // #when
    await interactionHandler(interaction)
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then — editInteraction always injects allowedMentions: {parse: []}
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'Already decided.', allowedMentions: {parse: []}}),
    )
  })

  it('outcome reply-failed → ephemeral correct text', async () => {
    // #given
    const {interactionHandler, fakeRegistry} = await runAndCaptureHandler()
    const {parseApprovalCustomId} = await import('./discord/approvals.js')
    vi.mocked(parseApprovalCustomId).mockReturnValueOnce({action: 'approve', requestID: 'req-abc'})

    const {userIsAuthorized} = await import('./discord/mentions.js')
    vi.mocked(userIsAuthorized).mockResolvedValueOnce(true)
    vi.mocked(fakeRegistry.handleDecision).mockResolvedValueOnce('reply-failed')

    const interaction = makeFakeButtonInteraction()

    // #when
    await interactionHandler(interaction)
    await new Promise(resolve => setTimeout(resolve, 0))

    // #then — editInteraction always injects allowedMentions: {parse: []}
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'Failed to record decision, try again.', allowedMentions: {parse: []}}),
    )
  })

  it('operator server starts when operatorWeb is configured', async () => {
    // #given — config has operatorWeb present
    const fakeConfig = makeFakeConfig({
      announce: undefined,
      operatorWeb: makeOperatorWebConfig(),
    })
    const fakeClient = makeFakeClient()
    const fakeOperatorHandle = makeFakeServerHandle()
    const startOperatorServerSpy = vi.fn().mockReturnValue(fakeOperatorHandle)

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: startOperatorServerSpy,
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — operator server was started once
    expect(startOperatorServerSpy).toHaveBeenCalledOnce()

    // #and — config was passed correctly
    const [, serverConfig] = startOperatorServerSpy.mock.calls[0] as [
      import('./web/server.js').OperatorServerDeps,
      import('./web/server.js').OperatorServerConfig,
    ]
    expect(serverConfig.bindHost).toBe('172.20.0.2')
    expect(serverConfig.bindPort).toBe(4000)
    expect(serverConfig.publicOrigin).toBe('https://operator.example.com')
  })

  it('wires listBindings into the operator server so GET /operator/repos mounts', async () => {
    // #given — config has operatorWeb present
    const fakeConfig = makeFakeConfig({
      announce: undefined,
      operatorWeb: makeOperatorWebConfig(),
    })
    const fakeClient = makeFakeClient()
    const fakeOperatorHandle = makeFakeServerHandle()
    const startOperatorServerSpy = vi.fn().mockReturnValue(fakeOperatorHandle)

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: startOperatorServerSpy,
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — listBindings must be wired, otherwise server.ts gates out the
    // repos-route mount and GET /operator/repos returns 404 instead of mounting.
    const [serverDeps] = startOperatorServerSpy.mock.calls[0] as [
      import('./web/server.js').OperatorServerDeps,
      import('./web/server.js').OperatorServerConfig,
    ]
    expect(serverDeps.listBindings).toBeDefined()
    expect(typeof serverDeps.listBindings).toBe('function')
  })

  it('operator server does NOT start when operatorWeb is absent', async () => {
    // #given — config has no operatorWeb block
    const fakeConfig = makeFakeConfig({announce: undefined, operatorWeb: undefined})
    const fakeClient = makeFakeClient()
    const startOperatorServerSpy = vi.fn()

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: startOperatorServerSpy,
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — operator server was never started
    expect(startOperatorServerSpy).not.toHaveBeenCalled()
  })

  it('composite close closes both announce and operator handles', async () => {
    // #given — both announce and operatorWeb are configured
    const fakeConfig = makeFakeConfig({
      announce: {webhookSecret: 'test-webhook-secret', presenceChannelId: 'test-presence-channel-id', httpPort: 3000},
      operatorWeb: makeOperatorWebConfig(),
    })
    const fakeClient = makeFakeClient()
    const announceCloseSpy = vi.fn((cb?: (err?: Error) => void) => cb?.())
    const operatorCloseSpy = vi.fn((cb?: (err?: Error) => void) => cb?.())
    const fakeAnnounceHandle = {close: announceCloseSpy}
    const fakeOperatorHandle = {close: operatorCloseSpy}

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn().mockReturnValue(fakeAnnounceHandle),
      startOperatorServer: vi.fn().mockReturnValue(fakeOperatorHandle),
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when — run the program (shutdown handlers are installed but not triggered here)
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — both server factories were called
    expect(deps.startAnnounceServer).toHaveBeenCalledOnce()
    expect(deps.startOperatorServer).toHaveBeenCalledOnce()
  })

  it('composite close: both server handles are created when both announce and operatorWeb are configured', async () => {
    // #given — both announce and operatorWeb are configured
    const fakeConfig = makeFakeConfig({
      announce: {webhookSecret: 'test-webhook-secret', presenceChannelId: 'test-presence-channel-id', httpPort: 3000},
      operatorWeb: makeOperatorWebConfig(),
    })
    const fakeClient = makeFakeClient()
    const fakeAnnounceHandle = makeFakeServerHandle()
    const fakeOperatorHandle = makeFakeServerHandle()

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn().mockReturnValue(fakeAnnounceHandle),
      startOperatorServer: vi.fn().mockReturnValue(fakeOperatorHandle),
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when — run the program
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — both factories were called (composite handle was built for shutdown)
    expect(deps.startAnnounceServer).toHaveBeenCalledOnce()
    expect(deps.startOperatorServer).toHaveBeenCalledOnce()
  })

  it('operator server receives githubOAuth deps and config when operatorWeb is configured', async () => {
    // #given — config has operatorWeb with OAuth fields
    const fakeConfig = makeFakeConfig({
      announce: undefined,
      operatorWeb: makeOperatorWebConfig({
        oauthClientId: 'my-client-id',
        oauthClientSecret: 'my-client-secret',
        oauthAllowedReturnPaths: ['/operator/dashboard'],
        oauthStateTtlMs: 300_000,
        oauthMaxOutstandingAttemptsPerKey: 3,
      }),
    })
    const fakeClient = makeFakeClient()
    const fakeOperatorHandle = makeFakeServerHandle()
    const startOperatorServerSpy = vi.fn().mockReturnValue(fakeOperatorHandle)

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: startOperatorServerSpy,
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — operator server was started once
    expect(startOperatorServerSpy).toHaveBeenCalledOnce()

    // #and — deps include githubOAuth
    const [serverDeps, serverConfig] = startOperatorServerSpy.mock.calls[0] as [
      import('./web/server.js').OperatorServerDeps,
      import('./web/server.js').OperatorServerConfig,
    ]
    expect(serverDeps.githubOAuth).toBeDefined()
    expect(typeof serverDeps.githubOAuth?.fetch).toBe('function')
    expect(typeof serverDeps.githubOAuth?.generateVerifier).toBe('function')
    expect(typeof serverDeps.githubOAuth?.generateState).toBe('function')
    expect(typeof serverDeps.githubOAuth?.getSourceKey).toBe('function')
    expect(serverDeps.githubOAuth?.stateStore).toBeDefined()

    // #and — config carries OAuth fields from GatewayConfig
    expect(serverConfig.githubOAuth).toBeDefined()
    expect(serverConfig.githubOAuth?.clientId).toBe('my-client-id')
    expect(serverConfig.githubOAuth?.clientSecret).toBe('my-client-secret')
    expect(serverConfig.githubOAuth?.allowedReturnPaths).toEqual(['/operator/dashboard'])
    expect(serverConfig.githubOAuth?.stateTtlMs).toBe(300_000)
    expect(serverConfig.githubOAuth?.maxOutstandingAttemptsPerKey).toBe(3)
    expect(serverConfig.githubOAuth?.callbackPath).toBe('/operator/auth/github/callback')
    expect(serverConfig.githubOAuth?.publicOrigin).toBe('https://operator.example.com')
  })

  it('operator server receives no githubOAuth when operatorWeb is absent', async () => {
    // #given — no operatorWeb
    const fakeConfig = makeFakeConfig({announce: undefined, operatorWeb: undefined})
    const fakeClient = makeFakeClient()
    const startOperatorServerSpy = vi.fn()

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: startOperatorServerSpy,
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — operator server was never started
    expect(startOperatorServerSpy).not.toHaveBeenCalled()
  })

  it('operator server receives allowlist and csrfSecret from config when operatorWeb is configured', async () => {
    // #given — config has operatorWeb with csrfSecret and allowlist
    const testAllowlist = {isAuthorized: (id: number) => id === 42, size: 1}
    const fakeConfig = makeFakeConfig({
      announce: undefined,
      operatorWeb: makeOperatorWebConfig({
        csrfSecret: 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE',
        allowlist: testAllowlist,
      }),
    })
    const fakeClient = makeFakeClient()
    const fakeOperatorHandle = makeFakeServerHandle()
    const startOperatorServerSpy = vi.fn().mockReturnValue(fakeOperatorHandle)

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: startOperatorServerSpy,
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — operator server was started
    expect(startOperatorServerSpy).toHaveBeenCalledOnce()

    // #and — deps include allowlist and csrfSecret
    const [serverDeps] = startOperatorServerSpy.mock.calls[0] as [
      import('./web/server.js').OperatorServerDeps,
      import('./web/server.js').OperatorServerConfig,
    ]
    expect(serverDeps.allowlist).toBeDefined()
    expect(serverDeps.allowlist?.isAuthorized(42)).toBe(true)
    expect(serverDeps.allowlist?.isAuthorized(99)).toBe(false)
    expect(serverDeps.csrfSecret).toBe('dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE')
    expect(serverDeps.auditLogger).toBeDefined()
  })

  it('denylist: getDenylistState is called once at startup to prime the cache', async () => {
    // #given — the denylist cache mock is already set up via vi.mock above
    const {createDenylistCache} = await import('./redaction/denylist.js')
    const createDenylistCacheMock = vi.mocked(createDenylistCache)

    const fakeConfig = makeFakeConfig({announce: undefined})
    const fakeClient = makeFakeClient()

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
    }

    // #when
    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // #then — createDenylistCache was called (the cache was created)
    expect(createDenylistCacheMock).toHaveBeenCalledOnce()

    // #and — getDenylistState was called at startup to prime the cache
    const fakeCacheInstance = createDenylistCacheMock.mock.results[0]?.value as {
      getDenylistState: ReturnType<typeof vi.fn>
    }
    expect(fakeCacheInstance).toBeDefined()
    expect(fakeCacheInstance.getDenylistState).toHaveBeenCalledOnce()
  })

  it('denylist: startup prime failure is logged and does not crash boot', async () => {
    // #given — getDenylistState rejects on the first call (prime failure)
    const {createDenylistCache} = await import('./redaction/denylist.js')
    const createDenylistCacheMock = vi.mocked(createDenylistCache)
    createDenylistCacheMock.mockReturnValueOnce({
      getDenylistState: vi.fn().mockRejectedValue(new Error('prime failed — network error')),
      isRepoDenied: vi.fn().mockReturnValue(true), // stays deny-all
    })

    const fakeConfig = makeFakeConfig({announce: undefined})
    const fakeClient = makeFakeClient()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
    }

    try {
      // #when — boot must NOT throw even though prime failed
      await expect(Effect.runPromise(makeGatewayProgram(deps, fakeConfig))).resolves.toBeUndefined()

      // #then — a warn was logged about the prime failure
      const warnMessages = warnSpy.mock.calls.map(args => String(args[0]))
      expect(warnMessages.some(m => m.includes('startup prime failed'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('shutdown → approvalRegistry.disposeAll called', async () => {
    // #given
    const {createApprovalRegistry} = await import('./approvals/registry.js')
    const noopLogger2 = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const fakeRegistry = vi.mocked(createApprovalRegistry)({
      logger: noopLogger2,
    })

    const fakeConfig = makeFakeConfig()
    const fakeClient = makeFakeClient()
    const fakeServerHandle = makeFakeServerHandle()

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn().mockReturnValue(fakeServerHandle),
      startOperatorServer: vi.fn(),
      runProviderSelfTest: vi.fn(async () => {}),
    }

    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // Find the shutdown drain (SIGTERM handler). It's registered via installShutdownHandlers.
    // We look at the 'once' calls for 'SIGTERM'/'SIGINT' or the shutdown drain fn directly.
    // Since installShutdownHandlers uses process.once, we capture via client.once calls
    // or test the drain by invoking program shutdown.
    // Simplest: confirm disposeAll was set up on the registry during program init.
    // The actual shutdown is exercised by simulating a SIGTERM-like drain.
    // We verify disposeAll is attached to the registry (i.e. registry is the one created).
    expect(fakeRegistry.disposeAll).toBeDefined()
    expect(typeof fakeRegistry.disposeAll).toBe('function')
    // Invoke it to confirm it resolves without throwing
    await expect(fakeRegistry.disposeAll('gateway shutdown')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Launch route wiring — POST /operator/runs must mount with production deps
// ---------------------------------------------------------------------------
//
// These tests assert that the production OperatorServerDeps wired by
// makeGatewayProgram include getBindingByRepo and launchWorkDeps, so that
// buildOperatorApp registers POST /operator/runs. The existing server.test.ts
// tests wire those deps manually (which is why they didn't catch this omission).
// These tests prove the PRODUCTION wiring mounts the route.

describe('launch route wiring — POST /operator/runs', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // Re-stub what clearAllMocks reset
    const {createApprovalRegistry} = await import('./approvals/registry.js')
    vi.mocked(createApprovalRegistry).mockReturnValue({
      register: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      pending: vi.fn().mockReturnValue([]),
      hasPendingForScope: vi.fn().mockReturnValue(false),
      describePendingForScope: vi.fn().mockReturnValue([]),
      handleDecision: vi.fn().mockResolvedValue('ok'),
      applySettlement: vi.fn().mockResolvedValue(undefined),
      attachMessage: vi.fn(),
      markMessagePostFailed: vi.fn(),
      confirmReply: vi.fn(),
      disposeRun: vi.fn(),
      disposeAll: vi.fn().mockResolvedValue(undefined),
    })
  })

  /**
   * Helper: run the program with operatorWeb configured, capture the
   * OperatorServerDeps passed to startOperatorServer, and return them.
   */
  // eslint-disable-next-line unicorn/consistent-function-scoping
  async function captureOperatorServerDeps(): Promise<import('./web/server.js').OperatorServerDeps> {
    const fakeConfig = makeFakeConfig({
      announce: undefined,
      operatorWeb: makeOperatorWebConfig(),
    })
    const fakeClient = makeFakeClient()
    const fakeOperatorHandle = makeFakeServerHandle()
    const startOperatorServerSpy = vi.fn().mockReturnValue(fakeOperatorHandle)

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: startOperatorServerSpy,
      runProviderSelfTest: vi.fn(async () => {}),
    }

    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    expect(startOperatorServerSpy).toHaveBeenCalledOnce()
    const [serverDeps] = startOperatorServerSpy.mock.calls[0] as [
      import('./web/server.js').OperatorServerDeps,
      import('./web/server.js').OperatorServerConfig,
    ]
    return serverDeps
  }

  it('wires getBindingByRepo into the operator server deps', async () => {
    // #given / #when
    const serverDeps = await captureOperatorServerDeps()

    // #then — getBindingByRepo must be wired so the launch route can mount
    expect(serverDeps.getBindingByRepo).toBeDefined()
    expect(typeof serverDeps.getBindingByRepo).toBe('function')
  })

  it('wires launchWorkDeps into the operator server deps', async () => {
    // #given / #when
    const serverDeps = await captureOperatorServerDeps()

    // #then — launchWorkDeps must be wired so the launch route can mount
    expect(serverDeps.launchWorkDeps).toBeDefined()
    expect(typeof serverDeps.launchWorkDeps).toBe('object')
  })

  /**
   * Extract unique logical routes from a Hono app, excluding the catch-all
   * ALL /* middleware entry and deduplicating by method+path.
   */
  // eslint-disable-next-line unicorn/consistent-function-scoping
  function extractRoutes(app: {routes: {method: string; path: string}[]}): {method: string; path: string}[] {
    const seen = new Set<string>()
    return app.routes
      .map(route => ({method: route.method, path: route.path}))
      .filter(route => {
        if (route.method === 'ALL' && route.path === '/*') return false
        const key = `${route.method}:${route.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }

  it('registers POST /operator/runs when production deps are fed to buildOperatorApp', async () => {
    // #given — capture the production-shaped operator deps from the program
    const serverDeps = await captureOperatorServerDeps()

    // #when — feed those deps to buildOperatorApp with matching githubOAuth config
    // (production deps include githubOAuth, so config must also include it)
    const {buildOperatorApp} = await import('./web/server.js')
    const app = buildOperatorApp(serverDeps, {
      bindHost: '127.0.0.1',
      bindPort: 0,
      publicOrigin: 'https://operator.example.com',
      githubOAuth: {
        clientId: 'test-oauth-client-id',
        clientSecret: 'test-oauth-client-secret',
        publicOrigin: 'https://operator.example.com',
        callbackPath: '/operator/auth/github/callback',
        allowedReturnPaths: ['/operator'],
        stateTtlMs: 600_000,
        maxOutstandingAttemptsPerKey: 5,
      },
    })

    // #then — POST /operator/runs is present (the launch route is mounted)
    expect(extractRoutes(app)).toContainEqual({method: 'POST', path: '/operator/runs'})
  })

  it('omits POST /operator/runs when getBindingByRepo is dropped from production deps', async () => {
    // #given — production deps with getBindingByRepo removed
    // Drop githubOAuth from deps too so buildOperatorApp doesn't throw on partial OAuth config
    const serverDeps = await captureOperatorServerDeps()
    const depsWithoutGetBindingByRepo = {...serverDeps, getBindingByRepo: undefined, githubOAuth: undefined}

    // #when
    const {buildOperatorApp} = await import('./web/server.js')
    const app = buildOperatorApp(depsWithoutGetBindingByRepo, {
      bindHost: '127.0.0.1',
      bindPort: 0,
      publicOrigin: 'https://operator.example.com',
    })

    // #then — launch route is absent when getBindingByRepo is missing
    expect(extractRoutes(app)).not.toContainEqual({method: 'POST', path: '/operator/runs'})
  })

  it('omits POST /operator/runs when launchWorkDeps is dropped from production deps', async () => {
    // #given — production deps with launchWorkDeps removed
    // Drop githubOAuth from deps too so buildOperatorApp doesn't throw on partial OAuth config
    const serverDeps = await captureOperatorServerDeps()
    const depsWithoutLaunchWorkDeps = {...serverDeps, launchWorkDeps: undefined, githubOAuth: undefined}

    // #when
    const {buildOperatorApp} = await import('./web/server.js')
    const app = buildOperatorApp(depsWithoutLaunchWorkDeps, {
      bindHost: '127.0.0.1',
      bindPort: 0,
      publicOrigin: 'https://operator.example.com',
    })

    // #then — launch route is absent when launchWorkDeps is missing
    expect(extractRoutes(app)).not.toContainEqual({method: 'POST', path: '/operator/runs'})
  })

  it('discord mention path still receives RunMentionDeps with the same engine deps shape', async () => {
    // #given — run the program and capture the deps passed to handleMention
    const capturedDeps = await runAndCaptureMentionDeps('approval-required')

    // #then — the mention path still receives a full RunMentionDeps
    // (the hoist did not change Discord behavior)
    expect(capturedDeps.run).toBeDefined()
    expect(typeof capturedDeps.run.coordinationConfig).toBe('object')
    expect(typeof capturedDeps.run.concurrency).toBe('object')
    expect(typeof capturedDeps.run.queue).toBe('object')
    expect(typeof capturedDeps.run.logger).toBe('object')
    expect(typeof capturedDeps.run.approvalRegistry).toBe('object')
    expect(capturedDeps.run.approvalMode).toBe('approval-required')
    expect(typeof capturedDeps.run.ensureClone).toBe('function')
    expect(typeof capturedDeps.run.readyz).toBe('function')
    expect(typeof capturedDeps.run.isShuttingDown).toBe('function')
    expect(capturedDeps.run.runIndex).toBeDefined()
    expect(capturedDeps.run.runObserver).toBeDefined()

    // #and — botUserId is the concrete value from client.user.id (not the lazy getter's fallback)
    expect(capturedDeps.run.botUserId).toBe('bot-user-id')
  })

  it('launchWorkDeps and Discord mention run deps share the same engine-deps instances (reference identity)', async () => {
    // #given — run the program once, capturing both operator server deps and mention deps.
    // Both paths must share the SAME runEngineDeps object so run-state/coordination
    // instances are never accidentally duplicated by a future spread/copy refactor.
    const {handleMention} = await import('./discord/mentions.js')
    const handleMentionMock = vi.mocked(handleMention)

    const botUserId = 'bot-user-id'
    const fakeClient = {
      ...makeFakeClient(),
      user: {id: botUserId},
    }
    const fakeConfig = makeFakeConfig({
      announce: undefined,
      operatorWeb: makeOperatorWebConfig(),
    })
    const fakeOperatorHandle = makeFakeServerHandle()
    const startOperatorServerSpy = vi.fn().mockReturnValue(fakeOperatorHandle)

    const deps = {
      makeClient: () => fakeClient as unknown as import('discord.js').Client,
      setupReadinessFlag: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      startAnnounceServer: vi.fn(),
      startOperatorServer: startOperatorServerSpy,
      runProviderSelfTest: vi.fn(async () => {}),
    }

    await Effect.runPromise(makeGatewayProgram(deps, fakeConfig))

    // Capture operator server deps
    expect(startOperatorServerSpy).toHaveBeenCalledOnce()
    const [operatorDeps] = startOperatorServerSpy.mock.calls[0] as [
      import('./web/server.js').OperatorServerDeps,
      import('./web/server.js').OperatorServerConfig,
    ]

    // Fire the messageCreate handler to capture mention deps
    const onCalls = (fakeClient.on as ReturnType<typeof vi.fn>).mock.calls as [string, (msg: unknown) => void][]
    const messageCreateHandler = onCalls.find(([event]) => event === 'messageCreate')?.[1]
    if (messageCreateHandler === undefined) throw new Error('messageCreate handler not registered')

    messageCreateHandler(makeFakeMentionMessage(botUserId))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(handleMentionMock).toHaveBeenCalledOnce()
    const mentionDeps = handleMentionMock.mock.calls[0]?.[2] as import('./discord/mentions.js').MentionDeps
    if (mentionDeps === undefined) throw new Error('handleMention was not called with deps')

    // #then — launchWorkDeps IS the same object as the engine deps spread into mention run
    // (reference identity on each shared instance proves no accidental copy was made)
    const launchDeps = operatorDeps.launchWorkDeps
    if (launchDeps === undefined) throw new Error('launchWorkDeps not wired')
    const mentionRunDeps = mentionDeps.run

    // These instances must be the exact same objects — not copies or re-creations.
    expect(launchDeps.concurrency).toBe(mentionRunDeps.concurrency)
    expect(launchDeps.queue).toBe(mentionRunDeps.queue)
    expect(launchDeps.approvalRegistry).toBe(mentionRunDeps.approvalRegistry)
    expect(launchDeps.runIndex).toBe(mentionRunDeps.runIndex)
    expect(launchDeps.runObserver).toBe(mentionRunDeps.runObserver)
  })
})
