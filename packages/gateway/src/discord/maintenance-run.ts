/**
 * Maintenance run lifecycle for Discord-initiated operator actions that must hold the per-repo
 * coordination lock without running a full agent session: `/fro-bot recover-checkout` (and its
 * Recover-entry button twin) and `/fro-bot checkout-backup delete`'s confirmation.
 *
 * Acquires the SAME repo lock a normal agent run holds (`execute/run.ts`'s `executeWorkOnHeldSlot`),
 * refusing immediately (never waiting) if a run already holds it, and creates a `RunState` record
 * with a live heartbeat so the lock lease renews for as long as the operator is looking at the
 * ephemeral preview. `release()` is the single exit point: it stops the heartbeat, transitions the
 * run to a terminal phase, and releases the lock, in that order (mirrors `run.ts`'s own
 * heartbeat-stop-before-lock-release discipline) \u2014 called from every terminal branch (success,
 * refusal, failure, cancel, expiry) so the lock is never left held.
 */

import type {CoordinationConfig, RunState} from '@fro-bot/runtime'
import type {GatewayLogger} from './client.js'

import {Effect} from 'effect'
import {
  acquireLockEffect,
  createHeartbeatController,
  createRunEffect,
  releaseLockEffect,
  transitionRunEffect,
} from '../runtime-effect.js'

/** Narrow logger adapter for runtime coordination calls \u2014 mirrors `execute/run.ts`'s `toCoordLogger`. */
function toCoordLogger(logger: GatewayLogger): {debug: (message: string, context?: Record<string, unknown>) => void} {
  return {debug: (msg, ctx) => logger.debug(ctx ?? {}, msg)}
}

export interface MaintenanceRunHandle {
  readonly runId: string
  /**
   * Terminalize the run and release the lock. `detailsPatch` is merged into the run's `details`
   * atomically with the terminal transition (e.g. `{kind: 'recover-checkout', outcome: 'success'}`).
   * Safe to call at most once per handle \u2014 callers own single-exit-point discipline.
   */
  readonly release: (finalPhase: 'COMPLETED' | 'FAILED', detailsPatch?: Record<string, unknown>) => Effect.Effect<void>
}

export type AcquireMaintenanceRunResult =
  | {readonly outcome: 'acquired'; readonly handle: MaintenanceRunHandle}
  | {readonly outcome: 'lock-held'; readonly holderId: string | null}
  | {readonly outcome: 'error'; readonly message: string}

/**
 * Acquire the repo lock and create a heartbeating maintenance run record. Never waits for a held
 * lock \u2014 `lock-held` is returned immediately so the caller can refuse with a named reason.
 */
export function acquireMaintenanceRun(opts: {
  readonly coordinationConfig: CoordinationConfig
  readonly identity: string
  readonly repo: string
  readonly kind: string
  readonly logger: GatewayLogger
}): Effect.Effect<AcquireMaintenanceRunResult> {
  const {coordinationConfig, identity, repo, kind, logger} = opts
  const coordLogger = toCoordLogger(logger)
  const runId = crypto.randomUUID()

  return Effect.gen(function* () {
    const lockResult = yield* acquireLockEffect(coordinationConfig, repo, identity, 'discord', runId, coordLogger).pipe(
      Effect.either,
    )
    if (lockResult._tag === 'Left') {
      return {outcome: 'error' as const, message: lockResult.left.message}
    }
    if (lockResult.right.acquired === false) {
      return {outcome: 'lock-held' as const, holderId: lockResult.right.holder?.holder_id ?? null}
    }
    const lockEtag = lockResult.right.etag

    const now = new Date().toISOString()
    const runState: RunState = {
      run_id: runId,
      surface: 'discord',
      thread_id: '',
      entity_ref: repo,
      phase: 'EXECUTING',
      started_at: now,
      last_heartbeat: now,
      holder_id: identity,
      details: {kind},
    }
    const createResult = yield* createRunEffect(coordinationConfig, identity, repo, runState, coordLogger).pipe(
      Effect.either,
    )
    if (createResult._tag === 'Left') {
      yield* releaseLockEffect(coordinationConfig, repo, lockEtag, coordLogger).pipe(Effect.either)
      return {outcome: 'error' as const, message: createResult.left.message}
    }
    let runEtag = createResult.right.etag

    const heartbeat = createHeartbeatController(coordinationConfig, identity, repo, runId, lockEtag, coordLogger)
    heartbeat.start()
    let stopped = false

    const release = (finalPhase: 'COMPLETED' | 'FAILED', detailsPatch?: Record<string, unknown>): Effect.Effect<void> =>
      Effect.gen(function* () {
        let finalLockEtag = lockEtag
        if (stopped === false) {
          stopped = true
          const stopResult = yield* Effect.tryPromise({
            try: async () => heartbeat.stop(),
            catch: error => (error instanceof Error ? error : new Error(String(error))),
          }).pipe(Effect.either)
          if (stopResult._tag === 'Right' && stopResult.right.success === true) {
            runEtag = stopResult.right.data.runEtag
            finalLockEtag = stopResult.right.data.lockEtag
          } else {
            logger.warn({repo, runId}, 'maintenance-run: heartbeat stop failed; using last known etags')
          }
        }
        const transitionResult = yield* transitionRunEffect(
          coordinationConfig,
          identity,
          repo,
          runId,
          finalPhase,
          runEtag,
          coordLogger,
          detailsPatch === undefined ? undefined : {detailsPatch},
        ).pipe(Effect.either)
        if (transitionResult._tag === 'Left') {
          logger.warn({repo, runId, err: transitionResult.left.message}, 'maintenance-run: terminal transition failed')
        }
        yield* releaseLockEffect(coordinationConfig, repo, finalLockEtag, coordLogger).pipe(
          Effect.tapError(error =>
            Effect.sync(() => logger.warn({repo, runId, err: error.message}, 'maintenance-run: releaseLock failed')),
          ),
          Effect.either,
        )
      })

    return {outcome: 'acquired' as const, handle: {runId, release}}
  })
}
