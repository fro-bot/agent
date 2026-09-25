/**
 * Shared git invocation-safety primitives for running git against an EXISTING checkout as the
 * unprivileged AGENT_UID/AGENT_GID identity — never as the root-owned service, and never with
 * credentials.
 *
 * Originally lived only in inspect.ts (the read-only `/inspect` handler). clone.ts's
 * `repo-exists` idempotency check and its post-rename race-check validation both run git
 * against a checkout the AGENT_UID identity already owns (or is about to), so they reuse the
 * exact same neutralized invocation shape rather than a hand-duplicated approximation of it —
 * see clone.ts for how it's wired through the shared `runGit` runner (inspect.ts).
 */

import {execFile} from 'node:child_process'
import process from 'node:process'

import {AGENT_HOME} from './identity.js'

/**
 * Bound on waiting for a confirmed reap after SIGKILL. Mirrors the reap-grace pattern used
 * elsewhere in this repo (src/services/setup/adapters.ts) for confirmed-termination semantics.
 */
const GIT_KILL_REAP_GRACE_MS = 2_000

/**
 * Bound on buffered stdout/stderr per git invocation. `execFile` buffers both streams in
 * memory and enforces this ceiling itself (Node's default is 1 MiB, too small for `git status
 * --porcelain=v2` on a large dirty tree — a single renamed/untracked file is a full porcelain
 * line, so tens of thousands of changed files can run into several MB of output). 64 MiB
 * comfortably covers even a six-figure changed-file count while still bounding memory use per
 * invocation.
 */
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024

// ---------------------------------------------------------------------------
// Git subprocess runner — confirmed-termination timeout, no credential env. Originally lived
// only in inspect.ts; clone.ts's repo-exists and post-rename race-check validation reuse it
// (via the injectable `gitRunner` dep, default `runGit` below) rather than duplicating a second
// spawn-and-confirm-kill implementation.
// ---------------------------------------------------------------------------

export interface GitRunnerOptions {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeoutMs: number
  /** Unprivileged uid to run git as. Defaults applied by callers from identity.ts (AGENT_UID). */
  readonly uid?: number
  /** Unprivileged gid to run git as. Defaults applied by callers from identity.ts (AGENT_GID). */
  readonly gid?: number
  /**
   * Optional external trigger for the exact same confirmed-termination path as `timeoutMs`
   * (SIGKILL, then the same reap-grace race between `timeout` and `termination-unconfirmed`) —
   * an already-aborted signal terminates immediately, without waiting for `timeoutMs`.
   */
  readonly signal?: AbortSignal
}

export type GitOutcome =
  | {readonly kind: 'ok'; readonly stdout: string; readonly stderr: string}
  | {readonly kind: 'failed'; readonly code: number | null; readonly stdout: string; readonly stderr: string}
  | {readonly kind: 'timeout'}
  /**
   * SIGKILL was sent, but the child's stdio streams never confirmed closed within the reap grace
   * window — termination was attempted, not confirmed. Distinct from `timeout` (which only ever
   * represents a CONFIRMED kill) so a caller can never mistake "we gave up waiting" for "the
   * process is definitely gone".
   */
  | {readonly kind: 'termination-unconfirmed'}

export type GitRunnerFn = (args: readonly string[], options: GitRunnerOptions) => Promise<GitOutcome>

/**
 * Default git runner. Uses the callback form of `execFile` (never the promisified wrapper) so we
 * retain a handle to the underlying `ChildProcess` and can CONFIRM termination on timeout: on
 * timeout we SIGKILL the child and wait for `execFile`'s callback — which Node fires only after
 * the child's stdio streams have actually closed — before resolving the timeout outcome, rather
 * than resolving as soon as `kill()` is called. `maxBuffer` is set explicitly so a pathologically
 * large `git status` output fails cleanly (mapped to a `failed` outcome) instead of throwing past
 * the caller.
 */
export const runGit: GitRunnerFn = async (args, options) =>
  new Promise(resolve => {
    let settled = false
    let terminating = false
    let timedOut = false
    let graceHandle: ReturnType<typeof setTimeout> | undefined
    let timeoutHandle: ReturnType<typeof setTimeout>

    const detachAbortListener = (): void => {
      options.signal?.removeEventListener('abort', onAbort)
    }

    const child = execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        encoding: 'utf8',
        uid: options.uid,
        gid: options.gid,
      },
      (error, stdout, stderr) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutHandle)
        clearTimeout(graceHandle)
        detachAbortListener()
        if (timedOut) {
          resolve({kind: 'timeout'})
          return
        }
        if (error === null) {
          resolve({kind: 'ok', stdout, stderr})
          return
        }
        // error.code is the numeric exit code for a normal non-zero exit, or a string (e.g.
        // 'ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') for spawn/stream failures — including
        // maxBuffer overflow, which we want reported as a clean `failed` outcome, not a throw
        // that escapes the caller.
        const code = typeof error.code === 'number' ? error.code : null
        resolve({kind: 'failed', code, stdout, stderr})
      },
    )

    // Confirmed-termination path shared by the timer AND `options.signal`: whichever fires first
    // sends SIGKILL and starts the same reap-grace race between a confirmed `timeout` (the exec
    // callback above still wins, proving the child's stdio actually closed) and
    // `termination-unconfirmed` (grace window elapses first) — an abort is just another trigger
    // for this path, never a distinct outcome. `terminating` guards against both firing (timer
    // fires, then the signal aborts before the grace window resolves, or vice versa).
    const terminate = (): void => {
      if (terminating) return
      terminating = true
      timedOut = true
      clearTimeout(timeoutHandle)
      child.kill('SIGKILL')
      // Grace window in case SIGKILL doesn't reap promptly (unusual, but SIGKILL delivery is not
      // instantaneous). If the child still hasn't closed after this, the caller must never hang
      // forever — but termination is NOT confirmed at this point (the exec callback, which Node
      // fires only once the child's stdio streams actually close, never ran): resolve as
      // `termination-unconfirmed`, never as `timeout`, so nothing downstream can mistake "we gave
      // up waiting" for "the process is definitely gone".
      graceHandle = setTimeout(() => {
        if (settled) return
        settled = true
        detachAbortListener()
        resolve({kind: 'termination-unconfirmed'})
      }, GIT_KILL_REAP_GRACE_MS)
    }

    function onAbort(): void {
      terminate()
    }

    timeoutHandle = setTimeout(terminate, options.timeoutMs)

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        terminate()
      } else {
        options.signal.addEventListener('abort', onAbort, {once: true})
      }
    }
  })

/**
 * Global git safety flags applied to every neutralized invocation. Byte-identical to the set
 * inspect.ts originally defined for itself, so moving a caller onto this shared list changes
 * nothing about what it already ran with.
 *
 * - `--no-optional-locks`: makes `git status` skip the opportunistic write of the refreshed
 *   stat-cache back to `.git/index` (the specific mechanism that keeps `status` read-only). A
 *   no-op for the rev-parse-only calls clone.ts makes, kept here anyway so this list stays one
 *   copy shared by every caller instead of two lists that quietly drift apart.
 * - `--no-pager`: git never spawns `core.pager` for our non-interactive output.
 * - `-c core.fsmonitor=false`: neutralizes an agent-writable `.git/config` that could otherwise
 *   configure `core.fsmonitor` to execute an arbitrary command.
 * - `-c core.hooksPath=/dev/null`: points hook lookup at a location that can never contain
 *   executable hook scripts, defense-in-depth against a config-injected hooks path.
 * - `-c core.pager=cat`: defense-in-depth alongside `--no-pager`.
 * - `-c credential.helper=`: disables any operator-side credential helper; these invocations
 *   never need credentials and must never be handed any.
 */
export const GIT_SAFETY_ARGS: readonly string[] = [
  '--no-optional-locks',
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.pager=cat',
  '-c',
  'credential.helper=',
]

/**
 * `-c safe.directory=` followed by `-c safe.directory=<canonicalPath>`: the FIRST entry resets
 * any `safe.directory` exceptions a repo's own (agent-writable) config might otherwise
 * contribute (confirmed against real git 2.55.0 that an empty `safe.directory` value clears
 * prior entries rather than adding one), and the SECOND grants exactly the canonical checkout
 * path, never `*` (which would trust every path) and never a parent path (which would also trust
 * sibling checkouts). Command-line `-c` config is honored for `safe.directory`; a repo's own
 * `.git/config` is NOT (confirmed against real git 2.55.0), which is exactly why this must be
 * passed as `-c` here rather than relying on anything committed inside the checkout. Required
 * once the checkout is owned by AGENT_UID and git also runs as AGENT_UID; kept unconditionally
 * (including for a same-uid caller) because a migration period can leave a checkout still owned
 * by the service uid while git already runs as AGENT_UID, or vice versa.
 */
export function safeDirectoryArgs(canonicalPath: string): readonly string[] {
  return ['-c', 'safe.directory=', '-c', `safe.directory=${canonicalPath}`]
}

/** Builds a full, safety-neutralized git invocation: `-C cwd` + safety flags + safe.directory + subArgs. */
export function gitInvocation(cwd: string, canonicalPath: string, subArgs: readonly string[]): readonly string[] {
  return ['-C', cwd, ...GIT_SAFETY_ARGS, ...safeDirectoryArgs(canonicalPath), ...subArgs]
}

/**
 * Minimal, credential-free git subprocess environment for a neutralized invocation. Deliberately
 * does NOT include GITHUB_TOKEN or proxy variables — these invocations are local-only and need
 * no network access.
 *
 * GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL=/dev/null disable the system and global config
 * levels entirely (HOME is fixed to AGENT_HOME rather than inherited from the calling process,
 * since the global config lookup git would otherwise perform there is disabled anyway, and the
 * caller may still be the root-owned service during a migration period).
 */
export function buildNeutralGitEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_TRACE: '0',
    GIT_TRACE_PACKET: '0',
    GIT_TRACE_PERFORMANCE: '0',
    GIT_CURL_VERBOSE: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    HOME: AGENT_HOME,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  }
}
