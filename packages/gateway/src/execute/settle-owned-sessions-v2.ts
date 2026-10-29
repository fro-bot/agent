/**
 * Termination barrier for a run on OpenCode V2: the sibling of `settle-owned-sessions.ts`. The contract is the same (the
 * run's lock is not released while a writer it started can still touch the checkout); what differs is what is believed.
 *
 * Stock v2.2.0 cannot prove that no session of the run can still be woken: a background shell's DELETE, a subagent's
 * completion and a queued notice all wake a session in a step the event stream does not show, and no REST route says a
 * producer is mid-way. So the barrier does not try to account for each entity the run started, and it does not confirm
 * a stop from an interrupt's reply. It acts on what the DIRECTORY shows and decides by the directory staying quiet:
 *
 * 1. Read the directory (`observeDirectoryV2`): active sessions, running shells, queued inbox items.
 * 2. Act on what it showed (`stopDirectoryActivityV2`): DELETE every running shell, then interrupt every active session,
 *    the root first. Every session and shell in a gateway checkout directory is the run's: nothing else shares it. A
 *    reading that could not be completed still carries what it did find, and that is acted on too. An owned session that
 *    moved is a target wherever it is stored (`knownSessionIds`): it keeps running at its destination, where placement by
 *    the directory cannot find it.
 * 3. Repeat until `createDirectoryStabilityGate` passes (11 quiet readings, 500 ms apart, over 5 s). Any activity and
 *    any read that fails, times out or comes back partial resets the count.
 *
 * It all runs under one bound (`DEFAULT_SETTLE_TIMEOUT_MS`) with a fresh teardown signal, because the run's own signal is
 * already aborted by the time a failure reaches here. If the gate has not passed when the bound is reached, the stop is
 * unconfirmed: the ledger's entries become `unknown`, and the caller quarantines the run and starts the watch
 * (`startQuarantineWatchV2`), which repeats step 2 for the whole hold.
 *
 * The ledger is bookkeeping here, not evidence. A pass settles its entries because the directory showed no activity; it
 * never decides whether to release.
 *
 * Accepted cost: any stop with a live shell kills it, and the kill wakes the root, so the barrier needs a full quiet
 * window after it. A stop whose window cannot be completed in the bound quarantines.
 *
 * This module does not decide what `run.ts` does with a quarantine outcome.
 */

import type {DirectoryStabilityTuning, OwnershipLedger, RemoteOpenCodeV2Client} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {
  awaitDirectoryStability,
  createDirectoryStabilityGate,
  DIRECTORY_QUIESCENCE_MIN_SPACING_MS,
  observeDirectoryV2,
  ownedSessionIdsOf,
  toErrorMessage,
} from '@fro-bot/runtime'
import {stopDirectoryActivityV2} from './root-stop-v2.js'

/**
 * Upper bound, in milliseconds, on the whole barrier (acting plus the stability window). A fresh budget, not a remainder
 * of the run's. The window alone is 5 s.
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 15_000

export interface SettleOwnedSessionsV2Params {
  /** Client for the workspace OpenCode V2 server this run is attached to. */
  readonly client: RemoteOpenCodeV2Client
  /** The location the run's sessions and shells live in: the directory the root was created at. */
  readonly directory: string
  /** The root session this run created. */
  readonly rootSessionId: string
  /** The run's ownership ledger: settled on a pass, marked `unknown` on a failure. */
  readonly ledger: OwnershipLedger
  readonly logger: GatewayLogger
  /** When the run began (epoch ms): which sessions' inboxes a reading reads. */
  readonly runStartedAt: number
  /**
   * Owned sessions that are stored somewhere else now (a move). One on the active list is stopped like any other, with
   * no placement by the directory: it keeps running at its destination, where the directory cannot see it.
   */
  readonly knownSessionIds?: () => readonly string[]
  /** The gateway run this attempt belongs to. Stamped on every log line. */
  readonly runId?: string
  /** Overrides `DEFAULT_SETTLE_TIMEOUT_MS` — for tests only. */
  readonly timeoutMs?: number
  /** Overrides the stability window — for tests only. */
  readonly stability?: DirectoryStabilityTuning
}

export type SettleOwnedSessionsV2Result =
  | {readonly settled: true}
  | {
      readonly settled: false
      /** Why the directory was not confirmed quiet. The caller quarantines and keeps stopping it through the hold. */
      readonly reason: string
    }

function withRunId(logger: GatewayLogger, runId: string | undefined): GatewayLogger {
  if (runId === undefined) return logger
  return {
    debug: (context, message) => logger.debug({runId, ...context}, message),
    info: (context, message) => logger.info({runId, ...context}, message),
    warn: (context, message) => logger.warn({runId, ...context}, message),
    error: (context, message) => logger.error({runId, ...context}, message),
  }
}

/** Race `work` against its own timer, so work that ignores cancellation still resolves into a decision. */
async function withBound<T>(ms: number, work: () => Promise<T>, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(onTimeout()), ms)
  })
  try {
    return await Promise.race([work(), timeoutPromise])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function settleOwnedSessionsV2(params: SettleOwnedSessionsV2Params): Promise<SettleOwnedSessionsV2Result> {
  const {
    client,
    directory,
    rootSessionId,
    ledger,
    runStartedAt,
    knownSessionIds,
    timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
    stability = {},
  } = params
  const logger = withRunId(params.logger, params.runId)

  const unsettled = ledger.snapshot().filter(entry => entry.state !== 'settled')
  logger.warn(
    {rootSessionId, directory, unsettled: unsettled.map(entry => entry.sessionId)},
    'settle-owned-sessions: stopping the run’s directory and waiting for it to stay quiet before releasing resources',
  )

  let finished = false
  // The last reason the gate had not passed, for the report when the bound is reached.
  let lastReason = 'the directory was never read'

  /** Mark what is unsettled `unknown`: "we gave up waiting" must not read as "we never tried". */
  function markUnresolved(): readonly string[] {
    const unresolved = ledger.snapshot().filter(entry => entry.state !== 'settled')
    for (const entry of unresolved) ledger.markUnknown(entry.sessionId)
    return unresolved.map(entry => entry.sessionId)
  }

  return withBound(
    timeoutMs,
    async () => {
      // The barrier always resolves to a decision, even when a callee misbehaves.
      const teardown = new AbortController()
      const teardownTimer = setTimeout(() => teardown.abort(), timeoutMs)
      try {
        const gate = createDirectoryStabilityGate({
          ...stability,
          observe: async signal => {
            const observation = await observeDirectoryV2({
              client,
              directory,
              signal,
              inbox: {runStartedAt, ownedSessionIds: () => ownedSessionIdsOf(rootSessionId, ledger)},
              ...(knownSessionIds === undefined ? {} : {knownSessionIds}),
            })
            if (observation.kind === 'quiescent') return observation
            lastReason =
              observation.kind === 'unreadable'
                ? `a read of the directory failed: ${observation.reason}`
                : `the directory was active: ${observation.activity.activeSessionIds.length} session(s), ${observation.activity.runningShellIds.length} shell(s), ${observation.activity.queuedInbox.length} queued inbox(es)`
            // A partial reading is acted on too: what it did show is still there to stop.
            await stopDirectoryActivityV2({
              client,
              rootSessionId,
              directory,
              activity: observation.activity,
              signal,
              logger,
            })
            return observation
          },
        })

        const outcome = await awaitDirectoryStability({
          gate,
          signal: teardown.signal,
          spacingMs: stability.minSpacingMs ?? DIRECTORY_QUIESCENCE_MIN_SPACING_MS,
        })

        if (finished) return {settled: false as const, reason: lastReason}
        if (outcome.passed) {
          for (const entry of ledger.snapshot()) if (entry.state !== 'settled') ledger.settle(entry.sessionId)
          logger.info(
            {rootSessionId, directory},
            'settle-owned-sessions: the directory stayed quiet for the whole window — safe to release',
          )
          return {settled: true as const}
        }

        const unresolvedIds = markUnresolved()
        logger.error(
          {rootSessionId, directory, unresolvedIds, reason: lastReason},
          'settle-owned-sessions: the directory could not be confirmed quiet',
        )
        return {settled: false as const, reason: lastReason}
      } catch (error) {
        const message = toErrorMessage(error)
        logger.error(
          {rootSessionId, detail: message},
          'settle-owned-sessions: unexpected error during settle attempt — quarantining rather than letting it escape',
        )
        if (!finished) markUnresolved()
        return {settled: false as const, reason: `settle attempt threw unexpectedly: ${message}`}
      } finally {
        clearTimeout(teardownTimer)
        teardown.abort()
        finished = true
      }
    },
    () => {
      finished = true
      // Marking happens after `finished` is set, so the abandoned attempt cannot undo it.
      const abandonedIds = markUnresolved()
      logger.error(
        {rootSessionId, timeoutMs, abandonedIds},
        'settle-owned-sessions: settle attempt exceeded its bound — quarantining rather than hanging',
      )
      return {settled: false as const, reason: `settle attempt exceeded its ${timeoutMs}ms bound: ${lastReason}`}
    },
  )
}
