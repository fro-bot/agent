/**
 * workspace-agent entry point.
 *
 * Starts the Hono HTTP server on 0.0.0.0:9100.
 * Starts the OpenCode SDK server bound to 127.0.0.1:54321 (loopback only).
 * Starts the bearer-token proxy on 0.0.0.0:9200 (sandbox-net reachable).
 * Handles SIGTERM gracefully with a 25s drain window.
 */

import type {ProxyListeningRef} from './server.js'
import process from 'node:process'

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

// Shared mutable state for OpenCode readiness, read by /healthz and /readyz.
// The supervisor (runSupervisedOpencode) writes all transitions here.
const opencodeStatus = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

// Shared mutable state for bearer proxy listening state, read by /readyz.
// Set to true when proxy.listen() resolves (OS port bind); cleared on close/error.
// /readyz requires BOTH opencodeStatus === 'ready' AND proxyListening.listening === true.
// Startup false-negative is avoided because the proxy binds (milliseconds) before
// OpenCode finishes booting (seconds), so this is true before opencodeStatus → 'ready'.
const proxyListeningRef: ProxyListeningRef = {listening: false}

// AbortController for the supervised OpenCode lifecycle.
// Aborting this stops the supervisor and reaps the child's process group.
// Required because detached:true puts the child in its OWN process group —
// it does NOT inherit SIGTERM from the parent on container stop.
const opencodeController = new AbortController()

const app = createApp({opencodeStatus, proxyListening: proxyListeningRef})

const server = serve({fetch: app.fetch, port: PORT, hostname: HOST}, info => {
  console.warn(`workspace-agent listening on ${info.address}:${info.port}`)
})

// Boot OpenCode server (loopback-bound) — supervised lifecycle with bounded respawn.
const opencodeLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => console.warn(msg, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(msg, meta ?? ''),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(msg, meta ?? ''),
}

// Fail-fast: throws at startup if WORKSPACE_OPENCODE_READY_TIMEOUT_MS is set but malformed.
const opencodeReadyTimeoutMs = readReadyTimeoutMs()

// Fire-and-forget supervised lifecycle. The supervisor writes status transitions
// to opencodeStatus so /readyz reflects live state. On exhaustion it lands in
// 'degraded' (clone API still alive; /readyz returns 503).
const opencodeServerPromise = runSupervisedOpencode({
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

// Boot bearer-token proxy — reads WORKSPACE_OPENCODE_TOKEN secret at startup
let proxy: ReturnType<typeof createOpencodeProxy> | undefined

try {
  const token = readSecret('WORKSPACE_OPENCODE_TOKEN')
  proxy = createOpencodeProxy({
    token,
    upstreamUrl: `http://${OPENCODE_HOSTNAME}:${OPENCODE_PORT}`,
    logger: opencodeLogger,
  })
  // Wire the proxy listening signal into the readiness state.
  // listen() resolves when the OS assigns the port (milliseconds), which happens
  // before OpenCode finishes booting (seconds). This ensures proxyListeningRef.listening
  // is true before opencodeStatus can transition to 'ready', avoiding a startup
  // false-negative on /readyz.
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
  // Clear the signal if the proxy server closes or errors after startup.
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

// Graceful shutdown on SIGTERM (Docker stop, compose down, etc.)
let shuttingDown = false

function shutdown(signal: string): void {
  if (shuttingDown === true) return
  shuttingDown = true

  console.warn(`workspace-agent: ${signal} received, draining (${DRAIN_MS}ms)`)

  const drainTimer = setTimeout(() => {
    console.error('workspace-agent: drain timeout, forcing exit')
    process.exit(1)
  }, DRAIN_MS)

  // Abort the supervised OpenCode lifecycle — this stops the supervisor and
  // reaps the child's process group via killChildGroup. The child does NOT
  // inherit SIGTERM from the parent because detached:true puts it in its own
  // process group; explicit abort is required to avoid orphaning it.
  opencodeController.abort()

  // Close proxy, then the Hono server.
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

// Export for testing (allows inspecting the promise in integration tests if needed)
export {opencodeServerPromise}
