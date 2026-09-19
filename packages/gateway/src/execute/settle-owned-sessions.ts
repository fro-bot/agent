/**
 * Termination barrier for a run's owned background sessions.
 *
 * `run-core.ts` dispatches background subagents (the ownership ledger) that
 * write to the workspace and the git index. Before this module existed, any
 * failure path that threw out of `runOpenCodeCore` (a `session.error`, a
 * dropped stream, a timeout) escaped immediately — `run.ts` would stop the
 * heartbeat and release the repository lock while sibling background children
 * of the failed run were still alive and mutating the checkout. The next
 * queued run could then acquire the lock and start working in a workspace a
 * previous run's orphaned subagents were still writing to.
 *
 * `settleOwnedSessions` is the barrier every such failure path is routed
 * through (via `throwWithBarrier` in `run-core.ts`) before the causal error is
 * allowed to escape to `run.ts`. It:
 *
 * 1. Fast-paths when the ledger has no unsettled work at all — a run that
 *    never dispatched background work, or whose owned children already
 *    settled, pays no cost and sends no extra request.
 * 2. Stops the root session from producing more work (best-effort — the root
 *    has usually already failed by the time this runs).
 * 3. Cancels every unsettled owned child individually, using a FRESH
 *    teardown signal — `run-core`'s own `combinedSignal` is already aborted
 *    by the time a failure reaches here and cannot carry a new cancellation
 *    request.
 * 4. Confirms settlement via the same reconciliation primitive the drain loop
 *    uses (`reconcileLedgerOnce`) rather than trusting that the abort calls
 *    succeeded — an `abort` response with no error envelope is a delivery
 *    receipt, not proof the child actually stopped.
 * 5. Bounds the whole attempt (abort round + confirmation round) with its own
 *    timer, independent of whatever the SDK client does with the signals it
 *    is handed — a hung abort or a hung confirmation call still resolves
 *    into a quarantine decision rather than hanging the caller forever.
 *
 * Every session.abort call checks BOTH the SDK error envelope (`response.error`)
 * and a thrown exception — this client reports transport failures as a field
 * on the response as often as it throws one, and an unchecked call looks
 * successful when it failed.
 *
 * Any entry still not `settled` when the attempt concludes (bounded timeout,
 * or confirmation still reports it live) is explicitly downgraded to
 * `unknown` — cancellation was requested but nothing here confirms the child
 * actually stopped, so `unknown` (not `settled`) is the honest state. The
 * caller (`run-core.ts`'s `throwWithBarrier`) reads this back via
 * `ledger.isDrainComplete()` to decide whether the causal error escapes
 * plain or `quarantined`.
 *
 * This module deliberately does NOT decide what `run.ts` does with a
 * quarantine outcome — it only reports whether settlement was confirmed. The
 * decision to hold the lock, keep the heartbeat renewing it, and refuse
 * hand-off lives entirely in `run.ts`.
 */

import type {OwnershipLedger, Logger as RuntimeLogger, SessionClient} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {createSdkLedgerReconcileAdapter, reconcileLedgerOnce} from '@fro-bot/runtime'

/**
 * Upper bound, in milliseconds, on the whole settle attempt (abort round +
 * confirmation round). Independent of the run's own deadline — the run's
 * `combinedSignal` is already aborted by the time this runs, so this is a
 * fresh budget, not a remainder of the run's budget.
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 15_000

export interface SettleOwnedSessionsParams {
  /** SDK client for the workspace OpenCode server this run is attached to. */
  readonly client: SessionClient
  /** Workspace directory — threaded to every `session.abort` query param. */
  readonly directory: string
  /** The root session this run created. */
  readonly rootSessionId: string
  /** The run's ownership ledger. Mutated in place (`markUnknown`/`settle` via reconciliation). */
  readonly ledger: OwnershipLedger
  readonly logger: GatewayLogger
  /** Overrides `DEFAULT_SETTLE_TIMEOUT_MS` — for tests only. */
  readonly timeoutMs?: number
}

export type SettleOwnedSessionsResult = {readonly settled: true} | {readonly settled: false; readonly reason: string}

/** Adapt the gateway's `(context, message)` logger to the runtime's `(message, context)` shape. */
function toRuntimeLogger(logger: GatewayLogger): RuntimeLogger {
  return {
    debug: (msg, ctx) => logger.debug(ctx ?? {}, msg),
    info: (msg, ctx) => logger.info(ctx ?? {}, msg),
    warning: (msg, ctx) => logger.warn(ctx ?? {}, msg),
    error: (msg, ctx) => logger.error(ctx ?? {}, msg),
  }
}

/**
 * Cancel a single session. Best-effort: checks BOTH the SDK error envelope
 * and a thrown exception, logs either, and never throws — a failed cancel
 * request is evidence for the confirmation step below, not a reason to abort
 * the whole settle attempt.
 */
async function abortSession(
  client: SessionClient,
  sessionId: string,
  directory: string,
  signal: AbortSignal,
  logger: GatewayLogger,
  role: 'root' | 'owned',
): Promise<void> {
  try {
    const response = await client.session.abort({path: {id: sessionId}, query: {directory}, signal})
    const envelope = response as {readonly error?: unknown} | undefined
    if (envelope?.error != null) {
      logger.warn(
        {sessionId, role, detail: String(envelope.error)},
        'settle-owned-sessions: session.abort returned an error envelope',
      )
    }
  } catch (error) {
    logger.warn(
      {sessionId, role, detail: error instanceof Error ? error.message : String(error)},
      'settle-owned-sessions: session.abort threw',
    )
  }
}

/**
 * Race `work` against its own timer. Unlike passing a signal down, this does
 * not require the awaited work to cooperate with cancellation — if `work`
 * hangs (a mock or a real client that ignores its signal), this still
 * resolves via `onTimeout` once `ms` elapses. The abandoned `work` promise is
 * simply never awaited further.
 */
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

/**
 * Cancel and confirm settlement of every owned session this run's ledger
 * still tracks as unsettled, before a causal error is allowed to escape.
 *
 * Fast path: returns `{settled: true}` immediately, with zero remote calls,
 * when `ledger.isDrainComplete()` is already `true` — nothing to cancel, no
 * unnecessary abort call.
 */
export async function settleOwnedSessions(params: SettleOwnedSessionsParams): Promise<SettleOwnedSessionsResult> {
  const {client, directory, rootSessionId, ledger, logger, timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS} = params

  if (ledger.isDrainComplete() === true) {
    return {settled: true}
  }

  const unsettled = ledger.snapshot().filter(entry => entry.state !== 'settled')
  logger.warn(
    {rootSessionId, unsettled: unsettled.map(entry => entry.sessionId)},
    'settle-owned-sessions: run failed with owned work still outstanding — cancelling before releasing resources',
  )

  return withBound(
    timeoutMs,
    async () => {
      // Fresh teardown signal — run-core's own `combinedSignal` is already aborted by
      // the time a failure reaches this barrier and cannot carry a new cancellation
      // request; this one is scoped solely to this settle attempt.
      const teardownSignal = AbortSignal.timeout(timeoutMs)

      // Stop the root from producing more work. Best-effort safety net — the root has
      // usually already failed (that is why this barrier is running at all).
      await abortSession(client, rootSessionId, directory, teardownSignal, logger, 'root')

      await Promise.allSettled(
        unsettled.map(async entry => abortSession(client, entry.sessionId, directory, teardownSignal, logger, 'owned')),
      )

      // Confirm — an abort call succeeding is a delivery receipt, not proof the child
      // actually stopped. Reuse the same reconciliation primitive the drain loop uses.
      const adapter = createSdkLedgerReconcileAdapter(client)
      const reconcileResult = await reconcileLedgerOnce({
        ledger,
        adapter,
        parentSessionId: rootSessionId,
        logger: toRuntimeLogger(logger),
      })
      if (reconcileResult.success === false) {
        logger.warn(
          {rootSessionId, detail: reconcileResult.error.message},
          'settle-owned-sessions: reconciliation call failed while confirming settlement',
        )
      }

      if (ledger.isDrainComplete() === true) {
        logger.info({rootSessionId}, 'settle-owned-sessions: owned work confirmed settled')
        return {settled: true}
      }

      // Still not confirmed — cancellation was requested but nothing here confirms the
      // child actually stopped. Explicitly downgrade every remaining entry to `unknown`
      // (idempotent for one already `unknown`) rather than leaving it `outstanding`,
      // which would misrepresent "we gave up waiting" as "we never tried".
      const stillUnresolved = ledger.snapshot().filter(entry => entry.state !== 'settled')
      for (const entry of stillUnresolved) {
        ledger.markUnknown(entry.sessionId)
      }
      const stillUnresolvedIds = stillUnresolved.map(entry => entry.sessionId)
      logger.error(
        {rootSessionId, stillUnresolvedIds},
        'settle-owned-sessions: owned work could not be confirmed settled',
      )
      return {settled: false, reason: `owned sessions not confirmed settled: ${stillUnresolvedIds.join(', ')}`}
    },
    () => {
      logger.error(
        {rootSessionId, timeoutMs},
        'settle-owned-sessions: settle attempt exceeded its bound — quarantining rather than hanging',
      )
      return {settled: false, reason: `settle attempt exceeded its ${timeoutMs}ms bound`}
    },
  )
}
