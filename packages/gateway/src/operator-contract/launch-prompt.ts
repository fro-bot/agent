import type {Surface} from '@fro-bot/runtime'

/**
 * Launch prompt bound for `POST /operator/runs` and `RunSummary.prompt` (contract 1.12.0).
 *
 * The stored value and the contract field share one bound, and nothing is ever truncated: an over-bound
 * prompt is rejected at launch with a 400 and the typed reason below.
 */

/**
 * Maximum launch prompt length, counted in UTF-16 code units (`String.prototype.length`), so a client
 * must count with `.length` — not code points or bytes. 4,001 emoji is 8,002 units and is over the bound.
 *
 * RAISE-ONLY: this bound may be increased but never lowered. A lowered bound would make `toRunSummary`
 * silently drop previously stored prompts that are now over it.
 */
export const OPERATOR_LAUNCH_PROMPT_MAX_LENGTH = 8_000

/** Typed 400 reason for a launch prompt longer than {@link OPERATOR_LAUNCH_PROMPT_MAX_LENGTH}. */
export const OPERATOR_LAUNCH_PROMPT_TOO_LONG = 'prompt-too-long'

/** The typed `reason` on the 400 `{error: 'bad request', reason}` launch response. */
export type OperatorLaunchPromptRejectionReason = typeof OPERATOR_LAUNCH_PROMPT_TOO_LONG

/**
 * The projection gate for a stored launch prompt: it reaches `RunSummary.prompt` only when ALL hold.
 *
 * 1. the run's surface is `web` (only the operator launch route stores a prompt; a value on any other
 *    surface is stale or tampered),
 * 2. the stored value is a string, non-empty, and within {@link OPERATOR_LAUNCH_PROMPT_MAX_LENGTH}.
 *
 * Otherwise `undefined`: the field is omitted and the row is kept. The value is never sliced.
 */
export function projectOperatorLaunchPrompt(surface: Surface, stored: unknown): string | undefined {
  if (
    surface !== 'web' ||
    typeof stored !== 'string' ||
    stored.length === 0 ||
    stored.length > OPERATOR_LAUNCH_PROMPT_MAX_LENGTH
  ) {
    return undefined
  }
  return stored
}
