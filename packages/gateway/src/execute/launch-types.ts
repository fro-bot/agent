/**
 * Transport-neutral types for the `launchWork` execution engine.
 *
 * Design contract: `LaunchWorkRequest` carries everything the engine needs to execute a unit of
 * work without knowing the transport. The Discord adapter (`runMention`) maps a
 * Discord `Message` → `LaunchWorkRequest`, constructs concrete `StatusSink` and
 * `ReplySink` implementations over the existing Discord live-status/typing flow,
 * and calls `launchWork`. A future web adapter will do the same with SSE or
 * WebSocket implementations.
 *
 * Sink contract:
 *   - `StatusSink` — the engine calls these methods to manage the working-state UX
 *     (typing indicator, status message, source-message reactions). The Discord
 *     adapter implements this by adapting `createStatusController` from
 *     `discord/status-message.ts` and `setRunReaction` from `discord/reactions.ts`.
 *     Do NOT reimplement `statusMode` logic — wrap the existing controller.
 *   - `ReplySink` — the engine calls these methods to deliver output and ephemeral
 *     acks. The Discord adapter implements this over `createDiscordStreamSink` (for
 *     streaming output) and `sendMessage`/`io.ts` (for acks). The `send` method
 *     accepts `MessageContentOptions` from `discord/io.ts` so the Discord
 *     implementation needs no cast at the call site.
 *
 * Adding a new transport: implement `StatusSink` and `ReplySink` for the new
 * surface, construct a `LaunchWorkRequest` with a `RequesterIdentity` discriminated
 * on `kind: 'web-operator'` (or a new variant), and call `launchWork`. The engine,
 * queue, concurrency cap, lock, run-state, and approval registry are all
 * transport-agnostic.
 */

import type {Surface} from '@fro-bot/runtime'

import type {PermissionReply, PermissionRequest} from '../approvals/coordinator.js'
import type {ApprovalRegistry} from '../approvals/registry.js'
import type {RepoBinding} from '../bindings/types.js'
import type {MessageContentOptions} from '../discord/io.js'
import type {TransitionResult} from '../discord/status-message.js'
import type {OperatorIdentity} from '../operator-contract/identity.js'

// ---------------------------------------------------------------------------
// RequesterIdentity — discriminated union for transport-neutral caller identity
// ---------------------------------------------------------------------------

/**
 * A Discord user who triggered the run via a mention.
 * `userId` is the Discord snowflake ID of the requester.
 */
export interface DiscordRequesterIdentity {
  readonly kind: 'discord-user'
  readonly userId: string
}

/**
 * A web operator who triggered the run via the control surface.
 *
 * Type alias for the canonical {@link OperatorIdentity} defined in the
 * operator-contract module. The structural shape is declared exactly once
 * there; this alias keeps the existing export path valid for all consumers.
 */
export type WebOperatorIdentity = OperatorIdentity

/**
 * Transport-neutral requester identity.
 *
 * Discriminated on `kind` so callers can narrow without `as` casts:
 * ```ts
 * if (request.requester.kind === 'discord-user') {
 *   // request.requester.userId is available here
 * }
 * ```
 */
export type RequesterIdentity = DiscordRequesterIdentity | WebOperatorIdentity

// ---------------------------------------------------------------------------
// RunReactionState — transport-neutral reaction lifecycle
// ---------------------------------------------------------------------------

/**
 * The four states the engine transitions the source-message reaction through.
 * Maps to the four `setRunReaction` calls in `run.ts` (`:370`, `:465`, `:574`, `:635`).
 *
 * The Discord adapter maps these to emoji reactions; a future transport may map
 * them to status badges, SSE events, or no-ops.
 */
export type RunReactionState = 'working' | 'awaiting-approval' | 'succeeded' | 'failed'

// ---------------------------------------------------------------------------
// StatusSink — transport-neutral working-state UX
// ---------------------------------------------------------------------------

/**
 * Transport-neutral interface for the engine's working-state UX.
 *
 * The engine calls these methods to manage the typing indicator, status message,
 * and source-message reaction lifecycle. The Discord adapter implements this by
 * wrapping `createStatusController` (from `discord/status-message.ts`) and
 * `setRunReaction` (from `discord/reactions.ts`).
 *
 * ## Discord adapter pattern
 *
 * ```ts
 * // In the Discord adapter:
 * const statusController = createStatusController({ thread, mode: statusMode, logger })
 * const statusSink: StatusSink = {
 *   noteActivity: summary => statusController.noteActivity(summary),
 *   setBusy: busy => statusController.setBusy(busy),
 *   resolveToAnswer: text => statusController.resolveToAnswer(text),
 *   resolveToFailure: note => statusController.resolveToFailure(note),
 *   dispose: () => statusController.dispose(),
 *   setReaction: state => setRunReaction(message, state, logger),
 * }
 * ```
 *
 * ## Web transport implementers
 *
 * A web transport may implement `noteActivity` as an SSE push, `setBusy` as a
 * WebSocket heartbeat, and `setReaction` as a no-op or a status-badge update.
 * The engine does not care — it only calls these methods.
 */
export interface StatusSink {
  /**
   * Record an essential-action summary and schedule a debounced status update.
   * In `typing-only` mode (Discord), this is a no-op — the adapter decides.
   * No-ops once a terminal transition has begun.
   *
   * Maps to `statusController.noteActivity(summary)` in the Discord adapter.
   * Called by the engine's `onActivity` callback (`:558-560` in `run.ts`).
   */
  readonly noteActivity: (summary: string) => void

  /**
   * Start or stop the typing/busy indicator.
   * - `true`: start pulsing (immediately and on a recurring interval).
   * - `false`: stop pulsing (e.g. during an approval wait).
   *
   * Maps to `statusController.setBusy(busy)` in the Discord adapter.
   * Called by the engine's `onBusy` callback (`:561-563` in `run.ts`).
   */
  readonly setBusy: (busy: boolean) => void

  /**
   * Settle, then resolve the status surface into the final answer.
   * - `'handled'`: the sink delivered the answer in-place (e.g. edited the status
   *   message); the engine must NOT flush the reply sink.
   * - `'delegated'`: the sink could not deliver in-place; the engine must flush
   *   the reply sink to deliver the answer.
   *
   * Maps to `statusController.resolveToAnswer(text)` in the Discord adapter.
   * Called by the engine after `runOpenCodeCore` succeeds (`:608` in `run.ts`).
   */
  readonly resolveToAnswer: (text: string) => Promise<TransitionResult>

  /**
   * Settle, then resolve the status surface into a failure note.
   * - `'handled'`: the sink delivered the failure note in-place.
   * - `'delegated'`: the engine must post the failure note via `replySink.send`.
   *
   * Maps to `statusController.resolveToFailure(note)` in the Discord adapter.
   * Called by the engine in the error path (`:696` in `run.ts`).
   */
  readonly resolveToFailure: (note: string) => Promise<TransitionResult>

  /**
   * Settle and clear all timers. Idempotent. Must be called in the run's
   * `finally` block to guarantee no timer leaks.
   *
   * Maps to `statusController.dispose()` in the Discord adapter.
   * Called by the engine's inner `finally` (`:716` in `run.ts`).
   */
  readonly dispose: () => Promise<void>

  /**
   * Transition the source-message reaction to reflect the current run state.
   * Best-effort, fire-and-forget — failures must not abort the run.
   *
   * Maps to `setRunReaction(message, state, logger)` in the Discord adapter.
   * Called at four points in the engine:
   * - `'working'`          after EXECUTING transition (`:370`)
   * - `'awaiting-approval'` when an approval is pending (`:465`)
   * - `'succeeded'`        after `runOpenCodeCore` completes (`:574`)
   * - `'failed'`           in the error path (`:635`)
   */
  readonly setReaction: (state: RunReactionState) => void
}

// ---------------------------------------------------------------------------
// ReplySink — transport-neutral output + ack delivery
// ---------------------------------------------------------------------------

/**
 * Transport-neutral interface for delivering run output and ephemeral acks.
 *
 * The engine uses two delivery modes:
 * 1. **Streaming output** — `append`/`flush`/`buffered` for the agent's text
 *    output (maps to `DiscordStreamSink` from `discord/streaming.ts`).
 * 2. **Acks and failure notes** — `send` for pre-thread and post-thread
 *    ephemeral messages (maps to `sendMessage` from `discord/io.ts`).
 *
 * ## Discord adapter pattern
 *
 * ```ts
 * // In the Discord adapter:
 * const streamSink = createDiscordStreamSink(thread, { logger })
 * const replySink: ReplySink = {
 *   // Streaming output — delegate to DiscordStreamSink
 *   append: text => streamSink.append(text),
 *   flush: () => streamSink.flush(),
 *   buffered: () => streamSink.buffered(),
 *   hasVisibleOutput: () => streamSink.hasVisibleOutput(),
 *   markVisibleOutputSent: () => streamSink.markVisibleOutputSent(),
 *   markVisibleOutputPending: () => streamSink.markVisibleOutputPending(),
 *   // Acks — delegate to sendMessage (pre-thread: message; post-thread: thread)
 *   send: (target, options) => sendMessage(target, options, logger),
 * }
 * ```
 *
 * ## Web transport implementers
 *
 * A web transport may implement `append`/`flush` as SSE pushes, `buffered` as
 * an in-memory accumulator, and `send` as an HTTP response write. The engine
 * does not care — it only calls these methods.
 */
export interface ReplySink {
  // ── Streaming output (maps to DiscordStreamSink) ──────────────────────────

  /**
   * Append a text delta to the internal buffer.
   * Called on each text event from the OpenCode event stream.
   *
   * Maps to `sink.append(text)` in the Discord adapter.
   */
  readonly append: (text: string) => void

  /**
   * Flush the current buffer to the transport.
   * - Short text: single delivery.
   * - Long text: summary + attachment (Discord) or chunked (web).
   * - Empty/whitespace with no prior visible output: "no output" placeholder.
   * - Empty/whitespace with prior visible output: no-op (`skipped-visible`).
   *
   * Maps to `sink.flush()` in the Discord adapter.
   * Called after `runOpenCodeCore` completes (`:610` in `run.ts`).
   */
  readonly flush: () => Promise<unknown>

  /**
   * Read the current buffered text without flushing.
   * Used by the engine to pass the buffered text to `statusSink.resolveToAnswer`
   * before deciding whether to flush (`:607` in `run.ts`).
   */
  readonly buffered: () => string

  /**
   * Returns `true` if visible output has been delivered — either via a successful
   * flush, via `markVisibleOutputSent`, or via a pending out-of-band send.
   * Used by the engine to classify timeout messages (`:677` in `run.ts`).
   */
  readonly hasVisibleOutput: () => boolean

  /**
   * Mark that visible output has already been delivered outside the buffer
   * (e.g. an approval waiting status). When set, `flush()` will NOT post a
   * "no output" placeholder for an empty buffer.
   *
   * Maps to `sink.markVisibleOutputSent()` in the Discord adapter.
   */
  readonly markVisibleOutputSent: () => void

  /**
   * Mark an out-of-band visible send as in-flight. Returns a one-shot settle
   * handle: `settle(true)` promotes to permanently delivered; `settle(false)`
   * retracts the pending claim.
   *
   * Maps to `sink.markVisibleOutputPending()` in the Discord adapter.
   * Used in the approval `onPending` closure (`:476`, `:493` in `run.ts`).
   */
  readonly markVisibleOutputPending: () => (delivered: boolean) => void

  // ── Acks and failure notes (maps to sendMessage via io.ts) ────────────────

  /**
   * Send an ephemeral ack or failure note to the transport.
   *
   * Accepts `MessageContentOptions` from `discord/io.ts` so the Discord
   * implementation (`sendMessage`) is structurally assignable without a cast.
   * A web implementation may map `content` to an HTTP response body or SSE event.
   *
   * Used for:
   * - Pre-thread acks on the source message (clone fail, not-ready, cap, queued)
   *   — `:229`, `:252`, `:264`, `:793-803`, `:822` in `run.ts`
   * - Post-thread acks on the thread (lock held, createRun fail, transition fail,
   *   failure note when `resolveToFailure` delegates) — `:277`, `:284`, `:313`,
   *   `:331`, `:701` in `run.ts`
   * - Approval waiting status and deadline timeout — `:451`, `:478` in `run.ts`
   *
   * The Discord adapter routes pre-thread sends to `sendMessage(message, ...)` and
   * post-thread sends to `sendMessage(thread, ...)`. The engine passes a
   * `ReplySinkTarget` discriminant so the adapter can route correctly.
   */
  readonly send: (target: ReplySinkTarget, options: MessageContentOptions) => Promise<unknown>
}

// ---------------------------------------------------------------------------
// ReplySinkTarget — routing discriminant for send()
// ---------------------------------------------------------------------------

/**
 * Routing discriminant passed to `ReplySink.send` so the adapter can route
 * pre-thread sends (to the source message) vs post-thread sends (to the thread).
 *
 * The Discord adapter maps:
 * - `'source'` → `sendMessage(message, options, logger)` (reply to the original mention)
 * - `'thread'` → `sendMessage(thread, options, logger)` (send to the run thread)
 *
 * A web adapter may ignore this discriminant if it has a single delivery channel,
 * or map it to different SSE event types.
 */
export type ReplySinkTarget = 'source' | 'thread'

// ---------------------------------------------------------------------------
// LaunchAdmission — result returned by launchWork
// ---------------------------------------------------------------------------

/**
 * Result returned by `launchWork` after the admission decision is made.
 *
 * `launchWork` returns as soon as the run is admitted (or rejected) — it does
 * NOT await the run itself. The gateway in-flight set owns the immediate-path
 * promise; graceful shutdown drains it.
 *
 * - `{accepted: true, runId}` — run was admitted (immediate or queued); the
 *   caller can use `runId` to poll the SSE observation pipeline.
 *   - `runPromise` (immediate path only): the in-flight run promise. Present
 *     when the run was started immediately (not queued). Callers that need to
 *     await the full run (e.g. the Discord adapter for backward compatibility)
 *     can await this promise. The web launch route ignores it and returns 202.
 * - `{accepted: false, reason}` — run was rejected before admission; no
 *   `RunState` was created, no `runId` to poll.
 *   - `'cap'`          — global concurrency cap reached; no slot AND queue full.
 *   - `'empty-prompt'` — prompt was empty; rejected before any queue/cap work.
 */
export type LaunchAdmission =
  | {readonly accepted: true; readonly runId: string; readonly runPromise?: Promise<void>}
  | {readonly accepted: false; readonly reason: 'cap' | 'empty-prompt'}

// ---------------------------------------------------------------------------
// LaunchWorkRequest — transport-neutral engine input
// ---------------------------------------------------------------------------

/**
 * Transport-neutral input to the `launchWork` execution engine.
 *
 * Carries everything the engine needs to execute a unit of work without
 * knowing the transport. The Discord adapter (`runMention`) constructs this
 * from a Discord `Message`; a future web adapter constructs it from an
 * authenticated HTTP request.
 *
 * ## Field derivation from Discord Message reads
 *
 * | `Message` read in `run.ts`                        | → `LaunchWorkRequest` field      |
 * |---------------------------------------------------|----------------------------------|
 * | `message.channel.id` (`:205`, `:807`)             | `channelId`                      |
 * | `message.content` (`:376-382`)                    | `promptText`                     |
 * | `surface: 'discord'` (`:273`, `:300`)             | `surface`                        |
 * | `sendMessage(message, ...)` pre-thread acks       | `replySink.send('source', ...)`  |
 * | `message.startThread(...)` (`:259-268`)           | `statusSink` (adapter creates thread, passes it to status controller) |
 * | `setRunReaction(message, ...)` (`:370`, `:465`, `:574`, `:635`) | `statusSink.setReaction(state)` |
 * | `createStatusController({thread, mode})` (`:347`) | `statusSink` (wraps controller)  |
 * | `createDiscordStreamSink(thread)` (`:375`)        | `replySink` (wraps stream sink)  |
 * | `sendMessage(thread, ...)` post-thread acks       | `replySink.send('thread', ...)`  |
 *
 * ## Usage
 *
 * ```ts
 * // Discord adapter:
 * const request: LaunchWorkRequest = {
 *   promptText: stripMention(message.content, deps.botUserId),
 *   channelId: message.channel.id,
 *   guildId: message.guild?.id,
 *   surface: 'discord',
 *   binding,
 *   requester: { kind: 'discord-user', userId: message.author.id },
 *   statusSink,   // wraps createStatusController + setRunReaction
 *   replySink,    // wraps createDiscordStreamSink + sendMessage
 * }
 * await launchWork(request, deps)
 * ```
 */
export interface LaunchWorkRequest {
  /**
   * The prompt text to send to the agent.
   *
   * Must be a fully-stripped, non-empty string. The Discord adapter strips the
   * bot mention via `botUserId` and fails fast on an empty result BEFORE calling
   * `launchWork`. The engine also validates at the front door. Neither re-strips
   * nor re-validates the prompt text beyond the empty check.
   *
   * Derived from `message.content` (`:376-382` in `run.ts`).
   */
  readonly promptText: string

  /**
   * Optional caller-supplied run ID.
   *
   * When present, the engine uses this value instead of generating its own
   * `crypto.randomUUID()`. This allows the launch route to own the runId
   * before work starts — registering a PENDING run-index entry and returning
   * 202 {runId} immediately (fire-and-return).
   *
   * When absent (the default for Discord), the engine generates its own UUID
   * as before — Discord behavior is unchanged.
   *
   * The caller is responsible for generating a valid UUID (e.g. `crypto.randomUUID()`).
   */
  readonly runId?: string

  /**
   * Optional injectable prompt builder.
   *
   * When present, the engine calls this function instead of `buildDiscordPrompt`
   * to construct the prompt text passed to OpenCode. This allows a web launch
   * to omit Discord-thread/persona framing (DISCORD_MECHANICAL_GUIDANCE) that
   * is inappropriate for a web-launched run.
   *
   * When absent (the default for Discord), `buildDiscordPrompt` is used exactly
   * as today — Discord behavior is unchanged.
   *
   * The builder receives the raw prompt text, owner, and repo. It must return
   * a non-empty string. The engine does not validate the returned string beyond
   * the existing empty-prompt check at the front door.
   */
  readonly promptBuilder?: (args: {
    readonly messageText: string
    readonly owner: string
    readonly repo: string
  }) => string

  /**
   * Optional thread factory called by the engine after `ensureClone` and `readyz`
   * pass, before lock acquisition.
   *
   * The Discord adapter provides this to create the response thread at the right
   * point in the pipeline (after gates pass, before lock). The factory creates the
   * Discord thread, initializes the real `StatusSink`/`ReplySink` implementations
   * (replacing any deferred proxies), and returns the thread ID for run-state.
   *
   * When absent (e.g. in-memory sink tests or future web transports that don't
   * need a thread), the engine uses an empty string as the thread ID in run-state.
   *
   * This is the seam that keeps thread creation in the adapter while letting the
   * engine trigger it at the correct pipeline stage. The engine never imports
   * Discord types — it only calls this opaque factory.
   *
   * Returns `{ok: true, threadId}` on success or `{ok: false, error}` on failure.
   * On failure the engine sends a coarse error via `replySink.send('source', ...)`
   * and aborts the run (same behavior as the current `startThread` error path).
   */
  readonly threadFactory?: () => Promise<
    {readonly ok: true; readonly threadId: string} | {readonly ok: false; readonly error: string}
  >

  /**
   * The channel ID scoping the per-channel FIFO queue and concurrency slot.
   *
   * Derived from `message.channel.id` (`:205`, `:807` in `run.ts`).
   */
  readonly channelId: string

  /**
   * The guild (server) ID, if available. Used for logging and source metadata.
   * `undefined` for DM channels or non-guild contexts.
   */
  readonly guildId: string | undefined

  /**
   * Transport-neutral surface identifier written into lock and run-state records.
   * Allows a web run to be recorded as `'web'` rather than `'discord'`.
   *
   * The Discord adapter passes `'discord'`; a web adapter passes `'web'`.
   * Now typed as `Surface` (which includes `'github' | 'discord' | 'web'`)
   * so callers get compile-time validation and the engine needs no cast.
   */
  readonly surface: Surface

  /**
   * The repo binding (owner, repo, channelId, workspacePath, …).
   * Carried unchanged from `RunTask.binding`.
   */
  readonly binding: RepoBinding

  /**
   * Transport-neutral requester identity.
   * Discriminated on `kind` — `'discord-user'` today; `'web-operator'` when a web surface is added.
   */
  readonly requester: RequesterIdentity

  /**
   * Working-state UX sink. The engine calls these methods to manage the typing
   * indicator, status message, and source-message reaction lifecycle.
   *
   * The Discord adapter implements this by wrapping `createStatusController` and
   * `setRunReaction`. See `StatusSink` for the full contract.
   */
  readonly statusSink: StatusSink

  /**
   * Output and ack delivery sink. The engine calls these methods to deliver
   * streaming output and ephemeral acks.
   *
   * The Discord adapter implements this by wrapping `createDiscordStreamSink` and
   * `sendMessage`. See `ReplySink` for the full contract.
   */
  readonly replySink: ReplySink

  /**
   * Optional factory for the transport-specific approval notification callback.
   *
   * When present, the engine calls this factory once — after `ensureClone`,
   * `readyz`, thread creation, lock acquisition, and run-state setup — passing
   * all engine-owned context the transport needs to register entries in the
   * approval registry, set deadlines, and wire reply routing. The factory
   * returns the `onPending` callback that the coordinator calls for each
   * permission request.
   *
   * When absent (the default), the engine uses the Discord approval transport
   * (`createDiscordApprovalOnPending`). Discord behavior is unchanged.
   *
   * A web transport provides this factory to push approval notifications to SSE
   * subscribers and register entries in the approval registry with a web scope
   * ID — without duplicating engine internals or using stale binding paths.
   *
   * The factory must not throw. The returned callback must not throw — the
   * coordinator wraps it defensively.
   *
   * @example
   * ```ts
   * // Web transport:
   * const request: LaunchWorkRequest = {
   *   // ...
   *   createApprovalOnPending: (ctx) => (req) => {
   *     ctx.approvalRegistry.register({
   *       requestID: req.requestID,
   *       sessionID: req.sessionID,
   *       approvalScopeId: ctx.runId,   // web scope: runId or session correlation ID
   *       directory: ctx.directory,
   *       request: req,
   *       effects: { postReply: ctx.postReplyFactory(req.sessionID) },
   *       deadlineMs: ctx.approvalDeadlineMs,
   *     })
   *     hub.notify({ runId: ctx.runId, repo: ctx.repo, request: req })
   *   },
   * }
   * ```
   */
  readonly createApprovalOnPending?: (context: ApprovalTransportContext) => (request: PermissionRequest) => void
}

// ---------------------------------------------------------------------------
// PostReplyFactory — transport-neutral factory for per-request SDK reply closures
// ---------------------------------------------------------------------------

/**
 * Factory for the per-request `postReply` function.
 *
 * The transport calls this once per `onPending` invocation to create a closure
 * that captures the per-request `sessionID`. The factory receives the
 * `sessionID` and returns a function that POSTs the decision to OpenCode.
 *
 * Defined here (in `launch-types.ts`) so `ApprovalTransportContext` can
 * reference it without creating a circular import with `discord-transport.ts`.
 * `discord-transport.ts` re-exports this type for backwards compatibility.
 */
export type PostReplyFactory = (
  sessionID: string,
) => (
  requestID: string,
  directory: string,
  decision: PermissionReply,
) => Promise<{readonly ok: boolean; readonly error?: string}>

// ---------------------------------------------------------------------------
// ApprovalTransportContext — engine-owned context passed to the approval factory
// ---------------------------------------------------------------------------

/**
 * Engine-owned context passed to `LaunchWorkRequest.createApprovalOnPending`.
 *
 * Contains everything a transport needs to register approval entries in the
 * shared registry, set deadlines, and wire reply routing — without duplicating
 * engine internals or using stale binding paths.
 *
 * All fields are set by the engine at the point it has canonical directory,
 * deadline, runId/repo, registry, and postReply factory available (after
 * `ensureClone`, `readyz`, thread creation, lock acquisition, and run-state
 * setup).
 *
 * ## Field ownership
 *
 * - `approvalRegistry` — program-scoped registry; the trust anchor for
 *   fail-closed settlement. The transport calls `register()` here.
 * - `directory` — canonical workspace path from `ensureClone` (not the
 *   potentially stale `binding.workspacePath`). Use this for reply routing.
 * - `approvalDeadlineMs` — per-approval deadline aligned with the run budget.
 *   Pass to `registry.register({ deadlineMs })`.
 * - `runId` — stable UUID for this run. Use as `approvalScopeId` for web
 *   transports (or derive a scope token from it).
 * - `repo` — `owner/repo` string for audit, logging, and correlation.
 * - `replySink` — the run's reply sink. Available if the transport wants to
 *   post a waiting-status message (Discord does; a web transport may use its
 *   own channel instead).
 * - `postReplyFactory` — factory for the per-request `postReply` closure.
 *   Call `postReplyFactory(sessionID)` once per `onPending` invocation to
 *   create the closure that POSTs the decision to OpenCode.
 */
export interface ApprovalTransportContext {
  /** Program-scoped approval registry. The transport calls `register()` here. */
  readonly approvalRegistry: ApprovalRegistry
  /**
   * Canonical workspace directory from `ensureClone`.
   * Use for `registry.register({ directory })` and reply routing.
   */
  readonly directory: string
  /**
   * Per-approval deadline in milliseconds, aligned with the run budget.
   * Pass to `registry.register({ deadlineMs })`.
   * `undefined` when no deadline is configured.
   */
  readonly approvalDeadlineMs: number | undefined
  /**
   * Stable UUID for this run.
   * Use as `approvalScopeId` for web transports (or derive a scope token).
   */
  readonly runId: string
  /**
   * `owner/repo` string for audit, logging, and correlation.
   */
  readonly repo: string
  /**
   * The run's reply sink. Available if the transport wants to post a
   * waiting-status message. Discord uses this; a web transport may use
   * its own notification channel instead.
   */
  readonly replySink: ReplySink
  /**
   * Factory for the per-request `postReply` closure.
   * Call `postReplyFactory(sessionID)` once per `onPending` invocation.
   * The returned function POSTs the decision to OpenCode's reply endpoint.
   */
  readonly postReplyFactory: PostReplyFactory
}
