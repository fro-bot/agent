/**
 * Clone handler — executes `git clone` inside the workspace container.
 *
 * SECURITY INVARIANTS (non-negotiable):
 * 1. Token is NEVER passed via argv, URL, or shell string.
 * 2. Token is injected via GIT_ASKPASS helper script (mkdtemp dir, O_EXCL file, chmod 0600, deleted in finally).
 * 3. Token is passed to the askpass script via GITHUB_TOKEN env var — NOT embedded in the script body.
 * 4. GIT_TRACE=0, GIT_CURL_VERBOSE=0, GIT_TRACE_PACKET=0, GIT_TRACE_PERFORMANCE=0 in subprocess env.
 * 5. execFile only — no exec(), no shell interpolation.
 * 6. Clone URL is always https://github.com/{owner}/{repo}.git — never caller-provided.
 * 7. -c credential.helper= disables any operator-side credential helper.
 * 8. Stderr is scrubbed of x-access-token patterns before logging or returning.
 * 9. Token is never logged, never in error responses, never persisted.
 * 10. Clone is atomic: written to a temp dir, renamed to dest on success; partial clones never reach destPath.
 */

import type {CloneFailure, CloneRequest, CloneSuccess} from './types.js'
import {execFile as execFileCb} from 'node:child_process'
import {rmSync} from 'node:fs'
import {mkdir, mkdtemp, open, realpath, rename, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import {promisify} from 'node:util'

const execFile = promisify(execFileCb)

/** Root directory where repos are cloned inside the workspace container. */
export const WORKSPACE_REPOS_ROOT = '/workspace/repos'

/** Default clone timeout in milliseconds. */
export const DEFAULT_CLONE_TIMEOUT_MS = 60_000

/** Maximum concurrent clones. */
export const MAX_CONCURRENT_CLONES = 5

/** Maximum queued clone requests before rejecting with 503. */
export const MAX_CLONE_QUEUE_DEPTH = 50

/** Regex to scrub x-access-token credentials from git stderr/stdout. */
const TOKEN_URL_RE = /x-access-token:[^@]+@/g

/**
 * Scrub any credential patterns from a string before logging or returning it.
 * Replaces `x-access-token:<token>@` with `x-access-token:[REDACTED]@`.
 */
export function scrubCredentials(s: string): string {
  return s.replaceAll(TOKEN_URL_RE, 'x-access-token:[REDACTED]@')
}

/** Simplified execFile signature used for dependency injection and testing. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: {env: Record<string, string>; signal?: AbortSignal},
) => Promise<{stdout: string; stderr: string}>

export interface CloneOptions {
  /** Clone timeout in milliseconds. Default: DEFAULT_CLONE_TIMEOUT_MS. */
  readonly timeoutMs?: number
  /** Maximum concurrent clones. Default: MAX_CONCURRENT_CLONES. */
  readonly maxConcurrent?: number
  /** Maximum queued requests. Default: MAX_CLONE_QUEUE_DEPTH. */
  readonly maxQueueDepth?: number
}

export interface CloneHandlerDeps {
  /** Injected execFile for testability. Defaults to promisified node:child_process execFile. */
  readonly execFileFn?: ExecFileFn
  /** Workspace repos root. Defaults to WORKSPACE_REPOS_ROOT. */
  readonly reposRoot?: string
  /** Clone options. */
  readonly options?: CloneOptions
  /** Injected mkdtemp for testability. */
  readonly mkdtempFn?: (prefix: string) => Promise<string>
}

export interface CloneHandlerResult {
  readonly response: CloneSuccess | CloneFailure
  readonly statusCode: 200 | 400 | 409 | 500 | 503 | 504
}

// ---------------------------------------------------------------------------
// Global askpass dir tracking for signal-handler cleanup
// ---------------------------------------------------------------------------

/** All in-flight askpass dirs. Drained on SIGTERM/SIGINT/exit. */
const activeAskpassDirs = new Set<string>()

async function cleanupAskpassDir(dir: string): Promise<void> {
  activeAskpassDirs.delete(dir)
  await rm(dir, {recursive: true, force: true})
}

function syncCleanupAskpassDirs(): void {
  // Synchronous best-effort cleanup on process exit.
  // We can't await here, but we can at least attempt removal.
  for (const dir of activeAskpassDirs) {
    try {
      rmSync(dir, {recursive: true, force: true})
    } catch {
      // Best-effort; ignore errors on exit.
    }
    activeAskpassDirs.delete(dir)
  }
}

export async function asyncCleanupAllAskpassDirs(): Promise<void> {
  const dirs = [...activeAskpassDirs]
  await Promise.allSettled(dirs.map(async dir => cleanupAskpassDir(dir)))
}

export {syncCleanupAskpassDirs}

// NOTE: No SIGTERM/SIGINT handlers here — main.ts owns signal handling.
// This exit handler is a synchronous best-effort safety net only.
process.on('exit', () => {
  syncCleanupAskpassDirs()
})

// ---------------------------------------------------------------------------
// Per-repo lock (serializes concurrent requests for the same owner/repo)
// ---------------------------------------------------------------------------

const repoLocks = new Map<string, Promise<void>>()

async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (repoLocks.has(key)) {
    await repoLocks.get(key)
  }
  let release!: () => void
  const lock = new Promise<void>(resolve => {
    release = resolve
  })
  repoLocks.set(key, lock)
  try {
    return await fn()
  } finally {
    repoLocks.delete(key)
    release()
  }
}

// ---------------------------------------------------------------------------
// Global concurrency semaphore
// ---------------------------------------------------------------------------

let activeClonesCount = 0
let queuedClonesCount = 0
const cloneQueue: (() => void)[] = []

/** Reset semaphore state — for testing only. */
export function resetCloneSemaphoreForTesting(): void {
  activeClonesCount = 0
  queuedClonesCount = 0
  cloneQueue.length = 0
}

async function withCloneSemaphore<T>(
  maxConcurrent: number,
  maxQueueDepth: number,
  fn: () => Promise<T>,
): Promise<T | CloneHandlerResult> {
  if (activeClonesCount >= maxConcurrent) {
    if (queuedClonesCount >= maxQueueDepth) {
      const result: CloneHandlerResult = {
        response: {ok: false, error: 'overloaded'},
        statusCode: 503,
      }
      return result
    }
    // Queue the request.
    queuedClonesCount++
    await new Promise<void>(resolve => {
      cloneQueue.push(resolve)
    })
    queuedClonesCount--
  }

  activeClonesCount++
  try {
    return await fn()
  } finally {
    activeClonesCount--
    const next = cloneQueue.shift()
    if (next !== undefined) next()
  }
}

// ---------------------------------------------------------------------------
// Core clone logic
// ---------------------------------------------------------------------------

/**
 * Core clone logic — pure-ish function for testability.
 *
 * Caller is responsible for validating owner/repo/token before calling this.
 * This function:
 * 1. Checks global concurrency semaphore (503 overloaded if exceeded).
 * 2. Acquires per-repo lock (serializes concurrent requests for same repo).
 * 3. Derives the destination path internally.
 * 4. Creates the repos root if missing.
 * 5. Checks for existing clone (returns 409 repo-exists).
 * 6. Clones into a temp dir (atomic: rename on success, rm on failure).
 * 7. Writes a GIT_ASKPASS helper script via mkdtemp + O_EXCL open.
 *    Token is passed via GITHUB_TOKEN env var — NOT embedded in script body.
 * 8. Invokes git clone via execFile with AbortController timeout.
 * 9. Reads HEAD SHA (failure → clone-failed, not ok:true with 'unknown').
 * 10. Verifies the cloned path is still within the repos root (symlink defense).
 * 11. Cleans up the askpass temp dir in finally.
 */
export async function executeClone(request: CloneRequest, deps: CloneHandlerDeps = {}): Promise<CloneHandlerResult> {
  const {
    execFileFn = execFile,
    reposRoot = WORKSPACE_REPOS_ROOT,
    options = {},
    mkdtempFn = async (prefix: string) => mkdtemp(prefix),
  } = deps
  const {
    timeoutMs = DEFAULT_CLONE_TIMEOUT_MS,
    maxConcurrent = MAX_CONCURRENT_CLONES,
    maxQueueDepth = MAX_CLONE_QUEUE_DEPTH,
  } = options

  const {owner, repo, token} = request

  // Global concurrency semaphore.
  const semaphoreResult = await withCloneSemaphore(maxConcurrent, maxQueueDepth, async () =>
    withRepoLock(`${owner}/${repo}`, async () =>
      executeCloneInner(owner, repo, token, reposRoot, timeoutMs, execFileFn, mkdtempFn),
    ),
  )

  return semaphoreResult
}

async function executeCloneInner(
  owner: string,
  repo: string,
  token: string,
  reposRoot: string,
  timeoutMs: number,
  execFileFn: ExecFileFn,
  mkdtempFn: (prefix: string) => Promise<string>,
): Promise<CloneHandlerResult> {
  const destPath = join(reposRoot, owner, repo)
  const cloneUrl = `https://github.com/${owner}/${repo}.git`

  let askpassDir: string | null = null
  let tmpClonePath: string | null = null

  // AbortController for timeout.
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // Ensure the owner dir exists.
    await mkdir(join(reposRoot, owner), {recursive: true, mode: 0o755})
    // Idempotency: if the destination already exists, return 409.
    try {
      await realpath(destPath)
      // If realpath succeeds, the path exists.
      return {
        response: {ok: false, error: 'repo-exists'},
        statusCode: 409,
      }
    } catch {
      // ENOENT — path does not exist, proceed with clone.
    }
    // Create a unique private askpass directory (race-free, mode 0700).
    askpassDir = await mkdtempFn(join(os.tmpdir(), 'workspace-agent-askpass-'))
    activeAskpassDirs.add(askpassDir)

    // Open askpass.sh with O_EXCL (exclusive creation — refuses if exists).
    const askpassPath = join(askpassDir, 'askpass.sh')
    const fh = await open(askpassPath, 'wx', 0o600)
    try {
      // Token is NOT embedded in the script body — it reads $GITHUB_TOKEN from env.
      // This means the script file on disk contains no secret.
      // Build the askpass script. The shell reads GITHUB_TOKEN from its environment.
      // We construct the string to avoid triggering no-template-curly-in-string lint rule.
      const githubTokenRef = ['$', '{GITHUB_TOKEN}'].join('')
      const askpassScript = [
        '#!/bin/sh',
        'case "$1" in',
        `  Username*) printf '%s' 'x-access-token' ;;`,
        `  Password*) printf '%s' "${githubTokenRef}" ;;`,
        `  *) exit 1 ;;`,
        'esac',
        '',
      ].join('\n')
      await fh.writeFile(askpassScript)
    } finally {
      await fh.close()
    }

    // Minimal env — only what git needs. Token via GITHUB_TOKEN, not in script body.
    const spawnEnv: Record<string, string> = {
      GIT_ASKPASS: askpassPath,
      GITHUB_TOKEN: token,
      GIT_TERMINAL_PROMPT: '0',
      GIT_TRACE: '0',
      GIT_TRACE_PACKET: '0',
      GIT_TRACE_PERFORMANCE: '0',
      GIT_CURL_VERBOSE: '0',
      HOME: process.env.HOME ?? '/root',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    }

    // Atomic clone: clone into a temp dir in the same parent (so rename is atomic).
    const randomSuffix = Math.random().toString(36).slice(2, 10)
    tmpClonePath = join(reposRoot, owner, `.tmp-${repo}-${randomSuffix}`)

    // Clone args — token NEVER appears here.
    // -c credential.helper= disables any operator-side credential helper.
    const gitArgs = ['-c', 'credential.helper=', 'clone', cloneUrl, tmpClonePath]

    try {
      await execFileFn('git', gitArgs, {env: spawnEnv, signal: controller.signal})
    } catch (error) {
      // Map AbortError → clone-timeout.
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR')
      ) {
        return {
          response: {ok: false, error: 'clone-timeout'},
          statusCode: 504,
        }
      }

      const raw = error instanceof Error ? error.message : String(error)
      const scrubbed = scrubCredentials(raw)

      // Detect ENOSPC.
      if (scrubbed.includes('ENOSPC') || scrubbed.includes('No space left')) {
        return {
          response: {ok: false, error: 'enospc', code: 'ENOSPC'},
          statusCode: 500,
        }
      }

      // Detect git not available.
      if (scrubbed.includes('ENOENT') && scrubbed.includes('git')) {
        return {
          response: {ok: false, error: 'git-not-available'},
          statusCode: 500,
        }
      }

      return {
        response: {ok: false, error: 'clone-failed'},
        statusCode: 500,
      }
    }

    // Atomic rename: tmpClonePath → destPath.
    try {
      await rename(tmpClonePath, destPath)
      tmpClonePath = null // Rename succeeded; don't rm in finally.
    } catch (error) {
      // Rename failure (e.g. cross-device link) → clone-failed.
      const raw = error instanceof Error ? error.message : String(error)
      const scrubbed = scrubCredentials(raw)
      // Check if dest appeared concurrently (race with another request that won the lock).
      if (scrubbed.includes('ENOTEMPTY') || scrubbed.includes('EEXIST')) {
        return {
          response: {ok: false, error: 'repo-exists'},
          statusCode: 409,
        }
      }
      return {
        response: {ok: false, error: 'clone-failed'},
        statusCode: 500,
      }
    }

    // Read HEAD SHA — failure is a clone failure, not ok:true with 'unknown'.
    // rev-parse is purely local; omit GITHUB_TOKEN from its env.
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const {GITHUB_TOKEN: _GITHUB_TOKEN, ...localGitEnv} = spawnEnv
    let commit: string
    try {
      const {stdout} = await execFileFn('git', ['-C', destPath, 'rev-parse', 'HEAD'], {env: localGitEnv})
      commit = stdout.trim()
      if (commit.length === 0) {
        return {
          response: {ok: false, error: 'head-resolution-failed'},
          statusCode: 500,
        }
      }
    } catch {
      return {
        response: {ok: false, error: 'head-resolution-failed'},
        statusCode: 500,
      }
    }

    // Symlink defense: verify the cloned path is still within the repos root.
    let resolvedPath: string
    try {
      resolvedPath = await realpath(destPath)
    } catch {
      return {
        response: {ok: false, error: 'path-escaped-workspace'},
        statusCode: 500,
      }
    }

    if (resolvedPath.startsWith(`${reposRoot}/`) === false && resolvedPath !== reposRoot) {
      // Path escaped the workspace — remove the clone and reject.
      await rm(destPath, {recursive: true, force: true})
      return {
        response: {ok: false, error: 'path-escaped-workspace'},
        statusCode: 500,
      }
    }

    return {
      response: {ok: true, path: resolvedPath, commit},
      statusCode: 200,
    }
  } catch (error) {
    // Catch-all for unexpected errors (e.g., mkdir EACCES, open EEXIST, etc.)
    // that aren't handled by inner try/catch blocks.
    // Map EACCES → permission-denied, ENOSPC → disk-full, etc.
    const raw = error instanceof Error ? error.message : String(error)
    const scrubbed = scrubCredentials(raw)
    if (scrubbed.includes('ENOSPC') || scrubbed.includes('No space left')) {
      return {response: {ok: false, error: 'disk-full'}, statusCode: 500}
    }
    if (scrubbed.includes('EACCES')) {
      return {response: {ok: false, error: 'permission-denied'}, statusCode: 500}
    }
    if (scrubbed.includes('EMFILE')) {
      return {response: {ok: false, error: 'too-many-files'}, statusCode: 500}
    }
    return {response: {ok: false, error: 'clone-failed'}, statusCode: 500}
  } finally {
    clearTimeout(timeoutHandle)

    // Clean up partial temp clone if rename didn't happen.
    if (tmpClonePath !== null) {
      await rm(tmpClonePath, {recursive: true, force: true})
    }

    // Always clean up the askpass temp dir.
    if (askpassDir !== null) {
      await cleanupAskpassDir(askpassDir)
    }
  }
}
