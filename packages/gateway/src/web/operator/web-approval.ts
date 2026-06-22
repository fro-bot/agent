/**
 * Web approval transport for the launch route.
 *
 * Registers each tool-permission request in the approval registry and fans out
 * an SSE approval frame so the operator can see and decide it.
 *
 * ### register-before-fan-out
 *
 * The registry entry is registered BEFORE the SSE frame is emitted. This
 * ensures a decision can settle even if the SSE send is dropped — the registry
 * is the authoritative fail-closed gate; the frame is advisory.
 *
 * ### fail-soft fan-out
 *
 * If `observeApproval` throws or rejects, the error is logged at warn level
 * and swallowed. The registration already happened and the deadline still
 * settles fail-closed.
 *
 * ### no visible-output claim
 *
 * The approval frame is a UI event, not agent output. This transport does NOT
 * call `markVisibleOutputPending` or `markVisibleOutputSent` — those are
 * Discord-specific concerns for the waiting-status message.
 */

import type {PermissionRequest} from '../../approvals/coordinator.js'
import type {ApprovalTransportContext, LaunchWorkRequest} from '../../execute/launch-types.js'
import type {ApprovalFrameData} from '../../operator-contract/approval-frame.js'
import type {OperatorLogger} from '../server.js'
import {boundApprovalDetail} from '../../approvals/approval-detail.js'

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface WebApprovalTransportDeps {
  /**
   * Fan-out function for approval frames. Mirrors the per-run closure wired
   * at the launch route (same pattern as observeOutput).
   *
   * Called with the runId and the bounded ApprovalFrameData after the registry
   * entry is registered. Fail-soft: errors are logged at warn and swallowed.
   */
  readonly observeApproval: (runId: string, data: ApprovalFrameData) => void
  /** Structured logger. */
  readonly logger: OperatorLogger
}

// ---------------------------------------------------------------------------
// createWebApprovalOnPending
// ---------------------------------------------------------------------------

/**
 * Factory for the web approval transport.
 *
 * Returns a `createApprovalOnPending` function suitable for
 * `LaunchWorkRequest.createApprovalOnPending`. When the engine calls this
 * factory with the `ApprovalTransportContext`, it returns an `onPending`
 * callback that:
 *
 * 1. Registers the request in the approval registry with
 *    `approvalScopeId = ctx.runId` (register-before-fan-out).
 * 2. Calls `observeApproval(ctx.runId, boundDetail)` to fan out the SSE
 *    approval frame, applying `boundApprovalDetail` to command/filepath.
 *
 * The fan-out is fail-soft: if `observeApproval` throws, the error is logged
 * at warn and swallowed. The registration already happened and the deadline
 * still settles fail-closed.
 */
export function createWebApprovalOnPending(
  deps: WebApprovalTransportDeps,
): NonNullable<LaunchWorkRequest['createApprovalOnPending']> {
  const {observeApproval, logger} = deps

  return (ctx: ApprovalTransportContext): ((request: PermissionRequest) => void) => {
    return (req: PermissionRequest): void => {
      const {requestID, sessionID} = req

      // Per-request postReply closure — captures sessionID for the SDK call.
      const postReplyForRequest = ctx.postReplyFactory(sessionID)

      // register-before-fan-out: register the entry in the shared registry
      // BEFORE emitting the SSE frame. This ensures a decision can settle
      // even if the SSE send is dropped.
      ctx.approvalRegistry.register({
        requestID,
        sessionID,
        approvalScopeId: ctx.runId,
        directory: ctx.directory,
        request: req,
        effects: {postReply: postReplyForRequest},
        deadlineMs: ctx.approvalDeadlineMs,
      })

      // Build the bounded frame data. Apply boundApprovalDetail to command and
      // filepath here — the caller (this transport) is responsible for bounding
      // per the U2 contract.
      const boundedCommand = boundApprovalDetail(req.command)
      const boundedFilepath = boundApprovalDetail(req.filepath)

      const frameData: ApprovalFrameData = {
        requestID,
        permission: req.permission,
        ...(boundedCommand !== undefined && boundedCommand.length > 0 ? {command: boundedCommand} : {}),
        ...(boundedFilepath !== undefined && boundedFilepath.length > 0 ? {filepath: boundedFilepath} : {}),
        settled: false,
      }

      // Fan out the SSE approval frame. Fail-soft: if observeApproval throws,
      // log at warn and continue — the registration already happened and the
      // deadline still settles fail-closed.
      try {
        observeApproval(ctx.runId, frameData)
      } catch (error: unknown) {
        logger.warn(
          {
            runId: ctx.runId,
            repo: ctx.repo,
            requestID,
            err: error instanceof Error ? error.message : String(error),
          },
          'web-approval: observeApproval threw (fail-soft; registry entry registered, deadline will settle)',
        )
      }
    }
  }
}
