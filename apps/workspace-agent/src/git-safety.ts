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
import {join} from 'node:path'
import process from 'node:process'

import {AGENT_GID, AGENT_HOME, AGENT_UID} from './identity.js'

/**
 * Bound on waiting for a confirmed reap after SIGKILL. Mirrors the reap-grace pattern used
 * elsewhere in this repo (src/services/setup/adapters.ts) for confirmed-termination semantics.
 * Exported so other confirmed-termination implementations in this module family (e.g.
 * git-stream.ts's own two-process reap logic) can share the same bound rather than each
 * hardcoding an independent copy of the same constant.
 */
export const GIT_KILL_REAP_GRACE_MS = 2_000

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
// Filter-driver enumeration and neutralization — closes the vector where a git command that
// reads working-tree content (`status`, `update-index --refresh`, `diff`) runs `filter.<driver>.
// clean`/`.process` on any tracked file whose stat info no longer matches the index. The driver
// command lives in config (any level plain `git config` reads: system, global, local, worktree,
// and anything pulled in via `include.path`/`includeIf`) and is assigned to files via
// `.gitattributes` or `.git/info/attributes` — both agent-writable between harness runs, and
// neither covered by GIT_SAFETY_ARGS's fixed `-c` neutralizers above.
//
// Originally lived only in inspect.ts, then duplicated byte-for-byte in checkout-profile.ts
// (Unit 3's `checkTempIndexCleanliness`, which has the identical need: a temp-index `status` also
// reads working-tree content). Consolidated here so both callers share one implementation instead
// of two copies that could quietly drift apart.
// ---------------------------------------------------------------------------

const FILTER_CONFIG_KEY_RE = /^filter\.(.+)\.(?:clean|smudge|process|required)$/

/**
 * Parses `git config -z --get-regexp '^filter\.'` output into the set of configured filter-driver
 * names. `-z` NUL-terminates each record as `key\nvalue\0` so a value containing embedded
 * newlines can never be misread as a record boundary — not needed for the key itself here, but
 * the key can contain `.` and `=` (valid characters in a git config subsection name), which is
 * exactly why GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> (not `-c`) are used to neutralize them
 * below. The regex is greedy on the driver-name capture, so `filter.evil.dot.clean` yields
 * `evil.dot` (not `evil`) and `filter.evil=x.clean` yields `evil=x` — confirmed against real git
 * 2.55.0.
 */
export function parseFilterDriverNames(stdout: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue
    const newlineIndex = record.indexOf('\n')
    const key = newlineIndex === -1 ? record : record.slice(0, newlineIndex)
    const match = FILTER_CONFIG_KEY_RE.exec(key)
    const driverName = match?.[1]
    if (driverName !== undefined) names.add(driverName)
  }
  return names
}

export type FilterEnumerationOutcome =
  {readonly kind: 'ok'; readonly drivers: ReadonlySet<string>} | {readonly kind: 'failed'}

/**
 * Enumerates every configured `filter.<name>.*` driver so each can be neutralized before a git
 * command that reads working-tree content runs. Plain `git config` — no
 * `--global`/`--system`/`--local`/`--file` — reads every level that command itself reads (system,
 * global, local, worktree) and follows `include.path`/`includeIf`, confirmed against real git
 * 2.55.0, so this sees exactly what could assign a driver to a tracked file. `--get-regexp` exits
 * 1 with empty stdout when nothing matches (the common case: no filter drivers configured) — that
 * is success with an empty set, not a failure.
 *
 * Fails closed: any other non-ok outcome (timeout, non-1 exit, or output this function can't
 * parse as a config record) reports `'failed'`, and the caller must never run the working-tree
 * command after a `'failed'` result.
 */
export async function enumerateFilterDrivers(
  canonicalPath: string,
  env: Record<string, string>,
  gitRunner: GitRunnerFn,
  timeoutMs: number,
  uid: number | undefined,
  gid: number | undefined,
): Promise<FilterEnumerationOutcome> {
  const outcome = await gitRunner(
    gitInvocation(canonicalPath, canonicalPath, ['config', '-z', '--get-regexp', String.raw`^filter\.`]),
    {cwd: canonicalPath, env, timeoutMs, uid, gid},
  )
  if (outcome.kind === 'ok') return {kind: 'ok', drivers: parseFilterDriverNames(outcome.stdout)}
  if (outcome.kind === 'failed' && outcome.code === 1 && outcome.stdout.length === 0) {
    return {kind: 'ok', drivers: new Set()}
  }
  return {kind: 'failed'}
}

/**
 * Builds the `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` env overrides that
 * neutralize every enumerated filter driver for one git invocation. Env-based overrides are used
 * instead of `-c key=value` because `-c` splits its argument on the FIRST `=`, so a driver named
 * with an `=` in it (a valid git config subsection name) can't be neutralized that way — the env
 * mechanism keeps the key and value as separate strings, never joined and re-split. Documented
 * since git 2.31; confirmed present and behaving as documented on git 2.55.0 (the version
 * `deploy/workspace.Dockerfile` installs).
 *
 * For each driver: `clean` and `smudge` are set to the empty string, `process` to the empty
 * string, and `required` to `false`.
 * - Empty `clean`/`process`: confirmed against real git 2.55 that this makes git treat the file as
 *   if no filter were configured for that operation — no subprocess is spawned. (`smudge` is
 *   never invoked by `git status`/`update-index --refresh` — it only runs on checkout — but is
 *   neutralized too for defense-in-depth in case a future caller runs a checkout-adjacent
 *   command.)
 * - `required=false` is necessary, not optional: with an empty `clean`/`process` but `required`
 *   left at a hostile `true`, git treats the now-unusable filter as a hard error and exits
 *   non-zero (confirmed against real git 2.55) — the command never executes, but every caller
 *   would then fail. Forcing `required=false` gets both no execution and a successful command.
 *
 * KNOWN SIDE EFFECT: with `clean` disabled, a tracked file whose stat info no longer matches the
 * index but whose *content* a real clean filter would normalize back to the committed blob
 * (git-lfs pointers, CRLF normalization, etc.) now compares raw worktree bytes against the index
 * blob instead — confirmed against real git 2.55 to report such a file as modified even though
 * the tree is semantically clean. A wrong "dirty"/"modified" label is recoverable; executing a
 * planted command is not, so this is accepted by every caller of this helper.
 */
export function buildFilterNeutralizationEnv(drivers: ReadonlySet<string>): Record<string, string> {
  const overrides: Record<string, string> = {}
  let index = 0
  for (const driver of drivers) {
    const entries: readonly (readonly [string, string])[] = [
      ['clean', ''],
      ['smudge', ''],
      ['process', ''],
      ['required', 'false'],
    ]
    for (const [subkey, value] of entries) {
      overrides[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${subkey}`
      overrides[`GIT_CONFIG_VALUE_${index}`] = value
      index += 1
    }
  }
  if (index > 0) overrides.GIT_CONFIG_COUNT = String(index)
  return overrides
}

// ---------------------------------------------------------------------------
// Unit 3: network and local git profile builders.
//
// These are the primitives the Unit 2 adversarial fixture suite
// (apps/workspace-agent/src/update-fixtures/*.test.ts) is written against.
// ---------------------------------------------------------------------------

/**
 * Fixed PATH for `buildNetworkGitProfile`'s sealed environment. Never derived from `parentEnv` —
 * see that function's contract for why: a compromised or unusual service PATH must never be able
 * to substitute a different `git`/`ssh`/`curl` binary into a credential-bearing invocation.
 */
const NETWORK_GIT_SAFE_PATH = '/usr/bin:/bin'

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
 * Builds the sealed, root-identity git invocation used
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
export function buildNetworkGitProfile(options: NetworkGitProfileOptions): GitProfile {
  const {bareRepoPath, serviceHome, askpassPath, token, caBundlePath, proxy} = options

  // Built from scratch — NEVER `{...parentEnv, ...}`. Every value below is either a literal this
  // builder chooses itself, or one of the two explicitly-sanctioned pass-throughs (`caBundlePath`,
  // `proxy`). `parentEnv` itself is never read here; a contaminated parent process environment
  // therefore cannot influence this profile at all.
  const env: Record<string, string> = {
    // Sealed system/global config — the ONLY config file this invocation ever reads is
    // `--git-dir`'s own `config`.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // Service-owned locations, never the caller's ambient HOME/XDG_CONFIG_HOME.
    HOME: serviceHome,
    XDG_CONFIG_HOME: join(serviceHome, '.config'),
    // Transport is HTTPS only; a config- or env-driven switch to ssh://, git://, ext::, or a bare
    // `http://` URL is refused by git itself before any connection is attempted.
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_TERMINAL_PROMPT: '0',
    GIT_TRACE: '0',
    GIT_TRACE_PACKET: '0',
    GIT_TRACE_PERFORMANCE: '0',
    GIT_CURL_VERBOSE: '0',
    // Askpass + token: env only, exactly clone.ts's shape — the token never appears in argv.
    GIT_ASKPASS: askpassPath,
    GITHUB_TOKEN: token,
    // Fixed, service-controlled PATH — never the parent's, so a contaminated ambient PATH can
    // never substitute a different git/ssh/curl binary into a credential-bearing invocation.
    PATH: NETWORK_GIT_SAFE_PATH,
  }

  if (caBundlePath !== undefined) {
    env.GIT_SSL_CAINFO = caBundlePath
  }

  if (proxy !== undefined) {
    // Both cases: curl (git's HTTP backend) consults the lowercase form for https:// targets and
    // the uppercase form is the conventional override — set both so neither casing is missed.
    env.HTTPS_PROXY = proxy.https
    env.https_proxy = proxy.https
    if (proxy.noProxy !== undefined) {
      env.NO_PROXY = proxy.noProxy
      env.no_proxy = proxy.noProxy
    }
  }

  const args: readonly string[] = [
    '--git-dir',
    bareRepoPath,
    '--no-pager',
    '-c',
    'http.followRedirects=false',
    '-c',
    'http.sslVerify=true',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'credential.helper=',
  ]

  return {args, env, cwd: serviceHome}
}

export interface LocalUpdateGitProfileOptions {
  /** Absolute, canonical path to the agent-owned checkout the merge runs against. */
  readonly checkoutPath: string
}

/**
 * Builds the uid-10001 local git invocation used for
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
export function buildLocalUpdateGitProfile(options: LocalUpdateGitProfileOptions): GitProfile {
  const {checkoutPath} = options

  // Reuses the exact neutralized invocation shape shared with inspect.ts/clone.ts
  // (GIT_SAFETY_ARGS + safeDirectoryArgs, via gitInvocation) — which already forces
  // `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `core.pager=cat`, and `credential.helper=`
  // — then adds the three overrides that shape doesn't cover: the attributes file, sparse
  // checkout, and submodule recursion. Every override here is `-c` on the command line, which
  // always wins over the checkout's own (agent-writable) `.git/config`.
  const args: readonly string[] = [
    ...gitInvocation(checkoutPath, checkoutPath, []),
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'core.sparseCheckout=false',
    '-c',
    'submodule.recurse=false',
  ]

  const env: Record<string, string> = {
    ...buildNeutralGitEnv(),
    // Empty transport allowlist: no transport at all — including file:// and ext:: — is available
    // to this invocation. This is a purely local merge; it must never be able to dial out.
    GIT_ALLOW_PROTOCOL: '',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
  }

  return {args, env, cwd: checkoutPath, uid: AGENT_UID, gid: AGENT_GID}
}
