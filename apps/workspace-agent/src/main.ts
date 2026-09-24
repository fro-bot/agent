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

/**
 * How long to wait for the :9100 listen() bind to settle (listening or 'error') before treating
 * startup as stalled and exiting. A loopback/wildcard TCP bind involves no upstream I/O — it
 * either succeeds or fails (e.g. EADDRINUSE) within a single event-loop tick under normal
 * conditions. 10s is pure margin for a slow tick under cold-start GC pressure, not a realistic
 * wait, and stays comfortably under the :9100 healthcheck's first probe (10s interval — see
 * deploy/compose.yaml) so a stalled bind is caught and the container restarted well within one
 * healthcheck cycle instead of silently hanging forever.
 */
export const SERVER_LISTEN_TIMEOUT_MS = 10_000

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
 * Process-exit function. Typed as `never`-returning (matches `process.exit`) so callers can
 * assume control flow does not continue past a call — TypeScript narrows accordingly.
 */
export type ExitFn = (code: number) => never

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
  /**
   * Process-exit function. Defaults to the real `process.exit`.
   * Injected for testing so a bind failure/timeout doesn't kill the test runner.
   */
  readonly exitFn?: ExitFn
}

/**
 * Start the workspace-agent: Hono server, bearer proxy, then supervised OpenCode.
 *
 * All startup work that was previously at module top-level lives here so the
 * env → supervisor readiness-timeout wiring is assertable via injected deps.
 *
 * **Startup order (reordered so OpenCode is never spawned before the control ports are bound):**
 * 1. Read env (readReadyTimeoutMs, readSecret) — BEFORE any server bind
 * 2. serve() — Hono HTTP server on :9100, AWAITED until actually listening, a bind 'error', or
 *    SERVER_LISTEN_TIMEOUT_MS elapses (whichever comes first) — the latter two exit(1)
 * 3. createOpencodeProxy() + proxy.listen() on :9200 — AWAITED until the bind attempt settles.
 *    A failed bind is FATAL (exitFn(1), same as the :9100 failure below): once OpenCode runs
 *    unprivileged (uid 10001) a control port nobody holds is a port it can take, including the
 *    gateway's bearer token headed for :9200.
 * 4. runSupervisedOpencode() — supervised OpenCode lifecycle (fire-and-forget), spawned as the
 *    unprivileged agent uid ONLY once both control ports above are already bound — once OpenCode
 *    runs unprivileged it is just another process on the box, and must never have a window where
 *    it could win a race to bind 9100 or 9200 before the real listeners do
 * 5. Wire SIGTERM/SIGINT shutdown handlers
 */
export async function startWorkspaceAgent(deps: WorkspaceAgentDeps = {}): Promise<void> {
  const {
    env = process.env,
    serveFn = serve,
    runSupervisedOpencodeFn = runSupervisedOpencode,
    createOpencodeProxyFn = createOpencodeProxy,
    readSecretFn = readSecret,
    exitFn = code => process.exit(code),
  } = deps

  // Supervisor writes all status transitions here; /healthz and /readyz read it.
  const opencodeStatus = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

  // /readyz requires BOTH opencodeStatus === 'ready' AND proxyListening.listening === true.
  const proxyListeningRef: ProxyListeningRef = {listening: false}

  // detached:true puts the child in its own process group — it does NOT inherit SIGTERM
  // from the parent on container stop, so we must abort explicitly to avoid orphaning it.
  const opencodeController = new AbortController()

  // Read env before any server bind: fail-fast if WORKSPACE_OPENCODE_READY_TIMEOUT_MS is malformed.
  const opencodeReadyTimeoutMs = readReadyTimeoutMs(env)

  // Read the control-API bearer once, before any server bind, and reuse it for both the Hono
  // app's auth middleware (every route but /healthz and /readyz) and the 9200 OpenCode proxy
  // below — never read WORKSPACE_OPENCODE_TOKEN a second time.
  let token: string
  try {
    token = readSecretFn('WORKSPACE_OPENCODE_TOKEN')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('workspace-agent: cannot start — missing WORKSPACE_OPENCODE_TOKEN', {message})
    return exitFn(1)
  }

  const app = createApp({opencodeStatus, proxyListening: proxyListeningRef, token})

  // Bind :9100 and WAIT for the first of three outcomes before doing anything else that could
  // race an unprivileged process for a port:
  //   1. the listening callback fires — bind succeeded, proceed
  //   2. the underlying server emits 'error' (e.g. EADDRINUSE) — log and exit(1)
  //   3. SERVER_LISTEN_TIMEOUT_MS elapses with neither — log and exit(1)
  // Before this reorder, an unhandled bind error crashed the process and the container
  // restarted. Startup is now sequenced BEFORE OpenCode is spawned, so without an explicit
  // 'error'/timeout path a failed bind would just hang the `await` forever — the process stays
  // alive, never listens, never spawns OpenCode, and compose's healthcheck never passes but also
  // never fails loudly. Racing all three outcomes restores the fail-fast/restart behavior.
  const server = await new Promise<ServerType>((resolve, reject) => {
    let settled = false
    let boundServer: ServerType | undefined
    let timer: ReturnType<typeof setTimeout>

    function finish(outcome: {ok: true; server: ServerType} | {ok: false; error: Error}): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      boundServer?.removeListener('error', onError)
      if (outcome.ok) {
        resolve(outcome.server)
      } else {
        reject(outcome.error)
      }
    }

    function onError(error: unknown): void {
      finish({ok: false, error: error instanceof Error ? error : new Error(String(error))})
    }

    timer = setTimeout(() => {
      finish({
        ok: false,
        error: new Error(`workspace-agent: :9100 did not start listening within ${SERVER_LISTEN_TIMEOUT_MS}ms`),
      })
    }, SERVER_LISTEN_TIMEOUT_MS)

    // Attach the 'error' listener immediately after serveFn returns the underlying server — the
    // OS bind attempt (@hono/node-server's serve() calls net.Server#listen internally) resolves
    // asynchronously via libuv, always after this synchronous call returns, so the listener is in
    // place before a bind failure can fire.
    boundServer = serveFn({fetch: app.fetch, port: PORT, hostname: HOST}, info => {
      console.warn(`workspace-agent listening on ${info.address}:${info.port}`)
      finish({ok: true, server: boundServer as ServerType})
    })
    boundServer.on('error', onError)
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('workspace-agent: failed to bind :9100', {message})
    return exitFn(1)
  })

  const opencodeLogger = {
    info: (msg: string, meta?: Record<string, unknown>) => console.warn(msg, meta ?? ''),
    warn: (msg: string, meta?: Record<string, unknown>) => console.warn(msg, meta ?? ''),
    error: (msg: string, meta?: Record<string, unknown>) => console.error(msg, meta ?? ''),
  }

  let proxy: OpencodeProxyHandle | undefined
  // Hoisted above the proxy 'close'/'error' handlers (which read it) and the shutdown() closure
  // (which sets it) — it gates whether an unexpected runtime port loss is fatal or an expected
  // part of our own graceful shutdown.
  let shuttingDown = false

  try {
    // Reuses the `token` read once, above, before any server bind — see that comment.
    proxy = createOpencodeProxyFn({
      token,
      upstreamUrl: `http://${OPENCODE_HOSTNAME}:${OPENCODE_PORT}`,
      logger: opencodeLogger,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('workspace-agent: cannot start proxy', {message})
    // Process should not start without the proxy; exit with error code.
    process.exit(1)
  }

  // Once :9200 has bound successfully, a 'close' or 'error' on the proxy server means the OS has
  // released (or is about to release) the port. If that happens while OpenCode (uid 10001) is
  // already running, the port is free for the unprivileged process to bind and intercept the
  // gateway's bearer token headed for the real proxy — that's the same control-port-takeover risk
  // the startup ordering above exists to prevent, just at runtime instead of at boot. Treat it as
  // fatal: log and exitFn(1) so the container restarts and re-binds :9200 before OpenCode is
  // spawned again. `proxyBindSucceeded` and `shuttingDown` gate this so it fires only for an
  // unexpected runtime loss of the port — not for the initial failed-bind path below (already
  // fatal via its own exitFn(1)) and not for the deliberate close in our own graceful-shutdown
  // path (proxy.close() in cleanupProxy further down).
  let proxyBindSucceeded = false
  proxy.server.on('close', () => {
    proxyListeningRef.listening = false
    if (proxyBindSucceeded && !shuttingDown) {
      console.error('workspace-agent: proxy server closed unexpectedly after startup — exiting to avoid ceding :9200')
      exitFn(1)
    }
  })
  proxy.server.on('error', () => {
    proxyListeningRef.listening = false
    if (proxyBindSucceeded && !shuttingDown) {
      console.error('workspace-agent: proxy server errored unexpectedly after startup — exiting to avoid ceding :9200')
      exitFn(1)
    }
  })

  // AWAIT the :9200 bind attempt to SETTLE (success or failure) before spawning OpenCode. A
  // failed bind is FATAL, the same as the :9100 failure above — log and exitFn(1) WITHOUT ever
  // calling runSupervisedOpencodeFn. This predates the uid split: it used to leave the process in
  // a "degraded mode" (clone API on :9100 still serving) because a stuck bind was only an
  // availability problem. Now that OpenCode runs unprivileged (uid 10001), an unbound :9200 is a
  // free port the agent can bind itself and receive the gateway's bearer token on — degraded mode
  // would hand the agent the control channel it must never hold.
  await proxy
    .listen(PROXY_PORT, HOST)
    .then(() => {
      proxyListeningRef.listening = true
      proxyBindSucceeded = true
    })
    .catch((error: unknown) => {
      proxyListeningRef.listening = false
      const message = error instanceof Error ? error.message : String(error)
      console.error('workspace-agent: proxy failed to bind :9200 — refusing to spawn OpenCode', {message})
      return exitFn(1)
    })

  // Fire-and-forget: supervisor writes status transitions to opencodeStatus.
  // On respawn exhaustion it lands in 'degraded' (clone API still alive; /readyz → 503).
  // Spawned only now — AFTER :9100 is confirmed listening and the :9200 bind attempt has
  // settled — so an unprivileged OpenCode process (uid 10001) can never win a race to bind
  // either control port first.
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
  // Errors are already handled in the .catch() above (which sets status to 'down').
  opencodeServerPromise.catch(() => {
    // Already handled above; this suppresses the linter.
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
