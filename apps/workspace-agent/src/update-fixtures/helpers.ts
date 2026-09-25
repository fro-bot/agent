/**
 * Shared fixtures for the Unit 2 adversarial real-git suite
 * (apps/workspace-agent/src/update-fixtures/*.test.ts).
 *
 * Every test in this directory spawns the REAL `git` binary — never a mock — against temp
 * directories on disk. Every invocation here is isolated from this machine's own `~/.gitconfig`
 * and from this repository's own `.git`: HOME is pinned to a per-test temp directory, and
 * GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM/GIT_CONFIG_NOSYSTEM disable every config level except the
 * one under test (repo-local, or explicit `-c`/env overrides).
 *
 * See docs/plans/2026-09-24-001-feat-workspace-checkout-update-recovery-plan.md, Unit 2, for the
 * scenario list this module supports, and Unit 3 (git-safety.ts, git-stream.ts,
 * checkout-profile.ts) for the primitives these fixtures exercise.
 */

import type {IncomingHttpHeaders, IncomingMessage, Server, ServerResponse} from 'node:http'

import {Buffer} from 'node:buffer'
import {execFile, execFileSync} from 'node:child_process'
import {chmod, mkdtemp, readFile, stat, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {createServer as createHttpsServer} from 'node:https'
import os from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Every scenario in this suite runs as a real assertion on host git — none of them needed actual
 * uid switching between the service identity and AGENT_UID (10001), so there is currently no
 * `WORKSPACE_FIXTURES_IN_IMAGE`-gated test to skip outside the image. If a future scenario in this
 * directory genuinely needs the image's real root/AGENT_UID boundary, gate it on
 * `process.env.WORKSPACE_FIXTURES_IN_IMAGE === '1'` rather than adding an ungated test that
 * silently no-ops on an unprivileged host.
 */

/**
 * Isolated git environment for every fixture invocation in this directory. `home` must be a
 * per-test temp directory — never the real HOME — since GIT_CONFIG_GLOBAL/_SYSTEM/_NOSYSTEM only
 * disable git's OWN config file resolution; HOME is still consulted by some git code paths (e.g.
 * a default cookie jar location) and must never resolve to this developer's real home directory.
 */
export function isolatedGitEnv(home: string, overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value
  }
  return {
    ...base,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    ...overrides,
  }
}

export function gitSync(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {cwd, env, encoding: 'utf8'})
}

export interface GitAsyncResult {
  readonly stdout: string
  readonly stderr: string
}

export type GitAsyncOutcome =
  | ({readonly ok: true} & GitAsyncResult)
  | {readonly ok: false; readonly code: number | null; readonly stdout: string; readonly stderr: string}

/** Async, non-throwing git invocation: failures are reported, never thrown, so a test can assert on them directly. */
export async function gitAsync(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<GitAsyncOutcome> {
  try {
    const {stdout, stderr} = await execFileAsync('git', args, {
      cwd,
      env,
      timeout: timeoutMs,
      encoding: 'utf8',
    })
    return {ok: true, stdout, stderr}
  } catch (error) {
    const execError = error as {code?: number | null; stdout?: string; stderr?: string}
    return {
      ok: false,
      code: typeof execError.code === 'number' ? execError.code : null,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
    }
  }
}

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(os.tmpdir(), prefix))
}

export function initRepo(dir: string, env: NodeJS.ProcessEnv, defaultBranch = 'main'): void {
  gitSync(dir, ['-c', `init.defaultBranch=${defaultBranch}`, 'init', '-q'], env)
}

export function commitFile(
  dir: string,
  env: NodeJS.ProcessEnv,
  name: string,
  content: string,
  message: string,
): string {
  execFileSync('sh', ['-c', `mkdir -p "$(dirname "$1")" && printf '%s' "$2" > "$1"`, '_', join(dir, name), content])
  gitSync(dir, ['add', '--', name], env)
  gitSync(dir, ['commit', '-q', '-m', message], env)
  return gitSync(dir, ['rev-parse', 'HEAD'], env).trim()
}

export function currentGitVersion(): string {
  return execFileSync('git', ['--version'], {encoding: 'utf8'}).trim()
}

// ---------------------------------------------------------------------------
// Loopback listener — the "attacker" endpoint a hostile config vector might redirect
// credential-bearing traffic to. Records every request it receives so a test can assert
// on presence/absence and on header content (Authorization, Cookie, custom headers).
// ---------------------------------------------------------------------------

export interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

export interface LoopbackListener {
  readonly port: number
  readonly requests: RecordedRequest[]
  readonly close: () => Promise<void>
}

/** Shared request-recording handler for both the plain-HTTP and HTTPS loopback listeners: records every request into `requests`, then always answers 401 with a Basic challenge, matching the "loopback listener challenging for auth" scenario language in the plan. */
function recordingHandler(requests: RecordedRequest[]): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.statusCode = 401
      res.setHeader('WWW-Authenticate', 'Basic realm="loopback-fixture"')
      res.end('unauthorized')
    })
  }
}

/** Waits for `server` to bind on 127.0.0.1 (OS-assigned port) and returns the assigned port. */
async function listenOnLoopback(server: {
  listen: (port: number, host: string, cb: () => void) => unknown
  once: (event: 'error', cb: (error: Error) => void) => unknown
  address: () => {port: number} | string | null
}): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('loopback listener did not report a numeric port')
  }
  return address.port
}

/** Starts a plain-HTTP server bound to 127.0.0.1 on an OS-assigned port. Always responds 401 with a Basic challenge, matching the "loopback listener challenging for auth" scenario language in the plan. */
export async function startLoopbackListener(): Promise<LoopbackListener> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer(recordingHandler(requests))
  const port = await listenOnLoopback(server)
  return {
    port,
    requests,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/**
 * Generates a throwaway self-signed certificate (RSA 2048, 1-day validity, CN=127.0.0.1) under
 * `dir` via the system `openssl` binary, for the http.sslVerify/http.sslCAInfo transport
 * fixtures. Nothing trusts this key for anything outside the test process.
 */
export async function generateSelfSignedCert(
  dir: string,
): Promise<{readonly certPath: string; readonly keyPath: string}> {
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-keyout',
    keyPath,
    '-out',
    certPath,
  ])
  return {certPath, keyPath}
}

export function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

/** Starts an HTTPS server bound to 127.0.0.1 on an OS-assigned port using `certPath`/`keyPath`. Same request-recording and 401 challenge behaviour as `startLoopbackListener`. */
export async function startHttpsLoopbackListener(certPath: string, keyPath: string): Promise<LoopbackListener> {
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)])
  const requests: RecordedRequest[] = []
  const server = createHttpsServer({cert, key}, recordingHandler(requests))
  const port = await listenOnLoopback(server)
  return {
    port,
    requests,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

// ---------------------------------------------------------------------------
// Sentinel — proof that a hook/filter/fsmonitor script actually ran, written OUTSIDE any
// checkout so it can never be mistaken for tracked content the merge itself produced.
// ---------------------------------------------------------------------------

/** Absolute path to the sentinel file a hook/filter script writes to when it runs, under a per-test temp `sentinelDir` (never inside a checkout). */
export function sentinelPath(sentinelDir: string): string {
  return join(sentinelDir, 'fired')
}

export async function sentinelFired(sentinelDir: string): Promise<boolean> {
  try {
    await stat(sentinelPath(sentinelDir))
    return true
  } catch {
    return false
  }
}

/** Writes and chmods an executable POSIX shell script at `scriptPath`. `body` is wrapped in a `#!/bin/sh` shebang. */
export async function writeExecutableScript(scriptPath: string, body: string): Promise<void> {
  await writeFile(scriptPath, `#!/bin/sh\n${body}\n`, {mode: 0o755})
  await chmod(scriptPath, 0o755)
}
