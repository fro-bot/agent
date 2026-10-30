import type {Result} from '@bfra.me/es/result'
import type {Logger} from '../shared/logger.js'
import {existsSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {toError, toErrorMessage} from '../shared/errors.js'
import {err, ok} from '../shared/types.js'

/**
 * Pre-spawn clear of OpenCode V2 resumable work in a restored database.
 *
 * V2 keeps a session's execution claim (`session_v2.time_suspended`) across any shutdown that did not
 * interrupt the turn with reason `user`, and a background child's recovery record (`kv` rows under
 * `job.background/`). A restart sweep resumes both. A server killed mid-run therefore leaves work that a
 * later server may resume on its own.
 *
 * Measured against v2.2.0 (probe P11): `serve --stdio` runs no boot sweep, so today this is insurance. It is
 * still required before every spawn because the claim survives stdin close, SIGTERM and SIGKILL, `--service`
 * mode does sweep, and clearing the claim alone is not enough: a surviving `job.background/` row still
 * resumes the child and wakes its parent. Both statements run in one transaction.
 *
 * The database is opened through SQLite, never read as a file: after a hard kill most of the state is in the
 * `-wal` file and the main file alone does not even contain the V2 tables. Opening applies the log, and closing
 * the last connection checkpoints it into the main file, so a save that copies only `opencode.db` carries the
 * clear (pinned by the WAL test).
 */

export type ClearHeldClaimsOutcome =
  | {readonly status: 'no-database'}
  | {readonly status: 'cleared'; readonly claims: number; readonly backgroundJobs: number}

// Cleared statements use only column and table names that exist in v2.2.0 (`core/src/session/sql.ts:71-72`,
// `core/src/kv/sql.ts:5`, `core/src/job.ts:37`). `LIKE` is safe here: the prefix has no `%` or `_`.
const CLEAR_CLAIMS_SQL =
  'UPDATE session_v2 SET time_suspended = NULL, resume_attempts = 0 WHERE time_suspended IS NOT NULL'
const CLEAR_BACKGROUND_JOBS_SQL = "DELETE FROM kv WHERE key LIKE 'job.background/%'"
const BUSY_TIMEOUT_MS = 5000

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function runClear(db: DatabaseSync): {readonly claims: number; readonly backgroundJobs: number} {
  // Absent tables are a no-op: a restored V1 database, or a database no V2 server ever opened.
  const hasSessions = tableExists(db, 'session_v2')
  const hasKv = tableExists(db, 'kv')
  // One transaction: both statements apply or neither does. A failure leaves it open, and the caller's close()
  // discards it (pinned by the trigger test).
  db.exec('BEGIN IMMEDIATE')
  const claims = hasSessions ? Number(db.prepare(CLEAR_CLAIMS_SQL).run().changes) : 0
  const backgroundJobs = hasKv ? Number(db.prepare(CLEAR_BACKGROUND_JOBS_SQL).run().changes) : 0
  db.exec('COMMIT')
  return {claims, backgroundJobs}
}

export async function clearHeldClaims(dbPath: string, logger: Logger): Promise<Result<ClearHeldClaimsOutcome, Error>> {
  // Checked before opening: `DatabaseSync` creates a missing file, and an empty database planted here would be
  // restored by the server as if it were the user's history.
  if (!existsSync(dbPath)) {
    logger.debug('No OpenCode V2 database to clear held claims in', {dbPath})
    return ok({status: 'no-database'})
  }

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath)
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    const {claims, backgroundJobs} = runClear(db)
    logger.info('Cleared held OpenCode V2 claims before spawn', {claims, backgroundJobs})
    return ok({status: 'cleared', claims, backgroundJobs})
  } catch (error) {
    logger.warning('Failed to clear held OpenCode V2 claims', {dbPath, error: toErrorMessage(error)})
    return err(toError(error))
  } finally {
    try {
      db?.close()
    } catch {
      // Nothing useful to do if close fails after the outcome is decided.
    }
  }
}
