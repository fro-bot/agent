// ensure-protected-dir.mjs — Create-or-validate a root-owned protected directory
// without ever following a symlink. Pure ESM, no build step. Used by
// workspace-entrypoint.sh before any untrusted or agent-uid code runs.
//
// Threat model: a compromised agent-uid process (or a tampered volume) could
// plant a symlink at a path this script is about to create/use, redirecting a
// later root-privileged write anywhere on the filesystem. lstat (never stat)
// on the target path, and refusing outright when it is a symlink or has the
// wrong owner, closes that TOCTOU class for the directories this script owns.
//
// Two protection levels, selected by the `nested` flag:
//   - strict (default): the path itself must be a real directory owned
//     exactly uid:gid with exactly `mode`. Used for the barrier directories
//     (/run/workspace-agent, /workspace/repos/.workspace-agent) that nothing
//     but this script ever creates.
//   - nested: for paths whose owner/mode we do NOT control — Docker creates
//     the intermediate directory for a bind-mounted secret file (mode 0755),
//     and a mounted volume's root directory carries whatever owner/mode the
//     volume's other container gave it (and may be read-only, so it can't be
//     chmod'ed even if we wanted to). Requiring an exact owner/mode there
//     would refuse every real deployment. What actually keeps the agent uid
//     out is the *parent*: root-owned 0700, so uid 10001 can't traverse into
//     it regardless of what mode the mount-managed child ends up with. So a
//     nested check accepts any owner/mode on the child (as long as it is a
//     real directory, never a symlink), but first re-verifies — in the same
//     call — that the parent is itself a strict protected directory (real
//     directory, owned uid:gid, mode exactly `mode`). That stops a future
//     caller from applying the relaxed rule somewhere with no barrier above
//     it.
//
// Test-injection note: this module never hardcodes uid 0 — callers pass the
// uid/gid they expect, and tests inject the test process's own uid/gid
// (which is never 0) so the "creates" and "owned by" paths are exercisable
// without root. The nested parent check reuses the same uid/gid argument for
// exactly this reason: production passes 0/0 for both the parent and child,
// so the effective production check is still "parent owned 0:0 mode 0700".

import {chmodSync, chownSync, lstatSync, mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import process from 'node:process'

/**
 * @param {string} parentPath
 * @param {number} uid
 * @param {number} gid
 * @param {number} mode
 * @returns {string | null} an error string if the parent is not a verified
 *   strict protected directory, or null if it is.
 */
function checkStrictParent(parentPath, uid, gid, mode) {
  let pst
  try {
    pst = lstatSync(parentPath)
  } catch (error) {
    return `cannot stat parent ${parentPath}: ${error.message}`
  }
  if (pst.isSymbolicLink()) {
    return `parent ${parentPath} is a symlink, not a real directory — refusing`
  }
  if (!pst.isDirectory()) {
    return `parent ${parentPath} is not a directory — refusing`
  }
  if (pst.uid !== uid || pst.gid !== gid) {
    return `parent ${parentPath} is owned by ${pst.uid}:${pst.gid}, expected ${uid}:${gid} — refusing`
  }
  const parentMode = pst.mode & 0o777
  if (parentMode !== mode) {
    return `parent ${parentPath} has mode ${parentMode.toString(8)}, expected ${mode.toString(8)} — refusing`
  }
  return null
}

/**
 * Ensure `path` exists as a real (non-symlink) directory. Creates it if
 * absent, always with owner uid:gid and exactly `mode`.
 *
 * Strict mode (default, `nested` false): if the path pre-exists, it must
 * already be owned uid:gid with exactly `mode`, or this refuses — it never
 * chowns/chmods a pre-existing directory it does not already trust, since
 * that directory could have been planted by untrusted code.
 *
 * Nested mode (`nested` true): for a path whose child directory is created
 * by something else (Docker's bind-mount / volume-mount machinery) and
 * whose owner/mode this script cannot and should not control. Requires the
 * parent directory to already be a verified strict protected directory
 * (owned uid:gid, mode exactly `mode`, a real directory) — refusing
 * otherwise, so the relaxed rule can never apply without a barrier above it.
 * If the child pre-exists, only symlink/regular-file checks apply; any
 * owner/mode is accepted, and the observed owner/mode is logged to stderr
 * for operator visibility. If the child is absent it is created exactly
 * like the strict case (owned uid:gid, mode `mode`) since we're the one
 * creating it.
 *
 * @param {string} dirPath
 * @param {number} uid
 * @param {number} gid
 * @param {number} mode - numeric (e.g. 0o700)
 * @param {boolean} [nested] - relax owner/mode checks on a pre-existing
 *   directory, after verifying the parent is itself strict.
 * @returns {{ ok: true, created: boolean } | { ok: false, error: string }}
 */
export function ensureProtectedDir(dirPath, uid, gid, mode, nested = false) {
  if (nested) {
    const parentError = checkStrictParent(dirname(dirPath), uid, gid, mode)
    if (parentError !== null) {
      return {ok: false, error: `refusing --nested for ${dirPath}: ${parentError}`}
    }
  }

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

  if (nested) {
    const observedMode = (st.mode & 0o777).toString(8)
    process.stderr.write(
      `ensure-protected-dir: ${dirPath} is nested and mount-managed — owned ${st.uid}:${st.gid}, mode ${observedMode} (accepted; the parent directory is the real barrier)\n`,
    )
    return {ok: true, created: false}
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

// CLI main guard: node ensure-protected-dir.mjs [--nested] <path> <uid> <gid> <mode-octal>
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rawArgs = process.argv.slice(2)
  const nested = rawArgs.includes('--nested')
  const positional = rawArgs.filter(arg => arg !== '--nested')
  const [dirPath, uidStr, gidStr, modeStr] = positional
  if (!dirPath || !uidStr || !gidStr || !modeStr) {
    process.stderr.write('usage: ensure-protected-dir.mjs [--nested] <path> <uid> <gid> <mode-octal>\n')
    process.exit(2)
  }
  const uid = Number.parseInt(uidStr, 10)
  const gid = Number.parseInt(gidStr, 10)
  const mode = Number.parseInt(modeStr, 8)
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || !Number.isInteger(mode)) {
    process.stderr.write(`invalid uid/gid/mode: ${uidStr} ${gidStr} ${modeStr}\n`)
    process.exit(2)
  }
  const result = ensureProtectedDir(dirPath, uid, gid, mode, nested)
  if (result.ok === false) {
    process.stderr.write(`${result.error}\n`)
    process.exit(1)
  }
  process.stderr.write(`ensure-protected-dir: ${dirPath} ${result.created ? 'created' : 'verified'}\n`)
  process.exit(0)
}
