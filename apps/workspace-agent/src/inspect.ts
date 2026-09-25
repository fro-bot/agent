/**
 * Inspect handler — reports the state of an EXISTING checkout without mutating it.
 *
 * READ-ONLY INVARIANTS (non-negotiable):
 * 1. Never runs `git clone`, `git fetch`, `git checkout`, or any write/network git command.
 * 2. `git status` is invoked with `--no-optional-locks` so it never writes the refreshed
 *    stat-cache back to the on-disk index (see buildGitInvocation() for the full rationale).
 * 3. Every git invocation neutralizes the code-execution vectors `status` can reach through an
 *    agent-writable `.git/config` / `.gitattributes` / `.git/info/attributes`: `core.fsmonitor`,
 *    `core.hooksPath`, `core.pager`, `credential.helper`, and — enumerated fresh before every
 *    `status` call, since the set of configured names isn't fixed — every `filter.<name>.clean`,
 *    `.smudge`, and `.process` driver, plus `.required` forced to `false`. Submodule recursion is
 *    disabled (`--ignore-submodules=all`) because a submodule's own config/attributes aren't
 *    covered by any of the above. This is a closed list of what's neutralized, not a blanket claim
 *    that inspection can't execute code — anything not on this list is still a candidate to check
 *    before relying on it.
 * 4. No credentials are read, minted, or passed to the git subprocess environment.
 * 5. Every git subprocess has a bounded timeout and is CONFIRMED terminated (we wait for the
 *    child's `close` event, not just for `kill()` to return) before the timeout outcome resolves.
 * 6. A checkout whose git top-level or git-directory resolves outside the canonical path is
 *    rejected as `checkout-substituted` \u2014 state is never reported for a substituted repository.
 * 7. Filter-driver enumeration (invariant 3) fails closed: if it fails, times out, or produces
 *    output this module can't parse, `git status` is never invoked and the call reports
 *    `inspection-failed`. A missed neutralization is worse than a missing observation.
 */

// GIT_SAFETY_ARGS, safeDirectoryArgs, gitInvocation, buildInspectEnv, GitRunnerOptions, GitOutcome,
// GitRunnerFn, the confirmed-termination `runGit` runner, and the filter-driver
// enumeration/neutralization helpers all now live in git-safety.ts, shared with clone.ts's
// `repo-exists` and post-rename race-check validation (and, for `runGit` itself, with clone.ts's
// default `gitRunner`) and with checkout-profile.ts's `checkTempIndexCleanliness` (for the filter
// helpers) -- see that module for the full rationale. Imported below under their original local
// names so nothing else in this file has to change.
import type {FilterEnumerationOutcome, GitOutcome, GitRunnerFn, GitRunnerOptions} from './git-safety.js'
import type {
  CheckoutObservation,
  CheckoutOperation,
  InspectErrorCode,
  InspectFailure,
  InspectRequest,
  InspectSuccess,
} from './types.js'
import {realpath, stat} from 'node:fs/promises'
import {join} from 'node:path'

import {
  buildFilterNeutralizationEnv,
  buildNeutralGitEnv as buildInspectEnv,
  enumerateFilterDrivers,
  gitInvocation,
  runGit,
} from './git-safety.js'
import {AGENT_GID, AGENT_UID} from './identity.js'

/** Root directory where repos are cloned inside the workspace container. Mirrors clone.ts. */
export const WORKSPACE_REPOS_ROOT = '/workspace/repos'

/** Default inspection timeout in milliseconds. Local-only git calls; short by design. */
export const DEFAULT_INSPECT_TIMEOUT_MS = 10_000

export type {FilterEnumerationOutcome, GitOutcome, GitRunnerFn, GitRunnerOptions}
export {runGit}
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
  readonly options?: {
    readonly timeoutMs?: number
    /**
     * Unprivileged uid every git invocation runs as. Defaults to AGENT_UID (identity.ts) —
     * production wiring never needs to override this. Injectable ONLY so local tests (this
     * machine is not root; switching to an arbitrary uid fails) can pass the CURRENT process's
     * own uid instead — see inspect.test.ts for exactly how and why that doesn't weaken the
     * code path under test.
     */
    readonly uid?: number
    /** Unprivileged gid every git invocation runs as. Defaults to AGENT_GID (identity.ts). */
    readonly gid?: number
  }
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
  const {timeoutMs = DEFAULT_INSPECT_TIMEOUT_MS, uid = AGENT_UID, gid = AGENT_GID} = options
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
    gitInvocation(canonicalResolved, canonicalResolved, ['rev-parse', '--show-toplevel', '--absolute-git-dir']),
    {
      cwd: canonicalResolved,
      env,
      timeoutMs,
      uid,
      gid,
    },
  )

  if (topOutcome.kind === 'timeout') return failure('inspection-timeout', 504)
  // Unconfirmed termination must never be reported as the clean, confirmed timeout above — it
  // does not claim the process actually stopped (module header invariant #5).
  if (topOutcome.kind === 'termination-unconfirmed') return failure('inspection-failed', 500)
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

  // Fail closed: enumerate every configured filter driver before `status` ever runs. If this
  // fails, times out, or returns something unparseable, `status` must never be invoked \u2014 an
  // inspection that might execute a planted command is worse than one reporting nothing.
  const filterEnumeration = await enumerateFilterDrivers(canonicalResolved, env, gitRunner, timeoutMs, uid, gid)
  if (filterEnumeration.kind === 'failed') return failure('inspection-failed', 500)

  const statusEnv: Record<string, string> = {...env, ...buildFilterNeutralizationEnv(filterEnumeration.drivers)}

  // `--ignore-submodules=all`: a submodule has its own config/attributes, which the enumeration
  // above does not (and cannot, without recursing) cover, and `status.submoduleSummary` can spawn
  // additional work on top. This means the dirty counts below no longer reflect submodule
  // changes -- see the module header and the report for the trade-off.
  const statusOutcome = await gitRunner(
    gitInvocation(canonicalResolved, canonicalResolved, [
      'status',
      '--porcelain=v2',
      '--branch',
      '--ignore-submodules=all',
    ]),
    {
      cwd: canonicalResolved,
      uid,
      gid,
      env: statusEnv,
      timeoutMs,
    },
  )

  if (statusOutcome.kind === 'timeout') return failure('inspection-timeout', 504)
  if (statusOutcome.kind === 'termination-unconfirmed') return failure('inspection-failed', 500)
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
