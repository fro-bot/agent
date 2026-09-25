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
   * an already-aborted signal terminates immediately, without waiting for `timeoutMs`. An abort
   * reports EXACTLY what a timeout would report (`timeout` or `termination-unconfirmed`) — there
   * is no way to distinguish "aborted" from "timed out" in the returned `GitOutcome`; a caller
   * that needs to know which one happened must track that itself (e.g. check `signal.aborted`).
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
      // A spawn failure (e.g. ENOENT for a missing `git` binary) never gets a live child process
      // — `child.pid` stays undefined for its whole lifetime in that case. Terminating here would
      // misreport that failure as `timeout` instead of letting the exec callback below resolve it
      // as the `failed` outcome it actually is.
      if (child.pid === undefined) return
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

// ---------------------------------------------------------------------------
// Unit 3 (not implemented yet): network and local git profile builders.
//
// These are the STUBS the Unit 2 adversarial fixture suite
// (apps/workspace-agent/src/update-fixtures/*.test.ts) is written against. Every exported
// function below has a typed signature and a JSDoc contract, but its body throws — Unit 3
// implements the body; Unit 2's suite is expected to fail red against these stubs until then.
// ---------------------------------------------------------------------------

/** A fully-built git invocation: the arg vector (after `git`), the environment, the working directory, and the identity to run as. */
export interface GitProfile {
  readonly args: readonly string[]
  readonly env: Record<string, string>
  readonly cwd: string
  readonly uid?: number
  readonly gid?: number
}

export interface NetworkGitProfileOptions {
  /** Absolute path to the root-owned protected bare repo (`--git-dir` target). */
  readonly bareRepoPath: string
  /** The service's own HOME — never an agent-owned checkout, never AGENT_HOME. */
  readonly serviceHome: string
  /** Path to the existing askpass helper (clone.ts's `writeAskpassHelper` shape). */
  readonly askpassPath: string
  /** The GitHub installation token, delivered via env, never as an argv literal. */
  readonly token: string
  /** Path to the trusted CA bundle; omitted uses the process's default trust store. */
  readonly caBundlePath?: string
  /**
   * The FULL parent process environment the service is actually running with (production passes
   * `process.env`). The builder may draw ordinary, non-git-specific values from it (e.g. `PATH`,
   * locale variables) but must NEVER let it influence git's own config, transport, TLS, or proxy
   * behavior: every git-specific variable — `GIT_CONFIG_*` (including `GIT_CONFIG_PARAMETERS` and
   * the `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n` triad), `GIT_SSH_COMMAND`, `GIT_ASKPASS`,
   * `GIT_PROXY_COMMAND`, `GIT_SSL_NO_VERIFY`, `GIT_SSL_CAINFO`, `HOME`/`XDG_CONFIG_HOME` insofar as
   * they would drive global-config lookup, and every `*_PROXY`/`*_proxy` variable — must be
   * cleared or replaced with a value this builder chooses itself, regardless of what `parentEnv`
   * contains. A profile built from a contaminated `parentEnv` must behave IDENTICALLY to one built
   * from an empty environment, except for the explicitly plumbed-through values below.
   */
  readonly parentEnv: NodeJS.ProcessEnv
  /**
   * The ONLY sanctioned proxy configuration. A builder must never source a proxy (or a no-proxy
   * exclusion) from `parentEnv`'s `*_PROXY`/`*_proxy` variables — omitting this option means NO
   * proxy is used, full stop, even if `parentEnv` carries one.
   */
  readonly proxy?: {readonly https: string; readonly noProxy?: string}
}

/**
 * Contract (Unit 3 — not implemented here): builds the sealed, root-identity git invocation used
 * for every credential-bearing network operation (`ls-remote`, `fetch`, `pack-objects`) against
 * the protected bare repo named by `bareRepoPath`.
 *
 * The built profile must:
 * - Seal system and global config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`) so no
 *   config file this process can reach other than `--git-dir`'s own `config` is ever read —
 *   regardless of what `parentEnv.HOME`, `parentEnv.XDG_CONFIG_HOME`, or `parentEnv.GIT_CONFIG_*`
 *   already say.
 * - Explicitly clear every ambient git-specific environment variable named in
 *   `NetworkGitProfileOptions.parentEnv`'s doc comment, even when `parentEnv` already carries one
 *   — never conditionally default to an ambient value (e.g. never
 *   `parentEnv.GIT_CONFIG_GLOBAL ?? '/dev/null'`; always the literal `'/dev/null'`).
 * - Set `cwd` to `serviceHome` and `--git-dir` to `bareRepoPath` — NEVER a cwd inside, or a
 *   `--git-dir`/`--work-tree` pointing at, an agent-owned checkout. This is the mechanism that
 *   makes every transport-rewrite vector in an agent-owned checkout's config irrelevant: this
 *   profile never reads that config file at all.
 * - Force `GIT_ALLOW_PROTOCOL=https`, `GIT_TERMINAL_PROMPT=0`, TLS verification on, HTTP redirects
 *   off, `credential.helper=` cleared, and hooks disabled (`core.hooksPath=/dev/null`).
 * - Wire `GIT_ASKPASS=askpassPath` and `GITHUB_TOKEN=token` (env only — the token must never
 *   appear in `args`).
 * - Propagate `caBundlePath` (as `GIT_SSL_CAINFO`) and, only when `proxy` is given, exactly the
 *   proxy env vars it implies — no ambient `*_PROXY`/`*_proxy`/`GIT_PROXY_COMMAND` value is ever
 *   consulted, and omitting `proxy` means the resulting env carries no proxy configuration at all.
 */
export function buildNetworkGitProfile(_options: NetworkGitProfileOptions): GitProfile {
  throw new Error('not implemented: Unit 3')
}

export interface LocalUpdateGitProfileOptions {
  /** Absolute, canonical path to the agent-owned checkout the merge runs against. */
  readonly checkoutPath: string
}

/**
 * Contract (Unit 3 — not implemented here): builds the uid-10001 local git invocation used for
 * the fast-forward merge and its surrounding admission re-checks.
 *
 * The built profile must, beyond `GIT_SAFETY_ARGS`/`safeDirectoryArgs` (above):
 * - Carry no credential helper, no askpass, and no proxy environment variable at all.
 * - Set `GIT_ALLOW_PROTOCOL=` (empty) — an empty transport allowlist, so no transport, including
 *   `file://` and `ext::`, is available to this invocation.
 * - Disable replace refs (`GIT_NO_REPLACE_OBJECTS=1`) and partial/lazy fetch
 *   (`-c remote.<name>.promisor=false` is a per-remote setting; this profile instead refuses via
 *   `checkout-profile.ts`'s layout check — this builder only forces the invocation-level
 *   equivalents it can apply unconditionally, `GIT_NO_REPLACE_OBJECTS=1` among them).
 * - Force hooks, `core.fsmonitor`, the attributes file, sparse checkout, and submodule recursion
 *   off via `-c` overrides that the checkout's own (agent-writable) config cannot re-enable
 *   (`-c` on the command line always wins over `.git/config`).
 */
export function buildLocalUpdateGitProfile(_options: LocalUpdateGitProfileOptions): GitProfile {
  throw new Error('not implemented: Unit 3')
}
