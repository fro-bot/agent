import type {Logger as RuntimeLogger} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

/**
 * Adapt the gateway's `(context, message)` logger to the runtime's `(message, context)` `Logger` shape.
 *
 * Runtime coordination and ledger-reconciliation primitives take narrower slices of that shape (some only `debug`,
 * some `debug` and `info`); the full four-method result is structurally assignable to each of them.
 */
export function toRuntimeLogger(logger: GatewayLogger): RuntimeLogger {
  return {
    debug: (msg, ctx) => logger.debug(ctx ?? {}, msg),
    info: (msg, ctx) => logger.info(ctx ?? {}, msg),
    warning: (msg, ctx) => logger.warn(ctx ?? {}, msg),
    error: (msg, ctx) => logger.error(ctx ?? {}, msg),
  }
}
