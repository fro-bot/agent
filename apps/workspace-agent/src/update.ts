/**
 * Update handler — brings an ELIGIBLE existing checkout up to date with its remote default
 * branch, or refuses/fails with a precise, machine-readable reason. Never runs against an
 * ineligible checkout, and never spends a network round-trip (let alone a credential) confirming
 * that a checkout already known to be ineligible is, in fact, ineligible.
 *
 * LOCAL ADMISSION (network-free): journal reconciliation, the repo mutex, canonical-path
 * containment, layout/config/operation/cleanliness/submodule admission, and the client-abort
 * check before the network phase. Every admission check below runs entirely against the LOCAL
 * checkout, as AGENT_UID, with NO fetch, NO bare-repo access, and NO network git profile ever
 * built or spawned — every refusal path returns before `runNetworkAndApply` is ever called.
 *
 * NETWORK + APPLY (`runNetworkAndApply`): creates the protected bare fetch store if absent,
 * observes the remote's default branch and tip (`ls-remote --symref`), fetches it into a unique
 * ref with one retry on a moved tip, journals `fetched`, imports the new objects into the
 * checkout via the confirmed-termination pack-stream (git-stream.ts, additive only — no ref/HEAD/
 * working-tree change), classifies ancestry INSIDE THE CHECKOUT (now that both H and T are
 * resolvable there — see that section's own header for why the bare store alone can't do this),
 * and for the "behind" case: runs the obstruction preflight, journals `applying`, re-checks
 * admission (the agent may have changed `.git` during the round-trip), fast-forwards under the
 * sealed local profile, verifies HEAD landed on T, journals `applied`, and clears. See the plan's
 * Unit 4 and the "High-Level Technical Design" sequence diagram for the directional design this
 * adapts (module-internal section headers document exactly where and why).
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

import type {GitProfile, GitRunnerFn} from './git-safety.js'
import type {PackStreamOptions, PackStreamOutcome} from './git-stream.js'
import type {JournalListEntry} from './journal.js'
import type {CheckoutHead, UpdateFailed, UpdateReady, UpdateRefused, UpdateRequest, UpdateResult} from './types.js'

import {randomUUID} from 'node:crypto'
import {lstat, mkdir, mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {performance} from 'node:perf_hooks'
import process from 'node:process'

import {
  checkCheckoutLayout,
  checkTempIndexCleanliness,
  inventoryCheckoutConfig,
  preflightObstructions,
} from './checkout-profile.js'
import {writeAskpassHelper} from './clone.js'
import {
  buildFilterNeutralizationEnv,
  buildLocalUpdateGitProfile,
  buildNetworkGitProfile,
  buildNeutralGitEnv,
  enumerateFilterDrivers,
  gitInvocation,
  runGit,
} from './git-safety.js'
import {runPackStream} from './git-stream.js'
import {AGENT_GID, AGENT_UID, FETCH_STORE_DIR_NAME, JOURNAL_DIR_NAME, WORKSPACE_STATE_DIR_NAME} from './identity.js'
import {inspectCheckout} from './inspect.js'
import {listJournals, readJournal, removeJournal, writeJournal} from './journal.js'
import {markRepoHeld, repoHoldReason, repoMutexKey, withRepoLock} from './repo-mutex.js'

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

/** Default budget for the apply phase (pack import + fast-forward merge), in milliseconds. Matches the plan's 25-second apply allocation. */
export const DEFAULT_APPLY_TIMEOUT_MS = 25_000

/** Default cap on total bytes piped through the pack stream. Generous but bounded — tunable via `UpdateHandlerDeps.maxPackBytes`. */
export const DEFAULT_MAX_PACK_BYTES = 2 * 1024 * 1024 * 1024

/** Default service identity home directory — the root-owned identity that runs every network git operation. Never AGENT_HOME. */
export const DEFAULT_SERVICE_HOME = process.env.HOME ?? '/root'

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
   * Deployment egress-proxy configuration for the network git profile
   * (`buildNetworkGitProfile`'s own `NetworkGitProfileOptions.proxy` — see that type's doc comment:
   * omitting this means NO proxy is used, full stop, even if the process environment carries one).
   * Sourced once at startup (`main.ts`'s `readUpdateNetworkConfig`, config.ts) and passed straight
   * through every `/update` call — this module never reads `process.env` for it itself.
   */
  readonly proxy?: {readonly https: string; readonly noProxy?: string}
  /**
   * Writes the GIT_ASKPASS helper for the network profile. Defaults to clone.ts's
   * `writeAskpassHelper`. Network half only (slice 2b).
   */
  readonly askpassWriter?: (dir: string) => Promise<string>
  /** Network budget in milliseconds (ls-remote + fetch, including one retry). Defaults to DEFAULT_NETWORK_BUDGET_MS. Per-call timeout for every fetch-phase git invocation. */
  readonly networkBudgetMs?: number
  /** Apply-phase budget in milliseconds (pack import + fast-forward merge). Defaults to DEFAULT_APPLY_TIMEOUT_MS. */
  readonly applyTimeoutMs?: number
  /** Cap on total bytes piped through the pack stream. Defaults to DEFAULT_MAX_PACK_BYTES. */
  readonly maxPackBytes?: number
  /** Root-owned service identity's home directory — cwd and HOME/XDG_CONFIG_HOME for every network git invocation. Defaults to DEFAULT_SERVICE_HOME. Never AGENT_HOME. */
  readonly serviceHome?: string
  /**
   * Injected pack-stream runner for testability — the seam a test uses to force a confirmed or
   * unconfirmed termination deterministically, without needing an actual hung subprocess.
   * Defaults to the real `runPackStream` (git-stream.ts).
   */
  readonly packStreamRunner?: (options: PackStreamOptions) => Promise<PackStreamOutcome>
  /** Client abort signal. Honored through the fetch phase; ignored once the apply phase begins (journal `applying`). */
  readonly signal?: AbortSignal
  /**
   * Monotonic clock for the network and apply deadlines (B2) — defaults to `performance.now()`.
   * Tests inject a fake, artificially-advancing clock to prove the cumulative budget
   * deterministically, without needing an actually-slow subprocess.
   */
  readonly monotonicNow?: () => number
  /**
   * Optional logger for operational events that don't fit the discriminated `UpdateResult` —
   * currently only: a fetch subprocess's termination could not be confirmed, so a
   * `refs/fro-bot/fetch/*` ref (or several, across a retry) is deliberately LEFT in the protected
   * bare store rather than risk deleting one a leaked process may still be writing (B1). Defaults
   * to a no-op; the repository is already under a maintenance hold in this case regardless of
   * whether anything is logged.
   */
  readonly logger?: {readonly warn: (msg: string, meta?: Record<string, unknown>) => void}
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
  readonly tracker: InvocationTracker
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}): Promise<JournalReconciliation> {
  const {journalsDir, owner, repo, destPath, tracker, timeoutMs, uid, gid} = params
  const gitRunner = tracker.gitRunner
  // (C2) Gated: a journal from THIS reconciliation must never be cleared while a subprocess this
  // tracker saw may still be live — the caller re-checks `tracker.sawUnconfirmed()` afterward and
  // overrides this function's own return value when that happened, but the journal itself must
  // never be removed here regardless.
  const clearJournal = async (): Promise<void> => {
    if (tracker.sawUnconfirmed()) return
    await removeJournal(journalsDir, owner, repo)
  }

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

  // journal.phase === 'applied' is checked FIRST, via a direct positive narrow (rather than
  // chaining exclusions for 'applying'/'fetched' first) so `journal.appliedAt` below is a plain,
  // reliably-narrowed `string` — TypeScript's discriminated-union narrowing is unambiguous for a
  // positive check against a literal that only one union member can have, even when the OTHER
  // member's own discriminant is itself a small union (`'fetched' | 'applying'`).
  if (journal.phase === 'applied') {
    // The merge completed but the journal was never cleared (a crash between the merge and the
    // clear). Verify HEAD really is at the journal's target SHA and the tree is clean against it
    // before trusting that — otherwise this is exactly the "interrupted mutation reported as
    // nothing changed" failure R6 forbids.
    let canonical: string
    try {
      canonical = await realpath(destPath)
    } catch {
      // The journal says a mutation completed, but the checkout is gone. Can't verify — refuse
      // rather than silently treating an unverifiable claim as either done or absent.
      return {kind: 'refused', result: NEEDS_RECOVERY}
    }

    const env = buildNeutralGitEnv()
    const headOutcome = await gitRunner(
      gitInvocation(canonical, canonical, ['rev-parse', '--verify', 'HEAD^{commit}']),
      {
        cwd: canonical,
        env,
        timeoutMs,
        uid,
        gid,
      },
    )
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

    await clearJournal()
    return {
      kind: 'ready',
      result: {
        kind: 'ready',
        change: 'fast-forward',
        branch: branchOutcome.stdout.trim(),
        sha: headSha,
        fromSha: journal.fromSha,
        // (B7) Carries the journal's OWN `appliedAt` — the moment the merge was actually verified
        // complete — rather than manufacturing a fresh `now()` for evidence collected earlier.
        // `appliedAt` is REQUIRED at phase 'applied' (journal.ts) — there is no legacy journal
        // predating the field to fall back to `now()` for.
        checkedAt: journal.appliedAt,
      },
    }
  }

  if (journal.phase === 'applying') return {kind: 'refused', result: NEEDS_RECOVERY}

  // journal.phase === 'fetched': checkout untouched at H (see the plan's reconciliation table) —
  // clear and start over.
  await clearJournal()
  return {kind: 'continue'}
}

// ---------------------------------------------------------------------------
// Startup journal reconciliation — called once, before the server accepts requests (main.ts).
// Reuses `reconcileUpdateJournal` (above) per repository, under that repository's own mutex, so a
// concurrent request arriving mid-reconciliation can never race the same journal file. Recovery
// journals (`kind: 'recovery'`) are left entirely alone — Unit 5's job, not this one's.
// ---------------------------------------------------------------------------

export interface JournalReconciliationLogger {
  readonly info: (msg: string, meta?: Record<string, unknown>) => void
  readonly warn: (msg: string, meta?: Record<string, unknown>) => void
  readonly error: (msg: string, meta?: Record<string, unknown>) => void
}

export interface ReconcileUpdateJournalsOnStartupDeps {
  readonly reposRoot?: string
  readonly gitRunner?: GitRunnerFn
  readonly options?: {readonly timeoutMs?: number; readonly uid?: number; readonly gid?: number}
  readonly now?: () => Date
  /** Required — every decision this pass makes (cleared, left in place, skipped) is logged. */
  readonly logger: JournalReconciliationLogger
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reconciles every OUTSTANDING update journal exactly once, at startup, before the server accepts
 * requests — the plan's reconciliation table applied at boot instead of lazily at the next
 * `/update` call for each repository. Bounded by construction: `listJournals` is a single
 * directory read (never recurses, never follows a symlink), and every journal's own git calls
 * inherit `options.timeoutMs`'s per-call, confirmed-termination bound (git-safety.ts's `runGit`
 * never hangs past it) — so this resolves in at most
 * `journalCount × (a small fixed number of git calls) × timeoutMs`. Never throws: a directory-
 * level fault (`JournalDirectoryError`) or an unexpected per-journal error is logged and skipped
 * rather than blocking startup.
 */
export async function reconcileUpdateJournalsOnStartup(deps: ReconcileUpdateJournalsOnStartupDeps): Promise<void> {
  const {reposRoot = WORKSPACE_REPOS_ROOT, gitRunner = runGit, options = {}, logger} = deps
  const {timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS, uid = AGENT_UID, gid = AGENT_GID} = options
  const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)

  let entries: readonly JournalListEntry[]
  try {
    entries = await listJournals(journalsDir)
  } catch (error) {
    logger.error('update: startup journal reconciliation could not list journals — leaving all as-is', {
      error: errorMessage(error),
    })
    return
  }

  for (const entry of entries) {
    if (entry.result.ok === false) {
      logger.warn('update: startup reconciliation found a malformed journal — leaving it in place (needs-recovery)', {
        fileName: entry.fileName,
        reason: entry.result.reason,
      })
      continue
    }

    const journal = entry.result.journal
    if (journal.kind === 'recovery') {
      logger.info('update: startup reconciliation skipping a recovery journal (Unit 5)', {
        owner: journal.owner,
        repo: journal.repo,
        phase: journal.phase,
      })
      continue
    }

    const {owner, repo, phase} = journal
    const destPath = join(reposRoot, owner, repo)
    const repoKey = repoMutexKey(owner, repo)
    try {
      await withRepoLock(repoKey, async () => {
        // (C5b) A maintenance hold set by an earlier operation means a subprocess from THAT
        // operation may still be live — never touch this repository's journal while held; only a
        // process restart clears a hold (repo-mutex.ts).
        if (repoHoldReason(repoKey) !== undefined) {
          logger.warn('update: startup reconciliation skipping a repository under maintenance hold', {
            owner,
            repo,
            phase,
          })
          return
        }

        // (C2) One tracker for this repository's reconciliation — any unconfirmed termination it
        // sees, from ANY git call `reconcileUpdateJournal` makes, wins over that call's own return
        // value: the journal must stay in place and the repository must be held.
        const tracker = createInvocationTracker({gitRunner})
        const outcome = await reconcileUpdateJournal({
          journalsDir,
          owner,
          repo,
          destPath,
          tracker,
          timeoutMs,
          uid,
          gid,
        })
        if (tracker.sawUnconfirmed()) {
          markRepoHeld(repoKey, 'termination-unconfirmed')
          logger.warn(
            "update: startup reconciliation's subprocess termination could not be confirmed — holding the repository and leaving its journal in place",
            {owner, repo, phase},
          )
          return
        }
        if (outcome.kind === 'continue' || outcome.kind === 'ready') {
          logger.info('update: startup reconciliation cleared a journal', {owner, repo, phase})
          return
        }
        logger.warn(
          'update: startup reconciliation left a journal in place — the next /update will refuse needs-recovery',
          {
            owner,
            repo,
            phase,
          },
        )
      })
    } catch (error) {
      logger.error('update: startup reconciliation failed unexpectedly for one journal — leaving it in place', {
        owner,
        repo,
        phase,
        error: errorMessage(error),
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Deadlines (review round B, B2) — a SINGLE monotonic budget for a whole sequence of git calls,
// rather than reusing that sequence's overall budget as EACH individual call's own timeoutMs
// (which lets N calls in the sequence consume N times the intended budget: the network phase can
// otherwise spend up to 5x networkBudgetMs across ls-remote/fetch/re-observe/retry-pair, and the
// apply phase up to 2x applyTimeoutMs across the pack import and the merge alone, before even
// counting the re-admission/verification calls around them). `now` is injectable
// (`performance.now()` by default) so a test can prove the cumulative bound deterministically —
// advancing a fake clock — without an actually-slow subprocess. Expiry is checked BEFORE
// dispatching each call in the sequence: an already-expired deadline is refused synchronously,
// never given a fresh allowance. A deadline never cancels work that has already passed its own
// point of no return (e.g. a spawned fast-forward merge) — see runFastForward's own comment.
// ---------------------------------------------------------------------------

export interface Deadline {
  /** Milliseconds remaining, floored at 0 — never negative. */
  readonly remainingMs: () => number
  readonly expired: () => boolean
}

export function createDeadline(budgetMs: number, now: () => number): Deadline {
  const deadlineAt = now() + budgetMs
  return {
    remainingMs: () => Math.max(0, deadlineAt - now()),
    expired: () => now() >= deadlineAt,
  }
}

// ---------------------------------------------------------------------------
// Invocation tracker (review round C, C2/C3) — wraps the injected git runner and pack-stream
// runner for ONE `executeUpdate` invocation (or one journal's startup reconciliation), recording
// centrally whether ANY dispatch through it reported `termination-unconfirmed` — regardless of
// how the immediate caller classified that outcome. Also enforces an optional active-phase
// `Deadline` (C3): every dispatch clamps its OWN requested `timeoutMs` to `remainingMs()` at
// dispatch time, never trusting a snapshot a multi-call helper captured once and reused.
// ---------------------------------------------------------------------------

export interface InvocationTracker {
  readonly gitRunner: GitRunnerFn
  readonly packStreamRunner: (options: PackStreamOptions) => Promise<PackStreamOutcome>
  /** True once ANY dispatch through this tracker reported `termination-unconfirmed`. Sticky. */
  readonly sawUnconfirmed: () => boolean
  /** Installs (or clears, via `undefined`) the active phase deadline every dispatch clamps to. */
  readonly setDeadline: (deadline: Deadline | undefined) => void
  /** Records that this invocation's journal has reached (or passed) the `applying` phase — the point of no return for `mutationStarted` classification ('possibly' vs `false`) on an unconfirmed termination. */
  readonly markApplyingPhase: () => void
  readonly isApplyingPhase: () => boolean
}

export function createInvocationTracker(params: {
  readonly gitRunner: GitRunnerFn
  readonly packStreamRunner?: (options: PackStreamOptions) => Promise<PackStreamOutcome>
}): InvocationTracker {
  const {gitRunner: baseGitRunner, packStreamRunner: basePackStreamRunner = runPackStream} = params
  let unconfirmed = false
  let applyingPhase = false
  let activeDeadline: Deadline | undefined

  // Fresh on EVERY dispatch — never a value a caller computed once and reused across several of
  // its own internal calls (C3).
  const clampTimeout = (requestedTimeoutMs: number): number | 'expired' => {
    if (activeDeadline === undefined) return requestedTimeoutMs
    if (activeDeadline.expired()) return 'expired'
    return Math.min(requestedTimeoutMs, activeDeadline.remainingMs())
  }

  const gitRunner: GitRunnerFn = async (args, options) => {
    const timeoutMs = clampTimeout(options.timeoutMs)
    if (timeoutMs === 'expired') return {kind: 'timeout'}
    const outcome = await baseGitRunner(args, {...options, timeoutMs})
    if (outcome.kind === 'termination-unconfirmed') unconfirmed = true
    return outcome
  }

  const packStreamRunner = async (options: PackStreamOptions): Promise<PackStreamOutcome> => {
    const timeoutMs = clampTimeout(options.timeoutMs)
    if (timeoutMs === 'expired') return {kind: 'timeout'}
    const outcome = await basePackStreamRunner({...options, timeoutMs})
    if (outcome.kind === 'termination-unconfirmed') unconfirmed = true
    return outcome
  }

  return {
    gitRunner,
    packStreamRunner,
    sawUnconfirmed: () => unconfirmed,
    setDeadline: deadline => {
      activeDeadline = deadline
    },
    markApplyingPhase: () => {
      applyingPhase = true
    },
    isApplyingPhase: () => applyingPhase,
  }
}

// ---------------------------------------------------------------------------
// Network + apply half (slice 2b). Every admission check above already passed by the time this is
// reached, so any checkout reaching this function is fully eligible. See the plan's Unit 4
// approach and the "High-Level Technical Design" sequence diagram for the flow this implements —
// adapted in one respect: the obstruction preflight (`preflightObstructions`) reads `toSha`'s tree
// from the CHECKOUT's own object database (see checkout-profile.ts), which does not exist there
// until the pack import has run. So objects are imported (additive-only — no ref, HEAD, or
// working-tree change) BEFORE the preflight, and the journal moves to `applying` only immediately
// before the merge itself, the first step that touches HEAD/refs/the working tree.
// ---------------------------------------------------------------------------

/**
 * Context `runNetworkAndApply` needs — assembled by `executeUpdate` from validated admission state
 * (an eligible checkout, its observed HEAD, and every injectable dependency `UpdateHandlerDeps`
 * accepts).
 */
interface NetworkAndApplyContext {
  readonly owner: string
  readonly repo: string
  readonly token: string
  readonly reposRoot: string
  readonly canonicalCheckoutPath: string
  readonly head: CheckoutHead
  readonly journalsDir: string
  readonly tracker: InvocationTracker
  readonly remoteBaseUrl: string
  readonly caBundlePath: string | undefined
  readonly proxy: {readonly https: string; readonly noProxy?: string} | undefined
  readonly askpassWriter: (dir: string) => Promise<string>
  readonly serviceHome: string
  readonly networkBudgetMs: number
  readonly applyTimeoutMs: number
  readonly maxPackBytes: number
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
  readonly now: () => Date
  readonly signal: AbortSignal | undefined
  readonly monotonicNow: () => number
  readonly logger: {readonly warn: (msg: string, meta?: Record<string, unknown>) => void}
}

/** `<reposRoot>/.workspace-agent/<FETCH_STORE_DIR_NAME>/<owner>__<repo>.git` — matches identity.ts's documented fetch-store naming (the same `<owner>__<repo>` pairing journal.ts uses), a single flat, root-owned directory rather than a per-owner tree needing its own symlink-safety chain. */
export function fetchStorePathFor(reposRoot: string, owner: string, repo: string): string {
  return join(reposRoot, WORKSPACE_STATE_DIR_NAME, FETCH_STORE_DIR_NAME, `${owner}__${repo}.git`)
}

/**
 * Real-directory/symlink/ownership/mode check shared by both the fetch-store path itself and its
 * parent (review round B, B6) — mirrors the protected-dir validation journal.ts's own
 * `checkRealDirectory` uses (and `deploy/scripts/ensure-protected-dir.mjs`'s production posture):
 * only `ENOENT` means absent; a symlink, a non-directory, a wrong owner, or a too-wide mode all
 * fail closed rather than being silently trusted or (for a symlink) followed. Owner is checked
 * only when this process itself is running as root (uid 0) — skipped otherwise, exactly like every
 * other test in this suite that can't actually run git as an arbitrary uid on a dev/CI host.
 */
type ProtectedDirCheck = {readonly kind: 'ok'} | {readonly kind: 'absent'} | {readonly kind: 'failed'}

async function checkProtectedFetchDir(path: string): Promise<ProtectedDirCheck> {
  let st: Awaited<ReturnType<typeof lstat>>
  try {
    st = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {kind: 'absent'}
    return {kind: 'failed'}
  }
  if (st.isSymbolicLink()) return {kind: 'failed'}
  if (!st.isDirectory()) return {kind: 'failed'}
  if (process.getuid?.() === 0 && st.uid !== 0) return {kind: 'failed'}
  // "No wider than 0700": every bit set in the observed mode must also be set in 0700 — 0700,
  // 0600, 0500, ... all pass; 0750/0755/0701 all fail.
  if ((st.mode & 0o777 & ~0o700) !== 0) return {kind: 'failed'}
  return {kind: 'ok'}
}

/**
 * Ensures the protected bare fetch store exists at `fetchStorePath`, creating it (and its parent
 * chain, mode 0700) only when confirmed absent — mirrors journal.ts's directory-safety posture
 * (never chowns/relaxes an existing directory, refuses outright if the target or its parent
 * EXISTS but is a symlink, the wrong type, root-owned-when-this-process-is-root, or wider than
 * mode 0700 — review round B, B6) without duplicating its full implementation, since the fetch
 * store's threat model (a root-owned bare git repo, never journal content) doesn't need the
 * malformed-content parsing journal.ts's checks exist for. `git init --template=` (empty) so a
 * freshly created store never gets git's own sample-hooks template copied into it.
 */
export async function ensureBareFetchStore(params: {
  readonly fetchStorePath: string
  readonly gitRunner: GitRunnerFn
  readonly timeoutMs: number
}): Promise<'ok' | 'failed' | 'unconfirmed'> {
  const {fetchStorePath, gitRunner, timeoutMs} = params

  const existing = await checkProtectedFetchDir(fetchStorePath)
  if (existing.kind === 'ok') return 'ok'
  if (existing.kind === 'failed') return 'failed'

  const parent = dirname(fetchStorePath)
  const parentCheck = await checkProtectedFetchDir(parent)
  if (parentCheck.kind === 'failed') return 'failed'

  try {
    await mkdir(parent, {recursive: true, mode: 0o700})
  } catch {
    return 'failed'
  }

  // (Review round C, C1) `git init --bare` creates ITS OWN target directory, when absent, with a
  // permissive default mode under the PROCESS UMASK — confirmed 0755 under the common 022 umask,
  // never the 0700 `checkProtectedFetchDir` requires. Left to git, every update after the first
  // would find its own store too wide and refuse `fetch-failed` forever. Create the leaf
  // EXCLUSIVELY here instead, with an explicit mode `mkdir(2)` applies directly — an ordinary
  // umask only ever CLEARS bits, and 0700 carries none outside the owner triad, so this is
  // reliably 0700 regardless of the process umask — before `git init --bare` ever touches it.
  // EEXIST is re-validated through `checkProtectedFetchDir`, never chmod'ed: a preexisting store
  // with wider bits is refused outright. Nothing has shipped with the old, git-created-mode
  // store, so there is no wider-mode store in the wild that needs migrating.
  try {
    await mkdir(fetchStorePath, {mode: 0o700})
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'failed'
    const recheck = await checkProtectedFetchDir(fetchStorePath)
    if (recheck.kind !== 'ok') return 'failed'
  }

  const outcome = await gitRunner(['init', '--quiet', '--bare', '--template=', fetchStorePath], {
    cwd: parent,
    env: buildNeutralGitEnv(),
    timeoutMs,
  })
  if (outcome.kind === 'ok') return 'ok'
  if (outcome.kind === 'termination-unconfirmed') return 'unconfirmed'
  return 'failed'
}

/**
 * Every reason a fetch-phase git invocation (`ls-remote`/`fetch`) can fail for, classified from
 * its stderr — captured against the REAL Unit 2/slice-1 `git-http-server` fixture (see
 * update.test.ts's "remote failure classification" describe block for the exact evidence each
 * pattern is proven against): only an explicit 404 (`fatal: repository '...' not found`) or 403
 * (`... error: 403`) is `permanent`; 401 (`fatal: Authentication failed`), 429
 * (`... error: 429`), and connection failure (`Couldn't connect to server` / `Failed to connect`)
 * are not — each is recoverable without any code or config change on this side.
 */
export type RemoteFailureReason =
  | 'fetch-auth-rejected'
  | 'fetch-not-found'
  | 'fetch-forbidden'
  | 'fetch-rate-limited'
  | 'fetch-unreachable'
  | 'fetch-failed'

/**
 * (Review round B, B3) Matches only a COMPLETE, single line of stderr against the two PERMANENT
 * patterns — never an unanchored substring test against the whole blob — and requires that line to
 * name THIS invocation's own `remoteUrl` exactly, trailing slash included (git itself always
 * appends one to the URL it echoes back; confirmed against the real update-fixtures git-http-server
 * fixture, see update.test.ts's "remote failure classification" describe block for the captured
 * wording). Any line starting with `remote:` — git's own verbatim-forwarded sideband text FROM THE
 * SERVER — is skipped entirely before matching: a hostile remote answering with
 * `remote: error: 403 ...` or `remote: fatal: repository '<url>/' not found` in its sideband
 * channel must never be mistaken for git's OWN fatal diagnostic line, which git itself always
 * emits WITHOUT a `remote:` prefix. A 403/404 for a DIFFERENT url, or a real line with trailing
 * junk after the code, is therefore never permanent — ambiguous stderr always classifies
 * non-permanent; permanence is asserted only from positive, exact evidence.
 */
function classifyRemoteFailure(
  stderr: string,
  remoteUrl: string,
): {readonly reason: RemoteFailureReason; readonly permanent: boolean} {
  const urlWithSlash = remoteUrl.endsWith('/') ? remoteUrl : `${remoteUrl}/`
  const notFoundLine = `fatal: repository '${urlWithSlash}' not found`
  const forbiddenLine = `fatal: unable to access '${urlWithSlash}': The requested URL returned error: 403`

  let sawRateLimited = false
  let sawAuthFailed = false
  let sawUnreachable = false
  for (const rawLine of stderr.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.length === 0 || line.startsWith('remote:')) continue
    if (line === notFoundLine) return {reason: 'fetch-not-found', permanent: true}
    if (line === forbiddenLine) return {reason: 'fetch-forbidden', permanent: true}
    if (!line.startsWith('fatal:')) continue
    if (line.includes('error: 429')) sawRateLimited = true
    else if (line.startsWith('fatal: Authentication failed')) sawAuthFailed = true
    else if (line.includes("Couldn't connect to server") || line.includes('Failed to connect')) sawUnreachable = true
  }
  if (sawRateLimited) return {reason: 'fetch-rate-limited', permanent: false}
  if (sawAuthFailed) return {reason: 'fetch-auth-rejected', permanent: false}
  if (sawUnreachable) return {reason: 'fetch-unreachable', permanent: false}
  return {reason: 'fetch-failed', permanent: false}
}

// ---------------------------------------------------------------------------
// Remote observation — ls-remote --symref (default branch + tip) and fetch, both through the
// sealed root-identity network git profile (buildNetworkGitProfile, git-safety.ts). Every call
// here is the ONLY place this module ever dials out, and the ONLY place a credential is ever in
// scope.
// ---------------------------------------------------------------------------

export interface RemoteObservation {
  readonly branch: string
  readonly sha: string
}

export type ObserveOutcome =
  | {readonly kind: 'ok'; readonly observation: RemoteObservation}
  | {readonly kind: 'failed'; readonly reason: RemoteFailureReason; readonly permanent: boolean}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'aborted'}
  /** The subprocess's termination could not be CONFIRMED — distinct from `timeout` (a confirmed kill). */
  | {readonly kind: 'unconfirmed'}

const DEFAULT_BRANCH_SYMREF_RE = /ref: refs\/heads\/(\S+)\s+HEAD/
const HEAD_SHA_LINE_RE = /^([0-9a-f]{40})\tHEAD$/m

/**
 * `GitOutcome`'s `timeout`/`termination-unconfirmed` report EXACTLY the same shape whether a
 * per-call timeout fired or the caller's own `signal` was aborted (git-safety.ts's `runGit` doc
 * comment: "there is no way to distinguish... a caller that needs to know which one happened must
 * track that itself"). Checked AFTER the call resolves, never before — the abort may have fired
 * during the call, not only before it started.
 */
function classifyTimeoutOrAbort(signal: AbortSignal | undefined): 'aborted' | 'timeout' {
  return signal?.aborted === true ? 'aborted' : 'timeout'
}

/** Runs `ls-remote --symref <remoteUrl> HEAD` and parses the remote's default branch name and current tip SHA. */
export async function observeRemoteDefaultBranch(
  profile: GitProfile,
  remoteUrl: string,
  gitRunner: GitRunnerFn,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ObserveOutcome> {
  const outcome = await gitRunner([...profile.args, 'ls-remote', '--symref', remoteUrl, 'HEAD'], {
    cwd: profile.cwd,
    env: profile.env,
    timeoutMs,
    signal,
  })
  if (outcome.kind === 'termination-unconfirmed') return {kind: 'unconfirmed'}
  if (outcome.kind === 'timeout') return {kind: classifyTimeoutOrAbort(signal)}
  if (outcome.kind !== 'ok') {
    const {reason, permanent} = classifyRemoteFailure(outcome.stderr, remoteUrl)
    return {kind: 'failed', reason, permanent}
  }
  const branchMatch = DEFAULT_BRANCH_SYMREF_RE.exec(outcome.stdout)
  const shaMatch = HEAD_SHA_LINE_RE.exec(outcome.stdout)
  if (branchMatch?.[1] === undefined || shaMatch?.[1] === undefined) {
    return {kind: 'failed', reason: 'fetch-failed', permanent: false}
  }
  return {kind: 'ok', observation: {branch: branchMatch[1], sha: shaMatch[1]}}
}

export type FetchIntoRefOutcome =
  | {readonly kind: 'ok'}
  | {readonly kind: 'failed'; readonly reason: RemoteFailureReason; readonly permanent: boolean}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'aborted'}
  /** The subprocess's termination could not be CONFIRMED — distinct from `timeout` (a confirmed kill). */
  | {readonly kind: 'unconfirmed'}

/** Runs `fetch <remoteUrl> <refspec>` — `refspec` may be `<branch>:<localRef>` (creates/updates `localRef`) or a bare SHA (fetches the object without creating a ref; requires the remote to allow SHA1-in-want, exactly as GitHub does). */
export async function fetchIntoRef(
  profile: GitProfile,
  remoteUrl: string,
  refspec: string,
  gitRunner: GitRunnerFn,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<FetchIntoRefOutcome> {
  const outcome = await gitRunner([...profile.args, 'fetch', '--quiet', remoteUrl, refspec], {
    cwd: profile.cwd,
    env: profile.env,
    timeoutMs,
    signal,
  })
  if (outcome.kind === 'termination-unconfirmed') return {kind: 'unconfirmed'}
  if (outcome.kind === 'timeout') return {kind: classifyTimeoutOrAbort(signal)}
  if (outcome.kind !== 'ok') {
    const {reason, permanent} = classifyRemoteFailure(outcome.stderr, remoteUrl)
    return {kind: 'failed', reason, permanent}
  }
  return {kind: 'ok'}
}

interface ObserveAndFetchResult {
  readonly branch: string
  readonly targetSha: string
  readonly uniqueRef: string
}

type ObserveAndFetchOutcome =
  | {readonly kind: 'ok'; readonly result: ObserveAndFetchResult}
  | {readonly kind: 'refused'; readonly result: UpdateRefused}
  | {readonly kind: 'failed'; readonly result: UpdateFailed}

/**
 * Observes the remote's default branch and tip, refuses `detached`/`non-default-branch` before
 * ever fetching object data, then fetches the branch into a fresh unique ref and re-observes to
 * detect a moved tip — retrying the fetch-then-observe pair once (two total attempts) before
 * failing `remote-moved`. Every git invocation runs through the sealed network profile with
 * `deadline.remainingMs()` as its PER-CALL bound (review round B, B2): ONE deadline covers the
 * WHOLE sequence (initial ls-remote, each fetch, each re-observe) instead of each call getting its
 * own fresh `networkBudgetMs` allowance — expiry is checked before every dispatch and reported as
 * `fetch-timeout` without ever starting a new call. Every unique ref this function is ABOUT TO
 * fetch into is registered via `registerFetchRef` BEFORE the fetch is dispatched — including a
 * ref from an attempt that is later superseded by a retry, or that turns out to belong to a
 * failed/aborted attempt (review round B, B1) — so the caller can delete every one of them
 * afterward, not only the ref belonging to the eventual winner.
 */
async function observeAndFetch(params: {
  readonly profile: GitProfile
  readonly remoteUrl: string
  readonly head: CheckoutHead
  readonly gitRunner: GitRunnerFn
  readonly signal: AbortSignal | undefined
  readonly deadline: Deadline
  readonly registerFetchRef: (ref: string) => void
  /** Fired specifically when a FETCH (never a bare ls-remote) subprocess's termination could not be confirmed — the one case where a just-registered ref may still be written by a leaked process. */
  readonly onFetchTerminationUnconfirmed: () => void
}): Promise<ObserveAndFetchOutcome> {
  const {profile, remoteUrl, head, gitRunner, signal, deadline, registerFetchRef, onFetchTerminationUnconfirmed} =
    params

  // A network subprocess whose termination could not be CONFIRMED is never treated the same as a
  // confirmed timeout: the caller (`runNetworkAndApply`) reads `reason` and places the repository
  // under a maintenance hold for exactly this reason — a leaked process may still be running.
  const UNCONFIRMED_RESULT: ObserveAndFetchOutcome = {
    kind: 'failed',
    result: {kind: 'failed', reason: 'termination-unconfirmed', mutationStarted: false, permanent: false},
  }
  const TIMEOUT_RESULT: ObserveAndFetchOutcome = {
    kind: 'failed',
    result: {kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false},
  }

  if (deadline.expired()) return TIMEOUT_RESULT
  const first = await observeRemoteDefaultBranch(profile, remoteUrl, gitRunner, deadline.remainingMs(), signal)
  if (first.kind === 'unconfirmed') return UNCONFIRMED_RESULT
  if (first.kind === 'aborted') {
    return {kind: 'failed', result: {kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false}}
  }
  if (first.kind === 'timeout') return TIMEOUT_RESULT
  if (first.kind === 'failed') {
    return {
      kind: 'failed',
      result: {kind: 'failed', reason: first.reason, mutationStarted: false, permanent: first.permanent},
    }
  }

  if (head.kind === 'detached') return {kind: 'refused', result: {kind: 'refused', reason: 'detached'}}
  if (head.branch !== first.observation.branch) {
    return {kind: 'refused', result: {kind: 'refused', reason: 'non-default-branch', branch: head.branch}}
  }

  let previousSha = first.observation.sha
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (deadline.expired()) return TIMEOUT_RESULT
    const uniqueRef = `refs/fro-bot/fetch/${randomUUID()}`
    registerFetchRef(uniqueRef)
    const fetchOutcome = await fetchIntoRef(
      profile,
      remoteUrl,
      `${first.observation.branch}:${uniqueRef}`,
      gitRunner,
      deadline.remainingMs(),
      signal,
    )
    if (fetchOutcome.kind === 'unconfirmed') {
      onFetchTerminationUnconfirmed()
      return UNCONFIRMED_RESULT
    }
    if (fetchOutcome.kind === 'aborted') {
      return {kind: 'failed', result: {kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false}}
    }
    if (fetchOutcome.kind === 'timeout') return TIMEOUT_RESULT
    if (fetchOutcome.kind === 'failed') {
      return {
        kind: 'failed',
        result: {
          kind: 'failed',
          reason: fetchOutcome.reason,
          mutationStarted: false,
          permanent: fetchOutcome.permanent,
        },
      }
    }

    if (deadline.expired()) return TIMEOUT_RESULT
    const reobserved = await observeRemoteDefaultBranch(profile, remoteUrl, gitRunner, deadline.remainingMs(), signal)
    if (reobserved.kind === 'unconfirmed') return UNCONFIRMED_RESULT
    if (reobserved.kind === 'aborted') {
      return {kind: 'failed', result: {kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false}}
    }
    if (reobserved.kind === 'timeout') return TIMEOUT_RESULT
    if (reobserved.kind === 'failed') {
      return {
        kind: 'failed',
        result: {kind: 'failed', reason: reobserved.reason, mutationStarted: false, permanent: reobserved.permanent},
      }
    }

    if (reobserved.observation.sha === previousSha) {
      return {kind: 'ok', result: {branch: first.observation.branch, targetSha: reobserved.observation.sha, uniqueRef}}
    }
    previousSha = reobserved.observation.sha
  }

  return {kind: 'failed', result: {kind: 'failed', reason: 'remote-moved', mutationStarted: false, permanent: false}}
}

// ---------------------------------------------------------------------------
// Ancestry — classified INSIDE THE CHECKOUT, after the object import below, never from the bare
// fetch store. H is a LOCAL commit the remote may never have seen at all (the ordinary "ahead"
// case: the agent committed locally without pushing) — the bare store has no basis to resolve it,
// and no remote (not even GitHub) can be asked to fetch an object it was never given. The checkout
// is the only repository guaranteed to already hold H; importing T's objects into it (additive
// only, see below) is what makes ancestry decidable at all for every case, not only "behind".
// ---------------------------------------------------------------------------

async function shaPresentInBare(
  bareRepoPath: string,
  sha: string,
  gitRunner: GitRunnerFn,
  timeoutMs: number,
): Promise<boolean> {
  const outcome = await gitRunner(['--git-dir', bareRepoPath, 'cat-file', '-e', `${sha}^{commit}`], {
    cwd: bareRepoPath,
    env: buildNeutralGitEnv(),
    timeoutMs,
  })
  return outcome.kind === 'ok'
}

type AncestryKind = 'equal' | 'behind' | 'ahead' | 'diverged'

/**
 * `git merge-base --is-ancestor` in the checkout: exit 0 = ancestor, exit 1 = not an ancestor
 * (informative, not a failure), anything else = inspection-failed.
 *
 * (Review round B, B4) Runs under `buildLocalUpdateGitProfile`'s settings — the same sealed,
 * no-transport, `GIT_NO_REPLACE_OBJECTS=1`/`GIT_NO_LAZY_FETCH=1` profile the merge itself uses —
 * with `core.commitGraph=false` additionally forced, rather than the plain `buildNeutralGitEnv()`
 * this call used before: a replace ref (`refs/replace/<sha>`) planted in the agent-writable
 * checkout, or a stale/hostile commit-graph file, could otherwise silently substitute a different
 * commit's ancestry for the real one. This closes the specific gap where ancestry was classified
 * WITHOUT the local update profile's own hardening, even though the merge right after it always
 * ran with it. It reduces ambiguity but is not, and cannot be, a defense against CONCURRENT
 * hostile mutation of the checkout by the agent — the worst case remains uid-10001 checkout
 * integrity loss the agent could already cause on its own, which is exactly why the merge itself
 * re-evaluates ancestry under this same local profile rather than trusting this result blindly.
 */
async function classifyAncestryInCheckout(params: {
  readonly canonicalCheckoutPath: string
  readonly fromSha: string
  readonly toSha: string
  readonly gitRunner: GitRunnerFn
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}): Promise<AncestryKind | 'inspection-failed'> {
  const {canonicalCheckoutPath, fromSha, toSha, gitRunner, timeoutMs, uid, gid} = params
  if (fromSha === toSha) return 'equal'
  const profile = buildLocalUpdateGitProfile({checkoutPath: canonicalCheckoutPath})
  const args = [...profile.args, '-c', 'core.commitGraph=false']
  const isAncestor = async (a: string, b: string): Promise<boolean | 'inspection-failed'> => {
    const outcome = await gitRunner([...args, 'merge-base', '--is-ancestor', a, b], {
      cwd: profile.cwd,
      env: profile.env,
      timeoutMs,
      uid,
      gid,
    })
    if (outcome.kind === 'ok') return true
    if (outcome.kind === 'failed' && outcome.code === 1) return false
    return 'inspection-failed'
  }
  const behind = await isAncestor(fromSha, toSha)
  if (behind === 'inspection-failed') return 'inspection-failed'
  if (behind) return 'behind'
  const ahead = await isAncestor(toSha, fromSha)
  if (ahead === 'inspection-failed') return 'inspection-failed'
  return ahead ? 'ahead' : 'diverged'
}

// ---------------------------------------------------------------------------
// Object import — pack-objects (root, bare store) | index-pack (AGENT_UID, checkout), via
// git-stream.ts's confirmed-termination two-process pipe. ADDITIVE ONLY: writes packed objects
// into the checkout's odb, touches no ref, no HEAD, no working tree, no index. This is what makes
// `toSha` resolvable for the obstruction preflight below, without ever using a local fetch or
// alternates (see the plan's "Objects cross as a pack stream" decision).
// ---------------------------------------------------------------------------

type PhaseOutcome = {readonly kind: 'ok'} | {readonly kind: 'failed'; readonly result: UpdateFailed}

async function importPackObjects(params: {
  readonly bareRepoPath: string
  readonly canonicalCheckoutPath: string
  /** H, excluded from the pack when present in the bare store (the ordinary "behind" case: a delta, not the full closure). Undefined — or absent from the bare store — packs the FULL closure of `toSha`, since a commit the remote never received can't be excluded from a pack built from the remote's own objects. */
  readonly fromShaIfKnownToBare: string | undefined
  readonly toSha: string
  readonly packStreamRunner: (options: PackStreamOptions) => Promise<PackStreamOutcome>
  readonly maxPackBytes: number
  readonly applyTimeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}): Promise<PhaseOutcome> {
  const {
    bareRepoPath,
    canonicalCheckoutPath,
    fromShaIfKnownToBare,
    toSha,
    packStreamRunner,
    maxPackBytes,
    applyTimeoutMs,
    uid,
    gid,
  } = params

  const revs = fromShaIfKnownToBare === undefined ? `${toSha}\n` : `${toSha}\n^${fromShaIfKnownToBare}\n`

  const outcome = await packStreamRunner({
    writer: {
      command: 'git',
      args: ['--git-dir', bareRepoPath, 'pack-objects', '--quiet', '--revs', '--stdout'],
      cwd: bareRepoPath,
      env: buildNeutralGitEnv(),
      stdin: revs,
    },
    reader: {
      command: 'git',
      args: [...gitInvocation(canonicalCheckoutPath, canonicalCheckoutPath, ['index-pack', '--stdin', '--strict'])],
      cwd: canonicalCheckoutPath,
      env: {...buildNeutralGitEnv(), GIT_ALLOW_PROTOCOL: ''},
      uid,
      gid,
    },
    maxBytes: maxPackBytes,
    timeoutMs: applyTimeoutMs,
  })

  if (outcome.kind === 'ok') return {kind: 'ok'}
  if (outcome.kind === 'termination-unconfirmed') {
    return {
      kind: 'failed',
      result: {kind: 'failed', reason: 'termination-unconfirmed', mutationStarted: 'possibly', permanent: false},
    }
  }
  // 'timeout' (confirmed-terminated) or 'failed' (writer-failed/reader-failed/byte-cap-exceeded/
  // spawn-failed): `index-pack` publishes objects only via an atomic rename on success, so a
  // confirmed non-success here never leaves a partially-written object in the checkout's odb —
  // nothing observable was mutated.
  return {kind: 'failed', result: {kind: 'failed', reason: 'apply-failed', mutationStarted: false, permanent: false}}
}

// ---------------------------------------------------------------------------
// Re-verification — re-observes the checkout's HEAD/branch/operation state and compares it
// against what admission (or the very start of this network round-trip) actually saw. The agent
// may have changed `.git` at any point during a network round-trip; every place that is about to
// either (a) trust a PREVIOUSLY-observed H without re-checking it, or (b) launch the
// fast-forward merge, re-verifies FIRST via this shared check.
// ---------------------------------------------------------------------------

type ReverifyOutcome = 'ok' | 'drifted' | 'inspection-failed'

async function reverifyCheckoutState(params: {
  readonly owner: string
  readonly repo: string
  readonly reposRoot: string
  readonly branch: string
  readonly fromSha: string
  readonly gitRunner: GitRunnerFn
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
  readonly now: () => Date
}): Promise<ReverifyOutcome> {
  const {owner, repo, reposRoot, branch, fromSha, gitRunner, timeoutMs, uid, gid, now} = params
  const reinspected = await inspectCheckout(
    {owner, repo},
    {gitRunner, reposRoot, options: {timeoutMs, uid, gid}, clock: now},
  )
  if (reinspected.response.ok !== true) return 'inspection-failed'
  const {observation} = reinspected.response
  if (observation.operationInProgress !== 'none') return 'drifted'
  if (observation.head.kind !== 'attached') return 'drifted'
  if (observation.head.branch !== branch) return 'drifted'
  if (observation.head.sha !== fromSha) return 'drifted'
  return 'ok'
}

/**
 * Confirms the checkout landed EXACTLY where the merge claims: HEAD at `toSha`, still on the
 * admitted `branch` (a fast-forward never changes which branch is checked out, but this confirms
 * it rather than assuming it), and clean against `toSha`. Any one of these failing means the
 * merge's own confirmed exit is not the whole story — R6 forbids reporting success without this.
 */
async function verifyPostMergeState(params: {
  readonly canonicalCheckoutPath: string
  readonly branch: string
  readonly toSha: string
  readonly gitRunner: GitRunnerFn
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}): Promise<boolean> {
  const {canonicalCheckoutPath, branch, toSha, gitRunner, timeoutMs, uid, gid} = params
  const env = buildNeutralGitEnv()

  const headOutcome = await gitRunner(
    gitInvocation(canonicalCheckoutPath, canonicalCheckoutPath, ['rev-parse', '--verify', 'HEAD^{commit}']),
    {cwd: canonicalCheckoutPath, env, timeoutMs, uid, gid},
  )
  if (headOutcome.kind !== 'ok' || headOutcome.stdout.trim() !== toSha) return false

  const branchOutcome = await gitRunner(
    gitInvocation(canonicalCheckoutPath, canonicalCheckoutPath, ['symbolic-ref', '--short', 'HEAD']),
    {cwd: canonicalCheckoutPath, env, timeoutMs, uid, gid},
  )
  if (branchOutcome.kind !== 'ok' || branchOutcome.stdout.trim() !== branch) return false

  const cleanliness = await checkTempIndexCleanliness({
    checkoutPath: canonicalCheckoutPath,
    headSha: toSha,
    gitRunner,
    timeoutMs,
    uid,
    gid,
  })
  return cleanliness.kind === 'clean'
}

// ---------------------------------------------------------------------------
// The fast-forward merge itself — the point of no return. Called only once the journal already
// reads `applying` (set by the caller before the object import above) and the obstruction
// preflight has passed. Re-runs layout/config/cleanliness/submodule/head-branch-SHA admission
// immediately before mutating — the agent may have changed `.git` during the network round-trip —
// then `merge --ff-only --no-overwrite-ignore` under the sealed LOCAL profile, then verifies via
// `verifyPostMergeState` before ever clearing the journal.
//
// mutationStarted / journal disposition split exactly at the merge command itself: every pre-merge
// re-admission check runs against an UNCHANGED checkout (the object import above is additive-only,
// touching no ref/HEAD/working-tree state) — a failure there clears the journal and reports
// `mutationStarted: false`. Once the merge command is actually spawned, any subsequent failure
// (confirmed non-zero exit, `termination-unconfirmed`, or a failed post-merge verification) LEAVES
// the journal at `applying`: once a mutation may have started, an interrupted or unconfirmed
// attempt is never reported as "nothing changed" (R6).
// ---------------------------------------------------------------------------

async function runFastForward(params: {
  readonly journalsDir: string
  readonly owner: string
  readonly repo: string
  readonly reposRoot: string
  readonly canonicalCheckoutPath: string
  readonly fromSha: string
  readonly toSha: string
  readonly branch: string
  readonly tracker: InvocationTracker
  /** (B2) One shared apply deadline — covers every call below, not a fresh full allowance per call. */
  readonly deadline: Deadline
  readonly uid: number | undefined
  readonly gid: number | undefined
  readonly now: () => Date
}): Promise<UpdateResult> {
  const {
    journalsDir,
    owner,
    repo,
    reposRoot,
    canonicalCheckoutPath,
    fromSha,
    toSha,
    branch,
    tracker,
    deadline,
    uid,
    gid,
    now,
  } = params
  const gitRunner = tracker.gitRunner

  // Pre-merge: the checkout is still UNCHANGED (the object import is additive-only) — any failure
  // here clears the journal and reports mutationStarted:false, never `true`. Gated: never clears
  // while `tracker` has seen an unconfirmed termination anywhere in this invocation.
  const preMergeFailed = async (): Promise<UpdateFailed> => {
    if (!tracker.sawUnconfirmed()) await removeJournal(journalsDir, owner, repo)
    return {kind: 'failed', reason: 'apply-failed', mutationStarted: false, permanent: false}
  }

  if (deadline.expired()) return preMergeFailed()

  const layout = await checkCheckoutLayout({
    checkoutPath: canonicalCheckoutPath,
    timeoutMs: deadline.remainingMs(),
    uid,
    gid,
  })
  if (layout.kind !== 'ok') return preMergeFailed()

  const configInventory = await inventoryCheckoutConfig({
    checkoutPath: canonicalCheckoutPath,
    gitRunner,
    timeoutMs: deadline.remainingMs(),
    uid,
    gid,
  })
  if (configInventory.kind !== 'allowed') return preMergeFailed()

  const cleanliness = await checkTempIndexCleanliness({
    checkoutPath: canonicalCheckoutPath,
    headSha: fromSha,
    gitRunner,
    timeoutMs: deadline.remainingMs(),
    uid,
    gid,
  })
  if (cleanliness.kind !== 'clean') return preMergeFailed()

  const submodules = await checkNoInitializedSubmodules({
    checkoutPath: canonicalCheckoutPath,
    gitRunner,
    timeoutMs: deadline.remainingMs(),
    uid,
    gid,
  })
  if (submodules.kind !== 'ok') return preMergeFailed()

  const reverify = await reverifyCheckoutState({
    owner,
    repo,
    reposRoot,
    branch,
    fromSha,
    gitRunner,
    timeoutMs: deadline.remainingMs(),
    uid,
    gid,
    now,
  })
  if (reverify !== 'ok') return preMergeFailed()

  // (B5) Admission already refuses a checkout carrying any configured filter.* driver, and the
  // config-inventory re-check just above re-confirms that immediately before this point — but the
  // agent could still write one into the (agent-writable) local config in the narrow gap between
  // that re-check and the merge actually being spawned. Enumerate and neutralize for the merge
  // invocation itself too, the same way checkTempIndexCleanliness/inspect already do for their own
  // working-tree-reading calls. Fails closed: an enumeration failure is a pre-merge failure, never
  // a reason to run the merge unneutralized.
  const localProfile = buildLocalUpdateGitProfile({checkoutPath: canonicalCheckoutPath})
  const filterEnumeration = await enumerateFilterDrivers(
    canonicalCheckoutPath,
    buildNeutralGitEnv(),
    gitRunner,
    deadline.remainingMs(),
    uid,
    gid,
  )
  if (filterEnumeration.kind !== 'ok') return preMergeFailed()
  const mergeEnv = {...localProfile.env, ...buildFilterNeutralizationEnv(filterEnumeration.drivers)}

  if (deadline.expired()) return preMergeFailed()

  // Point of no return — every failure below LEAVES the journal at `applying`.
  const mergeOutcome = await gitRunner([...localProfile.args, 'merge', '--ff-only', '--no-overwrite-ignore', toSha], {
    cwd: localProfile.cwd,
    env: mergeEnv,
    timeoutMs: deadline.remainingMs(),
    uid,
    gid,
  })
  if (mergeOutcome.kind === 'termination-unconfirmed') {
    return {kind: 'failed', reason: 'termination-unconfirmed', mutationStarted: 'possibly', permanent: false}
  }
  const POST_MERGE_FAILED: UpdateFailed = {
    kind: 'failed',
    reason: 'apply-failed',
    mutationStarted: true,
    permanent: false,
  }
  if (mergeOutcome.kind !== 'ok') return POST_MERGE_FAILED

  const verified = await verifyPostMergeState({
    canonicalCheckoutPath,
    branch,
    toSha,
    gitRunner,
    timeoutMs: deadline.remainingMs(),
    uid,
    gid,
  })
  if (verified !== true) return POST_MERGE_FAILED

  const appliedAt = now().toISOString()
  await writeJournal(journalsDir, {
    kind: 'update',
    owner,
    repo,
    phase: 'applied',
    fromSha,
    toSha,
    startedAt: appliedAt,
    appliedAt,
  })
  if (!tracker.sawUnconfirmed()) await removeJournal(journalsDir, owner, repo)

  return {kind: 'ready', change: 'fast-forward', branch, sha: toSha, fromSha, checkedAt: appliedAt}
}

/**
 * The network + apply half. Every admission check in `executeUpdate` has already passed by the
 * time this runs, so `context.head`/`context.canonicalCheckoutPath` describe a fully eligible
 * checkout. See the module header's "Network + apply half" section for the phase-by-phase design
 * and the journal-phase interpretation this implements.
 */
async function runNetworkAndApply(context: NetworkAndApplyContext): Promise<UpdateResult> {
  const {
    owner,
    repo,
    token,
    reposRoot,
    canonicalCheckoutPath,
    head,
    journalsDir,
    tracker,
    remoteBaseUrl,
    caBundlePath,
    proxy,
    askpassWriter,
    serviceHome,
    networkBudgetMs,
    applyTimeoutMs,
    maxPackBytes,
    timeoutMs,
    uid,
    gid,
    now,
    signal,
    monotonicNow,
    logger,
  } = context
  // (C2/C3) Every git/pack-stream call below goes through the tracker, never the raw runner — so
  // termination uncertainty anywhere is recorded centrally, and the active phase deadline
  // (installed below) clamps every dispatch to its true remaining time.
  const gitRunner = tracker.gitRunner
  const packStreamRunner = tracker.packStreamRunner
  const clearJournal = async (): Promise<void> => {
    if (tracker.sawUnconfirmed()) return
    await removeJournal(journalsDir, owner, repo)
  }

  const fetchStorePath = fetchStorePathFor(reposRoot, owner, repo)
  const storeReady = await ensureBareFetchStore({fetchStorePath, gitRunner, timeoutMs})
  if (storeReady === 'unconfirmed') {
    return {kind: 'failed', reason: 'termination-unconfirmed', mutationStarted: false, permanent: false}
  }
  if (storeReady === 'failed') {
    return {kind: 'failed', reason: 'fetch-failed', mutationStarted: false, permanent: false}
  }

  const askpassDir = await mkdtemp(join(tmpdir(), 'workspace-agent-update-askpass-'))
  // (B1) Every unique ref `observeAndFetch` is ABOUT TO fetch into is registered here BEFORE the
  // fetch is dispatched — including a ref from a retried or failed attempt, not only the eventual
  // winner — so every one of them is deleted below, not just the last. `fetchTerminationUnconfirmed`
  // gates that cleanup: a fetch subprocess whose termination could not be confirmed may still be
  // writing its ref, so in that case every registered ref is deliberately LEFT and logged instead.
  const registeredFetchRefs: string[] = []
  let fetchTerminationUnconfirmed = false
  try {
    const askpassPath = await askpassWriter(askpassDir)
    const networkProfile = buildNetworkGitProfile({
      bareRepoPath: fetchStorePath,
      serviceHome,
      askpassPath,
      token,
      caBundlePath,
      proxy,
      parentEnv: process.env,
    })
    const remoteUrl = `${remoteBaseUrl}/${owner}/${repo}.git`
    const fromSha = head.sha

    // (B2) One network deadline covers the WHOLE ls-remote/fetch/re-observe/retry sequence — never
    // a fresh networkBudgetMs allowance per call.
    const networkDeadline = createDeadline(networkBudgetMs, monotonicNow)
    tracker.setDeadline(networkDeadline)
    const observed = await observeAndFetch({
      profile: networkProfile,
      remoteUrl,
      head,
      gitRunner,
      signal,
      deadline: networkDeadline,
      registerFetchRef: ref => registeredFetchRefs.push(ref),
      onFetchTerminationUnconfirmed: () => {
        fetchTerminationUnconfirmed = true
      },
    })
    if (observed.kind !== 'ok') return observed.result
    const {branch, targetSha} = observed.result

    await writeJournal(journalsDir, {
      kind: 'update',
      owner,
      repo,
      phase: 'fetched',
      fromSha,
      toSha: targetSha,
      startedAt: now().toISOString(),
    })

    // Last chance to honor a client abort before any checkout-touching activity begins — ignored
    // from here on (journal moves to `applying` next, and stays honored-blind through the rest of
    // this function: "once the journal records applying, the workspace runs the mutation to
    // completion or confirmed termination regardless of the disconnect").
    if (signal?.aborted === true) {
      await clearJournal()
      return {kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false}
    }

    await writeJournal(journalsDir, {
      kind: 'update',
      owner,
      repo,
      phase: 'applying',
      fromSha,
      toSha: targetSha,
      startedAt: now().toISOString(),
    })
    // (C2) The point of no return for `mutationStarted` classification on an unconfirmed
    // termination: from here on it is reported as 'possibly', never `false`.
    tracker.markApplyingPhase()

    // (B2) One apply deadline covers EVERYTHING from here through the end of runFastForward — the
    // pack import, ancestry classification, the obstruction preflight, every pre-merge
    // re-admission re-check, the merge itself, and post-merge verification — instead of each step
    // separately consuming a fresh full applyTimeoutMs allowance.
    const applyDeadline = createDeadline(applyTimeoutMs, monotonicNow)
    tracker.setDeadline(applyDeadline)

    // H may be a LOCAL commit the remote has never seen (the "ahead" case) — pack the full closure
    // of T when the bare store doesn't already have H, never a delta built against an object that
    // isn't there.
    const hKnownToBare = await shaPresentInBare(fetchStorePath, fromSha, gitRunner, applyDeadline.remainingMs())
    if (applyDeadline.expired()) {
      await clearJournal()
      return {kind: 'failed', reason: 'apply-failed', mutationStarted: false, permanent: false}
    }
    const imported = await importPackObjects({
      bareRepoPath: fetchStorePath,
      canonicalCheckoutPath,
      fromShaIfKnownToBare: hKnownToBare ? fromSha : undefined,
      toSha: targetSha,
      packStreamRunner,
      maxPackBytes,
      applyTimeoutMs: applyDeadline.remainingMs(),
      uid,
      gid,
    })
    if (imported.kind === 'failed') {
      if (imported.result.reason !== 'termination-unconfirmed') await clearJournal()
      return imported.result
    }

    // T's objects are now resolvable in the checkout — alongside H, which the checkout always
    // already had — so ancestry can finally be decided, for every case, not only "behind".
    const ancestry = await classifyAncestryInCheckout({
      canonicalCheckoutPath,
      fromSha,
      toSha: targetSha,
      gitRunner,
      timeoutMs: applyDeadline.remainingMs(),
      uid,
      gid,
    })
    if (ancestry === 'inspection-failed') {
      // A CONCLUSIVE exit before the merge has ever launched: the checkout is still unchanged
      // (the import above is additive-only) — clear the journal rather than forcing recovery for
      // what may be a transient read failure.
      await clearJournal()
      return {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
    }
    if (ancestry === 'equal') {
      // H already equals T — but H was observed at ADMISSION time, before this entire network
      // round-trip. Re-verify the checkout hasn't drifted underneath us before trusting it.
      const reverify = await reverifyCheckoutState({
        owner,
        repo,
        reposRoot,
        branch,
        fromSha,
        gitRunner,
        timeoutMs: applyDeadline.remainingMs(),
        uid,
        gid,
        now,
      })
      if (reverify !== 'ok') {
        await clearJournal()
        return {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
      }

      // (Review round C, C4) Re-verifying branch/HEAD/operation state is not enough on its own to
      // report `unchanged` ready — a dirty checkout must never be reported ready just because the
      // remote tip matches H. Fresh cleanliness against T (== H here) closes the seam where the
      // agent could have dirtied the tree during this entire network round-trip.
      const cleanliness = await checkTempIndexCleanliness({
        checkoutPath: canonicalCheckoutPath,
        headSha: targetSha,
        gitRunner,
        timeoutMs: applyDeadline.remainingMs(),
        uid,
        gid,
      })
      if (cleanliness.kind === 'inspection-failed') {
        await clearJournal()
        return {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
      }
      if (cleanliness.kind === 'dirty') {
        // No merge ran — clear the journal exactly like any other pre-merge refusal.
        await clearJournal()
        return {
          kind: 'refused',
          reason: 'dirty',
          changedPaths: cleanliness.changedPaths.slice(0, MAX_DIRTY_SAMPLE_SIZE),
        }
      }

      await clearJournal()
      return {kind: 'ready', change: 'unchanged', branch, sha: fromSha, checkedAt: now().toISOString()}
    }
    if (ancestry === 'ahead') {
      await clearJournal()
      return {kind: 'refused', reason: 'ahead'}
    }
    if (ancestry === 'diverged') {
      await clearJournal()
      return {kind: 'refused', reason: 'diverged'}
    }

    // ancestry === 'behind'
    const preflight = await preflightObstructions({
      checkoutPath: canonicalCheckoutPath,
      fromSha,
      toSha: targetSha,
      gitRunner,
      timeoutMs: applyDeadline.remainingMs(),
      uid,
      gid,
    })
    if (preflight.kind === 'obstructed') {
      await clearJournal()
      return {kind: 'refused', reason: 'obstructed', obstructions: preflight.obstructions}
    }
    if (preflight.kind === 'inspection-failed') {
      // Same rationale as the ancestry inspection-failed case above: conclusive, pre-merge, checkout
      // still unchanged — clear the journal.
      await clearJournal()
      return {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
    }

    return await runFastForward({
      journalsDir,
      owner,
      repo,
      reposRoot,
      canonicalCheckoutPath,
      fromSha,
      toSha: targetSha,
      branch,
      tracker,
      deadline: applyDeadline,
      uid,
      gid,
      now,
    })
  } finally {
    // (C3) Clear the active phase deadline before any further dispatch — the ref cleanup below
    // uses its own flat `timeoutMs`, not the apply budget, and must never be refused outright just
    // because the apply phase itself already ran out of time.
    tracker.setDeadline(undefined)
    await rm(askpassDir, {recursive: true, force: true}).catch(() => {})
    // (B1) Only delete the registered refs once every fetch subprocess is CONFIRMED terminated —
    // never while a termination-unconfirmed fetch may still be writing one of them. The repository
    // is already under a maintenance hold either way (executeUpdate's own termination-unconfirmed
    // handling); leaving a ref behind in that case only affects the root-owned bare store, which is
    // already on hold pending an operator/restart.
    if (fetchTerminationUnconfirmed) {
      if (registeredFetchRefs.length > 0) {
        logger.warn(
          "update: a fetch subprocess's termination could not be confirmed \u2014 leaving fro-bot/fetch ref(s) in the protected bare store rather than risk deleting one a leaked process may still be writing",
          {owner, repo, refs: registeredFetchRefs},
        )
      }
    } else {
      for (const ref of registeredFetchRefs) {
        await gitRunner(['--git-dir', fetchStorePath, 'update-ref', '-d', ref], {
          cwd: fetchStorePath,
          env: buildNeutralGitEnv(),
          timeoutMs,
        }).catch(() => {})
      }
    }
  }
}

/**
 * Brings an eligible checkout up to date, or refuses/fails with a precise reason. See the module
 * header for the full admission order. Every refusal and every `no-checkout`/`inspection-failed`
 * result returns WITHOUT ever building or spawning the network git profile — only a fully
 * eligible checkout, with an unfired abort signal, ever reaches `runNetworkAndApply`.
 */
export async function executeUpdate(request: UpdateRequest, deps: UpdateHandlerDeps = {}): Promise<UpdateResult> {
  const {
    gitRunner: injectedGitRunner = runGit,
    reposRoot = WORKSPACE_REPOS_ROOT,
    options = {},
    now = () => new Date(),
    remoteBaseUrl = DEFAULT_REMOTE_BASE_URL,
    caBundlePath,
    proxy,
    askpassWriter = writeAskpassHelper,
    networkBudgetMs = DEFAULT_NETWORK_BUDGET_MS,
    applyTimeoutMs = DEFAULT_APPLY_TIMEOUT_MS,
    maxPackBytes = DEFAULT_MAX_PACK_BYTES,
    serviceHome = DEFAULT_SERVICE_HOME,
    packStreamRunner: injectedPackStreamRunner = runPackStream,
    signal,
    monotonicNow = () => performance.now(),
    logger = {warn: () => {}},
  } = deps
  const {timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS, uid = AGENT_UID, gid = AGENT_GID} = options
  const {owner, repo} = request

  const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
  const destPath = join(reposRoot, owner, repo)

  return withRepoLock(repoMutexKey(owner, repo), async (): Promise<UpdateResult> => {
    // (C2) One tracker for this WHOLE invocation — admission through the network/apply half —
    // wraps the injected runners so termination uncertainty anywhere is recorded in one place.
    // `gitRunner`/`packStreamRunner` below are the TRACKED versions; every admission step and
    // `runNetworkAndApply` use these, never the raw injected ones.
    const tracker = createInvocationTracker({gitRunner: injectedGitRunner, packStreamRunner: injectedPackStreamRunner})
    const gitRunner = tracker.gitRunner

    // Step 0: the sticky maintenance hold, checked before EVERYTHING else — even journal
    // reconciliation. A held repository means some earlier operation ended with an unconfirmed
    // subprocess termination; nothing below can be trusted until a process restart clears it.
    if (repoHoldReason(repoMutexKey(owner, repo)) !== undefined) {
      return {kind: 'refused', reason: 'maintenance-hold'}
    }

    // (C2) Every step below (through the end of the network/apply half) is wrapped in one IIFE so
    // EVERY exit — an early admission refusal/failure just as much as `runNetworkAndApply`'s own
    // result — funnels through the SINGLE choke point below, which overrides based on `tracker`
    // rather than on what any individual step concluded.
    const admissionResult = await (async (): Promise<UpdateResult> => {
      // Step 1: reconcile this repository's journal before anything else, under the mutex, so it
      // can never race a concurrent write of the same journal.
      const reconciliation = await reconcileUpdateJournal({
        journalsDir,
        owner,
        repo,
        destPath,
        tracker,
        timeoutMs,
        uid,
        gid,
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
        return {
          kind: 'refused',
          reason: 'dirty',
          changedPaths: cleanliness.changedPaths.slice(0, MAX_DIRTY_SAMPLE_SIZE),
        }
      }
      if (cleanliness.kind === 'inspection-failed') {
        return {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
      }

      // Step 8: client abort, checked once, immediately before the network/apply half would begin.
      if (signal?.aborted === true) {
        return {kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false}
      }

      // Admission passed in full — bring the checkout up to date.
      return runNetworkAndApply({
        owner,
        repo,
        token: request.token,
        reposRoot,
        canonicalCheckoutPath: destPath,
        head: observation.head,
        journalsDir,
        tracker,
        remoteBaseUrl,
        caBundlePath,
        proxy,
        askpassWriter,
        serviceHome,
        networkBudgetMs,
        applyTimeoutMs,
        maxPackBytes,
        timeoutMs,
        uid,
        gid,
        now,
        signal,
        monotonicNow,
        logger,
      })
    })()

    // (C2) Single choke point: ANY unconfirmed termination this tracker saw, at ANY phase of this
    // invocation — admission, journal reconciliation, or the network/apply half — wins over
    // whatever the naive result above says. `mutationStarted` is 'possibly' once the journal has
    // reached `applying` (`runNetworkAndApply` marks that via `tracker.markApplyingPhase()`),
    // `false` before it.
    if (tracker.sawUnconfirmed()) {
      markRepoHeld(repoMutexKey(owner, repo), 'termination-unconfirmed')
      return {
        kind: 'failed',
        reason: 'termination-unconfirmed',
        mutationStarted: tracker.isApplyingPhase() ? 'possibly' : false,
        permanent: false,
      }
    }
    return admissionResult
  })
}
