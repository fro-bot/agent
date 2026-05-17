import type {ChatInputCommandInteraction, Message} from 'discord.js'
import type {GatewayLogger} from './discord/client.js'

import process from 'node:process'

import {Effect} from 'effect'

import {loadGatewayConfig} from './config.js'
import {createDiscordClient} from './discord/client.js'
import {dispatchCommand, getCommandRegistry, registerSlashCommands} from './discord/commands/index.js'
import {handleMention} from './discord/mentions.js'
import {installShutdownHandlers} from './shutdown.js'

// ---------------------------------------------------------------------------
// Minimal structured logger — pino can replace this in a later unit.
// Only console.warn and console.error are permitted by the lint rules, so we
// route all levels through those two channels.
// ---------------------------------------------------------------------------

function makeLogger(level: 'debug' | 'info' | 'warn' | 'error'): GatewayLogger {
  const levels = {debug: 0, info: 1, warn: 2, error: 3} as const
  const minLevel = levels[level]

  return {
    debug: (ctx, msg) => {
      if (minLevel <= levels.debug) console.warn(JSON.stringify({level: 'debug', ...ctx, msg}))
    },
    info: (ctx, msg) => {
      if (minLevel <= levels.info) console.warn(JSON.stringify({level: 'info', ...ctx, msg}))
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
// Main Effect program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // a. Load config
  const config = yield* Effect.try({
    try: () => loadGatewayConfig(),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })

  // b. Create logger
  const logger = makeLogger(config.logLevel)

  // c. Create Discord client
  const client = createDiscordClient(config.discordToken, {logger})

  // d. Build command registry
  const registry = getCommandRegistry()

  // e. Register slash commands
  yield* Effect.tryPromise({
    try: async () => registerSlashCommands(client, config.discordApplicationId, config.discordGuildId, registry),
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
    try: async () => client.login(config.discordToken),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })

  // i. Log startup
  logger.info({applicationId: config.discordApplicationId}, 'gateway started')
})

// ---------------------------------------------------------------------------
// Top-level runner — logger may not exist yet if config load fails, so we
// fall back to console.error for the startup-failure path.
// ---------------------------------------------------------------------------

Effect.runPromise(program).catch((error: unknown) => {
  console.error(JSON.stringify({level: 'error', err: String(error), msg: 'gateway startup failed'}))
  process.exit(1)
})
