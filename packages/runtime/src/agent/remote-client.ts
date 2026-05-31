import type {OpenCodeServerHandle} from './server.js'

import {createOpencodeClient} from '@opencode-ai/sdk'

/**
 * Create an `OpenCodeServerHandle` backed by a remote OpenCode server.
 *
 * `close` and `shutdown` are intentional no-ops — the gateway does NOT own the
 * remote server. The `ownsServer` guard in `execution.ts` means an injected
 * handle is never closed by the execution loop.
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
    shutdown: () => {
      // no-op: gateway does not own the remote server
    },
  }
}
