// ensure-protected-dir.mjs — Create-or-validate a root-owned protected directory
// without ever following a symlink. Pure ESM, no build step. Used by
// workspace-entrypoint.sh before any untrusted or agent-uid code runs.
//
// Threat model: a compromised agent-uid process (or a tampered volume) could
// plant a symlink at a path this script is about to create/use, redirecting a
// later root-privileged write anywhere on the filesystem. lstat (never stat)
// on the target path, and refusing outright when it is a symlink or has the
// wrong owner, closes that TOCTOU class for the directories this script owns.

import {chmodSync, chownSync, lstatSync, mkdirSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import process from 'node:process'

/**
 * Ensure `path` exists as a real (non-symlink) directory owned by uid:gid with
 * exactly `mode`. Creates it if absent. Refuses (returns a descriptive error)
 * if a pre-existing path is a symlink, not a directory, or has the wrong
 * owner — it never chowns/chmods a pre-existing directory it does not already
 * trust, since that directory could have been planted by untrusted code.
 *
 * @param {string} dirPath
 * @param {number} uid
 * @param {number} gid
 * @param {number} mode - numeric (e.g. 0o700)
 * @returns {{ ok: true, created: boolean } | { ok: false, error: string }}
 */
export function ensureProtectedDir(dirPath, uid, gid, mode) {
  let st
  try {
    st = lstatSync(dirPath)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return {ok: false, error: `cannot stat ${dirPath}: ${error.message}`}
    }
    st = null
  }

  if (st === null) {
    try {
      mkdirSync(dirPath, {mode})
      chownSync(dirPath, uid, gid)
      chmodSync(dirPath, mode)
    } catch (error) {
      return {ok: false, error: `cannot create ${dirPath}: ${error.message}`}
    }
    return {ok: true, created: true}
  }

  if (st.isSymbolicLink()) {
    return {ok: false, error: `${dirPath} is a symlink, not a real directory — refusing to use it`}
  }
  if (!st.isDirectory()) {
    return {ok: false, error: `${dirPath} exists but is not a directory — refusing to use it`}
  }
  if (st.uid !== uid || st.gid !== gid) {
    return {ok: false, error: `${dirPath} is owned by ${st.uid}:${st.gid}, expected ${uid}:${gid}`}
  }
  const actualMode = st.mode & 0o777
  if (actualMode !== mode) {
    return {
      ok: false,
      error: `${dirPath} has mode ${actualMode.toString(8)}, expected ${mode.toString(8)}`,
    }
  }
  return {ok: true, created: false}
}

// CLI main guard: node ensure-protected-dir.mjs <path> <uid> <gid> <mode-octal>
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , dirPath, uidStr, gidStr, modeStr] = process.argv
  if (!dirPath || !uidStr || !gidStr || !modeStr) {
    process.stderr.write('usage: ensure-protected-dir.mjs <path> <uid> <gid> <mode-octal>\n')
    process.exit(2)
  }
  const uid = Number.parseInt(uidStr, 10)
  const gid = Number.parseInt(gidStr, 10)
  const mode = Number.parseInt(modeStr, 8)
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || !Number.isInteger(mode)) {
    process.stderr.write(`invalid uid/gid/mode: ${uidStr} ${gidStr} ${modeStr}\n`)
    process.exit(2)
  }
  const result = ensureProtectedDir(dirPath, uid, gid, mode)
  if (result.ok === false) {
    process.stderr.write(`${result.error}\n`)
    process.exit(1)
  }
  process.stderr.write(`ensure-protected-dir: ${dirPath} ${result.created ? 'created' : 'verified'}\n`)
  process.exit(0)
}
