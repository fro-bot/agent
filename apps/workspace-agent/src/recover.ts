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

import type {GitRunnerFn} from './git-safety.js'
import type {RecoveryJournalPhase, UpdateJournalPhase} from './journal.js'
import type {CheckoutOperation} from './types.js'

import {createHash} from 'node:crypto'
import {lstat, readdir, realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {performance} from 'node:perf_hooks'

import {listBackups} from './backups.js'
import {checkCheckoutLayout, inventoryCheckoutConfig} from './checkout-profile.js'
import {
  buildFilterNeutralizationEnv,
  buildNeutralGitEnv,
  enumerateFilterDrivers,
  gitInvocation,
  runGit,
} from './git-safety.js'
import {AGENT_GID, AGENT_UID, JOURNAL_DIR_NAME, WORKSPACE_STATE_DIR_NAME} from './identity.js'
import {inspectCheckout} from './inspect.js'
import {readJournal} from './journal.js'
import {repoHoldReason, repoMutexKey, withRepoLock} from './repo-mutex.js'

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

export interface PreviewRecoveryRequest {
  readonly owner: string
  readonly repo: string
}

export interface DirtyCounts {
  readonly staged: number
  readonly unstaged: number
  readonly untracked: number
  readonly conflicted: number
}

/** Current usage against the fixed retention quota. */
export interface RetentionUsage {
  readonly generationCount: number
  readonly totalBytes: number
  readonly maxGenerations: number
  readonly maxBytes: number
}

/** Full preview — `inspectionSafe: true` — every admission check the checkout would face passed. */
export interface SafeRecoveryPreview {
  readonly inspectionSafe: true
  /** HEAD SHA, or undefined for an unborn/no-HEAD checkout. */
  readonly headSha: string | undefined
  /** Current branch, or undefined if HEAD is detached. */
  readonly branch: string | undefined
  readonly dirty: DirtyCounts
  readonly operationInProgress: CheckoutOperation
  readonly ignoredCount: number
  readonly estimatedSizeBytes: number
  readonly entryCount: number
  readonly retention: RetentionUsage
  /** Digest of headSha, dirty counts, and size+entryCount \u2014 see computeFingerprint's doc comment. */
  readonly fingerprint: string
}

/** Opaque preview \u2014 `inspectionSafe: false` \u2014 admission would refuse the checkout (e.g. a hostile config); no git ever ran in it. */
export interface OpaqueRecoveryPreview {
  readonly inspectionSafe: false
  readonly estimatedSizeBytes: number
  readonly entryCount: number
  readonly retention: RetentionUsage
  /** Digest of ONLY size+entryCount \u2014 see computeFingerprint's doc comment. */
  readonly fingerprint: string
}

export type RecoveryPreview = SafeRecoveryPreview | OpaqueRecoveryPreview

/** A journal (update or recovery) currently in flight for this repository \u2014 unlike update.ts's blanket `needs-recovery`, the OPERATOR-FACING preview names the exact phase, since that is precisely what recovery exists to act on. */
export type JournalInProgressPhase = UpdateJournalPhase | RecoveryJournalPhase | 'malformed'

/**
 * `'inspection-failed'` covers every non-mutating local check that could not determine an answer
 * — INCLUDING an unconfirmed subprocess termination: `checkCheckoutLayout`/`inventoryCheckoutConfig`/
 * `inspectCheckout` all already collapse `termination-unconfirmed` into their own `inspection-failed`
 * (or, for `inspectCheckout`, `inspection-timeout`) outcomes before this module ever sees them, so
 * this preview has no reliable signal to distinguish "confirmed failure" from "unconfirmed
 * termination" and therefore never calls `markRepoHeld` itself — unlike update.ts, which reads that
 * distinction directly from `GitOutcome`/`PackStreamOutcome` before either is collapsed.
 */
export type PreviewRecoveryResult =
  | {readonly kind: 'no-checkout'}
  | {readonly kind: 'refused'; readonly reason: 'checkout-substituted'}
  | {readonly kind: 'refused'; readonly reason: 'maintenance-hold'}
  | {readonly kind: 'refused'; readonly reason: 'journal-in-progress'; readonly phase: JournalInProgressPhase}
  | {readonly kind: 'failed'; readonly reason: 'inspection-failed'}
  | {readonly kind: 'ok'; readonly preview: RecoveryPreview}

export interface PreviewRecoveryDeps {
  readonly gitRunner?: GitRunnerFn
  readonly reposRoot?: string
  readonly options?: {readonly timeoutMs?: number; readonly uid?: number; readonly gid?: number}
  readonly now?: () => Date
  readonly walkDeadlineMs?: number
  readonly walkMaxEntries?: number
  /** Injected monotonic clock for the filesystem walk's own deadline. Defaults to `performance.now()`. */
  readonly monotonicNow?: () => number
}

// ---------------------------------------------------------------------------
// Filesystem size/entry-count walk \u2014 read-only mirror of handoff.ts's own bounded-walk shape:
// `lstat`, never `stat`; a symlink is never followed (only its own size is counted); never crosses
// a filesystem boundary (`st_dev`); bounded by both a wall-clock deadline and an entry-count cap,
// both checked before every entry is processed. Unlike handoff.ts this never chowns/chmods
// anything and never fails closed on an unusual node type (fifo/socket/device) \u2014 this walk
// produces an ESTIMATE for an operator preview, not a security-relevant handoff; a pathological or
// unusual entry degrades the estimate rather than the whole preview.
// ---------------------------------------------------------------------------

interface WalkSizeResult {
  readonly totalBytes: number
  readonly entryCount: number
  /** False when the deadline or entry cap was hit \u2014 the reported totals are a lower-bound estimate, not exact. */
  readonly complete: boolean
}

interface WalkContext {
  rootDev: number | undefined
  readonly deadlineAt: number
  readonly maxEntries: number
  readonly now: () => number
  entries: number
  totalBytes: number
  capped: boolean
}

async function walkSize(entryPath: string, ctx: WalkContext): Promise<void> {
  if (ctx.capped) return
  if (ctx.now() > ctx.deadlineAt) {
    ctx.capped = true
    return
  }
  if (ctx.entries >= ctx.maxEntries) {
    ctx.capped = true
    return
  }
  ctx.entries += 1

  let st
  try {
    st = await lstat(entryPath)
  } catch {
    return // vanished mid-walk \u2014 not fatal for an estimate
  }

  if (ctx.rootDev === undefined) ctx.rootDev = st.dev
  else if (st.dev !== ctx.rootDev) return // foreign filesystem \u2014 never descend, never count its bytes

  if (st.isSymbolicLink()) {
    ctx.totalBytes += st.size // never followed \u2014 only the symlink's own size is counted
    return
  }
  if (st.isDirectory()) {
    let names: readonly string[]
    try {
      names = await readdir(entryPath)
    } catch {
      return
    }
    for (const name of names) {
      if (ctx.capped) return
      await walkSize(join(entryPath, name), ctx)
    }
    return
  }
  if (st.isFile()) {
    ctx.totalBytes += st.size
  }
  // fifo/socket/device, etc.: 0 bytes contributed, already counted as an entry above.
}

async function walkCheckoutSize(
  rootPath: string,
  options: {readonly deadlineMs: number; readonly maxEntries: number; readonly now: () => number},
): Promise<WalkSizeResult> {
  const ctx: WalkContext = {
    rootDev: undefined,
    deadlineAt: options.now() + options.deadlineMs,
    maxEntries: options.maxEntries,
    now: options.now,
    entries: 0,
    totalBytes: 0,
    capped: false,
  }
  await walkSize(rootPath, ctx)
  return {totalBytes: ctx.totalBytes, entryCount: ctx.entries, complete: !ctx.capped}
}

// ---------------------------------------------------------------------------
// Canonical-path resolution \u2014 filesystem-only (no git), so this can run even when the checkout's
// config is hostile. Mirrors inspect.ts's own substitution check (steps 1-2 of that module) exactly.
// ---------------------------------------------------------------------------

type CanonicalCheckoutResult =
  | {readonly kind: 'ok'; readonly path: string}
  | {readonly kind: 'no-checkout'}
  | {readonly kind: 'checkout-substituted'}

async function resolveCanonicalCheckout(
  reposRoot: string,
  owner: string,
  repo: string,
): Promise<CanonicalCheckoutResult> {
  let reposRootResolved: string
  try {
    reposRootResolved = await realpath(reposRoot)
  } catch {
    return {kind: 'no-checkout'}
  }
  const destPath = join(reposRoot, owner, repo)
  let canonicalResolved: string
  try {
    canonicalResolved = await realpath(destPath)
  } catch {
    return {kind: 'no-checkout'}
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
 * Reports what a `/recover` call would see for `request.owner`/`request.repo`, without mutating
 * anything. See the module header for the full admission-gated safety model.
 */
export async function previewRecovery(
  request: PreviewRecoveryRequest,
  deps: PreviewRecoveryDeps = {},
): Promise<PreviewRecoveryResult> {
  const {
    gitRunner = runGit,
    reposRoot = WORKSPACE_REPOS_ROOT,
    options = {},
    now = () => new Date(),
    walkDeadlineMs = DEFAULT_WALK_DEADLINE_MS,
    walkMaxEntries = DEFAULT_WALK_MAX_ENTRIES,
    monotonicNow = () => performance.now(),
  } = deps
  const {timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS, uid = AGENT_UID, gid = AGENT_GID} = options
  const {owner, repo} = request

  return withRepoLock(repoMutexKey(owner, repo), async (): Promise<PreviewRecoveryResult> => {
    // Checked first, before even the journal \u2014 mirrors update.ts's own step 0.
    if (repoHoldReason(repoMutexKey(owner, repo)) !== undefined) {
      return {kind: 'refused', reason: 'maintenance-hold'}
    }

    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const journalRead = await readJournal(journalsDir, owner, repo)
    if (journalRead.ok === true) {
      return {kind: 'refused', reason: 'journal-in-progress', phase: journalRead.journal.phase}
    }
    if (journalRead.ok === false && journalRead.reason === 'malformed') {
      return {kind: 'refused', reason: 'journal-in-progress', phase: 'malformed'}
    }

    const canonical = await resolveCanonicalCheckout(reposRoot, owner, repo)
    if (canonical.kind === 'no-checkout') return {kind: 'no-checkout'}
    if (canonical.kind === 'checkout-substituted') return {kind: 'refused', reason: 'checkout-substituted'}
    const canonicalPath = canonical.path

    // Admission gate: layout is pure filesystem (no git at all); config inventory is one inert
    // `git config --list` call \u2014 never a working-tree-reading command, so running it does not
    // violate "no git in the checkout" for a hostile-config checkout the way `git status` would.
    const layout = await checkCheckoutLayout({checkoutPath: canonicalPath, timeoutMs, uid, gid})
    let inspectionSafe = layout.kind === 'ok'
    if (inspectionSafe) {
      const configInventory = await inventoryCheckoutConfig({
        checkoutPath: canonicalPath,
        gitRunner,
        timeoutMs,
        uid,
        gid,
      })
      inspectionSafe = configInventory.kind === 'allowed'
    }

    const walk = await walkCheckoutSize(canonicalPath, {
      deadlineMs: walkDeadlineMs,
      maxEntries: walkMaxEntries,
      now: monotonicNow,
    })

    const retentionResult = await listBackups(owner, repo, {reposRoot})
    if (retentionResult.kind !== 'ok') return {kind: 'failed', reason: 'inspection-failed'}
    const retention: RetentionUsage = {
      generationCount: retentionResult.backups.length,
      totalBytes: retentionResult.totalBytes,
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
        retention,
        fingerprint,
      },
    }
  })
}
