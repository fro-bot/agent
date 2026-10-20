import type {CoordinationConfig, Result, RunState} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {getRunKey, parseRunState} from '@fro-bot/runtime'

export interface StaleEtagTransitionOptions<T> {
  readonly config: CoordinationConfig
  readonly identity: string
  readonly repo: string
  readonly runId: string
  /** The ETag the first attempt uses. */
  readonly etag: string
  readonly logger: GatewayLogger
  /** One conditional RunState transition write against the given ETag (e.g. `transitionRun`). */
  readonly attempt: (etag: string) => Promise<Result<T, Error>>
}

const TERMINAL_PHASES: ReadonlySet<RunState['phase']> = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])

/** Reads the run's stored record, or `null` when it cannot be read or parsed. Never throws. */
async function readStoredRun(
  config: CoordinationConfig,
  identity: string,
  repo: string,
  runId: string,
): Promise<{readonly state: RunState; readonly etag: string} | null> {
  try {
    const key = getRunKey(config, identity, repo, runId)
    const getObject = config.storeAdapter?.getObject
    if (key.success === false || getObject == null) {
      return null
    }
    const fetched = await getObject(key.data)
    if (fetched.success === false) {
      return null
    }
    const parsed = parseRunState(fetched.data.data)
    return parsed.success === false ? null : {state: parsed.data, etag: fetched.data.etag}
  } catch {
    return null
  }
}

/**
 * A terminal `transitionRun` for a run whose heartbeat stop failed. Every heartbeat tick rewrites the RunState, so the
 * ETag the caller holds may be stale (and after a `tickPending` stop one late write may still land). When the write
 * fails:
 *
 *  1. re-read the stored RunState once;
 *  2. if the read fails, or the record is for another run, or its phase is already terminal, return the original
 *     failure: there is nothing safe to retry;
 *  3. otherwise (this run, still PENDING / ACKNOWLEDGED / EXECUTING) retry the write once with the stored ETag and
 *     return that result.
 *
 * Never loops: at most two writes and one read.
 */
export async function transitionRetryingStaleEtag<T>(
  options: StaleEtagTransitionOptions<T>,
): Promise<Result<T, Error>> {
  const {config, identity, repo, runId, etag, logger, attempt} = options

  const first = await attempt(etag)
  if (first.success === true) {
    return first
  }

  const stored = await readStoredRun(config, identity, repo, runId)
  if (stored === null) {
    return first
  }
  if (stored.state.run_id !== runId || TERMINAL_PHASES.has(stored.state.phase)) {
    logger.warn(
      {repo, runId, phase: stored.state.phase, err: first.error.message},
      'run: terminal transition failed after a heartbeat stop failure and the stored run is terminal or not this run — skipping retry',
    )
    return first
  }

  logger.warn(
    {repo, runId, phase: stored.state.phase, err: first.error.message},
    'run: terminal transition failed after a heartbeat stop failure — retrying once with the stored ETag',
  )
  return attempt(stored.etag)
}
