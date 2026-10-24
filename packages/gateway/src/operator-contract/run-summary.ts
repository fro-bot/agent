/**
 * Operator-safe run summary projection.
 *
 * Exposes only display-safe fields from a RunState, scoped to a specific
 * binding (owner/repo). The binding is the authorization anchor — repo is
 * projected from the binding, never from entity_ref.
 *
 * Security: the builder copies only the declared safe fields; it does NOT
 * spread the RunState. Any future internal field added to RunState will not
 * leak here. Internal coordination fields (holder_id, thread_id, details,
 * surface, phase, entity_ref) are excluded by construction.
 *
 * Consistency: returns null when the run's entity_ref owner/repo does not
 * match the binding's owner/repo. This guards against storage corruption and
 * repo-rename edge cases where a run scanned under one binding's prefix
 * carries an entity_ref pointing to a different repo. The caller skips null
 * projections and warn-logs; the projector itself is pure (no logging, no I/O).
 */

import type {RunState} from '@fro-bot/runtime'
import type {OperatorProviderFailureReason} from './provider-failure-reason.js'
import type {OperatorFailureKind} from './run-status.js'

import {parseEntityRefRepo} from '@fro-bot/runtime'

import {OPERATOR_PROMPT_DETAILS_KEY, projectOperatorLaunchPrompt} from './launch-prompt.js'
import {projectProviderFailureReason, PROVIDER_FAILURE_REASON_DETAILS_KEY} from './provider-failure-reason.js'
import {PHASE_TO_WEB_STATUS, toOperatorFailureKind} from './run-status.js'

/**
 * The 7-value status set a run summary can carry.
 *
 * toRunSummary maps RunPhase only, producing the five lifecycle values via
 * PHASE_TO_WEB_STATUS (PENDING → 'queued', ACKNOWLEDGED/EXECUTING → 'running',
 * COMPLETED → 'succeeded', FAILED → 'failed', CANCELLED → 'cancelled'; the
 * ?? 'failed' fallback stays in this set).
 *
 * 'waiting_for_approval' and 'waiting_for_question' are registry overlays
 * applied by the runs route after toRunSummary, only on a 'running' base.
 * 'blocked' is never carried by a summary.
 */
export type RunSummaryStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'waiting_for_approval' | 'waiting_for_question'

/**
 * Operator-safe projection of a run's summary.
 *
 * Carries only the fields safe to expose to an operator web client.
 * Internal coordination fields (holder_id, thread_id, details, surface,
 * phase, entity_ref) are excluded by construction.
 *
 * updatedAt is optional — it is omitted when last_heartbeat is absent or
 * not a parseable ISO date string.
 */
export interface RunSummary {
  readonly runId: string
  readonly repo: string
  readonly status: RunSummaryStatus
  readonly createdAt: string
  readonly updatedAt?: string
  readonly failureKind?: OperatorFailureKind
  /** Why a `session-error` run failed at the provider (contract 1.12.0). Closed enum; see `OperatorRunStatus`. */
  readonly providerFailureReason?: OperatorProviderFailureReason
  /**
   * The operator's launch prompt, as submitted (contract 1.12.0). Present only on runs launched through
   * `POST /operator/runs`; absent on runs from any other surface and on records that predate 1.12.0.
   * UNTRUSTED text: consumers must render it inertly. Bounded by `OPERATOR_LAUNCH_PROMPT_MAX_LENGTH`
   * (UTF-16 code units); never truncated. Carried on the summary only, never on `OperatorRunStatus`.
   */
  readonly prompt?: string
}

/**
 * Pure builder: project a RunState to a RunSummary, scoped to a binding.
 *
 * Maps lifecycle phase only; waiting overlays are the caller's concern.
 *
 * Returns null when the run's entity_ref owner/repo does not match the
 * binding's owner/repo. This omits runs that do not belong to the binding's
 * repo (corruption/rename guard). The caller is responsible for warn-logging
 * null results; this function is pure and performs no I/O.
 *
 * Copies only the declared safe fields. Does NOT spread the RunState.
 * updatedAt is included only when last_heartbeat is a non-empty, parseable
 * ISO date string.
 *
 * @param runState - The canonical run state from the coordination layer.
 * @param binding - The authorized binding this run was scanned under.
 * @param binding.owner - The GitHub owner (org or user) of the binding.
 * @param binding.repo - The GitHub repository name of the binding.
 * @returns An operator-safe RunSummary, or null when entity_ref does not match the binding.
 */
export function toRunSummary(
  runState: RunState,
  binding: {readonly owner: string; readonly repo: string},
): RunSummary | null {
  // Consistency guard: verify entity_ref owner/repo matches the binding.
  // The binding is the authorization anchor; a mismatch indicates storage
  // corruption or a repo rename. Omit the run rather than misattribute it.
  const entityRefRepo = parseEntityRefRepo(runState.entity_ref)
  if (entityRefRepo === null) {
    return null
  }
  // Compared case-insensitively, the same rule the binding lookup uses (GitHub names are case-insensitive, bindings
  // are stored lowercase), so a legacy entity_ref that kept the repo's GitHub spelling is still the same repo.
  if (
    entityRefRepo.owner.toLowerCase() !== binding.owner.toLowerCase() ||
    entityRefRepo.repo.toLowerCase() !== binding.repo.toLowerCase()
  ) {
    return null
  }

  // Determine the summary status from the run phase.
  // Fail-closed: an unrecognized phase (data corruption / version skew) surfaces
  // as 'failed', not as undefined — a missing status key would silently drop the
  // field from JSON output.
  // PHASE_TO_WEB_STATUS values are lifecycle statuses only (queued/running/succeeded/
  // failed/cancelled), all in RunSummaryStatus; the waiting overlays are applied by the
  // caller. The ?? 'failed' fallback is also in RunSummaryStatus. Direct indexing typechecks
  // because runState.phase is RunPhase and PHASE_TO_WEB_STATUS is Record<RunPhase, ...>.
  const status: RunSummaryStatus = (PHASE_TO_WEB_STATUS[runState.phase] ?? 'failed') as RunSummaryStatus

  // Determine whether updatedAt should be included.
  // Omit when last_heartbeat is empty or not a parseable ISO date string.
  const heartbeatMs = runState.last_heartbeat.length === 0 ? Number.NaN : Date.parse(runState.last_heartbeat)
  const hasValidHeartbeat = Number.isNaN(heartbeatMs) === false

  // failureKind is populated ONLY for FAILED runs, mapped through the closed
  // allowlist (never a raw passthrough). Read runState.details.failureKind
  // solely within this branch — never elsewhere.
  const failureKind = runState.phase === 'FAILED' ? toOperatorFailureKind(runState.details.failureKind) : undefined

  // providerFailureReason (1.12.0): same three gates as the status projection (FAILED, internal
  // failureKind 'session-error', known wire value); otherwise omitted and the row is kept.
  const providerFailureReason = projectProviderFailureReason(
    runState.phase,
    runState.details.failureKind,
    runState.details[PROVIDER_FAILURE_REASON_DETAILS_KEY],
  )

  // prompt (1.12.0): only a trustworthy stored value on a web run (non-empty string within the bound).
  // Anything else is omitted and the row is kept; the value is never truncated.
  const prompt = projectOperatorLaunchPrompt(runState.surface, runState.details[OPERATOR_PROMPT_DETAILS_KEY])

  // Build the closed DTO — copy only declared safe fields, never spread runState.
  // repo comes from the binding (the authorization anchor), not entity_ref.
  const summary: RunSummary = {
    runId: runState.run_id,
    repo: `${binding.owner}/${binding.repo}`,
    status,
    createdAt: runState.started_at,
    ...(hasValidHeartbeat ? {updatedAt: runState.last_heartbeat} : {}),
    ...(failureKind === undefined ? {} : {failureKind}),
    ...(providerFailureReason === undefined ? {} : {providerFailureReason}),
    ...(prompt === undefined ? {} : {prompt}),
  }

  return summary
}
