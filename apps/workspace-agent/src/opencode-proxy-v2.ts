/**
 * Bearer-to-Basic reverse proxy for a stock OpenCode V2 server: the sibling of `opencode-proxy.ts`.
 *
 * This is the SOLE sandbox-net-reachable OpenCode entry point. The raw server is loopback-bound.
 *
 * What differs from the V1 proxy (all measured against v2.2.0, probe P14):
 * - The server demands Basic auth with a per-spawn password. The caller presents the gateway's bearer; the proxy
 *   checks it and replaces it with the credential of the server that is ready right now, read from the holder on
 *   every request, never captured. A respawn changes the password, so a captured value would answer 401 forever.
 * - While no server is ready the holder is empty and the proxy answers 503 without forwarding.
 * - Every upstream 401 has the same body, so the proxy cannot tell a stale password from a missing one. It reports
 *   any upstream 401 as an upstream authentication failure (502 plus `x-fro-bot-proxy-error: upstream-auth`),
 *   which the caller can tell apart from its own wrong bearer (401) and from a server that is down (502 without
 *   the header). Passing the 401 through would tell the gateway its own token is wrong.
 * - `x-opencode-directory` selects the location and passes through untouched (all headers except `authorization`
 *   and `host` do). The SSE stream (`/api/event`) is uncompressed, delivered incrementally, and sends a `:
 *   heartbeat` comment every 15 seconds, so it needs no special handling beyond the timeout exemption.
 * - The teardown classifier knows the V2 routes.
 * - The `/api/credential` group is never forwarded (fro-bot/agent#1992). The supervisor stores provider keys there,
 *   straight to loopback and not through this proxy, and `credential.list` returns every stored value in the clear.
 *
 * SECURITY INVARIANTS:
 * 1. The bearer is compared with `timingSafeEqual`, length-checked first, and is never logged or echoed.
 * 2. The upstream credential is never logged and never sent to the caller.
 * 3. A request with a missing or wrong bearer is answered 401 and never forwarded.
 * 4. No header value, query string or request body is logged. The workspace directory travels in a header and in
 *    the evict query, so the teardown log carries only a validated session id, the status and the duration.
 * 5. Non-SSE requests have an inactivity timeout (504). SSE is exempt.
 * 6. A bearer holder never reaches `/api/credential`: it is answered 404 and not forwarded, however the path is spelled.
 */

import type {OpencodeProxyHandle} from './opencode-proxy.js'
import type {UpstreamCredentials} from './opencode-server-v2.js'
import type {Logger} from './opencode-server.js'

import {Buffer} from 'node:buffer'
import {timingSafeEqual} from 'node:crypto'
import http from 'node:http'
import process from 'node:process'
import {URL} from 'node:url'

const UNAUTHORIZED_BODY = 'Unauthorized\n'
const SERVICE_UNAVAILABLE_BODY = 'Service Unavailable\n'
const GATEWAY_TIMEOUT_BODY = 'Gateway Timeout\n'
const UPSTREAM_AUTH_FAILED_BODY = 'Upstream Authentication Failed\n'
const BAD_GATEWAY_BODY = 'Bad Gateway\n'
const NOT_FOUND_BODY = 'Not Found\n'

/** Names the cause of a 502 the proxy synthesised, so a caller can tell an auth failure from a missing server. */
const PROXY_ERROR_HEADER = 'x-fro-bot-proxy-error'

/** Default inactivity timeout: 30 seconds. */
const PROXY_TIMEOUT_DEFAULT_MS = 30_000

/** Same contract as the V1 proxy: fail-soft to the default for a missing or invalid value. */
function readProxyTimeoutMs(): number {
  const raw = process.env.WORKSPACE_PROXY_TIMEOUT_MS
  if (raw === undefined || raw === '') return PROXY_TIMEOUT_DEFAULT_MS
  const trimmed = raw.trim()
  if (trimmed === '') return PROXY_TIMEOUT_DEFAULT_MS
  const parsed = Number.parseInt(trimmed, 10)
  if (Number.isInteger(parsed) === false || String(parsed) !== trimmed || parsed <= 0) return PROXY_TIMEOUT_DEFAULT_MS
  return parsed
}

/** A session id is a plain identifier; anything else in that path segment is not logged. */
const SESSION_ID_PATTERN = /^[\w-]{1,128}$/

interface TeardownRequest {
  readonly message: string
  readonly sessionId?: string
}

/**
 * Recognizes the V2 requests that tear down a session or a location. Matches on method and path only (the query
 * string is dropped), and returns a fixed message so nothing request-derived but a validated session id is logged.
 */
function classifyTeardown(method: string | undefined, rawUrl: string | undefined): TeardownRequest | undefined {
  if (method === undefined || rawUrl === undefined) return undefined
  let pathname: string
  try {
    pathname = new URL(rawUrl, 'http://proxy.invalid').pathname
  } catch {
    return undefined
  }
  // ['', 'api', 'session', ':id', 'interrupt'] | ['', 'api', 'session', ':id']
  // | ['', 'api', 'debug', 'location'] | ['', 'api', 'location', 'reload']
  const segments = pathname.split('/')
  if (segments[0] !== '' || segments[1] !== 'api') return undefined

  const [, , head, second, third] = segments
  if (head === 'session' && second !== undefined && SESSION_ID_PATTERN.test(second)) {
    if (method === 'POST' && segments.length === 5 && third === 'interrupt') {
      return {message: 'opencode-proxy-v2: session interrupt forwarded', sessionId: second}
    }
    if (method === 'DELETE' && segments.length === 4) {
      return {message: 'opencode-proxy-v2: session delete forwarded', sessionId: second}
    }
    return undefined
  }
  if (method === 'DELETE' && segments.length === 4 && head === 'debug' && second === 'location') {
    return {message: 'opencode-proxy-v2: location evict forwarded'}
  }
  if (method === 'POST' && segments.length === 4 && head === 'location' && second === 'reload') {
    return {message: 'opencode-proxy-v2: location reload forwarded'}
  }
  return undefined
}

/** How many times a path is percent-decoded before it is judged. A path still changing after this is not legitimate. */
const MAX_PATH_DECODE_ROUNDS = 3

/**
 * The path segments the server's router would see, or undefined when the path cannot be judged.
 *
 * Measured against v2.2.0 (/tmp/v2-plan/cred/echo-check.md): the router matches `credential` case-insensitively and
 * after percent-decoding, collapses empty segments and ignores `;params`. So the path is decoded until it is stable
 * (bounded), split on `/` and `\`, emptied of `.` and empty segments, resolved for `..`, and stripped of `;params`.
 * The query and fragment are not part of the path.
 */
function canonicalPathSegments(rawUrl: string | undefined): readonly string[] | undefined {
  if (rawUrl === undefined) return undefined
  let path = rawUrl.split(/[?#]/, 1)[0] ?? ''
  for (let round = 0; ; round++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch {
      return undefined
    }
    if (decoded === path) break
    if (round === MAX_PATH_DECODE_ROUNDS - 1) return undefined
    path = decoded
  }
  const segments: string[] = []
  for (const raw of path.split(/[/\\]/)) {
    const segment = raw.split(';', 1)[0] ?? ''
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments
}

/**
 * True for any request that could reach the `credential` route group, and for any path that cannot be judged. Fails
 * closed: a malformed or endlessly encoded path is not forwarded either.
 */
function targetsCredentialRoutes(rawUrl: string | undefined): boolean {
  const segments = canonicalPathSegments(rawUrl)
  if (segments === undefined) return true
  return segments[0]?.toLowerCase() === 'api' && segments[1]?.toLowerCase() === 'credential'
}

export interface OpencodeProxyV2Options {
  /** Expected bearer token. Compared with `timingSafeEqual`. Never logged. */
  readonly token: string
  /** Upstream loopback URL, e.g. http://127.0.0.1:54321 */
  readonly upstreamUrl: string
  readonly logger: Logger
  /** The credential of the server that is ready now. Read on every request. */
  readonly credentials: UpstreamCredentials
  /**
   * Inactivity timeout in milliseconds for non-SSE upstream requests. Defaults to `WORKSPACE_PROXY_TIMEOUT_MS`, or
   * 30000 if unset.
   */
  readonly timeoutMs?: number
}

/** Create the V2 proxy. The handle is the V1 handle, so `main.ts` drives either the same way. */
export function createOpencodeProxyV2(options: OpencodeProxyV2Options): OpencodeProxyHandle {
  const {token, upstreamUrl, logger, credentials} = options
  const inactivityTimeoutMs = options.timeoutMs === undefined ? readProxyTimeoutMs() : options.timeoutMs

  const expectedBuf = Buffer.from(token)
  const upstream = new URL(upstreamUrl)

  const reply = (
    res: http.ServerResponse,
    status: number,
    body: string,
    extraHeaders: Record<string, string> = {},
  ): void => {
    res.writeHead(status, {
      'Content-Type': 'text/plain',
      'Content-Length': String(Buffer.byteLength(body)),
      ...extraHeaders,
    })
    res.end(body)
  }

  const server = http.createServer((req, res) => {
    // --- Caller auth: the gateway bearer ---
    const authHeader = req.headers.authorization
    let authorized = false
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const presentedBuf = Buffer.from(authHeader.slice('Bearer '.length))
      // Guard length before timingSafeEqual (requires same-length buffers).
      if (presentedBuf.length === expectedBuf.length) {
        authorized = timingSafeEqual(presentedBuf, expectedBuf)
      }
    }
    if (authorized === false) {
      // Never log the Authorization header value or the url (the query can carry a directory).
      logger.warn('opencode-proxy-v2: unauthorized request', {method: req.method})
      reply(res, 401, UNAUTHORIZED_BODY)
      return
    }

    // --- Credential routes: never forwarded ---
    // After the bearer check (an unauthenticated caller learns nothing) and before the 503 and the forward, so the
    // answer is the same whether or not a server is ready. Nothing request-derived is logged but the method.
    if (targetsCredentialRoutes(req.url)) {
      logger.warn('opencode-proxy-v2: credential route blocked', {method: req.method})
      reply(res, 404, NOT_FOUND_BODY)
      return
    }

    // --- Upstream credential: the server that is ready now ---
    const upstreamAuthorization = credentials.authorization()
    if (upstreamAuthorization === undefined) {
      logger.warn('opencode-proxy-v2: no server is ready, request not forwarded', {method: req.method})
      reply(res, 503, SERVICE_UNAVAILABLE_BODY, {'Retry-After': '1'})
      return
    }

    // --- Teardown logging ---
    // After auth, so an unauthorised caller can never produce a "forwarded" line. Logged when the response closes,
    // so the status is the one the caller actually saw.
    const teardown = classifyTeardown(req.method, req.url)
    if (teardown !== undefined) {
      const startedAtMs = Date.now()
      res.once('close', () => {
        logger.info(teardown.message, {
          ...(teardown.sessionId === undefined ? {} : {sessionId: teardown.sessionId}),
          ...(res.headersSent ? {status: res.statusCode} : {}),
          durationMs: Date.now() - startedAtMs,
        })
      })
    }

    // --- Forward ---
    // The caller's bearer and Host are replaced; every other header (x-opencode-directory included) is kept.
    const forwardHeaders = Object.fromEntries(
      Object.entries(req.headers).filter(([key]) => key !== 'authorization' && key !== 'host'),
    )
    const forwardOptions: http.RequestOptions = {
      hostname: upstream.hostname,
      port: upstream.port === '' ? undefined : Number(upstream.port),
      path: req.url,
      method: req.method,
      headers: {...forwardHeaders, authorization: upstreamAuthorization, host: upstream.host},
    }

    // --- Inactivity timer: armed on request start, reset per non-SSE data chunk, cancelled for SSE ---
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const reqRef: {current: http.ClientRequest | undefined} = {current: undefined}
    // SSE intent: the request's Accept until response headers arrive, then the response's Content-Type.
    let responseIsSSE: boolean | undefined

    const armTimer = (): void => {
      clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => {
        if (settled === true) return
        settled = true
        logger.warn('opencode-proxy-v2: upstream inactivity timeout', {timeoutMs: inactivityTimeoutMs})
        reqRef.current?.destroy()
        if (res.headersSent === false) {
          reply(res, 504, GATEWAY_TIMEOUT_BODY)
        } else {
          res.destroy()
        }
      }, inactivityTimeoutMs)
    }

    const cancelTimer = (): void => {
      clearTimeout(inactivityTimer)
      inactivityTimer = undefined
    }

    const upstreamReq = http.request(forwardOptions, upstreamRes => {
      // A 401 here means the server rejected the credential the holder supplied: the holder is stale, or this is
      // not the server that was spawned. Say so, instead of passing a 401 the gateway would read as its own.
      if (upstreamRes.statusCode === 401) {
        settled = true
        cancelTimer()
        upstreamRes.resume()
        logger.error('opencode-proxy-v2: the OpenCode server rejected the credential the proxy holds', {
          method: req.method,
        })
        if (res.headersSent === false)
          reply(res, 502, UPSTREAM_AUTH_FAILED_BODY, {[PROXY_ERROR_HEADER]: 'upstream-auth'})
        else res.destroy()
        return
      }

      // SSE is a long-lived intentional stream and must never be timed out.
      const rawContentType = upstreamRes.headers['content-type']
      const contentType = Array.isArray(rawContentType) ? rawContentType.join(',') : (rawContentType ?? '')
      const isSSE = contentType.includes('text/event-stream')

      if (isSSE === true) {
        cancelTimer()
      } else {
        // Reset on each chunk so a slow-but-progressing response is not killed. Headers alone do not cancel the
        // timer: a server can send headers fast and then stall mid-body forever.
        upstreamRes.on('data', () => {
          armTimer()
        })
        upstreamRes.on('end', () => {
          settled = true
          cancelTimer()
        })
        upstreamRes.on('close', () => {
          settled = true
          cancelTimer()
        })
        upstreamRes.on('error', () => {
          settled = true
          cancelTimer()
        })
      }

      // `pipe` ends `res` only when the upstream ends; an upstream that dies mid-response would leave the caller waiting.
      upstreamRes.on('error', () => {
        res.destroy()
      })
      upstreamRes.on('close', () => {
        if (upstreamRes.complete === false) res.destroy()
      })

      responseIsSSE = isSSE
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      // Pipe without buffering: SSE streams through.
      upstreamRes.pipe(res, {end: true})
    })

    reqRef.current = upstreamReq
    armTimer()

    // An SSE stream has no end and no inactivity timer, so a departed caller must release the upstream request.
    res.once('close', () => {
      const isSSE = responseIsSSE ?? (req.headers.accept ?? '').includes('text/event-stream')
      if (isSSE === true && res.writableFinished === false) upstreamReq.destroy()
    })

    upstreamReq.on('error', (err: Error) => {
      settled = true
      cancelTimer()
      logger.error('opencode-proxy-v2: upstream error', {message: err.message})
      if (res.headersSent === false) reply(res, 502, BAD_GATEWAY_BODY)
      else res.destroy()
    })

    // Pipe a request body upstream; end bodyless requests at once (keep-alive streams never close on their own).
    const hasBody =
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined)
    if (hasBody === true) {
      req.pipe(upstreamReq, {end: true})
    } else {
      upstreamReq.end()
    }
  })

  return {
    server,

    async listen(port: number, hostname: string): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, hostname, () => {
          server.off('error', reject)
          logger.info('opencode-proxy-v2: listening', {port, hostname})
          resolve()
        })
      })
    },

    async close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close(err => {
          if (err !== undefined && err !== null) reject(err)
          else resolve()
        })
      })
    },
  }
}
