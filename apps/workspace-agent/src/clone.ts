/**
 * Clone handler — executes `git clone` inside the workspace container.
 *
 * SECURITY INVARIANTS (non-negotiable):
 * 1. Token is NEVER passed via argv, URL, or shell string.
 * 2. Token is injected via GIT_ASKPASS helper script (mkdtemp dir, O_EXCL file, chmod 0700 — git executes
 *    this file, so owner-execute is required; it lives in a private 0700 mkdtemp dir and never contains
 *    the token itself — deleted in finally).
 * 3. Token is passed to the askpass script via GITHUB_TOKEN env var — NOT embedded in the script body.
 * 4. GIT_TRACE=0, GIT_CURL_VERBOSE=0, GIT_TRACE_PACKET=0, GIT_TRACE_PERFORMANCE=0 in subprocess env.
 * 5. execFile only — no exec(), no shell interpolation.
 * 6. Clone URL is always https://github.com/{owner}/{repo}.git — never caller-provided.
 * 7. -c credential.helper= disables any operator-side credential helper.
 * 8. Stderr is scrubbed of x-access-token patterns before logging or returning.
 * 9. Token is never logged, never in error responses, never persisted.
 * 10. Clone is atomic: staged in a private, root-owned staging directory
 *     (`<reposRoot>/.workspace-agent/staging/`, see identity.ts), renamed to dest on success; partial
 *     clones never reach destPath.
 * 11. GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1 seal off global/system git config for the clone
 *     (and the post-clone local rev-parse) subprocess — a fresh clone has no repo config yet, so those are
 *     the only places a `url.<x>.insteadOf` redirect could come from and hijack the credentialed request.
 * 12. Staging, not the destination: a fresh clone is written under the ROOT-OWNED staging directory,
 *     never directly under `<reposRoot>/<owner>/`, which the agent identity can traverse. HEAD is
 *     resolved and validated there, before handoff — the service never runs git in an agent-owned tree
 *     for a fresh clone.
 * 13. Ownership handoff (handoff.ts) is filesystem calls only — `lstat`/`lchown`, never `git`, never
 *     following a symlink, never crossing a filesystem boundary, and fails the clone outright on a
 *     hardlinked file (a fresh HTTPS clone should never contain one) rather than guessing.
 * 14. Once staging is handed to AGENT_UID/AGENT_GID and renamed into place, any git invocation against
 *     an EXISTING checkout at that path (the `repo-exists` idempotency check, and the post-rename race
 *     check) runs as AGENT_UID/AGENT_GID with the same neutralized, credential-free invocation shape
 *     `/inspect` uses (git-safety.ts) — never as the root-owned service.
 * 15. A handoff failure is always reported as `checkout-handoff-failed` (deterministic — the same
 *     staged tree fails the same way on every retry), never `clone-timeout` or `too-many-files`
 *     (both reserved for `git clone` itself). The specific reason lives in `CloneFailure.code`,
 *     never in a new response field.
 */

import type {GitRunnerFn} from './git-safety.js'
import type {HandoffOps} from './handoff.js'
import type {CloneFailure, CloneRequest, CloneSuccess} from './types.js'
import {execFile as execFileCb} from 'node:child_process'
import {rmSync} from 'node:fs'
import {chmod, mkdir, mkdtemp, open, realpath, rename, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import {promisify} from 'node:util'

import {buildNeutralGitEnv, gitInvocation, runGit} from './git-safety.js'
import {handOffToAgent} from './handoff.js'
import {AGENT_GID, AGENT_UID, CLONE_STAGING_DIR_NAME, WORKSPACE_STATE_DIR_NAME} from './identity.js'

const execFile = promisify(execFileCb)

/** Root directory where repos are cloned inside the workspace container. */
export const WORKSPACE_REPOS_ROOT = '/workspace/repos'

/** Default clone timeout in milliseconds. */
export const DEFAULT_CLONE_TIMEOUT_MS = 60_000

/** Maximum concurrent clones. */
export const MAX_CONCURRENT_CLONES = 5

/** Maximum queued clone requests before rejecting with 503. */
export const MAX_CLONE_QUEUE_DEPTH = 50

/**
 * Deadline for the post-clone ownership-handoff walk (handoff.ts), in milliseconds. Generous
 * enough for a very large repo's worth of filesystem entries, but bounded so a pathological tree
 * can never hold the per-repo lock — and the global clone semaphore slot — open indefinitely.
 * Exceeding it maps to `checkout-handoff-failed` (`code: 'deadline-exceeded'`) — deliberately NOT
 * `clone-timeout`, which is reserved for `git clone` itself timing out and is treated as
 * retryable downstream; a handoff deadline is deterministic and will not resolve on retry.
 */
export const HANDOFF_DEADLINE_MS = 30_000

/**
 * Entry cap for the post-clone ownership-handoff walk. A fresh HTTPS clone of even a very large
 * monorepo lands well under this. Exceeding it maps to `checkout-handoff-failed`
 * (`code: 'max-entries'`) — deliberately NOT `too-many-files`, which is reserved for an EMFILE
 * resource exhaustion from git itself and is treated as retryable downstream; a fixed entry cap
 * being exceeded by a fixed tree is deterministic and will not resolve on retry.
 */
export const MAX_HANDOFF_ENTRIES = 500_000

/** Regex to scrub x-access-token credentials from git stderr/stdout. */
const TOKEN_URL_RE = /x-access-token:[^@]+@/g

/**
 * Scrub any credential patterns from a string before logging or returning it.
 * Replaces `x-access-token:<token>@` with `x-access-token:[REDACTED]@`.
 */
export function scrubCredentials(s: string): string {
  return s.replaceAll(TOKEN_URL_RE, 'x-access-token:[REDACTED]@')
}

/** Simplified execFile signature used for dependency injection and testing. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: {env: Record<string, string>; signal?: AbortSignal},
) => Promise<{stdout: string; stderr: string}>

export interface CloneOptions {
  /** Clone timeout in milliseconds. Default: DEFAULT_CLONE_TIMEOUT_MS. */
  readonly timeoutMs?: number
  /** Maximum concurrent clones. Default: MAX_CONCURRENT_CLONES. */
  readonly maxConcurrent?: number
  /** Maximum queued requests. Default: MAX_CLONE_QUEUE_DEPTH. */
  readonly maxQueueDepth?: number
  /** Ownership-handoff walk deadline. Default: HANDOFF_DEADLINE_MS. */
  readonly handoffDeadlineMs?: number
  /** Ownership-handoff walk entry cap. Default: MAX_HANDOFF_ENTRIES. */
  readonly handoffMaxEntries?: number
}

export interface CloneHandlerDeps {
  /** Injected execFile for testability. Defaults to promisified node:child_process execFile. */
  readonly execFileFn?: ExecFileFn
  /** Workspace repos root. Defaults to WORKSPACE_REPOS_ROOT. */
  readonly reposRoot?: string
  /** Clone options. */
  readonly options?: CloneOptions
  /** Injected mkdtemp for testability. */
  readonly mkdtempFn?: (prefix: string) => Promise<string>
  /**
   * Injected git runner for the `repo-exists` and post-rename race-check validation against an
   * EXISTING checkout, run as AGENT_UID/AGENT_GID. Defaults to the confirmed-termination `runGit`
   * (git-safety.ts) — the same runner `/inspect` uses.
   */
  readonly gitRunner?: GitRunnerFn
  /** Injected filesystem operations for the ownership-handoff walk (handoff.ts). Defaults to real node:fs/promises. */
  readonly handoffOps?: HandoffOps
}

export interface CloneHandlerResult {
  readonly response: CloneSuccess | CloneFailure
  readonly statusCode: 200 | 400 | 409 | 500 | 503 | 504
}

// ---------------------------------------------------------------------------
// Global askpass dir tracking for signal-handler cleanup
// ---------------------------------------------------------------------------

/** All in-flight askpass dirs. Drained on SIGTERM/SIGINT/exit. */
const activeAskpassDirs = new Set<string>()

async function cleanupAskpassDir(dir: string): Promise<void> {
  activeAskpassDirs.delete(dir)
  await rm(dir, {recursive: true, force: true})
}

function syncCleanupAskpassDirs(): void {
  // Synchronous best-effort cleanup on process exit.
  // We can't await here, but we can at least attempt removal.
  for (const dir of activeAskpassDirs) {
    try {
      rmSync(dir, {recursive: true, force: true})
    } catch {
      // Best-effort; ignore errors on exit.
    }
    activeAskpassDirs.delete(dir)
  }
}

export async function asyncCleanupAllAskpassDirs(): Promise<void> {
  const dirs = [...activeAskpassDirs]
  await Promise.allSettled(dirs.map(async dir => cleanupAskpassDir(dir)))
}

export {syncCleanupAskpassDirs}

// NOTE: No SIGTERM/SIGINT handlers here — main.ts owns signal handling.
// This exit handler is a synchronous best-effort safety net only.
process.on('exit', () => {
  syncCleanupAskpassDirs()
})

// ---------------------------------------------------------------------------
// Per-repo lock (serializes concurrent requests for the same owner/repo)
// ---------------------------------------------------------------------------

const repoLocks = new Map<string, Promise<void>>()

async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (repoLocks.has(key)) {
    await repoLocks.get(key)
  }
  let release!: () => void
  const lock = new Promise<void>(resolve => {
    release = resolve
  })
  repoLocks.set(key, lock)
  try {
    return await fn()
  } finally {
    repoLocks.delete(key)
    release()
  }
}

// ---------------------------------------------------------------------------
// Global concurrency semaphore
// ---------------------------------------------------------------------------

let activeClonesCount = 0
let queuedClonesCount = 0
const cloneQueue: (() => void)[] = []

/** Reset semaphore state — for testing only. */
export function resetCloneSemaphoreForTesting(): void {
  activeClonesCount = 0
  queuedClonesCount = 0
  cloneQueue.length = 0
}

async function withCloneSemaphore<T>(
  maxConcurrent: number,
  maxQueueDepth: number,
  fn: () => Promise<T>,
): Promise<T | CloneHandlerResult> {
  if (activeClonesCount >= maxConcurrent) {
    if (queuedClonesCount >= maxQueueDepth) {
      const result: CloneHandlerResult = {
        response: {ok: false, error: 'overloaded'},
        statusCode: 503,
      }
      return result
    }
    // Queue the request.
    queuedClonesCount++
    await new Promise<void>(resolve => {
      cloneQueue.push(resolve)
    })
    queuedClonesCount--
  }

  activeClonesCount++
  try {
    return await fn()
  } finally {
    activeClonesCount--
    const next = cloneQueue.shift()
    if (next !== undefined) next()
  }
}

// ---------------------------------------------------------------------------
// Core clone logic
// ---------------------------------------------------------------------------

/**
 * Core clone logic — pure-ish function for testability.
 *
 * Caller is responsible for validating owner/repo/token before calling this.
 * This function:
 * 1. Checks global concurrency semaphore (503 overloaded if exceeded).
 * 2. Acquires per-repo lock (serializes concurrent requests for same repo).
 * 3. Derives the destination path internally.
 * 4. Creates the repos root if missing.
 * 5. Checks for an existing checkout at the destination (returns 409 repo-exists), validated as
 *    AGENT_UID/AGENT_GID (isUsableGitCheckout).
 * 6. Clones into a unique directory under the root-owned staging parent (mkdtemp), never beside
 *    the destination and never under the agent-traversable owner dir.
 * 7. Writes a GIT_ASKPASS helper script via mkdtemp + O_EXCL open.
 *    Token is passed via GITHUB_TOKEN env var — NOT embedded in script body.
 * 8. Invokes git clone via execFile with AbortController timeout.
 * 9. Reads HEAD SHA from staging, BEFORE handoff (failure → clone-failed, not ok:true with
 *    'unknown').
 * 10. Hands the staged tree to AGENT_UID/AGENT_GID via filesystem calls only (handoff.ts).
 * 11. Renames staging → destination (atomic: rename on success, rm on failure).
 * 12. Verifies the cloned path is still within the repos root (symlink defense).
 * 13. Cleans up the askpass temp dir, and any not-yet-renamed staging dir, in finally.
 */
export async function executeClone(request: CloneRequest, deps: CloneHandlerDeps = {}): Promise<CloneHandlerResult> {
  const {
    execFileFn = execFile,
    reposRoot = WORKSPACE_REPOS_ROOT,
    options = {},
    mkdtempFn = async (prefix: string) => mkdtemp(prefix),
    gitRunner = runGit,
    handoffOps,
  } = deps
  const {
    timeoutMs = DEFAULT_CLONE_TIMEOUT_MS,
    maxConcurrent = MAX_CONCURRENT_CLONES,
    maxQueueDepth = MAX_CLONE_QUEUE_DEPTH,
    handoffDeadlineMs = HANDOFF_DEADLINE_MS,
    handoffMaxEntries = MAX_HANDOFF_ENTRIES,
  } = options

  const {owner, repo, token} = request

  // Global concurrency semaphore.
  const semaphoreResult = await withCloneSemaphore(maxConcurrent, maxQueueDepth, async () =>
    withRepoLock(`${owner}/${repo}`, async () =>
      executeCloneInner(owner, repo, token, reposRoot, timeoutMs, execFileFn, mkdtempFn, gitRunner, {
        deadlineMs: handoffDeadlineMs,
        maxEntries: handoffMaxEntries,
        ops: handoffOps,
      }),
    ),
  )

  return semaphoreResult
}

/**
 * Writes the GIT_ASKPASS helper script into `dir` (which must already exist, e.g. from
 * `mkdtemp`) and returns the script's path.
 *
 * The script never embeds the token in its body — it reads $GITHUB_TOKEN from its own
 * process env at exec time, so the file on disk contains no secret.
 *
 * Mode is 0o700 (owner read/write/execute), not 0o600. Git *executes* this file when it
 * needs to prompt for a credential (i.e. for any private repository); without the owner
 * execute bit, git fails with "cannot exec '<path>': Permission denied" regardless of
 * whether the process runs as root — execute permission is checked against the mode bits.
 * The directory this file lives in is a private mkdtemp dir (mode 0700, not world- or
 * group-readable), so adding owner-execute here adds no exposure.
 *
 * The mode passed to `open()` is masked by the process umask, so it alone cannot
 * guarantee the execute bit survives (e.g. umask 0177 would silently strip it back to
 * 0600 and reintroduce the "cannot exec" failure). `chmod` is called explicitly after
 * the write to set the mode unconditionally, independent of umask.
 *
 * The script answers ONLY the exact `https://github.com` credential prompts git issues
 * for the fixed clone URL (see invariant #6) — nothing else. Git follows HTTP redirects
 * on the first request by default (`http.followRedirects=initial`), and a redirect to a
 * different HTTPS host makes git prompt for THAT host's credentials; sealing global/system
 * config (buildCloneGitEnv) does not stop a same-request redirect, so the helper itself
 * has to refuse to answer for any host but github.com. The `case` patterns are exact
 * literals (no globs) against git's real prompt text — `Username for 'https://github.com': `
 * and `Password for 'https://x-access-token@github.com': ` — confirmed against real git
 * (see clone.askpass.test.ts). Exact-literal matching means a lookalike host
 * (`github.com.evil.example`), a path trick (`evil.example/github.com`), a non-https
 * scheme, or a non-default port cannot match; every other prompt falls through to the
 * `exit 1` fallback, same as before.
 */
export async function writeAskpassHelper(dir: string): Promise<string> {
  // Open askpass.sh with O_EXCL (exclusive creation — refuses if exists).
  const askpassPath = join(dir, 'askpass.sh')
  const fh = await open(askpassPath, 'wx', 0o700)
  try {
    // We construct the string to avoid triggering no-template-curly-in-string lint rule.
    const githubTokenRef = ['$', '{GITHUB_TOKEN}'].join('')
    const askpassScript = [
      '#!/bin/sh',
      'case "$1" in',
      `  "Username for 'https://github.com': ") printf '%s' 'x-access-token' ;;`,
      `  "Password for 'https://x-access-token@github.com': ") printf '%s' "${githubTokenRef}" ;;`,
      `  *) exit 1 ;;`,
      'esac',
      '',
    ].join('\n')
    await fh.writeFile(askpassScript)
  } finally {
    await fh.close()
  }
  // Umask-independent: guarantees the execute bit regardless of the process umask.
  await chmod(askpassPath, 0o700)
  return askpassPath
}

/**
 * Builds the environment used to invoke `git clone` for a workspace clone request.
 *
 * Seals git's config resolution before the token is ever placed in this env: a freshly
 * requested clone has no repo-local `.git/config` yet, so the global and system config
 * files are the only places a `url.<x>.insteadOf` rule (or similar config-driven
 * credential-forwarding trick) could live. A rule planted in either could silently
 * redirect the clone URL to an attacker-controlled or otherwise unintended host while
 * GIT_ASKPASS still answers the credential prompt for it — handing the token to whatever
 * host the redirect points to.
 *   - GIT_CONFIG_GLOBAL=/dev/null   — git reads no user/global gitconfig at all.
 *   - GIT_CONFIG_NOSYSTEM=1         — git reads no system-wide gitconfig at all.
 *   - GIT_ALLOW_PROTOCOL=https      — git will not follow a config- or redirect-induced
 *                                      switch to a non-https transport.
 *
 * Exported so tests exercise the exact production env-building logic rather than a
 * hand-copied approximation of it.
 */
export function buildCloneGitEnv(
  token: string,
  askpassPath: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    GIT_ASKPASS: askpassPath,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: '0',
    GIT_TRACE: '0',
    GIT_TRACE_PACKET: '0',
    GIT_TRACE_PERFORMANCE: '0',
    GIT_CURL_VERBOSE: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: 'https',
    HOME: parentEnv.HOME ?? '/root',
    PATH: parentEnv.PATH ?? '/usr/bin:/bin',
  }

  // Propagate egress-proxy settings so git reaches GitHub through mitmproxy.
  // The workspace runs on an internal-only network; without these, clone has
  // no route out. These are not secrets, so they do not break token isolation.
  for (const proxyVar of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
    const value = parentEnv[proxyVar]
    if (value !== undefined && value !== '') {
      env[proxyVar] = value
    }
  }

  return env
}

/**
 * Validates that `canonicalPath` is a usable, non-bare git checkout with a resolvable HEAD
 * commit — the same two-step check the `repo-exists` idempotency check and the post-rename
 * race-check both need. Runs as AGENT_UID/AGENT_GID with the same neutralized, credential-free
 * invocation shape `/inspect` uses (git-safety.ts) — never as the root-owned service, and never
 * with `safe.directory` set to anything but this exact canonical path.
 *
 * Fails closed: a timeout, a confirmed-or-unconfirmed kill, a non-zero exit, or unexpected output
 * from either step all report `false` — the caller must never treat any of those as repo-exists.
 */
async function isUsableGitCheckout(gitRunner: GitRunnerFn, canonicalPath: string, timeoutMs: number): Promise<boolean> {
  const env = buildNeutralGitEnv()

  const insideOutcome = await gitRunner(
    gitInvocation(canonicalPath, canonicalPath, ['rev-parse', '--is-inside-work-tree']),
    {cwd: canonicalPath, env, timeoutMs, uid: AGENT_UID, gid: AGENT_GID},
  )
  if (insideOutcome.kind !== 'ok' || insideOutcome.stdout.trim() !== 'true') return false

  const headOutcome = await gitRunner(
    gitInvocation(canonicalPath, canonicalPath, ['rev-parse', '--verify', 'HEAD^{commit}']),
    {cwd: canonicalPath, env, timeoutMs, uid: AGENT_UID, gid: AGENT_GID},
  )
  return headOutcome.kind === 'ok' && headOutcome.stdout.trim().length > 0
}

interface HandoffLimits {
  readonly deadlineMs: number
  readonly maxEntries: number
  readonly ops?: HandoffOps
}

async function executeCloneInner(
  owner: string,
  repo: string,
  token: string,
  reposRoot: string,
  timeoutMs: number,
  execFileFn: ExecFileFn,
  mkdtempFn: (prefix: string) => Promise<string>,
  gitRunner: GitRunnerFn,
  handoffLimits: HandoffLimits,
): Promise<CloneHandlerResult> {
  const destPath = join(reposRoot, owner, repo)
  const cloneUrl = `https://github.com/${owner}/${repo}.git`
  // Root-owned staging directory, created by the entrypoint (deploy/scripts/ensure-protected-dir.mjs)
  // as 0:0 0700 — see identity.ts. On the same volume as destPath, so the publishing rename is atomic.
  const stagingRoot = join(reposRoot, WORKSPACE_STATE_DIR_NAME, CLONE_STAGING_DIR_NAME)

  let askpassDir: string | null = null
  let stagingClonePath: string | null = null

  // AbortController for timeout.
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // Ensure the owner dir exists.
    await mkdir(join(reposRoot, owner), {recursive: true, mode: 0o755})
    // Idempotency: if the destination already exists, verify it is a usable git checkout —
    // as AGENT_UID/AGENT_GID (invariant #14) — before returning repo-exists. An empty or corrupt
    // directory must not be treated as a successful prior clone — fail closed instead.
    try {
      const existingResolved = await realpath(destPath)
      // Symlink defense: verify the existing path is still within the repos root.
      if (existingResolved.startsWith(`${reposRoot}/`) === false && existingResolved !== reposRoot) {
        // Path escaped the workspace — reject without returning repo-exists.
        return {
          response: {ok: false, error: 'path-escaped-workspace'},
          statusCode: 500,
        }
      }
      if (await isUsableGitCheckout(gitRunner, existingResolved, timeoutMs)) {
        return {
          response: {ok: false, error: 'repo-exists'},
          statusCode: 409,
        }
      }
      // Not a usable non-bare worktree with a resolvable HEAD — fail closed.
      return {
        response: {ok: false, error: 'head-resolution-failed'},
        statusCode: 500,
      }
    } catch {
      // ENOENT — path does not exist, proceed with clone.
    }

    // Ensure the staging directory exists beneath the (root-owned) state dir. mkdir recursive is
    // a no-op when the entrypoint has already created it — this call exists so the service can
    // still stage a clone on a machine where that hasn't happened yet (e.g. local/test runs).
    await mkdir(stagingRoot, {recursive: true, mode: 0o700})

    // Create a unique private askpass directory (race-free, mode 0700).
    askpassDir = await mkdtempFn(join(os.tmpdir(), 'workspace-agent-askpass-'))
    activeAskpassDirs.add(askpassDir)

    const askpassPath = await writeAskpassHelper(askpassDir)

    // Minimal, sealed env — only what git needs. Token via GITHUB_TOKEN, not in script
    // body. See buildCloneGitEnv for why global/system config is disabled here.
    const spawnEnv = buildCloneGitEnv(token, askpassPath, process.env)

    // Stage the clone in a unique directory under the root-owned staging parent — never beside
    // the destination, and never inside the agent-traversable owner dir (invariant #12).
    stagingClonePath = await mkdtempFn(join(stagingRoot, 'clone-'))

    // Clone args — token NEVER appears here.
    // -c credential.helper= disables any operator-side credential helper.
    const gitArgs = ['-c', 'credential.helper=', 'clone', cloneUrl, stagingClonePath]

    try {
      await execFileFn('git', gitArgs, {env: spawnEnv, signal: controller.signal})
    } catch (error) {
      // Map AbortError → clone-timeout.
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR')
      ) {
        return {
          response: {ok: false, error: 'clone-timeout'},
          statusCode: 504,
        }
      }

      const raw = error instanceof Error ? error.message : String(error)
      const scrubbed = scrubCredentials(raw)

      // Detect ENOSPC.
      if (scrubbed.includes('ENOSPC') || scrubbed.includes('No space left')) {
        return {
          response: {ok: false, error: 'enospc', code: 'ENOSPC'},
          statusCode: 500,
        }
      }

      // Detect git not available.
      if (scrubbed.includes('ENOENT') && scrubbed.includes('git')) {
        return {
          response: {ok: false, error: 'git-not-available'},
          statusCode: 500,
        }
      }

      return {
        response: {ok: false, error: 'clone-failed'},
        statusCode: 500,
      }
    }

    // Validate HEAD BEFORE handoff (invariant #12) — the staged tree is still service(root)-owned
    // at this point, so this is the only git invocation in this function that ever runs as root
    // with a fresh clone. rev-parse is purely local; omit GITHUB_TOKEN from its env.
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const {GITHUB_TOKEN: _GITHUB_TOKEN, ...localGitEnv} = spawnEnv
    let commit: string
    try {
      const {stdout} = await execFileFn('git', ['-C', stagingClonePath, 'rev-parse', 'HEAD'], {env: localGitEnv})
      commit = stdout.trim()
      if (commit.length === 0) {
        return {
          response: {ok: false, error: 'head-resolution-failed'},
          statusCode: 500,
        }
      }
    } catch {
      return {
        response: {ok: false, error: 'head-resolution-failed'},
        statusCode: 500,
      }
    }

    // Hand ownership to the unprivileged agent identity — filesystem calls only, never git
    // (invariant #13). Only after this succeeds is the tree fit to publish or to run git against
    // as AGENT_UID.
    const handoffResult = await handOffToAgent(stagingClonePath, {
      uid: AGENT_UID,
      gid: AGENT_GID,
      deadlineMs: handoffLimits.deadlineMs,
      maxEntries: handoffLimits.maxEntries,
      ops: handoffLimits.ops,
    })
    if (handoffResult.ok === false) {
      // A handoff failure is DETERMINISTIC — the same staged tree fails the same way on every
      // retry, whether it's a deadline, the entry cap, a hardlink, a filesystem-boundary crossing,
      // or an unsupported node type. It is never a `git clone` timeout (`clone-timeout`) or an
      // EMFILE resource exhaustion (`too-many-files`) — reusing either of those codes here would
      // tell the caller (gateway `PERMANENT_CLONE_ERROR_CODES`) this is retryable when it can never
      // succeed. One code covers every handoff-failure reason; the reason itself is carried in
      // `code` (the existing machine-readable sub-code field — see `types.ts`), never logged
      // separately, since this module has no logger of its own.
      return {
        response: {ok: false, error: 'checkout-handoff-failed', code: handoffResult.reason},
        statusCode: 500,
      }
    }

    // Atomic rename: stagingClonePath → destPath. The tree is now AGENT_UID/AGENT_GID-owned.
    try {
      await rename(stagingClonePath, destPath)
      stagingClonePath = null // Rename succeeded; don't rm in finally.
    } catch (error) {
      // Rename failure (e.g. cross-device link) → clone-failed.
      const raw = error instanceof Error ? error.message : String(error)
      const scrubbed = scrubCredentials(raw)
      // Check if dest appeared concurrently (race with another request that won the lock).
      // IMPORTANT: do NOT return repo-exists without validating the destination is a usable
      // git checkout. An empty or corrupt directory at destPath must not be treated as a
      // successful prior clone — fail closed instead.
      if (scrubbed.includes('ENOTEMPTY') || scrubbed.includes('EEXIST')) {
        // Validate the race destination using the same logic as the initial existing-path check —
        // as AGENT_UID/AGENT_GID (invariant #14): by the time a concurrent winner reaches this
        // point its own handoff has already run, so the race destination is agent-owned.
        let raceResolved: string
        try {
          raceResolved = await realpath(destPath)
        } catch {
          // Cannot resolve the path — treat as a failed clone, not repo-exists.
          return {
            response: {ok: false, error: 'clone-failed'},
            statusCode: 500,
          }
        }
        // Symlink defense: verify the race destination is still within the repos root.
        if (raceResolved.startsWith(`${reposRoot}/`) === false && raceResolved !== reposRoot) {
          return {
            response: {ok: false, error: 'path-escaped-workspace'},
            statusCode: 500,
          }
        }
        if (await isUsableGitCheckout(gitRunner, raceResolved, timeoutMs)) {
          return {
            response: {ok: false, error: 'repo-exists'},
            statusCode: 409,
          }
        }
        return {
          response: {ok: false, error: 'clone-failed'},
          statusCode: 500,
        }
      }
      return {
        response: {ok: false, error: 'clone-failed'},
        statusCode: 500,
      }
    }

    // Symlink defense: verify the cloned path is still within the repos root.
    let resolvedPath: string
    try {
      resolvedPath = await realpath(destPath)
    } catch {
      return {
        response: {ok: false, error: 'path-escaped-workspace'},
        statusCode: 500,
      }
    }

    if (resolvedPath.startsWith(`${reposRoot}/`) === false && resolvedPath !== reposRoot) {
      // Path escaped the workspace — remove the clone and reject. Root deletes an agent-owned tree
      // here, but this is unreachable in practice: the owner directory is root-owned 0755, so the
      // agent cannot swap destPath for a symlink between the rename above and this check.
      await rm(destPath, {recursive: true, force: true})
      return {
        response: {ok: false, error: 'path-escaped-workspace'},
        statusCode: 500,
      }
    }

    return {
      response: {ok: true, path: resolvedPath, commit},
      statusCode: 200,
    }
  } catch (error) {
    // Catch-all for unexpected errors (e.g., mkdir EACCES, open EEXIST, etc.)
    // that aren't handled by inner try/catch blocks.
    // Map EACCES → permission-denied, ENOSPC → disk-full, etc.
    const raw = error instanceof Error ? error.message : String(error)
    const scrubbed = scrubCredentials(raw)
    if (scrubbed.includes('ENOSPC') || scrubbed.includes('No space left')) {
      return {response: {ok: false, error: 'disk-full'}, statusCode: 500}
    }
    if (scrubbed.includes('EACCES')) {
      return {response: {ok: false, error: 'permission-denied'}, statusCode: 500}
    }
    if (scrubbed.includes('EMFILE')) {
      return {response: {ok: false, error: 'too-many-files'}, statusCode: 500}
    }
    return {response: {ok: false, error: 'clone-failed'}, statusCode: 500}
  } finally {
    clearTimeout(timeoutHandle)

    // Clean up partial staged clone if rename didn't happen (covers every failure path: clone
    // failure, HEAD-resolution failure, handoff failure, timeout, and rename failure).
    if (stagingClonePath !== null) {
      await rm(stagingClonePath, {recursive: true, force: true})
    }

    // Always clean up the askpass temp dir.
    if (askpassDir !== null) {
      await cleanupAskpassDir(askpassDir)
    }
  }
}
