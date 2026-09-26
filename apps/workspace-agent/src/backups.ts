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

import {lstat, readdir, readFile, rm} from 'node:fs/promises'
import {join} from 'node:path'

import {QUARANTINE_DIR_NAME, WORKSPACE_STATE_DIR_NAME} from './identity.js'

/** Root directory where repos are cloned inside the workspace container. Mirrors update.ts/inspect.ts. */
export const WORKSPACE_REPOS_ROOT = '/workspace/repos'

/** Name of the metadata file dropped alongside the preserved content inside each generation directory. */
export const QUARANTINE_METADATA_FILE_NAME = 'metadata.json'

/** Root-owned metadata dropped alongside a preserved checkout at quarantine time (slice 5b writes it; this module defines and strictly parses it now). */
export interface QuarantineMetadata {
  readonly recoveryId: string
  readonly owner: string
  readonly repo: string
  /** ISO-8601 timestamp, from an injected clock, when the generation was created. */
  readonly createdAt: string
  readonly sizeBytes: number
  readonly entryCount: number
  /** HEAD SHA the ORIGINAL (preserved) checkout was at. Absent for an unborn/no-HEAD checkout. */
  readonly originalHeadSha?: string
  /** Branch the ORIGINAL checkout was on. Absent if it was detached. */
  readonly originalBranch?: string
}

export type QuarantineMetadataReadResult =
  | {readonly ok: true; readonly metadata: QuarantineMetadata}
  | {readonly ok: false; readonly reason: 'absent'}
  | {readonly ok: false; readonly reason: 'malformed'; readonly detail: string}

/** One listable generation. `metadataOk: false` means metadata.json failed to parse — the entry is still listed and deletable, but size/HEAD/branch are unknown rather than guessed (see listBackups's own doc comment for why). */
export interface BackupEntry {
  readonly id: string
  readonly metadataOk: boolean
  readonly createdAt: string
  readonly sizeBytes: number
  readonly originalHeadSha: string | undefined
  readonly originalBranch: string | undefined
}

export interface BackupsDeps {
  readonly reposRoot?: string
}

export type ListBackupsResult =
  | {readonly kind: 'ok'; readonly backups: readonly BackupEntry[]; readonly totalBytes: number}
  | {readonly kind: 'failed'}

export type DeleteBackupResult =
  | {readonly kind: 'ok'}
  | {readonly kind: 'refused'; readonly reason: 'invalid-id' | 'not-found'}
  | {readonly kind: 'failed'}

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
  return {
    recoveryId: v.recoveryId,
    owner: v.owner,
    repo: v.repo,
    createdAt: v.createdAt,
    sizeBytes: v.sizeBytes,
    entryCount: v.entryCount,
    ...(v.originalHeadSha === undefined ? {} : {originalHeadSha: v.originalHeadSha}),
    ...(v.originalBranch === undefined ? {} : {originalBranch: v.originalBranch}),
  }
}

/** Reads and parses the metadata file inside a single generation directory. Never follows a symlink at that path. */
async function readQuarantineMetadata(generationPath: string): Promise<QuarantineMetadataReadResult> {
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
  const {reposRoot = WORKSPACE_REPOS_ROOT} = deps
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
    if (read.ok === true) {
      backups.push({
        id: name,
        metadataOk: true,
        createdAt: read.metadata.createdAt,
        sizeBytes: read.metadata.sizeBytes,
        originalHeadSha: read.metadata.originalHeadSha,
        originalBranch: read.metadata.originalBranch,
      })
      totalBytes += read.metadata.sizeBytes
      continue
    }
    backups.push({
      id: name,
      metadataOk: false,
      createdAt: st.mtime.toISOString(),
      sizeBytes: 0,
      originalHeadSha: undefined,
      originalBranch: undefined,
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
 */
export async function deleteBackup(
  owner: string,
  repo: string,
  id: string,
  deps: BackupsDeps = {},
): Promise<DeleteBackupResult> {
  if (!isSimplePathSegment(id)) return {kind: 'refused', reason: 'invalid-id'}

  const {reposRoot = WORKSPACE_REPOS_ROOT} = deps
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
}
