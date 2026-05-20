import type {GatewayLogger} from './discord/client.js'

import {unlinkSync, writeFileSync} from 'node:fs'

// ---------------------------------------------------------------------------
// Gateway readiness flag — /tmp/gateway-ready
//
// The Dockerfile healthcheck polls for this file. It is written when the
// Discord `clientReady` event fires (i.e. the bot is fully connected and
// ready to receive events). It is cleared at process startup so a stale flag
// from a prior process cannot mask a current-run failure.
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the Discord client subset used by readiness setup.
 * Avoids importing the full discord.js Client type in tests.
 */
export interface ReadinessClient {
  once: (event: 'clientReady', listener: () => void) => this
}

/**
 * Clears any stale readiness flag from a prior process, then registers a
 * one-time `clientReady` listener that writes the flag when Discord confirms
 * the bot is fully connected.
 *
 * Must be called BEFORE `client.login()` so the event cannot be missed.
 *
 * @param client - Discord client (or compatible mock)
 * @param logger - Structured logger
 * @param flagPath - Path to the readiness flag file (default: /tmp/gateway-ready)
 */
export function setupReadinessFlag(
  client: ReadinessClient,
  logger: GatewayLogger,
  flagPath = '/tmp/gateway-ready',
): void {
  // Clear any stale flag from a prior process. ENOENT is expected on fresh
  // containers and is silently ignored. Other errors are non-fatal here
  // because the flag-file is best-effort — permission errors will surface
  // when we try to writeFileSync below.
  try {
    unlinkSync(flagPath)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      logger.warn({err: error}, 'failed to clear stale gateway-ready flag')
    }
  }

  // Register the listener BEFORE login() so the event cannot be missed.
  client.once('clientReady', () => {
    try {
      writeFileSync(flagPath, '')
      logger.info({}, 'gateway ready')
    } catch (error) {
      logger.error({err: error}, 'failed to write gateway-ready flag')
    }
  })
}
