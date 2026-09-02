/**
 * Shared SQLite error-message classification for `checkpoint.ts` and `integrity.ts`.
 * Extracted rather than duplicated in both modules so the two matchers cannot drift
 * apart the way `paths.ts`'s DB-family filename list once threatened to (see that
 * module's own comment on why it re-exports rather than redefines).
 *
 * `node:sqlite` surfaces every failure as a thrown `Error` with no structured error
 * code — only a message — so matching on wording is what is available.
 */

/**
 * A busy or locked database is the harness's only signal that the OpenCode child (or some
 * other process) still holds the database open. Both "database is locked" (SQLITE_BUSY on
 * open/exec) and "busy" cover the cases observed in practice. This governs only the
 * checkpoint retry loop — whether to attempt again within the bound — and is a separate
 * axis from whether a failure is structural corruption.
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const message = error.message.toLowerCase()
  return message.includes('locked') || message.includes('busy')
}

/**
 * Reports whether an error is SQLite itself declaring the file structurally unusable as
 * a database — never a default. Deleting a repository's session history is the most
 * destructive thing this module does, so the match here is a positive allowlist of the
 * exact wording SQLite uses for that specific claim, not "everything isRetryableError
 * didn't catch". An unrecognized error (permission denied, disk full, I/O error, a
 * missing parent directory, a merely non-writable-but-readable database) must default to
 * `false` — leave the database alone — because those are environmental and often
 * transient, and wiping on them reproduces exactly the "wipe on any bootstrap failure"
 * tradeoff this design rejected, reached through a narrower door.
 *
 * Matches, verified against real `node:sqlite` output:
 * - "file is not a database" (garbage bytes where a SQLite header should be)
 * - "file is encrypted or is not a database" (an older SQLCipher-flavored build's wording
 *   for the same condition) — also caught by the "not a database" substring
 * - "database disk image is malformed" (a real database truncated or torn mid-page)
 *
 * Deliberately does not match "unable to open database file" (missing directory, fd
 * exhaustion), "attempt to write a readonly database" (permissions), "database or disk is
 * full" (SQLITE_FULL), or "disk i/o error" (SQLITE_IOERR) — all environmental, none of
 * them evidence the database itself is corrupt.
 */
export function isStructuralCorruptionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const message = error.message.toLowerCase()
  return message.includes('not a database') || message.includes('malformed')
}
