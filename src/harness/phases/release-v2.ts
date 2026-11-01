import type {OpenCodeV2ServerHandle, OwnershipLedger} from '@fro-bot/runtime'
import type {LiveObservationV2} from '../../features/agent/live-observation-v2.js'
import type {Logger} from '../../shared/logger.js'
import type {DrainOutcome} from './execute.js'
import type {DeferredSummaryV2} from './execution-backend.js'
import type {ObservedTurnV2} from './observed-turn-v2.js'
import {DEFAULT_PRUNING_CONFIG} from '@fro-bot/runtime'
import {PRE_SHUTDOWN_REQUEST_TIMEOUT_MS, releaseRunV2} from '../../features/agent/drain-v2.js'
import {createActionClientV2} from '../../features/agent/execution-v2.js'
import {getObservedFailureV2} from '../../features/agent/streaming-v2.js'
import {toErrorMessage} from '../../shared/errors.js'
import {pruneSessionsV2} from './prune-v2.js'
import {createSessionReaderV2} from './session-v2.js'

/**
 * The V2 side of the drain step in `run.ts`: release the run, then report it in the shapes the rest of the run reads.
 *
 * `releaseRunV2` (`features/agent/drain-v2.ts`) holds the policy: drain on success, stop on anything else, confirm the
 * directory quiet, shut the server down. This adds what only the harness knows: the session retention to prune to (done
 * while the server is up and the directory is quiet, V1's order) and the verdict as a `DrainOutcome` plus the reason
 * persistence must be declined. The run summary is written here too (`DeferredSummaryV2`).
 */

export interface RunReleaseV2Options {
  readonly serverHandle: OpenCodeV2ServerHandle
  /** `false` for a failed or timed-out execution, and for one that never returned (`null` session and ledger). */
  readonly executionSucceeded: boolean
  readonly rootSessionId: string | null
  readonly ledger: OwnershipLedger | undefined
  readonly runStartedAt: number
  /** Remaining drain budget (`computeDrainDeadlineMs`); `Number.POSITIVE_INFINITY` for no Action deadline. */
  readonly deadlineMs: number
  readonly sessionRetention: number | null
  readonly logger: Logger
  /** The event observation the execute phase kept open (`ExecutePhaseResult.liveObservation`): stopped here, once. */
  readonly liveObservation?: LiveObservationV2 | undefined
  /** The run summary the execute phase held back (`ExecutePhaseResult.deferredSummary`): written here, once. */
  readonly deferredSummary?: DeferredSummaryV2 | undefined
}

export interface RunReleaseV2Result {
  readonly drain: DrainOutcome
  /** Why nothing may be saved, or `undefined` when the directory was confirmed quiet. */
  readonly persistenceDeclineReason: string | undefined
  /**
   * The server's exit could not be confirmed (shutdown threw, or reported `unconfirmed`) while everything before it looked
   * clean. Publication must not proceed on it: a writer that may still be alive can change what the run published.
   */
  readonly serverExitUnconfirmed?: boolean
  /** What the event observation saw after the attempt returned, when it was kept running. See `observed-turn-v2.ts`. */
  readonly observed?: ObservedTurnV2 | undefined
}

type FetchRoute = OpenCodeV2ServerHandle['fetch']

/**
 * Wrap a fetch so every request ends: it aborts after `requestMs`, or when `phase` aborts, whichever comes first. The
 * request's own signal still applies. The timer is left to fire after a response arrives (unref'd, and aborting a
 * finished request is a no-op), so a body that stalls is cut at the same bound.
 */
export function boundRequests(
  fetchRoute: FetchRoute,
  phase: AbortSignal,
  requestMs: number = PRE_SHUTDOWN_REQUEST_TIMEOUT_MS,
): FetchRoute {
  return async (path, init) => {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    const timer = setTimeout(abort, requestMs)
    timer.unref()
    for (const signal of [phase, init?.signal]) {
      if (signal == null) continue
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, {once: true})
    }
    return fetchRoute(path, {...init, signal: controller.signal})
  }
}

/** The run summary the execute phase held back. Best-effort: a summary that cannot be written costs the next run context. */
async function writeDeferredSummary(
  serverHandle: OpenCodeV2ServerHandle,
  summary: DeferredSummaryV2 | undefined,
  fetchRoute: FetchRoute,
  logger: Logger,
): Promise<void> {
  if (summary === undefined) return
  try {
    const result = await createActionClientV2({...serverHandle, fetch: fetchRoute}).addSyntheticMessage({
      sessionId: summary.sessionId,
      text: summary.text,
    })
    if (result.success) logger.info('Session summary written via V2 route', {sessionId: summary.sessionId})
    else logger.warning('V2 summary writeback failed', {sessionId: summary.sessionId, error: result.error.kind})
  } catch (error) {
    logger.warning('V2 summary writeback failed', {sessionId: summary.sessionId, error: toErrorMessage(error)})
  }
}

export async function runReleaseV2(options: RunReleaseV2Options): Promise<RunReleaseV2Result> {
  const {serverHandle, logger} = options
  const seen: {observed: ObservedTurnV2 | undefined} = {observed: undefined}
  const outcome = await releaseRunV2({
    client: createActionClientV2(serverHandle),
    handle: serverHandle,
    directory: serverHandle.directory,
    rootSessionId: options.rootSessionId,
    ledger: options.ledger,
    runStartedAt: options.runStartedAt,
    executionSucceeded: options.executionSucceeded,
    deadlineMs: options.deadlineMs,
    logger,
    // The observation kept running through the wait stops here, once the directory has been decided and before the
    // server can emit anything for shutdown (a stream that dies with the server would read as a gap).
    onSettled: async quiet => {
      const live = options.liveObservation
      if (live === undefined) return
      const result = await live.stop()
      const failure = getObservedFailureV2(live.tracker)
      // Usage only from a quiet directory: a turn that may still be running has not finished adding to it.
      const usage = quiet && live.refreshUsage !== undefined ? await live.refreshUsage() : null
      seen.observed = {result, rootTerminal: live.tracker.rootTerminal, failure: failure?.error ?? null, usage}
    },
    beforeShutdown: async signal => {
      const fetchRoute = boundRequests(serverHandle.fetch, signal)
      await writeDeferredSummary(serverHandle, options.deferredSummary, fetchRoute, logger)
      await pruneSessionsV2({
        reader: createSessionReaderV2(fetchRoute),
        fetchRoute,
        directory: serverHandle.directory,
        config: {
          ...DEFAULT_PRUNING_CONFIG,
          maxSessions: options.sessionRetention ?? DEFAULT_PRUNING_CONFIG.maxSessions,
        },
        logger,
      })
    },
  })

  // `null` is a shutdown that threw; `unconfirmed` is one that returned without proving the process gone.
  const serverExitUnconfirmed = outcome.shutdown === null || outcome.shutdown.exit.outcome === 'unconfirmed'
  const exitDeclineReason = serverExitUnconfirmed
    ? 'the OpenCode server exit could not be confirmed, so a still-live writer could change the session state'
    : undefined

  return {
    // `expired` keeps V1's meaning: the wait for a succeeded run's own work did not finish inside its bound. A stop after
    // a failed or timed-out execution is not an expiry; the run already reported that.
    drain: {
      expired: options.executionSucceeded && outcome.drain !== 'quiet',
      cancelledCount: 0,
      settledCount: 0,
      unknownCount: outcome.quiet ? outcome.unknownCount : Math.max(1, outcome.unknownCount),
    },
    persistenceDeclineReason: outcome.declineReason ?? exitDeclineReason,
    serverExitUnconfirmed,
    observed: seen.observed,
  }
}
