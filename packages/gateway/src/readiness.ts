import type {GatewayLogger} from './discord/client.js'

import {unlinkSync, writeFileSync} from 'node:fs'
import process from 'node:process'

// ---------------------------------------------------------------------------
// Gateway readiness flag — /var/run/fro-bot/gateway-ready
//
// The Dockerfile healthcheck polls for this file. It is written when the
// Discord `clientReady` event fires (i.e. the bot is fully connected and
// ready to receive events). It is cleared at process startup so a stale flag
// from a prior process cannot mask a current-run failure.
//
// Re-arm behaviour: `clientReady`, `shardReady`, and `shardResume` all write
// the flag so reconnects re-arm the healthcheck. `shardDisconnect` clears the
// flag so the healthcheck goes red during a disconnect, preventing a stale
// green from masking an outage.
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the Discord client subset used by readiness setup.
 * Avoids importing the full discord.js Client type in tests.
 */
export interface ReadinessClient {
  on: (
    event: 'clientReady' | 'shardReady' | 'shardResume' | 'shardDisconnect',
    listener: (...args: unknown[]) => void,
  ) => this
}

/**
 * Clears any stale readiness flag from a prior process, then registers
 * persistent listeners that write the flag on `clientReady`, `shardReady`,
 * and `shardResume`, and clear it on `shardDisconnect`.
 *
 * Using `on` (not `once`) means reconnects re-write the flag and each
 * disconnect clears it, keeping the healthcheck accurate across the full
 * session lifetime.
 *
 * Must be called BEFORE `client.login()` so the event cannot be missed.
 *
 * @param client - Discord client (or compatible mock)
 * @param logger - Structured logger
 * @param flagPath - Path to the readiness flag file (default: /var/run/fro-bot/gateway-ready)
 */
export function setupReadinessFlag(
  client: ReadinessClient,
  logger: GatewayLogger,
  flagPath = process.env.FRO_BOT_READY_FLAG_PATH ?? '/var/run/fro-bot/gateway-ready',
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

  const writeFlag = (origin: string): void => {
    try {
      writeFileSync(flagPath, '', {mode: 0o600})
      logger.info({origin}, 'wrote gateway-ready flag')
    } catch (error) {
      logger.error({err: error, origin}, 'failed to write gateway-ready flag')
    }
  }

  const clearFlag = (origin: string): void => {
    try {
      unlinkSync(flagPath)
      logger.info({origin}, 'cleared gateway-ready flag')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // Already absent — that's fine.
        return
      }
      // Log and continue. Crashing the gateway during a disconnect is
      // strictly worse than leaving the flag in place — the next disconnect
      // or process exit will eventually clear it.
      logger.error({err: error, origin}, 'failed to clear gateway-ready flag')
    }
  }

  // Register listeners BEFORE login() so events cannot be missed.
  // Use `on` (not `once`) so reconnects re-write the flag.
  client.on('clientReady', () => writeFlag('clientReady'))
  client.on('shardReady', () => writeFlag('shardReady'))
  client.on('shardResume', () => writeFlag('shardResume'))
  client.on('shardDisconnect', () => clearFlag('shardDisconnect'))
}
