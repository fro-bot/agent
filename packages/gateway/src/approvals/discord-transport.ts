/**
 * Discord approval transport.
 *
 * Owns the Discord-specific side of the approval flow:
 * - Renders the approval embed + buttons and posts them via `replySink.send`.
 * - Registers the entry in the approval registry (register-before-send pattern).
 * - Attaches the settled-embed render function once the message is posted.
 * - Creates the per-request `postReply` closure that captures `sessionID`
 *   (the one documented Discord-specific cast in the approval path — the
 *   `result as Message` cast for `attachMessage`; widen `ReplySink.send` to
 *   return a typed result when a web transport needs it).
 *
 * Returns a `PermissionCoordinatorDeps`-compatible `onPending` callback that
 * the engine wires into `createPermissionCoordinator`. A future web transport
 * would supply its own `onPending` (notification + HTTP callback) without
 * touching this module.
 *
 * ### Transport seam
 *
 * The engine's `onPending` hook is the transport-neutral extension point.
 * This module is the Discord implementation of that hook. A future web
 * transport would create its own module implementing the same hook shape.
 *
 * ### register-before-send
 *
 * The registry entry is registered BEFORE the embed is posted so the button
 * handler can look up the entry even if the send is still in-flight.
 * `attachMessage` is called after a successful send to wire the render function.
 * `markMessagePostFailed` is called on send failure so the entry stays
 * registered (the permission can still be POSTed when it settles).
 */

import type {Message} from 'discord.js'

import type {GatewayLogger} from '../discord/client.js'
import type {ReplySink} from '../execute/launch-types.js'
import type {PermissionReply, PermissionRequest, SettlementReason} from './coordinator.js'
import type {ApprovalActor, ApprovalRegistry} from './registry.js'

import {buildApprovalButtons, buildApprovalEmbed, buildSettledEmbed} from '../discord/approvals.js'
import {editMessage} from '../discord/io.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Factory for the per-request `postReply` function.
 *
 * The transport calls this once per `onPending` invocation to create a closure
 * that captures the per-request `sessionID`. The factory receives the
 * `sessionID` and returns a function that POSTs the decision to OpenCode.
 *
 * This is the seam that keeps the SDK call inside the transport (a clean
 * Discord/OpenCode concern) while letting the engine remain transport-neutral.
 */
export type PostReplyFactory = (
  sessionID: string,
) => (
  requestID: string,
  directory: string,
  decision: PermissionReply,
) => Promise<{readonly ok: boolean; readonly error?: string}>

export interface DiscordApprovalTransportDeps {
  /** Program-scoped approval registry shared with the button handler. */
  readonly approvalRegistry: ApprovalRegistry
  /** Per-run reply sink — used to post the embed and the waiting-status message. */
  readonly replySink: ReplySink
  /**
   * Thread ID for the approval scope binding.
   * Set by the thread factory after thread creation; empty string for non-Discord paths.
   * Used as `approvalScopeId` in the registry so the button handler can verify
   * the interaction came from the correct thread/channel.
   */
  readonly threadId: string
  /** Workspace directory for reply routing (passed to registry.register). */
  readonly directory: string
  /** Per-approval deadline in ms (passed to registry.register). */
  readonly approvalDeadlineMs: number | undefined
  /**
   * Optional callback invoked when the deadline fires on an open entry.
   * Passed to registry.register as `onDeadlineSettled`.
   */
  readonly onDeadlineSettled: (() => void | Promise<void>) | undefined
  /**
   * Factory for the per-request `postReply` closure.
   * Called once per `onPending` invocation with the request's `sessionID`.
   */
  readonly postReplyFactory: PostReplyFactory
  readonly logger: GatewayLogger
}

// ---------------------------------------------------------------------------
// createDiscordApprovalOnPending
// ---------------------------------------------------------------------------

/**
 * Create the Discord `onPending` callback for `createPermissionCoordinator`.
 *
 * The returned function is the Discord transport implementation of the
 * transport-neutral `PermissionCoordinatorDeps.onPending` hook. It:
 * 1. Creates the per-request `postReply` closure (captures `sessionID`).
 * 2. Registers the entry in the approval registry (register-before-send).
 * 3. Posts a "Waiting for tool approval…" status message (fire-and-forget).
 * 4. Posts the approval embed + buttons (fire-and-forget).
 * 5. Attaches the settled-embed render function on success.
 *
 * Must not throw — the coordinator wraps it defensively.
 *
 * @param deps - Discord transport dependencies.
 */
export function createDiscordApprovalOnPending(
  deps: DiscordApprovalTransportDeps,
): (request: PermissionRequest) => void {
  const {
    approvalRegistry,
    replySink,
    threadId,
    directory,
    approvalDeadlineMs,
    onDeadlineSettled,
    postReplyFactory,
    logger,
  } = deps

  return function onPending(req: PermissionRequest): void {
    const {requestID, sessionID} = req

    // Per-request postReply closure — captures sessionID for the SDK call.
    // FIX 4: AbortSignal.timeout(10_000) is used inside the factory to avoid
    // the dangling-timer leak from the old Promise.race approach.
    const postReplyForRequest = postReplyFactory(sessionID)

    // register-before-send: register the entry in the shared registry
    // BEFORE attempting the Discord embed post. This ensures the button
    // handler can look up the entry even if the send is still in-flight.
    // Registry owns the deadline timer (single-owner rule).
    //
    // approvalScopeId: use threadId (set by threadFactory after thread creation).
    // For non-Discord paths (in-memory sinks), threadId is '' — the registry
    // still works; the approvalScopeId is only used for button-handler lookup.
    approvalRegistry.register({
      requestID,
      sessionID,
      approvalScopeId: threadId,
      directory,
      request: req,
      effects: {postReply: postReplyForRequest},
      deadlineMs: approvalDeadlineMs,
      onDeadlineSettled,
    })

    // Post a visible waiting-for-approval status BEFORE the embed so the
    // user sees the run is blocked even if the embed send is slow.
    // Fire-and-forget: status is best-effort; must not block onPending.
    //
    // Pending-visibility: mark the send as in-flight BEFORE the void send so
    // timeout classification sees it as visible context even if the Discord
    // round-trip has not completed yet. settle(true) on success promotes to
    // permanently delivered; settle(false) on failure retracts the claim.
    const settleWaitingStatus = replySink.markVisibleOutputPending()
    // eslint-disable-next-line no-void
    void replySink.send('thread', {content: 'Waiting for tool approval\u2026'}).then(result => {
      // replySink.send returns unknown; cast to check success (one documented cast).
      const r = result as {success?: boolean; error?: {message: string}} | undefined
      if (r?.success === true) {
        settleWaitingStatus(true)
      } else {
        settleWaitingStatus(false)
        logger.warn(
          {requestID, err: r?.error?.message ?? 'unknown'},
          'discord-transport: failed to post waiting-for-approval status',
        )
      }
    })

    // Fire-and-forget: send the embed then attach the render function.
    // onPending must not throw (coordinator catches internally anyway).
    //
    // Pending-visibility: same pattern as the waiting-status send above —
    // mark in-flight before the void send, settle on resolution.
    //
    // replySink.send returns unknown; cast to get the posted message reference
    // for attachMessage (Discord impl returns Result<Message, ...>).
    // This is the one documented Discord-specific cast in the approval transport —
    // the `result as Message` cast is resolved here (inside the transport where
    // it's a clean Discord concern). Widen ReplySink.send to return a typed
    // result when a web transport needs the posted message reference.
    const settleEmbed = replySink.markVisibleOutputPending()
    // eslint-disable-next-line no-void
    void replySink
      .send('thread', {embeds: [buildApprovalEmbed(req)], components: [buildApprovalButtons(requestID)]})
      .then(result => {
        const r = result as {success?: boolean; data?: Message; error?: {message: string}} | undefined
        if (r?.success === true) {
          // Embed send succeeded — settle pending claim as delivered so
          // flush() does not add a misleading _(no output)_.
          settleEmbed(true)
          const postedMessage = r.data
          if (postedMessage !== undefined) {
            // Attach the render function now that we have a message reference.
            // The `result as Message` cast is resolved here — inside the Discord
            // transport where it's a clean Discord concern.
            approvalRegistry.attachMessage(
              requestID,
              async (
                permReq: PermissionRequest,
                decision: PermissionReply,
                actor: ApprovalActor | null,
                reason: SettlementReason,
              ) => {
                // Derive a display string from the typed actor for the settled embed.
                // Discord-specific: extract the userId for the decidedBy display.
                const decidedBy =
                  actor === null ? null : actor.kind === 'discord-user' ? actor.userId : actor.operatorId
                const editResult = await editMessage(
                  postedMessage,
                  {
                    embeds: [buildSettledEmbed(permReq, decision, {decidedBy: decidedBy ?? undefined, reason})],
                    components: [],
                  },
                  logger,
                )
                if (editResult.success === false) {
                  logger.warn(
                    {requestID: permReq.requestID, err: editResult.error.message},
                    'discord-transport: failed to edit approval message',
                  )
                }
              },
            )
          }
        } else {
          settleEmbed(false)
          logger.warn(
            {requestID, err: r?.error?.message ?? 'unknown'},
            'discord-transport: failed to post approval embed',
          )
          approvalRegistry.markMessagePostFailed(requestID)
        }
      })
  }
}
