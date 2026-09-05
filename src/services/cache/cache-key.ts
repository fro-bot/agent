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
 * Generate unique save key with run ID and run attempt for versioning.
 * Appends run ID and run attempt so a re-run attempt (same GITHUB_RUN_ID, incremented
 * GITHUB_RUN_ATTEMPT) gets its own distinct cache entry instead of colliding with the
 * first attempt's -- a collision folds into 'persisted' via the caught "already exists"
 * error, silently discarding the retry attempt's own state. buildRestoreKeys' prefixes
 * (ref-scoped and repo-scoped, both stop before any run ID) are unaffected: they still
 * match every save key regardless of run ID or run attempt. Each attempt therefore creates
 * its own entry against the repo's cache budget rather than reusing one -- LRU eviction
 * handles the resulting growth, an accepted cost against losing a re-run's session state.
 */
export function buildSaveCacheKey(components: CacheKeyComponents, runId: number, runAttempt: number): string {
  return `${buildPrimaryCacheKey(components)}-${runId}-${runAttempt}`
}

export function buildCacheKeyComponents(): CacheKeyComponents {
  return {
    agentIdentity: 'github',
    repo: getGitHubRepository(),
    ref: getGitHubRefName(),
    os: getRunnerOS(),
  }
}
