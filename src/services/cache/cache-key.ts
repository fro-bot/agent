import type {AgentIdentity} from '../../shared/types.js'
import {CACHE_PREFIX} from '../../shared/constants.js'
import {getGitHubRefName, getGitHubRepository, getRunnerOS} from '../../shared/env.js'

export interface CacheKeyComponents {
  readonly agentIdentity: AgentIdentity
  readonly repo: string
  readonly ref: string
  readonly os: string
}

/**
 * Sanitize repository name for use in cache keys.
 * Replaces forward slashes with dashes to create valid cache key segments.
 */
function sanitizeRepoName(repo: string): string {
  return repo.replaceAll('/', '-')
}

/**
 * Generate primary cache key with full specificity.
 * Pattern: opencode-storage-{agent}-{sanitizedRepo}-{ref}-{os}
 */
export function buildPrimaryCacheKey(components: CacheKeyComponents): string {
  const {agentIdentity, repo, ref, os} = components
  const sanitizedRepo = sanitizeRepoName(repo)
  return `${CACHE_PREFIX}-${agentIdentity}-${sanitizedRepo}-${ref}-${os}`
}

/**
 * Generate restore keys for fallback matching.
 * Ordered from most to least specific:
 * 1. Same branch, any run (branch-scoped)
 * 2. Same repo, any branch (repo-scoped)
 */
export function buildRestoreKeys(components: CacheKeyComponents): readonly string[] {
  const {agentIdentity, repo, ref} = components
  const sanitizedRepo = sanitizeRepoName(repo)

  return [
    `${CACHE_PREFIX}-${agentIdentity}-${sanitizedRepo}-${ref}-`,
    `${CACHE_PREFIX}-${agentIdentity}-${sanitizedRepo}-`,
  ] as const
}

/**
 * Generate the unique save key: `{primary}-{runId}-{runAttempt}[-{invocationIdentity}]`.
 *
 * - `runId` + `runAttempt` keep a re-run attempt (same GITHUB_RUN_ID, incremented
 *   GITHUB_RUN_ATTEMPT) on its own distinct cache entry instead of colliding with the first
 *   attempt's -- a re-run's save must stay possible.
 * - `invocationIdentity` (`getInvocationIdentity`: the sanitized `GITHUB_JOB`, plus a short matrix
 *   hash for a matrix leg) keeps two jobs of the *same* run and attempt apart. Without it a
 *   `needs:`-chained second job restores the first job's just-saved entry, then fails to save
 *   ("Unable to reserve cache ... another job may be creating this cache") and loses its own
 *   session state. It is a pure suffix, so it is deterministic per job and identical across
 *   the main step and the post-action retry. `null` (outside a runner) omits the segment.
 *
 * The identity goes AFTER the attempt so buildRestoreKeys' prefixes (ref-scoped and repo-scoped,
 * both stop before any run ID) match every save key -- new-format, and old-format entries that
 * carry no identity suffix. Each job/attempt creates its own entry against the repo's cache
 * budget; LRU eviction handles the growth, an accepted cost against losing a job's session state.
 */
export function buildSaveCacheKey(
  components: CacheKeyComponents,
  runId: number,
  runAttempt: number,
  invocationIdentity: string | null,
): string {
  const base = `${buildPrimaryCacheKey(components)}-${runId}-${runAttempt}`
  return invocationIdentity == null ? base : `${base}-${invocationIdentity}`
}

export function buildCacheKeyComponents(): CacheKeyComponents {
  return {
    agentIdentity: 'github',
    repo: getGitHubRepository(),
    ref: getGitHubRefName(),
    os: getRunnerOS(),
  }
}
