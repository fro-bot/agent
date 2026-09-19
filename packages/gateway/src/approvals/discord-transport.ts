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

import type {Result} from '@fro-bot/runtime'
import type {Message} from 'discord.js'

import type {GatewayLogger} from '../discord/client.js'
import type {PostReplyFactory, ReplySink} from '../execute/launch-types.js'
import type {PermissionReply, PermissionRequest, SettlementReason} from './coordinator.js'
import type {ApprovalActor, ApprovalRegistry} from './registry.js'

import {DiscordAPIError, RESTJSONErrorCodes} from 'discord.js'

import {buildApprovalButtons, buildApprovalEmbed, buildSettledEmbed} from '../discord/approvals.js'
import {editMessage} from '../discord/io.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Re-export `PostReplyFactory` from `launch-types.ts` for backwards compatibility.
 *
 * The canonical definition lives in `launch-types.ts` so `ApprovalTransportContext`
 * can reference it without creating a circular import with this module.
 */
export type {PostReplyFactory}

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
// Terminal vs retryable delivery-failure classification
// ---------------------------------------------------------------------------

/**
 * Discord REST error codes that mean "retrying cannot help" for an approval
 * notification post: the thread/channel the embed would be posted into is
 * gone, or the bot has lost access to it.
 *
 * Deliberately narrow and numeric-code-based (not a message-string match) —
 * these codes are part of Discord's documented REST error contract and are
 * stable across client library versions, unlike free-text error messages.
 *
 * - `UnknownChannel` (10003): the thread/channel was deleted.
 * - `MissingAccess` (50001): the bot no longer has access to the channel
 *   (e.g. removed from the guild/channel).
 *
 * Everything else — rate limits (`RateLimitError`, not a `DiscordAPIError`),
 * 5xx `DiscordAPIError`/`HTTPError` responses, and network failures — is
 * retryable and must NOT trigger an auto-reject.
 */
const TERMINAL_DISCORD_ERROR_CODES: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.MissingAccess,
])

/**
 * `true` when `error` is a Discord API error whose numeric code identifies a
 * terminal delivery failure (see `TERMINAL_DISCORD_ERROR_CODES`).
 *
 * Classifies on `error instanceof DiscordAPIError` + a stable numeric code —
 * never on `error.message` — so a wording change in Discord's API responses
 * cannot silently reclassify a retryable failure as terminal (or vice versa).
 */
function isTerminalDeliveryFailure(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError && typeof error.code === 'number' && TERMINAL_DISCORD_ERROR_CODES.has(error.code)
  )
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

  /**
   * Called from both the embed-post failure branch and its `.catch()` on
   * every notification-post failure. No-ops for a retryable failure — the
   * entry stays `open` (via `markMessagePostFailed`) so a later settlement
   * can still POST the reply once a human decides.
   *
   * For a terminal failure: rejects the permission on the server via
   * `applySettlement` (which also settles/deletes the registry entry —
   * exactly once, since the entry is deleted inside `applySettlement` and a
   * second call for the same `requestID` is a no-op), and posts a best-effort
   * operator-visible note to the run's thread — the run's output channel this
   * transport already uses — worded distinctly from a human denial or a
   * deadline timeout so a pattern of delivery failures is diagnosable rather
   * than reading as arbitrary refusals.
   */
  function handleUndeliverable(requestID: string, error: unknown): void {
    if (!isTerminalDeliveryFailure(error)) return

    const code = error instanceof DiscordAPIError ? error.code : undefined
    logger.error(
      {requestID, code, err: error instanceof Error ? error.message : String(error)},
      'discord-transport: approval notification undeliverable (terminal Discord error) — auto-rejecting on the server',
    )

    // eslint-disable-next-line no-void
    void approvalRegistry
      .applySettlement({requestID, decision: 'reject', reason: 'disposed'})
      .catch((settleError: unknown) => {
        logger.error(
          {requestID, err: settleError instanceof Error ? settleError.message : String(settleError)},
          'discord-transport: applySettlement threw while auto-rejecting an undeliverable approval',
        )
      })

    // Best-effort operator-visible note. If the thread itself is gone this
    // send will also fail — that failure is swallowed here; the logger.error
    // above is the durable signal that always reaches an operator.
    // eslint-disable-next-line no-void
    void replySink
      .send('thread', {
        content:
          'A tool approval could not be delivered and was automatically denied (Discord notification failed to send).',
      })
      .catch(() => {})
  }

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
    void replySink
      .send('thread', {content: 'Waiting for tool approval…'})
      .then(result => {
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
      .catch((error: unknown) => {
        // Settle the pending visibility claim false so flush() does not treat
        // this as delivered visible output. Log a warning but do not rethrow —
        // onPending must not throw (coordinator wraps it defensively).
        settleWaitingStatus(false)
        logger.warn(
          {requestID, err: error instanceof Error ? error.message : String(error)},
          'discord-transport: waiting-for-approval send rejected unexpectedly',
        )
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
        const r = result as Result<Message, Error> | undefined
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
                // For web operators, use the display login (mutable but human-readable for embeds).
                const decidedBy = actor === null ? null : actor.kind === 'discord-user' ? actor.userId : actor.login
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
          const failureError = r?.success === false ? r.error : undefined
          logger.warn(
            {requestID, err: failureError?.message ?? 'unknown'},
            'discord-transport: failed to post approval embed',
          )
          approvalRegistry.markMessagePostFailed(requestID)
          handleUndeliverable(requestID, failureError)
        }
      })
      .catch((error: unknown) => {
        // Settle the pending visibility claim false and mark the registry entry
        // as post-failed so the button handler knows the embed was never posted.
        // Log a warning but do not rethrow — onPending must not throw.
        settleEmbed(false)
        logger.warn(
          {requestID, err: error instanceof Error ? error.message : String(error)},
          'discord-transport: approval embed send rejected unexpectedly',
        )
        approvalRegistry.markMessagePostFailed(requestID)
        handleUndeliverable(requestID, error)
      })
  }
}
