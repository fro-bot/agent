/**
 * Gateway redaction bridge — surface-time gate for operator endpoints.
 *
 * This module is the impure glue between the pure operator contract
 * (packages/gateway/src/operator-contract/run-status.ts) and the gateway's
 * binding store + denylist cache. It resolves a run → its binding → deny keys,
 * then calls the pure contract projection with those keys.
 *
 * ## Design
 *
 * The contract function (toOperatorRunStatus) is pure and synchronous — it takes
 * a repoKey and an isRepoDenied predicate as explicit params. This module is where
 * the impure binding resolution lives: it reads the binding store (async I/O) to
 * get the deny keys, then hands them to the pure contract.
 *
 * ## Fail-closed posture
 *
 * A binding that cannot be resolved, or that has no deny keys (legacy / unbackfilled),
 * yields {databaseId: null, nodeId: null}. The isRepoDenied predicate (from the
 * denylist cache) treats null/null as denied — fail closed. No surface-time GitHub
 * call is made to resolve repo identity; keys come from the binding only.
 *
 * ## filterDeniedRecords — denylist-filter-first primitive
 *
 * Any operator path that builds a working set from multiple records MUST call
 * filterDeniedRecords at the TOP of the working-set build — before any per-repo
 * query, name resolution, or projection — so a denied repo is never queried or
 * partially surfaced. This is the denylist-before-query invariant enforced at the
 * working-set level.
 *
 * Cross-reference: REDACTION_OBLIGATION in packages/gateway/src/operator-contract/redaction.ts
 * Cross-reference: fro-bot/dashboard docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md
 */

import type {RunState} from '@fro-bot/runtime'
import type {OperatorRunStatus, RunStatusRepoKey} from '../operator-contract/index.js'
import type {RepoKey} from './denylist.js'

import {toOperatorRunStatus} from '../operator-contract/index.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal binding-store interface required by the surface gate.
 *
 * Accepts the full BindingsStore from packages/gateway/src/bindings/store.ts
 * (structural subtype — no import coupling to the store module).
 */
export interface BindingsLookup {
  readonly getBindingByRepo: (
    owner: string,
    repo: string,
  ) => Promise<{success: true; data: {databaseId?: number; nodeId?: string} | null} | {success: false; error: Error}>
}

// ---------------------------------------------------------------------------
// resolveRunRepoKey — resolve a run's entity_ref to its binding deny keys
// ---------------------------------------------------------------------------

/**
 * Parse the owner/repo from a run's entity_ref ('owner/repo#runNumber').
 *
 * Returns null if the entity_ref does not match the expected format.
 * Internal — not exported; callers use resolveRunRepoKey.
 */
function parseEntityRef(entityRef: string): {owner: string; repo: string} | null {
  // entity_ref format: 'owner/repo#runNumber'
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
 * Resolve a run's entity_ref to its binding's deny keys.
 *
 * Reads the binding store (async I/O) to get the deny keys for the run's repo.
 * Returns {databaseId: null, nodeId: null} in all fail-closed cases:
 * - entity_ref cannot be parsed
 * - binding not found in the store
 * - binding has no deny keys (legacy / unbackfilled)
 * - binding store returns an error
 *
 * No GitHub API call is made — keys come from the binding only.
 *
 * @param runState - The run whose repo deny keys are needed.
 * @param bindingsLookup - The binding store to look up the binding.
 * @returns The repo's deny keys, or {databaseId: null, nodeId: null} on any failure.
 */
export async function resolveRunRepoKey(runState: RunState, bindingsLookup: BindingsLookup): Promise<RunStatusRepoKey> {
  const NULL_KEY: RunStatusRepoKey = {databaseId: null, nodeId: null}

  const parsed = parseEntityRef(runState.entity_ref)
  if (parsed === null) {
    return NULL_KEY
  }

  const {owner, repo} = parsed
  const result = await bindingsLookup.getBindingByRepo(owner, repo)

  if (result.success === false) {
    // Store error — fail closed
    return NULL_KEY
  }

  if (result.data === null) {
    // Binding not found — fail closed
    return NULL_KEY
  }

  const binding = result.data
  const databaseId = typeof binding.databaseId === 'number' ? binding.databaseId : null
  const nodeId = typeof binding.nodeId === 'string' ? binding.nodeId : null

  return {databaseId, nodeId}
}

// ---------------------------------------------------------------------------
// projectRunStatus — per-run projection helper
// ---------------------------------------------------------------------------

/**
 * Options for projectRunStatus.
 */
export interface ProjectRunStatusOpts {
  readonly nowMs: number
  readonly staleThresholdMs: number
  readonly bindingsLookup: BindingsLookup
  readonly isRepoDenied: (repoKey: RepoKey) => boolean
}

/**
 * Per-run projection helper: resolves deny keys from the binding and projects
 * the run to an OperatorRunStatus (or null if denied/omitted).
 *
 * This is the impure entry point for per-run status projection. It:
 * 1. Resolves the run's entity_ref → binding → deny keys (async, binding store).
 * 2. Calls the pure toOperatorRunStatus with those keys + the isRepoDenied predicate.
 * 3. Returns null if the repo is denied (or if the binding is missing/keyless — fail closed).
 *
 * The App client / GitHub is NOT called to resolve repo identity — keys come from
 * the binding only (denylist-before-query invariant).
 *
 * @param runState - The run to project.
 * @param opts - Projection options including the binding lookup and denylist predicate.
 * @returns The projected OperatorRunStatus, or null if the repo is denied/omitted.
 */
export async function projectRunStatus(
  runState: RunState,
  opts: ProjectRunStatusOpts,
): Promise<OperatorRunStatus | null> {
  const repoKey = await resolveRunRepoKey(runState, opts.bindingsLookup)

  return toOperatorRunStatus(runState, {
    nowMs: opts.nowMs,
    staleThresholdMs: opts.staleThresholdMs,
    repoKey,
    isRepoDenylisted: opts.isRepoDenied,
  })
}

// ---------------------------------------------------------------------------
// filterDeniedRecords — denylist-filter-first working-set primitive
// ---------------------------------------------------------------------------

/**
 * Filter a set of records by the denylist predicate, returning only non-denied records.
 *
 * This is the denylist-filter-first primitive. Call it at the TOP of any operator
 * working-set builder (binding-list, run-list, counts) BEFORE any per-repo query,
 * name resolution, or projection — so a denied repo is never queried or partially
 * surfaced.
 *
 * The predicate is called synchronously for each record. Records whose repoKey is
 * denied (including null/null keys — fail closed) are excluded from the result.
 *
 * @param records - The full working set of records.
 * @param getRepoKey - Extracts the repo deny key from a record.
 * @param isRepoDenied - The denylist predicate (from the denylist cache).
 * @returns Only the records whose repo is NOT denied.
 */
export function filterDeniedRecords<T>(
  records: readonly T[],
  getRepoKey: (record: T) => RepoKey,
  isRepoDenied: (repoKey: RepoKey) => boolean,
): T[] {
  const allowed: T[] = []
  for (const record of records) {
    const repoKey = getRepoKey(record)
    if (isRepoDenied(repoKey) === false) {
      allowed.push(record)
    }
  }
  return allowed
}
