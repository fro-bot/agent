/**
 * The approval reply for a run on OpenCode V1: `POST /session/{id}/permissions/{permissionID}` through the V1 SDK
 * handle. The V2 side is `createPostReplyFactoryV2` (`permission-reply-v2.ts`).
 *
 * The gateway NEVER sends `always`: V1 would append it to an in-memory `approved` list keyed by the DIRECTORY, so a
 * later session in the same checkout would inherit it (fro-bot/agent#1990). An operator `always` goes out as `once`
 * ({@link replyUpstream}) and the gateway keeps the grant itself, for the run only (`approvals/run-grants.ts`).
 */

import type {OpenCodeServerHandle} from '@fro-bot/runtime'
import type {PostReplyFactory} from './launch-types.js'

import {formatSdkError, toErrorMessage} from '@fro-bot/runtime'
import {replyUpstream} from '../approvals/run-grants.js'

export function createPostReplyFactoryV1(handle: Pick<OpenCodeServerHandle, 'client'>): PostReplyFactory {
  return sessionID => async (rID, dir, decision) => {
    // Call the OpenCode SDK permission reply endpoint.
    // Uses the session-scoped API: POST /session/{id}/permissions/{permissionID}
    try {
      const res = await handle.client.postSessionIdPermissionsPermissionId({
        path: {id: sessionID, permissionID: rID},
        body: {response: replyUpstream(decision)},
        query: {directory: dir},
        signal: AbortSignal.timeout(10_000),
      })
      const envelope = res as {error?: unknown} | undefined
      if (envelope?.error != null) {
        return {ok: false as const, error: formatSdkError(envelope.error)}
      }
      return {ok: true as const}
    } catch (error) {
      return {ok: false as const, error: toErrorMessage(error)}
    }
  }
}
