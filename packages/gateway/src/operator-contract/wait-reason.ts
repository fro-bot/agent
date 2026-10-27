/**
 * Operator-facing wait reason (contract 1.14.0): why a draining `running` run has not finished yet.
 *
 * A closed, kebab-case wire enum carried as an optional sibling of `status` on `OperatorRunStatus`. It is an
 * in-memory overlay on a live run (see `execute/wait-reason-registry.ts`), never a stored field, and it never carries
 * raw text. The internal vocabulary (the completion gate's declined-attempt codes) is imported type-only and mapped
 * through a `satisfies` table, so a new internal code fails compilation until it is given a wire value, while renaming
 * an internal spelling never changes the wire.
 *
 * Several internal codes share one wire value on purpose: an operator needs to know what the run is waiting for, not
 * which of the gate's checks said no.
 *
 * Security: membership is checked against a `Set`, never by indexing a plain object, so `toString`, `constructor` and
 * `__proto__` cannot resolve to prototype members. Unknown or non-string input yields nothing.
 */

import type {DrainRejectCode} from '../execute/drain-completion.js'

/** The closed wire set. Consumers must tolerate values added in later MINOR versions. */
export const OPERATOR_WAIT_REASONS = [
  'agent-working',
  'awaiting-reply',
  'awaiting-background-task',
  'confirming-completion',
] as const

export type OperatorWaitReason = (typeof OPERATOR_WAIT_REASONS)[number]

/**
 * Gate code → wire value. `satisfies Record<DrainRejectCode, …>` is exhaustive over the internal union.
 *
 * - `agent-working`: the root agent is still running, or its liveness could not be read.
 * - `awaiting-reply`: the parent's reply (or the evidence for it) is not persisted or delivered yet.
 * - `awaiting-background-task`: a background task's completion has not been observed or settled.
 * - `confirming-completion`: the gate is re-checking after activity moved the evidence.
 */
export const DRAIN_REJECT_CODE_TO_WAIT_REASON = {
  'root-live': 'agent-working',
  'root-liveness-unavailable': 'agent-working',
  'root-messages-unavailable': 'awaiting-reply',
  'no-root-user-message': 'awaiting-reply',
  'stream-user-message-not-persisted': 'awaiting-reply',
  'latest-root-user-message-unanswered': 'awaiting-reply',
  'reply-text-not-delivered': 'awaiting-reply',
  'notice-not-observed': 'awaiting-background-task',
  'ledger-not-drained': 'awaiting-background-task',
  'revision-drift': 'confirming-completion',
  'idle-evidence-stale': 'confirming-completion',
  'validation-threw': 'confirming-completion',
} satisfies Record<DrainRejectCode, OperatorWaitReason>

const OPERATOR_WAIT_REASON_SET: ReadonlySet<string> = new Set<string>(OPERATOR_WAIT_REASONS)
const DRAIN_REJECT_CODE_SET: ReadonlySet<string> = new Set<string>(Object.keys(DRAIN_REJECT_CODE_TO_WAIT_REASON))

/** Whether `value` is a wire wait reason. */
export function isOperatorWaitReason(value: unknown): value is OperatorWaitReason {
  return typeof value === 'string' && OPERATOR_WAIT_REASON_SET.has(value)
}

/** Maps a gate code to its wire value; anything else (unknown string, non-string) yields `undefined`. */
export function toOperatorWaitReason(code: unknown): OperatorWaitReason | undefined {
  if (typeof code !== 'string' || DRAIN_REJECT_CODE_SET.has(code) === false) return undefined
  return (DRAIN_REJECT_CODE_TO_WAIT_REASON as Record<string, OperatorWaitReason>)[code]
}
