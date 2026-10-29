/**
 * The approval reply for a run on OpenCode V2: the V2 side of `postReplyFactory` in `run.ts`.
 *
 * A permission reply is `POST /api/session/:sessionID/permission/:requestID/reply` with `{decision}`, where decision is
 * `once`, `always` or `reject` (`packages/protocol/src/groups/permission.ts` at `anomalyco/opencode@v2.2.0`). It is keyed
 * by REQUEST id: two approvals raised from one `execute` call share the call id and differ in request id (probe P5), so
 * each Discord decision answers exactly its own request. The approval coordinator and registry above this are unchanged.
 *
 * Failures collapse to a short code. A response body can echo the command or path being approved.
 */

import type {RemoteOpenCodeV2Client, V2CallError} from '@fro-bot/runtime'
import type {PostReplyFactory} from './launch-types.js'

/** Per-call bound; a hung workspace must not pin a settlement. */
const PERMISSION_REPLY_TIMEOUT_MS = 10_000

function describe(error: V2CallError): string {
  return error.kind === 'auth' || error.kind === 'http' ? `${error.kind} ${error.status}` : error.kind
}

export function createPostReplyFactoryV2(client: RemoteOpenCodeV2Client): PostReplyFactory {
  return sessionId => async (requestId, _directory, decision) => {
    try {
      const result = await client.replyPermission({
        sessionId,
        requestId,
        decision,
        signal: AbortSignal.timeout(PERMISSION_REPLY_TIMEOUT_MS),
      })
      return result.success ? {ok: true} : {ok: false, error: describe(result.error)}
    } catch {
      return {ok: false, error: 'threw'}
    }
  }
}
