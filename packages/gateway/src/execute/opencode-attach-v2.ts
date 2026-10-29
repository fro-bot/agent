/**
 * Remote-attach client for an OpenCode V2 workspace: the V2 sibling of `opencode-attach.ts`.
 *
 * Injects the workspace bearer token as an `Authorization` header on every request, including the SSE `/event`
 * subscription. The proxy swaps it for the server's own credentials.
 *
 * Security invariant: the token is NEVER logged.
 */

import type {RemoteOpenCodeV2Client} from '@fro-bot/runtime'

import {createRemoteOpenCodeV2Client} from '@fro-bot/runtime'
import {workspaceAuthHeaders} from './workspace-auth.js'

/**
 * @param baseURL  Full base URL of the workspace proxy (e.g. `http://workspace:9200`).
 * @param token    Bearer secret for the workspace proxy. Never logged.
 */
export function attachOpencodeV2(baseURL: string, token: string): RemoteOpenCodeV2Client {
  return createRemoteOpenCodeV2Client({baseUrl: baseURL, headers: workspaceAuthHeaders(token)})
}
