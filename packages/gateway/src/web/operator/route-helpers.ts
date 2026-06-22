/**
 * Shared gate helpers for operator routes.
 *
 * Extracts the duplicated owner/repo-split logic and denylist gate that appear
 * identically in decision-route.ts, pending-approvals-route.ts, and
 * run-stream-route.ts. Each route retains its own try/catch and maps the null
 * return to its own notFoundResponse — the no-oracle behavior is unchanged.
 */

import type {RunIndex} from '../../execute/run-index.js'
import type {DenylistCache} from '../../redaction/denylist.js'
import type {BindingsLookup} from '../../redaction/surface-gate.js'
import {resolveBindingDenyKeys} from '../../redaction/surface-gate.js'

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
 * Strips any trailing `#...` suffix from the repo path before splitting so
 * future entity_ref formats with a fragment do not bleed into the repo name.
 */
export async function resolveRepoFromRunIndex(
  runId: string,
  runIndex: Pick<RunIndex, 'lookup'>,
): Promise<{readonly owner: string; readonly repo: string} | null> {
  const location = await runIndex.lookup(runId)
  if (location === undefined) return null

  const repoPath = location.repo.split('#')[0] ?? location.repo
  const slashIdx = repoPath.indexOf('/')
  if (slashIdx === -1) return null

  const owner = repoPath.slice(0, slashIdx)
  const repo = repoPath.slice(slashIdx + 1)
  if (owner.length === 0 || repo.length === 0) return null

  return {owner, repo}
}

// ---------------------------------------------------------------------------
// checkDenylist
// ---------------------------------------------------------------------------

/**
 * Resolve deny-keys and check whether the repo is denylisted.
 *
 * Returns `true` when the repo is denied (caller should return notFoundResponse).
 * Returns `false` when the repo is allowed.
 *
 * Runs the denylist check BEFORE any GitHub authz call so a denylisted repo
 * never triggers a GitHub API request.
 */
export async function checkDenylist(
  owner: string,
  repo: string,
  bindingsLookup: BindingsLookup,
  denylistCache: DenylistCache,
): Promise<boolean> {
  const denyKeys = await resolveBindingDenyKeys(owner, repo, bindingsLookup)
  await denylistCache.getDenylistState()
  return denylistCache.isRepoDenied(denyKeys) === true
}
