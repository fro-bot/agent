/**
 * Journal store — records an in-flight update or recovery mutation for a single repository, so a
 * workspace restart mid-mutation is reconciled instead of silently reported as "nothing changed".
 *
 * checkout-update-recovery plan, Key Technical Decisions: "Journals live under
 * .workspace-agent/journals/, root-owned, written by temp-file-and-rename. Never inside `.git/`,
 * where the agent could forge one. Every update and recovery operation is reconciled on service
 * start and again at the top of each operation, before anything else."
 *
 * One journal file per repository, at `<journalsDir>/<owner>__<repo>.json` (the same
 * `<owner>__<repo>` pairing the protected bare-repo fetch store uses — identity.ts). A
 * repository never has more than one outstanding journal at a time: the per-repo mutex
 * (repo-mutex.ts) that clone, update, recover, and backup delete all share serializes every
 * operation on that repository, so at most one journal-writing operation is ever in flight for a
 * given `owner/repo` pair.
 *
 * SECURITY / CORRECTNESS INVARIANTS:
 * 1. Writes go to a private temp file (`open(..., 'wx')`, exclusive create), are fsynced
 *    (`FileHandle#sync`), then published with a single `rename` — the canonical path is either
 *    the OLD journal or the NEW one, never a partially-written file. A crash between the temp
 *    write and the rename leaves the previous journal (or its absence) exactly as it was; the
 *    stray temp file is never mistaken for a real journal (`listJournals` and `readJournal` only
 *    ever look at the canonical `<owner>__<repo>.json` name).
 * 2. Reads are PARSED, not cast: `readJournal`/`listJournals` validate the discriminated update
 *    vs. recovery shape and the named phase before returning a `Journal`. Truncated JSON, valid
 *    JSON of the wrong shape, and an unrecognized `phase` are all reported as `reason: 'malformed'`
 *    — a distinct outcome from `reason: 'absent'`. A malformed journal is NEVER treated as
 *    absent: callers (clone.ts today; update.ts/recover.ts in later units) must refuse to proceed
 *    rather than silently act as though no mutation was in flight.
 * 3. The journals directory itself is never trusted blindly. Before any read, write, list, or
 *    remove, both the journals directory and its parent (`.workspace-agent`, which the deploy
 *    entrypoint's `ensure-protected-dir.mjs` creates root-owned 0700 before the service becomes
 *    reachable) are `lstat`'d — never `stat`'d — and a symlink at either position is refused
 *    outright rather than followed. `writeJournal` creates the journals directory itself (mode
 *    0700) only when it is confirmed absent; it never chowns or relaxes an existing directory it
 *    does not already trust.
 * 4. Every journal file is published (and later replaced) only via `rename` onto its canonical
 *    path — never opened for in-place writing. `rename` replaces the directory entry atomically
 *    without touching whatever inode the old entry (if hardlinked elsewhere, which nothing
 *    legitimate ever does for a file this module itself creates) pointed at, so there is no
 *    hardlink surprise: the old content elsewhere, if any, is never mutated by a journal write.
 *    A journal file found to be a symlink is refused (reason: 'malformed'), never followed.
 */

import {randomUUID} from 'node:crypto'
import {lstat, mkdir, open, readdir, readFile, rename, rm} from 'node:fs/promises'
import {dirname, join} from 'node:path'

/** Phases of an in-flight checkout update. See the plan's reconciliation table. */
export type UpdateJournalPhase = 'fetched' | 'applying' | 'applied'

/** Phases of an in-flight recovery (preserve-and-replace). See the plan's reconciliation table. */
export type RecoveryJournalPhase = 'building' | 'quarantining' | 'installing' | 'verifying'

/**
 * An in-flight fast-forward update of an existing checkout. `appliedAt` is REQUIRED at phase
 * `'applied'` (review round B, B7) — nothing has shipped with the old, briefly-optional field, so
 * there is no legacy journal to stay lenient for. A parsed journal claiming `phase: 'applied'`
 * without a valid `appliedAt` is `malformed`, never silently treated as absent or backfilled with
 * a freshly-manufactured `now()` at reconciliation time (see update.ts's `reconcileUpdateJournal`,
 * which now reads `journal.appliedAt` directly, with no `?? now()` fallback).
 *
 * Deliberately two plain object members rather than one interface plus an intersection override —
 * TypeScript's discriminated-union narrowing on `phase` is reliable for a union of plain object
 * literal types; an intersection-typed member (`Common & {phase: ...}`) does not narrow as
 * dependably once one member's discriminant is itself a small union (`'fetched' | 'applying'`).
 */
export type UpdateJournal =
  | {
      readonly kind: 'update'
      readonly owner: string
      readonly repo: string
      readonly phase: 'fetched' | 'applying'
      /** HEAD SHA observed before the update started. */
      readonly fromSha: string
      /** Target SHA the update is advancing the checkout to. */
      readonly toSha: string
      /** ISO-8601 timestamp, from an injected clock, when the journal was first written. */
      readonly startedAt: string
    }
  | {
      readonly kind: 'update'
      readonly owner: string
      readonly repo: string
      readonly phase: 'applied'
      readonly fromSha: string
      readonly toSha: string
      readonly startedAt: string
      /** ISO-8601 timestamp, from an injected clock, when the fast-forward merge was VERIFIED complete. */
      readonly appliedAt: string
    }

/** An in-flight preserve-and-replace recovery of a checkout. */
export interface RecoveryJournal {
  readonly kind: 'recovery'
  readonly owner: string
  readonly repo: string
  readonly phase: RecoveryJournalPhase
  /** Identifier of the quarantine generation this recovery is creating (or has created). */
  readonly recoveryId: string
  /** ISO-8601 timestamp, from an injected clock, when the journal was first written. */
  readonly startedAt: string
}

/** A journal is exactly one of these two shapes — never a generic bag of optional flags. */
export type Journal = UpdateJournal | RecoveryJournal

/**
 * Result of reading a journal. `'absent'` means no journal file exists for this repository (or
 * the journals directory itself doesn't exist yet) — a legitimate, common state. `'malformed'`
 * means a journal file exists at the canonical path but could not be parsed as a valid `Journal`
 * (truncated, foreign JSON shape, or an unrecognized `phase`) — callers must treat this as a
 * blocking condition, never as `'absent'`.
 */
export type JournalReadResult =
  | {readonly ok: true; readonly journal: Journal}
  | {readonly ok: false; readonly reason: 'absent'}
  | {readonly ok: false; readonly reason: 'malformed'; readonly detail: string}

/** One entry from `listJournals` — the on-disk file name plus its parsed (or refused) content. */
export interface JournalListEntry {
  readonly fileName: string
  readonly result: JournalReadResult
}

/**
 * Thrown when the journals directory or its parent fails the symlink/real-directory safety
 * check. Distinct from a `JournalReadResult` failure: this is a directory-level fault (a
 * compromised or misconfigured volume), not a per-repository journal-content problem, and
 * callers should treat it as an operational failure rather than routing it through per-repo
 * refusal logic.
 */
export class JournalDirectoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalDirectoryError'
  }
}

const UPDATE_PHASES: ReadonlySet<string> = new Set<UpdateJournalPhase>(['fetched', 'applying', 'applied'])
const RECOVERY_PHASES: ReadonlySet<string> = new Set<RecoveryJournalPhase>([
  'building',
  'quarantining',
  'installing',
  'verifying',
])

/**
 * True only for a canonical journal file name (`<owner>__<repo>.json`) — never a leftover temp
 * file (dot-prefixed by `writeJournal`) or anything else that might land in the directory.
 * Deliberately plain string checks rather than a single regex with two adjacent `[^/]*`
 * quantifiers around a shared separator, which is super-linearly backtrackable against a
 * pathological name.
 */
function isCanonicalJournalFileName(name: string): boolean {
  if (name.startsWith('.')) return false
  if (!name.endsWith('.json')) return false
  if (!name.includes('__')) return false
  return true
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Parses `value` into a `Journal`, or returns `null` if it does not match the known discriminated
 * shape. Parsed, not cast: every field is checked before being trusted, including the `phase`
 * enum matching the journal's own `kind`.
 */
function parseJournal(value: unknown): Journal | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!isNonEmptyString(v.owner) || !isNonEmptyString(v.repo) || !isNonEmptyString(v.startedAt)) return null

  if (v.kind === 'update') {
    if (!isNonEmptyString(v.phase) || !UPDATE_PHASES.has(v.phase)) return null
    if (!isNonEmptyString(v.fromSha) || !isNonEmptyString(v.toSha)) return null
    const common = {
      kind: 'update' as const,
      owner: v.owner,
      repo: v.repo,
      fromSha: v.fromSha,
      toSha: v.toSha,
      startedAt: v.startedAt,
    }
    if (v.phase === 'applied') {
      // appliedAt is REQUIRED at this phase — a valid non-empty string, never silently coerced or
      // defaulted. Missing or invalid ⇒ malformed, not absent.
      if (!isNonEmptyString(v.appliedAt)) return null
      return {...common, phase: 'applied', appliedAt: v.appliedAt}
    }
    return {...common, phase: v.phase as 'fetched' | 'applying'}
  }

  if (v.kind === 'recovery') {
    if (!isNonEmptyString(v.phase) || !RECOVERY_PHASES.has(v.phase)) return null
    if (!isNonEmptyString(v.recoveryId)) return null
    return {
      kind: 'recovery',
      owner: v.owner,
      repo: v.repo,
      phase: v.phase as RecoveryJournalPhase,
      recoveryId: v.recoveryId,
      startedAt: v.startedAt,
    }
  }

  return null
}

function journalFileName(owner: string, repo: string): string {
  return `${owner}__${repo}.json`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
}

type RealDirectoryCheck = {readonly ok: true} | {readonly ok: false; readonly reason: 'enoent' | string}

/** `lstat`s `path` and confirms it is a real (non-symlink) directory, without creating anything. */
async function checkRealDirectory(path: string, label: string): Promise<RealDirectoryCheck> {
  let st
  try {
    st = await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {ok: false, reason: 'enoent'}
    return {ok: false, reason: `cannot stat ${label} ${path}: ${errorMessage(error)}`}
  }
  if (st.isSymbolicLink()) {
    return {ok: false, reason: `${label} ${path} is a symlink, not a real directory — refusing`}
  }
  if (!st.isDirectory()) {
    return {ok: false, reason: `${label} ${path} exists but is not a directory — refusing`}
  }
  return {ok: true}
}

/**
 * Checks that the journals directory's parent is safe to descend into. An ENTIRELY ABSENT parent
 * (`.workspace-agent` itself never created — a fresh machine, or a test) is reported as
 * `'absent'`, not an error, mirroring clone.ts's own tolerant `mkdir({recursive: true})` for the
 * staging directory: in production the deploy entrypoint (`ensure-protected-dir.mjs`) always
 * creates `.workspace-agent` before the service becomes reachable, so this path is exercised only
 * on a machine where that hasn't happened yet. What this DOES refuse outright — the actual attack
 * this module defends against — is a parent that EXISTS but is a symlink or not a real directory.
 */
async function checkParentSafe(journalsDir: string): Promise<'absent' | 'present'> {
  const parent = dirname(journalsDir)
  const result = await checkRealDirectory(parent, 'journals parent directory')
  if (result.ok === true) return 'present'
  if (result.reason === 'enoent') return 'absent'
  throw new JournalDirectoryError(result.reason)
}

/**
 * Confirms the journals directory is safe to read from (parent and directory both real,
 * non-symlink) without creating it. An absent parent or an absent journals directory are both
 * legitimate "no journals have ever been written for any repository" states, reported as
 * `'absent'`, not an error. A parent or directory that EXISTS but is a symlink (or not a real
 * directory) throws `JournalDirectoryError`.
 */
async function journalsDirStatus(journalsDir: string): Promise<'absent' | 'present'> {
  const parentStatus = await checkParentSafe(journalsDir)
  if (parentStatus === 'absent') return 'absent'
  const result = await checkRealDirectory(journalsDir, 'journals directory')
  if (result.ok === true) return 'present'
  if (result.reason === 'enoent') return 'absent'
  throw new JournalDirectoryError(result.reason)
}

/**
 * Confirms the journals directory is safe, creating it (and its parent, if that's also absent —
 * `recursive: true`, mode 0700) only when confirmed absent. Never chowns or relaxes an existing
 * directory this check does not already trust; refuses outright if either the parent or the
 * journals directory itself EXISTS but is a symlink or not a real directory.
 */
async function ensureJournalsDir(journalsDir: string): Promise<void> {
  const parentStatus = await checkParentSafe(journalsDir)
  if (parentStatus === 'present') {
    const result = await checkRealDirectory(journalsDir, 'journals directory')
    if (result.ok === true) return
    if (result.reason !== 'enoent') throw new JournalDirectoryError(result.reason)
  }
  await mkdir(journalsDir, {recursive: true, mode: 0o700})
}

/** Reads and parses a single journal file at `filePath`. Never follows a symlink at that path. */
async function readJournalFile(filePath: string): Promise<JournalReadResult> {
  let st
  try {
    st = await lstat(filePath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {ok: false, reason: 'absent'}
    return {ok: false, reason: 'malformed', detail: `cannot stat journal file: ${errorMessage(error)}`}
  }
  if (st.isSymbolicLink()) {
    return {ok: false, reason: 'malformed', detail: 'journal file is a symlink, not a regular file — refusing'}
  }
  if (!st.isFile()) {
    return {ok: false, reason: 'malformed', detail: 'journal path exists but is not a regular file'}
  }

  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    return {ok: false, reason: 'malformed', detail: `cannot read journal file: ${errorMessage(error)}`}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {ok: false, reason: 'malformed', detail: `invalid JSON: ${errorMessage(error)}`}
  }

  const journal = parseJournal(parsed)
  if (journal === null) {
    return {ok: false, reason: 'malformed', detail: 'journal does not match the known update/recovery schema'}
  }
  return {ok: true, journal}
}

/**
 * Writes `journal` for `journal.owner`/`journal.repo` under `journalsDir`. Creates the journals
 * directory (root-owned, mode 0700) if it does not already exist. Writes to a private temp file,
 * fsyncs it, then publishes with a single `rename` onto the canonical `<owner>__<repo>.json`
 * path — replacing any previous journal for that repository atomically. Throws
 * `JournalDirectoryError` if the journals directory or its parent fails the symlink/real-directory
 * safety check.
 */
export async function writeJournal(journalsDir: string, journal: Journal): Promise<void> {
  await ensureJournalsDir(journalsDir)

  const fileName = journalFileName(journal.owner, journal.repo)
  const finalPath = join(journalsDir, fileName)
  const tempPath = join(journalsDir, `.${fileName}.tmp-${randomUUID()}`)

  const handle = await open(tempPath, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(journal))
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await rename(tempPath, finalPath)
  } catch (error) {
    await rm(tempPath, {force: true})
    throw error
  }
}

/**
 * Reads the journal for `owner`/`repo` under `journalsDir`. Returns `{ok: false, reason:
 * 'absent'}` when the journals directory doesn't exist yet or no journal file exists for this
 * repository — both legitimate "nothing in flight" states. Returns `{ok: false, reason:
 * 'malformed', detail}` when a journal file exists but fails to parse; this is never conflated
 * with `'absent'`. Throws `JournalDirectoryError` if the journals directory or its parent fails
 * the symlink/real-directory safety check.
 */
export async function readJournal(journalsDir: string, owner: string, repo: string): Promise<JournalReadResult> {
  const status = await journalsDirStatus(journalsDir)
  if (status === 'absent') return {ok: false, reason: 'absent'}
  return readJournalFile(join(journalsDir, journalFileName(owner, repo)))
}

/**
 * Lists every journal file under `journalsDir` (canonical `<owner>__<repo>.json` names only —
 * a leftover temp file from an interrupted write, or anything else that doesn't match that
 * pattern, is skipped). Returns an empty list if the journals directory doesn't exist yet. Each
 * entry carries its own `JournalReadResult`, so a malformed journal for one repository never
 * prevents listing the rest. Throws `JournalDirectoryError` if the journals directory or its
 * parent fails the symlink/real-directory safety check.
 */
export async function listJournals(journalsDir: string): Promise<readonly JournalListEntry[]> {
  const status = await journalsDirStatus(journalsDir)
  if (status === 'absent') return []

  const names = await readdir(journalsDir)
  const entries: JournalListEntry[] = []
  for (const name of names) {
    if (!isCanonicalJournalFileName(name)) continue
    // Sequential by design: journal counts per repo are small, and reconciliation needs a
    // stable, deterministic order rather than the interleaving concurrent reads would produce.
    const result = await readJournalFile(join(journalsDir, name))
    entries.push({fileName: name, result})
  }
  return entries
}

/**
 * Removes the journal for `owner`/`repo` under `journalsDir`, if any. A no-op if the journals
 * directory or the specific journal file doesn't exist. Throws `JournalDirectoryError` if the
 * journals directory or its parent fails the symlink/real-directory safety check.
 */
export async function removeJournal(journalsDir: string, owner: string, repo: string): Promise<void> {
  const status = await journalsDirStatus(journalsDir)
  if (status === 'absent') return
  await rm(join(journalsDir, journalFileName(owner, repo)), {force: true})
}
