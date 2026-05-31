/**
 * Remote-attach client for the gateway.
 *
 * Wraps `createRemoteOpenCodeHandle` from the runtime, injecting the
 * workspace bearer token as an `Authorization` header. The header is
 * threaded automatically to both HTTP calls (e.g. `promptAsync`) and the
 * SSE `/event` subscription — the SDK uses fetch-based SSE (confirmed in
 * Unit 0 spike), so custom headers survive on the stream path.
 *
 * Security invariant: the token is NEVER logged.
 */

import type {OpenCodeServerHandle} from '@fro-bot/runtime'

import {createRemoteOpenCodeHandle} from '@fro-bot/runtime'

/**
 * Build an `OpenCodeServerHandle` attached to a remote workspace OpenCode
 * server.
 *
 * `close` and `shutdown` on the returned handle are no-ops — the gateway
 * does not own the remote server and must not shut it down.
 *
 * @param baseURL  Full base URL of the workspace proxy
 *                 (e.g. `http://workspace:9101`).
 * @param token    Bearer secret for the workspace proxy. Never logged.
 */
export function attachOpencode(baseURL: string, token: string): OpenCodeServerHandle {
  // Authorization header injected here — never passed through to a logger.
  return createRemoteOpenCodeHandle(baseURL, {Authorization: `Bearer ${token}`})
}
