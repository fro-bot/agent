/**
 * Projects a run's coordination state into an operator-safe run status.
 *
 * Goes through the redaction bridge (projectRunStatus) so a denied or keyless
 * repo yields null and is never surfaced. The result is a closed DTO that copies
 * only the operator-contract fields — RunState and its free-form details never
 * reach the output. The projection is split in two: an async base (redaction
 * bridge, no overlay) and a synchronous overlay. When the run's scope has a
 * pending approval the overlay yields waiting_for_approval; failing that, a
 * pending question yields waiting_for_question. Callers that hold a retained
 * base (the SSE manager) or a summary (the run list) reapply the overlay alone.
 */

import type {RunState} from '@fro-bot/runtime'
import type {OperatorRunStatus} from '../../operator-contract/index.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'

import {projectRunStatus} from '../../redaction/surface-gate.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Redaction-bridge options for the base projection. `_projectRunStatus` is an
 * injectable override for the bridge call so tests avoid binding-store I/O;
 * production callers omit it.
 */
export interface ProjectRunBaseDeps {
  readonly nowMs: number
  readonly staleThresholdMs: number
  readonly bindingsLookup: BindingsLookup
  readonly isRepoDenied: (repoKey: {readonly databaseId: number | null; readonly nodeId: string | null}) => boolean
  readonly _projectRunStatus?: (runState: RunState, deps: ProjectRunBaseDeps) => Promise<OperatorRunStatus | null>
}

/**
 * Registry reads for the waiting overlay, both keyed by the `scopeIdFor` scope.
 * Both are required: callers read live registries, so an absent family would
 * silently drop its waiting state.
 */
export interface WaitingPredicates {
  readonly hasPendingApproval: (scopeId: string) => boolean
  readonly hasPendingQuestion: (scopeId: string) => boolean
}

/**
 * Base deps plus the overlay predicates. `hasPendingQuestionForScope` is
 * optional here for existing callers: absent means no `waiting_for_question`
 * overlay.
 */
export interface ProjectRunObservationDeps extends ProjectRunBaseDeps {
  readonly hasPendingForScope: (approvalScopeId: string) => boolean
  readonly hasPendingQuestionForScope?: (questionScopeId: string) => boolean
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

// ---------------------------------------------------------------------------
// projectRunBase — async base projection (no overlay)
// ---------------------------------------------------------------------------

/**
 * Returns null for a denied or keyless repo (the caller omits it), otherwise a
 * closed DTO carrying only operator-contract fields, with no waiting overlay.
 */
export async function projectRunBase(runState: RunState, deps: ProjectRunBaseDeps): Promise<OperatorRunStatus | null> {
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

  return {
    runId,
    entityRef,
    surface,
    phase,
    status,
    startedAt,
    stale,
    ...(failureKind === undefined ? {} : {failureKind}),
    ...(checkoutProvenance === undefined ? {} : {checkoutProvenance}),
    ...(checkoutPreparation === undefined ? {} : {checkoutPreparation}),
  }
}

// ---------------------------------------------------------------------------
// projectRunObservation — base + overlay composition
// ---------------------------------------------------------------------------

/**
 * Base projection with the waiting overlay applied against the supplied
 * predicates. Null for a denied or keyless repo.
 */
export async function projectRunObservation(
  runState: RunState,
  deps: ProjectRunObservationDeps,
): Promise<OperatorRunStatus | null> {
  const base = await projectRunBase(runState, deps)
  if (base === null) {
    return null
  }

  const status = overlayWaitingStatus(base.status, scopeIdFor(runState), {
    hasPendingApproval: deps.hasPendingForScope,
    hasPendingQuestion: deps.hasPendingQuestionForScope ?? (() => false),
  })
  return status === base.status ? base : {...base, status}
}

async function callRealBridge(runState: RunState, deps: ProjectRunBaseDeps): Promise<OperatorRunStatus | null> {
  return projectRunStatus(runState, {
    nowMs: deps.nowMs,
    staleThresholdMs: deps.staleThresholdMs,
    bindingsLookup: deps.bindingsLookup,
    isRepoDenied: deps.isRepoDenied,
  })
}
