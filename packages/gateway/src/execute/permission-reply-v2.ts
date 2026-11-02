/**
 * The approval reply for a run on OpenCode V2: the V2 side of `postReplyFactory` in `run.ts`.
 *
 * A permission reply is `POST /api/session/:sessionID/permission/:requestID/reply` with `{decision, message?}`, where
 * decision is `once`, `always` or `reject` (`packages/protocol/src/groups/permission.ts` at
 * `anomalyco/opencode@v2.2.0`). The gateway NEVER sends `always`: upstream would store it as a saved-permission row
 * keyed by the whole project, outliving the run (fro-bot/agent#1990). An operator `always` goes out as `once`
 * ({@link replyUpstream}) and the gateway keeps the grant itself, for the run only (`approvals/run-grants.ts`). It is
 * keyed by REQUEST id: two approvals raised from one `execute` call share the call id and differ in request id (probe
 * P5), so each Discord decision answers exactly its own request. The approval coordinator and registry above this are
 * unchanged.
 *
 * Failures collapse to a short code. A response body can echo the command or path being approved.
 */

import type {RemoteOpenCodeV2Client, V2CallError} from '@fro-bot/runtime'
import type {PostReplyFactory} from './launch-types.js'

import {replyUpstream} from '../approvals/run-grants.js'

/**
 * Sent with every `reject`. Upstream treats a bare reject as the end of the execution (`interrupted`, reason `shutdown`,
 * claim left resumable, so the run fails and the repo is quarantined), but a reject with a message as a failed tool the
 * model reads before its next step, which is what the operator meant (fro-bot/agent#2001). Upstream applies the message
 * to every ask pending in the session. Dispose and teardown rejects carry it too: the run is ending anyway.
 */
export const OPERATOR_REJECT_MESSAGE_V2 =
  "The operator rejected this request. Don't retry it; continue without it, or explain what you need."

/** Per-call bound; a hung workspace must not pin a settlement. */
const PERMISSION_REPLY_TIMEOUT_MS = 10_000

function describe(error: V2CallError): string {
  return error.kind === 'auth' || error.kind === 'http' ? `${error.kind} ${error.status}` : error.kind
}

export function createPostReplyFactoryV2(client: RemoteOpenCodeV2Client): PostReplyFactory {
  return sessionId => async (requestId, _directory, decision) => {
    try {
      const upstream = replyUpstream(decision)
      const result = await client.replyPermission({
        sessionId,
        requestId,
        decision: upstream,
        ...(upstream === 'reject' ? {message: OPERATOR_REJECT_MESSAGE_V2} : {}),
        signal: AbortSignal.timeout(PERMISSION_REPLY_TIMEOUT_MS),
      })
      return result.success ? {ok: true} : {ok: false, error: describe(result.error)}
    } catch {
      return {ok: false, error: 'threw'}
    }
  }
}
