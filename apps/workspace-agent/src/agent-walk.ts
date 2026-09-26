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
): Promise<SpawnScriptOutcome> {
  return new Promise(resolve => {
    let settled = false
    let terminating = false
    let graceHandle: ReturnType<typeof setTimeout> | undefined
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const args = [...WALK_NODE_FLAGS, '-e', script, '--', ...scriptArgs]
    let child: ReturnType<typeof execFile>
    try {
      child = execFile(
        process.execPath,
        args,
        {
          uid: options.uid,
          gid: options.gid,
          cwd: WALK_CWD,
          env: buildWalkEnv(),
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutHandle)
          clearTimeout(graceHandle)
          if (error !== null) {
            resolve({kind: 'failed'})
            return
          }
          resolve({kind: 'ok', stdout})
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
): Promise<SpawnScriptOutcome> {
  return spawnWalkProcess(script, [], options)
}
