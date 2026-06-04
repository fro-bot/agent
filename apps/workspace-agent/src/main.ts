/**
 * workspace-agent entry point.
 *
 * Starts the Hono HTTP server on 0.0.0.0:9100.
 * Starts the OpenCode SDK server bound to 127.0.0.1:54321 (loopback only).
 * Starts the bearer-token proxy on 0.0.0.0:9200 (sandbox-net reachable).
 * Handles SIGTERM gracefully with a 25s drain window.
 */

import process from 'node:process'
import {serve} from '@hono/node-server'

import {asyncCleanupAllAskpassDirs} from './clone.js'
import {readReadyTimeoutMs, readSecret} from './config.js'
import {createOpencodeProxy} from './opencode-proxy.js'
import {startOpencodeServer} from './opencode-server.js'
import {createApp} from './server.js'

const PORT = 9100
const HOST = '0.0.0.0'
const DRAIN_MS = 25_000
const OPENCODE_PORT = 54321
const OPENCODE_HOSTNAME = '127.0.0.1'
const PROXY_PORT = 9200
const WORKSPACE_REPOS_ROOT = '/workspace/repos'

// Shared mutable state for OpenCode readiness, read by /healthz
const opencodeStatus = {status: 'starting' as 'starting' | 'ready' | 'down'}

const app = createApp({opencodeStatus})

const server = serve({fetch: app.fetch, port: PORT, hostname: HOST}, info => {
  console.warn(`workspace-agent listening on ${info.address}:${info.port}`)
})

// Boot OpenCode server (loopback-bound) — fire-and-forget, update status ref
const opencodeLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => console.warn(msg, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(msg, meta ?? ''),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(msg, meta ?? ''),
}

let opencodeHandle: {url: string; close: () => void} | undefined

// Fail-fast: throws at startup if WORKSPACE_OPENCODE_READY_TIMEOUT_MS is set but malformed.
const opencodeReadyTimeoutMs = readReadyTimeoutMs()

const opencodeServerPromise = startOpencodeServer({
  rootDir: WORKSPACE_REPOS_ROOT,
  logger: opencodeLogger,
  hostname: OPENCODE_HOSTNAME,
  port: OPENCODE_PORT,
  readyTimeoutMs: opencodeReadyTimeoutMs,
})
  .then(handle => {
    opencodeHandle = handle
    opencodeStatus.status = 'ready'
    console.warn('workspace-agent: opencode server ready', {url: handle.url})
  })
  .catch((error: unknown) => {
    opencodeStatus.status = 'down'
    const message = error instanceof Error ? error.message : String(error)
    console.error('workspace-agent: opencode server failed to start', {message})
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
  proxy.listen(PROXY_PORT, HOST).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('workspace-agent: proxy failed to start', {message})
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

  // Close OpenCode server and proxy, then the Hono server.
  const cleanupOpencode = (): void => {
    if (opencodeHandle !== undefined) {
      opencodeHandle.close()
    }
  }

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
      cleanupOpencode()
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
