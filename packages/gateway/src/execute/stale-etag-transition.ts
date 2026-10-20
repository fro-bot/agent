import type {CoordinationConfig, Result, RunState} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {getRunKey, HEARTBEAT_STOP_GRACE_MS, parseRunState} from '@fro-bot/runtime'

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

/**
 * Reads the run's stored record, or `null` when it cannot be read or parsed within `HEARTBEAT_STOP_GRACE_MS` (the
 * budget `stop()` itself gets: this read follows a failed stop and gates lock release and slot cleanup, so it must not
 * stall). Never throws. Every `null` is logged at debug with its reason, so a retry that was silently disabled is
 * visible.
 */
async function readStoredRun(
  options: Pick<StaleEtagTransitionOptions<unknown>, 'config' | 'identity' | 'repo' | 'runId' | 'logger'>,
): Promise<{readonly state: RunState; readonly etag: string} | null> {
  const {config, identity, repo, runId, logger} = options
  const skip = (reason: string): null => {
    logger.debug({repo, runId, reason}, 'run: stale-ETag retry disabled — stored run-state is unreadable')
    return null
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const key = getRunKey(config, identity, repo, runId)
    if (key.success === false) {
      return skip(key.error.message)
    }
    const getObject = config.storeAdapter?.getObject
    if (getObject == null) {
      return skip('store adapter has no getObject')
    }
    const budget = new Promise<'elapsed'>(resolve => {
      timer = setTimeout(() => resolve('elapsed'), HEARTBEAT_STOP_GRACE_MS)
    })
    // The race handles a late rejection of the abandoned read, so it cannot surface as an unhandled rejection.
    const fetched = await Promise.race([getObject(key.data), budget])
    if (fetched === 'elapsed') {
      return skip(`read did not settle within ${HEARTBEAT_STOP_GRACE_MS}ms`)
    }
    if (fetched.success === false) {
      return skip(fetched.error.message)
    }
    const parsed = parseRunState(fetched.data.data)
    return parsed.success === false ? skip(parsed.error.message) : {state: parsed.data, etag: fetched.data.etag}
  } catch (error) {
    return skip(error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
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
  const {repo, runId, etag, logger, attempt} = options

  const first = await attempt(etag)
  if (first.success === true) {
    return first
  }

  const stored = await readStoredRun(options)
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
