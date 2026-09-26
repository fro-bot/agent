/**
 * Backup (quarantine-generation) listing and deletion — Unit 5, slice 5a.
 *
 * A completed recovery preserves the WHOLE original checkout directory by rename into
 * `<reposRoot>/.workspace-agent/quarantine/<owner>__<repo>/<recovery-id>/` (checkout-update-
 * recovery plan, Key Technical Decisions: "Recovery preserves the whole directory by rename").
 * Slice 5b (not this slice) performs that rename and drops a small root-owned `metadata.json`
 * alongside the preserved content, inside the same generation directory — this module defines
 * that schema and its strict parser now, since listing/deletion need it regardless of which slice
 * writes it first.
 */

import type {AgentWalkOutcome, AgentWalkRunner} from './agent-walk.js'
import type {GitOutcome, GitRunnerFn} from './git-safety.js'
import type {BackupEntry, DeleteBackupResult, ListBackupsResult} from './types.js'
import type {InvocationTracker} from './update.js'
import {randomUUID} from 'node:crypto'
import {lstat, open, readdir, readFile, rename, rm} from 'node:fs/promises'
import {join} from 'node:path'

import {runAgentWalk} from './agent-walk.js'
import {AGENT_GID, AGENT_UID, JOURNAL_DIR_NAME, QUARANTINE_DIR_NAME, WORKSPACE_STATE_DIR_NAME} from './identity.js'
import {readJournal} from './journal.js'
import {repoHoldReason, repoMutexKey, withRepoLock} from './repo-mutex.js'
import {createInvocationTracker, runTrackedInvocation} from './update.js'

/** (F5) `listBackups` never calls git — this stub exists only to satisfy `createInvocationTracker`'s required `gitRunner` parameter and is never dispatched. */
const neverCalledGitRunner: GitRunnerFn = async (): Promise<GitOutcome> => ({kind: 'timeout'})

/**
 * (F4/F5, review round G, G3) Tries a plain agent-uid pathname walk (via `tracker.walkRunner`)
 * first — the envelope's ancestors ARE agent-traversable in some deployments/tests — falling back
 * to the fd-scoped sealed-tree walker (`tracker.sealedWalkRunner`) only when that's incomplete or
 * failed. BOTH sub-calls go through the SAME tracker instance (never a raw, untracked
 * `measureSealedTree` call — G3's fix), so an unconfirmed termination in EITHER one is recorded on
 * it. `measureSealedTree` reporting `unavailable` (non-Linux) surfaces the ORIGINAL direct outcome
 * unchanged, so a plain-walk-capable environment is never worse off than before this existed.
 */
async function measureGenerationCheckout(
  tracker: InvocationTracker,
  options: Parameters<AgentWalkRunner>[0],
): Promise<AgentWalkOutcome> {
  const direct = await tracker.walkRunner(options)
  if (direct.kind === 'termination-unconfirmed') return direct
  if (direct.kind === 'ok' && direct.complete) return direct
  const sealed = await tracker.sealedWalkRunner({dirPath: options.rootPath, ...options})
  if (sealed.kind === 'unavailable') return direct
  return sealed
}

/** Root directory where repos are cloned inside the workspace container. Mirrors update.ts/inspect.ts. */
export const WORKSPACE_REPOS_ROOT = '/workspace/repos'

/** Name of the metadata file dropped alongside the preserved content inside each generation directory. */
export const QUARANTINE_METADATA_FILE_NAME = 'metadata.json'

/**
 * (Review round E, E1) Name of the subdirectory, inside each generation ENVELOPE, that holds the
 * renamed original checkout. The envelope (`<quarantine>/<owner>__<repo>/<id>/`) is a directory
 * this service creates and owns; the preserved checkout is never renamed directly onto the
 * envelope path, since the original tree could itself contain a file or directory literally named
 * `metadata.json` — writing service metadata straight into the preserved tree would clobber it (or
 * fail outright if that name is a directory in the original), and either way could leave the
 * canonical checkout path empty with nothing usable in quarantine. `checkout/` is always a
 * SIBLING of `metadata.json`, never its parent or child.
 */
export const QUARANTINE_CHECKOUT_DIR_NAME = 'checkout'

/** Which code path created this generation — review round E, E2/E4. */
export type QuarantineSource = 'recovery' | 'interrupted-update' | 'reconciliation'

const QUARANTINE_SOURCES: readonly QuarantineSource[] = ['recovery', 'interrupted-update', 'reconciliation']

function isQuarantineSource(value: unknown): value is QuarantineSource {
  return typeof value === 'string' && (QUARANTINE_SOURCES as readonly string[]).includes(value)
}

/** Root-owned metadata ALWAYS dropped alongside a preserved checkout at quarantine time — written by recover.ts, defined and strictly parsed here. */
export interface QuarantineMetadata {
  readonly recoveryId: string
  readonly owner: string
  readonly repo: string
  /** ISO-8601 timestamp, from an injected clock, when the generation was created. */
  readonly createdAt: string
  readonly sizeBytes: number
  readonly entryCount: number
  /** (E4) False if the size/entry-count measurement at quarantine time was incomplete or failed outright — `sizeBytes`/`entryCount` are then a lower bound (0 if it failed entirely), never trusted for a quota decision. */
  readonly sizeComplete: boolean
  /** HEAD SHA the ORIGINAL (preserved) checkout was at. Absent for an unborn/no-HEAD checkout, OR whenever reading it would be unsafe (mid-merge — interrupted-update/reconciliation sources). */
  readonly originalHeadSha?: string
  /** Branch the ORIGINAL checkout was on. Absent if it was detached, OR unsafe to read. */
  readonly originalBranch?: string
  readonly source: QuarantineSource
}

export type QuarantineMetadataReadResult =
  | {readonly ok: true; readonly metadata: QuarantineMetadata}
  | {readonly ok: false; readonly reason: 'absent'}
  | {readonly ok: false; readonly reason: 'malformed'; readonly detail: string}

export interface BackupsDeps {
  readonly reposRoot?: string
  /** (E4b) Injected agent-uid walk runner, used ONLY to measure a generation whose metadata is missing/malformed — defaults to the real subprocess-spawning `runAgentWalk`. */
  readonly walkRunner?: AgentWalkRunner
  /** (F5) Defaults to `AGENT_UID`/`AGENT_GID` — NEVER root — same as every other agent-uid walk in this codebase. Tests pass `undefined` explicitly to run unprivileged locally. */
  readonly uid?: number
  readonly gid?: number
  readonly walkDeadlineMs?: number
  readonly walkMaxEntries?: number
  readonly walkTimeoutMs?: number
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Parses `value` into a `QuarantineMetadata`, or `null` if it does not match the known schema. Parsed, not cast. */
function parseQuarantineMetadata(value: unknown): QuarantineMetadata | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!isNonEmptyString(v.recoveryId) || !isNonEmptyString(v.owner) || !isNonEmptyString(v.repo)) return null
  if (!isNonEmptyString(v.createdAt)) return null
  if (!isNonNegativeInt(v.sizeBytes) || !isNonNegativeInt(v.entryCount)) return null
  if (v.originalHeadSha !== undefined && !isNonEmptyString(v.originalHeadSha)) return null
  if (v.originalBranch !== undefined && !isNonEmptyString(v.originalBranch)) return null
  if (typeof v.sizeComplete !== 'boolean') return null
  if (!isQuarantineSource(v.source)) return null
  return {
    recoveryId: v.recoveryId,
    owner: v.owner,
    repo: v.repo,
    createdAt: v.createdAt,
    sizeBytes: v.sizeBytes,
    entryCount: v.entryCount,
    sizeComplete: v.sizeComplete,
    source: v.source,
    ...(v.originalHeadSha === undefined ? {} : {originalHeadSha: v.originalHeadSha}),
    ...(v.originalBranch === undefined ? {} : {originalBranch: v.originalBranch}),
  }
}

/** Reads and parses the metadata file inside a single generation directory. Never follows a symlink at that path. Exported (F7) so recover.ts's replay/reconciliation path can decide whether a generation's metadata still needs completing, without re-implementing this parse. */
export async function readQuarantineMetadata(generationPath: string): Promise<QuarantineMetadataReadResult> {
  const filePath = join(generationPath, QUARANTINE_METADATA_FILE_NAME)
  let st
  try {
    st = await lstat(filePath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {ok: false, reason: 'absent'}
    return {ok: false, reason: 'malformed', detail: `cannot stat metadata file: ${errorMessage(error)}`}
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return {ok: false, reason: 'malformed', detail: 'metadata file is not a regular file — refusing'}
  }

  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    return {ok: false, reason: 'malformed', detail: `cannot read metadata file: ${errorMessage(error)}`}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {ok: false, reason: 'malformed', detail: `invalid JSON: ${errorMessage(error)}`}
  }

  const metadata = parseQuarantineMetadata(parsed)
  if (metadata === null) {
    return {ok: false, reason: 'malformed', detail: 'metadata does not match the known schema'}
  }
  return {ok: true, metadata}
}

/** `<reposRoot>/.workspace-agent/quarantine/<owner>__<repo>` — the same `<owner>__<repo>` pairing the fetch store and journal.ts use. */
function quarantineRepoDirFor(reposRoot: string, owner: string, repo: string): string {
  return join(reposRoot, WORKSPACE_STATE_DIR_NAME, QUARANTINE_DIR_NAME, `${owner}__${repo}`)
}

/**
 * Writes `metadata` to `<envelopePath>/metadata.json` via temp-file-then-`rename` (same atomicity
 * as journal.ts). Exported (F7) so recover.ts's initial quarantine write AND its replay/
 * reconciliation metadata-completion path share exactly one write implementation, rather than
 * recover.ts re-implementing the temp-then-rename dance a second time.
 */
export async function writeQuarantineMetadata(
  envelopePath: string,
  metadata: QuarantineMetadata,
): Promise<'ok' | 'failed'> {
  const metadataPath = join(envelopePath, QUARANTINE_METADATA_FILE_NAME)
  const tempPath = join(envelopePath, `.${QUARANTINE_METADATA_FILE_NAME}.tmp-${randomUUID()}`)
  try {
    const handle = await open(tempPath, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(metadata))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, metadataPath)
    return 'ok'
  } catch {
    await rm(tempPath, {force: true}).catch(() => {})
    return 'failed'
  }
}

type DirCheck = 'ok' | 'absent' | 'failed'

/** `lstat`s `path` and confirms it is a real (non-symlink) directory. Never creates anything. */
async function checkRealDirOrAbsent(path: string): Promise<DirCheck> {
  let st
  try {
    st = await lstat(path)
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'absent' : 'failed'
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'failed'
  return 'ok'
}

/**
 * Confirms the FULL chain (`.workspace-agent` -> `quarantine` -> `<owner>__<repo>`) is safe to
 * read, mirroring journal.ts's own protected-dir posture: any level missing means every level
 * below it is legitimately absent too (a repository that has never had a recovery has no
 * quarantine subdirectory at all); any level that EXISTS but is a symlink or not a real directory
 * fails closed.
 */
async function checkQuarantineRepoDir(reposRoot: string, quarantineRepoDir: string): Promise<DirCheck> {
  const stateDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME)
  const stateCheck = await checkRealDirOrAbsent(stateDir)
  if (stateCheck !== 'ok') return stateCheck

  const quarantineDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, QUARANTINE_DIR_NAME)
  const quarantineCheck = await checkRealDirOrAbsent(quarantineDir)
  if (quarantineCheck !== 'ok') return quarantineCheck

  return checkRealDirOrAbsent(quarantineRepoDir)
}

/**
 * True only for a simple, single path segment: no `/`/`\`, no `..`/`.`, no null byte, non-empty.
 * Checked BEFORE `id` is ever joined onto a filesystem path, so the join can only ever resolve to
 * a direct child of the given directory — never elsewhere (review-round-B-style hardening: reject
 * the string first, never sanitize-then-join).
 */
function isSimplePathSegment(id: string): boolean {
  if (id.length === 0) return false
  if (id === '.' || id === '..') return false
  if (id.includes('/') || id.includes('\\')) return false
  if (id.includes('\0')) return false
  return true
}

/**
 * Lists every generation for `owner`/`repo`, newest-or-oldest-unspecified (callers sort if they
 * need an order) — an empty quarantine subdirectory tree (never created for this repository) is
 * `{kind: 'ok', backups: [], totalBytes: 0}`, not a failure.
 *
 * A generation whose `metadata.json` fails to parse is still listed (skip-with-flag: `metadataOk:
 * false`, `createdAt` degraded to the directory's own mtime, size/HEAD/branch reported as unknown)
 * rather than causing the WHOLE call to fail — refusing every generation because one is corrupt
 * would hide the rest from an operator who needs exactly this list to decide what to delete, and a
 * corrupt-metadata generation still occupies real disk space that must remain visible and
 * deletable. `totalBytes` sums only `metadataOk: true` entries, so a corrupt generation is never
 * counted against the retention quota it can't prove it fits within.
 */
export async function listBackups(owner: string, repo: string, deps: BackupsDeps = {}): Promise<ListBackupsResult> {
  const {
    reposRoot = WORKSPACE_REPOS_ROOT,
    walkRunner = runAgentWalk,
    // (F5) Default to the agent identity, NEVER root. Checked with `'uid' in deps` rather than a
    // plain destructuring default: a caller that explicitly passes `uid: undefined` (as recover.ts
    // always does — forwarding its OWN already-resolved uid, whatever that resolves to in a given
    // environment) must keep that explicit choice, distinct from a caller that omits the key
    // entirely (a bare/standalone call, e.g. from server.ts's GET /backups route, or a test) and
    // gets the safe AGENT_UID/AGENT_GID default — a plain `= AGENT_UID` default cannot tell those
    // two cases apart, since both present as `deps.uid === undefined`.
    uid = 'uid' in deps ? deps.uid : AGENT_UID,
    gid = 'gid' in deps ? deps.gid : AGENT_GID,
    walkDeadlineMs = 10_000,
    walkMaxEntries = 200_000,
    walkTimeoutMs = 15_000,
  } = deps
  // (F5) The fallback measurement below is routed through a tracker so an unconfirmed subprocess
  // termination sets the repo hold (via `runTrackedInvocation`) exactly like every other agent-uid
  // walk in this codebase — `listBackups` is read-only and holds no lock itself, but the HOLD it
  // sets is repo-scoped and still protects a concurrent mutation from racing an uncertain walker.
  // (F4) The wrapped runner tries a plain agent-uid pathname walk first (the envelope's ancestors
  // ARE agent-traversable in some deployments/tests), falling back to the fd-scoped sealed-tree
  // walker only when that's incomplete/failed — exactly the scoped-access mechanism F4 introduced,
  // reused here rather than re-implemented.
  const tracker = createInvocationTracker({gitRunner: neverCalledGitRunner, walkRunner})
  const repoKey = repoMutexKey(owner, repo)
  const quarantineRepoDir = quarantineRepoDirFor(reposRoot, owner, repo)

  const dirStatus = await checkQuarantineRepoDir(reposRoot, quarantineRepoDir)
  if (dirStatus === 'absent') return {kind: 'ok', backups: [], totalBytes: 0}
  if (dirStatus === 'failed') return {kind: 'failed'}

  let names: readonly string[]
  try {
    names = await readdir(quarantineRepoDir)
  } catch {
    return {kind: 'failed'}
  }

  const backups: BackupEntry[] = []
  let totalBytes = 0
  for (const name of names) {
    const generationPath = join(quarantineRepoDir, name)
    let st
    try {
      st = await lstat(generationPath)
    } catch {
      continue // vanished between readdir and lstat
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue // never a legitimate generation shape

    const read = await readQuarantineMetadata(generationPath)
    if (read.ok === true && read.metadata.sizeComplete) {
      backups.push({
        id: name,
        metadataOk: true,
        createdAt: read.metadata.createdAt,
        sizeBytes: read.metadata.sizeBytes,
        sizeComplete: true,
        originalHeadSha: read.metadata.originalHeadSha,
        originalBranch: read.metadata.originalBranch,
      })
      totalBytes += read.metadata.sizeBytes
      continue
    }

    // (E4b/F5) Missing/malformed/incomplete-at-write-time metadata: try to measure the preserved
    // `checkout/` directly, AS THE AGENT (falling back to the fd-scoped sealed-tree walker when a
    // plain pathname walk can't reach it — F4), rather than failing closed as unknown forever.
    // Routed through `runTrackedInvocation` so an unconfirmed termination anywhere in THIS walk
    // sets the repo hold, same as every other agent-uid walk in this codebase.
    const measured = await runTrackedInvocation(
      repoKey,
      tracker,
      async () =>
        measureGenerationCheckout(tracker, {
          rootPath: join(generationPath, QUARANTINE_CHECKOUT_DIR_NAME),
          maxEntries: walkMaxEntries,
          deadlineMs: walkDeadlineMs,
          uid,
          gid,
          timeoutMs: walkTimeoutMs,
        }),
      () => ({kind: 'termination-unconfirmed'}) as const,
    )
    const measuredOk = measured.kind === 'ok' && measured.complete
    const sizeBytes = measuredOk && measured.kind === 'ok' ? measured.totalBytes : 0
    if (measuredOk) totalBytes += sizeBytes
    backups.push({
      id: name,
      metadataOk: read.ok,
      createdAt: read.ok ? read.metadata.createdAt : st.mtime.toISOString(),
      sizeBytes,
      sizeComplete: measuredOk,
      originalHeadSha: read.ok ? read.metadata.originalHeadSha : undefined,
      originalBranch: read.ok ? read.metadata.originalBranch : undefined,
    })
  }

  return {kind: 'ok', backups, totalBytes}
}

/**
 * Removes exactly one generation for `owner`/`repo`, after validating `id` is a direct child of
 * that repository's own quarantine directory: rejects `..`, an absolute path, any path separator,
 * and a symlinked or non-directory "generation" (see `isSimplePathSegment` and the module header).
 * An `id` that belongs to a DIFFERENT repository is refused the same way a nonexistent one is —
 * it simply never exists as a child of THIS repository's quarantine directory.
 *
 * (Review round E, E8) Runs under the SAME per-repo mutex clone/update/recovery share, so a delete
 * can never race a recovery mid-quarantine/install. Refuses outright on a maintenance hold or an
 * in-progress RECOVERY journal for this repository (an in-progress UPDATE journal does not block a
 * backup delete — it never touches quarantine).
 */
export async function deleteBackup(
  owner: string,
  repo: string,
  id: string,
  deps: BackupsDeps = {},
): Promise<DeleteBackupResult> {
  if (!isSimplePathSegment(id)) return {kind: 'refused', reason: 'invalid-id'}
  const {reposRoot = WORKSPACE_REPOS_ROOT} = deps

  return withRepoLock(repoMutexKey(owner, repo), async (): Promise<DeleteBackupResult> => {
    if (repoHoldReason(repoMutexKey(owner, repo)) !== undefined) {
      return {kind: 'refused', reason: 'maintenance-hold'}
    }
    const journalsDir = join(reposRoot, WORKSPACE_STATE_DIR_NAME, JOURNAL_DIR_NAME)
    const journalRead = await readJournal(journalsDir, owner, repo)
    if (journalRead.ok === true && journalRead.journal.kind === 'recovery') {
      return {kind: 'refused', reason: 'recovery-in-progress'}
    }

    const quarantineRepoDir = quarantineRepoDirFor(reposRoot, owner, repo)
    const dirStatus = await checkQuarantineRepoDir(reposRoot, quarantineRepoDir)
    if (dirStatus === 'absent') return {kind: 'refused', reason: 'not-found'}
    if (dirStatus === 'failed') return {kind: 'failed'}

    const generationPath = join(quarantineRepoDir, id)
    let st
    try {
      st = await lstat(generationPath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return {kind: 'refused', reason: 'not-found'}
      return {kind: 'failed'}
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return {kind: 'refused', reason: 'invalid-id'}

    try {
      await rm(generationPath, {recursive: true})
    } catch {
      return {kind: 'failed'}
    }
    return {kind: 'ok'}
  })
}
