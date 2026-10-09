/**
 * In-memory ownership ledger for background subagent executions.
 *
 * Tracks the executions an invocation owns, keyed by CHILD SESSION IDENTIFIER
 * rather than job identifier. Upstream reuses job ids across dispatches (e.g.
 * when a job is extended), so a ledger keyed on job id would let a delayed
 * notification for a stale job settle a newer execution that happens to share
 * the id. The session id is stable for the lifetime of the execution it names.
 *
 * Three entry states:
 * - `outstanding` — adopted, not yet known to be finished.
 * - `settled`     — confirmed finished (terminal; further settles are no-ops).
 * - `unknown`     — cannot confirm what happened (e.g. a dropped event or a
 *   failed reconciliation call). `unknown` is never collapsed into `settled`
 *   and never treated as zero: not knowing whether a child is alive is a
 *   reason to keep waiting, not a reason to proceed. Every caller that gates
 *   on this ledger — drain completion as much as persistence — requires both
 *   `outstanding() === 0` AND `unknown() === 0`. The deadline a caller applies
 *   on top of that wait, not this ledger, is what prevents an unresolvable
 *   `unknown` entry from wedging a run forever.
 *
 * In-memory state is intentional — this ledger does not survive a process
 * restart. Reconciliation against upstream (a later unit) is how a ledger
 * recovers from events it never saw.
 */

/** The three states an ownership entry can be in. */
export type OwnershipEntryState = 'outstanding' | 'settled' | 'unknown'

/** A single tracked execution, identified by its child session id. */
export interface OwnershipLedgerEntry {
  /** The child session identifier this entry tracks. */
  readonly sessionId: string
  /** Stable, caller-supplied label identifying the work (for later reporting by label, not count). */
  readonly label: string
  /** The entry's current state. */
  readonly state: OwnershipEntryState
}

export interface OwnershipLedger {
  /**
   * Record that this invocation owns the execution running under `sessionId`.
   *
   * Idempotent: adopting the same `sessionId` more than once counts as a
   * single entry and does not overwrite an entry already in progress or
   * resolved. Upstream can notify once for several dispatches against the
   * same session (e.g. an extension), so a second `adopt` call must not
   * double-count or reset an entry's state.
   */
  readonly adopt: (sessionId: string, label: string) => void
  /**
   * Mark the entry for `sessionId` as settled (confirmed finished).
   *
   * A no-op, not an error, when the entry was never adopted, or when it is
   * already settled — a settlement notification can arrive for an entry a
   * reconciliation pass already resolved.
   */
  readonly settle: (sessionId: string) => void
  /**
   * Mark the entry for `sessionId` as unknown — reachable only from
   * `outstanding`. A no-op when the entry was never adopted or is already
   * settled (settled is terminal); marking an already-unknown entry again is
   * a safe no-op.
   */
  readonly markUnknown: (sessionId: string) => void
  /** Count of entries currently `outstanding`. Zero means nothing left to drain. */
  readonly outstanding: () => number
  /** Count of entries currently `unknown`. Zero means nothing unconfirmed remains. */
  readonly unknown: () => number
  /**
   * `true` only when nothing is outstanding AND nothing is unknown — the
   * question a caller finishing a drain asks. An unknown entry might still be
   * a live writer, so a caller cannot treat "we lost track of it" as "it must
   * be done" — that is precisely the gap that let a run finish while a
   * background writer was still live. This predicate does NOT bound how long
   * a caller waits: an unresolvable `unknown` entry (e.g. every reconciliation
   * attempt failing) makes it never return `true`. Bounding the wait is the
   * caller's deadline's job, not this predicate's — see `runDrain` /
   * `run-core`'s drain-deadline cancellation, which terminate and report
   * incomplete instead of waiting on this forever.
   *
   * Currently identical to `isPersistenceSafe` (see its comment for why both
   * names still exist).
   */
  readonly isDrainComplete: () => boolean
  /**
   * `true` only when nothing is outstanding AND nothing is unknown — the
   * question a caller about to persist state asks. An unknown entry might
   * still be a live writer, so persistence must treat "unconfirmed" the same
   * as "still running".
   *
   * Currently identical to `isDrainComplete`: both ask "is it safe to treat
   * this ledger as empty", just at different moments (stop waiting vs. write
   * to disk). Kept as two named entry points rather than collapsed into one,
   * because callers read very differently at each call site (a drain loop
   * asking "can I stop waiting" vs. a cache-save gate asking "can I write") and
   * that self-documentation is worth the duplication. Do not assume they stay
   * identical forever — if drain semantics or persistence semantics need to
   * diverge again (e.g. a future grace policy that lets drain proceed on a
   * bounded number of stale-but-probably-dead unknowns while persistence still
   * refuses), change this comment and the implementation deliberately, not by
   * accident.
   */
  readonly isPersistenceSafe: () => boolean
  /** Snapshot of every tracked entry (including settled ones), for callers that report by label. */
  readonly snapshot: () => readonly OwnershipLedgerEntry[]
  /**
   * `true` when `sessionId` is tracked by this ledger, in ANY state --
   * outstanding, unknown, or settled. This is deliberately NOT "still
   * outstanding": the hot-path question a per-event ownership check asks is
   * "does this run's tree own this session at all", not "is it still live".
   * A settled descendant can still emit a trailing event (e.g. a final
   * message chunk that raced its own completion signal), and that event
   * belongs to this run just as much as one from an outstanding descendant --
   * dropping it as foreign would be wrong. Backed directly by the internal
   * `Map`, so this is an O(1) lookup with no allocation, unlike filtering
   * `snapshot()`.
   */
  readonly isTracked: (sessionId: string) => boolean
}

/** Create a new, empty ownership ledger. */
export function createOwnershipLedger(): OwnershipLedger {
  const entries = new Map<string, {label: string; state: OwnershipEntryState}>()

  function countByState(state: OwnershipEntryState): number {
    let count = 0
    for (const entry of entries.values()) {
      if (entry.state === state) count++
    }
    return count
  }

  // Shared by isDrainComplete/isPersistenceSafe so the two names can never
  // silently drift apart from one another -- a deliberate divergence must
  // touch this function, not just one of its two callers.
  function noOutstandingOrUnknown(): boolean {
    return countByState('outstanding') === 0 && countByState('unknown') === 0
  }

  return {
    adopt: (sessionId: string, label: string): void => {
      if (entries.has(sessionId) === true) return
      entries.set(sessionId, {label, state: 'outstanding'})
    },

    settle: (sessionId: string): void => {
      const entry = entries.get(sessionId)
      if (entry === undefined) return
      if (entry.state === 'settled') return
      entries.set(sessionId, {label: entry.label, state: 'settled'})
    },

    markUnknown: (sessionId: string): void => {
      const entry = entries.get(sessionId)
      if (entry === undefined) return
      if (entry.state !== 'outstanding') return
      entries.set(sessionId, {label: entry.label, state: 'unknown'})
    },

    outstanding: (): number => countByState('outstanding'),

    unknown: (): number => countByState('unknown'),

    isDrainComplete: (): boolean => noOutstandingOrUnknown(),

    isPersistenceSafe: (): boolean => noOutstandingOrUnknown(),

    snapshot: (): readonly OwnershipLedgerEntry[] =>
      Array.from(entries.entries()).map(([sessionId, entry]) => ({
        sessionId,
        label: entry.label,
        state: entry.state,
      })),

    isTracked: (sessionId: string): boolean => entries.has(sessionId),
  }
}
