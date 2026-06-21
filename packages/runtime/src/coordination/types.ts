import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'

export type RunPhase = 'PENDING' | 'ACKNOWLEDGED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

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

export type LockAcquisitionResult =
  | {readonly acquired: true; readonly etag: string; readonly holder: null}
  | {readonly acquired: false; readonly etag: null; readonly holder: LockRecord | null}

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
