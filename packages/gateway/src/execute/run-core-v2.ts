/**
 * Execute+stream core for the gateway on OpenCode V2 (v2.2.0): the sibling of `run-core.ts`.
 *
 * Responsibility boundary, unchanged: this owns session creation, prompt send, event subscription, event → sink routing
 * and resolution. It does NOT own the lock, run-state lifecycle, heartbeat, mention routing or the authorization gate;
 * those live in `run.ts` and are shared by both generations. It throws the same `RunCoreError`, so `run.ts` maps `kind`
 * to coarse Discord replies exactly as before.
 *
 * What V2 changes, and where it shows:
 * - The wire. One HTTP API under `/api/*` and one SSE stream (`GET /api/event`) for EVERY location on the server, so
 *   ownership (the root, or a child this run adopted) is what keeps a stranger's events out. `runtime/event-v2.ts` maps
 *   frames to a small domain union; this loop never reads a raw event name.
 * - Completion. There is no `session.idle`. A root that finished a turn is `session.execution.succeeded`, a failed one
 *   `execution.failed`, a stopped one `execution.interrupted` with a reason.
 * - Release. Stock v2.2.0 cannot prove that nothing the run started can still wake one of its sessions (`interrupt` is a
 *   delivery receipt, a shell DELETE wakes its owner, a notice is admitted and its wake started in separate steps). So
 *   the run is released on the DIRECTORY, not on its own accounting: only after no session of the directory is active, no
 *   shell of it is running and no session of it has a queued inbox item, for 11 readings over 5 s
 *   (`directory-quiescence-v2.ts`). Success waits for that in the drain gate; a stop waits for it in
 *   `settle-owned-sessions-v2.ts` after killing and interrupting whatever the directory shows. The ledger and the
 *   notices stay for ownership, approvals, event routing and progress; they no longer decide a release.
 * - Code Mode. Plugin and MCP tools run inside one `execute` call, so a tool line comes from the calls listed in the
 *   call's `metadata.toolCalls[]`, not from the wrapper. `shell`, `read`, `edit`, `question` and `subagent` are direct
 *   tools. A nested approval is its own request, keyed by request id, never by the `execute` call id.
 * - Questions. The `question` tool asks a form; a reply is a form reply and a reject is a form cancel. Any other form
 *   kind is cancelled with a visible notice, since nobody can fill it in here.
 * - Reasoning. It has its own events and carries no text into this loop, so it cannot reach the reply.
 * - A session move. The outside-checkout rules re-base on the destination, so a moved owned session fails the run. It
 *   always quarantines too: the destination's shells and sessions cannot be read from the directory this run reads.
 *
 * Everything else is parity with V1 and is commented where it lives: the termination barrier and its quarantine, the
 * cold-abort rule (#1958), the silence watchdog, eager subscribe, bounded and guarded reconcile passes, the drain gate
 * and its wait reason, owned children marked `unknown` on error, and the human-wait gauge that pauses the watchdog.
 */

import type {
  DirectoryStabilityTuning,
  OwnershipLedger,
  ReconcileLedgerOptions,
  RemoteOpenCodeV2Client,
  V2CallError,
  V2DomainEvent,
  V2FormField,
} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {QuestionAskedRequest, QuestionCoordinator} from '../approvals/question-coordinator.js'
import type {TerminalListener} from '../approvals/request-gate.js'
import type {GatewayLogger} from '../discord/client.js'
import type {DrainCompletionV2} from './drain-completion-v2.js'
import type {ExtractedToolPart} from './format-part.js'
import type {ProviderFailure, ProviderFailureReason} from './provider-failure.js'
import type {FormDirectoryV2} from './question-client-v2.js'
import type {CoreStreamSink, RunCoreErrorKind} from './run-core.js'
import {
  createDirectoryStabilityGate,
  createInactivityTimer,
  createLedgerReconciler,
  createOwnershipLedger,
  createV2LedgerReconcileAdapter,
  isShellLedgerKey,
  mapV2Event,
  mapV2EventStream,
  observeDirectoryV2,
  ownedSessionIdsOf,
  readBackgroundDispatch,
  readBackgroundShellDispatch,
  readToolShellId,
  reconcileShellsOnce,
  settleLedgerFromShellNotice,
  settleLedgerFromSubagentNotice,
  shellLedgerKey,
  toErrorMessage,
} from '@fro-bot/runtime'
import {parsePermissionReply, parsePermissionRequest} from '../approvals/coordinator.js'
import {parseQuestionRequest, safeLogId} from '../approvals/question-coordinator.js'
import {createDrainCompletionV2} from './drain-completion-v2.js'
import {formatToolPart} from './format-part.js'
import {reconcileLivePass} from './live-reconcile.js'
import {failureFromV2Error} from './provider-failure-v2.js'
import {createFormDirectoryV2} from './question-client-v2.js'
import {startQuarantineWatchV2} from './root-stop-v2.js'
import {
  awaitFirstEvent,
  EVENT_STREAM_CONNECT_TIMEOUT_MS,
  makeAbortableStream,
  resumeWith,
  RunCoreError,
  wrapLedgerWithHooks,
} from './run-core.js'
import {toRuntimeLogger} from './runtime-logger.js'
import {settleOwnedSessionsV2} from './settle-owned-sessions-v2.js'
import {createTextBoundaryTracker} from './text-boundary.js'
import {clearWaitReason, setWaitReason} from './wait-reason-registry.js'

/** Which kind of request a human wait is held for. */
type HumanWaitKind = 'approval' | 'question'

/** Bound on a form cancel the loop fires and does not await. */
const FORM_CANCEL_TIMEOUT_MS = 10_000

/** Sent to the model when a form it asked cannot be answered here, so its turn continues instead of waiting. */
const UNSUPPORTED_FORM_MESSAGE = 'This client cannot answer this kind of request. Continue without it.'
const NO_QUESTION_HANDLER_MESSAGE = 'This client cannot answer questions right now. Continue without an answer.'

/** The unsupported-form notice shown to the user. Fixed text: the form title is model- or plugin-controlled. */
const UNSUPPORTED_FORM_NOTICE = '⚠ An agent request that needs input could not be shown here and was cancelled.'

/** An interrupt or failure the gateway did not cause (see the `execution_interrupted` branch). */
const INTERRUPTED_FAILURE: ProviderFailure = {reason: 'session error', errorName: 'MessageAbortedError'}

/** Parameters for the V2 execute+stream core. */
export interface RunCoreV2Params {
  /** Client for the remote OpenCode V2 server (attach result from `opencode-attach-v2.ts`). */
  readonly client: RemoteOpenCodeV2Client
  /** Absolute path to the workspace repo checkout. The session is created at this location. */
  readonly directory: string
  /** Pre-built prompt text. Must be non-empty — callers validate before calling. */
  readonly promptText: string
  /** Streaming sink that receives text deltas. The caller flushes it after this resolves. */
  readonly sink: CoreStreamSink
  /** Abort signal — aborts event iteration when signalled. */
  readonly signal: AbortSignal
  /** Injected logger. Internal details only — never leak session internals to Discord. */
  readonly logger: GatewayLogger
  /** The gateway run this core is executing. Stamped on the barrier's log lines. */
  readonly runId?: string
  /** Only `approval-required` is supported; absent means the same. */
  readonly approvalMode?: 'approval-required'
  /** Permission coordinator. Required: fail-closed before any session is created when absent. */
  readonly coordinator?: PermissionCoordinator
  /**
   * Question coordinator. When absent, a `question` form is cancelled with a message so the model continues, rather
   * than left to block until the run's deadline.
   */
  readonly questions?: QuestionCoordinator
  /**
   * The open question forms of this run. The loop records each form it forwards so the question effects can address
   * the reply by session and form id. Defaults to a private directory when the effects are not wired.
   */
  readonly forms?: FormDirectoryV2
  /** Subscription to the request gate's terminal notifications; releases the matching human wait. */
  readonly onHumanWaitTerminal?: (listener: TerminalListener) => () => void
  /** Silence watchdog for the event stream (never paused). A stream with no frame, heartbeats included, is dead. */
  readonly streamSilenceTimeoutMs?: number
  /** Called with each essential tool-action summary as it is appended. */
  readonly onActivity?: (summary: string) => void
  /** Called when the busy state changes. */
  readonly onBusy?: (busy: boolean) => void
  /** Inactivity timeout: aborts with `inactivity-timeout` when no text, tool or reasoning activity arrives. */
  readonly inactivityTimeoutMs?: number
  /** Ownership ledger for background subagents this run dispatches. When present the run drains before it completes. */
  readonly ownershipLedger?: OwnershipLedger
  /** Called after every ledger mutation with the root id and the not-yet-settled owned session ids. */
  readonly onOwnershipChange?: (info: {
    readonly rootSessionId: string
    readonly ownedSessionIds: readonly string[]
  }) => void
  /** Overrides the directory stability window of the drain gate and the barrier — for tests only. */
  readonly directoryStability?: DirectoryStabilityTuning
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The names the Discord tool renderer knows: V2 `shell` is V1 `bash`, V2 `subagent` is V1 `task`. */
function rendererToolName(name: string): string {
  if (name === 'shell') return 'bash'
  if (name === 'subagent') return 'task'
  return name
}

function titleFromInput(input: Readonly<Record<string, unknown>> | null): string | undefined {
  const title = input?.title
  if (typeof title === 'string' && title.length > 0) return title
  return undefined
}

/**
 * Fail-soft tool-render helper: catches any exception (malformed input), logs `{tool, status}` only, and appends
 * nothing on error. A throwing renderer must never abort the event stream.
 */
function appendToolSummary(
  part: ExtractedToolPart,
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

/** The V1-shaped payload the existing question parser reads, built from a question form's fields. */
function questionPayloadFromForm(formId: string, sessionId: string, fields: readonly V2FormField[]): unknown {
  return {
    id: formId,
    sessionID: sessionId,
    questions: fields.map(field => ({
      question: field.description ?? field.title ?? '',
      header: field.title ?? '',
      options: field.options.map(option => ({label: option.label, description: option.description ?? ''})),
      multiple: field.type === 'multiselect',
      custom: true,
    })),
  }
}

/** The answers a replied form carries, per question in field order, for the question echo. */
function answersFromForm(
  fields: readonly V2FormField[],
  answer: Readonly<Record<string, unknown>> | null,
): readonly (readonly string[])[] {
  return fields.map(field => {
    const value = answer?.[field.key]
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
    if (typeof value === 'string') return [value]
    return []
  })
}

function describeCallError(error: V2CallError): string {
  return error.kind === 'auth' || error.kind === 'http' ? `${error.kind} ${error.status}` : error.kind
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function runOpenCodeCoreV2(params: RunCoreV2Params): Promise<void> {
  const {
    client,
    directory,
    promptText,
    sink,
    signal,
    logger,
    runId,
    coordinator,
    questions,
    onHumanWaitTerminal,
    approvalMode,
    onActivity,
    onBusy,
    inactivityTimeoutMs,
    streamSilenceTimeoutMs,
    ownershipLedger: providedLedger,
    onOwnershipChange,
    directoryStability,
  } = params
  const forms = params.forms ?? createFormDirectoryV2()
  // Which sessions' inboxes a directory reading reads: those updated since the run began (less a margin), the root and
  // what the run owns. Taken before anything is created, so the root counts.
  const runStartedAt = Date.now()

  // ── 0. Mode/coordinator pre-flight ────────────────────────────────────────
  // approval-required is the only supported mode and it needs a coordinator before any session or prompt exists.
  if (coordinator === undefined) {
    logger.error({approvalMode}, 'run-core: coordinator required — failing closed before session creation')
    throw new RunCoreError(
      'missing-coordinator',
      'approval-required mode requires a PermissionCoordinator — none was provided',
    )
  }
  // Captured immediately after the narrowing check: narrowing does not carry into nested callbacks, this binding does.
  const ownershipCoordinator: PermissionCoordinator = coordinator

  // ── 0b. Inactivity timer ───────────────────────────────────────────────────
  // Armed only once the prompt is sent (`resetInactivity` after it succeeds), so the primitive's auto-arm is paused at
  // once. Paused while a human is waited on or while the run drains; see `resetInactivity`.
  const inactivityTimer = createInactivityTimer({timeoutMs: inactivityTimeoutMs ?? 0})
  const inactivityArmed = inactivityTimeoutMs !== undefined && inactivityTimeoutMs > 0
  inactivityTimer.pause()

  let draining = false
  const outstandingHumanWaits = new Map<string, HumanWaitKind>()

  function clearInactivity(): void {
    inactivityTimer.pause()
  }

  // The single re-arm path. Activity must not re-arm the watchdog while a human is waited on or while the run drains,
  // or a quiet human wait / drain would trip `inactivity-timeout` before the question deadline or the run's own.
  function resetInactivity(): void {
    if (!inactivityArmed) return
    if (draining || outstandingHumanWaits.size > 0) return
    inactivityTimer.reset()
  }

  // Aborts when either the wall-clock/cancel signal or the inactivity signal fires.
  const combinedSignal = inactivityArmed ? AbortSignal.any([signal, inactivityTimer.signal]) : signal

  // ── 0c. Pre-flight abort check ─────────────────────────────────────────────
  if (combinedSignal.aborted) {
    logger.warn({}, 'run-core: signal already aborted before session creation')
    throw new RunCoreError('timeout', 'Run timed out: signal was already aborted before session creation')
  }

  // ── 1. Create session ──────────────────────────────────────────────────────
  // The session is created at `directory`. That exact string is also what the quiescence join matches on.
  let sessionId: string
  try {
    const created = await client.createSession({directory, signal: combinedSignal})
    if (!created.success) {
      if (created.error.kind === 'auth') {
        logger.error({detail: 'session.create 401'}, 'run-core: workspace proxy rejected bearer token')
        throw new RunCoreError('auth', `Session create rejected: ${describeCallError(created.error)}`)
      }
      if (created.error.kind === 'aborted' && combinedSignal.aborted) {
        throw new RunCoreError('timeout', 'Run timed out: signal aborted while creating the session')
      }
      throw new RunCoreError('unreachable', `Session create failed: ${describeCallError(created.error)}`)
    }
    sessionId = created.data.id
    // Ownership (root or an adopted descendant) is what event routing consults; an unowned session reaches no handler.
    coordinator.addOwnedSession(sessionId)
    logger.info({sessionId}, 'run-core: session created')
  } catch (error) {
    if (error instanceof RunCoreError) throw error
    const message = toErrorMessage(error)
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
  // `drainDoneController` is a purely internal signal (never a failure) that unblocks the stream once the gate admits
  // completion, kept apart from `combinedSignal`, whose abort always means timeout, inactivity or cancel.
  const drainDoneController = new AbortController()

  // A ledger mutation only asks the gate to validate; it never completes the drain itself. A settled ledger means every
  // child is non-live, which the server does BEFORE the parent's follow-up turn, so the ledger alone is not completion.
  let drainCompletion: DrainCompletionV2 | undefined

  // A run without a caller-supplied ledger still keeps one: every success goes through the drain gate.
  const ownershipLedger = providedLedger ?? createOwnershipLedger()

  function persistOwnership(): void {
    // Sessions only: recovery reads these as session ids, and a background shell is not one.
    const ownedSessionIds = ownershipLedger
      .snapshot()
      .filter(entry => entry.state !== 'settled' && !isShellLedgerKey(entry.sessionId))
      .map(entry => entry.sessionId)
    onOwnershipChange?.({rootSessionId: sessionId, ownedSessionIds})
  }

  // Children whose completion notice was seen. A notice can precede the dispatch result on the stream; the child is then
  // settled the moment it is adopted.
  const noticedChildIds = new Set<string>()
  // The same for background shells, by shell id.
  const noticedShellIds = new Set<string>()
  // Owned sessions that moved to another directory. They keep running at their destination, where a placement by the
  // directory cannot find them, so the barrier and the watch take them as explicit targets.
  const movedSessionIds = new Set<string>()

  const ledger: OwnershipLedger = wrapLedgerWithHooks(
    ownershipLedger,
    () => {
      persistOwnership()
      drainCompletion?.requestValidation()
    },
    // The single place a directly observed dispatch reaches the coordinator, so its events and approvals route
    // from the moment it is adopted. Reconciliation never adopts. A background shell is not a session: it has
    // no events or approvals of its own to route.
    adoptedKey => {
      if (!isShellLedgerKey(adoptedKey)) ownershipCoordinator.addOwnedSession(adoptedKey)
    },
  )

  const reconcileAdapter = createV2LedgerReconcileAdapter(client.session)
  const runtimeLogger = toRuntimeLogger(logger)
  // Live reconcile passes (the periodic tick and the one-shot on root idle) are bounded and write through a guarded
  // ledger. Once the run tears down or leaves the loop, settle owns the ledger and a pass still in flight is inert.
  let liveReconcileClosed = false
  const liveReconcileOptions = {
    ledger,
    adapter: reconcileAdapter,
    parentSessionId: sessionId,
    logger: runtimeLogger,
  }
  // The shell entries get their own pass: sessions are asked about through the session API, shells through the shell
  // routes, and a failing or slow one must not hold the other back.
  async function reconcileShellPass(passOptions: ReconcileLedgerOptions): Promise<unknown> {
    return reconcileShellsOnce({
      ledger: passOptions.ledger,
      api: client,
      directory,
      logger: passOptions.logger,
      ...(passOptions.signal === undefined ? {} : {signal: passOptions.signal}),
    })
  }

  async function runLivePasses(passOptions: ReconcileLedgerOptions): Promise<void> {
    await Promise.all([
      reconcileLivePass(passOptions, () => liveReconcileClosed),
      reconcileLivePass(passOptions, () => liveReconcileClosed, undefined, reconcileShellPass),
    ])
  }

  const reconciler = createLedgerReconciler({
    ...liveReconcileOptions,
    runPass: async () => runLivePasses(liveReconcileOptions),
  })

  const drain = createDrainCompletionV2({
    rootSessionId: sessionId,
    ledger,
    adapter: reconcileAdapter,
    // What lets the run go: the directory staying quiet for the window. Every success waits for it, whatever the ledger
    // holds.
    directoryGate: createDirectoryStabilityGate({
      ...directoryStability,
      observe: async signal =>
        observeDirectoryV2({
          client,
          directory,
          signal,
          inbox: {runStartedAt, ownedSessionIds: () => ownedSessionIdsOf(sessionId, ledger)},
        }),
    }),
    ...(directoryStability?.minSpacingMs === undefined ? {} : {directorySpacingMs: directoryStability.minSpacingMs}),
    signal: combinedSignal,
    logger,
    // The only path that completes a drain: an admitted validation unblocks the stream.
    onAdmitted: () => {
      drainDoneController.abort()
    },
    // Why the gate has not admitted the run yet, for the operator status (in-process only, cleared on every exit).
    onNotAdmitted: code => {
      if (runId !== undefined) setWaitReason(runId, code)
    },
  })
  drainCompletion = drain

  // ── 1d. Termination barrier ─────────────────────────────────────────────────
  // Every RunCoreError thrown once the session exists goes through `throwWithBarrier`: it kills and interrupts whatever
  // the run's directory shows and waits for the directory to stay quiet, BEFORE the causal error escapes to `run.ts`.
  // `run.ts` must never stop the heartbeat, release the lock or hand off the slot while a session or shell of the
  // directory can still write. If the directory cannot be confirmed quiet within the barrier's bound, the SAME kind and
  // message re-throw with `quarantined: true` and the quarantine watch keeps stopping the directory for the whole hold.
  //
  // There is no fast path for "the root has already halted" or "nothing is adopted": the prompt is admitted into server
  // scope, a shell's DELETE wakes its owner, a notice wakes its session in a step the stream does not show, and none of
  // that is visible in the ledger. Only a failure before the session exists (nothing to stop) skips it.
  const streamController = new AbortController()

  async function throwWithBarrier(
    kind: RunCoreErrorKind,
    message: string,
    options: {
      readonly providerFailureReason?: ProviderFailureReason
      readonly cause?: unknown
      /** Quarantine whatever the barrier finds: the run cannot read where the work went (a moved session). */
      readonly alwaysQuarantine?: boolean
    } = {},
  ): Promise<never> {
    const {providerFailureReason, cause, alwaysQuarantine = false} = options
    // Fail-close the human waits FIRST: the barrier can take up to 15 s, and until the waits are settled an approval
    // could still be answered, and the run's grants (dropped with the coordinator) could still cover a late ask. Neither call is awaited; their replies are bounded by their own
    // timeouts and must not delay the stop.
    ownershipCoordinator.dispose('run ended')
    // eslint-disable-next-line no-void
    void questions?.dispose('run ended')
    // The run is over: close the event connection with it, whichever path got here.
    streamController.abort()
    liveReconcileClosed = true
    reconciler.dispose()
    drain.dispose()
    const settlement = await settleOwnedSessionsV2({
      client,
      directory,
      rootSessionId: sessionId,
      ledger,
      runStartedAt,
      knownSessionIds: () => [...movedSessionIds],
      logger,
      ...(runId === undefined ? {} : {runId}),
      ...(directoryStability === undefined ? {} : {stability: directoryStability}),
    })
    if (settlement.settled && !alwaysQuarantine) {
      throw new RunCoreError(kind, message, false, providerFailureReason, cause)
    }
    // The directory could not be confirmed quiet (or must not be trusted to be): a paused producer can still wake a
    // session. Keep stopping whatever shows up for the whole hold.
    startQuarantineWatchV2({
      client,
      directory,
      rootSessionId: sessionId,
      knownSessionIds: () => [...movedSessionIds],
      logger,
      ...(runId === undefined ? {} : {runId}),
    })
    logger.error(
      {
        ...(runId === undefined ? {} : {runId}),
        sessionId,
        kind,
        detail: settlement.settled ? 'forced' : settlement.reason,
      },
      'run-core: the run’s directory could not be confirmed quiet before this failure — quarantining run',
    )
    throw new RunCoreError(kind, message, true, providerFailureReason, cause)
  }

  // Fails the run on a provider rejection the server will not recover from (#1836). Reuses `session-error`: a new
  // operator failure kind would be a contract change. Only the fixed `reason` leaves the classifier; the provider's own
  // message is never logged or placed in the error.
  async function failFromProvider(failure: ProviderFailure, source: string, alwaysQuarantine = false): Promise<never> {
    logger.error(
      {sessionId, source, errorName: failure.errorName, reason: failure.reason},
      'run-core: provider rejected the request — failing run',
    )
    clearInactivity()
    throw await throwWithBarrier('session-error', `Provider failure: ${failure.reason}`, {
      providerFailureReason: failure.reason,
      alwaysQuarantine,
    })
  }

  // ── 2. Subscribe to events (eager) ─────────────────────────────────────────
  // The stream is connected here, before the prompt is sent: the server replays nothing to a late connection. The
  // subscription's signal is the run's own deadline and cancel plus `streamController`, which every exit aborts, so a
  // silence or replaced-stream failure never leaves the reader parked on a socket nobody listens to.
  let eventStream: AsyncIterable<unknown>
  try {
    const subscribed = await client.subscribeEvents({
      directory,
      signal: AbortSignal.any([combinedSignal, streamController.signal]),
    })
    if (!subscribed.success) {
      const kind: RunCoreErrorKind = subscribed.error.kind === 'auth' ? 'auth' : 'unreachable'
      if (subscribed.error.kind === 'aborted' && combinedSignal.aborted) {
        clearInactivity()
        throw await throwWithBarrier('timeout', 'Run timed out: signal aborted while subscribing to events')
      }
      logger.error({sessionId, detail: describeCallError(subscribed.error)}, 'run-core: event subscribe failed')
      throw await throwWithBarrier(kind, `Event subscribe failed: ${describeCallError(subscribed.error)}`)
    }
    eventStream = subscribed.data
    logger.info({sessionId, directory}, 'run-core: event stream subscribed')
  } catch (error) {
    if (error instanceof RunCoreError) throw error
    const message = toErrorMessage(error)
    logger.error({sessionId, detail: message}, 'run-core: event.subscribe threw')
    throw await throwWithBarrier('unreachable', `Event subscribe threw: ${message}`)
  }

  // ── 2b. Post-subscribe abort check ────────────────────────────────────────
  if (combinedSignal.aborted) {
    clearInactivity()
    logger.warn({sessionId}, 'run-core: signal aborted after event subscribe')
    throw await throwWithBarrier('timeout', 'Run timed out: signal aborted after event subscribe')
  }

  // ── 2c. Connect barrier ───────────────────────────────────────────────────
  // Read the first frame of ONE iterator. The server registers its listener before it emits `server.connected`, so once
  // that frame is read nothing published later can be missed. The same iterator is consumed by the event loop below.
  // Nothing has been sent yet, so a failure here is `unreachable` (cancel and deadline keep `timeout`).
  const eventIterator = eventStream[Symbol.asyncIterator]()
  const firstFrame = await awaitFirstEvent(eventIterator, combinedSignal, EVENT_STREAM_CONNECT_TIMEOUT_MS)
  if (firstFrame.kind === 'aborted') {
    clearInactivity()
    logger.warn({sessionId}, 'run-core: signal aborted while waiting for the event stream to connect')
    throw await throwWithBarrier(
      'timeout',
      'Run timed out: signal aborted while waiting for the event stream to connect',
    )
  }
  if (firstFrame.kind !== 'frame' || mapV2Event(firstFrame.value)?.kind !== 'connected') {
    const detail =
      firstFrame.kind === 'frame'
        ? 'first frame was not server.connected'
        : firstFrame.kind === 'error'
          ? toErrorMessage(firstFrame.error)
          : firstFrame.kind
    logger.error({sessionId, detail}, 'run-core: event stream did not connect before the prompt')
    throw await throwWithBarrier('unreachable', `Event stream did not connect: ${detail}`, {
      cause: firstFrame.kind === 'error' ? firstFrame.error : undefined,
    })
  }
  eventStream = resumeWith(eventIterator, firstFrame.value)

  // ── 3. Send prompt ─────────────────────────────────────────────────────────
  // Admission is not instant (about 270 ms on a cold location, probe P1), and an interrupt sent before it is admitted
  // leaves no trace. That is why nothing below ever reads an interrupt reply as a stop.
  try {
    const prompted = await client.prompt({sessionId, text: promptText, directory, signal: combinedSignal})
    if (!prompted.success) {
      const detail = describeCallError(prompted.error)
      if (prompted.error.kind === 'aborted' && combinedSignal.aborted) {
        // Cancelling the request does not prove the server never admitted the prompt: a stop where the root may be
        // running, not an unreachable server.
        clearInactivity()
        logger.warn({sessionId, detail}, 'run-core: signal aborted while sending the prompt')
        throw await throwWithBarrier('timeout', 'Run timed out: signal aborted while sending the prompt')
      }
      if (prompted.error.kind === 'auth') {
        logger.error({sessionId, detail: 'prompt 401'}, 'run-core: workspace proxy rejected bearer token')
        throw await throwWithBarrier('auth', `Prompt rejected: ${detail}`)
      }
      if (prompted.error.kind === 'http' || prompted.error.kind === 'parse') {
        logger.error({sessionId, detail}, 'run-core: prompt returned an error')
        throw await throwWithBarrier('prompt-error', `Prompt error: ${detail}`)
      }
      logger.error({sessionId, detail}, 'run-core: prompt failed (server unreachable?)')
      throw await throwWithBarrier('unreachable', `Prompt failed: ${detail}`)
    }
    logger.info({sessionId, directory}, 'run-core: prompt sent')
    onBusy?.(true)
    resetInactivity()
  } catch (error) {
    if (error instanceof RunCoreError) throw error
    const message = toErrorMessage(error)
    if (combinedSignal.aborted) {
      clearInactivity()
      logger.warn({sessionId, detail: message}, 'run-core: signal aborted while sending the prompt')
      throw await throwWithBarrier('timeout', 'Run timed out: signal aborted while sending the prompt')
    }
    logger.error({sessionId, detail: message}, 'run-core: prompt threw (server unreachable?)')
    throw await throwWithBarrier('unreachable', `Prompt threw: ${message}`)
  }

  // ── 3b. Post-prompt abort check ────────────────────────────────────────────
  if (combinedSignal.aborted) {
    clearInactivity()
    logger.warn({sessionId}, 'run-core: signal aborted after prompt send')
    throw await throwWithBarrier('timeout', 'Run timed out: signal aborted after prompt send')
  }

  // ── 4. Consume event stream ────────────────────────────────────────────────
  // Tool name and input by call id: `session.tool.success` carries neither.
  const toolCalls = new Map<string, {name: string | null; input: Readonly<Record<string, unknown>> | null}>()
  // The shell a tool call started, by call id: `session.tool.progress` names it before the call finishes, and a failed
  // call may not repeat it.
  const shellByCall = new Map<string, string>()
  // Inner calls of `execute` calls already shown, by `v2InnerCallKey`.
  const shownInnerCalls = new Set<string>()
  // Text parts that received at least one delta, by message and ordinal: an end event repeats their text.
  const streamedTextParts = new Set<string>()

  // Segment boundaries: the sinks are append-only and see only strings, so separate text parts would otherwise run
  // together. The separator is inserted once, through the sink. See `text-boundary.ts` for the rule.
  const textBoundary = createTextBoundaryTracker()
  const trackedSink: CoreStreamSink = {
    append: text => {
      sink.append(text)
      textBoundary.noteAppended(text)
    },
  }

  function appendSegmentText(segmentKey: string | null, text: string): void {
    const emit = textBoundary.append(segmentKey, text)
    if (emit.length > 0) sink.append(emit)
  }

  // Observability counters (#1101): disambiguate a genuine workspace hang (zero events) from an event-routing gap
  // (events arrived but none reset the inactivity timer).
  let totalEvents = 0
  let activityEvents = 0
  let serverConnectedCount = 0
  let lastEventType: string | undefined

  function markActivity(): void {
    activityEvents += 1
    resetInactivity()
  }

  // Human-wait gauge: the request ids a human still has to settle, approvals and questions alike. The inactivity
  // watchdog is paused while the map is non-empty and, outside drain, re-armed with a fresh window only when the last
  // id is released. Keying by request id keeps both directions idempotent. The gauge never influences drain: while
  // `draining` the watchdog stays paused whatever is released, and the hard deadline is the only bound.
  let humanWaitsClosed = false

  function holdHumanWait(requestId: string, kind: HumanWaitKind): void {
    outstandingHumanWaits.set(requestId, kind)
    onBusy?.(false)
    clearInactivity()
  }

  function releaseHumanWait(requestId: string): void {
    if (humanWaitsClosed) return
    if (!outstandingHumanWaits.delete(requestId)) return
    if (draining) return
    if (outstandingHumanWaits.size > 0) return
    onBusy?.(true)
    markActivity()
  }

  // Terminal notifications from the request gate release the wait for any settlement path, including the ones that
  // produce no server echo (deadline skip, failed reply, teardown).
  const unsubscribeHumanWaitTerminal = onHumanWaitTerminal?.(event => {
    releaseHumanWait(event.requestID)
  })

  // True for the root, or a descendant this run's ledger adopted. The boundary that keeps a stranger's tool calls,
  // approvals and forms out of this run's handling and Discord thread.
  function isOwnedSession(eventSessionID: string | null): boolean {
    return eventSessionID !== null && ownershipCoordinator.isOwned(eventSessionID)
  }

  /** Real run activity on an owned session: re-arms the watchdog, and invalidates the drain gate's idle evidence. */
  function noteActivity(eventSessionId: string): void {
    markActivity()
    if (eventSessionId === sessionId) drain.noteRootActivity()
  }

  function cancelUnanswerableForm(formId: string, formSessionId: string, message: string): void {
    // Fire-and-continue: awaiting would starve the stream. A failed cancel leaves the form pending until the run's
    // deadline, which is what V1 did for every unanswerable question.
    client
      .cancelForm({
        sessionId: formSessionId,
        formId,
        message,
        signal: AbortSignal.timeout(FORM_CANCEL_TIMEOUT_MS),
      })
      .then(
        result => {
          if (!result.success) {
            logger.warn(
              {formId: safeLogId(formId), sessionID: safeLogId(formSessionId), error: result.error.kind},
              'run-core: form cancel returned an error',
            )
          }
        },
        () => {
          logger.warn({formId: safeLogId(formId)}, 'run-core: form cancel threw')
        },
      )
  }

  /**
   * Adopt a background shell into the ledger. Idempotent by shell id: a shell is seen at creation, and again when its
   * tool call returns `running`. A notice that preceded the adoption settles it at once.
   */
  function adoptShell(shellId: string, source: 'shell-created' | 'tool-result'): void {
    const key = shellLedgerKey(shellId)
    const fresh = !ledger.isTracked(key)
    // The command is model-controlled text and stays out of the ledger label and the logs.
    ledger.adopt(key, 'background shell')
    if (noticedShellIds.has(shellId)) ledger.settle(key)
    if (fresh) {
      logger.info({sessionId, shellId, source}, 'run-core: background shell adopted into ownership ledger')
    }
  }

  // The silence watchdog starts here (the primitive arms on creation), immediately before the `try` whose `finally`
  // disposes it, so nothing can throw in between and leak it. It feeds only the loop's own abort: the wall-clock and
  // activity signals keep their meaning for every check on `combinedSignal`.
  const silenceTimer = createInactivityTimer({timeoutMs: streamSilenceTimeoutMs ?? 0})

  // The stream is wrapped so the loop does not block indefinitely on a silent server when a signal fires mid-wait. The
  // abort signal also includes `drainDoneController.signal`, so the loop unblocks the instant the gate admits.
  const abortableStream = makeAbortableStream(
    eventStream,
    AbortSignal.any([combinedSignal, drainDoneController.signal, silenceTimer.signal]),
  )

  // Any frame, heartbeats included, proves the stream is alive. Before type dispatch, so no branch can skip it.
  async function* observeFrames(source: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    for await (const frame of source) {
      silenceTimer.reset()
      totalEvents += 1
      lastEventType = typeof frame === 'object' && frame !== null && 'type' in frame ? String(frame.type) : undefined
      yield frame
    }
  }

  const events = mapV2EventStream(observeFrames(abortableStream), {
    logger: toRuntimeLogger(logger),
    isOwnedSession,
  })

  function handleToolStart(event: Extract<V2DomainEvent, {kind: 'tool_started'}>): void {
    toolCalls.set(event.callId, {name: event.name, input: null})
  }

  function showInnerCalls(event: {
    readonly callId: string
    readonly calls: readonly {
      readonly key: string
      readonly tool: string
      readonly status: string
      readonly input: Readonly<Record<string, unknown>> | null
    }[]
  }): void {
    for (const inner of event.calls) {
      if (inner.status === 'running' || shownInnerCalls.has(inner.key)) continue
      shownInnerCalls.add(inner.key)
      appendToolSummary(
        {
          tool: inner.tool,
          state: {
            ...(inner.input === null ? {} : {input: {...inner.input}}),
            // The generic renderer prints a call's input alone; the title is what says which tool ran.
            title: inner.tool,
            status: inner.status === 'error' ? 'error' : 'completed',
          },
        },
        trackedSink,
        logger,
        onActivity,
      )
    }
  }

  try {
    for await (const event of events) {
      // Check abort at the top of each iteration so we exit as soon as the signal fires, even if the stream keeps
      // yielding events.
      if (combinedSignal.aborted) break

      switch (event.kind) {
        case 'connected': {
          // The server announces a stream once, when it opens. A second announcement means the connection was
          // replaced, and events in between were never delivered: this run can no longer trust what it saw.
          serverConnectedCount += 1
          if (serverConnectedCount > 1) {
            logger.error(
              {sessionId, totalEvents, activityEvents, lastEventType},
              'run-core: event stream announced itself again — stream was replaced',
            )
            throw await throwWithBarrier(
              'stream-ended',
              'Event stream was replaced (a second server.connected arrived)',
            )
          }
          break
        }

        case 'text_delta': {
          if (!isOwnedSession(event.sessionId)) break
          const partKey = `${event.messageId ?? event.sessionId}:${event.ordinal}`
          streamedTextParts.add(partKey)
          appendSegmentText(event.messageId === null ? null : `part:${partKey}`, event.delta)
          noteActivity(event.sessionId)
          break
        }

        case 'text_ended': {
          if (!isOwnedSession(event.sessionId)) break
          // The end event repeats the text deltas already delivered. A part that ended without any delta (a provider
          // that does not stream) is appended whole, once, so its text is not lost.
          const partKey = `${event.messageId ?? event.sessionId}:${event.ordinal}`
          if (!streamedTextParts.has(partKey) && event.text.length > 0) {
            streamedTextParts.add(partKey)
            appendSegmentText(event.messageId === null ? null : `part:${partKey}`, event.text)
          }
          noteActivity(event.sessionId)
          break
        }

        case 'reasoning_activity': {
          // Carries no text, so there is nothing to suppress: it can only keep the watchdog honest.
          if (isOwnedSession(event.sessionId)) noteActivity(event.sessionId)
          break
        }

        case 'tool_started': {
          if (isOwnedSession(event.sessionId)) handleToolStart(event)
          break
        }

        case 'tool_called': {
          if (!isOwnedSession(event.sessionId)) break
          const known = toolCalls.get(event.callId)
          toolCalls.set(event.callId, {name: known?.name ?? null, input: event.input})
          logger.debug({callId: event.callId, tool: known?.name}, 'run-core: tool called')
          break
        }

        case 'tool_progress': {
          if (!isOwnedSession(event.sessionId)) break
          const progressShellId = readToolShellId(event.metadata)
          if (progressShellId !== null) shellByCall.set(event.callId, progressShellId)
          showInnerCalls(event)
          noteActivity(event.sessionId)
          break
        }

        case 'tool_finished': {
          if (!isOwnedSession(event.sessionId)) break
          const info = toolCalls.get(event.callId)
          toolCalls.delete(event.callId)
          const callShellId = readToolShellId(event.metadata) ?? shellByCall.get(event.callId) ?? null
          shellByCall.delete(event.callId)
          const name = info?.name ?? null
          logger.debug({callId: event.callId, tool: name, outcome: event.outcome}, 'run-core: tool finished')

          if (name === 'execute' || event.calls.length > 0) {
            // Code Mode: the wrapper is not a tool line; the calls it made are.
            showInnerCalls(event)
          } else if (name !== null) {
            // Background dispatch observed: a `subagent` call that finished successfully with running metadata. Adopt
            // the child; the wrapped ledger's `onAdopted` hook registers it with the coordinator. This is the ONLY
            // path that calls `ledger.adopt` — reconciliation never adopts an untracked session.
            const dispatch = readBackgroundDispatch(name, event)
            if (dispatch !== null) {
              const description = info?.input?.description
              const label = typeof description === 'string' && description.length > 0 ? description : 'background task'
              ledger.adopt(dispatch.childSessionId, label)
              if (noticedChildIds.has(dispatch.childSessionId)) ledger.settle(dispatch.childSessionId)
              logger.info(
                {sessionId, childSessionId: dispatch.childSessionId, label},
                'run-core: background dispatch observed -- adopted into ownership ledger',
              )
            }
            if (name === 'shell') {
              // A shell is adopted when it is created, before anyone knows whether it will outlive its call. Only a
              // call that returns `running` did: it sends a notice and wakes its owner. A call that ended any other
              // way ran in the foreground and is over, so its entry would wait for a notice that never comes.
              const shellDispatch = readBackgroundShellDispatch(name, event)
              if (shellDispatch !== null) {
                adoptShell(shellDispatch.shellId, 'tool-result')
              } else if (callShellId !== null) {
                ledger.release(shellLedgerKey(callShellId))
              }
            }
            const title = titleFromInput(info?.input ?? null)
            appendToolSummary(
              {
                tool: rendererToolName(name),
                state: {
                  ...(info?.input === null || info?.input === undefined ? {} : {input: {...info.input}}),
                  ...(title === undefined ? {} : {title}),
                  status: event.outcome === 'failed' ? 'error' : 'completed',
                },
              },
              trackedSink,
              logger,
              onActivity,
            )
          }
          noteActivity(event.sessionId)
          break
        }

        case 'permission_asked': {
          if (!isOwnedSession(event.sessionId)) break
          // approval-required mode: route to the coordinator. The request is keyed by REQUEST id: two approvals raised
          // from one `execute` call share the call id and are two requests.
          const request = parsePermissionRequest({
            id: event.requestId,
            sessionID: event.sessionId,
            permission: event.action === 'shell' ? 'bash' : event.action,
            patterns: event.resources,
            // `save` is what upstream would store on an `always`; the coordinator keeps it as a run-local grant.
            always: event.save,
          })
          if (request === null) {
            logger.warn({eventType: 'permission.asked'}, 'run-core: permission.asked payload malformed — skipping')
            break
          }
          // Pauses typing and the inactivity timer until every outstanding approval is released.
          holdHumanWait(request.requestID, 'approval')
          // Fire-and-continue: do NOT await — awaiting would starve the stream.
          // eslint-disable-next-line no-void
          void coordinator.onPermissionAsked(request)
          logger.info({requestID: request.requestID}, 'run-core: permission.asked forwarded to coordinator')
          break
        }

        case 'permission_replied': {
          // Authoritative settlement — route to the coordinator.
          if (!isOwnedSession(event.sessionId)) break
          const reply = parsePermissionReply({
            requestID: event.requestId,
            sessionID: event.sessionId,
            reply: event.reply,
          })
          if (reply === null) {
            logger.warn({eventType: 'permission.replied'}, 'run-core: permission.replied payload malformed — skipping')
            break
          }
          releaseHumanWait(reply.requestID)
          coordinator.onPermissionReplied(reply)
          logger.info({requestID: reply.requestID, reply: reply.reply}, 'run-core: permission.replied forwarded')
          break
        }

        case 'form_asked': {
          if (!isOwnedSession(event.sessionId)) {
            // A form from a session this run does not own must not reach this run's operators. Logged because the
            // asking session is blocked on it: ids and a reason code only.
            logger.warn(
              {formId: safeLogId(event.formId), sessionID: safeLogId(event.sessionId), reason: 'unowned-session'},
              'run-core: form.created from a session this run does not own — ignoring',
            )
            break
          }
          if (event.formKind !== 'question') {
            // Nobody can fill in a form of another kind here. Cancel it with a message so the asking step continues,
            // and tell the user: a silently cancelled request would look like the agent ignoring it.
            logger.warn(
              {formId: safeLogId(event.formId), sessionID: safeLogId(event.sessionId), reason: 'unsupported-form-kind'},
              'run-core: form of an unsupported kind — cancelling',
            )
            cancelUnanswerableForm(event.formId, event.sessionId, UNSUPPORTED_FORM_MESSAGE)
            trackedSink.append(`\n${UNSUPPORTED_FORM_NOTICE}\n`)
            onActivity?.(UNSUPPORTED_FORM_NOTICE)
            break
          }
          if (questions === undefined) {
            logger.warn(
              {formId: safeLogId(event.formId), sessionID: safeLogId(event.sessionId), reason: 'no-question-handler'},
              'run-core: question form but no question handler is configured — cancelling',
            )
            cancelUnanswerableForm(event.formId, event.sessionId, NO_QUESTION_HANDLER_MESSAGE)
            break
          }
          // Recorded before anything can reply or reject: the question effects look the session and layout up by form id.
          forms.remember(event.formId, {sessionId: event.sessionId, fields: event.fields})
          const parsed = parseQuestionRequest(questionPayloadFromForm(event.formId, event.sessionId, event.fields))
          if (parsed.kind === 'malformed') {
            logger.warn(
              {formId: safeLogId(event.formId), sessionID: safeLogId(event.sessionId), reason: parsed.reason},
              'run-core: question form payload malformed — rejecting',
            )
            // The asking tool call is blocked on this form: reject it so the turn ends now, not at the inactivity timer.
            // eslint-disable-next-line no-void
            void questions.onMalformed({requestID: event.formId, sessionID: event.sessionId, reason: parsed.reason})
            break
          }
          const asked: QuestionAskedRequest = parsed.value
          // Pauses typing and the inactivity timer until every outstanding human wait is released.
          holdHumanWait(asked.requestID, 'question')
          // Fire-and-continue. A question the coordinator did not hand to the gate (skipped for lack of budget, or a
          // failed registration) never produces a terminal event, so release its wait here.
          questions
            .onAsked(asked)
            .then(outcome => {
              if (outcome === 'skipped' || outcome === 'failed') releaseHumanWait(asked.requestID)
            })
            .catch(() => {
              releaseHumanWait(asked.requestID)
            })
          logger.info(
            {requestID: asked.requestID, sessionID: asked.sessionID},
            'run-core: question form forwarded to question handler',
          )
          break
        }

        case 'form_resolved': {
          // Authoritative settlement from the server — works whether or not the gateway claimed the request.
          const record = forms.lookup(event.formId)
          if (record === undefined || !isOwnedSession(event.sessionId) || questions === undefined) break
          questions.onEcho(
            event.outcome === 'replied'
              ? {
                  kind: 'replied',
                  requestID: event.formId,
                  sessionID: event.sessionId,
                  answers: answersFromForm(record.fields, event.answer),
                }
              : {kind: 'rejected', requestID: event.formId, sessionID: event.sessionId},
          )
          // The echo is proof the server is unblocked, so release even if the gate had no entry for it.
          releaseHumanWait(event.formId)
          forms.forget(event.formId)
          logger.info({requestID: safeLogId(event.formId), echo: event.outcome}, 'run-core: form echo forwarded')
          break
        }

        case 'subagent_notice': {
          // The server's own statement that a child ended, read from metadata and never from text. Every terminal
          // state settles the entry (a cancelled child included).
          if (!isOwnedSession(event.sessionId)) break
          noticedChildIds.add(event.notice.childSessionId)
          // The gate hears it first: the notice must be registered before the settle can ask it to validate.
          drain.noteNotice(event.notice, event.inboxId)
          settleLedgerFromSubagentNotice(ledger, event.notice)
          markActivity()
          logger.info(
            {sessionId, childSessionId: event.notice.childSessionId, state: event.notice.state},
            'run-core: child completion notice observed',
          )
          break
        }

        case 'shell_started': {
          // The earliest signal that an owned session started a shell. A shell nobody tagged (`POST /api/shell`), one
          // a stranger's session started, and a user-run command (awaited by its request, no notice) are not owned.
          if (event.userCommand || event.ownerSessionId === null || !isOwnedSession(event.ownerSessionId)) break
          adoptShell(event.shellId, 'shell-created')
          break
        }

        case 'shell_exited': {
          // Informational only. The process ending is not the job ending: the notice is, and it can arrive on either
          // side of this frame (probes p20 and p22).
          logger.debug({shellId: event.shellId, status: event.status}, 'run-core: shell exited')
          break
        }

        case 'shell_notice': {
          // The server's own statement that a background shell ended, read from metadata and never from text. It
          // wakes the owner, so the gate waits for the turn it triggers exactly as it does for a child.
          if (!isOwnedSession(event.ownerSessionId)) break
          noticedShellIds.add(event.shellId)
          drain.noteShellNotice(event.shellId, event.state, event.inboxId)
          settleLedgerFromShellNotice(ledger, {shellId: event.shellId, state: event.state})
          markActivity()
          logger.info(
            {sessionId, shellId: event.shellId, state: event.state},
            'run-core: background shell completion notice observed',
          )
          break
        }

        case 'inbox_delivered': {
          // Any owned session: a notice can be queued into a busy child, and is delivered there. Inbox ids are unique
          // message ids, so a delivery can only match the notice it names.
          if (isOwnedSession(event.sessionId)) drain.noteInboxDelivered(event.inboxId)
          break
        }

        case 'execution_started': {
          if (event.sessionId === sessionId) {
            drain.noteRootActivity()
          }
          break
        }

        case 'execution_succeeded': {
          // Deliberately root-scoped, NOT an ownership check: a descendant finishing a turn must never end the run
          // while the root is still working. Root success is the signal to CONSIDER finishing; whether that is allowed
          // is the drain gate's call, below.
          if (event.sessionId !== sessionId) break
          // Every success drains, whether or not anything was adopted: the root's own idle is evidence about the root
          // only, and the run is released on the directory staying quiet (see the drain-completion gate). The run stays
          // alive — slot, lease and approval routing continue — until the gate admits success or the deadline expires.
          const ledgerSettled = ledger.isDrainComplete()
          if (!draining) {
            draining = true
            logger.info(
              {sessionId, outstanding: ledger.outstanding(), totalEvents, activityEvents},
              ledgerSettled
                ? 'run-core: root idle — waiting for the directory to stay quiet'
                : 'run-core: root idle with owned work outstanding — draining',
            )
            onBusy?.(false)
            clearInactivity()
            drain.beginDrain()
          }

          // Root idle is evidence only for the generation it arrives in: stamp the current revision.
          drain.noteRootIdle()

          // Immediate reconcile pass so already-finished background work settles without waiting for the interval.
          // Fire-and-forget: its mutations (via the wrapped ledger) trigger persistence and validation on their own.
          if (!ledgerSettled) {
            // eslint-disable-next-line no-void
            void runLivePasses(liveReconcileOptions)
          }

          // Validate now that this generation has idle evidence. Coalesced: at most one in flight.
          drain.requestValidation()
          break
        }

        case 'execution_failed': {
          if (event.sessionId === sessionId) {
            throw await failFromProvider(failureFromV2Error(event.error), 'session.execution.failed')
          }
          if (isOwnedSession(event.sessionId)) {
            // A child's failure does not end the root's turn. It is evidence something went wrong, not proof the child
            // stopped writing, so the entry is marked `unknown` — never `settled` — and the root learns the outcome from
            // the child's notice. The drain settles the entry once reconciliation sees it stop, or cancels it at the
            // deadline.
            ledger.markUnknown(event.sessionId)
            logger.warn(
              {sessionId, childSessionId: event.sessionId},
              'run-core: owned child reported a terminal execution failure — marked unknown, run continues',
            )
          }
          break
        }

        case 'execution_interrupted': {
          if (event.sessionId === sessionId) {
            // An interrupt the gateway did not send. The run's own stop ends the loop before this is read, so one that
            // arrives here came from another client, or from the server (reason `shutdown`, which leaves the claim held
            // and the execution resumable, so the root may not have stopped).
            logger.error({sessionId, reason: event.reason}, 'run-core: root execution was interrupted — failing run')
            // A `shutdown` interrupt leaves the execution claim held and resumable (probe P11): the root can start again
            // by itself later, which no reading of the directory can rule out, so it always quarantines.
            throw await failFromProvider(
              INTERRUPTED_FAILURE,
              'session.execution.interrupted',
              event.reason === 'shutdown',
            )
          }
          if (isOwnedSession(event.sessionId)) {
            ledger.markUnknown(event.sessionId)
            logger.warn(
              {sessionId, childSessionId: event.sessionId, reason: event.reason},
              'run-core: owned child was interrupted — marked unknown, run continues',
            )
          }
          break
        }

        case 'retry_scheduled': {
          // A retry is not a failure: the terminal event decides (see `provider-failure-v2.ts`). It is activity, and the
          // root may be mid-backoff, so it is logged for the operator.
          if (isOwnedSession(event.sessionId)) {
            logger.warn(
              {sessionId: event.sessionId, attempt: event.attempt},
              'run-core: provider retry scheduled — waiting',
            )
          }
          break
        }

        case 'step_failed': {
          // Informational: a failed step is followed by either a retry or the execution's own terminal event.
          if (isOwnedSession(event.sessionId)) {
            logger.warn(
              {sessionId: event.sessionId},
              'run-core: a model step failed — waiting for the execution outcome',
            )
          }
          break
        }

        case 'session_moved': {
          // An owned move is upgraded to `fatal` by the mapper; one that reaches here belongs to a stranger.
          break
        }

        case 'fatal': {
          // The outside-checkout rules re-base on the destination (probe P12), so the run can no longer be trusted to
          // stay inside its sandbox. The barrier interrupts the root and every owned child, then the run fails.
          logger.error({sessionId, movedSessionId: event.sessionId}, 'run-core: an owned session moved — failing run')
          movedSessionIds.add(event.sessionId)
          clearInactivity()
          // Always quarantined: the destination's shells and sessions cannot be read from the directory this run lists, so
          // a quiet directory says nothing about where the moved session's work went.
          throw await throwWithBarrier('session-error', 'An owned session changed location during the run', {
            alwaysQuarantine: true,
          })
        }

        case 'malformed': {
          // A known event whose payload could not be read (the mapper already logged the type and reason, never the
          // payload). One that names an owned session and could hide a request nobody can answer fails closed: the
          // asking tool call would block until the deadline.
          const safetyRelevant =
            event.eventType === 'permission.asked' ||
            event.eventType === 'form.created' ||
            event.eventType === 'session.moved' ||
            // A shell of an owned session that cannot be identified is a writer nobody can wait for or stop.
            event.eventType === 'shell.created'
          if (event.childSessionId !== undefined && isOwnedSession(event.sessionId)) {
            // A child's notice the server sent and this client cannot read. It proves nothing about the child, so the
            // child is fenced rather than waited on: the gate stops expecting a readable notice, and the entry is
            // `unknown` (never `settled`) until reconciliation sees it stop.
            drain.noteUnreadableNotice()
            ledger.markUnknown(event.childSessionId)
            markActivity()
            logger.warn(
              {sessionId, childSessionId: event.childSessionId, eventType: event.eventType},
              'run-core: a child completion notice could not be read — child fenced and marked unknown',
            )
            break
          }
          if (event.shellId !== undefined && isOwnedSession(event.sessionId)) {
            // A shell job's notice the server sent and this client cannot read: fenced like a child's. The gate stops
            // expecting a readable notice, and the entry is `unknown` (never `settled`) until reconciliation sees the
            // shell stop.
            drain.noteUnreadableNotice()
            ledger.markUnknown(shellLedgerKey(event.shellId))
            markActivity()
            logger.warn(
              {sessionId, shellId: event.shellId, eventType: event.eventType},
              'run-core: a background shell notice could not be read — shell fenced and marked unknown',
            )
            break
          }
          if (safetyRelevant && isOwnedSession(event.sessionId)) {
            logger.error(
              {sessionId, eventType: event.eventType},
              'run-core: an unreadable event from an owned session could hide a request — failing run',
            )
            clearInactivity()
            throw await throwWithBarrier('session-error', 'An unreadable event from an owned session')
          }
          break
        }
      }
    }
  } catch (error) {
    // A rejected stream or an unexpected throw in the loop body is not a RunCoreError. It must not escape raw: `run.ts`
    // would treat it as an unquarantined failure and release the lock and slot while the root, whose prompt keeps
    // running server-side, may still be writing the checkout.
    if (error instanceof RunCoreError) throw error
    const message = toErrorMessage(error)
    clearInactivity()
    logger.error({sessionId, detail: message}, 'run-core: event loop failed unexpectedly')
    throw await throwWithBarrier('stream-ended', `Event stream failed: ${message}`, {
      cause: error,
    })
  } finally {
    // The timers are always disposed on loop exit (normal, break, or throw).
    inactivityTimer.dispose()
    silenceTimer.dispose()
    // Every exit of the loop closes the connection: the reader is otherwise left parked on a socket.
    streamController.abort()
    liveReconcileClosed = true
    reconciler.dispose()
    // No validation result may admit success once the loop has exited, and its retry timer must not leak.
    drain.dispose()
    // A run that is no longer draining has no wait reason, whatever way the loop ended.
    if (runId !== undefined) clearWaitReason(runId)
    // The watchdog is gone: stop reacting to gate notifications and late releases.
    humanWaitsClosed = true
    unsubscribeHumanWaitTerminal?.()
    // Release whitespace still held for segments that never became visible, on EVERY exit.
    const heldTail = textBoundary.flush()
    if (heldTail.length > 0) sink.append(heldTail)
  }

  // Drain completed successfully: the gate admitted and `drainDoneController` unblocked the stream — NOT a failure.
  // Checked before `combinedSignal.aborted` because both signals feed the loop's abort and only one can be responsible.
  if (!combinedSignal.aborted && drainDoneController.signal.aborted) {
    logger.info(
      {sessionId, totalEvents, activityEvents, lastEventType},
      'run-core: drain complete — owned work settled',
    )
    onBusy?.(false)
    clearInactivity()
    return
  }

  // The silence watchdog is classified by its own signal, ahead of the drain-timeout, inactivity and wall-clock
  // branches: a silent stream is a lost stream whichever of those deadlines fired alongside it. It sits after the
  // drain-complete success on purpose: a drain the gate admitted in the same tick is a completed run.
  if (silenceTimer.signal.aborted) {
    logger.error(
      {sessionId, totalEvents, activityEvents, lastEventType, silenceMs: streamSilenceTimeoutMs},
      'run-core: event stream silent — failing the run',
    )
    throw await throwWithBarrier(
      'stream-ended',
      `Event stream silent for ${Math.round((streamSilenceTimeoutMs ?? 0) / 1000)}s`,
    )
  }

  // Stream exhausted (loop exited normally or via break). Distinguish timeout from premature close.
  if (combinedSignal.aborted) {
    if (draining) {
      // The run's own deadline covers execution AND drain. Cancelling and confirming every unsettled entry (outstanding
      // AND unknown) lives in `throwWithBarrier`, which cancels per entry rather than with a tree-cancel.
      logger.warn(
        {sessionId, outstanding: ledger.outstanding(), unknown: ledger.unknown(), totalEvents, activityEvents},
        'run-core: drain deadline expired — cancelling unsettled owned work, run reports incomplete',
      )
      throw await throwWithBarrier('drain-timeout', 'Run timed out while draining outstanding owned work')
    }

    // Inactivity is the tighter bound (always < hard ceiling), so on the rare both-aborted tick we attribute to it.
    if (inactivityArmed && inactivityTimer.signal.aborted) {
      logger.warn(
        {sessionId, totalEvents, activityEvents, lastEventType},
        'run-core: stream ended due to inactivity timeout',
      )
      throw await throwWithBarrier('inactivity-timeout', 'Run timed out: no activity within the inactivity window')
    }
    logger.warn({sessionId, totalEvents, activityEvents, lastEventType}, 'run-core: stream ended due to timeout signal')
    throw await throwWithBarrier('timeout', 'Run timed out: event stream aborted by timeout signal')
  }

  // Stream closed without a root success and not aborted by us → the server may still be working; fail so the run is
  // not silently completed.
  logger.error(
    {sessionId, totalEvents, activityEvents, lastEventType},
    'run-core: event stream closed before the root finished',
  )
  throw await throwWithBarrier('stream-ended', 'Event stream closed before the root execution finished')
}
