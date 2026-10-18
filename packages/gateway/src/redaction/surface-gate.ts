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
 * A binding-store read error is a distinct outcome from a missing binding. Callers that
 * only need the fail-closed key (`resolveRunRepoKey`, `projectRunStatus`) still see it as null/null. `projectRunStatusWithKey` reports it as
 * `unavailable`, so a caller holding earlier state can keep it instead of treating a
 * transient error as a denial.
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
export interface BindingsLookup<B extends BindingDenyKeySource = BindingDenyKeySource> {
  readonly getBindingByRepo: (
    owner: string,
    repo: string,
  ) => Promise<{success: true; data: B | null} | {success: false; error: Error}>
}

/** The slice of a binding the denylist reads: its optional repo identity keys. */
export interface BindingDenyKeySource {
  readonly databaseId?: number | null
  readonly nodeId?: string
}

// ---------------------------------------------------------------------------
// bindingToRepoKey — single owner of the binding → deny-key extraction
// ---------------------------------------------------------------------------

/**
 * Extract the denylist key from an already-resolved binding.
 *
 * The single place that maps a binding's optional `databaseId`/`nodeId` to a
 * `RepoKey`, so the extraction shape lives in exactly one place. A binding with
 * a missing/wrong-typed key yields `null` for that field (fail-closed at the
 * denylist check).
 */
export function bindingToRepoKey(binding: {readonly databaseId?: number | null; readonly nodeId?: string}): RepoKey {
  return {
    databaseId: typeof binding.databaseId === 'number' ? binding.databaseId : null,
    nodeId: typeof binding.nodeId === 'string' ? binding.nodeId : null,
  }
}

// ---------------------------------------------------------------------------
// Binding lookup — deny keys, with a store error kept distinct from a missing binding
// ---------------------------------------------------------------------------

const NULL_KEY: RunStatusRepoKey = {databaseId: null, nodeId: null}

/**
 * `unavailable`: the binding store read failed.
 * `resolved`: a key (null/null when no usable binding exists) plus the binding itself, or `null` when none is bound.
 */
export type DenyKeyLookup<B extends BindingDenyKeySource = BindingDenyKeySource> =
  | {readonly kind: 'resolved'; readonly repoKey: RunStatusRepoKey; readonly binding: B | null}
  | {readonly kind: 'unavailable'}

const UNAVAILABLE = {kind: 'unavailable'} as const

/**
 * One binding read that answers both "what are the deny keys" and "what is the binding".
 *
 * A store error or throw is `unavailable`, kept distinct from a missing binding
 * (`resolved` with a null/null key and a null binding). Never throws.
 */
export async function lookupBindingDenyKeys<B extends BindingDenyKeySource>(
  owner: string,
  repo: string,
  bindingsLookup: BindingsLookup<B>,
): Promise<DenyKeyLookup<B>> {
  let result: Awaited<ReturnType<BindingsLookup<B>['getBindingByRepo']>>
  try {
    result = await bindingsLookup.getBindingByRepo(owner, repo)
  } catch {
    return UNAVAILABLE
  }

  if (result.success === false) {
    return UNAVAILABLE
  }

  if (result.data === null) {
    return {kind: 'resolved', repoKey: NULL_KEY, binding: null}
  }

  return {kind: 'resolved', repoKey: bindingToRepoKey(result.data), binding: result.data}
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

async function lookupRunDenyKeys(runState: RunState, bindingsLookup: BindingsLookup): Promise<DenyKeyLookup> {
  const parsed = parseEntityRef(runState.entity_ref)
  if (parsed === null) {
    return {kind: 'resolved', repoKey: NULL_KEY, binding: null}
  }

  return lookupBindingDenyKeys(parsed.owner, parsed.repo, bindingsLookup)
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
  const lookup = await lookupRunDenyKeys(runState, bindingsLookup)
  return lookup.kind === 'resolved' ? lookup.repoKey : NULL_KEY
}

// ---------------------------------------------------------------------------
// projectRunStatusWithKey / projectRunStatus — per-run projection
// ---------------------------------------------------------------------------

/**
 * Options for projectRunStatus and projectRunStatusWithKey.
 */
export interface ProjectRunStatusOpts {
  readonly nowMs: number
  readonly staleThresholdMs: number
  readonly bindingsLookup: BindingsLookup
  readonly isRepoDenied: (repoKey: RepoKey) => boolean
}

/**
 * Outcome of projecting a run through the redaction bridge.
 * - `projected`: the closed status (no waiting overlay) and the repository key it was gated on.
 * - `denied`: the repository is denied, or has no usable binding or deny key. Nothing is surfaced.
 * - `unavailable`: the binding store read failed, so the run's repository is unknown. Nothing is
 *   surfaced, and the failure says nothing about whether the repository is denied.
 */
export type RunStatusProjection =
  | {readonly kind: 'projected'; readonly status: OperatorRunStatus; readonly repoKey: RunStatusRepoKey}
  | {readonly kind: 'denied'}
  | {readonly kind: 'unavailable'}

/**
 * Closed-DTO copy of the contract projection: only the operator-contract fields.
 * Destructuring `status` exhaustively makes a new OperatorRunStatus field a type error below until it is copied here.
 */
function toClosedStatus(status: OperatorRunStatus): OperatorRunStatus {
  const {
    runId,
    entityRef,
    surface,
    phase,
    status: webStatus,
    startedAt,
    stale,
    failureKind,
    checkoutProvenance,
    checkoutPreparation,
    ...uncopied
  } = status
  uncopied satisfies Record<string, never>

  return {
    runId,
    entityRef,
    surface,
    phase,
    status: webStatus,
    startedAt,
    stale,
    ...(failureKind === undefined ? {} : {failureKind}),
    ...(checkoutProvenance === undefined ? {} : {checkoutProvenance}),
    ...(checkoutPreparation === undefined ? {} : {checkoutPreparation}),
  }
}

/**
 * Per-run projection with the repository key it used. The one redaction-bridge sequence:
 * 1. Looks the run's entity_ref up in the binding store once (async I/O).
 * 2. Calls the pure toOperatorRunStatus with that key + the isRepoDenied predicate, which checks
 *    the denylist before it reads any run field.
 * 3. Returns the closed status with the key, `denied` for a denied or keyless repo (fail closed),
 *    or `unavailable` when the store read failed.
 *
 * The App client / GitHub is NOT called to resolve repo identity — keys come from
 * the binding only (denylist-before-query invariant).
 */
export async function projectRunStatusWithKey(
  runState: RunState,
  opts: ProjectRunStatusOpts,
): Promise<RunStatusProjection> {
  const lookup = await lookupRunDenyKeys(runState, opts.bindingsLookup)
  if (lookup.kind === 'unavailable') {
    return {kind: 'unavailable'}
  }

  const status = toOperatorRunStatus(runState, {
    nowMs: opts.nowMs,
    staleThresholdMs: opts.staleThresholdMs,
    repoKey: lookup.repoKey,
    isRepoDenylisted: opts.isRepoDenied,
  })
  if (status === null) {
    return {kind: 'denied'}
  }

  return {kind: 'projected', status: toClosedStatus(status), repoKey: lookup.repoKey}
}

/**
 * Per-run projection helper: the status of `projectRunStatusWithKey`, or null when the run is
 * denied, omitted, or its binding could not be read (fail closed).
 *
 * @param runState - The run to project.
 * @param opts - Projection options including the binding lookup and denylist predicate.
 * @returns The projected OperatorRunStatus, or null if the repo is denied/omitted/unreadable.
 */
export async function projectRunStatus(
  runState: RunState,
  opts: ProjectRunStatusOpts,
): Promise<OperatorRunStatus | null> {
  const projection = await projectRunStatusWithKey(runState, opts)
  return projection.kind === 'projected' ? projection.status : null
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
