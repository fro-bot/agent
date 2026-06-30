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

import type {OpenCodeServerHandle} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {GatewayLogger} from '../discord/client.js'

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

  // ── 0b. Inactivity controller setup ───────────────────────────────────────
  // When inactivityTimeoutMs is set, arm an AbortController that fires after the
  // configured window of silence. The controller is reset on every text delta,
  // tool completion, and permission.replied event. It is cleared (paused) on
  // permission.asked and re-armed on permission.replied.
  // The combined signal merges the wall-clock timeout signal with the inactivity signal
  // so either can abort the event loop.
  let inactivityController: AbortController | null = null
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null

  function clearInactivity(): void {
    if (inactivityTimer !== null) {
      clearTimeout(inactivityTimer)
      inactivityTimer = null
    }
  }

  function resetInactivity(): void {
    if (inactivityController === null || inactivityTimeoutMs === undefined) return
    clearInactivity()
    inactivityTimer = setTimeout(() => {
      inactivityController?.abort()
    }, inactivityTimeoutMs)
  }

  if (inactivityTimeoutMs !== undefined && inactivityTimeoutMs > 0) {
    inactivityController = new AbortController()
  }

  // combinedSignal: aborts when either the wall-clock signal or the inactivity signal fires.
  const combinedSignal = inactivityController === null ? signal : AbortSignal.any([signal, inactivityController.signal])

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
  const abortableStream = makeAbortableStream(eventStream, combinedSignal)

  try {
    for await (const rawEvent of abortableStream) {
      // Check abort at the top of each iteration so we exit as soon as the signal
      // fires, even if the stream itself keeps yielding events.
      if (combinedSignal.aborted) break

      const eventType = getEventKind(rawEvent)
      const eventPayload = getEventPayload(rawEvent)

      if (eventType === 'message.part.delta') {
        // New SDK shape: streaming text delta events.
        // delta may be {type:'text', text:string} or a plain string when field === 'text'.
        // Reasoning suppression: skip any delta whose partID is a known reasoning part.
        const eventSessionID = getEventSessionID(rawEvent)
        if (eventSessionID === sessionId) {
          const deltaPartId = getStringProperty(eventPayload, 'partID')
          if (deltaPartId !== null && reasoningPartIds.has(deltaPartId)) {
            // This delta belongs to a reasoning part — suppress it entirely.
          } else {
            const delta = getObjectProperty(eventPayload, 'delta')
            const deltaType = getStringProperty(delta, 'type')
            const deltaText = getStringProperty(delta, 'text')
            if (deltaType === 'text' && deltaText != null) {
              sink.append(deltaText)
              resetInactivity()
            } else if (typeof delta === 'string' && getStringProperty(eventPayload, 'field') === 'text') {
              sink.append(delta)
              resetInactivity()
            }
          }
        }
      } else if (eventType === 'session.next.text.delta') {
        // Sync/session.next shape: delta is a plain string or {type:'text', text:string}.
        // No partID on this legacy path — reasoning suppression does not apply here.
        const eventSessionID = getEventSessionID(rawEvent)
        if (eventSessionID === sessionId) {
          const deltaRaw = getObjectProperty(eventPayload, 'delta')
          const deltaText = typeof deltaRaw === 'string' ? deltaRaw : (getStringProperty(deltaRaw, 'text') ?? null)
          if (deltaText != null) {
            sink.append(deltaText)
            resetInactivity()
          }
        }
      } else if (eventType === 'message.part.updated') {
        // Tool lifecycle on the V1 session layer arrives via message.part.updated
        // (partType:'tool', state.status:'completed'). The V2 session.next.tool.*
        // events are handled separately below — both families can reach the /event
        // stream, so both branches are live.
        const part = getObjectProperty(eventPayload, 'part')
        const eventSessionID = getSessionID(eventPayload) ?? getSessionID(part)
        if (eventSessionID === sessionId) {
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
              resetInactivity()
            }
          }
        }
      } else if (eventType === 'session.next.tool.called') {
        // V2 sync tool lifecycle: cache call info for correlation with success event.
        const eventSessionID = getEventSessionID(rawEvent)
        if (eventSessionID === sessionId) {
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
        if (eventSessionID === sessionId) {
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
              resetInactivity()
            }
          }
        }
      } else if (eventType === 'permission.asked') {
        const eventSessionID = getEventSessionID(rawEvent)
        if (eventSessionID === sessionId) {
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
        if (eventSessionID === sessionId) {
          const ev = parsePermissionReply(eventPayload)
          if (ev === null) {
            logger.warn({eventType}, 'run-core: permission.replied payload malformed — skipping')
          } else {
            // Approval resolved — resume typing if the run continues.
            onBusy?.(true)
            resetInactivity() // Re-arm inactivity now that the run is unblocked.
            coordinator.onPermissionReplied(ev)
            logger.info(
              {requestID: ev.requestID, reply: ev.reply},
              'run-core: permission.replied forwarded to coordinator',
            )
          }
        }
      } else if (eventType === 'session.idle') {
        const eventSessionID = getEventSessionID(rawEvent)
        if (eventSessionID === sessionId) {
          logger.info({sessionId}, 'run-core: session.idle received — stream complete')
          // Signal not-busy: work is done.
          onBusy?.(false)
          clearInactivity()
          return
        }
      } else if (eventType === 'session.error') {
        const eventSessionID = getEventSessionID(rawEvent)
        if (eventSessionID === null || eventSessionID === sessionId) {
          const errorDetail = getStringProperty(eventPayload, 'error') ?? 'unknown session error'
          logger.error({sessionId, detail: errorDetail}, 'run-core: session.error received')
          clearInactivity()
          throw new RunCoreError('session-error', `Session error: ${errorDetail}`)
        }
      }
    }
  } finally {
    // Ensure the inactivity timer is always cleared on loop exit (normal, break, or throw).
    // The explicit clearInactivity() calls on the session.idle and session.error paths are
    // kept as defensive double-clears — clearTimeout on an already-cleared handle is a no-op.
    clearInactivity()
  }

  // Stream exhausted (loop exited normally or via break). Distinguish timeout from premature close.
  // NOTE: this block runs AFTER the finally above, so clearInactivity() has already fired.
  if (combinedSignal.aborted) {
    // Inactivity is the tighter bound (always < hard ceiling), so on the rare both-aborted
    // tick we attribute to inactivity-timeout deliberately.
    if (inactivityController !== null && inactivityController.signal.aborted) {
      logger.warn({sessionId}, 'run-core: stream ended due to inactivity timeout')
      throw new RunCoreError('inactivity-timeout', 'Run timed out: no activity within the inactivity window')
    }
    logger.warn({sessionId}, 'run-core: stream ended due to timeout signal')
    throw new RunCoreError('timeout', 'Run timed out: event stream aborted by timeout signal')
  }

  // Stream closed without session.idle and not aborted by us → OpenCode
  // may still be working; mark as failed so the run is not silently completed.
  logger.error({sessionId}, 'run-core: event stream closed before session.idle')
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
