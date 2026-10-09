/**
 * Program-scoped approval registry bridge.
 *
 * Maps requestID → approval context across all in-flight runs so any approval
 * transport (Discord button, web callback) can: verify scope binding, claim
 * exactly once (single-winner), and POST the reply to OpenCode. All side
 * effects are injected as closures — this module is pure and unit-testable.
 *
 * This module is the approval family of the shared {@link RequestGate}, which
 * owns the entry map, the `open → claimed → confirmed` lifecycle, the
 * deadline handshake, teardown, and the terminal notification (see
 * `request-gate.ts`). What lives here is approval-specific: the
 * `once/always/reject` vocabulary, the strict scope binding, supersede on
 * re-register, the reject cascade, and the settled render.
 *
 * ### 3-state entry lifecycle
 *
 * ```
 *   open  ──claim──▶  claimed  ──confirmReply──▶  (deleted)
 *             │                  │
 *             │           postReply failed
 *             │                  │
 *             └──────────────────▶  open  (retry allowed)
 * ```
 *
 * - `open`      — registered, no button click yet (or postReply failed).
 * - `claimed`   — button click in-flight; postReply call is running.
 *                 A second click returns `already-claimed` immediately,
 *                 preventing a duplicate POST even while the first is awaiting.
 * - The entry is deleted when `confirmReply` is called (the authoritative
 *   `permission.replied` echo from OpenCode) or on dispose.
 *
 * ### Winner-vs-loser rule (deadline race)
 *
 * - A **deadline** fires in the gate's own timer. If the entry is still
 *   `open` at that moment: the deadline wins — POST reject, render 'deadline',
 *   delete. If the entry is `claimed` (button approve in-flight): the button
 *   is the winner — deadline is a NO-OP, but `deadlineExpired` is set to true.
 *   If the button's postReply then fails, the reset path checks `deadlineExpired`
 *   and immediately fail-closes instead of leaving the entry open with a dead timer.
 * - A **dispose** (run ended / gateway shutdown) always wins — it tears down
 *   regardless of state (render 'disposed' + delete + best-effort reject POST
 *   if not yet claimed). A claimed entry is marked `disposed`: if its in-flight reply
 *   then fails, one reject reply is sent (never a reopen); if it succeeds, nothing more.
 *
 * ### register-before-send
 *
 * Callers MUST call `register()` before attempting to post the Discord embed.
 * Once the embed is posted successfully, call `attachMessage(requestID, renderFn)`
 * so that settled state can edit the message.
 * If the send fails, call `markMessagePostFailed(requestID)` — the entry stays
 * registered so the permission can still be POSTed when it settles.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {ApprovalRequestDetail} from '../operator-contract/approval-frame.js'
import type {PermissionReply, PermissionReplyEvent, PermissionRequest, SettlementReason} from './coordinator.js'
import type {ApprovalGateEntry, GateActor, RequestGate, ScopePolicy, TerminalOutcome} from './request-gate.js'

import {boundApprovalDetail} from './approval-detail.js'
import {createRequestGate} from './request-gate.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Bounded DTO for a single pending approval request.
 *
 * Returned by `describePendingForScope` for the GET pending-approvals endpoint.
 * Structurally identical to `ApprovalRequestDetail` (the open variant of
 * `ApprovalFrameData` minus the `settled` discriminant) — enforced at the type
 * level by aliasing `ApprovalRequestDetail` so a new field added there
 * automatically appears here without a separate change.
 *
 * `command` and `filepath` are already bounded (length-capped + control-char-stripped)
 * by `boundApprovalDetail` before being placed here — safe for direct JSON serialisation.
 */
export type PendingApprovalDTO = ApprovalRequestDetail

// ---------------------------------------------------------------------------
// ApprovalActor — transport-neutral actor/operator identity
// ---------------------------------------------------------------------------

export type {DiscordApprovalActor, WebOperatorActor} from './request-gate.js'

/**
 * Transport-neutral actor identity for an approval decision.
 *
 * Discriminated on `kind` so callers can narrow without `as` casts:
 * ```ts
 * if (actor.kind === 'discord-user') {
 *   // actor.userId is available here
 * }
 * ```
 */
export type ApprovalActor = GateActor

/** Render function injected after the approval embed/notification is posted successfully. */
export type RenderFn = (
  request: PermissionRequest,
  decision: PermissionReply,
  actor: ApprovalActor | null,
  reason: SettlementReason,
) => Promise<void>

export interface ApprovalSideEffects {
  /** POST the decision to OpenCode's reply endpoint. Injected by run.ts. */
  postReply: (
    requestID: string,
    directory: string,
    decision: PermissionReply,
  ) => Promise<{readonly ok: boolean; readonly error?: string}>
}

export interface RegisterParams {
  readonly requestID: string
  readonly sessionID: string
  /**
   * Transport-neutral scope identifier for the approval entry.
   *
   * For Discord: the thread/channel ID where the embed is posted — used by the
   * button handler to verify the interaction came from the correct channel.
   * For a future web transport: an opaque scope token (e.g. session ID or
   * request correlation ID) that the web callback verifies.
   *
   * Replaces the Discord-shaped `channelID` field.
   */
  readonly approvalScopeId: string
  /** Workspace dir for reply routing. */
  readonly directory: string
  readonly request: PermissionRequest
  readonly effects: ApprovalSideEffects
  /**
   * Optional per-entry deadline (ms). If defined and > 0, the registry starts
   * a timer. On expiry: if entry is still `open` → POST reject + render
   * 'deadline' + delete. If `claimed` (button in-flight) → NO-OP; the button
   * winner owns the outcome. `deadlineExpired` is set to true so that if the
   * button's postReply subsequently fails, the reset path fail-closes immediately.
   */
  readonly deadlineMs?: number
  /**
   * Optional callback invoked when the deadline fires on an `open` entry (i.e.
   * the deadline wins — no button click arrived in time). Called after the
   * reject POST and render have been dispatched. Use this to post a visible
   * "approval timed out" status to the run thread.
   *
   * NOT called when the button wins before the deadline, or on dispose.
   */
  readonly onDeadlineSettled?: () => void | Promise<void>
}

export type DecisionOutcome = 'ok' | 'not-found' | 'channel-mismatch' | 'already-claimed' | 'reply-failed'

export type {EntryState} from './request-gate.js'

export interface ApprovalRegistry {
  /** Register a new entry BEFORE sending the approval embed/notification. */
  register: (params: RegisterParams) => void
  /**
   * Attach the settled-embed render function once the approval notification is
   * posted. Must be called after `register` and only when the send succeeds.
   */
  attachMessage: (requestID: string, renderFn: RenderFn) => void
  /**
   * Mark that the approval notification could not be posted. The entry stays
   * registered so the permission reply can still be POSTed on settlement;
   * the render step is skipped since there is nothing to edit.
   */
  markMessagePostFailed: (requestID: string) => void
  has: (requestID: string) => boolean
  pending: () => readonly string[]
  /**
   * Returns true if any entry for the given `approvalScopeId` is in an
   * `open` or `claimed` state (i.e. the run is waiting for approval).
   *
   * Returns false when no entry exists for the scope, or when the only
   * matching entry is `confirmed` (already settled and about to be deleted).
   *
   * Boolean only — does not expose entry contents.
   */
  hasPendingForScope: (approvalScopeId: string) => boolean
  /**
   * Returns the full bounded detail for each **open** (not claimed) request in
   * the given `approvalScopeId`. Used by the GET pending-approvals endpoint to
   * recover open requests for a reconnecting browser.
   *
   * Only `open` entries are returned. `claimed` entries are mid-decision
   * (in-flight) and are not actionable by the browser — returning them would
   * render a prompt the browser cannot decide. `confirmed` entries are already
   * settled and are never returned.
   *
   * Returns an empty array when no open entries exist for the scope.
   * The returned DTOs carry bounded (length-capped + control-char-stripped)
   * `command` and `filepath` values — safe for direct JSON serialisation.
   *
   * Does NOT expose entry contents to unauthorised callers — the route layer
   * is responsible for authorisation before calling this method.
   */
  describePendingForScope: (approvalScopeId: string) => readonly PendingApprovalDTO[]
  /**
   * Transport-neutral decision intake: enforce scope binding, single-winner
   * claim, POST reply. Does NOT edit the embed/notification.
   *
   * Replaces the Discord-shaped `handleButtonDecision` method.
   */
  handleDecision: (args: {
    readonly requestID: string
    readonly approvalScopeId: string
    readonly decision: PermissionReply
    readonly actor: ApprovalActor
  }) => Promise<DecisionOutcome>
  /**
   * Authoritative settlement from `permission.replied`.
   * - Entry `open` → OpenCode-initiated (unsolicited or always-rule): render, clear timer, delete. No POST.
   * - Entry `claimed` → echo of our own button POST: render with event.reply, clear timer, delete.
   * - On `event.reply === 'reject'` → cascade all OTHER `open` entries with the same sessionID:
   *   best-effort POST reject, render 'cascade', clear timer, delete.
   *   NOTE: `claimed` siblings are skipped — they own their outcome via their own confirmReply echo.
   * - Entry not found → no-op.
   * - sessionID mismatch → warn + no-op (defensive cross-session guard).
   */
  confirmReply: (event: PermissionReplyEvent) => void
  /** Settlement application (called from applySettlement for dispose paths). Idempotent. */
  applySettlement: (args: {
    readonly requestID: string
    readonly decision: PermissionReply
    readonly reason: SettlementReason
  }) => Promise<void>
  /**
   * Fail-close every open approval that belongs to `sessionID` (run teardown).
   * Safe to call even if entries have already been settled. Approvals only:
   * questions sharing the gate are torn down by the question registry.
   */
  disposeRun: (sessionID: string, reason: string) => Promise<void>
  /** Fail-close every open approval (global teardown). Approvals only; shutdown uses the gate's `disposeAllAcrossFamilies`. */
  disposeAll: (reason: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Entry payload
// ---------------------------------------------------------------------------

/** Approval-specific data carried on a gate entry. */
export interface ApprovalPayload {
  readonly request: PermissionRequest
  readonly directory: string
  readonly effects: ApprovalSideEffects
  /** Set by attachMessage once the approval notification is posted. */
  renderFn: RenderFn | null
}

/** Approvals keep strict scope binding: the acting scope must equal the entry's scope. */
const approvalScopePolicy: ScopePolicy = (entry, request) => entry.scopeId === request.scopeId

/** Maps a settlement reason to how the entry left the gate. */
function terminalOutcomeFor(reason: SettlementReason): TerminalOutcome {
  switch (reason) {
    case 'replied':
      return 'confirmed'
    case 'cascade':
      return 'cascade'
    case 'deadline':
      return 'deadline'
    case 'disposed':
    case 'superseded':
      return 'disposed'
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createApprovalRegistry(deps: {
  readonly logger: GatewayLogger
  /** Shared gate. Pass the same gate to the question registry so terminal events span both families. */
  readonly gate?: RequestGate
}): ApprovalRegistry {
  const {logger} = deps
  const gate = deps.gate ?? createRequestGate({logger})

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function getEntry(requestID: string): ApprovalGateEntry | undefined {
    const entry = gate.get(requestID)
    return entry?.family === 'approval' ? entry : undefined
  }

  function approvalEntries(): readonly ApprovalGateEntry[] {
    const result: ApprovalGateEntry[] = []
    for (const entry of gate.list()) {
      if (entry.family === 'approval') result.push(entry)
    }
    return result
  }

  async function runRender(
    entry: ApprovalGateEntry,
    decision: PermissionReply,
    reason: SettlementReason,
  ): Promise<void> {
    const {renderFn} = entry.payload
    if (renderFn === null) return
    try {
      await renderFn(entry.payload.request, decision, entry.actor, reason)
    } catch (error) {
      gate.logRenderFailure(entry, reason, error)
    }
  }

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  function register(params: RegisterParams): void {
    const {requestID, sessionID, approvalScopeId, directory, request, effects, deadlineMs, onDeadlineSettled} = params
    const entry: ApprovalGateEntry = {
      family: 'approval',
      requestID,
      sessionID,
      scopeId: approvalScopeId,
      payload: {request, directory, effects, renderFn: null},
      ops: {
        // The next two return the underlying promise instead of wrapping it in an async function:
        // an async wrapper adds microtask ticks to the fail-close chain, whose depth the
        // FIX 2 tests in registry.test.ts pin.
        // eslint-disable-next-line @typescript-eslint/promise-function-async
        postDeadlineReply: () => effects.postReply(requestID, directory, 'reject'),
        // eslint-disable-next-line @typescript-eslint/promise-function-async
        renderDeadline: () => runRender(entry, 'reject', 'deadline'),
        dispose: async () => applySettlement({requestID, decision: 'reject', reason: 'disposed'}),
        onDeadlineSettled,
      },
      state: 'open',
      actor: null,
      timer: null,
      deadlineExpired: false,
      terminalFired: false,
    }
    // A re-ask for a pending request id replaces the entry. The gate clears the replaced entry's
    // timer (so it cannot settle the replacement) and emits no terminal notification for it,
    // because the request id stays pending.
    const replaced = gate.put(entry, deadlineMs)
    if (replaced !== undefined) {
      // Best-effort render the old embed as superseded so its buttons become visibly inert.
      // Wrapped so it never throws into register.
      if (replaced.family === 'approval' && replaced.payload.renderFn !== null) {
        // eslint-disable-next-line no-void
        void replaced.payload.renderFn(replaced.payload.request, 'reject', null, 'superseded').catch(() => {})
      }
      logger.warn({requestID}, 'ApprovalRegistry: duplicate requestID — overwriting (re-ask)')
    }
  }

  // -------------------------------------------------------------------------
  // attachMessage / markMessagePostFailed
  // -------------------------------------------------------------------------

  function attachMessage(requestID: string, renderFn: RenderFn): void {
    const entry = getEntry(requestID)
    if (entry === undefined) {
      logger.warn({requestID}, 'ApprovalRegistry: attachMessage — entry not found (already settled?)')
      return
    }
    entry.payload.renderFn = renderFn
  }

  function markMessagePostFailed(requestID: string): void {
    const entry = getEntry(requestID)
    if (entry === undefined) {
      logger.warn({requestID}, 'ApprovalRegistry: markMessagePostFailed — entry not found (already settled?)')
      return
    }
    logger.warn({requestID}, 'ApprovalRegistry: embed post failed — entry stays registered, renderFn will be skipped')
  }

  // -------------------------------------------------------------------------
  // has / pending / scope queries
  // -------------------------------------------------------------------------

  function has(requestID: string): boolean {
    return getEntry(requestID) !== undefined
  }

  function pending(): readonly string[] {
    return approvalEntries().map(entry => entry.requestID)
  }

  function hasPendingForScope(approvalScopeId: string): boolean {
    return gate.hasPendingForScope('approval', approvalScopeId)
  }

  function describePendingForScope(approvalScopeId: string): readonly PendingApprovalDTO[] {
    const result: PendingApprovalDTO[] = []
    for (const entry of approvalEntries()) {
      if (entry.scopeId !== approvalScopeId) continue
      // Only return 'open' entries — 'claimed' entries are mid-decision (in-flight)
      // and not actionable by the browser; returning them would render a prompt
      // the browser cannot decide.
      if (entry.state !== 'open') continue

      const {request} = entry.payload
      const command = boundApprovalDetail(request.command)
      const filepath = boundApprovalDetail(request.filepath)

      const dto: PendingApprovalDTO = {
        requestID: entry.requestID,
        permission: request.permission,
        ...(command !== undefined && command.length > 0 ? {command} : {}),
        ...(filepath !== undefined && filepath.length > 0 ? {filepath} : {}),
      }
      result.push(dto)
    }
    return result
  }

  // -------------------------------------------------------------------------
  // handleDecision (transport-neutral decision intake)
  // -------------------------------------------------------------------------

  async function handleDecision(args: {
    readonly requestID: string
    readonly approvalScopeId: string
    readonly decision: PermissionReply
    readonly actor: ApprovalActor
  }): Promise<DecisionOutcome> {
    const {requestID, approvalScopeId, decision, actor} = args

    const entry = getEntry(requestID)
    if (entry === undefined) {
      return 'not-found'
    }

    const admission = gate.admit(entry, {scopeId: approvalScopeId, actor}, approvalScopePolicy)
    if (admission.kind === 'scope-mismatch') return 'channel-mismatch'
    if (admission.kind === 'already-claimed') return 'already-claimed'

    const {effects, directory} = entry.payload
    // Returns the underlying promise: see the note on postDeadlineReply in register().
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    const outcome = await admission.submit(() => effects.postReply(requestID, directory, decision))
    switch (outcome) {
      case 'ok':
        return 'ok'
      case 'already-claimed':
        return 'already-claimed'
      case 'not-found':
        return 'not-found'
      case 'reply-failed':
        // Teardown removed the entry while this reply was in flight, and the reply failed: nothing
        // owns the permission any more, so it would stay pending in OpenCode. Deny it once, unless
        // the gate's deadline fail-close already started recovery (its reject answers the request).
        if (entry.state === 'disposed' && entry.recoveryStarted !== true) {
          await rejectAfterDisposedReplyFailure(entry)
        }
        return 'reply-failed'
    }
  }

  async function rejectAfterDisposedReplyFailure(entry: ApprovalGateEntry): Promise<void> {
    const {requestID} = entry
    try {
      const r = await entry.payload.effects.postReply(requestID, entry.payload.directory, 'reject')
      if (!r.ok) {
        logger.warn(
          {requestID, error: r.error},
          'ApprovalRegistry: deny after a failed reply on a disposed entry returned ok:false',
        )
      }
    } catch (error) {
      logger.warn({requestID, err: error}, 'ApprovalRegistry: deny after a failed reply on a disposed entry threw')
    }
  }

  // -------------------------------------------------------------------------
  // confirmReply — authoritative path for permission.replied
  // -------------------------------------------------------------------------

  function confirmReply(event: PermissionReplyEvent): void {
    const {requestID, sessionID, reply} = event

    const entry = getEntry(requestID)
    if (entry === undefined) {
      logger.debug({requestID, reply}, 'ApprovalRegistry: confirmReply — entry not found (already settled?)')
      return
    }

    // Defensive guard: cross-session settle prevention.
    // requestIDs are globally unique (per_...) so this should never fire in
    // practice, but guards against any future ID-collision scenario.
    if (entry.sessionID !== sessionID) {
      logger.warn(
        {requestID, entrySessionID: entry.sessionID, eventSessionID: sessionID},
        'ApprovalRegistry: confirmReply — sessionID mismatch, ignoring (cross-session guard)',
      )
      return
    }

    // Log if OpenCode's reply differs from our claimed decision (it wins).
    if ((entry.state === 'claimed' || entry.state === 'confirmed') && entry.actor !== null) {
      // The reply is the echo of our POST. Render with OpenCode's reply.
      logger.info({requestID, state: entry.state, reply}, 'ApprovalRegistry: confirmReply — decision winner echo')
    } else {
      // Open entry: OpenCode-initiated (unsolicited reject or always-rule). No POST needed.
      logger.info({requestID, state: entry.state, reply}, 'ApprovalRegistry: confirmReply — OpenCode-initiated')
    }

    // Render asynchronously (best-effort; errors logged by the gate).
    // eslint-disable-next-line no-void
    void gate
      .settleEcho(entry, async () => runRender(entry, reply, 'replied'))
      .then(() => {
        // Cascade only `open` siblings — skip `claimed` siblings entirely.
        // A `claimed` sibling has its own button-approve postReply in-flight and
        // will settle via its own confirmReply echo (or its own deadline).
        // Sending a cascade reject to a claimed sibling would create a contradiction:
        // OpenCode would receive both 'once' (from the button) and 'reject' (cascade).
        if (reply === 'reject') {
          // eslint-disable-next-line no-void
          void cascadeReject(sessionID)
        }
      })
  }

  async function cascadeReject(sessionID: string): Promise<void> {
    // Only cascade to `open` siblings; skip `claimed` ones.
    const siblings = approvalEntries().filter(e => e.sessionID === sessionID && e.state === 'open')
    await Promise.all(
      siblings.map(async sib => {
        gate.settleNow(sib, 'cascade')
        logger.info({requestID: sib.requestID, sessionID}, 'ApprovalRegistry: cascade-rejecting sibling permission')
        // Best-effort reject POST for the sibling (spec: KEEP the cascade POST).
        try {
          await sib.payload.effects.postReply(sib.requestID, sib.payload.directory, 'reject')
        } catch (error) {
          logger.warn({requestID: sib.requestID, err: error}, 'ApprovalRegistry: cascade postReply threw — continuing')
        }
        await runRender(sib, 'reject', 'cascade')
      }),
    )
  }

  // -------------------------------------------------------------------------
  // applySettlement — legacy/dispose path
  //
  // Still used by:
  //   - disposeRun / disposeAll (reason: 'disposed')
  //   - Any legacy callsite passing reason 'replied' | 'cascade' | 'deadline'
  //     directly (e.g., coordinator onSettled wiring). Will still work but the
  //     preferred path for 'replied' is confirmReply().
  //
  // Winner-vs-loser for deadline:
  //   If entry.state !== 'open' (already claimed/confirmed by a real winner),
  //   a 'deadline' reason must NOT render or delete — the winner owns it.
  //   EXCEPTION: 'disposed' always tears down (run is ending).
  // -------------------------------------------------------------------------

  async function applySettlement(args: {
    readonly requestID: string
    readonly decision: PermissionReply
    readonly reason: SettlementReason
  }): Promise<void> {
    const {requestID, decision, reason} = args

    const entry = getEntry(requestID)
    if (entry === undefined) {
      // Already settled/unregistered — idempotent no-op
      return
    }

    // Deadline: if entry is claimed/confirmed, the button winner owns it — bail.
    if (reason === 'deadline' && entry.state !== 'open') {
      logger.debug(
        {requestID, state: entry.state},
        'ApprovalRegistry: applySettlement(deadline) — entry claimed/confirmed, deadline loses (no-op)',
      )
      return
    }

    // The gate clears the deadline timer on any terminal path, runs the work below, then removes
    // the entry and emits the terminal notification.
    await gate.retire(entry, terminalOutcomeFor(reason), async () => {
      // A claimed entry's reply may still be in flight. Mark the entry disposed so the gate never
      // reopens it when that reply fails, and so `handleDecision` can deny the permission once the
      // reply settles. A reply that already succeeded awaits its echo, which finds nothing to settle.
      if (reason === 'disposed' && entry.state === 'claimed') entry.state = 'disposed'

      // For non-replied/non-cascade reasons on open entries: best-effort postReply.
      // Skip if already claimed/confirmed (postReply was or is being sent).
      if (reason !== 'replied' && reason !== 'cascade' && entry.state === 'open') {
        entry.state = 'claimed'
        try {
          const r = await entry.payload.effects.postReply(requestID, entry.payload.directory, decision)
          if (r.ok) {
            entry.state = 'confirmed'
          } else {
            logger.warn(
              {requestID, reason, error: r.error},
              'ApprovalRegistry: best-effort postReply on settlement returned ok:false — continuing',
            )
          }
        } catch (error) {
          logger.warn(
            {requestID, reason, err: error},
            'ApprovalRegistry: best-effort postReply on settlement threw — continuing',
          )
        }
      }

      // Edit the settled embed — only if a message was successfully attached.
      await runRender(entry, decision, reason)
    })
  }

  return {
    register,
    attachMessage,
    markMessagePostFailed,
    has,
    pending,
    hasPendingForScope,
    describePendingForScope,
    handleDecision,
    confirmReply,
    applySettlement,
    disposeRun: async (sessionID, reason) => gate.disposeFamilyRun('approval', sessionID, reason),
    disposeAll: async reason => gate.disposeFamilyAll('approval', reason),
  }
}
