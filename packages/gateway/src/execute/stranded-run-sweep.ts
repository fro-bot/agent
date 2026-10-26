/**
 * The periodic stranded-run sweep's scheduler.
 *
 * A run whose terminal RunState write failed (even after its retries) stays EXECUTING, and so does a run whose
 * process died. Startup recovery only heals the second kind, and only at the next boot. This ticks every minute
 * while the gateway runs and hands each pass to `recoverStaleRuns` (see `program.ts` for the options it passes).
 *
 * Lifecycle: an unref'd interval whose first tick is one interval after `start`; a pass never starts while the
 * previous one is running; each pass gets a signal that aborts at `STRANDED_RUN_SWEEP_PASS_BOUND_MS` (the pass stops
 * between repos, runs and records) and when the sweep is stopped. A pass that has not ended by the bound is abandoned,
 * so one stuck store call cannot stop the ticking. `start` after `stop` does nothing. A failing pass is logged and never stops the ticking.
 */

import type {RunState} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {RecoverStaleRunsDeps} from './recovery.js'
import {toErrorMessage} from '@fro-bot/runtime'
import {isMaintenanceRunInFlight} from '../discord/maintenance-run.js'
import {abortRegistry} from './abort-registry.js'
import {isRunLive} from './live-run-registry.js'
import {recoverStaleRuns} from './recovery.js'

/** How often a pass runs. A stranded record is therefore repaired within its stale threshold plus about a minute. */
export const STRANDED_RUN_SWEEP_INTERVAL_MS = 60_000

/**
 * A pass reads only run records modified within this window. A run that is alive keeps writing its record every
 * heartbeat, so a record untouched for an hour is terminal or long dead; the latter is startup recovery's, which scans
 * everything. It bounds the reads, not the listing.
 */
export const STRANDED_RUN_READ_WINDOW_MS = 60 * 60_000

/** How long one pass may run before its signal aborts. Four minutes: well past a normal pass, short of overlapping many. */
export const STRANDED_RUN_SWEEP_PASS_BOUND_MS = 4 * 60_000

/**
 * What a swept run's thread is told. It does not claim the run was interrupted by a restart, nor that nothing was
 * posted before: the failure reply may already have gone out, and this only confirms the record's final state.
 */
export const STRANDED_RUN_NOTE = "This run's status was reconciled: it is no longer running."

/**
 * Whether this process is still running `runId`: a mention or web run (in the live-run set from its ACKNOWLEDGED commit
 * to the end of the run or its quarantine hold, and in the abort registry while it executes) or a maintenance run
 * (heartbeating, but never in the abort registry). Such a record can look stale
 * during a stalled heartbeat tick and must not be terminalized.
 */
export function isRunOwnedByThisProcess(runId: string): boolean {
  return isRunLive(runId) || abortRegistry.has(runId) || isMaintenanceRunInFlight(runId)
}

export interface StrandedRunPassDeps {
  /** The same wiring startup recovery uses. */
  readonly recoverDeps: RecoverStaleRunsDeps
  /** Tells the run observer that a swept run is terminal, so its subscribers close instead of waiting it out. */
  readonly observeTerminal: (state: RunState) => void
  /** Whether this process still owns the run: it is in the abort registry, or it is an in-flight maintenance run. */
  readonly isOwned: (runId: string) => boolean
}

/**
 * One sweep pass: EXECUTING records only, never a run this process owns, no workspace gate (the write releases no
 * lock, and a busy workspace must not keep a dead run looking alive), and the neutral note. The write is conditioned
 * on a fresh read's ETag, so a heartbeat landing after the read makes it lose and the run is skipped.
 */
export function createStrandedRunPass(deps: StrandedRunPassDeps): (signal: AbortSignal) => Promise<void> {
  // Each pass starts one binding further on, so a repo that keeps a pass from ever finishing cannot starve the rest.
  let startOffset = 0
  return async signal =>
    recoverStaleRuns(deps.recoverDeps, {
      startOffset: startOffset++,
      phases: new Set<RunState['phase']>(['EXECUTING', 'ACKNOWLEDGED']),
      isOwned: deps.isOwned,
      requireQuiescence: false,
      note: STRANDED_RUN_NOTE,
      modifiedSince: new Date(Date.now() - STRANDED_RUN_READ_WINDOW_MS),
      observeTerminal: deps.observeTerminal,
      signal,
    })
}

export interface StrandedRunSweepDeps {
  /** One pass. Must stop promptly (between units of work) once `signal` aborts. */
  readonly pass: (signal: AbortSignal) => Promise<void>
  readonly logger: GatewayLogger
  /** Test seams; the defaults are the shipped values. */
  readonly intervalMs?: number
  readonly passBoundMs?: number
}

export interface StrandedRunSweep {
  /** Starts the interval. A second call is a no-op. */
  readonly start: () => void
  /** Clears the interval and aborts the pass that is running, if any. Safe to call more than once. */
  readonly stop: () => void
}

export function createStrandedRunSweep(deps: StrandedRunSweepDeps): StrandedRunSweep {
  const {
    pass,
    logger,
    intervalMs = STRANDED_RUN_SWEEP_INTERVAL_MS,
    passBoundMs = STRANDED_RUN_SWEEP_PASS_BOUND_MS,
  } = deps
  let timer: ReturnType<typeof setInterval> | undefined
  let running: AbortController | undefined
  let stopped = false

  function tick(): void {
    if (running !== undefined) {
      logger.debug({}, 'stranded-run sweep: previous pass still running — skipping this tick')
      return
    }
    const controller = new AbortController()
    running = controller
    let abandoned = false
    let bound: ReturnType<typeof setTimeout> | undefined
    const endPass = (): void => {
      clearTimeout(bound)
      if (running === controller) running = undefined
    }
    // When the bound wins the pass is abandoned and the next tick may start a new one, so a pass stuck in a store call
    // that ignores its signal cannot wedge the sweep. Whatever the abandoned pass still writes is an ETag-conditional
    // write, so a late one either lands the same repair or loses.
    bound = setTimeout(() => {
      abandoned = true
      logger.warn({passBoundMs}, 'stranded-run sweep: pass exceeded its bound — aborting it')
      controller.abort()
      endPass()
    }, passBoundMs)
    pass(controller.signal)
      .catch((error: unknown) => {
        if (abandoned) {
          logger.debug({err: toErrorMessage(error)}, 'stranded-run sweep: abandoned pass ended with an error')
          return
        }
        logger.error({err: toErrorMessage(error)}, 'stranded-run sweep: pass failed')
      })
      .finally(endPass)
  }

  return {
    start: () => {
      // A stop that landed first (shutdown during startup recovery) wins: nothing is scheduled afterwards.
      if (stopped || timer !== undefined) return
      timer = setInterval(tick, intervalMs)
      timer.unref()
    },
    stop: () => {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      running?.abort()
      running = undefined
    },
  }
}
