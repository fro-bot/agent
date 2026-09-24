/**
 * Ownership handoff — walks a freshly staged clone tree and hands it to the unprivileged agent
 * identity (AGENT_UID/AGENT_GID) via filesystem calls only, never git. Runs once per clone,
 * as the root-owned workspace-agent SERVICE, against a staging directory the service alone
 * controls at this point — see clone.ts for where this sits in the clone sequence (after HEAD
 * is resolved and validated, before the publishing rename).
 *
 * SECURITY INVARIANTS (non-negotiable):
 * 1. `lstat`, never `stat` — a symlink is never followed while walking, and is itself the only
 *    thing `lchown`'d; its target (which may point outside the tree entirely) is never touched.
 * 2. Never crosses a filesystem boundary: every entry's `st_dev` is compared against the root's.
 *    A fresh HTTPS clone under staging has no legitimate reason to contain a mount point — if
 *    one is found, the handoff fails closed rather than silently skip a directory that would
 *    then be reported as agent-owned when it is not.
 * 3. A regular file with `nlink > 1` (a hardlink) has no legitimate way to appear in a fresh
 *    HTTPS clone — `chown`/`lchown` follows the inode, not the directory entry, so chowning it
 *    in place could silently reassign ownership of whatever else shares that inode outside the
 *    tree. Rather than guess (e.g. copy-and-replace, as the one-time legacy migration script
 *    does for a case that genuinely can arise there), the handoff fails the clone outright.
 * 4. Bounded by both a wall-clock deadline and an entry-count cap, both checked before every
 *    entry is processed — a pathological tree can never hold the per-repo lock (and the global
 *    clone semaphore slot) open indefinitely.
 * 5. Any node type other than a directory, regular file, or symlink (fifo, socket, device) has
 *    no legitimate reason to appear in a git checkout either — fails closed for the same reason
 *    as invariant 3.
 *
 * Ownership: only entries UNDER `rootPath` are ever touched. The staging parent, the repos root,
 * and the owner directory are never touched here — they are root-owned `0755`/`0700` by
 * construction (see clone.ts and identity.ts) and stay that way.
 */

import type {Stats} from 'node:fs'

import {
  chmod as chmodFsPromises,
  lchown as lchownFsPromises,
  lstat as lstatFsPromises,
  readdir as readdirFsPromises,
} from 'node:fs/promises'
import {join} from 'node:path'

/** Injectable filesystem operations — real node:fs/promises by default. */
export interface HandoffOps {
  readonly lstat: (path: string) => Promise<Stats>
  readonly readdir: (path: string) => Promise<string[]>
  readonly lchown: (path: string, uid: number, gid: number) => Promise<void>
  readonly chmod: (path: string, mode: number) => Promise<void>
}

export function defaultHandoffOps(): HandoffOps {
  return {
    lstat: lstatFsPromises,
    readdir: readdirFsPromises,
    lchown: lchownFsPromises,
    chmod: chmodFsPromises,
  }
}

export interface HandoffOptions {
  /** Target uid — always AGENT_UID (identity.ts) in production. */
  readonly uid: number
  /** Target gid — always AGENT_GID (identity.ts) in production. */
  readonly gid: number
  /** Wall-clock deadline for the entire walk, in milliseconds. */
  readonly deadlineMs: number
  /** Maximum number of filesystem entries the walk will process before failing closed. */
  readonly maxEntries: number
  /** Injected filesystem operations. Defaults to real node:fs/promises. */
  readonly ops?: HandoffOps
  /** Injected clock for testability. Defaults to Date.now. */
  readonly now?: () => number
}

export type HandoffFailureReason =
  'hardlink' | 'foreign-filesystem' | 'unsupported-entry' | 'deadline-exceeded' | 'max-entries'

export type HandoffResult =
  | {readonly ok: true; readonly entries: number}
  | {readonly ok: false; readonly reason: HandoffFailureReason; readonly path: string}

interface WalkContext {
  readonly ops: HandoffOps
  readonly uid: number
  readonly gid: number
  readonly rootDev: number
  readonly deadlineAt: number
  readonly maxEntries: number
  readonly now: () => number
  entries: number
}

/** Owner rwx (dirs) / rw (files) OR'd onto the existing mode — never removes an existing bit. */
const OWNER_RWX = 0o700
const OWNER_RW = 0o600

async function chmodIfNeeded(
  ops: HandoffOps,
  path: string,
  currentMode: number,
  wantedOwnerBits: number,
): Promise<void> {
  const mode = currentMode & 0o777
  const wanted = mode | wantedOwnerBits
  if (wanted !== mode) await ops.chmod(path, wanted)
}

async function walk(entryPath: string, ctx: WalkContext): Promise<HandoffResult | null> {
  if (ctx.now() > ctx.deadlineAt) return {ok: false, reason: 'deadline-exceeded', path: entryPath}
  ctx.entries += 1
  if (ctx.entries > ctx.maxEntries) return {ok: false, reason: 'max-entries', path: entryPath}

  const st = await ctx.ops.lstat(entryPath)

  if (st.dev !== ctx.rootDev) {
    return {ok: false, reason: 'foreign-filesystem', path: entryPath}
  }

  if (st.isSymbolicLink()) {
    // Never followed while walking (lstat above), and lchown changes only the symlink's own
    // owner — the target (possibly outside the tree entirely) is never touched by construction.
    await ctx.ops.lchown(entryPath, ctx.uid, ctx.gid)
    return null
  }

  if (st.isDirectory()) {
    const names = await ctx.ops.readdir(entryPath)
    for (const name of names) {
      const result = await walk(join(entryPath, name), ctx)
      if (result !== null) return result
    }
    // Owner must be able to enter/list/write the directory. OR-ing onto the existing mode
    // only ever adds bits, so an already-narrower mode never gets loosened beyond owner-rwx,
    // and any group/other bits git set are left exactly as they were.
    await chmodIfNeeded(ctx.ops, entryPath, st.mode, OWNER_RWX)
    await ctx.ops.lchown(entryPath, ctx.uid, ctx.gid)
    return null
  }

  if (st.isFile()) {
    if (st.nlink > 1) return {ok: false, reason: 'hardlink', path: entryPath}
    // Owner must be able to read/write; OR-ing preserves any existing executable bit instead
    // of clobbering it back to a fixed mode.
    await chmodIfNeeded(ctx.ops, entryPath, st.mode, OWNER_RW)
    await ctx.ops.lchown(entryPath, ctx.uid, ctx.gid)
    return null
  }

  // fifo, socket, device, etc. — no legitimate reason to appear in a git checkout.
  return {ok: false, reason: 'unsupported-entry', path: entryPath}
}

/**
 * Hands a freshly staged clone tree at `rootPath` to `options.uid`:`options.gid`. See the module
 * header for the full invariant list. Returns the total number of entries visited on success.
 */
export async function handOffToAgent(rootPath: string, options: HandoffOptions): Promise<HandoffResult> {
  const {uid, gid, deadlineMs, maxEntries, ops = defaultHandoffOps(), now = () => Date.now()} = options

  const rootSt = await ops.lstat(rootPath)
  const ctx: WalkContext = {
    ops,
    uid,
    gid,
    rootDev: rootSt.dev,
    deadlineAt: now() + deadlineMs,
    maxEntries,
    now,
    entries: 0,
  }

  const failure = await walk(rootPath, ctx)
  if (failure !== null) return failure
  return {ok: true, entries: ctx.entries}
}
