/**
 * Shared gate helpers for operator routes.
 *
 * Holds the run-to-repo resolution and the repo-access predicate shared by the
 * run-scoped routes. The entity-ref parsing itself lives in `@fro-bot/runtime`
 * (`parseEntityRefRepo`). Each route retains its own try/catch and maps a null or
 * non-`allowed` result to its own notFoundResponse — the no-oracle behavior is
 * unchanged.
 */

import type {RunIndex} from '../../execute/run-index.js'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingDenyKeySource, BindingsLookup} from '../../redaction/surface-gate.js'

import {isValidGitHubOwner, isValidGitHubRepoName, parseEntityRefRepo} from '@fro-bot/runtime'

import {lookupBindingDenyKeys} from '../../redaction/surface-gate.js'

// ---------------------------------------------------------------------------
// resolveRepoFromRunIndex
// ---------------------------------------------------------------------------

/**
 * Resolve a runId to an {owner, repo} pair via the RunIndex.
 *
 * Returns `null` when:
 * - The runId is not found in the index.
 * - The resolved repo path is malformed (no slash, empty owner/repo).
 *
 * The caller maps null to its own notFoundResponse inside its own try/catch
 * so the no-oracle behavior is preserved per-route.
 *
 * `parseEntityRefRepo` strips any trailing `#...` suffix, which only guards legacy or
 * malformed records: `RunLocation.repo` is already the bare `owner/repo`.
 */
export async function resolveRepoFromRunIndex(
  runId: string,
  runIndex: Pick<RunIndex, 'lookup'>,
): Promise<{readonly owner: string; readonly repo: string} | null> {
  const location = await runIndex.lookup(runId)
  if (location === undefined) return null

  return parseEntityRefRepo(location.repo)
}

// ---------------------------------------------------------------------------
// resolveRepoAccess
// ---------------------------------------------------------------------------

/**
 * Outcome of the repo-access predicate.
 * - `allowed`: the repo is bound and not denylisted. Carries the binding the caller already read.
 * - `denied`: malformed name, no binding, or a denylisted/unprimed/keyless repo. Callers cannot (and must not)
 *   tell these apart.
 * - `unavailable`: the binding store or the denylist could not answer. Fail closed — nothing is surfaced.
 */
export type RepoAccess<B extends BindingDenyKeySource> =
  {readonly kind: 'allowed'; readonly binding: B} | {readonly kind: 'denied'} | {readonly kind: 'unavailable'}

/** Dependencies of {@link resolveRepoAccess}. */
export interface RepoAccessDeps<B extends BindingDenyKeySource> {
  readonly bindingsLookup: BindingsLookup<B>
  readonly denylistCache: Pick<DenylistCache, 'getDenylistState' | 'isRepoDenied'>
}

/**
 * The single repo-access predicate for the operator web surface. Reads and writes use the same rule.
 *
 * The caller's allowlist check is separate: the browser guard enforces it per request, and the
 * run-stream lease re-checks it on every tick.
 *
 * Order, fail-closed throughout:
 *   1. Validate the names (the GitHub name rules in `@fro-bot/runtime`) — a malformed name is `denied` with zero
 *      object-store calls.
 *   2. Read the binding ONCE. A store error or throw is `unavailable`; a missing binding is `denied`.
 *   3. Prime the denylist, then consult it with the binding's deny keys. A denylisted, unprimed, or
 *      keyless repo is `denied`.
 *
 * The denylist is consulted only after a binding is found, so it never sees a repo that is not bound.
 * Never throws: any unexpected throw is `unavailable`.
 */
export async function resolveRepoAccess<B extends BindingDenyKeySource>(
  owner: string,
  repo: string,
  deps: RepoAccessDeps<B>,
): Promise<RepoAccess<B>> {
  if (isValidGitHubOwner(owner) === false || isValidGitHubRepoName(repo) === false) {
    return {kind: 'denied'}
  }

  try {
    const lookup = await lookupBindingDenyKeys(owner, repo, deps.bindingsLookup)
    if (lookup.kind === 'unavailable') {
      return {kind: 'unavailable'}
    }
    if (lookup.binding === null) {
      return {kind: 'denied'}
    }

    await deps.denylistCache.getDenylistState()
    if (deps.denylistCache.isRepoDenied(lookup.repoKey) === true) {
      return {kind: 'denied'}
    }

    return {kind: 'allowed', binding: lookup.binding}
  } catch {
    return {kind: 'unavailable'}
  }
}
