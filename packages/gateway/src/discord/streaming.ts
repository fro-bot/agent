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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discord's hard content-length limit for a single message. */
const DISCORD_MESSAGE_CHAR_LIMIT = 2000

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
   * - Empty/whitespace: "no output" message.
   * - On `thread.send` rejection: returns `{kind:'error'}` (does not throw).
   */
  readonly flush: () => Promise<FlushResult>
  /** Read the current buffered text without flushing. */
  readonly buffered: () => string
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

  const append = (text: string): void => {
    buffer += text
  }

  const buffered = (): string => buffer

  const flush = async (): Promise<FlushResult> => {
    const text = buffer

    // Empty / whitespace → post a clear "no output" message
    if (text.trim().length === 0) {
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
      return {kind: 'sent', charCount: text.length}
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : String(sendError)
      logger?.warn({err: message}, 'streaming sink: text send failed')
      return {kind: 'error', message}
    }
  }

  return {append, flush, buffered}
}
