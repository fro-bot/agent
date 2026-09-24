// migrate-repo-ownership.mjs — One-time ownership migration for existing
// workspace-repos checkouts (root-owned, from before uid isolation) to the
// unprivileged OpenCode agent uid. Pure ESM, no build step. Used by
// workspace-entrypoint.sh, runs as root (the service keeps uid 0 with
// CAP_CHOWN/CAP_FOWNER/CAP_DAC_OVERRIDE — see compose.yaml).
//
// Filesystem only — this script never invokes git. It walks
// /workspace/repos/<owner>/<repo> trees with lstat (never stat) so it can
// never be redirected by a symlink, and it never crosses filesystem
// boundaries (st_dev comparison), so a bind-mounted or nested filesystem
// under a checkout is left alone.
//
// /workspace/repos and /workspace/repos/<owner> are NEVER chowned — only
// /workspace/repos/<owner>/<repo> and its contents move to the agent uid.
// This is deliberate: chowning the parent directories would hand the agent
// control over sibling checkouts and the .workspace-agent state directory.
//
// Hardlinks: a regular file with nlink > 1 may share its inode with a file
// outside the checkout (e.g. a dedup/cache layer). chown follows the inode,
// not the directory entry, so chowning it in place would silently change
// ownership of that external file too. The fix: copy the file's bytes to a
// fresh private inode in the same directory, then atomically rename over the
// original path. The chown that follows only ever touches the new inode; the
// external file's inode and ownership are never touched.
//
// Resumability: a completion marker is written for a checkout ONLY after that
// checkout's entire tree has been walked and chowned without error or
// timeout, via write-to-temp + rename (atomic). A marker's mere existence is
// therefore reliable proof of full completion — there is no state in which a
// partially-migrated checkout has a marker. On restart, checkouts with a
// marker are skipped entirely (cheap, correct); checkouts without one are
// walked again from scratch. Re-chowning an already-migrated tree is a no-op
// cost, so redoing a partial checkout is safe and idempotent.
//
// Bounded: a deadline (default 5 minutes, configurable) is checked before
// each filesystem entry is processed. On expiry, the walk stops immediately,
// no marker is written for the in-progress checkout, and the run reports
// failure loudly. Nothing is ever deleted.

import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import process from 'node:process'
import * as fsPromises from 'node:fs/promises'

export const DEFAULT_DEADLINE_MS = 5 * 60 * 1000
export const STAGING_PREFIX = '.tmp-'
export const STATE_DIR_NAME = '.workspace-agent'

// Functions-only: no Error subclasses (repo convention — only the gateway
// uses class-based errors). A discriminating `code` property plus a
// predicate stands in for `instanceof MigrationTimeoutError`.
const MIGRATION_TIMEOUT_CODE = 'MIGRATION_TIMEOUT'

function createMigrationTimeoutError(message) {
  const error = new Error(message)
  error.code = MIGRATION_TIMEOUT_CODE
  return error
}

function isMigrationTimeoutError(error) {
  return error instanceof Error && error.code === MIGRATION_TIMEOUT_CODE
}

/**
 * Build the default filesystem operations object (real node:fs/promises).
 * Tests override `chown`/`lchown` (and optionally others) since a non-root
 * test process cannot chown to an arbitrary uid — everything else runs for
 * real against a temp directory the test process already owns.
 */
export function defaultOps() {
  return {
    lstat: fsPromises.lstat,
    readdir: fsPromises.readdir,
    readFile: fsPromises.readFile,
    writeFile: fsPromises.writeFile,
    rename: fsPromises.rename,
    mkdir: fsPromises.mkdir,
    chmod: fsPromises.chmod,
    chown: fsPromises.chown,
    lchown: fsPromises.lchown,
    utimes: fsPromises.utimes,
  }
}

function markerPath(stateDir, owner, repo) {
  // owner/repo are individual path segments from readdir — they cannot
  // contain '/', so a plain join is safe and unambiguous.
  return join(stateDir, 'completed', `${owner}__${repo}.json`)
}

async function pathExists(ops, path) {
  try {
    await ops.lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Validate that `path` is a real (non-symlink) directory owned by `uid`,
 * without ever following a symlink. Throws on any violation.
 */
async function assertRealOwnedDir(ops, path, uid, label) {
  let st
  try {
    st = await ops.lstat(path)
  } catch (error) {
    throw new Error(`${label} (${path}) does not exist or cannot be stat'd: ${error.message}`)
  }
  if (st.isSymbolicLink()) {
    throw new Error(`${label} (${path}) is a symlink, not a real directory — refusing to migrate`)
  }
  if (!st.isDirectory()) {
    throw new Error(`${label} (${path}) exists but is not a directory — refusing to migrate`)
  }
  if (st.uid !== uid) {
    throw new Error(`${label} (${path}) is owned by uid ${st.uid}, expected ${uid} — refusing to migrate`)
  }
  return st
}

async function breakHardlink(ops, path, st, log) {
  const tmp = join(dirname(path), `.hardlink-break-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const data = await ops.readFile(path)
  await ops.writeFile(tmp, data, {mode: st.mode & 0o777})
  await ops.rename(tmp, path)
  // The rename gives the new inode a fresh mtime — restore the original
  // atime/mtime from the `st` captured before the break, sub-second
  // precision included (Date objects carry it through to utimes on
  // platforms that support it). xattrs and ACLs are NOT preserved by this
  // copy — only content, POSIX mode bits, and now atime/mtime.
  await ops.utimes(path, st.atime, st.mtime)
  log(`  broke hardlink (nlink=${st.nlink}): ${path}`)
}

/**
 * Recursively lstat-walk and chown `entryPath` (and everything beneath it, if
 * it is a directory) to uid:gid. Never follows symlinks (lchown only), never
 * crosses filesystem boundaries, breaks shared-inode hardlinks before
 * chowning, and preserves existing content and mode bits — only OR-ing in the
 * minimum owner rwx (dirs) / rw (files) needed for the new owner to use the
 * tree.
 */
async function migrateEntry(entryPath, ctx) {
  ctx.checkDeadline(entryPath)

  const st = await ctx.ops.lstat(entryPath)

  if (st.dev !== ctx.rootDev) {
    const problem = `${entryPath} contains a mount from another filesystem; unmount it or move it out of the checkout`
    ctx.log(`  PROBLEM: ${problem}`)
    ctx.stats.skippedForeignFs++
    ctx.checkoutProblems.push(problem)
    ctx.problems.push(problem)
    return
  }

  if (st.isSymbolicLink()) {
    // Never follow. lchown only changes the symlink's own owner, never the
    // target's — the target (possibly outside the tree entirely) is
    // untouched by construction.
    await ctx.ops.lchown(entryPath, ctx.uid, ctx.gid)
    ctx.stats.symlinks++
    return
  }

  if (st.isDirectory()) {
    const names = await ctx.ops.readdir(entryPath)
    for (const name of names) {
      if (name.startsWith(STAGING_PREFIX)) {
        ctx.log(`  WARNING: leftover staging dir from the old clone path, not touched or removed: ${join(entryPath, name)}`)
        ctx.stats.skippedStaging++
        continue
      }
      await migrateEntry(join(entryPath, name), ctx)
    }
    const mode = st.mode & 0o777
    const wanted = mode | 0o700 // owner must be able to enter/list/write the dir
    if (wanted !== mode) await ctx.ops.chmod(entryPath, wanted)
    await ctx.ops.lchown(entryPath, ctx.uid, ctx.gid)
    ctx.stats.dirs++
    return
  }

  if (st.isFile()) {
    let fileSt = st
    if (fileSt.nlink > 1) {
      await breakHardlink(ctx.ops, entryPath, fileSt, ctx.log)
      fileSt = await ctx.ops.lstat(entryPath)
      ctx.stats.hardlinksBroken++
    }
    const mode = fileSt.mode & 0o777
    const wanted = mode | 0o600 // owner must be able to read/write; preserves any existing exec bit
    if (wanted !== mode) await ctx.ops.chmod(entryPath, wanted)
    await ctx.ops.lchown(entryPath, ctx.uid, ctx.gid)
    ctx.stats.files++
    return
  }

  // Other node types (fifo, socket, device, ...): ownership only, no content
  // or mode semantics apply.
  await ctx.ops.lchown(entryPath, ctx.uid, ctx.gid)
  ctx.stats.other++
}

/**
 * Migrate every root-owned checkout under `reposRoot` to `targetUid:targetGid`.
 *
 * @param {object} options
 * @param {string} options.reposRoot - e.g. /workspace/repos
 * @param {string} [options.stateDir] - defaults to `${reposRoot}/.workspace-agent`
 * @param {number} [options.targetUid]
 * @param {number} [options.targetGid]
 * @param {number} [options.deadlineMs]
 * @param {number} [options.expectedRootOwnerUid] - uid the repos volume root and
 *   state dir must be owned by (defaults to 0/root; tests override this since
 *   a non-root test process can only create dirs it itself owns)
 * @param {object} [options.ops] - injectable fs operations (see defaultOps())
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{ok: true, timedOut: boolean, completed: string[], skippedAlreadyDone: string[], stats: object}>}
 */
export async function migrateRepoOwnership(options) {
  const {
    reposRoot,
    stateDir = join(reposRoot, STATE_DIR_NAME),
    targetUid = 10001,
    targetGid = 10001,
    deadlineMs = DEFAULT_DEADLINE_MS,
    expectedRootOwnerUid = 0,
    ops = defaultOps(),
    log = () => {},
  } = options

  const startedAt = Date.now()
  const deadlineAt = startedAt + deadlineMs

  const rootSt = await assertRealOwnedDir(ops, reposRoot, expectedRootOwnerUid, 'repos volume root')
  const rootDev = rootSt.dev

  // The state directory must already exist and be validated (the entrypoint
  // creates/validates it via ensure-protected-dir.mjs before this script
  // runs) — but re-validate here too so this script is safe to invoke
  // standalone (tests, manual recovery).
  if (await pathExists(ops, stateDir)) {
    await assertRealOwnedDir(ops, stateDir, expectedRootOwnerUid, 'workspace-agent state dir')
  } else {
    await ops.mkdir(stateDir, {mode: 0o700, recursive: true})
    await ops.chown(stateDir, expectedRootOwnerUid, expectedRootOwnerUid)
    await ops.chmod(stateDir, 0o700)
  }
  const completedDir = join(stateDir, 'completed')
  await ops.mkdir(completedDir, {mode: 0o700, recursive: true})

  const stats = {dirs: 0, files: 0, symlinks: 0, other: 0, hardlinksBroken: 0, skippedStaging: 0, skippedForeignFs: 0}
  const completed = []
  const skippedAlreadyDone = []
  // Every offending path found this run, across owner-level and
  // checkout-entry-level problems. Non-empty at the end fails the whole run
  // (non-zero exit) — but every checkout that migrated cleanly still keeps
  // its marker, so a fixed-and-restarted run only redoes the broken ones.
  const problems = []

  const ctx = {
    ops,
    uid: targetUid,
    gid: targetGid,
    rootDev,
    stats,
    log,
    problems,
    checkoutProblems: [],
    checkDeadline(where) {
      if (Date.now() > deadlineAt) {
        throw createMigrationTimeoutError(`migration deadline (${deadlineMs}ms) exceeded at: ${where}`)
      }
    },
  }

  let timedOut = false
  let ownerNames
  try {
    ownerNames = await ops.readdir(reposRoot)
  } catch (error) {
    throw new Error(`cannot list repos volume root ${reposRoot}: ${error.message}`)
  }

  outer: for (const owner of ownerNames) {
    if (owner === STATE_DIR_NAME || owner.startsWith(STAGING_PREFIX)) continue

    const ownerPath = join(reposRoot, owner)
    let ownerSt
    try {
      ownerSt = await ops.lstat(ownerPath)
    } catch (error) {
      const problem = `${ownerPath} cannot be stat'd (${error.message}); fix filesystem access to this path and restart`
      log(`  PROBLEM: ${problem}`)
      problems.push(problem)
      continue
    }
    // Owner directories stay root-owned, 0755 — never chowned, never descended
    // into if they are not real, same-owner, same-filesystem directories. Any
    // violation here means the checkouts under it are never migrated, so it
    // must fail the run loudly rather than silently skip.
    if (ownerSt.isSymbolicLink()) {
      const problem = `${ownerPath} is a symlink; replace it with a real directory`
      log(`  PROBLEM: ${problem}`)
      problems.push(problem)
      continue
    }
    if (!ownerSt.isDirectory()) {
      const problem = `${ownerPath} is not a directory; remove it or replace it with a real directory`
      log(`  PROBLEM: ${problem}`)
      problems.push(problem)
      continue
    }
    if (ownerSt.dev !== rootDev) {
      const problem = `${ownerPath} is mounted from a different filesystem than ${reposRoot}; unmount it or move it out of ${reposRoot}`
      log(`  PROBLEM: ${problem}`)
      problems.push(problem)
      continue
    }
    if (ownerSt.uid !== expectedRootOwnerUid) {
      const problem = `${ownerPath} is owned by uid ${ownerSt.uid}, expected ${expectedRootOwnerUid}; chown it to the expected owner`
      log(`  PROBLEM: ${problem}`)
      problems.push(problem)
      continue
    }

    let repoNames
    try {
      repoNames = await ops.readdir(ownerPath)
    } catch (error) {
      const problem = `${ownerPath} cannot be listed (${error.message}); fix filesystem access to this directory and restart`
      log(`  PROBLEM: ${problem}`)
      problems.push(problem)
      continue
    }

    for (const repo of repoNames) {
      if (repo.startsWith(STAGING_PREFIX)) {
        log(`  WARNING: leftover staging dir from the old clone path, not touched or removed: ${join(ownerPath, repo)}`)
        stats.skippedStaging++
        continue
      }
      const checkoutKey = `${owner}/${repo}`
      const marker = markerPath(stateDir, owner, repo)
      if (await pathExists(ops, marker)) {
        skippedAlreadyDone.push(checkoutKey)
        continue
      }

      const checkoutPath = join(ownerPath, repo)
      ctx.checkoutProblems = []
      try {
        await migrateEntry(checkoutPath, ctx)
      } catch (error) {
        if (isMigrationTimeoutError(error)) {
          timedOut = true
          log(`TIMEOUT: ${error.message} (checkout in progress: ${checkoutKey}, no marker written)`)
          break outer
        }
        throw error
      }

      if (ctx.checkoutProblems.length > 0) {
        // A skip happened somewhere inside this checkout (e.g. a nested
        // foreign-filesystem mount) — the tree was NOT fully migrated, so
        // writing a completion marker would make that partial state
        // permanent. Leave it unmarked; a future run retries it once the
        // reported problem is fixed.
        log(`  no marker written for ${checkoutKey}: ${ctx.checkoutProblems.length} problem(s) found inside this checkout`)
        continue
      }

      // Only reached on full, uninterrupted, problem-free success for this
      // checkout.
      const tmpMarker = `${marker}.tmp-${process.pid}`
      await ops.writeFile(
        tmpMarker,
        JSON.stringify({owner, repo, completedAt: new Date().toISOString()}, null, 2),
        {mode: 0o600},
      )
      await ops.rename(tmpMarker, marker)
      completed.push(checkoutKey)
      log(`migrate: ${checkoutKey}: complete`)
    }
  }

  if (problems.length > 0 && !timedOut) {
    const message = [
      `migration found ${problems.length} problem(s) that must be fixed before boot can continue:`,
      ...problems.map(p => `  - ${p}`),
    ].join('\n')
    throw new Error(message)
  }

  return {
    ok: true,
    timedOut,
    completed,
    skippedAlreadyDone,
    stats,
    durationMs: Date.now() - startedAt,
  }
}

// CLI main guard:
//   node migrate-repo-ownership.mjs [--repos-root PATH] [--state-dir PATH]
//     [--uid N] [--gid N] [--deadline-ms N]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const opts = {
    reposRoot: '/workspace/repos',
    targetUid: 10001,
    targetGid: 10001,
    deadlineMs: DEFAULT_DEADLINE_MS,
  }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    const value = args[i + 1]
    if (flag === '--repos-root') {
      opts.reposRoot = value
      i++
    } else if (flag === '--state-dir') {
      opts.stateDir = value
      i++
    } else if (flag === '--uid') {
      opts.targetUid = Number.parseInt(value, 10)
      i++
    } else if (flag === '--gid') {
      opts.targetGid = Number.parseInt(value, 10)
      i++
    } else if (flag === '--deadline-ms') {
      opts.deadlineMs = Number.parseInt(value, 10)
      i++
    }
  }
  opts.log = msg => process.stderr.write(`${msg}\n`)

  try {
    const result = await migrateRepoOwnership(opts)
    process.stderr.write(
      `migrate-repo-ownership: completed=${result.completed.length} ` +
        `already-done=${result.skippedAlreadyDone.length} ` +
        `dirs=${result.stats.dirs} files=${result.stats.files} ` +
        `hardlinks-broken=${result.stats.hardlinksBroken} durationMs=${result.durationMs}\n`,
    )
    if (result.timedOut) {
      process.stderr.write('migrate-repo-ownership: deadline exceeded — refusing to mark incomplete work done\n')
      process.exit(1)
    }
    process.exit(0)
  } catch (error) {
    process.stderr.write(`migrate-repo-ownership: fatal: ${error.message}\n`)
    process.exit(1)
  }
}
