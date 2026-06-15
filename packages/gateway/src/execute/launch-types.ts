/**
 * Transport-neutral types for the `launchWork` execution engine.
 *
 * ## Design contract
 *
 * `LaunchWorkRequest` carries everything the engine needs to execute a unit of
 * work without knowing the transport. The Discord adapter (`runMention`) maps a
 * Discord `Message` → `LaunchWorkRequest`, constructs concrete `StatusSink` and
 * `ReplySink` implementations over the existing Discord live-status/typing flow,
 * and calls `launchWork`. A future web adapter will do the same with SSE or
 * WebSocket implementations.
 *
 * ## Sink contract
 *
 * - `StatusSink` — the engine calls these methods to manage the working-state UX
 *   (typing indicator, status message, source-message reactions). The Discord
 *   adapter implements this by adapting `createStatusController` from
 *   `discord/status-message.ts` and `setRunReaction` from `discord/reactions.ts`.
 *   Do NOT reimplement `statusMode` logic — wrap the existing controller.
 *
 * - `ReplySink` — the engine calls these methods to deliver output and ephemeral
 *   acks. The Discord adapter implements this over `createDiscordStreamSink` (for
 *   streaming output) and `sendMessage`/`io.ts` (for acks). The `send` method
 *   accepts `MessageContentOptions` from `discord/io.ts` so the Discord
 *   implementation needs no cast at the call site.
 *
 * ## Adding a new transport
 *
 * To add a new transport:
 * 1. Implement `StatusSink` (typing/progress/reaction equivalents for your transport).
 * 2. Implement `ReplySink` (streaming output + ack delivery for your transport).
 * 3. Construct a `LaunchWorkRequest` with a `RequesterIdentity` discriminated on
 *    `kind: 'web-operator'` (or a new variant) and call `launchWork`.
 * 4. The engine, queue, concurrency cap, lock, run-state, and approval registry
 *    are all transport-agnostic — you get them for free.
 */

import type {RepoBinding} from '../bindings/types.js'
import type {MessageContentOptions} from '../discord/io.js'
import type {TransitionResult} from '../discord/status-message.js'

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
 * A future web operator who triggered the run via the control surface.
 * Shape is intentionally minimal — extend with session/auth fields when a web surface is added.
 */
export interface WebOperatorIdentity {
  readonly kind: 'web-operator'
  /** Stable operator identifier (e.g. GitHub login or internal operator ID). */
  readonly operatorId: string
}

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
   * Allows a future web run to be recorded as `'web'` rather than `'discord'`.
   *
   * The Discord adapter passes `'discord'`; a web adapter passes `'web'`.
   * surface is a string for transport-neutrality; runtime Surface is currently
   * 'github'|'discord' — widen when a web surface is added.
   */
  readonly surface: string

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
}
