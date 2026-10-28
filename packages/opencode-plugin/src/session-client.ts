/**
 * Adapts the plugin context's `ctx.session` to the runtime's `SessionClientV2`.
 *
 * Facts verified against a real v2.2.0 server loading a plugin:
 * - `ctx.session.list` resolves to `{data, cursor}`; `get` and `context` resolve to the bare payload.
 * - A missing session rejects with a tagged error `{_tag: 'Session.NotFoundError'}` and an empty message.
 * - An id that does not start with `ses` rejects with a `SchemaError`, before any lookup.
 */

import type {SessionClientV2, SessionListQueryV2} from '@fro-bot/runtime/session-v2'

/**
 * The slice of `ctx.session` this package reads. Declared with method syntax so TypeScript checks it bivariantly: the
 * real methods take a branded `SessionID`, which this package only ever has as a plain string.
 */
export interface PluginSessionApi {
  list: (query: SessionListQueryV2) => Promise<unknown>
  get: (input: {readonly sessionID: string}) => Promise<unknown>
  context: (input: {readonly sessionID: string}) => Promise<unknown>
}

const SESSION_ID_PREFIX = 'ses'
const NOT_FOUND_TAG = 'Session.NotFoundError'

export function isSessionNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, '_tag') === NOT_FOUND_TAG
}

export function createPluginSessionClient(session: PluginSessionApi): SessionClientV2 {
  return {
    list: async query => session.list(query),
    async get(sessionID) {
      // The server's schema rejects such an id with a SchemaError, which would read as an outage. It cannot exist.
      if (!sessionID.startsWith(SESSION_ID_PREFIX)) return null
      try {
        return await session.get({sessionID})
      } catch (error) {
        if (isSessionNotFound(error)) return null
        throw error
      }
    },
    messages: async sessionID => session.context({sessionID}),
  }
}
