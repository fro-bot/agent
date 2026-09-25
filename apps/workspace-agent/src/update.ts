/**
 * Update handler — brings an ELIGIBLE existing checkout up to date with its remote default
 * branch, or refuses/fails with a precise, machine-readable reason. Never runs against an
 * ineligible checkout, and never spends a network round-trip (let alone a credential) confirming
 * that a checkout already known to be ineligible is, in fact, ineligible.
 *
 * SLICE 2a (this file, this shape): the NETWORK-FREE half only — journal reconciliation, the
 * repo mutex, canonical-path containment, layout/config/operation/cleanliness/submodule
 * admission, and the client-abort check before the mutation phase. Every admission check below
 * runs entirely against the LOCAL checkout, as AGENT_UID, with NO fetch, NO bare-repo access, and
 * NO network git profile ever built or spawned — every refusal path returns before
 * `runNetworkAndApply` is ever called.
 *
 * SLICE 2b (not in this file yet): `runNetworkAndApply` currently always returns
 * `{kind: 'failed', reason: 'not-implemented', ...}`. It will be replaced with the bare-repo
 * fetch store, `ls-remote`/fetch against the protected bare repo, ancestry classification, the
 * obstruction preflight, journal `applying`, the `pack-objects | index-pack` stream
 * (git-stream.ts), the `--no-overwrite-ignore` fast-forward merge (`buildLocalUpdateGitProfile`),
 * post-merge re-verification, and journal `applied` -> clear. See the plan's Unit 4 and the
 * "High-Level Technical Design" sequence diagram for the full flow this stub will complete.
 *
 * See docs/plans/2026-09-24-001-feat-workspace-checkout-update-recovery-plan.md, Requirements
 * Trace R1-R6 and Unit 4, for the contract this module implements.
 *
 * ADMISSION ORDER (never reordered — each step refuses without running any later step, and
 * without ever building or spawning the network git profile):
 * 1. Reconcile this repository's journal (journal.ts) — `applying` refuses needs-recovery;
 *    `applied` with HEAD already at the journal's target SHA reconciles to `ready`; `fetched` is
 *    cleared and admission continues; a malformed journal refuses needs-recovery. All under the
 *    per-repo mutex (repo-mutex.ts), so this can never race a concurrent write of the same
 *    journal.
 * 2. Canonical-path containment, exactly as inspect.ts's own check (reused via `inspectCheckout`,
 *    which also supplies HEAD/branch state and in-progress-operation detection in the same call).
 *    A missing checkout with no journal returns the distinct `no-checkout` result, never a
 *    refusal, so the gateway knows to clone first.
 * 3. Layout (`checkCheckoutLayout`).
 * 4. Initialized submodules (`git submodule status`, this module — a leading `-` means
 *    deinitialized/never-initialized; anything else means initialized and refuses). Deliberately
 *    BEFORE the config allowlist: `git submodule init`/`update --init` always writes
 *    `submodule.<name>.url`/`.active` into local config, which the allowlist refuses regardless,
 *    so checking submodules first surfaces the more specific, more actionable reason.
 * 5. The closed config allowlist (`inventoryCheckoutConfig`).
 * 6. In-progress merge/rebase/am/cherry-pick/revert/bisect (from step 2's observation).
 * 7. Temp-index cleanliness against HEAD (`checkTempIndexCleanliness`) — a dirty checkout refuses
 *    with a bounded sample of changed paths, never the full list.
 * 8. Client abort (`AbortSignal`) — checked once, immediately before the network/apply half would
 *    begin, so an already-aborted request never reaches `runNetworkAndApply`.
 */

import type {LayoutRefusalReason, Obstruction} from './checkout-profile.js'
import type {GitRunnerFn} from './git-safety.js'
import type {CheckoutOperation} from './types.js'

import {realpath} from 'node:fs/promises'
import {join} from 'node:path'

import {checkCheckoutLayout, checkTempIndexCleanliness, inventoryCheckoutConfig} from './checkout-profile.js'
import {writeAskpassHelper} from './clone.js'
import {buildNeutralGitEnv, gitInvocation, runGit} from './git-safety.js'
import {AGENT_GID, AGENT_UID, JOURNAL_DIR_NAME, WORKSPACE_STATE_DIR_NAME} from './identity.js'
import {inspectCheckout} from './inspect.js'
import {readJournal, removeJournal} from './journal.js'
import {repoMutexKey, withRepoLock} from './repo-mutex.js'

/** Root directory where repos are cloned inside the workspace container. Mirrors clone.ts/inspect.ts. */
export const WORKSPACE_REPOS_ROOT = '/workspace/repos'

/**
 * Default per-invocation timeout for a local (admission) git subprocess, in milliseconds.
 * Matches the plan's 15-second local budget allocation — applied per call, not cumulatively.
 */
export const DEFAULT_LOCAL_TIMEOUT_MS = 15_000

/**
 * Default budget for the network half (ls-remote + fetch, including one retry), in milliseconds.
 * Unused by slice 2a's admission checks; carried on `UpdateHandlerDeps` so slice 2b's
 * `runNetworkAndApply` has it available without a signature change.
 */
export const DEFAULT_NETWORK_BUDGET_MS = 45_000

/**
 * Default remote base URL a fetch targets. Never caller-provided — always `https://github.com`,
 * exactly like clone.ts's fixed clone URL.
 */
export const DEFAULT_REMOTE_BASE_URL = 'https://github.com'

/**
 * Maximum number of changed paths reported in a `dirty` refusal — a bounded SAMPLE, never a full
 * manifest of a possibly-enormous dirty tree.
 */
export const MAX_DIRTY_SAMPLE_SIZE = 20

/** POST /update request body. */
export interface UpdateRequest {
  readonly owner: string
  readonly repo: string
  /** Installation access token (ghs_*). Used only by the network half (slice 2b); never logged. */
  readonly token: string
}

/** How the checkout's branch tip changed (or didn't) as a result of this update. */
export type UpdateChangeKind = 'fast-forward' | 'unchanged'

/**
 * The checkout was already eligible and is now current — unchanged, or fast-forwarded to the
 * remote tip. Carries CHECKED remote evidence; a `ready` result is never produced from an
 * unchecked or cached observation.
 */
export interface UpdateReady {
  readonly kind: 'ready'
  readonly change: UpdateChangeKind
  readonly branch: string
  readonly sha: string
  /** HEAD before the update, when `change` is `fast-forward`. Omitted when `change` is `unchanged`. */
  readonly fromSha?: string
  /** ISO-8601 timestamp, from an injected clock, when the remote evidence was checked. */
  readonly checkedAt: string
}

/**
 * Every reason `/update` can refuse to run for, closed and final — including the reasons only
 * the network/apply half (slice 2b) can ever actually produce (`detached`, `non-default-branch`,
 * `diverged`, `ahead`, `obstructed`; see the plan's Unit 2 "Policy" fixtures, which document that
 * classifying these is this module's job, not checkout-profile.ts's), so slice 2b never has to
 * widen this union — only implement the branches that currently can't be reached.
 */
export type UpdateRefusalReason =
  | 'needs-recovery'
  | 'checkout-substituted'
  | 'unsupported-layout'
  | 'unsupported-config'
  | 'operation-in-progress'
  | 'dirty'
  | 'submodule-initialized'
  | 'detached'
  | 'non-default-branch'
  | 'diverged'
  | 'ahead'
  | 'obstructed'

/**
 * The checkout is ineligible; no mutation was ever attempted, and NO network profile was ever
 * built or spawned reaching this result — every admission check runs entirely local-only, as
 * AGENT_UID. Discriminated by `reason`, each carrying exactly the detail its refusal reply needs.
 */
export type UpdateRefused =
  | {readonly kind: 'refused'; readonly reason: 'needs-recovery'}
  | {readonly kind: 'refused'; readonly reason: 'checkout-substituted'}
  | {readonly kind: 'refused'; readonly reason: 'unsupported-layout'; readonly layoutReason: LayoutRefusalReason}
  | {readonly kind: 'refused'; readonly reason: 'unsupported-config'; readonly disallowedKeys: readonly string[]}
  | {readonly kind: 'refused'; readonly reason: 'operation-in-progress'; readonly operation: CheckoutOperation}
  | {readonly kind: 'refused'; readonly reason: 'dirty'; readonly changedPaths: readonly string[]}
  | {readonly kind: 'refused'; readonly reason: 'submodule-initialized'; readonly submodules: readonly string[]}
  | {readonly kind: 'refused'; readonly reason: 'detached'}
  | {readonly kind: 'refused'; readonly reason: 'non-default-branch'; readonly branch: string}
  | {readonly kind: 'refused'; readonly reason: 'diverged'}
  | {readonly kind: 'refused'; readonly reason: 'ahead'}
  | {readonly kind: 'refused'; readonly reason: 'obstructed'; readonly obstructions: readonly Obstruction[]}

/**
 * Every reason `/update` can fail for. `'not-implemented'` is slice 2a's own placeholder —
 * `runNetworkAndApply` always returns it today; slice 2b replaces that function's body (never
 * this union's shape at the call site) and will add the fetch/apply failure reasons it needs
 * (auth rejected, host unreachable, rate-limited, remote-moved, apply-failed,
 * termination-unconfirmed) alongside it.
 */
export type UpdateFailureReason =
  /**
   * The client's `AbortSignal` fired before the network/apply half began. Never partway through
   * a mutation in this slice, since slice 2a never starts one.
   */
  | 'aborted'
  /**
   * A local admission check could not determine an answer (a git subprocess timed out, its
   * termination went unconfirmed, or it returned something this module can't parse) and failed
   * closed rather than guessing.
   */
  | 'inspection-failed'
  /** The network/apply half (slice 2b) is not implemented yet. See `runNetworkAndApply`. */
  | 'not-implemented'

/**
 * An attempt was made (or, for slice 2a, admission fully passed and the network/apply half was
 * reached) and did not succeed. `mutationStarted` is `'possibly'` only when subprocess
 * termination itself went unconfirmed — never a synonym for `true`.
 */
export interface UpdateFailed {
  readonly kind: 'failed'
  readonly reason: UpdateFailureReason
  readonly mutationStarted: boolean | 'possibly'
  readonly permanent: boolean
}

/**
 * No checkout exists at this repository's path, and no journal is in flight for it either — the
 * gateway should clone, not update.
 */
export interface UpdateNoCheckout {
  readonly kind: 'no-checkout'
}

/** The discriminated result of a `/update` attempt. Never flags — exactly one of these four shapes. */
export type UpdateResult = UpdateReady | UpdateRefused | UpdateFailed | UpdateNoCheckout

/** Injectable dependencies for `executeUpdate`. Every field has a production-matching default. */
export interface UpdateHandlerDeps {
  /**
   * Injected git runner for testability — and the seam a test spies on to assert the network
   * profile is never spawned during an admission refusal. Defaults to the confirmed-termination
   * `runGit` (git-safety.ts).
   */
  readonly gitRunner?: GitRunnerFn
  /** Workspace repos root. Defaults to WORKSPACE_REPOS_ROOT. */
  readonly reposRoot?: string
  /** Local admission options. */
  readonly options?: {
    readonly timeoutMs?: number
    /**
     * Unprivileged uid every local git invocation runs as. Defaults to AGENT_UID — tests pass
     * the CURRENT process's own uid, exactly like inspect.test.ts/checkout-profile.test.ts,
     * since this developer/CI host can't actually run git as an arbitrary uid.
     */
    readonly uid?: number
    /** Unprivileged gid every local git invocation runs as. Defaults to AGENT_GID. */
    readonly gid?: number
  }
  /** Injected clock for testability. Defaults to `() => new Date()`. */
  readonly now?: () => Date
  /** Base URL the network half fetches from. Defaults to DEFAULT_REMOTE_BASE_URL. Network half only (slice 2b). */
  readonly remoteBaseUrl?: string
  /** Trusted CA bundle path for the network git profile. Network half only (slice 2b). */
  readonly caBundlePath?: string
  /**
   * Writes the GIT_ASKPASS helper for the network profile. Defaults to clone.ts's
   * `writeAskpassHelper`. Network half only (slice 2b).
   */
  readonly askpassWriter?: (dir: string) => Promise<string>
  /** Network budget in milliseconds (ls-remote + fetch, including one retry). Defaults to DEFAULT_NETWORK_BUDGET_MS. Network half only (slice 2b). */
  readonly networkBudgetMs?: number
  /** Client abort signal. Checked once, immediately before the network/apply half would begin. */
  readonly signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Submodule admission — refuses if any submodule is INITIALIZED (has fetched history and/or a
// checked-out working tree), never merely because `.gitmodules` lists one. A fresh, non-recursive
// clone (clone.ts never passes `--recurse-submodules`) never initializes anything; this only ever
// fires for a submodule the agent itself initialized during a run. `git submodule status`'s own
// leading-character convention is the source of truth (Unit 2's policy-profile.test.ts pins it
// against real git): `-` means deinitialized/never-initialized, anything else (` `, `+`, `U`)
// means initialized.
// ---------------------------------------------------------------------------

export type SubmoduleCheckOutcome =
  | {readonly kind: 'ok'}
  | {readonly kind: 'refused'; readonly submodules: readonly string[]}
  | {readonly kind: 'inspection-failed'}

/**
 * Parses `git submodule status` output into (leading-status-char, path) pairs. Never trusts the
 * SHA/describe fields that follow — only the status character and the path matter for this check.
 */
function parseSubmoduleStatusLines(stdout: string): readonly {readonly status: string; readonly path: string}[] {
  const entries: {status: string; path: string}[] = []
  for (const rawLine of stdout.split('\n')) {
    if (rawLine.length === 0) continue
    const status = rawLine.charAt(0)
    // Format: `<status><sha> <path> (<describe>)` — status and sha are adjacent with no
    // separator, so the SHA is index 0 of the space-split remainder and the path is index 1.
    const rest = rawLine.slice(1).trim()
    const path = rest.split(' ')[1]
    if (path === undefined || path.length === 0) continue
    entries.push({status, path})
  }
  return entries
}

async function checkNoInitializedSubmodules(params: {
  readonly checkoutPath: string
  readonly gitRunner: GitRunnerFn
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}): Promise<SubmoduleCheckOutcome> {
  const {checkoutPath, gitRunner, timeoutMs, uid, gid} = params

  let canonical: string
  try {
    canonical = await realpath(checkoutPath)
  } catch {
    return {kind: 'inspection-failed'}
  }

  const env = buildNeutralGitEnv()
  const outcome = await gitRunner(gitInvocation(canonical, canonical, ['submodule', 'status']), {
    cwd: canonical,
    env,
    timeoutMs,
    uid,
    gid,
  })
  if (outcome.kind !== 'ok') return {kind: 'inspection-failed'}

  const initialized = parseSubmoduleStatusLines(outcome.stdout)
    .filter(entry => entry.status !== '-')
    .map(entry => entry.path)
  if (initialized.length > 0) return {kind: 'refused', submodules: initialized}
  return {kind: 'ok'}
}

// ---------------------------------------------------------------------------
// Journal reconciliation — step 1 of admission. Runs under the per-repo mutex (`executeUpdate`
// acquires it before calling this), so this can never race a concurrent write of the same
// journal. See journal.ts's own header and the plan's reconciliation table for the phase
// semantics this implements.
// ---------------------------------------------------------------------------

type JournalReconciliation =
  | {readonly kind: 'refused'; readonly result: UpdateRefused}
  | {readonly kind: 'ready'; readonly result: UpdateReady}
  | {readonly kind: 'failed'; readonly result: UpdateFailed}
  /** No journal was in flight (or an in-flight `fetched` journal was just cleared) — admission continues. */
  | {readonly kind: 'continue'}

const NEEDS_RECOVERY: UpdateRefused = {kind: 'refused', reason: 'needs-recovery'}

async function reconcileUpdateJournal(params: {
  readonly journalsDir: string
  readonly owner: string
  readonly repo: string
  readonly destPath: string
  readonly gitRunner: GitRunnerFn
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
  readonly now: () => Date
}): Promise<JournalReconciliation> {
  const {journalsDir, owner, repo, destPath, gitRunner, timeoutMs, uid, gid, now} = params

  const read = await readJournal(journalsDir, owner, repo)
  if (read.ok === false) {
    if (read.reason === 'malformed') return {kind: 'refused', result: NEEDS_RECOVERY}
    return {kind: 'continue'}
  }

  const journal = read.journal
  // A recovery journal (Unit 5) in flight or interrupted for this repository leaves the checkout
  // in a state update.ts has no basis to trust — refuse the same way an update-journal
  // `applying` phase does, rather than guessing.
  if (journal.kind === 'recovery') return {kind: 'refused', result: NEEDS_RECOVERY}

  if (journal.phase === 'applying') return {kind: 'refused', result: NEEDS_RECOVERY}

  if (journal.phase === 'fetched') {
    // Checkout untouched at H (see the plan's reconciliation table) — clear and start over.
    await removeJournal(journalsDir, owner, repo)
    return {kind: 'continue'}
  }

  // journal.phase === 'applied': the merge completed but the journal was never cleared (a crash
  // between the merge and the clear). Verify HEAD really is at the journal's target SHA and the
  // tree is clean against it before trusting that — otherwise this is exactly the "interrupted
  // mutation reported as nothing changed" failure R6 forbids.
  let canonical: string
  try {
    canonical = await realpath(destPath)
  } catch {
    // The journal says a mutation completed, but the checkout is gone. Can't verify — refuse
    // rather than silently treating an unverifiable claim as either done or absent.
    return {kind: 'refused', result: NEEDS_RECOVERY}
  }

  const env = buildNeutralGitEnv()
  const headOutcome = await gitRunner(gitInvocation(canonical, canonical, ['rev-parse', '--verify', 'HEAD^{commit}']), {
    cwd: canonical,
    env,
    timeoutMs,
    uid,
    gid,
  })
  if (headOutcome.kind !== 'ok') return {kind: 'refused', result: NEEDS_RECOVERY}
  const headSha = headOutcome.stdout.trim()
  if (headSha !== journal.toSha) return {kind: 'refused', result: NEEDS_RECOVERY}

  const cleanliness = await checkTempIndexCleanliness({
    checkoutPath: canonical,
    headSha,
    gitRunner,
    timeoutMs,
    uid,
    gid,
  })
  if (cleanliness.kind !== 'clean') return {kind: 'refused', result: NEEDS_RECOVERY}

  const branchOutcome = await gitRunner(gitInvocation(canonical, canonical, ['symbolic-ref', '--short', 'HEAD']), {
    cwd: canonical,
    env,
    timeoutMs,
    uid,
    gid,
  })
  if (branchOutcome.kind !== 'ok') {
    return {
      kind: 'failed',
      result: {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false},
    }
  }

  await removeJournal(journalsDir, owner, repo)
  return {
    kind: 'ready',
    result: {
      kind: 'ready',
      change: 'fast-forward',
      branch: branchOutcome.stdout.trim(),
      sha: headSha,
      fromSha: journal.fromSha,
      checkedAt: now().toISOString(),
    },
  }
}

// ---------------------------------------------------------------------------
// Network + apply half — NOT IMPLEMENTED in slice 2a. Every admission check above already passed
// by the time this is reached, so any checkout reaching this function is fully eligible; slice 2a
// simply stops here. Slice 2b replaces this function's BODY only — the admission flow above it,
// and every type this module exports, are designed to need no changes when it does.
// ---------------------------------------------------------------------------

/**
 * Context `runNetworkAndApply` needs to complete slice 2b — assembled by `executeUpdate` from
 * validated admission state (an eligible checkout, its observed HEAD/branch, and every injectable
 * dependency `UpdateHandlerDeps` accepts) so slice 2b's implementation never has to re-derive any
 * of it or change `executeUpdate`'s own shape to get it.
 */
interface NetworkAndApplyContext {
  readonly owner: string
  readonly repo: string
  readonly token: string
  readonly canonicalCheckoutPath: string
  readonly branch: string
  readonly headSha: string
  readonly journalsDir: string
  readonly gitRunner: GitRunnerFn
  readonly remoteBaseUrl: string
  readonly caBundlePath: string | undefined
  readonly askpassWriter: (dir: string) => Promise<string>
  readonly networkBudgetMs: number
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
  readonly now: () => Date
  readonly signal: AbortSignal | undefined
}

/**
 * What slice 2b adds here: create the protected bare repo if absent, `ls-remote --symref HEAD` +
 * fetch the default branch (`buildNetworkGitProfile`, using `context.remoteBaseUrl` /
 * `caBundlePath` / `askpassWriter` / `networkBudgetMs`), re-observe and retry once within the
 * network budget, require the local branch to equal the observed default branch, ancestry-check H
 * against T (equal -> `ready`/`unchanged`), the obstruction preflight, journal `applying`, the
 * `pack-objects | index-pack` stream (git-stream.ts), the fast-forward merge
 * (`buildLocalUpdateGitProfile`), post-merge re-verification, and journal `applied` -> clear.
 */
async function runNetworkAndApply(_context: NetworkAndApplyContext): Promise<UpdateResult> {
  return {kind: 'failed', reason: 'not-implemented', mutationStarted: false, permanent: false}
}

/**
 * Brings an eligible checkout up to date, or refuses/fails with a precise reason. See the module
 * header for the full admission order. Every refusal and every `no-checkout`/`inspection-failed`
 * result returns WITHOUT ever building or spawning the network git profile — only a fully
 * eligible checkout, with an unfired abort signal, ever reaches `runNetworkAndApply`.
 */
export async function executeUpdate(request: UpdateRequest, deps: UpdateHandlerDeps = {}): Promise<UpdateResult> {
  const {
    gitRunner = runGit,
    reposRoot = WORKSPACE_REPOS_ROOT,
    options = {},
    now = () => new Date(),
    remoteBaseUrl = DEFAULT_REMOTE_BASE_URL,
    caBundlePath,
    askpassWriter = writeAskpassHelper,
    networkBudgetMs = DEFAULT_NETWORK_BUDGET_MS,
    signal,
  } = deps
  const {timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS, uid = AGENT_UID, gid = AGENT_GID} = options
  const {owner, repo} = request

  const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
  const destPath = join(reposRoot, owner, repo)

  return withRepoLock(repoMutexKey(owner, repo), async (): Promise<UpdateResult> => {
    // Step 1: reconcile this repository's journal before anything else, under the mutex, so it
    // can never race a concurrent write of the same journal.
    const reconciliation = await reconcileUpdateJournal({
      journalsDir,
      owner,
      repo,
      destPath,
      gitRunner,
      timeoutMs,
      uid,
      gid,
      now,
    })
    if (reconciliation.kind !== 'continue') return reconciliation.result

    // Step 2: canonical-path containment, exactly as inspect.ts — reused via `inspectCheckout`,
    // which in the same call also supplies HEAD/branch state and in-progress-operation detection
    // (step 4 below).
    const inspected = await inspectCheckout(
      {owner, repo},
      {gitRunner, reposRoot, options: {timeoutMs, uid, gid}, clock: now},
    )
    if (inspected.response.ok === false) {
      const {error} = inspected.response
      if (error === 'no-checkout') return {kind: 'no-checkout'}
      if (error === 'checkout-substituted') return {kind: 'refused', reason: 'checkout-substituted'}
      // 'inspection-failed' | 'inspection-timeout' — a local check couldn't determine an answer.
      return {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
    }
    const observation = inspected.response.observation

    // Step 3: layout.
    const layout = await checkCheckoutLayout({checkoutPath: destPath, timeoutMs, uid, gid})
    if (layout.kind === 'refused') return {kind: 'refused', reason: 'unsupported-layout', layoutReason: layout.reason}
    if (layout.kind === 'inspection-failed') {
      return {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
    }

    // Step 4: initialized submodules. Deliberately BEFORE the config allowlist (step 5): `git
    // submodule init`/`update --init` always writes `submodule.<name>.url`/`.active` into local
    // config, which the allowlist below refuses regardless — checking submodules first reports
    // the more specific, more actionable `submodule-initialized` reason instead of a generic
    // `unsupported-config` for this common case (confirmed empirically: unsetting those two keys
    // while leaving `.git/modules/<name>` in place makes `git submodule status` itself report the
    // submodule as no longer initialized, so the two checks are inherently coupled — ordering is
    // what decides which refusal reason a caller actually sees).
    const submodules = await checkNoInitializedSubmodules({checkoutPath: destPath, gitRunner, timeoutMs, uid, gid})
    if (submodules.kind === 'refused') {
      return {kind: 'refused', reason: 'submodule-initialized', submodules: submodules.submodules}
    }
    if (submodules.kind === 'inspection-failed') {
      return {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
    }

    // Step 5: the closed config allowlist.
    const configInventory = await inventoryCheckoutConfig({checkoutPath: destPath, gitRunner, timeoutMs, uid, gid})
    if (configInventory.kind === 'refused') {
      return {kind: 'refused', reason: 'unsupported-config', disallowedKeys: configInventory.disallowedKeys}
    }
    if (configInventory.kind === 'inspection-failed') {
      return {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
    }

    // Step 6: in-progress merge/rebase/am/cherry-pick/revert/bisect, from step 2's observation.
    if (observation.operationInProgress !== 'none') {
      return {kind: 'refused', reason: 'operation-in-progress', operation: observation.operationInProgress}
    }

    // Step 7: temp-index cleanliness against HEAD — never the checkout's own (agent-writable)
    // persisted index.
    const cleanliness = await checkTempIndexCleanliness({
      checkoutPath: destPath,
      headSha: observation.head.sha,
      gitRunner,
      timeoutMs,
      uid,
      gid,
    })
    if (cleanliness.kind === 'dirty') {
      return {kind: 'refused', reason: 'dirty', changedPaths: cleanliness.changedPaths.slice(0, MAX_DIRTY_SAMPLE_SIZE)}
    }
    if (cleanliness.kind === 'inspection-failed') {
      return {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
    }

    // Step 8: client abort, checked once, immediately before the network/apply half would begin.
    if (signal?.aborted === true) {
      return {kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false}
    }

    // Admission passed in full — the network/apply half is not implemented in this slice.
    return runNetworkAndApply({
      owner,
      repo,
      token: request.token,
      canonicalCheckoutPath: destPath,
      branch: observation.head.kind === 'attached' ? observation.head.branch : '',
      headSha: observation.head.sha,
      journalsDir,
      gitRunner,
      remoteBaseUrl,
      caBundlePath,
      askpassWriter,
      networkBudgetMs,
      timeoutMs,
      uid,
      gid,
      now,
      signal,
    })
  })
}
