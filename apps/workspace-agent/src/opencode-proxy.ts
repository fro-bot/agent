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
 */

import type {Logger} from './opencode-server.js'

import {Buffer} from 'node:buffer'
import {timingSafeEqual} from 'node:crypto'
import http from 'node:http'
import {URL} from 'node:url'

const UNAUTHORIZED_BODY = 'Unauthorized\n'
const UNAUTHORIZED_BODY_BYTES = Buffer.from(UNAUTHORIZED_BODY)

export interface OpencodeProxyOptions {
  /**
   * Expected bearer token. Compared with timingSafeEqual.
   * Never logged.
   */
  readonly token: string
  /** Upstream loopback URL, e.g. http://127.0.0.1:54321 */
  readonly upstreamUrl: string
  readonly logger: Logger
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

    const upstreamReq = http.request(forwardOptions, upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      // Pipe without buffering — SSE streams through correctly
      upstreamRes.pipe(res, {end: true})
    })

    upstreamReq.on('error', (err: Error) => {
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
