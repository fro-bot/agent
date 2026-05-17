import {Client, GatewayIntentBits} from 'discord.js'

export interface GatewayLogger {
  readonly debug: (context: Record<string, unknown>, message: string) => void
  readonly info: (context: Record<string, unknown>, message: string) => void
  readonly warn: (context: Record<string, unknown>, message: string) => void
  readonly error: (context: Record<string, unknown>, message: string) => void
}

const DEFAULT_INTENTS: GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers,
]

export interface DiscordClientOptions {
  readonly intents?: GatewayIntentBits[]
  readonly logger?: GatewayLogger
}

/**
 * Create a Discord.js Client with safe defaults.
 *
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

export {DEFAULT_INTENTS}
