/**
 * Termination barrier for a run's owned background sessions, on OpenCode V2: the sibling of
 * `settle-owned-sessions.ts`. The contract is the same; read that module's doc for the reasoning. What differs is how a
 * stop is requested and how it is confirmed:
 *
 * - A session is stopped with `POST /api/session/:id/interrupt`. Its reply is a delivery receipt, never a stop
 *   (`{interrupted: false}` is also what a not-yet-admitted prompt returns, probe P1).
 * - A child is confirmed settled by the same reconciliation primitive the drain uses (`reconcileLedgerOnce`) over the V2
 *   adapter: absent from `GET /api/session/active` and listed by `session.list({parentID})`.
 * - A root is confirmed stopped by positive evidence plus absence from the active list (`probeRootStopV2`), and never
 *   by an interrupt with reason `shutdown`.
 *
 * Fast path: returns `{settled: true}` with zero remote calls when the ledger has no unsettled work and the root need
 * not be confirmed. Otherwise the whole attempt (interrupt round, confirmation round) runs under its own bound, with a
 * fresh teardown signal, because the run's own signal is already aborted by the time a failure reaches here. Anything
 * still unresolved when the attempt ends is downgraded to `unknown`, and the caller quarantines.
 *
 * Background shells: a session interrupt does not stop them (`Job.cancel(sessionID)` finds no job under a session id), and
 * they outlive the run's lock. So BEFORE the root is interrupted, every owned shell is killed with
 * `DELETE /api/shell/:id` and the stop is confirmed by `GET /api/shell` no longer listing it. A shell that cannot be
 * confirmed gone keeps the stop unconfirmed. The kill queues an `error` notice that wakes the root, which is why the
 * root interrupt comes after it, and why an owned shell counts as background work open (`followUpPossible`).
 *
 * Background work open (`followUpPossible`): the server then starts root turns by itself, so the root is never
 * confirmed. The barrier interrupts the root and the owned children once, settles the children, and reports
 * `rootUnconfirmed` without waiting out its budget; the quarantine watch does the polling.
 *
 * This module does not decide what `run.ts` does with a quarantine outcome.
 */

import type {OwnershipLedger, RemoteOpenCodeV2Client} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {StreamTerminal} from './root-stop-v2.js'

import {
  collectOwnerSessionIds,
  createV2LedgerReconcileAdapter,
  isShellLedgerKey,
  killOwnedShells,
  reconcileLedgerOnce,
  toErrorMessage,
} from '@fro-bot/runtime'
import {interruptSession, probeRootStopV2} from './root-stop-v2.js'
import {ROOT_QUIESCENCE_POLL_INTERVAL_MS} from './root-stop.js'
import {toRuntimeLogger} from './runtime-logger.js'

export {ROOT_QUIESCENCE_POLL_INTERVAL_MS}

/**
 * Upper bound, in milliseconds, on the whole settle attempt (interrupt round + confirmation round). A fresh budget,
 * not a remainder of the run's.
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 15_000

export interface SettleOwnedSessionsV2Params {
  /** Client for the workspace OpenCode V2 server this run is attached to. */
  readonly client: RemoteOpenCodeV2Client
  /** The location the run's sessions and shells live in: the directory the root was created at. */
  readonly directory: string
  /** The root session this run created. */
  readonly rootSessionId: string
  /** The run's ownership ledger. Mutated in place (`markUnknown`/`settle` via reconciliation). */
  readonly ledger: OwnershipLedger
  readonly logger: GatewayLogger
  /** The gateway run this attempt belongs to. Stamped on every log line, including the reconciliation lines. */
  readonly runId?: string
  /** Overrides `DEFAULT_SETTLE_TIMEOUT_MS` — for tests only. */
  readonly timeoutMs?: number
  /** The root may still be executing. Disables the settled-ledger fast path and adds root quiescence to the checks. */
  readonly confirmRootQuiescent?: boolean
  /** Background work is open, so a root turn the stream has not shown can still start. Only meaningful with `confirmRootQuiescent`. */
  readonly followUpPossible?: boolean
  /** Overrides `ROOT_QUIESCENCE_POLL_INTERVAL_MS` — for tests only. */
  readonly rootPollIntervalMs?: number
  /** How the root's latest execution ended on the stream, or `null`. Absent: the server's persisted outcome decides. */
  readonly streamTerminal?: () => StreamTerminal | null
}

export type SettleOwnedSessionsV2Result =
  | {readonly settled: true}
  | {
      readonly settled: false
      readonly reason: string
      /** The root was to be confirmed stopped and was not. The caller keeps watching it through the hold. */
      readonly rootUnconfirmed: boolean
      /** An owned background shell is not confirmed stopped. The caller keeps killing it through the hold. */
      readonly shellsUnconfirmed: boolean
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

function hasUnsettledShells(ledger: OwnershipLedger): boolean {
  return ledger.snapshot().some(entry => isShellLedgerKey(entry.sessionId) && entry.state !== 'settled')
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
    timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS,
    confirmRootQuiescent = false,
    followUpPossible = false,
    rootPollIntervalMs = ROOT_QUIESCENCE_POLL_INTERVAL_MS,
    streamTerminal = (): StreamTerminal | null => null,
  } = params
  const logger = withRunId(params.logger, params.runId)
  const runtimeLogger = toRuntimeLogger(logger)

  if (ledger.isDrainComplete() && !confirmRootQuiescent) {
    return {settled: true}
  }

  const unsettled = ledger.snapshot().filter(entry => entry.state !== 'settled')
  logger.warn(
    {rootSessionId, unsettled: unsettled.map(entry => entry.sessionId), confirmRootQuiescent},
    confirmRootQuiescent
      ? 'settle-owned-sessions: run failed while the root may still be running — interrupting the root and confirming it stopped before releasing resources'
      : 'settle-owned-sessions: run failed with owned work outstanding — cancelling before releasing resources',
  )
  let finished = false
  const isFinished = (): boolean => finished
  // Whether the root was confirmed stopped, readable from the bound's timeout path too.
  let rootConfirmed = !confirmRootQuiescent
  // Whether every owned shell was confirmed stopped. False until the kill has answered: a bound that passes first has
  // not ruled out a shell the ledger never heard of.
  let shellsConfirmed = false
  let unconfirmedShellIds: readonly string[] = []

  return withBound(
    timeoutMs,
    async () => {
      // The barrier always resolves to a decision, even when a callee misbehaves.
      try {
        const teardownSignal = AbortSignal.timeout(timeoutMs)

        const adapter = createV2LedgerReconcileAdapter(client.session)
        // Once the bound has passed this attempt is abandoned: whatever it still has in flight must not change the
        // ledger the caller has already read the decision from.
        const attemptLedger: OwnershipLedger = {
          ...ledger,
          settle: sessionId => {
            if (!isFinished()) ledger.settle(sessionId)
          },
          markUnknown: sessionId => {
            if (!isFinished()) ledger.markUnknown(sessionId)
          },
        }

        // Owned background shells first. A session interrupt does not stop them, and the kill wakes the root with an
        // error notice, so the root is interrupted AFTER it, never before. Confirmed ones are settled in the ledger.
        const shellKill = await killOwnedShells({
          api: client,
          directory,
          ownerSessionIds: collectOwnerSessionIds(rootSessionId, attemptLedger),
          ledger: attemptLedger,
          logger: runtimeLogger,
          signal: teardownSignal,
        })
        shellsConfirmed = shellKill.confirmed
        unconfirmedShellIds = shellKill.confirmed ? [] : shellKill.stillRunning

        // Stop the root from producing more work. Confirmed below only when `confirmRootQuiescent`.
        await interruptSession(client, rootSessionId, teardownSignal, logger, 'root')

        const unsettledSessions = unsettled.filter(entry => !isShellLedgerKey(entry.sessionId))
        await Promise.allSettled(
          unsettledSessions.map(async entry =>
            interruptSession(client, entry.sessionId, teardownSignal, logger, 'owned'),
          ),
        )

        if (unsettledSessions.length > 0) {
          const reconcileResult = await reconcileLedgerOnce({
            ledger: attemptLedger,
            adapter,
            parentSessionId: rootSessionId,
            logger: runtimeLogger,
            signal: teardownSignal,
          })
          if (!reconcileResult.success) {
            logger.warn(
              {rootSessionId, detail: reconcileResult.error.message},
              'settle-owned-sessions: reconciliation call failed while confirming settlement',
            )
          }
        }

        // The root's own turn: confirmed only by positive evidence, never by absence alone. Poll inside the same
        // teardown budget, interrupting again whenever the root turns up live.
        let rootQuiescent = !confirmRootQuiescent
        let reinterrupts = 0
        while (!rootQuiescent && !isFinished() && !teardownSignal.aborted) {
          // Nothing can confirm the root with background work open; the quarantine watch does the polling.
          if (followUpPossible) break
          const probe = await probeRootStopV2({
            client,
            adapter,
            rootSessionId,
            signal: teardownSignal,
            streamTerminal,
          })
          if (probe === 'confirmed') {
            rootQuiescent = true
            rootConfirmed = true
          } else {
            if (probe === 'busy' && !isFinished()) {
              reinterrupts += 1
              if (reinterrupts === 1) {
                logger.warn(
                  {rootSessionId},
                  'settle-owned-sessions: the root is running after the interrupt — interrupting it again until it is confirmed stopped',
                )
              }
              await interruptSession(client, rootSessionId, teardownSignal, logger, 'root')
            }
            if (!isFinished()) {
              await new Promise<void>(resolve => {
                setTimeout(resolve, rootPollIntervalMs)
              })
            }
          }
        }

        if (ledger.isDrainComplete() && rootQuiescent && shellsConfirmed) {
          logger.info(
            {rootSessionId, confirmRootQuiescent},
            confirmRootQuiescent
              ? 'settle-owned-sessions: owned work settled and the root confirmed stopped'
              : 'settle-owned-sessions: owned work confirmed settled',
          )
          return {settled: true as const}
        }

        // Still not confirmed. Downgrade every remaining entry to `unknown` rather than leaving it `outstanding`,
        // which would misrepresent "we gave up waiting" as "we never tried".
        const stillUnresolved = attemptLedger.snapshot().filter(entry => entry.state !== 'settled')
        for (const entry of stillUnresolved) {
          attemptLedger.markUnknown(entry.sessionId)
        }
        const stillUnresolvedIds = stillUnresolved.map(entry => entry.sessionId)
        const unresolvedNotes = [
          ...(stillUnresolvedIds.length > 0
            ? [`owned sessions not confirmed settled: ${stillUnresolvedIds.join(', ')}`]
            : []),
          ...(shellsConfirmed
            ? []
            : [`owned shells not confirmed stopped: ${unconfirmedShellIds.join(', ') || 'unknown'}`]),
        ].join('; ')
        logger.error(
          {rootSessionId, stillUnresolvedIds, unconfirmedShellIds, rootQuiescent},
          'settle-owned-sessions: owned work could not be confirmed settled',
        )
        if (!rootQuiescent) {
          return {
            settled: false as const,
            reason: `root session not confirmed stopped after interrupt${unresolvedNotes === '' ? '' : `; ${unresolvedNotes}`}`,
            rootUnconfirmed: true,
            shellsUnconfirmed: !shellsConfirmed || hasUnsettledShells(attemptLedger),
          }
        }
        return {
          settled: false as const,
          reason: unresolvedNotes,
          rootUnconfirmed: false,
          shellsUnconfirmed: !shellsConfirmed || hasUnsettledShells(attemptLedger),
        }
      } catch (error) {
        const message = toErrorMessage(error)
        logger.error(
          {rootSessionId, detail: message},
          'settle-owned-sessions: unexpected error during settle attempt — quarantining rather than letting it escape',
        )
        return {
          settled: false as const,
          reason: `settle attempt threw unexpectedly: ${message}`,
          rootUnconfirmed: !rootConfirmed,
          shellsUnconfirmed: !shellsConfirmed || hasUnsettledShells(ledger),
        }
      } finally {
        finished = true
      }
    },
    () => {
      finished = true
      // Marking happens after `finished` is set, so the abandoned attempt cannot undo it.
      const abandonedEntries = ledger.snapshot().filter(entry => entry.state !== 'settled')
      for (const entry of abandonedEntries) {
        ledger.markUnknown(entry.sessionId)
      }
      logger.error(
        {rootSessionId, timeoutMs, abandonedIds: abandonedEntries.map(entry => entry.sessionId)},
        'settle-owned-sessions: settle attempt exceeded its bound — quarantining rather than hanging',
      )
      return {
        settled: false as const,
        reason: `settle attempt exceeded its ${timeoutMs}ms bound`,
        rootUnconfirmed: !rootConfirmed,
        shellsUnconfirmed: !shellsConfirmed || hasUnsettledShells(ledger),
      }
    },
  )
}
