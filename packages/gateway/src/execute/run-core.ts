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
 *
 * Event-stream semantics mirror `src/features/agent/streaming.ts` exactly.
 * Cannot import from that module (backwards-dependency ban); accessors are
 * replicated locally.
 */

import type {OpenCodeServerHandle, OwnershipLedger, Logger as RuntimeLogger} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {GatewayLogger} from '../discord/client.js'

import {
  createInactivityTimer,
  createLedgerReconciler,
  createSdkLedgerReconcileAdapter,
  reconcileLedgerOnce,
} from '@fro-bot/runtime'
import {parsePermissionReply, parsePermissionRequest} from '../approvals/coordinator.js'
import {formatToolPart} from './format-part.js'

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

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

/**
 * Error thrown by `runOpenCodeCore` on any failure path.
 *
 * The `message` field is for internal logging only — never post it to Discord.
 * `run.ts` maps `kind` to coarse user-visible replies.
 */
export class RunCoreError extends Error {
  readonly kind: RunCoreErrorKind

  constructor(kind: RunCoreErrorKind, internalMessage: string) {
    super(internalMessage)
    this.name = 'RunCoreError'
    this.kind = kind
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
   *   completion when the ledger has outstanding entries: the run keeps
   *   consuming the event stream (routing descendant approvals/activity as
   *   normal) and periodically reconciling (via `createLedgerReconciler`)
   *   until every entry settles or the run's own deadline (`signal`) expires.
   *   Only once the ledger reports drain-complete does `runOpenCodeCore`
   *   return — so a caller awaiting this call already waits out the full
   *   drain, and no separate drain stage is needed in `run.ts`.
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

// ---------------------------------------------------------------------------
// Local typed accessor helpers (mirrors streaming.ts — no import allowed)
// ---------------------------------------------------------------------------

function getStringProperty(value: unknown, property: string): string | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'string' ? descriptor.value : null
}

function getObjectProperty(value: unknown, property: string): unknown {
  if (value == null || typeof value !== 'object') return null
  return Object.getOwnPropertyDescriptor(value, property)?.value ?? null
}

function getBooleanProperty(value: unknown, property: string): boolean | null {
  if (value == null || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, property)
  return typeof descriptor?.value === 'boolean' ? descriptor.value : null
}

/**
 * Adapt the gateway's `(context, message)` logger to the runtime's
 * `(message, context)` `Logger` shape the ledger-reconciliation primitives
 * expect. Mirrors `toLedgerReconcileLogger` in `execute/recovery.ts` —
 * duplicated locally rather than imported to avoid a cross-module coupling
 * for four one-line functions.
 */
function toRuntimeLogger(logger: GatewayLogger): RuntimeLogger {
  return {
    debug: (msg, ctx) => logger.debug(ctx ?? {}, msg),
    info: (msg, ctx) => logger.info(ctx ?? {}, msg),
    warning: (msg, ctx) => logger.warn(ctx ?? {}, msg),
    error: (msg, ctx) => logger.error(ctx ?? {}, msg),
  }
}

/**
 * Wrap an `OwnershipLedger` so every mutating call also fires `onChange` —
 * used to persist ownership onto run state and to re-check drain completion
 * after every adopt/settle/markUnknown, regardless of whether the mutation
 * came from an observed dispatch event or a reconciliation pass (both go
 * through this wrapper since reconciliation is handed the wrapped instance).
 */
function wrapLedgerWithHooks(ledger: OwnershipLedger, onChange: () => void): OwnershipLedger {
  return {
    adopt: (sessionId, label) => {
      ledger.adopt(sessionId, label)
      onChange()
    },
    settle: sessionId => {
      ledger.settle(sessionId)
      onChange()
    },
    markUnknown: sessionId => {
      ledger.markUnknown(sessionId)
      onChange()
    },
    outstanding: () => ledger.outstanding(),
    unknown: () => ledger.unknown(),
    isDrainComplete: () => ledger.isDrainComplete(),
    isPersistenceSafe: () => ledger.isPersistenceSafe(),
    snapshot: () => ledger.snapshot(),
  }
}

function getSessionID(value: unknown): string | null {
  return getStringProperty(value, 'sessionID')
}

/**
 * Extract the event kind from a raw server event.
 * Mirrors `getEventKind` in streaming.ts:
 * - Non-sync events: return `event.type` as-is.
 * - Sync events: return `event.name` with trailing `.N` index stripped.
 */
function getEventKind(event: unknown): string | null {
  const eventType = getStringProperty(event, 'type')
  if (eventType !== 'sync') return eventType
  return getStringProperty(event, 'name')?.replace(/\.\d+$/, '') ?? eventType
}

/**
 * Extract the canonical payload from a raw server event.
 * Mirrors `getEventPayload` in streaming.ts: prefers `properties`, falls back
 * to `data` (sync events carry their payload in `data`).
 */
function getEventPayload(event: unknown): unknown {
  return getObjectProperty(event, 'properties') ?? getObjectProperty(event, 'data')
}

/**
 * Extract the session ID from a raw server event.
 * Mirrors `getEventSessionID` in streaming.ts: checks `properties.sessionID`
 * then `data.sessionID`.
 */
function getEventSessionID(event: unknown): string | null {
  return getSessionID(getObjectProperty(event, 'properties')) ?? getSessionID(getObjectProperty(event, 'data'))
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

  function clearInactivity(): void {
    inactivityTimer.pause()
  }

  function resetInactivity(): void {
    if (!inactivityArmed) return
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
  let draining = false
  const drainDoneController = new AbortController()

  function persistOwnership(): void {
    if (ownershipLedger === undefined) return
    const ownedSessionIds = ownershipLedger
      .snapshot()
      .filter(entry => entry.state !== 'settled')
      .map(entry => entry.sessionId)
    onOwnershipChange?.({rootSessionId: sessionId, ownedSessionIds})
  }

  function checkDrainComplete(): void {
    if (ownershipLedger !== undefined && draining === true && ownershipLedger.isDrainComplete()) {
      drainDoneController.abort()
    }
  }

  const ledger: OwnershipLedger | undefined =
    ownershipLedger === undefined
      ? undefined
      : wrapLedgerWithHooks(ownershipLedger, () => {
          persistOwnership()
          checkDrainComplete()
        })

  const reconcileAdapter = ledger === undefined ? undefined : createSdkLedgerReconcileAdapter(client)
  const runtimeLogger = ledger === undefined ? undefined : toRuntimeLogger(logger)
  const reconciler =
    ledger === undefined || reconcileAdapter === undefined || runtimeLogger === undefined
      ? undefined
      : createLedgerReconciler({
          ledger,
          adapter: reconcileAdapter,
          parentSessionId: sessionId,
          logger: runtimeLogger,
        })

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
    throw new RunCoreError('unreachable', `Event subscribe threw: ${message}`)
  }

  // ── 2b. Post-subscribe abort check ────────────────────────────────────────
  if (combinedSignal.aborted) {
    clearInactivity()
    logger.warn({sessionId}, 'run-core: signal aborted after event subscribe')
    throw new RunCoreError('timeout', 'Run timed out: signal aborted after event subscribe')
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
        throw new RunCoreError('auth', `PromptAsync rejected: ${errMsg}`)
      }
      logger.error({sessionId, detail: errMsg}, 'run-core: promptAsync returned error')
      throw new RunCoreError('prompt-error', `PromptAsync error: ${errMsg}`)
    }
    logger.info({sessionId, directory}, 'run-core: prompt sent')
    // Signal busy: work has started — drive typing indicator in the status controller.
    onBusy?.(true)
    // Arm inactivity timer; the agent should produce output within the window.
    resetInactivity()
  } catch (error) {
    if (error instanceof RunCoreError) throw error
    const message = error instanceof Error ? error.message : String(error)
    logger.error({sessionId, detail: message}, 'run-core: promptAsync threw (server unreachable?)')
    throw new RunCoreError('unreachable', `PromptAsync threw: ${message}`)
  }

  // ── 3b. Post-prompt abort check ────────────────────────────────────────────
  if (combinedSignal.aborted) {
    clearInactivity()
    logger.warn({sessionId}, 'run-core: signal aborted after prompt send')
    throw new RunCoreError('timeout', 'Run timed out: signal aborted after prompt send')
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

  // Ownership check: true for the root session, or a descendant session this
  // run's ledger has adopted (surfaced through `coordinator.isOwned`). False
  // for a null session id (no session on the payload) and false for any
  // session this run does not own — including a session belonging to a
  // different run's tree. This is the boundary that keeps a stranger's tool
  // calls, approvals, and activity out of this run's handling: widening it
  // to every workspace session would route a stranger's approval into this
  // run's Discord thread.
  // Captured into its own binding: `coordinator` is narrowed to non-undefined by the
  // pre-flight check above, but that narrowing does not carry across the function
  // boundary of a nested `function` declaration — this binding does.
  const ownershipCoordinator: PermissionCoordinator = coordinator

  function isOwnedSession(eventSessionID: string | null): boolean {
    return eventSessionID !== null && ownershipCoordinator.isOwned(eventSessionID)
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

      if (eventType === 'message.part.delta') {
        // New SDK shape: streaming text delta events.
        // delta may be {type:'text', text:string} or a plain string when field === 'text'.
        // Reasoning suppression: skip any delta whose partID is a known reasoning part.
        const eventSessionID = getEventSessionID(rawEvent)
        if (isOwnedSession(eventSessionID)) {
          const deltaPartId = getStringProperty(eventPayload, 'partID')
          if (deltaPartId !== null && reasoningPartIds.has(deltaPartId)) {
            // This delta belongs to a reasoning part — suppress it entirely.
          } else {
            const delta = getObjectProperty(eventPayload, 'delta')
            const deltaType = getStringProperty(delta, 'type')
            const deltaText = getStringProperty(delta, 'text')
            if (deltaType === 'text' && deltaText != null) {
              sink.append(deltaText)
              markActivity()
            } else if (typeof delta === 'string' && getStringProperty(eventPayload, 'field') === 'text') {
              sink.append(delta)
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
            sink.append(deltaText)
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
              // Adopt the child into the ledger and register it as owned so its own
              // events and approvals route from here on. Admission (whether the
              // dispatch was allowed to start) is a separate concern this call site
              // does not own -- by the time this event arrives the dispatch already ran.
              if (ledger !== undefined && status === 'completed' && tool === 'task') {
                const stateMetadata = getObjectProperty(toolState, 'metadata')
                const jobId = getStringProperty(stateMetadata, 'jobId')
                const isBackground = getBooleanProperty(stateMetadata, 'background')
                if (jobId !== null && isBackground === true) {
                  const label = stateTitle ?? 'background task'
                  ledger.adopt(jobId, label)
                  ownershipCoordinator.addOwnedSession(jobId)
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
                sink,
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
                sink,
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
            // Pause typing while waiting on a human approval — the run is blocked,
            // not actively working. Typing would falsely imply active work.
            onBusy?.(false)
            // Pause the inactivity timer while waiting for human approval.
            clearInactivity()
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
            // Approval resolved — resume typing if the run continues.
            onBusy?.(true)
            markActivity() // Re-arm inactivity now that the run is unblocked.
            coordinator.onPermissionReplied(ev)
            logger.info(
              {requestID: ev.requestID, reply: ev.reply},
              'run-core: permission.replied forwarded to coordinator',
            )
          }
        }
      } else if (eventType === 'session.idle') {
        // Deliberately root-scoped, NOT an ownership check: a descendant's own
        // idle transition must never end the run while the root is still
        // working. Root idle is the signal to CONSIDER finishing; whether that
        // is actually allowed is the ledger's call, below.
        const eventSessionID = getEventSessionID(rawEvent)
        if (eventSessionID === sessionId) {
          if (ledger === undefined || ledger.isDrainComplete()) {
            logger.info(
              {sessionId, totalEvents, activityEvents, lastEventType},
              'run-core: session.idle received — stream complete',
            )
            // Signal not-busy: work is done.
            onBusy?.(false)
            clearInactivity()
            return
          }

          // Outstanding owned work: enter (or remain in) drain rather than
          // completing. The run stays alive — slot, lease, and approval routing
          // all continue exactly as during execution — until the ledger settles
          // or the run's own deadline (`combinedSignal`) expires.
          if (draining === false) {
            draining = true
            logger.info(
              {sessionId, outstanding: ledger.outstanding(), totalEvents, activityEvents},
              'run-core: root session idle with owned work outstanding — draining',
            )
            onBusy?.(false)
            clearInactivity()
          }

          // Immediate reconcile pass so already-finished background work settles
          // without waiting for the reconciler's interval. Fire-and-forget: its
          // mutations (via the wrapped ledger) trigger persistence and the
          // drain-complete check on their own once they land.
          if (reconcileAdapter !== undefined && runtimeLogger !== undefined) {
            // eslint-disable-next-line no-void
            void reconcileLedgerOnce({
              ledger,
              adapter: reconcileAdapter,
              parentSessionId: sessionId,
              logger: runtimeLogger,
            }).catch(() => {
              // reconcileLedgerOnce never rejects; this satisfies no-floating-promises.
            })
          }
        }
      } else if (eventType === 'session.error') {
        const eventSessionID = getEventSessionID(rawEvent)
        // A null session id means the payload didn't carry one (rare) — treated as
        // ours defensively, matching the prior root-scoped behaviour, since we
        // cannot attribute it to a specific session at all. Otherwise: ownership,
        // not root equality — a descendant's error is this run's problem too.
        if (eventSessionID === null || isOwnedSession(eventSessionID)) {
          const errorDetail = getStringProperty(eventPayload, 'error') ?? 'unknown session error'
          logger.error({sessionId, detail: errorDetail}, 'run-core: session.error received')
          clearInactivity()
          throw new RunCoreError('session-error', `Session error: ${errorDetail}`)
        }
      } else {
        // Unrecognized event type — log at debug so a lost-event/routing gap (events arriving
        // as types we do not handle) is visible rather than silently falling through.
        logger.debug({eventType, sessionId}, 'run-core: unrecognized event type')
      }
    }
  } finally {
    // Ensure the inactivity timer is always disposed on loop exit (normal, break, or throw).
    // The explicit clearInactivity() calls on the session.idle and session.error paths are
    // kept as defensive double-clears — pause()/dispose() on an already-cleared timer is a no-op.
    inactivityTimer.dispose()
    reconciler?.dispose()
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
      // The run's own deadline covers execution AND drain — there is no
      // separate drain budget to extend, and a completion notification never
      // resets `combinedSignal`. Cancel every still-outstanding entry
      // individually (a completed entry linking to a running one is never the
      // gateway's problem at depth one, but cancelling per-entry rather than a
      // single tree-cancel means raising the depth later does not silently
      // reintroduce that gap). Each entry is downgraded to `unknown` — the
      // cancellation request was sent, but nothing here confirms the child
      // actually stopped, so `unknown` (not `settled`) is the honest state.
      const outstandingEntries = ledger.snapshot().filter(entry => entry.state === 'outstanding')
      await Promise.allSettled(
        outstandingEntries.map(async entry => {
          try {
            await client.session.abort({
              path: {id: entry.sessionId},
              query: {directory},
              signal: AbortSignal.timeout(5_000),
            })
          } catch (error) {
            logger.warn(
              {sessionId: entry.sessionId, detail: error instanceof Error ? error.message : String(error)},
              'run-core: failed to abort owned session during drain-deadline cancellation',
            )
          }
          ledger.markUnknown(entry.sessionId)
        }),
      )
      logger.warn(
        {sessionId, cancelledCount: outstandingEntries.length, totalEvents, activityEvents},
        'run-core: drain deadline expired — cancelled outstanding owned work, run reports incomplete',
      )
      throw new RunCoreError('drain-timeout', 'Run timed out while draining outstanding owned work')
    }

    // Inactivity is the tighter bound (always < hard ceiling), so on the rare both-aborted
    // tick we attribute to inactivity-timeout deliberately.
    if (inactivityArmed && inactivityTimer.signal.aborted) {
      logger.warn(
        {sessionId, totalEvents, activityEvents, lastEventType},
        'run-core: stream ended due to inactivity timeout',
      )
      throw new RunCoreError('inactivity-timeout', 'Run timed out: no activity within the inactivity window')
    }
    logger.warn({sessionId, totalEvents, activityEvents, lastEventType}, 'run-core: stream ended due to timeout signal')
    throw new RunCoreError('timeout', 'Run timed out: event stream aborted by timeout signal')
  }

  // Stream closed without session.idle and not aborted by us → OpenCode
  // may still be working; mark as failed so the run is not silently completed.
  logger.error(
    {sessionId, totalEvents, activityEvents, lastEventType},
    'run-core: event stream closed before session.idle',
  )
  throw new RunCoreError('stream-ended', 'Event stream closed before session.idle was received')
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
