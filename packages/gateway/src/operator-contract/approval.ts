/**
 * Approval-decision contract for the operator API surface.
 *
 * This module is the **sole definer** of `PermissionReply`.
 * `packages/gateway/src/approvals/coordinator.ts` re-exports it from here
 * (not re-declares it) so all 9 existing import sites continue to resolve
 * `PermissionReply` from `coordinator.js` unchanged — a seam for incremental
 * migration to direct contract imports in a future pass.
 *
 * ### v1.1 promotion candidates (kept in coordinator.ts for v1 to bound fan-out)
 * - `PermissionRequest`    (11-file fan-out)
 * - `PermissionReplyEvent` (2-file fan-out)
 * - `SettlementReason`     (5-file fan-out)
 */

import type {ApprovalActor, DecisionOutcome} from '../approvals/registry.js'

// ---------------------------------------------------------------------------
// PermissionReply — sole definer (coordinator.ts re-exports from here)
// ---------------------------------------------------------------------------

/** Reply verbs accepted by the OpenCode permission reply endpoint. */
export type PermissionReply = 'once' | 'always' | 'reject'

// ---------------------------------------------------------------------------
// OperatorDecisionState — operator-facing decision-state set
// ---------------------------------------------------------------------------

/**
 * Operator-facing decision states for an approval entry.
 *
 * - `pending`         — implied pre-decision state: entry is open, no `DecisionOutcome` yet.
 *                       NOT produced by `toOperatorDecisionState` (which maps `DecisionOutcome`
 *                       values only); it is the state before any outcome exists.
 * - `claimed`         — decision was accepted and the reply was POSTed successfully (`ok`).
 * - `already_claimed` — a second decision arrived while the first POST was still in-flight;
 *                       the entry has NOT settled yet (NOT `already_settled`).
 * - `scope_mismatch`  — the `approvalScopeId` in the decision did not match the registered entry.
 * - `failed_to_settle`— the reply POST failed (threw or returned `ok:false`).
 * - `unavailable`     — no entry found for the given `requestID`.
 *
 * Note: `expired` is NOT in this set. It is a deadline/settlement-path state
 * (`SettlementReason 'deadline'`), not a `DecisionOutcome`; if exposed at all
 * it is derived separately from the deadline path, not from this mapping.
 */
export type OperatorDecisionState =
  | 'pending'
  | 'claimed'
  | 'already_claimed'
  | 'scope_mismatch'
  | 'failed_to_settle'
  | 'unavailable'

/**
 * Map a `DecisionOutcome` (registry-internal) to the operator-facing `OperatorDecisionState`.
 *
 * The `never` exhaustiveness guard at the bottom ensures that adding a new
 * `DecisionOutcome` variant to `registry.ts` without updating this mapping
 * fails compilation — the constraint is load-bearing.
 *
 * `pending` is NOT produced here — it is the implied pre-decision state (open
 * entry, no `DecisionOutcome`). This function only maps the 5 post-decision outcomes.
 */
export function toOperatorDecisionState(outcome: DecisionOutcome): Exclude<OperatorDecisionState, 'pending'> {
  switch (outcome) {
    case 'ok':
      return 'claimed'
    case 'channel-mismatch':
      return 'scope_mismatch'
    case 'already-claimed':
      // The first POST is still in-flight; the entry has NOT settled yet.
      // This is NOT 'already_settled'.
      return 'already_claimed'
    case 'reply-failed':
      return 'failed_to_settle'
    case 'not-found':
      return 'unavailable'
    default: {
      // Exhaustiveness guard: if a new DecisionOutcome variant is added to
      // registry.ts without a case here, TypeScript will fail to compile.
      const exhaustiveCheck: never = outcome
      throw new Error(`toOperatorDecisionState: unhandled DecisionOutcome variant: ${String(exhaustiveCheck)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// DecisionInput — makes R7 load-bearing
// ---------------------------------------------------------------------------

/**
 * The input shape for an operator approval decision.
 *
 * Requires a transport-bound `actor: ApprovalActor` (a discriminated union)
 * rather than a free-form `decidedBy: string`. This makes the R7 constraint
 * load-bearing: any new decision entry point that references `DecisionInput`
 * cannot bypass the fail-closed gate with an untyped string actor.
 *
 * Mirrors the args accepted by `registry.handleDecision`.
 */
export interface DecisionInput {
  readonly requestID: string
  readonly approvalScopeId: string
  readonly decision: PermissionReply
  readonly actor: ApprovalActor
}
