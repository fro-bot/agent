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
 * ### two halves
 *
 * {@link createWebApprovalOnRegistered} is the announce half: it attaches the settle renderer and emits the open
 * frame for a request some transport has ALREADY registered. A Discord-launched run uses it alone (the Discord
 * transport registers), so the run's SSE subscribers see its approvals like a web run's.
 * {@link createWebApprovalOnPending} is register + announce, for web-launched runs.
 *
 * ### no visible-output claim
 *
 * The approval frame is a UI event, not agent output. This transport does NOT
 * call `markVisibleOutputPending` or `markVisibleOutputSent` — those are
 * Discord-specific concerns for the waiting-status message.
 */

import type {PermissionReply, PermissionRequest, SettlementReason} from '../../approvals/coordinator.js'
import type {ApprovalActor, ApprovalRegistry} from '../../approvals/registry.js'
import type {ApprovalTransportContext, LaunchWorkRequest} from '../../execute/launch-types.js'
import type {ApprovalFrameData} from '../../operator-contract/approval-frame.js'
import type {OperatorLogger} from '../server.js'
import {toErrorMessage} from '@fro-bot/runtime'
import {boundApprovalDetail} from '../../approvals/approval-detail.js'

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Per-run context of the announce half. */
export interface WebApprovalAnnounceContext {
  /** Program-scoped registry; the announcer attaches its settle renderer here. */
  readonly approvalRegistry: Pick<ApprovalRegistry, 'attachMessage'>
  /** Stable UUID for this run; the SSE fan-out key. */
  readonly runId: string
  /** `owner/repo` for logging and correlation. */
  readonly repo: string
}

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
// createWebApprovalOnRegistered
// ---------------------------------------------------------------------------

/**
 * Factory for the announce half of the web approval transport.
 *
 * Returns, per run, a hook to call AFTER the request is registered in the registry. It:
 *
 * 1. Attaches a settle renderer FIRST, so the `settled: true` frame is emitted on every settlement path
 *    (decision echo, deadline, cascade, supersede, teardown) even if the open frame below was dropped or the
 *    other transport's card never posted. Fail-soft: a throw is logged and swallowed (the settlement happened).
 * 2. Emits the open frame with `command` / `filepath` bounded by `boundApprovalDetail`. Fail-soft likewise.
 */
export function createWebApprovalOnRegistered(
  deps: WebApprovalTransportDeps,
): (ctx: WebApprovalAnnounceContext) => (request: PermissionRequest) => void {
  const {observeApproval, logger} = deps

  return (ctx: WebApprovalAnnounceContext): ((request: PermissionRequest) => void) => {
    return (req: PermissionRequest): void => {
      const {requestID} = req

      // The renderer is attached before the open frame. It runs on EVERY settlement path.
      ctx.approvalRegistry.attachMessage(
        requestID,
        async (
          _permReq: PermissionRequest,
          _decision: PermissionReply,
          _actor: ApprovalActor | null,
          _reason: SettlementReason,
        ): Promise<void> => {
          try {
            observeApproval(ctx.runId, {requestID, settled: true})
          } catch (error: unknown) {
            logger.warn(
              {runId: ctx.runId, requestID, err: toErrorMessage(error)},
              'web-approval: renderFn settle-frame threw (fail-soft; settlement already applied)',
            )
          }
        },
      )

      // Build the bounded frame data. Apply boundApprovalDetail to command and
      // filepath here — this transport is responsible for bounding the raw
      // approval detail before it is sent in the SSE frame.
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
          {runId: ctx.runId, repo: ctx.repo, requestID, err: toErrorMessage(error)},
          'web-approval: observeApproval threw (fail-soft; registry entry registered, deadline will settle)',
        )
      }
    }
  }
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
 *    `approvalScopeId = ctx.runId` and `runId = ctx.runId` (register-before-fan-out).
 * 2. Announces it (see {@link createWebApprovalOnRegistered}).
 */
export function createWebApprovalOnPending(
  deps: WebApprovalTransportDeps,
): NonNullable<LaunchWorkRequest['createApprovalOnPending']> {
  const announce = createWebApprovalOnRegistered(deps)

  return (ctx: ApprovalTransportContext): ((request: PermissionRequest) => void) => {
    const announceForRun = announce(ctx)
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
        runId: ctx.runId,
        directory: ctx.directory,
        request: req,
        effects: {postReply: postReplyForRequest},
        deadlineMs: ctx.approvalDeadlineMs,
      })

      announceForRun(req)
    }
  }
}
