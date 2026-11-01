import type {CacheRestorePhaseResult, CacheRestoreV2PhaseResult} from './cache-restore.js'

/**
 * Which generation a cache-restore result is for. A V1 result carries no `generation` field (V1 behaviour is untouched), so
 * this guard is the one way to tell them apart. It lives apart from `cache-restore.ts` so the phases that only need to
 * branch do not import the phase that spawns the server.
 */
export function isCacheRestoreV2(
  result: CacheRestorePhaseResult | CacheRestoreV2PhaseResult,
): result is CacheRestoreV2PhaseResult {
  return 'generation' in result && result.generation === 'v2'
}
