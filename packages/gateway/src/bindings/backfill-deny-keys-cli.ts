/**
 * Admin CLI entrypoint for the active-binding deny-key backfill.
 *
 * Constructs the real deps (bindingsStore, getRepoIdentity, writeBinding) from
 * environment config and calls backfillActiveBindingDenyKeys, logging the result.
 *
 * ## Security invariant
 *
 * This is an OFFLINE/ADMIN entrypoint only. It must NEVER be imported from any
 * request handler, Discord command, or HTTP route. Calling it from a request path
 * would violate the denylist-before-query invariant (the backfill issues GitHub
 * queries to resolve repo identity — that is only safe offline/admin).
 *
 * ## Usage
 *
 *   node --import tsx/esm src/bindings/backfill-deny-keys-cli.ts
 *
 * Or via bunx (from the repo root):
 *
 *   bunx tsx src/bindings/backfill-deny-keys-cli.ts
 *
 * Required env vars (same as the gateway daemon):
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (or _FILE variants)
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET, S3_PREFIX
 *   GATEWAY_IDENTITY (optional, defaults to 'discord-gateway')
 */

import type {ObjectStoreAdapter, ObjectStoreConfig, Result} from '@fro-bot/runtime'
import type {RepoBinding} from './types.js'

import {readFileSync} from 'node:fs'
import process from 'node:process'

import {buildObjectStoreKey, err, ok} from '@fro-bot/runtime'

import {createAppClient} from '../github/app-client.js'
import {backfillActiveBindingDenyKeys} from './backfill-deny-keys.js'
import {createBindingsStore} from './store.js'

// ---------------------------------------------------------------------------
// Logger (plain console — this is an admin script, not a daemon)
// ---------------------------------------------------------------------------

const cliLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => {
    // Admin CLI: use stderr for all output so stdout can be piped cleanly.
    console.error(JSON.stringify({level: 'info', msg, ...meta}))
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {
    console.warn(JSON.stringify({level: 'warn', msg, ...meta}))
  },
  error: (msg: string, meta?: Record<string, unknown>) => {
    console.error(JSON.stringify({level: 'error', msg, ...meta}))
  },
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function readEnv(name: string): string {
  const fileVar = process.env[`${name}_FILE`]
  if (fileVar !== undefined && fileVar.length > 0) {
    // Synchronous read — this is a startup-time config read, not a hot path.
    return readFileSync(fileVar, 'utf8').trim()
  }
  const val = process.env[name]
  if (val === undefined || val.length === 0) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return val
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  cliLogger.info('backfill-deny-keys-cli: starting')

  // 1. Read config from env
  let appId: string
  let privateKey: string
  let s3Bucket: string
  let s3Prefix: string
  let s3Region: string
  let awsAccessKeyId: string
  let awsSecretAccessKey: string
  let identity: string

  try {
    appId = readEnv('GITHUB_APP_ID')
    privateKey = readEnv('GITHUB_APP_PRIVATE_KEY')
    s3Bucket = readEnv('S3_BUCKET')
    s3Prefix = process.env.S3_PREFIX ?? 'fro-bot-state'
    s3Region = readEnv('AWS_REGION')
    awsAccessKeyId = readEnv('AWS_ACCESS_KEY_ID')
    awsSecretAccessKey = readEnv('AWS_SECRET_ACCESS_KEY')
    identity = process.env.GATEWAY_IDENTITY ?? 'discord-gateway'
  } catch (configError) {
    cliLogger.error('backfill-deny-keys-cli: missing required env var', {
      error: configError instanceof Error ? configError.message : String(configError),
    })
    process.exit(1)
  }

  // 2. Build the App client
  const appClient = createAppClient({
    appId,
    privateKey,
    logger: {
      warn: (msg, meta) => cliLogger.warn(msg, meta),
      debug: () => undefined,
    },
  })

  // 3. Build the bindings store using the runtime S3 adapter.
  //    The adapter is constructed inline — this is admin-only, not a hot path.
  const storeConfig: ObjectStoreConfig = {
    enabled: true,
    bucket: s3Bucket,
    region: s3Region,
    prefix: s3Prefix,
    credentials: {accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey},
  }

  // Build a minimal S3-compatible adapter from env credentials.
  // The gateway uses @fro-bot/runtime's object store adapter interface.
  // For the CLI we construct a minimal adapter that wraps the AWS SDK directly.
  // If @fro-bot/runtime exports a factory, use it; otherwise fail with a clear error.
  let adapter: ObjectStoreAdapter
  try {
    // Try to import the S3 adapter factory from the runtime package.
    // This may not be available in all environments (e.g. test env).
    const runtimeModule = await import('@fro-bot/runtime')
    const createS3Adapter = (runtimeModule as Record<string, unknown>).createS3Adapter
    if (typeof createS3Adapter !== 'function') {
      throw new TypeError('@fro-bot/runtime does not export createS3Adapter — cannot construct S3 adapter')
    }
    // Cast to a typed factory to satisfy no-unsafe-call.
    const typedFactory = createS3Adapter as (config: ObjectStoreConfig) => ObjectStoreAdapter
    adapter = typedFactory(storeConfig)
  } catch (adapterError) {
    cliLogger.error('backfill-deny-keys-cli: failed to build S3 adapter', {
      error: adapterError instanceof Error ? adapterError.message : String(adapterError),
    })
    process.exit(1)
  }

  const bindingsStore = createBindingsStore({adapter, storeConfig, identity})

  // 4. Build writeBinding: unconditional store put via the adapter's conditionalPut.
  //    We use conditionalPut with no condition (no ifNoneMatch/ifMatch) to perform an
  //    unconditional overwrite. This is admin-only — not wired into any request handler.
  const writeBinding = async (binding: RepoBinding): Promise<Result<void, Error>> => {
    const keyResult = buildObjectStoreKey(
      storeConfig,
      identity,
      `${binding.owner}/${binding.repo}`,
      'bindings',
      'repo.json',
    )
    if (keyResult.success === false) {
      return err(keyResult.error)
    }

    if (adapter.conditionalPut == null) {
      return err(new Error('S3 adapter does not support conditionalPut — cannot write binding'))
    }

    // Unconditional put: no ifNoneMatch or ifMatch condition.
    const putResult = await adapter.conditionalPut(keyResult.data, JSON.stringify(binding), {})
    if (putResult.success === false) {
      return err(putResult.error)
    }

    return ok(undefined)
  }

  // 5. Run the backfill
  const result = await backfillActiveBindingDenyKeys({
    bindingsStore,
    getRepoIdentity: async (owner, repo) => appClient.getRepoIdentity(owner, repo),
    writeBinding,
    logger: cliLogger,
  })

  if (result.success === false) {
    cliLogger.error('backfill-deny-keys-cli: backfill failed', {error: result.error.message})
    process.exit(1)
  }

  const {total, updated, skipped, failed} = result.data
  cliLogger.info('backfill-deny-keys-cli: complete', {total, updated, skipped, failed})

  if (failed > 0) {
    cliLogger.warn('backfill-deny-keys-cli: some bindings failed — check logs above', {failed})
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// Entry guard — only run when executed directly
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({level: 'error', msg: 'backfill-deny-keys-cli: unhandled error', error: String(error)}),
    )
    process.exit(1)
  })
}
