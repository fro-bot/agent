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
import type {OperatorWebStatus} from './run-status.js'

import {PHASE_TO_WEB_STATUS} from './run-status.js'

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
  readonly status: OperatorWebStatus
  readonly createdAt: string
  readonly updatedAt?: string
}

/**
 * Extract the owner/repo from an entity_ref string ('owner/repo#runNumber').
 *
 * Returns null when the entity_ref does not contain a slash (malformed or empty).
 * Strips the '#fragment' before splitting so the repo segment is clean.
 */
function extractEntityRefRepo(entityRef: string): {owner: string; repo: string} | null {
  // Strip the '#fragment' (run number) first
  const hashIdx = entityRef.indexOf('#')
  const repoPath = hashIdx === -1 ? entityRef : entityRef.slice(0, hashIdx)

  const slashIdx = repoPath.indexOf('/')
  if (slashIdx === -1) {
    return null
  }

  const owner = repoPath.slice(0, slashIdx)
  const repo = repoPath.slice(slashIdx + 1)

  if (owner.length === 0 || repo.length === 0) {
    return null
  }

  return {owner, repo}
}

/**
 * Pure builder: project a RunState to a RunSummary, scoped to a binding.
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
  const entityRefRepo = extractEntityRefRepo(runState.entity_ref)
  if (entityRefRepo === null) {
    return null
  }
  if (entityRefRepo.owner !== binding.owner || entityRefRepo.repo !== binding.repo) {
    return null
  }

  // Determine the web status from the run phase.
  // Fail-closed: an unrecognized phase (data corruption / version skew) surfaces
  // as 'failed', not as undefined — a missing status key would silently drop the
  // field from JSON output.
  const status: OperatorWebStatus =
    (PHASE_TO_WEB_STATUS as Record<string, OperatorWebStatus>)[runState.phase] ?? 'failed'

  // Determine whether updatedAt should be included.
  // Omit when last_heartbeat is empty or not a parseable ISO date string.
  const heartbeatMs = runState.last_heartbeat.length === 0 ? Number.NaN : Date.parse(runState.last_heartbeat)
  const hasValidHeartbeat = Number.isNaN(heartbeatMs) === false

  // Build the closed DTO — copy only declared safe fields, never spread runState.
  // repo comes from the binding (the authorization anchor), not entity_ref.
  const summary: RunSummary = {
    runId: runState.run_id,
    repo: `${binding.owner}/${binding.repo}`,
    status,
    createdAt: runState.started_at,
    ...(hasValidHeartbeat ? {updatedAt: runState.last_heartbeat} : {}),
  }

  return summary
}
