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
