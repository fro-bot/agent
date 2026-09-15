/**
 * Bounded admission for background subagent dispatch.
 *
 * Admission decides whether a dispatch may proceed BEFORE its execution
 * starts. Enforcing after the fact would mean observing an overage that has
 * already begun writing, which is what this module exists to prevent.
 *
 * Three caps:
 * - Outstanding — how many dispatches may be live at once. Read from the
 *   ownership ledger (`OwnershipLedger.outstanding()`), since that genuinely
 *   is the live-entry count.
 * - Total — how many dispatches an invocation may start overall, across its
 *   whole lifetime. This CANNOT be derived from the ledger: `adopt` is
 *   idempotent per session id, so an extension (a new submission against an
 *   existing execution) never creates a new ledger entry, and a promotion
 *   converts foreground work the caps never saw before it is adopted. Both
 *   still consume a start. So this module keeps its own monotonic counter,
 *   incremented on every ADMITTED dispatch regardless of what happens to the
 *   ledger.
 * - Depth — fixed at 1, deliberately not configurable (not in
 *   `shared/constants.ts` with the other two). A depth knob would reopen a
 *   grandchild traversal gap the rest of this plan assumes stays shut:
 *   upstream cancellation walks running jobs only, so a completed child
 *   linking the root to a running grandchild is never reached.
 *
 * Once an invocation enters finalization or cancellation, admission refuses
 * everything: work started then could not be drained before the terminal
 * steps run.
 *
 * A refusal returns a structured error naming which cap was exceeded, so a
 * caller can surface the reason to the model instead of failing silently.
 */

import type {Result} from '../shared/types.js'
import type {OwnershipLedger} from './ownership-ledger.js'

import {DEFAULT_MAX_OUTSTANDING_DISPATCHES, DEFAULT_MAX_TOTAL_DISPATCHES} from '../shared/constants.js'
import {err, ok} from '../shared/types.js'

/** Depth is fixed, not configurable — see module docs above. */
const MAX_DISPATCH_DEPTH = 1

/**
 * How a dispatch relates to the ledger:
 * - `new`       — a fresh execution with no existing ledger entry.
 * - `extension` — a new submission against an execution the ledger already
 *   tracks (same child session id). Does not add a new live entry, so it is
 *   exempt from the outstanding check, but it still consumes a total slot.
 * - `promotion` — foreground work converting to a tracked background
 *   execution. The caps never saw it before now, so it is treated like a new
 *   dispatch for both the outstanding and total checks.
 */
export type DispatchKind = 'new' | 'extension' | 'promotion'

/** Why admission was refused. */
export type DispatchRefusalReason =
  'depth-exceeded' | 'outstanding-cap-exceeded' | 'total-cap-exceeded' | 'terminal-phase'

/** The invocation-level phase that closes admission entirely once entered. */
export type DispatchTerminalPhase = 'cancellation' | 'finalization'

/** A dispatch admission request. */
export interface DispatchRequest {
  /** The child session identifier the dispatch would run under. */
  readonly sessionId: string
  /** Caller-supplied label, forwarded to the ledger on adoption (not used by admission itself). */
  readonly label: string
  /** How this dispatch relates to the ledger — see `DispatchKind`. */
  readonly kind: DispatchKind
  /** Depth of the resulting execution relative to the root (a direct child is 1). */
  readonly depth: number
}

/** Structured refusal naming which cap was exceeded. */
export interface DispatchRefusal {
  /** Which cap (or phase) caused the refusal. */
  readonly reason: DispatchRefusalReason
  /** The configured limit that was exceeded (or 0 for `terminal-phase`, which has no numeric limit). */
  readonly limit: number
  /** The value that exceeded (or would have exceeded) the limit. */
  readonly actual: number
  /** Human-readable summary, safe to surface to the model. */
  readonly message: string
}

export interface DispatchAdmissionOptions {
  /** Maximum outstanding (live) dispatches. Defaults to `DEFAULT_MAX_OUTSTANDING_DISPATCHES`. */
  readonly maxOutstanding?: number
  /** Maximum total dispatches for the invocation's lifetime. Defaults to `DEFAULT_MAX_TOTAL_DISPATCHES`. */
  readonly maxTotal?: number
}

export interface DispatchAdmission {
  /**
   * Decide whether `request` may proceed. Returns `ok(undefined)` and
   * increments the internal total counter on admission; returns
   * `err(DispatchRefusal)` and leaves all state — including the ledger —
   * unchanged on refusal.
   */
  readonly tryAdmit: (request: DispatchRequest) => Result<void, DispatchRefusal>
  /**
   * Enter a terminal phase. Irreversible: once called, every subsequent
   * `tryAdmit` call is refused, regardless of `phase`'s value — cancellation
   * and finalization both mean "no further dispatch."
   */
  readonly enterTerminalPhase: (phase: DispatchTerminalPhase) => void
  /** Total dispatches admitted so far (informational). */
  readonly totalDispatched: () => number
}

/** Create a dispatch admission gate backed by `ledger`. */
export function createDispatchAdmission(
  ledger: OwnershipLedger,
  options: DispatchAdmissionOptions = {},
): DispatchAdmission {
  const maxOutstanding = options.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING_DISPATCHES
  const maxTotal = options.maxTotal ?? DEFAULT_MAX_TOTAL_DISPATCHES

  let totalDispatched = 0
  let terminalPhase: DispatchTerminalPhase | undefined

  return {
    tryAdmit: (request: DispatchRequest): Result<void, DispatchRefusal> => {
      if (terminalPhase !== undefined) {
        return err({
          reason: 'terminal-phase',
          limit: 0,
          actual: 0,
          message: `dispatch refused: invocation has entered ${terminalPhase}`,
        })
      }

      if (request.depth > MAX_DISPATCH_DEPTH) {
        return err({
          reason: 'depth-exceeded',
          limit: MAX_DISPATCH_DEPTH,
          actual: request.depth,
          message: `dispatch refused: depth ${String(request.depth)} exceeds the fixed limit of ${String(MAX_DISPATCH_DEPTH)}`,
        })
      }

      if (request.kind !== 'extension') {
        const outstanding = ledger.outstanding()
        if (outstanding >= maxOutstanding) {
          return err({
            reason: 'outstanding-cap-exceeded',
            limit: maxOutstanding,
            actual: outstanding,
            message: `dispatch refused: outstanding dispatches (${String(outstanding)}) already at the limit of ${String(maxOutstanding)}`,
          })
        }
      }

      if (totalDispatched >= maxTotal) {
        return err({
          reason: 'total-cap-exceeded',
          limit: maxTotal,
          actual: totalDispatched,
          message: `dispatch refused: total dispatches (${String(totalDispatched)}) already at the limit of ${String(maxTotal)}`,
        })
      }

      totalDispatched++
      return ok(undefined)
    },

    enterTerminalPhase: (phase: DispatchTerminalPhase): void => {
      terminalPhase = phase
    },

    totalDispatched: (): number => totalDispatched,
  }
}
