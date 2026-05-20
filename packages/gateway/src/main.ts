import type {ChatInputCommandInteraction, Client, GatewayIntentBits, Message} from 'discord.js'
import type {GatewayConfig} from './config.js'
import type {GatewayLogger} from './discord/client.js'

import process from 'node:process'

import {Effect} from 'effect'

import {loadGatewayConfig} from './config.js'
import {createDiscordClient} from './discord/client.js'
import {dispatchCommand, getCommandRegistry, registerSlashCommands} from './discord/commands/index.js'
import {handleMention} from './discord/mentions.js'
import {setupReadinessFlag} from './readiness.js'
import {installShutdownHandlers} from './shutdown.js'

// ---------------------------------------------------------------------------
// Minimal structured logger — pino can replace this in a later unit.
// warn and error use the lint-permitted console channels directly.
// debug and info use console.log with scoped eslint-disable because they are
// informational, not warnings — routing them through console.warn would
// poison log-aggregator severity classification.
// ---------------------------------------------------------------------------

function makeLogger(level: 'debug' | 'info' | 'warn' | 'error'): GatewayLogger {
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

    // d. Build command registry
    const registry = getCommandRegistry()

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
      const cmd = interaction as unknown as ChatInputCommandInteraction
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

    // g. Install shutdown handlers
    installShutdownHandlers(client, logger)

    // h. Login
    yield* Effect.tryPromise({
      try: async () => deps.login(client, config.discordToken),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })

    // i. Log startup
    logger.info({applicationId: config.discordApplicationId}, 'gateway started')
  })
}

// ---------------------------------------------------------------------------
// Main Effect program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // a. Load config
  const config = yield* Effect.try({
    try: () => loadGatewayConfig(),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })

  yield* makeGatewayProgram(
    {
      makeClient: makeDiscordClientFromConfig,
      setupReadinessFlag,
      login: async (client, token) => {
        await client.login(token)
      },
    },
    config,
  )
})

// ---------------------------------------------------------------------------
// Top-level runner — logger may not exist yet if config load fails, so we
// fall back to console.error for the startup-failure path.
// ---------------------------------------------------------------------------

Effect.runPromise(program).catch((error: unknown) => {
  console.error(JSON.stringify({level: 'error', err: String(error), msg: 'gateway startup failed'}))
  process.exit(1)
})
