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
import type {DiscordStreamSink} from '../discord/streaming.js'

import {parsePermissionReply, parsePermissionRequest} from '../approvals/coordinator.js'

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
  | 'stream-ended' // event stream closed before session.idle was received

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
// Params
// ---------------------------------------------------------------------------

/** Parameters for the execute+stream core. */
export interface RunCoreParams {
  /** Handle to the remote OpenCode server (attach result from `opencode-attach.ts`). */
  readonly handle: OpenCodeServerHandle
  /**
   * Absolute path to the workspace repo checkout.
   * Threaded to BOTH `promptAsync` and `event.subscribe` — required for SSE
   * routing to deliver tool events.
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
   */
  readonly sink: DiscordStreamSink
  /** Abort signal — aborts event iteration when signalled. */
  readonly signal: AbortSignal
  /** Injected logger. Internal details only — never leak session internals to Discord. */
  readonly logger: GatewayLogger
  /**
   * Optional permission coordinator.
   * When present, `permission.asked` and `permission.replied` events are routed
   * to it. When absent, those events are silently ignored (back-compat).
   */
  readonly coordinator?: PermissionCoordinator
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
// Core
// ---------------------------------------------------------------------------

/**
 * Execute a single OpenCode prompt against a remote server and pipe text
 * events to the provided `DiscordStreamSink`.
 *
 * Flow:
 * 1. `session.create()`
 * 2. `event.subscribe({query: {directory}})` — SSE stream (directory REQUIRED,
 *    subscribe-before-prompt removes the race where permission.asked fires
 *    before the SSE listener exists)
 * 3. `session.promptAsync({..., query: {directory}})` — blocks until queued
 * 4. Iterate events:
 *    - `message.part.delta` (this session) → `sink.append(text)`
 *    - `session.next.text.delta` (this session) → `sink.append(text)`
 *    - `session.next.tool.called` (this session) → cache call info
 *    - `session.next.tool.success` (this session) → append progress line to sink
 *    - `permission.asked` (this session, coordinator present) → fire-and-continue
 *    - `permission.replied` (this session, coordinator present) → settle
 *    - `session.idle` for this session → resolve
 *    - `session.error` for this session → throw `RunCoreError('session-error')`
 * 5. Caller calls `sink.flush()` after this resolves.
 *
 * @throws {RunCoreError} on unreachable server, 401 auth rejection,
 *   session error, or prompt rejection.
 */
export async function runOpenCodeCore(params: RunCoreParams): Promise<void> {
  const {handle, directory, promptText, sink, signal, logger, coordinator} = params
  const {client} = handle

  // ── 1. Create session ──────────────────────────────────────────────────────
  let sessionId: string
  try {
    const sessionResponse = await client.session.create({query: {directory}})
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

  // ── 2. Subscribe to events — directory threaded to query (SSE-routing) ─────
  // Subscribe BEFORE prompt to eliminate the race where permission.asked fires
  // before the SSE listener exists.
  let eventStream: AsyncIterable<unknown>
  try {
    const eventsResult = await client.event.subscribe({query: {directory}})
    eventStream = eventsResult.stream as AsyncIterable<unknown>
    logger.info({sessionId, directory}, 'run-core: event stream subscribed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error({sessionId, detail: message}, 'run-core: event.subscribe threw')
    throw new RunCoreError('unreachable', `Event subscribe threw: ${message}`)
  }

  // ── 3. Send prompt — directory threaded to query ───────────────────────────
  try {
    const promptResponse = await client.session.promptAsync({
      path: {id: sessionId},
      body: {parts: [{type: 'text', text: promptText}]},
      query: {directory},
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
  } catch (error) {
    if (error instanceof RunCoreError) throw error
    const message = error instanceof Error ? error.message : String(error)
    logger.error({sessionId, detail: message}, 'run-core: promptAsync threw (server unreachable?)')
    throw new RunCoreError('unreachable', `PromptAsync threw: ${message}`)
  }

  // ── 4. Consume event stream ────────────────────────────────────────────────
  // V2 sync tool lifecycle: correlate called→success by callID.
  const pendingToolCalls = new Map<string, ToolCallInfo>()

  for await (const rawEvent of eventStream) {
    if (signal.aborted) break

    const eventType = getEventKind(rawEvent)
    const eventPayload = getEventPayload(rawEvent)

    if (eventType === 'message.part.delta') {
      // New SDK shape: streaming text delta events.
      // delta may be {type:'text', text:string} or a plain string when field === 'text'.
      const eventSessionID = getEventSessionID(rawEvent)
      if (eventSessionID === sessionId) {
        const delta = getObjectProperty(eventPayload, 'delta')
        const deltaType = getStringProperty(delta, 'type')
        const deltaText = getStringProperty(delta, 'text')
        if (deltaType === 'text' && deltaText != null) {
          sink.append(deltaText)
        } else if (typeof delta === 'string' && getStringProperty(eventPayload, 'field') === 'text') {
          sink.append(delta)
        }
      }
    } else if (eventType === 'session.next.text.delta') {
      // Sync/session.next shape: delta is a plain string or {type:'text', text:string}.
      const eventSessionID = getEventSessionID(rawEvent)
      if (eventSessionID === sessionId) {
        const deltaRaw = getObjectProperty(eventPayload, 'delta')
        const deltaText = typeof deltaRaw === 'string' ? deltaRaw : (getStringProperty(deltaRaw, 'text') ?? null)
        if (deltaText != null) sink.append(deltaText)
      }
    } else if (eventType === 'message.part.updated') {
      // OpenCode 1.15.13 contract: tool lifecycle arrives via message.part.updated
      // (partType:'tool', state.status:'completed'). session.next.tool.called/success
      // no longer fire on 1.15.13 — this branch handles the new contract.
      const part = getObjectProperty(eventPayload, 'part')
      const eventSessionID = getSessionID(eventPayload) ?? getSessionID(part)
      if (eventSessionID === sessionId) {
        const partType = getStringProperty(part, 'type')
        if (partType === 'tool') {
          // ONLY handle tool parts — text parts are streamed via message.part.delta.
          const toolState = getObjectProperty(part, 'state')
          if (getStringProperty(toolState, 'status') === 'completed') {
            const tool = getStringProperty(part, 'tool') ?? ''
            // Title resolution: state.title → input.title → bash command/cmd → tool name.
            const stateTitle = getStringProperty(toolState, 'title')
            const stateInput = getObjectProperty(toolState, 'input')
            const title =
              stateTitle ??
              getStringProperty(stateInput, 'title') ??
              (tool.toLowerCase() === 'bash'
                ? String(getObjectProperty(stateInput, 'command') ?? getObjectProperty(stateInput, 'cmd') ?? tool)
                : tool)
            logger.debug({tool, title}, 'run-core: tool completed (message.part.updated)')
            sink.append(`\n🔧 ${tool}: ${title}\n`)
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
            const title =
              getStringProperty(structured, 'title') ??
              getStringProperty(input, 'title') ??
              (tool.toLowerCase() === 'bash'
                ? String(getObjectProperty(input, 'command') ?? getObjectProperty(input, 'cmd') ?? tool)
                : tool)
            logger.debug({callID, tool, title}, 'run-core: tool success')
            sink.append(`\n🔧 ${tool}: ${title}\n`)
          }
        }
      }
    } else if (eventType === 'permission.asked') {
      // Permission gate — only act when coordinator is wired in.
      if (coordinator !== undefined) {
        const eventSessionID = getEventSessionID(rawEvent)
        if (eventSessionID === sessionId) {
          const req = parsePermissionRequest(eventPayload)
          if (req === null) {
            logger.warn({eventType}, 'run-core: permission.asked payload malformed — skipping')
          } else {
            // Fire-and-continue: do NOT await — awaiting would starve the SSE drain.
            // eslint-disable-next-line no-void
            void coordinator.onPermissionAsked(req)
            logger.info({requestID: req.requestID}, 'run-core: permission.asked forwarded to coordinator')
          }
        }
      }
    } else if (eventType === 'permission.replied') {
      // Authoritative settlement — only act when coordinator is wired in.
      if (coordinator !== undefined) {
        const eventSessionID = getEventSessionID(rawEvent)
        if (eventSessionID === sessionId) {
          const ev = parsePermissionReply(eventPayload)
          if (ev === null) {
            logger.warn({eventType}, 'run-core: permission.replied payload malformed — skipping')
          } else {
            coordinator.onPermissionReplied(ev)
            logger.info(
              {requestID: ev.requestID, reply: ev.reply},
              'run-core: permission.replied forwarded to coordinator',
            )
          }
        }
      }
    } else if (eventType === 'session.idle') {
      const eventSessionID = getEventSessionID(rawEvent)
      if (eventSessionID === sessionId) {
        logger.info({sessionId}, 'run-core: session.idle received — stream complete')
        return
      }
    } else if (eventType === 'session.error') {
      const eventSessionID = getEventSessionID(rawEvent)
      if (eventSessionID === null || eventSessionID === sessionId) {
        const errorDetail = getStringProperty(eventPayload, 'error') ?? 'unknown session error'
        logger.error({sessionId, detail: errorDetail}, 'run-core: session.error received')
        throw new RunCoreError('session-error', `Session error: ${errorDetail}`)
      }
    }
  }

  // Stream exhausted. Distinguish timeout (signal aborted) from premature close.
  if (signal.aborted === true) {
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
