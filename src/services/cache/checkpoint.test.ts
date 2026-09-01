import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {checkpointDatabase} from './checkpoint.js'

async function fileSizeOrZero(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size
  } catch {
    return 0
  }
}

describe('checkpointDatabase', () => {
  let tempDir: string
  let dbPath: string
  let walPath: string
  let logger: Logger
  const openHandles: DatabaseSync[] = []

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-test-'))
    dbPath = path.join(tempDir, 'opencode.db')
    walPath = `${dbPath}-wal`
    logger = createMockLogger()
  })

  afterEach(async () => {
    while (openHandles.length > 0) {
      const handle = openHandles.pop()
      try {
        handle?.close()
      } catch {
        // best effort — some handles may already be closed by the test itself
      }
    }
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  /**
   * Opens a database with a populated write-ahead log and deliberately does not close
   * it — mirroring `server.close()` sending `proc.kill()` without awaiting a checkpoint.
   * The caller must keep the connection referenced (via `openHandles`, closed in
   * `afterEach`) or SQLite may perform its own implicit checkpoint when the handle is
   * finalized, defeating the "hot WAL" fixture this suite depends on.
   */
  function openHotWalDatabase(targetDbPath: string): DatabaseSync {
    const db = new DatabaseSync(targetDbPath)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    db.exec("INSERT INTO sessions (data) VALUES ('session-1')")
    openHandles.push(db)
    return db
  }

  it('checkpoints a populated write-ahead log so the data is readable from the database alone', async () => {
    // #given a database whose write-ahead log holds data and was never cleanly closed
    openHotWalDatabase(dbPath)
    expect(await fileSizeOrZero(walPath)).toBeGreaterThan(0)

    // #when checkpointing
    const outcome = await checkpointDatabase({dbPath, walPath, logger})

    // #then it reports success and the write-ahead log is empty
    expect(outcome).toEqual({status: 'checkpointed'})
    expect(await fileSizeOrZero(walPath)).toBe(0)

    // #then the data survives in the database alone, with no write-ahead log to fall back on
    const verifyDb = new DatabaseSync(dbPath)
    try {
      const rows = verifyDb.prepare('SELECT data FROM sessions').all()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.data).toBe('session-1')
    } finally {
      verifyDb.close()
    }
  })

  it('checkpoints a database whose main file is only a header page while the write-ahead log holds all the data (regression guard: see save.ts hasCacheableContent doc comment)', async () => {
    // #given a database in WAL mode that was never checkpointed: on real Node 24.20.0 this
    // leaves the main file at exactly the WAL-mode header-page size, never 0 bytes, with
    // every row actually living in the write-ahead log
    openHotWalDatabase(dbPath)
    const dbSizeBefore = await fileSizeOrZero(dbPath)
    expect(dbSizeBefore).toBeGreaterThan(0)
    expect(dbSizeBefore).toBeLessThanOrEqual(4096)
    expect(await fileSizeOrZero(walPath)).toBeGreaterThan(0)

    // #when checkpointing
    const outcome = await checkpointDatabase({dbPath, walPath, logger})

    // #then it is checkpointed, not skipped as "nothing-to-checkpoint" - a header-page-only
    // main file is real, cacheable content, not an empty database
    expect(outcome).toEqual({status: 'checkpointed'})
    expect(await fileSizeOrZero(walPath)).toBe(0)

    // #then the data that lived only in the write-ahead log is now readable from the main
    // database file alone
    const verifyDb = new DatabaseSync(dbPath)
    try {
      const rows = verifyDb.prepare('SELECT data FROM sessions').all()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.data).toBe('session-1')
    } finally {
      verifyDb.close()
    }
  })

  it('returns nothing-to-checkpoint for an already-clean database and lets the save proceed', async () => {
    // #given a database that was cleanly closed, leaving no write-ahead log behind
    const db = openHotWalDatabase(dbPath)
    db.close()
    openHandles.pop()
    await expect(fs.access(walPath)).rejects.toThrow()

    // #when checkpointing
    const outcome = await checkpointDatabase({dbPath, walPath, logger})

    // #then there is nothing to merge — the outcome tells the caller to proceed with the save
    expect(outcome).toEqual({status: 'nothing-to-checkpoint'})
  })

  it('yields nothing-to-checkpoint for a missing database rather than throwing or creating one', async () => {
    // #given a database path that has never been created
    await expect(fs.access(dbPath)).rejects.toThrow()

    // #when checkpointing
    const outcome = await checkpointDatabase({dbPath, walPath, logger})

    // #then it reports a definite outcome and never creates the file as a side effect —
    // `node:sqlite` would otherwise create a fresh empty database for a path that doesn't exist
    expect(outcome).toEqual({status: 'nothing-to-checkpoint'})
    await expect(fs.access(dbPath)).rejects.toThrow()
  })

  it('yields nothing-to-checkpoint for a zero-byte database rather than throwing', async () => {
    // #given a zero-byte database file (e.g. touched but never written)
    await fs.writeFile(dbPath, '')

    // #when checkpointing
    const outcome = await checkpointDatabase({dbPath, walPath, logger})

    // #then it reports a definite outcome without opening the file
    expect(outcome).toEqual({status: 'nothing-to-checkpoint'})
  })

  it('retries a database locked by another connection, then reports failure without throwing', async () => {
    // #given a database held under an exclusive lock by an in-progress transaction on
    // another connection — the liveness probe a checkpoint attempt provides
    const holder = openHotWalDatabase(dbPath)
    holder.exec('PRAGMA locking_mode=EXCLUSIVE')
    holder.exec('BEGIN IMMEDIATE')
    holder.exec("INSERT INTO sessions (data) VALUES ('in-flight')")

    // #when checkpointing with a small bound so the test stays fast
    const outcome = await checkpointDatabase({dbPath, walPath, logger, maxAttempts: 3, retryDelayMs: 1})

    // #then it retries and reports failure without throwing, classified retryable since
    // the database itself is fine and merely locked by a live writer
    expect(outcome.status).toBe('failed')
    const reason = outcome.status === 'failed' ? outcome.reason : ''
    expect(reason.length).toBeGreaterThan(0)
    expect(outcome.status === 'failed' && outcome.retryable).toBe(true)
    expect(logger.warning).toHaveBeenCalled()

    holder.exec('COMMIT')
  })

  it('reports a non-retryable failure for a database SQLite itself cannot open, without retrying', async () => {
    // #given a database file that is not valid SQLite at all, with a populated
    // write-ahead log beside it so the early-return does not skip opening it
    await fs.writeFile(dbPath, 'not a real sqlite database file, just garbage bytes'.repeat(50))
    await fs.writeFile(walPath, 'also not a real write-ahead log, just more garbage'.repeat(50))

    // #when checkpointing
    const outcome = await checkpointDatabase({dbPath, walPath, logger, maxAttempts: 3, retryDelayMs: 1})

    // #then it fails on the very first attempt — SQLite reports the file itself is not a
    // usable database, which is structural and not worth retrying
    expect(outcome.status).toBe('failed')
    const reason = outcome.status === 'failed' ? outcome.reason : ''
    expect(reason.toLowerCase()).toContain('not a database')
    expect(outcome.status === 'failed' && outcome.retryable).toBe(false)
    expect(logger.warning).toHaveBeenCalledWith('SQLite checkpoint attempt failed', {
      attempt: 1,
      maxAttempts: 3,
      reason,
    })
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('never interrupts attempt 1 but stops before attempt 2 once the deadline has elapsed, reporting a retryable failure', async () => {
    // #given a database held under an exclusive lock, guaranteeing every attempt fails
    // retryably, and a deadline so small it is certainly exceeded by the time attempt 1's
    // delay elapses
    const holder = openHotWalDatabase(dbPath)
    holder.exec('PRAGMA locking_mode=EXCLUSIVE')
    holder.exec('BEGIN IMMEDIATE')
    holder.exec("INSERT INTO sessions (data) VALUES ('in-flight')")

    // #when checkpointing with a deadline smaller than the retry delay
    const outcome = await checkpointDatabase({
      dbPath,
      walPath,
      logger,
      maxAttempts: 5,
      retryDelayMs: 50,
      deadlineMs: 1,
    })

    // #then attempt 1 still ran (never interrupted mid-checkpoint) and failed on the lock,
    // but the deadline stopped any further attempt rather than exhausting maxAttempts —
    // the failure remains classified retryable since the database itself is fine, merely
    // slow to become available
    expect(outcome.status).toBe('failed')
    const reason = outcome.status === 'failed' ? outcome.reason : ''
    expect(reason).toContain('deadline')
    expect(outcome.status === 'failed' && outcome.retryable).toBe(true)
    expect(logger.warning).toHaveBeenCalledWith(
      'SQLite checkpoint deadline exceeded, declining further attempts',
      expect.objectContaining({attempt: 1, maxAttempts: 5, deadlineMs: 1}),
    )

    holder.exec('COMMIT')
  })

  it('treats a pragma result of checkpointed: 0 as success when it actually truncates the write-ahead log', async () => {
    // #given two structurally-identical hot-WAL databases: one to pin the raw pragma's
    // return shape (the exact finding this design distrusts), one for the helper under test
    const controlDbPath = path.join(tempDir, 'control.db')
    const controlWalPath = `${controlDbPath}-wal`
    openHotWalDatabase(controlDbPath)
    openHotWalDatabase(dbPath)

    // #when checkpointing the control database directly via the raw pragma
    const rawDb = new DatabaseSync(controlDbPath)
    const rawRow = rawDb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    rawDb.close()

    // #then the raw pragma reports checkpointed: 0 despite fully truncating the log —
    // this is the signal checkpointDatabase must not trust
    expect(rawRow).toBeDefined()
    expect(rawRow?.checkpointed).toBe(0)
    expect(await fileSizeOrZero(controlWalPath)).toBe(0)

    // #when checkpointing the second database via the helper under test
    const outcome = await checkpointDatabase({dbPath, walPath, logger})

    // #then the helper still reports success, judged by the write-ahead log's size on
    // disk rather than the pragma's checkpointed count
    expect(outcome).toEqual({status: 'checkpointed'})
  })
})
