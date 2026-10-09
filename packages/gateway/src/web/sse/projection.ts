/**
 * Projects a run's coordination state into an operator-safe run status.
 *
 * Goes through the redaction bridge (projectRunStatus) so a denied or keyless
 * repo yields null and is never surfaced. The result is a closed DTO that copies
 * only the operator-contract fields — RunState and its free-form details never
 * reach the output. When the run's approval scope has a pending decision, the
 * status is overlaid with waiting_for_approval; failing that, a pending question
 * overlays waiting_for_question.
 */

import type {RunState} from '@fro-bot/runtime'
import type {OperatorRunStatus} from '../../operator-contract/index.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'

import {projectRunStatus} from '../../redaction/surface-gate.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Carries the redaction-bridge options plus the approval-overlay predicate.
 * `_projectRunStatus` is an injectable override for the bridge call so tests
 * avoid binding-store I/O; production callers omit it.
 */
export interface ProjectRunObservationDeps {
  readonly nowMs: number
  readonly staleThresholdMs: number
  readonly bindingsLookup: BindingsLookup
  readonly isRepoDenied: (repoKey: {readonly databaseId: number | null; readonly nodeId: string | null}) => boolean
  readonly hasPendingForScope: (approvalScopeId: string) => boolean
  /**
   * True when the run's scope has an open or claimed agent question. Optional:
   * absent means no `waiting_for_question` overlay. Keyed by the same `scopeIdFor` scope.
   */
  readonly hasPendingQuestionForScope?: (questionScopeId: string) => boolean
  readonly _projectRunStatus?: (
    runState: RunState,
    deps: ProjectRunObservationDeps,
  ) => Promise<OperatorRunStatus | null>
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
// projectRunObservation — main projection entry point
// ---------------------------------------------------------------------------

/**
 * Returns null for a denied or keyless repo (the caller omits it), otherwise a
 * closed DTO carrying only operator-contract fields with the approval overlay
 * applied.
 */
export async function projectRunObservation(
  runState: RunState,
  deps: ProjectRunObservationDeps,
): Promise<OperatorRunStatus | null> {
  const bridgeFn = deps._projectRunStatus ?? callRealBridge
  const base = await bridgeFn(runState, deps)
  if (base === null) {
    return null
  }

  // Copy only the contract fields from the deny-gated bridge result (base), never from runState —
  // preserves the deny-gate (a denied repo's base is null before any field). Destructuring `base`
  // exhaustively makes a new OperatorRunStatus field a type error below until it is copied here.
  const {
    runId,
    entityRef,
    surface,
    phase,
    status,
    startedAt,
    stale,
    failureKind,
    checkoutProvenance,
    checkoutPreparation,
    ...uncopied
  } = base
  uncopied satisfies Record<string, never>

  const scopeId = scopeIdFor(runState)
  // Only overlay a waiting status when the run is actively running — a stale approval or
  // question entry must not override a terminal status (succeeded/failed/cancelled) that has
  // already been reached. The overlay is meaningless once the run has left the running state.
  // Approval wins over question: an approval gates a tool call, so it is the more urgent signal.
  const overlaidStatus = overlayWaitingStatus(status, scopeId, deps)

  const result: OperatorRunStatus = {
    runId,
    entityRef,
    surface,
    phase,
    status: overlaidStatus,
    startedAt,
    stale,
    ...(failureKind === undefined ? {} : {failureKind}),
    ...(checkoutProvenance === undefined ? {} : {checkoutProvenance}),
    ...(checkoutPreparation === undefined ? {} : {checkoutPreparation}),
  }

  return result
}

function overlayWaitingStatus(
  status: OperatorRunStatus['status'],
  scopeId: string,
  deps: ProjectRunObservationDeps,
): OperatorRunStatus['status'] {
  if (status !== 'running') return status
  if (deps.hasPendingForScope(scopeId) === true) return 'waiting_for_approval'
  if (deps.hasPendingQuestionForScope?.(scopeId) === true) return 'waiting_for_question'
  return status
}

async function callRealBridge(runState: RunState, deps: ProjectRunObservationDeps): Promise<OperatorRunStatus | null> {
  return projectRunStatus(runState, {
    nowMs: deps.nowMs,
    staleThresholdMs: deps.staleThresholdMs,
    bindingsLookup: deps.bindingsLookup,
    isRepoDenied: deps.isRepoDenied,
  })
}
