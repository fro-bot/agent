/**
 * workspace-agent entry point.
 *
 * Starts the Hono HTTP server on 0.0.0.0:9100.
 * Handles SIGTERM gracefully with a 25s drain window.
 */

import process from 'node:process'
import {serve} from '@hono/node-server'

import {asyncCleanupAllAskpassDirs} from './clone.js'
import {createApp} from './server.js'

const PORT = 9100
const HOST = '0.0.0.0'
const DRAIN_MS = 25_000

const app = createApp()

const server = serve({fetch: app.fetch, port: PORT, hostname: HOST}, info => {
  console.warn(`workspace-agent listening on ${info.address}:${info.port}`)
})

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

  // Clean up all in-flight askpass dirs before closing the server.
  // This runs after any in-flight clone AbortControllers have been signalled
  // (they abort on their own timeout; we just wait for their finally blocks).
  asyncCleanupAllAskpassDirs()
    .catch(() => {
      // Best-effort; proceed to server.close regardless.
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
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
