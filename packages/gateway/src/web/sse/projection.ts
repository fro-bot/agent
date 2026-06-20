/**
 * Projects a run's coordination state into an operator-safe run status.
 *
 * Goes through the redaction bridge (projectRunStatus) so a denied or keyless
 * repo yields null and is never surfaced. The result is a closed DTO that copies
 * only the operator-contract fields — RunState and its free-form details never
 * reach the output. When the run's approval scope has a pending decision, the
 * status is overlaid with waiting_for_approval.
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

  const scopeId = scopeIdFor(runState)
  const overlaidStatus = deps.hasPendingForScope(scopeId) === true ? 'waiting_for_approval' : base.status

  // Copy only the contract fields; never spread runState or read its details.
  const result: OperatorRunStatus = {
    runId: base.runId,
    entityRef: base.entityRef,
    surface: base.surface,
    phase: base.phase,
    status: overlaidStatus,
    startedAt: base.startedAt,
    stale: base.stale,
  }

  return result
}

async function callRealBridge(runState: RunState, deps: ProjectRunObservationDeps): Promise<OperatorRunStatus | null> {
  return projectRunStatus(runState, {
    nowMs: deps.nowMs,
    staleThresholdMs: deps.staleThresholdMs,
    bindingsLookup: deps.bindingsLookup,
    isRepoDenied: deps.isRepoDenied,
  })
}
