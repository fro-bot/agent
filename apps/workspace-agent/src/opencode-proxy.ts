/**
 * Bearer-token reverse proxy for the OpenCode SDK server.
 *
 * This is the SOLE sandbox-net-reachable OpenCode entry point. The raw
 * OpenCode server is loopback-bound and never directly accessible.
 *
 * SECURITY INVARIANTS:
 * 1. Bearer token compared with timingSafeEqual — no timing oracle.
 * 2. Length mismatch checked before timingSafeEqual (guards against empty comparisons).
 * 3. Token is never logged, never echoed in error responses.
 * 4. Missing or wrong bearer → 401 with a fixed body, request NOT forwarded.
 * 5. Supports HTTP and SSE (fetch-based SSE streams through the pipe without buffering).
 *
 * INACTIVITY TIMEOUT:
 * Non-SSE requests are subject to an inactivity timeout: a timer is armed on
 * request start and reset on each data chunk of the upstream response. If no
 * progress is made for the configured interval, the upstream request is destroyed
 * and a 504 Gateway Timeout is returned. SSE (text/event-stream) responses are
 * fully exempt — the timer is cancelled when SSE is detected so long-lived event
 * streams are never cut off. The interval is configurable via the `timeoutMs`
 * option (or `WORKSPACE_PROXY_TIMEOUT_MS` env var) with a 30s default.
 */

import type {Logger} from './opencode-server.js'

import {Buffer} from 'node:buffer'
import {timingSafeEqual} from 'node:crypto'
import http from 'node:http'
import process from 'node:process'
import {URL} from 'node:url'

const UNAUTHORIZED_BODY = 'Unauthorized\n'
const UNAUTHORIZED_BODY_BYTES = Buffer.from(UNAUTHORIZED_BODY)

const GATEWAY_TIMEOUT_BODY = 'Gateway Timeout\n'
const GATEWAY_TIMEOUT_BODY_BYTES = Buffer.from(GATEWAY_TIMEOUT_BODY)

/** Default inactivity timeout: 30 seconds. */
const PROXY_TIMEOUT_DEFAULT_MS = 30_000

/**
 * Read the proxy inactivity timeout from the environment.
 * Returns the default (30s) if the variable is absent, empty, or invalid.
 * Fail-soft: invalid values fall back to the default (not a startup-critical config).
 */
function readProxyTimeoutMs(): number {
  const raw = process.env.WORKSPACE_PROXY_TIMEOUT_MS
  if (raw === undefined || raw === '') {
    return PROXY_TIMEOUT_DEFAULT_MS
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    return PROXY_TIMEOUT_DEFAULT_MS
  }
  const parsed = Number.parseInt(trimmed, 10)
  if (Number.isInteger(parsed) === false || String(parsed) !== trimmed || parsed <= 0) {
    return PROXY_TIMEOUT_DEFAULT_MS
  }
  return parsed
}

export interface OpencodeProxyOptions {
  /**
   * Expected bearer token. Compared with timingSafeEqual.
   * Never logged.
   */
  readonly token: string
  /** Upstream loopback URL, e.g. http://127.0.0.1:54321 */
  readonly upstreamUrl: string
  readonly logger: Logger
  /**
   * Inactivity timeout in milliseconds for non-SSE upstream requests.
   * The timer is armed on request start and reset on each data chunk of the
   * upstream response. SSE (text/event-stream) responses are fully exempt.
   * Defaults to `WORKSPACE_PROXY_TIMEOUT_MS` env var, or 30000ms if unset.
   */
  readonly timeoutMs?: number
}

export interface OpencodeProxyHandle {
  /** The underlying Node http.Server. */
  readonly server: http.Server
  /** Bind the server to a port and start listening. */
  readonly listen: (port: number, hostname: string) => Promise<void>
  /** Close the proxy server. */
  readonly close: () => Promise<void>
}

/**
 * Create a bearer-token reverse proxy that forwards authorized HTTP and SSE
 * requests to the loopback-bound OpenCode server.
 */
export function createOpencodeProxy(options: OpencodeProxyOptions): OpencodeProxyHandle {
  const {token, upstreamUrl, logger} = options
  // Resolve timeout: explicit option takes precedence, then env, then default.
  const inactivityTimeoutMs = options.timeoutMs === undefined ? readProxyTimeoutMs() : options.timeoutMs

  const expectedBuf = Buffer.from(token)
  const upstream = new URL(upstreamUrl)

  const server = http.createServer((req, res) => {
    // --- Auth check ---
    const authHeader = req.headers.authorization

    let authorized = false
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const presented = authHeader.slice('Bearer '.length)
      const presentedBuf = Buffer.from(presented)
      // Guard length before timingSafeEqual (requires same-length buffers)
      if (presentedBuf.length === expectedBuf.length) {
        authorized = timingSafeEqual(presentedBuf, expectedBuf)
      }
    }

    if (authorized === false) {
      // Never log the Authorization header value
      logger.warn('opencode-proxy: unauthorized request', {method: req.method, url: req.url})
      res.writeHead(401, {
        'Content-Type': 'text/plain',
        'Content-Length': String(UNAUTHORIZED_BODY_BYTES.length),
      })
      res.end(UNAUTHORIZED_BODY)
      return
    }

    // --- Forward ---
    // Strip Authorization (never forward caller's bearer to OpenCode)
    // and Host (replace with upstream's host).
    // Build the forwarded headers by filtering — avoids 'undefined' header values
    // which Node throws ERR_HTTP_INVALID_HEADER_VALUE for.
    const forwardHeaders = Object.fromEntries(
      Object.entries(req.headers).filter(([key]) => key !== 'authorization' && key !== 'host'),
    )

    const forwardOptions: http.RequestOptions = {
      hostname: upstream.hostname,
      port: upstream.port === '' ? undefined : Number(upstream.port),
      path: req.url,
      method: req.method,
      headers: {
        ...forwardHeaders,
        host: upstream.host,
      },
    }

    // --- Inactivity timer ---
    // Armed on request start. Reset on each non-SSE response data chunk.
    // Cancelled entirely when SSE (text/event-stream) is detected.
    // On fire: destroy the upstream request and return 504.
    //
    // `settled` prevents double-operation: the timer callback is a no-op if the
    // response already completed (end/close/error) or if the timer already fired.
    // This closes the race where the timer fires just as the response completes.
    //
    // `reqRef` is a mutable object so the timer callback can reference the upstream
    // request without a forward-reference lint violation. It is populated
    // synchronously by http.request() below before armTimer() is first called,
    // so reqRef.current is always set when the callback runs. Timers are async —
    // no callback can fire before the synchronous assignment completes.
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const reqRef: {current: http.ClientRequest | undefined} = {current: undefined}

    const armTimer = (): void => {
      clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => {
        // Guard: if the response already completed or was destroyed, do nothing.
        // This prevents double-operation on an already-ended response.
        if (settled === true) return
        settled = true
        logger.warn('opencode-proxy: upstream inactivity timeout', {
          url: req.url,
          timeoutMs: inactivityTimeoutMs,
        })
        reqRef.current?.destroy()
        if (res.headersSent === false) {
          res.writeHead(504, {
            'Content-Type': 'text/plain',
            'Content-Length': String(GATEWAY_TIMEOUT_BODY_BYTES.length),
          })
          res.end(GATEWAY_TIMEOUT_BODY)
        } else {
          res.destroy()
        }
      }, inactivityTimeoutMs)
    }

    const cancelTimer = (): void => {
      clearTimeout(inactivityTimer)
      inactivityTimer = undefined
    }

    // Populate reqRef.current synchronously before arming the timer.
    // http.request() is synchronous — the assignment completes before any timer
    // callback can fire (timers are async).
    const upstreamReq = http.request(forwardOptions, upstreamRes => {
      // --- SSE detection ---
      // Check the upstream response Content-Type. If it is text/event-stream,
      // cancel the inactivity timer entirely — SSE is a long-lived intentional
      // stream that must never be timed out.
      //
      // Node headers can be string | string[] | undefined — normalize to a single
      // string before the substring check so an array-valued header doesn't break
      // SSE detection (e.g. when a proxy merges duplicate Content-Type headers).
      const rawContentType = upstreamRes.headers['content-type']
      const contentType = Array.isArray(rawContentType) ? rawContentType.join(',') : (rawContentType ?? '')
      const isSSE = contentType.includes('text/event-stream')

      if (isSSE === true) {
        // SSE is fully exempt: cancel the inactivity timer and never re-arm it.
        cancelTimer()
      } else {
        // Non-SSE: reset the timer on each data chunk so a slow-but-progressing
        // response is not killed. The timer fires only after no progress for the
        // configured interval.
        // IMPORTANT: do NOT cancel the timer here just because headers arrived —
        // a server can send headers fast then stall mid-body forever.
        upstreamRes.on('data', () => {
          armTimer()
        })

        // Cancel the timer when the response ends cleanly, or when the TCP
        // connection drops mid-stream (close/error). Without close/error handlers,
        // a mid-stream TCP drop emits close/error (not end), leaving the timer
        // armed — it would fire uselessly and log a false "inactivity timeout".
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

      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      // Pipe without buffering — SSE streams through correctly
      upstreamRes.pipe(res, {end: true})
    })

    // Populate the ref and arm the timer — both happen synchronously after
    // http.request() returns, so reqRef.current is set before any timer fires.
    reqRef.current = upstreamReq
    armTimer()

    upstreamReq.on('error', (err: Error) => {
      // Mark settled (symmetric with the upstreamRes handlers) so a timer firing
      // in the same tick as this error is a no-op rather than double-operating on res.
      settled = true
      cancelTimer()
      logger.error('opencode-proxy: upstream error', {message: err.message})
      if (res.headersSent === false) {
        res.writeHead(502, {'Content-Type': 'text/plain'})
        res.end('Bad Gateway\n')
      } else {
        res.destroy()
      }
    })

    // Pipe request body → upstream (needed for POST/PUT with bodies).
    // For GET/HEAD and other bodyless requests, end immediately — do not wait
    // for the req stream to close (keep-alive connections keep the stream open,
    // causing a deadlock if we pipe unconditionally).
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
          logger.info('opencode-proxy: listening', {port, hostname})
          resolve()
        })
      })
    },

    async close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close(err => {
          if (err !== undefined && err !== null) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
    },
  }
}
