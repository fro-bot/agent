/**
 * Operator-facing provider failure reason (contract 1.12.0).
 *
 * A closed, kebab-case wire enum carried as a sibling of `failureKind` on `RunSummary` and
 * `OperatorRunStatus`. It says WHY a `session-error` run failed at the provider, which `failureKind`
 * alone cannot express (every provider failure collapses to `session-error`).
 *
 * Decoupling: the wire values are a contract of their own. The internal vocabulary
 * (`execute/provider-failure.ts`) is imported type-only and mapped through a `satisfies` table, so a new
 * internal reason fails compilation until it is given a wire value, while renaming an internal spelling
 * never changes the wire.
 *
 * Security: the enum is fixed values with no provider-controlled or user text. Membership is checked
 * against a `Set`, never by indexing a plain object — indexing would let `toString`, `constructor` and
 * `__proto__` resolve to prototype members.
 */

import type {RunPhase} from '@fro-bot/runtime'
import type {ProviderFailureReason} from '../execute/provider-failure.js'

/**
 * The closed wire set of provider failure reasons.
 *
 * `unclassified` is the wire value for the internal catch-all (`session error`): a provider failure
 * with no more specific cause. Consumers must tolerate values added in later MINOR versions.
 */
export type OperatorProviderFailureReason =
  'provider-auth-unavailable' | 'model-not-available' | 'provider-rejected-request' | 'unclassified'

/**
 * Internal `ProviderFailureReason` → wire value.
 *
 * `satisfies Record<ProviderFailureReason, …>` is exhaustive over the internal union: adding an internal
 * reason without a wire entry here is a compile error.
 */
export const PROVIDER_FAILURE_REASON_TO_OPERATOR = {
  'provider auth unavailable': 'provider-auth-unavailable',
  'model not available': 'model-not-available',
  'model provider rejected the request': 'provider-rejected-request',
  'session error': 'unclassified',
} satisfies Record<ProviderFailureReason, OperatorProviderFailureReason>

const OPERATOR_PROVIDER_FAILURE_REASONS: ReadonlySet<string> = new Set<OperatorProviderFailureReason>(
  Object.values(PROVIDER_FAILURE_REASON_TO_OPERATOR),
)

/** Map an internal provider failure reason to its wire value. Total over the internal union. */
export function toOperatorProviderFailureReason(reason: ProviderFailureReason): OperatorProviderFailureReason {
  return PROVIDER_FAILURE_REASON_TO_OPERATOR[reason]
}

/**
 * Parse an untrusted stored value into the wire enum.
 *
 * Returns the value only when it is exactly one of the known wire strings; anything else (absent, wrong
 * type, different casing, the internal spaced spelling, an unknown string, a prototype key) is `undefined`.
 * There is no sentinel: absence already means "no further detail".
 */
export function parseOperatorProviderFailureReason(value: unknown): OperatorProviderFailureReason | undefined {
  if (typeof value !== 'string' || OPERATOR_PROVIDER_FAILURE_REASONS.has(value) === false) {
    return undefined
  }
  return value as OperatorProviderFailureReason
}

/**
 * The projection gate for a stored reason: the value reaches an operator DTO only when ALL three hold.
 *
 * 1. the run is `FAILED` (a reason on any other phase is tampered or stale),
 * 2. the INTERNAL stored `failureKind` is exactly `'session-error'` (the only kind a reason refines), and
 * 3. the stored value parses as a known wire reason.
 *
 * Otherwise `undefined`: the field is omitted and the row is kept. Takes the individual candidate values,
 * never a details object, so it cannot read any other key.
 */
export function projectProviderFailureReason(
  phase: RunPhase,
  storedFailureKind: unknown,
  storedReason: unknown,
): OperatorProviderFailureReason | undefined {
  if (phase !== 'FAILED' || storedFailureKind !== 'session-error') {
    return undefined
  }
  return parseOperatorProviderFailureReason(storedReason)
}
