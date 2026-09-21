/**
 * Ledger reconciliation: settles tracked ownership entries against upstream
 * state the event stream never delivered a confirmation for.
 *
 * The ledger (`ownership-ledger.ts`) learns about background work from a
 * stream of dispatch/settlement events. That stream has no replay: a
 * reconnect, a discontinuity, or a silent drop with no reconnect at all can
 * leave a tracked entry `outstanding` forever even after the session it
 * names has actually finished. Reconciliation asks upstream directly instead
 * of waiting for a completion event that may never arrive.
 *
 * This module settles what it already tracks. It does NOT adopt sessions the
 * ledger has never heard of. An earlier version adopted any live, untracked
 * child returned by `children(parentSessionId)`, meant to recover a
 * background dispatch whose event was dropped before the ledger ever learned
 * of it. That could not work and was actively harmful: upstream creates a
 * child session identically for foreground `task` delegation and for
 * background dispatch — the only difference is a `background: true` flag on
 * the tool-call metadata, which never reaches the session record itself (see
 * `session.children` / `session.status` in `../session/backend.js`, and
 * upstream `packages/opencode/src/tool/task.ts`: the child session is created
 * before the foreground/background branch, and `background` is stamped only
 * onto the returned tool part's metadata). `children()` and `liveSessionIds()`
 * therefore have no discriminant between an ordinary foreground subagent and
 * a background dispatch. Adopting on that basis meant an unrelated foreground
 * subagent, mid-run at a reconcile tick, could be adopted as this run's owned
 * background work — making every run's drain depend on a classification
 * THESE TWO CALLS cannot make. That adoption path has been removed.
 *
 * Read that as a statement about `children()`/`liveSessionIds()`, not about
 * the server as a whole. A discriminant does exist elsewhere: the same
 * `background: true` the session record lacks is written to the tool part's
 * `state.metadata` before the job starts, persisted with the rest of the part,
 * and returned by the message read API. See "Known gap" below — what is
 * missing here is a discriminant on THIS module's inputs, not one anywhere.
 *
 * Two upstream questions, both still needed to settle tracked entries safely:
 * - `children(parentSessionId)` — DISCOVERY. A bare `parent_id` lookup with
 *   no liveness filter. Used only to confirm a *tracked* entry's session id
 *   is actually a descendant of this parent — never to introduce a new entry.
 * - `liveSessionIds()` — LIVENESS. Backed by session status, which holds an
 *   entry only while a session is non-idle. A session absent from this set
 *   has finished (or never started); a session present in it is live right
 *   now.
 *
 * Every ledger entry that is currently `outstanding` or `unknown` falls into
 * one of three cases on each pass:
 * - Child of this parent AND live → left as-is. `outstanding` stays
 *   outstanding. An `unknown` entry stays `unknown` here too — this loop only
 *   ever settles or downgrades, it never re-promotes `unknown` back to
 *   `outstanding`; it can only leave `unknown` via the settle branch below.
 * - Child of this parent AND NOT live → finished. Settled. This settlement IS
 *   inferred from absence — the session is missing from `liveSessionIds()` —
 *   but that absence is checked against a session upstream still
 *   affirmatively confirms (via `children()`) belongs to this parent's tree.
 *   That is the one place this module treats absence of liveness as evidence
 *   of completion; it never treats absence of an *event* the same way.
 * - NOT a child of this parent at all → unverifiable. The reconciler has no
 *   basis to claim this entry is part of this parent's tree, so it is marked
 *   `unknown` — never settled (settling asserts a positive observation of
 *   completion this pass never made) and never left outstanding (that would
 *   let a session live under someone else's tree block this parent's drain
 *   forever). This is the security-relevant case: a persisted or forged
 *   ledger entry naming a session that happens to be live elsewhere on the
 *   server must never be treated as this run's live work merely because
 *   `liveSessionIds()` says it is live *somewhere*.
 *
 * Failure handling: a failed reconciliation call (either upstream call
 * rejecting or returning an error) marks every currently-outstanding ledger
 * entry `unknown` rather than leaving them untouched or settling them.
 * `unknown` blocks `isDrainComplete()` exactly as `outstanding` does — both
 * are required to be zero before either predicate returns `true` (see
 * `ownership-ledger.ts`), because an entry the harness cannot confirm might
 * still be a live writer. A failed call must never settle an entry it did not
 * actually observe finishing (that would wrongly unblock both drain and
 * persistence), so the only safe move is downgrading it to `unknown` and
 * leaving the caller's own deadline — not this predicate — to bound how long
 * an unresolvable status blocks the run. `unknown` is the fail-safe middle
 * state the ledger was designed for.
 * Settling FROM unknown is still allowed, and only ever happens on a later
 * pass where the session is confirmed both a child of this parent (via
 * `children()`) AND absent from `liveSessionIds()` — never as a timeout or a
 * default.
 *
 * Empty-ledger short circuit: when the ledger has no entries at all, this
 * module makes no remote calls. With adoption gone there is nothing an empty
 * ledger could learn from `children()`/`liveSessionIds()` — every branch
 * below only ever acts on entries already in the ledger. Skipping the pass
 * saves two upstream calls per Action run and two every
 * `DEFAULT_LEDGER_RECONCILE_INTERVAL_MS` per gateway run, for a call that
 * would otherwise be a guaranteed no-op.
 *
 * Known gap: a background dispatch whose *dispatch* event (not settlement
 * event) never reaches the ledger — dropped mid-stream, or during a
 * reconnect gap before the ledger ever learns the session id — is not
 * recovered by THIS module. Its two inputs cannot tell such a child from an
 * ordinary foreground subagent, so it is never adopted and never counted
 * toward drain. The run's own deadline bounds the consequence: an
 * unrecovered dispatch does not hang a run forever, it is silently excluded
 * from the drain wait. Background dispatch is now enabled, so this is live
 * exposure rather than a latent one.
 *
 * It is NOT, however, unrecoverable in principle, and an earlier version of
 * this comment said so wrongly. Verified against the pinned base version:
 * `tool/task.ts` records `{parentSessionId, sessionId, background: true}`
 * through `ctx.metadata()` BEFORE the background job starts, `session/tools.ts`
 * stores it at the tool part's `state.metadata`, and `core/session/projector.ts`
 * persists the whole part, stripping only ids. `GET /session/{id}/message`
 * returns it, and the SDK types declare `metadata` on both running and
 * completed tool states — so `part.tool === 'task' && part.state.metadata
 * .background === true` distinguishes a background dispatch from a foreground
 * delegation, which returns no `background` key at all.
 *
 * Recovering a dropped dispatch therefore means reading persisted task parts,
 * not waiting for upstream to add a session-record flag. Two things such a
 * reader must handle, neither of which this module does today: correlating by
 * `part.messageID` and tool start time so a resumed session's historical
 * dispatches are not adopted as this invocation's, and keeping observation
 * separate from execution — upstream's background-job registry is explicitly
 * process-local, so a restarted server can learn a dispatch existed while
 * being unable to recover its in-process status. Conflating those two is
 * most likely how the original "unrecoverable" claim arose.
 */

import type {Result} from '@bfra.me/es/result'
import type {SessionClient} from '../session/backend.js'
import type {Logger} from '../shared/logger.js'
import type {OwnershipLedger} from './ownership-ledger.js'

import {err, ok} from '@bfra.me/es/result'
import {toError} from '../shared/errors.js'

/** Bounded interval between reconciliation passes run only because the interval elapsed. */
export const DEFAULT_LEDGER_RECONCILE_INTERVAL_MS = 30_000

/** A child session returned by upstream's `children` lookup, used only to confirm tracked entries. */
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

/**
 * Run one reconciliation pass: settle tracked entries that are no longer
 * live, downgrade tracked entries this parent can no longer vouch for to
 * `unknown`, and — on failure — mark outstanding entries unknown. Never
 * adopts a session the ledger does not already track (see module doc).
 *
 * Idempotent: running this repeatedly against an unchanged upstream view makes
 * no further ledger changes (`settle` and `markUnknown` are themselves
 * idempotent).
 *
 * Makes no upstream calls when the ledger has no entries at all — see
 * "Empty-ledger short circuit" in the module doc.
 */
export async function reconcileLedgerOnce(options: ReconcileLedgerOptions): Promise<Result<void, Error>> {
  const {ledger, adapter, parentSessionId, logger} = options

  if (ledger.snapshot().length === 0) {
    return ok(undefined)
  }

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
  const childSessionIds = new Set(children.map(child => child.id))

  const settled: string[] = []
  const downgradedToUnknown: string[] = []
  for (const entry of ledger.snapshot()) {
    if (entry.state !== 'outstanding' && entry.state !== 'unknown') continue

    if (childSessionIds.has(entry.sessionId) === false) {
      // Not a child of this parent at all — this pass has no basis to claim the
      // entry, whether or not `liveSessionIds` happens to report it live under
      // some other tree. Downgrade to unknown rather than settle (no positive
      // observation of completion was made) or leave outstanding (that would
      // block drain forever on work that was never this parent's to begin with).
      ledger.markUnknown(entry.sessionId)
      downgradedToUnknown.push(entry.sessionId)
      continue
    }

    if (liveSessionIds.has(entry.sessionId) === true) continue
    ledger.settle(entry.sessionId)
    settled.push(entry.sessionId)
  }

  if (settled.length > 0 || downgradedToUnknown.length > 0) {
    logger.debug('Ledger reconciliation adjusted ownership', {
      source: 'reconcileLedgerOnce',
      parentSessionId,
      settled,
      downgradedToUnknown,
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
 * settlement event for a tracked entry, with no detected discontinuity, has
 * nothing else to trigger a re-check — belt-and-braces triggers (subscription,
 * discontinuity) do not cover a silent drop.
 *
 * Overlap guard: each tick is skipped while a previous pass is still in
 * flight. `reconcileLedgerOnce` makes up to two remote calls per pass (none
 * at all when the ledger is empty); if either slows past `intervalMs`,
 * letting a second pass start would stack concurrent calls against the same
 * upstream and ledger. A skipped tick is never lost work — the next tick (or
 * the very next `reconcileLedgerOnce` the pass finishes with) picks up the
 * current state, and the fixed-cadence interval (rather than
 * self-rescheduling after each pass) keeps the "one tick per `intervalMs`,
 * barring overlap" timing callers and tests already rely on.
 */
export function createLedgerReconciler(options: CreateLedgerReconcilerOptions): LedgerReconciler {
  const {intervalMs = DEFAULT_LEDGER_RECONCILE_INTERVAL_MS, ...reconcileOptions} = options

  let disposed = false
  let inFlight = false
  const handle = setInterval(() => {
    if (disposed) return
    if (inFlight) return // a previous pass is still running — skip this tick rather than stack.
    inFlight = true
    reconcileLedgerOnce(reconcileOptions)
      .catch(() => {
        // reconcileLedgerOnce never rejects (all upstream failures are captured as `err`
        // results and logged internally); this catch exists only to satisfy no-floating-promises.
      })
      .finally(() => {
        inFlight = false
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
