import type {AgentIdentity} from './types.js'
import {CACHE_PREFIX} from './constants.js'

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
 * Generate unique save key with run ID for versioning.
 * Appends run ID to ensure each run creates a distinct cache entry.
 */
export function buildSaveCacheKey(components: CacheKeyComponents, runId: number): string {
  return `${buildPrimaryCacheKey(components)}-${runId}`
}
