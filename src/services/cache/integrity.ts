import * as fs from 'node:fs/promises'
import {DatabaseSync} from 'node:sqlite'
import {toErrorMessage} from '../../shared/errors.js'

export type DatabaseUsability = {readonly usable: true} | {readonly usable: false; readonly reason: string}

/**
 * Verifies a SQLite database file is actually openable and readable, without scanning
 * its contents.
 *
 * Restore-only, by design. `checkpointDatabase`'s contract is driven entirely by the
 * write-ahead log: a database with no log to merge is reported `nothing-to-checkpoint`
 * before anything ever opens it, which is exactly right for a healthy database but says
 * nothing about a structurally corrupt one with no hot WAL to betray it through a failed
 * checkpoint attempt. This probe exists to close that specific gap on the restore path,
 * where a corrupt database would otherwise reach `bootstrapOpenCodeServer` untouched and
 * later get re-persisted by `saveCache` under a fresh key — the same self-perpetuating
 * loop this module's checkpoint repair already breaks for the hot-WAL case.
 *
 * Deliberately not folded into `checkpointDatabase` itself: that would change what
 * `nothing-to-checkpoint` means for the save path too, forcing every healthy save with
 * no pending WAL data to open a database it currently never touches. The restore path
 * already runs outside the `createOpencode` bootstrap budget and already owns the
 * clean-slate machinery (`cleanStorage`) this probe's failure feeds into; the save path
 * has neither reason to pay this cost.
 *
 * `SELECT count(*) FROM sqlite_master` reads the schema table every SQLite database has
 * — even an empty one — which is the first page SQLite actually validates. Opening the
 * connection alone is not sufficient: `node:sqlite` defers validation until the first
 * real read, so `new DatabaseSync(path)` on a garbage file does not throw by itself
 * (verified locally). This one-page read is enough to surface both "file is not a
 * database" and "database disk image is malformed" — the two structural errors that
 * matter here — without a full `PRAGMA integrity_check`, which walks every page and
 * would scale with database size on the critical path of every cache hit. Measured
 * locally against a healthy ~2.5 MB checkpointed database: under 2ms per call, and the
 * cost does not grow with database size the way a full scan would, because only the
 * schema page is ever read.
 *
 * Never opens a missing or empty database: `node:sqlite` creates a fresh empty database
 * file for a path that does not exist, which would be the wrong side effect for a
 * database this function did not expect to find. Both cases report `usable: true` —
 * there is nothing here for this probe to find corrupt, and the caller's own
 * `nothing-to-checkpoint` / cache-hit gating already established there is a restored
 * database worth checking in the first place.
 */
export async function verifyDatabaseUsable(dbPath: string): Promise<DatabaseUsability> {
  const stat = await fs.stat(dbPath).catch(() => null)
  if (stat == null || stat.size === 0) {
    return {usable: true}
  }

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath)
    db.prepare('SELECT count(*) FROM sqlite_master').get()
    return {usable: true}
  } catch (error) {
    return {usable: false, reason: toErrorMessage(error)}
  } finally {
    try {
      db?.close()
    } catch {
      // best effort close — the outcome is already determined by the read above
    }
  }
}
