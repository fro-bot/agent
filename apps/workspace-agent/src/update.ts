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
import process from 'node:process'

import {
  checkCheckoutLayout,
  checkTempIndexCleanliness,
  inventoryCheckoutConfig,
  preflightObstructions,
} from './checkout-profile.js'
import {writeAskpassHelper} from './clone.js'
import {
  buildLocalUpdateGitProfile,
  buildNetworkGitProfile,
  buildNeutralGitEnv,
  gitInvocation,
  runGit,
} from './git-safety.js'
import {runPackStream} from './git-stream.js'
import {AGENT_GID, AGENT_UID, FETCH_STORE_DIR_NAME, JOURNAL_DIR_NAME, WORKSPACE_STATE_DIR_NAME} from './identity.js'
import {inspectCheckout} from './inspect.js'
import {listJournals, readJournal, removeJournal, writeJournal} from './journal.js'
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
   * PLUMBING ONLY as of this slice: accepted here and threaded down to `NetworkAndApplyContext`,
   * but `runNetworkAndApply` does not yet pass it to `buildNetworkGitProfile` — a tracked follow-up,
   * not a silent gap (server.ts's `ServerDeps.updateNetworkConfig` doc comment cross-references it).
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
  const {reposRoot = WORKSPACE_REPOS_ROOT, gitRunner = runGit, options = {}, now = () => new Date(), logger} = deps
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
    try {
      await withRepoLock(repoMutexKey(owner, repo), async () => {
        const outcome = await reconcileUpdateJournal({
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
  readonly gitRunner: GitRunnerFn
  readonly remoteBaseUrl: string
  readonly caBundlePath: string | undefined
  readonly askpassWriter: (dir: string) => Promise<string>
  readonly serviceHome: string
  readonly networkBudgetMs: number
  readonly applyTimeoutMs: number
  readonly maxPackBytes: number
  readonly packStreamRunner: (options: PackStreamOptions) => Promise<PackStreamOutcome>
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
  readonly now: () => Date
  readonly signal: AbortSignal | undefined
}

/** `<reposRoot>/.workspace-agent/<FETCH_STORE_DIR_NAME>/<owner>__<repo>.git` — matches identity.ts's documented fetch-store naming (the same `<owner>__<repo>` pairing journal.ts uses), a single flat, root-owned directory rather than a per-owner tree needing its own symlink-safety chain. */
function fetchStorePathFor(reposRoot: string, owner: string, repo: string): string {
  return join(reposRoot, WORKSPACE_STATE_DIR_NAME, FETCH_STORE_DIR_NAME, `${owner}__${repo}.git`)
}

/**
 * Ensures the protected bare fetch store exists at `fetchStorePath`, creating it (and its parent
 * chain, mode 0700) only when confirmed absent — mirrors journal.ts's directory-safety posture
 * (never chowns/relaxes an existing directory, refuses outright if the target or its parent
 * EXISTS but is a symlink) without duplicating its full implementation, since the fetch store's
 * threat model (a root-owned bare git repo, never journal content) doesn't need the malformed-
 * content parsing journal.ts's checks exist for.
 */
async function ensureBareFetchStore(params: {
  readonly fetchStorePath: string
  readonly gitRunner: GitRunnerFn
  readonly timeoutMs: number
}): Promise<'ok' | 'failed'> {
  const {fetchStorePath, gitRunner, timeoutMs} = params
  try {
    const st = await lstat(fetchStorePath)
    if (st.isSymbolicLink() || !st.isDirectory()) return 'failed'
    return 'ok'
  } catch {
    // ENOENT — fall through to create.
  }
  const parent = dirname(fetchStorePath)
  try {
    const parentStat = await lstat(parent)
    if (parentStat.isSymbolicLink()) return 'failed'
  } catch {
    // Parent absent too — mkdir recursive below creates the whole chain.
  }
  try {
    await mkdir(parent, {recursive: true, mode: 0o700})
  } catch {
    return 'failed'
  }
  const outcome = await gitRunner(['init', '--quiet', '--bare', fetchStorePath], {
    cwd: parent,
    env: buildNeutralGitEnv(),
    timeoutMs,
  })
  return outcome.kind === 'ok' ? 'ok' : 'failed'
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

function classifyRemoteFailure(stderr: string): {readonly reason: RemoteFailureReason; readonly permanent: boolean} {
  if (/^fatal: repository '.*' not found/m.test(stderr)) return {reason: 'fetch-not-found', permanent: true}
  if (/error: 403\b/.test(stderr)) return {reason: 'fetch-forbidden', permanent: true}
  if (/error: 429\b/.test(stderr)) return {reason: 'fetch-rate-limited', permanent: false}
  if (/^fatal: Authentication failed/m.test(stderr)) return {reason: 'fetch-auth-rejected', permanent: false}
  if (/Couldn't connect to server|Failed to connect/.test(stderr))
    return {reason: 'fetch-unreachable', permanent: false}
  return {reason: 'fetch-failed', permanent: false}
}

// ---------------------------------------------------------------------------
// Remote observation — ls-remote --symref (default branch + tip) and fetch, both through the
// sealed root-identity network git profile (buildNetworkGitProfile, git-safety.ts). Every call
// here is the ONLY place this module ever dials out, and the ONLY place a credential is ever in
// scope.
// ---------------------------------------------------------------------------

interface RemoteObservation {
  readonly branch: string
  readonly sha: string
}

type ObserveOutcome =
  | {readonly kind: 'ok'; readonly observation: RemoteObservation}
  | {readonly kind: 'failed'; readonly reason: RemoteFailureReason; readonly permanent: boolean}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'aborted'}

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
async function observeRemoteDefaultBranch(
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
  if (outcome.kind === 'timeout' || outcome.kind === 'termination-unconfirmed')
    return {kind: classifyTimeoutOrAbort(signal)}
  if (outcome.kind !== 'ok') {
    const {reason, permanent} = classifyRemoteFailure(outcome.stderr)
    return {kind: 'failed', reason, permanent}
  }
  const branchMatch = DEFAULT_BRANCH_SYMREF_RE.exec(outcome.stdout)
  const shaMatch = HEAD_SHA_LINE_RE.exec(outcome.stdout)
  if (branchMatch?.[1] === undefined || shaMatch?.[1] === undefined) {
    return {kind: 'failed', reason: 'fetch-failed', permanent: false}
  }
  return {kind: 'ok', observation: {branch: branchMatch[1], sha: shaMatch[1]}}
}

type FetchIntoRefOutcome =
  | {readonly kind: 'ok'}
  | {readonly kind: 'failed'; readonly reason: RemoteFailureReason; readonly permanent: boolean}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'aborted'}

/** Runs `fetch <remoteUrl> <refspec>` — `refspec` may be `<branch>:<localRef>` (creates/updates `localRef`) or a bare SHA (fetches the object without creating a ref; requires the remote to allow SHA1-in-want, exactly as GitHub does). */
async function fetchIntoRef(
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
  if (outcome.kind === 'timeout' || outcome.kind === 'termination-unconfirmed')
    return {kind: classifyTimeoutOrAbort(signal)}
  if (outcome.kind !== 'ok') {
    const {reason, permanent} = classifyRemoteFailure(outcome.stderr)
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
 * `timeoutMs` as its PER-CALL bound; the caller (`runNetworkAndApply`) is responsible for the
 * overall network-budget deadline.
 */
async function observeAndFetch(params: {
  readonly profile: GitProfile
  readonly remoteUrl: string
  readonly head: CheckoutHead
  readonly gitRunner: GitRunnerFn
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
}): Promise<ObserveAndFetchOutcome> {
  const {profile, remoteUrl, head, gitRunner, timeoutMs, signal} = params

  const first = await observeRemoteDefaultBranch(profile, remoteUrl, gitRunner, timeoutMs, signal)
  if (first.kind === 'aborted') {
    return {kind: 'failed', result: {kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false}}
  }
  if (first.kind === 'timeout') {
    return {kind: 'failed', result: {kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false}}
  }
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
    const uniqueRef = `refs/fro-bot/fetch/${randomUUID()}`
    const fetchOutcome = await fetchIntoRef(
      profile,
      remoteUrl,
      `${first.observation.branch}:${uniqueRef}`,
      gitRunner,
      timeoutMs,
      signal,
    )
    if (fetchOutcome.kind === 'aborted') {
      return {kind: 'failed', result: {kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false}}
    }
    if (fetchOutcome.kind === 'timeout') {
      return {
        kind: 'failed',
        result: {kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false},
      }
    }
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

    const reobserved = await observeRemoteDefaultBranch(profile, remoteUrl, gitRunner, timeoutMs, signal)
    if (reobserved.kind === 'aborted') {
      return {kind: 'failed', result: {kind: 'failed', reason: 'aborted', mutationStarted: false, permanent: false}}
    }
    if (reobserved.kind === 'timeout') {
      return {
        kind: 'failed',
        result: {kind: 'failed', reason: 'fetch-timeout', mutationStarted: false, permanent: false},
      }
    }
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

/** `git merge-base --is-ancestor` in the checkout: exit 0 = ancestor, exit 1 = not an ancestor (informative, not a failure), anything else = inspection-failed. */
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
  const env = buildNeutralGitEnv()
  const isAncestor = async (a: string, b: string): Promise<boolean | 'inspection-failed'> => {
    const outcome = await gitRunner(
      gitInvocation(canonicalCheckoutPath, canonicalCheckoutPath, ['merge-base', '--is-ancestor', a, b]),
      {cwd: canonicalCheckoutPath, env, timeoutMs, uid, gid},
    )
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
// The fast-forward merge itself — the point of no return. Called only once the journal already
// reads `applying` (set by the caller before the object import above) and the obstruction
// preflight has passed. Re-runs layout/config/cleanliness/operation-state immediately before
// mutating — the agent may have changed `.git` during the network round-trip — then
// `merge --ff-only --no-overwrite-ignore` under the sealed LOCAL profile, then verifies HEAD
// really landed on `toSha` before ever clearing the journal. Every non-clean outcome from this
// point on LEAVES the journal at `applying`: once a mutation may have started, an interrupted or
// unconfirmed attempt is never reported as "nothing changed" (R6).
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
  readonly gitRunner: GitRunnerFn
  readonly timeoutMs: number
  readonly applyTimeoutMs: number
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
    gitRunner,
    timeoutMs,
    applyTimeoutMs,
    uid,
    gid,
    now,
  } = params

  const APPLY_FAILED_MUTATED: UpdateFailed = {
    kind: 'failed',
    reason: 'apply-failed',
    mutationStarted: true,
    permanent: false,
  }

  const layout = await checkCheckoutLayout({checkoutPath: canonicalCheckoutPath, timeoutMs, uid, gid})
  if (layout.kind !== 'ok') return APPLY_FAILED_MUTATED

  const configInventory = await inventoryCheckoutConfig({
    checkoutPath: canonicalCheckoutPath,
    gitRunner,
    timeoutMs,
    uid,
    gid,
  })
  if (configInventory.kind !== 'allowed') return APPLY_FAILED_MUTATED

  const cleanliness = await checkTempIndexCleanliness({
    checkoutPath: canonicalCheckoutPath,
    headSha: fromSha,
    gitRunner,
    timeoutMs,
    uid,
    gid,
  })
  if (cleanliness.kind !== 'clean') return APPLY_FAILED_MUTATED

  const reinspected = await inspectCheckout(
    {owner, repo},
    {gitRunner, reposRoot, options: {timeoutMs, uid, gid}, clock: now},
  )
  if (reinspected.response.ok !== true || reinspected.response.observation.operationInProgress !== 'none') {
    return APPLY_FAILED_MUTATED
  }

  const localProfile = buildLocalUpdateGitProfile({checkoutPath: canonicalCheckoutPath})
  const mergeOutcome = await gitRunner([...localProfile.args, 'merge', '--ff-only', '--no-overwrite-ignore', toSha], {
    cwd: localProfile.cwd,
    env: localProfile.env,
    timeoutMs: applyTimeoutMs,
    uid,
    gid,
  })
  if (mergeOutcome.kind === 'termination-unconfirmed') {
    return {kind: 'failed', reason: 'termination-unconfirmed', mutationStarted: 'possibly', permanent: false}
  }
  if (mergeOutcome.kind !== 'ok') return APPLY_FAILED_MUTATED

  const headOutcome = await gitRunner([...localProfile.args, 'rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: localProfile.cwd,
    env: localProfile.env,
    timeoutMs,
    uid,
    gid,
  })
  if (headOutcome.kind !== 'ok' || headOutcome.stdout.trim() !== toSha) return APPLY_FAILED_MUTATED

  await writeJournal(journalsDir, {
    kind: 'update',
    owner,
    repo,
    phase: 'applied',
    fromSha,
    toSha,
    startedAt: now().toISOString(),
  })
  await removeJournal(journalsDir, owner, repo)

  return {kind: 'ready', change: 'fast-forward', branch, sha: toSha, fromSha, checkedAt: now().toISOString()}
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
    gitRunner,
    remoteBaseUrl,
    caBundlePath,
    askpassWriter,
    serviceHome,
    networkBudgetMs,
    applyTimeoutMs,
    maxPackBytes,
    packStreamRunner,
    timeoutMs,
    uid,
    gid,
    now,
    signal,
  } = context

  const fetchStorePath = fetchStorePathFor(reposRoot, owner, repo)
  const storeReady = await ensureBareFetchStore({fetchStorePath, gitRunner, timeoutMs})
  if (storeReady === 'failed') {
    return {kind: 'failed', reason: 'fetch-failed', mutationStarted: false, permanent: false}
  }

  const askpassDir = await mkdtemp(join(tmpdir(), 'workspace-agent-update-askpass-'))
  let uniqueRef: string | undefined
  try {
    const askpassPath = await askpassWriter(askpassDir)
    const networkProfile = buildNetworkGitProfile({
      bareRepoPath: fetchStorePath,
      serviceHome,
      askpassPath,
      token,
      caBundlePath,
      parentEnv: process.env,
    })
    const remoteUrl = `${remoteBaseUrl}/${owner}/${repo}.git`
    const fromSha = head.sha

    const observed = await observeAndFetch({
      profile: networkProfile,
      remoteUrl,
      head,
      gitRunner,
      timeoutMs: networkBudgetMs,
      signal,
    })
    if (observed.kind !== 'ok') return observed.result
    uniqueRef = observed.result.uniqueRef
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
      await removeJournal(journalsDir, owner, repo)
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

    // H may be a LOCAL commit the remote has never seen (the "ahead" case) — pack the full closure
    // of T when the bare store doesn't already have H, never a delta built against an object that
    // isn't there.
    const hKnownToBare = await shaPresentInBare(fetchStorePath, fromSha, gitRunner, timeoutMs)
    const imported = await importPackObjects({
      bareRepoPath: fetchStorePath,
      canonicalCheckoutPath,
      fromShaIfKnownToBare: hKnownToBare ? fromSha : undefined,
      toSha: targetSha,
      packStreamRunner,
      maxPackBytes,
      applyTimeoutMs,
      uid,
      gid,
    })
    if (imported.kind === 'failed') {
      if (imported.result.reason !== 'termination-unconfirmed') await removeJournal(journalsDir, owner, repo)
      return imported.result
    }

    // T's objects are now resolvable in the checkout — alongside H, which the checkout always
    // already had — so ancestry can finally be decided, for every case, not only "behind".
    const ancestry = await classifyAncestryInCheckout({
      canonicalCheckoutPath,
      fromSha,
      toSha: targetSha,
      gitRunner,
      timeoutMs,
      uid,
      gid,
    })
    if (ancestry === 'inspection-failed') {
      // Can't confirm the checkout's state; leave the journal at `applying` for recovery.
      return {kind: 'failed', reason: 'inspection-failed', mutationStarted: false, permanent: false}
    }
    if (ancestry === 'equal') {
      await removeJournal(journalsDir, owner, repo)
      return {kind: 'ready', change: 'unchanged', branch, sha: fromSha, checkedAt: now().toISOString()}
    }
    if (ancestry === 'ahead') {
      await removeJournal(journalsDir, owner, repo)
      return {kind: 'refused', reason: 'ahead'}
    }
    if (ancestry === 'diverged') {
      await removeJournal(journalsDir, owner, repo)
      return {kind: 'refused', reason: 'diverged'}
    }

    // ancestry === 'behind'
    const preflight = await preflightObstructions({
      checkoutPath: canonicalCheckoutPath,
      fromSha,
      toSha: targetSha,
      gitRunner,
      timeoutMs,
      uid,
      gid,
    })
    if (preflight.kind === 'obstructed') {
      await removeJournal(journalsDir, owner, repo)
      return {kind: 'refused', reason: 'obstructed', obstructions: preflight.obstructions}
    }
    if (preflight.kind === 'inspection-failed') {
      // Can't confirm the checkout's state; leave the journal at `applying` for recovery.
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
      gitRunner,
      timeoutMs,
      applyTimeoutMs,
      uid,
      gid,
      now,
    })
  } finally {
    await rm(askpassDir, {recursive: true, force: true}).catch(() => {})
    if (uniqueRef !== undefined) {
      await gitRunner(['--git-dir', fetchStorePath, 'update-ref', '-d', uniqueRef], {
        cwd: fetchStorePath,
        env: buildNeutralGitEnv(),
        timeoutMs,
      }).catch(() => {})
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
    gitRunner = runGit,
    reposRoot = WORKSPACE_REPOS_ROOT,
    options = {},
    now = () => new Date(),
    remoteBaseUrl = DEFAULT_REMOTE_BASE_URL,
    caBundlePath,
    askpassWriter = writeAskpassHelper,
    networkBudgetMs = DEFAULT_NETWORK_BUDGET_MS,
    applyTimeoutMs = DEFAULT_APPLY_TIMEOUT_MS,
    maxPackBytes = DEFAULT_MAX_PACK_BYTES,
    serviceHome = DEFAULT_SERVICE_HOME,
    packStreamRunner = runPackStream,
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

    // Admission passed in full — bring the checkout up to date.
    return runNetworkAndApply({
      owner,
      repo,
      token: request.token,
      reposRoot,
      canonicalCheckoutPath: destPath,
      head: observation.head,
      journalsDir,
      gitRunner,
      remoteBaseUrl,
      caBundlePath,
      askpassWriter,
      serviceHome,
      networkBudgetMs,
      applyTimeoutMs,
      maxPackBytes,
      packStreamRunner,
      timeoutMs,
      uid,
      gid,
      now,
      signal,
    })
  })
}
