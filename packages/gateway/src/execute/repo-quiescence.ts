/**
 * Repo workspace quiescence: the shared contract and directory resolution for the checker
 * (`repo-quiescence-v2.ts`). A point-in-time read of one repo's workspace directory, used to corroborate an expired
 * coordination lease before it is replaced or deleted: only `clear` permits it; `busy` and `unknown` both block. Not
 * fencing — it proves nothing about later activity.
 */

import type {RepoQuiescence} from '../runtime-effect.js'

import {isValidGitHubOwner, isValidGitHubRepoName, parseRepoSlug} from '@fro-bot/runtime'
import {canonicalWorkspaceDirectory} from '../workspace-api/client.js'

export interface RepoQuiescenceContext {
  readonly repo: string
  readonly signal: AbortSignal
}

/** Structurally compatible with the lock layer's `ConfirmExpiredHolder`, which passes extra context. */
export type RepoQuiescenceChecker = (context: RepoQuiescenceContext) => Promise<RepoQuiescence>

/**
 * Resolves `owner/repo` to the canonical workspace directory (shared with the run's session directory), or
 * `null` for anything that is not a valid slug (`parseRepoSlug`) or not a canonical workspace name. A directory
 * without sessions reads as quiet, so `clear` is only meaningful because this is the directory the run's sessions are
 * created under.
 */
export function resolveRepoDirectory(repo: string): string | null {
  const parsed = parseRepoSlug(repo)
  if (parsed.success === false) return null
  // Validate the RAW names before the workspace helper lowercases them: Unicode case folding maps some non-ASCII
  // characters onto ASCII ones (the Kelvin sign U+212A lowercases to `k`), which would turn a name that is not a
  // GitHub name into a valid-looking directory.
  if (isValidGitHubOwner(parsed.data.owner) === false || isValidGitHubRepoName(parsed.data.repo) === false) return null
  return canonicalWorkspaceDirectory(parsed.data.owner, parsed.data.repo)
}
