import {Client, GatewayIntentBits} from 'discord.js'

export interface GatewayLogger {
  readonly debug: (context: Record<string, unknown>, message: string) => void
  readonly info: (context: Record<string, unknown>, message: string) => void
  readonly warn: (context: Record<string, unknown>, message: string) => void
  readonly error: (context: Record<string, unknown>, message: string) => void
}

const DEFAULT_INTENTS: readonly GatewayIntentBits[] = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]

export interface DiscordClientOptions {
  readonly intents?: readonly GatewayIntentBits[]
  readonly logger?: GatewayLogger
}

/**
 * Create a Discord.js Client with safe defaults.
 *
 * - Default intents are `Guilds` and `GuildMessages` only — the non-privileged baseline.
 *   Callers that need `MessageContent` or `GuildMembers` must pass them via `options.intents`;
 *   they are merged with (not replacing) the defaults.
 * - `allowedMentions` is locked to `{ parse: ['users'], repliedUser: false }` to prevent
 *   accidental @everyone / @here pings.
 * - Shard lifecycle events are wired to structured log lines when a logger is provided.
 * - Does NOT call `client.login()` — the caller (main.ts) is responsible for that.
 */
export function createDiscordClient(options: DiscordClientOptions = {}): Client {
  // Merge caller's intents with defaults — dedupe via Set since intents are numeric bitfield values.
  const intents =
    options.intents === undefined
      ? DEFAULT_INTENTS
      : [...new Set<GatewayIntentBits>([...DEFAULT_INTENTS, ...options.intents])]
  const logger = options.logger

  const client = new Client({
    intents,
    allowedMentions: {parse: ['users'], repliedUser: false},
  })

  if (logger) {
    client.on('shardReady', (shardId: number) => {
      logger.info({shardId}, 'discord shard ready')
    })

    client.on('shardDisconnect', (event, shardId: number) => {
      logger.warn({shardId, code: event.code, reason: event.reason}, 'discord shard disconnected')
    })

    client.on('shardReconnecting', (shardId: number) => {
      logger.info({shardId}, 'discord shard reconnecting')
    })

    client.on('shardError', (error: Error, shardId: number) => {
      logger.error({shardId, err: error}, 'discord shard error')
    })

    client.on('shardResume', (shardId: number, replayedEvents: number) => {
      logger.info({shardId, replayedEvents}, 'discord shard resumed')
    })
  }

  return client
}

/**
 * A no-op `GatewayLogger` that silently discards all log calls.
 * Use as a fallback when no logger is injected (e.g. stream sink without deps).
 * For production paths, prefer a real logger so failures produce observable output.
 */
export const NOOP_GATEWAY_LOGGER: GatewayLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
})

/**
 * A minimal console-backed `GatewayLogger` for handlers that have no injected logger.
 * debug/info are silenced; warn/error emit structured JSON to console.warn/console.error
 * so failures produce observable output without a full pino setup.
 *
 * Use for best-effort handlers (e.g. ping) where a real logger is not available.
 */
export const CONSOLE_GATEWAY_LOGGER: GatewayLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: (ctx: Record<string, unknown>, msg: string) => console.warn(JSON.stringify({level: 'warn', ...ctx, msg})),
  error: (ctx: Record<string, unknown>, msg: string) => console.error(JSON.stringify({level: 'error', ...ctx, msg})),
})

export {DEFAULT_INTENTS}
