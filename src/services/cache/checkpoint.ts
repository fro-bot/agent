import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import {DatabaseSync} from 'node:sqlite'
import {toErrorMessage} from '../../shared/errors.js'

/**
 * Outcome of a checkpoint attempt against a SQLite database's write-ahead log.
 *
 * Three states, not two. Collapsing "already clean" into "failed" would decline saves
 * that were always safe (a healthy database with no pending WAL data), which is exactly
 * how a two-state design regresses existing session continuity: every save with nothing
 * to merge would be treated the same as one that genuinely could not merge.
 *
 * - `checkpointed`: the write-ahead log held data and it was successfully merged into
 *   the main database file. The log is now empty (or absent).
 * - `nothing-to-checkpoint`: there was no database, no write-ahead log, or the log was
 *   already empty. Nothing needed to happen, and the caller should proceed exactly as
 *   if a checkpoint had succeeded.
 * - `failed`: a write-ahead log existed and held data, but it could not be merged
 *   (a live writer held the database, every attempt could not fully truncate it, or the
 *   repair deadline elapsed between attempts). `reason` is a human-readable explanation
 *   for logs and the job summary. `retryable` distinguishes why: `true` means the
 *   database itself is presumably fine and merely busy, slow, or still not fully
 *   truncated within budget; `false` means SQLite itself reported the file is not a
 *   usable database (e.g. "file is not a database", "database disk image is malformed")
 *   — a structural failure no amount of retrying would fix. Callers use this to decide
 *   whether to treat the database as corrupted rather than merely busy.
 */
export type CheckpointOutcome =
  | {readonly status: 'checkpointed'}
  | {readonly status: 'nothing-to-checkpoint'}
  | {readonly status: 'failed'; readonly reason: string; readonly retryable: boolean}

export interface CheckpointOptions {
  readonly dbPath: string
  readonly walPath: string
  readonly logger: Logger
  /** Bounded retry count for a busy or partially-progressed checkpoint. Default 5. */
  readonly maxAttempts?: number
  /** Delay between retry attempts, in milliseconds. Default 200. */
  readonly retryDelayMs?: number
  /**
   * Wall-clock budget in milliseconds for the whole repair, checked only between
   * attempts. An in-flight `PRAGMA wal_checkpoint(TRUNCATE)` is never interrupted, so a
   * slow-but-succeeding first attempt always completes regardless of this value. Default
   * 5000. The pragma itself has no bound: this PR's own measurement put a 185 MB
   * write-ahead log at ~2.4s for a single attempt, so 5 default attempts could otherwise
   * add ~12s of unbounded time ahead of every cache-hit's bootstrap. 5000ms guarantees at
   * least one full attempt completes even for an unusually large log, while capping the
   * worst case to roughly one attempt beyond the budget instead of unbounded attempts
   * times unbounded per-attempt duration.
   */
  readonly deadlineMs?: number
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_RETRY_DELAY_MS = 200
const DEFAULT_DEADLINE_MS = 5000

async function fileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath)
    return stat.size
  } catch {
    return null
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * A busy or locked database is the harness's only signal that the OpenCode child (or some
 * other process) still holds the database open. `node:sqlite` surfaces this as a thrown
 * error rather than a return value, and Node's typings for that error carry no structured
 * code — only a message. Matching on wording is what's available; both "database is
 * locked" (SQLITE_BUSY on open/exec) and "busy" cover the cases observed in practice.
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const message = error.message.toLowerCase()
  return message.includes('locked') || message.includes('busy')
}

/**
 * Attempts to merge a SQLite write-ahead log into its main database file via
 * `PRAGMA wal_checkpoint(TRUNCATE)`, using `node:sqlite` (available unflagged on Node 24;
 * no new dependency).
 *
 * The harness cannot observe whether the process that was writing to this database has
 * actually exited — `serverHandle.shutdown()` sends a signal and returns without waiting.
 * The checkpoint attempt is itself the liveness probe: a live writer surfaces as a busy
 * database, and this function retries that within a bound before reporting failure.
 *
 * Success is judged by the write-ahead log's size on disk after the attempt, never by
 * the pragma's returned `checkpointed` count. Verified on Node 24.20.0: the pragma
 * returned `{busy: 0, log: 0, checkpointed: 0}` while truncating a populated log to
 * zero bytes. Trusting that count would report a false failure on every successful
 * truncation of an otherwise-idle database.
 *
 * Never throws. A missing or zero-byte database is `nothing-to-checkpoint` without ever
 * opening it — `node:sqlite` creates a fresh empty database file for a path that does
 * not exist, which would be the wrong side effect for a database this function did not
 * expect to find.
 */
export async function checkpointDatabase(options: CheckpointOptions): Promise<CheckpointOutcome> {
  const {
    dbPath,
    walPath,
    logger,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    deadlineMs = DEFAULT_DEADLINE_MS,
  } = options

  const dbSize = await fileSize(dbPath)
  if (dbSize == null || dbSize === 0) {
    return {status: 'nothing-to-checkpoint'}
  }

  const walSizeBefore = await fileSize(walPath)
  if (walSizeBefore == null || walSizeBefore === 0) {
    return {status: 'nothing-to-checkpoint'}
  }

  let lastReason = 'unknown checkpoint failure'
  let lastRetryable = true
  const startedAt = Date.now()

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Checked between attempts only, never mid-checkpoint: attempt 1 always runs
    // regardless of this budget, and an in-flight PRAGMA is never aborted.
    if (attempt > 1 && Date.now() - startedAt >= deadlineMs) {
      lastReason = `checkpoint deadline of ${deadlineMs}ms exceeded after attempt ${attempt - 1}/${maxAttempts}`
      lastRetryable = true
      logger.warning('SQLite checkpoint deadline exceeded, declining further attempts', {
        attempt: attempt - 1,
        maxAttempts,
        deadlineMs,
      })
      break
    }

    let db: DatabaseSync | undefined
    let caughtError: unknown

    try {
      db = new DatabaseSync(dbPath)
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    } catch (error) {
      caughtError = error
    } finally {
      try {
        db?.close()
      } catch {
        // best effort close — the checkpoint outcome is judged by WAL size on disk, not this
      }
    }

    if (caughtError !== undefined) {
      lastReason = toErrorMessage(caughtError)
      lastRetryable = isRetryableError(caughtError)
      if (!lastRetryable || attempt === maxAttempts) {
        logger.warning('SQLite checkpoint attempt failed', {attempt, maxAttempts, reason: lastReason})
        break
      }
      logger.debug('SQLite checkpoint busy, retrying', {attempt, maxAttempts, reason: lastReason})
      await delay(retryDelayMs)
      continue
    }

    const walSizeAfter = await fileSize(walPath)
    if (walSizeAfter == null || walSizeAfter === 0) {
      return {status: 'checkpointed'}
    }

    lastReason = `write-ahead log still ${walSizeAfter} bytes after checkpoint attempt ${attempt}/${maxAttempts}`
    lastRetryable = true
    if (attempt === maxAttempts) {
      break
    }
    logger.debug('SQLite checkpoint did not fully truncate write-ahead log, retrying', {
      attempt,
      maxAttempts,
      walSizeAfter,
    })
    await delay(retryDelayMs)
  }

  return {status: 'failed', reason: lastReason, retryable: lastRetryable}
}
