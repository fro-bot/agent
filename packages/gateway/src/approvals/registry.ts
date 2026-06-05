/**
 * Program-scoped approval registry bridge.
 *
 * Maps requestID → approval context across all in-flight runs so the Discord
 * button handler can: verify channel binding, claim exactly once
 * (single-winner), and POST the reply to OpenCode. All Discord/SDK side
 * effects are injected as closures — this module is pure and unit-testable.
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
 * - A **deadline** fires in the registry's own timer. If the entry is still
 *   `open` at that moment: the deadline wins — POST reject, render 'deadline',
 *   delete. If the entry is `claimed` (button approve in-flight): the button
 *   is the winner — deadline is a NO-OP, but `deadlineExpired` is set to true.
 *   If the button's postReply then fails, the reset path checks `deadlineExpired`
 *   and immediately fail-closes instead of leaving the entry open with a dead timer.
 * - A **dispose** (run ended / gateway shutdown) always wins — it tears down
 *   regardless of state (render 'disposed' + delete + best-effort reject POST
 *   if not yet claimed).
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
import type {PermissionReply, PermissionReplyEvent, PermissionRequest, SettlementReason} from './coordinator.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Render function injected after the Discord embed is posted successfully. */
export type RenderFn = (
  request: PermissionRequest,
  decision: PermissionReply,
  decidedBy: string | null,
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
  /** Thread/channel id where the embed will be posted — the binding. */
  readonly channelID: string
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

export type EntryState = 'open' | 'claimed' | 'confirmed'

export interface ApprovalRegistry {
  /** Register a new entry BEFORE sending the Discord embed. */
  register: (params: RegisterParams) => void
  /**
   * Attach the settled-embed render function once the Discord message is
   * posted. Must be called after `register` and only when the send succeeds.
   */
  attachMessage: (requestID: string, renderFn: RenderFn) => void
  /**
   * Mark that the Discord embed could not be posted. The entry stays
   * registered so the permission reply can still be POSTed on settlement;
   * the embed edit step is skipped since there is nothing to edit.
   */
  markMessagePostFailed: (requestID: string) => void
  has: (requestID: string) => boolean
  pending: () => readonly string[]
  /** Button path: enforce channel binding, single-winner claim, POST reply. Does NOT edit the embed. */
  handleButtonDecision: (args: {
    readonly requestID: string
    readonly channelID: string
    readonly decision: PermissionReply
    readonly decidedBy: string
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
   * Fail-close every open entry that belongs to `sessionID` (run teardown).
   * Safe to call even if entries have already been settled.
   */
  disposeRun: (sessionID: string, reason: string) => Promise<void>
  /** Fail-close every open entry (shutdown / global teardown). */
  disposeAll: (reason: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Internal entry shape
// ---------------------------------------------------------------------------

interface RegistryEntry {
  readonly request: PermissionRequest
  readonly sessionID: string
  readonly channelID: string
  readonly directory: string
  readonly effects: ApprovalSideEffects
  state: EntryState
  decidedBy: string | null
  /** Set by attachMessage once the Discord embed is posted. */
  renderFn: RenderFn | null
  /** Deadline timer handle — cleared on any terminal transition. */
  timer: ReturnType<typeof setTimeout> | null
  /**
   * Set to true when the deadline timer fires but the entry is `claimed`
   * (button in-flight). If the button's postReply subsequently fails and
   * resets state to `open`, the reset path checks this flag and immediately
   * fail-closes instead of leaving the entry open with a dead timer.
   */
  deadlineExpired: boolean
  /**
   * Optional callback invoked when the deadline fires on an `open` entry.
   * Stored from RegisterParams.onDeadlineSettled.
   */
  readonly onDeadlineSettled: (() => void | Promise<void>) | undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createApprovalRegistry(deps: {readonly logger: GatewayLogger}): ApprovalRegistry {
  const {logger} = deps
  const entries = new Map<string, RegistryEntry>()

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function clearTimer(entry: RegistryEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  async function runRender(
    entry: RegistryEntry,
    requestID: string,
    decision: PermissionReply,
    reason: SettlementReason,
  ): Promise<void> {
    if (entry.renderFn !== null) {
      try {
        await entry.renderFn(entry.request, decision, entry.decidedBy, reason)
      } catch (error) {
        logger.error({requestID, reason, err: error}, 'ApprovalRegistry: renderFn threw during settlement — continuing')
      }
    }
  }

  /**
   * Shared fail-close helper: POST reject + render 'deadline' + delete.
   * Used by both the deadline open-path and the handleButtonDecision reset
   * path when deadlineExpired is true.
   */
  async function failCloseNow(requestID: string, entry: RegistryEntry): Promise<void> {
    logger.warn({requestID}, 'ApprovalRegistry: fail-closing entry (deadline already expired)')
    entry.state = 'claimed'
    entry.decidedBy = null
    try {
      const r = await entry.effects.postReply(requestID, entry.directory, 'reject')
      if (!r.ok) {
        logger.warn(
          {requestID, error: r.error},
          'ApprovalRegistry: failCloseNow postReply returned ok:false — continuing',
        )
      }
    } catch (error) {
      logger.warn({requestID, err: error}, 'ApprovalRegistry: failCloseNow postReply threw — continuing')
    }
    await runRender(entry, requestID, 'reject', 'deadline')
    entries.delete(requestID)
  }

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  function register(params: RegisterParams): void {
    const {requestID, sessionID, channelID, directory, request, effects, deadlineMs, onDeadlineSettled} = params
    if (entries.has(requestID)) {
      // FIX 3: clear the existing entry's timer before overwriting so the old
      // setTimeout cannot fire settleByDeadline on the replacement entry.
      const existing = entries.get(requestID)
      if (existing !== undefined) {
        clearTimer(existing)
        // NBC4: best-effort render the old embed as superseded so its buttons
        // become visibly inert. Wrapped so it never throws into register.
        if (existing.renderFn !== null) {
          // eslint-disable-next-line no-void
          void existing.renderFn(existing.request, 'reject', null, 'superseded').catch(() => {})
        }
      }
      logger.warn({requestID}, 'ApprovalRegistry: duplicate requestID — overwriting (re-ask)')
    }
    const entry: RegistryEntry = {
      request,
      sessionID,
      channelID,
      directory,
      effects,
      state: 'open',
      decidedBy: null,
      renderFn: null,
      timer: null,
      deadlineExpired: false,
      onDeadlineSettled,
    }
    entries.set(requestID, entry)

    if (deadlineMs !== undefined && deadlineMs > 0) {
      entry.timer = setTimeout(() => {
        settleByDeadline(requestID)
      }, deadlineMs)
      entry.timer.unref?.()
    }
  }

  /**
   * Deadline timer callback. Only settles if entry is still `open` — the
   * button winner (claimed state) beats the deadline.
   *
   * FIX 2: When the entry is `claimed`, set `deadlineExpired = true` so that
   * if the button's postReply subsequently fails and resets to `open`, the
   * reset path can immediately fail-close instead of leaving a dead timer.
   */
  function settleByDeadline(requestID: string): void {
    const entry = entries.get(requestID)
    if (entry === undefined) return // already gone

    if (entry.state !== 'open') {
      // Button approve is in-flight (claimed). Deadline LOSES. No-op.
      // But mark deadlineExpired so the button reset path can fail-close.
      entry.deadlineExpired = true
      logger.debug(
        {requestID, state: entry.state},
        'ApprovalRegistry: deadline fired but entry is claimed — no-op (button winner); deadlineExpired set',
      )
      return
    }

    // Entry is open — deadline wins.
    logger.warn({requestID}, 'ApprovalRegistry: deadline expired on open entry — fail-closed')
    entry.state = 'claimed'
    entry.timer = null

    // Capture the callback before the entry is deleted.
    const {onDeadlineSettled} = entry

    // Best-effort POST reject then render.
    const doDeadline = async () => {
      try {
        const r = await entry.effects.postReply(requestID, entry.directory, 'reject')
        if (!r.ok) {
          logger.warn(
            {requestID, error: r.error},
            'ApprovalRegistry: deadline postReply returned ok:false — continuing',
          )
        }
      } catch (error) {
        logger.warn({requestID, err: error}, 'ApprovalRegistry: deadline postReply threw — continuing')
      }
      await runRender(entry, requestID, 'reject', 'deadline')
      entries.delete(requestID)

      // Notify the run thread that approval timed out (best-effort).
      if (onDeadlineSettled !== undefined) {
        try {
          await onDeadlineSettled()
        } catch (error) {
          logger.warn({requestID, err: error}, 'ApprovalRegistry: onDeadlineSettled threw — continuing')
        }
      }
    }

    // eslint-disable-next-line no-void
    void doDeadline()
  }

  // -------------------------------------------------------------------------
  // attachMessage / markMessagePostFailed
  // -------------------------------------------------------------------------

  function attachMessage(requestID: string, renderFn: RenderFn): void {
    const entry = entries.get(requestID)
    if (entry === undefined) {
      logger.warn({requestID}, 'ApprovalRegistry: attachMessage — entry not found (already settled?)')
      return
    }
    entry.renderFn = renderFn
  }

  function markMessagePostFailed(requestID: string): void {
    const entry = entries.get(requestID)
    if (entry === undefined) {
      logger.warn({requestID}, 'ApprovalRegistry: markMessagePostFailed — entry not found (already settled?)')
      return
    }
    logger.warn({requestID}, 'ApprovalRegistry: embed post failed — entry stays registered, renderFn will be skipped')
  }

  // -------------------------------------------------------------------------
  // has / pending
  // -------------------------------------------------------------------------

  function has(requestID: string): boolean {
    return entries.has(requestID)
  }

  function pending(): readonly string[] {
    return Array.from(entries.keys())
  }

  // -------------------------------------------------------------------------
  // handleButtonDecision
  // -------------------------------------------------------------------------

  async function handleButtonDecision(args: {
    readonly requestID: string
    readonly channelID: string
    readonly decision: PermissionReply
    readonly decidedBy: string
  }): Promise<DecisionOutcome> {
    const {requestID, channelID, decision, decidedBy} = args

    const entry = entries.get(requestID)
    if (entry === undefined) {
      return 'not-found'
    }

    if (entry.channelID !== channelID) {
      logger.warn(
        {requestID, expected: entry.channelID, received: channelID},
        'ApprovalRegistry: channel mismatch — ignoring button click',
      )
      return 'channel-mismatch'
    }

    // Single-winner gate: claimed or confirmed both block a second click.
    if (entry.state === 'claimed' || entry.state === 'confirmed') {
      return 'already-claimed'
    }

    // Atomic claim — transitions open → claimed
    entry.state = 'claimed'
    entry.decidedBy = decidedBy

    let result: {readonly ok: boolean; readonly error?: string}
    try {
      result = await entry.effects.postReply(requestID, entry.directory, decision)
    } catch (error) {
      logger.error({requestID, err: error}, 'ApprovalRegistry: postReply threw — resetting to open')
      // FIX 2: if deadline already fired while we were in-flight, fail-close immediately
      // instead of leaving the entry open with a dead timer.
      if (entry.deadlineExpired) {
        // eslint-disable-next-line no-void
        void failCloseNow(requestID, entry)
      } else {
        entry.state = 'open'
        entry.decidedBy = null
      }
      return 'reply-failed'
    }

    if (!result.ok) {
      logger.error(
        {requestID, error: result.error},
        'ApprovalRegistry: postReply returned ok:false — resetting to open',
      )
      // FIX 2: same fail-close-on-expired-deadline logic for the ok:false path.
      if (entry.deadlineExpired) {
        // eslint-disable-next-line no-void
        void failCloseNow(requestID, entry)
      } else {
        entry.state = 'open'
        entry.decidedBy = null
      }
      return 'reply-failed'
    }

    // Stay claimed — render happens in confirmReply when OpenCode echoes back.
    // Do NOT transition to confirmed here; the deadline must see 'claimed' to back off.
    return 'ok'
  }

  // -------------------------------------------------------------------------
  // confirmReply — authoritative path for permission.replied
  // -------------------------------------------------------------------------

  function confirmReply(event: PermissionReplyEvent): void {
    const {requestID, sessionID, reply} = event

    const entry = entries.get(requestID)
    if (entry === undefined) {
      logger.debug({requestID, reply}, 'ApprovalRegistry: confirmReply — entry not found (already settled?)')
      return
    }

    // P2 defensive guard: cross-session settle prevention.
    // requestIDs are globally unique (per_...) so this should never fire in
    // practice, but guards against any future ID-collision scenario.
    if (entry.sessionID !== sessionID) {
      logger.warn(
        {requestID, entrySessionID: entry.sessionID, eventSessionID: sessionID},
        'ApprovalRegistry: confirmReply — sessionID mismatch, ignoring (cross-session guard)',
      )
      return
    }

    // Clear the deadline timer regardless of state — this event is authoritative.
    clearTimer(entry)

    // Log if OpenCode's reply differs from our claimed decision (it wins).
    if ((entry.state === 'claimed' || entry.state === 'confirmed') && entry.decidedBy !== null) {
      // The reply is the echo of our POST. Render with OpenCode's reply.
      logger.info({requestID, state: entry.state, reply}, 'ApprovalRegistry: confirmReply — button winner echo')
    } else {
      // Open entry: OpenCode-initiated (unsolicited reject or always-rule). No POST needed.
      logger.info({requestID, state: entry.state, reply}, 'ApprovalRegistry: confirmReply — OpenCode-initiated')
    }

    entries.delete(requestID)

    // Render asynchronously (best-effort; errors logged inside runRender).
    // eslint-disable-next-line no-void
    void runRender(entry, requestID, reply, 'replied').then(() => {
      // FIX 1: cascade only `open` siblings — skip `claimed` siblings entirely.
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
    // FIX 1: only cascade to `open` siblings; skip `claimed` ones.
    const siblings = Array.from(entries.entries()).filter(([, e]) => e.sessionID === sessionID && e.state === 'open')
    await Promise.all(
      siblings.map(async ([sibID, sib]) => {
        clearTimer(sib)
        entries.delete(sibID)
        logger.info({requestID: sibID, sessionID}, 'ApprovalRegistry: cascade-rejecting sibling permission')
        // Best-effort reject POST for the sibling (spec: KEEP the cascade POST).
        try {
          await sib.effects.postReply(sibID, sib.directory, 'reject')
        } catch (error) {
          logger.warn({requestID: sibID, err: error}, 'ApprovalRegistry: cascade postReply threw — continuing')
        }
        await runRender(sib, sibID, 'reject', 'cascade')
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

    const entry = entries.get(requestID)
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

    // Clear deadline timer on any terminal path.
    clearTimer(entry)

    // For non-replied/non-cascade reasons on open entries: best-effort postReply.
    // Skip if already claimed/confirmed (postReply was or is being sent).
    if (reason !== 'replied' && reason !== 'cascade' && entry.state === 'open') {
      entry.state = 'claimed'
      try {
        const r = await entry.effects.postReply(requestID, entry.directory, decision)
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
    await runRender(entry, requestID, decision, reason)

    // Unregister
    entries.delete(requestID)
  }

  // -------------------------------------------------------------------------
  // disposeRun
  // -------------------------------------------------------------------------

  async function disposeRun(sessionID: string, reason: string): Promise<void> {
    const snapshot = Array.from(entries.entries())
      .filter(([, entry]) => entry.sessionID === sessionID)
      .map(([requestID]) => requestID)
    if (snapshot.length > 0) {
      logger.warn(
        {sessionID, reason, count: snapshot.length},
        'ApprovalRegistry: disposeRun — fail-closing run entries',
      )
    }
    await Promise.all(
      snapshot.map(async requestID => {
        try {
          await applySettlement({requestID, decision: 'reject', reason: 'disposed'})
        } catch (error) {
          logger.error({requestID, err: error}, 'ApprovalRegistry: disposeRun — applySettlement threw — continuing')
        }
      }),
    )
  }

  // -------------------------------------------------------------------------
  // disposeAll
  // -------------------------------------------------------------------------

  async function disposeAll(_reason: string): Promise<void> {
    // Snapshot keys before iteration so deletion during iteration is safe
    const snapshot = Array.from(entries.keys())
    await Promise.all(
      snapshot.map(async requestID => {
        try {
          await applySettlement({requestID, decision: 'reject', reason: 'disposed'})
        } catch (error) {
          logger.error({requestID, err: error}, 'ApprovalRegistry: disposeAll — applySettlement threw — continuing')
        }
      }),
    )
  }

  return {
    register,
    attachMessage,
    markMessagePostFailed,
    has,
    pending,
    handleButtonDecision,
    confirmReply,
    applySettlement,
    disposeRun,
    disposeAll,
  }
}
