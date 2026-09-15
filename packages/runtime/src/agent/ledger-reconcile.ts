/**
 * Ledger reconciliation: recovers the ownership ledger from events it never saw.
 *
 * The ledger (`ownership-ledger.ts`) learns about background work from a stream
 * of dispatch/settlement events. That stream has no replay: a reconnect, a
 * discontinuity, or a silent drop with no reconnect at all can leave the ledger
 * reading zero while a child session is still writing. Reconciliation asks
 * upstream directly instead of waiting for an event that may never arrive.
 *
 * Two upstream questions, deliberately kept separate:
 * - `children(parentSessionId)` — DISCOVERY. A bare `parent_id` lookup with no
 *   liveness filter. It returns every child session ever created under the
 *   parent, including ones that finished long ago. Adopting its result wholesale
 *   would keep the ledger permanently non-empty with historical children, and
 *   drain (and persistence) would never complete. This was a real defect caught
 *   in review; this module must never adopt a `children()` candidate on its own.
 * - `liveSessionIds()` — LIVENESS. Backed by session status, which holds an
 *   entry only while a session is non-idle. A session absent from this set has
 *   finished (or never started); a session present in it is live right now.
 *
 * A candidate is adopted only when it is BOTH a child of the parent AND live
 * AND absent from the ledger. A ledger entry is settled only when its session
 * is confirmed no longer live. Nothing is ever adopted or settled from
 * `children()` output alone.
 *
 * Failure handling: a failed reconciliation call (either upstream call
 * rejecting or returning an error) marks every currently-outstanding ledger
 * entry `unknown` rather than leaving them untouched or settling them. This
 * matters because `unknown` — unlike `outstanding` — does not block
 * `isDrainComplete()`, only `isPersistenceSafe()`. A failed call must never
 * make the ledger look empty (which would wrongly unblock persistence), but it
 * also must not make a permanently-unreachable status check block drain
 * forever. `unknown` is the fail-safe middle state the ledger was designed for.
 * Settling FROM unknown is still allowed, and only ever happens on a later
 * POSITIVE observation (a status check that confirms the session is no longer
 * live) — never inferred from the absence of evidence.
 */

import type {Result} from '@bfra.me/es/result'
import type {SessionClient} from '../session/backend.js'
import type {Logger} from '../shared/logger.js'
import type {OwnershipLedger} from './ownership-ledger.js'

import {err, ok} from '@bfra.me/es/result'
import {toError} from '../shared/errors.js'

/** Bounded interval between reconciliation passes run only because the interval elapsed. */
export const DEFAULT_LEDGER_RECONCILE_INTERVAL_MS = 30_000

/** A candidate child session discovered via upstream's `children` lookup. */
export interface LedgerReconcileChild {
  readonly id: string
}

/**
 * Upstream calls this module needs, taken as an injected adapter rather than
 * reaching for an SDK client directly — the established pattern for testable
 * I/O in this project (see `CacheAdapter` in `src/services/cache/types.ts`).
 *
 * Both methods return `Result` rather than throwing, so a transport failure
 * is indistinguishable in shape from any other upstream error the caller must
 * handle by marking the ledger unknown — there is no separate "crashed" path
 * to forget to wire up.
 */
export interface LedgerReconcileAdapter {
  /** Every child session ever created under `parentSessionId` — no liveness filter. */
  readonly children: (parentSessionId: string) => Promise<Result<readonly LedgerReconcileChild[], Error>>
  /** The set of session ids that are currently non-idle (live) upstream. */
  readonly liveSessionIds: () => Promise<Result<ReadonlySet<string>, Error>>
}

export interface ReconcileLedgerOptions {
  readonly ledger: OwnershipLedger
  readonly adapter: LedgerReconcileAdapter
  readonly parentSessionId: string
  readonly logger: Logger
}

/** Label recorded for entries this module adopts — reconciliation has no caller-supplied label to preserve. */
const RECONCILED_LABEL = 'reconciled'

/**
 * Run one reconciliation pass: adopt live untracked children, settle entries
 * that are no longer live, and — on failure — mark outstanding entries unknown.
 *
 * Idempotent: running this repeatedly against an unchanged upstream view makes
 * no further ledger changes (`adopt` and `settle` are themselves idempotent).
 */
export async function reconcileLedgerOnce(options: ReconcileLedgerOptions): Promise<Result<void, Error>> {
  const {ledger, adapter, parentSessionId, logger} = options

  const [childrenResult, liveResult] = await Promise.all([adapter.children(parentSessionId), adapter.liveSessionIds()])

  if (childrenResult.success === false || liveResult.success === false) {
    const error = childrenResult.success === false ? childrenResult.error : (liveResult as {error: Error}).error
    const previouslyOutstanding = ledger.snapshot().filter(entry => entry.state === 'outstanding')
    for (const entry of previouslyOutstanding) {
      ledger.markUnknown(entry.sessionId)
    }
    logger.warning('Ledger reconciliation failed; marking outstanding entries unknown rather than settling them', {
      source: 'reconcileLedgerOnce',
      parentSessionId,
      unknownCount: previouslyOutstanding.length,
      error: error.message,
    })
    return err(error)
  }

  const children = childrenResult.data
  const liveSessionIds = liveResult.data
  const knownSessionIds = new Set(ledger.snapshot().map(entry => entry.sessionId))

  const adopted: string[] = []
  for (const child of children) {
    if (knownSessionIds.has(child.id) === true) continue
    if (liveSessionIds.has(child.id) === false) continue
    ledger.adopt(child.id, RECONCILED_LABEL)
    adopted.push(child.id)
  }

  const settled: string[] = []
  for (const entry of ledger.snapshot()) {
    if (entry.state !== 'outstanding' && entry.state !== 'unknown') continue
    if (liveSessionIds.has(entry.sessionId) === true) continue
    ledger.settle(entry.sessionId)
    settled.push(entry.sessionId)
  }

  if (adopted.length > 0 || settled.length > 0) {
    logger.debug('Ledger reconciliation adjusted ownership', {
      source: 'reconcileLedgerOnce',
      parentSessionId,
      adopted,
      settled,
    })
  }

  return ok(undefined)
}

export interface LedgerReconciler {
  /** Stops the interval timer. Idempotent — safe to call more than once. */
  readonly dispose: () => void
}

export interface CreateLedgerReconcilerOptions extends ReconcileLedgerOptions {
  /** Interval between interval-triggered passes. Defaults to `DEFAULT_LEDGER_RECONCILE_INTERVAL_MS`. */
  readonly intervalMs?: number
}

/**
 * Arms a bounded-interval reconciliation pass, independent of the subscription
 * and discontinuity triggers a caller wires up elsewhere by calling
 * `reconcileLedgerOnce` directly. The interval exists because a dropped
 * dispatch event with no detected discontinuity has nothing else to trigger a
 * re-check — this is the plan's central hazard, and belt-and-braces triggers
 * (subscription, discontinuity) do not cover it.
 */
export function createLedgerReconciler(options: CreateLedgerReconcilerOptions): LedgerReconciler {
  const {intervalMs = DEFAULT_LEDGER_RECONCILE_INTERVAL_MS, ...reconcileOptions} = options

  let disposed = false
  const handle = setInterval(() => {
    if (disposed) return
    reconcileLedgerOnce(reconcileOptions).catch(() => {
      // reconcileLedgerOnce never rejects (all upstream failures are captured as `err`
      // results and logged internally); this catch exists only to satisfy no-floating-promises.
    })
  }, intervalMs)

  return {
    dispose: (): void => {
      if (disposed) return
      disposed = true
      clearInterval(handle)
    },
  }
}

/**
 * Default adapter backed by a real `SessionClient` (the SDK client both the
 * Action and the gateway ultimately hold). The gateway wraps this behind
 * `packages/gateway/src/runtime-effect.ts`, following the pattern that file
 * already uses for every other runtime primitive: `Effect.tryPromise` around
 * this adapter's Promise-returning, `Result`-yielding methods, flat-mapped
 * into `Effect.succeed`/`Effect.fail` on the `success` discriminant. Because
 * this shape returns `Result` instead of throwing, that wrap needs no special
 * casing beyond what every other `*Effect` wrapper already does. The Action
 * consumes it directly, since it has no equivalent Effect boundary.
 */
export function createSdkLedgerReconcileAdapter(client: SessionClient): LedgerReconcileAdapter {
  return {
    children: async (parentSessionId: string): Promise<Result<readonly LedgerReconcileChild[], Error>> => {
      try {
        const response = await client.session.children({path: {id: parentSessionId}})
        if (response.error != null || response.data == null) {
          return err(toError(response.error ?? 'session.children returned no data'))
        }
        if (!Array.isArray(response.data)) {
          return err(new Error('session.children returned a non-array payload'))
        }
        return ok(response.data.map(session => ({id: session.id})))
      } catch (error) {
        return err(toError(error))
      }
    },

    liveSessionIds: async (): Promise<Result<ReadonlySet<string>, Error>> => {
      try {
        const response = await client.session.status()
        if (response.error != null || response.data == null) {
          return err(toError(response.error ?? 'session.status returned no data'))
        }
        return ok(new Set(Object.keys(response.data)))
      } catch (error) {
        return err(toError(error))
      }
    },
  }
}
