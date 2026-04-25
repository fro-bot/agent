import type {ObjectStoreAdapter, ObjectStoreConfig} from '../object-store/types.js'

export type RunPhase = 'PENDING' | 'ACKNOWLEDGED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export type Surface = 'github' | 'discord'

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

export interface LockAcquisitionResult {
  readonly acquired: boolean
  readonly etag: string | null
  readonly holder: LockRecord | null
}

export interface CoordinationConfig {
  readonly storeAdapter: ObjectStoreAdapter
  readonly storeConfig: ObjectStoreConfig
  readonly lockTtlSeconds: number
  readonly heartbeatIntervalMs: number
  readonly staleThresholdMs: number
}

export const DEFAULT_LOCK_TTL_SECONDS = 900
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
export const DEFAULT_STALE_THRESHOLD_MS = 60_000
