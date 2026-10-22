import type {ReleaseIfHolderOutcome, Result} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {err, HEARTBEAT_STOP_GRACE_MS, isPreconditionFailed, ok} from '@fro-bot/runtime'

/**
 * How long the ownership fallback may take in total (its read and its delete), the same budget `heartbeat.stop()` gets.
 * Past it the call is abandoned, so a stalled store can never hold up the caller's slot hand-off or release.
 */
export const OWNERSHIP_RELEASE_BUDGET_MS = HEARTBEAT_STOP_GRACE_MS

export interface LockReleaseOptions {
  /** The ETag-conditional release the caller already makes. */
  readonly releaseByEtag: () => Promise<Result<void, Error>>
  /**
   * Releases the lock only if the stored record is still this acquisition's (holder, run and token), deleting with the
   * ETag it reads. Called at most once, and only after `releaseByEtag` lost its condition. `signal` aborts at the
   * budget; the callee must hand it to the read and the delete so neither starts late.
   */
  readonly releaseIfHolder: (
    acquisitionToken: string,
    signal: AbortSignal,
  ) => Promise<Result<ReleaseIfHolderOutcome, Error>>
  /** This acquisition's token. Without one there is nothing to prove ownership with, so there is no fallback. */
  readonly acquisitionToken: string | undefined
  readonly logger: Pick<GatewayLogger, 'debug' | 'info' | 'warn'>
  readonly context: {readonly repo: string; readonly runId: string}
  /** Prefix of the log lines, e.g. `run` or `maintenance-run`. */
  readonly label: string
}

/**
 * Releases the coordination lock by ETag and, when that ETag turns out to be stale, by ownership.
 *
 * A renewal the heartbeat lost track of (it timed out, or its response never arrived) can still commit, which moves the
 * lock's ETag past the one the heartbeat reports. The ETag release then fails its condition although the record is ours.
 * Retrying once through the ownership check deletes it with the ETag the store has now, and never touches a successor's
 * record: a different holder, run or token is left in place.
 *
 * The ownership release gets `OWNERSHIP_RELEASE_BUDGET_MS`. Every outcome of it is an expected one and maps to success;
 * only a failure of the ownership release itself (including running out of budget) comes back as an error, for the
 * caller to warn about as it always has.
 */
/**
 * Runs the ownership release against the budget. At the deadline the callee's signal is aborted and the call is
 * abandoned, so an adapter that ignores cancellation still cannot block; the timer is cleared on every exit.
 */
async function withBudget(
  releaseIfHolder: LockReleaseOptions['releaseIfHolder'],
  acquisitionToken: string,
  logger: LockReleaseOptions['logger'],
  context: LockReleaseOptions['context'],
  label: string,
): Promise<Result<ReleaseIfHolderOutcome, Error>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'elapsed'>(resolve => {
    timer = setTimeout(() => {
      resolve('elapsed')
    }, OWNERSHIP_RELEASE_BUDGET_MS)
  })
  // An async wrapper turns a synchronous throw into a rejection, and the catch turns any rejection into an error. The
  // abandoned call's later outcome is then handled, so it can never surface as an unhandled rejection.
  const attempt = (async () => releaseIfHolder(acquisitionToken, controller.signal))().catch(
    (error: unknown): Result<ReleaseIfHolderOutcome, Error> =>
      err(error instanceof Error ? error : new Error(String(error))),
  )
  try {
    const raced = await Promise.race([attempt, deadline])
    if (raced !== 'elapsed') return raced

    const message = `${label}: ownership release did not finish within ${OWNERSHIP_RELEASE_BUDGET_MS}ms — lock left to its TTL`
    controller.abort(new Error(message))
    logger.warn(context, message)
    return err(new Error(message))
  } finally {
    clearTimeout(timer)
  }
}

export async function releaseLockOrByOwnership(options: LockReleaseOptions): Promise<Result<void, Error>> {
  const {releaseByEtag, releaseIfHolder, acquisitionToken, logger, context, label} = options
  const released = await releaseByEtag()
  if (released.success === true || acquisitionToken === undefined || isPreconditionFailed(released.error) === false) {
    return released
  }

  const byOwnership = await withBudget(releaseIfHolder, acquisitionToken, logger, context, label)
  if (byOwnership.success === false) return err(byOwnership.error)

  const outcome = byOwnership.data
  const fields = {...context, outcome}
  switch (outcome) {
    case 'released':
      logger.info(fields, `${label}: lock released by ownership after a stale ETag`)
      break
    case 'no-lock':
      logger.debug(fields, `${label}: lock already gone when releasing by ownership`)
      break
    case 'not-holder':
      logger.info(fields, `${label}: lock now belongs to another acquisition — left in place`)
      break
    case 'conflict':
      logger.info(fields, `${label}: lock replaced while releasing by ownership — left in place`)
      break
  }
  return ok(undefined)
}
