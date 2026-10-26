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

import type {CoordinationConfig, Result, RunState} from '@fro-bot/runtime'
import type {RepoQuiescenceChecker} from '../execute/repo-quiescence.js'
import type {GatewayLogger} from './client.js'

import {err, ok} from '@fro-bot/runtime'
import {Effect} from 'effect'
import {releaseLockOrByOwnership} from '../execute/lock-release.js'
import {toRuntimeLogger} from '../execute/runtime-logger.js'
import {TERMINAL_WRITE_RETRY, transitionRetryingStaleEtag} from '../execute/stale-etag-transition.js'
import {
  acquireLockEffect,
  createHeartbeatController,
  createRunEffect,
  releaseLockEffect,
  releaseLockIfHolderEffect,
  transitionRunEffect,
} from '../runtime-effect.js'

/** Runs a runtime-effect call to a `Result`, so the shared release helper sees both kinds of release alike. */
async function toResult<A>(effect: Effect.Effect<A, Error>): Promise<Result<A, Error>> {
  const settled = await Effect.runPromise(effect.pipe(Effect.either))
  return settled._tag === 'Right' ? ok(settled.right) : err(settled.left)
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
  /** An expired lease exists but the workspace is not confirmed clear; nothing was mutated. */
  | {readonly outcome: 'blocked'; readonly reason: 'workspace-busy' | 'workspace-unknown'}
  | {readonly outcome: 'error'; readonly message: string}

/**
 * Run ids of maintenance runs whose heartbeat is live in this process. A maintenance run heartbeats its record like any
 * run but is not in the abort registry, so the stranded-run sweep asks this set before it treats a stale-looking
 * EXECUTING record as orphaned. An id is added once the record exists and removed when the release finishes, whatever
 * its writes returned.
 */
const inFlightMaintenanceRunIds = new Set<string>()

/** Whether a maintenance run with this id is heartbeating in this process. */
export function isMaintenanceRunInFlight(runId: string): boolean {
  return inFlightMaintenanceRunIds.has(runId)
}

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
  /** Required: an expired lease is only taken over once the repo workspace is confirmed clear. */
  readonly checkRepoQuiescence: RepoQuiescenceChecker
}): Effect.Effect<AcquireMaintenanceRunResult> {
  const {coordinationConfig, identity, repo, kind, logger, checkRepoQuiescence} = opts
  const coordLogger = toRuntimeLogger(logger)
  const runId = crypto.randomUUID()

  return Effect.gen(function* () {
    // Minted per acquisition: the holder fields repeat across this gateway's runs, so renewal adoption matches on it.
    const acquisitionToken = crypto.randomUUID()
    const lockResult = yield* acquireLockEffect(coordinationConfig, repo, identity, 'discord', runId, coordLogger, {
      confirmExpiredHolder: checkRepoQuiescence,
      acquisitionToken,
    }).pipe(Effect.either)
    if (lockResult._tag === 'Left') {
      return {outcome: 'error' as const, message: lockResult.left.message}
    }
    if (lockResult.right.acquired === false) {
      if (lockResult.right.outcome === 'expired-holder') {
        const reason = lockResult.right.confirmation.kind === 'busy' ? 'workspace-busy' : 'workspace-unknown'
        return {outcome: 'blocked' as const, reason}
      }
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

    const heartbeat = createHeartbeatController(
      coordinationConfig,
      identity,
      repo,
      runId,
      lockEtag,
      runEtag,
      coordLogger,
      acquisitionToken,
    )
    heartbeat.start()
    inFlightMaintenanceRunIds.add(runId)
    let stopped = false

    const release = (finalPhase: 'COMPLETED' | 'FAILED', detailsPatch?: Record<string, unknown>): Effect.Effect<void> =>
      Effect.gen(function* () {
        let finalLockEtag = lockEtag
        // A failed stop leaves `runEtag` possibly stale (every tick rewrites the RunState); the terminal write
        // retries either way.
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
            // A failed stop still reports the freshest ETags its successful writes produced.
            if (stopResult._tag === 'Right' && stopResult.right.success === false) {
              finalLockEtag = stopResult.right.error.lockEtag
              runEtag = stopResult.right.error.runEtag
            }
            logger.warn({repo, runId}, 'maintenance-run: heartbeat stop failed; using the etags it last confirmed')
          }
        }
        const attempt = async (etag: string) => {
          const attempted = await Effect.runPromise(
            transitionRunEffect(
              coordinationConfig,
              identity,
              repo,
              runId,
              finalPhase,
              etag,
              coordLogger,
              detailsPatch === undefined ? undefined : {detailsPatch},
            ).pipe(Effect.either),
          )
          return attempted._tag === 'Right' ? ok(attempted.right) : err(attempted.left)
        }
        // Every terminal write retries (three bounded attempts), whether or not the stop was clean: a lost conditional
        // write or a transient store error must not strand the record, and a failed stop only makes it likelier.
        const transitionResult = yield* Effect.promise(async () =>
          transitionRetryingStaleEtag({
            config: coordinationConfig,
            identity,
            repo,
            runId,
            etag: runEtag,
            logger,
            attempt,
            ...TERMINAL_WRITE_RETRY,
          }),
        )
        if (transitionResult.success === false) {
          logger.warn({repo, runId, err: transitionResult.error.message}, 'maintenance-run: terminal transition failed')
        }
        // A renewal the heartbeat lost track of may have moved the lock's ETag past the one held; the ownership
        // fallback then deletes our own record and leaves a successor's alone.
        const released = yield* Effect.promise(async () =>
          releaseLockOrByOwnership({
            releaseByEtag: async () =>
              toResult(releaseLockEffect(coordinationConfig, repo, finalLockEtag, coordLogger)),
            releaseIfHolder: async (token, signal) =>
              toResult(
                releaseLockIfHolderEffect(coordinationConfig, repo, identity, coordLogger, {
                  acquisitionToken: token,
                  runId,
                  signal,
                }),
              ),
            acquisitionToken,
            logger,
            context: {repo, runId},
            label: 'maintenance-run',
          }),
        )
        if (released.success === false) {
          logger.warn({repo, runId, err: released.error.message}, 'maintenance-run: releaseLock failed')
        }
      }).pipe(
        // Forgotten whatever the writes returned, and even if the release itself is interrupted.
        Effect.ensuring(
          Effect.sync(() => {
            inFlightMaintenanceRunIds.delete(runId)
          }),
        ),
      )

    return {outcome: 'acquired' as const, handle: {runId, release}}
  })
}
