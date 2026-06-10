/**
 * Tests for the centralized fail-soft Discord I/O helper (discord/io.ts).
 *
 * TDD: these tests were written BEFORE the implementation.
 *
 * Coverage:
 * - Message/Thread family: sendMessage, editMessage
 * - Interaction family: replyInteraction, editInteraction (Effect-returning)
 * - Guard invariant: allowedMentions:{parse:[]} on every call, no override param
 * - Error path: catch+log+err, never throw
 * - Redaction: log payload never contains raw content
 */

import type {Message, MessageMentionTypes} from 'discord.js'
import type {GatewayLogger} from './client.js'
import type {ReplyCapable} from './io.js'
import {Effect} from 'effect'
import {assert, describe, expect, it, vi} from 'vitest'

import {editInteraction, editMessage, replyInteraction, sendMessage} from './io.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Minimal send-capable target (mirrors SinkThread). */
function makeSendTarget(sendFn = vi.fn().mockResolvedValue(makeFakeMessage())) {
  return {send: sendFn}
}

/** Minimal Message double with reply + edit. */
function makeFakeMessage(
  replyFn = vi.fn().mockResolvedValue(makeSentMessage()),
  editFn = vi.fn().mockResolvedValue(makeSentMessage()),
): ReplyCapable & {edit: ReturnType<typeof vi.fn>} {
  return {reply: replyFn, edit: editFn}
}

/** A "sent" message returned by reply/edit. */
function makeSentMessage() {
  return {id: 'msg-123', content: 'sent'}
}

/** Minimal interaction double with reply + editReply. */
function makeInteraction(
  replyFn = vi.fn().mockResolvedValue(undefined),
  editReplyFn = vi.fn().mockResolvedValue(makeSentMessage()),
) {
  return {reply: replyFn, editReply: editReplyFn}
}

/** A logger spy. */
function makeLogger(): GatewayLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

/** Extract the allowedMentions from the first call arg of a mock. */
function getAllowedMentions(fn: ReturnType<typeof vi.fn>): {parse: readonly MessageMentionTypes[]} | undefined {
  const call = fn.mock.calls[0]
  if (call === undefined) throw new Error('Expected at least one call')
  const arg = call[0] as Record<string, unknown>
  return arg.allowedMentions as {parse: readonly MessageMentionTypes[]} | undefined
}

// ---------------------------------------------------------------------------
// sendMessage — Thread.send / Message.reply
// ---------------------------------------------------------------------------

describe('sendMessage', () => {
  describe('happy path — Thread.send', () => {
    it('calls target.send with the provided content', async () => {
      // #given
      const target = makeSendTarget()
      const logger = makeLogger()

      // #when
      const result = await sendMessage(target, {content: 'hello'}, logger)

      // #then
      expect(result.success).toBe(true)
      expect(target.send).toHaveBeenCalledOnce()
    })

    it('hardcodes allowedMentions:{parse:[]} — no override possible', async () => {
      // #given
      const target = makeSendTarget()
      const logger = makeLogger()

      // #when
      await sendMessage(target, {content: '@everyone look at this!'}, logger)

      // #then
      const mentions = getAllowedMentions(target.send)
      expect(mentions).toEqual({parse: []})
    })

    it('returns ok with the sent Message', async () => {
      // #given
      const sentMsg = makeSentMessage()
      const target = makeSendTarget(vi.fn().mockResolvedValue(sentMsg))
      const logger = makeLogger()

      // #when
      const result = await sendMessage(target, {content: 'hi'}, logger)

      // #then
      assert(result.success)
      expect(result.data).toBe(sentMsg)
    })
  })

  describe('happy path — Message.reply', () => {
    it('calls message.reply with the provided content', async () => {
      // #given
      const sentMsg = makeSentMessage()
      const replyFn = vi.fn().mockResolvedValue(sentMsg)
      const message = makeFakeMessage(replyFn)
      const logger = makeLogger()

      // #when
      const result = await sendMessage(message, {content: 'reply text'}, logger)

      // #then
      expect(result.success).toBe(true)
      expect(replyFn).toHaveBeenCalledOnce()
    })

    it('hardcodes allowedMentions:{parse:[]} on reply', async () => {
      // #given
      const replyFn = vi.fn().mockResolvedValue(makeSentMessage())
      const message = makeFakeMessage(replyFn)
      const logger = makeLogger()

      // #when
      await sendMessage(message, {content: 'reply with @role ping'}, logger)

      // #then
      const mentions = getAllowedMentions(replyFn)
      expect(mentions).toEqual({parse: []})
    })
  })

  describe('error path', () => {
    it('catches a rejected send, logs via logger, returns err — does NOT throw', async () => {
      // #given
      const apiError = new Error('Discord API 500')
      const target = makeSendTarget(vi.fn().mockRejectedValue(apiError))
      const logger = makeLogger()

      // #when
      let threw = false
      let result: Awaited<ReturnType<typeof sendMessage>> | undefined
      try {
        result = await sendMessage(target, {content: 'hello'}, logger)
      } catch {
        threw = true
      }

      // #then
      expect(threw).toBe(false)
      expect(result?.success).toBe(false)
      // Logger was called (warn or error)
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
      const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls
      expect(warnCalls.length + errorCalls.length).toBeGreaterThan(0)
    })

    it('log payload does NOT include raw message content', async () => {
      // #given
      const secretContent = 'SUPER_SECRET_CONTENT_12345'
      const target = makeSendTarget(vi.fn().mockRejectedValue(new Error('fail')))
      const logger = makeLogger()

      // #when
      await sendMessage(target, {content: secretContent}, logger)

      // #then — content must not appear in any log call
      const allLogArgs = [
        ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
        ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ]
      const serialized = JSON.stringify(allLogArgs)
      expect(serialized).not.toContain(secretContent)
    })

    it('returns err with the Error on failure', async () => {
      // #given
      const apiError = new Error('rate limited')
      const target = makeSendTarget(vi.fn().mockRejectedValue(apiError))
      const logger = makeLogger()

      // #when
      const result = await sendMessage(target, {content: 'hi'}, logger)

      // #then
      assert(!result.success)
      expect(result.error).toBeInstanceOf(Error)
    })
  })

  describe('type-level: no allowedMentions override', () => {
    it('the options parameter has no allowedMentions property (structural assertion)', async () => {
      // This is a compile-time check — if sendMessage accepted allowedMentions,
      // TypeScript would allow it. We assert the runtime shape has no such key.
      // The real guard is the type signature in io.ts (no allowedMentions in options).
      // Here we just verify the function exists and works without it.
      const target = makeSendTarget()
      const logger = makeLogger()
      // @ts-expect-error — allowedMentions must NOT be accepted
      await sendMessage(target, {content: 'hi', allowedMentions: {parse: ['everyone']}}, logger)
      // If this compiles without error, the type guard is broken.
      // The @ts-expect-error above will fail compilation if the param IS accepted.
      expect(true).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// editMessage — Message.edit
// ---------------------------------------------------------------------------

describe('editMessage', () => {
  describe('happy path', () => {
    it('calls message.edit with the provided content', async () => {
      // #given
      const editFn = vi.fn().mockResolvedValue(makeSentMessage())
      const message = {edit: editFn} as unknown as Message
      const logger = makeLogger()

      // #when
      const result = await editMessage(message, {content: 'edited!'}, logger)

      // #then
      expect(result.success).toBe(true)
      expect(editFn).toHaveBeenCalledOnce()
    })

    it('hardcodes allowedMentions:{parse:[]} on edit', async () => {
      // #given
      const editFn = vi.fn().mockResolvedValue(makeSentMessage())
      const message = {edit: editFn} as unknown as Message
      const logger = makeLogger()

      // #when
      await editMessage(message, {content: 'edited @everyone'}, logger)

      // #then
      const mentions = getAllowedMentions(editFn)
      expect(mentions).toEqual({parse: []})
    })

    it('returns ok with the edited Message', async () => {
      // #given
      const editedMsg = makeSentMessage()
      const editFn = vi.fn().mockResolvedValue(editedMsg)
      const message = {edit: editFn} as unknown as Message
      const logger = makeLogger()

      // #when
      const result = await editMessage(message, {content: 'new content'}, logger)

      // #then
      assert(result.success)
      expect(result.data).toBe(editedMsg)
    })
  })

  describe('error path', () => {
    it('catches a rejected edit, logs, returns err — does NOT throw', async () => {
      // #given
      const editFn = vi.fn().mockRejectedValue(new Error('edit failed'))
      const message = {edit: editFn} as unknown as Message
      const logger = makeLogger()

      // #when
      let threw = false
      let result: Awaited<ReturnType<typeof editMessage>> | undefined
      try {
        result = await editMessage(message, {content: 'hi'}, logger)
      } catch {
        threw = true
      }

      // #then
      expect(threw).toBe(false)
      expect(result?.success).toBe(false)
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
      const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls
      expect(warnCalls.length + errorCalls.length).toBeGreaterThan(0)
    })

    it('log payload does NOT include raw edit content', async () => {
      // #given
      const secretContent = 'EDIT_SECRET_CONTENT_99999'
      const editFn = vi.fn().mockRejectedValue(new Error('fail'))
      const message = {edit: editFn} as unknown as Message
      const logger = makeLogger()

      // #when
      await editMessage(message, {content: secretContent}, logger)

      // #then
      const allLogArgs = [
        ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
        ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ]
      const serialized = JSON.stringify(allLogArgs)
      expect(serialized).not.toContain(secretContent)
    })
  })

  describe('type-level: no allowedMentions override', () => {
    it('the options parameter has no allowedMentions property', async () => {
      const editFn = vi.fn().mockResolvedValue(makeSentMessage())
      const message = {edit: editFn} as unknown as Message
      const logger = makeLogger()
      // @ts-expect-error — allowedMentions must NOT be accepted
      await editMessage(message, {content: 'hi', allowedMentions: {parse: ['everyone']}}, logger)
      expect(true).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// replyInteraction — Effect-returning interaction reply
// ---------------------------------------------------------------------------

describe('replyInteraction', () => {
  describe('happy path', () => {
    it('calls interaction.reply with the provided content', async () => {
      // #given
      const replyFn = vi.fn().mockResolvedValue(undefined)
      const interaction = makeInteraction(replyFn)
      const logger = makeLogger()

      // #when
      const result = await Effect.runPromise(replyInteraction(interaction, {content: 'pong'}, logger))

      // #then
      expect(result.success).toBe(true)
      expect(replyFn).toHaveBeenCalledOnce()
    })

    it('hardcodes allowedMentions:{parse:[]} on interaction reply', async () => {
      // #given
      const replyFn = vi.fn().mockResolvedValue(undefined)
      const interaction = makeInteraction(replyFn)
      const logger = makeLogger()

      // #when
      await Effect.runPromise(replyInteraction(interaction, {content: '@everyone ping'}, logger))

      // #then
      const mentions = getAllowedMentions(replyFn)
      expect(mentions).toEqual({parse: []})
    })

    it('composes inside Effect.gen without Effect.tryPromise wrapping', async () => {
      // #given — the Effect-returning helper must yield directly in Effect.gen
      const replyFn = vi.fn().mockResolvedValue(undefined)
      const interaction = makeInteraction(replyFn)
      const logger = makeLogger()

      // #when — use it directly in Effect.gen (no tryPromise wrapper)
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* replyInteraction(interaction, {content: 'direct yield'}, logger)
        }),
      )

      // #then
      expect(result.success).toBe(true)
      expect(replyFn).toHaveBeenCalledOnce()
    })
  })

  describe('error path', () => {
    it('on Discord API rejection: Effect resolves to err Result — does NOT die/throw', async () => {
      // #given
      const replyFn = vi.fn().mockRejectedValue(new Error('interaction expired'))
      const interaction = makeInteraction(replyFn)
      const logger = makeLogger()

      // #when — must NOT throw out of Effect.runPromise
      let threw = false
      let result: {success: boolean} | undefined
      try {
        result = await Effect.runPromise(replyInteraction(interaction, {content: 'hi'}, logger))
      } catch {
        threw = true
      }

      // #then — Effect resolves (not dies), result is err
      expect(threw).toBe(false)
      expect(result?.success).toBe(false)
    })

    it('logs via logger on failure (warn or error)', async () => {
      // #given
      const replyFn = vi.fn().mockRejectedValue(new Error('fail'))
      const interaction = makeInteraction(replyFn)
      const logger = makeLogger()

      // #when
      await Effect.runPromise(replyInteraction(interaction, {content: 'hi'}, logger))

      // #then
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
      const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls
      expect(warnCalls.length + errorCalls.length).toBeGreaterThan(0)
    })

    it('log payload does NOT include raw interaction content', async () => {
      // #given
      const secretContent = 'INTERACTION_SECRET_REPLY_77777'
      const replyFn = vi.fn().mockRejectedValue(new Error('fail'))
      const interaction = makeInteraction(replyFn)
      const logger = makeLogger()

      // #when
      await Effect.runPromise(replyInteraction(interaction, {content: secretContent}, logger))

      // #then
      const allLogArgs = [
        ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
        ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ]
      const serialized = JSON.stringify(allLogArgs)
      expect(serialized).not.toContain(secretContent)
    })
  })

  describe('type-level: no allowedMentions override', () => {
    it('the options parameter has no allowedMentions property', async () => {
      const replyFn = vi.fn().mockResolvedValue(undefined)
      const interaction = makeInteraction(replyFn)
      const logger = makeLogger()
      // @ts-expect-error — allowedMentions must NOT be accepted
      await Effect.runPromise(replyInteraction(interaction, {content: 'hi', allowedMentions: {parse: []}}, logger))
      expect(true).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// editInteraction — Effect-returning interaction editReply
// ---------------------------------------------------------------------------

describe('editInteraction', () => {
  describe('happy path', () => {
    it('calls interaction.editReply with the provided content', async () => {
      // #given
      const editReplyFn = vi.fn().mockResolvedValue(makeSentMessage())
      const interaction = makeInteraction(vi.fn(), editReplyFn)
      const logger = makeLogger()

      // #when
      const result = await Effect.runPromise(editInteraction(interaction, {content: 'edited reply'}, logger))

      // #then
      expect(result.success).toBe(true)
      expect(editReplyFn).toHaveBeenCalledOnce()
    })

    it('hardcodes allowedMentions:{parse:[]} on editReply', async () => {
      // #given
      const editReplyFn = vi.fn().mockResolvedValue(makeSentMessage())
      const interaction = makeInteraction(vi.fn(), editReplyFn)
      const logger = makeLogger()

      // #when
      await Effect.runPromise(editInteraction(interaction, {content: '@role ping'}, logger))

      // #then
      const mentions = getAllowedMentions(editReplyFn)
      expect(mentions).toEqual({parse: []})
    })

    it('composes inside Effect.gen without Effect.tryPromise wrapping', async () => {
      // #given
      const editReplyFn = vi.fn().mockResolvedValue(makeSentMessage())
      const interaction = makeInteraction(vi.fn(), editReplyFn)
      const logger = makeLogger()

      // #when
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* editInteraction(interaction, {content: 'direct yield'}, logger)
        }),
      )

      // #then
      expect(result.success).toBe(true)
      expect(editReplyFn).toHaveBeenCalledOnce()
    })

    it('works with a button interaction shape (broad type coverage)', async () => {
      // #given — simulate the button interaction from program.ts
      const editReplyFn = vi.fn().mockResolvedValue(makeSentMessage())
      const buttonInteraction = {
        // button interactions have editReply but not reply in the deferred path
        reply: vi.fn(),
        editReply: editReplyFn,
        isButton: () => true,
        isChatInputCommand: () => false,
      }
      const logger = makeLogger()

      // #when
      const result = await Effect.runPromise(editInteraction(buttonInteraction, {content: 'Approved.'}, logger))

      // #then
      expect(result.success).toBe(true)
      expect(editReplyFn).toHaveBeenCalledOnce()
    })
  })

  describe('error path', () => {
    it('on Discord API rejection: Effect resolves to err Result — does NOT die/throw', async () => {
      // #given
      const editReplyFn = vi.fn().mockRejectedValue(new Error('token expired'))
      const interaction = makeInteraction(vi.fn(), editReplyFn)
      const logger = makeLogger()

      // #when
      let threw = false
      let result: {success: boolean} | undefined
      try {
        result = await Effect.runPromise(editInteraction(interaction, {content: 'hi'}, logger))
      } catch {
        threw = true
      }

      // #then
      expect(threw).toBe(false)
      expect(result?.success).toBe(false)
    })

    it('logs via logger on failure', async () => {
      // #given
      const editReplyFn = vi.fn().mockRejectedValue(new Error('fail'))
      const interaction = makeInteraction(vi.fn(), editReplyFn)
      const logger = makeLogger()

      // #when
      await Effect.runPromise(editInteraction(interaction, {content: 'hi'}, logger))

      // #then
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
      const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls
      expect(warnCalls.length + errorCalls.length).toBeGreaterThan(0)
    })

    it('log payload does NOT include raw editReply content', async () => {
      // #given
      const secretContent = 'EDIT_INTERACTION_SECRET_55555'
      const editReplyFn = vi.fn().mockRejectedValue(new Error('fail'))
      const interaction = makeInteraction(vi.fn(), editReplyFn)
      const logger = makeLogger()

      // #when
      await Effect.runPromise(editInteraction(interaction, {content: secretContent}, logger))

      // #then
      const allLogArgs = [
        ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
        ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ]
      const serialized = JSON.stringify(allLogArgs)
      expect(serialized).not.toContain(secretContent)
    })

    it('inside Effect.gen catchAll: err Result does not re-fail the outer Effect', async () => {
      // #given — simulates the fro-bot.ts #854 catchAll pattern:
      // catchAll calls editInteraction (which catches internally), then re-fails.
      // The edit helper must NOT die so the catchAll can decide whether to re-fail.
      const editReplyFn = vi.fn().mockRejectedValue(new Error('edit also failed'))
      const interaction = makeInteraction(vi.fn(), editReplyFn)
      const logger = makeLogger()

      // #when — catchAll calls editInteraction then re-fails with original error
      const originalError = new Error('original failure')
      let caughtError: Error | undefined
      try {
        await Effect.runPromise(
          Effect.fail(originalError).pipe(
            Effect.catchAll(err =>
              Effect.gen(function* () {
                // editInteraction must not die here — it returns err Result
                const editResult = yield* editInteraction(interaction, {content: 'An error occurred.'}, logger)
                expect(editResult.success).toBe(false) // edit also failed, but no die
                return yield* Effect.fail(err) // re-fail with original
              }),
            ),
          ),
        )
      } catch (error) {
        caughtError = error as Error
      }

      // #then — the outer Effect re-failed with the original error message (not the edit error).
      // Effect wraps the error in a FiberFailure when it propagates out of runPromise,
      // so we check the message rather than identity.
      expect(caughtError?.message).toBe(originalError.message)
    })
  })

  describe('type-level: no allowedMentions override', () => {
    it('the options parameter has no allowedMentions property', async () => {
      const editReplyFn = vi.fn().mockResolvedValue(makeSentMessage())
      const interaction = makeInteraction(vi.fn(), editReplyFn)
      const logger = makeLogger()
      // @ts-expect-error — allowedMentions must NOT be accepted
      await Effect.runPromise(editInteraction(interaction, {content: 'hi', allowedMentions: {parse: []}}, logger))
      expect(true).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting: never throws in any branch
// ---------------------------------------------------------------------------

describe('never throws in any branch', () => {
  it('sendMessage: does not throw even when send rejects with a non-Error', async () => {
    // #given
    const target = makeSendTarget(vi.fn().mockRejectedValue('string error'))
    const logger = makeLogger()

    // #when / #then
    await expect(sendMessage(target, {content: 'hi'}, logger)).resolves.toBeDefined()
  })

  it('editMessage: does not throw even when edit rejects with a non-Error', async () => {
    // #given
    const editFn = vi.fn().mockRejectedValue(42)
    const message = {edit: editFn} as unknown as Message
    const logger = makeLogger()

    // #when / #then
    await expect(editMessage(message, {content: 'hi'}, logger)).resolves.toBeDefined()
  })

  it('replyInteraction: Effect.runPromise does not reject even when reply rejects', async () => {
    // #given
    const replyFn = vi.fn().mockRejectedValue(new Error('boom'))
    const interaction = makeInteraction(replyFn)
    const logger = makeLogger()

    // #when / #then
    await expect(Effect.runPromise(replyInteraction(interaction, {content: 'hi'}, logger))).resolves.toBeDefined()
  })

  it('editInteraction: Effect.runPromise does not reject even when editReply rejects', async () => {
    // #given
    const editReplyFn = vi.fn().mockRejectedValue(new Error('boom'))
    const interaction = makeInteraction(vi.fn(), editReplyFn)
    const logger = makeLogger()

    // #when / #then
    await expect(Effect.runPromise(editInteraction(interaction, {content: 'hi'}, logger))).resolves.toBeDefined()
  })
})
