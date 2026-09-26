/**
 * Unit 3: the two-process binary pack stream.
 *
 * Contract owner for `pack-objects --stdout | index-pack --stdin --strict` — the mechanism that
 * moves objects from the root-owned protected bare repo into an agent-owned checkout without ever
 * running a local fetch (which takes a URL a rewrite can redirect) or exposing the checkout to
 * alternates (which would tie it to the protected store). See the plan's "Objects cross as a pack
 * stream, never by local fetch or alternates" key technical decision.
 */

import type {Buffer} from 'node:buffer'
import type {ChildProcess} from 'node:child_process'
import type {Readable} from 'node:stream'

import {spawn} from 'node:child_process'
import process from 'node:process'

import {GIT_KILL_REAP_GRACE_MS} from './git-safety.js'

/** Bound on waiting for a confirmed close after a signal or clean exit; shared with `runGit`. */
const KILL_REAP_GRACE_MS = GIT_KILL_REAP_GRACE_MS

/**
 * Bound on how much of each side's stderr (and the reader's stdout, which callers never need) we
 * retain in memory. `PackStreamOutcome` has no field to carry this — the union does not have room
 * for it — so it is captured only long enough to keep the underlying OS pipe draining (a child
 * that fills its stdout/stderr pipe buffer would otherwise block on write() forever) and is
 * discarded once read. Nothing beyond this bound is ever retained, so this can never grow
 * unbounded regardless of how verbose a process is.
 */
const DISCARDED_STREAM_CAPTURE_LIMIT_BYTES = 4_096

/** One half of the pack-stream pipe: the exact subprocess to spawn, its cwd/env, and the identity to run it as. */
export interface GitStreamProcessSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly uid?: number
  readonly gid?: number
}

/**
 * The producer half of the pipe, with an optional payload for its OWN stdin — distinct from the
 * writer→reader pipe wired between the two specs. `git pack-objects --revs` always reads its
 * revision arguments from stdin (there is no argv-based mode), so a real caller must be able to
 * hand the writer input independent of the byte stream `runPackStream` forwards to the reader.
 */
export interface PackStreamWriterSpec extends GitStreamProcessSpec {
  /**
   * Written to the writer's stdin in full, then the writer's stdin is closed (EOF), before the
   * writer→reader byte pump begins consuming the writer's stdout. Omit for a writer that needs no
   * input on its own stdin — stdin then closes immediately with zero bytes, exactly as it did
   * before this field existed.
   */
  readonly stdin?: string | Uint8Array
}

export interface PackStreamOptions {
  /** The producer, normally `git pack-objects --stdout` against the bare repo, run as root. */
  readonly writer: PackStreamWriterSpec
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
   * A process's exit was never CONFIRMED by its stdio actually closing (the `'close'` event),
   * within the reap grace window — mirrors `GitOutcome`'s `termination-unconfirmed` in
   * git-safety.ts, which gets the same guarantee through `execFile`'s callback (fired only once
   * the child's stdio streams have closed, never merely on process exit). The canonical cause is
   * a grandchild that inherited a duplicate of a stdio pipe's file descriptor and escaped the
   * spawned process group (e.g. via a detached grandchild): the direct child may exit and even be
   * reaped, but as long as the grandchild still holds the pipe open, the corresponding stream
   * never sees EOF and `'close'` never fires. This can surface even on an otherwise clean run —
   * a writer or reader that exits 0 but whose `'close'` never follows within the grace window is
   * ALSO reported here, never as `ok`. A caller must treat this as "the mutex must stay held",
   * never as an ordinary timeout.
   */
  | {readonly kind: 'termination-unconfirmed'}

/** Internal reason the pipe is settling: every `PackStreamFailureReason`, plus markers for the two non-failure paths. */
type SettlementTrigger = PackStreamFailureReason | 'ok' | 'timeout'

/** Sends `signal` to the process GROUP led by `child` (negative pid), never just the process itself, so any ordinary (non-setsid) descendants die too. Swallows ESRCH: the group may already be gone. */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    // Already gone (ESRCH) or otherwise unsignalable — nothing left to terminate.
  }
}

/** Resolves `true` once `isClosed` reports true (checked immediately, then again on the child's `'close'` event), or `false` if `timeoutMs` elapses first. */
async function waitForClose(child: ChildProcess, isClosed: () => boolean, timeoutMs: number): Promise<boolean> {
  if (isClosed()) return true
  return new Promise(resolve => {
    let done = false
    let timer: ReturnType<typeof setTimeout>
    const onClose = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(true)
    }
    timer = setTimeout(() => {
      if (done) return
      done = true
      child.off('close', onClose)
      resolve(false)
    }, timeoutMs)
    child.once('close', onClose)
  })
}

/**
 * Ensures `child` is CONFIRMED closed — its `'close'` event has fired, meaning both the process
 * exited and its stdio streams actually finished closing (mirrors `runGit`'s `execFile`-callback
 * confirmation, never the bare `'exit'` event). If `child` hasn't exited yet, sends SIGTERM to its
 * process group and waits `KILL_REAP_GRACE_MS` for `'close'`; if still not closed, escalates to
 * SIGKILL and waits the same grace again. Signaling an already-exited child is a harmless no-op
 * (ESRCH, swallowed) — this is exactly what happens for the canonical "grandchild holds a stdio
 * pipe open" case: the direct child is already gone, no signal can reach the escaped grandchild
 * holding the pipe, and `'close'` simply never arrives within the grace window. Returns `false` in
 * that case (and only that case) — never resolves `true` on a bare exit without a confirmed close.
 */
async function ensureConfirmedClose(child: ChildProcess, isClosed: () => boolean): Promise<boolean> {
  if (isClosed() || child.pid === undefined) return true
  killProcessGroup(child, 'SIGTERM')
  if (await waitForClose(child, isClosed, KILL_REAP_GRACE_MS)) return true
  killProcessGroup(child, 'SIGKILL')
  return waitForClose(child, isClosed, KILL_REAP_GRACE_MS)
}

/**
 * Drains `stream` to completion so a child writing to it can never block on a full OS pipe
 * buffer. Nothing is retained past `DISCARDED_STREAM_CAPTURE_LIMIT_BYTES` — `PackStreamOutcome`
 * has no field to carry stderr/extra stdout, so there is no destination for a captured value;
 * retaining zero bytes trivially satisfies "never let it grow unbounded". No-op for a `null`
 * stream (e.g. when `stdio` didn't request a pipe).
 */
function drainAndDiscard(stream: Readable | null): void {
  if (stream === null) return
  let capturedBytes = 0
  stream.on('data', (chunk: Buffer) => {
    capturedBytes = Math.min(capturedBytes + chunk.length, DISCARDED_STREAM_CAPTURE_LIMIT_BYTES)
  })
  stream.on('error', () => {
    // A capture-only stream erroring (e.g. EPIPE after the child is killed) is not actionable.
  })
}

/**
 * Contract: spawns `writer` and `reader`, each in its own process group, and pipes `writer`'s
 * stdout directly to `reader`'s stdin as raw bytes with backpressure (never buffering the whole
 * pack in memory). If `writer.stdin` is given, it is written to the writer's own stdin (then
 * closed) before the writer→reader pump begins — this is separate from the writer→reader pipe.
 *
 * Required behaviour:
 * - Total bytes piped is bounded by `maxBytes`; exceeding it fails closed as
 *   `byte-cap-exceeded` (detected mid-stream, not only after the fact) and terminates BOTH
 *   processes before resolving.
 * - Total elapsed time is bounded by `timeoutMs`. On expiry, both processes are sent SIGTERM
 *   first; any process still alive after a short grace period is escalated to SIGKILL. The
 *   outcome resolves `timeout` only once CONFIRMED CLOSE (stdio actually closed, not merely
 *   process exit) of BOTH is observed within the grace window — otherwise it resolves
 *   `termination-unconfirmed` (see that variant's doc for the canonical cause).
 * - If either process exits non-zero, or exits before its counterpart has finished, the other is
 *   sent the same SIGTERM-then-SIGKILL sequence, and the outcome reports `failed` with BOTH
 *   sides' `PackStreamProcessResult` — `reason` names whichever side triggered the abort
 *   (`writer-failed` or `reader-failed`), and the OTHER side's result shows whether it exited on
 *   its own or had to be terminated (and by which signal).
 * - A zero-byte stream (nothing written before both processes exit 0) is a valid `ok` outcome
 *   with `bytesTransferred: 0` — but ONLY once both sides' `'close'` is also confirmed; a clean
 *   exit whose `'close'` never follows within the grace window resolves `termination-unconfirmed`
 *   instead, never `ok`.
 */
export async function runPackStream(options: PackStreamOptions): Promise<PackStreamOutcome> {
  return new Promise<PackStreamOutcome>(resolve => {
    let settled = false
    let settling: SettlementTrigger | null = null
    let bytesTransferred = 0
    let writerExit: PackStreamProcessResult | undefined
    let readerExit: PackStreamProcessResult | undefined
    let writerClose: PackStreamProcessResult | undefined
    let readerClose: PackStreamProcessResult | undefined
    let overallTimer: ReturnType<typeof setTimeout> | undefined

    const settle = (outcome: PackStreamOutcome): void => {
      if (settled) return
      settled = true
      if (overallTimer !== undefined) clearTimeout(overallTimer)
      resolve(outcome)
    }

    const resultFor = (result: PackStreamProcessResult | undefined): PackStreamProcessResult =>
      result ?? {exitCode: null, signal: null}

    let writer: ChildProcess
    let reader: ChildProcess
    try {
      writer = spawn(options.writer.command, [...options.writer.args], {
        cwd: options.writer.cwd,
        env: options.writer.env,
        uid: options.writer.uid,
        gid: options.writer.gid,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      reader = spawn(options.reader.command, [...options.reader.args], {
        cwd: options.reader.cwd,
        env: options.reader.env,
        uid: options.reader.uid,
        gid: options.reader.gid,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      // A synchronous throw from spawn() itself (rare — most spawn failures surface as an async
      // 'error' event instead): neither side is running, so nothing to terminate.
      resolve({
        kind: 'failed',
        reason: 'spawn-failed',
        writer: {exitCode: null, signal: null},
        reader: {exitCode: null, signal: null},
      })
      return
    }

    // The writer's own stdin is independent of the writer→reader pipe (that pipe is wired below,
    // writer.stdout -> reader.stdin). `.end(undefined)` closes it immediately with zero bytes,
    // matching the pre-`stdin`-field behaviour exactly.
    writer.stdin?.end(options.writer.stdin)

    const runSettlement = async (trigger: SettlementTrigger): Promise<void> => {
      const [writerConfirmed, readerConfirmed] = await Promise.all([
        ensureConfirmedClose(writer, () => writerClose !== undefined),
        ensureConfirmedClose(reader, () => readerClose !== undefined),
      ])
      if (!writerConfirmed || !readerConfirmed) {
        settle({kind: 'termination-unconfirmed'})
        return
      }
      if (trigger === 'ok') {
        settle({kind: 'ok', bytesTransferred})
        return
      }
      if (trigger === 'timeout') {
        settle({kind: 'timeout'})
        return
      }
      settle({kind: 'failed', reason: trigger, writer: resultFor(writerExit), reader: resultFor(readerExit)})
    }

    const beginSettlement = (trigger: SettlementTrigger): void => {
      if (settled || settling !== null) return
      settling = trigger
      writer.stdout?.pause()
      runSettlement(trigger).catch(() => {
        // ensureConfirmedClose/settle never throw; this exists only to satisfy no-floating-promises.
      })
    }

    const checkCleanCompletion = (): void => {
      if (settled || settling !== null) return
      if (writerExit?.exitCode === 0 && readerExit?.exitCode === 0) {
        beginSettlement('ok')
      }
    }

    writer.on('error', () => {
      beginSettlement('spawn-failed')
    })
    reader.on('error', () => {
      beginSettlement('spawn-failed')
    })

    writer.on('exit', (code, signal) => {
      writerExit = {exitCode: code, signal}
      if (settled || settling !== null) return
      if (code !== 0) {
        beginSettlement('writer-failed')
        return
      }
      checkCleanCompletion()
    })

    reader.on('exit', (code, signal) => {
      readerExit = {exitCode: code, signal}
      if (settled || settling !== null) return
      if (code !== 0) {
        beginSettlement('reader-failed')
        return
      }
      checkCleanCompletion()
    })

    writer.on('close', (code, signal) => {
      writerClose = {exitCode: code, signal}
    })
    reader.on('close', (code, signal) => {
      readerClose = {exitCode: code, signal}
    })

    drainAndDiscard(writer.stderr)
    drainAndDiscard(reader.stderr)
    drainAndDiscard(reader.stdout)
    writer.stdout?.on('error', () => {
      // A read error on an already-terminated writer is not actionable beyond what exit/abort handling already does.
    })
    reader.stdin?.on('error', () => {
      // EPIPE from a reader that exited early is expected once we stop forwarding — not actionable beyond abort handling.
    })

    writer.stdout?.on('data', (chunk: Buffer) => {
      if (settled || settling !== null) return
      bytesTransferred += chunk.length
      if (bytesTransferred > options.maxBytes) {
        beginSettlement('byte-cap-exceeded')
        return
      }
      const canContinue = reader.stdin?.write(chunk) ?? false
      if (!canContinue) {
        writer.stdout?.pause()
      }
    })
    reader.stdin?.on('drain', () => {
      if (!settled && settling === null) writer.stdout?.resume()
    })
    writer.stdout?.on('end', () => {
      if (!settled && settling === null) reader.stdin?.end()
    })

    overallTimer = setTimeout(() => {
      beginSettlement('timeout')
    }, options.timeoutMs)
  })
}
