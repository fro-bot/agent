/**
 * Output frame contract for the operator run-stream.
 *
 * Carries the agent's visible output text to an operator subscribed to a run's
 * SSE stream. Two frame modes:
 *
 * - **Delta frame** (`final: false`): appended live as the agent produces output.
 *   Clients accumulate these to build the in-progress answer.
 * - **Terminal frame** (`final: true`): replaces the accumulated live text with
 *   the authoritative complete answer. Guaranteed to arrive before the terminal
 *   status frame. A run with no output still produces a terminal frame (empty
 *   `text`) so the client can distinguish "no output" from "missing output".
 *
 * `seq` is monotonic per run (starts at 0, increments by 1 per frame). Clients
 * can detect gaps caused by coalescing via `droppedCount`.
 *
 * `droppedCount` (when present) tells the client how many prior delta frames
 * were coalesced or elided under per-subscriber backpressure. The terminal frame
 * always carries the complete answer regardless of how many deltas were dropped.
 */

// ---------------------------------------------------------------------------
// OperatorOutputFrame — operator-facing output frame
// ---------------------------------------------------------------------------

/**
 * An output frame delivered over the operator run-stream.
 *
 * Delta frames (`final: false`) append live output; the terminal frame
 * (`final: true`) replaces with the authoritative complete answer.
 * `seq` is monotonic per run; `droppedCount` (when present) indicates
 * how many prior deltas were coalesced/elided under backpressure.
 */
export interface OperatorOutputFrame {
  readonly runId: string
  readonly text: string
  readonly final: boolean
  readonly seq: number
  readonly droppedCount?: number
}
