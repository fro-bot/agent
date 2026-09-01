import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {verifyDatabaseUsable} from './integrity.js'

describe('verifyDatabaseUsable', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integrity-test-'))
    dbPath = path.join(tempDir, 'opencode.db')
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('reports usable for a healthy database with no write-ahead log', async () => {
    // #given a real, cleanly-closed database — the common case this probe must not flag
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    db.exec("INSERT INTO sessions (data) VALUES ('session-1')")
    db.close()

    // #when verifying
    const result = await verifyDatabaseUsable(dbPath)

    // #then it reports usable without throwing
    expect(result).toEqual({usable: true})
  })

  it('reports not usable for a file that is not a real SQLite database', async () => {
    // #given a file with garbage bytes instead of a real SQLite header
    await fs.writeFile(dbPath, 'not a real sqlite database file, just garbage bytes'.repeat(50))

    // #when verifying
    const result = await verifyDatabaseUsable(dbPath)

    // #then it reports the structural failure SQLite itself surfaces
    expect(result.usable).toBe(false)
    expect(result.usable === false ? result.reason.toLowerCase() : '').toContain('not a database')
  })

  it('reports not usable for a database file truncated mid-page (a malformed disk image)', async () => {
    // #given a real database truncated to simulate a torn write with no write-ahead log
    // left behind to explain it
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    const insert = db.prepare('INSERT INTO sessions (data) VALUES (?)')
    db.exec('BEGIN')
    for (let i = 0; i < 200; i++) {
      insert.run('x'.repeat(200))
    }
    db.exec('COMMIT')
    db.close()
    // Size the file through the open handle rather than stat-then-open: resolving the
    // path twice is a check-then-use window, and the truncation must apply to the same
    // file that was measured.
    const fileHandle = await fs.open(dbPath, 'r+')
    try {
      const {size} = await fileHandle.stat()
      await fileHandle.truncate(Math.floor(size / 2))
    } finally {
      await fileHandle.close()
    }

    // #when verifying
    const result = await verifyDatabaseUsable(dbPath)

    // #then it reports the disk-image corruption SQLite itself surfaces
    expect(result.usable).toBe(false)
    expect(result.usable === false ? result.reason.toLowerCase() : '').toContain('malformed')
  })

  it('reports usable for a real database that cannot be opened due to a permissions fault, not corruption', async () => {
    // #given a real, healthy database made unreadable by permissions — an environmental
    // fault (SQLITE_CANTOPEN: "unable to open database file"), not evidence of corruption.
    // This is the blocking case the review caught: any thrown error previously became
    // usable: false, which would have reported a perfectly healthy database as corrupt
    // and let the caller delete a repository's session history over a transient fault.
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT)')
    db.exec("INSERT INTO sessions (data) VALUES ('session-1')")
    db.close()
    await fs.chmod(dbPath, 0o000)

    try {
      // #when verifying
      const result = await verifyDatabaseUsable(dbPath)

      // #then it reports usable — the safe default for an unrecognized SQLite error is to
      // leave the database alone, not report it corrupt
      expect(result).toEqual({usable: true})
    } finally {
      await fs.chmod(dbPath, 0o644)
    }
  })

  it('reports usable without creating a file for a database path that does not exist', async () => {
    // #given a path nothing has ever written to
    await expect(fs.access(dbPath)).rejects.toThrow()

    // #when verifying
    const result = await verifyDatabaseUsable(dbPath)

    // #then it reports usable (nothing here to find corrupt) and never creates the file as
    // a side effect — node:sqlite would otherwise create a fresh empty database
    expect(result).toEqual({usable: true})
    await expect(fs.access(dbPath)).rejects.toThrow()
  })

  it('reports usable for a zero-byte database rather than opening it', async () => {
    // #given a zero-byte file (e.g. touched but never written)
    await fs.writeFile(dbPath, '')

    // #when verifying
    const result = await verifyDatabaseUsable(dbPath)

    // #then it reports usable without attempting to open it
    expect(result).toEqual({usable: true})
  })
})
