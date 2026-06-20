/**
 * Web auto-deny approval transport for the launch route.
 *
 * Web launches have no interactive approval transport yet. Without an explicit
 * createApprovalOnPending, the engine would default to the Discord approval
 * transport — which posts to a non-existent thread and holds the repo lock until
 * the ~13m deadline, blocking ALL runs in that repo.
 *
 * This module provides a web createApprovalOnPending that auto-denies every
 * tool permission request immediately (fail-fast, no lock hold, no Discord
 * transport, no cross-surface confusion).
 *
 * A web-launched run can therefore only complete work that needs no tool
 * approval. Tool-gated steps are denied and the run proceeds/fails accordingly.
 */

import type {PermissionRequest} from '../../approvals/coordinator.js'
import type {ApprovalTransportContext, LaunchWorkRequest} from '../../execute/launch-types.js'
import type {OperatorLogger} from '../server.js'

// ---------------------------------------------------------------------------
// Web auto-deny createApprovalOnPending
// ---------------------------------------------------------------------------

/**
 * Factory for the web auto-deny approval transport.
 *
 * Returns a createApprovalOnPending function suitable for LaunchWorkRequest.
 * When the engine calls this factory with the ApprovalTransportContext, it
 * returns an onPending callback that immediately denies every PermissionRequest
 * by posting 'reject' via postReplyFactory.
 *
 * The deny is fire-and-forget: the callback does not await the reply POST
 * (the coordinator wraps it defensively). This ensures no lock hold and no
 * deadlock regardless of the reply POST outcome.
 *
 * A logger may be provided to surface failed deny POSTs at warn level.
 * When absent, failed deny POSTs are silently swallowed (the coordinator's
 * deadline will eventually settle the entry fail-closed).
 */
export function createWebAutoDenyApproval(
  logger?: OperatorLogger,
): NonNullable<LaunchWorkRequest['createApprovalOnPending']> {
  return (ctx: ApprovalTransportContext): ((request: PermissionRequest) => void) => {
    return (req: PermissionRequest): void => {
      // Auto-deny: immediately reject the permission request.
      // Fire-and-forget: do not await — the coordinator wraps defensively.
      // 'reject' is the deny reply value (OpenCode PermissionReply enum).
      const postReply = ctx.postReplyFactory(req.sessionID)
      // eslint-disable-next-line no-void
      void postReply(req.requestID, ctx.directory, 'reject').catch((error: unknown) => {
        if (logger !== undefined) {
          logger.warn(
            {runId: ctx.runId, repo: ctx.repo, err: error instanceof Error ? error.message : String(error)},
            'web-approval: auto-deny postReply failed (best-effort; coordinator deadline will settle fail-closed)',
          )
        }
      })
    }
  }
}
