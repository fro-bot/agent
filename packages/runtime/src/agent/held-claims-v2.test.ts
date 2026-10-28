import type {Logger} from '../shared/logger.js'
import {existsSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {clearHeldClaims} from './held-claims-v2.js'

function createMockLogger(): Logger {
  return {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}
}

// Mirrors the two tables the clear touches in upstream v2.2.0: `session_v2`
// (core/src/session/sql.ts:71-72 for the claim columns) and `kv` (core/src/kv/sql.ts:5).
const SCHEMA = `
  CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    time_suspended INTEGER,
    resume_attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

function seed(db: DatabaseSync): void {
  db.exec(SCHEMA)
  db.exec(`
    INSERT INTO session_v2 (id, parent_id, time_suspended, resume_attempts) VALUES
      ('ses_root', NULL, 1700000000000, 2),
      ('ses_child', 'ses_root', 1700000000001, 0),
      ('ses_idle', NULL, NULL, 0);
    INSERT INTO kv (key, value) VALUES
      ('job.background/ntf_1', '{"status":"running"}'),
      ('job.background/ntf_2', '{"status":"running"}'),
      ('job.background', 'not-a-job-row'),
      ('job.other/ntf_3', 'keep');
  `)
}

function readState(dbPath: string): {
  readonly sessions: readonly {id: string; time_suspended: number | null; resume_attempts: number}[]
  readonly kvKeys: readonly string[]
} {
  const db = new DatabaseSync(dbPath, {readOnly: true})
  try {
    const sessions = db
      .prepare('SELECT id, time_suspended, resume_attempts FROM session_v2 ORDER BY id')
      .all() as unknown as {id: string; time_suspended: number | null; resume_attempts: number}[]
    const kvKeys = (db.prepare('SELECT key FROM kv ORDER BY key').all() as unknown as {key: string}[]).map(r => r.key)
    return {sessions, kvKeys}
  } finally {
    db.close()
  }
}

describe('clearHeldClaims', () => {
  let tmp: string
  let dbPath: string
  let logger: Logger

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'held-claims-v2-'))
    dbPath = path.join(tmp, 'opencode.db')
    logger = createMockLogger()
  })

  afterEach(async () => {
    await fs.rm(tmp, {recursive: true, force: true})
  })

  it('clears every held claim and every background-job row, and nothing else', async () => {
    // #given a database with held claims and background-job rows
    const db = new DatabaseSync(dbPath)
    seed(db)
    db.close()

    // #when clearing
    const result = await clearHeldClaims(dbPath, logger)

    // #then the claims and the job rows are gone and unrelated rows are untouched
    expect(result).toMatchObject({success: true, data: {status: 'cleared', claims: 2, backgroundJobs: 2}})
    const state = readState(dbPath)
    expect(state.sessions).toEqual([
      {id: 'ses_child', time_suspended: null, resume_attempts: 0},
      {id: 'ses_idle', time_suspended: null, resume_attempts: 0},
      {id: 'ses_root', time_suspended: null, resume_attempts: 0},
    ])
    expect(state.kvKeys).toEqual(['job.background', 'job.other/ntf_3'])
  })

  it('does not touch the attempts counter of a session that holds no claim', async () => {
    // #given an unclaimed session with a non-zero attempts counter
    const db = new DatabaseSync(dbPath)
    db.exec(SCHEMA)
    db.exec(`INSERT INTO session_v2 (id, time_suspended, resume_attempts) VALUES ('ses_a', NULL, 3)`)
    db.close()

    // #when clearing
    await clearHeldClaims(dbPath, logger)

    // #then the counter is preserved
    expect(readState(dbPath).sessions).toEqual([{id: 'ses_a', time_suspended: null, resume_attempts: 3}])
  })

  it('is a no-op for a missing database and does not create one', async () => {
    // #when the database file does not exist
    const result = await clearHeldClaims(dbPath, logger)

    // #then nothing happens, and in particular no empty database is created
    expect(result).toMatchObject({success: true, data: {status: 'no-database'}})
    expect(existsSync(dbPath)).toBe(false)
  })

  it('is a no-op for a database without the V2 tables (for example a restored V1 database)', async () => {
    // #given a database that only has V1 tables
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)')
    db.exec(`INSERT INTO session (id, title) VALUES ('ses_v1', 't')`)
    db.close()

    // #when clearing
    const result = await clearHeldClaims(dbPath, logger)

    // #then it succeeds without creating V2 tables or touching V1 rows
    expect(result).toMatchObject({success: true, data: {status: 'cleared', claims: 0, backgroundJobs: 0}})
    const check = new DatabaseSync(dbPath, {readOnly: true})
    const tables = (
      check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as {name: string}[]
    ).map(r => r.name)
    check.close()
    expect(tables).toEqual(['session'])
  })

  it('clears the claims when only one of the two tables exists', async () => {
    // #given session_v2 without kv
    const db = new DatabaseSync(dbPath)
    db.exec(
      'CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, time_suspended INTEGER, resume_attempts INTEGER NOT NULL DEFAULT 0)',
    )
    db.exec(`INSERT INTO session_v2 (id, time_suspended, resume_attempts) VALUES ('ses_a', 5, 1)`)
    db.close()

    // #when clearing
    const result = await clearHeldClaims(dbPath, logger)

    // #then the claim is cleared and the missing kv table is not an error
    expect(result).toMatchObject({success: true, data: {status: 'cleared', claims: 1, backgroundJobs: 0}})
  })

  it('applies the write-ahead log, so a hard-killed database is cleared (never reading the main file alone)', async () => {
    // #given a database whose schema and claims live only in the -wal file, as after SIGKILL
    // (P11: the main file alone does not even contain the V2 tables)
    const live = path.join(tmp, 'live.db')
    const writer = new DatabaseSync(live)
    writer.exec('PRAGMA journal_mode = WAL')
    writer.exec('PRAGMA wal_autocheckpoint = 0')
    seed(writer)
    // Copy db + wal while the writer is still open: the copy is what a hard kill leaves behind.
    await fs.copyFile(live, dbPath)
    await fs.copyFile(`${live}-wal`, `${dbPath}-wal`)
    writer.close()
    const mainOnly = path.join(tmp, 'main-only.db')
    await fs.copyFile(dbPath, mainOnly)
    expect(() => readState(mainOnly)).toThrow(/no such table/)

    // #when clearing
    const result = await clearHeldClaims(dbPath, logger)

    // #then the WAL content was seen and cleared
    expect(result).toMatchObject({success: true, data: {status: 'cleared', claims: 2, backgroundJobs: 2}})
    // #and the cleared state is in the main file itself, so saving only that file saves the clear
    const savedMainOnly = path.join(tmp, 'saved-main-only.db')
    await fs.copyFile(dbPath, savedMainOnly)
    const state = readState(savedMainOnly)
    expect(state.sessions.every(s => s.time_suspended === null && s.resume_attempts === 0)).toBe(true)
    expect(state.kvKeys).toEqual(['job.background', 'job.other/ntf_3'])
  })

  it('returns an error, and does not throw, when the file is not a database', async () => {
    // #given a file that is not SQLite
    await fs.writeFile(dbPath, 'this is not a sqlite database, it is just text padding '.repeat(20))

    // #when clearing
    const result = await clearHeldClaims(dbPath, logger)

    // #then the failure is reported as a Result
    expect(result.success).toBe(false)
  })

  it('rolls back both statements when one fails, so a partial clear never persists', async () => {
    // #given a kv table whose delete is rejected by a trigger
    const db = new DatabaseSync(dbPath)
    seed(db)
    db.exec(`CREATE TRIGGER no_kv_delete BEFORE DELETE ON kv BEGIN SELECT RAISE(ABORT, 'blocked'); END`)
    db.close()

    // #when clearing
    const result = await clearHeldClaims(dbPath, logger)

    // #then it reports the failure and the claims were not cleared either
    expect(result.success).toBe(false)
    expect(readState(dbPath).sessions.filter(s => s.time_suspended !== null)).toHaveLength(2)
  })
})
