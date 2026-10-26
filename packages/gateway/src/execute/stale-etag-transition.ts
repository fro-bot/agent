import type {CoordinationConfig, Result, RunState} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {err, getRunKey, HEARTBEAT_STOP_GRACE_MS, ok, parseRunState, toErrorMessage} from '@fro-bot/runtime'

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
  /**
   * Total writes, the first included. Default 2: the first write, then one retry after a re-read.
   */
  readonly attempts?: number
  /**
   * Wait before retry `n` (`delaysMs[n - 1]`); a missing entry means no wait. Default: no waits.
   */
  readonly delaysMs?: readonly number[]
  /**
   * Bound on each write, the first included. A write that has not settled by then counts as failed and is
   * abandoned (it may still land, which the next re-read then finds as a terminal record). Default: unbounded.
   */
  readonly attemptTimeoutMs?: number
  /**
   * What to return when the re-read finds THIS run's record already terminal. A write that was abandoned at its bound
   * can still commit; the record then holds the outcome the caller wanted (or another terminal one), so the caller
   * should treat it as written, using the stored state and the phase it actually has. The stored record is never
   * overwritten. Without this callback the original failure is returned, as before. A record that belongs to another
   * run is always a failure.
   */
  readonly adoptTerminal?: (stored: {readonly state: RunState; readonly etag: string}) => T
}

/**
 * The arguments every terminal RunState write passes: three bounded writes, 500 ms then 1 s apart. The worst case is
 * about 27 s (three 5 s writes, two 5 s re-reads, 1.5 s of waits), and only when the store stalls.
 */
export const TERMINAL_WRITE_RETRY = {
  attempts: 3,
  delaysMs: [500, 1_000],
  attemptTimeoutMs: 5_000,
  adoptTerminal: (stored: {readonly state: RunState; readonly etag: string}) => ({
    etag: stored.etag,
    state: stored.state,
  }),
} as const

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
    // Aborts the read when the budget runs out, so a stalled request is cancelled instead of left to hold a socket.
    const controller = new AbortController()
    const budget = new Promise<'elapsed'>(resolve => {
      timer = setTimeout(() => {
        resolve('elapsed')
        controller.abort(new Error(`read did not settle within ${HEARTBEAT_STOP_GRACE_MS}ms`))
      }, HEARTBEAT_STOP_GRACE_MS)
    })
    // The race handles a late rejection of the aborted read, so it cannot surface as an unhandled rejection.
    const fetched = await Promise.race([getObject(key.data, {signal: controller.signal}), budget])
    if (fetched === 'elapsed') {
      return skip(`read did not settle within ${HEARTBEAT_STOP_GRACE_MS}ms`)
    }
    if (fetched.success === false) {
      return skip(fetched.error.message)
    }
    const parsed = parseRunState(fetched.data.data)
    return parsed.success === false ? skip(parsed.error.message) : {state: parsed.data, etag: fetched.data.etag}
  } catch (error) {
    return skip(toErrorMessage(error))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Runs one write, abandoning it as a failure when it has not settled within `timeoutMs`. The race also swallows a
 * late rejection of the abandoned write, so it cannot surface as an unhandled rejection.
 */
async function boundedAttempt<T>(
  attempt: () => Promise<Result<T, Error>>,
  timeoutMs: number | undefined,
): Promise<Result<T, Error>> {
  if (timeoutMs === undefined) return attempt()
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<Result<T, Error>>(resolve => {
    timer = setTimeout(() => {
      resolve(err(new Error(`terminal transition did not settle within ${timeoutMs}ms`)))
    }, timeoutMs)
  })
  try {
    return await Promise.race([attempt(), bound])
  } finally {
    clearTimeout(timer)
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * A terminal `transitionRun` that survives a stale ETag. Every heartbeat tick rewrites the RunState, so the ETag the
 * caller holds may be stale (and after a `tickPending` stop one late write may still land), and a write can also fail
 * transiently. When a write fails:
 *
 *  1. wait the configured delay, then re-read the stored RunState;
 *  2. if the read fails, or the record is for another run, return the last failure; if this run's record is already
 *     terminal, return `adoptTerminal(stored)` when given (the abandoned write evidently committed), else the last
 *     failure. Nothing is safe to retry, and a terminal record is never overwritten;
 *  3. otherwise (this run, still PENDING / ACKNOWLEDGED / EXECUTING) retry the write with the stored ETag.
 *
 * Bounded: at most `attempts` writes (default 2) and one read before each retry, each write optionally bounded by
 * `attemptTimeoutMs`. The default is one re-read and one retry, with no wait and no bound.
 */
export async function transitionRetryingStaleEtag<T>(
  options: StaleEtagTransitionOptions<T>,
): Promise<Result<T, Error>> {
  const {repo, runId, etag, logger, attempt, attempts = 2, delaysMs = [], attemptTimeoutMs} = options

  let last = await boundedAttempt(async () => attempt(etag), attemptTimeoutMs)
  for (let retry = 1; last.success === false && retry < attempts; retry += 1) {
    // Nothing can be re-read without a store adapter that reads, so waiting would only delay the failure. The read
    // returns `null` at once and logs why the retry is disabled.
    if (options.config.storeAdapter?.getObject == null) {
      await readStoredRun(options)
      return last
    }
    const delay = delaysMs[retry - 1] ?? 0
    if (delay > 0) await sleep(delay)

    const stored = await readStoredRun(options)
    if (stored === null) {
      return last
    }
    if (
      stored.state.run_id === runId &&
      TERMINAL_PHASES.has(stored.state.phase) &&
      options.adoptTerminal !== undefined
    ) {
      logger.info(
        {repo, runId, phase: stored.state.phase, err: last.error.message},
        'run: terminal transition failed but the stored run is already terminal — adopting the stored record',
      )
      return ok(options.adoptTerminal({state: stored.state, etag: stored.etag}))
    }
    if (stored.state.run_id !== runId || TERMINAL_PHASES.has(stored.state.phase)) {
      logger.warn(
        {repo, runId, phase: stored.state.phase, err: last.error.message},
        'run: terminal transition failed and the stored run is terminal or not this run — skipping retry',
      )
      return last
    }

    logger.warn(
      {repo, runId, phase: stored.state.phase, retry, attempts, err: last.error.message},
      'run: terminal transition failed — retrying with the stored ETag',
    )
    last = await boundedAttempt(async () => attempt(stored.etag), attemptTimeoutMs)
  }
  return last
}
