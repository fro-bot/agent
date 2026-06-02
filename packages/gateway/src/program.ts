import type {Client, GatewayIntentBits, Message} from 'discord.js'
import type {GatewayConfig} from './config.js'
import type {GatewayLogger} from './discord/client.js'
import type {SinkThread} from './discord/streaming.js'
import type {AnnounceServerConfig, AnnounceServerDeps} from './http/server.js'
import type {CloseableServer} from './shutdown.js'
import {
  createS3Adapter,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCK_TTL_SECONDS,
  DEFAULT_STALE_THRESHOLD_MS,
} from '@fro-bot/runtime'
import {Effect} from 'effect'
import {createApprovalRegistry} from './approvals/registry.js'
import {createBindingsStore} from './bindings/store.js'
import {parseApprovalCustomId} from './discord/approvals.js'
import {createDiscordClient} from './discord/client.js'
import {dispatchCommand, getCommandRegistry, registerSlashCommands} from './discord/commands/index.js'
import {handleMention, userIsAuthorized} from './discord/mentions.js'
import {createConcurrencyRegistry} from './execute/concurrency.js'
import {recoverStaleRuns} from './execute/recovery.js'
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
    const concurrencyRegistry = createConcurrencyRegistry(config.maxConcurrentRuns)
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

    // Program-scoped approval registry — shared between the button handler and shutdown drain.
    const approvalRegistry = createApprovalRegistry({logger})

    // e. Register slash commands
    yield* Effect.tryPromise({
      try: async () =>
        registerSlashCommands(config.discordToken, config.discordApplicationId, config.discordGuildId, registry),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })

    // f. Wire client events
    client.on('interactionCreate', (interaction): void => {
      // ── Button interactions: approval flow ────────────────────────────────
      if (interaction.isButton()) {
        const parsed = parseApprovalCustomId(interaction.customId)
        if (parsed === null) return // not our button — ignore

        // eslint-disable-next-line no-void
        void (async () => {
          try {
            // Auth: reuse the same authorization gate as the mention path.
            const guild = interaction.guild
            if (guild === null) {
              await interaction.reply({content: 'Not authorized to approve.', ephemeral: true})
              return
            }
            const authorized = await userIsAuthorized(guild, interaction.user.id, config.triggerRoleId, logger)
            if (authorized === false) {
              await interaction.reply({content: 'Not authorized to approve.', ephemeral: true})
              return
            }

            // Defer immediately — acknowledgements the interaction within Discord's 3 s
            // window. We'll editReply after the (potentially slow) postReply HTTP call.
            await interaction.deferReply({ephemeral: true})

            const decision = parsed.action === 'approve' ? ('once' as const) : ('reject' as const)
            const outcome = await approvalRegistry.handleButtonDecision({
              requestID: parsed.requestID,
              channelID: interaction.channelId,
              decision,
              decidedBy: interaction.user.id,
            })

            const ackContent =
              outcome === 'ok'
                ? decision === 'once'
                  ? 'Approved.'
                  : 'Denied.'
                : outcome === 'channel-mismatch'
                  ? 'This approval belongs to another channel.'
                  : outcome === 'not-found'
                    ? 'This approval is no longer pending.'
                    : outcome === 'already-claimed'
                      ? 'Already decided.'
                      : 'Failed to record decision, try again.'

            await interaction.editReply({content: ackContent})
          } catch (error: unknown) {
            logger.error({err: String(error)}, 'button: unexpected error handling approval interaction')
            // Best-effort edit — if this also throws Discord considers the interaction failed.
            await interaction.editReply({content: 'Failed to record decision, try again.'}).catch(() => {})
          }
        })()
        return
      }

      if (!interaction.isChatInputCommand()) return
      // isChatInputCommand() narrows to ChatInputCommandInteraction — cast is safe.
      const cmd = interaction
      Effect.runPromise(dispatchCommand(cmd, registry)).catch((error: unknown) => {
        logger.error({err: error, commandName: cmd.commandName}, 'command dispatch failed')
      })
    })

    // Track in-flight mention run promises so SIGTERM can await them before tearing down.
    const inFlightRuns = new Set<Promise<void>>()

    client.on('messageCreate', (message: Message) => {
      if (message.author.bot) return
      if (client.user === null) return
      if (!message.mentions.has(client.user.id)) return
      // Stop accepting new mentions once shutdown has been requested.
      if (isShuttingDown()) return

      const mentionDeps = {
        bindingsStore,
        triggerRoleId: config.triggerRoleId,
        run: {
          coordinationConfig: {
            storeAdapter: s3Adapter,
            storeConfig: config.objectStore,
            lockTtlSeconds: DEFAULT_LOCK_TTL_SECONDS,
            heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
            staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
          },
          identity: config.identity,
          concurrency: concurrencyRegistry,
          attachUrl: config.workspaceOpencodeUrl,
          attachToken: config.workspaceOpencodeToken,
          runTimeoutMs: config.runTimeoutMs,
          botUserId: client.user.id,
          logger,
          approvalRegistry,
        },
        logger,
      }

      const runPromise: Promise<void> = Effect.runPromise(handleMention(message, client.user.id, mentionDeps)).catch(
        (error: unknown) => {
          logger.error({err: error}, 'mention handler failed')
        },
      )
      inFlightRuns.add(runPromise)
      runPromise
        .finally(() => {
          inFlightRuns.delete(runPromise)
        })
        .catch(() => {
          // Errors are already handled in runPromise; finally() cannot throw here.
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

    // h. Install shutdown handlers — drain pending approvals fail-closed then await in-flight runs
    installShutdownHandlers(client, logger, undefined, serverHandle, async () => {
      // Dispose pending approvals before draining runs — ensures pending permissions
      // fail-closed so in-flight runs don't hang waiting for a button that will never come.
      await approvalRegistry.disposeAll('gateway shutdown')
      await Promise.all(inFlightRuns)
    })

    // i. Login
    yield* Effect.tryPromise({
      try: async () => deps.login(client, config.discordToken),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })

    // j. Stale-run recovery — transition any runs left EXECUTING by a prior crash.
    //    Called after login so the Discord client is available for best-effort thread notes.
    //    Errors are logged internally; the startup sequence continues regardless.
    yield* Effect.tryPromise({
      try: async () =>
        recoverStaleRuns({
          coordinationConfig: {
            storeAdapter: s3Adapter,
            storeConfig: config.objectStore,
            lockTtlSeconds: DEFAULT_LOCK_TTL_SECONDS,
            heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
            staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
          },
          identity: config.identity,
          bindingsStore,
          resolveThread: async (threadId: string): Promise<SinkThread | null> => {
            try {
              const channel = await client.channels.fetch(threadId)
              if (channel === null) return null
              if (!('send' in channel)) return null
              return channel
            } catch {
              return null
            }
          },
          logger,
        }),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })

    // k. Log startup
    logger.info({applicationId: config.discordApplicationId}, 'gateway started')
  })
}
