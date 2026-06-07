import type {SinkThread} from './streaming.js'
import {AttachmentBuilder} from 'discord.js'
import {describe, expect, it, vi} from 'vitest'

import {createDiscordStreamSink} from './streaming.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeThread(sendFn: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)): SinkThread & {
  readonly _send: ReturnType<typeof vi.fn>
} {
  return {
    send: sendFn,
    _send: sendFn,
  } as unknown as SinkThread & {readonly _send: ReturnType<typeof vi.fn>}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first argument of the first call to a mock function. */
function firstCallArg<T>(fn: ReturnType<typeof vi.fn>): T {
  const call = fn.mock.calls[0]
  if (call === undefined) throw new Error('Expected at least one call')
  return call[0] as T
}

const SHORT_TEXT = 'Hello from the agent!'
const LONG_TEXT = 'x'.repeat(2001)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDiscordStreamSink', () => {
  describe('happy path — short text (<= 2000 chars)', () => {
    it('sends the buffered text in a single message', async () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append(SHORT_TEXT)

      // #when
      const result = await sink.flush()

      // #then
      expect(result.kind).toBe('sent')
      expect(thread._send).toHaveBeenCalledOnce()
    })

    it('hardcodes allowedMentions:{parse:[]} on the send', async () => {
      // #given — agent text contains @everyone, @here, and a role ping
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append('@everyone @here <@&12345> come look at this!')

      // #when
      await sink.flush()

      // #then — allowedMentions MUST be {parse:[]} so nothing pings
      const call = firstCallArg<{allowedMentions: {parse: string[]}}>(thread._send)
      expect(call.allowedMentions).toEqual({parse: []})
    })

    it('includes the buffered text as content', async () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append('agent says hi')

      // #when
      await sink.flush()

      // #then
      const call = firstCallArg<{content: string}>(thread._send)
      expect(call.content).toBe('agent says hi')
    })

    it('coalesces multiple appended deltas into one send', async () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append('Hello ')
      sink.append('world')
      sink.append('!')

      // #when
      const result = await sink.flush()

      // #then — one send, full text
      expect(result.kind).toBe('sent')
      expect(thread._send).toHaveBeenCalledOnce()
      const call = firstCallArg<{content: string}>(thread._send)
      expect(call.content).toBe('Hello world!')
    })
  })

  describe('happy path — long text (> 2000 chars)', () => {
    it('posts summary + .md attachment instead of raw long text', async () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append(LONG_TEXT)

      // #when
      const result = await sink.flush()

      // #then — attachment fallback
      expect(result.kind).toBe('attachment')
      expect(thread._send).toHaveBeenCalledOnce()

      const call = firstCallArg<{content: string; files: AttachmentBuilder[]}>(thread._send)
      expect(call.files).toHaveLength(1)
      expect(call.files[0]).toBeInstanceOf(AttachmentBuilder)
      // Must NOT contain the raw long text as a content string
      expect(call.content).not.toBe(LONG_TEXT)
    })

    it('hardcodes allowedMentions:{parse:[]} on the attachment send', async () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append(LONG_TEXT)

      // #when
      await sink.flush()

      // #then
      const call = firstCallArg<{allowedMentions: {parse: string[]}}>(thread._send)
      expect(call.allowedMentions).toEqual({parse: []})
    })

    it('does not send more than 2000 chars as content', async () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append(LONG_TEXT)

      // #when
      await sink.flush()

      // #then — content must be a short summary, not the full 2001-char text
      const call = firstCallArg<{content?: string}>(thread._send)
      const contentLength = call.content?.length ?? 0
      expect(contentLength).toBeLessThanOrEqual(2000)
    })
  })

  describe('edge case — empty / whitespace output', () => {
    it('sends a clear "no output" message when buffer is empty', async () => {
      // #given — nothing appended
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)

      // #when
      const result = await sink.flush()

      // #then
      expect(result.kind).toBe('empty')
      expect(thread._send).toHaveBeenCalledOnce()
      const call = firstCallArg<{content: string}>(thread._send)
      expect(call.content.trim().length).toBeGreaterThan(0) // not an empty string
    })

    it('sends a clear "no output" message when buffer is only whitespace', async () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append('   \n\t  ')

      // #when
      const result = await sink.flush()

      // #then
      expect(result.kind).toBe('empty')
      const call = firstCallArg<{content: string}>(thread._send)
      expect(call.content.trim().length).toBeGreaterThan(0)
    })

    it('hardcodes allowedMentions:{parse:[]} on the empty-output send', async () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)

      // #when
      await sink.flush()

      // #then
      const call = firstCallArg<{allowedMentions: {parse: string[]}}>(thread._send)
      expect(call.allowedMentions).toEqual({parse: []})
    })
  })

  describe('error path — thread.send rejects', () => {
    it('returns {kind:"error"} on short-text send failure without throwing', async () => {
      // #given
      const sendFn = vi.fn().mockRejectedValue(new Error('Missing Permissions'))
      const thread = makeThread(sendFn)
      const sink = createDiscordStreamSink(thread)
      sink.append('some text')

      // #when / #then — must NOT throw
      const result = await sink.flush()
      expect(result.kind).toBe('error')
    })

    it('returns {kind:"error"} on attachment send failure without throwing', async () => {
      // #given
      const sendFn = vi.fn().mockRejectedValue(new Error('attachment upload failed'))
      const thread = makeThread(sendFn)
      const sink = createDiscordStreamSink(thread)
      sink.append(LONG_TEXT)

      // #when / #then — must NOT throw
      const result = await sink.flush()
      expect(result.kind).toBe('error')
    })

    it('returns {kind:"error"} on empty-output send failure without throwing', async () => {
      // #given
      const sendFn = vi.fn().mockRejectedValue(new Error('rate limited'))
      const thread = makeThread(sendFn)
      const sink = createDiscordStreamSink(thread)

      // #when / #then — must NOT throw
      const result = await sink.flush()
      expect(result.kind).toBe('error')
    })
  })

  describe('allowedMentions invariant — asserted across all send paths', () => {
    it('sHORT path: allowedMentions.parse is an empty array', async () => {
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append('short text')
      await sink.flush()
      const call = firstCallArg<{allowedMentions: {parse: unknown[]}}>(thread._send)
      expect(Array.isArray(call.allowedMentions.parse)).toBe(true)
      expect(call.allowedMentions.parse).toHaveLength(0)
    })

    it('lONG path: allowedMentions.parse is an empty array', async () => {
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append(LONG_TEXT)
      await sink.flush()
      const call = firstCallArg<{allowedMentions: {parse: unknown[]}}>(thread._send)
      expect(Array.isArray(call.allowedMentions.parse)).toBe(true)
      expect(call.allowedMentions.parse).toHaveLength(0)
    })

    it('eMPTY path: allowedMentions.parse is an empty array', async () => {
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      await sink.flush()
      const call = firstCallArg<{allowedMentions: {parse: unknown[]}}>(thread._send)
      expect(Array.isArray(call.allowedMentions.parse)).toBe(true)
      expect(call.allowedMentions.parse).toHaveLength(0)
    })
  })

  describe('buffered()', () => {
    it('returns the current accumulated buffer without side-effects', () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append('alpha')
      sink.append(' beta')

      // #when
      const snapshot = sink.buffered()

      // #then — read-only, no send triggered
      expect(snapshot).toBe('alpha beta')
      expect(thread._send).not.toHaveBeenCalled()
    })
  })

  // ── Unit 4: markVisibleOutputSent — approval status prevents _(no output)_ ──

  // ── Unit 1: hasVisibleOutput() — read-only predicate for visible-output state ──

  describe('hasVisibleOutput()', () => {
    it('returns false on a newly created sink', () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)

      // #when / #then
      expect(sink.hasVisibleOutput()).toBe(false)
    })

    it('returns true after markVisibleOutputSent() is called', () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.markVisibleOutputSent()

      // #when / #then
      expect(sink.hasVisibleOutput()).toBe(true)
    })

    it('flushing an empty buffer does not reset visible-output state to false', async () => {
      // #given — mark visible output, then flush an empty buffer
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.markVisibleOutputSent()
      await sink.flush() // returns skipped-visible; must not reset the flag

      // #when / #then — still true after flush
      expect(sink.hasVisibleOutput()).toBe(true)
    })

    it('flushing buffered text does not reset visible-output state', async () => {
      // #given — mark visible output, append text, flush
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.markVisibleOutputSent()
      sink.append('some output')
      await sink.flush()

      // #when / #then — still true after flush
      expect(sink.hasVisibleOutput()).toBe(true)
    })

    // ── flush() sets hasVisibleOutput — the core missing cases ──

    it('returns true after flush() returns {kind:"sent"}', async () => {
      // #given — short text, no prior markVisibleOutputSent
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append(SHORT_TEXT)

      // #when
      const result = await sink.flush()

      // #then — flush succeeded with sent, so visible output is now true
      expect(result.kind).toBe('sent')
      expect(sink.hasVisibleOutput()).toBe(true)
    })

    it('returns true after flush() returns {kind:"attachment"}', async () => {
      // #given — long text triggers attachment path
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append(LONG_TEXT)

      // #when
      const result = await sink.flush()

      // #then — attachment was sent, so visible output is now true
      expect(result.kind).toBe('attachment')
      expect(sink.hasVisibleOutput()).toBe(true)
    })

    it('remains false after flush() returns {kind:"empty"}', async () => {
      // #given — empty buffer, no prior markVisibleOutputSent
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)

      // #when
      const result = await sink.flush()

      // #then — _(no output)_ is not "visible output" from the agent
      expect(result.kind).toBe('empty')
      expect(sink.hasVisibleOutput()).toBe(false)
    })

    it('remains true after flush() returns {kind:"skipped-visible"}', async () => {
      // #given — visible output already marked, empty buffer
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.markVisibleOutputSent()

      // #when
      const result = await sink.flush()

      // #then — skipped-visible means output was already sent; flag stays true
      expect(result.kind).toBe('skipped-visible')
      expect(sink.hasVisibleOutput()).toBe(true)
    })

    it('remains false after flush() returns {kind:"error"} on a failed send', async () => {
      // #given — send fails; no visible output was actually delivered
      const sendFn = vi.fn().mockRejectedValue(new Error('Missing Permissions'))
      const thread = makeThread(sendFn)
      const sink = createDiscordStreamSink(thread)
      sink.append(SHORT_TEXT)

      // #when
      const result = await sink.flush()

      // #then — error means nothing was delivered; flag stays false
      expect(result.kind).toBe('error')
      expect(sink.hasVisibleOutput()).toBe(false)
    })
  })

  // ── Unit: markVisibleOutputPending() — pending-visibility counter ──

  describe('markVisibleOutputPending()', () => {
    it('happy path: makes hasVisibleOutput() return true immediately before settle', () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)

      // #when — mark pending, do NOT settle yet
      sink.markVisibleOutputPending()

      // #then — pending counts as visible
      expect(sink.hasVisibleOutput()).toBe(true)
    })

    it('happy path: settle(true) keeps hasVisibleOutput() true after pending drops to 0', () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      const settle = sink.markVisibleOutputPending()

      // #when — settle as delivered
      settle(true)

      // #then — permanently visible (visibleOutputSent promoted)
      expect(sink.hasVisibleOutput()).toBe(true)
    })

    it('error path: settle(false) with no other visible output makes hasVisibleOutput() return false', () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      const settle = sink.markVisibleOutputPending()

      // #when — settle as failed
      settle(false)

      // #then — pending retracted, not promoted to delivered
      expect(sink.hasVisibleOutput()).toBe(false)
    })

    it('edge case: two concurrent handles — settle one false keeps hasVisibleOutput() true while other is still pending', () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      const settle1 = sink.markVisibleOutputPending()
      const settle2 = sink.markVisibleOutputPending()

      // #when — settle first as failed
      settle1(false)

      // #then — second is still pending, so still visible
      expect(sink.hasVisibleOutput()).toBe(true)

      // #when — settle second as failed too
      settle2(false)

      // #then — both retracted, no other visible output
      expect(sink.hasVisibleOutput()).toBe(false)
    })

    it('edge case: double-settle is a no-op — pending→settle(false)→settle(false) leaves hasVisibleOutput false (no negative count)', () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      const settle = sink.markVisibleOutputPending()

      // #when — settle twice with false
      settle(false)
      settle(false) // must be a no-op, not decrement again

      // #then — still false, count not negative
      expect(sink.hasVisibleOutput()).toBe(false)
    })

    it('edge case: double-settle — first settle wins; pending→settle(false)→settle(true) does NOT promote to delivered', () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      const settle = sink.markVisibleOutputPending()

      // #when — first settle false, then try to promote with true
      settle(false)
      settle(true) // must be a no-op; first settle already won

      // #then — not promoted to delivered
      expect(sink.hasVisibleOutput()).toBe(false)
    })

    it('integration: empty-buffer flush() after settle(true) returns {kind:"skipped-visible"}', async () => {
      // #given — settle(true) promotes to visibleOutputSent; buffer is empty
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      const settle = sink.markVisibleOutputPending()
      settle(true)

      // #when
      const result = await sink.flush()

      // #then — existing skipped-visible contract still holds
      expect(result.kind).toBe('skipped-visible')
      expect(thread._send).not.toHaveBeenCalled()
    })

    it('fix 1 regression: empty-buffer flush() while send is still PENDING (not yet settled) returns {kind:"skipped-visible"} — does NOT post _(no output)_', async () => {
      // This is the core regression guard for FIX 1.
      // Race: approval send is in-flight (pending) when flush() is called on an empty buffer.
      // Before FIX 1, flush() only checked visibleOutputSent (false) and would post _(no output)_.
      // After FIX 1, flush() also checks pendingVisibleOutput > 0 and returns skipped-visible.
      // #given — pending send in-flight; buffer empty; NOT yet settled
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.markVisibleOutputPending() // increments pendingVisibleOutput; NOT settled

      // #when — flush while send is still pending
      const result = await sink.flush()

      // #then — skipped-visible (pending suppresses _(no output)_)
      expect(result.kind).toBe('skipped-visible')
      // #and — _(no output)_ was NOT sent to Discord
      expect(thread._send).not.toHaveBeenCalled()
    })
  })

  describe('markVisibleOutputSent()', () => {
    it('flush returns {kind:"skipped-visible"} instead of posting _(no output)_ when visible output was already sent', async () => {
      // #given — nothing appended to buffer, but visible output was already posted (e.g. approval status)
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.markVisibleOutputSent()

      // #when
      const result = await sink.flush()

      // #then — no send, kind is skipped-visible (not empty)
      expect(result.kind).toBe('skipped-visible')
      expect(thread._send).not.toHaveBeenCalled()
    })

    it('flush sends buffered text normally even after markVisibleOutputSent (text takes precedence)', async () => {
      // #given — text was appended AND visible output was marked
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.append('agent output here')
      sink.markVisibleOutputSent()

      // #when
      const result = await sink.flush()

      // #then — text is sent normally (not suppressed)
      expect(result.kind).toBe('sent')
      expect(thread._send).toHaveBeenCalledOnce()
      const call = firstCallArg<{content: string}>(thread._send)
      expect(call.content).toBe('agent output here')
    })

    it('flush sends _(no output)_ when buffer is empty and markVisibleOutputSent was NOT called', async () => {
      // #given — nothing appended, no visible output marked
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)

      // #when
      const result = await sink.flush()

      // #then — existing _(no output)_ behavior preserved
      expect(result.kind).toBe('empty')
      expect(thread._send).toHaveBeenCalledOnce()
    })

    it('markVisibleOutputSent is idempotent — calling twice still suppresses _(no output)_', async () => {
      // #given
      const thread = makeThread()
      const sink = createDiscordStreamSink(thread)
      sink.markVisibleOutputSent()
      sink.markVisibleOutputSent()

      // #when
      const result = await sink.flush()

      // #then
      expect(result.kind).toBe('skipped-visible')
      expect(thread._send).not.toHaveBeenCalled()
    })
  })
})
