/**
 * (Review round E, E5) Bounded, agent-uid filesystem size/entry-count walk of an agent-owned
 * checkout tree. Spawned via the SAME execFile-with-uid/gid pattern git-safety.ts's `runGit` uses
 * — but running node, never git, so this stays available even for a hostile-config checkout
 * admission refuses to run ANY git command in. Running the walk AS the agent identity, rather than
 * as root, means a symlink race the agent stages inside its own checkout can at most redirect the
 * walk somewhere the agent already has read access to — never somewhere only root could read —
 * closing the actual privilege-escalation concern a root-run walk would carry, without needing
 * fd-relative traversal Node's `fs` module doesn't cleanly expose. Confirmed-termination semantics
 * mirror `runGit`'s own: SIGKILL, then a reap-grace race between a confirmed exit and
 * `termination-unconfirmed`.
 */

import {execFile} from 'node:child_process'
import process from 'node:process'

/** Self-contained (no imports beyond the two required at the top) — spawned via `node -e`, receiving argv AFTER `--`: rootPath, maxEntries, deadlineMs. Never follows a symlink; never crosses a filesystem boundary; bounded by both a wall-clock deadline and an entry-count cap. */
const WALK_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const [rootPath, maxEntriesStr, deadlineMsStr] = process.argv.slice(1);
const maxEntries = Number(maxEntriesStr);
const deadlineAt = Date.now() + Number(deadlineMsStr);
let entries = 0, totalBytes = 0, capped = false, rootDev;
function walk(p) {
  if (capped) return;
  if (Date.now() > deadlineAt || entries >= maxEntries) { capped = true; return; }
  entries += 1;
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (rootDev === undefined) rootDev = st.dev;
  else if (st.dev !== rootDev) return;
  if (st.isSymbolicLink()) { totalBytes += st.size; return; }
  if (st.isDirectory()) {
    let names;
    try { names = fs.readdirSync(p); } catch { return; }
    for (const name of names) { if (capped) return; walk(path.join(p, name)); }
    return;
  }
  if (st.isFile()) totalBytes += st.size;
}
walk(rootPath);
process.stdout.write(JSON.stringify({totalBytes, entryCount: entries, complete: !capped}));
`

const WALK_KILL_REAP_GRACE_MS = 2_000

export interface AgentWalkOptions {
  readonly rootPath: string
  readonly maxEntries: number
  readonly deadlineMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
  readonly timeoutMs: number
}

export type AgentWalkOutcome =
  | {readonly kind: 'ok'; readonly totalBytes: number; readonly entryCount: number; readonly complete: boolean}
  | {readonly kind: 'failed'}
  | {readonly kind: 'termination-unconfirmed'}

export type AgentWalkRunner = (options: AgentWalkOptions) => Promise<AgentWalkOutcome>

/** Strictly parses the walk subprocess's stdout. Anything malformed — not JSON, not an object, a wrong-typed or out-of-range field — is `failed`, never a best-effort partial result. */
function parseWalkOutput(stdout: string): AgentWalkOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return {kind: 'failed'}
  }
  if (typeof parsed !== 'object' || parsed === null) return {kind: 'failed'}
  const v = parsed as Record<string, unknown>
  if (typeof v.totalBytes !== 'number' || !Number.isFinite(v.totalBytes) || v.totalBytes < 0) return {kind: 'failed'}
  if (typeof v.entryCount !== 'number' || !Number.isInteger(v.entryCount) || v.entryCount < 0) return {kind: 'failed'}
  if (typeof v.complete !== 'boolean') return {kind: 'failed'}
  return {kind: 'ok', totalBytes: v.totalBytes, entryCount: v.entryCount, complete: v.complete}
}

/**
 * Runs the bounded walk as `options.uid`/`options.gid`, confirmed-termination semantics matching
 * `runGit`: on `options.timeoutMs` elapsing, SIGKILL is sent; if the child's stdio hasn't closed
 * (the exec callback fired) within `WALK_KILL_REAP_GRACE_MS`, the outcome is
 * `termination-unconfirmed` — NEVER `failed` — since a leaked process may still be running.
 */
export const runAgentWalk: AgentWalkRunner = async options =>
  new Promise(resolve => {
    let settled = false
    let terminating = false
    let graceHandle: ReturnType<typeof setTimeout> | undefined
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const args = ['-e', WALK_SCRIPT, '--', options.rootPath, String(options.maxEntries), String(options.deadlineMs)]
    let child: ReturnType<typeof execFile>
    try {
      child = execFile(
        process.execPath,
        args,
        {uid: options.uid, gid: options.gid, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024},
        (error, stdout) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutHandle)
          clearTimeout(graceHandle)
          if (error !== null) {
            resolve({kind: 'failed'})
            return
          }
          resolve(parseWalkOutput(stdout))
        },
      )
    } catch {
      resolve({kind: 'failed'})
      return
    }
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      clearTimeout(graceHandle)
      resolve({kind: 'failed'})
    })

    const terminate = (): void => {
      if (terminating) return
      if (child.pid === undefined) return
      terminating = true
      clearTimeout(timeoutHandle)
      child.kill('SIGKILL')
      graceHandle = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({kind: 'termination-unconfirmed'})
      }, WALK_KILL_REAP_GRACE_MS)
    }

    timeoutHandle = setTimeout(terminate, options.timeoutMs)
  })
