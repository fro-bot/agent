/**
 * Execute+stream core for the gateway.
 *
 * Responsibility boundary:
 * - Owns: session creation, prompt send, event subscription, event → sink
 *   routing, resolution on `session.idle`.
 * - Does NOT own: lock, run-state lifecycle, heartbeat, mention routing,
 *   authorization gate. Those live in `run.ts`.
 *
 * Error surface: throws `RunCoreError` on attach/connect failure, proxy 401,
 * session error, prompt rejection, run timeout, or premature stream close.
 * `run.ts` maps `kind` to coarse Discord replies (no internal detail leaked).
 *
 * Critical constraint (SSE-routing memory): `session.create`, `event.subscribe`,
 * AND `promptAsync` must all carry the workspace repo `directory` in their query
 * params. Omitting `directory` from any of the three splits the SSE listener from
 * the publisher — tool events never arrive.
 */

import type {OpenCodeServerHandle, OwnershipEntryState, OwnershipLedger} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {QuestionCoordinator} from '../approvals/question-coordinator.js'
import type {TerminalListener} from '../approvals/request-gate.js'
import type {GatewayLogger} from '../discord/client.js'
import type {DrainCompletion} from './drain-completion.js'
import type {ProviderFailure, ProviderFailureReason} from './provider-failure.js'

import {
  createInactivityTimer,
  createLedgerReconciler,
  createOwnershipLedger,
  createSdkLedgerReconcileAdapter,
  getBooleanProperty,
  getEventKind,
  getEventPayload,
  getEventSessionID,
  getObjectProperty,
  getSessionID,
  getStringProperty,
  parseSyntheticNoticePart,
} from '@fro-bot/runtime'
import {parsePermissionReply, parsePermissionRequest} from '../approvals/coordinator.js'
import {parseQuestionEcho, parseQuestionRequest, safeLogId} from '../approvals/question-coordinator.js'
import {createDrainCompletion} from './drain-completion.js'
import {formatToolPart} from './format-part.js'
import {reconcileLivePass} from './live-reconcile.js'
import {
  failureFromErrorObject,
  failureFromErrorText,
  failureFromRetryStatus,
  isAbortedError,
  isContextOverflowError,
} from './provider-failure.js'
import {createReplyDeliveryTracker} from './reply-delivery.js'
import {toRuntimeLogger} from './runtime-logger.js'
import {settleOwnedSessions} from './settle-owned-sessions.js'
import {createTextBoundaryTracker} from './text-boundary.js'

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/** Which kind of request a human wait is held for. */
type HumanWaitKind = 'approval' | 'question'

/** Discriminant for `RunCoreError` — `run.ts` maps these to coarse Discord replies. */
export type RunCoreErrorKind =
  | 'unreachable' // network error / server not reachable
  | 'auth' // proxy rejected the bearer token (401)
  | 'session-error' // OpenCode `session.error` event received
  | 'prompt-error' // `promptAsync` returned an error
  | 'timeout' // run exceeded the configured wall-clock timeout
  | 'inactivity-timeout' // run exceeded the inactivity timeout (no text/tool progress)
  | 'stream-ended' // event stream closed before session.idle was received
  | 'missing-coordinator' // approval-required mode but no coordinator provided (fail-closed)
  | 'drain-timeout' // root session went idle with owned work outstanding and the deadline expired before it settled
  | 'checkout-substituted' // inspect() found a tree that is not the expected repository — a correctness failure, not a missing label
  | 'workspace-unavailable' // clone failed for a reason that will not resolve on its own (e.g. the repo does not exist or is inaccessible) — do not invite a retry

/**
 * Error thrown by `runOpenCodeCore` on any failure path.
 *
 * The `message` field is for internal logging only — never post it to Discord.
 * `run.ts` maps `kind` to coarse user-visible replies.
 *
 * `quarantined` is `true` only when this failure passed through the
 * termination barrier (`throwWithBarrier`, see below) and the barrier could
 * NOT confirm that this run's owned background sessions actually stopped.
 * `kind` and `message` are never altered by quarantine — they always
 * describe the ORIGINAL causal failure; quarantine is additional safety
 * evidence layered on top, never a replacement explanation. `run.ts` must
 * treat a quarantined error as a signal to hold the lock, keep the heartbeat
 * renewing it, and refuse hand-off — never release or hand off resources for
 * a run whose owned work could not be confirmed settled.
 *
 * `providerFailureReason` is set only by `failFromProvider` (always with `kind: 'session-error'`): the
 * closed, fixed-text reason from the provider-failure classifier. `run.ts` reads this typed property and
 * never parses `message`. It is carried through every `throwWithBarrier` throw site, quarantined or not.
 *
 * `cause` is the underlying error when the failure wraps one (an event stream that rejected, an unexpected
 * throw in the event loop). Like `message`, it is for internal logging only.
 */
export class RunCoreError extends Error {
  readonly kind: RunCoreErrorKind
  readonly quarantined: boolean
  readonly providerFailureReason?: ProviderFailureReason

  constructor(
    kind: RunCoreErrorKind,
    internalMessage: string,
    quarantined = false,
    providerFailureReason?: ProviderFailureReason,
    cause?: unknown,
  ) {
    super(internalMessage, cause === undefined ? undefined : {cause})
    this.name = 'RunCoreError'
    this.kind = kind
    this.quarantined = quarantined
    if (providerFailureReason !== undefined) {
      this.providerFailureReason = providerFailureReason
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal sink interface
// ---------------------------------------------------------------------------

/**
 * Minimal streaming sink interface required by `runOpenCodeCore`.
 *
 * `runOpenCodeCore` only calls `sink.append(text)` — it never calls `flush()`,
 * `buffered()`, or any other method. The caller (`run.ts`) is responsible for
 * flushing after `runOpenCodeCore` resolves.
 *
 * Both `ReplySink` (from `execute/launch-types.ts`) and `DiscordStreamSink`
 * (from `discord/streaming.ts`) satisfy this interface structurally, so no
 * cast is needed at the call site in `run.ts`.
 */
export interface CoreStreamSink {
  /** Append a text delta to the internal buffer. */
  readonly append: (text: string) => void
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** Parameters for the execute+stream core. */
export interface RunCoreParams {
  /** Handle to the remote OpenCode server (attach result from `opencode-attach.ts`). */
  readonly handle: OpenCodeServerHandle
  /**
   * Absolute path to the workspace repo checkout.
   * Threaded to `session.create`, `event.subscribe`, AND `promptAsync` — required
   * for SSE routing to deliver tool events.
   */
  readonly directory: string
  /**
   * Pre-built prompt text (from `buildDiscordPrompt`).
   * Must be non-empty — callers are expected to validate before calling.
   */
  readonly promptText: string
  /**
   * Streaming sink that receives text deltas.
   * Caller is responsible for calling `sink.flush()` after `runOpenCodeCore`
   * resolves (`run.ts` does this after transitioning to COMPLETED).
   *
   * Typed as `CoreStreamSink` (only `append` required) so both `ReplySink` and
   * `DiscordStreamSink` are structurally assignable without a cast.
   */
  readonly sink: CoreStreamSink
  /** Abort signal — aborts event iteration when signalled. */
  readonly signal: AbortSignal
  /** Injected logger. Internal details only — never leak session internals to Discord. */
  readonly logger: GatewayLogger
  /**
   * Gateway approval mode. Currently only `approval-required` is supported.
   * `autonomous-low-risk` is deferred (unsafe due to OpenCode last-match-wins evaluation).
   * When present, must be `approval-required`; when absent, defaults to `approval-required`.
   */
  readonly approvalMode?: 'approval-required'
  /**
   * Permission coordinator. Required when `approvalMode` is `approval-required` (the only
   * supported mode). Fail-closed: if absent, `runOpenCodeCore` throws before session creation.
   */
  readonly coordinator?: PermissionCoordinator
  /**
   * Question coordinator. When absent, `question.*` events are not handled: an owned
   * `question.asked` is warn-logged and does not pause the inactivity watchdog.
   */
  readonly questions?: QuestionCoordinator
  /**
   * Subscription to the request gate's terminal notifications (`RequestGate.onTerminal`).
   * `runOpenCodeCore` subscribes once for the run and releases the matching human wait on
   * every terminal event, so a settlement that produces no OpenCode echo (deadline skip,
   * failed reply, teardown) still re-arms the watchdog and unblocks drain. Unsubscribed
   * when the event loop exits. No-op when absent.
   */
  readonly onHumanWaitTerminal?: (listener: TerminalListener) => () => void
  /**
   * Optional hook called with each essential tool-action summary string as it is appended.
   * Receives the same summary string that `appendToolSummary` computes — no recomputation.
   * Used by `run.ts` to drive the status controller's `noteActivity`.
   * No-op when absent.
   */
  readonly onActivity?: (summary: string) => void
  /**
   * Optional hook called when the busy state changes.
   * - `true`: work has started (prompt sent to session).
   * - `false`: work has stopped (session.idle received, or run is blocked on an approval wait).
   * Used by `run.ts` to drive the status controller's `setBusy`.
   * No-op when absent.
   */
  readonly onBusy?: (busy: boolean) => void
  /**
   * Optional inactivity timeout in milliseconds.
   * When set, the run is aborted with `kind: 'inactivity-timeout'` if no text delta or
   * tool completion is received within this window. The timer resets on every text delta,
   * tool completion, and permission.replied event. It is paused (cleared) on
   * permission.asked and re-armed on permission.replied.
   * When absent, no inactivity timeout is applied.
   */
  readonly inactivityTimeoutMs?: number
  /**
   * Ownership ledger for background subagents this run has dispatched.
   *
   * When present, `runOpenCodeCore` does three additional things it otherwise
   * skips entirely (backward-compatible no-op when absent):
   * - Adopts a session into the ledger (and registers it with
   *   `coordinator.addOwnedSession`) when a `task` tool call completes with
   *   `state.metadata.background === true` — the observable signal that a
   *   background dispatch was made (see `tool/task.ts` upstream).
   * - Treats the root session's `session.idle` as a DRAIN signal rather than
   *   completion once any dispatch was adopted: the run keeps consuming the
   *   event stream (routing descendant approvals/activity as normal) and
   *   periodically reconciling (via `createLedgerReconciler`) until the
   *   drain-completion gate (`drain-completion.ts`) admits success or the
   *   run's own deadline (`signal`) expires. A settled ledger alone is not
   *   enough: upstream marks a child non-live BEFORE it injects the parent's
   *   follow-up turn, so the gate also needs each child's completion notice
   *   (or REST cancel evidence), current root idle, and REST corroboration.
   *   `runOpenCodeCore` returns only then — so a caller awaiting this call
   *   already waits out the full drain, and no separate drain stage is
   *   needed in `run.ts`. A run that never adopted a dispatch is unaffected.
   * - On deadline expiry while draining, cancels every still-outstanding
   *   entry individually (`session.abort`) and throws `RunCoreError` with
   *   kind `'drain-timeout'` instead of waiting indefinitely.
   */
  readonly ownershipLedger?: OwnershipLedger
  /**
   * Called after every ledger mutation (adopt/settle/markUnknown) with the
   * root session id and the current set of NOT-YET-SETTLED owned session ids
   * (outstanding + unknown; settled entries are omitted since recovery has
   * nothing left to reconcile for them). `run.ts` uses this to persist
   * ownership onto the run's `RunState.details` continuously, matching the
   * shape `recovery.ts`'s `readPersistedOwnership` reads
   * (`details.rootSessionId`, `details.ownedSessionIds`). Fire-and-forget from
   * `runOpenCodeCore`'s perspective — a slow or failing persist must never
   * stall event processing. No-op when absent.
   */
  readonly onOwnershipChange?: (info: {
    readonly rootSessionId: string
    readonly ownedSessionIds: readonly string[]
  }) => void
}

/** Snapshot of every tracked entry's state, keyed by session id — the comparison basis for detecting a genuine mutation. */
function snapshotStates(ledger: OwnershipLedger): ReadonlyMap<string, OwnershipEntryState> {
  return new Map(ledger.snapshot().map(entry => [entry.sessionId, entry.state]))
}

function statesEqual(
  before: ReadonlyMap<string, OwnershipEntryState>,
  after: ReadonlyMap<string, OwnershipEntryState>,
): boolean {
  if (before.size !== after.size) return false
  for (const [sessionId, state] of before) {
    if (after.get(sessionId) !== state) return false
  }
  return true
}

/**
 * Wrap an `OwnershipLedger` so every mutating call also fires `onChange` —
 * used to persist ownership onto run state and to re-check drain completion
 * after every adopt/settle/markUnknown, regardless of whether the mutation
 * came from an observed dispatch event or a reconciliation pass (both go
 * through this wrapper since reconciliation is handed the wrapped instance).
 *
 * `onChange` (and, for `adopt`, `onAdopted`) only fires when the mutation
 * actually changed the ledger's tracked state. All three mutators are
 * idempotent by contract (`adopt` on an already-tracked id, `settle` on a
 * missing or already-settled entry, `markUnknown` on a missing/settled/
 * already-unknown entry are all no-ops) — firing on those calls would mean a
 * duplicate event or a repeated reconciliation pass triggers a redundant
 * remote persistence write for state that did not move. Comparing the full
 * per-session state snapshot (not just membership) is required, not just an
 * optimization: an `outstanding` → `unknown` transition keeps the session in
 * the ledger the whole time, so a membership-only comparison would miss it,
 * but it IS a real state change that must reach `onChange` so the unknown
 * entry is persisted.
 *
 * `onAdopted` is the gateway's hook point for registering a directly-observed
 * dispatch with `coordinator.addOwnedSession` — see `runOpenCodeCore`. In
 * practice this fires only from the `task`-tool-completion path: reconciliation
 * never calls `adopt` (it settles or downgrades already-tracked entries only —
 * see `@fro-bot/runtime`'s `ledger-reconcile.ts` module doc), so a
 * reconciliation pass never reaches this branch. It intentionally lives here,
 * at the gateway's existing ledger-wrapping boundary, rather than as a
 * callback threaded through `reconcileLedgerOnce` in `@fro-bot/runtime`: that
 * primitive is shared with the Action, which has no coordinator concept at
 * all, and every ledger mutation — from either path — already flows through
 * this single wrapper (reconciliation is handed the wrapped ledger instance).
 * Adding a gateway-only hook here keeps the runtime primitive free of gateway
 * concepts and leaves the Action's direct, unwrapped use of
 * `createLedgerReconciler`/`reconcileLedgerOnce` untouched.
 *
 * Exported for direct unit testing of the no-op detection: through the real
 * `runOpenCodeCore` → `reconcileLedgerOnce` path, `settle`/`markUnknown` can
 * only ever be called once per entry per genuine transition (the reconcile
 * loop snapshots once and skips non-outstanding/non-unknown entries), so a
 * true duplicate call cannot be forced deterministically through that
 * integration path — exercising this wrapper directly is the only reliable
 * way to prove the no-op branch itself.
 */
export function wrapLedgerWithHooks(
  ledger: OwnershipLedger,
  onChange: () => void,
  onAdopted: (sessionId: string) => void,
): OwnershipLedger {
  return {
    adopt: (sessionId, label) => {
      const before = snapshotStates(ledger)
      ledger.adopt(sessionId, label)
      const after = snapshotStates(ledger)
      if (statesEqual(before, after)) return
      onAdopted(sessionId)
      onChange()
    },
    settle: sessionId => {
      const before = snapshotStates(ledger)
      ledger.settle(sessionId)
      const after = snapshotStates(ledger)
      if (statesEqual(before, after)) return
      onChange()
    },
    markUnknown: sessionId => {
      const before = snapshotStates(ledger)
      ledger.markUnknown(sessionId)
      const after = snapshotStates(ledger)
      if (statesEqual(before, after)) return
      onChange()
    },
    outstanding: () => ledger.outstanding(),
    unknown: () => ledger.unknown(),
    isDrainComplete: () => ledger.isDrainComplete(),
    isPersistenceSafe: () => ledger.isPersistenceSafe(),
    snapshot: () => ledger.snapshot(),
    isTracked: sessionId => ledger.isTracked(sessionId),
  }
}

// ---------------------------------------------------------------------------
// Tool-call correlation table
// ---------------------------------------------------------------------------

interface ToolCallInfo {
  readonly tool: string
  readonly input: unknown
}

// ---------------------------------------------------------------------------
// Shared tool-render helper (P2.6 + P1.2)
// ---------------------------------------------------------------------------

/**
 * Fail-soft tool-render helper shared by both tool event paths.
 *
 * Calls `formatToolPart`, catches any exception (malformed input, unexpected
 * shape), logs `{tool, status}` only (no raw content), and appends nothing on
 * error. A throwing `formatToolPart` must never abort the event stream.
 *
 * When `onActivity` is provided, it is called with the same summary string
 * that is appended to the sink — no recomputation.
 */
function appendToolSummary(
  part: import('./format-part.js').ExtractedToolPart,
  sink: CoreStreamSink,
  logger: GatewayLogger,
  onActivity?: (summary: string) => void,
): void {
  let summary: string | null
  try {
    summary = formatToolPart(part)
  } catch {
    logger.warn({tool: part.tool, status: part.state.status}, 'run-core: formatToolPart threw — skipping tool line')
    return
  }
  if (summary !== null && summary.length > 0) {
    sink.append(`\n${summary}\n`)
    onActivity?.(summary)
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function runOpenCodeCore(params: RunCoreParams): Promise<void> {
  const {
    handle,
    directory,
    promptText,
    sink,
    signal,
    logger,
    coordinator,
    questions,
    onHumanWaitTerminal,
    approvalMode,
    onActivity,
    onBusy,
    inactivityTimeoutMs,
    ownershipLedger,
    onOwnershipChange,
  } = params
  const {client} = handle

  // ── 0. Mode/coordinator pre-flight ────────────────────────────────────────
  // Coordinator is required unconditionally: approval-required is the only supported mode
  // and it requires a coordinator before any session or prompt operations.
  // Fail closed here so no session is created without approval wiring.
  if (coordinator === undefined) {
    logger.error({approvalMode}, 'run-core: coordinator required — failing closed before session creation')
    throw new RunCoreError(
      'missing-coordinator',
      'approval-required mode requires a PermissionCoordinator — none was provided',
    )
  }

  // Captured into its own binding immediately after the narrowing check above: `coordinator`
  // is narrowed to non-undefined here, but that narrowing does not carry across the function
  // boundary of a nested function/arrow callback (e.g. the ledger's `onAdopted` hook below, or
  // `isOwnedSession` further down) — this binding does.
  const ownershipCoordinator: PermissionCoordinator = coordinator

  // ── 0b. Inactivity timer setup ─────────────────────────────────────────────
  // When inactivityTimeoutMs is set (>0), the shared `createInactivityTimer` primitive
  // arms a timeout that fires after the configured window of silence. It is reset on
  // every text delta, tool completion, and permission.replied event. It is paused on
  // permission.asked and resumed+reset on permission.replied.
  // `timer.signal` never aborts when inactivityTimeoutMs is undefined or <= 0 (inert
  // instance), mirroring the previous `inactivityController === null` arming guard.
  // The combined signal merges the wall-clock timeout signal with the inactivity signal
  // so either can abort the event loop.
  const inactivityTimer = createInactivityTimer({timeoutMs: inactivityTimeoutMs ?? 0})
  const inactivityArmed = inactivityTimeoutMs !== undefined && inactivityTimeoutMs > 0
  // The primitive auto-arms on creation; run-core's contract is to NOT start counting
  // idle time until the prompt is actually sent (resetInactivity() below, after
  // promptAsync succeeds) — pause immediately to cancel that initial auto-arm and
  // preserve the exact prior timing (no timer running during session.create/subscribe).
  inactivityTimer.pause()

  // Watchdog pause state, consulted by `resetInactivity`. `draining` becomes true the first time the root
  // goes idle with owned work outstanding (see 1c); `outstandingHumanWaits` is the request ids a human
  // still has to settle (see the human-wait gauge below).
  let draining = false
  const outstandingHumanWaits = new Map<string, HumanWaitKind>()

  function clearInactivity(): void {
    inactivityTimer.pause()
  }

  // The single re-arm path. The watchdog stays paused while a human is being waited on or while the
  // run drains owned background work: activity (text, tool completions, owned children, parallel tools)
  // then must not re-arm it, or a quiet human wait / drain would trip `inactivity-timeout` before the
  // question deadline or the run's own deadline. Releasing the last human wait outside drain is the one
  // path that re-arms, and it does so after the wait is deleted, so the guard sees an empty gauge.
  function resetInactivity(): void {
    if (!inactivityArmed) return
    if (draining === true || outstandingHumanWaits.size > 0) return
    inactivityTimer.reset()
  }

  // combinedSignal: aborts when either the wall-clock signal or the inactivity signal fires.
  const combinedSignal = inactivityArmed ? AbortSignal.any([signal, inactivityTimer.signal]) : signal

  // ── 0c. Pre-flight abort check ─────────────────────────────────────────────
  // Check before any external call so an already-expired signal (e.g. AbortSignal.timeout
  // that fired during setup) is caught immediately rather than after a blocking SDK call.
  if (combinedSignal.aborted) {
    logger.warn({}, 'run-core: signal already aborted before session creation')
    throw new RunCoreError('timeout', 'Run timed out: signal was already aborted before session creation')
  }

  // ── 1. Create session ──────────────────────────────────────────────────────
  let sessionId: string
  try {
    // approval-required mode (the only supported mode): no session permission override.
    // Discord approval UI handles permission asks via the coordinator.
    const sessionResponse = await client.session.create({
      query: {directory},
      signal: combinedSignal,
    })
    if (sessionResponse.error != null) {
      const errMsg = String(sessionResponse.error)
      if (isAuthError(sessionResponse)) {
        logger.error({detail: 'session.create 401'}, 'run-core: workspace proxy rejected bearer token')
        throw new RunCoreError('auth', `Session create rejected: ${errMsg}`)
      }
      throw new RunCoreError('unreachable', `Session create failed: ${errMsg}`)
    }
    if (sessionResponse.data == null) {
      throw new RunCoreError('unreachable', 'Session create returned no data')
    }
    sessionId = sessionResponse.data.id
    // Register the root session as owned before anything else observes events for
    // it. Ownership (root or an adopted descendant) is what the event-routing
    // checks below consult — an unowned session never reaches a handler.
    coordinator.addOwnedSession(sessionId)
    logger.info({sessionId}, 'run-core: session created')
  } catch (error) {
    if (error instanceof RunCoreError) throw error
    const message = error instanceof Error ? error.message : String(error)
    logger.error({detail: message}, 'run-core: session create threw (server unreachable?)')
    throw new RunCoreError('unreachable', `Session create threw: ${message}`)
  }

  // ── 1b. Post-create abort check ────────────────────────────────────────────
  if (combinedSignal.aborted) {
    clearInactivity()
    logger.warn({sessionId}, 'run-core: signal aborted after session creation')
    throw new RunCoreError('timeout', 'Run timed out: signal aborted after session creation')
  }

  // ── 1c. Drain machinery — inert when no ledger is provided ─────────────────
  // `draining` becomes true the first time the root session goes idle with
  // outstanding owned work. `drainDoneController` is a purely-internal signal
  // (never a failure) that unblocks the abortable stream once the ledger
  // reports drain-complete, without conflating that with `combinedSignal`
  // (whose abort always means timeout/inactivity/cancel).
  // (`draining` itself is declared with the inactivity timer above: the watchdog consults it.)
  const drainDoneController = new AbortController()

  // A ledger mutation only asks the drain-completion gate to validate; it never completes the drain
  // itself. A settled ledger means every child is non-live, which upstream does BEFORE it injects the
  // parent's follow-up turn (see `drain-completion.ts`), so the ledger alone is not completion. Human
  // waits take no part either: a root `question` tool call blocks inside the root runner, and a
  // foreground child keeps the root blocked on its `task` tool, so root idle with a question pending can
  // only mean an owned background child, which is already a ledger entry.
  // Assigned once the reconcile adapter exists (below); stays undefined for a run with no ledger.
  let drainCompletion: DrainCompletion | undefined

  // What the stream actually delivered to the sink. The drain-completion gate's delivery fence consults it: the
  // sink is append-only, so completion waits for the follow-up reply to be delivered rather than repairing it.
  const replyDelivery = createReplyDeliveryTracker()

  // Only ROOT text counts: the fence is about the parent's follow-up reply, not a descendant's output.
  //
  // Recorded when the delta is ACCEPTED, not when it is appended: the boundary tracker may hold a not-yet-visible
  // segment's whitespace lead-in. The invariant that makes this safe is "everything the fence has counted is either in
  // the sink or held by the tracker, and the held text is flushed when the event loop exits". Flushing earlier (before
  // the gate's check) would be unsafe: a validation that is later rejected would have released a lead-in whose
  // segment can still become visible, and the separator could no longer go before it. Admission aborts the loop, so
  // the flush in its `finally` runs on the admitted path as well, before `runCore` returns.
  function recordDelivered(eventSessionID: string | null, partId: string | null, text: string): void {
    if (drainCompletion !== undefined && eventSessionID === sessionId) replyDelivery.recordDelta(partId, text)
  }

  function persistOwnership(): void {
    if (ownershipLedger === undefined) return
    const ownedSessionIds = ownershipLedger
      .snapshot()
      .filter(entry => entry.state !== 'settled')
      .map(entry => entry.sessionId)
    onOwnershipChange?.({rootSessionId: sessionId, ownedSessionIds})
  }

  const ledger: OwnershipLedger | undefined =
    ownershipLedger === undefined
      ? undefined
      : wrapLedgerWithHooks(
          ownershipLedger,
          () => {
            persistOwnership()
            drainCompletion?.requestValidation()
          },
          // A directly-observed dispatch (the task-tool-completion path below) must become
          // visible to event routing (`coordinator.isOwned`) the moment it is adopted —
          // otherwise its tool events and permission asks are dropped as foreign. This hook is
          // the single place `ledger.adopt` calls reach the coordinator. `reconcileLedgerOnce` is
          // handed this same wrapped ledger (below) for its settle/downgrade mutations, but it
          // never calls `adopt` itself — it settles or downgrades what is already tracked, never
          // adopting a session the ledger has not already learned about (see
          // `@fro-bot/runtime`'s `ledger-reconcile.ts` module doc) — so this hook only ever fires
          // from the task-tool-completion path, never from a reconciliation pass.
          adoptedSessionId => ownershipCoordinator.addOwnedSession(adoptedSessionId),
        )

  const reconcileAdapter = ledger === undefined ? undefined : createSdkLedgerReconcileAdapter(client, directory)
  const runtimeLogger = ledger === undefined ? undefined : toRuntimeLogger(logger)
  // Live-path reconcile passes (the periodic tick and the one-shot on root idle) are bounded and write through a
  // guarded ledger. Once the run starts tearing down (`throwWithBarrier`) or leaves the event loop, settle owns the
  // ledger and a pass still in flight must not change it.
  let liveReconcileClosed = false
  const liveReconcileOptions =
    ledger === undefined || reconcileAdapter === undefined || runtimeLogger === undefined
      ? undefined
      : {ledger, adapter: reconcileAdapter, parentSessionId: sessionId, logger: runtimeLogger}
  const reconciler =
    liveReconcileOptions === undefined
      ? undefined
      : createLedgerReconciler({
          ...liveReconcileOptions,
          runPass: async () => reconcileLivePass(liveReconcileOptions, () => liveReconcileClosed),
        })

  if (ledger !== undefined && reconcileAdapter !== undefined) {
    drainCompletion = createDrainCompletion({
      client,
      directory,
      rootSessionId: sessionId,
      ledger,
      adapter: reconcileAdapter,
      signal: combinedSignal,
      logger,
      isReplyDelivered: parts => replyDelivery.covers(parts),
      // The only path that completes a drain: an admitted validation unblocks the stream.
      onAdmitted: () => drainDoneController.abort(),
    })
  }

  // ── 1d. Termination barrier ─────────────────────────────────────────────────
  // Every RunCoreError thrown from this point on (session create/ledger creation
  // already happened above — a throw before this point has no owned work to settle)
  // is routed through here instead of escaping directly. Pass-through (zero remote
  // calls, unchanged kind/message) when the ledger has no unsettled owned work.
  // Otherwise cancels and confirms settlement (`settleOwnedSessions`) BEFORE letting
  // the causal error escape to run.ts — run.ts must never stop the heartbeat, release
  // the lock, or hand off the slot while a sibling of this run's failed session is
  // still alive and writing. If settlement cannot be confirmed within its bound, the
  // SAME kind and message re-throw with `quarantined: true` (never a different kind —
  // quarantine is additional evidence, not a replacement explanation).
  //
  // Root still running: the prompt runs in server scope (`promptAsync`), so closing the stream or giving up on
  // the run does not stop it — only `session.abort` does. A stop where the root may still be executing
  // (`rootMayBeRunning`: the wall-clock or inactivity deadline, a stream that ended, a signal after the prompt
  // was sent, an operator cancel, a provider retry mid-backoff) must therefore abort the root and confirm it
  // quiescent before the run releases its lock and slot, even with an empty or absent ledger. An unconfirmed
  // root is quarantined exactly like an unconfirmed child. A failure where the root has already halted (a
  // terminal provider error, a rejected prompt) and a clean completion keep the fast path.
  //
  // Follow-up window: a run that adopted background work keeps draining after its children settle, because
  // upstream then injects a follow-up turn on the ROOT, which may be writing to the checkout again. A failure
  // there (cancel, deadline, a dropped stream) takes the same root teardown.
  async function throwWithBarrier(
    kind: RunCoreErrorKind,
    message: string,
    options: {
      readonly rootMayBeRunning?: boolean
      readonly providerFailureReason?: ProviderFailureReason
      readonly cause?: unknown
    } = {},
  ): Promise<never> {
    const {rootMayBeRunning = false, providerFailureReason, cause} = options
    liveReconcileClosed = true
    // Nothing after this point reads from either handle: the barrier always ends in a throw, and its decision
    // reads `drainCompletion` only for existence. Disposing here also covers exits before the event loop, whose
    // `finally` never runs, and stops a validation from admitting success while teardown is in progress.
    reconciler?.dispose()
    drainCompletion?.dispose()
    const rootFollowUpOpen =
      rootMayBeRunning ||
      (drainCompletion !== undefined && draining === true && drainDoneController.signal.aborted === false)
    const barrierLedger = ledger ?? (rootMayBeRunning ? createOwnershipLedger() : undefined)
    if (barrierLedger === undefined || (barrierLedger.isDrainComplete() === true && rootFollowUpOpen === false)) {
      throw new RunCoreError(kind, message, false, providerFailureReason, cause)
    }
    const settlement = await settleOwnedSessions({
      client,
      directory,
      rootSessionId: sessionId,
      ledger: barrierLedger,
      logger,
      ...(rootFollowUpOpen ? {confirmRootQuiescent: true} : {}),
    })
    if (settlement.settled === true) {
      throw new RunCoreError(kind, message, false, providerFailureReason, cause)
    }
    logger.error(
      {sessionId, kind, detail: settlement.reason},
      'run-core: owned work could not be confirmed settled before this failure — quarantining run',
    )
    throw new RunCoreError(kind, message, true, providerFailureReason, cause)
  }

  // An abort the gateway did not cause (see the `session.error` and `message.updated` branches).
  const ABORTED_FAILURE: ProviderFailure = {reason: 'session error', errorName: 'MessageAbortedError'}

  // Fails the run on a provider rejection OpenCode will not recover from (#1836). Reuses `session-error`:
  // a new operator failure kind would be a contract change. Only the fixed `reason` and a sanitized error
  // name leave the classifier; the provider's own message is never logged or placed in the error.
  // `rootMayBeRunning`: only a retry status — OpenCode is mid-backoff and will keep going. Every terminal source
  // (`session.error`, `message.updated`, overflow at idle) fires after `halt` has set the root idle
  // (processor.ts:613-639), so the root is already stopped there.
  async function failFromProvider(failure: ProviderFailure, source: string, rootMayBeRunning = false): Promise<never> {
    logger.error(
      {sessionId, source, errorName: failure.errorName, reason: failure.reason},
      'run-core: provider rejected the request — failing run',
    )
    clearInactivity()
    throw await throwWithBarrier('session-error', `Provider failure: ${failure.reason}`, {
      rootMayBeRunning,
      providerFailureReason: failure.reason,
    })
  }

  // ── 2. Subscribe to events — directory threaded to query (SSE-routing) ─────
  // Subscribe BEFORE prompt to eliminate the race where permission.asked fires
  // before the SSE listener exists.
  let eventStream: AsyncIterable<unknown>
  try {
    const eventsResult = await client.event.subscribe({query: {directory}, signal: combinedSignal})
    eventStream = eventsResult.stream as AsyncIterable<unknown>
    logger.info({sessionId, directory}, 'run-core: event stream subscribed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error({sessionId, detail: message}, 'run-core: event.subscribe threw')
    throw await throwWithBarrier('unreachable', `Event subscribe threw: ${message}`)
  }

  // ── 2b. Post-subscribe abort check ────────────────────────────────────────
  if (combinedSignal.aborted) {
    clearInactivity()
    logger.warn({sessionId}, 'run-core: signal aborted after event subscribe')
    throw await throwWithBarrier('timeout', 'Run timed out: signal aborted after event subscribe')
  }

  // ── 3. Send prompt — directory threaded to query ───────────────────────────
  try {
    const promptResponse = await client.session.promptAsync({
      path: {id: sessionId},
      body: {parts: [{type: 'text', text: promptText}]},
      query: {directory},
      signal: combinedSignal,
    })
    if (promptResponse.error != null) {
      const errMsg = String(promptResponse.error)
      if (isAuthError(promptResponse)) {
        logger.error({sessionId, detail: 'promptAsync 401'}, 'run-core: workspace proxy rejected bearer token')
        throw await throwWithBarrier('auth', `PromptAsync rejected: ${errMsg}`)
      }
      logger.error({sessionId, detail: errMsg}, 'run-core: promptAsync returned error')
      throw await throwWithBarrier('prompt-error', `PromptAsync error: ${errMsg}`)
    }
    logger.info({sessionId, directory}, 'run-core: prompt sent')
    // Signal busy: work has started — drive typing indicator in the status controller.
    onBusy?.(true)
    // Arm inactivity timer; the agent should produce output within the window.
    resetInactivity()
  } catch (error) {
    if (error instanceof RunCoreError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (combinedSignal.aborted) {
      // The run's own signal cancelled the request. Cancelling the request does not prove the server never
      // started the prompt, so this is a stop where the root may be running, not an unreachable server.
      clearInactivity()
      logger.warn({sessionId, detail: message}, 'run-core: signal aborted while sending the prompt')
      throw await throwWithBarrier('timeout', 'Run timed out: signal aborted while sending the prompt', {
        rootMayBeRunning: true,
      })
    }
    logger.error({sessionId, detail: message}, 'run-core: promptAsync threw (server unreachable?)')
    throw await throwWithBarrier('unreachable', `PromptAsync threw: ${message}`)
  }

  // ── 3b. Post-prompt abort check ────────────────────────────────────────────
  if (combinedSignal.aborted) {
    clearInactivity()
    logger.warn({sessionId}, 'run-core: signal aborted after prompt send')
    throw await throwWithBarrier('timeout', 'Run timed out: signal aborted after prompt send', {
      rootMayBeRunning: true,
    })
  }

  // ── 4. Consume event stream ────────────────────────────────────────────────
  // V2 sync tool lifecycle: correlate called→success by callID.
  const pendingToolCalls = new Map<string, ToolCallInfo>()

  // Reasoning suppression (R5): track part IDs of reasoning parts so their
  // deltas can be suppressed at the message.part.delta site. Reasoning parts
  // carry `id` on `message.part.updated` (type === 'reasoning'); their deltas
  // carry `partID` on `message.part.delta` but no part kind — correlation is
  // the only way to distinguish them from text deltas.
  const reasoningPartIds = new Set<string>()

  // Sessions (root or owned child) with a `ContextOverflowError` session.error not yet recovered. With
  // auto-compaction on (the default) OpenCode publishes it and compacts: `compaction.create`
  // (compaction.ts:559-582) then writes that session's user message with a `compaction` part, the first event of
  // the recovery (called from prompt.ts:1322 after processor.ts:629-631). With compaction off OpenCode halts
  // instead (processor.ts:621-628): `session.error`, then that session's `session.idle`, with the errored
  // `message.updated` only after. So a session's own compaction part clears its entry and, if its idle arrives
  // first, the overflow was unrecovered and the run fails. A null session id is keyed to the root, as run-core
  // already treats it.
  const overflowPending = new Set<string>()

  // Part IDs of synthetic background-task notices. A notice is the harness talking to the parent agent,
  // never reply text: nothing carrying one of these ids may reach the sink.
  const noticePartIds = new Set<string>()

  // Segment boundaries: the sinks are append-only and see only strings, so separate text parts would otherwise run
  // together ("...can do.The README..."). Part identity exists only here; the separator is inserted once, through
  // the sink, so Discord, the web sink and the final output all receive the same text. Tool summaries go through
  // `trackedSink` so they are accounted for. See `text-boundary.ts` for the rule.
  const textBoundary = createTextBoundaryTracker()
  const trackedSink: CoreStreamSink = {
    append: text => {
      sink.append(text)
      textBoundary.noteAppended(text)
    },
  }

  // Appends a text delta. The tracker returns exactly what to append now: the delta itself, `separator + held + text`
  // for a segment's first visible delta, or nothing while a not-yet-visible segment's whitespace lead-in is held.
  // The delivery fence records the part's own text separately, as the delta is accepted, and never sees the
  // separator. That is safe because held text is flushed to the sink when the event loop exits (see its `finally`)
  // and nothing reads the sink before then.
  function appendSegmentText(segmentKey: string | null, text: string): void {
    const emit = textBoundary.append(segmentKey, text)
    if (emit.length > 0) sink.append(emit)
  }

  // Wrap the raw event stream in an abort-aware iterator so we do not block
  // indefinitely waiting for the next event when the signal fires mid-stream.
  // The inner generator races each `next()` call against the abort signal so
  // the loop exits promptly even when the SSE server is silent.
  //
  // `iterationSignal` additionally includes `drainDoneController.signal` so the
  // loop also unblocks the instant the ledger reports drain-complete, rather
  // than waiting for the next SSE event that may never arrive. Every existing
  // `combinedSignal.aborted` check below is unaffected — it still means
  // exactly "timeout/inactivity/cancel", never "drain finished".
  const iterationSignal =
    ledger === undefined ? combinedSignal : AbortSignal.any([combinedSignal, drainDoneController.signal])
  const abortableStream = makeAbortableStream(eventStream, iterationSignal)

  // Observability counters (#1101): disambiguate a genuine workspace hang (zero events
  // observed) from an event-delivery/routing gap (events arrived but none reset the
  // inactivity timer, e.g. session-mismatched or unrecognized event types).
  let totalEvents = 0
  let activityEvents = 0
  let lastEventType: string | undefined

  // Marks a real run-activity event: bumps the activity counter and re-arms the
  // inactivity timer. Kept as a thin wrapper so resetInactivity() semantics are
  // untouched — this does not change when/why the timer resets, only adds counting.
  function markActivity(): void {
    activityEvents += 1
    resetInactivity()
  }

  // Human-wait gauge: the request ids a human still has to settle, approvals and questions alike.
  // The inactivity watchdog is paused while the map is non-empty and, outside drain, re-armed with
  // a fresh window only when the last id is released. Keying by request id keeps both directions
  // idempotent: a duplicate ask adds nothing, and a release for an unknown or already-released id
  // changes nothing, so the count can never drift or go negative.
  //
  // The gauge never influences drain. While `draining` the watchdog stays paused whatever is
  // released: the run's hard deadline (or a cancel) is the only bound, as it is without human waits.
  // Re-arming mid-drain would let a quiet but valid background child trip the inactivity timer,
  // which the post-loop classification reports as `drain-timeout` and cancels owned work early.
  //
  // Releases come from three places, all through `releaseHumanWait`: OpenCode's echo, the request
  // gate's terminal notification (which also fires for settlements that produce no echo: deadline
  // skip, failed reply, teardown), and a question that was skipped without being registered.
  //
  // Once the event loop has exited the run no longer owns the watchdog: late releases (an
  // asynchronous skip finishing after the run ended) must not re-arm a timer nobody disposes.
  let humanWaitsClosed = false

  function holdHumanWait(requestId: string, kind: HumanWaitKind): void {
    outstandingHumanWaits.set(requestId, kind)
    // Pause typing while waiting on a human: the run is blocked, not actively working.
    onBusy?.(false)
    clearInactivity()
  }

  function releaseHumanWait(requestId: string): void {
    if (humanWaitsClosed === true) return
    if (!outstandingHumanWaits.delete(requestId)) return
    // Drain is bounded by the ledger and the run deadline alone: stay paused and quiet.
    if (draining === true) return
    if (outstandingHumanWaits.size > 0) return
    // Last outstanding item settled outside drain: the run is unblocked, so resume typing and re-arm.
    onBusy?.(true)
    markActivity()
  }

  // Terminal notifications from the request gate release the wait for any settlement path.
  // Subscribed here (before the loop) and unsubscribed in the loop's finally.
  const unsubscribeHumanWaitTerminal = onHumanWaitTerminal?.(event => {
    releaseHumanWait(event.requestID)
  })

  // Ownership check: true for the root session, or a descendant session this
  // run's ledger has adopted (surfaced through `coordinator.isOwned`). False
  // for a null session id (no session on the payload) and false for any
  // session this run does not own — including a session belonging to a
  // different run's tree. This is the boundary that keeps a stranger's tool
  // calls, approvals, and activity out of this run's handling: widening it
  // to every workspace session would route a stranger's approval into this
  // run's Discord thread. Uses the `ownershipCoordinator` binding captured
  // near the top of this function (see its comment for why a separate
  // binding is needed at all).
  function isOwnedSession(eventSessionID: string | null): boolean {
    return eventSessionID !== null && ownershipCoordinator.isOwned(eventSessionID)
  }

  // Feeds the drain-completion gate. ROOT session only — a descendant's activity never changes root
  // lifecycle state. Invalidating: a new root user message (an injected notice included), a root busy/retry
  // status, and root assistant/text/tool activity. A notice also registers its injected user message before
  // anything can test completion. No-op for a run with no ledger.
  function observeRootForDrain(rawEvent: unknown, eventType: string | null, eventPayload: unknown): void {
    if (drainCompletion === undefined) return
    if (eventType === 'message.part.updated') {
      const part = getObjectProperty(eventPayload, 'part')
      if ((getSessionID(eventPayload) ?? getSessionID(part)) !== sessionId) return
      const notice = parseSyntheticNoticePart(part)
      if (notice === null) {
        drainCompletion.noteRootActivity()
        return
      }
      const partId = getStringProperty(part, 'id')
      if (partId !== null) noticePartIds.add(partId)
      drainCompletion.noteNotice(notice, getStringProperty(part, 'messageID'), partId)
    } else if (eventType === 'message.updated') {
      const info = getObjectProperty(eventPayload, 'info')
      if ((getSessionID(eventPayload) ?? getSessionID(info)) !== sessionId) return
      const role = getStringProperty(info, 'role')
      const messageId = getStringProperty(info, 'id')
      if (role === 'user' && messageId !== null) drainCompletion.noteRootUserMessage(messageId)
      else if (role === 'assistant') drainCompletion.noteRootActivity()
    } else if (eventType === 'session.status') {
      if (getEventSessionID(rawEvent) !== sessionId) return
      const statusType = getStringProperty(getObjectProperty(eventPayload, 'status'), 'type')
      if (statusType === 'busy' || statusType === 'retry') drainCompletion.noteRootActivity()
    } else if (
      (eventType === 'message.part.delta' ||
        eventType === 'session.next.text.delta' ||
        eventType === 'session.next.tool.called' ||
        eventType === 'session.next.tool.success') &&
      getEventSessionID(rawEvent) === sessionId
    )
      drainCompletion.noteRootActivity()
  }

  try {
    for await (const rawEvent of abortableStream) {
      // Check abort at the top of each iteration so we exit as soon as the signal
      // fires, even if the stream itself keeps yielding events.
      if (combinedSignal.aborted) break

      const eventType = getEventKind(rawEvent)
      const eventPayload = getEventPayload(rawEvent)

      // totalEvents counts every event the loop PROCESSES (post-getEventKind), including
      // events dropped by a session-mismatch guard below, by design — a foreign-session
      // event that arrives but is dropped still increments totalEvents, so
      // `totalEvents > 0, activityEvents: 0` reveals the session-mismatch/routing case.
      totalEvents += 1
      lastEventType = eventType ?? undefined

      // Root-only freshness bookkeeping for the drain-completion gate. Observation only: it never alters
      // the routing below, so a run that adopted nothing sees no behavioural difference.
      observeRootForDrain(rawEvent, eventType, eventPayload)

      if (overflowPending.size > 0 && eventType === 'message.part.updated') {
        const part = getObjectProperty(eventPayload, 'part')
        const partSessionId = getSessionID(eventPayload) ?? getSessionID(part)
        if (partSessionId !== null && getStringProperty(part, 'type') === 'compaction') {
          overflowPending.delete(partSessionId)
        }
      }

      if (eventType === 'message.part.delta') {
        // New SDK shape: streaming text delta events.
        // delta may be {type:'text', text:string} or a plain string when field === 'text'.
        // Reasoning suppression: skip any delta whose partID is a known reasoning part.
        const eventSessionID = getEventSessionID(rawEvent)
        if (isOwnedSession(eventSessionID)) {
          const deltaPartId = getStringProperty(eventPayload, 'partID')
          if (deltaPartId !== null && (reasoningPartIds.has(deltaPartId) || noticePartIds.has(deltaPartId))) {
            // This delta belongs to a reasoning part or a synthetic background-task notice — suppress it entirely.
          } else {
            const delta = getObjectProperty(eventPayload, 'delta')
            const deltaType = getStringProperty(delta, 'type')
            const deltaText = getStringProperty(delta, 'text')
            // Identity: the part id; a delta without one falls back to its message id. Neither → no boundary.
            const segmentMessageId = getStringProperty(eventPayload, 'messageID')
            const segmentKey =
              deltaPartId === null
                ? segmentMessageId === null
                  ? null
                  : `message:${segmentMessageId}`
                : `part:${deltaPartId}`
            if (deltaType === 'text' && deltaText != null) {
              appendSegmentText(segmentKey, deltaText)
              recordDelivered(eventSessionID, deltaPartId, deltaText)
              markActivity()
            } else if (typeof delta === 'string' && getStringProperty(eventPayload, 'field') === 'text') {
              appendSegmentText(segmentKey, delta)
              recordDelivered(eventSessionID, deltaPartId, delta)
              markActivity()
            }
          }
        }
      } else if (eventType === 'session.next.text.delta') {
        // Sync/session.next shape: delta is a plain string or {type:'text', text:string}.
        // No partID on this legacy path — reasoning suppression does not apply here.
        const eventSessionID = getEventSessionID(rawEvent)
        if (isOwnedSession(eventSessionID)) {
          const deltaRaw = getObjectProperty(eventPayload, 'delta')
          const deltaText = typeof deltaRaw === 'string' ? deltaRaw : (getStringProperty(deltaRaw, 'text') ?? null)
          if (deltaText != null) {
            // Legacy shape carries `assistantMessageID` + `textID` (no partID): that pair is the segment identity.
            // With neither there is nothing to key on, so no boundary is ever guessed between anonymous deltas.
            const assistantMessageId = getStringProperty(eventPayload, 'assistantMessageID')
            const textId = getStringProperty(eventPayload, 'textID')
            const segmentKey = assistantMessageId === null ? null : `legacy:${assistantMessageId}:${textId ?? ''}`
            appendSegmentText(segmentKey, deltaText)
            recordDelivered(eventSessionID, null, deltaText)
            markActivity()
          }
        }
      } else if (eventType === 'message.part.updated') {
        // Tool lifecycle on the V1 session layer arrives via message.part.updated
        // (partType:'tool', state.status:'completed'). The V2 session.next.tool.*
        // events are handled separately below — both families can reach the /event
        // stream, so both branches are live.
        const part = getObjectProperty(eventPayload, 'part')
        const eventSessionID = getSessionID(eventPayload) ?? getSessionID(part)
        if (isOwnedSession(eventSessionID)) {
          const partType = getStringProperty(part, 'type')
          if (partType === 'reasoning') {
            // Reasoning suppression: register this part's ID so its deltas are suppressed
            // at the message.part.delta site. Render nothing for reasoning parts.
            const reasoningId = getStringProperty(part, 'id')
            if (reasoningId !== null) {
              reasoningPartIds.add(reasoningId)
            }
          } else if (partType === 'tool') {
            // ONLY handle tool parts — text parts are streamed via message.part.delta.
            const toolState = getObjectProperty(part, 'state')
            const status = getStringProperty(toolState, 'status')
            if (status === 'completed' || status === 'error') {
              const tool = getStringProperty(part, 'tool') ?? ''
              const stateInput = getObjectProperty(toolState, 'input')
              const stateTitle = getStringProperty(toolState, 'title')
              logger.debug({tool, status}, 'run-core: tool completed (message.part.updated)')

              // Background dispatch observed: a `task` tool call completes immediately
              // once dispatch begins, carrying `metadata.background === true` and
              // `metadata.jobId` (the child session id) -- see upstream `tool/task.ts`.
              // Adopt the child into the ledger; the wrapped ledger's `onAdopted` hook
              // (see `wrapLedgerWithHooks`) registers it with the coordinator so its own
              // events and approvals route from here on. This is the ONLY path that calls
              // `ledger.adopt` -- reconciliation never adopts an untracked session (see
              // `@fro-bot/runtime`'s `ledger-reconcile.ts` module doc), so there is exactly
              // one adoption->ownership path, not two. Admission (whether the dispatch was
              // allowed to start) is a separate concern this call site does not own -- by
              // the time this event arrives the dispatch already ran.
              if (ledger !== undefined && status === 'completed' && tool === 'task') {
                const stateMetadata = getObjectProperty(toolState, 'metadata')
                const jobId = getStringProperty(stateMetadata, 'jobId')
                const isBackground = getBooleanProperty(stateMetadata, 'background')
                if (jobId !== null && isBackground === true) {
                  const label = stateTitle ?? 'background task'
                  ledger.adopt(jobId, label)
                  logger.info(
                    {sessionId, jobId, label},
                    'run-core: background dispatch observed -- adopted into ownership ledger',
                  )
                }
              }

              appendToolSummary(
                {
                  tool,
                  state: {
                    input:
                      stateInput != null && typeof stateInput === 'object'
                        ? (stateInput as Record<string, unknown>)
                        : undefined,
                    title: stateTitle ?? undefined,
                    status: status === 'error' ? 'error' : 'completed',
                  },
                },
                trackedSink,
                logger,
                onActivity,
              )
              markActivity()
            }
          }
        }
      } else if (eventType === 'session.next.tool.called') {
        // V2 sync tool lifecycle: cache call info for correlation with success event.
        const eventSessionID = getEventSessionID(rawEvent)
        if (isOwnedSession(eventSessionID)) {
          const callID = getStringProperty(eventPayload, 'callID')
          const tool = getStringProperty(eventPayload, 'tool')
          const input = getObjectProperty(eventPayload, 'input')
          if (callID != null && tool != null) {
            pendingToolCalls.set(callID, {tool, input})
            logger.debug({callID, tool}, 'run-core: tool called')
          }
        }
      } else if (eventType === 'session.next.tool.success') {
        // V2 sync tool lifecycle: resolve title and surface progress line to Discord.
        const eventSessionID = getEventSessionID(rawEvent)
        if (isOwnedSession(eventSessionID)) {
          const callID = getStringProperty(eventPayload, 'callID')
          if (callID !== null) {
            const callInfo = pendingToolCalls.get(callID)
            if (callInfo !== undefined) {
              pendingToolCalls.delete(callID)
              const {tool, input} = callInfo
              // Title resolution: structured.title → input.title → bash command → tool name.
              const structured = getObjectProperty(eventPayload, 'structured')
              const structuredTitle = getStringProperty(structured, 'title')
              const inputTitle = getStringProperty(input, 'title')
              const title = structuredTitle ?? inputTitle ?? undefined
              logger.debug({callID, tool}, 'run-core: tool success')
              appendToolSummary(
                {
                  tool,
                  state: {
                    input: input != null && typeof input === 'object' ? (input as Record<string, unknown>) : undefined,
                    title,
                    status: 'completed',
                  },
                },
                trackedSink,
                logger,
                onActivity,
              )
              markActivity()
            }
          }
        }
      } else if (eventType === 'permission.asked') {
        const eventSessionID = getEventSessionID(rawEvent)
        if (isOwnedSession(eventSessionID)) {
          // approval-required mode: route to coordinator.
          // Coordinator is guaranteed non-null here (pre-flight check above).
          const req = parsePermissionRequest(eventPayload)
          if (req === null) {
            logger.warn({eventType}, 'run-core: permission.asked payload malformed — skipping')
          } else {
            // Pauses typing and the inactivity timer until every outstanding approval is released.
            holdHumanWait(req.requestID, 'approval')
            // Fire-and-continue: do NOT await — awaiting would starve the SSE drain.
            // eslint-disable-next-line no-void
            void coordinator.onPermissionAsked(req)
            logger.info({requestID: req.requestID}, 'run-core: permission.asked forwarded to coordinator')
          }
        }
      } else if (eventType === 'permission.replied') {
        // Authoritative settlement — route to coordinator.
        // Coordinator is guaranteed non-null here (pre-flight check above).
        const eventSessionID = getEventSessionID(rawEvent)
        if (isOwnedSession(eventSessionID)) {
          const ev = parsePermissionReply(eventPayload)
          if (ev === null) {
            logger.warn({eventType}, 'run-core: permission.replied payload malformed — skipping')
          } else {
            // Resumes typing and re-arms inactivity only if no other human-wait item remains.
            releaseHumanWait(ev.requestID)
            coordinator.onPermissionReplied(ev)
            logger.info(
              {requestID: ev.requestID, reply: ev.reply},
              'run-core: permission.replied forwarded to coordinator',
            )
          }
        }
      } else if (eventType === 'question.asked') {
        const eventSessionID = getEventSessionID(rawEvent)
        const askedRequestID = safeLogId(getStringProperty(eventPayload, 'id'))
        if (isOwnedSession(eventSessionID) === false) {
          // A question from a session this run does not own must not reach this run's operators.
          // Logged because the asking session is blocked on it: ids and a reason code only.
          logger.warn(
            {eventType, requestID: askedRequestID, sessionID: safeLogId(eventSessionID), reason: 'unowned-session'},
            'run-core: question.asked from a session this run does not own — ignoring',
          )
        } else if (questions === undefined) {
          logger.warn(
            {eventType, requestID: askedRequestID, sessionID: safeLogId(eventSessionID), reason: 'no-question-handler'},
            'run-core: question.asked but no question handler is configured — ignoring',
          )
        } else {
          const parsed = parseQuestionRequest(eventPayload)
          if (parsed.kind === 'malformed') {
            logger.warn(
              {eventType, requestID: askedRequestID, sessionID: safeLogId(eventSessionID), reason: parsed.reason},
              'run-core: question.asked payload malformed — skipping',
            )
            // The asking tool call is blocked on this request. When its id is readable, reject it
            // (fire-and-continue) so the agent's turn ends now instead of at the inactivity timeout.
            // A payload with no readable id cannot be addressed and stays warn-only.
            const rawAskedRequestID = getStringProperty(eventPayload, 'id')
            if (rawAskedRequestID !== null && rawAskedRequestID.length > 0 && eventSessionID !== null) {
              // eslint-disable-next-line no-void
              void questions.onMalformed({
                requestID: rawAskedRequestID,
                sessionID: eventSessionID,
                reason: parsed.reason,
              })
            }
          } else {
            const req = parsed.value
            // Pauses typing and the inactivity timer until every outstanding human wait is released.
            holdHumanWait(req.requestID, 'question')
            // Fire-and-continue: do NOT await — awaiting would starve the SSE drain. A question the
            // coordinator did not hand to the gate (skipped for lack of budget, or a failed
            // registration) will never produce a terminal event, so release its wait here.
            questions
              .onAsked(req)
              .then(outcome => {
                if (outcome === 'skipped' || outcome === 'failed') releaseHumanWait(req.requestID)
              })
              .catch(() => {
                releaseHumanWait(req.requestID)
              })
            logger.info(
              {requestID: req.requestID, sessionID: req.sessionID},
              'run-core: question.asked forwarded to question handler',
            )
          }
        }
      } else if (eventType === 'question.replied' || eventType === 'question.rejected') {
        // Authoritative settlement from OpenCode — works whether or not the gateway claimed the request.
        const eventSessionID = getEventSessionID(rawEvent)
        if (isOwnedSession(eventSessionID) && questions !== undefined) {
          const parsed = parseQuestionEcho(eventType, eventPayload)
          if (parsed.kind === 'malformed') {
            logger.warn(
              {eventType, sessionID: safeLogId(eventSessionID), reason: parsed.reason},
              'run-core: question echo payload malformed — skipping',
            )
          } else {
            questions.onEcho(parsed.value)
            // The echo is proof OpenCode is unblocked, so release even if the gate had no entry for it.
            releaseHumanWait(parsed.value.requestID)
            logger.info(
              {requestID: parsed.value.requestID, echo: parsed.value.kind},
              'run-core: question echo forwarded to question handler',
            )
          }
        }
      } else if (eventType === 'session.idle') {
        // Deliberately root-scoped, NOT an ownership check: a descendant's own
        // idle transition must never end the run while the root is still
        // working. Root idle is the signal to CONSIDER finishing; whether that
        // is actually allowed is the ledger's call, below.
        const eventSessionID = getEventSessionID(rawEvent)
        // Any session's idle with an overflow nothing compacted: OpenCode stopped it (compaction off). A child's
        // output is lost with it, so fail rather than let the root complete.
        if (eventSessionID !== null && overflowPending.has(eventSessionID)) {
          throw await failFromProvider({reason: 'session error', errorName: 'ContextOverflowError'}, 'session.idle')
        }
        if (eventSessionID === sessionId) {
          // Background-only gate: a run that never adopted a dispatch (no ledger, or an empty one) completes
          // on root idle exactly as it always has. Once ANY dispatch was adopted, a settled ledger is not
          // enough — see the drain-completion gate below.
          if (ledger === undefined || drainCompletion === undefined || ledger.snapshot().length === 0) {
            logger.info(
              {sessionId, totalEvents, activityEvents, lastEventType},
              'run-core: session.idle received — stream complete',
            )
            // Signal not-busy: work is done.
            onBusy?.(false)
            clearInactivity()
            return
          }

          // A background dispatch was adopted: enter (or remain in) drain rather than completing. The run
          // stays alive — slot, lease, and approval routing all continue exactly as during execution — until
          // the drain-completion gate admits success or the run's own deadline (`combinedSignal`) expires.
          // The gate needs the ledger settled AND each child's completion notice (or cancel evidence) AND
          // root freshness; a settled ledger alone can precede the parent's injected follow-up turn.
          const ledgerSettled = ledger.isDrainComplete()
          if (draining === false) {
            draining = true
            logger.info(
              {sessionId, outstanding: ledger.outstanding(), totalEvents, activityEvents},
              ledgerSettled
                ? 'run-core: root session idle with background work settled — awaiting completion notice and root freshness'
                : 'run-core: root session idle with owned work outstanding — draining',
            )
            onBusy?.(false)
            clearInactivity()
            drainCompletion.beginDrain()
          }

          // Root idle is evidence only for the generation it arrives in: stamp the current revision.
          drainCompletion.noteRootIdle()

          // Immediate reconcile pass so already-finished background work settles
          // without waiting for the reconciler's interval. Fire-and-forget: its
          // mutations (via the wrapped ledger) trigger persistence and a validation
          // request on their own once they land.
          if (ledgerSettled === false && liveReconcileOptions !== undefined) {
            // eslint-disable-next-line no-void
            void reconcileLivePass(liveReconcileOptions, () => liveReconcileClosed)
          }

          // Validate against REST now that this generation has idle evidence. Coalesced: at most one in flight.
          drainCompletion.requestValidation()
        }
      } else if (eventType === 'session.error') {
        const eventSessionID = getEventSessionID(rawEvent)
        // A null session id means the payload didn't carry one (rare) — treated as ours defensively, matching the
        // prior root-scoped behaviour, since we cannot attribute it to a specific session at all. Otherwise:
        // ownership, not root equality, decides whether the event is ours at all.
        if (eventSessionID === null || isOwnedSession(eventSessionID)) {
          // The payload is a string or a structured `{name, data}` object. Both go through the shared
          // classifier: only a fixed reason survives, never the provider's text.
          const errorText = getStringProperty(eventPayload, 'error')
          const structuredError = errorText === null ? getObjectProperty(eventPayload, 'error') : null
          // An owned child, as opposed to the root or an error that names no session.
          const childSessionId = eventSessionID !== null && eventSessionID !== sessionId ? eventSessionID : null
          // A context overflow is not decided here: compaction may follow, so it only arms `overflowPending`.
          // An abort is exempt only when the gateway caused it (the combined signal ends the loop); an abort
          // from any other client (`POST /session/:id/abort`) is followed by an idle that would otherwise
          // complete the run with partial output.
          if (isContextOverflowError(structuredError)) {
            overflowPending.add(eventSessionID ?? sessionId)
          } else if (childSessionId !== null) {
            // A child's terminal error (or an abort by another client) does not end the root's turn. It is
            // evidence something went wrong, not proof the child stopped writing, so the entry is marked
            // `unknown` — never `settled` — and the root learns the child's outcome from its task-completion
            // notice. The drain settles the entry once reconciliation sees it stop, or cancels it at the
            // deadline. Marking goes through the hook-wrapped ledger, so persistence and validation fire.
            ledger?.markUnknown(childSessionId)
            logger.warn(
              {sessionId, childSessionId},
              'run-core: owned child reported a terminal session error — marked unknown, run continues',
            )
          } else if (isAbortedError(structuredError)) {
            if (combinedSignal.aborted === false) throw await failFromProvider(ABORTED_FAILURE, 'session.error')
          } else {
            const failure =
              errorText === null ? failureFromErrorObject(structuredError) : failureFromErrorText(errorText)
            throw await failFromProvider(failure, 'session.error')
          }
        }
      } else if (eventType === 'message.updated') {
        // Root assistant message with `info.error`: OpenCode's processor sets it only when it has stopped
        // (retries exhausted or error non-retryable), so waiting for `session.idle` or inactivity is pointless.
        // Root only — a child's failed message is the child's problem, handled via the ledger.
        const info = getObjectProperty(eventPayload, 'info')
        if (
          (getSessionID(eventPayload) ?? getSessionID(info)) === sessionId &&
          getStringProperty(info, 'role') === 'assistant'
        ) {
          const messageError = getObjectProperty(info, 'error')
          if (messageError !== null && typeof messageError === 'object') {
            if (isAbortedError(messageError)) {
              if (combinedSignal.aborted === false) throw await failFromProvider(ABORTED_FAILURE, 'message.updated')
            } else {
              throw await failFromProvider(failureFromErrorObject(messageError), 'message.updated')
            }
          }
        }
      } else if (eventType === 'session.status') {
        // A retry that cannot succeed (provider auth missing, an account rate limit, model unsupported) would
        // otherwise sit through the whole retry/backoff budget. `failureFromRetryStatus` returns a failure only
        // when the shared classifier says `stop`; transient retries (429/5xx/overload) return null and keep waiting.
        // Root only: a child's retry never fails the parent through this path.
        if (getEventSessionID(rawEvent) === sessionId) {
          const retryFailure = failureFromRetryStatus(getObjectProperty(eventPayload, 'status'))
          if (retryFailure !== null) throw await failFromProvider(retryFailure, 'session.status', true)
        }
      } else {
        // Unrecognized event type — log at debug so a lost-event/routing gap (events arriving
        // as types we do not handle) is visible rather than silently falling through.
        logger.debug({eventType, sessionId}, 'run-core: unrecognized event type')
      }
    }
  } catch (error) {
    // A rejected stream or an unexpected throw in the loop body is not a RunCoreError. It must not escape
    // `runOpenCodeCore` raw: `run.ts` would treat it as an unquarantined failure and release the lock and slot
    // while the root, whose prompt keeps running server-side, may still be writing the checkout.
    if (error instanceof RunCoreError) throw error
    const message = error instanceof Error ? error.message : String(error)
    clearInactivity()
    logger.error({sessionId, detail: message}, 'run-core: event loop failed unexpectedly')
    throw await throwWithBarrier('stream-ended', `Event stream failed: ${message}`, {
      rootMayBeRunning: true,
      cause: error,
    })
  } finally {
    // Ensure the inactivity timer is always disposed on loop exit (normal, break, or throw).
    // The explicit clearInactivity() calls on the session.idle and session.error paths are
    // kept as defensive double-clears — pause()/dispose() on an already-cleared timer is a no-op.
    inactivityTimer.dispose()
    liveReconcileClosed = true
    reconciler?.dispose()
    // No validation result may admit success once the loop has exited, and its retry timer must not leak.
    drainCompletion?.dispose()
    // The watchdog is gone: stop reacting to gate notifications and late releases.
    humanWaitsClosed = true
    unsubscribeHumanWaitTerminal?.()
    // Release whitespace still held for segments that never became visible. The delivery fence already counted it
    // as delivered, so it must reach the sink on EVERY exit (idle, admitted drain, abort, error). Nothing reads the
    // sink before this point; callers take the final text after `runCore` settles.
    const heldTail = textBoundary.flush()
    if (heldTail.length > 0) sink.append(heldTail)
  }

  // Drain completed successfully: the ledger reported drain-complete and
  // `drainDoneController` unblocked the stream — NOT a failure path. Checked
  // before `combinedSignal.aborted` because both signals feed `iterationSignal`
  // and only one can be responsible for a given exit.
  if (combinedSignal.aborted === false && drainDoneController.signal.aborted === true) {
    logger.info(
      {sessionId, totalEvents, activityEvents, lastEventType},
      'run-core: drain complete — owned work settled',
    )
    onBusy?.(false)
    clearInactivity()
    return
  }

  // Stream exhausted (loop exited normally or via break). Distinguish timeout from premature close.
  // NOTE: this block runs AFTER the finally above, so clearInactivity() has already fired.
  if (combinedSignal.aborted) {
    if (ledger !== undefined && draining === true) {
      // The run's own deadline covers execution AND drain — there is no separate drain
      // budget to extend, and a completion notification never resets `combinedSignal`.
      // Cancellation + confirmation of every unsettled entry (outstanding AND unknown)
      // now lives in `throwWithBarrier` → `settleOwnedSessions` — a completed entry
      // linking to a running one is never the gateway's problem at depth one, but the
      // barrier cancels per-entry rather than a single tree-cancel, so raising the depth
      // later does not silently reintroduce that gap.
      logger.warn(
        {sessionId, outstanding: ledger.outstanding(), unknown: ledger.unknown(), totalEvents, activityEvents},
        'run-core: drain deadline expired — cancelling unsettled owned work, run reports incomplete',
      )
      throw await throwWithBarrier('drain-timeout', 'Run timed out while draining outstanding owned work')
    }

    // Inactivity is the tighter bound (always < hard ceiling), so on the rare both-aborted
    // tick we attribute to inactivity-timeout deliberately.
    if (inactivityArmed && inactivityTimer.signal.aborted) {
      logger.warn(
        {sessionId, totalEvents, activityEvents, lastEventType},
        'run-core: stream ended due to inactivity timeout',
      )
      throw await throwWithBarrier('inactivity-timeout', 'Run timed out: no activity within the inactivity window', {
        rootMayBeRunning: true,
      })
    }
    logger.warn({sessionId, totalEvents, activityEvents, lastEventType}, 'run-core: stream ended due to timeout signal')
    throw await throwWithBarrier('timeout', 'Run timed out: event stream aborted by timeout signal', {
      rootMayBeRunning: true,
    })
  }

  // Stream closed without session.idle and not aborted by us → OpenCode
  // may still be working; mark as failed so the run is not silently completed.
  logger.error(
    {sessionId, totalEvents, activityEvents, lastEventType},
    'run-core: event stream closed before session.idle',
  )
  throw await throwWithBarrier('stream-ended', 'Event stream closed before session.idle was received', {
    rootMayBeRunning: true,
  })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wrap an async iterable so that each `next()` call races against the abort
 * signal. When the signal fires while the stream is blocked waiting for the
 * next event, the generator terminates immediately rather than hanging until
 * the server sends another event.
 *
 * This is the key fix for the "silent stream" reliability issue: without this
 * wrapper the `for await` loop only checks `signal.aborted` AFTER an event
 * arrives, meaning a timed-out run can block indefinitely on a quiet stream.
 */
async function* makeAbortableStream(stream: AsyncIterable<unknown>, signal: AbortSignal): AsyncGenerator<unknown> {
  const iterator = stream[Symbol.asyncIterator]()

  try {
    while (true) {
      // Race the next event against the abort signal.
      const nextPromise = iterator.next()

      // Build an abort promise that resolves (not rejects) so Promise.race
      // returns cleanly rather than throwing an AbortError.
      const abortPromise = new Promise<{done: true; value: undefined}>(resolve => {
        if (signal.aborted === true) {
          resolve({done: true, value: undefined})
          return
        }
        const onAbort = () => {
          resolve({done: true, value: undefined})
        }
        signal.addEventListener('abort', onAbort, {once: true})
        // Clean up the listener when the next event arrives first (resolve or reject).
        // Using .then(cleanup, cleanup) instead of .finally() to avoid creating an
        // additional microtask chain and to handle both resolve and reject paths
        // without swallowing the rejection (nextPromise rejection propagates normally
        // through Promise.race — we only need the side-effect of removing the listener).
        // eslint-disable-next-line no-void
        void nextPromise.then(
          () => {
            signal.removeEventListener('abort', onAbort)
          },
          () => {
            signal.removeEventListener('abort', onAbort)
          },
        )
      })

      const result = await Promise.race([nextPromise, abortPromise])

      if (result.done === true) return

      yield result.value
    }
  } finally {
    // Fire-and-forget: the iterator may never resolve return(); awaiting it would hang.
    // .catch avoids an unhandled rejection if return() rejects (Node 24 crashes on those).
    // eslint-disable-next-line no-void
    void iterator.return?.()?.catch(() => {})
  }
}

/** Detect a proxy/server 401 response in an SDK response envelope. */
function isAuthError(response: {readonly error?: unknown}): boolean {
  if (response.error == null) return false
  const error = response.error
  // Rely solely on the numeric status field (SDK wraps HTTP responses as {status, message}).
  // String-substring matching on "401"/"unauthorized"/"forbidden" produced false positives
  // when non-auth error messages contained those tokens.
  if (typeof error === 'object' && error !== null) {
    const statusLike = (error as Record<string, unknown>).status
    if (statusLike === 401 || statusLike === 403) return true
  }
  return false
}
