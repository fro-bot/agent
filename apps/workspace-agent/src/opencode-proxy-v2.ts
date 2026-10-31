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
 * - The teardown classifier knows the one allowlisted stop route (session interrupt).
 * - Only the routes the gateway's clients call are forwarded (`V2_GATEWAY_ROUTES`, an allowlist; fro-bot/agent#1992).
 *   The supervisor stores provider keys through `/api/credential`, straight to loopback and not through this proxy,
 *   and `credential.list` returns every stored value in the clear, so a bearer holder must not be able to reach it by
 *   any spelling. A denylist lost that race twice (absolute-form `http://host/api/credential`, and
 *   `/api/credential;x/../info`, which the server's router truncates at `;`), so the target is checked to be
 *   canonical origin-form and then matched against the allowlist by exact segments, with no decoding.
 *
 * SECURITY INVARIANTS:
 * 1. The bearer is compared with `timingSafeEqual`, length-checked first, and is never logged or echoed.
 * 2. The upstream credential is never logged and never sent to the caller.
 * 3. A request with a missing or wrong bearer is answered 401 and never forwarded.
 * 4. No header value, query string or request body is logged. The workspace directory travels in a header and in
 *    the evict query, so the teardown log carries only a validated session id, the status and the duration.
 * 5. Non-SSE requests have an inactivity timeout (504). SSE is exempt.
 * 6. A request whose target is not canonical origin-form, or is not an allowlisted method and route, is answered 404 and
 *    never forwarded, and only the method is logged.
 */

import type {OpencodeProxyHandle} from './opencode-proxy.js'
import type {UpstreamCredentials} from './opencode-server-v2.js'
import type {Logger} from './opencode-server.js'

import {Buffer} from 'node:buffer'
import {timingSafeEqual} from 'node:crypto'
import http from 'node:http'
import process from 'node:process'
import {URL} from 'node:url'

import {isGatewayRouteV2} from '@fro-bot/runtime/workspace-v2'

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
 * Recognizes the one allowlisted request that stops a session. Runs only on a target `isForwardableTarget` accepted, so
 * the path is canonical, and returns a fixed message so nothing request-derived but a validated session id is logged.
 */
function classifyTeardown(method: string | undefined, rawUrl: string | undefined): TeardownRequest | undefined {
  if (method !== 'POST' || rawUrl === undefined) return undefined
  const segments = (rawUrl.split('?', 1)[0] ?? '').split('/')
  // ['', 'api', 'session', ':id', 'interrupt']
  const [, api, head, id, tail] = segments
  if (
    segments.length === 5 &&
    api === 'api' &&
    head === 'session' &&
    tail === 'interrupt' &&
    id !== undefined &&
    SESSION_ID_PATTERN.test(id)
  ) {
    return {message: 'opencode-proxy-v2: session interrupt forwarded', sessionId: id}
  }
  return undefined
}

/** Printable ASCII only: no control character, space, DEL or byte above 0x7e anywhere in the target. */
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/

/** The percent-encodings of `/`, `\`, `.`, `;` and `%`: the characters a router can decode into path structure. */
const STRUCTURAL_ENCODING = /%(?:2f|5c|2e|3b|25)/i

/**
 * True when a request may be forwarded: its target is canonical origin-form and its method and path are an allowlisted
 * route. The check is strict on purpose, because the forwarded target is what the server's router sees:
 *
 * - origin-form only: it starts with exactly one `/`, so absolute-form (`http://host/...`, which the server's router
 *   reduces to its path), authority-form and `*` are refused;
 * - printable ASCII only, and no `#`;
 * - the path (everything before the first `?`) has no `;` (the router truncates a segment there), no `\`, no empty
 *   segment, no `.` or `..` segment, and no percent-encoding of `/`, `\`, `.`, `;` or `%`;
 * - the path matches an allowlisted route by exact segments, with no decoding (`isGatewayRouteV2`).
 *
 * The query is allowed and is never inspected for routing: nothing after the first `?` decides the route.
 */
export function isForwardableTarget(method: string | undefined, target: string | undefined): boolean {
  if (method === undefined || target === undefined) return false
  if (!PRINTABLE_ASCII.test(target) || target.includes('#')) return false
  if (!target.startsWith('/') || target.startsWith('//')) return false
  const queryStart = target.indexOf('?')
  const path = queryStart === -1 ? target : target.slice(0, queryStart)
  if (path.includes(';') || path.includes('\\') || STRUCTURAL_ENCODING.test(path)) return false
  if (
    path
      .split('/')
      .slice(1)
      .some(segment => segment === '' || segment === '.' || segment === '..')
  )
    return false
  return isGatewayRouteV2(method, path)
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

    // --- Allowlist: only the gateway's own routes, in canonical origin-form ---
    // After the bearer check (an unauthenticated caller learns nothing) and before the 503 and the forward, so the
    // answer is the same whether or not a server is ready. Nothing request-derived is logged but the method.
    if (!isForwardableTarget(req.method, req.url)) {
      logger.warn('opencode-proxy-v2: route not allowed', {method: req.method})
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
