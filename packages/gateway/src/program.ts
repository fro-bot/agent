import type {CoordinationConfig, ObjectStoreAdapter} from '@fro-bot/runtime'
import type {Client, GatewayIntentBits, Message} from 'discord.js'
import type {Context} from 'hono'
import type {RepoBinding} from './bindings/types.js'
import type {GatewayConfig} from './config.js'
import type {GatewayLogger} from './discord/client.js'
import type {SinkThread} from './discord/streaming.js'
import type {RunTask} from './execute/run.js'
import type {AnnounceServerConfig, AnnounceServerDeps} from './http/server.js'
import type {CoordinationLogger} from './runtime-effect.js'
import type {CloseableServer} from './shutdown.js'
import type {OperatorAllowlist} from './web/auth/allowlist.js'
import type {OperatorServerConfig, OperatorServerDeps} from './web/server.js'
import {
  createS3Adapter,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCK_TTL_SECONDS,
  DEFAULT_PENDING_STALE_THRESHOLD_MS,
  DEFAULT_STALE_THRESHOLD_MS,
} from '@fro-bot/runtime'
import {getConnInfo} from '@hono/node-server/conninfo'
import {Effect} from 'effect'
import {createApprovalRegistry} from './approvals/registry.js'
import {createBindingsStore} from './bindings/store.js'
import {parseApprovalCustomId} from './discord/approvals.js'
import {createDiscordClient, withLogContext} from './discord/client.js'
import {dispatchCommand, getCommandRegistry, registerSlashCommands} from './discord/commands/index.js'
import {editInteractionAsync} from './discord/io.js'
import {handleMention, userIsAuthorized} from './discord/mentions.js'
import {createConcurrencyRegistry} from './execute/concurrency.js'
import {createChannelQueue, DEFAULT_MAX_QUEUE_DEPTH} from './execute/queue.js'
import {recoverStaleRuns} from './execute/recovery.js'
import {createRunIndex} from './execute/run-index.js'
import {getInFlightRuns} from './execute/run.js'
import {createAppClient} from './github/app-client.js'
import {createRateLimiter} from './http/rate-limit.js'
import {createDenylistCache} from './redaction/denylist.js'
import {createAppClientMetadataReader} from './redaction/reader-app-client.js'
import {forceReleaseStaleLockEffect} from './runtime-effect.js'
import {DEFAULT_DRAIN_MS, installShutdownHandlers, isShuttingDown} from './shutdown.js'
import {buildGitHubOAuthDeps} from './web/auth/github.js'
import {createInMemorySessionStore} from './web/auth/session.js'
import {createRunObservationManager} from './web/sse/manager.js'
import {projectRunObservation} from './web/sse/projection.js'
import {createWorkspaceClient} from './workspace-api/client.js'
import {ensureWorkspaceClone} from './workspace-api/ensure-clone.js'

// ---------------------------------------------------------------------------
// Pure helper — builds the coordination config from the shared S3 adapter and
// gateway config. Extracted to avoid repeating the 5-field literal at every
// call site (self-test, mention handler, stale-run recovery).
// ---------------------------------------------------------------------------

function makeCoordinationConfig(s3Adapter: ObjectStoreAdapter, config: GatewayConfig): CoordinationConfig {
  return {
    storeAdapter: s3Adapter,
    storeConfig: config.objectStore,
    lockTtlSeconds: DEFAULT_LOCK_TTL_SECONDS,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
    pendingStaleThresholdMs: DEFAULT_PENDING_STALE_THRESHOLD_MS,
  }
}

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
// Operator server inputs helper — exported so the offline diagnostic can share
// the same deps-construction path as production.
// ---------------------------------------------------------------------------

/** Program-scoped instances passed into buildOperatorServerInputs. */
export interface BuildOperatorServerInputs {
  readonly logger: OperatorServerDeps['logger']
  readonly isShuttingDown: () => boolean
  readonly denylistCache: NonNullable<OperatorServerDeps['denylistCache']>
  readonly bindingsStore: {
    readonly getBindingByRepo: NonNullable<OperatorServerDeps['getBindingByRepo']>
    readonly listBindings?: () => Promise<
      {readonly success: true; readonly data: RepoBinding[]} | {readonly success: false; readonly error: Error}
    >
  }
  /**
   * Run-observation manager for the run-stream route.
   * Optional — omit (or pass undefined) to simulate a missing dep in tests,
   * which causes GET /operator/runs/:runId/stream to be absent from app.routes.
   */
  readonly runObservationManager?: NonNullable<OperatorServerDeps['runObservationManager']> | undefined
  readonly runIndex: NonNullable<OperatorServerDeps['runIndex']>
  readonly approvalRegistry: NonNullable<OperatorServerDeps['approvalRegistry']>
  /**
   * Engine dependencies for the launch route's launchWork call.
   * Required for POST /operator/runs to be registered — the route gate checks
   * deps.launchWorkDeps !== undefined. Pass runEngineDeps from the program scope.
   * Optional only for the offline diagnostic which may pass undefined to simulate
   * a missing dep and verify the launch route is absent.
   */
  readonly launchWorkDeps: NonNullable<OperatorServerDeps['launchWorkDeps']> | undefined
  readonly operatorWebConfig: {
    readonly bindHost: string
    readonly bindPort: number
    readonly publicOrigin: string
    readonly oauthClientId: string
    readonly oauthClientSecret: string
    readonly oauthAllowedReturnPaths: readonly string[]
    readonly oauthStateTtlMs: number
    readonly oauthMaxOutstandingAttemptsPerKey: number
    readonly csrfSecret: string
    readonly allowlist: OperatorAllowlist
  }
}

/**
 * Build the OperatorServerDeps and OperatorServerConfig objects from
 * program-scoped instances.
 *
 * Constructs operator-local pieces (rate limiter, session store, OAuth deps,
 * getSourceKey) internally. The caller passes already-constructed program-scoped
 * instances (denylistCache, bindingsStore, runObservationManager, runIndex,
 * approvalRegistry) in.
 *
 * Production's deps.startOperatorServer(...) call passes the helper's output
 * unchanged — behavior-identical to the previous inline construction.
 *
 * Exported for the offline route-registration diagnostic which calls this helper
 * with realistic-but-offline stubs to assert the route inventory without binding
 * a port.
 */
export function buildOperatorServerInputs(inputs: BuildOperatorServerInputs): {
  readonly deps: OperatorServerDeps
  readonly config: OperatorServerConfig
} {
  const {
    logger,
    isShuttingDown: isShuttingDownFn,
    denylistCache,
    bindingsStore,
    runObservationManager,
    runIndex,
    approvalRegistry,
    launchWorkDeps,
    operatorWebConfig,
  } = inputs

  // Build the source key extractor for OAuth outstanding-attempt counting.
  // Must use the TCP socket address (not caller-spoofable headers).
  // getConnInfo may throw in environments without a real socket; fall back to 'unknown'.
  const getSourceKey = (c: Context): string => {
    try {
      return getConnInfo(c).remote.address ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  // Build the shared rate limiter for the operator surface.
  // Passed to both buildGitHubOAuthDeps and OperatorServerDeps so OAuth routes
  // participate in the same per-socket budget as the health route.
  const operatorRateLimiter = createRateLimiter({limit: 20, windowMs: 60_000})

  // Build the shared in-memory session store for the operator surface.
  // Gateway restart is global logout — acceptable for v1.
  const sessionStore = createInMemorySessionStore()
  const sessionDeps = {
    logger,
    auditLogger: logger,
    clock: () => Date.now(),
  }

  // Build production GitHub OAuth deps with real CSPRNG, fetch, and clock.
  // Pass the session store so successful callbacks mint a fresh session.
  // Pass the allowlist so non-allowlisted users are denied before session creation.
  const githubOAuthDeps = buildGitHubOAuthDeps(
    logger,
    logger,
    getSourceKey,
    operatorRateLimiter,
    sessionStore,
    sessionDeps,
    operatorWebConfig.allowlist,
  )

  const deps: OperatorServerDeps = {
    logger,
    isShuttingDown: isShuttingDownFn,
    rateLimiter: operatorRateLimiter,
    githubOAuth: githubOAuthDeps,
    sessionStore,
    sessionDeps,
    allowlist: operatorWebConfig.allowlist,
    csrfSecret: operatorWebConfig.csrfSecret,
    auditLogger: logger,
    // Wire the existing program-scoped instances so the run-stream route
    // can reach them without creating second copies.
    denylistCache,
    bindingsLookup: bindingsStore,
    // listBindings is a distinct dep from bindingsLookup: server.ts gates the
    // GET /operator/repos mount on listBindings, so omitting it leaves that
    // route unmounted. bindingsLookup only covers the run-stream route.
    listBindings: bindingsStore.listBindings === undefined ? undefined : bindingsStore.listBindings.bind(bindingsStore),
    // getBindingByRepo: server.ts gates POST /operator/runs on this dep being present.
    // Bound to the store so the method's `this` context is preserved.
    getBindingByRepo: bindingsStore.getBindingByRepo.bind(bindingsStore),
    // launchWorkDeps: server.ts gates POST /operator/runs on this dep being present.
    // Shared with the Discord mention path so both use the same run-state instances.
    launchWorkDeps,
    runObservationManager,
    runIndex,
    approvalRegistry,
  }

  const config: OperatorServerConfig = {
    bindHost: operatorWebConfig.bindHost,
    bindPort: operatorWebConfig.bindPort,
    publicOrigin: operatorWebConfig.publicOrigin,
    githubOAuth: {
      clientId: operatorWebConfig.oauthClientId,
      clientSecret: operatorWebConfig.oauthClientSecret,
      publicOrigin: operatorWebConfig.publicOrigin,
      callbackPath: '/operator/auth/github/callback',
      allowedReturnPaths: operatorWebConfig.oauthAllowedReturnPaths,
      stateTtlMs: operatorWebConfig.oauthStateTtlMs,
      maxOutstandingAttemptsPerKey: operatorWebConfig.oauthMaxOutstandingAttemptsPerKey,
    },
  }

  return {deps, config}
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
  /**
   * Factory for the operator web HTTP server.
   * Receives the assembled deps + config so callers can inject fakes in tests.
   * Returns a CloseableServer handle that will be passed to installShutdownHandlers.
   * Only called when config.operatorWeb is present.
   * Optional — when absent, the operator server is not started even if config.operatorWeb is set.
   */
  readonly startOperatorServer?: (deps: OperatorServerDeps, config: OperatorServerConfig) => CloseableServer
  /**
   * Provider semantics self-test — validates that the S3-compatible store honors
   * IfNoneMatch/IfMatch conditional write semantics required for safe coordination.
   * Injected so tests can stub it without touching the real S3 adapter.
   */
  readonly runProviderSelfTest: (config: CoordinationConfig, logger: CoordinationLogger) => Promise<void>
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

    // Provider semantics self-test — fail-fast before serving so a provider that doesn't honor
    // IfNoneMatch/IfMatch conditional writes can't silently corrupt the coordination lock.
    const selfTestCoordConfig = makeCoordinationConfig(s3Adapter, config)
    yield* Effect.tryPromise({
      try: async () => deps.runProviderSelfTest(selfTestCoordConfig, runtimeLogger),
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })

    const concurrencyRegistry = createConcurrencyRegistry(config.maxConcurrentRuns)
    const channelQueue = createChannelQueue<RunTask>(DEFAULT_MAX_QUEUE_DEPTH)
    const bindingsStore = createBindingsStore({
      adapter: s3Adapter,
      storeConfig: config.objectStore,
      identity: config.identity,
    })
    // Server-owned run index: authoritative runId → {repo, surface} resolution.
    // Populated at run creation; used by privileged routes (future SSE/launch) to
    // authorize a run by id without trusting client-supplied owner/repo.
    const runIndex = createRunIndex({
      bindingsStore,
      coordinationConfig: makeCoordinationConfig(s3Adapter, config),
      identity: config.identity,
      logger,
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
      queue: channelQueue,
      triggerRoleId: config.triggerRoleId,
      gatewayLogger: logger,
      // force-release-lock deps: pre-built coordination config + Effect-wrapped primitive
      // (injected so tests can mock without real S3 calls)
      coordinationConfig: makeCoordinationConfig(s3Adapter, config),
      // identity is the run-state owner identity (gateway identity); forwarded to
      // forceReleaseStaleLockEffect so it reads run-state under the correct key segment.
      identity: config.identity,
      forceReleaseStaleLock: forceReleaseStaleLockEffect,
    }

    const registry = getCommandRegistry(commandDeps)

    // Program-scoped approval registry — shared between the button handler and shutdown drain.
    const approvalRegistry = createApprovalRegistry({logger})

    // Run-observation manager: projects run states and fans them to SSE subscribers.
    // It is fed by the run lifecycle hook and holds a latest-status cache per active run.
    // No HTTP route consumes it yet, so nothing subscribes.
    const DENYLIST_TTL_MS = 5 * 60_000 // 5-minute TTL — also used as the background refresh cadence
    const denylistCache = createDenylistCache({
      reader: createAppClientMetadataReader(appClient),
      ttlMs: DENYLIST_TTL_MS,
      graceMs: 30 * 60_000, // 30-minute grace window
      now: () => Date.now(),
      logger,
    })
    const runObservationManager = createRunObservationManager({
      projectRunObservation: async runState =>
        projectRunObservation(runState, {
          nowMs: Date.now(),
          staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
          bindingsLookup: bindingsStore,
          isRepoDenied: denylistCache.isRepoDenied,
          hasPendingForScope: scopeId => approvalRegistry.hasPendingForScope(scopeId),
        }),
      logger,
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: id => clearInterval(id),
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: id => clearTimeout(id),
      now: () => Date.now(),
    })

    // Prime the denylist cache once at startup so isRepoDenied reads primed state
    // rather than deny-all. A prime failure is logged but must not crash startup —
    // the cache stays fail-closed (deny-all) until a later refresh succeeds.
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await denylistCache.getDenylistState()
        } catch (primeError: unknown) {
          logger.warn(
            {err: String(primeError)},
            'denylist: startup prime failed — cache stays deny-all until next refresh',
          )
        }
      },
      catch: error => (error instanceof Error ? error : new Error(String(error))),
    })

    // Background refresh: keep the denylist warm on the same cadence as the TTL.
    // Errors are logged by the cache internally; the interval catch is a final safety net.
    const denylistRefreshInterval = setInterval(() => {
      denylistCache.getDenylistState().catch((error: unknown) => {
        logger.warn({err: String(error)}, 'denylist: background refresh failed')
      })
    }, DENYLIST_TTL_MS)

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
          const buttonLog = withLogContext(logger, {interaction: 'approval-button'})
          try {
            // Defer FIRST — acks the interaction within Discord's 3 s window before
            // any REST calls (guild.members.fetch inside userIsAuthorized can be slow).
            // All subsequent responses must use editReply (not reply) since the
            // interaction is now deferred.
            await interaction.deferReply({ephemeral: true})

            // Auth: reuse the same authorization gate as the mention path.
            const guild = interaction.guild
            if (guild === null) {
              await editInteractionAsync(interaction, {content: 'Not authorized to approve.'}, buttonLog)
              return
            }
            const authorized = await userIsAuthorized(guild, interaction.user.id, config.triggerRoleId, buttonLog)
            if (authorized === false) {
              await editInteractionAsync(interaction, {content: 'Not authorized to approve.'}, buttonLog)
              return
            }

            const decision = parsed.action === 'approve' ? ('once' as const) : ('reject' as const)
            const outcome = await approvalRegistry.handleDecision({
              requestID: parsed.requestID,
              approvalScopeId: interaction.channelId,
              decision,
              actor: {kind: 'discord-user', userId: interaction.user.id},
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

            await editInteractionAsync(interaction, {content: ackContent}, buttonLog)
          } catch (error: unknown) {
            logger.error({err: String(error)}, 'button: unexpected error handling approval interaction')
            // editInteraction catches internally and returns a Result — never throws.
            await editInteractionAsync(interaction, {content: 'Failed to record decision, try again.'}, buttonLog)
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

    // ---------------------------------------------------------------------------
    // Engine deps for launchWork — shared between Discord mentions and the web
    // operator launch route so both paths use the same run-state/coordination
    // instances and cannot diverge.
    //
    // botUserId is read lazily via a getter: client.user is set after login, but
    // the operator server starts before login. On the web path botUserId is
    // destructured by executeWorkOnHeldSlot but never consumed — the web path
    // always supplies a promptBuilder that does not use it. On the Discord path
    // the messageCreate handler spreads these deps and overrides botUserId with
    // the concrete client.user.id value.
    // ---------------------------------------------------------------------------
    const runEngineDeps: import('./execute/run.js').RunMentionDeps = {
      coordinationConfig: makeCoordinationConfig(s3Adapter, config),
      identity: config.identity,
      concurrency: concurrencyRegistry,
      queue: channelQueue,
      attachUrl: config.workspaceOpencodeUrl,
      attachToken: config.workspaceOpencodeToken,
      runTimeoutMs: config.runTimeoutMs,
      // Lazy getter: client.user is non-null after login. Web-launched runs
      // always supply a promptBuilder so botUserId is never read on that path.
      get botUserId() {
        return client.user?.id ?? ''
      },
      persona: config.persona,
      logger,
      approvalRegistry,
      approvalMode: config.approvalMode,
      statusMode: config.statusMode,
      // Workspace readiness gate — uses the same :9100 base as the clone endpoint.
      // Placed inside run so it is called after the concurrency gate, not before.
      readyz: async () => workspaceClient.readyz(),
      // Ensure workspace checkout exists. Called after the concurrency gate so
      // same-channel mention storms do not each mint GitHub App tokens before
      // the busy/cap rejection fires. Adapts GatewayLogger (context-first) to
      // the EnsureCloneDeps logger (message-first) inline.
      ensureClone: async (owner: string, repo: string) =>
        ensureWorkspaceClone({
          owner,
          repo,
          appClient,
          workspaceClient,
          logger: {
            info: (msg, meta) => logger.info(meta ?? {}, msg),
            warn: (msg, meta) => logger.warn(meta ?? {}, msg),
            error: (msg, meta) => logger.error(meta ?? {}, msg),
          },
        }),
      // Shutdown gate: suppress handoff to next queued task once SIGTERM fires.
      // The in-memory queue is lossy by design; dropping pending tasks on graceful
      // shutdown matches that contract and is consistent with the messageCreate
      // guard above that refuses new mentions once isShuttingDown() returns true.
      isShuttingDown,
      // Server-owned run index: populated at run creation for privileged route authz.
      runIndex,
      // Feeds the run-observation manager at each lifecycle transition.
      runObserver: runObservationManager,
    }

    // Track in-flight mention run promises so SIGTERM can await them before tearing down.
    const inFlightRuns = new Set<Promise<void>>()

    client.on('messageCreate', (message: Message) => {
      if (message.author.bot) return
      if (client.user === null) return
      if (!message.mentions.has(client.user.id)) return
      // Stop accepting new mentions once shutdown has been requested.
      if (isShuttingDown()) return

      // Reuse the program-scoped engine deps; override botUserId with the
      // concrete value now that client.user is guaranteed non-null.
      const mentionDeps = {
        bindingsStore,
        triggerRoleId: config.triggerRoleId,
        run: {
          ...runEngineDeps,
          botUserId: client.user.id,
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

    // g. Start announce HTTP server (before shutdown handlers so the handle is available).
    //    Announce endpoint is opt-in: only started when both GATEWAY_WEBHOOK_SECRET and
    //    GATEWAY_PRESENCE_CHANNEL_ID are configured. When absent, serverHandle is undefined
    //    and installShutdownHandlers skips server close (server param is already optional).
    let serverHandle: CloseableServer | undefined
    if (config.announce === undefined) {
      logger.info({}, 'announce endpoint disabled — no announce secrets configured')
    } else {
      serverHandle = deps.startAnnounceServer(
        {
          client,
          logger,
          isShuttingDown,
        },
        {
          webhookSecret: config.announce.webhookSecret,
          presenceChannelId: config.announce.presenceChannelId,
          httpPort: config.announce.httpPort,
        },
      )
      logger.info({}, 'announce endpoint enabled — HTTP server started')
    }

    // g2. Start operator web HTTP server (before shutdown handlers so the handle is available).
    //     Operator web endpoint is opt-in: only started when all required operator config
    //     vars are set. Partial config fails closed at loadGatewayConfig() time.
    //     When absent, operatorServerHandle is undefined and shutdown skips it.
    let operatorServerHandle: CloseableServer | undefined
    if (config.operatorWeb === undefined || deps.startOperatorServer === undefined) {
      logger.info({}, 'operator web endpoint disabled — no operator web config set')
    } else {
      // Build the operator server deps and config via the shared helper.
      // The helper constructs operator-local pieces (rate limiter, session store,
      // OAuth deps, getSourceKey) and wires the program-scoped instances.
      // Using the helper here ensures production and the offline diagnostic share
      // the same wiring path — a future edit that drops a dep from the helper
      // will be caught by the diagnostic before it reaches production.
      const operatorInputs = buildOperatorServerInputs({
        logger,
        isShuttingDown,
        denylistCache,
        bindingsStore,
        runObservationManager,
        runIndex,
        approvalRegistry,
        launchWorkDeps: runEngineDeps,
        operatorWebConfig: config.operatorWeb,
      })

      operatorServerHandle = deps.startOperatorServer(operatorInputs.deps, operatorInputs.config)
      logger.info(
        {bindHost: config.operatorWeb.bindHost, bindPort: config.operatorWeb.bindPort},
        'operator web endpoint enabled — HTTP server started',
      )
    }

    // h. Install shutdown handlers — drain pending approvals fail-closed then await in-flight runs.
    //    Build a composite server handle that closes both the announce and operator servers
    //    (if present) so installShutdownHandlers only needs to call close() once.
    const compositeServerHandle: CloseableServer | undefined =
      serverHandle === undefined && operatorServerHandle === undefined
        ? undefined
        : {
            close(cb?: (err?: Error) => void): void {
              const handles = [serverHandle, operatorServerHandle].filter((h): h is CloseableServer => h !== undefined)
              if (handles.length === 0) {
                cb?.()
                return
              }
              let remaining = handles.length
              let firstError: Error | undefined
              for (const h of handles) {
                h.close(err => {
                  if (err !== undefined && err !== null && firstError === undefined) {
                    firstError = err
                  }
                  remaining -= 1
                  if (remaining === 0) {
                    cb?.(firstError)
                  }
                })
              }
            },
          }

    installShutdownHandlers(client, logger, undefined, compositeServerHandle, async () => {
      // Stop the denylist background refresh — no new refreshes after shutdown starts.
      clearInterval(denylistRefreshInterval)

      // Shut down the run-observation manager — closes all SSE subscriptions and clears timers.
      runObservationManager.shutdown()

      // Dispose pending approvals before draining runs — ensures pending permissions
      // fail-closed so in-flight runs don't hang waiting for a button that will never come.
      //
      // NOTE: disposeAll is best-effort early fail-close, NOT a hard barrier. A run still
      // draining SSE could call register() for a late approval after disposeAll clears the
      // map; that late entry is fail-closed only by the run's own coordinator.dispose() in
      // its finally block. The per-run coordinator.dispose() is the authoritative backstop
      // for approvals registered after this global drain.
      await approvalRegistry.disposeAll('gateway shutdown')

      // Drain in-flight runs with a bounded timeout so a hung S3/network call
      // (e.g. in acquireLock/ensureClone/readyz) cannot stall shutdown forever.
      // The recovery sweep (recoverStaleRuns) is the backstop for any run that
      // does not complete before the deadline.
      const drainDeadline = new Promise<void>(resolve => {
        setTimeout(() => {
          const discordCount = inFlightRuns.size
          const webCount = getInFlightRuns().size
          const total = discordCount + webCount
          if (total > 0) {
            logger.warn({discordCount, webCount}, `shutdown drain timed out with ${total} run(s) still in flight`)
          }
          resolve()
        }, DEFAULT_DRAIN_MS)
      })

      // Drain Discord mention runs (owned by this program-scoped set).
      // Drain web immediate runs (owned by run.ts's module-scoped in-flight set).
      // Both sets are drained concurrently; the deadline races both.
      await Promise.race([Promise.all([...inFlightRuns, ...getInFlightRuns()]), drainDeadline])
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
          coordinationConfig: makeCoordinationConfig(s3Adapter, config),
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
