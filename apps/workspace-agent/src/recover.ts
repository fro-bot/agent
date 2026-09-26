/**
 * Recovery preview — Unit 5, slice 5a. Read-only: reports what a `/recover` (preserve-and-
 * replace) call would see, without ever mutating anything and without a server-side operation id
 * (checkout-update-recovery plan, Key Technical Decisions: "The recovery preview is stateless").
 * The actual `/recover` mutation (quarantine + fresh checkout) is slice 5b, not this module.
 *
 * Admission gates what git this module is willing to run in the checkout, exactly like update.ts:
 * `checkCheckoutLayout` (pure filesystem, no git at all) and `inventoryCheckoutConfig` (one inert
 * `git config --list` call — never a working-tree-reading command) together decide whether the
 * checkout is `inspectionSafe`. Only when BOTH pass does this module ever run `git status` (via
 * `inspectCheckout`) or any other working-tree-reading command in the checkout. When either
 * refuses or fails, the preview degrades to an OPAQUE shape (size + entry count only, computed by
 * a pure filesystem walk) and no further git ever runs there.
 */

import type {AgentWalkRunner, SealedWalkRunner} from './agent-walk.js'
import type {QuarantineMetadata, QuarantineSource} from './backups.js'
import type {GitProfile, GitRunnerFn} from './git-safety.js'
import type {PackStreamOptions} from './git-stream.js'
import type {JournalListEntry, RecoveryJournal, RecoveryJournalPhase, UpdateJournal} from './journal.js'
import type {
  DirtyCounts,
  ExecuteRecoveryRequest,
  ExecuteRecoveryResult,
  PreviewRecoveryRequest,
  PreviewRecoveryResult,
  RetentionUsage,
} from './types.js'
import type {Deadline, InvocationTracker, RemoteFailureReason} from './update.js'
import {createHash, randomUUID} from 'node:crypto'
import {lstat, mkdir, mkdtemp, realpath, rename, rm, statfs} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {performance} from 'node:perf_hooks'
import process from 'node:process'
import {runAgentWalk} from './agent-walk.js'
import {listBackups, QUARANTINE_CHECKOUT_DIR_NAME, readQuarantineMetadata, writeQuarantineMetadata} from './backups.js'
import {checkCheckoutLayout, checkTempIndexCleanliness, inventoryCheckoutConfig} from './checkout-profile.js'
import {HANDOFF_DEADLINE_MS, MAX_HANDOFF_ENTRIES, writeAskpassHelper} from './clone.js'
import {
  buildFilterNeutralizationEnv,
  buildNetworkGitProfile,
  buildNeutralGitEnv,
  enumerateFilterDrivers,
  gitInvocation,
  runGit,
} from './git-safety.js'
import {runPackStream} from './git-stream.js'
import {handOffToAgent} from './handoff.js'
import {
  AGENT_GID,
  AGENT_UID,
  CLONE_STAGING_DIR_NAME,
  JOURNAL_DIR_NAME,
  QUARANTINE_DIR_NAME,
  WORKSPACE_STATE_DIR_NAME,
} from './identity.js'
import {inspectCheckout} from './inspect.js'
import {listJournals, readJournal, removeJournal, writeJournal} from './journal.js'
import {repoHoldReason, repoMutexKey, withRepoLock} from './repo-mutex.js'
import {
  createDeadline,
  createInvocationTracker,
  DEFAULT_APPLY_TIMEOUT_MS as DEFAULT_BUILD_TIMEOUT_MS,
  DEFAULT_MAX_PACK_BYTES,
  DEFAULT_NETWORK_BUDGET_MS,
  DEFAULT_REMOTE_BASE_URL,
  DEFAULT_SERVICE_HOME,
  ensureBareFetchStore,
  fetchIntoRef,
  fetchStorePathFor,
  observeRemoteDefaultBranch,
  runTrackedInvocation,
} from './update.js'

/** Root directory where repos are cloned inside the workspace container. Mirrors update.ts/inspect.ts. */
export const WORKSPACE_REPOS_ROOT = '/workspace/repos'

/** Default per-invocation timeout for a local git subprocess, in milliseconds. Matches update.ts's own local budget. */
export const DEFAULT_LOCAL_TIMEOUT_MS = 15_000

/** Default wall-clock budget for the filesystem size/entry-count walk, in milliseconds. */
export const DEFAULT_WALK_DEADLINE_MS = 10_000

/** Default cap on filesystem entries the walk will visit before capping the estimate. */
export const DEFAULT_WALK_MAX_ENTRIES = 200_000

/** Retention quota, checkout-update-recovery plan Key Technical Decisions: "5 generations, 10 GiB". */
export const RETENTION_MAX_GENERATIONS = 5
export const RETENTION_MAX_BYTES = 10 * 1024 * 1024 * 1024

/** Default headroom multiplier for the free-space preflight — plan: "start at twice the estimated checkout size". */
export const DEFAULT_DISK_HEADROOM_MULTIPLIER = 2

export interface ExecuteRecoveryDeps {
  readonly gitRunner?: GitRunnerFn
  readonly packStreamRunner?: (options: PackStreamOptions) => ReturnType<typeof runPackStream>
  /** (Review round H, H4) Test seam — injectable so a test can simulate an unconfirmed termination during the PRE-rename pathname walk without a real subprocess. Defaults to the real `runAgentWalk`. */
  readonly walkRunner?: AgentWalkRunner
  readonly reposRoot?: string
  readonly options?: {readonly timeoutMs?: number; readonly uid?: number; readonly gid?: number}
  readonly now?: () => Date
  readonly walkDeadlineMs?: number
  readonly walkMaxEntries?: number
  readonly monotonicNow?: () => number
  readonly remoteBaseUrl?: string
  readonly caBundlePath?: string
  readonly proxy?: {readonly https: string; readonly noProxy?: string}
  readonly askpassWriter?: (dir: string) => Promise<string>
  readonly serviceHome?: string
  readonly networkBudgetMs?: number
  readonly buildTimeoutMs?: number
  readonly maxPackBytes?: number
  readonly diskHeadroomMultiplier?: number
  readonly statfsFn?: RecoveryStatfsFn
  readonly mkdtempFn?: (prefix: string) => Promise<string>
  readonly recoveryIdFn?: () => string
}

/** Minimal free-space shape this module needs — avoids `fs.promises.statfs`'s bigint-overload union. */
export type RecoveryStatfsFn = (path: string) => Promise<{readonly bavail: number; readonly bsize: number}>

async function defaultStatfs(path: string): Promise<{readonly bavail: number; readonly bsize: number}> {
  const stats = await statfs(path)
  return {bavail: Number(stats.bavail), bsize: Number(stats.bsize)}
}

export interface PreviewRecoveryDeps {
  readonly gitRunner?: GitRunnerFn
  /** (Review round E, E5) Injected agent-uid walk runner. Defaults to the real subprocess-spawning `runAgentWalk`. */
  readonly walkRunner?: AgentWalkRunner
  readonly reposRoot?: string
  readonly options?: {readonly timeoutMs?: number; readonly uid?: number; readonly gid?: number}
  readonly now?: () => Date
  readonly walkDeadlineMs?: number
  readonly walkMaxEntries?: number
}

// ---------------------------------------------------------------------------
// Filesystem size/entry-count walk (Review round E, E5) - delegates to agent-walk.ts's
// AgentWalkRunner, run AS THE AGENT IDENTITY rather than in-process as this (root) service. See
// agent-walk.ts's module header for the full rationale. Never runs in-process on a path the agent
// can reach.
// ---------------------------------------------------------------------------

/** Extra time, beyond the walk's own internal deadline, allowed for the subprocess to observe that deadline and print its result before this module gives up on it as unconfirmed. */
const WALK_TIMEOUT_BUFFER_MS = 5_000

type WalkOrFailOutcome =
  | {readonly kind: 'ok'; readonly totalBytes: number; readonly entryCount: number; readonly complete: boolean}
  | {readonly kind: 'failed'}
  | {readonly kind: 'termination-unconfirmed'}

/**
 * (Review round H, H4) `termination-unconfirmed` is preserved as its OWN outcome — never folded
 * into `failed` — so a caller that must abort BEFORE a durable mutation (quarantine's pre-rename
 * measurement) can tell "the walk cleanly failed" (safe to proceed treating the size as unknown)
 * apart from "the walk's fate is genuinely uncertain" (must not proceed at all).
 */
async function walkCheckoutSize(params: {
  readonly walkRunner: AgentWalkRunner
  readonly rootPath: string
  readonly maxEntries: number
  readonly deadlineMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}): Promise<WalkOrFailOutcome> {
  const {walkRunner, rootPath, maxEntries, deadlineMs, uid, gid} = params
  const outcome = await walkRunner({
    rootPath,
    maxEntries,
    deadlineMs,
    uid,
    gid,
    timeoutMs: deadlineMs + WALK_TIMEOUT_BUFFER_MS,
  })
  if (outcome.kind === 'termination-unconfirmed') return {kind: 'termination-unconfirmed'}
  if (outcome.kind !== 'ok') return {kind: 'failed'}
  return outcome
}

// ---------------------------------------------------------------------------
// Canonical-path resolution \u2014 filesystem-only (no git), so this can run even when the checkout's
// config is hostile. Mirrors inspect.ts's own substitution check (steps 1-2 of that module) exactly.
// ---------------------------------------------------------------------------

type CanonicalCheckoutResult =
  | {readonly kind: 'ok'; readonly path: string}
  | {readonly kind: 'no-checkout'}
  | {readonly kind: 'checkout-substituted'}
  /** (Review round E, E9) A `realpath` failure OTHER than ENOENT (EACCES, ELOOP, ENOTDIR, …) is never "no checkout" — something exists but couldn't be positively resolved, which is exactly what `inspection-failed` means everywhere else in this module. */
  | {readonly kind: 'inspection-failed'}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function resolveCanonicalCheckout(
  reposRoot: string,
  owner: string,
  repo: string,
): Promise<CanonicalCheckoutResult> {
  let reposRootResolved: string
  try {
    reposRootResolved = await realpath(reposRoot)
  } catch (error) {
    return {kind: isEnoent(error) ? 'no-checkout' : 'inspection-failed'}
  }
  const destPath = join(reposRoot, owner, repo)
  let canonicalResolved: string
  try {
    canonicalResolved = await realpath(destPath)
  } catch (error) {
    return {kind: isEnoent(error) ? 'no-checkout' : 'inspection-failed'}
  }
  const expectedCanonical = join(reposRootResolved, owner, repo)
  if (canonicalResolved !== expectedCanonical) return {kind: 'checkout-substituted'}
  return {kind: 'ok', path: canonicalResolved}
}

/**
 * Digest of the given parts, joined with an embedded NUL so no ambiguity between e.g. `['1', '23']`
 * and `['12', '3']` is possible. Safe preview evidence: the fingerprint is never a secret and is
 * only ever compared for equality by `/recover` (slice 5b), never decoded.
 */
function computeFingerprint(parts: readonly (string | number)[]): string {
  const hash = createHash('sha256')
  hash.update(parts.map(String).join('\u0000'))
  return hash.digest('hex')
}

/** Counts ignored (never tracked, matched by `.gitignore`/`.git/info/exclude`) paths via a dedicated, filter-neutralized `git status --ignored` call \u2014 `inspectCheckout`'s own status call never requests `--ignored`, so this is a second, deliberately separate call. Returns `undefined` on any failure (fail closed \u2014 the caller treats that as inspection-failed). */
async function countIgnoredEntries(
  canonicalPath: string,
  gitRunner: GitRunnerFn,
  timeoutMs: number,
  uid: number | undefined,
  gid: number | undefined,
): Promise<number | undefined> {
  const env = buildNeutralGitEnv()
  const filterEnumeration = await enumerateFilterDrivers(canonicalPath, env, gitRunner, timeoutMs, uid, gid)
  if (filterEnumeration.kind !== 'ok') return undefined
  const statusEnv = {...env, ...buildFilterNeutralizationEnv(filterEnumeration.drivers)}
  const outcome = await gitRunner(
    gitInvocation(canonicalPath, canonicalPath, [
      'status',
      '--porcelain=v2',
      '-z',
      '--ignored=matching',
      '--ignore-submodules=all',
    ]),
    {cwd: canonicalPath, env: statusEnv, timeoutMs, uid, gid},
  )
  if (outcome.kind !== 'ok') return undefined
  return outcome.stdout.split('\0').filter(entry => entry.startsWith('! ')).length
}

/**
 * The body of `previewRecovery`, extracted so `executeRecovery` (slice 5b) can recompute the
 * fingerprint under the mutex IT already holds, without previewRecovery's own `withRepoLock`
 * re-entering the same non-reentrant per-repo lock (repo-mutex.ts's `withRepoLock` would deadlock
 * on a second acquire of the same key from within the first). Must only ever be called from
 * inside an existing `withRepoLock(repoMutexKey(owner, repo), ...)` for this exact repo.
 */
async function computeRecoveryPreviewLocked(
  owner: string,
  repo: string,
  params: {
    readonly gitRunner: GitRunnerFn
    readonly walkRunner: AgentWalkRunner
    readonly reposRoot: string
    readonly timeoutMs: number
    readonly uid: number
    readonly gid: number
    readonly now: () => Date
    readonly walkDeadlineMs: number
    readonly walkMaxEntries: number
  },
): Promise<PreviewRecoveryResult> {
  const {gitRunner, walkRunner, reposRoot, timeoutMs, uid, gid, now, walkDeadlineMs, walkMaxEntries} = params

  // Checked first, before even the journal — mirrors update.ts's own step 0.
  if (repoHoldReason(repoMutexKey(owner, repo)) !== undefined) {
    return {kind: 'refused', reason: 'maintenance-hold'}
  }

  const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
  const journalRead = await readJournal(journalsDir, owner, repo)
  if (journalRead.ok === true) {
    const journal = journalRead.journal
    // (E2) An interrupted UPDATE journal is recoverable, never a dead end — a RECOVERY journal
    // in progress still refuses outright (startup reconciliation, not a fresh /recover, owns it).
    if (journal.kind === 'update') {
      // (F6) The checkout at its canonical path is still agent-traversable and untouched at this
      // point (no quarantine has happened yet) — a filesystem-only walk (no git) gives real
      // size/entry evidence for the projected quota and disk-headroom checks at confirm time,
      // instead of the fixed `estimatedSizeBytes: 0` that used to silently defeat them. Journal
      // INSTANCE identity (`startedAt`) is folded into the fingerprint too, so a NEW interrupted
      // update starting at the same phase/shas (vanishingly unlikely, but not impossible for a
      // repeatedly-failing update) is never mistaken for the one the operator actually previewed.
      const canonicalForWalk = await resolveCanonicalCheckout(reposRoot, owner, repo)
      const walkRootPath = canonicalForWalk.kind === 'ok' ? canonicalForWalk.path : join(reposRoot, owner, repo)
      const walk = await walkCheckoutSize({
        walkRunner,
        rootPath: walkRootPath,
        maxEntries: walkMaxEntries,
        deadlineMs: walkDeadlineMs,
        uid,
        gid,
      })
      const estimatedSizeBytes = walk.kind === 'ok' ? walk.totalBytes : 0
      const entryCount = walk.kind === 'ok' ? walk.entryCount : 0
      const sizeMeasurementComplete = walk.kind === 'ok' && walk.complete
      const updateFingerprint = computeFingerprint([
        'update-recovery',
        owner,
        repo,
        journal.phase,
        journal.fromSha,
        journal.toSha,
        journal.startedAt,
        estimatedSizeBytes,
        entryCount,
      ])
      return {
        kind: 'recoverable-update',
        update: {
          phase: journal.phase,
          fromSha: journal.fromSha,
          toSha: journal.toSha,
          startedAt: journal.startedAt,
          estimatedSizeBytes,
          entryCount,
          sizeMeasurementComplete,
          fingerprint: updateFingerprint,
        },
      }
    }
    return {kind: 'refused', reason: 'journal-in-progress', phase: journal.phase}
  }
  if (journalRead.ok === false && journalRead.reason === 'malformed') {
    return {kind: 'refused', reason: 'journal-in-progress', phase: 'malformed'}
  }

  const canonical = await resolveCanonicalCheckout(reposRoot, owner, repo)
  if (canonical.kind === 'no-checkout') return {kind: 'no-checkout'}
  if (canonical.kind === 'checkout-substituted') return {kind: 'refused', reason: 'checkout-substituted'}
  if (canonical.kind === 'inspection-failed') return {kind: 'failed', reason: 'inspection-failed'}
  const canonicalPath = canonical.path

  // Admission gate: layout is pure filesystem (no git at all); config inventory is one inert
  // `git config --list` call — never a working-tree-reading command, so running it does not
  // violate "no git in the checkout" for a hostile-config checkout the way `git status` would.
  const layout = await checkCheckoutLayout({checkoutPath: canonicalPath, timeoutMs, uid, gid})
  let inspectionSafe = layout.kind === 'ok'
  if (inspectionSafe) {
    const configInventory = await inventoryCheckoutConfig({checkoutPath: canonicalPath, gitRunner, timeoutMs, uid, gid})
    inspectionSafe = configInventory.kind === 'allowed'
  }

  // (E5) AS THE AGENT — never in-process as this (root) service.
  const walk = await walkCheckoutSize({
    walkRunner,
    rootPath: canonicalPath,
    maxEntries: walkMaxEntries,
    deadlineMs: walkDeadlineMs,
    uid,
    gid,
  })
  if (walk.kind !== 'ok') return {kind: 'failed', reason: 'inspection-failed'}

  const retentionResult = await listBackups(owner, repo, {reposRoot, walkRunner, uid, gid})
  if (retentionResult.kind !== 'ok') return {kind: 'failed', reason: 'inspection-failed'}
  const retention: RetentionUsage = {
    generationCount: retentionResult.backups.length,
    totalBytes: retentionResult.totalBytes,
    hasUnknownSize: retentionResult.backups.some(backup => !backup.metadataOk || !backup.sizeComplete),
    maxGenerations: RETENTION_MAX_GENERATIONS,
    maxBytes: RETENTION_MAX_BYTES,
  }

  if (!inspectionSafe) {
    const fingerprint = computeFingerprint([walk.totalBytes, walk.entryCount])
    return {
      kind: 'ok',
      preview: {
        inspectionSafe: false,
        estimatedSizeBytes: walk.totalBytes,
        entryCount: walk.entryCount,
        sizeMeasurementComplete: walk.complete,
        retention,
        fingerprint,
      },
    }
  }

  const inspected = await inspectCheckout(
    {owner, repo},
    {gitRunner, reposRoot, options: {timeoutMs, uid, gid}, clock: now},
  )
  if (inspected.response.ok !== true) {
    // Admission already passed (layout ok, config allowed) and the canonical path already
    // resolved above, so a failure HERE is a genuine, not a hostile-config, inspection failure.
    return {kind: 'failed', reason: 'inspection-failed'}
  }
  const observation = inspected.response.observation

  const ignoredCount = await countIgnoredEntries(canonicalPath, gitRunner, timeoutMs, uid, gid)
  if (ignoredCount === undefined) return {kind: 'failed', reason: 'inspection-failed'}

  const headSha = observation.head.sha
  const branch = observation.head.kind === 'attached' ? observation.head.branch : undefined
  const dirty: DirtyCounts =
    observation.worktree.kind === 'dirty'
      ? {
          staged: observation.worktree.staged,
          unstaged: observation.worktree.unstaged,
          untracked: observation.worktree.untracked,
          conflicted: observation.worktree.conflicted,
        }
      : {staged: 0, unstaged: 0, untracked: 0, conflicted: 0}

  const fingerprint = computeFingerprint([
    headSha,
    dirty.staged,
    dirty.unstaged,
    dirty.untracked,
    dirty.conflicted,
    walk.totalBytes,
    walk.entryCount,
  ])

  return {
    kind: 'ok',
    preview: {
      inspectionSafe: true,
      headSha,
      branch,
      dirty,
      operationInProgress: observation.operationInProgress,
      ignoredCount,
      estimatedSizeBytes: walk.totalBytes,
      entryCount: walk.entryCount,
      sizeMeasurementComplete: walk.complete,
      retention,
      fingerprint,
    },
  }
}

/**
 * Reports what a `/recover` call would see for `request.owner`/`request.repo`, without mutating
 * anything. See the module header for the full admission-gated safety model.
 */
export async function previewRecovery(
  request: PreviewRecoveryRequest,
  deps: PreviewRecoveryDeps = {},
): Promise<PreviewRecoveryResult> {
  const {
    gitRunner: injectedGitRunner = runGit,
    walkRunner: injectedWalkRunner = runAgentWalk,
    reposRoot = WORKSPACE_REPOS_ROOT,
    options = {},
    now = () => new Date(),
    walkDeadlineMs = DEFAULT_WALK_DEADLINE_MS,
    walkMaxEntries = DEFAULT_WALK_MAX_ENTRIES,
  } = deps
  const {timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS, uid = AGENT_UID, gid = AGENT_GID} = options
  const {owner, repo} = request
  const repoKey = repoMutexKey(owner, repo)

  // (D4) Wraps the ENTIRE standalone preview in a tracker + the shared D1 choke point: an
  // unconfirmed termination anywhere holds the repository and returns `termination-unconfirmed`,
  // never a preview — opaque or otherwise — built on an uncertain read.
  return withRepoLock(repoKey, async () => {
    const tracker = createInvocationTracker({gitRunner: injectedGitRunner, walkRunner: injectedWalkRunner})
    return runTrackedInvocation(
      repoKey,
      tracker,
      async () =>
        computeRecoveryPreviewLocked(owner, repo, {
          gitRunner: tracker.gitRunner,
          walkRunner: tracker.walkRunner,
          reposRoot,
          timeoutMs,
          uid,
          gid,
          now,
          walkDeadlineMs,
          walkMaxEntries,
        }),
      (): PreviewRecoveryResult => ({kind: 'failed', reason: 'termination-unconfirmed'}),
    )
  })
}

// ---------------------------------------------------------------------------
// Mutation core — Unit 5, slice 5b. Everything below runs only under withRepoLock, via
// executeRecovery at the end of this module.
// ---------------------------------------------------------------------------

type FetchRecoveryTargetOutcome =
  | {readonly kind: 'ok'; readonly branch: string; readonly sha: string}
  | {readonly kind: 'failed'; readonly reason: RemoteFailureReason}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'unconfirmed'}

/**
 * Fetches the remote's CURRENT default branch and tip into the bare store, forcing the local ref
 * (`+<branch>:refs/heads/<branch>`) so a rewritten remote history never leaves a stale non-fast-
 * forward ref behind. Retries the fetch-then-observe pair once (two attempts) to detect a moved
 * tip, mirroring update.ts's own `observeAndFetch` loop — recovery has no local H to compare
 * against, so it always packs T's full closure and never refuses detached/non-default-branch.
 */
async function fetchRecoveryTarget(params: {
  readonly profile: GitProfile
  readonly remoteUrl: string
  readonly gitRunner: GitRunnerFn
  readonly deadline: Deadline
}): Promise<FetchRecoveryTargetOutcome> {
  const {profile, remoteUrl, gitRunner, deadline} = params
  if (deadline.expired()) return {kind: 'timeout'}
  const first = await observeRemoteDefaultBranch(profile, remoteUrl, gitRunner, deadline.remainingMs(), undefined)
  if (first.kind === 'unconfirmed') return {kind: 'unconfirmed'}
  if (first.kind === 'timeout' || first.kind === 'aborted') return {kind: 'timeout'}
  if (first.kind === 'failed') return {kind: 'failed', reason: first.reason}

  const branch = first.observation.branch
  let previousSha = first.observation.sha
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (deadline.expired()) return {kind: 'timeout'}
    const fetched = await fetchIntoRef(
      profile,
      remoteUrl,
      `+${branch}:refs/heads/${branch}`,
      gitRunner,
      deadline.remainingMs(),
      undefined,
    )
    if (fetched.kind === 'unconfirmed') return {kind: 'unconfirmed'}
    if (fetched.kind === 'timeout' || fetched.kind === 'aborted') return {kind: 'timeout'}
    if (fetched.kind === 'failed') return {kind: 'failed', reason: fetched.reason}

    if (deadline.expired()) return {kind: 'timeout'}
    const reobserved = await observeRemoteDefaultBranch(
      profile,
      remoteUrl,
      gitRunner,
      deadline.remainingMs(),
      undefined,
    )
    if (reobserved.kind === 'unconfirmed') return {kind: 'unconfirmed'}
    if (reobserved.kind === 'timeout' || reobserved.kind === 'aborted') return {kind: 'timeout'}
    if (reobserved.kind === 'failed') return {kind: 'failed', reason: reobserved.reason}
    if (reobserved.observation.sha === previousSha) return {kind: 'ok', branch, sha: reobserved.observation.sha}
    previousSha = reobserved.observation.sha
  }
  return {kind: 'failed', reason: 'fetch-failed'}
}

type BuildStagingOutcome =
  {readonly kind: 'ok'} | {readonly kind: 'termination-unconfirmed'} | {readonly kind: 'failed'}

/**
 * Builds a fresh checkout at `stagingPath` (already created, root-owned, empty) ENTIRELY as root:
 * `git init` (empty template, no sample hooks), pack import from the bare store (both sides run
 * as root — the staging tree is not agent-owned yet), `read-tree --reset -u` from `sha`, ref setup
 * for `branch`, then the canonical origin config the closed allowlist (checkout-profile.ts)
 * recognizes. Never touched by AGENT_UID until `handOffToAgent` runs on the caller side.
 */
async function buildStagingCheckout(params: {
  readonly stagingPath: string
  readonly bareRepoPath: string
  readonly owner: string
  readonly repo: string
  readonly branch: string
  readonly sha: string
  readonly gitRunner: GitRunnerFn
  readonly packStreamRunner: (options: PackStreamOptions) => ReturnType<typeof runPackStream>
  readonly maxPackBytes: number
  readonly timeoutMs: number
}): Promise<BuildStagingOutcome> {
  const {stagingPath, bareRepoPath, owner, repo, branch, sha, gitRunner, packStreamRunner, maxPackBytes, timeoutMs} =
    params
  const env = buildNeutralGitEnv()
  const runLocal = async (args: readonly string[]) =>
    gitRunner(gitInvocation(stagingPath, stagingPath, args), {cwd: stagingPath, env, timeoutMs})

  const init = await gitRunner(['init', '--quiet', '--template=', stagingPath], {cwd: stagingPath, env, timeoutMs})
  if (init.kind === 'termination-unconfirmed') return {kind: 'termination-unconfirmed'}
  if (init.kind !== 'ok') return {kind: 'failed'}

  const packed = await packStreamRunner({
    writer: {
      command: 'git',
      args: ['--git-dir', bareRepoPath, 'pack-objects', '--quiet', '--revs', '--stdout'],
      cwd: bareRepoPath,
      env,
      stdin: `${sha}\n`,
    },
    reader: {
      command: 'git',
      args: [...gitInvocation(stagingPath, stagingPath, ['index-pack', '--stdin', '--strict'])],
      cwd: stagingPath,
      env: {...env, GIT_ALLOW_PROTOCOL: ''},
    },
    maxBytes: maxPackBytes,
    timeoutMs,
  })
  if (packed.kind === 'termination-unconfirmed') return {kind: 'termination-unconfirmed'}
  if (packed.kind !== 'ok') return {kind: 'failed'}

  const originUrl = `https://github.com/${owner}/${repo}.git`
  const steps: readonly (readonly string[])[] = [
    ['read-tree', '--reset', '-u', sha],
    ['update-ref', `refs/heads/${branch}`, sha],
    ['symbolic-ref', 'HEAD', `refs/heads/${branch}`],
    ['config', 'remote.origin.url', originUrl],
    ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ['config', `branch.${branch}.remote`, 'origin'],
    ['config', `branch.${branch}.merge`, `refs/heads/${branch}`],
  ]
  for (const args of steps) {
    const outcome = await runLocal(args)
    if (outcome.kind === 'termination-unconfirmed') return {kind: 'termination-unconfirmed'}
    if (outcome.kind !== 'ok') return {kind: 'failed'}
  }
  return {kind: 'ok'}
}

/** `<reposRoot>/.workspace-agent/quarantine/<owner>__<repo>/<recoveryId>/` — the root-owned envelope directory for one generation. Never itself the preserved checkout — see `QUARANTINE_CHECKOUT_DIR_NAME`'s doc comment (E1). */
function envelopePathFor(reposRoot: string, owner: string, repo: string, recoveryId: string): string {
  return join(reposRoot, WORKSPACE_STATE_DIR_NAME, QUARANTINE_DIR_NAME, `${owner}__${repo}`, recoveryId)
}

/**
 * Preserves the existing checkout at `checkoutPath` inside a fresh, root-owned ENVELOPE
 * (`<quarantine>/<owner>__<repo>/<recoveryId>/`): the original is renamed to the envelope's
 * `checkout/` subdirectory (never onto the envelope path itself — E1), and metadata.json is
 * written as a SIBLING of `checkout/`, so nothing ever writes into (or collides with) the
 * preserved content. Idempotent: if `checkout/` already exists, the rename is skipped (a prior
 * attempt already completed it — reconciliation, E3, relies on this).
 *
 * (Review round E, E2 regression fix) ALWAYS writes metadata — never `undefined` — so a
 * quarantine created by taking over an interrupted update (or by crash reconciliation) never
 * becomes a permanently `hasUnknownSize` generation that blocks every later recovery. Size/entry
 * count are measured with the E5 agent-uid walker AFTER the rename (measuring what's actually
 * preserved); `originalHeadSha`/`originalBranch` are supplied by the caller and are `undefined`
 * whenever reading them would be unsafe (interrupted-update/reconciliation sources).
 */
async function quarantineExistingCheckout(params: {
  readonly reposRoot: string
  readonly owner: string
  readonly repo: string
  readonly recoveryId: string
  readonly checkoutPath: string
  readonly source: QuarantineSource
  readonly originalHeadSha: string | undefined
  readonly originalBranch: string | undefined
  readonly now: () => Date
  readonly walkRunner: AgentWalkRunner
  readonly sealedWalkRunner: SealedWalkRunner
  readonly walkMaxEntries: number
  readonly walkDeadlineMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}): Promise<'ok' | 'failed' | 'termination-unconfirmed'> {
  const {reposRoot, owner, repo, recoveryId, checkoutPath, source, originalHeadSha, originalBranch, now} = params
  const {walkRunner, sealedWalkRunner, walkMaxEntries, walkDeadlineMs, uid, gid} = params
  const envelopePath = envelopePathFor(reposRoot, owner, repo, recoveryId)
  const envelopeCheckoutPath = join(envelopePath, QUARANTINE_CHECKOUT_DIR_NAME)

  // (Review round H, H4) Measure BEFORE the rename AND before the envelope itself is created (F4:
  // the tree is still agent-traversable at the canonical path here, with the repo lock held). An
  // uncertain outcome aborts here, before ANY durable state — not even an empty envelope
  // directory — exists for this attempt, exactly like the sealed-fallback path already does (G3).
  let measured: WalkOrFailOutcome = {kind: 'failed'}
  const originalStillAtCheckoutPath = await pathExists(checkoutPath)
  if (originalStillAtCheckoutPath) {
    measured = await walkCheckoutSize({
      walkRunner,
      rootPath: checkoutPath,
      maxEntries: walkMaxEntries,
      deadlineMs: walkDeadlineMs,
      uid,
      gid,
    })
    if (measured.kind === 'termination-unconfirmed') return 'termination-unconfirmed'
  }

  try {
    await mkdir(envelopePath, {recursive: true, mode: 0o700})
  } catch {
    return 'failed'
  }

  if (!(await pathExists(envelopeCheckoutPath))) {
    try {
      await rename(checkoutPath, envelopeCheckoutPath)
    } catch {
      return 'failed'
    }
  } else if (!originalStillAtCheckoutPath && !(measured.kind === 'ok' && measured.complete)) {
    // (F4) Legacy/replay: `checkout/` was already renamed into the envelope by a PRIOR attempt,
    // and there was nothing left at the canonical path to measure beforehand — the envelope's own
    // ancestors are root-owned mode 0700, blocking a plain agent-uid pathname walk, so the fd-
    // scoped sealed-tree walker is the only remaining option. (G3) Routed through the CALLER's
    // `sealedWalkRunner` (the tracker's wrapped one, never a direct `measureSealedTree` call) so an
    // unconfirmed termination here is recorded on the SAME tracker `runTrackedInvocation` checks —
    // a direct call would silently drop that signal. Propagated to the caller immediately, before
    // ANY metadata is written, so replay/execute never advances past uncertainty.
    const sealed = await sealedWalkRunner({
      dirPath: envelopeCheckoutPath,
      maxEntries: walkMaxEntries,
      deadlineMs: walkDeadlineMs,
      uid,
      gid,
      timeoutMs: walkDeadlineMs + WALK_TIMEOUT_BUFFER_MS,
    })
    if (sealed.kind === 'termination-unconfirmed') return 'termination-unconfirmed'
    if (sealed.kind === 'ok') measured = sealed
  }

  const fullMetadata: QuarantineMetadata = {
    recoveryId,
    owner,
    repo,
    createdAt: now().toISOString(),
    sizeBytes: measured.kind === 'ok' ? measured.totalBytes : 0,
    entryCount: measured.kind === 'ok' ? measured.entryCount : 0,
    sizeComplete: measured.kind === 'ok' && measured.complete,
    source,
    ...(originalHeadSha === undefined ? {} : {originalHeadSha}),
    ...(originalBranch === undefined ? {} : {originalBranch}),
  }
  return writeQuarantineMetadata(envelopePath, fullMetadata)
}

/** Verifies an installed checkout, AS THE AGENT IDENTITY (local profile): HEAD == `sha`, attached to `branch`, and clean against a fresh temp index built from `sha`. */

/** Verifies an installed checkout, AS THE AGENT IDENTITY (local profile): HEAD == `sha`, attached to `branch`, and clean against a fresh temp index built from `sha`. */
async function verifyInstalledCheckout(params: {
  readonly canonicalPath: string
  readonly branch: string
  readonly sha: string
  readonly gitRunner: GitRunnerFn
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}): Promise<'ok' | 'failed'> {
  const {canonicalPath, branch, sha, gitRunner, timeoutMs, uid, gid} = params
  const env = buildNeutralGitEnv()
  const headOutcome = await gitRunner(
    gitInvocation(canonicalPath, canonicalPath, ['rev-parse', '--verify', 'HEAD^{commit}']),
    {cwd: canonicalPath, env, timeoutMs, uid, gid},
  )
  if (headOutcome.kind !== 'ok' || headOutcome.stdout.trim() !== sha) return 'failed'

  const branchOutcome = await gitRunner(
    gitInvocation(canonicalPath, canonicalPath, ['symbolic-ref', '--short', 'HEAD']),
    {cwd: canonicalPath, env, timeoutMs, uid, gid},
  )
  if (branchOutcome.kind !== 'ok' || branchOutcome.stdout.trim() !== branch) return 'failed'

  const cleanliness = await checkTempIndexCleanliness({
    checkoutPath: canonicalPath,
    headSha: sha,
    gitRunner,
    timeoutMs,
    uid,
    gid,
  })
  return cleanliness.kind === 'clean' ? 'ok' : 'failed'
}

/** `<reposRoot>/.workspace-agent/staging/recover-<recoveryId>` — deterministic from `recoveryId` alone (never a random mkdtemp name) so crash reconciliation can find it without the journal carrying an extra field. */
function stagingPathFor(reposRoot: string, recoveryId: string): string {
  return join(reposRoot, WORKSPACE_STATE_DIR_NAME, CLONE_STAGING_DIR_NAME, `recover-${recoveryId}`)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

export type RecoveryReconciliationOutcome = 'cleared' | 'left-in-place' | 'left-in-place-missing-checkout'

/**
 * Applies the plan's recovery reconciliation table to one journal. At NO phase is the original
 * deleted or the canonical path left empty. (Review round E, E3): restart-safe — a crash DURING
 * replay itself must not be treated as if the journal's (possibly stale) `phase` field were the
 * only truth. Whether staging (`stagingPath`) still exists is the primary signal: staging is
 * consumed EXACTLY ONCE, by the install rename, so "staging still present" means install has not
 * run yet (whatever is at the canonical path, if anything, is still the untouched original and may
 * need quarantining first); "staging absent" means install already completed and the canonical
 * path already holds the fresh checkout — quarantining/installing are both skipped entirely, never
 * re-attempted against fresh content. Within "staging still present", the envelope's `checkout/`
 * existing means a PRIOR attempt already completed the quarantine rename. Each phase transition is
 * written durably via `advance()` BEFORE the next step runs, so a crash between two steps resumes
 * correctly on the next replay.
 */
async function reconcileOneRecoveryJournal(params: {
  readonly journalsDir: string
  readonly reposRoot: string
  readonly journal: RecoveryJournal
  readonly gitRunner: GitRunnerFn
  readonly walkRunner: AgentWalkRunner
  readonly sealedWalkRunner: SealedWalkRunner
  readonly now: () => Date
  readonly timeoutMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
}): Promise<RecoveryReconciliationOutcome> {
  const {journalsDir, reposRoot, journal, gitRunner, walkRunner, sealedWalkRunner, now, timeoutMs, uid, gid} = params
  const {owner, repo, recoveryId, targetSha, branch, startedAt} = journal
  const checkoutPath = join(reposRoot, owner, repo)
  const stagingPath = stagingPathFor(reposRoot, recoveryId)
  const envelopeCheckoutPath = join(envelopePathFor(reposRoot, owner, repo, recoveryId), QUARANTINE_CHECKOUT_DIR_NAME)

  const advance = async (phase: RecoveryJournalPhase): Promise<void> => {
    await writeJournal(journalsDir, {kind: 'recovery', owner, repo, phase, recoveryId, targetSha, branch, startedAt})
  }

  // (E7/F3) A `building` journal means nothing durable exists yet but staging — remove it. The
  // journal is RESTORED to `journal.supersededUpdate` (never merely deleted) when this recovery had
  // taken over an interrupted update, so the update journal — and the /update needs-recovery
  // barrier it enforces — survives a crash exactly as it survives a confirmed in-process failure.
  // If staging removal fails, the journal MUST stay (never silently clear over an unremoved leak).
  if (journal.phase === 'building') {
    try {
      await rm(stagingPath, {recursive: true, force: true})
    } catch {
      return 'left-in-place'
    }
    await rollbackBuildJournal(journalsDir, owner, repo, journal.supersededUpdate)
    return 'cleared'
  }

  if (await pathExists(stagingPath)) {
    const envelopeCheckoutExists = await pathExists(envelopeCheckoutPath)
    // (F7) Complete the quarantine — rename AND/OR metadata — whenever either half is still
    // missing, INDEPENDENTLY of whether a prior replay already finished the rename half. A rename
    // already done but crashing before its metadata write must not be replayed forever as
    // "nothing to do here": `readQuarantineMetadata` distinguishes genuinely absent/malformed
    // metadata (completed here) from valid metadata (left untouched, never re-stamped with the
    // generic `source: 'reconciliation'`/unknown provenance this call site would otherwise write).
    const envelopeHasValidMetadata =
      envelopeCheckoutExists &&
      (await readQuarantineMetadata(envelopePathFor(reposRoot, owner, repo, recoveryId))).ok === true
    if (!envelopeHasValidMetadata && ((await pathExists(checkoutPath)) || envelopeCheckoutExists)) {
      const result = await quarantineExistingCheckout({
        reposRoot,
        owner,
        repo,
        recoveryId,
        checkoutPath,
        source: 'reconciliation',
        originalHeadSha: undefined,
        originalBranch: undefined,
        now,
        walkRunner,
        sealedWalkRunner,
        walkMaxEntries: DEFAULT_WALK_MAX_ENTRIES,
        walkDeadlineMs: DEFAULT_WALK_DEADLINE_MS,
        uid,
        gid,
      })
      // (G3) Uncertainty stops replay before ANY further transition — never advance to
      // `installing`, never rename staging, never clear the journal. The outer
      // `runTrackedInvocation` (this journal's own tracker) sets the hold once this function
      // returns, since `sealedWalkRunner` above already recorded the uncertainty on it.
      if (result === 'termination-unconfirmed') return 'left-in-place'
      if (result === 'failed') return 'left-in-place'
    }
    await advance('installing')
    try {
      await mkdir(join(reposRoot, owner), {recursive: true, mode: 0o755})
      await rename(stagingPath, checkoutPath)
    } catch {
      return 'left-in-place'
    }
  } else if (!(await pathExists(checkoutPath))) {
    return 'left-in-place-missing-checkout'
  }
  await advance('verifying')

  const verified = await verifyInstalledCheckout({
    canonicalPath: checkoutPath,
    branch,
    sha: targetSha,
    gitRunner,
    timeoutMs,
    uid,
    gid,
  })
  if (verified !== 'ok') return 'left-in-place'
  await removeJournal(journalsDir, owner, repo)
  return 'cleared'
}

export interface ReconcileRecoveryJournalsOnStartupDeps {
  readonly gitRunner?: GitRunnerFn
  /** (Review round G, G3) Test seam — injectable so a test can simulate an unconfirmed termination during the fd-scoped sealed-tree fallback measurement without a real subprocess. Defaults to the real `measureSealedTree`. */
  readonly sealedWalkRunner?: SealedWalkRunner
  readonly now?: () => Date
  readonly reposRoot?: string
  readonly options?: {readonly timeoutMs?: number; readonly uid?: number; readonly gid?: number}
  readonly logger: {
    readonly info: (msg: string, meta?: Record<string, unknown>) => void
    readonly warn: (msg: string, meta?: Record<string, unknown>) => void
    readonly error: (msg: string, meta?: Record<string, unknown>) => void
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reconciles every OUTSTANDING recovery journal exactly once, at startup, before the server
 * accepts requests — mirrors update.ts's own `reconcileUpdateJournalsOnStartup`, but is NOT called
 * by it: the two run side by side from main.ts (slice 5c wires the call; this function exists so
 * that wiring is a one-line addition). Never throws: a directory-level fault or an unexpected
 * per-journal error is logged and the journal is left in place rather than blocking startup.
 */
export async function reconcileRecoveryJournalsOnStartup(deps: ReconcileRecoveryJournalsOnStartupDeps): Promise<void> {
  const {
    reposRoot = WORKSPACE_REPOS_ROOT,
    gitRunner = runGit,
    sealedWalkRunner: injectedSealedWalkRunner,
    now = () => new Date(),
    options = {},
    logger,
  } = deps
  const {timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS, uid = AGENT_UID, gid = AGENT_GID} = options
  const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)

  let entries: readonly JournalListEntry[]
  try {
    entries = await listJournals(journalsDir)
  } catch (error) {
    logger.error('recover: startup journal reconciliation could not list journals — leaving all as-is', {
      error: errorMessage(error),
    })
    return
  }

  for (const entry of entries) {
    if (entry.result.ok === false) continue
    const journal = entry.result.journal
    if (journal.kind !== 'recovery') continue
    const {owner, repo, phase} = journal
    const repoKey = repoMutexKey(owner, repo)
    try {
      await withRepoLock(repoKey, async () => {
        if (repoHoldReason(repoKey) !== undefined) {
          logger.warn('recover: startup reconciliation skipping a repository under maintenance hold', {
            owner,
            repo,
            phase,
          })
          return
        }
        // (D1) Routed through the shared choke point so a throw from `reconcileOneRecoveryJournal`
        // still holds the repository, not only an ordinary non-'cleared' return.
        const tracker = createInvocationTracker({gitRunner, sealedWalkRunner: injectedSealedWalkRunner})
        await runTrackedInvocation(
          repoKey,
          tracker,
          async () => {
            const outcome = await reconcileOneRecoveryJournal({
              journalsDir,
              reposRoot,
              journal,
              gitRunner: tracker.gitRunner,
              walkRunner: tracker.walkRunner,
              sealedWalkRunner: tracker.sealedWalkRunner,
              now,
              timeoutMs,
              uid,
              gid,
            })
            logger[outcome === 'cleared' ? 'info' : 'warn'](`recover: startup reconciliation ${outcome} a journal`, {
              owner,
              repo,
              phase,
            })
          },
          () => {
            logger.warn('recover: reconciliation subprocess termination could not be confirmed — holding repository', {
              owner,
              repo,
              phase,
            })
          },
        )
      })
    } catch (error) {
      logger.error('recover: startup reconciliation failed unexpectedly for one journal — leaving it in place', {
        owner,
        repo,
        phase,
        error: errorMessage(error),
      })
    }
  }
}

type PreflightOutcome =
  | {readonly kind: 'ok'}
  | {readonly kind: 'refused'; readonly reason: 'quota-exceeded'; readonly usage: RetentionUsage}
  | {readonly kind: 'refused'; readonly reason: 'insufficient-disk-space'}

/**
 * Quota (5 generations / 10 GiB) then free-space (`estimatedSizeBytes * diskHeadroomMultiplier`)
 * — checked BEFORE anything is built or moved, per the plan's "refuses before building"/"refuses
 * before any rename". (Review round E, E4) The quota check is PROJECTED — existing usage PLUS the
 * incoming generation this call is about to create — never existing usage alone; a generation
 * whose size could not be measured (malformed/unreadable metadata) fails the quota check closed
 * (`hasUnknownSize`) rather than silently contributing zero bytes.
 */
async function checkRecoveryPreflight(params: {
  readonly reposRoot: string
  readonly estimatedSizeBytes: number
  readonly retention: RetentionUsage
  readonly hasUnknownSize: boolean
  readonly diskHeadroomMultiplier: number
  readonly statfsFn: RecoveryStatfsFn
}): Promise<PreflightOutcome> {
  const {reposRoot, estimatedSizeBytes, retention, hasUnknownSize, diskHeadroomMultiplier, statfsFn} = params
  const projectedCount = retention.generationCount + 1
  const projectedBytes = retention.totalBytes + estimatedSizeBytes
  if (hasUnknownSize || projectedCount > retention.maxGenerations || projectedBytes > retention.maxBytes) {
    return {kind: 'refused', reason: 'quota-exceeded', usage: retention}
  }
  let stats: {readonly bavail: number; readonly bsize: number}
  try {
    stats = await statfsFn(reposRoot)
  } catch {
    return {kind: 'refused', reason: 'insufficient-disk-space'}
  }
  const availableBytes = stats.bavail * stats.bsize
  if (availableBytes < estimatedSizeBytes * diskHeadroomMultiplier) {
    return {kind: 'refused', reason: 'insufficient-disk-space'}
  }
  return {kind: 'ok'}
}

/** Every dependency `runRecoveryMutation` needs, already resolved from `ExecuteRecoveryDeps` defaults by `executeRecovery`. */
/**
 * (Review round F, F3) Rolls back a pre-quarantine recovery failure's journal: RESTORES
 * `supersededUpdate` (if this recovery took over an interrupted update) rather than deleting,
 * since the update journal, and the `/update` `needs-recovery` barrier it enforces, must survive a
 * confirmed build/handoff failure exactly as if the recovery attempt had never started. Removes
 * the journal outright only when there was nothing to restore.
 */
async function rollbackBuildJournal(
  journalsDir: string,
  owner: string,
  repo: string,
  supersededUpdate: UpdateJournal | undefined,
): Promise<void> {
  if (supersededUpdate === undefined) {
    await removeJournal(journalsDir, owner, repo)
    return
  }
  await writeJournal(journalsDir, supersededUpdate)
}

interface RecoveryMutationContext {
  readonly owner: string
  readonly repo: string
  readonly token: string
  readonly fingerprint: string
  readonly reposRoot: string
  readonly journalsDir: string
  readonly checkoutPath: string
  readonly tracker: InvocationTracker
  readonly timeoutMs: number
  readonly uid: number
  readonly gid: number
  readonly now: () => Date
  readonly walkDeadlineMs: number
  readonly walkMaxEntries: number
  readonly monotonicNow: () => number
  readonly remoteBaseUrl: string
  readonly caBundlePath: string | undefined
  readonly proxy: {readonly https: string; readonly noProxy?: string} | undefined
  readonly askpassWriter: (dir: string) => Promise<string>
  readonly serviceHome: string
  readonly networkBudgetMs: number
  readonly buildTimeoutMs: number
  readonly maxPackBytes: number
  readonly diskHeadroomMultiplier: number
  readonly statfsFn: RecoveryStatfsFn
  readonly recoveryId: string
}

/**
 * The full mutation sequence, run entirely under the caller's repo lock and tracker. Returns a
 * best-effort result for the tracker/hold choke point in `executeRecovery` to override when an
 * unconfirmed termination occurred anywhere in this call — this function itself never clears the
 * journal except on a fully verified success.
 */
async function runRecoveryMutation(ctx: RecoveryMutationContext): Promise<ExecuteRecoveryResult> {
  const {owner, repo, token, fingerprint, reposRoot, journalsDir, checkoutPath, tracker, recoveryId} = ctx
  const {timeoutMs, uid, gid, now, walkDeadlineMs, walkMaxEntries, monotonicNow} = ctx
  const gitRunner = tracker.gitRunner
  const packStreamRunner = tracker.packStreamRunner
  const walkRunner = tracker.walkRunner
  const sealedWalkRunner = tracker.sealedWalkRunner

  const preview = await computeRecoveryPreviewLocked(owner, repo, {
    gitRunner,
    walkRunner,
    reposRoot,
    timeoutMs,
    uid,
    gid,
    now,
    walkDeadlineMs,
    walkMaxEntries,
  })
  if (preview.kind === 'refused')
    return {
      kind: 'refused',
      reason: preview.reason,
      ...('phase' in preview ? {phase: preview.phase} : {}),
    } as ExecuteRecoveryResult
  if (preview.kind === 'failed') return {kind: 'failed', reason: 'inspection-failed'}

  let estimatedSizeBytes = 0
  let retention: RetentionUsage = {
    generationCount: 0,
    totalBytes: 0,
    hasUnknownSize: false,
    maxGenerations: RETENTION_MAX_GENERATIONS,
    maxBytes: RETENTION_MAX_BYTES,
  }
  // (E2) An interrupted UPDATE journal: checked out fingerprint against the JOURNAL's own
  // identity (never a live git inspection — the checkout may be mid-merge). There IS a checkout
  // to quarantine (whatever the interrupted update left behind), but its safe headSha/branch are
  // unknown, so its own quarantine metadata degrades exactly like reconciliation's does.
  const hadExistingCheckout = preview.kind === 'ok' || preview.kind === 'recoverable-update'
  if (preview.kind === 'ok') {
    // (E4) An incomplete walk is never trusted as a lower bound for a quota/disk decision — refuse
    // rather than admit on a possibly-undercounted size, exactly at the point this evidence is
    // actually ACTED on (never in previewRecovery itself, which reports the degraded estimate as
    // information, not a decision). Checked BEFORE the fingerprint comparison: an incomplete walk
    // makes the fingerprint ITSELF unreliable (it digests the walk's own totals), so "the size
    // could not be measured" is always the more honest answer than a spurious `checkout-changed`.
    if (!preview.preview.sizeMeasurementComplete) return {kind: 'failed', reason: 'inspection-failed'}
    if (preview.preview.fingerprint !== fingerprint) return {kind: 'refused', reason: 'checkout-changed'}
    estimatedSizeBytes = preview.preview.estimatedSizeBytes
    retention = preview.preview.retention
  } else if (preview.kind === 'recoverable-update') {
    // (F6) Same ordering rationale as the safe path above: completeness is checked BEFORE the
    // fingerprint, which digests the walk's own totals.
    if (!preview.update.sizeMeasurementComplete) return {kind: 'failed', reason: 'inspection-failed'}
    if (preview.update.fingerprint !== fingerprint) return {kind: 'refused', reason: 'checkout-changed'}
    estimatedSizeBytes = preview.update.estimatedSizeBytes
  }
  if (preview.kind !== 'ok') {
    // (E4) A `listBackups` failure must never fail OPEN as "zero existing generations" — refuse.
    const fresh = await listBackups(owner, repo, {reposRoot, walkRunner, uid, gid})
    if (fresh.kind !== 'ok') return {kind: 'failed', reason: 'inspection-failed'}
    retention = {
      generationCount: fresh.backups.length,
      totalBytes: fresh.totalBytes,
      hasUnknownSize: fresh.backups.some(backup => !backup.metadataOk || !backup.sizeComplete),
      maxGenerations: RETENTION_MAX_GENERATIONS,
      maxBytes: RETENTION_MAX_BYTES,
    }
  }

  const preflight = await checkRecoveryPreflight({
    reposRoot,
    estimatedSizeBytes,
    retention,
    hasUnknownSize: retention.hasUnknownSize,
    diskHeadroomMultiplier: ctx.diskHeadroomMultiplier,
    statfsFn: ctx.statfsFn,
  })
  if (preflight.kind !== 'ok') return preflight

  // (F3) Re-reads the journal (still under this call's repo lock — unchanged since the preview
  // above) to capture the FULL original update journal this recovery is about to supersede, so it
  // can be RESTORED (never merely deleted) if this recovery fails or crashes before quarantine.
  let supersededUpdate: UpdateJournal | undefined
  if (preview.kind === 'recoverable-update') {
    const priorJournal = await readJournal(journalsDir, owner, repo)
    if (priorJournal.ok === true && priorJournal.journal.kind === 'update') {
      supersededUpdate = priorJournal.journal
    }
  }

  // (Review round D, D5) The FIRST journal write is deferred until the recovery target (branch +
  // sha) is actually known — see below, right before staging begins — so `targetSha`/`branch` are
  // never absent from any recovery journal this function writes. Nothing before that point mutates
  // anything durable (the bare fetch store is root-owned and self-healing — D3), so there is
  // nothing for a crash in this earlier window to leave inconsistent.
  const fetchStorePath = fetchStorePathFor(reposRoot, owner, repo)
  const storeReady = await ensureBareFetchStore({fetchStorePath, gitRunner, timeoutMs})
  if (storeReady !== 'ok') return {kind: 'failed', reason: 'fetch-failed'}

  const askpassDir = await mkdtemp(join(tmpdir(), 'workspace-agent-recover-askpass-'))
  const stagingPath = stagingPathFor(reposRoot, recoveryId)
  let target: {readonly branch: string; readonly sha: string}
  try {
    const askpassPath = await ctx.askpassWriter(askpassDir)
    const profile = buildNetworkGitProfile({
      bareRepoPath: fetchStorePath,
      serviceHome: ctx.serviceHome,
      askpassPath,
      token,
      caBundlePath: ctx.caBundlePath,
      proxy: ctx.proxy,
      parentEnv: process.env,
    })
    const remoteUrl = `${ctx.remoteBaseUrl}/${owner}/${repo}.git`
    const deadline = createDeadline(ctx.networkBudgetMs, monotonicNow)
    tracker.setDeadline(deadline)
    const fetched = await fetchRecoveryTarget({profile, remoteUrl, gitRunner, deadline})
    tracker.setDeadline(undefined)
    if (fetched.kind !== 'ok') return {kind: 'failed', reason: 'fetch-failed'}
    target = fetched

    // (E2) ATOMIC HAND-OVER: journal.ts keeps exactly one journal file per repository
    // (`<owner>__<repo>.json`), written by temp-file-then-`rename`. Writing THIS recovery journal
    // therefore atomically REPLACES whatever journal (including an interrupted update's) already
    // sat at that path — there is no separate "remove the update journal" step, and no window
    // where this repository has no journal at all: the old journal is superseded the instant this
    // write's rename succeeds, never before.
    await writeJournal(journalsDir, {
      kind: 'recovery',
      owner,
      repo,
      phase: 'building',
      recoveryId,
      targetSha: target.sha,
      branch: target.branch,
      startedAt: now().toISOString(),
      ...(supersededUpdate === undefined ? {} : {supersededUpdate}),
    })

    // (E7) Created EXCLUSIVELY — never silently reused — so a leftover leaf from an earlier,
    // never-cleaned-up attempt at this same (vanishingly unlikely, randomUUID) recoveryId fails
    // closed instead of building on top of unknown content.
    await mkdir(dirname(stagingPath), {recursive: true, mode: 0o700})
    await mkdir(stagingPath, {mode: 0o700})
    // (E6) One aggregate build deadline, installed on the tracker before staging init and kept
    // through pack import and every subsequent build git call — cleared only after handoff.
    const buildDeadline = createDeadline(ctx.buildTimeoutMs, monotonicNow)
    tracker.setDeadline(buildDeadline)
    tracker.markApplyingPhase()
    const built = await buildStagingCheckout({
      stagingPath,
      bareRepoPath: fetchStorePath,
      owner,
      repo,
      branch: target.branch,
      sha: target.sha,
      gitRunner,
      packStreamRunner,
      maxPackBytes: ctx.maxPackBytes,
      timeoutMs: ctx.buildTimeoutMs,
    })
    if (built.kind === 'failed') {
      // (E7/F3) A CONFIRMED (not unconfirmed) pre-quarantine failure: nothing durable exists but
      // staging, so remove it. The journal is RESTORED to the superseded update journal (never
      // merely deleted) when this recovery took over an interrupted update — F3: the evidence, and
      // the /update needs-recovery barrier it enforces, must survive. If staging removal itself
      // fails, the journal MUST stay exactly as this recovery left it — never touched.
      try {
        await rm(stagingPath, {recursive: true, force: true})
        await rollbackBuildJournal(journalsDir, owner, repo, supersededUpdate)
      } catch {
        // journal stays in place
      }
      return {kind: 'failed', reason: 'build-failed'}
    }
    if (built.kind !== 'ok') return {kind: 'failed', reason: 'build-failed'}
  } finally {
    await rm(askpassDir, {recursive: true, force: true}).catch(() => {})
  }

  const handoff = await handOffToAgent(stagingPath, {
    uid,
    gid,
    deadlineMs: HANDOFF_DEADLINE_MS,
    maxEntries: MAX_HANDOFF_ENTRIES,
  })
  // (E6) The aggregate build deadline is cleared only now — handoff itself is filesystem-only,
  // never a tracked git/pack-stream call, but it is still logically part of "the build".
  tracker.setDeadline(undefined)
  if (handoff.ok !== true) {
    // (E7/F3) Handoff failure is always CONFIRMED (filesystem-only lstat/lchown, no subprocess) —
    // clean up (and restore any superseded update journal) the same way a confirmed build failure does.
    try {
      await rm(stagingPath, {recursive: true, force: true})
      await rollbackBuildJournal(journalsDir, owner, repo, supersededUpdate)
    } catch {
      // journal stays in place
    }
    return {kind: 'failed', reason: 'build-failed'}
  }

  await writeJournal(journalsDir, {
    kind: 'recovery',
    owner,
    repo,
    phase: 'quarantining',
    recoveryId,
    targetSha: target.sha,
    branch: target.branch,
    startedAt: now().toISOString(),
  })
  if (hadExistingCheckout) {
    // (E2 regression fix) ALWAYS quarantines with real metadata (measured fresh by
    // quarantineExistingCheckout itself, via the E5 walker) — an interrupted-update checkout's
    // headSha/branch are never safe to read (it may be mid-merge), so only THOSE two fields are
    // omitted for that source; size/entry count are never skipped.
    const quarantined = await quarantineExistingCheckout({
      reposRoot,
      owner,
      repo,
      recoveryId,
      checkoutPath,
      source: preview.kind === 'ok' ? 'recovery' : 'interrupted-update',
      originalHeadSha: preview.kind === 'ok' && preview.preview.inspectionSafe ? preview.preview.headSha : undefined,
      originalBranch: preview.kind === 'ok' && preview.preview.inspectionSafe ? preview.preview.branch : undefined,
      now,
      walkRunner,
      sealedWalkRunner,
      walkMaxEntries: ctx.walkMaxEntries,
      walkDeadlineMs: ctx.walkDeadlineMs,
      uid,
      gid,
    })
    // (G3) `!== 'ok'` already covers BOTH 'failed' and 'termination-unconfirmed' — either way this
    // stops here, before the 'installing' journal write and the staging rename. The outer
    // `runTrackedInvocation` (executeRecovery's choke point) overrides this whole result to
    // `{kind:'failed', reason:'termination-unconfirmed'}` if `sealedWalkRunner` above recorded
    // uncertainty — this return value is a safe placeholder for that case, never the final answer.
    if (quarantined !== 'ok') return {kind: 'failed', reason: 'quarantine-failed'}
  }

  await writeJournal(journalsDir, {
    kind: 'recovery',
    owner,
    repo,
    phase: 'installing',
    recoveryId,
    targetSha: target.sha,
    branch: target.branch,
    startedAt: now().toISOString(),
  })
  try {
    await mkdir(join(reposRoot, owner), {recursive: true, mode: 0o755})
    await rename(stagingPath, checkoutPath)
  } catch {
    return {kind: 'failed', reason: 'install-failed'}
  }

  await writeJournal(journalsDir, {
    kind: 'recovery',
    owner,
    repo,
    phase: 'verifying',
    recoveryId,
    targetSha: target.sha,
    branch: target.branch,
    startedAt: now().toISOString(),
  })
  const verified = await verifyInstalledCheckout({
    canonicalPath: checkoutPath,
    branch: target.branch,
    sha: target.sha,
    gitRunner,
    timeoutMs,
    uid,
    gid,
  })
  if (verified !== 'ok') return {kind: 'failed', reason: 'verification-failed'}

  await removeJournal(journalsDir, owner, repo)
  return {kind: 'ok', recoveryId, sha: target.sha, branch: target.branch}
}

/**
 * Confirms and executes a previously previewed recovery: quarantines the existing checkout (if
 * any) and installs a fresh one at the remote's current default branch tip. See the module header
 * and the plan's Unit 5 for the full admission-gated mutation model. ONE `InvocationTracker` wraps
 * every git/pack-stream call this invocation makes (including the fingerprint recompute) — an
 * unconfirmed subprocess termination ANYWHERE holds the repository and leaves the journal in
 * place, exactly like update.ts's `executeUpdate`. The hold check runs in a `finally` so it fires
 * even if a later step throws, not only on an ordinary return (review round: "a return-only choke
 * point misses exceptions").
 */
export async function executeRecovery(
  request: ExecuteRecoveryRequest,
  deps: ExecuteRecoveryDeps = {},
): Promise<ExecuteRecoveryResult> {
  const {
    gitRunner: injectedGitRunner = runGit,
    packStreamRunner: injectedPackStreamRunner = runPackStream,
    walkRunner: injectedWalkRunner,
    reposRoot = WORKSPACE_REPOS_ROOT,
    options = {},
    now = () => new Date(),
    walkDeadlineMs = DEFAULT_WALK_DEADLINE_MS,
    walkMaxEntries = DEFAULT_WALK_MAX_ENTRIES,
    monotonicNow = () => performance.now(),
    remoteBaseUrl = DEFAULT_REMOTE_BASE_URL,
    caBundlePath,
    proxy,
    askpassWriter = writeAskpassHelper,
    serviceHome = DEFAULT_SERVICE_HOME,
    networkBudgetMs = DEFAULT_NETWORK_BUDGET_MS,
    buildTimeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
    maxPackBytes = DEFAULT_MAX_PACK_BYTES,
    diskHeadroomMultiplier = DEFAULT_DISK_HEADROOM_MULTIPLIER,
    statfsFn = defaultStatfs,
    recoveryIdFn = randomUUID,
  } = deps
  const {timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS, uid = AGENT_UID, gid = AGENT_GID} = options
  const {owner, repo} = request
  const repoKey = repoMutexKey(owner, repo)

  return withRepoLock(repoKey, async (): Promise<ExecuteRecoveryResult> => {
    if (repoHoldReason(repoKey) !== undefined) return {kind: 'refused', reason: 'maintenance-hold'}

    const tracker = createInvocationTracker({
      gitRunner: injectedGitRunner,
      packStreamRunner: injectedPackStreamRunner,
      walkRunner: injectedWalkRunner,
    })
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const checkoutPath = join(reposRoot, owner, repo)

    // (D1) Shared choke point (update.ts) — sets the hold in a try/finally so it fires even if
    // `runRecoveryMutation` throws, not only on an ordinary return.
    return runTrackedInvocation(
      repoKey,
      tracker,
      async () =>
        runRecoveryMutation({
          owner,
          repo,
          token: request.token,
          fingerprint: request.fingerprint,
          reposRoot,
          journalsDir,
          checkoutPath,
          tracker,
          timeoutMs,
          uid,
          gid,
          now,
          walkDeadlineMs,
          walkMaxEntries,
          monotonicNow,
          remoteBaseUrl,
          caBundlePath,
          proxy,
          askpassWriter,
          serviceHome,
          networkBudgetMs,
          buildTimeoutMs,
          maxPackBytes,
          diskHeadroomMultiplier,
          statfsFn,
          recoveryId: recoveryIdFn(),
        }),
      (): ExecuteRecoveryResult => ({kind: 'failed', reason: 'termination-unconfirmed'}),
    )
  })
}
