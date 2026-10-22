import type {ReleaseIfHolderOutcome, Result} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {err, isPreconditionFailed, ok} from '@fro-bot/runtime'

export interface LockReleaseOptions {
  /** The ETag-conditional release the caller already makes. */
  readonly releaseByEtag: () => Promise<Result<void, Error>>
  /**
   * Releases the lock only if the stored record is still this acquisition's (holder, run and token), deleting with the
   * ETag it reads. Called at most once, and only after `releaseByEtag` lost its condition.
   */
  readonly releaseIfHolder: (acquisitionToken: string) => Promise<Result<ReleaseIfHolderOutcome, Error>>
  /** This acquisition's token. Without one there is nothing to prove ownership with, so there is no fallback. */
  readonly acquisitionToken: string | undefined
  readonly logger: Pick<GatewayLogger, 'debug' | 'info'>
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
 * Every outcome of the ownership release is an expected one and maps to success; only a failure of the ownership
 * release itself comes back as an error, for the caller to warn about as it always has.
 */
export async function releaseLockOrByOwnership(options: LockReleaseOptions): Promise<Result<void, Error>> {
  const {releaseByEtag, releaseIfHolder, acquisitionToken, logger, context, label} = options
  const released = await releaseByEtag()
  if (released.success === true || acquisitionToken === undefined || isPreconditionFailed(released.error) === false) {
    return released
  }

  const byOwnership = await releaseIfHolder(acquisitionToken)
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
