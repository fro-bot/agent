/**
 * Run-state reaction helper for Discord mention runs.
 *
 * Provides a glanceable reaction on the triggering message reflecting the
 * current run state. This is a secondary affordance — API failures MUST
 * NEVER halt execution or propagate to callers.
 *
 * Emoji map:
 *   working          → ⏳  (run is in progress)
 *   succeeded        → ✅  (run completed successfully)
 *   failed           → ❌  (run failed)
 *   awaiting-approval → ⏸️  (run is waiting for tool approval)
 *
 * Design:
 * - Each call to `setRunReaction` clears all prior reactions on the message
 *   before adding the new one, so the message never accumulates stale cues.
 * - Every Discord API call is wrapped in its own try/catch so the exported
 *   method resolves to void and NEVER rejects.
 * - Failures are logged at warn level (not silently swallowed).
 */

import type {Message} from 'discord.js'

import type {GatewayLogger} from './client.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The set of run states that can be reflected as a reaction. */
export type RunReactionState = keyof typeof REACTION_EMOJIS

// ---------------------------------------------------------------------------
// Emoji map
// ---------------------------------------------------------------------------

/**
 * Standard unicode emoji per run state.
 * No custom emoji — but note: `setRunReaction` calls `message.reactions.removeAll()`,
 * which DOES require the `ManageMessages` permission. Without it the removeAll call
 * will fail (the catch logs a warn and reactions may accumulate), but execution continues.
 */
export const REACTION_EMOJIS = {
  working: '⏳',
  succeeded: '✅',
  failed: '❌',
  'awaiting-approval': '⏸️',
} as const

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set a run-state reaction on the triggering message.
 *
 * Clears all existing reactions first (replace, not accumulate), then adds
 * the emoji for the given state.
 *
 * CATCH BOUNDARY: every Discord API call is wrapped in its own try/catch.
 * This method resolves to void and NEVER rejects. Failures are logged at warn.
 *
 * @param message - The triggering Discord message to react on.
 * @param state   - The run state to reflect.
 * @param logger  - Gateway logger for failure logging.
 */
export async function setRunReaction(message: Message, state: RunReactionState, logger: GatewayLogger): Promise<void> {
  // Step 1: clear prior reactions (best-effort)
  try {
    await message.reactions.removeAll()
  } catch (error: unknown) {
    logger.warn({state, err: String(error)}, 'reactions: failed to remove prior reactions (best-effort)')
    // Do not return — still attempt to add the new reaction
  }

  // Step 2: add the new state reaction (best-effort)
  const emoji = REACTION_EMOJIS[state]
  try {
    await message.react(emoji)
  } catch (error: unknown) {
    logger.warn({state, emoji, err: String(error)}, 'reactions: failed to add state reaction (best-effort)')
  }
}
