import type {OpenCodeServerHandle} from './server.js'

import {createOpencodeClient} from '@opencode-ai/sdk'

/**
 * Create an `OpenCodeServerHandle` backed by a remote OpenCode server.
 *
 * `close` and `shutdown` are intentional no-ops — the gateway does NOT own the
 * remote server. The `ownsServer` guard in `execution.ts` means an injected
 * handle is never closed by the execution loop. `shutdown` resolves immediately
 * with `quiesced: true`: there is no local child to wait on, so "nothing to wait
 * for" is trivially "already quiesced" rather than an unconfirmed timeout.
 *
 * @param baseUrl  Base URL of the remote server (camelCase per SDK convention).
 * @param headers  HTTP headers merged onto every request, including the SSE
 *                 `/event` subscription (the SDK uses fetch-based SSE, not
 *                 `EventSource`, so custom headers survive on the stream path).
 */
export function createRemoteOpenCodeHandle(
  baseUrl: string,
  headers: Readonly<Record<string, string>> = {},
): OpenCodeServerHandle {
  const client = createOpencodeClient({baseUrl, headers})
  return {
    client,
    server: {
      url: baseUrl,
      close: () => {
        // no-op: gateway does not own the remote server
      },
    },
    shutdown: async () => {
      // no-op: gateway does not own the remote server, so there is nothing to wait on
      return {quiesced: true}
    },
  }
}
