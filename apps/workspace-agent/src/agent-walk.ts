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

import {Buffer} from 'node:buffer'
import {spawn} from 'node:child_process'
import process from 'node:process'

import {AGENT_HOME, AGENT_TMPDIR} from './identity.js'

/** Self-contained (no imports beyond the two required at the top) — spawned via `node -e`, receiving argv AFTER `--`: rootPath, maxEntries, deadlineMs. Never follows a symlink; never crosses a filesystem boundary; bounded by both a wall-clock deadline and an entry-count cap. */
const WALK_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const [rootPath, maxEntriesStr, deadlineMsStr] = process.argv.slice(1);
const maxEntries = Number(maxEntriesStr);
const deadlineAt = Date.now() + Number(deadlineMsStr);
let entries = 0, totalBytes = 0, capped = false, hadError = false, rootDev;
function walk(p, isRoot) {
  if (capped) return;
  if (Date.now() > deadlineAt || entries >= maxEntries) { capped = true; return; }
  entries += 1;
  let st;
  try { st = fs.lstatSync(p); } catch (e) {
    if (isRoot) { process.exitCode = 1; process.exit(1); }
    hadError = true;
    return;
  }
  if (rootDev === undefined) rootDev = st.dev;
  else if (st.dev !== rootDev) return;
  if (st.isSymbolicLink()) { totalBytes += st.size; return; }
  if (st.isDirectory()) {
    let names;
    try { names = fs.readdirSync(p); } catch (e) { hadError = true; return; }
    for (const name of names) { if (capped) return; walk(path.join(p, name), false); }
    return;
  }
  if (st.isFile()) totalBytes += st.size;
}
walk(rootPath, true);
process.stdout.write(JSON.stringify({totalBytes, entryCount: entries, complete: !capped && !hadError}));
`

const WALK_KILL_REAP_GRACE_MS = 2_000

/** (Review round G, G1) Explicit byte cap per stream, enforced by this module — replaces `execFile`'s `maxBuffer`, which `spawn` has no equivalent of. Exceeding it fails the walk, never silently truncates. */
const MAX_WALK_OUTPUT_BYTES = 8 * 1024 * 1024

/** Fixed, service-controlled PATH — never the parent's, mirrors git-safety.ts's own network-profile PATH. */
const WALK_PATH = '/usr/bin:/bin'

/** Safe, ambient-content-free working directory for the walk subprocess. */
const WALK_CWD = '/'

/**
 * (Review round F, F1) Built from scratch — NEVER `{...process.env}` — so the agent-uid child can
 * never inherit `WORKSPACE_OPENCODE_TOKEN`, `GITHUB_TOKEN`, any secret-file path, `NODE_OPTIONS`,
 * `NODE_PATH`, `LD_*`, or any other ambient variable the root service happens to be carrying.
 * Mirrors opencode-server.ts's `buildOpencodeEnv` allowlist-construction STYLE (an explicit object
 * literal, not a filter over the parent env) without importing anything OpenCode-specific.
 */
function buildWalkEnv(): NodeJS.ProcessEnv {
  return {PATH: WALK_PATH, HOME: AGENT_HOME, TMPDIR: AGENT_TMPDIR, LANG: 'C'}
}

/**
 * Hardening flags applied to the walk subprocess. `--no-experimental-fetch` is deliberately
 * OMITTED: fetch has been a stable (non-experimental) global since Node 21, so `--no-experimental-
 * fetch` is an invalid negation on Node 24+ and would make the CHILD FAIL TO START at all —
 * verified empirically (`node --no-experimental-fetch -e ...` → "invalid negation"). The walk
 * never uses fetch anyway, so there is nothing this flag would have protected here.
 */
const WALK_NODE_FLAGS: readonly string[] = ['--disallow-code-generation-from-strings', '--no-addons']

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

type SpawnScriptOutcome =
  | {readonly kind: 'ok'; readonly stdout: string}
  | {readonly kind: 'failed'}
  | {readonly kind: 'termination-unconfirmed'}

/**
 * Spawns `process.execPath` with `WALK_NODE_FLAGS`, `-e`, `script`, `--`, `...scriptArgs`, as
 * `options.uid`/`options.gid`, `cwd: WALK_CWD`, `env: buildWalkEnv()` -- the F1-hardened spawn
 * shape shared by the real walk AND `runWalkScriptForTesting` (F1's own test seam), so a test
 * exercises the EXACT production spawn, not a hand-copied approximation of it. Confirmed-
 * termination semantics match `runGit`: SIGKILL on `options.timeoutMs`, then a reap-grace race
 * between a confirmed exit and `termination-unconfirmed` -- never `failed` -- since a leaked
 * process may still be running.
 */
async function spawnWalkProcess(
  script: string,
  scriptArgs: readonly string[],
  options: {readonly uid: number | undefined; readonly gid: number | undefined; readonly timeoutMs: number},
  /** (F4) When set, inherited by the child as fd 3 — `measureSealedTree`'s scoped-access mechanism. Opened and closed by the CALLER; never held open by this function. */
  extraFd?: number,
): Promise<SpawnScriptOutcome> {
  return new Promise(resolve => {
    let settled = false
    let terminating = false
    let overflowed = false
    let graceHandle: ReturnType<typeof setTimeout> | undefined
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0

    const args = [...WALK_NODE_FLAGS, '-e', script, '--', ...scriptArgs]
    // (G1) `spawn`, not `execFile`: `execFile`'s internal `spawn` call does not forward a custom
    // `stdio` array (verified against Node 24's `lib/child_process.js` — an extra inherited fd
    // never reaches the child through `execFile`), so `measureSealedTree`'s fd-3 handoff silently
    // did nothing. `spawn` honors `stdio` directly.
    const stdio: ('ignore' | 'pipe' | number)[] =
      extraFd === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', extraFd]
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(process.execPath, args, {
        uid: options.uid,
        gid: options.gid,
        cwd: WALK_CWD,
        env: buildWalkEnv(),
        stdio,
      })
    } catch {
      resolve({kind: 'failed'})
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      // (G1) Explicit byte cap replacing `execFile`'s `maxBuffer` — exceeding it FAILS the walk
      // (never a silently truncated partial result masquerading as complete JSON).
      if (stdoutBytes > MAX_WALK_OUTPUT_BYTES) {
        overflowed = true
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr?.on('data', () => {}) // drained, never buffered — the walk never needs stderr content
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      clearTimeout(graceHandle)
      resolve({kind: 'failed'})
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      clearTimeout(graceHandle)
      if (overflowed || code !== 0) {
        resolve({kind: 'failed'})
        return
      }
      resolve({kind: 'ok', stdout: Buffer.concat(stdoutChunks).toString('utf8')})
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
}

/** Runs the bounded walk as `options.uid`/`options.gid` — see `spawnWalkProcess`'s doc comment for the spawn/termination contract. */
export const runAgentWalk: AgentWalkRunner = async options => {
  const scriptArgs = [options.rootPath, String(options.maxEntries), String(options.deadlineMs)]
  const outcome = await spawnWalkProcess(WALK_SCRIPT, scriptArgs, options)
  if (outcome.kind !== 'ok') return outcome
  return parseWalkOutput(outcome.stdout)
}

/**
 * (Review round F, F1) TEST-ONLY seam: runs an ARBITRARY diagnostic script through the exact same
 * hardened spawn path (flags, env, cwd, uid/gid, confirmed-termination) `runAgentWalk` uses, so a
 * test can verify what the REAL production spawn actually exposes to the child -- e.g. a script
 * that prints `process.env`/`process.cwd()` -- rather than asserting against a hand-built copy of
 * the env-construction logic. Never used by production code.
 */
export async function runWalkScriptForTesting(
  script: string,
  options: {readonly uid: number | undefined; readonly gid: number | undefined; readonly timeoutMs: number},
  /** (Review round G, G4) Optional inherited fd 3, for tests that need to assert what the child sees at that descriptor (e.g. comparing `fstat(3)` to the intended target, or checking for descriptor leaks). */
  extraFd?: number,
): Promise<SpawnScriptOutcome> {
  return spawnWalkProcess(script, [], options, extraFd)
}

/**
 * (Review round F, F4) Self-contained walk script for the SEALED-TREE (fd-scoped) mode: identical
 * bounded-walk logic to `WALK_SCRIPT`, but the root to walk is always `/proc/self/fd/3` \u2014 the
 * inherited directory descriptor \u2014 never a caller-supplied pathname. This is what makes the
 * mechanism safe: the agent-uid child never receives (and could never construct) a PATH through
 * the root-owned, mode-0700 quarantine envelope ancestors; it only receives an ALREADY-OPEN
 * descriptor to the one directory root chose to hand it, opened by root before the child ever
 * starts. Linux-only (procfs `/proc/self/fd`); `measureSealedTree` checks availability first.
 */
const WALK_SCRIPT_FD = `
const fs = require('node:fs');
const path = require('node:path');
const [maxEntriesStr, deadlineMsStr] = process.argv.slice(1);
const maxEntries = Number(maxEntriesStr);
const deadlineAt = Date.now() + Number(deadlineMsStr);
let entries = 0, totalBytes = 0, capped = false, hadError = false;
// (Review round G, G2) fstat the INHERITED FD DIRECTLY — never lstat the /proc/self/fd/3 PATH
// itself, which reports the SYMLINK's own tiny size and never recurses into the directory it
// points to (the exact bug this replaces: a prior version lstat'd the path and reported
// complete:true having walked nothing).
let rootSt;
try { rootSt = fs.fstatSync(3); } catch (e) { process.exitCode = 1; process.exit(1); }
if (!rootSt.isDirectory()) { process.exitCode = 1; process.exit(1); }
const rootDev = rootSt.dev;
function walk(p) {
  if (capped) return;
  if (Date.now() > deadlineAt || entries >= maxEntries) { capped = true; return; }
  entries += 1;
  let st;
  try { st = fs.lstatSync(p); } catch (e) { hadError = true; return; }
  if (st.dev !== rootDev) return;
  if (st.isSymbolicLink()) { totalBytes += st.size; return; }
  if (st.isDirectory()) {
    let names;
    try { names = fs.readdirSync(p); } catch (e) { hadError = true; return; }
    for (const name of names) { if (capped) return; walk(path.join(p, name)); }
    return;
  }
  if (st.isFile()) totalBytes += st.size;
}
// The root counts as one entry via the FSTAT result already obtained above (never re-derived by
// lstat-ing the symlink). Its children are reached by deliberately dereferencing the TRUSTED
// procfs anchor EXACTLY ONCE via readdirSync — safe because fd 3 is bound to a specific inode by
// the kernel, immune to any rename/symlink-swap race an attacker could stage; every entry BELOW
// that point is still reached via ordinary no-follow lstat, exactly like the pathname-mode walker.
entries += 1;
if (!(Date.now() > deadlineAt || entries > maxEntries)) {
  let names;
  try { names = fs.readdirSync('/proc/self/fd/3'); } catch (e) { hadError = true; names = []; }
  for (const name of names) { if (capped) break; walk('/proc/self/fd/3/' + name); }
}
process.stdout.write(JSON.stringify({totalBytes, entryCount: entries, complete: !capped && !hadError}));
`

/**
 * (Review round F, F4) Measures an agent-UNTRAVERSABLE tree (a quarantine envelope's `checkout/`,
 * whose ancestors are root-owned mode 0700) by having ROOT open the directory itself and hand the
 * agent-uid child an ALREADY-OPEN descriptor to it \u2014 never by loosening the envelope's
 * permissions, and never by walking it in-process as root (which would reintroduce the exact
 * symlink-race concern `runAgentWalk` exists to close). The child accesses the descriptor via
 * `/proc/self/fd/3` (Linux procfs) since Node has no public fd-relative `readdir`/`lstat` API; on a
 * platform without `/proc/self/fd` (macOS dev machines), this returns `{kind:'unavailable'}` and
 * the caller's measurement stays explicitly unknown \u2014 failing closed, never assuming zero bytes.
 * REJECTED alternative: chmod'ing the envelope open \u2014 the review explicitly ruled this out (it
 * would let the agent traverse OTHER generations' envelopes too, not just measure this one).
 */
export interface SealedWalkOptions {
  readonly dirPath: string
  readonly maxEntries: number
  readonly deadlineMs: number
  readonly uid: number | undefined
  readonly gid: number | undefined
  readonly timeoutMs: number
}

export type SealedWalkOutcome = AgentWalkOutcome | {readonly kind: 'unavailable'}

export type SealedWalkRunner = (options: SealedWalkOptions) => Promise<SealedWalkOutcome>

export const measureSealedTree: SealedWalkRunner = async options => {
  if (process.platform !== 'linux') return {kind: 'unavailable'}
  const {open} = await import('node:fs/promises')
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(options.dirPath, 'r')
  } catch {
    return {kind: 'failed'}
  }
  try {
    const scriptArgs = [String(options.maxEntries), String(options.deadlineMs)]
    const outcome = await spawnWalkProcess(WALK_SCRIPT_FD, scriptArgs, options, handle.fd)
    if (outcome.kind !== 'ok') return outcome
    return parseWalkOutput(outcome.stdout)
  } finally {
    await handle.close()
  }
}
