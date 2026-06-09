/**
 * workspace-agent entry point.
 *
 * Starts the Hono HTTP server on 0.0.0.0:9100.
 * Starts the OpenCode SDK server bound to 127.0.0.1:54321 (loopback only).
 * Starts the bearer-token proxy on 0.0.0.0:9200 (sandbox-net reachable).
 * Handles SIGTERM gracefully with a 25s drain window.
 *
 * The module top level is a thin entrypoint guard — all startup work lives in
 * the exported `startWorkspaceAgent(deps)` function so the env → supervisor
 * readiness-timeout wiring is assertable without binding real ports.
 */

import type {AddressInfo} from 'node:net'
import type {ServerType} from '@hono/node-server'
import type {OpencodeProxyHandle, OpencodeProxyOptions} from './opencode-proxy.js'
import type {RunSupervisedOpencodeOptions} from './opencode-server.js'
import type {ProxyListeningRef} from './server.js'

import process from 'node:process'
import {fileURLToPath} from 'node:url'

import {serve} from '@hono/node-server'

import {asyncCleanupAllAskpassDirs} from './clone.js'
import {readReadyTimeoutMs, readSecret} from './config.js'
import {createOpencodeProxy} from './opencode-proxy.js'
import {runSupervisedOpencode} from './opencode-server.js'
import {createApp} from './server.js'

const PORT = 9100
const HOST = '0.0.0.0'
const DRAIN_MS = 25_000
const OPENCODE_PORT = 54321
const OPENCODE_HOSTNAME = '127.0.0.1'
const PROXY_PORT = 9200
const WORKSPACE_REPOS_ROOT = '/workspace/repos'

// ── Injectable dependency types ───────────────────────────────────────────────

/** Serve function signature matching @hono/node-server's `serve`. */
export type ServeFn = (
  options: {
    readonly fetch: (req: Request) => Response | Promise<Response>
    readonly port: number
    readonly hostname: string
  },
  listeningListener?: (info: AddressInfo) => void,
) => ServerType

/** Factory function for the OpenCode bearer proxy. */
export type CreateOpencodeProxyFn = (options: OpencodeProxyOptions) => OpencodeProxyHandle

/** Supervisor runner function. */
export type RunSupervisedOpencodeFn = (options: RunSupervisedOpencodeOptions) => Promise<void>

/** Secret reader function. */
export type ReadSecretFn = (name: string) => string

/**
 * Injectable dependencies for `startWorkspaceAgent`.
 * All have real defaults so production wiring is unchanged.
 */
export interface WorkspaceAgentDeps {
  /**
   * Environment variable source. Defaults to `process.env`.
   * Injected for testing so env reads are isolated.
   */
  readonly env?: NodeJS.ProcessEnv
  /**
   * Hono node-server `serve` function. Defaults to the real `@hono/node-server` serve.
   * Injected for testing to avoid binding real ports.
   */
  readonly serveFn?: ServeFn
  /**
   * Supervised OpenCode runner. Defaults to the real `runSupervisedOpencode`.
   * Injected for testing to avoid spawning real processes.
   */
  readonly runSupervisedOpencodeFn?: RunSupervisedOpencodeFn
  /**
   * OpenCode proxy factory. Defaults to the real `createOpencodeProxy`.
   * Injected for testing to avoid binding real ports.
   */
  readonly createOpencodeProxyFn?: CreateOpencodeProxyFn
  /**
   * Secret reader. Defaults to the real `readSecret` from config.ts.
   * Injected for testing to avoid reading real secrets.
   */
  readonly readSecretFn?: ReadSecretFn
}

/**
 * Start the workspace-agent: Hono server, supervised OpenCode, and bearer proxy.
 *
 * All startup work that was previously at module top-level lives here so the
 * env → supervisor readiness-timeout wiring is assertable via injected deps.
 *
 * **Startup order is preserved byte-for-byte from the pre-refactor entrypoint:**
 * 1. Read env (readReadyTimeoutMs, readSecret) — BEFORE any server bind
 * 2. serve() — Hono HTTP server on :9100
 * 3. runSupervisedOpencode() — supervised OpenCode lifecycle (fire-and-forget)
 * 4. createOpencodeProxy() + proxy.listen() — bearer proxy on :9200
 * 5. Wire SIGTERM/SIGINT shutdown handlers
 */
export async function startWorkspaceAgent(deps: WorkspaceAgentDeps = {}): Promise<void> {
  const {
    env = process.env,
    serveFn = serve,
    runSupervisedOpencodeFn = runSupervisedOpencode,
    createOpencodeProxyFn = createOpencodeProxy,
    readSecretFn = readSecret,
  } = deps

  // Supervisor writes all status transitions here; /healthz and /readyz read it.
  const opencodeStatus = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

  // /readyz requires BOTH opencodeStatus === 'ready' AND proxyListening.listening === true.
  // The proxy binds (milliseconds) before OpenCode finishes booting (seconds), so this
  // is true before opencodeStatus → 'ready', avoiding a startup false-negative.
  const proxyListeningRef: ProxyListeningRef = {listening: false}

  // detached:true puts the child in its own process group — it does NOT inherit SIGTERM
  // from the parent on container stop, so we must abort explicitly to avoid orphaning it.
  const opencodeController = new AbortController()

  const app = createApp({opencodeStatus, proxyListening: proxyListeningRef})

  // Read env before any server bind: fail-fast if WORKSPACE_OPENCODE_READY_TIMEOUT_MS is malformed.
  const opencodeReadyTimeoutMs = readReadyTimeoutMs(env)

  const server = serveFn({fetch: app.fetch, port: PORT, hostname: HOST}, info => {
    console.warn(`workspace-agent listening on ${info.address}:${info.port}`)
  })

  const opencodeLogger = {
    info: (msg: string, meta?: Record<string, unknown>) => console.warn(msg, meta ?? ''),
    warn: (msg: string, meta?: Record<string, unknown>) => console.warn(msg, meta ?? ''),
    error: (msg: string, meta?: Record<string, unknown>) => console.error(msg, meta ?? ''),
  }

  // Fire-and-forget: supervisor writes status transitions to opencodeStatus.
  // On respawn exhaustion it lands in 'degraded' (clone API still alive; /readyz → 503).
  const opencodeServerPromise = runSupervisedOpencodeFn({
    rootDir: WORKSPACE_REPOS_ROOT,
    logger: opencodeLogger,
    statusRef: opencodeStatus,
    signal: opencodeController.signal,
    hostname: OPENCODE_HOSTNAME,
    port: OPENCODE_PORT,
    readyTimeoutMs: opencodeReadyTimeoutMs,
  }).catch((error: unknown) => {
    // Unexpected supervisor crash (should not happen — supervisor catches internally).
    opencodeStatus.status = 'down'
    const message = error instanceof Error ? error.message : String(error)
    console.error('workspace-agent: opencode supervisor crashed unexpectedly', {message})
  })

  let proxy: OpencodeProxyHandle | undefined

  try {
    const token = readSecretFn('WORKSPACE_OPENCODE_TOKEN')
    proxy = createOpencodeProxyFn({
      token,
      upstreamUrl: `http://${OPENCODE_HOSTNAME}:${OPENCODE_PORT}`,
      logger: opencodeLogger,
    })
    // listen() resolves when the OS assigns the port (milliseconds), well before
    // OpenCode finishes booting (seconds) — so proxyListeningRef.listening is true
    // before opencodeStatus can transition to 'ready', avoiding a /readyz false-negative.
    proxy
      .listen(PROXY_PORT, HOST)
      .then(() => {
        proxyListeningRef.listening = true
      })
      .catch((error: unknown) => {
        proxyListeningRef.listening = false
        const message = error instanceof Error ? error.message : String(error)
        console.error('workspace-agent: proxy failed to start', {message})
      })
    proxy.server.on('close', () => {
      proxyListeningRef.listening = false
    })
    proxy.server.on('error', () => {
      proxyListeningRef.listening = false
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('workspace-agent: cannot start proxy — missing WORKSPACE_OPENCODE_TOKEN', {message})
    // Process should not start without the proxy; exit with error code.
    process.exit(1)
  }

  let shuttingDown = false

  function shutdown(signal: string): void {
    if (shuttingDown === true) return
    shuttingDown = true

    console.warn(`workspace-agent: ${signal} received, draining (${DRAIN_MS}ms)`)

    const drainTimer = setTimeout(() => {
      console.error('workspace-agent: drain timeout, forcing exit')
      process.exit(1)
    }, DRAIN_MS)

    // Explicit abort required: detached child is in its own process group and
    // does not inherit SIGTERM from the parent; abort reaps it via killChildGroup.
    opencodeController.abort()

    const cleanupProxy = async (): Promise<void> => {
      if (proxy !== undefined) {
        return proxy.close().catch(() => {
          // Best-effort
        })
      }
      return Promise.resolve()
    }

    asyncCleanupAllAskpassDirs()
      .catch(() => {
        // Best-effort
      })
      .finally(() => {
        cleanupProxy()
          .catch(() => {
            // Best-effort
          })
          .finally(() => {
            server.close(err => {
              clearTimeout(drainTimer)
              if (err !== undefined && err !== null) {
                console.error('workspace-agent: shutdown error', err)
                process.exit(1)
              }
              console.warn('workspace-agent: shutdown clean')
              process.exit(0)
            })
          })
      })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // Suppress unused-variable warning — the promise is fire-and-forget.
  opencodeServerPromise.catch(() => {
    // Already handled in the .catch() above; this suppresses the linter.
  })
}

// ── Entrypoint guard ──────────────────────────────────────────────────────────
// Mirror the repo's fileURLToPath(import.meta.url) === process.argv[1] pattern
// (see deploy/scripts/validate-auth.mjs). When this module is the direct Node
// entrypoint, start the agent with real production dependencies. When imported
// as a library (tests, other modules), do nothing — no ports are bound.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  startWorkspaceAgent().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('workspace-agent: startup failed', {message})
    process.exit(1)
  })
}
