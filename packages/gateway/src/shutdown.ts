import type {Client} from 'discord.js'

import type {GatewayLogger} from './discord/client.js'

import process from 'node:process'

export const DEFAULT_DRAIN_MS = 25_000

// Todo 008: module-level guard so two installShutdownHandlers calls share state.
// The first handler to see a signal owns the destroy chain; subsequent calls are no-ops.
let shuttingDown = false

/**
 * IMPORTANT for future test authors:
 *
 * `shuttingDown` is module-level state that persists across the entire
 * Vitest worker process via ESM module caching. ANY test file that
 * imports from this module (including indirectly through transitive
 * imports) MUST call `__resetShuttingDownForTests()` in a `beforeEach`
 * block, or its shutdown-related assertions may pass vacuously with
 * stale state from a previous test file.
 *
 * The idempotency test in `shutdown.test.ts` is the canonical example
 * of why this matters: if `shuttingDown` leaks in as `true`, the test
 * will silently pass with 0 exits instead of 1.
 *
 * This export is intentionally prefixed with `__` to flag it as test-
 * only — production code must never call it.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetShuttingDownForTests(): void {
  shuttingDown = false
}

/**
 * Returns true if a shutdown signal has been received and the gateway is draining.
 * Intended for command handlers to check before starting long-running work.
 *
 * This is a pure getter — production code may call it; only `__resetShuttingDownForTests`
 * is test-only.
 */
export function isShuttingDown(): boolean {
  return shuttingDown
}

/** Minimal interface for a closeable server handle (e.g. @hono/node-server ServerType). */
export interface CloseableServer {
  readonly close: (cb?: (err?: Error) => void) => void
}

/**
 * Install SIGTERM and SIGINT handlers that gracefully drain the Discord client
 * and (optionally) an HTTP server.
 *
 * On signal:
 * 1. Log 'shutdown initiated' at info.
 * 2. Optionally await in-flight runs via `awaitInFlight` (bounded by the same drain timer).
 * 3. Race `client.destroy()` AND `server.close()` (if provided) against a drain timer (default 25 s).
 * 4. If both win → log 'shutdown clean', exit 0.
 * 5. If timer wins → log 'shutdown timeout', exit 1.
 * 6. If destroy rejects → log 'shutdown failed', exit 1.
 * 7. If server.close() fails → log a warning but do NOT prevent client teardown result.
 *
 * Returns a cleanup function that removes both signal listeners (useful in tests).
 *
 * Idempotent across multiple installs: if two calls are active and a signal
 * arrives, only the first install's handler runs the destroy chain.
 */
export function installShutdownHandlers(
  client: Client,
  logger: GatewayLogger,
  drainMs: number = DEFAULT_DRAIN_MS,
  server?: CloseableServer,
  awaitInFlight?: () => Promise<void>,
): () => void {
  const handler = (signal: string) => {
    if (shuttingDown) {
      logger.debug({signal}, 'shutdown signal received while already shutting down — ignoring')
      return
    }
    shuttingDown = true

    logger.info({signal}, 'shutdown initiated')

    let drainTimer: ReturnType<typeof setTimeout> | undefined

    const drainTimeout = new Promise<'timeout'>(resolve => {
      drainTimer = setTimeout(() => resolve('timeout'), drainMs)
    })

    // Drain in-flight runs (if a drain function was provided) before destroying the client.
    // Both steps are subject to the same drain timer — if the timer wins first, we proceed.
    const inFlightDrain: Promise<void> = awaitInFlight === undefined ? Promise.resolve() : awaitInFlight()

    const destroyPromise = inFlightDrain
      .then(async () => client.destroy())
      .then(() => 'clean' as const)
      .catch((error: unknown) => {
        logger.warn({err: error}, 'client.destroy() rejected during shutdown')
        return 'failed' as const
      })

    // Close the HTTP server if one was provided. Failure is logged but must NOT
    // prevent client teardown from determining the exit code.
    const serverClosePromise: Promise<void> =
      server === undefined
        ? Promise.resolve()
        : new Promise<void>(resolve => {
            server.close(err => {
              if (err !== undefined && err !== null) {
                logger.warn({err}, 'server.close() failed during shutdown')
              }
              resolve()
            })
          })

    Promise.race([Promise.all([destroyPromise, serverClosePromise]).then(([result]) => result), drainTimeout])
      .then(result => {
        if (drainTimer !== undefined) {
          clearTimeout(drainTimer)
        }
        if (result === 'timeout') {
          logger.warn({}, 'shutdown timeout')
          process.exit(1)
        } else if (result === 'failed') {
          logger.warn({}, 'shutdown failed')
          process.exit(1)
        } else {
          logger.info({}, 'shutdown clean')
          process.exit(0)
        }
      })
      .catch(() => {
        process.exit(1)
      })
  }

  process.on('SIGTERM', handler)
  process.on('SIGINT', handler)

  return () => {
    process.off('SIGTERM', handler)
    process.off('SIGINT', handler)
  }
}
