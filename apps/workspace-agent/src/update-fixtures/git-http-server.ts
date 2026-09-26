/**
 * Test-only helper: a local HTTPS smart-HTTP git server, standing in for `https://github.com` in
 * the Unit 4 (`/update`) test seam.
 *
 * Wraps the real `git http-backend` binary as a CGI program behind an HTTPS listener built from
 * `update-fixtures/helpers.ts`'s self-signed CA/cert generation and generic HTTPS-with-handler
 * plumbing (`startHttpsServerWithHandler`) — this module never re-implements either. What this
 * module adds on top:
 *
 * 1. A CGI adapter: maps an incoming Node `IncomingMessage`/`ServerResponse` pair to the
 *    environment variables and stdin/stdout `git http-backend` expects (per the CGI/1.1
 *    convention), and parses the CGI response header block (`Status:`, `Content-Type:`, ...) back
 *    into a real HTTP response.
 * 2. Optional Basic-auth gating in front of the CGI, so `/update`'s fetch-failure classification
 *    can be exercised against a real 401 challenge.
 * 3. Failure injection per repo path (`403`, `404`, `429`, `hang`) so `/update`'s fetch-failure
 *    classification can be exercised against every HTTP status it must distinguish, without
 *    needing a real GitHub outage or a real rate-limited token.
 *
 * NOT part of the production module graph — nothing under `apps/workspace-agent/src` outside
 * `update-fixtures/` may import this file.
 */

import type {ChildProcess} from 'node:child_process'
import type {IncomingMessage, ServerResponse} from 'node:http'
import type {Socket} from 'node:net'

import {Buffer} from 'node:buffer'
import {execFileSync, spawn} from 'node:child_process'
import {chmod, mkdir, open, rm} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

import {generateSelfSignedCert, makeTempDir, startHttpsServerWithHandler} from './helpers.js'

/** A canned failure this fixture can return for a given repo path instead of running `git http-backend`. `'hang'` accepts the connection and never responds at all — the fixture's own `close()` still force-terminates any socket left open by it (see `startGitHttpServer`). */
export type GitHttpServerFailureKind = '403' | '404' | '429' | 'hang'

export interface GitHttpServerOptions {
  /**
   * Directory containing bare repositories at `<reposRoot>/<owner>/<repo>.git`, matching the URL
   * shape `<baseUrl>/<owner>/<repo>.git/...` this fixture serves. The caller creates and
   * populates repositories under this root (e.g. via `git init --bare` + a push, or by pointing
   * it at a directory containing an existing bare mirror) before pointing a git client at
   * `baseUrl`.
   */
  readonly reposRoot: string
  /**
   * When set, every request must carry `Authorization: Basic <base64(username:token)>` with this
   * exact token (any username is accepted — only the token half is checked, matching how the
   * real askpass helpers here always send `x-access-token` as the username). A missing or wrong
   * value gets a `401` with `WWW-Authenticate: Basic` before `git http-backend` ever runs.
   */
  readonly requireToken?: string
}

export interface GitHttpServerHandle {
  /** `https://127.0.0.1:<port>` — prefix with `/<owner>/<repo>.git` for a fetchable URL. */
  readonly baseUrl: string
  /** Path to the self-signed certificate, usable directly as `GIT_SSL_CAINFO` / `caBundlePath` — a self-signed cert validates against itself. */
  readonly caBundlePath: string
  /** Closes the HTTPS listener, force-terminates any lingering connections or CGI children (so an injected `hang` never blocks cleanup), and removes the temp cert directory. */
  readonly close: () => Promise<void>
  /** Injects (or, passing `undefined`, clears) a canned failure for `repoPath` (e.g. `'owner/repo.git'`, matching the `<owner>/<repo>.git` segment of the request URL). Takes effect on the next request. */
  readonly setFailure: (repoPath: string, failure: GitHttpServerFailureKind | undefined) => void
  /** Total number of HTTP requests this server instance has received so far — lets a test assert "the real server was never contacted" for a scenario that fails before ever reaching it (e.g. a deliberately unreachable override URL). */
  readonly requestCount: () => number
}

// ---------------------------------------------------------------------------
// Pure helpers: request-path parsing and CGI response-header parsing. Kept free of any
// process/socket state so they're trivially testable in isolation if ever needed.
// ---------------------------------------------------------------------------

/**
 * Extracts the `<owner>/<repo>.git` segment from a request path like
 * `/owner/repo.git/info/refs` or `/owner/repo.git/git-upload-pack`, for failure-injection lookup.
 * Returns `null` for a path with no `.git` segment at all (never expected from a real git client
 * against this fixture, but failing closed — no failure ever matches — is the safe default).
 */
export function extractRepoPathFromUrl(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname)
  const trimmed = decoded.startsWith('/') ? decoded.slice(1) : decoded
  const gitIdx = trimmed.indexOf('.git')
  if (gitIdx === -1) return null
  return trimmed.slice(0, gitIdx + '.git'.length)
}

/** Splits a request URL into its path and raw query string (never including the `?`). */
export function splitUrl(url: string): {readonly pathname: string; readonly query: string} {
  const qIdx = url.indexOf('?')
  if (qIdx === -1) return {pathname: url, query: ''}
  return {pathname: url.slice(0, qIdx), query: url.slice(qIdx + 1)}
}

/** Finds the earliest CGI header/body boundary (`\r\n\r\n` or bare `\n\n` — `git http-backend` uses bare LF) in `buf`. Returns `null` until the full header block has arrived. */
function findHeaderBoundary(buf: Buffer): {readonly index: number; readonly length: number} | null {
  const crlfIdx = buf.indexOf('\r\n\r\n')
  const lfIdx = buf.indexOf('\n\n')
  if (crlfIdx === -1 && lfIdx === -1) return null
  if (crlfIdx === -1) return {index: lfIdx, length: 2}
  if (lfIdx === -1) return {index: crlfIdx, length: 4}
  return crlfIdx <= lfIdx ? {index: crlfIdx, length: 4} : {index: lfIdx, length: 2}
}

/** Parses a CGI response header block (everything before the header/body boundary) into an HTTP status code (default 200, per CGI convention when no `Status:` line is present) and a plain header map. */
export function parseCgiHeaders(headerText: string): {
  readonly statusCode: number
  readonly headers: Record<string, string>
} {
  const headers: Record<string, string> = {}
  let statusCode = 200
  const normalized = headerText.replaceAll('\r\n', '\n')
  for (const line of normalized.split('\n')) {
    if (line.length === 0) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key.toLowerCase() === 'status') {
      const match = /^(\d{3})/.exec(value)
      if (match?.[1] !== undefined) statusCode = Number.parseInt(match[1], 10)
      continue
    }
    headers[key] = value
  }
  return {statusCode, headers}
}

// ---------------------------------------------------------------------------
// CGI adapter — spawns `git http-backend` for one request and pipes it through.
// ---------------------------------------------------------------------------

/** Resolved once per fixture instance (`startGitHttpServer`), not per request — `git --exec-path` is a fixed property of the installed git binary. */
function resolveHttpBackendPath(): string {
  const execPath = execFileSync('git', ['--exec-path'], {encoding: 'utf8'}).trim()
  return join(execPath, 'git-http-backend')
}

/** Builds the CGI/1.1 environment for one request. `Content-Type` and `Content-Length` are the two CGI meta-variables with no `HTTP_` prefix; every other header is forwarded as `HTTP_<NAME>` with dashes turned into underscores — the generic CGI header-forwarding rule, which is what lets `git http-backend` see `Content-Encoding: gzip` (as `HTTP_CONTENT_ENCODING`) and decompress the request body itself; this adapter never touches the body bytes. */
function buildCgiEnv(params: {
  readonly reposRoot: string
  readonly req: IncomingMessage
  readonly pathInfo: string
  readonly queryString: string
  readonly remoteUser: string | undefined
}): NodeJS.ProcessEnv {
  const {reposRoot, req, pathInfo, queryString, remoteUser} = params
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    GIT_PROJECT_ROOT: reposRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    GATEWAY_INTERFACE: 'CGI/1.1',
    SERVER_PROTOCOL: 'HTTP/1.1',
    SERVER_SOFTWARE: 'workspace-agent-update-fixtures-git-http-server',
    REQUEST_METHOD: req.method ?? 'GET',
    PATH_INFO: pathInfo,
    QUERY_STRING: queryString,
    REMOTE_ADDR: '127.0.0.1',
  }
  if (remoteUser !== undefined) env.REMOTE_USER = remoteUser

  for (const [key, rawValue] of Object.entries(req.headers)) {
    if (rawValue === undefined) continue
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue
    const lower = key.toLowerCase()
    if (lower === 'content-type') {
      env.CONTENT_TYPE = value
      continue
    }
    if (lower === 'content-length') {
      env.CONTENT_LENGTH = value
      continue
    }
    env[`HTTP_${key.toUpperCase().replaceAll('-', '_')}`] = value
  }

  return env
}

/**
 * Spawns `git http-backend` for one request, streams the request body straight into its stdin
 * (never buffered — `Content-Length`/`Content-Encoding` are forwarded as-is, so `http-backend`
 * itself handles a gzip-compressed body), and parses its CGI-style stdout (a header block, a
 * blank-line boundary, then the raw response body) into a real HTTP response on `res`.
 *
 * Tracks the spawned child in `children` for the fixture's own `close()` to force-kill — a
 * request that never completes (this fixture's own `hang` injection short-circuits before ever
 * reaching here, but a genuinely wedged `git http-backend` is the same shape of problem) must
 * never block test cleanup.
 */
async function runGitHttpBackend(params: {
  readonly httpBackendPath: string
  readonly reposRoot: string
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly remoteUser: string | undefined
  readonly children: Set<ChildProcess>
}): Promise<void> {
  const {httpBackendPath, reposRoot, req, res, remoteUser, children} = params
  const {pathname, query} = splitUrl(req.url ?? '/')
  const env = buildCgiEnv({reposRoot, req, pathInfo: decodeURIComponent(pathname), queryString: query, remoteUser})

  await new Promise<void>(resolve => {
    const child = spawn(httpBackendPath, [], {cwd: reposRoot, env})
    children.add(child)

    let headerBuf = Buffer.alloc(0)
    let headersParsed = false
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      children.delete(child)
      resolve()
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (headersParsed) {
        res.write(chunk)
        return
      }
      headerBuf = Buffer.concat([headerBuf, chunk])
      const boundary = findHeaderBoundary(headerBuf)
      if (boundary === null) return
      headersParsed = true
      const headerText = headerBuf.subarray(0, boundary.index).toString('latin1')
      const body = headerBuf.subarray(boundary.index + boundary.length)
      const {statusCode, headers} = parseCgiHeaders(headerText)
      res.writeHead(statusCode, headers)
      if (body.length > 0) res.write(body)
    })

    child.stderr?.on('data', () => {
      // Diagnostic-only; this fixture has no logger of its own and stderr content is not part of
      // any assertion surface. Draining it (rather than ignoring the stream entirely) prevents a
      // full stderr pipe buffer from blocking git-http-backend if it ever writes a lot.
    })

    child.on('error', () => {
      if (!headersParsed) res.writeHead(500)
      res.end()
      finish()
    })

    child.on('close', () => {
      if (!headersParsed) res.writeHead(500)
      res.end()
      finish()
    })

    if (child.stdin !== null) req.pipe(child.stdin)
    req.on('error', () => {
      child.kill('SIGKILL')
    })
  })
}

// ---------------------------------------------------------------------------
// Request handler — failure injection, then Basic-auth gating, then the CGI adapter.
// ---------------------------------------------------------------------------

function respondWithCannedFailure(res: ServerResponse, failure: GitHttpServerFailureKind): void {
  if (failure === '403') {
    res.writeHead(403, {'content-type': 'text/plain'})
    res.end('Forbidden')
    return
  }
  if (failure === '404') {
    res.writeHead(404, {'content-type': 'text/plain'})
    res.end('Not Found')
    return
  }
  // '429' — rate-limited. GitHub's own real rate-limit responses carry `Retry-After` and/or
  // `X-RateLimit-Remaining: 0`; both are included so a classifier can match on either.
  res.writeHead(429, {'content-type': 'text/plain', 'retry-after': '1', 'x-ratelimit-remaining': '0'})
  res.end('Too Many Requests')
}

/** Constant-time-enough Basic-auth check for a test fixture: builds the exact expected header value (any username, exact token) and compares as plain strings — this is a throwaway local test server, not a security boundary, so `timingSafeEqual` buys nothing here. */
function checkBasicAuthToken(authHeader: string | undefined, expectedToken: string): boolean {
  if (authHeader === undefined || !authHeader.startsWith('Basic ')) return false
  let decoded: string
  try {
    decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8')
  } catch {
    return false
  }
  const colonIdx = decoded.indexOf(':')
  if (colonIdx === -1) return false
  return decoded.slice(colonIdx + 1) === expectedToken
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Starts the fixture: a self-signed-HTTPS listener on loopback, backing `git http-backend` as CGI
 * against `options.reposRoot`. See the module header for the overall shape and `GitHttpServerOptions`/
 * `GitHttpServerHandle` for the contract.
 */
export async function startGitHttpServer(options: GitHttpServerOptions): Promise<GitHttpServerHandle> {
  const {reposRoot, requireToken} = options
  const httpBackendPath = resolveHttpBackendPath()

  const certDir = await makeTempDir('workspace-agent-git-http-server-cert-')
  const {certPath, keyPath} = await generateSelfSignedCert(certDir)

  const failures = new Map<string, GitHttpServerFailureKind>()
  const children = new Set<ChildProcess>()
  const sockets = new Set<Socket>()
  let requestCount = 0

  function handler(req: IncomingMessage, res: ServerResponse): void {
    requestCount += 1
    const {pathname} = splitUrl(req.url ?? '/')
    const repoPath = extractRepoPathFromUrl(pathname)
    const failure = repoPath === null ? undefined : failures.get(repoPath)

    if (failure === 'hang') {
      // Accept the connection, consume the body so the socket never backs up, and never respond.
      // `close()` force-destroys the underlying socket (tracked below) rather than relying on
      // this handler ever finishing.
      req.resume()
      return
    }
    if (failure !== undefined) {
      respondWithCannedFailure(res, failure)
      return
    }

    let remoteUser: string | undefined
    if (requireToken !== undefined) {
      if (!checkBasicAuthToken(req.headers.authorization, requireToken)) {
        res.writeHead(401, {'WWW-Authenticate': 'Basic realm="workspace-agent-git-http-server-fixture"'})
        res.end()
        return
      }
      remoteUser = 'x-access-token'
    }

    runGitHttpBackend({httpBackendPath, reposRoot, req, res, remoteUser, children}).catch(() => {
      // runGitHttpBackend resolves on every path (including its own error handlers) and never
      // rejects; this exists only to satisfy no-floating-promises.
    })
  }

  const {port, server} = await startHttpsServerWithHandler(certPath, keyPath, handler)
  // Typed explicitly: the 'connection' event isn't part of https.Server's own typed event map
  // (only 'secureConnection' is), so TypeScript falls back to a looser inferred parameter type for
  // this raw net.Server-inherited event without an explicit annotation here.
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return {
    baseUrl: `https://127.0.0.1:${port}`,
    caBundlePath: certPath,
    setFailure(repoPath, failure) {
      if (failure === undefined) failures.delete(repoPath)
      else failures.set(repoPath, failure)
    },
    requestCount: () => requestCount,
    async close() {
      for (const child of children) child.kill('SIGKILL')
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(certDir, {recursive: true, force: true})
    },
  }
}

// ---------------------------------------------------------------------------
// Test-only askpass seam for the loopback origin.
// ---------------------------------------------------------------------------

/**
 * Test-only askpass helper: answers the exact `https://<host>` credential prompts for a
 * caller-supplied `host` (this fixture's own loopback origin, e.g. `127.0.0.1:41234`), mirroring
 * `clone.ts`'s `writeAskpassHelper` shape — mkdtemp'd directory, `O_EXCL` script creation, mode
 * `0700` set explicitly via `chmod` (umask-independent), token delivered via `$GITHUB_TOKEN` at
 * exec time and never embedded in the script body — but parameterized on host instead of
 * hardcoding `github.com`.
 *
 * NOT a template for production code. `clone.ts`'s real askpass helper hardcodes the exact
 * literal `github.com` so a config- or redirect-driven host substitution can never make it answer
 * a credential prompt for an attacker-chosen host — see that module's doc comment. Parameterizing
 * the host is safe ONLY here, because this helper answers for a throwaway local fixture server
 * with a throwaway test token; there is no real credential for a substituted host to steal.
 *
 * Why a second helper at all, rather than reusing `clone.ts`'s `writeAskpassHelper` for these
 * fixtures: `buildNetworkGitProfile` already takes `askpassPath` as a plain parameter (see
 * `git-safety.ts`), so the "seam" the test needs already exists at the call site — it's just that
 * the ONE existing askpass implementation is deliberately locked to `github.com` and must stay
 * that way. Loosening it, or adding a host allowlist, would weaken the exact protection
 * `clone.askpass.test.ts` exists to prove. A second, explicitly test-only, explicitly-documented
 * helper is the change that touches zero production code.
 */
export async function writeLoopbackAskpassHelper(dir: string, host: string): Promise<string> {
  const askpassPath = join(dir, 'askpass.sh')
  const fh = await open(askpassPath, 'wx', 0o700)
  try {
    const githubTokenRef = ['$', '{GITHUB_TOKEN}'].join('')
    const script = [
      '#!/bin/sh',
      'case "$1" in',
      `  "Username for 'https://${host}': ") printf '%s' 'x-access-token' ;;`,
      `  "Password for 'https://x-access-token@${host}': ") printf '%s' "${githubTokenRef}" ;;`,
      `  *) exit 1 ;;`,
      'esac',
      '',
    ].join('\n')
    await fh.writeFile(script)
  } finally {
    await fh.close()
  }
  await chmod(askpassPath, 0o700)
  return askpassPath
}

/** Creates an empty bare repository directory ready for `git init --bare` under a fixture's `reposRoot`, at `<reposRoot>/<owner>/<repo>.git` — the exact path shape `extractRepoPathFromUrl`/`GIT_PROJECT_ROOT` expect. */
export async function bareRepoPath(reposRoot: string, owner: string, repo: string): Promise<string> {
  const dir = join(reposRoot, owner)
  await mkdir(dir, {recursive: true})
  return join(dir, `${repo}.git`)
}
