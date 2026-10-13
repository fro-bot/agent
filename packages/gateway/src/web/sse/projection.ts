/**
 * Waiting-status overlay for operator run statuses.
 *
 * The redaction bridge (`projectRunStatusWithKey`) yields a run's closed base status; this
 * module overlays the live waiting state on it. When the run's scope has a pending approval
 * the overlay yields waiting_for_approval; failing that, a pending question yields
 * waiting_for_question. Only a `running` status is overlaid. Callers that hold a retained
 * base (the SSE manager) or a summary (the run list) reapply the overlay alone.
 */

import type {RunState} from '@fro-bot/runtime'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Registry reads for the waiting overlay, both keyed by the `scopeIdFor` scope.
 * Both are required: callers read live registries, so an absent family would
 * silently drop its waiting state.
 */
export interface WaitingPredicates {
  readonly hasPendingApproval: (scopeId: string) => boolean
  readonly hasPendingQuestion: (scopeId: string) => boolean
}

// ---------------------------------------------------------------------------
// scopeIdFor — derive the approval scope id from a run
// ---------------------------------------------------------------------------

/**
 * Derives the approval scope id for a run. Discord runs are thread-scoped
 * (the approval flow keys on the thread); other surfaces key on the run id.
 */
export function scopeIdFor(runState: RunState): string {
  if (runState.surface === 'discord') {
    return runState.thread_id
  }
  return runState.run_id
}

// ---------------------------------------------------------------------------
// overlayWaitingStatus — synchronous waiting overlay
// ---------------------------------------------------------------------------

/**
 * Overlays a waiting status on a `running` status; any other status passes
 * through. A stale approval or question entry must not override a queued or
 * terminal status. Approval wins over question: an approval gates a tool call,
 * so it is the more urgent signal. Generic so run summaries (whose status union
 * is narrower than OperatorWebStatus) reuse it.
 */
export function overlayWaitingStatus<S extends string>(
  status: S,
  scopeId: string,
  predicates: WaitingPredicates,
): S | 'waiting_for_approval' | 'waiting_for_question' {
  if (status !== 'running') return status
  if (predicates.hasPendingApproval(scopeId) === true) return 'waiting_for_approval'
  if (predicates.hasPendingQuestion(scopeId) === true) return 'waiting_for_question'
  return status
}
