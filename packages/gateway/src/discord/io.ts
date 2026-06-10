/**
 * Centralized fail-soft Discord I/O helper.
 *
 * Two helper families:
 *
 * **Message/Thread family** (plain async, returns `Promise<Result>`):
 * - `sendMessage` — covers `Thread.send` and `Message.reply` via a minimal
 *   send-capable shape (mirrors `SinkThread` from `streaming.ts`).
 * - `editMessage` — covers `Message.edit` (typing diverges from send/reply).
 *
 * **Interaction family** (Effect-returning, composes in `Effect.gen` handlers):
 * - `replyInteraction` — wraps `interaction.reply`.
 * - `editInteraction` — wraps `interaction.editReply`.
 *
 * **Invariants (enforced, no escape hatch):**
 * - `allowedMentions: {parse: []}` is ALWAYS applied — agent or interpolated
 *   text can NEVER ping `@everyone`, roles, or users. There is NO override
 *   parameter; the guard cannot be opted out.
 * - All helpers catch Discord API errors, log via the injected `GatewayLogger`
 *   with **redacted** context (operation name + target id + sanitized error
 *   message ONLY — never raw content/embeds/payload), and return a `Result`.
 * - None of these helpers ever throw or reject.
 */

import type {Result} from '@fro-bot/runtime'
import type {Message, MessageMentionTypes} from 'discord.js'

import type {GatewayLogger} from './client.js'
import {err, ok} from '@fro-bot/runtime'
import {Effect} from 'effect'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Minimal send-capable shape. Covers both `Thread.send` and `Message.reply`.
 * Mirrors `SinkThread` from `streaming.ts` but typed to return `Message` so
 * callers can use the sent message reference.
 *
 * Invariant: agent or interpolated text can NEVER ping `@everyone`, roles, or
 * users. Asserted at every call site in tests.
 */
export interface SendCapable {
  readonly send: (options: SendOptions) => Promise<unknown>
}

/**
 * Minimal reply-capable shape. Covers `Message.reply`.
 */
export interface ReplyCapable {
  readonly reply: (options: SendOptions) => Promise<unknown>
}

/**
 * A target that supports either `send` (Thread) or `reply` (Message).
 * `sendMessage` accepts either shape.
 */
export type SendOrReplyTarget = SendCapable | ReplyCapable

/** Options accepted by `sendMessage` and `editMessage`. No `allowedMentions` — it is always injected. */
export interface MessageContentOptions {
  readonly content?: string
  readonly embeds?: readonly unknown[]
  readonly components?: readonly unknown[]
  readonly files?: readonly unknown[]
  readonly flags?: unknown
}

/** Options accepted by `replyInteraction` and `editInteraction`. No `allowedMentions` — always injected. */
export interface InteractionContentOptions {
  readonly content?: string
  readonly embeds?: readonly unknown[]
  readonly components?: readonly unknown[]
  readonly files?: readonly unknown[]
  readonly ephemeral?: boolean
  readonly flags?: unknown
}

/**
 * Minimal interaction shape broad enough to cover both `ChatInputCommandInteraction`
 * and the button interaction used in `program.ts` (which uses `editReply` after
 * `deferReply`). Structural type — not tied to a specific discord.js class.
 */
export interface RepliableInteractionTarget {
  readonly reply: (options: InteractionSendOptions) => Promise<unknown>
  readonly editReply: (options: InteractionEditOptions) => Promise<unknown>
}

// ---------------------------------------------------------------------------
// Internal option shapes (with allowedMentions injected)
// ---------------------------------------------------------------------------

interface AllowedMentions {
  readonly parse: readonly MessageMentionTypes[]
}

interface SendOptions {
  readonly content?: string
  readonly embeds?: readonly unknown[]
  readonly components?: readonly unknown[]
  readonly files?: readonly unknown[]
  readonly flags?: unknown
  readonly allowedMentions: AllowedMentions
}

interface InteractionSendOptions {
  readonly content?: string
  readonly embeds?: readonly unknown[]
  readonly components?: readonly unknown[]
  readonly files?: readonly unknown[]
  readonly ephemeral?: boolean
  readonly flags?: unknown
  readonly allowedMentions: AllowedMentions
}

interface InteractionEditOptions {
  readonly content?: string
  readonly embeds?: readonly unknown[]
  readonly components?: readonly unknown[]
  readonly files?: readonly unknown[]
  readonly flags?: unknown
  readonly allowedMentions: AllowedMentions
}

// ---------------------------------------------------------------------------
// Shared guard constant
// ---------------------------------------------------------------------------

/**
 * The mention guard applied to every Discord send/reply/edit.
 * `parse: []` means NO mention types are parsed — @everyone, roles, and users
 * are all treated as plain text regardless of the message content.
 */
const SAFE_MENTIONS: AllowedMentions = {parse: []}

// ---------------------------------------------------------------------------
// Internal: sanitize error for logging (never log raw content/payload)
// ---------------------------------------------------------------------------

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ---------------------------------------------------------------------------
// Message/Thread family — plain async, returns Promise<Result>
// ---------------------------------------------------------------------------

/**
 * Send a message to a Thread (`thread.send`) or reply to a Message
 * (`message.reply`), with `allowedMentions: {parse: []}` always applied.
 *
 * Accepts any target that has either a `send` or `reply` method (covers
 * `ThreadChannel`, `SinkThread`, and `Message`).
 *
 * Returns `ok(sentMessage)` on success, `err(Error)` on failure.
 * Never throws.
 *
 * **No `allowedMentions` parameter** — the guard cannot be opted out.
 */
export async function sendMessage(
  target: SendOrReplyTarget,
  options: MessageContentOptions,
  logger: GatewayLogger,
): Promise<Result<unknown, Error>> {
  const sendOptions: SendOptions = {...options, allowedMentions: SAFE_MENTIONS}

  try {
    let result: unknown
    if ('send' in target) {
      result = await target.send(sendOptions)
    } else {
      result = await target.reply(sendOptions)
    }
    return ok(result)
  } catch (error: unknown) {
    const sanitized = sanitizeError(error)
    logger.warn(
      {
        op: 'sendMessage',
        err: sanitized,
      },
      'io: sendMessage failed',
    )
    return err(error instanceof Error ? error : new Error(sanitized))
  }
}

/**
 * Edit an existing Discord message (`message.edit`), with
 * `allowedMentions: {parse: []}` always applied.
 *
 * `Message.edit` has a different type signature from `send`/`reply` — it
 * accepts `MessageEditOptions` which extends `Omit<BaseMessageOptions, 'content'>`.
 * This is a separate helper to avoid forcing incompatible types.
 *
 * Returns `ok(editedMessage)` on success, `err(Error)` on failure.
 * Never throws.
 *
 * **No `allowedMentions` parameter** — the guard cannot be opted out.
 */
export async function editMessage(
  message: Pick<Message, 'edit'>,
  options: MessageContentOptions,
  logger: GatewayLogger,
): Promise<Result<unknown, Error>> {
  const editOptions: SendOptions = {...options, allowedMentions: SAFE_MENTIONS}

  try {
    const result = await message.edit(editOptions as Parameters<Message['edit']>[0])
    return ok(result)
  } catch (error: unknown) {
    const sanitized = sanitizeError(error)
    logger.warn(
      {
        op: 'editMessage',
        err: sanitized,
      },
      'io: editMessage failed',
    )
    return err(error instanceof Error ? error : new Error(sanitized))
  }
}

// ---------------------------------------------------------------------------
// Interaction family — Effect-returning, composes in Effect.gen handlers
// ---------------------------------------------------------------------------

/**
 * Reply to a Discord interaction (`interaction.reply`), with
 * `allowedMentions: {parse: []}` always applied.
 *
 * Returns an `Effect` that yields `Result<unknown, Error>`.
 * The Effect NEVER fails (never calls `Effect.fail`) — Discord API errors are
 * caught and returned as `err(Error)` inside the Result. This means callers
 * can `yield*` directly in `Effect.gen` without worrying about the Effect dying.
 *
 * Covers both `ChatInputCommandInteraction` and button interactions (broad
 * structural type — not tied to a specific discord.js class).
 *
 * **No `allowedMentions` parameter** — the guard cannot be opted out.
 */
export function replyInteraction(
  interaction: RepliableInteractionTarget,
  options: InteractionContentOptions,
  logger: GatewayLogger,
): Effect.Effect<Result<unknown, Error>, never> {
  return Effect.promise(async () => {
    const replyOptions: InteractionSendOptions = {...options, allowedMentions: SAFE_MENTIONS}

    try {
      const result = await interaction.reply(replyOptions)
      return ok(result)
    } catch (error: unknown) {
      const sanitized = sanitizeError(error)
      logger.warn(
        {
          op: 'replyInteraction',
          err: sanitized,
        },
        'io: replyInteraction failed',
      )
      return err(error instanceof Error ? error : new Error(sanitized))
    }
  })
}

/**
 * Edit the reply of a Discord interaction (`interaction.editReply`), with
 * `allowedMentions: {parse: []}` always applied.
 *
 * Returns an `Effect` that yields `Result<unknown, Error>`.
 * The Effect NEVER fails — Discord API errors are caught and returned as
 * `err(Error)` inside the Result. This is critical for the `fro-bot.ts`
 * `Effect.catchAll` pattern (#854 fix): the catchAll calls this helper, then
 * re-fails with the original error — the helper must not die so the catchAll
 * can control re-failure.
 *
 * Covers both `ChatInputCommandInteraction` and button interactions.
 *
 * **No `allowedMentions` parameter** — the guard cannot be opted out.
 */
export function editInteraction(
  interaction: RepliableInteractionTarget,
  options: InteractionContentOptions,
  logger: GatewayLogger,
): Effect.Effect<Result<unknown, Error>, never> {
  return Effect.promise(async () => {
    const editOptions: InteractionEditOptions = {...options, allowedMentions: SAFE_MENTIONS}

    try {
      const result = await interaction.editReply(editOptions)
      return ok(result)
    } catch (error: unknown) {
      const sanitized = sanitizeError(error)
      logger.warn(
        {
          op: 'editInteraction',
          err: sanitized,
        },
        'io: editInteraction failed',
      )
      return err(error instanceof Error ? error : new Error(sanitized))
    }
  })
}
