import type {Client, GatewayIntentBits, Message} from 'discord.js'
import type {GatewayConfig} from './config.js'
import type {GatewayLogger} from './discord/client.js'
import type {AnnounceServerConfig, AnnounceServerDeps} from './http/server.js'
import type {CloseableServer} from './shutdown.js'

import {createS3Adapter} from '@fro-bot/runtime'
import {Effect} from 'effect'

import {createBindingsStore} from './bindings/store.js'
import {createDiscordClient} from './discord/client.js'
import {dispatchCommand, getCommandRegistry, registerSlashCommands} from './discord/commands/index.js'
import {handleMention} from './discord/mentions.js'
import {createAppClient} from './github/app-client.js'
import {installShutdownHandlers, isShuttingDown} from './shutdown.js'
import {createWorkspaceClient} from './workspace-api/client.js'

// ---------------------------------------------------------------------------
// Minimal structured logger — pino can replace this in a later unit.
// warn and error use the lint-permitted console channels directly.
// debug and info use console.log with scoped eslint-disable because they are
// informational, not warnings — routing them through console.warn would
// poison log-aggregator severity classification.
// ---------------------------------------------------------------------------

export function makeLogger(level: 'debug' | 'info' | 'warn' | 'error'): GatewayLogger {
  const levels = {debug: 0, info: 1, warn: 2, error: 3} as const
  const minLevel = levels[level]

  return {
    debug: (ctx, msg) => {
      // eslint-disable-next-line no-console
      if (minLevel <= levels.debug) console.log(JSON.stringify({level: 'debug', ...ctx, msg}))
    },
    info: (ctx, msg) => {
      // eslint-disable-next-line no-console
      if (minLevel <= levels.info) console.log(JSON.stringify({level: 'info', ...ctx, msg}))
    },
    warn: (ctx, msg) => {
      if (minLevel <= levels.warn) console.warn(JSON.stringify({level: 'warn', ...ctx, msg}))
    },
    error: (ctx, msg) => {
      if (minLevel <= levels.error) console.error(JSON.stringify({level: 'error', ...ctx, msg}))
    },
  }
}

// ---------------------------------------------------------------------------
// Composition helper — exported for unit testing only.
// Keeps the wiring between GatewayConfig.privilegedIntents and
// createDiscordClient() explicit and independently verifiable.
// ---------------------------------------------------------------------------

export function makeDiscordClientFromConfig(
  config: {privilegedIntents: readonly GatewayIntentBits[]},
  logger: GatewayLogger,
): ReturnType<typeof createDiscordClient> {
  return createDiscordClient({intents: config.privilegedIntents, logger})
}

// ---------------------------------------------------------------------------
// Injectable deps interface — exported so tests can supply spies.
// ---------------------------------------------------------------------------

export interface GatewayProgramDeps {
  readonly makeClient: (config: GatewayConfig, logger: GatewayLogger) => Client
  readonly setupReadinessFlag: (client: Client, logger: GatewayLogger) => void
  readonly login: (client: Client, token: string) => Promise<void>
  /**
   * Factory for the announce HTTP server.
   * Receives the assembled deps + config so callers can inject fakes in tests.
   * Returns a CloseableServer handle that will be passed to installShutdownHandlers.
   */
  readonly startAnnounceServer: (deps: AnnounceServerDeps, config: AnnounceServerConfig) => CloseableServer
}

// ---------------------------------------------------------------------------
// Extracted program factory — exported for unit testing only.
// Accepts injectable deps so tests can assert call ordering without touching
// the network or requiring a real Discord token.
// ---------------------------------------------------------------------------

export function makeGatewayProgram(deps: GatewayProgramDeps, config: GatewayConfig): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    // b. Create logger
    const logger = makeLogger(config.logLevel)

    // c. Create Discord client
    const client = deps.makeClient(config, logger)

    // c2. Set up readiness flag — clears stale flag, registers clientReady listener.
    //     Must run BEFORE client.login() so the event cannot be missed.
    yield* Effect.sync(() => deps.setupReadinessFlag(client, logger))

    // d. Build command registry with runtime deps
    const addProjectLogger = {
      debug: (msg: string, meta?: Record<string, unknown>) => logger.debug(meta ?? {}, msg),
      info: (msg: string, meta?: Record<string, unknown>) => logger.info(meta ?? {}, msg),
      warn: (msg: string, meta?: Record<string, unknown>) => logger.warn(meta ?? {}, msg),
      error: (msg: string, meta?: Record<string, unknown>) => logger.error(meta ?? {}, msg),
    }

    // Adapt GatewayLogger to the runtime Logger interface (uses 'warning' not 'warn')
    const runtimeLogger = {
      debug: (msg: string, ctx?: Record<string, unknown>) => logger.debug(ctx ?? {}, msg),
      info: (msg: string, ctx?: Record<string, unknown>) => logger.info(ctx ?? {}, msg),
      warning: (msg: string, ctx?: Record<string, unknown>) => logger.warn(ctx ?? {}, msg),
      error: (msg: string, ctx?: Record<string, unknown>) => logger.error(ctx ?? {}, msg),
    }

    const s3Adapter = createS3Adapter(config.objectStore, runtimeLogger)
    const bindingsStore = createBindingsStore({
      adapter: s3Adapter,
      storeConfig: config.objectStore,
      identity: config.identity,
    })
    const appClient = createAppClient({
      appId: config.githubAppId,
      privateKey: config.githubAppPrivateKey,
      installUrl: config.gatewayGitHubAppInstallUrl,
      logger: addProjectLogger,
    })
    const workspaceClient = createWorkspaceClient({baseUrl: config.workspaceAgentUrl})

    const commandDeps = {
      bindingsStore,
      appClient,
      workspaceClient,
      installUrl: config.gatewayGitHubAppInstallUrl,
      logger: addProjectLogger,
      isShuttingDown,
    }

    const registry = getCommandRegistry(commandDeps)

    // e. Register slash commands
    yield* Effect.tryPromise({
      try: async () =>
        registerSlashCommands(config.discordToken, config.discordApplicationId, config.discordGuildId, registry),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })

    // f. Wire client events
    client.on('interactionCreate', interaction => {
      if (!interaction.isChatInputCommand()) return
      // isChatInputCommand() narrows to ChatInputCommandInteraction — cast is safe.
      const cmd = interaction
      Effect.runPromise(dispatchCommand(cmd, registry)).catch((error: unknown) => {
        logger.error({err: error, commandName: cmd.commandName}, 'command dispatch failed')
      })
    })

    client.on('messageCreate', (message: Message) => {
      if (message.author.bot) return
      if (client.user === null) return
      if (!message.mentions.has(client.user.id)) return
      Effect.runPromise(handleMention(message, client.user.id)).catch((error: unknown) => {
        logger.error({err: error}, 'mention handler failed')
      })
    })

    // g. Start announce HTTP server (before shutdown handlers so the handle is available)
    const serverHandle = deps.startAnnounceServer(
      {
        client,
        logger,
        isShuttingDown,
      },
      {
        webhookSecret: config.webhookSecret,
        presenceChannelId: config.presenceChannelId,
        httpPort: config.httpPort,
      },
    )

    // h. Install shutdown handlers — pass server handle so it is closed on drain
    installShutdownHandlers(client, logger, undefined, serverHandle)

    // i. Login
    yield* Effect.tryPromise({
      try: async () => deps.login(client, config.discordToken),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })

    // j. Log startup
    logger.info({applicationId: config.discordApplicationId}, 'gateway started')
  })
}
