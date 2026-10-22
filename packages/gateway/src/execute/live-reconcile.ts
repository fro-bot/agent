/**
 * One bounded reconcile pass for the gateway run's live path: the periodic tick and the one-shot on root idle.
 *
 * `createLedgerReconciler` skips a tick while a pass is still in flight, so a single `children()` or `status()`
 * call that never answers would stop periodic reconciliation for the rest of the run. Each pass therefore gets a
 * bound (`LIVE_RECONCILE_TIMEOUT_MS`) and a signal that is aborted when the bound expires: the race bounds this
 * await, the signal asks the client to stop the request.
 *
 * A pass that times out does what a failed pass (an adapter error) does in `reconcileLedgerOnce`, nothing more:
 * every `outstanding` entry becomes `unknown` and the pass is logged. A failed pass leaves `isDrainComplete()`
 * exactly as an `outstanding` entry would (both block), and a later successful pass can still settle the entry.
 *
 * An abandoned or stale pass must never change the ledger. Once the bound has passed, or the run has moved on to
 * teardown (`isClosed`), the ledger the pass writes through ignores `settle` and `markUnknown`: teardown's settle
 * owns the ledger from then on.
 */

import type {OwnershipLedger, ReconcileLedgerOptions} from '@fro-bot/runtime'

import {reconcileLedgerOnce} from '@fro-bot/runtime'

/** Bound on one live-path reconcile pass, in milliseconds. */
export const LIVE_RECONCILE_TIMEOUT_MS = 5_000

/**
 * Runs one reconcile pass under `LIVE_RECONCILE_TIMEOUT_MS`. Never rejects. `isClosed` reports that the run no
 * longer owns the ledger; a pass that is still running by then is inert whenever it answers.
 */
export async function reconcileLivePass(
  options: ReconcileLedgerOptions,
  isClosed: () => boolean,
  timeoutMs: number = LIVE_RECONCILE_TIMEOUT_MS,
): Promise<void> {
  const {ledger, logger, parentSessionId} = options
  const controller = new AbortController()
  let abandoned = false
  const inert = (): boolean => abandoned || isClosed()
  const guardedLedger: OwnershipLedger = {
    ...ledger,
    settle: sessionId => {
      if (!inert()) ledger.settle(sessionId)
    },
    markUnknown: sessionId => {
      if (!inert()) ledger.markUnknown(sessionId)
    },
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timed-out'>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timed-out')
    }, timeoutMs)
  })
  try {
    const outcome = await Promise.race([
      reconcileLedgerOnce({...options, ledger: guardedLedger, signal: controller.signal}).then(
        () => 'finished' as const,
      ),
      timedOut,
    ])
    if (outcome === 'finished') return

    abandoned = true
    if (isClosed()) return
    const outstanding = ledger.snapshot().filter(entry => entry.state === 'outstanding')
    for (const entry of outstanding) ledger.markUnknown(entry.sessionId)
    logger.warning('Ledger reconciliation timed out; marking outstanding entries unknown rather than settling them', {
      source: 'reconcileLivePass',
      parentSessionId,
      unknownCount: outstanding.length,
      timeoutMs,
    })
  } catch {
    // reconcileLedgerOnce never rejects (upstream failures come back as `err` results); a throw from the ledger
    // or logger must not escape a fire-and-forget pass.
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
