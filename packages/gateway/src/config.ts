import type {AwsCredentials, ObjectStoreConfig} from './runtime-effect.js'

import {existsSync, readFileSync, statSync} from 'node:fs'
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
    const stat = statSync(filePath)
    if (!stat.isFile()) {
      throw new Error(
        `Secret path is a directory, not a file: ${filePath} (the bind-mount source likely doesn't exist on the host)`,
      )
    }
    const contents = readFileSync(filePath, 'utf8')
    // Strip only trailing whitespace (newline/spaces from echo) so leading whitespace
    // in valid secrets is preserved — matching the env-var path which uses raw process.env[name].
    // Treat whitespace-only or empty files as "not set" (e.g. empty bind-mounted optional secrets).
    const trailingTrimmed = contents.trimEnd()
    return trailingTrimmed.trim() === '' ? null : trailingTrimmed
  }

  const value = process.env[name]
  if (value !== undefined && value.trim() !== '') {
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

  const awsAccessKeyId = readOptionalSecret('AWS_ACCESS_KEY_ID')
  const awsSecretAccessKey = readOptionalSecret('AWS_SECRET_ACCESS_KEY')
  const awsSessionToken = readOptionalSecret('AWS_SESSION_TOKEN')

  // Pair validation: both must be set together, or neither
  if (awsAccessKeyId !== null && awsSecretAccessKey === null) {
    throw new Error(
      'Both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together (received: AWS_ACCESS_KEY_ID). Set both, or set neither to use the SDK default credential chain.',
    )
  }

  if (awsSecretAccessKey !== null && awsAccessKeyId === null) {
    throw new Error(
      'Both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together (received: AWS_SECRET_ACCESS_KEY). Set both, or set neither to use the SDK default credential chain.',
    )
  }

  let credentials: AwsCredentials | undefined

  if (awsAccessKeyId !== null && awsSecretAccessKey !== null) {
    credentials = {
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey,
      ...(awsSessionToken === null ? {} : {sessionToken: awsSessionToken}),
    }
  } else if (awsSessionToken !== null) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'AWS_SESSION_TOKEN is set without AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY; ignoring it and falling back to SDK default credential chain.',
      }),
    )
  }

  const objectStore: ObjectStoreConfig = {
    enabled: true,
    bucket: s3Bucket,
    region: s3Region,
    prefix: s3Prefix,
    ...(s3Endpoint === undefined ? {} : {endpoint: s3Endpoint}),
    ...(s3Sse === undefined ? {} : {sseEncryption: s3Sse as ObjectStoreConfig['sseEncryption']}),
    ...(credentials === undefined ? {} : {credentials}),
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
