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
              requestTimeoutMs: 5000,
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
              const response = await serving.fetch('/api/agent')
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              return response.json()
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
