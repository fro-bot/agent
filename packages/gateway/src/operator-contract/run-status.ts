/**
 * Operator-safe run-status projection.
 *
 * Re-exports the canonical lifecycle types (RunPhase, Surface) from @fro-bot/runtime
 * so the contract barrel is the single import authority for operator-facing consumers.
 *
 * Posture: re-export only — existing gateway files that import RunPhase/Surface directly
 * from @fro-bot/runtime (execute/launch-types.ts, runtime-effect.ts, execute/recovery.test.ts)
 * are left as-is. Migrating them to the contract barrel is a deferred follow-up.
 *
 * Security (R5): OperatorRunStatus carries only operator-safe fields. The internal
 * coordination fields holder_id, thread_id, and details are excluded by construction —
 * they do not appear in the type and cannot appear in the projection output.
 *
 * Security (R5/R6 cross-obligation, metadata/repos.yaml redaction obligation): entity_ref is 'owner/repo#123'.
 * Exposing it for a repo redacted in metadata/repos.yaml reintroduces the repo-redaction cross-obligation leak.
 * The pre-query redaction gate does NOT retroactively scrub an already-stored run's status,
 * so toOperatorRunStatus requires a caller-supplied repoKey + isRepoDenylisted predicate and returns null
 * (omit the record entirely) for a denylisted repo. A populated status is never returned
 * for a denylisted repo — not even a partial one. The predicate form makes the "forgot to check"
 * state unrepresentable: the projection cannot be called without supplying a denylist mechanism.
 *
 * The caller (gateway bridge) resolves the run → its binding → deny keys and passes them in.
 * The contract function stays pure and synchronous — no binding lookups, no I/O.
 *
 * Note: 'blocked' and 'waiting_for_approval' are NOT produced by this pure projection.
 * They are derived by the snapshot endpoint from queue/registry state and layered on top
 * of the web status after this function returns. This function maps RunPhase only.
 */

import type {RunPhase, RunState, Surface} from '@fro-bot/runtime'

export type {RunPhase, Surface} from '@fro-bot/runtime'

/**
 * The 7-value operator-facing web status set (snake_case).
 *
 * 'blocked' and 'waiting_for_approval' are endpoint-layer overlays derived from
 * queue/registry state — they are NOT produced by toOperatorRunStatus (which maps
 * RunPhase only). The snapshot endpoint layers them on top after projection.
 */
export type OperatorWebStatus =
  'queued' | 'blocked' | 'running' | 'waiting_for_approval' | 'succeeded' | 'failed' | 'cancelled'

/**
 * Operator-safe projection of a run's status.
 *
 * Carries only the fields safe to expose to an operator web client.
 * Internal coordination fields (holder_id, thread_id, details) are excluded
 * by construction — they do not appear in this type.
 */
export interface OperatorRunStatus {
  readonly runId: string
  readonly entityRef: string
  readonly surface: Surface
  readonly phase: RunPhase
  readonly status: OperatorWebStatus
  readonly startedAt: string
  readonly stale: boolean
  readonly failureKind?: OperatorFailureKind
}

/**
 * Maps a RunPhase to its operator-facing web status.
 *
 * 'blocked' and 'waiting_for_approval' are NOT in this map — they are
 * endpoint-layer overlays, not derivable from RunPhase alone.
 *
 * Exported so sibling projectors (e.g. run-summary.ts) can reuse the mapping
 * without re-declaring it. Consumers outside this package should import from
 * the contract barrel.
 */
export const PHASE_TO_WEB_STATUS: Record<RunPhase, OperatorWebStatus> = {
  PENDING: 'queued',
  ACKNOWLEDGED: 'running',
  EXECUTING: 'running',
  COMPLETED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

/**
 * The operator-facing failure-reason enum.
 *
 * A closed allowlist derived from RunCoreErrorKind (execute/run-core.ts) — the internal
 * error-kind vocabulary. 'unknown' is the fallback for any internal kind with no mapping
 * entry (defense-in-depth: unmapped/future/unrecognized kinds never leak past this gate).
 */
export type OperatorFailureKind =
  'inactivity-timeout' | 'max-duration-timeout' | 'stream-ended' | 'workspace-unreachable' | 'session-error' | 'unknown'

/**
 * Closed allowlist mapping RunCoreErrorKind (internal) → OperatorFailureKind (operator-safe).
 *
 * Deliberately a `Partial`-shaped Record via index access with `?? 'unknown'` in
 * toOperatorFailureKind — kinds with no entry here (e.g. 'missing-coordinator') fall
 * through to 'unknown' rather than being a type error, since the input is untyped `unknown`.
 *
 * Exported so sibling projectors can reuse the mapping without re-declaring it.
 */
export const RUN_CORE_ERROR_KIND_TO_OPERATOR_FAILURE_KIND: Record<string, OperatorFailureKind> = {
  timeout: 'max-duration-timeout',
  'inactivity-timeout': 'inactivity-timeout',
  'stream-ended': 'stream-ended',
  unreachable: 'workspace-unreachable',
  auth: 'workspace-unreachable',
  'session-error': 'session-error',
  'prompt-error': 'session-error',
  // 'missing-coordinator' has no entry — falls through to 'unknown' via the default.
}

/**
 * Maps a raw failure-kind value to the operator-safe OperatorFailureKind enum.
 *
 * Structural defense-in-depth: this function's signature accepts only the single
 * candidate VALUE, never a details/context object — it is impossible for this function
 * to read any other property, because it never receives one.
 *
 * - `undefined` (field absent) → `undefined` (the operator field will be omitted).
 * - Any recognized internal kind string → its mapped OperatorFailureKind.
 * - Any other value (unrecognized string, object, number, null, boolean) → `'unknown'`.
 *   This is a closed allowlist gate: nothing but the six known enum values can escape
 *   this function, regardless of what raw value flows in.
 */
export function toOperatorFailureKind(failureKind: unknown): OperatorFailureKind | undefined {
  if (failureKind === undefined) {
    return undefined
  }

  if (typeof failureKind === 'string') {
    return RUN_CORE_ERROR_KIND_TO_OPERATOR_FAILURE_KIND[failureKind] ?? 'unknown'
  }

  return 'unknown'
}

/**
 * The repo identity keys used for denylist matching.
 *
 * Supplied by the gateway bridge, which resolves the run → its binding → deny keys.
 * A record with neither a usable databaseId nor nodeId is denied (fail closed).
 */
export interface RunStatusRepoKey {
  readonly databaseId: number | null
  readonly nodeId: string | null
}

/**
 * Pure, redaction-aware projection from RunState to OperatorRunStatus.
 *
 * Returns null when opts.isRepoDenylisted(opts.repoKey) returns true — the record
 * is omitted entirely. This is the critical repo-redaction cross-obligation: entity_ref
 * would otherwise expose a denylisted repo's identity and activity that the pre-query gate
 * cannot scrub.
 *
 * The predicate form makes the "forgot to check" state unrepresentable: callers MUST supply
 * a denylist mechanism (e.g. backed by metadata/repos.yaml). Passing a blanket `() => false`
 * is an explicit opt-out, not a silent default.
 *
 * The caller (gateway bridge) resolves the run → its binding → deny keys and passes them in
 * as `repoKey`. The contract function stays pure and synchronous — no binding lookups, no I/O.
 *
 * @param runState - The canonical run state from the coordination layer.
 * @param opts - Projection options.
 * @param opts.nowMs - Current time in milliseconds (explicit; no hidden clock coupling).
 * @param opts.staleThresholdMs - Age threshold in ms beyond which a run is considered
 *   stale. REQUIRED explicit param — no hidden coupling to any runtime default constant.
 * @param opts.repoKey - The repo's deny keys resolved from the binding by the gateway bridge.
 *   A null/null key means no usable deny key (fails closed — denied).
 * @param opts.isRepoDenylisted - Predicate that receives the repoKey and returns true if
 *   that repo is on the metadata/repos.yaml denylist. When true, returns null (record omitted)
 *   to prevent identity/activity leak. The caller supplies the denylist mechanism; the
 *   projection cannot be called without one.
 */
export const toOperatorRunStatus = (
  runState: RunState,
  opts: {
    readonly nowMs: number
    readonly staleThresholdMs: number
    readonly repoKey: RunStatusRepoKey
    readonly isRepoDenylisted: (repoKey: RunStatusRepoKey) => boolean
  },
): OperatorRunStatus | null => {
  // #given the redaction predicate — check first, before touching any field
  if (opts.isRepoDenylisted(opts.repoKey) === true) {
    // Omit the record entirely. A populated status must never be returned for a
    // denylisted repo — even a partial one would leak the repo's identity/activity.
    return null
  }

  // #given the last_heartbeat — derive stale with explicit numeric comparison
  // Fail-safe: if last_heartbeat is unparseable, treat as stale (unknown freshness = stale).
  const heartbeatMs = Date.parse(runState.last_heartbeat)
  const stale = Number.isNaN(heartbeatMs) || heartbeatMs <= opts.nowMs - opts.staleThresholdMs

  // #when projecting — map only operator-safe fields; internal fields are never read
  return {
    runId: runState.run_id,
    entityRef: runState.entity_ref,
    surface: runState.surface,
    phase: runState.phase,
    // Fail-closed: an unrecognized phase (data corruption / version skew) surfaces as 'failed',
    // not as undefined — a missing status key would silently drop the field from JSON output.
    status: PHASE_TO_WEB_STATUS[runState.phase] ?? 'failed',
    startedAt: runState.started_at,
    stale,
    // failureKind is populated ONLY for FAILED runs, mapped through the closed
    // allowlist (never a raw passthrough). Read runState.details.failureKind
    // solely within this branch — never elsewhere.
    ...(runState.phase === 'FAILED' && toOperatorFailureKind(runState.details.failureKind) !== undefined
      ? {failureKind: toOperatorFailureKind(runState.details.failureKind)}
      : {}),
  }
}
