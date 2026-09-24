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
// GitRunnerFn, and the confirmed-termination `runGit` runner all now live in git-safety.ts, shared
// with clone.ts's `repo-exists` and post-rename race-check validation (and, for `runGit` itself,
// with clone.ts's default `gitRunner`) — see that module for the full rationale. Imported below
// under their original local names so nothing else in this file has to change.
import type {GitOutcome, GitRunnerFn, GitRunnerOptions} from './git-safety.js'
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

import {buildNeutralGitEnv as buildInspectEnv, gitInvocation, runGit} from './git-safety.js'
import {AGENT_GID, AGENT_UID} from './identity.js'

/** Root directory where repos are cloned inside the workspace container. Mirrors clone.ts. */
export const WORKSPACE_REPOS_ROOT = '/workspace/repos'

/** Default inspection timeout in milliseconds. Local-only git calls; short by design. */
export const DEFAULT_INSPECT_TIMEOUT_MS = 10_000

export type {GitOutcome, GitRunnerFn, GitRunnerOptions}
export {runGit}

// ---------------------------------------------------------------------------
// Filter-driver enumeration and neutralization — closes the vector where `git status` runs
// `filter.<driver>.clean` (and `.process`) on any tracked file whose stat info no longer matches
// the index. The driver command lives in config (any level `git config` reads: system, global,
// local, worktree, and anything pulled in via `include.path`/`includeIf`) and is assigned to
// files via `.gitattributes` or `.git/info/attributes` — both agent-writable between harness
// runs, and neither covered by the fixed `-c` neutralizers above.
// ---------------------------------------------------------------------------

const FILTER_CONFIG_KEY_RE = /^filter\.(.+)\.(?:clean|smudge|process|required)$/

/**
 * Parses `git config -z --get-regexp '^filter\.'` output into the set of configured filter-driver
 * names. `-z` NUL-terminates each record as `key\nvalue\0` so a value containing embedded
 * newlines can never be misread as a record boundary \u2014 not needed for the key itself here, but
 * the key can contain `.` and `=` (valid characters in a git config subsection name), which is
 * exactly why GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> (not `-c`) are used to neutralize them
 * below. The regex is greedy on the driver-name capture, so `filter.evil.dot.clean` yields
 * `evil.dot` (not `evil`) and `filter.evil=x.clean` yields `evil=x` \u2014 confirmed against real git
 * 2.55.0.
 */
function parseFilterDriverNames(stdout: string): ReadonlySet<string> {
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
 * Enumerates every configured `filter.<name>.*` driver so each can be neutralized before `git
 * status` runs. Plain `git config` \u2014 no `--global`/`--system`/`--local`/`--file` \u2014 reads every
 * level `status` itself reads (system, global, local, worktree) and follows `include.path`/
 * `includeIf`, confirmed against real git 2.55.0, so this sees exactly what could assign a driver
 * to a tracked file. `--get-regexp` exits 1 with empty stdout when nothing matches (the common
 * case: no filter drivers configured) \u2014 that is success with an empty set, not a failure.
 *
 * Fails closed: any other non-ok outcome (timeout, non-1 exit, or output this function can't
 * parse as a config record) reports `'failed'`, and the caller must never run `git status` after
 * a `'failed'` result.
 */
async function enumerateFilterDrivers(
  cwd: string,
  env: Record<string, string>,
  gitRunner: GitRunnerFn,
  timeoutMs: number,
  uid: number | undefined,
  gid: number | undefined,
): Promise<FilterEnumerationOutcome> {
  const outcome = await gitRunner(gitInvocation(cwd, cwd, ['config', '-z', '--get-regexp', String.raw`^filter\.`]), {
    cwd,
    env,
    timeoutMs,
    uid,
    gid,
  })
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
 * with an `=` in it (a valid git config subsection name) can't be neutralized that way \u2014 the env
 * mechanism keeps the key and value as separate strings, never joined and re-split. Documented
 * since git 2.31; confirmed present and behaving as documented on git 2.55.0 (the version
 * `deploy/workspace.Dockerfile` installs).
 *
 * For each driver: `clean` and `smudge` are set to the empty string, `process` to the empty
 * string, and `required` to `false`.
 * - Empty `clean`/`process`: confirmed against real git 2.55 that this makes git treat the file as
 *   if no filter were configured for that operation \u2014 no subprocess is spawned. (`smudge` is
 *   never invoked by `git status` \u2014 it only runs on checkout \u2014 but is neutralized too for
 *   defense-in-depth in case a future code path in this module runs a checkout-adjacent command.)
 * - `required=false` is necessary, not optional: with an empty `clean`/`process` but `required`
 *   left at a hostile `true`, `git status` treats the now-unusable filter as a hard error and
 *   exits non-zero (confirmed against real git 2.55) \u2014 the command never executes, but every
 *   inspection of that repo would then fail. Forcing `required=false` gets both no execution and a
 *   successful `status`.
 *
 * KNOWN SIDE EFFECT (see report): with `clean` disabled, a tracked file whose stat info no longer
 * matches the index but whose *content* a real clean filter would normalize back to the committed
 * blob (git-lfs pointers, CRLF normalization, etc.) now compares raw worktree bytes against the
 * index blob instead \u2014 confirmed against real git 2.55 to report such a file as modified even
 * though the tree is semantically clean. A wrong "dirty" label is recoverable; executing a planted
 * command is not, so this is accepted and must be reported, not fixed here.
 */
function buildFilterNeutralizationEnv(drivers: ReadonlySet<string>): Record<string, string> {
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
