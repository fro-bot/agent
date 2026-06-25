/**
 * Shared runner for the active-binding deny-key backfill.
 *
 * Wires env config → App client → S3 adapter → bindings store → writeBinding
 * → backfillActiveBindingDenyKeys and returns a process exit code.
 *
 * Callers decide what to do with the exit code (process.exit, test assertion,
 * etc.) — this function never calls process.exit itself, keeping it testable.
 *
 * ## Security invariant
 *
 * This is an OFFLINE/ADMIN runner only. It must NEVER be imported from any
 * request handler, Discord command, or HTTP route. Calling it from a request
 * path would violate the denylist-before-query invariant (the backfill issues
 * GitHub queries to resolve repo identity — that is only safe offline/admin).
 *
 * ## Exit codes
 *
 *   0 — clean run (all bindings updated or skipped, zero failures)
 *   1 — config/adapter/backfill-level failure (cannot proceed)
 *   2 — partial failure (some bindings failed; check logs)
 */

import type {Logger, ObjectStoreAdapter, ObjectStoreConfig, Result} from '@fro-bot/runtime'
import type {RepoBinding} from './types.js'

import {readFileSync} from 'node:fs'
import process from 'node:process'

import {buildObjectStoreKey, createS3Adapter, err, ok} from '@fro-bot/runtime'

import {createAppClient} from '../github/app-client.js'
import {backfillActiveBindingDenyKeys} from './backfill-deny-keys.js'
import {createBindingsStore} from './store.js'

// ---------------------------------------------------------------------------
// Usage / help
// ---------------------------------------------------------------------------

export const USAGE = `
Usage: node dist/main.mjs backfill-deny-keys [--apply] [--help|-h]

Backfill deny keys (databaseId + nodeId) for active bindings that lack them.

By default this command runs in PREVIEW mode — it resolves identities and
reports what would be written, but makes NO changes to the store.
Pass --apply to perform the actual writes.

Options:
  --apply     Write deny keys to the live S3 bindings store (real run).
              Omit this flag to preview without writing (safe default).
  --help, -h  Print this usage message and exit.

Required env vars (with optional _FILE variants for secrets):
  GITHUB_APP_ID              GitHub App numeric ID
  GITHUB_APP_PRIVATE_KEY     PEM private key (or GITHUB_APP_PRIVATE_KEY_FILE)
  S3_BUCKET                  Object-store bucket name
  AWS_REGION                 AWS region
  AWS_ACCESS_KEY_ID          AWS credentials
  AWS_SECRET_ACCESS_KEY      AWS credentials (or AWS_SECRET_ACCESS_KEY_FILE)

Optional env vars:
  S3_PREFIX          Object-store key prefix (default: fro-bot-state)
  GATEWAY_IDENTITY   Namespace for bindings in the store (default: discord-gateway)

Exit codes:
  0  Clean run — all bindings updated or already-keyed (skipped)
  1  Config/setup failure or bad flag — cannot proceed (check logs)
  2  Partial failure — some bindings failed; inspect logs and re-run to retry
`.trim()

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/** Parsed result from parseBackfillArgs. */
export type BackfillArgMode = {readonly mode: 'help' | 'apply' | 'dry-run'} | {readonly error: string}

const KNOWN_FLAGS = new Set(['--apply', '--help', '-h'])

/**
 * Parse the argv slice for the backfill-deny-keys subcommand.
 *
 * Pure function — no process.exit, no side effects. Testable in isolation.
 *
 * @param args - The remaining argv after the subcommand name (process.argv.slice(3))
 */
export function parseBackfillArgs(args: readonly string[]): BackfillArgMode {
  for (const arg of args) {
    if (!KNOWN_FLAGS.has(arg)) {
      return {error: `Unknown flag: ${arg}`}
    }
  }

  if (args.includes('--help') || args.includes('-h')) {
    return {mode: 'help'}
  }

  if (args.includes('--apply')) {
    return {mode: 'apply'}
  }

  return {mode: 'dry-run'}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunDenyKeyBackfillOptions {
  /** When true, resolve identities and count what would change, but skip writes. */
  readonly dryRun: boolean
  /**
   * Optional logger override. Defaults to a plain-console logger that writes
   * JSON to stderr (safe for piping stdout).
   */
  readonly logger?: Logger
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

/**
 * Read a required env var, with optional _FILE variant support.
 * Throws with a clear message if the var is missing or empty.
 */
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
// Default logger (plain console, stderr-safe for admin scripts)
// ---------------------------------------------------------------------------

function makeDefaultLogger(): Logger {
  return {
    debug: (_msg: string, _ctx?: Record<string, unknown>) => {
      // Admin runner: debug suppressed by default to keep output clean.
    },
    info: (msg: string, ctx?: Record<string, unknown>) => {
      // Use stderr so stdout can be piped cleanly.
      console.error(JSON.stringify({level: 'info', msg, ...ctx}))
    },
    warning: (msg: string, ctx?: Record<string, unknown>) => {
      console.warn(JSON.stringify({level: 'warn', msg, ...ctx}))
    },
    error: (msg: string, ctx?: Record<string, unknown>) => {
      console.error(JSON.stringify({level: 'error', msg, ...ctx}))
    },
  }
}

// ---------------------------------------------------------------------------
// Backfill logger adapter
// ---------------------------------------------------------------------------

/**
 * Adapt the runtime Logger (uses 'warning') to the BackfillDeps logger shape
 * (uses 'warn'). The backfill function expects { info, warn, error }.
 */
function makeBackfillLogger(logger: Logger): {
  readonly info: (msg: string, meta?: Record<string, unknown>) => void
  readonly warn: (msg: string, meta?: Record<string, unknown>) => void
  readonly error: (msg: string, meta?: Record<string, unknown>) => void
} {
  return {
    info: (msg, meta) => logger.info(msg, meta),
    warn: (msg, meta) => logger.warning(msg, meta),
    error: (msg, meta) => logger.error(msg, meta),
  }
}

// ---------------------------------------------------------------------------
// writeBinding factory
// ---------------------------------------------------------------------------

/**
 * Build the writeBinding closure for the backfill runner.
 *
 * Extracted as a named factory so it can be tested directly without mocking
 * backfillActiveBindingDenyKeys.
 *
 * Performs an unconditional overwrite via conditionalPut with no condition
 * (no ifNoneMatch / ifMatch). Admin-only — never wired into a request handler.
 */
export function makeWriteBinding(
  adapter: ObjectStoreAdapter,
  storeConfig: ObjectStoreConfig,
  identity: string,
): (binding: RepoBinding) => Promise<Result<void, Error>> {
  return async (binding: RepoBinding): Promise<Result<void, Error>> => {
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
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Wire env config → App client → S3 adapter → bindings store → backfill.
 *
 * Returns a process exit code:
 *   0 — success
 *   1 — config/adapter/backfill failure
 *   2 — partial failure (some bindings failed)
 *
 * Never calls process.exit — the caller decides.
 */
export async function runDenyKeyBackfill(options: RunDenyKeyBackfillOptions): Promise<number> {
  const logger = options.logger ?? makeDefaultLogger()

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
    logger.error('backfill-runner: missing required env var', {
      error: configError instanceof Error ? configError.message : String(configError),
    })
    return 1
  }

  // 2. Build the App client
  const appClient = createAppClient({
    appId,
    privateKey,
    logger: {
      warn: (msg, meta) => logger.warning(msg, meta),
      debug: (msg, meta) => logger.debug(msg, meta),
    },
  })

  // 3. Build the S3 adapter via the static import — 2 args: (config, logger).
  //    The logger is required; passing undefined causes logger.debug() to crash.
  const storeConfig: ObjectStoreConfig = {
    enabled: true,
    bucket: s3Bucket,
    region: s3Region,
    prefix: s3Prefix,
    credentials: {accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey},
  }

  let adapter: ObjectStoreAdapter
  try {
    adapter = createS3Adapter(storeConfig, logger)
  } catch (adapterError) {
    logger.error('backfill-runner: failed to build S3 adapter', {
      error: adapterError instanceof Error ? adapterError.message : String(adapterError),
    })
    return 1
  }

  // 4. Build the bindings store
  const bindingsStore = createBindingsStore({adapter, storeConfig, identity})

  // 5. Build writeBinding: unconditional overwrite via conditionalPut with no condition.
  //    Admin-only — not wired into any request handler.
  const writeBinding = makeWriteBinding(adapter, storeConfig, identity)

  // 6. Run the backfill
  const backfillLogger = makeBackfillLogger(logger)
  const result = await backfillActiveBindingDenyKeys({
    bindingsStore,
    getRepoIdentity: async (owner, repo) => appClient.getRepoIdentity(owner, repo),
    writeBinding,
    dryRun: options.dryRun,
    logger: backfillLogger,
  })

  if (result.success === false) {
    logger.error('backfill-runner: backfill failed', {error: result.error.message})
    return 1
  }

  const {total, updated, skipped, failed} = result.data
  logger.info('backfill-runner: complete', {total, updated, skipped, failed})

  if (failed > 0) {
    logger.warning('backfill-runner: some bindings failed — check logs above', {failed})
    return 2
  }

  return 0
}
