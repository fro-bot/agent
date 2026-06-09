/**
 * Per-run status message + typing pulse controller.
 *
 * Owns one editable Discord status message and a typing indicator pulse.
 * Created once per mention run; disposed in the run's `finally` block.
 *
 * Modes:
 * - `live-status` (default): posts a single editable status message that updates on a
 *   debounced cadence while the agent works, then transitions into the final answer.
 * - `typing-only`: suppresses the status message entirely; only the typing indicator is shown.
 *
 * All Discord I/O is fail-soft: rejections are caught + logged and never abort the run.
 */

import type {GatewayLogger} from './client.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce interval for status message edits (ms). Keeps edits within Discord rate limits. */
export const STATUS_DEBOUNCE_MS = 1500

/** Typing indicator re-pulse interval (ms). Discord typing auto-expires ~10s; pulse at ~7s. */
export const STATUS_TYPING_PULSE_MS = 7000

/** Discord's hard content-length limit for a single message. */
const DISCORD_MESSAGE_CHAR_LIMIT = 2000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal thread interface required by the status controller.
 * Typed narrowly so test doubles don't need the full `ThreadChannel` API.
 */
export interface StatusThread {
  readonly send: (options: {readonly content: string}) => Promise<StatusMessage>
  readonly sendTyping: () => Promise<void>
}

/**
 * Minimal message interface for the posted status message.
 * Typed narrowly for testability.
 */
export interface StatusMessage {
  readonly edit: (options: {readonly content: string}) => Promise<unknown>
  readonly delete: () => Promise<unknown>
}

/** Discriminated result of a resolve call. */
export type TransitionResult = {readonly transition: 'handled'} | {readonly transition: 'delegated'}

/** The controller returned by `createStatusController`. */
export interface StatusController {
  /**
   * Record an essential-action summary and schedule a debounced status edit.
   * First call posts the initial status message; subsequent calls edit it.
   * In `typing-only` mode, this is a no-op (no message posted).
   */
  readonly noteActivity: (summary: string) => void
  /**
   * Start or stop the typing indicator pulse.
   * - `true`: immediately sends typing and schedules re-pulse every ~7s.
   * - `false`: clears the pulse interval (e.g. during an approval wait).
   * Runs in BOTH modes (typing pulses even in typing-only).
   */
  readonly setBusy: (busy: boolean) => void
  /**
   * Settle, then resolve the status message into the final answer.
   * - `handled`: controller edited the status message into the answer (caller does nothing more).
   * - `delegated`: caller must post the answer via the sink (status deleted or never existed).
   *
   * Conditions for `handled`: live-status mode AND a status message exists AND
   * the answer is non-empty, non-whitespace, and fits one Discord message (≤2000 chars).
   * All other cases → `delegated`.
   */
  readonly resolveToAnswer: (text: string) => Promise<TransitionResult>
  /**
   * Settle, then resolve the status message into a failure note.
   * - `handled`: controller edited the status message into the note (caller does nothing more).
   * - `delegated`: caller must post the failure note via safeSend (no status to edit, or typing-only).
   *
   * Never both edits and delegates.
   */
  readonly resolveToFailure: (note: string) => Promise<TransitionResult>
  /**
   * Settle (cancel debounce, await in-flight edit), then clear all timers.
   * Idempotent. No edits or pulses fire after dispose.
   */
  readonly dispose: () => Promise<void>
}

/** Dependencies injected into the factory. */
export interface StatusControllerDeps {
  readonly thread: StatusThread
  readonly mode: 'live-status' | 'typing-only'
  readonly logger: GatewayLogger
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Aggregate activity summaries into a human-readable status line.
 * Counts occurrences of key action verbs and formats them as a compact summary.
 * e.g. `⏳ Working… edited 2 files · ran 1 command`
 */
function buildStatusContent(summaries: readonly string[]): string {
  if (summaries.length === 0) {
    return '⏳ Working…'
  }

  // Count by action verb (first word of each summary)
  const counts = new Map<string, number>()
  for (const summary of summaries) {
    const verb = summary.trim().split(/\s+/)[0] ?? 'worked'
    counts.set(verb, (counts.get(verb) ?? 0) + 1)
  }

  const parts: string[] = []
  for (const [verb, count] of counts) {
    parts.push(`${verb} ${count} ${count === 1 ? 'time' : 'times'}`)
  }

  return `⏳ Working… ${parts.join(' · ')}`
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a per-run status message + typing pulse controller.
 *
 * Usage:
 * ```ts
 * const ctrl = createStatusController({ thread, mode: config.statusMode, logger })
 * ctrl.setBusy(true)
 * ctrl.noteActivity('edited 1 file')
 * const result = await ctrl.resolveToAnswer(finalText)
 * // if result.transition === 'delegated': post via sink
 * await ctrl.dispose() // in finally
 * ```
 */
export function createStatusController(deps: StatusControllerDeps): StatusController {
  const {thread, mode, logger} = deps

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** The posted status message, if any. */
  let statusMessage: StatusMessage | null = null

  /** Accumulated activity summaries since last edit. */
  const activitySummaries: string[] = []

  /** Pending debounce timer ID. */
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  /** In-flight edit promise (awaited during settle). */
  let inFlightEdit: Promise<unknown> | null = null

  /** Typing pulse interval ID. */
  let typingInterval: ReturnType<typeof setInterval> | null = null

  /** Whether the controller has been disposed. */
  let disposed = false

  // -------------------------------------------------------------------------
  // Fail-soft Discord I/O wrappers
  // -------------------------------------------------------------------------

  async function safePost(content: string): Promise<StatusMessage | null> {
    try {
      const msg = await thread.send({content})
      return msg
    } catch (error) {
      logger.warn({err: String(error)}, 'status-message: failed to post status message')
      return null
    }
  }

  async function safeEdit(msg: StatusMessage, content: string): Promise<void> {
    try {
      await msg.edit({content})
    } catch (error) {
      logger.warn({err: String(error)}, 'status-message: failed to edit status message')
    }
  }

  async function safeDelete(msg: StatusMessage): Promise<void> {
    try {
      await msg.delete()
    } catch (error) {
      logger.warn({err: String(error)}, 'status-message: failed to delete status message')
    }
  }

  async function safeSendTyping(): Promise<void> {
    try {
      await thread.sendTyping()
    } catch (error) {
      logger.warn({err: String(error)}, 'status-message: failed to send typing indicator')
    }
  }

  // -------------------------------------------------------------------------
  // Debounced status update
  // -------------------------------------------------------------------------

  function scheduleDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (disposed === true) {
        return
      }
      // eslint-disable-next-line no-void
      void performStatusUpdate()
    }, STATUS_DEBOUNCE_MS)
  }

  async function performStatusUpdate(): Promise<void> {
    const content = buildStatusContent(activitySummaries)

    if (statusMessage === null) {
      // First update — post the initial status message
      const posted = await safePost(content)
      statusMessage = posted
    } else {
      // Subsequent update — edit the existing message
      const msg = statusMessage
      inFlightEdit = safeEdit(msg, content)
      try {
        await inFlightEdit
      } finally {
        inFlightEdit = null
      }
    }
  }

  // -------------------------------------------------------------------------
  // Settle phase — cancel debounce + await in-flight edit
  // -------------------------------------------------------------------------

  async function settle(): Promise<void> {
    // Cancel any pending debounce timer
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    // Await any in-flight edit so it can't land after the final message
    if (inFlightEdit !== null) {
      await inFlightEdit
      inFlightEdit = null
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const noteActivity = (summary: string): void => {
    if (disposed === true) {
      return
    }
    if (mode === 'typing-only') {
      // typing-only: no status message posted
      return
    }
    activitySummaries.push(summary)
    scheduleDebounce()
  }

  const setBusy = (busy: boolean): void => {
    if (busy === true) {
      // Clear any existing interval first (idempotent start)
      if (typingInterval !== null) {
        clearInterval(typingInterval)
        typingInterval = null
      }
      // Immediately send typing
      // eslint-disable-next-line no-void
      void safeSendTyping()
      // Schedule re-pulse
      typingInterval = setInterval(() => {
        if (disposed === true) {
          if (typingInterval !== null) {
            clearInterval(typingInterval)
            typingInterval = null
          }
          return
        }
        // eslint-disable-next-line no-void
        void safeSendTyping()
      }, STATUS_TYPING_PULSE_MS)
    } else if (typingInterval !== null) {
      // Stop pulsing
      clearInterval(typingInterval)
      typingInterval = null
    }
  }

  const resolveToAnswer = async (text: string): Promise<TransitionResult> => {
    await settle()

    if (disposed === true) {
      return {transition: 'delegated'}
    }

    // typing-only mode: always delegate
    if (mode === 'typing-only') {
      return {transition: 'delegated'}
    }

    // No status message posted yet: delegate
    if (statusMessage === null) {
      return {transition: 'delegated'}
    }

    const trimmed = text.trim()

    // Empty/whitespace answer: delete status and delegate
    if (trimmed.length === 0) {
      await safeDelete(statusMessage)
      statusMessage = null
      return {transition: 'delegated'}
    }

    // Long answer (>2000 chars): delete status and delegate
    if (text.length > DISCORD_MESSAGE_CHAR_LIMIT) {
      await safeDelete(statusMessage)
      statusMessage = null
      return {transition: 'delegated'}
    }

    // Short answer that fits: edit in place
    await safeEdit(statusMessage, text)
    return {transition: 'handled'}
  }

  const resolveToFailure = async (note: string): Promise<TransitionResult> => {
    await settle()

    if (disposed === true) {
      return {transition: 'delegated'}
    }

    // typing-only mode: always delegate
    if (mode === 'typing-only') {
      return {transition: 'delegated'}
    }

    // No status message: delegate (caller posts via safeSend)
    if (statusMessage === null) {
      return {transition: 'delegated'}
    }

    // Status message exists: edit into the failure note
    await safeEdit(statusMessage, note)
    return {transition: 'handled'}
  }

  const dispose = async (): Promise<void> => {
    if (disposed === true) {
      return
    }
    disposed = true

    // Settle: cancel debounce + await in-flight edit
    await settle()

    // Clear typing interval
    if (typingInterval !== null) {
      clearInterval(typingInterval)
      typingInterval = null
    }
  }

  return {noteActivity, setBusy, resolveToAnswer, resolveToFailure, dispose}
}
