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
 *   and never treated as zero: a caller finishing a drain only needs
 *   `outstanding() === 0`, but a caller about to persist state must also see
 *   `unknown() === 0`, because an unknown entry might be a live writer.
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
   * `true` once nothing is outstanding — the question a caller finishing a
   * drain asks. Unlike `isPersistenceSafe`, this ignores `unknown` entries:
   * a caller only cares that no more work is expected to arrive.
   */
  readonly isDrainComplete: () => boolean
  /**
   * `true` only when nothing is outstanding AND nothing is unknown — the
   * question a caller about to persist state asks. An unknown entry might
   * still be a live writer, so persistence must treat "unconfirmed" the same
   * as "still running".
   */
  readonly isPersistenceSafe: () => boolean
  /** Snapshot of every tracked entry (including settled ones), for callers that report by label. */
  readonly snapshot: () => readonly OwnershipLedgerEntry[]
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

    isDrainComplete: (): boolean => countByState('outstanding') === 0,

    isPersistenceSafe: (): boolean => countByState('outstanding') === 0 && countByState('unknown') === 0,

    snapshot: (): readonly OwnershipLedgerEntry[] =>
      Array.from(entries.entries()).map(([sessionId, entry]) => ({
        sessionId,
        label: entry.label,
        state: entry.state,
      })),
  }
}
