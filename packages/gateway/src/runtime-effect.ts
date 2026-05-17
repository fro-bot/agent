/**
 * Effect adapter wrapping @fro-bot/runtime async-Result-returning functions.
 *
 * This is the SINGLE file in the gateway package that imports from @fro-bot/runtime.
 * All other gateway code must import coordination/sync helpers from here.
 */

import type {
  CoordinationConfig,
  LockAcquisitionResult,
  LockRecord,
  Logger,
  ObjectStoreAdapter,
  ObjectStoreConfig,
  RunPhase,
  RunState,
  Surface,
} from '@fro-bot/runtime'

import {
  acquireLock,
  createRun,
  findStaleRuns,
  forceReleaseLock,
  releaseLock,
  renewLease,
  syncArtifactsToStore,
  syncMetadataToStore,
  syncSessionsFromStore,
  syncSessionsToStore,
  transitionRun,
  validateProviderSemantics,
} from '@fro-bot/runtime'
import {Effect} from 'effect'

export type {ObjectStoreConfig} from '@fro-bot/runtime'

// ---------------------------------------------------------------------------
// Shared logger type used by all coordination functions
// ---------------------------------------------------------------------------

export interface CoordinationLogger {
  readonly debug: (message: string, context?: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Lock operations
// ---------------------------------------------------------------------------

export const acquireLockEffect = (
  config: CoordinationConfig,
  repo: string,
  holderId: string,
  surface: Surface,
  runId: string,
  logger: CoordinationLogger,
): Effect.Effect<LockAcquisitionResult, Error> =>
  Effect.tryPromise({
    try: async () => acquireLock(config, repo, holderId, surface, runId, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.flatMap(result => (result.success === true ? Effect.succeed(result.data) : Effect.fail(result.error))))

export const releaseLockEffect = (
  config: CoordinationConfig,
  repo: string,
  etag: string,
  logger: CoordinationLogger,
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => releaseLock(config, repo, etag, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.flatMap(result => (result.success === true ? Effect.succeed(result.data) : Effect.fail(result.error))))

export const renewLeaseEffect = (
  config: CoordinationConfig,
  repo: string,
  lockRecord: LockRecord,
  etag: string,
  logger: CoordinationLogger,
): Effect.Effect<{etag: string}, Error> =>
  Effect.tryPromise({
    try: async () => renewLease(config, repo, lockRecord, etag, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.flatMap(result => (result.success === true ? Effect.succeed(result.data) : Effect.fail(result.error))))

export const forceReleaseLockEffect = (
  config: CoordinationConfig,
  repo: string,
  etag: string,
  logger: CoordinationLogger,
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => forceReleaseLock(config, repo, etag, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.flatMap(result => (result.success === true ? Effect.succeed(result.data) : Effect.fail(result.error))))

// ---------------------------------------------------------------------------
// Run-state operations
// ---------------------------------------------------------------------------

export const createRunEffect = (
  config: CoordinationConfig,
  identity: string,
  repo: string,
  runState: RunState,
  logger: CoordinationLogger,
): Effect.Effect<{etag: string}, Error> =>
  Effect.tryPromise({
    try: async () => createRun(config, identity, repo, runState, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.flatMap(result => (result.success === true ? Effect.succeed(result.data) : Effect.fail(result.error))))

export const transitionRunEffect = (
  config: CoordinationConfig,
  identity: string,
  repo: string,
  runId: string,
  newPhase: RunPhase,
  etag: string,
  logger: CoordinationLogger,
): Effect.Effect<{etag: string; state: RunState}, Error> =>
  Effect.tryPromise({
    try: async () => transitionRun(config, identity, repo, runId, newPhase, etag, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.flatMap(result => (result.success === true ? Effect.succeed(result.data) : Effect.fail(result.error))))

export const findStaleRunsEffect = (
  config: CoordinationConfig,
  identity: string,
  repo: string,
  logger: CoordinationLogger,
): Effect.Effect<RunState[], Error> =>
  Effect.tryPromise({
    try: async () => findStaleRuns(config, identity, repo, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.flatMap(result => (result.success === true ? Effect.succeed(result.data) : Effect.fail(result.error))))

// ---------------------------------------------------------------------------
// Self-test / provider semantics
// ---------------------------------------------------------------------------

export const validateProviderSemanticsEffect = (
  config: CoordinationConfig,
  logger: CoordinationLogger,
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => validateProviderSemantics(config, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.flatMap(result => (result.success === true ? Effect.succeed(result.data) : Effect.fail(result.error))))

// ---------------------------------------------------------------------------
// S3 sync helpers — plain Promise returns (no Result tag)
// ---------------------------------------------------------------------------

export const syncSessionsToStoreEffect = (
  adapter: ObjectStoreAdapter,
  config: ObjectStoreConfig,
  identity: string,
  repo: string,
  sessionStoragePath: string,
  logger: Logger,
): Effect.Effect<{uploaded: number; failed: number}, Error> =>
  Effect.tryPromise({
    try: async () => syncSessionsToStore(adapter, config, identity, repo, sessionStoragePath, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })

export const syncSessionsFromStoreEffect = (
  adapter: ObjectStoreAdapter,
  config: ObjectStoreConfig,
  identity: string,
  repo: string,
  sessionStoragePath: string,
  logger: Logger,
): Effect.Effect<{downloaded: number; failed: number; mainDbRestored: boolean}, Error> =>
  Effect.tryPromise({
    try: async () => syncSessionsFromStore(adapter, config, identity, repo, sessionStoragePath, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })

export const syncArtifactsToStoreEffect = (
  adapter: ObjectStoreAdapter,
  config: ObjectStoreConfig,
  identity: string,
  repo: string,
  runId: string,
  logPath: string,
  logger: Logger,
): Effect.Effect<{uploaded: number; failed: number}, Error> =>
  Effect.tryPromise({
    try: async () => syncArtifactsToStore(adapter, config, identity, repo, runId, logPath, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })

export const syncMetadataToStoreEffect = (
  adapter: ObjectStoreAdapter,
  config: ObjectStoreConfig,
  identity: string,
  repo: string,
  runId: string,
  metadata: unknown,
  logger: Logger,
): Effect.Effect<{success: boolean}, Error> =>
  Effect.tryPromise({
    try: async () => syncMetadataToStore(adapter, config, identity, repo, runId, metadata, logger),
    catch: error => (error instanceof Error ? error : new Error(String(error))),
  })
