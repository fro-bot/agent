import type {Client} from 'discord.js'

import type {GatewayLogger} from './discord/client.js'

import process from 'node:process'

export const DEFAULT_DRAIN_MS = 25_000

/**
 * Install SIGTERM and SIGINT handlers that gracefully drain the Discord client.
 *
 * On signal:
 * 1. Log 'shutdown initiated' at info.
 * 2. Race `client.destroy()` against a drain timer (default 25 s).
 * 3. If destroy wins → log 'shutdown clean', exit 0.
 * 4. If timer wins → log 'shutdown timeout', exit 1.
 *
 * Returns a cleanup function that removes both signal listeners (useful in tests).
 */
export function installShutdownHandlers(
  client: Client,
  logger: GatewayLogger,
  drainMs: number = DEFAULT_DRAIN_MS,
): () => void {
  const handler = (signal: string) => {
    logger.info({signal}, 'shutdown initiated')

    let drainTimer: ReturnType<typeof setTimeout> | undefined

    const drainTimeout = new Promise<'timeout'>(resolve => {
      drainTimer = setTimeout(() => resolve('timeout'), drainMs)
    })

    const destroyPromise = client
      .destroy()
      .then(() => 'clean' as const)
      .catch((error: unknown) => {
        logger.warn({err: error}, 'client.destroy() rejected during shutdown')
        return 'clean' as const
      })

    Promise.race([destroyPromise, drainTimeout])
      .then(result => {
        if (drainTimer !== undefined) {
          clearTimeout(drainTimer)
        }
        if (result === 'timeout') {
          logger.warn({}, 'shutdown timeout')
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
