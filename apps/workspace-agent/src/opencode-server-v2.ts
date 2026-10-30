/**
 * OpenCode V2 server lifecycle for the workspace-agent: the sibling of `opencode-server.ts`, selected by `main.ts`
 * when the image carries a stock OpenCode with major version 2 or higher.
 *
 * Spawn, password, readiness, plugin gate and shutdown come from `@fro-bot/runtime/workspace-v2`
 * (`startOpenCodeV2Server`). This module adds what only the workspace needs:
 *
 * - the child runs as the unprivileged agent identity with an environment built from an allowlist;
 * - every spawn gets a fresh database directory, so nothing a session wrote survives a respawn and V2 has no
 *   execution claim to resume after a restart;
 * - the per-spawn Basic credential is published to the proxy through a holder, before readiness flips to ready;
 * - the effective permission rules are checked after the plugin gate, and a server that fails the check never serves;
 * - the provider credentials are provisioned into each spawn's empty credential store over loopback, and a server
 *   whose model provider has no credential never serves (opencode-credentials-v2.ts, fro-bot/agent#1992);
 * - on shutdown every session still active is interrupted (reason `user`) before stdin closes.
 *
 * SECURITY INVARIANTS:
 * 1. The server binds 127.0.0.1 only. The :9200 bearer proxy is the sole externally reachable surface.
 * 2. The server password lives inside the runtime handle and the holder's provider function. It is never logged,
 *    never put in the environment of anything but the spawn, and never serialised with the holder.
 * 3. A failed start, a failed gate or an unexpected exit clears the credential at once, so the proxy fails closed
 *    instead of forwarding with a password the next server does not hold.
 * 4. Bounded respawn: max attempts, with a stable-run reset, as in the V1 supervisor.
 */

import type {OpenCodeV2ServerHandle, Logger as RuntimeLogger} from '@fro-bot/runtime/workspace-v2'
import type {CredentialResult, ProviderKeyEntry, SpawnConfig} from './opencode-credentials-v2.js'
import type {Logger, SupervisedStatusRef} from './opencode-server.js'
import {chmod, mkdir, mkdtemp, chown as nodeChown, rm} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {setTimeout as sleep} from 'node:timers/promises'

import {
  buildWorkspaceConfigV2,
  DEFAULT_SYSTEMATIC_VERSION,
  FRO_BOT_PLUGIN_ID,
  FRO_BOT_PLUGIN_PACKAGE,
  FRO_BOT_PLUGIN_VERSION,
  startOpenCodeV2Server,
  SYSTEMATIC_PACKAGE,
  SYSTEMATIC_V2_PLUGIN_ID,
  verifyPermissionRules,
} from '@fro-bot/runtime/workspace-v2'
import {MAX_CONFIG_FILE_BYTES, readOptionalBoundedFile, readOptionalSecretBlob} from './config.js'
import {
  AGENT_GID,
  AGENT_HOME,
  AGENT_TMPDIR,
  AGENT_UID,
  AGENT_USERNAME,
  AGENT_XDG_CACHE_HOME,
  AGENT_XDG_CONFIG_HOME,
  AGENT_XDG_DATA_HOME,
  AGENT_XDG_STATE_HOME,
  OPENCODE_EXECUTABLE_PATH,
} from './identity.js'
import {
  modelProviderId,
  parseAuthBlob,
  provisionCredentials,
  spawnConfigFromMergedConfig,
  verifyCredentialGate,
} from './opencode-credentials-v2.js'

/**
 * Where per-spawn database directories live. Root-owned and never agent-writable: the service creates it, so a
 * path the agent can influence is never the target of a root-privileged `rm` or `chown`. The parent
 * `/var/lib/workspace-agent` is created by deploy/workspace.Dockerfile next to the service's own home.
 */
export const WORKSPACE_OPENCODE_V2_DB_DIR = '/var/lib/workspace-agent/opencode-v2-db'

/** The file name inside a spawn directory (probe P15: V2 names it `opencode.db` on the release channel). */
const DATABASE_FILE_NAME = 'opencode.db'

/** The plugin specs the image installs at build time, in the order the config lists them. */
export const WORKSPACE_V2_PLUGIN_SPECS: readonly string[] = [
  `${SYSTEMATIC_PACKAGE}@${DEFAULT_SYSTEMATIC_VERSION}`,
  `${FRO_BOT_PLUGIN_PACKAGE}@${FRO_BOT_PLUGIN_VERSION}`,
]

/** The ids `GET /api/plugin` must list active after spawn (probe P13: matched by id, never by presence). */
export const WORKSPACE_V2_EXPECTED_PLUGIN_IDS: readonly string[] = [SYSTEMATIC_V2_PLUGIN_ID, FRO_BOT_PLUGIN_ID]

const OPENCODE_PORT = 54_321

/** Where the entrypoint reads the root-only provider credential blob from when `WORKSPACE_OPENCODE_AUTH_FILE` is unset. */
export const DEFAULT_WORKSPACE_AUTH_FILE = '/run/workspace-agent/secrets/workspace_opencode_auth'

// ── Child environment ──────────────────────────────────────────────────────────

const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'] as const
const CA_BUNDLE_ENV_NAMES = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO'] as const
const LOCALE_ENV_NAMES = ['LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE'] as const

/** Trusted PATH for the child and its tools: the locations deploy/workspace.Dockerfile installs binaries at. */
const TRUSTED_OPENCODE_PATH = '/usr/local/bin:/usr/bin:/bin'

function copyEnvIfSet(source: NodeJS.ProcessEnv, target: Record<string, string>, name: string): void {
  const value = source[name]
  if (value !== undefined) target[name] = value
}

/**
 * Builds the V2 child environment from an allowlist, never by subtracting from `parentEnv`. The runtime spawn then
 * adds the password, the config content and the project-config and auto-update switches itself.
 *
 * The file watcher stays at V2's default: probe P3 found no difference with it on or off, so
 * `OPENCODE_DISABLE_FILEWATCHER` is neither set nor defaulted here, and the allowlist does not forward it from the
 * parent. V2 has no environment flag for background subagents (they are native), so no V1 flag is carried over.
 */
export function buildOpencodeV2Env(parentEnv: NodeJS.ProcessEnv, databasePath: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    HOME: AGENT_HOME,
    USER: AGENT_USERNAME,
    LOGNAME: AGENT_USERNAME,
    PATH: TRUSTED_OPENCODE_PATH,
    XDG_DATA_HOME: AGENT_XDG_DATA_HOME,
    XDG_CONFIG_HOME: AGENT_XDG_CONFIG_HOME,
    XDG_CACHE_HOME: AGENT_XDG_CACHE_HOME,
    XDG_STATE_HOME: AGENT_XDG_STATE_HOME,
    TMPDIR: AGENT_TMPDIR,
    OPENCODE_DB: databasePath,
    // The egress allowlist blocks models.opencode.ai (403); the bundled snapshot is the floor, so the fetch is noise.
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  }

  for (const name of PROXY_ENV_NAMES) copyEnvIfSet(parentEnv, env, name)
  for (const name of CA_BUNDLE_ENV_NAMES) copyEnvIfSet(parentEnv, env, name)
  for (const name of LOCALE_ENV_NAMES) copyEnvIfSet(parentEnv, env, name)

  return env
}

// ── Fresh database per spawn ───────────────────────────────────────────────────

export interface PrepareFreshDatabaseOptions {
  /** Defaults to `WORKSPACE_OPENCODE_V2_DB_DIR`. */
  readonly baseDir?: string
  /** Defaults to the agent uid (identity.ts). */
  readonly uid?: number
  /** Defaults to the agent gid (identity.ts). */
  readonly gid?: number
  /** Test seam: the real `chown` needs privilege the test process does not have for uid 10001. */
  readonly chown?: (target: string, uid: number, gid: number) => Promise<void>
}

/**
 * Gives the next spawn an empty database directory and returns the database path inside it.
 *
 * Everything under `baseDir` is removed first, so no spawn inherits what an earlier one wrote. The base directory
 * is recreated root-owned and mode 0711: the agent can traverse it to reach its own directory but can neither list
 * nor modify it. The per-spawn directory is created by `mkdtemp` under that root-owned parent, so the path the
 * `chown` acts on cannot be swapped for a symlink by the agent.
 */
export async function prepareFreshDatabase(options: PrepareFreshDatabaseOptions = {}): Promise<string> {
  const {baseDir = WORKSPACE_OPENCODE_V2_DB_DIR, uid = AGENT_UID, gid = AGENT_GID, chown = nodeChown} = options
  await rm(baseDir, {recursive: true, force: true})
  await mkdir(baseDir, {recursive: true, mode: 0o711})
  // `mkdir` applies the umask; the mode the agent needs is exact.
  await chmod(baseDir, 0o711)
  const spawnDir = await mkdtemp(path.join(baseDir, 'spawn-'))
  await chown(spawnDir, uid, gid)
  await chmod(spawnDir, 0o700)
  return path.join(spawnDir, DATABASE_FILE_NAME)
}

// ── Credential holder ──────────────────────────────────────────────────────────

/**
 * The Basic credential of the server that is currently ready, read by the proxy on every request. It stores a
 * provider function, not a string, so serialising the holder (or a log line that includes it) cannot leak it, and
 * a rotated value is picked up without re-wiring the proxy.
 */
export interface UpstreamCredentials {
  /** The `Authorization` header value to inject, or undefined while no server is ready. */
  readonly authorization: () => string | undefined
  readonly set: (provider: () => string) => void
  readonly clear: () => void
}

export function createUpstreamCredentials(): UpstreamCredentials {
  let provider: (() => string) | undefined
  return {
    authorization: () => provider?.(),
    set: next => {
      provider = next
    },
    clear: () => {
      provider = undefined
    },
  }
}

// ── Supervisor ─────────────────────────────────────────────────────────────────

type StartServerFn = typeof startOpenCodeV2Server
type VerifyRulesFn = typeof verifyPermissionRules

export interface RunSupervisedOpencodeV2Deps {
  readonly startServer: StartServerFn
  readonly verifyRules: VerifyRulesFn
  /** Returns the database path for the next spawn. Default: `prepareFreshDatabase()`. */
  readonly prepareDatabase: () => Promise<string>
  /**
   * Returns the raw provider credential blob, or null when none is provisioned (a clone-only deployment). May throw
   * for an unreadable file. Default: the hardened root-only secret read of `WORKSPACE_OPENCODE_AUTH_FILE`.
   */
  readonly readAuthBlob: () => string | null
  /**
   * The model and the inline-authenticated providers the NEXT spawn will see. Called once per spawn, after the server
   * is up, because the file is agent-writable and a later spawn may load a different one. May throw for an unreadable
   * or malformed config. Default: the merged `opencode.json` the entrypoint wrote.
   */
  readonly readSpawnConfig: () => SpawnConfig
}

export interface RunSupervisedOpencodeV2Options {
  /** The repos root, used as the server's working directory and the location the gates ask about. */
  readonly rootDir: string
  readonly logger: Logger
  /** Mutable status reference: the supervisor writes transitions here. */
  readonly statusRef: SupervisedStatusRef
  /** Published to the proxy on every spawn, before `statusRef` flips to ready. */
  readonly credentials: UpstreamCredentials
  /** Aborting stops the supervisor and runs the interrupt-then-close shutdown. */
  readonly signal?: AbortSignal
  /** Service environment the allowlisted child environment is sourced from. Default: `process.env`. */
  readonly parentEnv?: NodeJS.ProcessEnv
  /** Default: 54321, where the :9200 proxy expects the upstream. */
  readonly port?: number
  /** Per-phase readiness bound for each attempt (listen, `/api/info`, plugin activation). Default 60000. */
  readonly readyTimeoutMs?: number
  /** Bound on each runtime request and on the permission-gate read, headers and body together. Default 5000. */
  readonly requestTimeoutMs?: number
  /** Absolute OpenCode executable. Default: `/usr/local/bin/opencode`. */
  readonly binaryPath?: string
  /** Literal absolute directories outside the checkout that stay reachable without a prompt. Default none. */
  readonly allowedExternalDirectories?: readonly string[]
  /** Maximum spawn attempts (initial plus respawns). Default 4. */
  readonly maxAttempts?: number
  readonly initialBackoffMs?: number
  readonly maxBackoffMs?: number
  /** Uptime after ready that counts as a stable run and resets the attempt budget. Default 60000. */
  readonly stableReadyResetMs?: number
  readonly deps?: Partial<RunSupervisedOpencodeV2Deps>
}

/** The merged config the entrypoint writes and the server loads as its global config. */
export const MERGED_CONFIG_PATH = path.join(AGENT_XDG_CONFIG_HOME, 'opencode', 'opencode.json')

/**
 * The effective model and the providers that carry an inline credential setting, read from the merged config the spawn
 * loads (base + `WORKSPACE_OPENCODE_CONFIG` overlay + the `WORKSPACE_OPENCODE_MODEL` that wins when non-blank, all
 * resolved by `merge-config.mjs`). Reading the file the server loads, rather than recomputing the rule from the
 * environment, leaves one source that cannot drift from the server's. Absent file: no model, no inline auth. The file
 * is agent-writable, so it is opened without following symlinks and size-capped; the answer only selects which
 * providers the gate checks, it grants nothing, and it carries provider ids, never a value.
 */
export function readSpawnConfigFromFile(configPath: string = MERGED_CONFIG_PATH): SpawnConfig {
  const raw = readOptionalBoundedFile(configPath, MAX_CONFIG_FILE_BYTES)
  if (raw === null) return {authenticatedProviders: []}
  const parsed = spawnConfigFromMergedConfig(raw)
  if (!parsed.success) throw new Error(parsed.error.message)
  return parsed.data
}

/** `WORKSPACE_OPENCODE_AUTH_FILE` when set and non-blank, else the path the entrypoint defaults to. */
function authFilePath(env: NodeJS.ProcessEnv): string {
  const configured = env.WORKSPACE_OPENCODE_AUTH_FILE?.trim() ?? ''
  return configured === '' ? DEFAULT_WORKSPACE_AUTH_FILE : configured
}

/** The runtime logger takes `warning` and `debug`; the workspace logger takes `warn` and has no debug level. */
function toRuntimeLogger(logger: Logger): RuntimeLogger {
  return {
    debug: () => undefined,
    info: (message, context) => logger.info(message, context),
    warning: (message, context) => logger.warn(message, context),
    error: (message, context) => logger.error(message, context),
  }
}

/** Bound on the active-session listing a shutdown does before it interrupts. */
const ACTIVE_LISTING_TIMEOUT_MS = 5000

/** Per-request bound for the runtime's own calls and for the permission-gate read. */
const REQUEST_TIMEOUT_MS = 5000

/**
 * Settles with `work`, or rejects as soon as `signal` aborts, whichever comes first. A response whose body stalls
 * after the headers arrived is covered even when the transport underneath ignores the signal.
 */
async function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, {once: true})
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Every session still active on this spawn. The database is fresh per spawn, so every session on the server belongs
 * to this run. Fail-soft: a listing that cannot be read leaves the shutdown with nothing to interrupt, and the
 * process is still stopped.
 */
async function listActiveSessionIds(handle: OpenCodeV2ServerHandle, logger: Logger): Promise<readonly string[]> {
  try {
    const response = await handle.fetch('/api/session/active', {signal: AbortSignal.timeout(ACTIVE_LISTING_TIMEOUT_MS)})
    if (!response.ok) {
      logger.warn('opencode-server-v2: could not list active sessions for shutdown', {status: response.status})
      return []
    }
    const body = (await response.json()) as {data?: unknown}
    if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) return []
    return Object.keys(body.data)
  } catch {
    logger.warn('opencode-server-v2: could not list active sessions for shutdown')
    return []
  }
}

export async function runSupervisedOpencodeV2(options: RunSupervisedOpencodeV2Options): Promise<void> {
  const {
    rootDir,
    logger,
    statusRef,
    credentials,
    signal,
    parentEnv = process.env,
    port = OPENCODE_PORT,
    readyTimeoutMs = 60_000,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    binaryPath = OPENCODE_EXECUTABLE_PATH,
    allowedExternalDirectories = [],
    maxAttempts = 4,
    initialBackoffMs = 1000,
    maxBackoffMs = 10_000,
    stableReadyResetMs = 60_000,
  } = options
  const {
    startServer = startOpenCodeV2Server,
    verifyRules = verifyPermissionRules,
    prepareDatabase = async () => prepareFreshDatabase(),
    readAuthBlob = () => readOptionalSecretBlob(authFilePath(parentEnv)),
    readSpawnConfig = () => readSpawnConfigFromFile(),
  } = options.deps ?? {}

  const runtimeLogger = toRuntimeLogger(logger)

  // The config is the same for every attempt, and a config that cannot be built is not a transient failure.
  const built = buildWorkspaceConfigV2({plugins: WORKSPACE_V2_PLUGIN_SPECS, allowedExternalDirectories}, runtimeLogger)
  if (!built.success) {
    credentials.clear()
    statusRef.status = 'degraded'
    logger.error('opencode-server-v2: cannot build the workspace config', {message: built.error})
    return
  }

  // The credential blob is a static root-only secret, so an unreadable or malformed one is not a transient failure
  // either: nothing is spawned, and the status says why. Errors name the provider id or the file path, never a key.
  let keyEntries: readonly ProviderKeyEntry[] = []
  try {
    const rawBlob = readAuthBlob()
    if (rawBlob !== null) {
      const parsed = parseAuthBlob(rawBlob)
      if (!parsed.success) {
        credentials.clear()
        statusRef.status = 'degraded'
        logger.error('opencode-server-v2: provider credential blob is unusable', {
          kind: parsed.error.kind,
          message: parsed.error.message,
        })
        return
      }
      keyEntries = parsed.data
    }
  } catch (error) {
    credentials.clear()
    statusRef.status = 'degraded'
    logger.error('opencode-server-v2: cannot read the provider credential blob', {
      message: error instanceof Error ? error.message : 'unknown',
    })
    return
  }
  let attempt = 1
  let backoffMs = initialBackoffMs
  // One listener for the whole lifetime, however many respawns: it aborts a start in flight and wakes a ready wait.
  // `startAbort` exists ONLY while a start is in flight. The signal given to the runtime spawn governs the server for
  // its whole life, and aborting it after the start runs the handle's own shutdown with no sessions to interrupt;
  // that shutdown is memoized, so it would win over the supervisor's interrupt-then-close. Once the server is
  // running, only the supervisor stops it.
  let startAbort: AbortController | undefined
  let wake: () => void = () => undefined
  const aborted = new Promise<void>(resolve => {
    wake = resolve
  })
  const onAbort = (): void => {
    startAbort?.abort()
    wake()
  }
  signal?.addEventListener('abort', onAbort, {once: true})

  /** Interrupt what is running, then close stdin and confirm the exit. Never throws. */
  const stopServer = async (handle: OpenCodeV2ServerHandle): Promise<void> => {
    credentials.clear()
    const ownedSessionIds = await listActiveSessionIds(handle, logger)
    try {
      const result = await handle.shutdown({ownedSessionIds})
      logger.info('opencode-server-v2: server stopped', {
        outcome: result.exit.outcome,
        interrupted: result.interrupts.stopped.length,
        unconfirmed: result.interrupts.unconfirmed.length,
      })
    } catch (error) {
      logger.error('opencode-server-v2: shutdown failed', {message: error instanceof Error ? error.message : 'unknown'})
    }
  }

  // A function, not a repeated property read: TypeScript would otherwise narrow `signal.aborted` across the awaits.
  const isAborted = (): boolean => signal?.aborted === true

  /** Waits out the backoff, abortably. Returns false when the supervisor was aborted. */
  const backoff = async (): Promise<boolean> => {
    if (backoffMs > 0 && !isAborted()) {
      await sleep(backoffMs, undefined, {signal}).catch(() => undefined)
    }
    if (isAborted()) return false
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    return true
  }

  /**
   * Provisions the keys into this spawn's credential store, then gates on the model it will use. Runs once per spawn,
   * after the server is up, and reads the merged config fresh each time: the file is agent-writable, so a replacement
   * spawn can load a different model than the one before it, and the gate must check the one this server loaded.
   *
   * The gate checks the provider of the effective model (from the overlay or the env, whichever the merge chose). With
   * no model (a clone-only deployment) there is no request it could fail, so it checks the providers provisioned
   * instead, and with neither it has nothing to check and does not block readiness. A provider whose merged config
   * carries an inline credential setting needs no stored connection.
   */
  const credentialStep = async (serving: OpenCodeV2ServerHandle): Promise<CredentialResult<unknown>> => {
    let spawnConfig: SpawnConfig
    try {
      spawnConfig = readSpawnConfig()
    } catch (error) {
      return {
        success: false,
        error: {
          kind: 'model-config-invalid',
          message: `Cannot read the effective model from the merged config: ${error instanceof Error ? error.message : 'unknown'}`,
        },
      }
    }
    const modelProvider = modelProviderId(spawnConfig.model)
    const requiredProviders = modelProvider === undefined ? keyEntries.map(entry => entry.providerId) : [modelProvider]
    if (requiredProviders.length === 0) {
      logger.info('opencode-server-v2: no model or provider credentials configured, credential gate skipped')
      return {success: true, data: []}
    }
    const request = {handle: serving, requestTimeoutMs, ...(signal === undefined ? {} : {signal})}
    // The fresh database has no credentials (V2 only imports auth.json through a migration a fresh database skips), so
    // every spawn stores them again. Then the gate reads them back: a server that cannot authenticate its model's
    // provider never goes ready.
    if (keyEntries.length > 0) {
      const provisioned = await provisionCredentials({...request, entries: keyEntries, logger})
      if (!provisioned.success) return provisioned
    }
    return verifyCredentialGate({
      ...request,
      providers: requiredProviders,
      configuredAuth: spawnConfig.authenticatedProviders,
    })
  }

  try {
    while (attempt <= maxAttempts) {
      if (isAborted()) return

      // Fail closed before every spawn: not ready, and no credential for the proxy to forward with.
      statusRef.status = 'starting'
      credentials.clear()
      logger.info('opencode-server-v2: supervisor spawning', {rootDir, attempt, maxAttempts})

      let handle: OpenCodeV2ServerHandle | undefined
      try {
        const databasePath = await prepareDatabase()
        // An abort during preparation found no start in flight to cancel, so nothing else stops this attempt.
        if (isAborted()) return
        const startController = new AbortController()
        startAbort = startController
        const started = await startServer(
          {
            binaryPath,
            directory: rootDir,
            expectedPluginIds: WORKSPACE_V2_EXPECTED_PLUGIN_IDS,
            config: built.data.content,
            env: buildOpencodeV2Env(parentEnv, databasePath),
            port,
            uid: AGENT_UID,
            gid: AGENT_GID,
            timeouts: {
              listenTimeoutMs: readyTimeoutMs,
              infoTimeoutMs: readyTimeoutMs,
              agentReadyTimeoutMs: readyTimeoutMs,
              // Teardown has to finish inside main.ts's 25s drain: listing 5s + interrupts 8s + exit 5s + kill 2s.
              requestTimeoutMs,
              interruptSettleTimeoutMs: 8000,
              exitTimeoutMs: 5000,
              killConfirmTimeoutMs: 2000,
            },
            signal: startController.signal,
          },
          runtimeLogger,
        )
        startAbort = undefined
        if (started.success) {
          handle = started.data
        } else if (isAborted()) {
          return
        } else {
          logger.warn('opencode-server-v2: start failed', {
            attempt,
            kind: started.error.kind,
            message: started.error.message,
            ...(started.error.plugins === undefined ? {} : {plugins: started.error.plugins}),
          })
        }
      } catch (error) {
        startAbort = undefined
        logger.error('opencode-server-v2: start threw', {
          attempt,
          message: error instanceof Error ? error.message : 'unknown',
        })
      }

      if (handle !== undefined) {
        const serving = handle
        // The effective rules are the source of truth: a server whose rules do not hold never serves.
        const gate = await verifyRules(
          {
            listAgents: async () => {
              // One bound for headers and body, joined with service cancellation: the handle's raw fetch has none.
              const bound = AbortSignal.timeout(requestTimeoutMs)
              const gateSignal = signal === undefined ? bound : AbortSignal.any([signal, bound])
              const read = async (): Promise<unknown> => {
                const response = await serving.fetch('/api/agent', {signal: gateSignal})
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return response.json()
              }
              return untilAborted(gateSignal, read())
            },
          },
          built.data.expectations,
          runtimeLogger,
        )
        if (!gate.success) {
          logger.error('opencode-server-v2: permission gate failed', {
            attempt,
            kind: gate.error.kind,
            message: gate.error.message,
          })
          await stopServer(handle)
          handle = undefined
        }
      }

      if (handle !== undefined) {
        const serving = handle
        const gated = await credentialStep(serving)
        if (!gated.success && isAborted()) {
          // The service is stopping: the request was cut short by the abort, not refused. A clean stop, not a failure.
          await stopServer(handle)
          return
        }
        if (!gated.success) {
          logger.error('opencode-server-v2: credential gate failed', {
            attempt,
            kind: gated.error.kind,
            message: gated.error.message,
            ...(gated.error.providers === undefined ? {} : {providers: gated.error.providers}),
          })
          await stopServer(handle)
          handle = undefined
        }
      }

      if (handle !== undefined) {
        if (isAborted()) {
          await stopServer(handle)
          return
        }
        // Credential first, status second: a request admitted the moment /readyz reports ready must carry it.
        credentials.set(handle.authorizationHeader)
        statusRef.status = 'ready'
        const readyAt = Date.now()
        logger.info('opencode-server-v2: ready', {attempt, pid: handle.pid})

        const outcome = await Promise.race([
          handle.exited.then(() => 'exited' as const),
          aborted.then(() => 'aborted' as const),
        ])
        if (outcome === 'aborted') {
          await stopServer(handle)
          return
        }

        // Unexpected exit: not ready, and the dead server's password goes with it.
        credentials.clear()
        statusRef.status = 'starting'
        const wasStable = Date.now() - readyAt >= stableReadyResetMs
        if (wasStable) {
          logger.info('opencode-server-v2: stable run detected — resetting respawn budget', {attempt})
          attempt = 1
          backoffMs = initialBackoffMs
        }
        if (attempt < maxAttempts) {
          logger.warn('opencode-server-v2: server exited after becoming ready — respawning', {attempt, maxAttempts})
          if (!(await backoff())) return
          attempt++
          continue
        }
        statusRef.status = 'degraded'
        logger.error('opencode-server-v2: supervisor exhausted attempts after post-ready exit', {attempt, maxAttempts})
        return
      }

      // This attempt did not produce a serving server.
      if (attempt < maxAttempts) {
        logger.warn('opencode-server-v2: attempt failed, will respawn', {
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
        })
        if (!(await backoff())) return
        attempt++
        continue
      }
      statusRef.status = 'degraded'
      logger.error('opencode-server-v2: supervisor exhausted all attempts', {attempt, maxAttempts})
      return
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
