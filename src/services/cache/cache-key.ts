import type {SessionGeneration} from '@fro-bot/runtime'
import type {AgentIdentity} from '../../shared/types.js'
import {selectOpenCodeGeneration} from '@fro-bot/runtime'
import {CACHE_PREFIX, CACHE_V2_PREFIX} from '../../shared/constants.js'
import {getGitHubRefName, getGitHubRepository, getRunnerOS} from '../../shared/env.js'

export interface CacheKeyComponents {
  readonly agentIdentity: AgentIdentity
  readonly repo: string
  readonly ref: string
  readonly os: string
}

const CACHE_PREFIXES: Readonly<Record<SessionGeneration, string>> = {
  v1: CACHE_PREFIX,
  v2: CACHE_V2_PREFIX,
}

/**
 * Picks the session generation from the resolved OpenCode version that bootstrap saves to state
 * (`STATE_KEYS.OPENCODE_VERSION`). A major version of 2 or above is V2. A missing version, an unparseable one
 * and every V1 version (including harness builds) are V1, so a run with no V2 state behaves as it always did.
 * The restore, save and post-hook paths all call this with the same value.
 *
 * The selection is the runtime's `selectOpenCodeGeneration`; this keeps only the cache-key decision that an
 * unreadable version is V1, because a cache key must always pick a side.
 */
export function resolveSessionGeneration(version: string | null | undefined): SessionGeneration {
  const selected = selectOpenCodeGeneration(version ?? undefined)
  return selected.success ? selected.data : 'v1'
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
 * Pattern: {prefix}-{agent}-{sanitizedRepo}-{ref}-{os}, where the prefix is `opencode-storage` for V1 and
 * `opencode-v2-storage` for V2.
 */
export function buildPrimaryCacheKey(components: CacheKeyComponents, generation: SessionGeneration = 'v1'): string {
  const {agentIdentity, repo, ref, os} = components
  const sanitizedRepo = sanitizeRepoName(repo)
  return `${CACHE_PREFIXES[generation]}-${agentIdentity}-${sanitizedRepo}-${ref}-${os}`
}

/**
 * Generate restore keys for fallback matching.
 * Ordered from most to least specific:
 * 1. Same branch, any run (branch-scoped)
 * 2. Same repo, any branch (repo-scoped)
 */
export function buildRestoreKeys(
  components: CacheKeyComponents,
  generation: SessionGeneration = 'v1',
): readonly string[] {
  const {branch, repo} = buildScopedRestoreKeys(components, generation)
  return [branch, repo] as const
}

function buildScopedRestoreKeys(
  components: CacheKeyComponents,
  generation: SessionGeneration,
): {readonly branch: string; readonly repo: string} {
  const {agentIdentity, repo, ref} = components
  const prefix = `${CACHE_PREFIXES[generation]}-${agentIdentity}-${sanitizeRepoName(repo)}-`
  return {branch: `${prefix}${ref}-`, repo: prefix}
}

export type RestoreScope = 'branch' | 'repo'

export interface RestoreTier {
  readonly generation: SessionGeneration
  readonly scope: RestoreScope
  readonly key: string
}

/**
 * The Actions-cache restore tiers, in the order they are tried. A V1 run has today's two tiers. A V2 run tries V2
 * before V1 at each scope: V2 branch, V1 branch, V2 repo, V1 repo.
 *
 * Each tier is its own `restoreCache` call because @actions/cache derives an entry's version from the path list
 * the call passes, and the two generations build their lists separately.
 */
export function buildRestoreTiers(
  components: CacheKeyComponents,
  generation: SessionGeneration,
): readonly RestoreTier[] {
  const v1 = buildScopedRestoreKeys(components, 'v1')
  if (generation === 'v1') {
    return [
      {generation: 'v1', scope: 'branch', key: v1.branch},
      {generation: 'v1', scope: 'repo', key: v1.repo},
    ]
  }

  const v2 = buildScopedRestoreKeys(components, 'v2')
  return [
    {generation: 'v2', scope: 'branch', key: v2.branch},
    {generation: 'v1', scope: 'branch', key: v1.branch},
    {generation: 'v2', scope: 'repo', key: v2.repo},
    {generation: 'v1', scope: 'repo', key: v1.repo},
  ]
}

export type RestoreHit =
  | {readonly store: 'object-store'; readonly generation: SessionGeneration}
  | {readonly store: 'cache'; readonly key: string}

export type RestoreSource =
  | {readonly store: 'object-store'; readonly generation: SessionGeneration; readonly scope: 'repo'}
  | {readonly store: 'cache'; readonly generation: SessionGeneration; readonly scope: 'exact' | RestoreScope}

/**
 * Maps whichever entry a restore hit to the store it came from, its generation and its scope. An object-store hit
 * is always repo-scoped (one object per repo). A cache key is classified by the prefix that matches it, branch
 * before repo since the branch prefix is the narrower of the two. Returns null for a key no prefix matches.
 */
export function classifyRestoreHit(components: CacheKeyComponents, hit: RestoreHit): RestoreSource | null {
  if (hit.store === 'object-store') {
    return {store: 'object-store', generation: hit.generation, scope: 'repo'}
  }

  for (const generation of ['v2', 'v1'] as const) {
    if (hit.key === buildPrimaryCacheKey(components, generation)) {
      return {store: 'cache', generation, scope: 'exact'}
    }
    const {branch, repo} = buildScopedRestoreKeys(components, generation)
    if (hit.key.startsWith(branch)) {
      return {store: 'cache', generation, scope: 'branch'}
    }
    if (hit.key.startsWith(repo)) {
      return {store: 'cache', generation, scope: 'repo'}
    }
  }

  return null
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
  generation: SessionGeneration = 'v1',
): string {
  const base = `${buildPrimaryCacheKey(components, generation)}-${runId}-${runAttempt}`
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
