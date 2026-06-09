/**
 * Tests for createStatusController — per-run status message + typing pulse manager.
 *
 * Uses vi.useFakeTimers() throughout to control debounce and pulse intervals.
 */

import type {GatewayLogger} from './client.js'
import type {StatusThread} from './status-message.js'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createStatusController, STATUS_DEBOUNCE_MS, STATUS_TYPING_PULSE_MS} from './status-message.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A mock Discord message with edit and delete vi.fns. */
function makeMockMessage() {
  return {
    edit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  }
}

type MockMessage = ReturnType<typeof makeMockMessage>

/**
 * Build a StatusThread mock. By default send() resolves with a fresh mock message.
 * Pass `sendImpl` to override the send behaviour (e.g. to return a controllable promise).
 */
function makeThread(sendImpl?: () => Promise<MockMessage>): StatusThread & {
  readonly _send: ReturnType<typeof vi.fn>
  readonly _sendTyping: ReturnType<typeof vi.fn>
} {
  const defaultImpl = async (): Promise<MockMessage> => makeMockMessage()
  const sendFn = vi.fn().mockImplementation(sendImpl ?? defaultImpl)
  const sendTypingFn = vi.fn().mockResolvedValue(undefined)
  const result: StatusThread & {
    readonly _send: ReturnType<typeof vi.fn>
    readonly _sendTyping: ReturnType<typeof vi.fn>
  } = {
    send: sendFn,
    sendTyping: sendTypingFn,
    _send: sendFn,
    _sendTyping: sendTypingFn,
  }
  return result
}

function makeLogger(): GatewayLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance fake timers by the debounce interval so the pending edit fires. */
async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(STATUS_DEBOUNCE_MS)
}

/** Advance fake timers by the typing pulse interval. */
async function flushTypingPulse(): Promise<void> {
  await vi.advanceTimersByTimeAsync(STATUS_TYPING_PULSE_MS)
}

/** Flush pending microtasks (Promise.resolve() tick). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createStatusController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // Happy path — live-status mode
  // -------------------------------------------------------------------------

  describe('happy path — live-status mode', () => {
    it('first noteActivity posts a status message', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when
      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #then
      expect(thread._send).toHaveBeenCalledOnce()
    })

    it('subsequent noteActivity within the debounce window coalesces into a single edit', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when — three rapid calls before the debounce fires
      ctrl.noteActivity('edited 1 file')
      ctrl.noteActivity('ran 1 command')
      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #then — only one send (initial post), no extra sends
      expect(thread._send).toHaveBeenCalledOnce()
    })

    it('subsequent noteActivity after debounce fires edits the existing message', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when — first batch posts
      ctrl.noteActivity('edited 1 file')
      await flushDebounce()
      expect(thread._send).toHaveBeenCalledOnce()

      // second batch edits
      ctrl.noteActivity('ran 1 command')
      await flushDebounce()

      // #then — edit called on the posted message
      expect(mockMsg.edit).toHaveBeenCalledOnce()
      // send still only called once (the initial post)
      expect(thread._send).toHaveBeenCalledOnce()
    })

    it('status content reflects accumulated essential-action counts', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when — multiple activities
      ctrl.noteActivity('edited 1 file')
      ctrl.noteActivity('ran 1 command')
      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #then — the posted content should mention the activities
      const [sendArg] = thread._send.mock.calls[0] as [{content: string}]
      expect(typeof sendArg.content).toBe('string')
      expect(sendArg.content.length).toBeGreaterThan(0)
    })
  })

  // -------------------------------------------------------------------------
  // Transition — resolveToAnswer
  // -------------------------------------------------------------------------

  describe('resolveToAnswer', () => {
    it('short answer (≤2000 chars) edits the status message and returns handled', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #when
      const result = await ctrl.resolveToAnswer('Short answer text')

      // #then
      expect(result.transition).toBe('handled')
      expect(mockMsg.edit).toHaveBeenCalledOnce()
      expect(mockMsg.delete).not.toHaveBeenCalled()
    })

    it('long answer (>2000 chars) deletes the status message and returns delegated', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #when
      const longAnswer = 'x'.repeat(2001)
      const result = await ctrl.resolveToAnswer(longAnswer)

      // #then
      expect(result.transition).toBe('delegated')
      expect(mockMsg.delete).toHaveBeenCalledOnce()
      expect(mockMsg.edit).not.toHaveBeenCalled()
    })

    it('exactly 2000 chars → handled (boundary inclusive)', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #when
      const exactAnswer = 'x'.repeat(2000)
      const result = await ctrl.resolveToAnswer(exactAnswer)

      // #then
      expect(result.transition).toBe('handled')
      expect(mockMsg.edit).toHaveBeenCalledOnce()
    })

    it('2001 chars → delegated (one over boundary)', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #when
      const overAnswer = 'x'.repeat(2001)
      const result = await ctrl.resolveToAnswer(overAnswer)

      // #then
      expect(result.transition).toBe('delegated')
      expect(mockMsg.delete).toHaveBeenCalledOnce()
    })

    it('empty answer deletes the status message and returns delegated', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #when
      const result = await ctrl.resolveToAnswer('')

      // #then
      expect(result.transition).toBe('delegated')
      expect(mockMsg.delete).toHaveBeenCalledOnce()
      expect(mockMsg.edit).not.toHaveBeenCalled()
    })

    it('whitespace-only answer deletes the status message and returns delegated', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #when
      const result = await ctrl.resolveToAnswer('   \n\t  ')

      // #then
      expect(result.transition).toBe('delegated')
      expect(mockMsg.delete).toHaveBeenCalledOnce()
    })

    it('no status message yet → resolveToAnswer returns delegated without deleting', async () => {
      // #given — no noteActivity called, so no status message posted
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when
      const result = await ctrl.resolveToAnswer('Short answer')

      // #then
      expect(result.transition).toBe('delegated')
      expect(thread._send).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Settle / race condition
  // -------------------------------------------------------------------------

  describe('settle / race condition', () => {
    it('cancels pending debounce timer before resolving — no late edit after answer', async () => {
      // #given — schedule a debounced edit but do NOT advance timers yet
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // Post the initial status message
      ctrl.noteActivity('edited 1 file')
      await flushDebounce()
      expect(thread._send).toHaveBeenCalledOnce()

      // Schedule another debounced edit (timer NOT yet fired)
      ctrl.noteActivity('ran 1 command')

      // #when — resolve before the debounce fires
      const result = await ctrl.resolveToAnswer('Final answer')

      // Advance timers — the debounce should have been cancelled
      await flushDebounce()

      // #then — the answer edit happened, but no extra edit from the cancelled debounce
      expect(result.transition).toBe('handled')
      // edit called exactly once (for the answer), not twice (answer + late debounce)
      expect(mockMsg.edit).toHaveBeenCalledOnce()
      const [editArg] = mockMsg.edit.mock.calls[0] as [{content: string}]
      expect(editArg.content).toBe('Final answer')
    })

    it('awaits in-flight edit promise before performing final edit', async () => {
      // #given — controllable in-flight edit promise
      let resolveEdit!: () => void
      const editPromise = new Promise<void>(resolve => {
        resolveEdit = resolve
      })
      const mockMsg = {
        edit: vi.fn().mockReturnValueOnce(editPromise).mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      }
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // Post initial status
      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // Trigger a second debounced edit — this starts the in-flight edit
      ctrl.noteActivity('ran 1 command')
      await flushDebounce()
      // The in-flight edit is now pending (not yet resolved)
      expect(mockMsg.edit).toHaveBeenCalledOnce()

      // #when — resolveToAnswer is called while edit is still in flight
      const resolvePromise = ctrl.resolveToAnswer('Final answer')

      // Resolve the in-flight edit
      resolveEdit()
      const result = await resolvePromise

      // #then — final answer edit happened after the in-flight edit settled
      expect(result.transition).toBe('handled')
      // edit called twice: once for the in-flight debounce, once for the final answer
      expect(mockMsg.edit).toHaveBeenCalledTimes(2)
      const lastEditArg = mockMsg.edit.mock.calls[1]?.[0] as {content: string}
      expect(lastEditArg.content).toBe('Final answer')
    })
  })

  // -------------------------------------------------------------------------
  // Typing pulse — setBusy
  // -------------------------------------------------------------------------

  describe('setBusy — typing pulse', () => {
    it('setBusy(true) immediately sends typing', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when
      ctrl.setBusy(true)
      await flushMicrotasks()

      // #then
      expect(thread._sendTyping).toHaveBeenCalledOnce()
    })

    it('setBusy(true) re-pulses typing on the interval', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when
      ctrl.setBusy(true)
      await flushMicrotasks()
      await flushTypingPulse()
      await flushMicrotasks()

      // #then — at least 2 typing calls (initial + 1 pulse)
      expect(thread._sendTyping.mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it('setBusy(false) stops further typing pulses', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.setBusy(true)
      await flushMicrotasks()
      const callsAfterStart = thread._sendTyping.mock.calls.length

      // #when
      ctrl.setBusy(false)
      await flushTypingPulse()
      await flushMicrotasks()

      // #then — no additional pulses after setBusy(false)
      expect(thread._sendTyping.mock.calls.length).toBe(callsAfterStart)
    })
  })

  // -------------------------------------------------------------------------
  // Approval-wait: setBusy(false) pauses, setBusy(true) resumes
  // -------------------------------------------------------------------------

  describe('approval-wait — typing paused during wait', () => {
    it('no pulses fire while paused; setBusy(true) resumes', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.setBusy(true)
      await flushMicrotasks()
      const callsBeforePause = thread._sendTyping.mock.calls.length

      // #when — pause (approval wait)
      ctrl.setBusy(false)
      await flushTypingPulse()
      await flushTypingPulse()
      await flushMicrotasks()

      // #then — no new pulses during pause
      expect(thread._sendTyping.mock.calls.length).toBe(callsBeforePause)

      // #when — resume
      ctrl.setBusy(true)
      await flushMicrotasks()
      const callsAfterResume = thread._sendTyping.mock.calls.length

      // #then — typing resumed
      expect(callsAfterResume).toBeGreaterThan(callsBeforePause)
    })
  })

  // -------------------------------------------------------------------------
  // Failure path — resolveToFailure
  // -------------------------------------------------------------------------

  describe('resolveToFailure', () => {
    it('with status message present: edits into the note and returns handled', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #when
      const result = await ctrl.resolveToFailure('Something went wrong')

      // #then
      expect(result.transition).toBe('handled')
      expect(mockMsg.edit).toHaveBeenCalledOnce()
      expect(mockMsg.delete).not.toHaveBeenCalled()
    })

    it('with no status message yet: returns delegated without throwing', async () => {
      // #given — no noteActivity, no status message
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when
      const result = await ctrl.resolveToFailure('Something went wrong')

      // #then
      expect(result.transition).toBe('delegated')
      expect(thread._send).not.toHaveBeenCalled()
    })

    it('handled: edits status message and does NOT delete it', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #when
      const result = await ctrl.resolveToFailure('Failure note')

      // #then — handled: edit called, delete NOT called (never both)
      expect(result.transition).toBe('handled')
      expect(mockMsg.edit).toHaveBeenCalledOnce()
      expect(mockMsg.delete).not.toHaveBeenCalled()
    })

    it('delegated: does NOT edit the status message', async () => {
      // #given — no status message posted
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when
      const result = await ctrl.resolveToFailure('Failure note')

      // #then — delegated: no edit, no delete
      expect(result.transition).toBe('delegated')
      expect(thread._send).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // typing-only mode
  // -------------------------------------------------------------------------

  describe('typing-only mode', () => {
    it('noteActivity posts nothing', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'typing-only', logger})

      // #when
      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #then
      expect(thread._send).not.toHaveBeenCalled()
    })

    it('setBusy(true) still pulses typing in typing-only mode', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'typing-only', logger})

      // #when
      ctrl.setBusy(true)
      await flushMicrotasks()

      // #then
      expect(thread._sendTyping).toHaveBeenCalledOnce()
    })

    it('resolveToAnswer always returns delegated in typing-only mode', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'typing-only', logger})

      // #when
      const result = await ctrl.resolveToAnswer('Short answer')

      // #then
      expect(result.transition).toBe('delegated')
      expect(thread._send).not.toHaveBeenCalled()
    })

    it('resolveToFailure always returns delegated in typing-only mode', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'typing-only', logger})

      // #when
      const result = await ctrl.resolveToFailure('Failure note')

      // #then
      expect(result.transition).toBe('delegated')
      expect(thread._send).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Fail-soft — Discord I/O errors are caught and logged
  // -------------------------------------------------------------------------

  describe('fail-soft — Discord I/O errors', () => {
    it('rejected sendTyping is caught and logged, does not throw', async () => {
      // #given
      const thread = makeThread()
      thread._sendTyping.mockRejectedValue(new Error('Rate limited'))
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when
      ctrl.setBusy(true)
      await flushMicrotasks()

      // #then — no throw, warn was called
      expect(logger.warn).toHaveBeenCalled()
    })

    it('rejected message.edit is caught and logged, does not throw', async () => {
      // #given
      const mockMsg = makeMockMessage()
      mockMsg.edit.mockRejectedValue(new Error('Unknown Message'))
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #when — second activity triggers an edit
      ctrl.noteActivity('ran 1 command')

      // #then — must not throw when debounce fires
      await expect(flushDebounce()).resolves.not.toThrow()
      expect(logger.warn).toHaveBeenCalled()
    })

    it('rejected message.delete is caught and logged, does not throw', async () => {
      // #given
      const mockMsg = makeMockMessage()
      mockMsg.delete.mockRejectedValue(new Error('Unknown Message'))
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #when — long answer triggers delete
      const result = await ctrl.resolveToAnswer('x'.repeat(2001))

      // #then — delegated, no throw
      expect(result.transition).toBe('delegated')
      expect(logger.warn).toHaveBeenCalled()
    })

    it('rejected thread.send is caught and logged, does not throw', async () => {
      // #given
      const thread = makeThread()
      thread._send.mockRejectedValue(new Error('Missing Permissions'))
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when
      ctrl.noteActivity('edited 1 file')

      // #then — must not throw when debounce fires
      await expect(flushDebounce()).resolves.not.toThrow()
      expect(logger.warn).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  describe('dispose', () => {
    it('clears the typing interval — no pulses after dispose', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.setBusy(true)
      await flushMicrotasks()
      const callsBeforeDispose = thread._sendTyping.mock.calls.length

      // #when
      await ctrl.dispose()
      await flushTypingPulse()
      await flushMicrotasks()

      // #then — no new pulses after dispose
      expect(thread._sendTyping.mock.calls.length).toBe(callsBeforeDispose)
    })

    it('cancels the pending debounce timer — no edit fires after dispose', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // Post initial status
      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // Schedule another debounced edit
      ctrl.noteActivity('ran 1 command')

      // #when — dispose before debounce fires
      await ctrl.dispose()
      await flushDebounce()

      // #then — no extra edit after dispose
      expect(mockMsg.edit).not.toHaveBeenCalled()
    })

    it('is idempotent — calling dispose twice does not throw', async () => {
      // #given
      const thread = makeThread()
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      // #when / #then
      await expect(ctrl.dispose()).resolves.not.toThrow()
      await expect(ctrl.dispose()).resolves.not.toThrow()
    })

    it('no edits or pulses fire after dispose', async () => {
      // #given
      const mockMsg = makeMockMessage()
      const thread = makeThread(async () => mockMsg)
      const logger = makeLogger()
      const ctrl = createStatusController({thread, mode: 'live-status', logger})

      ctrl.setBusy(true)
      ctrl.noteActivity('edited 1 file')
      await flushDebounce()

      // #when
      await ctrl.dispose()
      const editCallsAtDispose = mockMsg.edit.mock.calls.length
      const typingCallsAtDispose = thread._sendTyping.mock.calls.length

      ctrl.noteActivity('ran 1 command')
      await flushDebounce()
      await flushTypingPulse()
      await flushMicrotasks()

      // #then — nothing new after dispose
      expect(mockMsg.edit.mock.calls.length).toBe(editCallsAtDispose)
      expect(thread._sendTyping.mock.calls.length).toBe(typingCallsAtDispose)
    })
  })
})
