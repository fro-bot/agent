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

/**
 * The `CACHE_SAVED` state-key value the harness layer (`cleanup.ts`, `post.ts`) hands off
 * across the main step/post-hook process boundary. Widened from a boolean to this
 * four-value enum so the post hook can gate its retry on durability actually achieved
 * (`durable`, `store-only`) rather than on cache-write success alone — the boolean
 * conflated a store-only save with total failure and caused a redundant object-store
 * upload (see the cache-save-result-contract plan).
 *
 * - `durable`: the cache write itself persisted (`persisted` outcome). Retry is futile
 *   and unnecessary — skip.
 * - `store-only`: the cache write was rejected or errored, but the object store already
 *   persisted the same state. Skip is justified by **durability already achieved through
 *   the other backend**, not by predicting a cache retry would fail — repeating the save
 *   here would only repeat the store upload, not add durability. See the branch in
 *   `post.ts` for why this is not the futility inference the plan's Key Technical
 *   Decisions reject.
 * - `skipped`: `SKIP_CACHE=true` or no cacheable content existed. Deliberate; retry would
 *   just repeat the same no-op.
 * - `not-persisted`: nothing durable happened (checkpoint declined, cache rejected/errored
 *   with no store persistence) — or the state value was absent or unrecognized. The post
 *   hook must retry here: an absent/garbled value must fail toward doing the work, never
 *   toward skipping it, because the post hook is the last chance to persist state.
 */
export type CacheSaveStateValue = 'durable' | 'store-only' | 'skipped' | 'not-persisted'

/** Every valid `CacheSaveStateValue`, used to validate a state string read back from `core.getState`. */
export const CACHE_SAVE_STATE_VALUES: readonly CacheSaveStateValue[] = [
  'durable',
  'store-only',
  'skipped',
  'not-persisted',
]

type CacheSaveStateMapper = (result: CacheSaveResult) => CacheSaveStateValue

/**
 * One mapper per `CacheSaveOutcome`, pinned by `satisfies Record<CacheSaveOutcome, ...>` the
 * same way `RESPONSE_SURFACE_POLICIES` (`packages/runtime/src/agent/prompt.ts`) pins response
 * surfaces: adding a new outcome to the union without adding a case here fails `check-types`,
 * rather than the new outcome silently mapping to nothing (or falling through to a wrong
 * default) in `cleanup.ts`.
 */
const OUTCOME_TO_STATE_VALUE = {
  'skipped-by-configuration': () => 'skipped',
  'skipped-empty': () => 'skipped',
  'checkpoint-declined': () => 'not-persisted',
  // A rejected or errored cache write is not-persisted UNLESS the object store already
  // achieved durability independently — the double-sync bug this plan exists to fix.
  'cache-rejected': result => (result.storePersisted ? 'store-only' : 'not-persisted'),
  'cache-error': result => (result.storePersisted ? 'store-only' : 'not-persisted'),
  // `persisted` always has cachePersisted: true (see the type doc above), so it is always
  // durable regardless of storePersisted.
  persisted: () => 'durable',
} as const satisfies Record<CacheSaveOutcome, CacheSaveStateMapper>

/**
 * Derives the `CACHE_SAVED` state value to hand off to the post hook from a `CacheSaveResult`.
 * The single place this mapping happens — `cleanup.ts` calls this rather than re-deriving the
 * enum from the result's fields itself, so there is exactly one spot to update if a new
 * outcome or persistence rule is added.
 */
export function toCacheSaveStateValue(result: CacheSaveResult): CacheSaveStateValue {
  return OUTCOME_TO_STATE_VALUE[result.outcome](result)
}

/**
 * Parses a `CACHE_SAVED` state string read back via `core.getState`. Anything absent (`''`,
 * the value `core.getState` returns for an unset key) or unrecognized (e.g. `'true'` from an
 * older action version, or corrupted state) maps to `not-persisted` — fail toward retrying
 * the save, never toward skipping it, since the post hook is the last chance to persist.
 */
export function parseCacheSaveStateValue(value: string): CacheSaveStateValue {
  return (CACHE_SAVE_STATE_VALUES as readonly string[]).includes(value)
    ? (value as CacheSaveStateValue)
    : 'not-persisted'
}
