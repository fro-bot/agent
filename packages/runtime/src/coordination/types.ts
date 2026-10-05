import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'

export type RunPhase = 'PENDING' | 'ACKNOWLEDGED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

/**
 * The subset of `RunPhase` that is terminal (no further transitions possible).
 * Shared by `cancelRun`'s already-terminal outcome and the operator cancel
 * route's response DTO so both agree on one closed union instead of each
 * hand-writing the same three literals.
 */
export type TerminalPhase = Extract<RunPhase, 'COMPLETED' | 'FAILED' | 'CANCELLED'>

export type Surface = 'github' | 'discord' | 'web'

export interface RunState {
  readonly run_id: string
  readonly surface: Surface
  readonly thread_id: string
  readonly entity_ref: string
  readonly phase: RunPhase
  readonly started_at: string
  readonly last_heartbeat: string
  readonly holder_id: string
  readonly details: Record<string, unknown>
}

export interface LockRecord {
  readonly repo: string
  readonly holder_id: string
  readonly surface: Surface
  readonly acquired_at: string
  readonly ttl_seconds: number
  readonly run_id: string
}

/**
 * Snapshot of whether OpenCode is running anything in a repo's workspace directory.
 * Only `clear` authorizes replacing an expired lease holder; `busy` and `unknown` both block.
 */
export type RepoQuiescence =
  | {
      readonly kind: 'clear'
      readonly source: 'opencode-session-status'
      readonly directory: string
      readonly checkedAt: string
    }
  | {
      readonly kind: 'busy'
      readonly source: 'opencode-session-status'
      readonly directory: string
      readonly checkedAt: string
      readonly sessionIds: readonly string[]
    }
  | {
      readonly kind: 'unknown'
      readonly source: 'opencode-session-status' | 'unavailable'
      readonly directory: string | null
      readonly reason: string
    }

/** A `RepoQuiescence` that did not authorize takeover. */
export type BlockedRepoQuiescence = Exclude<RepoQuiescence, {readonly kind: 'clear'}>

export type ConfirmExpiredHolder = (context: {
  readonly repo: string
  readonly holder: LockRecord
  readonly signal: AbortSignal
}) => Promise<RepoQuiescence>

export interface LockAcquisitionOptions {
  readonly confirmExpiredHolder?: ConfirmExpiredHolder
  /** Holders whose expired leases may be reclaimed without corroboration (e.g. the Action's own surface). */
  readonly reclaimableWithoutConfirmation?: (holder: LockRecord) => boolean
}

/** Logger for lock operations that emit audit events (`info`) alongside diagnostics (`debug`). */
export interface LockLogger {
  readonly debug: (message: string, context?: Record<string, unknown>) => void
  readonly info: (message: string, context?: Record<string, unknown>) => void
}

export type LockAcquisitionResult =
  | {readonly acquired: true; readonly outcome: 'acquired'; readonly etag: string; readonly holder: null}
  | {readonly acquired: false; readonly outcome: 'active-holder'; readonly etag: null; readonly holder: LockRecord}
  | {
      readonly acquired: false
      readonly outcome: 'expired-holder'
      readonly etag: null
      readonly holder: LockRecord
      readonly confirmation: BlockedRepoQuiescence
    }
  | {readonly acquired: false; readonly outcome: 'conflict'; readonly etag: null; readonly holder: null}

export interface CoordinationConfig {
  readonly storeAdapter: ObjectStoreAdapter
  readonly storeConfig: ObjectStoreConfig
  readonly lockTtlSeconds: number
  readonly heartbeatIntervalMs: number
  readonly staleThresholdMs: number
  /**
   * Staleness threshold for PENDING and ACKNOWLEDGED runs (pre-execution phases).
   *
   * Must be much larger than `staleThresholdMs` because queued runs do NOT refresh
   * their heartbeat while waiting — `last_heartbeat` is set once at admission
   * (`createRun`) and is not updated until the heartbeat controller starts after
   * the ACKNOWLEDGED transition. A run legitimately queued behind a long task
   * (default runTimeoutMs = 10 min) can sit PENDING for well over 60 s without
   * being orphaned. Using the short `staleThresholdMs` here would cause the
   * recovery sweep to fail every queued-behind-long-run, silently dropping it.
   *
   * Set to 30 minutes — comfortably above the 10-min runTimeoutMs default plus
   * any realistic queue wait. A PENDING run is only considered genuinely orphaned
   * once it has been pre-execution for longer than any single run could take.
   */
  readonly pendingStaleThresholdMs: number
}

export const DEFAULT_LOCK_TTL_SECONDS = 900
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
export const DEFAULT_STALE_THRESHOLD_MS = 60_000
/**
 * Default staleness threshold for PENDING and ACKNOWLEDGED runs.
 *
 * 30 minutes — much larger than DEFAULT_STALE_THRESHOLD_MS (60 s) because
 * queued runs do not refresh their heartbeat until ACKNOWLEDGED. See
 * `CoordinationConfig.pendingStaleThresholdMs` for the full rationale.
 */
export const DEFAULT_PENDING_STALE_THRESHOLD_MS = 30 * 60_000
