import type {Logger} from '../shared/logger.js'
import type {CoordinationConfig, LockRecord, LockScope} from './types.js'

import {readLock} from './lock.js'

/** Whether a stored lock record is the one this holder wrote. A refusal names why, so it can be logged. */
export type LockOwnership = {readonly owned: true} | {readonly owned: false; readonly reason: string}

export interface LockAdopterOptions {
  readonly config: CoordinationConfig
  readonly repo: string
  readonly scope?: LockScope
  /** The surface's ownership rule. Must be strict enough that a successor's record is never accepted. */
  readonly owns: (stored: LockRecord) => LockOwnership
  readonly logger: Pick<Logger, 'debug'>
  /** Fields added to the debug line for a refused record. */
  readonly logContext?: Readonly<Record<string, unknown>>
}

/**
 * Builds the `adopt` function the lease loop takes: reads the stored lock and resolves with its ETag when the surface
 * says the record is ours, else `null` (no lock, an unreadable lock, or someone else's record). The signal aborts the
 * read.
 */
export function createLockAdopter(
  options: LockAdopterOptions,
): (signal?: AbortSignal) => Promise<{readonly etag: string} | null> {
  const {config, repo, scope, owns, logger, logContext} = options
  return async signal => {
    const stored = await readLock(config, repo, scope, signal)
    if (stored.success === false || stored.data === null) return null

    const ownership = owns(stored.data.record)
    if (ownership.owned === false) {
      logger.debug('Lock record not adopted', {
        ...logContext,
        reason: ownership.reason,
        storedHolderId: stored.data.record.holder_id,
        storedRunId: stored.data.record.run_id,
      })
      return null
    }
    return {etag: stored.data.etag}
  }
}
