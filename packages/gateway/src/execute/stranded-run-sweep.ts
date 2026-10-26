/**
 * The periodic stranded-run sweep's scheduler.
 *
 * A run whose terminal RunState write failed (even after its retries) stays EXECUTING, and so does a run whose
 * process died. Startup recovery only heals the second kind, and only at the next boot. This ticks every minute
 * while the gateway runs and hands each pass to `recoverStaleRuns` (see `program.ts` for the options it passes).
 *
 * Lifecycle: an unref'd interval whose first tick is one interval after `start`; a pass never starts while the
 * previous one is running; each pass gets a signal that aborts at `STRANDED_RUN_SWEEP_PASS_BOUND_MS` (the pass stops
 * between repos and runs) and when the sweep is stopped. A failing pass is logged and never stops the ticking.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {RecoverStaleRunsDeps} from './recovery.js'
import {toErrorMessage} from '@fro-bot/runtime'
import {isMaintenanceRunInFlight} from '../discord/maintenance-run.js'
import {abortRegistry} from './abort-registry.js'
import {recoverStaleRuns} from './recovery.js'

/** How often a pass runs. A stranded record is therefore repaired within its stale threshold plus about a minute. */
export const STRANDED_RUN_SWEEP_INTERVAL_MS = 60_000

/** How long one pass may run before its signal aborts. Four minutes: well past a normal pass, short of overlapping many. */
export const STRANDED_RUN_SWEEP_PASS_BOUND_MS = 4 * 60_000

/**
 * What a swept run's thread is told. It does not claim the run was interrupted by a restart, nor that nothing was
 * posted before: the failure reply may already have gone out, and this only confirms the record's final state.
 */
export const STRANDED_RUN_NOTE = "This run's status was reconciled: it is no longer running."

/**
 * Whether this process is still running `runId`: a mention or web run (registered in the abort registry for its whole
 * execution) or a maintenance run (heartbeating, but never in the abort registry). Such a record can look stale
 * during a stalled heartbeat tick and must not be terminalized.
 */
export function isRunOwnedByThisProcess(runId: string): boolean {
  return abortRegistry.has(runId) || isMaintenanceRunInFlight(runId)
}

export interface StrandedRunPassDeps {
  /** The same wiring startup recovery uses. */
  readonly recoverDeps: RecoverStaleRunsDeps
  /** Whether this process still owns the run: it is in the abort registry, or it is an in-flight maintenance run. */
  readonly isOwned: (runId: string) => boolean
}

/**
 * One sweep pass: EXECUTING records only, never a run this process owns, no workspace gate (the write releases no
 * lock, and a busy workspace must not keep a dead run looking alive), and the neutral note. The write is conditioned
 * on a fresh read's ETag, so a heartbeat landing after the read makes it lose and the run is skipped.
 */
export function createStrandedRunPass(deps: StrandedRunPassDeps): (signal: AbortSignal) => Promise<void> {
  return async signal =>
    recoverStaleRuns(deps.recoverDeps, {
      phases: new Set(['EXECUTING']),
      isOwned: deps.isOwned,
      requireQuiescence: false,
      note: STRANDED_RUN_NOTE,
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

  function tick(): void {
    if (running !== undefined) {
      logger.debug({}, 'stranded-run sweep: previous pass still running — skipping this tick')
      return
    }
    const controller = new AbortController()
    running = controller
    const bound = setTimeout(() => {
      logger.warn({passBoundMs}, 'stranded-run sweep: pass exceeded its bound — aborting it')
      controller.abort()
    }, passBoundMs)
    // The pass is awaited to the end even after its abort, so two passes never overlap.
    pass(controller.signal)
      .catch((error: unknown) => {
        logger.error({err: toErrorMessage(error)}, 'stranded-run sweep: pass failed')
      })
      .finally(() => {
        clearTimeout(bound)
        running = undefined
      })
  }

  return {
    start: () => {
      if (timer !== undefined) return
      timer = setInterval(tick, intervalMs)
      timer.unref()
    },
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      running?.abort()
    },
  }
}
