import type {ObjectStoreConfig} from './runtime-effect.js'

import {existsSync, readFileSync} from 'node:fs'
import process from 'node:process'

const DEFAULT_S3_PREFIX = 'fro-bot-state'
const DEFAULT_GATEWAY_IDENTITY = 'discord-gateway'
const DEFAULT_LOG_LEVEL = 'info' as const
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

export interface GatewayConfig {
  readonly discordToken: string
  readonly discordApplicationId: string
  readonly discordGuildId: string | null
  readonly objectStore: ObjectStoreConfig
  readonly identity: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/**
 * Read a required secret by name.
 *
 * Precedence:
 * 1. If `${name}_FILE` env var is set AND that file exists → read file contents, trim trailing whitespace
 * 2. Else if `process.env[name]` is set → return it
 * 3. Else throw with a clear message
 */
export function readSecret(name: string): string {
  const value = readOptionalSecret(name)
  if (value === null) {
    throw new Error(`Missing required secret: ${name} (set ${name} env var or ${name}_FILE pointing to a file)`)
  }
  return value
}

/**
 * Read an optional secret by name.
 *
 * Same precedence as `readSecret` but returns `null` instead of throwing.
 */
export function readOptionalSecret(name: string): string | null {
  const filePath = process.env[`${name}_FILE`]
  if (filePath !== undefined && existsSync(filePath)) {
    return readFileSync(filePath, 'utf8').trimEnd()
  }

  const value = process.env[name]
  if (value !== undefined) {
    return value
  }

  return null
}

/**
 * Load and validate the gateway configuration from environment variables and secrets.
 *
 * Throws if any required secret is missing or if a value fails validation.
 */
export function loadGatewayConfig(): GatewayConfig {
  const discordToken = readSecret('DISCORD_TOKEN')
  const discordApplicationId = readSecret('DISCORD_APPLICATION_ID')
  const discordGuildId = readOptionalSecret('DISCORD_GUILD_ID')

  const s3Bucket = readSecret('S3_BUCKET')
  const s3Region = readSecret('S3_REGION')
  const s3Endpoint = readOptionalSecret('S3_ENDPOINT') ?? undefined
  const s3Prefix = readOptionalSecret('S3_PREFIX') ?? DEFAULT_S3_PREFIX
  const s3Sse = readOptionalSecret('S3_SSE') ?? undefined

  const identity = readOptionalSecret('GATEWAY_IDENTITY') ?? DEFAULT_GATEWAY_IDENTITY

  const rawLogLevel = readOptionalSecret('LOG_LEVEL') ?? DEFAULT_LOG_LEVEL
  if (!(VALID_LOG_LEVELS as readonly string[]).includes(rawLogLevel)) {
    throw new Error(`Invalid LOG_LEVEL value: "${rawLogLevel}" (valid values: ${VALID_LOG_LEVELS.join(', ')})`)
  }
  const logLevel = rawLogLevel as GatewayConfig['logLevel']

  const objectStore: ObjectStoreConfig = {
    enabled: true,
    bucket: s3Bucket,
    region: s3Region,
    prefix: s3Prefix,
    ...(s3Endpoint === undefined ? {} : {endpoint: s3Endpoint}),
    ...(s3Sse === undefined ? {} : {sseEncryption: s3Sse as ObjectStoreConfig['sseEncryption']}),
  }

  return {
    discordToken,
    discordApplicationId,
    discordGuildId,
    objectStore,
    identity,
    logLevel,
  }
}
