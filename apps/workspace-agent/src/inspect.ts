/**
 * Inspect handler — reports the state of an EXISTING checkout without mutating it.
 *
 * READ-ONLY INVARIANTS (non-negotiable):
 * 1. Never runs `git clone`, `git fetch`, `git checkout`, or any write/network git command.
 * 2. `git status` is invoked with `--no-optional-locks` so it never writes the refreshed
 *    stat-cache back to the on-disk index (see buildGitInvocation() for the full rationale).
 * 3. Every git invocation carries `-c core.fsmonitor=false` (and other `-c` neutralizers) so an
 *    agent-writable `.git/config` cannot turn inspection into code execution.
 * 4. No credentials are read, minted, or passed to the git subprocess environment.
 * 5. Every git subprocess has a bounded timeout and is CONFIRMED terminated (we wait for the
 *    child's `close` event, not just for `kill()` to return) before the timeout outcome resolves.
 * 6. A checkout whose git top-level or git-directory resolves outside the canonical path is
 *    rejected as `checkout-substituted` \u2014 state is never reported for a substituted repository.
 */

import type {
  CheckoutObservation,
  CheckoutOperation,
  InspectErrorCode,
  InspectFailure,
  InspectRequest,
  InspectSuccess,
} from './types.js'
import {execFile} from 'node:child_process'
import {realpath, stat} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

/** Root directory where repos are cloned inside the workspace container. Mirrors clone.ts. */
export const WORKSPACE_REPOS_ROOT = '/workspace/repos'

/** Default inspection timeout in milliseconds. Local-only git calls; short by design. */
export const DEFAULT_INSPECT_TIMEOUT_MS = 10_000

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
 * inspection call.
 */
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024

// ---------------------------------------------------------------------------
// Git subprocess runner \u2014 confirmed-termination timeout, no credential env.
// ---------------------------------------------------------------------------

export interface GitRunnerOptions {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeoutMs: number
}

export type GitOutcome =
  | {readonly kind: 'ok'; readonly stdout: string; readonly stderr: string}
  | {readonly kind: 'failed'; readonly code: number | null; readonly stdout: string; readonly stderr: string}
  | {readonly kind: 'timeout'}

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
    let timedOut = false
    let graceHandle: ReturnType<typeof setTimeout> | undefined
    let timeoutHandle: ReturnType<typeof setTimeout>

    const child = execFile(
      'git',
      args,
      {cwd: options.cwd, env: options.env, maxBuffer: GIT_MAX_BUFFER_BYTES, encoding: 'utf8'},
      (error, stdout, stderr) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutHandle)
        clearTimeout(graceHandle)
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

    timeoutHandle = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      // Grace window in case SIGKILL doesn't reap promptly (unusual, but SIGKILL delivery is not
      // instantaneous). If the child still hasn't closed after this, resolve anyway — the caller
      // must never hang forever — but we have genuinely waited, not just fired-and-forgotten.
      graceHandle = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({kind: 'timeout'})
      }, GIT_KILL_REAP_GRACE_MS)
    }, options.timeoutMs)
  })

/**
 * Global git safety flags applied to EVERY inspection invocation.
 *
 * - `--no-optional-locks`: makes `git status` skip the opportunistic write of the refreshed
 *   stat-cache back to `.git/index`. This is the specific mechanism that keeps `status` read-only
 *   \u2014 without it, `git status` silently rewrites the index on disk even though it reports no
 *   changes were made.
 * - `--no-pager`: git never spawns `core.pager` for our non-interactive output.
 * - `-c core.fsmonitor=false`: neutralizes an agent-writable `.git/config` that could otherwise
 *   configure `core.fsmonitor` to execute an arbitrary command on every `status` call.
 * - `-c core.hooksPath=/dev/null`: points hook lookup at a location that can never contain
 *   executable hook scripts, defense-in-depth against a config-injected hooks path.
 * - `-c core.pager=cat`: defense-in-depth alongside `--no-pager` (config could otherwise re-enable
 *   paging for a subcommand that ignores the global flag).
 * - `-c credential.helper=`: disables any operator-side credential helper; inspection never needs
 *   credentials and must never be handed any.
 */
const GIT_SAFETY_ARGS: readonly string[] = [
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

function gitInvocation(cwd: string, subArgs: readonly string[]): readonly string[] {
  return ['-C', cwd, ...GIT_SAFETY_ARGS, ...subArgs]
}

/**
 * Minimal git subprocess environment. Deliberately does NOT include GITHUB_TOKEN, proxy
 * variables, or any credential material \u2014 inspection is local-only and needs no network access.
 */
function buildInspectEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_TRACE: '0',
    GIT_TRACE_PACKET: '0',
    GIT_TRACE_PERFORMANCE: '0',
    GIT_CURL_VERBOSE: '0',
    HOME: process.env.HOME ?? '/root',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  }
}

// ---------------------------------------------------------------------------
// Porcelain v2 parsing
// ---------------------------------------------------------------------------

const SHA_RE = /^[0-9a-f]{40}$/

interface ParsedStatus {
  readonly head: CheckoutObservation['head']
  readonly worktree: CheckoutObservation['worktree']
}

/**
 * Parses `git status --porcelain=v2 --branch` output into head + worktree state.
 * Returns null on any unparseable/unexpected shape (unborn HEAD, malformed SHA, etc.) \u2014
 * callers map a null result to the `inspection-failed` error code.
 */
function parsePorcelainV2(stdout: string): ParsedStatus | null {
  const lines = stdout.split('\n').filter(line => line.length > 0)

  let branchOid: string | null = null
  let branchHead: string | null = null
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0

  for (const line of lines) {
    if (line.startsWith('# branch.oid ')) {
      branchOid = line.slice('# branch.oid '.length).trim()
      continue
    }
    if (line.startsWith('# branch.head ')) {
      branchHead = line.slice('# branch.head '.length).trim()
      continue
    }
    if (line.startsWith('#')) continue

    const marker = line.charAt(0)
    if (marker === '?') {
      untracked += 1
      continue
    }
    if (marker === 'u') {
      conflicted += 1
      continue
    }
    if (marker === '1' || marker === '2') {
      const fields = line.split(' ')
      const xy = fields[1]
      if (xy === undefined || xy.length !== 2) continue
      if (!xy.startsWith('.')) staged += 1
      if (xy.charAt(1) !== '.') unstaged += 1
      continue
    }
    // Unknown marker (e.g. future porcelain extension) \u2014 ignore rather than fail closed on parsing.
  }

  if (branchOid === null || branchHead === null) return null
  // '(initial)' \u2014 unborn branch, no commits yet. No resolvable SHA; treat as unparseable.
  if (SHA_RE.test(branchOid) === false) return null

  const head: CheckoutObservation['head'] =
    branchHead === '(detached)'
      ? {kind: 'detached', sha: branchOid}
      : {kind: 'attached', branch: branchHead, sha: branchOid}

  const dirty = staged > 0 || unstaged > 0 || untracked > 0 || conflicted > 0
  const worktree: CheckoutObservation['worktree'] = dirty
    ? {kind: 'dirty', staged, unstaged, untracked, conflicted}
    : {kind: 'clean'}

  return {head, worktree}
}

// ---------------------------------------------------------------------------
// In-progress operation detection \u2014 presence of state files, never parsed output.
// ---------------------------------------------------------------------------

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * `rebase-apply/` is shared by two distinct git operations: `git am` and the apply-based
 * (`--apply`) form of `git rebase`. Git itself tells them apart with a marker file inside the
 * directory: `applying` for `git am`, `rebasing` for `git rebase --apply` (verified against real
 * git 2.55: `am` leaves only `applying`, `rebase --apply` leaves only `rebasing`, never both).
 * If `rebase-apply/` exists with neither marker — a state git's own sources treat as impossible
 * for a live operation — report `rebase`: it was the pre-existing (and more common) mapping for
 * this directory, so a markerless directory left by some future git version degrades to the
 * prior behavior rather than to a guess with no evidence behind it.
 */
async function detectRebaseApplyOperation(gitDir: string): Promise<CheckoutOperation> {
  if (await pathExists(join(gitDir, 'rebase-apply', 'applying'))) return 'am'
  return 'rebase'
}

async function detectOperationInProgress(gitDir: string): Promise<CheckoutOperation> {
  if (await pathExists(join(gitDir, 'MERGE_HEAD'))) return 'merge'
  if (await pathExists(join(gitDir, 'rebase-merge'))) return 'rebase'
  if (await pathExists(join(gitDir, 'rebase-apply'))) return detectRebaseApplyOperation(gitDir)
  if (await pathExists(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (await pathExists(join(gitDir, 'REVERT_HEAD'))) return 'revert'
  if (await pathExists(join(gitDir, 'BISECT_LOG'))) return 'bisect'
  return 'none'
}

// ---------------------------------------------------------------------------
// Core inspect logic
// ---------------------------------------------------------------------------

export interface InspectHandlerDeps {
  /** Injected git runner for testability. Defaults to the confirmed-termination `runGit`. */
  readonly gitRunner?: GitRunnerFn
  /** Workspace repos root. Defaults to WORKSPACE_REPOS_ROOT. */
  readonly reposRoot?: string
  /** Inspection options. */
  readonly options?: {readonly timeoutMs?: number}
  /** Injected clock for testability. Defaults to `() => new Date()`. */
  readonly clock?: () => Date
}

export interface InspectHandlerResult {
  readonly response: InspectSuccess | InspectFailure
  readonly statusCode: 200 | 404 | 409 | 500 | 504
}

function failure(error: InspectErrorCode, statusCode: InspectHandlerResult['statusCode']): InspectHandlerResult {
  const response: InspectFailure = {ok: false, error}
  return {response, statusCode}
}

/**
 * Core inspect logic \u2014 reports the state of an existing checkout without mutating it.
 *
 * 1. Resolves the canonical destination path; a missing/unresolvable path is `no-checkout`.
 * 2. Resolves the checkout's actual git top-level and git-directory (`git rev-parse
 *    --show-toplevel --absolute-git-dir`). A top-level that doesn't match the canonical path, or
 *    a git-directory that resolves outside it, is `checkout-substituted` \u2014 state is never
 *    reported for a substituted or escaped repository.
 * 3. Runs `git status --no-optional-locks --porcelain=v2 --branch` to read HEAD and worktree
 *    state in a single read-only call.
 * 4. Detects an in-progress merge/rebase/am/cherry-pick/revert/bisect from the presence of git's
 *    state files in the resolved git directory \u2014 never from parsing human-readable output.
 */
export async function inspectCheckout(
  request: InspectRequest,
  deps: InspectHandlerDeps = {},
): Promise<InspectHandlerResult> {
  const {gitRunner = runGit, reposRoot = WORKSPACE_REPOS_ROOT, options = {}, clock = () => new Date()} = deps
  const {timeoutMs = DEFAULT_INSPECT_TIMEOUT_MS} = options
  const {owner, repo} = request

  // Resolve the repos root itself first, so the substitution check below compares against the
  // real (symlink-free) root rather than a possibly-symlinked ancestor of it.
  let reposRootResolved: string
  try {
    reposRootResolved = await realpath(reposRoot)
  } catch {
    return failure('inspection-failed', 500)
  }

  const destPath = join(reposRoot, owner, repo)

  let canonicalResolved: string
  try {
    canonicalResolved = await realpath(destPath)
  } catch {
    return failure('no-checkout', 404)
  }

  // Strict equality, not a prefix/"underneath" check: the resolved checkout must be EXACTLY
  // `<resolved reposRoot>/<owner>/<repo>`. A prefix check alone would still accept a symlinked
  // `owner` component, or a repo directory symlinked to a *different* repo that happens to live
  // under the same root — both resolve to a path underneath reposRoot without being the
  // requested checkout.
  const expectedCanonical = join(reposRootResolved, owner, repo)
  if (canonicalResolved !== expectedCanonical) {
    return failure('checkout-substituted', 409)
  }

  const env = buildInspectEnv()

  const topOutcome = await gitRunner(
    gitInvocation(canonicalResolved, ['rev-parse', '--show-toplevel', '--absolute-git-dir']),
    {
      cwd: canonicalResolved,
      env,
      timeoutMs,
    },
  )

  if (topOutcome.kind === 'timeout') return failure('inspection-timeout', 504)
  if (topOutcome.kind === 'failed') return failure('no-checkout', 404)

  const topLines = topOutcome.stdout.trim().split('\n')
  if (topLines.length !== 2) return failure('inspection-failed', 500)
  const [toplevelRaw, gitDirRaw] = topLines
  if (toplevelRaw === undefined || gitDirRaw === undefined || toplevelRaw.length === 0 || gitDirRaw.length === 0) {
    return failure('inspection-failed', 500)
  }

  let toplevelResolved: string
  let gitDirResolved: string
  try {
    toplevelResolved = await realpath(toplevelRaw)
    gitDirResolved = await realpath(gitDirRaw)
  } catch {
    return failure('inspection-failed', 500)
  }

  if (toplevelResolved !== canonicalResolved) return failure('checkout-substituted', 409)

  const gitDirWithinCanonical =
    gitDirResolved === canonicalResolved || gitDirResolved.startsWith(`${canonicalResolved}/`)
  if (gitDirWithinCanonical === false) return failure('checkout-substituted', 409)

  const statusOutcome = await gitRunner(gitInvocation(canonicalResolved, ['status', '--porcelain=v2', '--branch']), {
    cwd: canonicalResolved,
    env,
    timeoutMs,
  })

  if (statusOutcome.kind === 'timeout') return failure('inspection-timeout', 504)
  if (statusOutcome.kind === 'failed') return failure('inspection-failed', 500)

  const parsed = parsePorcelainV2(statusOutcome.stdout)
  if (parsed === null) return failure('inspection-failed', 500)

  const operationInProgress = await detectOperationInProgress(gitDirResolved)

  const observation: CheckoutObservation = {
    head: parsed.head,
    worktree: parsed.worktree,
    operationInProgress,
    observedAt: clock().toISOString(),
  }

  const response: InspectSuccess = {ok: true, observation}
  return {response, statusCode: 200}
}
