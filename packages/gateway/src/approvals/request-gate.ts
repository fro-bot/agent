/**
 * Shared lifecycle core for gateway human-wait requests.
 *
 * Two request families settle through one gate: tool approvals
 * (`registry.ts`) and agent questions (`question-registry.ts`). The gate owns
 * what must be identical for both so settlement cannot drift between them:
 *
 * - the entry map keyed by request id;
 * - the `open → claimed → confirmed` state machine and the single-winner claim;
 * - the scope check, through a family-supplied {@link ScopePolicy};
 * - the registry-owned deadline timer and the claimed-vs-deadline handshake;
 * - authoritative echo settlement, including entries nobody on the gateway claimed;
 * - run teardown (`disposeRun` / `disposeAll`);
 * - one terminal notification per request id.
 *
 * Each family supplies, per entry, a {@link GateEntryOps} bundle: the reply
 * sent when the deadline wins, the settled render, and its own teardown.
 *
 * ### Entry lifecycle
 *
 * ```
 *   open  ──claim──▶  claimed  ──echo──▶  (removed)
 *     ▲                  │
 *     └── reply failed ──┘   (fail-closed instead when the deadline already passed)
 * ```
 *
 * ### Deadline vs. claim
 *
 * - Deadline on an `open` entry: the deadline wins — send the family's deadline
 *   reply, render, remove.
 * - Deadline on a `claimed` entry: the claimant wins and the deadline is a
 *   no-op, but `deadlineExpired` is set. If the claimant's reply then fails,
 *   the entry fail-closes with the deadline reply instead of re-opening with
 *   a dead timer.
 * - Teardown always wins, regardless of state.
 *
 * ### Terminal notification
 *
 * Every entry emits exactly one {@link TerminalEvent} to the registered
 * listeners when it leaves the gate: echo, deadline, fail-close, or teardown.
 * The event does not depend on an echo arriving, and an echo that arrives
 * after the entry already left finds nothing to settle, so it cannot emit a
 * second event. Re-registering a request id replaces its entry without an
 * event; the replacement emits when it leaves.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {OperatorIdentity} from '../operator-contract/identity.js'
import type {QuestionPayload} from './question-registry.js'
import type {ApprovalPayload} from './registry.js'

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/** A Discord user who acted on a request from a thread. */
export interface DiscordApprovalActor {
  readonly kind: 'discord-user'
  /** Discord snowflake ID of the acting user. */
  readonly userId: string
}

/** A web operator who acted through the control surface (alias of the canonical identity). */
export type WebOperatorActor = OperatorIdentity

/** Transport-neutral actor identity, discriminated on `kind`. */
export type GateActor = DiscordApprovalActor | WebOperatorActor

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export type RequestFamily = 'approval' | 'question'

export type EntryState = 'open' | 'claimed' | 'confirmed'

/** Result of a reply/reject call to OpenCode. */
export interface ReplyResult {
  readonly ok: boolean
  readonly error?: string
}

/** Family-supplied behavior the gate invokes on a single entry. */
export interface GateEntryOps {
  /**
   * Reply sent when the deadline wins, and when a claim fail-closes after the deadline passed.
   * Return the underlying promise directly: the gate's microtask ordering around settlement is pinned by tests.
   */
  readonly postDeadlineReply: () => Promise<ReplyResult>
  /** Settled render for the deadline outcome. Best-effort: the family catches render failures. */
  readonly renderDeadline: () => Promise<void>
  /** Family teardown for run end / shutdown. Must leave the gate through {@link RequestGate.remove} + {@link RequestGate.terminate}. */
  readonly dispose: () => Promise<void>
  /** Invoked after the deadline wins on an `open` entry (best-effort). */
  readonly onDeadlineSettled: (() => void | Promise<void>) | undefined
}

interface EntryBase {
  readonly requestID: string
  readonly sessionID: string
  readonly scopeId: string
  readonly ops: GateEntryOps
  state: EntryState
  /** The actor that claimed the entry; null while open and after a fail-close. */
  actor: GateActor | null
  /** Deadline timer handle — cleared on any terminal transition. */
  timer: ReturnType<typeof setTimeout> | null
  /** True once the deadline fired while the entry was `claimed`. */
  deadlineExpired: boolean
  /** True once the terminal notification was emitted (or deliberately suppressed on replacement). */
  terminalFired: boolean
}

export interface ApprovalGateEntry extends EntryBase {
  readonly family: 'approval'
  readonly payload: ApprovalPayload
}

export interface QuestionGateEntry extends EntryBase {
  readonly family: 'question'
  readonly payload: QuestionPayload
}

export type GateEntry = ApprovalGateEntry | QuestionGateEntry

// ---------------------------------------------------------------------------
// Scope policy, claim, terminal events
// ---------------------------------------------------------------------------

/** Family-supplied rule: may this actor, acting from this scope, settle this entry? */
export type ScopePolicy = (
  entry: Pick<GateEntry, 'scopeId'>,
  request: {readonly scopeId: string; readonly actor: GateActor},
) => boolean

export type AdmitOutcome = 'admitted' | 'scope-mismatch' | 'already-claimed'

/** How an entry left the gate. */
export type TerminalOutcome = 'confirmed' | 'cascade' | 'deadline' | 'disposed' | 'fail-closed'

/** Notification that a request will no longer block its run. Carries identifiers only. */
export interface TerminalEvent {
  readonly requestID: string
  readonly sessionID: string
  readonly family: RequestFamily
  readonly scopeId: string
  readonly outcome: TerminalOutcome
}

export type TerminalListener = (event: TerminalEvent) => void

// ---------------------------------------------------------------------------
// Gate interface
// ---------------------------------------------------------------------------

export interface RequestGate {
  /** Look up the live entry for a request id (any family). */
  readonly get: (requestID: string) => GateEntry | undefined
  /** Snapshot of all live entries. */
  readonly list: () => readonly GateEntry[]
  /** Insert an entry and arm its deadline timer when `deadlineMs` is positive. */
  readonly put: (entry: GateEntry, deadlineMs: number | undefined) => void
  /**
   * Retire an entry that is being replaced by a new entry for the same request
   * id: clears its timer and suppresses its terminal notification, because the
   * request id remains pending under the replacement.
   */
  readonly detach: (entry: GateEntry) => void
  readonly clearTimer: (entry: GateEntry) => void
  /** Remove the entry from the map if it is still the registered one. */
  readonly remove: (entry: GateEntry) => void
  /** Emit the terminal notification for the entry, at most once. */
  readonly terminate: (entry: GateEntry, outcome: TerminalOutcome) => void
  /** Log a settled-render failure without raising it. Families call this from their render wrapper's catch. */
  readonly logRenderFailure: (entry: GateEntry, reason: string, error: unknown) => void
  /** Scope + single-winner check. Does not change state. */
  readonly admit: (
    entry: GateEntry,
    request: {readonly scopeId: string; readonly actor: GateActor},
    policy: ScopePolicy,
  ) => AdmitOutcome
  /** Atomic `open → claimed` transition. Call synchronously after {@link RequestGate.admit}. */
  readonly claim: (entry: GateEntry, actor: GateActor) => void
  /**
   * Send the claimant's reply. On success the entry stays `claimed` until the
   * echo settles it. On failure the claim is released to `open`, or the entry
   * fail-closes when the deadline already passed.
   */
  readonly postClaimed: (entry: GateEntry, post: () => Promise<ReplyResult>) => Promise<'ok' | 'reply-failed'>
  /**
   * Authoritative echo settlement: clear the timer, remove the entry, start the
   * settled render, emit the terminal notification. Resolves when the render finishes.
   */
  readonly settleEcho: (entry: GateEntry, render: () => Promise<void>) => Promise<void>
  /** True when an `open` or `claimed` entry of the family exists for the scope. */
  readonly hasPendingForScope: (family: RequestFamily, scopeId: string) => boolean
  /** Fail-close every entry of the session, across families. */
  readonly disposeRun: (sessionID: string, reason: string) => Promise<void>
  /** Fail-close every entry, across families. */
  readonly disposeAll: (reason: string) => Promise<void>
  /** Subscribe to terminal notifications. Returns an unsubscribe function. */
  readonly onTerminal: (listener: TerminalListener) => () => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRequestGate(deps: {readonly logger: GatewayLogger}): RequestGate {
  const {logger} = deps
  const entries = new Map<string, GateEntry>()
  const listeners = new Set<TerminalListener>()

  function label(entry: GateEntry): string {
    return entry.family === 'approval' ? 'ApprovalRegistry' : 'QuestionRegistry'
  }

  /**
   * Error fields for a log call. Approval errors keep the raw error object;
   * question errors log only the error name, because a question-family error
   * message can echo question or answer text.
   */
  function errorFields(entry: GateEntry, error: unknown): Record<string, unknown> {
    if (entry.family === 'approval') return {err: error}
    return {errName: error instanceof Error ? error.name : typeof error}
  }

  function get(requestID: string): GateEntry | undefined {
    return entries.get(requestID)
  }

  function list(): readonly GateEntry[] {
    return Array.from(entries.values())
  }

  function clearTimer(entry: GateEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  function put(entry: GateEntry, deadlineMs: number | undefined): void {
    entries.set(entry.requestID, entry)
    if (deadlineMs !== undefined && deadlineMs > 0) {
      entry.timer = setTimeout(() => {
        settleByDeadline(entry)
      }, deadlineMs)
      entry.timer.unref?.()
    }
  }

  function detach(entry: GateEntry): void {
    clearTimer(entry)
    entry.terminalFired = true
  }

  function remove(entry: GateEntry): void {
    if (entries.get(entry.requestID) === entry) {
      entries.delete(entry.requestID)
    }
  }

  function terminate(entry: GateEntry, outcome: TerminalOutcome): void {
    if (entry.terminalFired) return
    entry.terminalFired = true
    const event: TerminalEvent = {
      requestID: entry.requestID,
      sessionID: entry.sessionID,
      family: entry.family,
      scopeId: entry.scopeId,
      outcome,
    }
    for (const listener of Array.from(listeners)) {
      try {
        listener(event)
      } catch (error) {
        logger.error(
          {requestID: entry.requestID, family: entry.family, ...errorFields(entry, error)},
          'RequestGate: terminal listener threw — continuing',
        )
      }
    }
  }

  function logRenderFailure(entry: GateEntry, reason: string, error: unknown): void {
    logger.error(
      {requestID: entry.requestID, reason, ...errorFields(entry, error)},
      `${label(entry)}: renderFn threw during settlement — continuing`,
    )
  }

  function logDeadlineReplyFailure(entry: GateEntry, context: 'deadline' | 'failCloseNow', result: ReplyResult): void {
    logger.warn(
      {requestID: entry.requestID, error: result.error},
      `${label(entry)}: ${context} postReply returned ok:false — continuing`,
    )
  }

  function logDeadlineReplyThrow(entry: GateEntry, context: 'deadline' | 'failCloseNow', error: unknown): void {
    logger.warn(
      {requestID: entry.requestID, ...errorFields(entry, error)},
      `${label(entry)}: ${context} postReply threw — continuing`,
    )
  }

  /**
   * Fail-close: send the deadline reply, render the deadline outcome, remove.
   * Used when a claim's reply fails after the deadline already passed.
   */
  async function failCloseNow(entry: GateEntry): Promise<void> {
    logger.warn({requestID: entry.requestID}, `${label(entry)}: fail-closing entry (deadline already expired)`)
    entry.state = 'claimed'
    entry.actor = null
    try {
      const r = await entry.ops.postDeadlineReply()
      if (!r.ok) logDeadlineReplyFailure(entry, 'failCloseNow', r)
    } catch (error) {
      logDeadlineReplyThrow(entry, 'failCloseNow', error)
    }
    // An echo that landed while the reply was in flight already rendered and removed the entry.
    if (entries.get(entry.requestID) === entry) {
      await renderDeadline(entry)
      remove(entry)
    }
    terminate(entry, 'fail-closed')
  }

  async function renderDeadline(entry: GateEntry): Promise<void> {
    try {
      await entry.ops.renderDeadline()
    } catch (error) {
      logRenderFailure(entry, 'deadline', error)
    }
  }

  /**
   * Deadline timer callback. Only an `open` entry settles — a claimant that
   * got there first keeps ownership, and `deadlineExpired` is recorded so a
   * failed claim can fail-close instead of re-opening.
   */
  function settleByDeadline(entry: GateEntry): void {
    if (entries.get(entry.requestID) !== entry) return // already gone or replaced

    if (entry.state !== 'open') {
      entry.deadlineExpired = true
      logger.debug(
        {requestID: entry.requestID, state: entry.state},
        `${label(entry)}: deadline fired but entry is claimed — no-op (claimant wins); deadlineExpired set`,
      )
      return
    }

    logger.warn({requestID: entry.requestID}, `${label(entry)}: deadline expired on open entry — fail-closed`)
    entry.state = 'claimed'
    entry.timer = null

    const doDeadline = async (): Promise<void> => {
      try {
        const r = await entry.ops.postDeadlineReply()
        if (!r.ok) logDeadlineReplyFailure(entry, 'deadline', r)
      } catch (error) {
        logDeadlineReplyThrow(entry, 'deadline', error)
      }
      // An echo that landed while the reply was in flight already rendered and removed the entry.
      if (entries.get(entry.requestID) === entry) {
        await renderDeadline(entry)
        remove(entry)
      }
      terminate(entry, 'deadline')

      const {onDeadlineSettled} = entry.ops
      if (onDeadlineSettled !== undefined) {
        try {
          await onDeadlineSettled()
        } catch (error) {
          logger.warn(
            {requestID: entry.requestID, ...errorFields(entry, error)},
            `${label(entry)}: onDeadlineSettled threw — continuing`,
          )
        }
      }
    }

    // eslint-disable-next-line no-void
    void doDeadline()
  }

  function admit(
    entry: GateEntry,
    request: {readonly scopeId: string; readonly actor: GateActor},
    policy: ScopePolicy,
  ): AdmitOutcome {
    if (!policy(entry, request)) {
      logger.warn(
        {requestID: entry.requestID, expected: entry.scopeId, received: request.scopeId},
        `${label(entry)}: scope mismatch — ignoring decision`,
      )
      return 'scope-mismatch'
    }
    // Single-winner gate: claimed or confirmed both block a second decision.
    if (entry.state === 'claimed' || entry.state === 'confirmed') {
      return 'already-claimed'
    }
    return 'admitted'
  }

  function claim(entry: GateEntry, actor: GateActor): void {
    entry.state = 'claimed'
    entry.actor = actor
  }

  function releaseFailedClaim(entry: GateEntry): 'reply-failed' {
    if (entry.deadlineExpired) {
      // The deadline fired while the claim was in flight: fail-close instead of
      // leaving the entry open with a dead timer.
      // eslint-disable-next-line no-void
      void failCloseNow(entry)
    } else {
      entry.state = 'open'
      entry.actor = null
    }
    return 'reply-failed'
  }

  async function postClaimed(entry: GateEntry, post: () => Promise<ReplyResult>): Promise<'ok' | 'reply-failed'> {
    let result: ReplyResult
    try {
      result = await post()
    } catch (error) {
      logger.error(
        {requestID: entry.requestID, ...errorFields(entry, error)},
        `${label(entry)}: postReply threw — resetting to open`,
      )
      return releaseFailedClaim(entry)
    }

    if (!result.ok) {
      logger.error(
        {requestID: entry.requestID, error: result.error},
        `${label(entry)}: postReply returned ok:false — resetting to open`,
      )
      return releaseFailedClaim(entry)
    }

    // Stay claimed — the settled render happens when OpenCode echoes back.
    // The deadline must keep seeing `claimed` so it backs off.
    return 'ok'
  }

  async function settleEcho(entry: GateEntry, run: () => Promise<void>): Promise<void> {
    // The echo is authoritative: clear the deadline timer regardless of state.
    clearTimer(entry)
    remove(entry)
    // The render starts before listeners run, so a settle frame is enqueued ahead of any run-level consequence.
    const rendered = run().catch((error: unknown) => {
      logRenderFailure(entry, 'replied', error)
    })
    terminate(entry, 'confirmed')
    await rendered
  }

  function hasPendingForScope(family: RequestFamily, scopeId: string): boolean {
    for (const entry of entries.values()) {
      if (
        entry.family === family &&
        entry.scopeId === scopeId &&
        (entry.state === 'open' || entry.state === 'claimed')
      ) {
        return true
      }
    }
    return false
  }

  async function disposeEntries(snapshot: readonly GateEntry[], context: 'disposeRun' | 'disposeAll'): Promise<void> {
    await Promise.all(
      snapshot.map(async entry => {
        try {
          await entry.ops.dispose()
        } catch (error) {
          logger.error(
            {requestID: entry.requestID, ...errorFields(entry, error)},
            `${label(entry)}: ${context} — dispose threw — continuing`,
          )
        }
      }),
    )
  }

  async function disposeRun(sessionID: string, reason: string): Promise<void> {
    const snapshot = list().filter(entry => entry.sessionID === sessionID)
    if (snapshot.length > 0) {
      logger.warn({sessionID, reason, count: snapshot.length}, 'RequestGate: disposeRun — fail-closing run entries')
    }
    await disposeEntries(snapshot, 'disposeRun')
  }

  async function disposeAll(_reason: string): Promise<void> {
    // Snapshot before iterating so removal during disposal is safe.
    await disposeEntries(list(), 'disposeAll')
  }

  function onTerminal(listener: TerminalListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    get,
    list,
    put,
    detach,
    clearTimer,
    remove,
    terminate,
    logRenderFailure,
    admit,
    claim,
    postClaimed,
    settleEcho,
    hasPendingForScope,
    disposeRun,
    disposeAll,
    onTerminal,
  }
}
