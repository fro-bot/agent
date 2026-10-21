import type {Logger} from '../shared/logger.js'
import type {Result} from '../shared/types.js'
import type {CoordinationConfig, RunState} from './types.js'

import {buildObjectStoreKey} from '../object-store/key-builder.js'
import {err, ok} from '../shared/types.js'
import {requireConditionalPut, requireGetObject, resolveGetObject} from './adapter-guards.js'
import {createLeaseLoop} from './lease-loop.js'
import {renewLease} from './lock.js'
import {parseRunState, RUN_STATE_TAG} from './run-state.js'

/**
 * The total time `stop()` spends waiting on an in-flight tick and then reading the final snapshot before it gives up.
 * Also the budget of the gateway's stale-ETag recovery read (`stale-etag-transition.ts`), which follows a failed stop.
 */
export const HEARTBEAT_STOP_GRACE_MS = 5_000

/**
 * Bounds one heartbeat tick (RunState read, lock renewal, RunState write). The same bound the Action puts on its
 * renewal, and well under `DEFAULT_HEARTBEAT_INTERVAL_MS` so a hung request fails before the next tick is due.
 */
const HEARTBEAT_TICK_TIMEOUT_MS = 10_000

/**
 * What the controller logs through. `info` and `warning` are optional so a caller that only has a `debug` sink still
 * works: the missing levels fall back to `debug`. Production callers pass the full runtime `Logger`.
 */
export type HeartbeatLogger = Pick<Logger, 'debug'> & Partial<Pick<Logger, 'info' | 'warning'>>

export interface HeartbeatStopResult {
  /** Current ETag of the run-state object after the final heartbeat tick. */
  readonly runEtag: string
  /** Current run state after the final heartbeat tick. */
  readonly runState: RunState
  /** Current ETag of the lock record after the most recent lease renewal. */
  readonly lockEtag: string
}

/**
 * The failure side of `stop()`. Still an `Error` (so `.message` consumers keep working), plus the facts a caller
 * needs to settle conservatively.
 */
export interface HeartbeatStopError extends Error {
  /**
   * The freshest lock ETag a renewal confirmed (the acquisition ETag if none did). Tracked apart from the RunState
   * ETag: a tick can renew the lock and then fail the RunState write, and release must still use the renewed ETag.
   * With `tickPending` it may already be stale; a conditional release then fails safely and the lease lapses via TTL.
   */
  readonly lockEtag: string
  /**
   * The ETag of the controller's last successful RunState write (the ETag it was constructed with if none
   * succeeded). Every tick rewrites the RunState, so a terminal transition that uses an older ETag loses its
   * conditional write; with `tickPending`, one late write may still land and make this stale too.
   */
  readonly runEtag: string
  /**
   * True when the grace period elapsed while a tick was still in flight. That tick may yet renew the lock or
   * write the RunState (until its own tick timeout), so neither ETag the caller holds can be trusted to be current.
   */
  readonly tickPending: boolean
}

export interface HeartbeatController {
  /** Starts the tick interval. A no-op after `stop()` has run: a stopped controller is final, a restart needs a new one. */
  readonly start: () => void
  /**
   * Quiesce the heartbeat timer and return an authoritative snapshot of the run state.
   *
   * Never rejects: every failure, including an adapter that throws, comes back as a `HeartbeatStopError`.
   *
   * `stop()` is liveness-only: it does not perform a terminal `transitionRun`. The caller
   * owns the run lifecycle and uses the returned `runEtag` to transition the run to
   * `COMPLETED`, `FAILED`, or `CANCELLED` after handling any post-shutdown work.
   *
   * One `HEARTBEAT_STOP_GRACE_MS` budget covers the whole call: the wait on an in-flight tick and the snapshot read
   * share it, so `stop()` resolves within about one grace period. If a tick is still pending when it elapses,
   * returns a `tickPending` error without reading a snapshot: its request is aborted at that point, but the tick
   * stays live until its own tick timeout and the caller's ETags may be stale, so it must settle best-effort (a conditional write or release that loses the race
   * fails safely). If the snapshot read is still pending, returns an error with `tickPending` false and the ETags
   * confirmed so far.
   *
   * `stop()` first marks the controller stopping, so a tick that has not yet started its lock renewal or its
   * RunState write skips that I/O, and no RunState read starts after `stop()`. `stop()` does not supersede a tick: a
   * request already in flight when it began can still land, and a result that arrives before that tick's own timeout
   * is applied (a late renewal restarts the lease TTL, a late RunState write changes the run ETag). Requests are
   * aborted when the tick timeout or this budget runs out, never when `stop()` begins; that narrows the window but
   * cannot close it, because a PUT aborted on the client can still commit server-side. A result that arrives after
   * its tick timed out is ignored.
   *
   * If a heartbeat tick failed since the last successful tick, returns the tick error. Every failure carries
   * `lockEtag`, the freshest lock ETag a renewal confirmed, so a RunState write that failed after a successful
   * renewal does not strand the caller on the acquisition ETag, and `runEtag`, the ETag of the last successful
   * RunState write.
   * Otherwise returns the freshest snapshot fetched after in-flight ticks complete.
   */
  readonly stop: () => Promise<Result<HeartbeatStopResult, HeartbeatStopError>>
  readonly isRunning: boolean
}

function getRunKey(config: CoordinationConfig, identity: string, repo: string, runId: string): Result<string, Error> {
  const key = buildObjectStoreKey(config.storeConfig, identity, repo, 'runs', `${runId}.json`)
  if (key.success === false) {
    return err(key.error)
  }

  return ok(key.data)
}

export function createHeartbeatController(
  config: CoordinationConfig,
  identity: string,
  repo: string,
  runId: string,
  lockEtag: string,
  runEtag: string,
  logger: HeartbeatLogger,
  /** The per-acquisition token `acquireLock` wrote; every renewal record keeps it. Omit for a lock acquired without one. */
  acquisitionToken?: string,
): HeartbeatController {
  const runKey = getRunKey(config, identity, repo, runId)
  if (runKey.success === false) {
    throw runKey.error
  }

  // Tracked apart from the lock ETag, which the loop owns: the lock and the RunState are separate objects and a tick
  // can advance one without the other.
  let currentRunEtag = runEtag
  let stopRequested = false

  const loopLogger: Pick<Logger, 'debug' | 'info' | 'warning'> = {
    debug: (message, context) => logger.debug(message, context),
    info: (message, context) => (logger.info ?? logger.debug)(message, context),
    warning: (message, context) => (logger.warning ?? logger.debug)(message, context),
  }

  const readRunState = async (
    signal: AbortSignal | undefined,
  ): Promise<{readonly state: RunState; readonly etag: string}> => {
    const getObject = requireGetObject(config)
    const current = await getObject(runKey.data, signal === undefined ? undefined : {signal})
    if (current.success === false) {
      throw current.error
    }
    const parsed = parseRunState(current.data.data)
    if (parsed.success === false) {
      throw parsed.error
    }
    return {state: parsed.data, etag: current.data.etag}
  }

  const loop = createLeaseLoop({
    renew: async (record, etag, signal) => renewLease(config, repo, record, etag, logger, 'repo', signal),
    initialEtag: lockEtag,
    intervalMs: config.heartbeatIntervalMs,
    tickTimeoutMs: HEARTBEAT_TICK_TIMEOUT_MS,
    stopBudgetMs: HEARTBEAT_STOP_GRACE_MS,
    // A daemon: nothing here may be left to keep the process alive, and nothing needs to be told to let go of it.
    unref: false,
    abortOnDeadline: true,
    logger: loopLogger,
    logContext: {repo, runId},
    tick: async ctx => {
      // A tick must not start new I/O once stop has begun.
      if (ctx.isStopping()) return

      const current = await readRunState(ctx.signal)
      const nextState: RunState = {...current.state, last_heartbeat: new Date().toISOString()}

      // Renew the lock lease BEFORE writing the heartbeat. If renewal fails, the heartbeat timestamp stays stale so
      // findStaleRuns correctly flags this run. The reverse order (heartbeat first, lease second) causes split-brain:
      // the run looks fresh but the lock TTL expires, allowing another gateway to steal the lock. `renewLock` throws
      // on an unconfirmed renewal, which skips the write.
      const renewed = await ctx.renewLock({
        repo,
        holder_id: nextState.holder_id,
        surface: nextState.surface,
        acquired_at: nextState.last_heartbeat,
        ttl_seconds: config.lockTtlSeconds,
        run_id: nextState.run_id,
        ...(acquisitionToken === undefined ? {} : {acquisition_token: acquisitionToken}),
      })
      // Stop began, or this attempt timed out, before the write: a late write would change the run ETag after the
      // caller has already tried to settle it.
      if (renewed === 'skipped' || ctx.isStopping() || !ctx.isCurrent()) return

      const written = await requireConditionalPut(config)(runKey.data, JSON.stringify(nextState), {
        ifMatch: current.etag,
        tagging: RUN_STATE_TAG,
        ...(ctx.signal === undefined ? {} : {signal: ctx.signal}),
      })
      if (written.success === false) {
        throw written.error
      }
      // A write that returns after its tick timed out must not move the ETag the caller will transition with.
      if (ctx.isCurrent()) currentRunEtag = written.data.etag
    },
    finalize: async signal => {
      const getObject = resolveGetObject(config)
      if (getObject.success === false) {
        throw getObject.error
      }
      const current = await getObject.data(runKey.data, signal === undefined ? undefined : {signal})
      if (current.success === false) {
        throw current.error
      }
      const parsed = parseRunState(current.data.data)
      if (parsed.success === false) {
        throw parsed.error
      }
      return {runEtag: current.data.etag, runState: parsed.data}
    },
  })

  return {
    start: () => {
      if (loop.isRunning === false && stopRequested === false) {
        logger.debug('Starting heartbeat controller', {repo, runId})
      }
      loop.start()
    },
    stop: async (): Promise<Result<HeartbeatStopResult, HeartbeatStopError>> => {
      logger.debug('Stopping heartbeat controller', {repo, runId})
      stopRequested = true
      const stopped = await loop.stop()
      if (stopped.success === false) {
        const {cause, lockEtag: failedLockEtag, tickPending} = stopped.error
        return err(
          Object.assign(new Error(stopped.error.message, {cause}), {
            lockEtag: failedLockEtag,
            runEtag: currentRunEtag,
            tickPending,
          }),
        )
      }
      const snapshot = stopped.data.final
      // `finalize` is always given, so a success always carries its snapshot.
      if (snapshot === undefined) {
        return err(
          Object.assign(new Error('Heartbeat stop produced no snapshot'), {
            lockEtag: stopped.data.lockEtag,
            runEtag: currentRunEtag,
            tickPending: false,
          }),
        )
      }
      return ok({runEtag: snapshot.runEtag, runState: snapshot.runState, lockEtag: stopped.data.lockEtag})
    },
    get isRunning() {
      return loop.isRunning
    },
  }
}
