import type {ActionOpenCodeV2Client, OwnershipLedger} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import {
  createV2LedgerReconcileAdapter,
  DEFAULT_LEDGER_RECONCILE_INTERVAL_MS,
  reconcileLedgerOnce,
  reconcileShellsOnce,
} from '@fro-bot/runtime'

/**
 * Reconciling the ownership ledger against the V2 server over REST: the Action's sibling of the gateway's live pass.
 *
 * The event stream settles an entry from its notice. This is the net under it for a notice the stream missed: children
 * through `GET /api/session/active` and `session.list({parentID})`, background shells through `GET /api/shell` and
 * `GET /api/shell/:id`. Reconciliation settles what it can prove stopped and never adopts (a session whose adoption
 * event was lost is the directory gate's concern, not the ledger's).
 *
 * Why it is bounded and guarded: a pass that never answers must not stop the ticks behind it, and a pass abandoned at
 * its bound (or by a run that moved on to teardown) must never change the ledger when it finally answers. The first
 * would hold the in-flight guard forever; the second would let a stale answer overturn a decision already made.
 */

/** Bound on one pass. A server that is slow but answers must not turn every pass into a timeout. */
export const RECONCILE_PASS_TIMEOUT_MS = 5_000

export interface ReconcileOwnedWorkOptions {
  readonly client: ActionOpenCodeV2Client
  readonly ledger: OwnershipLedger
  /** The location the run's sessions and shells live in. */
  readonly directory: string
  readonly parentSessionId: string
  readonly logger: Logger
  /** `true` once the caller no longer owns the ledger: a pass still running is inert whenever it answers. */
  readonly isClosed?: () => boolean
  readonly timeoutMs?: number
}

/**
 * One bounded pass over the ledger's session and shell entries. Resolves `true` when it saw an unsettled entry still
 * running (a live direct child, or a listed shell), so a caller with no deadline can tell "waiting on work that runs"
 * from "waiting on work it cannot see". A pass that failed or timed out observed nothing and resolves `false`. Never
 * rejects.
 */
export async function reconcileOwnedWorkV2(options: ReconcileOwnedWorkOptions): Promise<boolean> {
  const {client, ledger, directory, parentSessionId, logger, isClosed = () => false} = options
  const timeoutMs = options.timeoutMs ?? RECONCILE_PASS_TIMEOUT_MS
  if (ledger.snapshot().length === 0) return false

  const controller = new AbortController()
  let abandoned = false
  const inert = (): boolean => abandoned || isClosed()
  const guarded: OwnershipLedger = {
    ...ledger,
    settle: key => {
      if (!inert()) ledger.settle(key)
    },
    markUnknown: key => {
      if (!inert()) ledger.markUnknown(key)
    },
  }
  const adapter = createV2LedgerReconcileAdapter(client.session)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timed-out'>(resolve => {
    timer = setTimeout(() => {
      // Abandoned first: an abort-triggered answer must find the guard already closed.
      abandoned = true
      controller.abort()
      resolve('timed-out')
    }, timeoutMs)
  })

  try {
    const outcome = await Promise.race([
      Promise.all([
        reconcileLedgerOnce({ledger: guarded, adapter, parentSessionId, logger, signal: controller.signal}),
        reconcileShellsOnce({ledger: guarded, api: client, directory, logger, signal: controller.signal}),
      ]).then(([sessions, shells]) => {
        const sessionRunning = sessions.success && sessions.data.liveTrackedSessionIds.size > 0
        const shellRunning = shells.success && shells.data.liveShellIds.size > 0
        return sessionRunning || shellRunning
      }),
      timedOut,
    ])
    if (outcome !== 'timed-out') return outcome

    if (!isClosed()) {
      const outstanding = ledger.snapshot().filter(entry => entry.state === 'outstanding')
      for (const entry of outstanding) ledger.markUnknown(entry.sessionId)
      logger.warning('Ledger reconciliation timed out; marking outstanding entries unknown rather than settling them', {
        source: 'reconcileOwnedWorkV2',
        parentSessionId,
        unknownCount: outstanding.length,
        timeoutMs,
      })
    }
    return false
  } catch {
    // Both passes return a result instead of throwing; a throw from the ledger or logger must not escape a
    // fire-and-forget pass.
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface OwnedWorkReconciler {
  /** Run a pass now, unless one is already in flight. Resolves when it finished or was skipped. */
  readonly reconcileNow: () => Promise<void>
  /** Stop the interval. Passes already running become inert. Idempotent. */
  readonly dispose: () => void
}

export interface OwnedWorkReconcilerOptions extends Omit<ReconcileOwnedWorkOptions, 'isClosed'> {
  readonly intervalMs?: number
}

/**
 * The live tick plus a one-shot trigger (the root going idle), over a single in-flight guard: a tick that fires while a
 * pass is running is skipped, and `reconcileNow` joins the pass that is running instead of stacking a second one.
 */
export function createOwnedWorkReconcilerV2(options: OwnedWorkReconcilerOptions): OwnedWorkReconciler {
  const {intervalMs = DEFAULT_LEDGER_RECONCILE_INTERVAL_MS, ...passOptions} = options
  let disposed = false
  let inFlight: Promise<void> | null = null

  const reconcileNow = async (): Promise<void> => {
    if (disposed) return
    if (inFlight !== null) return inFlight
    inFlight = reconcileOwnedWorkV2({...passOptions, isClosed: () => disposed})
      .then(() => undefined)
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  const timer = setInterval(() => {
    // eslint-disable-next-line no-void
    void reconcileNow()
  }, intervalMs)

  return {
    reconcileNow,
    dispose: () => {
      if (disposed) return
      disposed = true
      clearInterval(timer)
    },
  }
}
