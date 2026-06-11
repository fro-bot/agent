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
import type {
  BaseMessageOptions,
  InteractionEditReplyOptions,
  InteractionReplyOptions,
  Message,
  MessageCreateOptions,
  MessageMentionTypes,
  MessageReplyOptions,
} from 'discord.js'

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
 * Uses `MessageCreateOptions` as the parameter type so that discord.js
 * `ThreadChannel` (whose `.send` accepts `string | MessagePayload | MessageCreateOptions`)
 * is structurally assignable without casts.
 *
 * Invariant: agent or interpolated text can NEVER ping `@everyone`, roles, or
 * users. Asserted at every call site in tests.
 */
export interface SendCapable {
  readonly send: (options: MessageCreateOptions) => Promise<unknown>
}

/**
 * Minimal reply-capable shape. Covers `Message.reply`.
 *
 * Uses `MessageReplyOptions` as the parameter type so that discord.js
 * `Message` (whose `.reply` accepts `string | MessagePayload | MessageReplyOptions`)
 * is structurally assignable without casts.
 */
export interface ReplyCapable {
  readonly reply: (options: MessageReplyOptions) => Promise<unknown>
}

/**
 * A target that supports either `send` (Thread) or `reply` (Message).
 * `sendMessage` accepts either shape.
 */
export type SendOrReplyTarget = SendCapable | ReplyCapable

/**
 * Options accepted by `sendMessage`. No `allowedMentions` — it is always injected.
 *
 * Field types are picked from `MessageCreateOptions` so that the spread
 * `{...options, allowedMentions: SAFE_MENTIONS}` is assignable to
 * `MessageCreateOptions` without casts.
 */
export type MessageContentOptions = Pick<MessageCreateOptions, 'content' | 'embeds' | 'components' | 'files' | 'flags'>

/**
 * Options accepted by `editMessage`. No `allowedMentions` — it is always injected.
 * Deliberately omits `flags` — `MessageEditOptions.flags` and `MessageCreateOptions.flags`
 * have incompatible `BitFieldResolvable` types; edits do not use flags.
 */
export type MessageEditContentOptions = Pick<MessageCreateOptions, 'content' | 'embeds' | 'components' | 'files'>

/**
 * Options accepted by `replyInteraction`. No `allowedMentions` — always injected.
 * Mirrors the `MessageContentOptions` approach: a `Pick` of discord.js's own option type so the
 * helper's `{...options, allowedMentions}` spread is assignable without a cast. `ephemeral` is
 * reply-only (an edit inherits the deferred reply's visibility and cannot change it).
 */
export type InteractionContentOptions = Pick<
  InteractionReplyOptions,
  'content' | 'embeds' | 'components' | 'files' | 'flags' | 'ephemeral'
>

/** Options accepted by `editInteraction`. Same as the reply options minus `ephemeral` (edits can't set it). */
export type InteractionEditContentOptions = Pick<
  InteractionEditReplyOptions,
  'content' | 'embeds' | 'components' | 'files' | 'flags'
>

/**
 * Minimal interaction shape broad enough to cover both `ChatInputCommandInteraction`
 * and the button interaction used in `program.ts` (which uses `editReply` after
 * `deferReply`). Structural type — not tied to a specific discord.js class.
 *
 * Uses discord.js's own `InteractionReplyOptions` / `InteractionEditReplyOptions`
 * as the parameter types so that `ChatInputCommandInteraction` and `ButtonInteraction`
 * are structurally assignable without casts.
 */
export interface RepliableInteractionTarget {
  readonly reply: (options: InteractionReplyOptions) => Promise<unknown>
  readonly editReply: (options: InteractionEditReplyOptions) => Promise<unknown>
}

// ---------------------------------------------------------------------------
// Internal option shapes (with allowedMentions injected)
// ---------------------------------------------------------------------------

interface AllowedMentions {
  readonly parse: readonly MessageMentionTypes[]
}

/**
 * Internal send options — a subset of `MessageCreateOptions` with `allowedMentions`
 * required. Assignable to `MessageCreateOptions` so no cast is needed when
 * calling `target.send(sendOptions)`.
 */
type SendOptions = Pick<
  MessageCreateOptions,
  'content' | 'embeds' | 'components' | 'files' | 'flags' | 'allowedMentions'
>

/**
 * Internal edit options — uses `BaseMessageOptions` fields (shared between
 * `MessageCreateOptions` and `MessageEditOptions`) plus `content?: string`.
 * Assignable to `MessageEditOptions` so no cast is needed when calling
 * `message.edit(editOptions)`.
 *
 * We avoid `Pick<MessageEditOptions, 'flags'>` because `MessageEditOptions.flags`
 * and `MessageCreateOptions.flags` have incompatible `BitFieldResolvable` types.
 * The `editMessage` helper does not use `flags`, so omitting it is safe.
 */
type EditOptions = Pick<BaseMessageOptions, 'embeds' | 'components' | 'files' | 'allowedMentions'> & {
  readonly content?: string
}

/**
 * Internal send options — extends `InteractionReplyOptions` with `allowedMentions` required.
 * Using discord.js's own type ensures structural assignability when calling `interaction.reply`.
 */
type InteractionSendOptions = InteractionReplyOptions & {readonly allowedMentions: AllowedMentions}

/**
 * Internal edit options — extends `InteractionEditReplyOptions` with `allowedMentions` required.
 * Using discord.js's own type ensures structural assignability when calling `interaction.editReply`.
 */
type InteractionEditOptions = InteractionEditReplyOptions & {readonly allowedMentions: AllowedMentions}

// ---------------------------------------------------------------------------
// Shared guard constant
// ---------------------------------------------------------------------------

/**
 * The mention guard applied to every Discord send/reply/edit.
 * `parse: []` means NO mention types are parsed — @everyone, roles, and users
 * are all treated as plain text regardless of the message content.
 *
 * Frozen so the shared object cannot be mutated at runtime.
 */
const SAFE_MENTIONS: AllowedMentions = Object.freeze({parse: Object.freeze([] as MessageMentionTypes[])})

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
export async function sendMessage<T = unknown>(
  target: SendOrReplyTarget,
  options: MessageContentOptions,
  logger: GatewayLogger,
): Promise<Result<T, Error>> {
  const sendOptions: SendOptions = {...options, allowedMentions: SAFE_MENTIONS}

  try {
    let result: unknown
    if ('send' in target) {
      result = await target.send(sendOptions)
    } else {
      result = await target.reply(sendOptions)
    }
    // Caller-asserted narrowing: the actual value is typed as T at the call site.
    // The single `as T` cast is the documented narrowing point for this IO-wrapper idiom.
    return ok(result as T)
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
  options: MessageEditContentOptions,
  logger: GatewayLogger,
): Promise<Result<unknown, Error>> {
  const editOptions: EditOptions = {...options, allowedMentions: SAFE_MENTIONS}

  try {
    const result = await message.edit(editOptions)
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
    try {
      const replyOptions: InteractionSendOptions = {...options, allowedMentions: SAFE_MENTIONS}
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
  options: InteractionEditContentOptions,
  logger: GatewayLogger,
): Effect.Effect<Result<unknown, Error>, never> {
  return Effect.promise(async () => {
    try {
      const editOptions: InteractionEditOptions = {...options, allowedMentions: SAFE_MENTIONS}
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

// ---------------------------------------------------------------------------
// Plain-async convenience wrappers (for non-Effect.gen callers)
// ---------------------------------------------------------------------------

/**
 * Plain-async wrapper around `replyInteraction` for non-Effect.gen callers.
 * For `Effect.gen` handlers, use the Effect-returning `replyInteraction` directly.
 */
export async function replyInteractionAsync(
  interaction: RepliableInteractionTarget,
  options: InteractionContentOptions,
  logger: GatewayLogger,
): Promise<Result<unknown, Error>> {
  return Effect.runPromise(replyInteraction(interaction, options, logger))
}

/**
 * Plain-async wrapper around `editInteraction` for non-Effect.gen callers.
 * For `Effect.gen` handlers, use the Effect-returning `editInteraction` directly.
 */
export async function editInteractionAsync(
  interaction: RepliableInteractionTarget,
  options: InteractionEditContentOptions,
  logger: GatewayLogger,
): Promise<Result<unknown, Error>> {
  return Effect.runPromise(editInteraction(interaction, options, logger))
}
