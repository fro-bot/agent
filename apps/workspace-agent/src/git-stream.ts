/**
 * Unit 3 (not implemented yet): the two-process binary pack stream.
 *
 * Contract owner for `pack-objects --stdout | index-pack --stdin --strict` — the mechanism that
 * moves objects from the root-owned protected bare repo into an agent-owned checkout without ever
 * running a local fetch (which takes a URL a rewrite can redirect) or exposing the checkout to
 * alternates (which would tie it to the protected store). See the plan's "Objects cross as a pack
 * stream, never by local fetch or alternates" key technical decision.
 *
 * This module is a STUB: every exported function has a typed signature and a JSDoc contract, but
 * its body throws. The adversarial fixture suite
 * (apps/workspace-agent/src/update-fixtures/pack.test.ts) is written against this contract and is
 * expected to fail red until Unit 3 implements it.
 */

/** One half of the pack-stream pipe: the exact subprocess to spawn, its cwd/env, and the identity to run it as. */
export interface GitStreamProcessSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly uid?: number
  readonly gid?: number
}

export interface PackStreamOptions {
  /** The producer, normally `git pack-objects --stdout` against the bare repo, run as root. */
  readonly writer: GitStreamProcessSpec
  /** The consumer, normally `git index-pack --stdin --strict` in the checkout, run as AGENT_UID. */
  readonly reader: GitStreamProcessSpec
  /** Hard cap on total bytes piped from writer stdout to reader stdin. */
  readonly maxBytes: number
  /** Hard cap on total elapsed time for the pair, including confirmed termination. */
  readonly timeoutMs: number
}

export type PackStreamFailureReason = 'writer-failed' | 'reader-failed' | 'byte-cap-exceeded' | 'spawn-failed'

/**
 * How one side of the pipe (writer or reader) ended, with enough fidelity to distinguish "exited
 * on its own" (`signal: null`) from "was terminated by us" (`signal` set) — the audited contract
 * tests assert on this distinction directly (e.g. a reader that traps SIGTERM must show a
 * `SIGKILL` escalation, not a bare null exit code that could mean anything).
 */
export interface PackStreamProcessResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

export type PackStreamOutcome =
  | {readonly kind: 'ok'; readonly bytesTransferred: number}
  | {
      readonly kind: 'failed'
      readonly reason: PackStreamFailureReason
      readonly writer: PackStreamProcessResult
      readonly reader: PackStreamProcessResult
    }
  /** Both processes were confirmed terminated (reaped) after `timeoutMs` elapsed. */
  | {readonly kind: 'timeout'}
  /**
   * Termination was attempted (SIGTERM, then SIGKILL after a grace period) but never CONFIRMED
   * within the reap grace window — mirrors `GitOutcome`'s `termination-unconfirmed` in
   * git-safety.ts. The canonical cause is a grandchild that inherited a duplicate of the pipe's
   * file descriptor and escaped the spawned process group (e.g. via a detached grandchild), so
   * the pipe never fully closes even though the directly-spawned writer/reader were themselves
   * reaped. A caller must treat this as "the mutex must stay held", never as an ordinary timeout.
   */
  | {readonly kind: 'termination-unconfirmed'}

/**
 * Contract (Unit 3 — not implemented here): spawns `writer` and `reader`, each in its own process
 * group, and pipes `writer`'s stdout directly to `reader`'s stdin as raw bytes with backpressure
 * (never buffering the whole pack in memory).
 *
 * Required behaviour:
 * - Total bytes piped is bounded by `maxBytes`; exceeding it fails closed as
 *   `byte-cap-exceeded` (detected mid-stream, not only after the fact) and terminates BOTH
 *   processes before resolving.
 * - Total elapsed time is bounded by `timeoutMs`. On expiry, both processes are sent SIGTERM
 *   first; any process still alive after a short grace period is escalated to SIGKILL. The
 *   outcome resolves `timeout` only once termination of BOTH is CONFIRMED (reaped) — never
 *   resolves `timeout` for an unconfirmed kill; that case resolves `termination-unconfirmed`
 *   instead (see that variant's doc for the canonical cause).
 * - If either process exits non-zero, or exits before its counterpart has finished, the other is
 *   sent the same SIGTERM-then-SIGKILL sequence, and the outcome reports `failed` with BOTH
 *   sides' `PackStreamProcessResult` — `reason` names whichever side triggered the abort
 *   (`writer-failed` or `reader-failed`), and the OTHER side's result shows whether it exited on
 *   its own or had to be terminated (and by which signal).
 * - A zero-byte stream (nothing written before both processes exit 0) is a valid `ok` outcome
 *   with `bytesTransferred: 0`.
 */
export async function runPackStream(_options: PackStreamOptions): Promise<PackStreamOutcome> {
  throw new Error('not implemented: Unit 3')
}
