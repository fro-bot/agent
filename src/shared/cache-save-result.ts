/**
 * Terminal outcome of a `saveCache` attempt, mirroring the shape of `CheckpointOutcome`
 * (`src/services/cache/checkpoint.ts`): a structural axis (here, two independent
 * persistence axes) plus a named terminal condition, rather than a single boolean that
 * collapses "deliberately skipped", "denied", and "succeeded" into the same two poles.
 *
 * - `skipped-by-configuration`: `SKIP_CACHE=true`. Neither backend was attempted.
 * - `skipped-empty`: no cacheable content existed. Neither backend was attempted.
 * - `checkpoint-declined`: the SQLite write-ahead log could not be checkpointed before
 *   the save could proceed. Neither backend was attempted.
 * - `cache-rejected`: the Actions cache write returned its `-1` failure sentinel. `@actions/cache@6.2.0`
 *   distinguishes a policy denial (`CacheWriteDeniedError`) from a reservation collision
 *   (`ReserveCacheError`) internally, but neither survives the `saveCache()` call
 *   boundary — both return `-1` with no further detail. **This is an inference, not an
 *   observation**: `cache-rejected` covers both causes because the boundary cannot
 *   distinguish them, not because they were determined to be one or the other. Do not
 *   infer which one occurred from the trigger type, runner configuration, or any other
 *   signal outside this call — a self-hosted runner or customized environment can hold a
 *   writable token even on a comment trigger.
 * - `cache-error`: the save threw an error other than a caught "already exists" collision
 *   (see below). Distinct from `cache-rejected`: this is a thrown exception, not the `-1`
 *   sentinel.
 * - `persisted`: the save reached a durable state through at least one backend. This
 *   includes the case where `cacheAdapter.saveCache` throws an "already exists" error —
 *   folded in here (not a separate outcome) because the cache key is durably written
 *   either way: some other job's concurrent save already committed it, so the state is
 *   present under that key regardless of which run wrote it.
 */
export type CacheSaveOutcome =
  'skipped-by-configuration' | 'skipped-empty' | 'checkpoint-declined' | 'cache-rejected' | 'cache-error' | 'persisted'

/**
 * Structured result of a `saveCache` attempt. `cachePersisted` and `storePersisted` are
 * independent axes — either, both, or neither backend may have durably persisted state
 * in a single save — while `outcome` names the terminal condition that produced them.
 * Durability overall is `cachePersisted || storePersisted`, never either axis alone.
 */
export interface CacheSaveResult {
  readonly cachePersisted: boolean
  readonly storePersisted: boolean
  readonly outcome: CacheSaveOutcome
}
