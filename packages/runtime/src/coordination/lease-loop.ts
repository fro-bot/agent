import type {Logger} from '../shared/logger.js'
import type {Result} from '../shared/types.js'
import type {LockRecord} from './types.js'

import {err, ok} from '../shared/types.js'

/** The outcome of one renewal: the lock's new ETag, or the reason it was not confirmed. */
export type LeaseRenewal = Result<{readonly etag: string}, Error>

/** Renews the lock record against `etag`. The surface injects this, so its own renewal (and test seam) stays in use. */
export type LeaseRenew = (record: LockRecord, etag: string, signal?: AbortSignal) => Promise<LeaseRenewal>

/** What a tick body gets to work with. */
export interface LeaseTickContext {
  /** Aborts at the tick timeout or when the stop budget runs out. `undefined` unless `abortOnDeadline` is on. */
  readonly signal: AbortSignal | undefined
  /** True once `stop()` has begun. */
  readonly isStopping: () => boolean
  /** False once this attempt's tick timeout has fired: its results must be dropped, not applied. */
  readonly isCurrent: () => boolean
  /**
   * Renews the lock against the freshest confirmed ETag.
   * - `'skipped'`: stop had begun or the attempt timed out before the I/O started (nothing was sent), or the attempt
   *   timed out while it was in flight (the result is dropped).
   * - `'renewed'`: confirmed; the new ETag is recorded before this resolves.
   * - throws: the renewal was not confirmed (`err` or a throw), so the body's later I/O does not run. The loop
   *   remembers the failure, so a body that catches it and returns still counts. The tick ends failed if its LAST
   *   renewal outcome was a failure, even after an earlier confirmed renewal in the same tick; a later confirmed
   *   renewal clears it.
   */
  readonly renewLock: (record: LockRecord) => Promise<'renewed' | 'skipped'>
}

export interface LeaseLoopOptions<F = void> {
  readonly renew: LeaseRenew
  /** The ETag the lock was acquired with. */
  readonly initialEtag: string
  readonly intervalMs: number
  /** Bounds one attempt. When it fires, the attempt is superseded and recorded as failed. */
  readonly tickTimeoutMs: number
  /** One budget for the whole of `stop()`: the wait on the in-flight attempt plus `finalize`. */
  readonly stopBudgetMs: number
  /** Unref every loop timer so none keeps the process alive. */
  readonly unref: boolean
  /** Create one `AbortController` per attempt, aborted at the tick timeout or when the stop budget runs out. */
  readonly abortOnDeadline: boolean
  /** The per-tick work. Must renew through `ctx.renewLock`. */
  readonly tick: (ctx: LeaseTickContext) => Promise<void>
  /** Runs inside the stop budget once the last tick has settled without failing. Reject to report a failure. */
  readonly finalize?: (signal?: AbortSignal) => Promise<F>
  /**
   * Recovers a renewal whose outcome was lost: S3 may have committed it even though the call failed, was aborted or
   * outlived the tick timeout, which leaves the loop holding a dead ETag (every later renewal would fail its
   * `If-Match`). Reads the stored lock and resolves with its ETag when the record is OURS, else `null`; the surface
   * owns what "ours" means (holder, run and acquisition token), so a successor's record is never adopted. Never needs
   * to reject: a rejection counts as `null`.
   *
   * The loop calls it (a) inside the tick, after a renewal fails, while the attempt is current and stop has not
   * begun, so the tick timeout and its signal bound the read; and (b) once from `stop()` when the last tick ended
   * with an unconfirmed renewal, within what is left of the stop budget. It adopts the ETag only when it differs
   * from the one held. In a tick, adoption clears the failure (`hasFailed()` is false) and leaves
   * `continuityUnverified()` latched; at stop the error is still returned, now carrying the adopted `lockEtag`.
   */
  readonly adopt?: (signal?: AbortSignal) => Promise<{readonly etag: string} | null>
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warning'>
  /** Fields added to every log line, e.g. `{repo, holderId}`. */
  readonly logContext?: Readonly<Record<string, unknown>>
}

export interface LeaseLoopStopped<F> {
  /** The freshest lock ETag a renewal confirmed (the acquisition ETag if none did). */
  readonly lockEtag: string
  /** What `finalize` returned. `undefined` only when no `finalize` was given. */
  readonly final: F | undefined
}

/** The failure side of `stop()`. Still an `Error`, plus the facts a caller needs to settle conservatively. */
export interface LeaseLoopStopError extends Error {
  /** The freshest lock ETag a renewal confirmed. With `tickPending` it may already be stale. */
  readonly lockEtag: string
  /** True when the budget ran out while an attempt was still in flight; that attempt may yet renew the lock. */
  readonly tickPending: boolean
}

export interface LeaseLoop<F = void> {
  /** Starts the tick interval. A no-op once running, and after `stop()`: a stopped loop is final. */
  readonly start: () => void
  /** Never rejects. */
  readonly stop: () => Promise<Result<LeaseLoopStopped<F>, LeaseLoopStopError>>
  /** Waits for the attempt in flight, if any, without stopping the loop. Bounded by the tick timeout. */
  readonly settle: () => Promise<void>
  readonly currentEtag: () => string
  /** True while the latest attempt that finished (or timed out) ended without a confirmed renewal or in a failure. */
  readonly hasFailed: () => boolean
  /**
   * Latches, and never clears, the first time lock coverage cannot be vouched for:
   * - a renewal ended in `err` or a throw;
   * - the body failed before the renewal was confirmed;
   * - the body caught a renewal failure and returned, and no renewal confirmed earlier in that tick;
   * - the tick timeout fired before the renewal was confirmed;
   * - an attempt was still pending when `stop()`'s budget ran out.
   * A failure or timeout after a confirmed renewal in the same tick does not latch (it still sets `hasFailed`). A tick that skips its renewal (stopping or
   * superseded) neither latches nor fails.
   */
  readonly continuityUnverified: () => boolean
  readonly isRunning: boolean
}

/**
 * One tick attempt. Mutable on purpose: it is a per-invocation tracker threaded through the attempt's async steps.
 * `superseded` is set only by the tick timeout; `stop()` never touches it.
 */
interface Attempt {
  readonly controller: AbortController | undefined
  readonly settled: Promise<void>
  superseded: boolean
  concluded: boolean
  renewalConfirmed: boolean
  /**
   * The latest renewal this attempt saw fail while it was still current, kept apart from the body's own outcome: a body
   * may catch the failure and return normally, and the attempt must still end as failed unless a later renewal
   * confirms. `message` is the log line for it: `err` result and thrown renewal are logged differently.
   */
  renewalFailure: {readonly error: Error; readonly message: string; adopted: boolean} | null
  /** True once `renew` was called: the lock may have been rewritten whatever the call reported. */
  renewalSent: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

// Distinct from any value `finalize` can return, so a result can never be mistaken for the budget running out.
const BUDGET_ELAPSED = Symbol('lease-loop-budget-elapsed')

const RENEWAL_FAILED = 'Coordination lease renewal failed'
const RENEWAL_THREW = 'Coordination lease renewal threw'
const TICK_FAILED_AFTER_RENEWAL = 'Coordination lease tick failed after renewal'

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * The renewal loop shared by the Action and the gateway: scheduling, the per-tick timeout, the overlap guard, the
 * stopping flag, the shared stop budget, the freshest confirmed lock ETag, the failure state and failure logging.
 * Surfaces inject how they renew (`renew`) and what else a tick does (`tick`, `finalize`); takeover policy stays theirs.
 */
export function createLeaseLoop<F = void>(options: LeaseLoopOptions<F>): LeaseLoop<F> {
  const {renew, intervalMs, tickTimeoutMs, stopBudgetMs, unref, abortOnDeadline, tick, finalize, adopt, logger} =
    options
  const logContext = options.logContext ?? {}

  let lockEtag = options.initialEtag
  // The latest finished attempt's failure, or null. One field, so "failed without an error" cannot be represented.
  let failure: Error | null = null
  let continuityUnverified = false
  // True after an attempt ended with a renewal that was sent but never confirmed: the stored ETag may differ from the
  // one held. Cleared by a confirmed renewal or an adoption.
  let lockEtagUncertain = false
  let running = false
  let stopping = false
  let intervalHandle: ReturnType<typeof setInterval> | null = null
  let inFlight: Attempt | null = null

  const unrefTimer = (handle: {unref: () => unknown}): void => {
    if (unref) handle.unref()
  }

  const toStopError = (cause: Error, tickPending: boolean): LeaseLoopStopError =>
    Object.assign(new Error(cause.message, {cause}), {lockEtag, tickPending})

  /** Records how an attempt that was not superseded ended badly. State only: logging comes after the attempt ends. */
  const recordFailure = (attempt: Attempt, error: Error): void => {
    failure = error
    // A failure after a confirmed renewal says nothing against lock coverage.
    if (attempt.renewalConfirmed === false) continuityUnverified = true
    // A renewal that was sent and never confirmed may still have committed.
    if (attempt.renewalSent && attempt.renewalConfirmed === false) lockEtagUncertain = true
  }

  /**
   * Logging must never decide whether an attempt ends: a throwing logger would otherwise leave the in-flight slot taken
   * forever, or escape a timer callback, a promise handler or `stop()`. Called only after the attempt is concluded.
   */
  const logSafely = (level: 'debug' | 'info' | 'warning', message: string, context: Record<string, unknown>): void => {
    try {
      logger[level](message, {...logContext, ...context})
    } catch {
      // Nowhere left to report a logger that cannot log.
    }
  }
  const logFailure = (message: string, error: Error): void => {
    logSafely('warning', message, {error: error.message})
  }

  /** Runs the surface's adoption read. Never rejects: a failed read adopts nothing. */
  const readStoredLock = async (signal: AbortSignal | undefined): Promise<{readonly etag: string} | null> => {
    if (adopt === undefined) return null
    try {
      return await adopt(signal)
    } catch (error) {
      logSafely('debug', 'Lease adoption read failed', {error: toError(error).message})
      return null
    }
  }

  /** Takes a stored ETag that is ours and differs from the one held. */
  const takeStoredEtag = (stored: {readonly etag: string} | null): boolean => {
    if (stored === null || stored.etag === lockEtag) return false
    lockEtag = stored.etag
    lockEtagUncertain = false
    logSafely('info', 'Coordination lease ETag adopted after a renewal outcome was lost', {etag: stored.etag})
    return true
  }

  /** Ends an attempt that failed: an adopted lost renewal clears the failure, anything else records and logs it. */
  const endFailed = (attempt: Attempt, error: Error, message: string, conclude: () => void): void => {
    const lost = attempt.renewalFailure
    if (lost !== null && lost.adopted && lost.error === error) {
      failure = null
      if (attempt.renewalConfirmed === false) continuityUnverified = true
      conclude()
      return
    }
    recordFailure(attempt, error)
    conclude()
    logFailure(message, error)
  }

  const runAttempt = (): void => {
    if (inFlight != null) return

    const controller = abortOnDeadline ? new AbortController() : undefined
    let finish: () => void = () => {}
    const settled = new Promise<void>(resolve => {
      finish = resolve
    })
    const attempt: Attempt = {
      controller,
      settled,
      superseded: false,
      concluded: false,
      renewalConfirmed: false,
      renewalFailure: null,
      renewalSent: false,
      timer: undefined,
    }
    inFlight = attempt

    // Ends the attempt exactly once, whichever of the body or the tick timeout gets there first.
    const conclude = (): void => {
      if (attempt.concluded) return
      attempt.concluded = true
      clearTimeout(attempt.timer)
      if (inFlight === attempt) inFlight = null
      finish()
    }

    attempt.timer = setTimeout(() => {
      if (attempt.concluded) return
      attempt.superseded = true
      // Everything the log reads is captured before the attempt ends.
      const confirmed = attempt.renewalConfirmed
      const error = new Error(
        confirmed ? `Lease tick exceeded ${tickTimeoutMs}ms` : `Lease renewal exceeded ${tickTimeoutMs}ms`,
      )
      recordFailure(attempt, error)
      controller?.abort(error)
      conclude()
      logFailure(confirmed ? TICK_FAILED_AFTER_RENEWAL : RENEWAL_THREW, error)
    }, tickTimeoutMs)
    unrefTimer(attempt.timer)

    const ctx: LeaseTickContext = {
      signal: controller?.signal,
      isStopping: () => stopping,
      isCurrent: () => attempt.superseded === false,
      renewLock: async record => {
        // Nothing may start once stop has begun or the attempt was abandoned: a late renewal would restart the TTL.
        if (stopping || attempt.superseded) return 'skipped'

        // Adopts the stored ETag when the lost renewal turns out to be ours, before the failure reaches the body. Only
        // while this attempt is current and stop has not begun: the stop path does its own read.
        const adoptLostRenewal = async (): Promise<void> => {
          const lost = attempt.renewalFailure
          if (adopt === undefined || lost === null || stopping || attempt.superseded) return
          const stored = await readStoredLock(controller?.signal)
          // A read that resolves after the tick timed out is dropped, like any other late result.
          if (attempt.superseded === false && takeStoredEtag(stored)) lost.adopted = true
        }

        let renewed: LeaseRenewal
        attempt.renewalSent = true
        try {
          renewed =
            controller === undefined ? await renew(record, lockEtag) : await renew(record, lockEtag, controller.signal)
        } catch (error) {
          const cause = toError(error)
          if (attempt.superseded === false) {
            attempt.renewalFailure = {error: cause, message: RENEWAL_THREW, adopted: false}
            await adoptLostRenewal()
          }
          throw cause
        }
        if (renewed.success === false) {
          if (attempt.superseded === false) {
            attempt.renewalFailure = {error: renewed.error, message: RENEWAL_FAILED, adopted: false}
            await adoptLostRenewal()
          }
          throw renewed.error
        }
        // Dropped, not applied: a timed-out attempt must not move the ETag the caller will release with.
        if (attempt.superseded) return 'skipped'

        lockEtag = renewed.data.etag
        lockEtagUncertain = false
        attempt.renewalConfirmed = true
        // A confirmed renewal supersedes an earlier failure the body caught: the tick's last outcome is what counts.
        attempt.renewalFailure = null
        return 'renewed'
      },
    }

    // The async wrapper turns a synchronous throw from `tick` into a rejection.
    ;(async () => tick(ctx))().then(
      () => {
        if (attempt.concluded) return
        // The tick ends failed when its LAST renewal outcome was a failure, even one the body caught and returned past.
        // A later confirmed renewal clears it (see `renewLock`). `recordFailure` latches only if none confirmed this tick.
        const renewalFailure = attempt.renewalFailure
        if (renewalFailure !== null) {
          endFailed(attempt, renewalFailure.error, renewalFailure.message, conclude)
          return
        }
        // Only a confirmed renewal is evidence the lock is held; a tick that skipped its I/O proves nothing.
        if (attempt.renewalConfirmed) failure = null
        conclude()
      },
      (error: unknown) => {
        if (attempt.concluded) return
        const cause = toError(error)
        const message =
          cause === attempt.renewalFailure?.error
            ? attempt.renewalFailure.message
            : attempt.renewalConfirmed
              ? TICK_FAILED_AFTER_RENEWAL
              : RENEWAL_THREW
        endFailed(attempt, cause, message, conclude)
      },
    )
  }

  return {
    start: () => {
      if (running) return
      // One-way: a restart would un-skip a tick that outlived `stop()`. A restart needs a new loop.
      if (stopping) {
        logger.debug('Ignoring start of a stopped lease loop', logContext)
        return
      }
      running = true
      intervalHandle = setInterval(runAttempt, intervalMs)
      unrefTimer(intervalHandle)
    },

    stop: async () => {
      running = false
      stopping = true
      if (intervalHandle != null) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }

      // One budget for the whole call, cleared on every exit. A raced promise that settles late is already handled by
      // the race, so it cannot surface as an unhandled rejection.
      let budgetTimer: ReturnType<typeof setTimeout> | undefined
      const budget = new Promise<typeof BUDGET_ELAPSED>(resolve => {
        budgetTimer = setTimeout(() => resolve(BUDGET_ELAPSED), stopBudgetMs)
        unrefTimer(budgetTimer)
      })

      try {
        const pending = inFlight
        if (pending != null) {
          const winner = await Promise.race([pending.settled, budget])
          // The attempt may have concluded in the same turn the budget fired; only a still-open one is pending.
          if (winner === BUDGET_ELAPSED && pending.concluded === false) {
            // An unresolved tick is itself a gap in coverage, not a pass.
            continuityUnverified = true
            // The attempt's own timeout stays armed so it still records its failure, but it must not hold the process
            // (or a daemon's shutdown) open for the rest of the tick timeout.
            pending.timer?.unref()
            pending.controller?.abort(new Error('Lease stop budget elapsed'))
            return err(toStopError(new Error(`Lease tick did not settle within ${stopBudgetMs}ms of stop`), true))
          }
        }

        if (failure != null) {
          // The last tick ended with a renewal that may have committed: look for it before reporting the ETag.
          if (lockEtagUncertain) {
            const readController = abortOnDeadline ? new AbortController() : undefined
            const read = await Promise.race([readStoredLock(readController?.signal), budget])
            if (read === BUDGET_ELAPSED) {
              readController?.abort(new Error('Lease stop budget elapsed'))
            } else {
              takeStoredEtag(read)
            }
          }
          return err(toStopError(failure, false))
        }
        if (finalize === undefined) return ok({lockEtag, final: undefined})

        const finalizeController = abortOnDeadline ? new AbortController() : undefined
        // A throw or rejection from `finalize` lands in the catch below. A rejection after the budget elapsed is already
        // handled by the race, so it cannot surface as an unhandled rejection.
        const run = finalizeController === undefined ? finalize() : finalize(finalizeController.signal)
        const outcome = await Promise.race([run, budget])
        if (outcome === BUDGET_ELAPSED) {
          finalizeController?.abort(new Error('Lease stop budget elapsed'))
          return err(toStopError(new Error(`Lease finalize did not settle within ${stopBudgetMs}ms of stop`), false))
        }
        return ok({lockEtag, final: outcome})
      } catch (error) {
        // `stop()` never rejects: whatever `finalize` threw or rejected with comes back as an error.
        return err(toStopError(toError(error), false))
      } finally {
        clearTimeout(budgetTimer)
      }
    },

    settle: async () => {
      // Unlike `stop()`, this clears nothing: the attempt settles within its own tick timeout and never rejects.
      const pending = inFlight
      if (pending == null) return
      await pending.settled
    },

    currentEtag: () => lockEtag,
    hasFailed: () => failure != null,
    continuityUnverified: () => continuityUnverified,
    get isRunning() {
      return running
    },
  }
}
