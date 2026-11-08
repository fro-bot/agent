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

import type {SettledDecider} from '../discord/approvals.js'
import type {GatewayLogger} from '../discord/client.js'
import type {PostReplyFactory, ReplySink} from '../execute/launch-types.js'
import type {PermissionReply, PermissionRequest, SettlementReason} from './coordinator.js'
import type {ApprovalActor, ApprovalRegistry, RegistrationId} from './registry.js'

import {toErrorMessage} from '@fro-bot/runtime'
import {DiscordAPIError, RESTJSONErrorCodes} from 'discord.js'

import {
  approvalCardRejectOnly,
  buildApprovalButtons,
  buildApprovalEmbed,
  buildSettledEmbed,
} from '../discord/approvals.js'
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
  /**
   * The run that raised the request. Stored on the registry entry (alongside the thread scope) so the operator
   * routes reach a Discord-run approval by run id, which is all a dashboard operator holds.
   */
  readonly runId: string
  /**
   * Called once per request, right after it is registered and before anything is posted to Discord: announces the
   * request to the run's operator-stream subscribers (open frame + settle renderer). Optional; fail-soft: a throw
   * is logged and never stops the Discord card.
   */
  readonly onRegistered?: ((request: PermissionRequest) => void) | undefined
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
// Per-registration card state
// ---------------------------------------------------------------------------

/** What a settlement told the renderer: enough to draw the settled card. */
interface CardOutcome {
  readonly permReq: PermissionRequest
  readonly decision: PermissionReply
  readonly actor: ApprovalActor | null
  readonly reason: SettlementReason
}

/**
 * The card of one registered request. Created per `onPending` call and captured by that call's renderer and send
 * continuations only, so it cannot be reached by a later request that reuses the id, and it is garbage once those
 * finish. `pendingEdit` is the only retained outcome: held while the post is in flight, cleared when the card is
 * edited or the post fails.
 */
interface CardState {
  /** The registration this card belongs to; the only one a delivery failure of this card may reject. */
  readonly registration: RegistrationId
  /** The post failed for good: there will be no card, so a later settlement has nothing to retain an edit for. */
  dead: boolean
  message: Message | undefined
  /** The registration has settled by some path (decision, deadline, teardown, supersede). */
  settled: boolean
  pendingEdit: CardOutcome | undefined
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
export function isTerminalDeliveryFailure(error: unknown): boolean {
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
 * 5. Edits the card to its settled state; the renderer is attached at registration so a settlement that lands while
 *    the post is in flight is applied when the card posts.
 *
 * Between 2 and 3 it announces the request to the run's operator stream (`onRegistered`), so a dashboard sees a
 * Discord run's approvals like a web run's.
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
    runId,
    onRegistered,
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
   * For a terminal failure: asks the registry to reject the permission, retire the entry, and report back
   * (`rejectUndeliverable`). The registry does so only if the entry is still THIS registration and still `open`,
   * checked and claimed in one synchronous step. If an operator decision is already in flight (`claimed`) the entry
   * is left alone, because that approval may still succeed and run the tool: it settles through its own path, and
   * nothing is announced as denied. The operator-visible note (worded distinctly from a human denial or a deadline
   * timeout, so a pattern of delivery failures is diagnosable) is posted only when the registry did reject.
   */
  function handleUndeliverable(requestID: string, registration: RegistrationId, error: unknown): void {
    if (!isTerminalDeliveryFailure(error)) return

    const code = error instanceof DiscordAPIError ? error.code : undefined

    // eslint-disable-next-line no-void
    void approvalRegistry
      .rejectUndeliverable(requestID, registration)
      .then(outcome => {
        if (outcome === 'skipped') {
          logger.warn(
            {requestID, code},
            'discord-transport: approval notification undeliverable, but the request is already decided or in flight — left to settle',
          )
          return
        }
        logger.error(
          {requestID, code, err: toErrorMessage(error)},
          'discord-transport: approval notification undeliverable (terminal Discord error) — auto-rejected on the server',
        )
        // Best-effort operator-visible note. If the thread itself is gone this send will also fail — that
        // failure is swallowed here; the logger.error above is the durable signal that always reaches an operator.
        // eslint-disable-next-line no-void
        void replySink
          .send('thread', {
            content:
              'A tool approval could not be delivered and was automatically denied (Discord notification failed to send).',
          })
          .catch(() => {})
      })
      .catch((settleError: unknown) => {
        logger.error(
          {requestID, err: toErrorMessage(settleError)},
          'discord-transport: rejectUndeliverable threw while auto-rejecting an undeliverable approval',
        )
      })
  }

  /** Edit a posted card to the settled state, with the decider's origin. Best-effort: a failed edit is logged. */
  async function settleCard(message: Message, outcome: CardOutcome): Promise<void> {
    const {permReq, decision, actor, reason} = outcome
    // Pass the actor's origin through so the embed mentions a Discord user but shows a
    // web operator's GitHub login as plain text (Discord cannot resolve it as a mention).
    const decidedBy: SettledDecider | undefined =
      actor === null || actor.kind === 'run-grant'
        ? undefined
        : actor.kind === 'discord-user'
          ? {kind: 'discord-user', userId: actor.userId}
          : {kind: 'web', login: actor.login}
    const editResult = await editMessage(
      message,
      {embeds: [buildSettledEmbed(permReq, decision, {decidedBy, reason})], components: []},
      logger,
    )
    if (editResult.success === false) {
      logger.warn(
        {requestID: permReq.requestID, err: editResult.error.message},
        'discord-transport: failed to edit approval message',
      )
    }
  }

  /**
   * The embed post failed. A card whose request already settled (a decision, deadline, teardown, or a re-ask landed
   * while the post was in flight) has nothing left to deliver or reject: its retained outcome is dropped, and the
   * registry is NOT touched, because by id it may now hold a successor request that this stale failure must not
   * mark failed or auto-reject. Otherwise the existing handling applies.
   */
  function cardPostFailed(card: CardState, requestID: string, error: unknown): void {
    card.pendingEdit = undefined
    card.dead = true
    if (card.settled) {
      logger.debug({requestID}, 'discord-transport: card post failed after the request settled — nothing to do')
      return
    }
    approvalRegistry.markMessagePostFailed(requestID)
    handleUndeliverable(requestID, card.registration, error)
  }

  return function onPending(req: PermissionRequest): void {
    const {requestID, sessionID} = req

    // Per-request postReply closure — captures sessionID for the SDK call.
    // FIX 4: AbortSignal.timeout(10_000) is used inside the factory to avoid
    // the dangling-timer leak from the old Promise.race approach.
    const postReplyForRequest = postReplyFactory(sessionID)

    // A card that clamps the Action cannot show the whole request: it offers Deny only, and the registry refuses an
    // approve that reaches it another way (a stale or forged button id).
    const rejectOnly = approvalCardRejectOnly(req)

    // register-before-send: register the entry in the shared registry
    // BEFORE attempting the Discord embed post. This ensures the button
    // handler can look up the entry even if the send is still in-flight.
    // Registry owns the deadline timer (single-owner rule).
    //
    // approvalScopeId: use threadId (set by threadFactory after thread creation).
    // For non-Discord paths (in-memory sinks), threadId is '' — the registry
    // still works; the approvalScopeId is only used for button-handler lookup.
    const registration = approvalRegistry.register({
      requestID,
      sessionID,
      approvalScopeId: threadId,
      runId,
      directory,
      request: req,
      effects: {postReply: postReplyForRequest},
      deadlineMs: approvalDeadlineMs,
      onDeadlineSettled,
      rejectOnly,
    })

    // Announce to the run's operator stream. After register (a decision can settle even if the frame is dropped)
    // and before the card is posted: the settle renderer it attaches does not depend on the card ever posting.
    if (onRegistered !== undefined) {
      try {
        onRegistered(req)
      } catch (error: unknown) {
        logger.warn(
          {requestID, err: toErrorMessage(error)},
          'discord-transport: operator-stream announce threw (fail-soft; registered, the Discord card still posts)',
        )
      }
    }

    // The card's settle renderer attaches HERE, at registration, not after the send resolves. A decision can land
    // while the embed send is still in flight (the dashboard sees the request as soon as it is announced above), and
    // a renderer attached later would find the entry settled and gone, leaving an active-looking card that never
    // shows the decision. Attached now, it records the outcome and the card is edited once it exists. It belongs to
    // this registration only: a request that re-asks the same id gets its own card state, so neither card can be
    // edited for the other's outcome. It runs after the announce renderer, so the dashboard frame never waits on
    // a Discord edit.
    const card: CardState = {registration, dead: false, message: undefined, settled: false, pendingEdit: undefined}
    approvalRegistry.attachMessage(
      requestID,
      async (
        permReq: PermissionRequest,
        decision: PermissionReply,
        actor: ApprovalActor | null,
        reason: SettlementReason,
      ) => {
        card.settled = true
        const outcome: CardOutcome = {permReq, decision, actor, reason}
        if (card.message === undefined) {
          // Card still posting: keep the outcome until it posts. A card that already failed for good will never
          // post, so there is nothing to keep it for.
          if (!card.dead) card.pendingEdit = outcome
          return
        }
        await settleCard(card.message, outcome)
      },
    )

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
          {requestID, err: toErrorMessage(error)},
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
      .send('thread', {embeds: [buildApprovalEmbed(req)], components: [buildApprovalButtons(requestID, rejectOnly)]})
      .then(result => {
        const r = result as Result<Message, Error> | undefined
        if (r?.success === true) {
          // Embed send succeeded — settle pending claim as delivered so
          // flush() does not add a misleading _(no output)_.
          settleEmbed(true)
          const postedMessage = r.data
          if (postedMessage === undefined) {
            card.pendingEdit = undefined
          } else {
            // The card exists now: the renderer attached at registration can edit it. If the request already
            // settled while the post was in flight, edit it to that outcome now, exactly once, and drop it.
            card.message = postedMessage
            const late = card.pendingEdit
            card.pendingEdit = undefined
            if (late !== undefined) {
              // eslint-disable-next-line no-void
              void settleCard(postedMessage, late)
            }
          }
        } else {
          settleEmbed(false)
          const failureError = r?.success === false ? r.error : undefined
          logger.warn(
            {requestID, err: failureError?.message ?? 'unknown'},
            'discord-transport: failed to post approval embed',
          )
          cardPostFailed(card, requestID, failureError)
        }
      })
      .catch((error: unknown) => {
        // Settle the pending visibility claim false and mark the registry entry
        // as post-failed so the button handler knows the embed was never posted.
        // Log a warning but do not rethrow — onPending must not throw.
        settleEmbed(false)
        logger.warn(
          {requestID, err: toErrorMessage(error)},
          'discord-transport: approval embed send rejected unexpectedly',
        )
        cardPostFailed(card, requestID, error)
      })
  }
}
