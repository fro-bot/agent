/**
 * Discord streaming sink — takes accumulated agent text and flushes it into a
 * Discord thread with `allowedMentions: {parse: []}` on every send path.
 *
 * Behavior:
 * - Flush on demand: the caller drives when to flush (`session.idle` is the primary trigger).
 * - Long-response fallback: if text exceeds 2000 chars, post a summary line + `.md` attachment.
 * - Empty/whitespace output: post a clear "no output" message, not an empty send.
 * - Every send — stream text, `.md` fallback, error messages — hardcodes `allowedMentions:{parse:[]}`.
 * - All sends go to the thread; never to the parent channel.
 */

import type {MessageMentionTypes} from 'discord.js'
import type {GatewayLogger} from './client.js'

import {Buffer} from 'node:buffer'
import {AttachmentBuilder} from 'discord.js'

import {MAX_DISCORD_MESSAGE_LENGTH} from './constants.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discord's hard content-length limit for a single message. */
const DISCORD_MESSAGE_CHAR_LIMIT = MAX_DISCORD_MESSAGE_LENGTH

/** Fallback message shown when a flush yields nothing. */
const EMPTY_OUTPUT_MESSAGE = '_(no output)_'

/** Summary line shown before the `.md` attachment fallback. */
const LONG_OUTPUT_SUMMARY = '_(response too long — full output attached as a file)_'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal thread interface required by the sink. Typed narrowly so test doubles
 * don't need to implement the full `ThreadChannel` API.
 */
export interface SinkThread {
  readonly send: (options: SendOptions) => Promise<unknown>
}

/** Message payload shape passed to `thread.send`. */
interface SendOptions {
  readonly content?: string
  readonly files?: AttachmentBuilder[]
  readonly allowedMentions: {readonly parse: readonly MessageMentionTypes[]}
}

/** Discriminated result of a flush attempt. */
export type FlushResult =
  | {readonly kind: 'sent'; readonly charCount: number}
  | {readonly kind: 'attachment'; readonly charCount: number}
  | {readonly kind: 'empty'}
  | {readonly kind: 'skipped-visible'}
  | {readonly kind: 'error'; readonly message: string}

/** Dependencies injected into the sink factory. */
export interface StreamSinkDeps {
  readonly logger?: GatewayLogger
}

// ---------------------------------------------------------------------------
// Internal helper — ALL Discord sends route through here
// ---------------------------------------------------------------------------

/**
 * The SINGLE send helper that enforces `allowedMentions: {parse: []}` on
 * every Discord write. No code in this module calls `thread.send` directly.
 *
 * Invariant: agent or interpolated text can NEVER ping `@everyone`, roles, or
 * users. Asserted at every call site in tests.
 */
async function safeSend(thread: SinkThread, options: Omit<SendOptions, 'allowedMentions'>): Promise<void> {
  await thread.send({
    ...options,
    allowedMentions: {parse: []},
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A `DiscordStreamSink` accumulates agent text deltas and flushes them to
 * a Discord thread on demand.
 *
 * Usage:
 * ```ts
 * const sink = createDiscordStreamSink(thread, deps)
 * sink.append(textDelta)          // called on each text event
 * const result = await sink.flush() // called on session.idle
 * ```
 */
export interface DiscordStreamSink {
  /** Append a text delta to the internal buffer. */
  readonly append: (text: string) => void
  /**
   * Flush the current buffer to the Discord thread.
   * - Short text (≤2000 chars): single message send.
   * - Long text (>2000 chars): summary line + `.md` attachment.
   * - Empty/whitespace AND no visible output already sent: "no output" message.
   * - Empty/whitespace AND visible output already sent (e.g. approval status): `{kind:'skipped-visible'}`, no send.
   * - On `thread.send` rejection: returns `{kind:'error'}` (does not throw).
   */
  readonly flush: () => Promise<FlushResult>
  /** Read the current buffered text without flushing. */
  readonly buffered: () => string
  /**
   * Mark that visible output has already been sent to the thread outside the
   * buffer (e.g. an approval waiting status). When set, `flush()` will NOT
   * post `_(no output)_` for an empty buffer — it returns `{kind:'skipped-visible'}`.
   *
   * Has no effect when the buffer contains non-whitespace text (text always flushes normally).
   */
  readonly markVisibleOutputSent: () => void
  /**
   * Marks an out-of-band visible send as in-flight so timeout/error
   * classification treats it as visible context while the Discord send is
   * pending. Returns a one-shot settle handle:
   * - `settle(true)` — send succeeded; promotes to permanently delivered
   *   (same effect as `markVisibleOutputSent()`).
   * - `settle(false)` — send failed; retracts the pending claim without
   *   marking delivered.
   * The handle is one-shot: calling it a second time is a no-op (guards
   * against double-decrement and prevents a late `settle(true)` from
   * overriding an earlier `settle(false)`).
   */
  readonly markVisibleOutputPending: () => (delivered: boolean) => void
  /**
   * Returns `true` if visible output has been sent to the thread — either via
   * `markVisibleOutputSent()`, via a successful flush of buffered text, or via
   * a pending out-of-band send that has not yet settled.
   * Read-only; never resets once permanently set.
   *
   * Use this to decide whether a timeout or error message should acknowledge
   * partial output rather than treating the run as having produced nothing.
   */
  readonly hasVisibleOutput: () => boolean
}

/**
 * Create a `DiscordStreamSink` bound to `thread`.
 *
 * All sends are routed through `safeSend`, which hardcodes
 * `allowedMentions: {parse: []}`.
 */
export function createDiscordStreamSink(thread: SinkThread, deps: StreamSinkDeps = {}): DiscordStreamSink {
  const {logger} = deps
  let buffer = ''
  let visibleOutputSent = false
  let pendingVisibleOutput = 0

  const append = (text: string): void => {
    buffer += text
  }

  const buffered = (): string => buffer

  const markVisibleOutputSent = (): void => {
    visibleOutputSent = true
  }

  const markVisibleOutputPending = (): ((delivered: boolean) => void) => {
    pendingVisibleOutput += 1
    let settled = false
    return (delivered: boolean): void => {
      if (settled === true) {
        return
      }
      settled = true
      pendingVisibleOutput -= 1
      if (delivered === true) {
        visibleOutputSent = true
      }
    }
  }

  const hasVisibleOutput = (): boolean => visibleOutputSent === true || pendingVisibleOutput > 0

  const flush = async (): Promise<FlushResult> => {
    const text = buffer

    // Empty / whitespace — check if visible output was already sent outside the buffer
    if (text.trim().length === 0) {
      // Visible output already delivered OR an out-of-band send is still in-flight (pending).
      // A pending send that later fails will retract via settle(false) for future reads, but
      // suppressing _(no output)_ here avoids a contradictory "(no output) + updates above"
      // pair in the timeout race where flush() runs before classification reads hasVisibleOutput().
      if (visibleOutputSent === true || pendingVisibleOutput > 0) {
        return {kind: 'skipped-visible'}
      }
      // Genuinely empty run → post the "no output" fallback
      try {
        await safeSend(thread, {content: EMPTY_OUTPUT_MESSAGE})
        return {kind: 'empty'}
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : String(sendError)
        logger?.warn({err: message}, 'streaming sink: empty-output send failed')
        return {kind: 'error', message}
      }
    }

    // Long output → summary line + .md attachment fallback
    if (text.length > DISCORD_MESSAGE_CHAR_LIMIT) {
      try {
        const attachment = new AttachmentBuilder(Buffer.from(text, 'utf-8'), {name: 'response.md'})
        await safeSend(thread, {content: LONG_OUTPUT_SUMMARY, files: [attachment]})
        visibleOutputSent = true
        return {kind: 'attachment', charCount: text.length}
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : String(sendError)
        logger?.warn({err: message}, 'streaming sink: attachment send failed')
        return {kind: 'error', message}
      }
    }

    // Short output → single message
    try {
      await safeSend(thread, {content: text})
      visibleOutputSent = true
      return {kind: 'sent', charCount: text.length}
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : String(sendError)
      logger?.warn({err: message}, 'streaming sink: text send failed')
      return {kind: 'error', message}
    }
  }

  return {append, flush, buffered, markVisibleOutputSent, markVisibleOutputPending, hasVisibleOutput}
}
